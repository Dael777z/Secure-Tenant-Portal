import Stripe from "stripe"

import type { LogService } from "../logging"
import { AppError } from "../types/errors"
import type { CardDetails } from "../types/inputs"

/**
 * The Stripe calls the portal makes, behind an interface so tests use a fake.
 * Only the fields the portal uses come back, already in plain shapes.
 */
export interface StripeIntent {
    id: string
    /** requires_payment_method, requires_action, processing, succeeded, canceled, ... */
    status: string
    amountCents: number
    amountReceivedCents: number
    currency: string
    clientSecret: string | null
    /** Why the last attempt failed (the card was declined, the bank's check failed, ...). */
    failureMessage: string | null
    /** The card it was paid with (cards, Apple Pay, Google Pay). */
    card: CardDetails | null
}

export interface StripeRefundState {
    id: string
    amountCents: number
    /** pending, requires_action, succeeded, failed, canceled */
    status: string | null
}

/** A verified webhook event, cut down to what the portal acts on. */
export interface StripeWebhookEvent {
    id: string
    type: string
    /** The PaymentIntent the event is about (for charge and refund events, the one they belong to). */
    paymentIntentId: string | null
    /** The id of the object in the event (pi_, ch_, re_). */
    objectId: string | null
}

export interface StripeGateway {
    /** For Stripe.js in the browser. */
    publishableKey: string
    /**
     * What the tenant entered in Stripe's card form or wallet sheet (a ConfirmationToken made by
     * Stripe.js), read before charging. `type` is "card" for cards, Apple Pay and Google Pay.
     */
    readConfirmationToken(confirmationTokenId: string): Promise<{ type: string; card: CardDetails | null }>
    /** Create and confirm a card PaymentIntent with that token. CARD_DECLINED when the card is refused. */
    createCardIntent(input: {
        amountCents: number; description: string; metadata: Record<string, string>; idempotencyKey: string; confirmationTokenId: string
    }): Promise<StripeIntent>
    retrieveIntent(paymentIntentId: string): Promise<StripeIntent>
    listRefunds(paymentIntentId: string): Promise<StripeRefundState[]>
    /** WEBHOOK_SIGNATURE_INVALID when the signature does not match; STRIPE_NOT_CONFIGURED without a webhook secret. */
    verifyWebhook(rawBody: Buffer | string, signature: string): StripeWebhookEvent
}

export interface StripeGatewayOptions {
    secretKey: string
    publishableKey: string
    webhookSecret: string
    logger: LogService
    /** Pass Stripe's message to the browser (development); in production only the code. */
    verboseErrors: boolean
}

export function createStripeGateway(options: StripeGatewayOptions): StripeGateway {
    const stripe = new Stripe(options.secretKey, { maxNetworkRetries: 2, timeout: 20_000 })
    const mode = options.secretKey.includes("_test_") ? "test" : "live"

    /** One Stripe call, logged as stripe.request.succeeded / .failed; failures become STRIPE_ERROR. */
    async function call<T>(operation: string, work: () => Promise<T>): Promise<T> {
        const startedAt = Date.now()
        try {
            const result = await work()
            options.logger.info("stripe.request.succeeded", { operation, mode, durationMs: Date.now() - startedAt })
            return result
        } catch (error) {
            const e = error as { type?: string; code?: string; decline_code?: string; message?: string; requestId?: string; statusCode?: number }
            // A declined card is the tenant's to fix, not a fault: Stripe writes its message for the cardholder.
            if (e.type === "StripeCardError") {
                options.logger.warn("stripe.card.declined", { operation, mode, code: e.code, declineCode: e.decline_code, requestId: e.requestId })
                throw new AppError("CARD_DECLINED", { message: e.message ?? null, declineCode: e.decline_code ?? e.code ?? null })
            }
            options.logger.error("stripe.request.failed", {
                operation, mode, type: e.type, code: e.code, statusCode: e.statusCode, requestId: e.requestId, message: e.message, durationMs: Date.now() - startedAt,
            })
            throw new AppError("STRIPE_ERROR", {
                operation,
                stripeCode: e.code ?? e.type ?? null,
                requestId: e.requestId ?? null,
                message: options.verboseErrors ? e.message ?? null : null,
            })
        }
    }

    return {
        publishableKey: options.publishableKey,

        readConfirmationToken(confirmationTokenId) {
            return call("confirmation_tokens.retrieve", async () => {
                const preview = (await stripe.confirmationTokens.retrieve(confirmationTokenId)).payment_method_preview
                return { type: preview?.type ?? "unknown", card: preview?.card ? cardDetails(preview.card) : null }
            })
        },

        createCardIntent(input) {
            return call("payment_intents.create", async () => {
                const created = await stripe.paymentIntents.create({
                    amount: input.amountCents,
                    currency: "usd",
                    allowed_payment_method_types: ["card"],
                    confirm: true,
                    confirmation_token: input.confirmationTokenId,
                    description: input.description,
                    metadata: input.metadata,
                }, { idempotencyKey: input.idempotencyKey })
                // again, expanded: what the card actually was
                return toIntent(await stripe.paymentIntents.retrieve(created.id, { expand: ["payment_method"] }))
            })
        },

        retrieveIntent(paymentIntentId) {
            // expanded, for the card's brand and last four digits
            return call("payment_intents.retrieve", async () => toIntent(await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method"] })))
        },

        listRefunds(paymentIntentId) {
            return call("refunds.list", async () => (await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 })).data
                .map((r) => ({ id: r.id, amountCents: r.amount, status: r.status })))
        },

        verifyWebhook(rawBody, signature) {
            if (!options.webhookSecret) throw new AppError("STRIPE_NOT_CONFIGURED")
            let event: Stripe.Event
            try {
                event = stripe.webhooks.constructEvent(rawBody, signature, options.webhookSecret)
            } catch {
                throw new AppError("WEBHOOK_SIGNATURE_INVALID")
            }
            return toWebhookEvent(event)
        },
    }
}

function toIntent(pi: Stripe.PaymentIntent): StripeIntent {
    const method = typeof pi.payment_method === "object" && pi.payment_method ? pi.payment_method : null
    return {
        id: pi.id,
        status: pi.status,
        amountCents: pi.amount,
        amountReceivedCents: pi.amount_received,
        currency: pi.currency,
        clientSecret: pi.client_secret,
        failureMessage: pi.last_payment_error?.message ?? null,
        card: method?.card ? cardDetails(method.card) : null,
    }
}

function cardDetails(card: { brand?: string | null; last4?: string | null; funding?: string | null; wallet?: { type?: string | null } | null }): CardDetails {
    return { brand: card.brand ?? null, last4: card.last4 ?? null, funding: card.funding ?? null, wallet: card.wallet?.type ?? null }
}

const idOf = (value: string | { id: string } | null | undefined) => (typeof value === "string" ? value : value?.id ?? null)

/** Exported for tests, which build events with Stripe's own test signatures. */
export function toWebhookEvent(event: Stripe.Event): StripeWebhookEvent {
    const object = event.data.object as { id?: string; object?: string; payment_intent?: string | { id: string } | null }
    const paymentIntentId = object.object === "payment_intent" ? object.id ?? null : idOf(object.payment_intent)
    return { id: event.id, type: event.type, paymentIntentId, objectId: object.id ?? null }
}
