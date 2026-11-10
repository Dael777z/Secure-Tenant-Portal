# Secure Tenant Portal

React (Vite) + Express 5 + TypeScript + PostgreSQL resident portal for Summit
Property Management (NMSU CSCI 4980 senior project).

## Running it

You need Node 22+ and Docker (Docker Desktop on Windows/macOS). Then `npm install` once.

|             | this machine      | containers            | Cloudflare Tunnel         |
|-------------|-------------------|-----------------------|---------------------------|
| development | `npm run dev`     | `npm run docker:dev`  | `npm run cloudflare:dev`  |
| production  | `npm run prod`    | `npm run docker:prod` | `npm run cloudflare:prod` |

- **`npm run dev`**: the everyday one. The database runs in a container; the API
  (`tsx watch`) and the page (Vite) run here with hot reload. Open http://localhost:5173.
- **`npm run prod`**: the production build, run here against the development
  database (migrated, never seeded), to check it before shipping. http://localhost:8080.
- **`npm run docker:dev` / `docker:prod`**: everything in containers, built from the
  `Dockerfile`. Development is at http://localhost:3000 with the sample data;
  production at http://localhost:8080 with its own database, which starts empty
  (see "Production data" below).
- **`npm run cloudflare:dev` / `cloudflare:prod`**: the same stacks, published at your
  Cloudflare hostname through a tunnel (see below).

Development and production are separate stacks (`portal-dev`, `portal-prod`) with
separate databases, so both can run at once. Every development flow shares the
one development database.

Container and tunnel targets also take an action:

```
npm run docker:prod logs        follow the app's logs
npm run docker:prod status      list the containers
npm run docker:prod db <task>   a database task inside the stack (see below)
npm run docker:prod down        stop it   (npm run docker:prod down -- --volumes also deletes its database)
```

Sign in to development data as `manager@example.com` / `manager-demo-password`
(property manager), `maintenance@example.com` / `manager-demo-password` (maintenance
staff: the maintenance queue only), or `tenant@example.com` / `tenant-demo-password`.
`npm run dev empty` starts a new development database with no sample data (add a
login with `npm run db admin`; `--maintenance` makes it a maintenance staff login).

## Three roles

| Role | Admin.role / table | Can |
|---|---|---|
| Property manager | `admin` | Everything on the manager side |
| Maintenance staff | `maintenance_staff` (003) | The maintenance queue: read, file, change status. No leases, money or bank accounts, in the API and in the database's RLS |
| Tenant | Tenants table | Their own lease, ledger, payments, requests and bank links |

On a lease, **Add a charge** adds a late fee, deposit, utility bill, proration or
other charge (rent is billed automatically). On Tenants, **Reset sign-in** gives a
signed-up tenant a link to choose a new password; their old password and sessions
stop working. A tenant's payment carries a key per checkout, so a double click or a
retry is recorded once.

## Database tasks

```
npm run db status                       applied and pending migrations, whether there is data
npm run db migrate                      apply pending migrations
npm run db admin you@example.com "Name" add a staff login (asks for its password)
npm run db seed                         load the sample data (does nothing if staff exist)
npm run db setup                        migrate + seed (every dev flow runs this first)
npm run db reset                        wipe, migrate, seed
npm run db email-test you@example.com   send one of each notification email (see Email)
```

These act on the development database. Add `clean` (`npm run db reset clean`) for a
small clean-start dataset, or `empty` (`npm run db reset empty`) for none at all.
For a container stack: `npm run docker:prod db <task>`.

### Production data

A production database only gets data you add on purpose:

- `npm run docker:prod db admin you@example.com "Your Name"` adds the first staff
  login (the password is asked for, never typed on the command line). Everything
  else is then added in the manager pages, and tenants join from their invite links.
- `npm run docker:prod db seed` loads the sample data, for a synthetic demo, after
  you type `yes`.
- `npm run docker:prod db reset empty` deletes everything and leaves an empty,
  migrated database (also after `yes`). Without `empty` it loads the sample data too.

The same tasks work with `cloudflare:prod`. Starting or updating a production stack
only ever migrates.

## Tests

`npm test` runs everything, including the integration tests on the development
Postgres (each test file gets a fresh database of its own and drops it afterwards).
`npm run test:unit` needs no database.

## Settings

Development needs none. `.env` is optional; `.env.example` lists what you can change
(Plaid sandbox keys, ports, the Cloudflare settings for `cloudflare:dev`).

Production reads `.env.prod`, which the first production run creates with random
database passwords and secrets. Keep it private: if it is lost, so are the
database passwords. Both files are git-ignored. Everything that is not
per-machine (token lifetimes, rate limits, the time zone) is a constant in
`src/config.ts`.

## Cloudflare

The tunnel publishes a stack at your hostname without opening any ports.

1. In the Cloudflare dashboard (Zero Trust > Networks > Tunnels), create a tunnel
   and copy its token.
2. Add a public hostname for it (for example `portal.example.com`) with the service
   `http://app:3000`. The same tunnel works for either stack.
3. Put the token and the address in the settings file (`.env.prod` for production,
   `.env` for development):

   ```
   CLOUDFLARE_TUNNEL_TOKEN=...
   WEB_ORIGIN=https://portal.example.com
   ```

4. `npm run cloudflare:prod` (or `cloudflare:dev`). The app is also still on
   localhost. `npm run docker:prod` takes the tunnel down again and keeps the app.

   `cloudflare:dev` needs `JWT_ACCESS_SECRET` (32+ random characters) in `.env`, and
   `TOKEN_ENCRYPTION_KEY` too if Plaid is on: development mode otherwise signs sessions
   with a secret that is public in the source code, so the app refuses to start on a
   public address without them. It also skips the sample data there (its demo passwords
   are public); add a login with `db admin`.

The hosted site is public: the portal's own login is the only gate. Give it a
login with `npm run cloudflare:prod db admin ...`, or sample data with
`npm run cloudflare:prod db seed` (see "Production data").

## Plaid

Bank linking turns on when `PLAID_CLIENT_ID` and `PLAID_SECRET` are set (in `.env`, or
`.env.prod` for production). `PLAID_ENV` is `sandbox` unless set to `production`.

No redirect address is needed to test in a browser: when a bank signs in on its own
website, Link opens it in a pop-up. A redirect address only matters inside a mobile
app's embedded browser. To turn it on, have whoever runs the Plaid dashboard add the
addresses below to its allowed redirect URIs, then set `PLAID_REDIRECT_URI=/plaid-oauth`
(joined to each target's address). Until they are added, leave it unset: Plaid refuses
to create a link session that names an address it has not allowed.

| Run | Redirect URI |
| --- | --- |
| `npm run dev` | `http://localhost:5173/plaid-oauth` |
| `npm run docker:dev` | `http://localhost:3000/plaid-oauth` |
| `npm run prod`, `npm run docker:prod` | `http://localhost:8080/plaid-oauth` |
| `cloudflare:dev`, `cloudflare:prod` | `https://<your hostname>/plaid-oauth` |

Plain `http://` works only for localhost and only in sandbox. A full address in
`PLAID_REDIRECT_URI` is used as given.

To test in sandbox, sign in as a tenant, open Pay rent, choose **Connect bank account**,
pick any bank and sign in with `user_good` / `pass_good` (code `1234` if asked). When a
Plaid call fails, the server logs `plaid.request.failed` with Plaid's error type, code,
message and request id, and the page shows Plaid's code.

## Cards, Apple Pay and Google Pay (Stripe)

Tenants can pay by **Credit/Debit Card** (Stripe's card form) or **Apple Pay / Google Pay**
(the device's own button, shown only where it works) when `STRIPE_SECRET_KEY` and
`STRIPE_PUBLISHABLE_KEY` are set (`.env`, or `.env.prod`). Test keys (`sk_test_`/`pk_test_`)
move no money. The card is typed into Stripe's frame or picked in the wallet sheet; its
number never reaches this server. The browser sends a ConfirmationToken, the server reads
which card it is and charges it at once, so the payment is usually on the ledger before the
page updates. The ledger names it like `Visa •••• 4242` or `Apple Pay (Visa •••• 4242)`;
`Stripe_Payments` keeps the brand, last four digits, debit/credit and wallet.

- **The usual rules apply**: at least the full balance, at most three months of rent ahead,
  and not while a Cash App / Zelle report waits for the office (`AMOUNT_BELOW_BALANCE`,
  `AMOUNT_ABOVE_LIMIT`, `ALREADY_REPORTED`, as for bank payments). Nothing reaches Stripe then.
- A declined card answers `402 CARD_DECLINED` with Stripe's message, and nothing is recorded.
- A bank check (3-D Secure) shows in Stripe's own window; the payment completes after it.
  Until Stripe confirms, the payment is `pending` and not on the balance.
- **Card fee passed on.** Every card, Apple Pay and Google Pay payment adds Stripe's 2.9% +
  30¢. Because Stripe takes its cut from the whole amount charged, the fee is grossed up so
  the office still receives the full rent ($950 rent → $28.69 fee → $978.69 charged). The pay
  page shows it before paying; when the payment completes, the fee is its own
  `processing_fee` charge ("Card processing fee") and the payment is the whole amount, so
  the balance drops by exactly the rent. It is `CARD_FEE` in `src/services/fees.ts` (null
  would mean no fee). Visa and Mastercard rules forbid surcharging debit and prepaid cards,
  and credit-card surcharges need registering with the networks and are banned in some
  states: check before going live. International cards cost a further 1.5%, which the flat
  rate does not cover. Bank transfers, Cash App and Zelle have no fee.
- **Apple Pay** needs your domain registered in Stripe (Settings → Payment method domains)
  and HTTPS; **Google Pay** needs HTTPS. On `http://localhost` they do not appear; use the
  Cloudflare tunnel (`npm run cloudflare:dev`) to try them on a phone.

A refund made in Stripe's dashboard comes back through the webhook as a `refund` row. Every
webhook event handled is kept in `Stripe_Events`. A payment's status only moves forward
(pending → completed or failed), and the database enforces it.

**Webhook.** In the dashboard, add an endpoint `https://<your site>/api/stripe/webhook` with
the events `payment_intent.succeeded`, `payment_intent.processing`,
`payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded` and
`charge.refund.updated`, and put its signing secret in `STRIPE_WEBHOOK_SECRET` (required in
production). In development, the [Stripe CLI](https://docs.stripe.com/stripe-cli) forwards
events and prints the secret to use:

```
stripe listen --forward-to localhost:3000/api/stripe/webhook --events payment_intent.succeeded,payment_intent.processing,payment_intent.payment_failed,payment_intent.canceled,charge.refunded,charge.refund.updated
```

Test cards (test keys only): `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` is
declined, `4000 0027 6000 3184` asks for a bank check. Any future expiry, any CVC and ZIP.

## Email (Resend)

Email notifications turn on when `RESEND_API_KEY` and `EMAIL_FROM` are set (in `.env`, or
`.env.prod`). `EMAIL_FROM` must be on a domain verified in Resend, e.g.
`Summit Property <notifications@your-domain.com>`. Without them nothing is sent, and notices
stay in the resident portal.

Who gets what follows the choices the portal already keeps: each tenant's (Settings →
Notifications) and the office's (manager Settings → Notifications: where to send, and which
topics). Office emails go to the office's notification address, or, when that is empty, to
every property manager's sign-in email.

| Who | When | Turned off by |
| --- | --- | --- |
| Tenant | a rent reminder (the office's reminder rules, Payment Rules); sent from 8:00 local time | Rent due reminders |
| Tenant | a payment is received | Payment receipts |
| Tenant | the office sends a notice with **email** ticked (Communications → Notices) | Messages from the office |
| Tenant | the office sends a message | Messages from the office |
| Tenant | a maintenance request moves to a new stage | Maintenance updates |
| Office | a tenant sends a message | A tenant sends a message |
| Office | a tenant files a maintenance request | A tenant submits a maintenance request |
| Office | a tenant reports a Cash App or Zelle payment to confirm | A tenant reports a Cash App or Zelle payment |
| Office | rent is late: one summary a day, from 8:00 | Rent becomes late |
| Office | a lease ends within 90 days (once per lease; skipped if the unit's next lease exists) | (always) |

A notice's email is a `Notifications_Sent` row of its own (channel `email`, `email_of` = the
in-app notice), so the Notices page shows each one as sent, failed (with Resend's reason),
waiting, or not sent (turned off, or too old: an email that could not go out within two days
is skipped rather than sent late). The queue is checked every minute. Message emails say
there is a message and link to the portal; the text itself is never emailed. A burst of
messages sends one email, until the other side opens the conversation. The office's daily
emails are recorded in `Scheduled_Emails_Sent`, so each goes out once.

To see every email in a real inbox, send one of each (sample details, subjects start
with `[Test]`; no database needed):

```
npm run db email-test you@example.com
```

With `EMAIL_FROM` on `onboarding@resend.dev` (before you verify a domain), Resend only
delivers to the address your Resend account is registered with.

## Logs

One JSON line per event, on the console (and in `LOG_FILE` when set). Every line written
while handling a request carries that request's `request_id`, also sent back as the
`x-request-id` header, so one id finds everything a click did. Lines carry ids and
amounts, never emails, names, passwords or tokens.

A flow step logs `<event>.succeeded` (info) or `<event>.failed`, which is a warning with the
app's error `code` when the app refused, and an error with the cause when something broke.
Both have `durationMs`. Office changes add `by`, the staff member (`admin:3`).

| Event | Metadata |
| --- | --- |
| `request.completed` | method, path (no query string), statusCode, error code, durationMs |
| `auth.login.succeeded` / `.failed` | userId, role / reason (`unknown email`, `wrong password`, `mfa required`) |
| `auth.signup.*`, `auth.refresh.*`, `auth.logout` | userId |
| `auth.token.rejected`, `auth.forbidden` | reason / userId, role, permission, path |
| `payment.tenant.*` | userId, amount, method, leaseId, confirmation |
| `payment.office.*`, `payment.reversed.*`, `payment.receipt_attached.*` | by, leaseId, amount, paymentId, confirmation |
| `office.lease.create.*` / `.update.*` / `.add_tenant.*` / `.remove_tenant.*` | by, leaseId, unitId, tenantIds, invited |
| `office.tenant.invite.*` / `.reinvite.*` / `.update.*` / `.deactivate.*` | by, tenantId, changed fields |
| `office.property.*`, `office.unit.*` (create, update, deactivate) | by, propertyId / unitId |
| `maintenance.create.*` / `.status.*` / `.deactivate.*` | userId or by, requestId, status |
| `plaid.request.succeeded` / `.failed` | operation, env, Plaid's requestId, itemId, account counts / Plaid's code and message |
| `plaid.accounts_saved.*` | userId, itemId, linked, total |
| `payment.card.start.*` | userId, amount, leaseId, paymentIntentId, fee, wallet, status |
| `payment.stripe.settled`, `payment.stripe.refunded`, `payment.stripe.amount_mismatch` | paymentIntentId, leaseId, amount, from/to / refundId / problem |
| `stripe.webhook.*` | eventId, type, paymentIntentId |
| `stripe.request.succeeded` / `.failed`, `stripe.card.declined` | operation, mode (test/live), Stripe's code, requestId |
| `notify.*` (`tenant_message`, `office_message`, `maintenance`, `maintenance_update`, `reported_payment`, `notices`, `office_daily`) | tenantId / requestId, queued, sent, failed |
| `email.failed`, `email.retry` | noticeId or key (e.g. `late_rent:2026-11-06`) / Resend's status, attempt |
| `rent.charges.*` | today, added |

To follow one request in Docker: `docker compose logs app | grep <request id>`.

## Layout

```
db/migrations/        001 = the database dev's schema (verbatim), 002 = what the app adds
src/config.ts         every setting
src/cli.ts            database tasks (npm run db ...)
src/app.ts            the server: check the database, listen, keep rent charges current
src/container.ts      builds the real dependencies
src/create-app.ts     the Express app, from its dependencies
src/routes/           HTTP: validate input, call one service method, send JSON
src/services/         business rules (Manager, Tenant, Auth, RentCharges)
src/types/stores.ts   the database contract, one interface per area
src/db/postgres-db.ts all the app's SQL; implements the contract
src/db/identity.ts    who is asking (admin / tenant / system), for row-level security
src/db/migrate.ts     migration runner and startup check
src/db/seed/data.ts   the sample data (edit this one)
frontend/             the React app
scripts/portal.mjs    the npm flows above
compose.yaml          the containers (compose.dev.yaml: development overrides)
local/                git-ignored notes and docs that stay on your machine
```

A request goes **route -> service -> store interface -> Postgres**. The signed-in
user's identity is set on each database transaction, and Postgres row-level
security filters every table by it; the app signs in as `summit_app`, never as the
owner (it refuses to start otherwise).

## Changing things

- **Sample data**: edit `src/db/seed/data.ts`, then `npm run db reset`.
- **The schema**: add the next file in `db/migrations` (`003_something.sql`), then
  `npm run db migrate`. Never edit an applied file (`migrate` refuses, and the server
  will not start with a pending migration). 001 is the database dev's file.
- **A query**: add the method to its interface in `src/types/stores.ts`, and
  implement it in `src/db/postgres-db.ts` with `this.query(...)` or `this.tx(...)`. Alias each
  column to the record's field name (`l.start_date AS "startDate"`) and the rows come back as records.
- **A route**: a service method, then one line in `src/routes/<area>.ts`
  (`router.get("/x", ...can("permission"), async (req, res) => { res.json(await service.x()) })`).
  Errors: `throw new AppError("CODE")`; codes and HTTP statuses are in `src/types/errors.ts`.

## How it behaves

- Nothing is hard-deleted. `DELETE` routes deactivate a record or, for a payment,
  add a matching refund. Leases are ended, not deleted.
- Tenants are invited. The office adds them (on a lease or from Tenants) and sends
  the sign-up link from Tenants > Copy sign-up link; the tenant only chooses a password.
- Online rent payment comes from a Plaid-linked bank account. In development without
  Plaid keys it records a test transfer; production has no such fallback.
