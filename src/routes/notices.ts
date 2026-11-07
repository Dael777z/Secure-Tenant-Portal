import { Router } from "express"

import type { Auth } from "../middleware/auth"
import { uploadBody } from "../middleware/body"
import type { RateLimits } from "../middleware/rate-limit"
import type { NoticesService } from "../services/notices-service"
import type { ValidRequest } from "../types/access"
import type { DocumentCategory, DocumentChange, DocumentScope, NoticeAudience } from "../types/additions"
import { AppError } from "../types/errors"
import { parseUserId } from "../utils/user-id"
import { id, text } from "./validate"

const SCOPES: DocumentScope[] = ["property", "unit", "tenant", "lease"]
const CATEGORIES: DocumentCategory[] = ["lease", "inspection", "insurance", "notice", "receipt", "other"]
const TEMPLATES = ["rent_upcoming", "rent_due", "rent_overdue", "payment_received", "maintenance_update", "manual", "invite", "lease_ending", "custom"]

/**
 * Notices and documents (009).
 *
 *   GET  /manager/notices?template=&channel=&status=&q=   every notice residents were sent
 *   POST /manager/notices  { audience: { kind: all|property|tenant, id? }, subject, body, email? }  (email: also by email, 011)
 *   GET  /manager/documents/all?scope=&id=&category=&q=    uploaded files, signed leases and receipts
 *   POST /manager/documents { scope, id, category, title, sharedWithTenant, filename, data }  (10 MB)
 *   PUT  /manager/documents/:id  { title?, category?, sharedWithTenant? }
 *   DELETE /manager/documents/:id                         hide it (kept on record)
 *   GET  /manager/documents/:id                           open it
 *
 *   GET  /tenant/notices, POST /tenant/notices/:id/read   what the office wrote to them
 *   GET  /tenant/documents, GET /tenant/documents/:id     their lease and what the office shared
 */
export function createNoticesRouter(deps: { notices: NoticesService; guard: Auth; limits: RateLimits }): Router {
    const { notices, guard, limits } = deps
    const { can } = guard
    const router = Router()
    const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | null => {
        if (value === undefined || value === null || value === "") return null
        if (!allowed.includes(value as T)) throw new AppError("VALIDATION_ERROR")
        return value as T
    }
    const sendFile = (res: import("express").Response, file: { filename: string; contentType: string; data: Buffer }) => {
        res.set({
            "Content-Type": file.contentType,
            "Content-Disposition": `inline; filename="${file.filename.replace(/["\\]/g, "")}"`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
            // A PDF opened in a tab runs no scripts from this site.
            "Content-Security-Policy": "sandbox",
        })
        res.send(file.data)
    }

    /* ---- Notices ---- */

    router.get("/manager/notices", ...can("messages:manage"), async (req, res) => {
        const q = req.query as Record<string, unknown>
        res.json({
            emailEnabled: notices.emailEnabled,
            notices: await notices.notices({
                template: pick(q.template, TEMPLATES),
                channel: pick(q.channel, ["in_app", "email"] as const),
                status: pick(q.status, ["queued", "sending", "sent", "failed", "skipped"] as const),
                q: typeof q.q === "string" && q.q.trim() ? q.q.trim().slice(0, 100) : null,
            }),
        })
    })

    router.post("/manager/notices", limits.messages, ...can("messages:manage"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const a = (body.audience ?? {}) as Record<string, unknown>
        const audience: NoticeAudience = a.kind === "all" ? { kind: "all" }
            : a.kind === "property" || a.kind === "tenant" ? { kind: a.kind, id: id(a.id) }
            : (() => { throw new AppError("VALIDATION_ERROR") })()
        if (body.email !== undefined && typeof body.email !== "boolean") throw new AppError("VALIDATION_ERROR")
        res.status(201).json(await notices.send(audience, text(body.subject, 200)!, text(body.body, 5000)!, body.email === true))
    })

    router.get("/tenant/notices", ...can("ledger:read:self"), async (_req, res) => {
        res.json({ notices: await notices.tenantNotices() })
    })

    router.post("/tenant/notices/:id/read", ...can("ledger:read:self"), async (req, res) => {
        await notices.markRead(id(req.params.id))
        res.json({ ok: true })
    })

    /* ---- Documents ---- */

    router.get("/manager/documents/all", ...can("ledger:read:property"), async (req, res) => {
        const q = req.query as Record<string, unknown>
        const scope = pick(q.scope, SCOPES)
        res.json({
            documents: await notices.hub({
                scope,
                id: scope === null ? null : id(q.id),
                category: pick(q.category, CATEGORIES),
                q: typeof q.q === "string" && q.q.trim() ? q.q.trim().slice(0, 100) : null,
            }),
        })
    })

    router.post("/manager/documents", limits.sensitive, ...can("users:provision"), uploadBody, async (req, res) => {
        const body = req.body as Record<string, unknown>
        const scope = pick(body.scope, SCOPES)
        if (scope === null || typeof body.sharedWithTenant !== "boolean") throw new AppError("VALIDATION_ERROR")
        const docId = await notices.upload({
            scope,
            scopeId: id(body.id),
            category: pick(body.category, CATEGORIES) ?? "other",
            title: text(body.title, 200)!,
            sharedWithTenant: body.sharedWithTenant,
            file: { filename: body.filename, data: body.data },
        })
        res.status(201).json({ id: docId })
    })

    router.put("/manager/documents/:id", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const change: DocumentChange = {}
        if (body.title !== undefined) change.title = text(body.title, 200)!
        if (body.category !== undefined) change.category = pick(body.category, CATEGORIES)!
        if (body.sharedWithTenant !== undefined) {
            if (typeof body.sharedWithTenant !== "boolean") throw new AppError("VALIDATION_ERROR")
            change.sharedWithTenant = body.sharedWithTenant
        }
        await notices.update(id(req.params.id), change)
        res.json({ ok: true })
    })

    router.delete("/manager/documents/:id", limits.sensitive, ...can("users:provision"), async (req, res) => {
        await notices.hide(id(req.params.id))
        res.json({ ok: true })
    })

    router.get("/manager/documents/:id", ...can("ledger:read:property"), async (req, res) => {
        sendFile(res, await notices.file(id(req.params.id)))
    })

    router.get("/tenant/documents", ...can("ledger:read:self"), async (req: ValidRequest, res) => {
        res.json({ groups: await notices.tenantDocuments(parseUserId(req.user!.id)!.id) })
    })

    router.get("/tenant/documents/:id", ...can("ledger:read:self"), async (req, res) => {
        sendFile(res, await notices.file(id(req.params.id)))
    })

    return router
}
