import { Router } from "express"

import type { Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import type { TenantService } from "../services/tenant-service"
import type { ValidRequest } from "../types/access"
import { AppError } from "../types/errors"
import { MANUAL_PAY_METHODS, type ManualPayMethod, type NotificationPrefs } from "../types/settings"
import { id, idempotencyKey, money, text } from "./validate"

/**
 * /api/tenant: the tenant pages, always as the signed-in tenant.
 *
 *   GET  /tenant/summary       balance, ledger, requests, notices, bank accounts
 *   POST /tenant/payments      { amount, bankAccountId?, idempotencyKey? }  → { confirmation }
 *                              (the same idempotencyKey again answers with the first payment's confirmation)
 *   POST /tenant/maintenance   { title, description? }     → the new request
 *
 * Juan's tenant side (006):
 *   POST /tenant/payments/report  { method: "cashapp"|"zelle", amount, idempotencyKey? } → { confirmation }
 *                                  (the full balance, sent in the tenant's own app; pending until the office confirms)
 *   PUT  /tenant/profile          { name, phone? }   the tenant's own name and phone
 *   PUT  /tenant/notifications    { rentDue, paymentReceipts, maintenance, messages }  email choices
 */
export function createTenantRouter(deps: { tenant: TenantService; guard: Auth; limits: RateLimits; plaidEnabled: boolean; testPayments: boolean }): Router {
    const { tenant, guard, limits } = deps
    const flags = { plaidEnabled: deps.plaidEnabled, testPayments: deps.testPayments }
    const router = Router()

    // return a summary of all the pertinent information related to the tenant
    router.get("/tenant/summary", ...guard.can("ledger:read:self"), async (req: ValidRequest, res) => {
        res.json(await tenant.summary(req.user!.id, flags))
    })

    // add a payment by tenant id and associate it with a bank account
    router.post("/tenant/payments", limits.sensitive, ...guard.can("payment:create:self"), async (req: ValidRequest, res) => {
        const body = req.body as Record<string, unknown>
        const bankAccountId = body.bankAccountId === undefined || body.bankAccountId === null ? null : id(body.bankAccountId)
        res.status(201).json(await tenant.recordPayment(req.user!.id, { amount: money(body.amount), bankAccountId, idempotencyKey: idempotencyKey(body.idempotencyKey) }, flags))
    })

    // Cash App / Zelle: "I've sent it"
    router.post("/tenant/payments/report", limits.sensitive, ...guard.can("payment:create:self"), async (req: ValidRequest, res) => {
        const body = req.body as Record<string, unknown>
        if (!MANUAL_PAY_METHODS.includes(body.method as ManualPayMethod)) throw new AppError("VALIDATION_ERROR")
        res.status(201).json(await tenant.reportPayment(req.user!.id, {
            method: body.method as ManualPayMethod,
            amount: money(body.amount),
            idempotencyKey: idempotencyKey(body.idempotencyKey),
        }))
    })

    router.put("/tenant/profile", limits.sensitive, ...guard.can("account:self"), async (req: ValidRequest, res) => {
        const body = req.body as Record<string, unknown>
        const phone = text(body.phone, 40, { optional: true })
        if (phone !== null && !/^[0-9+().\-\s]{7,40}$/.test(phone)) throw new AppError("VALIDATION_ERROR")
        await tenant.updateProfile(req.user!.id, { name: text(body.name, 255)!, phone })
        res.json({ ok: true })
    })

    router.put("/tenant/notifications", ...guard.can("account:self"), async (req: ValidRequest, res) => {
        const body = req.body as Record<string, unknown>
        const keys: Array<keyof NotificationPrefs> = ["rentDue", "paymentReceipts", "maintenance", "messages"]
        if (!keys.every((k) => typeof body[k] === "boolean")) throw new AppError("VALIDATION_ERROR")
        const prefs = Object.fromEntries(keys.map((k) => [k, body[k]])) as unknown as NotificationPrefs
        await tenant.saveNotificationPrefs(req.user!.id, prefs)
        res.json(prefs)
    })

    // create a maintenace request by tenant id
    router.post("/tenant/maintenance", limits.sensitive, ...guard.can("maintenance:create"), async (req: ValidRequest, res) => {
        const body = req.body as Record<string, unknown>
        const request = await tenant.createMaintenance(req.user!.id, {
            title: text(body.title, 120)!,
            description: text(body.description, 4000, { optional: true }) ?? "",
        })
        res.status(201).json(request)
    })

    return router
}
