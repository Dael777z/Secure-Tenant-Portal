import { Router } from "express"

import type { Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import type { TenantService } from "../services/tenant-service"
import type { ValidRequest } from "../types/access"
import { id, idempotencyKey, money, text } from "./validate"

/**
 * /api/tenant: the tenant pages, always as the signed-in tenant.
 *
 *   GET  /tenant/summary       balance, ledger, requests, notices, bank accounts
 *   POST /tenant/payments      { amount, bankAccountId?, idempotencyKey? }  → { confirmation }
 *                              (the same idempotencyKey again answers with the first payment's confirmation)
 *   POST /tenant/maintenance   { title, description? }     → the new request
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
