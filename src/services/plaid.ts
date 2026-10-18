import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from "plaid"

import type { LogService } from "../logging"
import { AppError } from "../types/errors"

// interface for plaid account data useful for mocking plaid bank linking flow
export interface PlaidAccount {
    accountId: string
    name: string
    mask: string | null
    subtype: string | null
    accountNumber: string | null
    routingNumber: string | null
}

export interface PlaidGateway {
    createLinkToken(clientUserId: string): Promise<string>
    exchangeAndGetAuth(publicToken: string): Promise<{ itemId: string; accessToken: string; accounts: PlaidAccount[] }>
}

export interface PlaidGatewayOptions {
    clientId: string
    secret: string
    env: "sandbox" | "production"
    redirectUri: string
    logger: LogService
    verboseErrors: boolean
}

// take a plaid failed response and extract the failure information
export function describePlaidFailure(error: unknown) {
    const failure = error as { response?: { status?: number; data?: Record<string, unknown> }; code?: string; message?: string }
    const data = failure.response?.data ?? {}
    return {
        status: failure.response?.status ?? null,
        type: (data.error_type as string | undefined) ?? (failure.response ? "UNKNOWN" : "NETWORK"),
        code: (data.error_code as string | undefined) ?? failure.code ?? "UNKNOWN",
        message: (data.error_message as string | undefined) ?? failure.message ?? "no message",
        displayMessage: (data.display_message as string | null | undefined) ?? null,
        requestId: (data.request_id as string | undefined) ?? null,
    }
}

// create plaid gateway
export function createPlaidGateway(options: PlaidGatewayOptions): PlaidGateway {

    // create plaid api with configuration options specified
    const plaid = new PlaidApi(
        new Configuration({
            basePath: PlaidEnvironments[options.env],
            baseOptions: {
                headers: {
                    "PLAID-CLIENT-ID": options.clientId,
                    "PLAID-SECRET": options.secret,
                },
            },
        }),
    )

    // wraps a plaid operation in a try catch statement that will catch and log plaid errors
    async function call<T>(operation: string, request: () => Promise<{ data: T }>): Promise<T> {
        try {
            return (await request()).data
        } catch (error) {
            const failure = describePlaidFailure(error)
            options.logger.error("plaid.request_failed", { operation, env: options.env, ...failure })
            throw new AppError("PLAID_ERROR", {
                operation,
                plaidCode: failure.code,
                plaidType: failure.type,
                requestId: failure.requestId,
                message: failure.displayMessage ?? (options.verboseErrors ? failure.message : null),
            })
        }
    }

    return {

        // create plaid api link token
        async createLinkToken(clientUserId) {
            const data = await call("link_token_create", () => plaid.linkTokenCreate({
                user: { client_user_id: clientUserId },
                client_name: "Summit Resident Portal",
                products: [Products.Auth],
                country_codes: [CountryCode.Us],
                language: "en",
                redirect_uri: options.redirectUri,
            }))
            return data.link_token
        },

        // exchange link token for a limited plaid api access token, return accounts and access token
        async exchangeAndGetAuth(publicToken) {
            const exchange = await call("item_public_token_exchange", () => plaid.itemPublicTokenExchange({ public_token: publicToken }))
            const auth = await call("auth_get", () => plaid.authGet({ access_token: exchange.access_token }))
            const accounts = auth.accounts.map((account) => {
                const ach = auth.numbers.ach.find((n) => n.account_id === account.account_id)
                return {
                    accountId: account.account_id,
                    name: account.name,
                    mask: account.mask ?? null,
                    subtype: account.subtype ?? null,
                    accountNumber: ach?.account ?? null,
                    routingNumber: ach?.routing ?? null,
                }
            })
            return { itemId: exchange.item_id, accessToken: exchange.access_token, accounts }
        },
    }
}
