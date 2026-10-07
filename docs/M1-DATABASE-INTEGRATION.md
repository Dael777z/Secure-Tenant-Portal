# Milestone 1: database and API integration

Branch `feature/postgres-integration`, built on Scott's `TypeScript-Skeleton`.
Author: Alex (backend / integration testing), 10/7/2026.

This connects Scott's Express skeleton to Postgres using Angel's schema, and
adds integration tests that run the skeleton's auth API against a real
database. Nothing on the frontend changed.

## Try it on Windows (one click)

1. Double-click **`Start Demo.cmd`** in the repo folder. The first run takes a few minutes; later starts take seconds. It:
   - finds or downloads a portable Node.js 22 and PostgreSQL. These are shared with the resident-portal launcher and need no admin rights.
   - creates its own demo database in `%LOCALAPPDATA%\SecureTenantPortal`.
   - writes `.env`, which stays on your PC and is ignored by git. It asks once for the Plaid sandbox keys; press Enter to skip.
   - runs `npm install`, `db:migrate` and `db:seed`, then `npm run dev`, and opens http://localhost:5173.
2. Sign in:
   - Tenant: `tenant@example.com` / `tenant-demo-password` (every sample resident who has signed up uses the same password, e.g. `aisha.okafor@example.com`)
   - Manager: `manager@example.com` / `manager-demo-password`
   - Maintenance staff: `maintenance@example.com` / `manager-demo-password`
   - In Plaid Link's sandbox: `user_good` / `pass_good`.
3. **`Stop Demo.cmd`** stops the app and the database. **`Reset Demo.cmd`** starts the data over.

---

## Run it (any OS, by hand)

1. Start Postgres. With Docker: `npm run db:up`. That starts `docker-compose.db.yml`: Postgres 16 on localhost:5432, with a `portal` database and a `portal_test` database. Any local Postgres works too.
2. Copy `.env.example` to `.env`. Fill in `JWT_ACCESS_SECRET` and `SEED_ADMIN_PASSWORD`. The `DATABASE_URL` and `TEST_DATABASE_URL` values already match `db:up`.
3. `npm install`
4. `npm run db:migrate`: builds the tables. It is safe to run again.
5. `npm run db:seed`: adds a manager login (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`), a maintenance login, and the demo portfolio (see "Demo data" under the manager side). With `SEED_TENANT_PASSWORD` set, `tenant@example.com` can sign in right away; without it, the tenant is invited and signs up first.
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

## Juan's tenant UI, connected (branch `feature/tenant-ui-integration`)

This branch is built on the one above.

- Juan's `tenant-side-ui` branch is copied into `frontend/`, unchanged, as its own commit with his authorship. It replaces the skeleton's placeholder page.
- Sign-in is now real. The login form calls `/api/auth/login`. A reload keeps you signed in, and when the 15-minute access cookie expires the app refreshes it once. Sign out calls `/api/auth/logout`. The sidebar shows who signed in.
- Staff accounts see a "manager side not built yet" screen instead of the resident pages.
- **Still mock data:** rent, ledger, maintenance, notices, unit and address all come from `data/mockData.ts`. They switch over once the tenant API exists.
- Checked in a browser against Postgres:
  - A wrong password shows "That email and password do not match."
  - The tenant signs in; all five pages open with no errors.
  - Reload keeps the session; sign out works.
  - The manager gets the staff screen.

**Scott:** after `npm run build`, Express serves the app on :3000. The Origin check only accepts `WEB_ORIGIN`, which is `http://localhost:5173` by default. So in a production-style run, sign-in is refused unless `WEB_ORIGIN` matches the address in the browser. In dev, through Vite, it works.

## Everything together (branch `feature/full-integration`)

This is built on the two branches above. It joins Scott's skeleton, Angel's schema, Juan's tenant pages and Dael's Plaid link into one app. The rule was to adjust our code to theirs, and change theirs as little as possible.

**What a tenant can do now, all against the database:**
- See their name, unit and address from Angel's tables.
- See their balance and full ledger. The ledger is built from Angel's `Lease` and `Payment` rows (see "How the ledger works").
- Pay rent. This adds a `Payment` row with the payer, method and a confirmation number; the ledger and balance update.
- See and file maintenance requests, stored on their unit.
- See notices made from real records: rent due, payments received, repair updates.
- Link a bank account through Plaid Link, using Dael's two calls with his paths. With Plaid keys set, Pay rent asks for a linked account first and labels the payment with it.

**Checked:**
- 50 automated tests: 15 new for this branch, covering the tenant API and the Plaid routes with Plaid replaced by a stand-in.
- A browser run of the tenant pages against Postgres (10/10).

### Run it

As above (`db:up`, `.env`, `db:migrate`, `db:seed`), then:

1. Sign up the seeded tenant, either with Insomnia (`POST /api/auth/signup` `{"email":"tenant@example.com","password":"…"}`) or with curl.
2. `npm run dev`, open http://localhost:5173 and sign in.
3. For bank linking, put the sandbox `PLAID_CLIENT_ID` and `PLAID_SECRET` in `.env`; they're in the Discord keys channel, never in git. In Plaid Link's sandbox, use `user_good` / `pass_good`. Without the keys, payments are recorded as "Bank transfer (demo)".

### New API (Scott's grouping: `api/tenant/`)

| Route | Who | What |
|---|---|---|
| `GET /api/tenant/summary` | tenant | Everything Juan's pages show, in his types (`frontend/src/types`): tenant, balance, due dates, ledger, requests, notices, linked banks |
| `POST /api/tenant/payments` `{amount, bankAccountId?}` | tenant | Records a payment on their current lease |
| `POST /api/tenant/maintenance` `{title, description}` | tenant | Files a request on their unit |
| `POST /api/create_link_token` | tenant | Dael's route; the Plaid user is now the signed-in tenant |
| `POST /api/exchange_and_get_auth` `{public_token}` | tenant | Dael's route; saves the linked accounts |

Every route works from the signed-in tenant's own id. A tenant cannot reach another unit's lease, payments, requests or bank accounts; there are tests for that. Staff accounts get 403.

### How the ledger works on Angel's tables

`Lease.ammount_owed` is read as **monthly rent**:
- It is charged on move-in, then on the 1st of each month until `end_date`.
- Every `Payment` on the lease is a credit.
- The balance is charges minus payments, in exact cents.

This lives in one function (`src/services/ledger.ts`). If Angel adds a real ledger table, that function is what changes; the API and Juan's pages stay the same.

### What changed in teammates' code (kept small on purpose)

| Whose | What changed | Why |
|---|---|---|
| **Juan** | Each page reads `useTenantData()` instead of importing the mock arrays: 1–5 lines per page. New requests and payments call the API instead of a timer. Pay rent shows Dael's Connect button, and allows bank only. | Real data; client said bank transfers only. `mockData.ts` is untouched and still supplies the payment method options. |
| **Dael** | His two routes moved into the main app (`src/routes/plaid.ts`) with the same paths and calls (`src/services/plaid.ts`), plus sign-in. His Connect button is `frontend/src/components/PlaidLinkButton.tsx`. | One server. The Plaid user must be the real tenant. |
| **Dael** | Linked accounts are saved: Plaid ids, last 4 digits, and the access token **encrypted** (`src/utils/secrets.ts`). The response shows the routing number but only `••••` and the last 4 of the account number; the full number is not stored. | Client: name, email, phone only. The access token can pull the numbers later if a payment processor ever needs them. |
| **Angel** | Migration `003_tenant_portal.sql`, additions only: maintenance `title`, `description`, `created_at`; payment `tID`, `method`, `confirmation`; a `Bank_Accounts` table. | What Juan's pages and Dael's flow need. Everything has a default; 001/002 are unchanged. |
| **Scott** | Two routers mounted where his comment said (`// app.use("/api", createPlaidRouter())`), new error codes in his error map, and Plaid settings in `env.ts`. | Plugging in, not reworking. |

### Still to do

- **Moving money.** A payment is recorded, but no money moves. The next payments step is Plaid Transfer, or a processor using the saved Plaid link (Dael).
- ~~The manager side~~: done, see below.
- **Late fees** are not charged. The due notice uses the 5th, per the client.

---

## The manager side (branch `feature/manager-side`)

Staff now get a real workspace after signing in, ported from the manager screens in our resident-portal reference and cut down to what Angel's tables store. Same sign-in and session as the tenant side; Scott's RBAC decides what each role can do. No new permissions were added.

| Who | Sees | Can do |
|---|---|---|
| Property manager (`manager@example.com`) | Dashboard, Properties, Rent Roll, Tenants, lease pages, Maintenance, Updates | Everything below |
| Maintenance staff (`maintenance@example.com`) | Maintenance only | File requests, move them between New / In progress / Resolved |
| Tenant | the resident portal, as before | `/api/manager/*` returns 403 |

**Screens**
- **Dashboard**: portfolio counts, occupancy, rent collected vs. expected this month, outstanding, overdue accounts, open maintenance, recent activity, and the top items that need attention. A quick-actions bar (**+ New lease, + Add property, + Add unit, Record a payment, + Invite tenant, Maintenance request**) sits on the main screens.
- **Properties**: one card per building with occupancy and money owed; a property page lists its units.
- **Rent Roll**: every unit with residents, rent, balance and status (Owes rent / Paid up / Vacant), filters, search and totals.
- **Tenants**: everyone with a resident account, whether they have signed up yet, and their balance. Contact details can be corrected; the email stays the tenant's sign-in.
- **Lease page**: balance, rent, dates, residents and cosigners (add or remove, at least one stays), the full ledger, record an office payment (check, cash, money order, bank transfer), change rent, end the lease.
- **Maintenance**: the queue across all properties; status changes show up in the resident's portal.
- **Updates**: overdue rent, new requests and residents who have not signed up, worst first.

A new lease can add residents who are not in the system yet: they are created as invited tenants and sign up themselves with `POST /api/auth/signup`, exactly like the seeded tenant.

### Manager API

| Route | Permission | What |
|---|---|---|
| `GET /api/manager/me` | `maintenance:manage` | The signed-in staff member's name and role |
| `GET /api/manager/dashboard`, `properties`, `units?propertyId=`, `tenants`, `leases/:id`, `updates` | `ledger:read:property` | Reads |
| `POST/PUT /api/manager/properties[/:id]`, `units[/:id]` | `users:provision` | Portfolio. A unit number is unique within its property. |
| `POST /api/manager/tenants`, `PUT /api/manager/tenants/:id` | `users:provision` | Invite a tenant; fix name or phone |
| `POST /api/manager/leases` `{unitId, startDate, endDate?, monthlyRent, tenantIds, newTenants}` | `users:provision` | New lease on a vacant unit (409 `UNIT_OCCUPIED` otherwise) |
| `PUT /api/manager/leases/:id` `{monthlyRent?, endDate?}` | `users:provision` | Change rent or end the lease |
| `POST /api/manager/leases/:id/tenants`, `DELETE .../tenants/:tid` | `users:provision` | Add or remove a resident |
| `POST /api/manager/leases/:id/payments` `{amount, method, tenantId?}` | `ledger:adjust` | Office payment, confirmation `OFF-########` |
| `GET/POST /api/manager/maintenance`, `PUT /api/manager/maintenance/:id` `{status}` | `maintenance:manage` | The queue |

Every property manager sees every property, as the client asked on 9/28. Money stays in dollars, as in Angel's `NUMERIC` columns, and the ledger is the same `buildLedger` the tenant side uses, so both sides always show the same balance.

### Demo data (`npm run db:seed`)

Two properties (Woodcrest Apartments 101–112, Mesilla Court A1–A6), 14 leases with rent history since each move-in: most paid on time, some a month or two behind, one partial payment, one lease with two cosigners, one resident who has not signed up yet (Nora Brooks), and six maintenance requests in every status. `tenant@example.com` is on unit 101.

### What changed

| File | Change |
|---|---|
| `src/services/manager-store.ts`, `src/routes/manager.ts`, `src/types/manager.ts` | New: the manager API on Angel's tables |
| `src/db/seed.ts` | Richer demo data (above) and a maintenance login |
| `src/db/pool.ts` | A dropped idle database connection (Postgres restart, Reset Demo) no longer crashes the server |
| `src/create-app.ts`, `src/utils/init.ts`, `src/app.ts`, error maps | Mount the router; add `UNIT_OCCUPIED` (409) |
| `frontend/src/manager/*` | New: the manager screens, styles prefixed `mgr-` so Juan's CSS is untouched |
| `frontend/src/App.tsx` | Staff get `<ManagerApp>` instead of the placeholder |

**Checked:** 61 automated tests (11 new for the manager API, including role access), and a browser run of the manager side (18/18) and the tenant side against the same database.

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
