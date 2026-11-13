import { Router, type Response } from "express"

import type { Auth } from "../middleware/auth"
import { uploadBody } from "../middleware/body"
import type { RateLimits } from "../middleware/rate-limit"
import type { MaintenanceDetailService } from "../services/maintenance-detail-service"
import type { MaintenanceWorkInput, StoredFile } from "../types/additions"
import { AppError } from "../types/errors"
import { id, text } from "./validate"

/**
 * Maintenance detail (009). Staff with maintenance:manage (managers and
 * maintenance staff); booking the cost as an expense is the manager's.
 *
 *   GET  /manager/maintenance/summary?days=30
 *   GET  /manager/maintenance/:id                           history, notes, photos, assignees
 *   PUT  /manager/maintenance/:id/work     { assignedTo? , laborCost?, materialsCost? }
 *   POST /manager/maintenance/:id/notes    { body }         staff only; the resident never sees these
 *   POST /manager/maintenance/:id/attachments { filename, data }   a photo (5 MB)
 *   GET  /manager/maintenance/:id/attachments/:attachmentId
 *   POST /manager/maintenance/:id/expense                   labor + materials as one repairs expense
 *
 *   GET  /tenant/maintenance/attachments?ids=1,2            photos on the tenant's own requests
 *   POST /tenant/maintenance/:id/attachments { filename, data }
 *   GET  /tenant/maintenance/:id/attachments/:attachmentId
 */
export function createMaintenanceDetailRouter(deps: { maintenance: MaintenanceDetailService; guard: Auth; limits: RateLimits }): Router {
    const { maintenance, guard, limits } = deps
    const { can } = guard
    const router = Router()

    const sendPhoto = (res: Response, file: StoredFile) => {
        res.set({
            "Content-Type": file.contentType,
            "Content-Disposition": `inline; filename="${file.filename.replace(/["\\]/g, "")}"`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=300",
        })
        res.send(file.data)
    }
    const cost = (value: unknown) => {
        if (value === null || value === "") return null
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) throw new AppError("VALIDATION_ERROR")
        return value
    }

    router.get("/manager/maintenance/summary", ...can("maintenance:manage"), async (req, res) => {
        const days = req.query.days === undefined ? 30 : Number(req.query.days)
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new AppError("VALIDATION_ERROR")
        res.json(await maintenance.summary(days))
    })

    router.get("/manager/maintenance/:id", ...can("maintenance:manage"), async (req, res) => {
        res.json(await maintenance.detail(id(req.params.id)))
    })

    router.put("/manager/maintenance/:id/work", limits.sensitive, ...can("maintenance:manage"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const input: MaintenanceWorkInput = {}
        if ("assignedTo" in body) input.assignedTo = body.assignedTo === null ? null : id(body.assignedTo)
        if ("laborCost" in body) input.laborCost = cost(body.laborCost)
        if ("materialsCost" in body) input.materialsCost = cost(body.materialsCost)
        await maintenance.updateWork(id(req.params.id), input)
        res.json({ ok: true })
    })

    router.post("/manager/maintenance/:id/notes", limits.sensitive, ...can("maintenance:manage"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({ id: await maintenance.addNote(id(req.params.id), text(body.body, 2000)!) })
    })

    router.post("/manager/maintenance/:id/attachments", limits.sensitive, ...can("maintenance:manage"), uploadBody, async (req, res) => {
        res.status(201).json({ id: await maintenance.addStaffPhoto(id(req.params.id), req.body) })
    })

    router.get("/manager/maintenance/:id/attachments/:attachmentId", ...can("maintenance:manage"), async (req, res) => {
        sendPhoto(res, await maintenance.photo(id(req.params.id), id(req.params.attachmentId)))
    })

    router.post("/manager/maintenance/:id/expense", limits.sensitive, ...can("ledger:adjust"), async (req, res) => {
        res.status(201).json({ expenseId: await maintenance.recordExpense(id(req.params.id)) })
    })

    /* ---- The resident ---- */

    router.get("/tenant/maintenance/attachments", ...can("maintenance:create"), async (req, res) => {
        const raw = typeof req.query.ids === "string" ? req.query.ids : ""
        const ids = raw ? raw.split(",").slice(0, 100).map((x) => id(x)) : []
        res.json({ attachments: await maintenance.tenantPhotos(ids) })
    })

    router.post("/tenant/maintenance/:id/attachments", limits.sensitive, ...can("maintenance:create"), uploadBody, async (req, res) => {
        res.status(201).json({ id: await maintenance.addTenantPhoto(id(req.params.id), req.body) })
    })

    router.get("/tenant/maintenance/:id/attachments/:attachmentId", ...can("maintenance:create"), async (req, res) => {
        sendPhoto(res, await maintenance.photo(id(req.params.id), id(req.params.attachmentId)))
    })

    return router
}
