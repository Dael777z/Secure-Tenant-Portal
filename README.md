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

The hosted site is public: the portal's own login is the only gate. Give it a
login with `npm run cloudflare:prod db admin ...`, or sample data with
`npm run cloudflare:prod db seed` (see "Production data").

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
