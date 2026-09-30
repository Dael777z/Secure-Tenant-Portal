/**
 * Resident routes.
 *
 * Every handler here opens its transaction with the resident's own security
 * context, so the database is deciding what these queries can see. The
 * `tenancyFor` helper below is the application's own filter on top of that —
 * belt to the database's braces — and the isolation test suite runs with it
 * disabled precisely to prove that removing the belt changes nothing.
 */

import type { Router } from "../http/router.ts";
import { AUTHENTICATED, requires, roles } from "../http/router.ts";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../http/errors.ts";
import { SYSTEM_CONTEXT, withContext, withReadOnlyContext, type Tx } from "../db/context.ts";
import type { Pool } from "../db/pool.ts";
import type { Config } from "../config.ts";
import type { HttpContext } from "../http/context.ts";
import type { PaymentProvider } from "../providers/payments/index.ts";
import type { Storage } from "../providers/storage/index.ts";
import { ALLOWED_IMAGE_TYPES, MAX_PHOTO_BYTES, sniffImageType } from "../providers/storage/index.ts";
import { newObjectKey } from "../providers/storage/filesystem.ts";
import * as api from "../../../../packages/shared/src/api.ts";
import { IDEMPOTENCY_HEADER } from "../../../../packages/shared/src/api.ts";
import { ageBalance, summarizeByPeriod } from "../../../../packages/shared/src/ledger.ts";
import { dueDateFor, periodOf, shiftPeriod, today } from "../../../../packages/shared/src/ids.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import { PRIORITY_GUIDANCE, PRIORITY_TARGET_HOURS } from "../../../../packages/shared/src/maintenance.ts";
import * as ledger from "../domain/ledger.ts";
import * as payments from "../domain/payments.ts";
import * as autopay from "../domain/autopay.ts";
import * as disputes from "../domain/disputes.ts";
import * as maintenance from "../domain/maintenance.ts";
import * as plans from "../domain/plans.ts";
import { effectivePolicy, humanPolicy } from "../domain/latefees.ts";
import { homePhotoId, leaseMemberNames, listDocuments } from "../domain/portfolio.ts";
import { emit } from "../domain/notifications.ts";
import { exportTenancyStatement } from "../domain/exports.ts";

/**
 * Bank transfers only, unless the operator turns cards on (PAYMENTS_ALLOW_CARDS).
 * Checked on every path that can move money with a method: paying, adding a
 * method, and enrolling in autopay — so a card saved before the switch cannot
 * be used after it.
 */
async function assertMethodAccepted(tx: Tx, config: Config, methodId: string): Promise<void> {
  if (config.payments.allowCards) return;
  const method = await tx.maybeOne<{ kind: string }>("SELECT kind FROM payment_methods WHERE id = $1", [methodId]);
  if (method?.kind === "card") {
    throw unprocessable("This property accepts bank transfers only. Please pay from a bank account.");
  }
}

export function registerTenantRoutes(
  router: Router,
  deps: { pool: Pool; config: Config; payments: PaymentProvider; storage: Storage },
): void {
  const { pool, config } = deps;

  /**
   * The tenancy this request may act on.
   *
   * In test mode with UNSAFE_DISABLE_APPLICATION_FILTERS set, this returns
   * whatever tenancy the caller asked for without checking ownership — which is
   * the point. The isolation suite drives real endpoints with this check
   * removed, so that a pass means the database refused, not that this function
   * remembered to.
   */
  async function tenancyFor(ctx: HttpContext, tx: Tx, requested?: string): Promise<string> {
    if (config.security.disableApplicationFilters && requested) return requested;

    const tenancyId = requested ?? ctx.user?.tenancyId;
    if (!tenancyId) throw notFound("No active tenancy is attached to this account.");

    if (ctx.user?.role === "tenant" && tenancyId !== ctx.user.tenancyId) {
      // 404 rather than 403: confirming that a tenancy exists is itself a
      // disclosure.
      throw notFound();
    }
    return tenancyId;
  }

  /* ---------------------------------------------------------------- *
   * Summary and ledger
   * ---------------------------------------------------------------- */

  router.get("/api/v1/tenant/summary", requires("ledger:read:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      const tenancy = await tx.one<{
        property_id: string;
        monthly_rent_cents: number;
        rent_due_day: number;
        late_fee_hold_until: string | null;
        late_fee_hold_reason: string | null;
      }>(
        `SELECT property_id, monthly_rent_cents, rent_due_day,
                late_fee_hold_until::text AS late_fee_hold_until, late_fee_hold_reason
         FROM tenancies WHERE id = $1`,
        [tenancyId],
      );

      const [entries, balance, plan, enrollment, pending, methods, openWorkOrders, openDisputes, policy] =
        await Promise.all([
          ledger.getEntries(tx, tenancyId, { limit: 25 }),
          ledger.getBalance(tx, tenancyId),
          plans.getActivePlan(tx, tenancyId),
          autopay.get(tx, tenancyId),
          payments.listPendingPayments(tx, tenancyId),
          listPaymentMethods(tx, tenancyId, deps.payments),
          maintenance.listForTenancy(tx, tenancyId, true),
          disputes.listForTenancy(tx, tenancyId, true),
          effectivePolicy(tx, tenancyId, tenancy.property_id),
        ]);

      const period = periodOf(today());
      const nextPeriod = shiftPeriod(period, 1);
      const dueDate = dueDateFor(period, tenancy.rent_due_day);
      const upcoming = dueDate >= today() ? dueDate : dueDateFor(nextPeriod, tenancy.rent_due_day);

      return {
        balance: {
          tenancyId,
          balanceCents: balance,
          aging: ageBalance(await ledger.getEntries(tx, tenancyId, { limit: 500 }), today()),
          nextChargeDate: upcoming,
          nextChargeCents: tenancy.monthly_rent_cents as Cents,
          dueDate,
          lateFeePolicy: humanPolicy(policy),
          lateFeesPausedUntil: tenancy.late_fee_hold_until,
          lateFeePauseReason: tenancy.late_fee_hold_reason,
          activePlan: plan,
          autopay: enrollment,
          leaseAutopays: await autopay.listForLease(tx, tenancyId),
          pendingPayments: pending,
        },
        recentEntries: entries,
        openWorkOrders,
        openDisputes,
        paymentMethods: methods,
        cardsAccepted: deps.config.payments.allowCards,
        // Everyone on the lease (016), and documents waiting on this resident (018).
        leaseMembers: await leaseMemberNames(tx, tenancyId),
        homePhotoId: await homePhotoId(tx, tenancyId),
        documentsToSign: (await listDocuments(tx, tenancyId, ctx.user!.id)).filter(
          (d) => d.requiresSignature && !d.withdrawnAt && !d.signedByMe,
        ).length,
      };
    }),
  );

  router.get("/api/v1/tenant/ledger", requires("ledger:read:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const query = api.ledgerQuery.parse(ctx.query);
      const tenancyId = await tenancyFor(ctx, tx);
      const entries = await ledger.getEntries(tx, tenancyId, query);
      // Periods are summarized from the full history, not from the page, so a
      // running balance never depends on how many rows were requested.
      const all = query.period || query.from ? await ledger.getEntries(tx, tenancyId, { limit: 5000 }) : entries;
      return {
        entries,
        periods: summarizeByPeriod(all),
        balanceCents: await ledger.getBalance(tx, tenancyId),
      };
    }),
  );

  /** Everything that produced one row: the "why is this here" endpoint. */
  router.get("/api/v1/tenant/ledger/:entryId/trace", requires("ledger:read:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const trace = await ledger.traceEntry(tx, ctx.params.entryId);
      if (!trace) throw notFound();

      const [payment, workOrder, plan, dispute, policyExplanation] = await Promise.all([
        trace.entry.paymentId ? payments.getPayment(tx, trace.entry.paymentId) : null,
        trace.entry.workOrderId ? maintenance.get(tx, trace.entry.workOrderId) : null,
        trace.entry.paymentPlanId ? plans.getActivePlan(tx, trace.entry.tenancyId) : null,
        disputes.forEntry(tx, trace.entry.id),
        ledger.explainPolicy(tx, trace.entry),
      ]);

      return { ...trace, payment, workOrder, plan, dispute, policyExplanation };
    }),
  );

  router.get("/api/v1/tenant/statement.csv", requires("ledger:read:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      const result = await exportTenancyStatement(tx, tenancyId);
      ctx.buffer(200, Buffer.from(result.body, "utf8"), result.contentType, {
        "content-disposition": `attachment; filename="${result.filename}"`,
      });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Payments
   * ---------------------------------------------------------------- */

  router.get("/api/v1/tenant/payments", requires("ledger:read:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      return { payments: await payments.listPayments(tx, tenancyId) };
    }),
  );

  router.post("/api/v1/tenant/payments", requires("payment:submit:own"), async (ctx) => {
    const input = api.submitPaymentRequest.parse(ctx.body);

    // The client supplies the key so that a retry of the *same* attempt is
    // recognized. Generating one here would defeat the entire mechanism, since
    // a retried request would get a fresh key and a second charge.
    const idempotencyKey = String(ctx.req.headers[IDEMPOTENCY_HEADER] ?? "");
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw badRequest(
        `A ${IDEMPOTENCY_HEADER} header is required on payments, so that a retry cannot charge you twice.`,
      );
    }

    // Two transactions, deliberately. The first runs as the resident, so
    // Row-Level Security is what decides whether this tenancy and this payment
    // method are theirs. The second runs as the system, because moving a
    // payment through its states and writing to the ledger are things the
    // system does on their instruction — and things a resident's own context is
    // correctly forbidden from doing.
    const authorized = await withContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      await assertMethodAccepted(tx, deps.config, input.paymentMethodId);
      return payments.authorizePayment(tx, {
        tenancyId,
        amountCents: input.amountCents,
        paymentMethodId: input.paymentMethodId,
        idempotencyKey: `${tenancyId}:${idempotencyKey}`,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
        expectedBalanceCents: input.expectedBalanceCents,
      });
    });

    if (authorized.existing) {
      // A retry of an attempt already accepted. Say so; charge nothing.
      return {
        payment: authorized.existing,
        balanceCents: authorized.balanceCents,
        deduplicated: true,
      };
    }

    const result = await withContext(pool, SYSTEM_CONTEXT, (tx) =>
      payments.submitPayment(tx, deps.payments, {
        tenancyId: authorized.tenancyId,
        amountCents: authorized.amountCents,
        paymentMethodId: authorized.methodId,
        idempotencyKey: authorized.idempotencyKey,
        actorUserId: authorized.actorUserId,
        actorRole: authorized.actorRole,
      }),
    );

    // A failed payment's bookkeeping — pausing late fees, writing the annotation
    // the resident reads, telling both parties — is system work, and runs in its
    // own transaction under the system context. Residents cannot write to the
    // ledger, so doing this inside their transaction would roll back the payment
    // record itself and leave a declined card with no trace at all.
    if (result.failureConsequence && !result.deduplicated) {
      await withContext(pool, SYSTEM_CONTEXT, async (tx) => {
        const events = await payments.applyFailureConsequence(tx, result.failureConsequence!);
        for (const event of events) {
          await emit(tx, {
            eventType: event.eventType as never,
            dedupeKey: event.dedupeKey,
            tenancyId: result.payment.tenancyId,
            payload: event.payload,
          });
        }
      });
    }

    return { payment: result.payment, balanceCents: result.balanceCents, deduplicated: result.deduplicated };
  });

  router.get("/api/v1/tenant/payments/:paymentId", requires("ledger:read:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const payment = await payments.getPayment(tx, ctx.params.paymentId);
      if (!payment) throw notFound();
      return { payment };
    }),
  );

  router.get("/api/v1/tenant/payment-methods", requires("payment:method:manage:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      return { paymentMethods: await listPaymentMethods(tx, tenancyId, deps.payments) };
    }),
  );

  router.post("/api/v1/tenant/payment-methods", requires("payment:method:manage:own"), async (ctx) => {
    const input = api.addPaymentMethodRequest.parse(ctx.body);
    if (input.kind === "card" && !deps.config.payments.allowCards) {
      throw unprocessable("This property accepts bank transfers only. Add a bank account instead.");
    }
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);

      // The token comes from the provider's client-side element. No card number
      // and no full account number has touched this process.
      const tokenized = await deps.payments.tokenize({
        kind: input.kind,
        providerToken: input.providerToken,
        tenancyId,
      });

      const row = await tx.one<{ id: string }>(
        `INSERT INTO payment_methods
           (organization_id, property_id, tenancy_id, kind, provider, provider_token,
            institution, last4, brand, exp_month, exp_year, verified, verified_at)
         SELECT t.organization_id, t.property_id, t.id, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                CASE WHEN $10 THEN now() ELSE NULL END
         FROM tenancies t WHERE t.id = $1
         RETURNING id`,
        [
          tenancyId, input.kind, deps.payments.name, tokenized.providerToken,
          tokenized.institution, tokenized.last4, tokenized.brand,
          tokenized.expMonth, tokenized.expYear, tokenized.verified,
        ],
      );

      // Whole-balance autopay only when no one else on the lease has autopay;
      // otherwise the database would refuse it (021) and the new method with it.
      const roommateAutopay = (await autopay.listForLease(tx, tenancyId)).some(
        (a) => a.setUpByUserId !== ctx.user!.id,
      );
      if (input.makeAutopayDefault && tokenized.verified && !roommateAutopay) {
        await autopay.enroll(tx, {
          tenancyId,
          paymentMethodId: row.id,
          dayOfMonth: 1,
          capCents: null,
          actorUserId: ctx.user!.id,
        });
      }

      return { paymentMethods: await listPaymentMethods(tx, tenancyId, deps.payments) };
    });
  });

  // Micro-deposit verification (012). The processor decides; this records it.
  router.post("/api/v1/tenant/payment-methods/:methodId/verify", requires("payment:method:manage:own"), async (ctx) => {
    const input = api.verifyBankRequest.parse(ctx.body);
    const method = await withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      return tx.maybeOne<{
        id: string;
        kind: string;
        verified: boolean;
        provider_token: string;
        verification_attempts: number;
        verification_locked_at: string | null;
      }>(
        `SELECT id, kind, verified, provider_token, verification_attempts, verification_locked_at::text AS verification_locked_at
         FROM payment_methods WHERE id = $1 AND tenancy_id = $2 AND removed_at IS NULL`,
        [ctx.params.methodId, tenancyId],
      );
    });
    if (!method) throw notFound();
    if (method.kind !== "ach") throw unprocessable("Only bank accounts need verifying.");
    if (method.verified) throw conflict("This bank account is already verified.");
    if (method.verification_locked_at || method.verification_attempts >= MAX_VERIFY_ATTEMPTS) {
      throw forbidden("Too many wrong amounts. The office has been told and will check this account with you.");
    }

    const ok = await deps.payments.verifyMicrodeposits({
      providerToken: method.provider_token,
      amountsCents: [input.amountsCents[0]!, input.amountsCents[1]!],
    });

    // Written as the system: whether an account is verified is the processor's
    // answer, not something a resident's session should be able to set.
    await withContext(pool, SYSTEM_CONTEXT, (tx) =>
      ok
        ? tx.query("UPDATE payment_methods SET verified = true, verified_at = now() WHERE id = $1", [method.id])
        : tx.query(
            `UPDATE payment_methods
             SET verification_attempts = verification_attempts + 1,
                 verification_locked_at = CASE WHEN verification_attempts + 1 >= $2 THEN now() ELSE NULL END
             WHERE id = $1`,
            [method.id, MAX_VERIFY_ATTEMPTS],
          ),
    );

    const paymentMethods = await withReadOnlyContext(pool, ctx.dbContext(), async (tx) =>
      listPaymentMethods(tx, await tenancyFor(ctx, tx), deps.payments),
    );
    if (!ok) {
      const left = paymentMethods.find((m) => m.id === method.id)?.verificationAttemptsLeft ?? 0;
      throw unprocessable(
        left > 0
          ? `Those amounts do not match. ${left} ${left === 1 ? "try" : "tries"} left.`
          : "Those amounts do not match, and this account is now locked. The office will check it with you.",
      );
    }
    return { paymentMethods, verified: true };
  });

  router.delete("/api/v1/tenant/payment-methods/:methodId", requires("payment:method:manage:own"), async (ctx) =>
    withContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      const inUse = await tx.maybeOne<{ id: string }>(
        "SELECT id FROM autopay_enrollments WHERE payment_method_id = $1 AND active",
        [ctx.params.methodId],
      );
      if (inUse) {
        throw unprocessable(
          "This method is being used for autopay. Cancel or change autopay first, so that a draft does not fail unexpectedly.",
        );
      }
      await tx.query(
        "UPDATE payment_methods SET removed_at = now() WHERE id = $1 AND tenancy_id = $2",
        [ctx.params.methodId, tenancyId],
      );
      return { paymentMethods: await listPaymentMethods(tx, tenancyId, deps.payments) };
    }),
  );

  /* ---------------------------------------------------------------- *
   * Autopay
   * ---------------------------------------------------------------- */

  router.get("/api/v1/tenant/autopay", requires("autopay:manage:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      return { autopay: await autopay.get(tx, tenancyId), leaseAutopays: await autopay.listForLease(tx, tenancyId) };
    }),
  );

  router.post("/api/v1/tenant/autopay", requires("autopay:manage:own"), async (ctx) => {
    const input = api.autopayRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      await assertMethodAccepted(tx, deps.config, input.paymentMethodId);
      // Split rent (021): each resident has their own autopay, either for
      // their share or (when no one else has one) for the whole balance. The
      // database refuses a combination that would draft the rent twice, and a
      // roommate's autopay is never replaced from here.
      const enrollment = await autopay.enroll(tx, {
        tenancyId,
        paymentMethodId: input.paymentMethodId,
        dayOfMonth: input.dayOfMonth,
        capCents: input.capCents,
        shareCents: input.shareCents,
        actorUserId: ctx.user!.id,
      });
      return { autopay: enrollment };
    });
  });

  router.delete("/api/v1/tenant/autopay", requires("autopay:manage:own"), async (ctx) =>
    withContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      // Only your own autopay. A roommate's is theirs to stop (or the office's).
      const stopped = await autopay.cancel(tx, tenancyId, ctx.user!.id);
      if (!stopped) {
        const covering = await autopay.get(tx, tenancyId);
        if (covering && covering.setUpByMe === false) {
          throw conflict(
            `Autopay on this lease was set up by ${covering.setUpByName ?? "another resident"}, so only they can turn it off.`,
          );
        }
      }
      return { autopay: await autopay.get(tx, tenancyId), leaseAutopays: await autopay.listForLease(tx, tenancyId) };
    }),
  );

  /* ---------------------------------------------------------------- *
   * Disputes
   * ---------------------------------------------------------------- */

  router.get("/api/v1/tenant/disputes", requires("dispute:open:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      return { disputes: await disputes.listForTenancy(tx, tenancyId) };
    }),
  );

  router.post("/api/v1/tenant/disputes", requires("dispute:open:own"), async (ctx) => {
    const input = api.openDisputeRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      const dispute = await disputes.openDispute(tx, {
        ledgerEntryId: input.ledgerEntryId,
        tenancyId,
        reason: input.reason,
        actorUserId: ctx.user!.id,
      });

      const entry = await ledger.getEntry(tx, input.ledgerEntryId);
      const context = await tx.one<{ unit_label: string; resident_name: string; property_id: string }>(
        `SELECT u.label AS unit_label, r.display_name AS resident_name, t.property_id
         FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN users r ON r.id = t.resident_user_id
         WHERE t.id = $1`,
        [tenancyId],
      );

      await emit(tx, {
        eventType: "dispute.opened",
        dedupeKey: `dispute.opened:${dispute.id}`,
        tenancyId,
        propertyId: context.property_id,
        payload: {
          disputeId: dispute.id,
          unitLabel: context.unit_label,
          residentName: context.resident_name,
          description: entry?.description,
          amountCents: Math.abs(entry?.amountCents ?? 0),
          reason: input.reason,
        },
      });

      return { dispute };
    });
  });

  router.delete("/api/v1/tenant/disputes/:disputeId", requires("dispute:open:own"), async (ctx) =>
    withContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      await disputes.withdraw(tx, ctx.params.disputeId, tenancyId);
      return { disputes: await disputes.listForTenancy(tx, tenancyId) };
    }),
  );

  /* ---------------------------------------------------------------- *
   * Maintenance
   * ---------------------------------------------------------------- */

  router.get("/api/v1/tenant/work-orders", requires("workorder:read:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      return {
        workOrders: await maintenance.listForTenancy(tx, tenancyId),
        priorityGuidance: PRIORITY_GUIDANCE,
      };
    }),
  );

  router.post("/api/v1/tenant/work-orders", requires("workorder:submit:own"), async (ctx) => {
    const input = api.submitWorkOrderRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      const workOrder = await maintenance.submit(tx, {
        tenancyId,
        category: input.category,
        priority: input.priority,
        title: input.title,
        description: input.description,
        entryPermission: input.entryPermission,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });

      await emit(tx, {
        eventType: "workorder.submitted",
        dedupeKey: `workorder.submitted:${workOrder.id}`,
        tenancyId,
        payload: {
          reference: workOrder.reference,
          title: workOrder.title,
          description: workOrder.description,
          priority: workOrder.priority,
          priorityGuidance: PRIORITY_GUIDANCE[workOrder.priority],
          targetHours: PRIORITY_TARGET_HOURS[workOrder.priority],
          unitLabel: workOrder.unitLabel,
          residentName: workOrder.residentName,
          entryPermission: workOrder.entryPermission,
        },
      });

      return { workOrder };
    });
  });

  router.get("/api/v1/tenant/work-orders/:workOrderId", requires("workorder:read:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const workOrder = await maintenance.get(tx, ctx.params.workOrderId);
      if (!workOrder) throw notFound();
      return { workOrder };
    }),
  );

  router.post("/api/v1/tenant/work-orders/:workOrderId/notes", requires("workorder:submit:own"), async (ctx) => {
    const input = api.workOrderNoteRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const workOrder = await maintenance.update(tx, {
        workOrderId: ctx.params.workOrderId,
        note: input.note,
        visibleToResident: true,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });
      return { workOrder };
    });
  });

  /** Reopen: a resident saying "this is not actually fixed" must be actionable. */
  router.post("/api/v1/tenant/work-orders/:workOrderId/reopen", requires("workorder:submit:own"), async (ctx) => {
    const input = api.workOrderNoteRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const workOrder = await maintenance.update(tx, {
        workOrderId: ctx.params.workOrderId,
        status: "in_progress",
        note: `Reopened by resident: ${input.note}`,
        visibleToResident: true,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });
      return { workOrder };
    });
  });

  /* ---------------------------------------------------------------- *
   * Photos
   * ---------------------------------------------------------------- */

  router.post("/api/v1/tenant/work-orders/:workOrderId/photos", AUTHENTICATED, async (ctx) => {
    const contentType = String(ctx.req.headers["content-type"] ?? "");
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

    // Trust the bytes, not the header. A file that claims to be a JPEG and is
    // actually HTML is how a photo upload becomes stored XSS.
    const sniffed = sniffImageType(body);
    if (!sniffed || !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(sniffed)) {
      throw badRequest("That file does not look like a JPEG, PNG, WebP, or HEIC image.");
    }
    if (contentType && !contentType.startsWith("image/")) {
      throw badRequest("Photos must be uploaded with an image content type.");
    }

    const key = newObjectKey("work-orders");
    await deps.storage.put(key, body, sniffed);

    return withContext(pool, ctx.dbContext(), async (tx) => {
      const photoId = await maintenance.attachPhoto(tx, {
        workOrderId: ctx.params.workOrderId,
        objectKey: key,
        contentType: sniffed,
        sizeBytes: body.length,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });
      return { photoId, workOrder: await maintenance.get(tx, ctx.params.workOrderId) };
    });
  });

  /**
   * Serve a photo.
   *
   * Authorization is a database read under the caller's own context: if RLS does
   * not return the row, the caller does not get the bytes. There is no signed
   * URL to leak and no object that is readable without a session.
   */
  router.get("/api/v1/photos/:photoId", AUTHENTICATED, async (ctx) => {
    const photo = await withReadOnlyContext(pool, ctx.dbContext(), (tx) =>
      tx.maybeOne<{ object_key: string; content_type: string }>(
        "SELECT object_key, content_type FROM work_order_photos WHERE id = $1",
        [ctx.params.photoId],
      ),
    );
    if (!photo) throw notFound();

    const object = await deps.storage.get(photo.object_key);
    if (!object) throw notFound();

    ctx.buffer(200, object.body, photo.content_type, {
      "cache-control": "private, max-age=300, no-store",
      "content-disposition": "inline",
    });
  });

  /* ---------------------------------------------------------------- *
   * What was sent to me
   * ---------------------------------------------------------------- */

  /**
   * A resident can read every notice this system sent them. "I was never told"
   * becomes a checkable claim rather than one party's word against the other's.
   */
  router.get("/api/v1/tenant/notifications", requires("ledger:read:own"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = await tenancyFor(ctx, tx);
      const { listForTenancy } = await import("../domain/notifications.ts");
      return { notifications: await listForTenancy(tx, tenancyId) };
    }),
  );
}

const MAX_VERIFY_ATTEMPTS = 3;

async function listPaymentMethods(tx: Tx, tenancyId: string, provider?: PaymentProvider) {
  const rows = await tx.many<{
    id: string;
    kind: "ach" | "card";
    provider_token: string;
    verification_attempts: number;
    verification_locked_at: string | null;
    institution: string | null;
    brand: string | null;
    last4: string | null;
    verified: boolean;
    created_at: string;
    is_autopay_default: boolean;
  }>(
    `SELECT m.id, m.kind, m.institution, m.brand, m.last4, m.verified, m.provider_token,
            m.verification_attempts, m.verification_locked_at::text AS verification_locked_at,
            m.created_at::text AS created_at,
            EXISTS (SELECT 1 FROM autopay_enrollments a
                    WHERE a.payment_method_id = m.id AND a.active) AS is_autopay_default
     FROM payment_methods m
     WHERE m.tenancy_id = $1 AND m.removed_at IS NULL
     ORDER BY m.created_at`,
    [tenancyId],
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.last4
      ? `${row.institution ?? row.brand ?? "Payment method"} ••••${row.last4}`
      : (row.institution ?? row.brand ?? "Payment method"),
    last4: row.last4,
    institution: row.institution ?? row.brand,
    verified: row.verified,
    isAutopayDefault: row.is_autopay_default,
    addedAt: row.created_at,
    verificationLocked: row.verification_locked_at !== null,
    verificationAttemptsLeft: Math.max(0, MAX_VERIFY_ATTEMPTS - row.verification_attempts),
    simulatedDepositsCents:
      provider?.isSimulated && row.kind === "ach" && !row.verified ? provider.simulatedMicrodeposits(row.provider_token) : null,
  }));
}
