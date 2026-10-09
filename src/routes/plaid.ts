import { Router } from "express"

import { env } from "../config/env"
import { authenticateJWT } from "../middleware/auth"
import { requirePermission } from "../middleware/rbac"
import type { PlaidGateway } from "../services/plaid"
import type { TenantStore } from "../services/tenant-store"
import { AppError } from "../types/errors"
import type { ValidRequest } from "../types/interfaces"
import { encryptSecret } from "../utils/secrets"

/**
 * Dael's Plaid prototype (feature/plaid-connector), mounted in the main app
 * with the same two paths, now for a signed-in tenant:
 *
 *   POST /api/create_link_token       → { link_token }
 *   POST /api/exchange_and_get_auth   → { accounts, bankAccounts }
 *
 * Changes from the prototype: the Plaid user is the real signed-in tenant; the
 * linked accounts are saved (access token encrypted, last four digits only);
 * and the response shows the routing number but only the last four digits of
 * the account number.
 */
export function createPlaidRouter(plaid: PlaidGateway | null, store: TenantStore | null): Router {
    const router = Router()

    const ready = () => {
        if (!plaid) throw new AppError("PLAID_NOT_CONFIGURED")
        if (!store) throw new AppError("DATABASE_REQUIRED")
        return { plaid, store }
    }

    router.post("/create_link_token", authenticateJWT, requirePermission("payment:create:self"), async (req: ValidRequest, res) => {
        const { plaid } = ready()
        try {
            res.json({ link_token: await plaid.createLinkToken(req.user!.id) })
        } catch {
            throw new AppError("PLAID_ERROR")
        }
    })

    router.post("/exchange_and_get_auth", authenticateJWT, requirePermission("payment:create:self"), async (req: ValidRequest, res) => {
        const { plaid, store } = ready()
        const { public_token } = req.body as { public_token?: unknown }
        if (typeof public_token !== "string" || !public_token || public_token.length > 300) throw new AppError("VALIDATION_ERROR")

        let linked
        try {
            linked = await plaid.exchangeAndGetAuth(public_token)
        } catch {
            throw new AppError("PLAID_ERROR")
        }

        const bankAccounts = await store.saveBankAccounts(
            req.user!.id,
            { itemId: linked.itemId, accessTokenEnc: encryptSecret(linked.accessToken, env.tokenEncryptionKey) },
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
