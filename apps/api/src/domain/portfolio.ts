/**
 * Setting up and keeping the portfolio: properties, units, residents, leases,
 * the people on a lease, a lease's own late-fee terms, and its documents.
 *
 * Structural writes go through the definer functions in migration 017, which
 * check the caller themselves. The functions here shape input and output and
 * never widen what the database allows.
 */

import { createHash, randomInt } from "node:crypto";
import type { Tx } from "../db/context.ts";
import { hashPassword } from "../auth/password.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import { today } from "../../../../packages/shared/src/ids.ts";
import type {
  IssuedLogin,
  LeaseDocument,
  LeaseLateFeeRequest,
  LeaseResident,
  RecurringCharge,
  RecurringChargeRequest,
  ResidentContact,
  SavePropertyRequest,
  SaveUnitRequest,
  ScreeningSettings,
} from "../../../../packages/shared/src/portfolio.ts";

/* ------------------------------------------------------------------ *
 * Temporary passwords
 * ------------------------------------------------------------------ */

// No 0/O, 1/l/I: it will be read aloud or copied off a sticky note.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Four groups of four, e.g. "kq7m-2xpt-9fhv-w3ra": about 79 bits, easy to type. */
export function temporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g += 1) {
    let group = "";
    for (let i = 0; i < 4; i += 1) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join("-");
}

/* ------------------------------------------------------------------ *
 * Properties and units
 * ------------------------------------------------------------------ */

export async function saveProperty(tx: Tx, id: string | null, input: SavePropertyRequest): Promise<string> {
  const row = await tx.one<{ id: string }>(
    "SELECT app.admin_save_property($1, $2, $3, $4, $5, $6, $7) AS id",
    [id, input.name, input.addressLine1, input.addressLine2, input.city, input.state, input.postalCode],
  );
  return row.id;
}

export async function saveUnit(tx: Tx, id: string | null, input: SaveUnitRequest): Promise<string> {
  const row = await tx.one<{ id: string }>(
    "SELECT app.admin_save_unit($1, $2, $3, $4::smallint, $5::numeric, $6) AS id",
    [id, input.propertyId ?? null, input.label, input.bedrooms, input.bathrooms, input.marketRentCents],
  );
  return row.id;
}

export interface PropertyDetail {
  id: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  units: Array<{
    id: string;
    label: string;
    bedrooms: number | null;
    bathrooms: number | null;
    marketRentCents: Cents;
    tenancyId: string | null;
    residentName: string | null;
    coverPhotoId: string | null;
  }>;
}

export async function getProperty(tx: Tx, propertyId: string): Promise<PropertyDetail | null> {
  const property = await tx.maybeOne<{
    id: string; name: string; address_line1: string; address_line2: string | null;
    city: string; state: string; postal_code: string;
  }>(
    "SELECT id, name, address_line1, address_line2, city, state, postal_code FROM properties WHERE id = $1",
    [propertyId],
  );
  if (!property) return null;
  const units = await tx.many<{
    id: string; label: string; bedrooms: number | null; bathrooms: string | null;
    market_rent_cents: string; tenancy_id: string | null; resident_name: string | null; cover_photo_id: string | null;
  }>(
    `SELECT u.id, u.label, u.bedrooms, u.bathrooms::text AS bathrooms, u.market_rent_cents,
            t.id AS tenancy_id, r.display_name AS resident_name,
            (SELECT ph.id FROM property_photos ph WHERE ph.unit_id = u.id AND ph.is_cover
               AND ph.removed_at IS NULL LIMIT 1) AS cover_photo_id
     FROM units u
     LEFT JOIN tenancies t ON t.unit_id = u.id AND t.status = 'active'
     LEFT JOIN users r ON r.id = t.resident_user_id
     WHERE u.property_id = $1
     ORDER BY u.label`,
    [propertyId],
  );
  return {
    id: property.id,
    name: property.name,
    addressLine1: property.address_line1,
    addressLine2: property.address_line2,
    city: property.city,
    state: property.state,
    postalCode: property.postal_code,
    units: units.map((u) => ({
      id: u.id,
      label: u.label,
      bedrooms: u.bedrooms,
      bathrooms: u.bathrooms === null ? null : Number(u.bathrooms),
      marketRentCents: Number(u.market_rent_cents) as Cents,
      tenancyId: u.tenancy_id,
      residentName: u.resident_name,
      coverPhotoId: u.cover_photo_id,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Residents
 * ------------------------------------------------------------------ */

/**
 * The account for this person, creating it with a temporary password if it
 * does not exist yet. Someone who already has a login (moving units, or on a
 * second lease) keeps it, and no password is issued.
 */
export async function ensureResident(tx: Tx, contact: ResidentContact): Promise<IssuedLogin> {
  const password = temporaryPassword();
  const { hash, algorithm } = await hashPassword(password);
  const row = await tx.one<{ user_id: string; created: boolean }>(
    "SELECT user_id, created FROM app.admin_create_resident($1, $2, $3, $4, $5)",
    [contact.email, contact.name, contact.phone, hash, algorithm],
  );
  return {
    userId: row.user_id,
    name: contact.name,
    email: contact.email,
    temporaryPassword: row.created ? password : null,
  };
}

export async function updateResident(tx: Tx, userId: string, contact: ResidentContact): Promise<void> {
  await tx.query("SELECT app.admin_update_resident($1, $2, $3, $4)", [userId, contact.name, contact.email, contact.phone]);
}

export async function resetResidentPassword(tx: Tx, userId: string): Promise<string> {
  const password = temporaryPassword();
  const { hash, algorithm } = await hashPassword(password);
  await tx.query("SELECT app.admin_reset_resident_password($1, $2, $3)", [userId, hash, algorithm]);
  return password;
}

/* ------------------------------------------------------------------ *
 * Leases
 * ------------------------------------------------------------------ */

export interface NewLease {
  unitId: string;
  resident: ResidentContact;
  otherResidents: ResidentContact[];
  startsOn: string;
  endsOn: string | null;
  monthlyRentCents: number;
  rentDueDay: number;
  depositCents: number;
}

export async function createLease(tx: Tx, lease: NewLease): Promise<{ tenancyId: string; logins: IssuedLogin[] }> {
  const emails = [lease.resident, ...lease.otherResidents].map((p) => p.email);
  if (new Set(emails).size !== emails.length) {
    throw new PortfolioRefused("The same email address is listed twice. Each person needs their own.");
  }
  if (lease.endsOn && lease.endsOn < lease.startsOn) {
    throw new PortfolioRefused("The lease ends before it starts.");
  }

  const primary = await ensureResident(tx, lease.resident);
  const row = await tx.one<{ id: string }>(
    "SELECT app.admin_create_lease($1, $2, $3::date, $4::date, $5, $6::smallint, $7) AS id",
    [lease.unitId, primary.userId, lease.startsOn, lease.endsOn, lease.monthlyRentCents, lease.rentDueDay, lease.depositCents],
  );

  const logins = [primary];
  for (const person of lease.otherResidents) {
    const login = await ensureResident(tx, person);
    await tx.query("SELECT app.lease_add_resident($1, $2)", [row.id, login.userId]);
    logins.push(login);
  }
  return { tenancyId: row.id, logins };
}

export async function updateLease(
  tx: Tx,
  tenancyId: string,
  terms: { endsOn: string | null; monthlyRentCents: number; rentDueDay: number; depositCents: number },
): Promise<void> {
  await tx.query("SELECT app.admin_update_lease($1, $2::date, $3, $4::smallint, $5)", [
    tenancyId, terms.endsOn, terms.monthlyRentCents, terms.rentDueDay, terms.depositCents,
  ]);
}

export async function endLease(tx: Tx, tenancyId: string, endsOn: string): Promise<void> {
  await tx.query("SELECT app.admin_end_lease($1, $2::date)", [tenancyId, endsOn]);
}

export async function listLeaseResidents(tx: Tx, tenancyId: string): Promise<LeaseResident[]> {
  const rows = await tx.many<{
    id: string; display_name: string; email: string; phone: string | null; is_primary: boolean;
    added_at: string | null; last_login_at: string | null; must_change_password: boolean;
  }>(
    `SELECT u.id, u.display_name, u.email, u.phone, (u.id = t.resident_user_id) AS is_primary,
            r.added_at::text AS added_at, u.last_login_at::text AS last_login_at, u.must_change_password
     FROM tenancies t
     JOIN users u ON u.id = ANY (app.lease_resident_ids(t.id))
     LEFT JOIN tenancy_residents r ON r.tenancy_id = t.id AND r.user_id = u.id
     WHERE t.id = $1
     ORDER BY (u.id = t.resident_user_id) DESC, r.added_at, u.display_name`,
    [tenancyId],
  );
  return rows.map((r) => ({
    userId: r.id,
    name: r.display_name,
    email: r.email,
    phone: r.phone,
    isPrimary: r.is_primary,
    addedAt: r.added_at,
    lastLoginAt: r.last_login_at,
    mustChangePassword: r.must_change_password,
  }));
}

export async function addLeaseResident(tx: Tx, tenancyId: string, contact: ResidentContact): Promise<IssuedLogin> {
  const login = await ensureResident(tx, contact);
  await tx.query("SELECT app.lease_add_resident($1, $2)", [tenancyId, login.userId]);
  return login;
}

export async function removeLeaseResident(tx: Tx, tenancyId: string, userId: string): Promise<void> {
  await tx.query("SELECT app.lease_remove_resident($1, $2)", [tenancyId, userId]);
}

/** Names of the people on the resident's own lease (016). */
export async function leaseMemberNames(
  tx: Tx,
  tenancyId: string,
): Promise<Array<{ userId: string; name: string; isPrimary: boolean }>> {
  const rows = await tx.many<{ user_id: string; display_name: string; is_primary: boolean }>(
    "SELECT user_id, display_name, is_primary FROM app.lease_member_names($1)",
    [tenancyId],
  );
  return rows.map((r) => ({ userId: r.user_id, name: r.display_name, isPrimary: r.is_primary }));
}

/* ------------------------------------------------------------------ *
 * A lease's own late-fee terms (015)
 * ------------------------------------------------------------------ */

export async function setLeaseLateFee(tx: Tx, tenancyId: string, terms: LeaseLateFeeRequest, actorUserId: string): Promise<void> {
  // A caller who cannot see the lease inserts nothing rather than failing; say so.
  const result = await tx.query(
    `INSERT INTO lease_late_fee_policies
       (tenancy_id, organization_id, property_id, enabled, grace_days, fee_type, flat_cents, percent,
        daily_cents, max_cents, min_balance_cents, note, updated_by_user_id)
     SELECT t.id, t.organization_id, t.property_id, $2, $3, $4, $5, $6, $7, $8, $9, nullif($10, ''), $11
     FROM tenancies t WHERE t.id = $1
     ON CONFLICT (tenancy_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, grace_days = EXCLUDED.grace_days, fee_type = EXCLUDED.fee_type,
       flat_cents = EXCLUDED.flat_cents, percent = EXCLUDED.percent, daily_cents = EXCLUDED.daily_cents,
       max_cents = EXCLUDED.max_cents, min_balance_cents = EXCLUDED.min_balance_cents,
       note = EXCLUDED.note, updated_by_user_id = EXCLUDED.updated_by_user_id`,
    [
      tenancyId, terms.enabled, terms.graceDays, terms.feeType, terms.flatCents, terms.percent,
      terms.dailyCents, terms.maxCents, terms.minBalanceCents, terms.note, actorUserId,
    ],
  );
  if ((result.rowCount ?? 0) === 0) throw new PortfolioRefused("That lease was not found.");
}

export async function clearLeaseLateFee(tx: Tx, tenancyId: string): Promise<void> {
  await tx.query("DELETE FROM lease_late_fee_policies WHERE tenancy_id = $1", [tenancyId]);
}

/* ------------------------------------------------------------------ *
 * Organization settings
 * ------------------------------------------------------------------ */

export async function getScreening(tx: Tx): Promise<ScreeningSettings> {
  const row = await tx.maybeOne<{ screening_provider: string | null; screening_url: string | null }>(
    "SELECT screening_provider, screening_url FROM organization_settings LIMIT 1",
  );
  return { provider: row?.screening_provider ?? null, url: row?.screening_url ?? null };
}

export async function saveScreening(tx: Tx, organizationId: string, provider: string, url: string, actorUserId: string) {
  await tx.query(
    `INSERT INTO organization_settings (organization_id, screening_provider, screening_url, updated_by_user_id, updated_at)
     VALUES ($1, nullif($2, ''), nullif($3, ''), $4, now())
     ON CONFLICT (organization_id) DO UPDATE SET
       screening_provider = EXCLUDED.screening_provider, screening_url = EXCLUDED.screening_url,
       updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
    [organizationId, provider, url, actorUserId],
  );
}

/* ------------------------------------------------------------------ *
 * Lease documents (018)
 * ------------------------------------------------------------------ */

export function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/** A PDF starts with "%PDF-". A file that does not is not accepted, whatever it is called. */
export function looksLikePdf(body: Buffer): boolean {
  return body.length > 8 && body.subarray(0, 5).toString("latin1") === "%PDF-";
}

export async function attachDocument(
  tx: Tx,
  input: {
    tenancyId: string; title: string; fileName: string; sizeBytes: number; sha256: string;
    objectKey: string; requiresSignature: boolean; actorUserId: string;
  },
): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `INSERT INTO lease_documents
       (organization_id, property_id, tenancy_id, title, file_name, content_type, size_bytes, sha256,
        object_key, requires_signature, uploaded_by_user_id)
     SELECT t.organization_id, t.property_id, t.id, $2, $3, 'application/pdf', $4, $5, $6, $7, $8
     FROM tenancies t WHERE t.id = $1
     RETURNING id`,
    [input.tenancyId, input.title, input.fileName, input.sizeBytes, input.sha256, input.objectKey,
     input.requiresSignature, input.actorUserId],
  );
  return row.id;
}

export async function withdrawDocument(tx: Tx, documentId: string, actorUserId: string): Promise<boolean> {
  const result = await tx.query(
    "UPDATE lease_documents SET withdrawn_at = now(), withdrawn_by_user_id = $2 WHERE id = $1 AND withdrawn_at IS NULL",
    [documentId, actorUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listDocuments(tx: Tx, tenancyId: string, viewerUserId: string): Promise<LeaseDocument[]> {
  const docs = await tx.many<{
    id: string; tenancy_id: string; title: string; file_name: string; size_bytes: number; sha256: string;
    requires_signature: boolean; uploaded_at: string; uploaded_by_name: string | null; withdrawn_at: string | null;
  }>(
    `SELECT d.id, d.tenancy_id, d.title, d.file_name, d.size_bytes, d.sha256, d.requires_signature,
            d.uploaded_at::text AS uploaded_at, up.display_name AS uploaded_by_name, d.withdrawn_at::text AS withdrawn_at
     FROM lease_documents d
     LEFT JOIN users up ON up.id = d.uploaded_by_user_id
     WHERE d.tenancy_id = $1
     ORDER BY d.withdrawn_at IS NOT NULL, d.uploaded_at DESC`,
    [tenancyId],
  );
  if (docs.length === 0) return [];

  const signatures = await tx.many<{ document_id: string; user_id: string; typed_name: string; signed_at: string }>(
    `SELECT document_id, user_id, typed_name, signed_at::text AS signed_at
     FROM lease_document_signatures WHERE tenancy_id = $1 ORDER BY signed_at`,
    [tenancyId],
  );
  const members = await leaseMemberNames(tx, tenancyId);
  const nameOf = new Map(members.map((m) => [m.userId, m.name]));

  return docs.map((d) => {
    const signed = signatures.filter((s) => s.document_id === d.id);
    const signedIds = new Set(signed.map((s) => s.user_id));
    return {
      id: d.id,
      tenancyId: d.tenancy_id,
      title: d.title,
      fileName: d.file_name,
      sizeBytes: d.size_bytes,
      sha256: d.sha256,
      requiresSignature: d.requires_signature,
      uploadedAt: d.uploaded_at,
      uploadedByName: d.uploaded_by_name,
      withdrawnAt: d.withdrawn_at,
      signatures: signed.map((s) => ({
        userId: s.user_id,
        name: nameOf.get(s.user_id) ?? s.typed_name,
        typedName: s.typed_name,
        signedAt: s.signed_at,
      })),
      awaitingSignatureFrom:
        d.requires_signature && !d.withdrawn_at
          ? members.filter((m) => !signedIds.has(m.userId)).map((m) => m.name)
          : [],
      signedByMe: signedIds.has(viewerUserId),
    };
  });
}

export async function signDocument(
  tx: Tx,
  input: { documentId: string; userId: string; typedName: string; sha256: string; ip: string | null; userAgent: string | null },
): Promise<void> {
  await tx.query(
    `INSERT INTO lease_document_signatures (document_id, tenancy_id, user_id, typed_name, document_sha256, ip_address, user_agent)
     SELECT d.id, d.tenancy_id, $2, $3, $4, $5::inet, $6 FROM lease_documents d WHERE d.id = $1
     ON CONFLICT (document_id, user_id) DO NOTHING`,
    [input.documentId, input.userId, input.typedName, input.sha256, input.ip, input.userAgent?.slice(0, 400) ?? null],
  );
}

export class PortfolioRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioRefused";
  }
}

/* ------------------------------------------------------------------ *
 * Recurring monthly charges (006). Posted each month with rent by the
 * post-recurring-charges job; here they are listed, added and stopped.
 * ------------------------------------------------------------------ */

export async function listRecurring(tx: Tx, tenancyId: string): Promise<RecurringCharge[]> {
  const rows = await tx.many<{
    id: string; category: string; amount_cents: string; description: string; day_of_month: number;
    starts_on: string; ends_on: string | null; active: boolean;
  }>(
    `SELECT id, category, amount_cents, description, day_of_month, starts_on::text AS starts_on,
            ends_on::text AS ends_on, active
     FROM recurring_charges WHERE tenancy_id = $1
     ORDER BY active DESC, created_at DESC`,
    [tenancyId],
  );
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    amountCents: Number(r.amount_cents) as Cents,
    description: r.description,
    dayOfMonth: r.day_of_month,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    active: r.active,
  }));
}

export async function addRecurring(tx: Tx, tenancyId: string, input: RecurringChargeRequest): Promise<string> {
  if (input.endsOn && input.endsOn < input.startsOn) throw new PortfolioRefused("The charge ends before it starts.");
  const row = await tx.maybeOne<{ id: string }>(
    `INSERT INTO recurring_charges
       (organization_id, property_id, tenancy_id, category, amount_cents, description, day_of_month, starts_on, ends_on)
     SELECT t.organization_id, t.property_id, t.id, $2, $3, $4, $5, $6::date, $7::date
     FROM tenancies t WHERE t.id = $1 AND t.status = 'active'
     RETURNING id`,
    [tenancyId, input.category, input.amountCents, input.description, input.dayOfMonth, input.startsOn, input.endsOn],
  );
  if (!row) throw new PortfolioRefused("That lease was not found or has ended.");
  return row.id;
}

/** Stops future postings. Months already posted stay on the ledger. */
export async function stopRecurring(tx: Tx, chargeId: string): Promise<string | null> {
  const row = await tx.maybeOne<{ tenancy_id: string }>(
    `UPDATE recurring_charges
     SET active = false, ends_on = COALESCE(LEAST(ends_on, $2::date), $2::date)
     WHERE id = $1 AND active
     RETURNING tenancy_id`,
    [chargeId, today()],
  );
  return row?.tenancy_id ?? null;
}

/* ------------------------------------------------------------------ *
 * Photos of properties and units (019)
 * ------------------------------------------------------------------ */

export interface PropertyPhoto {
  id: string;
  propertyId: string;
  unitId: string | null;
  unitLabel: string | null;
  caption: string | null;
  isCover: boolean;
  uploadedAt: string;
  uploadedByName: string | null;
}

export async function listPhotos(tx: Tx, propertyId: string, unitId?: string | null): Promise<PropertyPhoto[]> {
  const rows = await tx.many<{
    id: string; property_id: string; unit_id: string | null; unit_label: string | null; caption: string | null;
    is_cover: boolean; uploaded_at: string; uploaded_by_name: string | null;
  }>(
    `SELECT ph.id, ph.property_id, ph.unit_id, u.label AS unit_label, ph.caption, ph.is_cover,
            ph.uploaded_at::text AS uploaded_at, up.display_name AS uploaded_by_name
     FROM property_photos ph
     LEFT JOIN units u ON u.id = ph.unit_id
     LEFT JOIN users up ON up.id = ph.uploaded_by_user_id
     WHERE ph.property_id = $1 AND ph.removed_at IS NULL
       AND ($2::uuid IS NULL OR ph.unit_id = $2::uuid)
     ORDER BY ph.unit_id NULLS FIRST, u.label, ph.is_cover DESC, ph.uploaded_at`,
    [propertyId, unitId ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    propertyId: r.property_id,
    unitId: r.unit_id,
    unitLabel: r.unit_label,
    caption: r.caption,
    isCover: r.is_cover,
    uploadedAt: r.uploaded_at,
    uploadedByName: r.uploaded_by_name,
  }));
}

export async function addPhoto(
  tx: Tx,
  input: {
    propertyId: string; unitId: string | null; objectKey: string; contentType: string; sizeBytes: number;
    caption: string | null; actorUserId: string;
  },
): Promise<string> {
  // The first photo of a property or unit becomes its cover.
  const hasCover = await tx.maybeOne(
    `SELECT 1 FROM property_photos WHERE property_id = $1 AND unit_id IS NOT DISTINCT FROM $2::uuid
       AND is_cover AND removed_at IS NULL`,
    [input.propertyId, input.unitId],
  );
  const row = await tx.one<{ id: string }>(
    `INSERT INTO property_photos
       (organization_id, property_id, unit_id, object_key, content_type, size_bytes, caption, is_cover, uploaded_by_user_id)
     SELECT p.organization_id, p.id, $2::uuid, $3, $4, $5, nullif($6, ''), $7, $8
     FROM properties p WHERE p.id = $1
     RETURNING id`,
    [input.propertyId, input.unitId, input.objectKey, input.contentType, input.sizeBytes, input.caption ?? "", !hasCover, input.actorUserId],
  );
  return row.id;
}

async function photoTarget(tx: Tx, photoId: string) {
  return tx.maybeOne<{ property_id: string; unit_id: string | null; is_cover: boolean }>(
    "SELECT property_id, unit_id, is_cover FROM property_photos WHERE id = $1 AND removed_at IS NULL",
    [photoId],
  );
}

export async function makeCover(tx: Tx, photoId: string): Promise<string | null> {
  const target = await photoTarget(tx, photoId);
  if (!target) return null;
  await tx.query(
    `UPDATE property_photos SET is_cover = false
     WHERE property_id = $1 AND unit_id IS NOT DISTINCT FROM $2::uuid AND is_cover AND removed_at IS NULL`,
    [target.property_id, target.unit_id],
  );
  // A caller the update policy refuses matches no rows; that is "not found", not success.
  const done = await tx.query("UPDATE property_photos SET is_cover = true WHERE id = $1", [photoId]);
  return done.rowCount ? target.property_id : null;
}

export async function setCaption(tx: Tx, photoId: string, caption: string): Promise<string | null> {
  const row = await tx.maybeOne<{ property_id: string }>(
    "UPDATE property_photos SET caption = nullif($2, '') WHERE id = $1 AND removed_at IS NULL RETURNING property_id",
    [photoId, caption.trim().slice(0, 140)],
  );
  return row?.property_id ?? null;
}

/** Hide a photo. If it was the cover, the next remaining photo takes its place. */
export async function removePhoto(tx: Tx, photoId: string, actorUserId: string): Promise<string | null> {
  const target = await photoTarget(tx, photoId);
  if (!target) return null;
  const done = await tx.query(
    "UPDATE property_photos SET removed_at = now(), removed_by_user_id = $2, is_cover = false WHERE id = $1",
    [photoId, actorUserId],
  );
  if (!done.rowCount) return null;
  if (target.is_cover) {
    await tx.query(
      `UPDATE property_photos SET is_cover = true
       WHERE id = (SELECT id FROM property_photos
                   WHERE property_id = $1 AND unit_id IS NOT DISTINCT FROM $2::uuid AND removed_at IS NULL
                   ORDER BY uploaded_at LIMIT 1)`,
      [target.property_id, target.unit_id],
    );
  }
  return target.property_id;
}

/** The picture a resident sees of home: their unit's cover, else their building's. */
export async function homePhotoId(tx: Tx, tenancyId: string): Promise<string | null> {
  const row = await tx.maybeOne<{ id: string }>(
    `SELECT ph.id FROM tenancies t
     JOIN property_photos ph ON ph.property_id = t.property_id AND ph.is_cover AND ph.removed_at IS NULL
       AND (ph.unit_id = t.unit_id OR ph.unit_id IS NULL)
     WHERE t.id = $1
     ORDER BY (ph.unit_id IS NOT NULL) DESC LIMIT 1`,
    [tenancyId],
  );
  return row?.id ?? null;
}
