import { Router } from "express"

import type { Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import type { MessageService } from "../services/message-service"
import type { ValidRequest } from "../types/access"
import { AppError } from "../types/errors"
import { id, text } from "./validate"

/** The longest message (the column is VARCHAR(2000)). */
export const MESSAGE_MAX_LENGTH = 2000

/**
 * Messages between a tenant and the property office (004).
 *
 *   messages:manage (property managers)
 *     GET  /manager/messages?box=archived        the inbox (or the archived conversations)
 *     GET  /manager/messages/unread              { unread }: conversations waiting on the office
 *     GET  /manager/messages/:tenantId           one conversation (tenant, archived, messages)
 *     POST /manager/messages/:tenantId           { body }  → the message (starts the conversation if new)
 *     POST /manager/messages/:tenantId/read      the receipt: the tenant's messages are read
 *     PUT  /manager/messages/:tenantId/archive   { archived: boolean }
 *
 *   messages:self (the signed-in tenant)
 *     GET  /tenant/messages                      { messages, unread }
 *     POST /tenant/messages                      { body }  → the message
 *     POST /tenant/messages/read                 the receipt: the office's messages are read
 */
export function createMessageRouter(deps: { messages: MessageService; guard: Auth; limits: RateLimits }): Router {
    const { messages, guard, limits } = deps
    const { can } = guard
    const router = Router()
    const body = (req: ValidRequest) => text((req.body as Record<string, unknown> | undefined)?.body, MESSAGE_MAX_LENGTH)!

    // ---- The office
    router.get("/manager/messages", ...can("messages:manage"), async (req, res) => {
        const box = req.query.box ?? "inbox"
        if (box !== "inbox" && box !== "archived") throw new AppError("VALIDATION_ERROR")
        res.json({ threads: await messages.threads(box === "archived") })
    })
    router.get("/manager/messages/unread", ...can("messages:manage"), async (_req, res) => {
        res.json({ unread: await messages.unreadThreads() })
    })
    router.get("/manager/messages/:tenantId", ...can("messages:manage"), async (req, res) => {
        res.json(await messages.conversation(id(req.params.tenantId)))
    })
    router.post("/manager/messages/:tenantId", limits.messages, ...can("messages:manage"), async (req: ValidRequest, res) => {
        res.status(201).json(await messages.reply(req.user!.id, id(req.params.tenantId), body(req)))
    })
    router.post("/manager/messages/:tenantId/read", ...can("messages:manage"), async (req, res) => {
        res.json({ marked: await messages.markReadByOffice(id(req.params.tenantId)) })
    })
    router.put("/manager/messages/:tenantId/archive", ...can("messages:manage"), async (req, res) => {
        const archived = (req.body as Record<string, unknown> | undefined)?.archived
        if (typeof archived !== "boolean") throw new AppError("VALIDATION_ERROR")
        await messages.setArchived(id(req.params.tenantId), archived)
        res.json({ ok: true })
    })

    // ---- The tenant
    router.get("/tenant/messages", ...can("messages:self"), async (req: ValidRequest, res) => {
        res.json(await messages.tenantConversation(req.user!.id))
    })
    router.post("/tenant/messages", limits.messages, ...can("messages:self"), async (req: ValidRequest, res) => {
        res.status(201).json(await messages.tenantSend(req.user!.id, body(req)))
    })
    router.post("/tenant/messages/read", ...can("messages:self"), async (req: ValidRequest, res) => {
        res.json({ marked: await messages.markReadByTenant(req.user!.id) })
    })

    return router
}
