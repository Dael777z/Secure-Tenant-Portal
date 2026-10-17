import { Router } from "express"

import type { Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import type { ManagerService } from "../services/manager-service"
import { AppError } from "../types/errors"
import type { InviteResult } from "../types/manager"
import type { ValidRequest } from "../types/access"
import { date, id, money, person, receipt, text } from "./validate"

/**
 * /api/manager: the office side. Every route validates its input and makes one
 * service call. DELETE never deletes: it retires the row, or for a payment adds
 * a matching refund.
 *
 *   ledger:read:property  the portfolio, rent roll, tenants, leases, updates
 *   users:provision       add or change properties, units, tenants, leases
 *   ledger:adjust         record or reverse an office payment, receipts
 *   maintenance:manage    the maintenance queue
 */

export function createManagerRouter(deps: {
    manager: ManagerService
    guard: Auth
    limits: RateLimits
    /** Where a tenant opens their invite: `${webOrigin}/signup?token=...` */
    webOrigin: string
}): Router {
    const { manager, guard, limits, webOrigin } = deps
    const { can } = guard
    const router = Router()

    /** An invitation plus the link the office sends. */
    const withLink = (invite: InviteResult) => ({
        ...invite,
        inviteLink: `${webOrigin.replace(/\/$/, "")}/signup?token=${encodeURIComponent(invite.inviteToken)}`,
    })

    // Who is signed in (name for the sidebar).
    router.get("/manager/me", ...can("maintenance:manage"), async (req: ValidRequest, res) => {
        res.json(await manager.staffProfile(req.user?.id ?? ""))
    })

    // ---- Reading
    router.get("/manager/dashboard", ...can("ledger:read:property"), async (_req, res) => {
        res.json(await manager.dashboard())
    })
    router.get("/manager/properties", ...can("ledger:read:property"), async (_req, res) => {
        res.json({ properties: await manager.properties() })
    })
    router.get("/manager/units", ...can("ledger:read:property"), async (req, res) => {
        const propertyId = req.query.propertyId === undefined ? undefined : id(req.query.propertyId)
        res.json({ units: await manager.units(propertyId) })
    })
    router.get("/manager/tenants", ...can("ledger:read:property"), async (_req, res) => {
        res.json({ tenants: await manager.tenants() })
    })
    router.get("/manager/leases/:leaseId", ...can("ledger:read:property"), async (req, res) => {
        res.json(await manager.lease(id(req.params.leaseId)))
    })
    router.get("/manager/updates", ...can("ledger:read:property"), async (_req, res) => {
        res.json({ updates: await manager.updates() })
    })

    // ---- Properties and units
    router.post("/manager/properties", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({ id: await manager.saveProperty(null, { name: text(body.name, 255)!, address: text(body.address, 500)! }) })
    })
    router.put("/manager/properties/:propertyId", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.json({ id: await manager.saveProperty(id(req.params.propertyId), { name: text(body.name, 255)!, address: text(body.address, 500)! }) })
    })
    router.delete("/manager/properties/:propertyId", ...can("users:provision"), async (req, res) => {
        await manager.deactivateProperty(id(req.params.propertyId))
        res.json({ ok: true })
    })
    router.post("/manager/units", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({ id: await manager.saveUnit(null, { propertyId: id(body.propertyId), unitNum: text(body.unitNum, 20)! }) })
    })
    router.put("/manager/units/:unitId", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.json({ id: await manager.saveUnit(id(req.params.unitId), { propertyId: id(body.propertyId), unitNum: text(body.unitNum, 20)! }) })
    })
    router.delete("/manager/units/:unitId", ...can("users:provision"), async (req, res) => {
        await manager.deactivateUnit(id(req.params.unitId))
        res.json({ ok: true })
    })

    // ---- Tenants
    router.post("/manager/tenants", ...can("users:provision"), async (req, res) => {
        const invite = await manager.inviteTenant(person(req.body))
        res.status(201).json({ id: invite.tenantId, ...withLink(invite) })
    })
    router.put("/manager/tenants/:tenantId", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        await manager.updateTenant(id(req.params.tenantId), { name: text(body.name, 255)!, phone: text(body.phone, 20, { optional: true }) })
        res.json({ ok: true })
    })
    // A new link for a tenant who has not signed up (the old one stops working).
    router.post("/manager/tenants/:tenantId/invite", limits.sensitive, ...can("users:provision"), async (req, res) => {
        res.json(withLink(await manager.reissueInvite(id(req.params.tenantId))))
    })
    router.delete("/manager/tenants/:tenantId", ...can("users:provision"), async (req, res) => {
        await manager.deactivateTenant(id(req.params.tenantId))
        res.json({ ok: true })
    })

    // ---- Leases
    router.post("/manager/leases", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const created = await manager.createLease({
            unitId: id(body.unitId),
            startDate: date(body.startDate)!,
            endDate: date(body.endDate, { optional: true }),
            monthlyRent: money(body.monthlyRent),
            tenantIds: Array.isArray(body.tenantIds) ? body.tenantIds.map(id) : [],
            newTenants: Array.isArray(body.newTenants) ? body.newTenants.map(person) : [],
        })
        res.status(201).json({ id: created.id, invites: created.invites.map(withLink) })
    })
    // Change the rent, or end the lease: { endDate: "2026-12-31" }. Leases are never deleted.
    router.put("/manager/leases/:leaseId", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        await manager.updateLease(id(req.params.leaseId), {
            ...(body.monthlyRent !== undefined ? { monthlyRent: money(body.monthlyRent) } : {}),
            ...("endDate" in body ? { endDate: date(body.endDate, { optional: true }) } : {}),
        })
        res.json({ ok: true })
    })
    router.post("/manager/leases/:leaseId/tenants", ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const invite = await manager.addTenantToLease(
            id(req.params.leaseId),
            body.newTenant ? { newTenant: person(body.newTenant) } : { tenantId: id(body.tenantId) },
        )
        res.status(201).json({ ok: true, ...(invite ? { invite: withLink(invite) } : {}) })
    })
    router.delete("/manager/leases/:leaseId/tenants/:tenantId", ...can("users:provision"), async (req, res) => {
        await manager.removeTenantFromLease(id(req.params.leaseId), id(req.params.tenantId))
        res.json({ ok: true })
    })

    // ---- Payments and receipts
    router.post("/manager/leases/:leaseId/payments", limits.sensitive, ...can("ledger:adjust"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const methods = ["Check", "Cash", "Money order", "Bank transfer"]
        if (typeof body.method !== "string" || !methods.includes(body.method)) throw new AppError("VALIDATION_ERROR")
        const confirmation = await manager.recordPayment(id(req.params.leaseId), {
            amount: money(body.amount),
            method: body.method,
            tenantId: body.tenantId === undefined || body.tenantId === null ? null : id(body.tenantId),
            receipt: body.receipt === undefined || body.receipt === null ? null : receipt(body.receipt),
        })
        res.status(201).json({ confirmation })
    })
    // Undo an office payment. Payments are never deleted: this adds a matching refund, shown as "Payment reversed".
    router.delete("/manager/leases/:leaseId/payments/:paymentId", ...can("ledger:adjust"), async (req, res) => {
        await manager.reverseOfficePayment(id(req.params.leaseId), id(req.params.paymentId))
        res.json({ ok: true })
    })
    router.put("/manager/leases/:leaseId/payments/:paymentId/receipt", limits.sensitive, ...can("ledger:adjust"), async (req, res) => {
        await manager.attachReceipt(id(req.params.leaseId), id(req.params.paymentId), receipt(req.body))
        res.json({ ok: true })
    })
    router.get("/manager/leases/:leaseId/payments/:paymentId/receipt", ...can("ledger:read:property"), async (req, res) => {
        const file = await manager.receipt(id(req.params.leaseId), id(req.params.paymentId))
        res.set({
            "Content-Type": file.contentType,
            "Content-Disposition": `inline; filename="${file.filename}"`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        })
        res.send(file.data)
    })

    // ---- Maintenance
    router.get("/manager/maintenance", ...can("maintenance:manage"), async (_req, res) => {
        const units = await manager.units()
        res.json({
            requests: await manager.maintenance(),
            units: units.map((u) => ({ id: u.id, label: `Unit ${u.unitNum} - ${u.propertyName}` })),
        })
    })
    router.post("/manager/maintenance", ...can("maintenance:manage"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({
            id: await manager.createMaintenance({
                unitId: id(body.unitId),
                title: text(body.title, 120)!,
                description: text(body.description, 4000, { optional: true }) ?? "",
            }),
        })
    })
    router.put("/manager/maintenance/:requestId", ...can("maintenance:manage"), async (req, res) => {
        const status = (req.body as Record<string, unknown>).status
        if (status !== "submitted" && status !== "in_progress" && status !== "resolved") throw new AppError("VALIDATION_ERROR")
        await manager.setMaintenanceStatus(id(req.params.requestId), status)
        res.json({ ok: true })
    })
    router.delete("/manager/maintenance/:requestId", ...can("maintenance:manage"), async (req, res) => {
        await manager.deactivateMaintenance(id(req.params.requestId))
        res.json({ ok: true })
    })

    return router
}
