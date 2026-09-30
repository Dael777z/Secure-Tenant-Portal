import 'dotenv/config'
import express from 'express'
import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from 'plaid'

const { PLAID_CLIENT_ID, PLAID_SECRET } = process.env
if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.error('Missing PLAID_CLIENT_ID or PLAID_SECRET in .env')
  process.exit(1)
}

const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET': PLAID_SECRET,
      },
    },
  }),
)

const app = express()
app.use(express.json())

// Step 1: create a link_token the frontend uses to open Plaid Link
app.post('/api/create_link_token', async (_req, res) => {
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: 'prototype-user' },
      client_name: 'API Connector Prototype',
      products: [Products.Auth],
      country_codes: [CountryCode.Us],
      language: 'en',
    })
    res.json({ link_token: response.data.link_token })
  } catch (err) {
    handleError(res, err)
  }
})

// Step 2: exchange the public_token from Link, then fetch account + routing numbers
app.post('/api/exchange_and_get_auth', async (req, res) => {
  try {
    const { public_token } = req.body as { public_token: string }
    const exchange = await plaid.itemPublicTokenExchange({ public_token })
    const auth = await plaid.authGet({ access_token: exchange.data.access_token })

    const accounts = auth.data.accounts.map((account) => {
      const ach = auth.data.numbers.ach.find((n) => n.account_id === account.account_id)
      return {
        name: account.name,
        mask: account.mask,
        subtype: account.subtype,
        account_number: ach?.account ?? null,
        routing_number: ach?.routing ?? null,
      }
    })
    res.json({ accounts })
  } catch (err) {
    handleError(res, err)
  }
})

function handleError(res: express.Response, err: unknown) {
  const plaidError = (err as { response?: { data?: unknown } }).response?.data
  console.error(plaidError ?? err)
  res.status(500).json({ error: plaidError ?? String(err) })
}

const PORT = Number(process.env.PORT ?? 8000)
app.listen(PORT, () => console.log(`Plaid server listening on http://localhost:${PORT}`))
