/**
 * Manager and staff routes.
 *
 * Every discretionary action here appends to the ledger with an actor and a
 * required reason, and none of them updates or deletes anything. The route
 * layer's job is to validate, name the actor, and get out of the way.
 *
 * Note which routes staff can reach: maintenance, and nothing else. That is the
 * delegation guarantee the proposal describes, and it is enforced three times
 * over — by the capability declared on the route, by CAPABILITIES_BY_ROLE, and
 * by the Row-Level Security policies that give staff no visibility into the
 * ledger at all.
 */

import type { Router } from "../http/router.ts";
import { requires, roles } from "../http/router.ts";
import { badRequest, notFound, unprocessable } from "../http/errors.ts";
import { withContext, withReadOnlyContext } from "../db/context.ts";
import type { Pool } from "../db/pool.ts";
import type { Config } from "../config.ts";
import * as api from "../../../../packages/shared/src/api.ts";
import { periodOf, today } from "../../../../packages/shared/src/ids.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import { PRIORITY_GUIDANCE, PRIORITY_TARGET_HOURS } from "../../../../packages/shared/src/maintenance.ts";
import * as ledger from "../domain/ledger.ts";
import * as rentroll from "../domain/rentroll.ts";
import * as plans from "../domain/plans.ts";
import * as payments from "../domain/payments.ts";
import * as disputes from "../domain/disputes.ts";
import * as maintenance from "../domain/maintenance.ts";
import { dashboard } from "../domain/dashboard.ts";
import { listTenants, listUnits } from "../domain/directory.ts";
import { can } from "../../../../packages/shared/src/roles.ts";
import { postPeriod } from "../domain/charges.ts";
import { getLeasePolicy, getPolicy, humanPolicy } from "../domain/latefees.ts";
import { emit } from "../domain/notifications.ts";
import { exportPeriod } from "../domain/exports.ts";

export function registerManagerRoutes(router: Router, deps: { pool: Pool; config: Config }): void {
  const { pool } = deps;

  /* ---------------------------------------------------------------- *
   * Rent roll and exceptions
   * ---------------------------------------------------------------- */

  // The dashboard is a view over the rent roll, so it needs the rent roll's
  // capability. Maintenance counts are included only for roles that can read
  // maintenance; an owner gets the financial half and no zeros pretending to be data.
  router.get("/api/v1/manager/dashboard", requires("rentroll:read"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const query = api.dashboardQuery.parse(ctx.query);
      return dashboard(tx, {
        period: query.period,
        propertyId: query.propertyId,
        includeMaintenance: can(ctx.user!.role, "workorder:read:property"),
      });
    }),
  );

  // The Units and Tenants screens. Lease terms and balances are financial, so
  // these need the rent roll's capability: on-site staff do not get them.
  router.get("/api/v1/manager/units", requires("rentroll:read"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const occupancy = ctx.query.occupancy === "occupied" || ctx.query.occupancy === "vacant" ? ctx.query.occupancy : "all";
      return { units: await listUnits(tx, { propertyId: ctx.query.propertyId || undefined, occupancy }) };
    }),
  );

  router.get("/api/v1/manager/tenants", requires("rentroll:read"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => ({
      tenants: await listTenants(tx, {
        propertyId: ctx.query.propertyId || undefined,
        status: ctx.query.status === "all" ? "all" : "active",
        search: ctx.query.search ? String(ctx.query.search).slice(0, 120) : undefined,
      }),
    })),
  );

  router.get("/api/v1/manager/rent-roll", requires("rentroll:read"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const query = api.rentRollQuery.parse(ctx.query);
      return rentroll.rentRoll(tx, query);
    }),
  );

  router.get("/api/v1/manager/exceptions", requires("rentroll:read"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const period = ctx.query.period ? api.rentRollQuery.parse({ period: ctx.query.period }).period : undefined;
      return rentroll.exceptions(tx, { period, propertyId: ctx.query.propertyId });
    }),
  );

  router.get("/api/v1/manager/tenancies/:tenancyId", requires("ledger:read:property"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const tenancyId = ctx.params.tenancyId;
      const tenancy = await tx.maybeOne<{
        id: string;
        unit_label: string;
        property_name: string;
        property_id: string;
        resident_name: string;
        resident_email: string;
        resident_phone: string | null;
        monthly_rent_cents: number;
        rent_due_day: number;
        deposit_cents: number;
        starts_on: string;
        ends_on: string | null;
        status: string;
        late_fee_hold_until: string | null;
        late_fee_hold_reason: string | null;
      }>(
        `SELECT t.id, u.label AS unit_label, p.name AS property_name, t.property_id,
                r.display_name AS resident_name, r.email AS resident_email, r.phone AS resident_phone,
                t.monthly_rent_cents, t.rent_due_day, t.deposit_cents, t.starts_on::text AS starts_on,
                t.ends_on::text AS ends_on, t.status,
                t.late_fee_hold_until::text AS late_fee_hold_until, t.late_fee_hold_reason
         FROM tenancies t
         JOIN units u ON u.id = t.unit_id
         JOIN properties p ON p.id = t.property_id
         JOIN users r ON r.id = t.resident_user_id
         WHERE t.id = $1`,
        [tenancyId],
      );
      if (!tenancy) throw notFound();

      const [entries, balance, plan, allPayments, openDisputes, workOrders, policy] = await Promise.all([
        ledger.getEntries(tx, tenancyId, { limit: 500 }),
        ledger.getBalance(tx, tenancyId),
        plans.getActivePlan(tx, tenancyId),
        payments.listPayments(tx, tenancyId, 30),
        disputes.listForTenancy(tx, tenancyId),
        maintenance.listForTenancy(tx, tenancyId),
        getPolicy(tx, tenancy.property_id),
      ]);
      const leasePolicy = await getLeasePolicy(tx, tenancyId);

      return {
        tenancy,
        balanceCents: balance,
        entries,
        activePlan: plan,
        payments: allPayments,
        disputes: openDisputes,
        workOrders,
        lateFeePolicy: humanPolicy(leasePolicy ?? policy),
        // Both sets of terms, so the lease screen can show what the lease would
        // fall back to if its own terms were removed.
        leaseLateFee: leasePolicy ? lateFeeTerms(leasePolicy) : null,
        propertyLateFee: policy ? lateFeeTerms(policy) : null,
        propertyLateFeeText: humanPolicy(policy),
      };
    }),
  );

  /* ---------------------------------------------------------------- *
   * Discretionary actions
   *
   * Each writes an appended ledger row carrying who did it and why. None of
   * them can modify or remove what is already there.
   * ---------------------------------------------------------------- */

  router.post("/api/v1/manager/waive-fee", requires("ledger:write:discretionary"), async (ctx) => {
    const input = api.waiveFeeRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const { original, reversal } = await plans.waiveFee(tx, {
        ledgerEntryId: input.ledgerEntryId,
        amountCents: input.amountCents,
        reason: input.reason,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });

      await emit(tx, {
        eventType: "late_fee.waived",
        dedupeKey: `late_fee.waived:${reversal.id}`,
        tenancyId: original.tenancyId,
        payload: {
          amountCents: Math.abs(reversal.amountCents),
          reason: input.reason,
          actorName: ctx.user!.displayName,
          balanceCents: await ledger.getBalance(tx, original.tenancyId),
        },
      });

      await audit(tx, ctx, "ledger.waive", "ledger_entry", original.id, {
        reversalId: reversal.id,
        amountCents: reversal.amountCents,
        reason: input.reason,
      });

      return {
        original,
        reversal,
        balanceCents: await ledger.getBalance(tx, original.tenancyId),
      };
    });
  });

  router.post("/api/v1/manager/record-payment", requires("ledger:write:discretionary"), async (ctx) => {
    const input = api.recordPaymentRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const result = await payments.recordOfflinePayment(tx, {
        tenancyId: input.tenancyId,
        amountCents: input.amountCents,
        method: input.method,
        receivedOn: input.receivedOn,
        reference: input.reference,
        reason: input.reason,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });

      await emit(tx, {
        eventType: "payment.receipt",
        dedupeKey: `payment.receipt:${result.payment.id}`,
        tenancyId: input.tenancyId,
        payload: {
          paymentId: result.payment.id,
          amountCents: result.payment.amountCents,
          receiptNumber: result.payment.receiptNumber,
          methodLabel: result.payment.methodLabel,
          balanceCents: result.balanceCents,
        },
      });

      await audit(tx, ctx, "payment.recorded", "payment", result.payment.id, {
        amountCents: input.amountCents,
        method: input.method,
        reason: input.reason,
      });

      return result;
    });
  });

  router.post("/api/v1/manager/adjustments", requires("ledger:write:discretionary"), async (ctx) => {
    const input = api.adjustmentRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const entry = await plans.postAdjustment(tx, {
        tenancyId: input.tenancyId,
        category: input.category,
        amountCents: input.amountCents,
        description: input.description,
        effectiveDate: input.effectiveDate,
        reason: input.reason,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });

      await emit(tx, {
        eventType: "charge.posted",
        dedupeKey: `charge.posted:${entry.id}`,
        tenancyId: input.tenancyId,
        payload: {
          description: entry.description,
          amountCents: entry.amountCents,
          effectiveDate: entry.effectiveDate,
          balanceCents: await ledger.getBalance(tx, input.tenancyId),
        },
      });

      await audit(tx, ctx, "ledger.adjustment", "ledger_entry", entry.id, {
        amountCents: input.amountCents,
        reason: input.reason,
      });

      return { entry, balanceCents: await ledger.getBalance(tx, input.tenancyId) };
    });
  });

  router.post("/api/v1/manager/reverse", requires("ledger:write:discretionary"), async (ctx) => {
    const input = api.reverseEntryRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const result = await ledger.reverseEntry(tx, {
        entryId: input.ledgerEntryId,
        reason: input.reason,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });
      await audit(tx, ctx, "ledger.reverse", "ledger_entry", input.ledgerEntryId, {
        reversalId: result.reversal.id,
        reason: input.reason,
      });
      return {
        ...result,
        balanceCents: await ledger.getBalance(tx, result.original.tenancyId),
      };
    });
  });

  router.post("/api/v1/manager/payment-plans", requires("ledger:write:discretionary"), async (ctx) => {
    const input = api.paymentPlanRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const plan = await plans.openPlan(tx, {
        tenancyId: input.tenancyId,
        totalCents: input.totalCents,
        installments: input.installments,
        firstDueDate: input.firstDueDate,
        intervalDays: input.intervalDays,
        reason: input.reason,
        suspendLateFees: input.suspendLateFees,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });

      await emit(tx, {
        eventType: "payment_plan.opened",
        dedupeKey: `payment_plan.opened:${plan.id}`,
        tenancyId: input.tenancyId,
        payload: {
          totalCents: plan.totalCents,
          installments: plan.installments.map((i) => ({ dueDate: i.dueDate, amountCents: i.amountCents })),
          suspendsLateFees: plan.suspendsLateFees,
          reason: plan.reason,
          openedByName: ctx.user!.displayName,
        },
      });

      await audit(tx, ctx, "plan.opened", "payment_plan", plan.id, {
        totalCents: input.totalCents,
        installments: input.installments,
        reason: input.reason,
      });

      return { plan };
    });
  });

  router.delete("/api/v1/manager/payment-plans/:planId", requires("ledger:write:discretionary"), async (ctx) => {
    const reason = typeof (ctx.body as { reason?: string })?.reason === "string"
      ? (ctx.body as { reason: string }).reason
      : "";
    if (reason.trim().length < 4) throw badRequest("Please state why the plan is being cancelled.");
    return withContext(pool, ctx.dbContext(), async (tx) => {
      await plans.cancelPlan(tx, ctx.params.planId, reason, {
        userId: ctx.user!.id,
        role: ctx.user!.role,
      });
      await audit(tx, ctx, "plan.cancelled", "payment_plan", ctx.params.planId, { reason });
      return { ok: true };
    });
  });

  /* ---------------------------------------------------------------- *
   * Charges
   * ---------------------------------------------------------------- */

  router.post("/api/v1/manager/post-charges", requires("charges:post"), async (ctx) => {
    const input = api.postChargesRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const result = await postPeriod(tx, input.period, {
        propertyId: input.propertyId,
        dryRun: input.dryRun,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });

      if (!input.dryRun) {
        for (const charge of result.planned.filter((p) => !p.alreadyPosted)) {
          await emit(tx, {
            eventType: "charge.posted",
            dedupeKey: `charge.posted:${charge.idempotencyKey}`,
            tenancyId: charge.tenancyId,
            payload: {
              description: charge.description,
              amountCents: charge.amountCents,
              effectiveDate: charge.effectiveDate,
              balanceCents: await ledger.getBalance(tx, charge.tenancyId),
            },
          });
        }
        await audit(tx, ctx, "charges.posted", "period", null, {
          period: input.period,
          count: result.posted,
          totalCents: result.totalCents,
        });
      }

      return {
        period: input.period,
        dryRun: input.dryRun,
        posted: result.planned.map((p) => ({
          tenancyId: p.tenancyId,
          unitLabel: p.unitLabel,
          residentName: p.residentName,
          category: p.category,
          amountCents: p.amountCents,
          description: p.description,
          alreadyPosted: p.alreadyPosted,
        })),
        totalCents: result.totalCents,
        newCount: result.planned.filter((p) => !p.alreadyPosted).length,
        skippedCount: result.skipped,
      };
    });
  });

  /* ---------------------------------------------------------------- *
   * Disputes
   * ---------------------------------------------------------------- */

  router.get("/api/v1/manager/disputes", requires("dispute:respond"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const rows = await tx.many<{ id: string; tenancy_id: string }>(
        `SELECT id, tenancy_id FROM charge_disputes
         WHERE status IN ('open','responded')
           AND ($1::uuid IS NULL OR property_id = $1::uuid)
         ORDER BY opened_at`,
        [ctx.query.propertyId ?? null],
      );
      const full = await Promise.all(rows.map((row) => disputes.getDispute(tx, row.id)));
      return { disputes: full.filter(Boolean) };
    }),
  );

  router.post("/api/v1/manager/disputes/respond", requires("dispute:respond"), async (ctx) => {
    const input = api.respondToDisputeRequest.parse(ctx.body);
    if (input.resolution === "adjusted" && !input.adjustmentCents) {
      throw unprocessable("State the amount to adjust when resolving a dispute in the resident's favour.");
    }
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const dispute = await disputes.respond(tx, {
        disputeId: input.disputeId,
        response: input.response,
        resolution: input.resolution,
        adjustmentCents: input.adjustmentCents,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });

      await emit(tx, {
        eventType: "dispute.responded",
        dedupeKey: `dispute.responded:${dispute.id}:${dispute.respondedAt}`,
        tenancyId: dispute.tenancyId,
        payload: {
          response: input.response,
          responderName: ctx.user!.displayName,
          adjusted: input.resolution === "adjusted",
          adjustmentCents: input.adjustmentCents ?? 0,
          balanceCents: await ledger.getBalance(tx, dispute.tenancyId),
        },
      });

      await audit(tx, ctx, "dispute.responded", "dispute", dispute.id, {
        resolution: input.resolution,
        adjustmentCents: input.adjustmentCents,
      });

      return { dispute };
    });
  });

  /* ---------------------------------------------------------------- *
   * Maintenance — the one area on-site staff can reach
   * ---------------------------------------------------------------- */

  router.get("/api/v1/manager/work-orders", requires("workorder:read:property"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => ({
      workOrders: await maintenance.listForProperty(tx, {
        propertyId: ctx.query.propertyId,
        status: (ctx.query.status as "open" | "all") ?? "open",
      }),
      targetHours: PRIORITY_TARGET_HOURS,
    })),
  );

  // Filing on a resident's behalf: a phone call, a walk-through, a neighbour's
  // report. The request lands in the same queue and the resident's own thread,
  // attributed to the person who filed it. RLS limits it to assigned properties.
  router.post("/api/v1/manager/work-orders", requires("workorder:triage"), async (ctx) => {
    const input = api.managerSubmitWorkOrderRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const workOrder = await maintenance.submit(tx, {
        tenancyId: input.tenancyId,
        category: input.category,
        priority: input.priority,
        title: input.title,
        description: input.description,
        entryPermission: input.entryPermission,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });
      // A tenancy outside the caller's properties yields no row from
      // app.work_order_context(), which tx.one() reports as not-found: to this
      // caller, that tenancy does not exist.

      await emit(tx, {
        eventType: "workorder.submitted",
        dedupeKey: `workorder.submitted:${workOrder.id}`,
        tenancyId: input.tenancyId,
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

      await audit(tx, ctx, "workorder.filed_for_resident", "work_order", workOrder.id, {
        reference: workOrder.reference,
        priority: workOrder.priority,
      });

      return { workOrder };
    });
  });

  router.get("/api/v1/manager/work-orders/:workOrderId", requires("workorder:read:property"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const workOrder = await maintenance.get(tx, ctx.params.workOrderId);
      if (!workOrder) throw notFound();
      return { workOrder };
    }),
  );

  router.post("/api/v1/manager/work-orders/:workOrderId", requires("workorder:triage"), async (ctx) => {
    const input = api.updateWorkOrderRequest.parse(ctx.body);

    // Staff triage maintenance; they do not post money. The capability check on
    // the route allows them here, so the money-shaped part of this request is
    // refused separately and explicitly.
    if (input.creditCents !== undefined && ctx.user!.role !== "manager") {
      throw notFound();
    }

    return withContext(pool, ctx.dbContext(), async (tx) => {
      const workOrder = await maintenance.update(tx, {
        workOrderId: ctx.params.workOrderId,
        status: input.status,
        note: input.note,
        visibleToResident: input.visibleToResident,
        assignedToUserId: input.assignedToUserId,
        creditCents: input.creditCents,
        creditReason: input.creditReason,
        actorUserId: ctx.user!.id,
        actorRole: ctx.user!.role,
      });

      if (input.status && input.visibleToResident) {
        const resolved = input.status === "resolved" || input.status === "closed";
        await emit(tx, {
          eventType: resolved ? "workorder.resolved" : "workorder.status_changed",
          dedupeKey: `workorder.${input.status}:${workOrder.id}:${workOrder.events.length}`,
          tenancyId: workOrder.tenancyId,
          payload: {
            reference: workOrder.reference,
            title: workOrder.title,
            status: input.status,
            note: input.note ?? null,
            creditCents: input.creditCents ?? null,
          },
        });
      }

      return { workOrder };
    });
  });

  /* ---------------------------------------------------------------- *
   * Policy and exports
   * ---------------------------------------------------------------- */

  router.get("/api/v1/manager/late-fee-policy", requires("policy:configure"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const properties = await tx.many<{ id: string; name: string }>("SELECT id, name FROM properties ORDER BY name");
      const policies = await Promise.all(
        properties.map(async (property) => {
          const policy = await getPolicy(tx, property.id);
          return {
            propertyId: property.id,
            propertyName: property.name,
            enabled: policy?.enabled ?? false,
            graceDays: policy?.grace_days ?? 5,
            feeType: policy?.fee_type ?? "flat",
            flatCents: (policy?.flat_cents ?? 0) as Cents,
            percent: policy?.percent ?? 0,
            dailyCents: (policy?.daily_cents ?? 0) as Cents,
            maxCents: (policy?.max_cents ?? 0) as Cents,
            minBalanceCents: (policy?.min_balance_cents ?? 0) as Cents,
            plainLanguage: humanPolicy(policy),
          };
        }),
      );
      return { policies };
    }),
  );

  router.post("/api/v1/manager/late-fee-policy", requires("policy:configure"), async (ctx) => {
    const input = api.lateFeePolicyRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      await tx.query(
        `INSERT INTO late_fee_policies
           (property_id, organization_id, enabled, grace_days, fee_type, flat_cents, percent,
            daily_cents, max_cents, min_balance_cents, updated_by_user_id, updated_at)
         SELECT p.id, p.organization_id, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()
         FROM properties p WHERE p.id = $1
         ON CONFLICT (property_id) DO UPDATE SET
           enabled = EXCLUDED.enabled, grace_days = EXCLUDED.grace_days,
           fee_type = EXCLUDED.fee_type, flat_cents = EXCLUDED.flat_cents,
           percent = EXCLUDED.percent, daily_cents = EXCLUDED.daily_cents,
           max_cents = EXCLUDED.max_cents, min_balance_cents = EXCLUDED.min_balance_cents,
           updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
        [
          input.propertyId, input.enabled, input.graceDays, input.feeType, input.flatCents,
          input.percent, input.dailyCents, input.maxCents, input.minBalanceCents, ctx.user!.id,
        ],
      );

      // A policy change is exactly the kind of decision that needs to be
      // attributable months later, when a resident asks why the rule changed.
      await audit(tx, ctx, "policy.late_fee_changed", "property", input.propertyId, {
        enabled: input.enabled,
        graceDays: input.graceDays,
        feeType: input.feeType,
        flatCents: input.flatCents,
        percent: input.percent,
      });

      const policy = await getPolicy(tx, input.propertyId);
      return { policy, plainLanguage: humanPolicy(policy) };
    });
  });

  router.get("/api/v1/manager/export", requires("export:generate"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const query = api.exportQuery.parse(ctx.query);
      const result = await exportPeriod(tx, {
        period: query.period,
        propertyId: query.propertyId,
        audience: query.audience,
        format: query.format,
      });
      ctx.buffer(200, Buffer.from(result.body, "utf8"), result.contentType, {
        "content-disposition": `attachment; filename="${result.filename}"`,
      });
    }),
  );

  /* ---------------------------------------------------------------- *
   * Delegation
   * ---------------------------------------------------------------- */

  /**
   * Who can see what, in a form a manager can check for themselves.
   *
   * The proposal treats this as a usability requirement rather than only a
   * security one: if a manager cannot verify without help that an on-site agent
   * cannot read the rent roll, the permission model is not legible enough,
   * regardless of whether the database is correct.
   */
  router.get("/api/v1/manager/staff", requires("staff:manage"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const staff = await tx.many<{
        user_id: string;
        display_name: string;
        email: string;
        role: string;
        property_id: string;
        property_name: string;
        granted_at: string;
        revoked_at: string | null;
      }>(
        `SELECT u.id AS user_id, u.display_name, u.email, u.role,
                sa.property_id, p.name AS property_name,
                sa.granted_at::text AS granted_at, sa.revoked_at::text AS revoked_at
         FROM staff_assignments sa
         JOIN users u ON u.id = sa.user_id
         JOIN properties p ON p.id = sa.property_id
         ORDER BY p.name, u.display_name`,
      );
      const { CAPABILITIES_BY_ROLE, ROLE_DESCRIPTIONS, ROLE_LABELS } = await import(
        "../../../../packages/shared/src/roles.ts"
      );
      return { staff, capabilitiesByRole: CAPABILITIES_BY_ROLE, roleLabels: ROLE_LABELS, roleDescriptions: ROLE_DESCRIPTIONS };
    }),
  );

  router.get("/api/v1/manager/audit", roles("manager", "owner"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const rows = await tx.many<{
        id: string;
        action: string;
        actor_name: string | null;
        actor_role: string | null;
        subject_type: string | null;
        subject_id: string | null;
        detail: unknown;
        occurred_at: string;
      }>(
        `SELECT a.id, a.action, u.display_name AS actor_name, a.actor_role,
                a.subject_type, a.subject_id, a.detail, a.occurred_at::text AS occurred_at
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE ($1::uuid IS NULL OR a.subject_id = $1::uuid)
         ORDER BY a.occurred_at DESC
         LIMIT 200`,
        [ctx.query.subjectId ?? null],
      );
      return { entries: rows };
    }),
  );

  router.get("/api/v1/manager/properties", roles("manager", "owner", "staff"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const properties = await tx.many<{
        id: string;
        name: string;
        city: string;
        state: string;
        unit_count: number;
        occupied: number;
        cover_photo_id: string | null;
      }>(
        `SELECT p.id, p.name, p.city, p.state,
                (SELECT count(*) FROM units u WHERE u.property_id = p.id)::int AS unit_count,
                (SELECT count(*) FROM tenancies t WHERE t.property_id = p.id AND t.status = 'active')::int AS occupied,
                (SELECT ph.id FROM property_photos ph WHERE ph.property_id = p.id AND ph.unit_id IS NULL
                   AND ph.is_cover AND ph.removed_at IS NULL LIMIT 1) AS cover_photo_id
         FROM properties p ORDER BY p.name`,
      );
      return { properties, period: periodOf(today()) };
    }),
  );
}

async function audit(
  tx: import("../db/context.ts").Tx,
  ctx: import("../http/context.ts").HttpContext,
  action: string,
  subjectType: string,
  subjectId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, detail, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      ctx.user!.organizationId, ctx.user!.id, ctx.user!.role, action,
      subjectType, subjectId, JSON.stringify(detail), ctx.ip,
    ],
  );
}

function lateFeeTerms(policy: NonNullable<Awaited<ReturnType<typeof getPolicy>>> & { note?: string | null }) {
  return {
    enabled: policy.enabled,
    graceDays: policy.grace_days,
    feeType: policy.fee_type,
    flatCents: Number(policy.flat_cents) as Cents,
    percent: Number(policy.percent),
    dailyCents: Number(policy.daily_cents) as Cents,
    maxCents: Number(policy.max_cents) as Cents,
    minBalanceCents: Number(policy.min_balance_cents) as Cents,
    note: policy.note ?? null,
  };
}
