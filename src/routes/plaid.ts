import { Router } from "express"

import type { Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import type { PlaidGateway } from "../services/plaid"
import type { TenantService } from "../services/tenant-service"
import { AppError } from "../types/errors"
import type { ValidRequest } from "../types/access"
import { encryptSecret } from "../utils/secrets"

/**
 * Linking a tenant's bank account with Plaid:
 *
 *   POST /api/create_link_token       → { link_token }
 *   POST /api/exchange_and_get_auth   { public_token } → { accounts, bankAccounts }
 *
 * The access token is stored encrypted, and account numbers leave only as
 * their last four digits. Without Plaid keys both routes answer 503 PLAID_NOT_CONFIGURED.
 */
export function createPlaidRouter(deps: {
    plaid: PlaidGateway | null
    tenant: TenantService
    guard: Auth
    limits: RateLimits
    tokenEncryptionKey: string
}): Router {
    const { tenant, guard, tokenEncryptionKey, limits } = deps
    const router = Router()

    const gateway = (): PlaidGateway => {
        if (!deps.plaid) throw new AppError("PLAID_NOT_CONFIGURED")
        return deps.plaid
    }

    router.post("/create_link_token", limits.sensitive, ...guard.can("payment:create:self"), async (req: ValidRequest, res) => {
        const plaid = gateway()
        try {
            res.json({ link_token: await plaid.createLinkToken(req.user!.id) })
        } catch {
            throw new AppError("PLAID_ERROR")
        }
    })

    router.post("/exchange_and_get_auth", limits.sensitive, ...guard.can("payment:create:self"), async (req: ValidRequest, res) => {
        const plaid = gateway()
        const { public_token } = req.body as { public_token?: unknown }
        if (typeof public_token !== "string" || !public_token || public_token.length > 300) throw new AppError("VALIDATION_ERROR")

        let linked
        try {
            linked = await plaid.exchangeAndGetAuth(public_token)
        } catch {
            throw new AppError("PLAID_ERROR")
        }

        const bankAccounts = await tenant.saveBankAccounts(
            req.user!.id,
            { itemId: linked.itemId, accessTokenEnc: encryptSecret(linked.accessToken, tokenEncryptionKey) },
            linked.accounts.map((a) => ({ accountId: a.accountId, name: a.name, mask: a.mask, subtype: a.subtype })),
        )

        res.json({
            accounts: linked.accounts.map((a) => ({
                name: a.name,
                mask: a.mask,
                subtype: a.subtype,
                account_number: a.accountNumber ? `••••${a.accountNumber.slice(-4)}` : null,
                routing_number: a.routingNumber,
            })),
            bankAccounts,
        })
    })

    return router
}
