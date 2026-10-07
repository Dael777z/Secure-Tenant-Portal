import { Router, type RequestHandler } from "express"

import { authenticateJWT } from "../middleware/auth"
import { requirePermission } from "../middleware/rbac"
import type { ManagerStore } from "../services/manager-store"
import { AppError } from "../types/errors"
import type { Permission, ValidRequest } from "../types/interfaces"

/**
 * /api/manager/* — the manager side, using the permissions already in Scott's
 * rbac.ts (no new ones):
 *   ledger:read:property  read the portfolio, rent roll, tenants, leases, updates
 *   users:provision       add/edit properties, units, tenants, leases
 *   ledger:adjust         record an offline payment
 *   maintenance:manage    the maintenance queue (on-site staff too)
 */

const text = (value: unknown, max: number, { optional = false } = {}): string | null => {
    if ((value === undefined || value === null || value === "") && optional) return null
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new AppError("VALIDATION_ERROR")
    return value.trim()
}
const money = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100_000 || Math.round(value * 100) !== value * 100) {
        throw new AppError("VALIDATION_ERROR")
    }
    return value
}
const date = (value: unknown, { optional = false } = {}): string | null => {
    if ((value === undefined || value === null || value === "") && optional) return null
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new AppError("VALIDATION_ERROR")
    return value
}
const id = (value: unknown): number => {
    const n = typeof value === "string" ? Number(value) : value
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 2_000_000_000) throw new AppError("VALIDATION_ERROR")
    return n
}
const email = (value: unknown): string => {
    const v = text(value, 255)!.toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new AppError("VALIDATION_ERROR")
    return v
}
const person = (value: unknown) => {
    const v = (value ?? {}) as Record<string, unknown>
    return { name: text(v.name, 255)!, email: email(v.email), phone: text(v.phone, 20, { optional: true }) }
}

export function createManagerRouter(store: ManagerStore | null): Router {
    const router = Router()
    const can = (permission: Permission): RequestHandler[] => [authenticateJWT, requirePermission(permission)]
    const need = (): ManagerStore => {
        if (!store) throw new AppError("DATABASE_REQUIRED")
        return store
    }

    // Who is signed in (name for the sidebar). Every staff role can manage maintenance.
    router.get("/manager/me", ...can("maintenance:manage"), async (req, res) => {
        res.json(await need().staffProfile((req as ValidRequest).user?.id ?? ""))
    })

    // Reading
    router.get("/manager/dashboard", ...can("ledger:read:property"), async (_req, res) => {
        res.json(await need().dashboard())
    })
    router.get("/manager/properties", ...can("ledger:read:property"), async (_req, res) => {
        res.json({ properties: await need().properties() })
    })
    router.get("/manager/units", ...can("ledger:read:property"), async (req, res) => {
        const propertyId = req.query.propertyId === undefined ? undefined : id(req.query.propertyId)
        res.json({ units: await need().units(propertyId) })
    })
    router.get("/manager/tenants", ...can("ledger:read:property"), async (_req, res) => {
        res.json({ tenants: await need().tenants() })
    })
    router.get("/manager/leases/:leaseId", ...can("ledger:read:property"), async (req, res) => {
        res.json(await need().lease(id(req.params.leaseId)))
    })
    router.get("/manager/updates", ...can("ledger:read:property"), async (_req, res) => {
        res.json({ updates: await need().updates() })
    })

    // Portfolio
    router.post("/manager/properties", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({ id: await need().saveProperty(null, { name: text(body.name, 255)!, address: text(body.address, 500)! }) })
    })
    router.put("/manager/properties/:propertyId", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.json({ id: await need().saveProperty(id(req.params.propertyId), { name: text(body.name, 255)!, address: text(body.address, 500)! }) })
    })
    router.post("/manager/units", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({ id: await need().saveUnit(null, { propertyId: id(body.propertyId), unitNum: text(body.unitNum, 20)! }) })
    })
    router.put("/manager/units/:unitId", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.json({ id: await need().saveUnit(id(req.params.unitId), { propertyId: id(body.propertyId), unitNum: text(body.unitNum, 20)! }) })
    })

    // Tenants
    router.post("/manager/tenants", ...can("users:provision"), async (req, res) => {
        res.status(201).json({ id: await need().inviteTenant(person(req.body)) })
    })
    router.put("/manager/tenants/:tenantId", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        await need().updateTenant(id(req.params.tenantId), { name: text(body.name, 255)!, phone: text(body.phone, 20, { optional: true }) })
        res.json({ ok: true })
    })

    // Leases
    router.post("/manager/leases", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const tenantIds = Array.isArray(body.tenantIds) ? body.tenantIds.map(id) : []
        const newTenants = Array.isArray(body.newTenants) ? body.newTenants.map(person) : []
        const leaseId = await need().createLease({
            unitId: id(body.unitId),
            startDate: date(body.startDate)!,
            endDate: date(body.endDate, { optional: true }),
            monthlyRent: money(body.monthlyRent),
            tenantIds,
            newTenants,
        })
        res.status(201).json({ id: leaseId })
    })
    router.put("/manager/leases/:leaseId", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        await need().updateLease(id(req.params.leaseId), {
            ...(body.monthlyRent !== undefined ? { monthlyRent: money(body.monthlyRent) } : {}),
            ...("endDate" in body ? { endDate: date(body.endDate, { optional: true }) } : {}),
        })
        res.json({ ok: true })
    })
    router.post("/manager/leases/:leaseId/tenants", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        await need().addTenantToLease(id(req.params.leaseId), body.newTenant ? { newTenant: person(body.newTenant) } : { tenantId: id(body.tenantId) })
        res.status(201).json({ ok: true })
    })
    router.delete("/manager/leases/:leaseId/tenants/:tenantId", ...can("users:provision"), async (req, res) => {
        await need().removeTenantFromLease(id(req.params.leaseId), id(req.params.tenantId))
        res.json({ ok: true })
    })
    router.post("/manager/leases/:leaseId/payments", ...can("ledger:adjust"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const methods = ["Check", "Cash", "Money order", "Bank transfer"]
        if (typeof body.method !== "string" || !methods.includes(body.method)) throw new AppError("VALIDATION_ERROR")
        const confirmation = await need().recordPayment(id(req.params.leaseId), {
            amount: money(body.amount),
            method: body.method,
            tenantId: body.tenantId === undefined || body.tenantId === null ? null : id(body.tenantId),
        })
        res.status(201).json({ confirmation })
    })

    // Maintenance (on-site staff too)
    router.get("/manager/maintenance", ...can("maintenance:manage"), async (_req, res) => {
        const units = await need().units()
        res.json({
            requests: await need().maintenance(),
            units: units.map((u) => ({ id: u.id, label: `Unit ${u.unitNum} - ${u.propertyName}` })),
        })
    })
    router.post("/manager/maintenance", ...can("maintenance:manage"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({
            id: await need().createMaintenance({
                unitId: id(body.unitId),
                title: text(body.title, 120)!,
                description: text(body.description, 4000, { optional: true }) ?? "",
            }),
        })
    })
    router.put("/manager/maintenance/:requestId", ...can("maintenance:manage"), async (req, res) => {
        const status = (req.body as Record<string, unknown>).status
        if (status !== "submitted" && status !== "in_progress" && status !== "resolved") throw new AppError("VALIDATION_ERROR")
        await need().setMaintenanceStatus(id(req.params.requestId), status)
        res.json({ ok: true })
    })

    return router
}
