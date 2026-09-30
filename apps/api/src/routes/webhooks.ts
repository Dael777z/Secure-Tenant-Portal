/**
 * Provider webhooks.
 *
 * Three rules, in this order, on every request:
 *
 *   Verify the signature before parsing anything. An unsigned or badly-signed
 *   body is hostile input, not a malformed friend, and it is answered with 400
 *   and nothing else — no hint about why, because the hint is a tuning signal
 *   for whoever is probing.
 *
 *   Record the event before acting on it, keyed by the provider's own event id.
 *   A replay finds the row already there and stops. This is what prevents a
 *   retrying provider from crediting a rent payment four times.
 *
 *   Answer 200 for anything successfully recorded, including events that turn
 *   out to be irrelevant. A provider that receives an error retries, and
 *   retrying an event we have decided to ignore is pure noise.
 */

import type { Router } from "../http/router.ts";
import { PUBLIC } from "../http/router.ts";
import { withContext, SYSTEM_CONTEXT } from "../db/context.ts";
import type { Pool } from "../db/pool.ts";
import type { PaymentProvider } from "../providers/payments/index.ts";
import { reconcile } from "../domain/payments.ts";
import { emit } from "../domain/notifications.ts";
import type { EventType } from "../../../../packages/shared/src/notifications.ts";

const MAX_WEBHOOK_BYTES = 512 * 1024;

export function registerWebhookRoutes(
  router: Router,
  deps: {
    pool: Pool;
    payments: PaymentProvider;
    log: (level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
  },
): void {
  const { pool, payments, log } = deps;

  router.post(`/api/v1/webhooks/${payments.name}`, PUBLIC, async (ctx) => {
    // The raw bytes, not a re-serialized parse: signatures are computed over
    // exactly what was sent, and JSON.parse followed by JSON.stringify is not
    // guaranteed to produce the same bytes.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of ctx.req) {
      total += (chunk as Buffer).length;
      if (total > MAX_WEBHOOK_BYTES) {
        ctx.json(413, { error: { code: "too_large", message: "Payload too large." } });
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks, total);

    const event = payments.parseWebhook(raw, ctx.req.headers as Record<string, string | string[]>);
    if (!event) {
      log("warn", "rejected a webhook with an invalid signature", { ip: ctx.ip, bytes: total });
      ctx.json(400, { error: { code: "invalid_signature", message: "Signature verification failed." } });
      return;
    }

    await withContext(pool, SYSTEM_CONTEXT, async (tx) => {
      // Record first. If this insert conflicts, the event has already been
      // handled and there is nothing further to do.
      //
      // ON CONFLICT rather than catch-and-continue: a failed statement aborts
      // the transaction, so catching the violation and then answering would
      // fail on the very replay this guard exists to absorb.
      const recorded = await tx.query(
        `INSERT INTO webhook_events (provider, provider_event_id, event_type, payload, signature_valid)
         VALUES ($1, $2, $3, $4::jsonb, true)
         ON CONFLICT (provider, provider_event_id) DO NOTHING`,
        [payments.name, event.providerEventId, event.type, JSON.stringify(event.raw)],
      );

      if (recorded.rowCount === 0) {
        log("info", "ignored a replayed webhook", { eventId: event.providerEventId });
        ctx.json(200, { ok: true, deduplicated: true });
        return;
      }

      const outcome = await reconcile(tx, event);

      for (const notification of outcome.notify) {
        await emit(tx, {
          eventType: notification.eventType as EventType,
          dedupeKey: notification.dedupeKey,
          tenancyId: outcome.payment?.tenancyId ?? null,
          payload: notification.payload,
        });
      }

      await tx.query("UPDATE webhook_events SET processed_at = now() WHERE provider = $1 AND provider_event_id = $2", [
        payments.name,
        event.providerEventId,
      ]);

      log("info", `webhook ${event.type} -> ${outcome.action}`, {
        eventId: event.providerEventId,
        paymentId: outcome.payment?.id,
      });

      ctx.json(200, { ok: true, action: outcome.action });
    });
  });

  router.get("/api/v1/health", PUBLIC, async (ctx) => {
    try {
      const result = await pool.query<{ ok: number }>("SELECT 1 AS ok");
      ctx.json(200, {
        status: "ok",
        database: result.rows[0]?.ok === 1 ? "ok" : "degraded",
        paymentsProvider: payments.name,
        paymentsSimulated: payments.isSimulated,
        time: new Date().toISOString(),
      });
    } catch (error) {
      ctx.json(503, { status: "degraded", database: "unreachable", error: (error as Error).message });
    }
  });
}
