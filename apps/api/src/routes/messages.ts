/**
 * Messages routes (migration 011), for both sides of a conversation.
 *
 *   /api/v1/tenant/messages…   a resident and their own tenancy
 *   /api/v1/manager/messages…  managers (every topic) and on-site staff
 *                              (maintenance threads only — RLS enforces it)
 *
 * Notifications are emitted under the system context in their own transaction,
 * after the message is committed: a resident's session cannot read the
 * manager roster that decides who gets the email, and a failed email must never
 * roll back a message the person has already seen appear.
 */

import type { Router } from "../http/router.ts";
import { roles } from "../http/router.ts";
import { conflict, notFound, unprocessable } from "../http/errors.ts";
import { SYSTEM_CONTEXT, withContext, withReadOnlyContext } from "../db/context.ts";
import type { Pool } from "../db/pool.ts";
import type { HttpContext } from "../http/context.ts";
import * as api from "../../../../packages/shared/src/api.ts";
import * as messages from "../domain/messages.ts";
import { emit } from "../domain/notifications.ts";

export function registerMessageRoutes(router: Router, deps: { pool: Pool }): void {
  const { pool } = deps;

  async function notify(threadId: string, messageId: string, body: string, fromResident: boolean): Promise<void> {
    try {
      await withContext(pool, SYSTEM_CONTEXT, async (tx) => {
        const found = await messages.getThread(tx, threadId);
        if (!found) return;
        const last = found.messages[found.messages.length - 1];
        await emit(tx, {
          eventType: fromResident ? "message.to_management" : "message.to_resident",
          dedupeKey: `message:${messageId}`,
          tenancyId: found.thread.tenancyId,
          payload: {
            subject: found.thread.subject,
            unitLabel: found.thread.unitLabel,
            authorName: last?.authorName ?? null,
            body: body.length > 1200 ? `${body.slice(0, 1200)}…` : body,
            threadId,
          },
        });
      });
    } catch {
      // Delivery is best-effort; the message itself is already saved and visible.
    }
  }

  async function reply(ctx: HttpContext) {
    const input = api.postMessageRequest.parse(ctx.body);
    const result = await withContext(pool, ctx.dbContext(), async (tx) => {
      const found = await messages.getThread(tx, ctx.params.threadId);
      if (!found) throw notFound();
      if (found.thread.status === "closed") {
        throw conflict("This conversation is closed. Reopen it to reply, or start a new one.");
      }
      const message = await messages.addMessage(tx, found.thread.id, input.body);
      return { threadId: found.thread.id, message };
    });
    await notify(result.threadId, result.message.id, input.body, ctx.user!.role === "tenant");
    return { message: result.message };
  }

  async function setStatus(ctx: HttpContext) {
    const input = api.threadStatusRequest.parse(ctx.body);
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const changed = await messages.setStatus(tx, ctx.params.threadId, input.status);
      if (!changed) throw notFound();
      return (await messages.getThread(tx, ctx.params.threadId))!;
    });
  }

  async function read(ctx: HttpContext) {
    return withContext(pool, ctx.dbContext(), async (tx) => {
      const found = await messages.getThread(tx, ctx.params.threadId);
      if (!found) throw notFound();
      await messages.markRead(tx, found.thread.id);
      return { ...found, thread: { ...found.thread, unreadCount: 0 } };
    });
  }

  /* ---------------------------------------------------------------- *
   * Resident
   * ---------------------------------------------------------------- */

  router.get("/api/v1/tenant/messages", roles("tenant"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => ({
      threads: await messages.listThreads(tx, { tenancyId: ctx.user!.tenancyId ?? undefined }),
    })),
  );

  router.post("/api/v1/tenant/messages", roles("tenant"), async (ctx) => {
    const input = api.startThreadRequest.parse(ctx.body);
    const tenancyId = ctx.user!.tenancyId;
    if (!tenancyId) throw notFound("No active tenancy is attached to this account.");
    if (input.tenancyId && input.tenancyId !== tenancyId) throw notFound();

    const result = await withContext(pool, ctx.dbContext(), async (tx) => {
      const threadId = await startOrRefuse(() =>
        messages.startThread(tx, {
          tenancyId,
          subject: input.subject,
          topic: input.topic,
          body: input.body,
          ledgerEntryId: input.ledgerEntryId ?? null,
          workOrderId: input.workOrderId ?? null,
        }),
      );
      return messages.getThread(tx, threadId);
    });
    const first = result!.messages[0]!;
    await notify(result!.thread.id, first.id, input.body, true);
    return result;
  });

  router.get("/api/v1/tenant/messages/:threadId", roles("tenant"), read);
  router.post("/api/v1/tenant/messages/:threadId", roles("tenant"), reply);
  router.post("/api/v1/tenant/messages/:threadId/status", roles("tenant"), setStatus);

  /* ---------------------------------------------------------------- *
   * Management (managers: all topics; staff: maintenance only)
   * ---------------------------------------------------------------- */

  router.get("/api/v1/manager/messages", roles("manager", "staff"), async (ctx) =>
    withReadOnlyContext(pool, ctx.dbContext(), async (tx) => {
      const status = ctx.query.status === "open" || ctx.query.status === "closed" ? ctx.query.status : "all";
      return {
        threads: await messages.listThreads(tx, {
          propertyId: ctx.query.propertyId || undefined,
          tenancyId: ctx.query.tenancyId || undefined,
          status,
          unreadOnly: ctx.query.unread === "1",
        }),
      };
    }),
  );

  router.post("/api/v1/manager/messages", roles("manager", "staff"), async (ctx) => {
    const input = api.startThreadRequest.parse(ctx.body);
    if (!input.tenancyId) throw unprocessable("Choose the resident this message is for.");
    if (ctx.user!.role === "staff" && input.topic !== "maintenance") {
      throw unprocessable("On-site staff can start maintenance conversations only.");
    }
    const result = await withContext(pool, ctx.dbContext(), async (tx) => {
      const threadId = await startOrRefuse(() =>
        messages.startThread(tx, {
          tenancyId: input.tenancyId!,
          subject: input.subject,
          topic: input.topic,
          body: input.body,
          ledgerEntryId: input.ledgerEntryId ?? null,
          workOrderId: input.workOrderId ?? null,
        }),
      );
      return messages.getThread(tx, threadId);
    });
    const first = result!.messages[0]!;
    await notify(result!.thread.id, first.id, input.body, false);
    return result;
  });

  router.get("/api/v1/manager/messages/:threadId", roles("manager", "staff"), read);
  router.post("/api/v1/manager/messages/:threadId", roles("manager", "staff"), reply);
  router.post("/api/v1/manager/messages/:threadId/status", roles("manager", "staff"), setStatus);
}

async function startOrRefuse(start: () => Promise<string>): Promise<string> {
  try {
    return await start();
  } catch (error) {
    if (error instanceof messages.ThreadRefused) throw notFound(error.message);
    throw error;
  }
}
