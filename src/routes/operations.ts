import { Router } from "express"

import type { Auth } from "../middleware/auth"
import { receiptBody } from "../middleware/body"
import type { RateLimits } from "../middleware/rate-limit"
import type { OperationsService } from "../services/operations-service"
import { AppError } from "../types/errors"
import { MANUAL_CHARGE_KINDS, type ManualChargeKind } from "../types/inputs"
import type { FeeType, OfficeNotifications, RuleScope } from "../types/operations"
import { date, id, money, text } from "./validate"

/**
 * /api/manager RentRedi-style routes (008). Property managers only.
 *
 *   GET    /manager/charges?from=YYYY-MM-DD&to=YYYY-MM-DD        Rent & Charges (default: this month)
 *   POST   /manager/leases/:leaseId/charges  { kind, amount, dueDate, description?, occurrences? }   one, or monthly repeats
 *   GET    /manager/units/:unitId                                the unit page (leases, performance, requests)
 *   GET    /manager/documents                                    lease PDFs and payment receipts on file
 *   PUT    /manager/leases/:leaseId/document  { filename, data } the signed lease PDF (base64, 4 MB)
 *   GET    /manager/leases/:leaseId/document                     open it
 *   GET    /manager/late-fee-rules                               rules, and the rule each unit gets
 *   POST   /manager/late-fee-rules   { propertyId?, unitId?, graceDays, firstAmount, firstType, dailyAmount?, dailyType?, maxAmount?, maxType? }
 *   DELETE /manager/late-fee-rules/:ruleId                       retire it (kept on record)
 *   GET    /manager/reminder-rules                               rules, units, reminders recorded
 *   POST   /manager/reminder-rules   { propertyId?, unitId?, daysBefore, repeatAfterDue }
 *   DELETE /manager/reminder-rules/:ruleId
 *   GET    /manager/staff                                        the team
 *   GET    /manager/settings/notifications                       where the office is notified
 *   PUT    /manager/settings/notifications   { notifyEmail?, newMaintenance, tenantMessage, reportedPayment, lateRent }
 */
export function createOperationsRouter(deps: { operations: OperationsService; guard: Auth; limits: RateLimits }): Router {
    const { operations, guard, limits } = deps
    const { can } = guard
    const router = Router()

    const scope = (body: Record<string, unknown>): RuleScope => {
        const propertyId = body.propertyId === null || body.propertyId === undefined || body.propertyId === "" ? null : id(body.propertyId)
        const unitId = body.unitId === null || body.unitId === undefined || body.unitId === "" ? null : id(body.unitId)
        if (unitId !== null && propertyId === null) throw new AppError("VALIDATION_ERROR")
        return { propertyId, unitId }
    }
    const feeType = (value: unknown): FeeType => {
        if (value === undefined || value === null || value === "flat") return "flat"
        if (value === "percent") return "percent"
        throw new AppError("VALIDATION_ERROR")
    }
    const amountOrZero = (value: unknown) => (value === undefined || value === null || value === "" || value === 0 ? 0 : money(value))
    const days = (value: unknown, max: number) => {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new AppError("VALIDATION_ERROR")
        return value
    }

    router.get("/manager/charges", ...can("ledger:read:property"), async (req, res) => {
        const q = req.query as Record<string, string | undefined>
        res.json(await operations.charges(q.from ? date(q.from) : null, q.to ? date(q.to) : null))
    })

    // A late fee, deposit, utility bill, parking, HOA fee... once or monthly (rent is billed automatically).
    router.post("/manager/leases/:leaseId/charges", limits.sensitive, ...can("ledger:adjust"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        if (typeof body.kind !== "string" || !(MANUAL_CHARGE_KINDS as readonly string[]).includes(body.kind)) throw new AppError("VALIDATION_ERROR")
        const occurrences = body.occurrences === undefined ? 1 : body.occurrences
        if (typeof occurrences !== "number") throw new AppError("VALIDATION_ERROR")
        const ids = await operations.addCharges(id(req.params.leaseId), {
            kind: body.kind as ManualChargeKind,
            amount: money(body.amount),
            dueDate: date(body.dueDate)!,
            description: text(body.description, 200, { optional: true }),
            occurrences,
        })
        res.status(201).json({ id: ids[0], ids })
    })

    router.get("/manager/units/:unitId", ...can("ledger:read:property"), async (req, res) => {
        res.json(await operations.unit(id(req.params.unitId)))
    })

    router.get("/manager/documents", ...can("ledger:read:property"), async (_req, res) => {
        res.json({ documents: await operations.documents() })
    })

    router.put("/manager/leases/:leaseId/document", limits.sensitive, ...can("users:provision"), receiptBody, async (req, res) => {
        const body = req.body as Record<string, unknown>
        if (typeof body.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new AppError("RECEIPT_INVALID")
        await operations.uploadLeaseDocument(id(req.params.leaseId), { filename: text(body.filename, 200) ?? "lease.pdf", data: body.data })
        res.json({ ok: true })
    })

    router.get("/manager/leases/:leaseId/document", ...can("ledger:read:property"), async (req, res) => {
        const file = await operations.leaseDocument(id(req.params.leaseId))
        if (!file) throw new AppError("NOT_FOUND")
        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${file.filename.replace(/"/g, "")}"`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        })
        res.send(file.data)
    })

    router.get("/manager/late-fee-rules", ...can("ledger:read:property"), async (_req, res) => {
        res.json(await operations.lateFeeRules())
    })

    router.post("/manager/late-fee-rules", limits.sensitive, ...can("ledger:adjust"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const maxAmount = body.maxAmount === undefined || body.maxAmount === null || body.maxAmount === "" ? null : money(body.maxAmount)
        res.status(201).json({
            id: await operations.saveLateFeeRule({
                ...scope(body),
                graceDays: days(body.graceDays, 60),
                firstAmount: amountOrZero(body.firstAmount),
                firstType: feeType(body.firstType),
                dailyAmount: amountOrZero(body.dailyAmount),
                dailyType: feeType(body.dailyType),
                maxAmount,
                maxType: feeType(body.maxType),
            }),
        })
    })

    router.delete("/manager/late-fee-rules/:ruleId", ...can("ledger:adjust"), async (req, res) => {
        await operations.retireLateFeeRule(id(req.params.ruleId))
        res.json({ ok: true })
    })

    router.get("/manager/reminder-rules", ...can("ledger:read:property"), async (_req, res) => {
        res.json(await operations.reminderRules())
    })

    router.post("/manager/reminder-rules", limits.sensitive, ...can("ledger:adjust"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        if (typeof body.repeatAfterDue !== "boolean") throw new AppError("VALIDATION_ERROR")
        res.status(201).json({ id: await operations.saveReminderRule({ ...scope(body), daysBefore: days(body.daysBefore, 30), repeatAfterDue: body.repeatAfterDue }) })
    })

    router.delete("/manager/reminder-rules/:ruleId", ...can("ledger:adjust"), async (req, res) => {
        await operations.retireReminderRule(id(req.params.ruleId))
        res.json({ ok: true })
    })

    router.get("/manager/staff", ...can("ledger:read:property"), async (_req, res) => {
        res.json({ staff: await operations.staff() })
    })

    router.get("/manager/settings/notifications", ...can("ledger:read:property"), async (_req, res) => {
        res.json(await operations.notifications())
    })

    router.put("/manager/settings/notifications", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const flag = (v: unknown) => { if (typeof v !== "boolean") throw new AppError("VALIDATION_ERROR"); return v }
        const notifyEmail = text(body.notifyEmail, 254, { optional: true })
        if (notifyEmail !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(notifyEmail)) throw new AppError("VALIDATION_ERROR")
        const input: OfficeNotifications = {
            notifyEmail,
            newMaintenance: flag(body.newMaintenance),
            tenantMessage: flag(body.tenantMessage),
            reportedPayment: flag(body.reportedPayment),
            lateRent: flag(body.lateRent),
        }
        await operations.saveNotifications(input)
        res.json(input)
    })

    return router
}
