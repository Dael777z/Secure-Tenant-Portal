/**
 * Portfolio administration, people on a lease, lease late-fee terms, lease
 * documents, screening settings and data import. See migrations 014–018 and
 * docs/MEETING-2026-09-28.md for why each exists.
 */

import type { Router } from "../http/router.ts";
import { AUTHENTICATED, requires } from "../http/router.ts";
import { badRequest, notFound, unprocessable } from "../http/errors.ts";
import { withContext, withReadOnlyContext, type Tx } from "../db/context.ts";
import { PostgresError } from "../db/protocol.ts";
import type { Pool } from "../db/pool.ts";
import type { HttpContext } from "../http/context.ts";
import type { Storage } from "../providers/storage/index.ts";
import { newObjectKey } from "../providers/storage/filesystem.ts";
import { MAX_PHOTO_BYTES, sniffImageType } from "../providers/storage/index.ts";
import * as v from "../../../../packages/shared/src/validate.ts";
import * as pf from "../../../../packages/shared/src/portfolio.ts";
import { toCsv } from "../../../../packages/shared/src/csv.ts";
import * as portfolio from "../domain/portfolio.ts";
import { runImport } from "../domain/importer.ts";
import { getLeasePolicy, getPolicy, humanPolicy } from "../domain/latefees.ts";

interface Deps {
  storage: Storage;
}

/**
 * The definer functions in 017 explain themselves in their exception messages
 * ("this unit already has an active lease; end it first"). Those are written
 * for the manager and shown as they are. Anything else from the database is
 * left to the generic handler.
 */
function explained<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    if (error instanceof portfolio.PortfolioRefused) throw unprocessable(error.message);
    if (
      error instanceof PostgresError &&
      ["23505", "23514", "23503", "42501"].includes(error.code) &&
      !/violates|duplicate key|permission denied|row-level security/i.test(error.message)
    ) {
      const message = error.message.charAt(0).toUpperCase() + error.message.slice(1);
      throw unprocessable(message.endsWith(".") ? message : `${message}.`);
    }
    if (error instanceof PostgresError && error.code === "23505" && /units_property_id_label/.test(error.message)) {
      throw unprocessable("That property already has a unit with this label.");
    }
    throw error;
  });
}

async function audit(tx: Tx, ctx: HttpContext, action: string, subjectType: string, subjectId: string | null, detail: Record<string, unknown>) {
  await tx.query(
    `INSERT INTO audit_log (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, detail, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [ctx.user!.organizationId, ctx.user!.id, ctx.user!.role, action, subjectType, subjectId, JSON.stringify(detail), ctx.ip],
  );
}

/** Logins are audited without their temporary passwords. */
const withoutSecrets = (logins: pf.IssuedLogin[]) =>
  logins.map((l) => ({ userId: l.userId, email: l.email, newAccount: l.temporaryPassword !== null }));

export function registerPortfolioRoutes(router: Router, pool: Pool, deps: Deps): void {
  /* ---------------------------------------------------------------- *
   * Properties and units
   * ---------------------------------------------------------------- */

  router.get("/api/v1/manager/properties/:propertyId", requires("rentroll:read"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const property = await portfolio.getProperty(tx, ctx.params.propertyId);
      if (!property) throw notFound();
      return { property };
    }),
  );

  router.post("/api/v1/manager/properties", requires("portfolio:manage"), async (ctx) => {
    const input = pf.savePropertyRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const id = await explained(() => portfolio.saveProperty(tx, null, input));
      await audit(tx, ctx, "property.created", "property", id, { name: input.name });
      return { propertyId: id };
    });
  });

  router.post("/api/v1/manager/properties/:propertyId", requires("portfolio:manage"), async (ctx) => {
    const input = pf.savePropertyRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const id = await explained(() => portfolio.saveProperty(tx, ctx.params.propertyId, input));
      await audit(tx, ctx, "property.updated", "property", id, { name: input.name });
      return { propertyId: id };
    });
  });

  router.post("/api/v1/manager/units", requires("portfolio:manage"), async (ctx) => {
    const input = pf.saveUnitRequest.parse(ctx.body);
    if (!input.propertyId) throw badRequest("Choose the property this unit belongs to.");
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const id = await explained(() => portfolio.saveUnit(tx, null, input));
      await audit(tx, ctx, "unit.created", "unit", id, { label: input.label, propertyId: input.propertyId });
      return { unitId: id };
    });
  });

  router.post("/api/v1/manager/units/:unitId", requires("portfolio:manage"), async (ctx) => {
    const input = pf.saveUnitRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const id = await explained(() => portfolio.saveUnit(tx, ctx.params.unitId, input));
      await audit(tx, ctx, "unit.updated", "unit", id, { label: input.label, marketRentCents: input.marketRentCents });
      return { unitId: id };
    });
  });

  /* ---------------------------------------------------------------- *
   * Leases and the people on them
   * ---------------------------------------------------------------- */

  router.post("/api/v1/manager/leases", requires("portfolio:manage"), async (ctx) => {
    const input = pf.createLeaseRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const { tenancyId, logins } = await explained(() => portfolio.createLease(tx, input));
      await audit(tx, ctx, "lease.created", "tenancy", tenancyId, {
        unitId: input.unitId,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        monthlyRentCents: input.monthlyRentCents,
        residents: withoutSecrets(logins),
      });
      return { tenancyId, logins };
    });
  });

  router.post("/api/v1/manager/leases/:tenancyId", requires("portfolio:manage"), async (ctx) => {
    const input = pf.updateLeaseRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      await explained(() => portfolio.updateLease(tx, ctx.params.tenancyId, input));
      await audit(tx, ctx, "lease.updated", "tenancy", ctx.params.tenancyId, { ...input });
      return { ok: true };
    });
  });

  router.post("/api/v1/manager/leases/:tenancyId/end", requires("portfolio:manage"), async (ctx) => {
    const input = pf.endLeaseRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      await explained(() => portfolio.endLease(tx, ctx.params.tenancyId, input.endsOn));
      await audit(tx, ctx, "lease.ended", "tenancy", ctx.params.tenancyId, { endsOn: input.endsOn });
      return { ok: true };
    });
  });

  router.get("/api/v1/manager/leases/:tenancyId/residents", requires("ledger:read:property"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => ({
      residents: await portfolio.listLeaseResidents(tx, ctx.params.tenancyId),
    })),
  );

  router.post("/api/v1/manager/leases/:tenancyId/residents", requires("portfolio:manage"), async (ctx) => {
    const input = pf.residentContact.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const login = await explained(() => portfolio.addLeaseResident(tx, ctx.params.tenancyId, input));
      await audit(tx, ctx, "lease.resident_added", "tenancy", ctx.params.tenancyId, withoutSecrets([login])[0]!);
      return { login };
    });
  });

  router.delete("/api/v1/manager/leases/:tenancyId/residents/:userId", requires("portfolio:manage"), async (ctx) =>
    withContext(pool, ctx.dbContext(), async (tx) => {
      await explained(() => portfolio.removeLeaseResident(tx, ctx.params.tenancyId, ctx.params.userId));
      await audit(tx, ctx, "lease.resident_removed", "tenancy", ctx.params.tenancyId, { userId: ctx.params.userId });
      return { ok: true };
    }),
  );

  router.post("/api/v1/manager/residents/:userId", requires("portfolio:manage"), async (ctx) => {
    const input = pf.residentContact.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      await explained(() => portfolio.updateResident(tx, ctx.params.userId, input));
      await audit(tx, ctx, "resident.contact_updated", "user", ctx.params.userId, { email: input.email });
      return { ok: true };
    });
  });

  router.post("/api/v1/manager/residents/:userId/reset-password", requires("portfolio:manage"), async (ctx) =>
    withContext(pool, ctx.dbContext(), async (tx) => {
      const temporaryPassword = await explained(() => portfolio.resetResidentPassword(tx, ctx.params.userId));
      await audit(tx, ctx, "resident.password_reset", "user", ctx.params.userId, {});
      return { temporaryPassword };
    }),
  );

  /* ---------------------------------------------------------------- *
   * A lease's own late-fee terms
   * ---------------------------------------------------------------- */

  router.post("/api/v1/manager/leases/:tenancyId/late-fee", requires("policy:configure"), async (ctx) => {
    const input = pf.leaseLateFeeRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      await explained(() => portfolio.setLeaseLateFee(tx, ctx.params.tenancyId, input, ctx.user!.id));
      const saved = await getLeasePolicy(tx, ctx.params.tenancyId);
      if (!saved) throw notFound();
      await audit(tx, ctx, "policy.lease_late_fee_changed", "tenancy", ctx.params.tenancyId, { ...input });
      return { plainLanguage: humanPolicy(saved) };
    });
  });

  router.delete("/api/v1/manager/leases/:tenancyId/late-fee", requires("policy:configure"), async (ctx) =>
    withContext(pool, ctx.dbContext(), async (tx) => {
      const tenancy = await tx.maybeOne<{ property_id: string }>("SELECT property_id FROM tenancies WHERE id = $1", [
        ctx.params.tenancyId,
      ]);
      if (!tenancy) throw notFound();
      await portfolio.clearLeaseLateFee(tx, ctx.params.tenancyId);
      await audit(tx, ctx, "policy.lease_late_fee_cleared", "tenancy", ctx.params.tenancyId, {});
      return { plainLanguage: humanPolicy(await getPolicy(tx, tenancy.property_id)) };
    }),
  );

  /* ---------------------------------------------------------------- *
   * Photos of properties and units (019)
   * ---------------------------------------------------------------- */

  router.get("/api/v1/manager/properties/:propertyId/photos", requires("rentroll:read"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => ({
      photos: await portfolio.listPhotos(tx, ctx.params.propertyId, ctx.query.unitId || null),
    })),
  );

  /**
   * Upload a photo. The body is the image; unitId and caption travel in the
   * query string. JPEG, PNG or WebP, checked by their bytes. HEIC (an iPhone's
   * default) is refused with a plain explanation, because browsers cannot show it.
   */
  router.post("/api/v1/manager/properties/:propertyId/photos", requires("portfolio:manage"), async (ctx) => {
    const unitId = ctx.query.unitId ? v.uuid().parse(ctx.query.unitId) : null;
    const caption = String(ctx.query.caption ?? "").trim().slice(0, 140);
    const declared = Number(ctx.req.headers["content-length"] ?? 0);
    if (declared > MAX_PHOTO_BYTES) throw badRequest("That photo is larger than 15 MB.");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of ctx.req) {
      total += (chunk as Buffer).length;
      if (total > MAX_PHOTO_BYTES) throw badRequest("That photo is larger than 15 MB.");
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks, total);
    const type = sniffImageType(body);
    if (type === "image/heic") {
      throw badRequest("That is an iPhone HEIC photo, which browsers cannot show. Share it as a JPEG (Settings → Camera → Formats → Most Compatible) and try again.");
    }
    if (!type || !["image/jpeg", "image/png", "image/webp"].includes(type)) {
      throw badRequest("That file is not a JPEG, PNG or WebP picture.");
    }

    const reachable = await withReadOnlyContext(pool, ctx.dbContext(), (tx) =>
      tx.maybeOne("SELECT 1 FROM properties WHERE id = $1", [ctx.params.propertyId]),
    );
    if (!reachable) throw notFound();

    const objectKey = newObjectKey("properties");
    await deps.storage.put(objectKey, body, type);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const photoId = await explained(() =>
        portfolio.addPhoto(tx, {
          propertyId: ctx.params.propertyId, unitId, objectKey, contentType: type, sizeBytes: body.length,
          caption, actorUserId: ctx.user!.id,
        }),
      );
      await audit(tx, ctx, "photo.added", "property", ctx.params.propertyId, { photoId, unitId });
      return { photoId, photos: await portfolio.listPhotos(tx, ctx.params.propertyId) };
    });
  });

  router.post("/api/v1/manager/photos/:photoId/cover", requires("portfolio:manage"), async (ctx) =>
    withContext(pool, ctx.dbContext(), async (tx) => {
      const propertyId = await portfolio.makeCover(tx, ctx.params.photoId);
      if (!propertyId) throw notFound();
      await audit(tx, ctx, "photo.cover", "property", propertyId, { photoId: ctx.params.photoId });
      return { photos: await portfolio.listPhotos(tx, propertyId) };
    }),
  );

  router.post("/api/v1/manager/photos/:photoId/caption", requires("portfolio:manage"), async (ctx) => {
    const input = v.object({ caption: v.string() }).parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const propertyId = await portfolio.setCaption(tx, ctx.params.photoId, input.caption);
      if (!propertyId) throw notFound();
      return { photos: await portfolio.listPhotos(tx, propertyId) };
    });
  });

  router.post("/api/v1/manager/photos/:photoId/remove", requires("portfolio:manage"), async (ctx) =>
    withContext(pool, ctx.dbContext(), async (tx) => {
      const propertyId = await portfolio.removePhoto(tx, ctx.params.photoId, ctx.user!.id);
      if (!propertyId) throw notFound();
      await audit(tx, ctx, "photo.removed", "property", propertyId, { photoId: ctx.params.photoId });
      return { photos: await portfolio.listPhotos(tx, propertyId) };
    }),
  );

  /** The picture. As with every file here: no row under your own access, no bytes. */
  router.get("/api/v1/property-photos/:photoId", AUTHENTICATED, async (ctx) => {
    const photo = await withReadOnlyContext(pool, ctx.dbContext(), (tx) =>
      tx.maybeOne<{ object_key: string; content_type: string }>(
        "SELECT object_key, content_type FROM property_photos WHERE id = $1",
        [ctx.params.photoId],
      ),
    );
    if (!photo) throw notFound();
    const object = await deps.storage.get(photo.object_key);
    if (!object) throw notFound();
    ctx.buffer(200, object.body, photo.content_type, {
      "cache-control": "private, max-age=3600",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    });
  });

  /* ---------------------------------------------------------------- *
   * Recurring monthly charges on a lease
   * ---------------------------------------------------------------- */

  router.get("/api/v1/manager/leases/:tenancyId/recurring", requires("ledger:read:property"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => ({
      charges: await portfolio.listRecurring(tx, ctx.params.tenancyId),
    })),
  );

  router.post("/api/v1/manager/leases/:tenancyId/recurring", requires("charges:post"), async (ctx) => {
    const input = pf.recurringChargeRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const id = await explained(() => portfolio.addRecurring(tx, ctx.params.tenancyId, input));
      await audit(tx, ctx, "recurring_charge.added", "tenancy", ctx.params.tenancyId, { chargeId: id, ...input });
      return { chargeId: id, charges: await portfolio.listRecurring(tx, ctx.params.tenancyId) };
    });
  });

  router.post("/api/v1/manager/recurring/:chargeId/stop", requires("charges:post"), async (ctx) =>
    withContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await portfolio.stopRecurring(tx, ctx.params.chargeId);
      if (!tenancyId) throw notFound();
      await audit(tx, ctx, "recurring_charge.stopped", "tenancy", tenancyId, { chargeId: ctx.params.chargeId });
      return { charges: await portfolio.listRecurring(tx, tenancyId) };
    }),
  );

  /* ---------------------------------------------------------------- *
   * Lease documents
   * ---------------------------------------------------------------- */

  router.get("/api/v1/manager/leases/:tenancyId/documents", requires("ledger:read:property"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => ({
      documents: await portfolio.listDocuments(tx, ctx.params.tenancyId, ctx.user!.id),
    })),
  );

  /**
   * Upload a lease PDF. The body is the file itself; title and whether it needs
   * signing travel in the query string. The bytes are checked, not the name.
   */
  router.post("/api/v1/manager/leases/:tenancyId/documents", requires("documents:manage"), async (ctx) => {
    const title = String(ctx.query.title ?? "").trim().slice(0, 120);
    const fileName = String(ctx.query.fileName ?? "lease.pdf").replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "lease.pdf";
    const requiresSignature = ctx.query.requiresSignature === "1" || ctx.query.requiresSignature === "true";
    if (!title) throw badRequest("Give the document a title, like “Lease agreement 2026–27”.");

    const declared = Number(ctx.req.headers["content-length"] ?? 0);
    if (declared > pf.MAX_DOCUMENT_BYTES) throw badRequest("That file is larger than 15 MB.");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of ctx.req) {
      total += (chunk as Buffer).length;
      if (total > pf.MAX_DOCUMENT_BYTES) throw badRequest("That file is larger than 15 MB.");
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks, total);
    if (!portfolio.looksLikePdf(body)) throw badRequest("That file is not a PDF. Save or print the lease as a PDF and try again.");

    // Check the lease is reachable before storing anything.
    const reachable = await withReadOnlyContext(pool, ctx.dbContext(), (tx) =>
      tx.maybeOne("SELECT 1 FROM tenancies WHERE id = $1", [ctx.params.tenancyId]),
    );
    if (!reachable) throw notFound();

    const objectKey = newObjectKey("leases");
    await deps.storage.put(objectKey, body, "application/pdf");
    const hash = portfolio.sha256(body);

    return withContext(pool, ctx.dbContext(), async (tx) => {
      const documentId = await portfolio.attachDocument(tx, {
        tenancyId: ctx.params.tenancyId,
        title,
        fileName,
        sizeBytes: body.length,
        sha256: hash,
        objectKey,
        requiresSignature,
        actorUserId: ctx.user!.id,
      });
      await audit(tx, ctx, "document.uploaded", "lease_document", documentId, {
        tenancyId: ctx.params.tenancyId, title, sha256: hash, requiresSignature,
      });
      return { documentId, documents: await portfolio.listDocuments(tx, ctx.params.tenancyId, ctx.user!.id) };
    });
  });

  router.post("/api/v1/manager/documents/:documentId/withdraw", requires("documents:manage"), async (ctx) =>
    withContext(pool, ctx.dbContext(), async (tx) => {
      const ok = await portfolio.withdrawDocument(tx, ctx.params.documentId, ctx.user!.id);
      if (!ok) throw notFound();
      await audit(tx, ctx, "document.withdrawn", "lease_document", ctx.params.documentId, {});
      return { ok: true };
    }),
  );

  /**
   * The file. Authorization is the database read under the caller's own
   * context, as for photos: no row, no bytes.
   */
  router.get("/api/v1/documents/:documentId/file", AUTHENTICATED, async (ctx) => {
    const doc = await withReadOnlyContext(pool, ctx.dbContext(), (tx) =>
      tx.maybeOne<{ object_key: string; file_name: string }>(
        "SELECT object_key, file_name FROM lease_documents WHERE id = $1",
        [ctx.params.documentId],
      ),
    );
    if (!doc) throw notFound();
    const object = await deps.storage.get(doc.object_key);
    if (!object) throw notFound();
    const download = ctx.query.download === "1";
    ctx.buffer(200, object.body, "application/pdf", {
      "cache-control": "private, no-store",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${doc.file_name.replace(/"/g, "")}"`,
      "x-content-type-options": "nosniff",
    });
  });

  router.get("/api/v1/tenant/documents", requires("documents:sign:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = ctx.user!.tenancyId;
      if (!tenancyId) throw notFound("No active tenancy is attached to this account.");
      return { documents: await portfolio.listDocuments(tx, tenancyId, ctx.user!.id) };
    }),
  );

  router.post("/api/v1/tenant/documents/:documentId/sign", requires("documents:sign:own"), async (ctx) => {
    const input = pf.signDocumentRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const doc = await tx.maybeOne<{ tenancy_id: string }>("SELECT tenancy_id FROM lease_documents WHERE id = $1", [
        ctx.params.documentId,
      ]);
      if (!doc) throw notFound();
      await explained(() =>
        portfolio.signDocument(tx, {
          documentId: ctx.params.documentId,
          userId: ctx.user!.id,
          typedName: input.typedName,
          sha256: input.sha256,
          ip: ctx.ip || null,
          userAgent: String(ctx.req.headers["user-agent"] ?? "") || null,
        }),
      );
      await tx.query(
        `INSERT INTO audit_log (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, detail, ip_address)
         VALUES ($1, $2, 'tenant', 'document.signed', 'lease_document', $3, $4::jsonb, $5)`,
        [ctx.user!.organizationId, ctx.user!.id, ctx.params.documentId, JSON.stringify({ sha256: input.sha256 }), ctx.ip],
      );
      return { documents: await portfolio.listDocuments(tx, doc.tenancy_id, ctx.user!.id) };
    });
  });

  /* ---------------------------------------------------------------- *
   * Settings: applicant screening
   * ---------------------------------------------------------------- */

  router.get("/api/v1/manager/settings/screening", requires("rentroll:read"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => ({ screening: await portfolio.getScreening(tx) })),
  );

  router.post("/api/v1/manager/settings/screening", requires("policy:configure"), async (ctx) => {
    const input = pf.screeningSettingsRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      await portfolio.saveScreening(tx, ctx.user!.organizationId, input.provider, input.url, ctx.user!.id);
      await audit(tx, ctx, "settings.screening_changed", "organization", ctx.user!.organizationId, { ...input });
      return { screening: await portfolio.getScreening(tx) };
    });
  });

  /* ---------------------------------------------------------------- *
   * Import
   * ---------------------------------------------------------------- */

  router.get("/api/v1/manager/import/template/:kind", requires("data:import"), async (ctx) => {
    const kind = v.enumOf(pf.IMPORT_KINDS).parse(ctx.params.kind);
    const example: Record<pf.ImportKind, string[][]> = {
      units: [["Mesa Vista", "1200 N Main St", "Las Cruces", "NM", "88001", "1A", "2", "1", "950.00"]],
      leases: [["Mesa Vista", "1A", "Jordan Rivera", "jordan@example.com", "(575) 555-0100", "2025-08-01", "2026-07-31", "950.00", "1", "950.00", "Sam Rivera <sam@example.com>"]],
      ledger: [
        ["Mesa Vista", "1A", "2025-09-01", "charge", "rent", "Rent for September 2025", "950.00", "RR-2025-09-rent-1A"],
        ["Mesa Vista", "1A", "2025-09-03", "payment", "payment_ach", "Online payment", "950.00", "RR-2025-09-pay-1A"],
      ],
    };
    const csv = toCsv([[...pf.IMPORT_COLUMNS[kind]], ...example[kind]]);
    ctx.buffer(200, Buffer.from(csv, "utf8"), "text/csv; charset=utf-8", {
      "content-disposition": `attachment; filename="import-${kind}-template.csv"`,
    });
  });

  router.post("/api/v1/manager/import", requires("data:import"), async (ctx) => {
    const input = pf.importRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const report = await runImport(tx, input, { userId: ctx.user!.id, role: ctx.user!.role });
      if (!input.dryRun) {
        await audit(tx, ctx, "data.imported", "organization", ctx.user!.organizationId, {
          kind: input.kind, source: input.source, totals: report.totals, logins: withoutSecrets(report.logins),
        });
      }
      return { report };
    });
  });
}
