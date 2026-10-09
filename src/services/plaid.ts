import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from "plaid"

/**
 * The two Plaid calls Dael's prototype makes (feature/plaid-connector,
 * server/index.ts), behind an interface so the routes can be tested without
 * reaching Plaid.
 */
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

export function createPlaidGateway(options: { clientId: string; secret: string; env: "sandbox" | "production" }): PlaidGateway {
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

    return {
        async createLinkToken(clientUserId) {
            const response = await plaid.linkTokenCreate({
                user: { client_user_id: clientUserId },
                client_name: "Summit Resident Portal",
                products: [Products.Auth],
                country_codes: [CountryCode.Us],
                language: "en",
            })
            return response.data.link_token
        },

        async exchangeAndGetAuth(publicToken) {
            const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken })
            const auth = await plaid.authGet({ access_token: exchange.data.access_token })
            const accounts = auth.data.accounts.map((account) => {
                const ach = auth.data.numbers.ach.find((n) => n.account_id === account.account_id)
                return {
                    accountId: account.account_id,
                    name: account.name,
                    mask: account.mask ?? null,
                    subtype: account.subtype ?? null,
                    accountNumber: ach?.account ?? null,
                    routingNumber: ach?.routing ?? null,
                }
            })
            return { itemId: exchange.data.item_id, accessToken: exchange.data.access_token, accounts }
        },
    }
}
