import { Router } from "express"

import type { Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import type { FinanceService } from "../services/finance-service"
import { isPeriod } from "../services/finance"
import type { ValidRequest } from "../types/access"
import { AppError } from "../types/errors"
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "../types/finance"
import { date, id, money, text } from "./validate"

/**
 * /api/manager finance routes (005): collections, P&L, performance, expenses,
 * leases ending soon. Property managers only.
 *
 *   GET    /manager/finance?period=this-month|30d|90d|ytd|12m   the Finance tab
 *   GET    /manager/analytics                                   the Performance tab
 *   GET    /manager/leases/expiring?days=90                      leases ending soon
 *   GET    /manager/leases/:leaseId/renewal-notice               the default message
 *   POST   /manager/leases/:leaseId/renewal-notice  { body? }    message the residents
 *   POST   /manager/expenses   { category, amount, spentOn, propertyId?, unitId?, vendor?, description? }
 *   DELETE /manager/expenses/:expenseId                          void it (kept on record)
 */
export function createFinanceRouter(deps: { finance: FinanceService; guard: Auth; limits: RateLimits }): Router {
    const { finance, guard, limits } = deps
    const { can } = guard
    const router = Router()

    router.get("/manager/finance", ...can("ledger:read:property"), async (req, res) => {
        const period = req.query.period ?? "this-month"
        if (!isPeriod(period)) throw new AppError("VALIDATION_ERROR")
        res.json(await finance.overview(period))
    })

    router.get("/manager/analytics", ...can("ledger:read:property"), async (_req, res) => {
        res.json(await finance.analytics())
    })

    router.get("/manager/leases/expiring", ...can("ledger:read:property"), async (req, res) => {
        const days = req.query.days === undefined ? 90 : Number(req.query.days)
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new AppError("VALIDATION_ERROR")
        res.json({ days, leases: await finance.expiring(days) })
    })

    router.get("/manager/leases/:leaseId/renewal-notice", ...can("messages:manage"), async (req, res) => {
        res.json({ body: await finance.renewalDraft(id(req.params.leaseId)) })
    })

    router.post("/manager/leases/:leaseId/renewal-notice", limits.sensitive, ...can("messages:manage"), async (req: ValidRequest, res) => {
        const body = req.body as Record<string, unknown>
        const message = text(body.body, 2000, { optional: true }) ?? undefined
        res.status(201).json({ recipients: await finance.sendRenewalNotice(req.user!.id, id(req.params.leaseId), message) })
    })

    router.post("/manager/expenses", limits.sensitive, ...can("ledger:adjust"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        if (typeof body.category !== "string" || !(EXPENSE_CATEGORIES as readonly string[]).includes(body.category)) throw new AppError("VALIDATION_ERROR")
        const optionalId = (v: unknown) => (v === undefined || v === null || v === "" ? null : id(v))
        res.status(201).json({
            id: await finance.addExpense({
                category: body.category as ExpenseCategory,
                amount: money(body.amount),
                spentOn: date(body.spentOn)!,
                propertyId: optionalId(body.propertyId),
                unitId: optionalId(body.unitId),
                vendor: text(body.vendor, 120, { optional: true }),
                description: text(body.description, 300, { optional: true }),
            }),
        })
    })

    router.delete("/manager/expenses/:expenseId", ...can("ledger:adjust"), async (req, res) => {
        await finance.voidExpense(id(req.params.expenseId))
        res.json({ ok: true })
    })

    return router
}
