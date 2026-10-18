import { Router } from "express"

import type { Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import type { ManagerService } from "../services/manager-service"
import { AppError } from "../types/errors"
import type { InviteResult } from "../types/manager"
import type { ValidRequest } from "../types/access"
import { date, id, money, person, receipt, text } from "./validate"

/*
 /api/manager: the office side. Every route validates its input and makes one
 
service call. DELETE never deletes: it retires the row, or for a payment adds
a matching refund.

ledger:read:property  the portfolio, rent roll, tenants, leases, updates
users:provision       add or change properties, units, tenants, leases
ledger:adjust         record or reverse an office payment, receipts
maintenance:manage    the maintenance queue
*/

export function createManagerRouter(deps: {
    manager: ManagerService
    guard: Auth
    limits: RateLimits
    webOrigin: string
}): Router {
    const { manager, guard, limits, webOrigin } = deps
    const router = Router()

    /** An invitation plus the link the office sends. */
    const withLink = (invite: InviteResult) => ({
        ...invite,
        inviteLink: `${webOrigin.replace(/\/$/, "")}/signup?token=${encodeURIComponent(invite.inviteToken)}`,
    })

    // return what admin is signed in
    router.get("/manager/me", ...guard.can("maintenance:manage"), async (req: ValidRequest, res) => {
        res.json(await manager.staffProfile(req.user?.id ?? ""))
    })

    // ---- Reading
    router.get("/manager/dashboard", ...guard.can("ledger:read:property"), async (_req, res) => {
        res.json(await manager.dashboard())
    })
    router.get("/manager/properties", ...guard.can("ledger:read:property"), async (_req, res) => {
        res.json({ properties: await manager.properties() })
    })
    router.get("/manager/units", ...guard.can("ledger:read:property"), async (req, res) => {
        const propertyId = req.query.propertyId === undefined ? undefined : id(req.query.propertyId)
        res.json({ units: await manager.units(propertyId) })
    })
    router.get("/manager/tenants", ...guard.can("ledger:read:property"), async (_req, res) => {
        res.json({ tenants: await manager.tenants() })
    })
    router.get("/manager/leases/:leaseId", ...guard.can("ledger:read:property"), async (req, res) => {
        res.json(await manager.lease(id(req.params.leaseId)))
    })
    router.get("/manager/updates", ...guard.can("ledger:read:property"), async (_req, res) => {
        res.json({ updates: await manager.updates() })
    })

    // ---- Properties and units

    // add a new property
    router.post("/manager/properties", ...guard.can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({ id: await manager.saveProperty(null, { name: text(body.name, 255)!, address: text(body.address, 500)! }) })
    })

    // update a property by id
    router.put("/manager/properties/:propertyId", ...guard.can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.json({ id: await manager.saveProperty(id(req.params.propertyId), { name: text(body.name, 255)!, address: text(body.address, 500)! }) })
    })

    // deactivate a property by id
    router.delete("/manager/properties/:propertyId", ...guard.can("users:provision"), async (req, res) => {
        await manager.deactivateProperty(id(req.params.propertyId))
        res.json({ ok: true })
    })

    // add a new unit, based on property id and unit number
    router.post("/manager/units", ...guard.can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({ id: await manager.saveUnit(null, { propertyId: id(body.propertyId), unitNum: text(body.unitNum, 20)! }) })
    })

    // update a unit by unit id
    router.put("/manager/units/:unitId", ...guard.can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.json({ id: await manager.saveUnit(id(req.params.unitId), { propertyId: id(body.propertyId), unitNum: text(body.unitNum, 20)! }) })
    })

    // deactivate a unit by unit id
    router.delete("/manager/units/:unitId", ...guard.can("users:provision"), async (req, res) => {
        await manager.deactivateUnit(id(req.params.unitId))
        res.json({ ok: true })
    })

    // add a new tenant, return the inviteed tenant's id and invite link
    router.post("/manager/tenants", ...guard.can("users:provision"), async (req, res) => {
        const invite = await manager.inviteTenant(person(req.body))
        res.status(201).json({ id: invite.tenantId, ...withLink(invite) })
    })

    // update a tenants information
    router.put("/manager/tenants/:tenantId", ...guard.can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        await manager.updateTenant(id(req.params.tenantId), { name: text(body.name, 255)!, phone: text(body.phone, 20, { optional: true }) })
        res.json({ ok: true })
    })
    
    // update a tenants invite link
    router.post("/manager/tenants/:tenantId/invite", limits.sensitive, ...guard.can("users:provision"), async (req, res) => {
        res.json(withLink(await manager.reissueInvite(id(req.params.tenantId))))
    })

    // mark a tenant as deactivated
    router.delete("/manager/tenants/:tenantId", ...guard.can("users:provision"), async (req, res) => {
        await manager.deactivateTenant(id(req.params.tenantId))
        res.json({ ok: true })
    })

    // ---- Leases

    // creates a new lease and returns sign up links for each tenant on the lease
    router.post("/manager/leases", ...guard.can("users:provision"), async (req, res) => {
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

    // update an existing lease by lease id, updates the rent and end date
    router.put("/manager/leases/:leaseId", ...guard.can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        await manager.updateLease(id(req.params.leaseId), {
            ...(body.monthlyRent !== undefined ? { monthlyRent: money(body.monthlyRent) } : {}),
            ...("endDate" in body ? { endDate: date(body.endDate, { optional: true }) } : {}),
        })
        res.json({ ok: true })
    })

    // add tenant to an existing lease
    router.post("/manager/leases/:leaseId/tenants", ...guard.can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const invite = await manager.addTenantToLease(
            id(req.params.leaseId),
            body.newTenant ? { newTenant: person(body.newTenant) } : { tenantId: id(body.tenantId) },
        )
        res.status(201).json({ ok: true, ...(invite ? { invite: withLink(invite) } : {}) })
    })

    // remove a tenant from a lease by lease id and tenant id
    router.delete("/manager/leases/:leaseId/tenants/:tenantId", ...guard.can("users:provision"), async (req, res) => {
        await manager.removeTenantFromLease(id(req.params.leaseId), id(req.params.tenantId))
        res.json({ ok: true })
    })

    // ---- Payments and receipts

    // add a new rent payment onto the database
    router.post("/manager/leases/:leaseId/payments", limits.sensitive, ...guard.can("ledger:adjust"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const methods = ["Check", "Cash", "Money order", "Bank transfer"]
        if (typeof body.method !== "string" || !methods.includes(body.method)) throw new AppError("VALIDATION_ERROR") // check payment method exists and is valid

        // stores the amount, method, tenantID, and a receipt file (TODO, automatic payments dont use receipt images)
        const confirmation = await manager.recordPayment(id(req.params.leaseId), {
            amount: money(body.amount),
            method: body.method,
            tenantId: body.tenantId === undefined || body.tenantId === null ? null : id(body.tenantId),
            receipt: body.receipt === undefined || body.receipt === null ? null : receipt(body.receipt),
        })
        res.status(201).json({ confirmation })
    })


    
    router.delete("/manager/leases/:leaseId/payments/:paymentId", ...guard.can("ledger:adjust"), async (req, res) => {
        await manager.reverseOfficePayment(id(req.params.leaseId), id(req.params.paymentId))
        res.json({ ok: true })
    })

    // add a receipt to a particular payment
    router.put("/manager/leases/:leaseId/payments/:paymentId/receipt", limits.sensitive, ...guard.can("ledger:adjust"), async (req, res) => {
        await manager.attachReceipt(id(req.params.leaseId), id(req.params.paymentId), receipt(req.body))
        res.json({ ok: true })
    })

    // return the receipt data
    router.get("/manager/leases/:leaseId/payments/:paymentId/receipt", ...guard.can("ledger:read:property"), async (req, res) => {
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

    // return a list of maintenance requests including the property and unit they belong to
    router.get("/manager/maintenance", ...guard.can("maintenance:manage"), async (_req, res) => {
        const units = await manager.units()
        res.json({
            requests: await manager.maintenance(),
            units: units.map((u) => ({ id: u.id, label: `Unit ${u.unitNum} - ${u.propertyName}` })),
        })
    })

    // create a mainteance request/ticket for a unit
    router.post("/manager/maintenance", ...guard.can("maintenance:manage"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        res.status(201).json({
            id: await manager.createMaintenance({
                unitId: id(body.unitId),
                title: text(body.title, 120)!,
                description: text(body.description, 4000, { optional: true }) ?? "",
            }),
        })
    })

    // update the status of a maintenace request
    router.put("/manager/maintenance/:requestId", ...guard.can("maintenance:manage"), async (req, res) => {
        const status = (req.body as Record<string, unknown>).status
        if (status !== "submitted" && status !== "in_progress" && status !== "resolved") throw new AppError("VALIDATION_ERROR")
        await manager.setMaintenanceStatus(id(req.params.requestId), status)
        res.json({ ok: true })
    })

    // deactivate a mainteance request
    router.delete("/manager/maintenance/:requestId", ...guard.can("maintenance:manage"), async (req, res) => {
        await manager.deactivateMaintenance(id(req.params.requestId))
        res.json({ ok: true })
    })

    return router
}
