import { useCallback, useEffect, useState } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import './App.css'

type BankAccount = {
  name: string
  mask: string | null
  subtype: string | null
  account_number: string | null
  routing_number: string | null
}

function App() {
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/create_link_token', { method: 'POST' })
      .then((res) => res.json())
      .then((data) => {
        if (data.link_token) setLinkToken(data.link_token)
        else setError(JSON.stringify(data.error))
      })
      .catch((err) => setError(String(err)))
  }, [])

  const onSuccess = useCallback(async (publicToken: string | null) => {
    if (!publicToken) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/exchange_and_get_auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token: publicToken }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(JSON.stringify(data.error))
      setAccounts(data.accounts)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess })

  return (
    <main className="container">
      <h1>Bank Account Connector</h1>

      <button className="connect" onClick={() => open()} disabled={!ready || loading}>
        Connect bank account
      </button>

      {loading && <p>Fetching account details…</p>}
      {error && <p className="error">Error: {error}</p>}

      {accounts.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Account number</th>
              <th>Routing number</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={`${a.name}-${a.mask}`}>
                <td>
                  {a.name} {a.subtype && <small>({a.subtype})</small>}
                </td>
                <td><code>{a.account_number ?? '—'}</code></td>
                <td><code>{a.routing_number ?? '—'}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

export default App
