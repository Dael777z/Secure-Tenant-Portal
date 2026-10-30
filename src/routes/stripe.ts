import express, { Router } from "express"

import type { Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import type { StripePaymentService } from "../services/stripe-payments"
import type { ValidRequest } from "../types/access"
import { AppError } from "../types/errors"
import { idempotencyKey, money } from "./validate"

const paymentIntentId = (value: unknown): string => {
    if (typeof value !== "string" || !/^pi_[A-Za-z0-9_]{1,250}$/.test(value)) throw new AppError("VALIDATION_ERROR")
    return value
}

/*
Rent by Cash App Pay, through Stripe (006). Without Stripe keys these answer 503 STRIPE_NOT_CONFIGURED.

  payment:create:self (the signed-in tenant)
    POST /tenant/payments/cashapp              { amount, idempotencyKey } → { paymentIntentId, clientSecret }
                                               (the same idempotencyKey again: the same checkout)
    POST /tenant/payments/cashapp/:id/refresh  → { status: pending | completed | failed, confirmation }
 */
export function createStripePaymentRouter(deps: { payments: StripePaymentService; guard: Auth; limits: RateLimits }): Router {
    const { payments, guard, limits } = deps
    const router = Router()

    router.post("/tenant/payments/cashapp", limits.sensitive, ...guard.can("payment:create:self"), async (req: ValidRequest, res) => {
        const body = req.body as Record<string, unknown>
        const key = idempotencyKey(body.idempotencyKey)
        if (!key) throw new AppError("VALIDATION_ERROR")   // required: it is what makes a retry safe
        res.status(201).json(await payments.startCashApp(req.user!.id, { amount: money(body.amount), idempotencyKey: key }))
    })

    router.post("/tenant/payments/cashapp/:paymentIntentId/refresh", limits.sensitive, ...guard.can("payment:create:self"), async (req, res) => {
        res.json(await payments.refreshForTenant(paymentIntentId(req.params.paymentIntentId)))
    })

    return router
}

/*
  POST /stripe/webhook   Stripe's events, signed with STRIPE_WEBHOOK_SECRET. No session: the signature is
                         the proof. Needs the body exactly as sent, so it is mounted before express.json().
                         Subscribe to payment_intent.succeeded, .processing, .payment_failed, .canceled,
                         charge.refunded and charge.refund.updated.
 */
export function createStripeWebhookRouter(deps: { payments: StripePaymentService }): Router {
    const router = Router()
    router.post("/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
        const signature = req.get("stripe-signature")
        if (!signature || !Buffer.isBuffer(req.body)) throw new AppError("WEBHOOK_SIGNATURE_INVALID")
        await deps.payments.handleWebhook(req.body, signature)
        res.json({ received: true })
    })
    return router
}
