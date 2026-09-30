/**
 * The scheduled job runner.
 *
 * Six jobs, all idempotent, all safe to run more often than needed and safe to
 * miss. That property is deliberate: a self-hosted box gets rebooted, a
 * container gets rescheduled, and a system where "the charge job did not run at
 * midnight on the 1st" is unrecoverable is a system that will eventually bill
 * two hundred people twice or not at all.
 *
 * Each run is recorded in `job_runs`, so a charge that did not post is a
 * question with an answer rather than a mystery.
 */

import type { Pool } from "../db/pool.ts";
import { SYSTEM_CONTEXT, withContext, type Tx } from "../db/context.ts";
import type { Config } from "../config.ts";
import type { PaymentProvider } from "../providers/payments/index.ts";
import type { Transport } from "../providers/notify/index.ts";
import { periodOf, today, addDays } from "../../../../packages/shared/src/ids.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import { postPeriod } from "../domain/charges.ts";
import { assessProperty, effectivePolicy, humanPolicy, postAssessments } from "../domain/latefees.ts";
import { dispatchPending, emit } from "../domain/notifications.ts";
import * as autopay from "../domain/autopay.ts";
import { applyFailureConsequence, submitPayment } from "../domain/payments.ts";
import { getBalance } from "../domain/ledger.ts";

export interface JobDefinition {
  name: string;
  /** How often it is eligible to run. The runner ticks more often than this. */
  everyMs: number;
  run: (tx: Tx, deps: JobDeps) => Promise<{ processed: number; detail?: Record<string, unknown> }>;
}

export interface JobDeps {
  config: Config;
  payments: PaymentProvider;
  transport: Transport;
  log: (level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}

const HOUR = 60 * 60 * 1000;

export const JOBS: JobDefinition[] = [
  {
    name: "post-recurring-charges",
    everyMs: 6 * HOUR,
    async run(tx) {
      const period = periodOf(today());
      const properties = await tx.many<{ id: string }>("SELECT id FROM properties");
      let processed = 0;
      for (const property of properties) {
        const result = await postPeriod(tx, period, {
          propertyId: property.id,
          dryRun: false,
          actorRole: "system_job",
        });
        processed += result.posted;

        // Tell the resident about anything newly posted, so a charge never
        // appears on a balance without having been announced.
        for (const charge of result.planned.filter((p) => !p.alreadyPosted)) {
          await emit(tx, {
            eventType: "charge.posted",
            dedupeKey: `charge.posted:${charge.idempotencyKey}`,
            tenancyId: charge.tenancyId,
            payload: {
              description: charge.description,
              amountCents: charge.amountCents,
              effectiveDate: charge.effectiveDate,
              balanceCents: await getBalance(tx, charge.tenancyId),
            },
          });
        }
      }
      return { processed, detail: { period } };
    },
  },

  {
    name: "assess-late-fees",
    everyMs: 12 * HOUR,
    async run(tx) {
      const asOf = today();
      const properties = await tx.many<{ id: string }>("SELECT id FROM properties");
      let posted = 0;
      const suppressed: Record<string, number> = {};

      for (const property of properties) {
        const assessments = await assessProperty(tx, property.id, asOf);
        // Counting the suppressions is what lets a manager answer "why did
        // nobody get a fee this month" without reading code.
        for (const assessment of assessments) {
          if (!assessment.shouldPost) {
            suppressed[assessment.reason] = (suppressed[assessment.reason] ?? 0) + 1;
          }
        }

        posted += await postAssessments(tx, assessments, asOf);

        for (const assessment of assessments.filter((a) => a.shouldPost)) {
          const policy = await effectivePolicy(tx, assessment.tenancyId, property.id);
          await emit(tx, {
            eventType: "late_fee.assessed",
            dedupeKey: `late_fee.assessed:${assessment.idempotencyKey}`,
            tenancyId: assessment.tenancyId,
            payload: {
              amountCents: assessment.amountCents,
              detail: assessment.detail,
              policyText: humanPolicy(policy),
              balanceCents: await getBalance(tx, assessment.tenancyId),
            },
          });
        }
      }

      return { processed: posted, detail: { asOf, suppressed } };
    },
  },

  {
    name: "run-autopay",
    everyMs: 6 * HOUR,
    async run(tx, deps) {
      const due = await autopay.findDue(tx);
      let drafted = 0;

      for (const draft of due) {
        if (draft.blocked) {
          // The cap did its job. Nothing is taken, and the resident is told
          // exactly that, because silence here reads as a system failure.
          await emit(tx, {
            eventType: "autopay.blocked_by_cap",
            dedupeKey: `autopay.blocked:${draft.enrollmentId}:${draft.period}`,
            tenancyId: draft.tenancyId,
            payload: { balanceCents: draft.amountCents, capCents: draft.capCents, isShare: draft.shareCents !== null },
            // A share's limit is that person's business, not their roommates'.
            onlyResidentUserId: draft.shareCents !== null ? draft.userId : null,
          });
          await autopay.markDrafted(tx, draft.enrollmentId, draft.period);
          continue;
        }

        try {
          const result = await submitPayment(tx, deps.payments, {
            tenancyId: draft.tenancyId,
            amountCents: draft.amountCents,
            paymentMethodId: draft.paymentMethodId,
            idempotencyKey: `autopay:${draft.enrollmentId}:${draft.period}`,
            // Recorded as the payment of the person whose autopay it is (021).
            actorUserId: draft.userId,
            actorRole: "system_job",
          });

          // This job already runs under the system context, so the failure
          // bookkeeping can be applied here rather than deferred.
          if (result.failureConsequence) {
            const events = await applyFailureConsequence(tx, result.failureConsequence);
            for (const event of events) {
              await emit(tx, {
                eventType: event.eventType as never,
                dedupeKey: event.dedupeKey,
                tenancyId: draft.tenancyId,
                payload: event.payload,
              });
            }
          }
          drafted += 1;
        } catch (error) {
          deps.log("warn", "autopay draft failed", {
            tenancyId: draft.tenancyId,
            error: (error as Error).message,
          });
        }

        await autopay.markDrafted(tx, draft.enrollmentId, draft.period);
      }

      return { processed: drafted, detail: { considered: due.length } };
    },
  },

  {
    name: "send-reminders",
    everyMs: 12 * HOUR,
    async run(tx) {
      let sent = 0;

      // Autopay three days out: an automatic draft nobody saw coming is only
      // nominally a convenience.
      for (const upcoming of await autopay.findUpcoming(tx)) {
        sent += await emit(tx, {
          eventType: "autopay.scheduled",
          dedupeKey: `autopay.scheduled:${upcoming.enrollmentId}:${upcoming.period}`,
          tenancyId: upcoming.tenancyId,
          payload: {
            amountCents: upcoming.amountCents,
            draftDate: upcoming.draftDate,
            methodLabel: upcoming.methodLabel,
            isShare: upcoming.isShare,
          },
          onlyResidentUserId: upcoming.residentUserId,
        });
      }

      // Plan installments, three days out.
      const installments = await tx.many<{
        tenancy_id: string;
        id: string;
        due_date: string;
        amount_cents: number;
        sequence: number;
        total: number;
      }>(
        `SELECT i.tenancy_id, i.id, i.due_date::text AS due_date, i.amount_cents, i.sequence,
                (SELECT count(*) FROM payment_plan_installments x WHERE x.payment_plan_id = i.payment_plan_id)::int AS total
         FROM payment_plan_installments i
         JOIN payment_plans p ON p.id = i.payment_plan_id
         WHERE p.status = 'active' AND i.status IN ('scheduled','partial')
           AND i.due_date = current_date + 3`,
      );
      for (const installment of installments) {
        sent += await emit(tx, {
          eventType: "payment_plan.installment_due",
          dedupeKey: `plan.installment:${installment.id}`,
          tenancyId: installment.tenancy_id,
          payload: {
            amountCents: installment.amount_cents,
            dueDate: installment.due_date,
            sequence: installment.sequence,
            total: installment.total,
          },
        });
      }

      // Past due, once a balance is meaningfully overdue and nothing is in
      // flight. The message leads with the payment-plan option rather than with
      // a threat.
      const overdue = await tx.many<{
        tenancy_id: string;
        property_id: string;
        balance: number;
        days: number;
      }>(
        `SELECT t.id AS tenancy_id, t.property_id,
                sum(e.amount_cents)::bigint AS balance,
                (current_date - min(e.effective_date) FILTER (WHERE e.amount_cents > 0))::int AS days
         FROM tenancies t
         JOIN ledger_entries e ON e.tenancy_id = t.id
         WHERE t.status = 'active'
           AND (t.late_fee_hold_until IS NULL OR t.late_fee_hold_until < current_date)
           AND NOT EXISTS (
             SELECT 1 FROM payments p WHERE p.tenancy_id = t.id AND p.status IN ('pending','processing')
           )
           AND NOT EXISTS (
             SELECT 1 FROM payment_plans pl WHERE pl.tenancy_id = t.id AND pl.status = 'active'
           )
         GROUP BY t.id, t.property_id
         HAVING sum(e.amount_cents) > 0
            AND (current_date - min(e.effective_date) FILTER (WHERE e.amount_cents > 0)) >= 7`,
      );

      for (const account of overdue) {
        const policy = await effectivePolicy(tx, account.tenancy_id, account.property_id);
        sent += await emit(tx, {
          eventType: "balance.past_due",
          // Weekly at most: a daily past-due email is how a portal teaches
          // someone to stop reading its mail.
          dedupeKey: `balance.past_due:${account.tenancy_id}:${weekKey(today())}`,
          tenancyId: account.tenancy_id,
          payload: {
            balanceCents: Number(account.balance),
            daysPastDue: account.days,
            policyText: humanPolicy(policy),
          },
        });
      }

      return { processed: sent };
    },
  },

  {
    name: "dispatch-notifications",
    everyMs: 60 * 1000,
    async run(tx, deps) {
      const result = await dispatchPending(tx, deps.transport, 100);
      return { processed: result.sent, detail: { failed: result.failed } };
    },
  },

  {
    name: "mark-missed-plan-installments",
    everyMs: 12 * HOUR,
    async run(tx) {
      const result = await tx.query(
        `UPDATE payment_plan_installments
         SET status = 'missed'
         WHERE status IN ('scheduled','partial')
           AND due_date < current_date - 3
           AND payment_plan_id IN (SELECT id FROM payment_plans WHERE status = 'active')`,
      );
      return { processed: result.rowCount };
    },
  },

  {
    name: "purge-expired-sessions",
    everyMs: 24 * HOUR,
    async run(tx) {
      const result = await tx.query("DELETE FROM sessions WHERE expires_at < now() - interval '7 days'");
      return { processed: result.rowCount };
    },
  },
];

export class JobRunner {
  private readonly pool: Pool;
  private readonly deps: JobDeps;
  private readonly lastRun = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(pool: Pool, deps: JobDeps) {
    this.pool = pool;
    this.deps = deps;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run every job now, regardless of schedule. Used by tests and by seeding. */
  async runAll(): Promise<void> {
    for (const job of JOBS) await this.execute(job);
  }

  async runOne(name: string): Promise<void> {
    const job = JOBS.find((j) => j.name === name);
    if (!job) throw new Error(`no such job: ${name}`);
    await this.execute(job);
  }

  private async tick(): Promise<void> {
    // One tick at a time. Overlapping runs of the charge job would be safe
    // because of idempotency, but they would also be pointless database load.
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const job of JOBS) {
        const last = this.lastRun.get(job.name) ?? 0;
        if (now - last < job.everyMs) continue;
        await this.execute(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async execute(job: JobDefinition): Promise<void> {
    this.lastRun.set(job.name, Date.now());

    const started = await this.pool.query<{ id: string }>(
      "INSERT INTO job_runs (job_name) VALUES ($1) RETURNING id",
      [job.name],
    );
    const runId = started.rows[0].id;

    try {
      // Jobs run in the system context: a named role that every RLS policy
      // recognizes, rather than a superuser connection that would bypass them.
      const result = await withContext(this.pool, SYSTEM_CONTEXT, (tx) => job.run(tx, this.deps));

      await this.pool.query(
        `UPDATE job_runs SET status = 'ok', finished_at = now(), items_processed = $2, detail = $3::jsonb
         WHERE id = $1`,
        [runId, result.processed, JSON.stringify(result.detail ?? {})],
      );

      if (result.processed > 0) {
        this.deps.log("info", `job ${job.name} processed ${result.processed}`, result.detail);
      }
    } catch (error) {
      await this.pool.query(
        "UPDATE job_runs SET status = 'error', finished_at = now(), error = $2 WHERE id = $1",
        [runId, String((error as Error).message).slice(0, 2000)],
      );
      // A failing job must never take the web server down with it. Rent
      // collection continues; the failure is recorded and logged.
      this.deps.log("error", `job ${job.name} failed`, { error: (error as Error).message });
    }
  }
}

function weekKey(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}
