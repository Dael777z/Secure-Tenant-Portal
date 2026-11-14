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
Rent by debit/credit card, Apple Pay or Google Pay, through Stripe (010). Without Stripe keys
these answer 503 STRIPE_NOT_CONFIGURED. `amount` is the rent being paid; the server adds any fee.

  payment:create:self (the signed-in tenant)
    POST /tenant/payments/card                 { amount, idempotencyKey, confirmationTokenId } (a ctoken_ from Stripe.js)
                                               → { paymentIntentId, clientSecret, status, requiresAction, fee, total };
                                               402 CARD_DECLINED with Stripe's message when the card is refused;
                                               the amount follows the usual rules (AMOUNT_BELOW_BALANCE, AMOUNT_ABOVE_LIMIT, ALREADY_REPORTED)
    POST /tenant/payments/stripe/:id/refresh   → { status: pending | completed | failed, confirmation }
 */
export function createStripePaymentRouter(deps: { payments: StripePaymentService; guard: Auth; limits: RateLimits }): Router {
    const { payments, guard, limits } = deps
    const router = Router()

    router.post("/tenant/payments/card", limits.sensitive, ...guard.can("payment:create:self"), async (req: ValidRequest, res) => {
        const body = req.body as Record<string, unknown>
        const key = idempotencyKey(body.idempotencyKey)   // required: it is what makes a retry safe
        const token = body.confirmationTokenId
        if (!key || typeof token !== "string" || !/^ctoken_[A-Za-z0-9_]{1,250}$/.test(token)) throw new AppError("VALIDATION_ERROR")
        res.status(201).json(await payments.startCard(req.user!.id, { amount: money(body.amount), idempotencyKey: key, confirmationTokenId: token }))
    })

    router.post("/tenant/payments/stripe/:paymentIntentId/refresh", limits.sensitive, ...guard.can("payment:create:self"), async (req, res) => {
        res.json(await payments.refreshForTenant(paymentIntentId(req.params.paymentIntentId)))
    })

    return router
}

/** Stripe's events are small (a few KB); this is plenty, and keeps an unsigned-in route's body small (middleware/body.ts). */
export const WEBHOOK_BODY_LIMIT = "256kb"

/*
  POST /stripe/webhook   Stripe's events, signed with STRIPE_WEBHOOK_SECRET. No session: the signature is
                         the proof. Needs the body exactly as sent, so it is mounted before the JSON body parser.
                         Subscribe to payment_intent.succeeded, .processing, .payment_failed, .canceled,
                         charge.refunded and charge.refund.updated.
 */
export function createStripeWebhookRouter(deps: { payments: StripePaymentService }): Router {
    const router = Router()
    router.post("/stripe/webhook", express.raw({ type: "application/json", limit: WEBHOOK_BODY_LIMIT }), async (req, res) => {
        const signature = req.get("stripe-signature")
        if (!signature || !Buffer.isBuffer(req.body)) throw new AppError("WEBHOOK_SIGNATURE_INVALID")
        await deps.payments.handleWebhook(req.body, signature)
        res.json({ received: true })
    })
    return router
}
