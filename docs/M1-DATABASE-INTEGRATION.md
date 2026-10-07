# Milestone 1: database and API integration

Branch `feature/postgres-integration`, built on Scott's `TypeScript-Skeleton`.
Author: Alex (backend / integration testing), 10/7/2026.

This connects Scott's Express skeleton to Postgres using Angel's schema, and
adds integration tests that run the skeleton's auth API against a real
database. Nothing on the frontend changed.

---

## Run it

1. Start Postgres. With Docker: `npm run db:up`. That starts `docker-compose.db.yml`: Postgres 16 on localhost:5432, with a `portal` database and a `portal_test` database. Any local Postgres works too.
2. Copy `.env.example` to `.env`. Fill in `JWT_ACCESS_SECRET` and `SEED_ADMIN_PASSWORD`. The `DATABASE_URL` and `TEST_DATABASE_URL` values already match `db:up`.
3. `npm install`
4. `npm run db:migrate`: builds the tables. It is safe to run again.
5. `npm run db:seed`: adds a manager login (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`), a property with units 101–104, and an invited tenant `tenant@example.com` on a lease.
6. `npm run dev`, then in Insomnia:
   - `POST /api/auth/signup` `{"email":"tenant@example.com","password":"…"}` returns 201. Any other email returns 403.
   - `POST /api/auth/login`, then `GET /api/auth/me`, as in Scott's demo.

Leave `DATABASE_URL` empty (with `DEV=1`) and the backend uses the in-memory store as before.

## Tests

`npm test` runs everything: 35 tests. The 18 integration tests need `TEST_DATABASE_URL`. Without it they are skipped, and `npm test` also works on a fresh clone with no `.env`, which it didn't before. Each test file builds its own schema in the test database and drops it afterwards.

| File | What it proves |
|---|---|
| `src/integration/schema.integration.test.ts` | Angel's rules hold in the database itself. Units go with their property. A leased unit, and a lease with payments, cannot be deleted. Several tenants per lease, each only once. Maintenance status values and the `submitted` default. A request survives its tenant leaving. No "signed up" without a password. One email, one account. |
| `src/integration/repository.integration.test.ts` | The in-memory store and the Postgres store behave the same, so code tested on one works on the other. |
| `src/integration/http.integration.test.ts` | Scott's Insomnia demo as tests: invite-only signup, login cookies (httpOnly; refresh is SameSite=Strict), `/auth/me`, staff login with the right role, refresh rotation (an old token is refused), logout, and the Origin check. |

## What changed

| File | Change |
|---|---|
| `db/migrations/001_schema.sql` | Angel's sheet, table for table, with his names, including `ammount`/`ammount_owed`. Changes go in new files, never in this one. |
| `db/migrations/002_auth_support.sql` | What we agreed on Discord on 10/1. `Tenants.signed_up`, with a check that a signed-up tenant has a password. `password_hash` becomes nullable so the office can add a tenant first. `Admin.role` uses the skeleton's three staff roles. A `Refresh_Tokens` table, which stores only token hashes. Emails are lower case and unique across Tenants **and** Admin. |
| `src/services/postgres-db.ts` | Implements Scott's `DatabaseInterface` on that schema. A user id says which table it comes from: `tenant:5` or `admin:5`. Tenant 5 and admin 5 are different people, and that id goes in the JWT. |
| `src/db/*` | Connection pool, migration runner (refuses an edited migration), seed, and the `db:migrate` / `db:seed` commands. |
| `src/types/interfaces.ts`, `memory-db.ts` | Adds `inviteTenant` and `completeSignup` to the repository interface, in both stores. |
| `src/services/auth.ts` | **Signup is invite-only** (Scott, 10/1: "if user exist & not signed up let signup"). An unknown address and an already-signed-up one get the same `SIGNUP_NOT_ALLOWED`. Login now takes as long for an unknown email as for a wrong password, so it can't be used to find out who lives here. |
| `src/create-app.ts`, `src/app.ts` | Scott's app setup moved into `createApp()` so the tests can start it. `app.ts` still starts the server the same way. |
| `src/utils/init.ts`, `src/config/env.ts` | `DATABASE_URL` set means Postgres; unset with `DEV=1` means memory. |
| `package.json` | Adds `pg`. Fixes `npm run dev`: `-n backend, frontend` had a space, which is why Scott's terminal said `'frontend' is not recognized`. `npm audit fix` updated `proxy-addr` (critical, used by Express's `trust proxy`). |

---

## What the team decided last week (Discord 9/27–10/2)

- **Stack:** React (Vite) + Express + TypeScript + Postgres. Plaid for linking bank accounts.
- **Users** (Angel, 10/1): Tenants and Admin stay separate tables; roles are on the Admin side. The office adds a tenant; the tenant can sign up only if they already exist (Scott/Angel).
- **Routes** (Scott): grouped as `auth/`, `api/`, `tenant/`.
- **Scope:** Scott and Juan think tenant screening is out of scope. Migration and reconciliation matter more. *To confirm with Hamsa and Mohammad.*
- **Keys:** not in GitHub; shared in a Discord channel.
- **From the client** (9/27, 9/28):
  - Bank transfers only, no cards, one payment page.
  - Migrate about a year of records: about 27 units on RentRedi, the rest in Excel/secretarial records.
  - Several payees per lease, each with their own account or sharing one.
  - Late fees vary and are applied automatically, but staff can delete or edit charges.
  - Every property manager has the same access.
  - Mobile UI matters to them.
  - They want bank statement reconciliation.
  - A chatbot for maintenance is future work.
  - The client handles the hardware.
  - Meetings at Monday class time.

---

## Open items, by person

### Angel: schema (proposals; your call)

The core of our proposal is the shared ledger, and the schema doesn't have one yet. These are the gaps the other pieces will run into. Each one would be a new migration (003, 004, …).

1. **A ledger table.** `Lease.ammount_owed` is one number, so there is no history. Juan's Ledger page needs rows (date, description, amount, balance after). Suggestion: an append-only `Ledger_Entries` table for charges, payments and credits, with the balance as their sum. The client's "delete/modify charges" becomes a reversing entry, which keeps the history honest.
2. **Payment status.** ACH takes days and can fail or bounce. Add `status` (pending / settled / failed / returned) and `method`. Add `tID`, for who paid, since each cosigner can pay. Add a Plaid/transfer reference and an idempotency key, so a double-click doesn't pay twice.
3. **Maintenance details.** Juan's page shows a title, a description and a submitted date. Maintenance_T has only a status. Juan also uses `open` where the database has `submitted`; one of the two should change.
4. **Rent and due day.** Is `ammount_owed` the monthly rent? Consider `monthly_rent` and `rent_due_day`, and per-lease late-fee terms, since the client said they vary.
5. **Small things:**
   - The `ammount` spelling is worth fixing now, before code depends on it.
   - `TIMESTAMP` should be `TIMESTAMPTZ`.
   - Money is NUMERIC dollars in some places. Pick one convention (NUMERIC dollars or integer cents) everywhere.
6. **Privacy rules (RLS)**, as you planned: tenants see only their own leases. The app should also log in as a non-superuser role, not `postgres`, or RLS doesn't apply.

### Dael: Plaid

1. **Don't store account and routing numbers.** The prototype fetches the full numbers and sends them to the browser.
   - The client asked us to store name, email and phone only.
   - Full bank numbers are a liability: they need encryption, and NACHA has rules for them.
   - Store the Plaid `access_token` (server-side only, encrypted), `account_id`, `mask` (last 4) and institution name.
   - Move money with Plaid Transfer, or a processor token (Stripe/Dwolla), and never handle the numbers ourselves. That also covers Juan's autopay idea: autopay keeps the Plaid account link, not the numbers.
2. `client_user_id` should be our real user id (`tenant:5`), not `'prototype-user'`.
3. **The sandbox secret was posted in Discord.** It is sandbox-only and fine for now, but rotate it in the Plaid dashboard before we get production keys. Production keys should go in a password manager or the server's environment, never in chat.
4. A `Bank_Accounts` / `Plaid_Items` table (one per tenant per linked account) belongs in Angel's schema once the above is decided.

### Scott: skeleton

1. Review `createApp()`. It's a straight move of `app.ts` so tests can start the app.
2. Refresh tokens:
   - Two refreshes sent at the same moment with the same token can both succeed. Making `revokeRefreshToken` an `UPDATE … WHERE NOT revoked RETURNING` and checking it closes that.
   - A password change should call `revokeAllTokensForUser`.
3. Vite warns that `frontend/vite.config.ts` is ESM loaded as CommonJS. Renaming it to `vite.config.mts` should fix that.
4. `npm audit` still flags `shell-quote` through `concurrently`. That's dev-only; the fix is a major version bump.

### Juan: tenant UI

The mock data shapes are a good contract. Once Angel settles the ledger and maintenance tables, the next backend step is `GET /api/tenant/ledger`, `/maintenance` and `/payments`, returning those shapes.

### Everyone

- **M1 is due 10/9.** If this is approved, merge it into `TypeScript-Skeleton` so the next pieces build on a real database.
- **Confirm with the client** that tenant screening is out of scope.
