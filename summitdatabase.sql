/* ============================================================
   Summit Resident Portal — the whole database in one file

   First-time setup (run once, on an empty database):
     createdb summit
     psql -d summit -v ON_ERROR_STOP=1 -f summit_schema.sql

   The whole file runs as one transaction. If anything fails, you're
   left with an empty database. To start over: dropdb summit && createdb summit, then run it again.

   Three parts:
     1. tables       — what we store
     2. protections  — rules the database enforces on its own
     3. RLS          — who gets to see which rows

   Needs PostgreSQL 15+ (the lease_balance view uses a newer feature).

   ============================================================ */
BEGIN;

-- btree_gist lets us stop two leases on the same unit from overlapping.
-- Without it, the EXCLUDE constraint on Lease can't mix equality (uID) with a range overlap test.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- citext makes emails case-insensitive. "janedoe@gmail.com" and "JaneDoe@gmail.com" are the same login, which is what people expect.
CREATE EXTENSION IF NOT EXISTS citext;


---------------------------------------------------------------------
-- PART 1: TABLES
---------------------------------------------------------------------

/* A building, or a single-family house. Nothing fancy here; it's
   really just a name and address that units hang off of. */
CREATE TABLE Property (
    pID      SERIAL PRIMARY KEY,        -- internal id, never shown to users
    Name     VARCHAR(255) NOT NULL,     -- "Maple Court", "12 Oak St"
    Address  TEXT NOT NULL              -- full mailing address, free text
);

/* One rentable place. A single-family house is just a property with
   one unit.

   Deleting a property cascades to its units, but a unit with any
   history refuses to go — the Foreign Keys on those tables use RESTRICT. So in practice this cascade only ever
   cleans up a property that was entered by mistake and never used.
   To retire a unit for real, set deactivated_at. */
CREATE TABLE Units (
    uID             SERIAL PRIMARY KEY,        -- internal id
    pID             INT NOT NULL               -- which property this belongs to
                    REFERENCES Property(pID) ON DELETE CASCADE,
    UnitNum         VARCHAR(20) NOT NULL,      -- "1A", "202", "B" — whatever the building uses
    deactivated_at  TIMESTAMPTZ,               -- set when the unit is retired; null means active
    UNIQUE (pID, UnitNum)                      -- no two units with the same number in one property
);

/* A tenant. An admin adds them first (name, email, phone), then the
   tenant finishes signing up themselves via an invite link. That's
   why password_hash stays null until signup_completed flips to true.

   Don't hard-delete tenants. Set deactivated_at so their lease and
   payment history stays intact. The Lease_Tenants FK uses RESTRICT,
   so the database will refuse anyway. */
CREATE TABLE Tenants (
    tID                      SERIAL PRIMARY KEY,
    Name                     VARCHAR(255) NOT NULL,
    Phone                    VARCHAR(40),         -- free text; app validates format
    Email                    CITEXT NOT NULL,     -- login identifier
    password_hash            TEXT,                -- null until signup is complete

    /* We store a hash of the invite token, not the token itself. If
       the DB ever leaks, nobody can sign up with a stolen link. The
       check enforces a SHA-256 hex digest (64 chars, lowercase hex). */
    signup_token_hash        VARCHAR(64) UNIQUE
                             CHECK (signup_token_hash IS NULL
                                    OR signup_token_hash ~ '^[0-9a-f]{64}$'),
    signup_token_expires_at  TIMESTAMPTZ,         -- when the invite link stops working
    signup_completed         BOOLEAN NOT NULL DEFAULT false,
    deactivated_at           TIMESTAMPTZ,         -- soft delete; null means active
    public_id                UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,  -- shown in URLs
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* signup_completed and password_hash have to agree. Either you're
       mid-signup (no password yet), or you're done (password set).
       There's no state where signup is finished but there's no
       password, and no state where it isn't finished but there is one. */
    CONSTRAINT signup_password_consistency CHECK (
        (signup_completed = false AND password_hash IS NULL)
        OR
        (signup_completed = true  AND password_hash IS NOT NULL)
    ),

    -- Cheap sanity check. The app does the real validation; this just
    -- stops obvious garbage from landing.
    CONSTRAINT tenants_email_format CHECK (Email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

/* One lease agreement on one unit.

   end_date is the last day of the lease (that day still counts). Null
   means it's open-ended.

   The exclusion constraint stops two leases on the same unit from
   overlapping in time. The range is inclusive on both ends ('[]'), so
   a lease ending 2025-06-30 and another starting 2025-07-01 don't
   collide, but two leases both covering 2025-06-30 do.

   monthly_rent is the rent as written into the lease. Actual money
   charged over the life of the lease lives in Charge, because rent
   can change mid-lease or be prorated, and fees are separate rows. */
CREATE TABLE Lease (
    LeaseID       SERIAL PRIMARY KEY,
    uID           INT NOT NULL                    -- which unit
                  REFERENCES Units(uID) ON DELETE RESTRICT,
    start_date    DATE NOT NULL,                  -- first day the lease is in effect
    end_date      DATE,                           -- last day, inclusive; null means open-ended
    monthly_rent  NUMERIC(10,2) NOT NULL          -- rent as signed
                  CHECK (monthly_rent > 0),       -- can't sign a $0 lease
    public_id     UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date IS NULL OR end_date >= start_date),
    CONSTRAINT no_overlapping_leases EXCLUDE USING gist (
        uID WITH =,                               -- same unit
        daterange(start_date, COALESCE(end_date, 'infinity'::date), '[]') WITH &&
    )
);

/* Who's on which lease. A lease can have several people on it
   (roommates, co-signers), and a person can be on several leases over
   time. That's why this is its own table instead of a column on Lease.

   Rows here disappear if the lease is deleted. A tenant who's ever
   been on a lease can't be hard-deleted — the RESTRICT below stops
   it — so the lease keeps a record of who signed it. Deactivate
   tenants instead. */
CREATE TABLE Lease_Tenants (
    LeaseID  INT NOT NULL                         -- which lease
             REFERENCES Lease(LeaseID) ON DELETE CASCADE,
    tID      INT NOT NULL                         -- which tenant signed it
             REFERENCES Tenants(tID) ON DELETE RESTRICT,
    PRIMARY KEY (LeaseID, tID)                    -- a tenant appears once per lease
);

/* What we've charged to a lease: monthly rent runs, deposits, late
   fees, prorations, utilities, whatever.

   This is the debit side of the ledger. Payment is the credit side.
   Together they make the balance (see lease_balance).

   Unlike Payment, a Charge can be edited. Admins sometimes fat-finger
   an amount, and forcing them to correct-by-insert for something that
   never touched a payment processor is annoying. Every change is
   captured in audit_log, so nothing is lost. */
CREATE TABLE Charge (
    chargeID     SERIAL PRIMARY KEY,
    LeaseID      INT NOT NULL                     -- which lease this is owed on
                 REFERENCES Lease(LeaseID) ON DELETE RESTRICT,
    kind         VARCHAR(20) NOT NULL             -- what kind of charge this is
                 CHECK (kind IN ('rent','deposit','late_fee','utility','proration','other')),
    amount       NUMERIC(10,2) NOT NULL           -- how much, always positive; direction is implicit
                 CHECK (amount > 0),
    due_date     DATE NOT NULL,                   -- when it's due; drives overdue reports
    description  TEXT,                            -- free text for the statement line
    public_id    UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* The credit side: money actually in (or back out).

   Payments are append-only. Nothing here gets deleted or rewritten; if
   something's wrong, add a correcting row. Part 2 enforces this with
   triggers and the grant list below.

   direction says whether this is money in ('charge') or money back out
   ('refund'). Refunds are their own rows — flipping the original
   payment's status would erase the record of what actually came in,
   and you can't represent a partial refund that way.

   Everything is USD. If Summit ever rents in another currency, we'll
   add a currency column per lease and enforce it here. */
CREATE TABLE Payment (
    payID            SERIAL PRIMARY KEY,
    LeaseID          INT NOT NULL                 -- which lease this applies to
                     REFERENCES Lease(LeaseID) ON DELETE RESTRICT,
    direction        VARCHAR(10) NOT NULL DEFAULT 'charge'  -- 'charge' = money in, 'refund' = money back
                     CHECK (direction IN ('charge','refund')),
    amount           NUMERIC(10,2) NOT NULL       -- always positive; direction says which way
                     CHECK (amount > 0),
    status           VARCHAR(20) NOT NULL DEFAULT 'pending' -- where the processor is on this
                     CHECK (status IN ('pending','completed','failed')),
    transaction_id   VARCHAR(255) NOT NULL UNIQUE, -- the processor's id (Stripe pi_..., etc.)
    idempotency_key  VARCHAR(255) UNIQUE,          -- stops the same charge from being recorded twice
    "timestamp"      TIMESTAMPTZ NOT NULL DEFAULT now(),    -- quoted because it's a keyword
    public_id        UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE
);

/* A maintenance request. Belongs to the unit, not the lease, so it
   sticks around when tenants change and the repair history stays with
   the unit.

   A unit with tickets can't be deleted (the RESTRICT below stops it),
   so repair history is safe.

   If the reporter is ever removed, the ticket stays and tID goes null.
   In practice a tenant who's been on a lease can't be deleted at all,
   so this mostly guards against future changes. */
CREATE TABLE Maintenance_T (
    mID          SERIAL PRIMARY KEY,
    uID          INT NOT NULL                     -- which unit needs work
                 REFERENCES Units(uID) ON DELETE RESTRICT,
    tID          INT                              -- who reported it; null if that account is gone
                 REFERENCES Tenants(tID) ON DELETE SET NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'submitted'
                 CHECK (status IN ('submitted','in_progress','resolved')),
    description  TEXT NOT NULL,                   -- what's wrong, in the tenant's words
    public_id    UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* Staff accounts. Everyone here has full access for now. The role
   column is there so we can add narrower roles later (say
   'maintenance_staff') by widening the check.

   One row per person. Don't share admin logins — the audit log, MFA,
   and revocation all depend on knowing which human did what. */
CREATE TABLE Admin (
    admin_id              SERIAL PRIMARY KEY,
    name                  VARCHAR(255) NOT NULL,
    email                 CITEXT NOT NULL,        -- login identifier
    password_hash         TEXT NOT NULL,          -- always set; admins are created with a password
    role                  VARCHAR(20) NOT NULL DEFAULT 'admin'
                          CHECK (role IN ('admin')),   -- widen this when we add roles
    mfa_secret_encrypted  TEXT,                   -- app encrypts before storing; never plain
    mfa_enabled           BOOLEAN NOT NULL DEFAULT false,
    deactivated_at        TIMESTAMPTZ,            -- soft delete; null means active
    CONSTRAINT admin_email_format CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

/* Indexes. Ordinary lookups, plus two partial ones for the queries we
   actually run all day: open tickets and pending payments. */
CREATE INDEX idx_units_pid         ON Units(pID);           -- units of a property
CREATE INDEX idx_lease_uid         ON Lease(uID);           -- leases on a unit
CREATE INDEX idx_lease_tenants_tid ON Lease_Tenants(tID);   -- leases a tenant is on
CREATE INDEX idx_charge_leaseid    ON Charge(LeaseID);      -- charges on a lease
CREATE INDEX idx_payment_leaseid   ON Payment(LeaseID);     -- payments on a lease
CREATE INDEX idx_payment_time      ON Payment("timestamp"); -- recent activity
CREATE INDEX idx_maint_uid         ON Maintenance_T(uID);   -- tickets on a unit
CREATE INDEX idx_maint_tid         ON Maintenance_T(tID);   -- tickets a tenant filed

-- Partial indexes: smaller, and they only cover the rows we care about.
CREATE INDEX idx_maint_open        ON Maintenance_T(uID) WHERE status <> 'resolved';
CREATE INDEX idx_payment_pending   ON Payment(LeaseID)   WHERE status = 'pending';

/* Only active accounts need a unique email. A deactivated tenant's
   address should be reusable later, and the login lookup filters out
   deactivated rows anyway, so there's no ambiguity. */
CREATE UNIQUE INDEX tenants_active_email ON Tenants (Email) WHERE deactivated_at IS NULL;
CREATE UNIQUE INDEX admin_active_email   ON Admin (email)   WHERE deactivated_at IS NULL;


---------------------------------------------------------------
-- PART 2: PROTECTIONS
-- Rules the database enforces on its own, so even a bug in the
-- app can't break them.
---------------------------------------------------------------

/* Keeps updated_at honest. Fires on every UPDATE and stamps now().
   Putting this in a trigger instead of relying on the app means a
   forgotten "SET updated_at = now()" can't happen. */
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();       -- overwrite whatever the caller sent
    RETURN NEW;                    -- BEFORE trigger: return the modified row
END $$;

-- Attach to every table with an updated_at column.
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON Tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_lease_updated BEFORE UPDATE ON Lease
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_charge_updated BEFORE UPDATE ON Charge
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_maint_updated BEFORE UPDATE ON Maintenance_T
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* An email belongs to exactly one human, tenant or admin.

   Within a table, the partial unique indexes above handle it. Across
   tables there's no constraint that can do this, so we check with a
   trigger. Two concurrent inserts of the same email in different
   tables could slip through — for a single-company portal with a
   handful of admins, that's acceptable. If it ever isn't, replace
   this with a shared email-identity table. */
CREATE FUNCTION email_not_in_other_table() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- TG_TABLE_NAME tells us which table fired this. If it's a tenant
    -- insert, check Admin. If it's an admin insert, check Tenants.
    IF TG_TABLE_NAME = 'tenants' THEN
        IF EXISTS (SELECT 1 FROM Admin WHERE email = NEW.Email) THEN
            RAISE EXCEPTION 'Email % already belongs to an admin account', NEW.Email
                USING ERRCODE = 'unique_violation';
        END IF;
    ELSIF TG_TABLE_NAME = 'admin' THEN
        IF EXISTS (SELECT 1 FROM Tenants WHERE Email = NEW.email) THEN
            RAISE EXCEPTION 'Email % already belongs to a tenant account', NEW.email
                USING ERRCODE = 'unique_violation';
        END IF;
    END IF;
    RETURN NEW;                    -- BEFORE trigger, so we return the row to insert
END $$;

CREATE TRIGGER trg_tenants_email_unique
    BEFORE INSERT OR UPDATE OF Email ON Tenants
    FOR EACH ROW EXECUTE FUNCTION email_not_in_other_table();
CREATE TRIGGER trg_admin_email_unique
    BEFORE INSERT OR UPDATE OF email ON Admin
    FOR EACH ROW EXECUTE FUNCTION email_not_in_other_table();

/* A deactivated unit shouldn't get a new lease. Once it's retired,
   it stays retired unless someone clears deactivated_at on purpose. */
CREATE FUNCTION block_lease_on_deactivated_unit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM Units
               WHERE uID = NEW.uID AND deactivated_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Unit % is deactivated; can''t create a lease on it', NEW.uID
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_lease_unit_active
    BEFORE INSERT OR UPDATE OF uID ON Lease
    FOR EACH ROW EXECUTE FUNCTION block_lease_on_deactivated_unit();

/* The payment ledger. Nothing gets deleted, nothing gets rewritten
   except status. Everything else is frozen at insert.

   Which status transitions are allowed (completed → failed on a
   returned ACH, say) is the app's call. If we ever need a new status,
   widen the check on Payment.status. */

-- Shared by the append-only tables. It just says no. The ERRCODE is
-- an integrity violation so the app can catch it specifically if it
-- wants to.
CREATE FUNCTION forbid_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER trg_payment_no_delete BEFORE DELETE ON Payment
    FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER trg_payment_no_truncate BEFORE TRUNCATE ON Payment
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

/* Status can change. Everything else can't. The tuple comparison is
   shorthand for "any of these columns differ"; if any one differs,
   the whole thing is not distinct-from equal, so the IS DISTINCT FROM
   returns true and we raise. */
CREATE FUNCTION payment_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.payID, NEW.LeaseID, NEW.direction, NEW.amount, NEW.transaction_id,
        NEW.idempotency_key, NEW."timestamp", NEW.public_id)
       IS DISTINCT FROM
       (OLD.payID, OLD.LeaseID, OLD.direction, OLD.amount, OLD.transaction_id,
        OLD.idempotency_key, OLD."timestamp", OLD.public_id)
    THEN
        RAISE EXCEPTION 'Payment rows are immutable except for status; insert a correcting row instead'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;                    -- status change passes through
END $$;

CREATE TRIGGER trg_payment_guard_update BEFORE UPDATE ON Payment
    FOR EACH ROW EXECUTE FUNCTION payment_guard_update();

/* One thing we deliberately don't enforce: that a lease has at least
   one tenant. The app creates the Lease and its Lease_Tenants rows
   together in one transaction, so the invariant holds in practice.
   A deferred constraint could do it, but it complicates every lease
   insert and this isn't where bugs usually come from. */

/* Balance per lease.

     total_charged   = sum of all Charge rows
     total_paid      = completed 'charge' payments
     total_refunded  = completed 'refund' payments
     balance         = charged - paid + refunded

   Positive balance means the tenant owes. Negative means they're
   ahead (deposit, prepayment, etc.).

   security_invoker means whoever queries the view only sees rows
   they're allowed to see. Without it, the view would run as its owner
   and leak every lease to every tenant. */
CREATE VIEW lease_balance WITH (security_invoker = true) AS
WITH charge_totals AS (
    -- Everything billed to this lease, regardless of kind.
    SELECT LeaseID, SUM(amount) AS total_charged
    FROM Charge
    GROUP BY LeaseID
),
payment_totals AS (
    -- Split completed payments into money-in and money-back.
    SELECT LeaseID,
           SUM(CASE WHEN direction = 'charge' THEN amount ELSE 0 END) AS total_paid,
           SUM(CASE WHEN direction = 'refund' THEN amount ELSE 0 END) AS total_refunded
    FROM Payment
    WHERE status = 'completed'     -- pending/failed don't move the balance
    GROUP BY LeaseID
)
SELECT
    l.LeaseID,
    l.uID,
    COALESCE(c.total_charged, 0)::NUMERIC(10,2)  AS total_charged,
    COALESCE(p.total_paid, 0)::NUMERIC(10,2)     AS total_paid,
    COALESCE(p.total_refunded, 0)::NUMERIC(10,2) AS total_refunded,
    (COALESCE(c.total_charged, 0)
     - COALESCE(p.total_paid, 0)
     + COALESCE(p.total_refunded, 0))::NUMERIC(10,2) AS balance
FROM Lease l
-- Left joins so a lease with no charges or no payments still shows up
-- with a zero balance instead of disappearing.
LEFT JOIN charge_totals  c ON c.LeaseID = l.LeaseID
LEFT JOIN payment_totals p ON p.LeaseID = l.LeaseID;

/* Audit log: who changed what, when. Nobody can edit or delete
   entries. Password hashes, MFA secrets and signup tokens are
   stripped before anything is written (see audit_row_change below). */
CREATE TABLE audit_log (
    auditID     BIGSERIAL PRIMARY KEY,
    table_name  TEXT NOT NULL,                    -- which table the change was on
    row_pk      TEXT NOT NULL,                    -- the changed row's PK, colon-joined if composite
    action      TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
    old_data    JSONB,                            -- row before the change; null for INSERT
    new_data    JSONB,                            -- row after the change; null for DELETE
    changed_by  TEXT,                             -- "admin:3" or "tenant:42" or the DB user
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_row  ON audit_log(table_name, row_pk);   -- "show me everything about this lease"
CREATE INDEX idx_audit_time ON audit_log(changed_at);           -- "what happened last week"

-- Make the log truly append-only. Same forbid_modification function
-- as Payment uses.
CREATE TRIGGER trg_audit_no_change BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

/* Called by the triggers below. TG_ARGV holds the PK column names
   (lowercase) so each entry says which row it was about.

   changed_by comes from the identity the backend sets per request
   (app.user_type / app.user_id). If there's no identity — a
   migration, say — it falls back to the DB user.

   SECURITY DEFINER so the function can write to audit_log even though
   summit_app has no grants on it directly. */
CREATE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    -- Column names whose values never belong in the log.
    secret_keys TEXT[] := ARRAY['password_hash', 'mfa_secret_encrypted', 'signup_token_hash'];
    old_j JSONB;
    new_j JSONB;
    src   JSONB;
    pk    TEXT := '';
    k     TEXT;
BEGIN
    -- Snapshot the old row for UPDATE/DELETE, minus secrets.
    IF TG_OP IN ('UPDATE', 'DELETE') THEN old_j := to_jsonb(OLD) - secret_keys; END IF;
    -- Snapshot the new row for INSERT/UPDATE, minus secrets.
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_j := to_jsonb(NEW) - secret_keys; END IF;

    -- Use whichever side exists to extract the PK values.
    src := COALESCE(new_j, old_j);

    -- Build "value1:value2" from the PK column names we were told
    -- about via TG_ARGV.
    FOREACH k IN ARRAY TG_ARGV LOOP
        pk := pk || CASE WHEN pk = '' THEN '' ELSE ':' END || COALESCE(src ->> k, '');
    END LOOP;

    INSERT INTO audit_log (table_name, row_pk, action, old_data, new_data, changed_by)
    VALUES (
        TG_TABLE_NAME, pk, TG_OP, old_j, new_j,
        -- Prefer the request identity; fall back to the DB user if
        -- nobody set one (migrations, manual fixes, etc.).
        COALESCE(
            NULLIF(concat_ws(':',
                NULLIF(current_setting('app.user_type', true), ''),
                NULLIF(current_setting('app.user_id',   true), '')), ''),
            session_user::TEXT)
    );
    RETURN NULL;                  -- AFTER trigger: return value is ignored
END $$;

-- One trigger per audited table. The arguments are the PK column
-- name(s) in lowercase; composite keys pass several.
CREATE TRIGGER trg_audit_payment AFTER INSERT OR UPDATE OR DELETE ON Payment
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('payid');
CREATE TRIGGER trg_audit_charge AFTER INSERT OR UPDATE OR DELETE ON Charge
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('chargeid');
CREATE TRIGGER trg_audit_lease AFTER INSERT OR UPDATE OR DELETE ON Lease
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('leaseid');
CREATE TRIGGER trg_audit_lease_tenants AFTER INSERT OR UPDATE OR DELETE ON Lease_Tenants
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('leaseid', 'tid');
CREATE TRIGGER trg_audit_tenants AFTER INSERT OR UPDATE OR DELETE ON Tenants
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('tid');
CREATE TRIGGER trg_audit_admin AFTER INSERT OR UPDATE OR DELETE ON Admin
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('admin_id');
CREATE TRIGGER trg_audit_maint AFTER INSERT OR UPDATE OR DELETE ON Maintenance_T
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('mid');

/* Ticket status changes, timestamped, so we can see how long
   repairs take. Fills itself in. */
CREATE TABLE Maintenance_Status_History (
    histID      BIGSERIAL PRIMARY KEY,
    mID         INT NOT NULL REFERENCES Maintenance_T(mID) ON DELETE CASCADE,
    old_status  VARCHAR(20),                      -- null for a ticket's first entry
    new_status  VARCHAR(20) NOT NULL,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_msh_mid ON Maintenance_Status_History(mID, changed_at);

CREATE FUNCTION log_maintenance_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- New ticket: record the initial status with no previous value.
        INSERT INTO Maintenance_Status_History (mID, old_status, new_status)
        VALUES (NEW.mID, NULL, NEW.status);
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        -- Only log when the status actually changed, not on every
        -- UPDATE (editing the description shouldn't add a row).
        INSERT INTO Maintenance_Status_History (mID, old_status, new_status)
        VALUES (NEW.mID, OLD.status, NEW.status);
    END IF;
    RETURN NULL;
END $$;

-- The "OF status" clause means this only fires when status is part of
-- the UPDATE, which saves work on description-only edits.
CREATE TRIGGER trg_maint_status_hist AFTER INSERT OR UPDATE OF status ON Maintenance_T
    FOR EACH ROW EXECUTE FUNCTION log_maintenance_status();

/* The app's DB login.

   The backend connects as summit_app, never as the table owner and
   never as a superuser. It can only do what's listed below. Set the
   password outside the repo:
     ALTER ROLE summit_app LOGIN PASSWORD '...';

   Nothing can be deleted except Lease_Tenants rows. Everything else
   is deactivated or corrected-by-insert. */
DO $$
BEGIN
    -- Create the role if it doesn't already exist. NOLOGIN here; you
    -- enable login separately with a password.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'summit_app') THEN
        CREATE ROLE summit_app NOLOGIN;
    END IF;
END $$;

-- Nobody gets to create objects in the public schema by default.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO summit_app;

-- Table-level grants. Notice Payment is INSERT-only plus a column-level
-- UPDATE on status; the trigger enforces the same rule, but the grant
-- stops it before the trigger even has to fire.
GRANT SELECT, INSERT, UPDATE ON Property        TO summit_app;
GRANT SELECT, INSERT, UPDATE ON Units           TO summit_app;
GRANT SELECT, INSERT, UPDATE ON Tenants         TO summit_app;
GRANT SELECT, INSERT, UPDATE ON Lease           TO summit_app;
GRANT SELECT, INSERT, DELETE ON Lease_Tenants   TO summit_app;
GRANT SELECT, INSERT, UPDATE ON Charge          TO summit_app;
GRANT SELECT, INSERT         ON Payment         TO summit_app;
GRANT UPDATE (status)        ON Payment         TO summit_app;   -- status is the only editable column
GRANT SELECT, INSERT, UPDATE ON Maintenance_T   TO summit_app;
GRANT SELECT, INSERT, UPDATE ON Admin           TO summit_app;
GRANT SELECT                 ON Maintenance_Status_History TO summit_app;
GRANT SELECT                 ON lease_balance   TO summit_app;
-- audit_log gets no grants at all. The triggers write to it as
-- SECURITY DEFINER. Admins read it through read_audit_log() below.

-- Sequences (for the SERIAL columns) need USAGE to draw nextval from.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO summit_app;


--------------------------------------------------------------------
-- PART 3: ROW-LEVEL SECURITY (who gets to see which rows)
--
-- A tenant only ever sees their own stuff, and the database makes
-- sure of it, even if a query forgets its WHERE clause.
--
-- How the DB knows who's asking: after checking the JWT, the backend
-- runs these three lines at the start of each request's transaction
-- (the true makes them last for that transaction only):
--
--   SELECT set_config('app.user_type', 'tenant', true);
--   SELECT set_config('app.user_id',   '42',     true);
--   SELECT set_config('app.user_role', 'admin',  true);
--
-- app.user_type is 'tenant', 'admin' or 'system'. app.user_id is the
-- tID or admin_id ('' for system). app.user_role is Admin.role.
--
-- 'system' is for work with no logged-in human, like a Stripe webhook
-- marking a payment completed.
--
-- Things to keep in mind:
--   * These rules apply to summit_app. The table owner skips them, so
--     never connect the app as the owner.
--   * If a tenant tries to touch something they can't, they get
--     "0 rows affected", not an error. If no identity is set at all,
--     every query comes back empty.
--   * RLS works on rows, not columns, so tenants get no write access
--     to their own Tenants row. Changes go through the app or an
--     admin.
--   * RLS protects against a forgotten WHERE clause or a bug in the
--     app's permission checks. It does NOT protect against full SQL
--     injection (the app's login can set its own identity), so keep
--     using parameterized queries.
-- ############################################################

/* Helpers the policies use. They just read whatever identity the
   backend set for this request. */

-- 'tenant', 'admin', 'system', or null if nothing was set.
CREATE FUNCTION app_user_type() RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_type', true), '')
$$;

-- The logged-in tenant's id, or null if the caller isn't a tenant.
CREATE FUNCTION app_tenant_id() RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN NULLIF(current_setting('app.user_type', true), '') = 'tenant'
                THEN NULLIF(current_setting('app.user_id', true), '')::INT
           END
$$;

/* Admin access needs both the type and the role, so a narrower role
   added later (maintenance_staff) won't get full access by accident. */
CREATE FUNCTION app_is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        NULLIF(current_setting('app.user_type', true), '') = 'admin'
        AND current_setting('app.user_role', true) = 'admin',
        false)
$$;

/* Is this tenant on a lease for this unit today? Runs as whoever is
   asking, so the rules on Lease and Lease_Tenants still apply. If a
   tenant can't see a lease, this returns false rather than leaking
   its existence. */
CREATE FUNCTION tenant_has_active_lease_on(p_unit INT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM Lease l
        JOIN Lease_Tenants lt ON lt.LeaseID = l.LeaseID
        WHERE l.uID = p_unit
          AND lt.tID = app_tenant_id()
          AND l.start_date <= CURRENT_DATE
          AND (l.end_date IS NULL OR l.end_date >= CURRENT_DATE)
    )
$$;

/* Turn RLS on everywhere. A table with RLS and no matching policy
   is locked. */
ALTER TABLE Property                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE Units                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE Tenants                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE Lease                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE Lease_Tenants               ENABLE ROW LEVEL SECURITY;
ALTER TABLE Charge                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE Payment                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE Maintenance_T               ENABLE ROW LEVEL SECURITY;
ALTER TABLE Admin                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE Maintenance_Status_History  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log                   ENABLE ROW LEVEL SECURITY;   -- no policy, so nothing gets in

/* Admins get full access to everything. The grants above still
   apply, so no deleting payments, and the payment trigger still
   protects the ledger.

   The (SELECT ...) wrappers around app_is_admin() aren't strictly
   necessary but make the function get evaluated once per query
   instead of once per row, which matters on big tables. */
CREATE POLICY admin_all ON Property      FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Units         FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Tenants       FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Lease         FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Lease_Tenants FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Charge        FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Payment       FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Maintenance_T FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Admin         FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_read ON Maintenance_Status_History FOR SELECT TO summit_app USING ((SELECT app_is_admin()));

/* 'system' (webhooks, background jobs) works with payments and
   nothing else.

   This is also how a tenant-initiated payment gets recorded: the
   backend checks in code that the tenant belongs to the lease, then
   writes the row as 'system'. Tenants themselves never write to the
   ledger. */
CREATE POLICY system_payment ON Payment FOR ALL TO summit_app
    USING      ((SELECT app_user_type()) = 'system')   -- for reads/updates/deletes
    WITH CHECK ((SELECT app_user_type()) = 'system');  -- for inserts/updates

/* Tenants can read their own stuff. The only thing they can create
   is a maintenance ticket. */

-- Their own account row.
CREATE POLICY tenant_self ON Tenants FOR SELECT TO summit_app
    USING (tID = (SELECT app_tenant_id()));

-- Their own spot on a lease (they can't see roommates' rows).
CREATE POLICY tenant_own_rows ON Lease_Tenants FOR SELECT TO summit_app
    USING (tID = (SELECT app_tenant_id()));

-- Leases they're on, or used to be on.
CREATE POLICY tenant_own_leases ON Lease FOR SELECT TO summit_app
    USING (LeaseID IN (SELECT LeaseID FROM Lease_Tenants WHERE tID = (SELECT app_tenant_id())));

-- The units and properties those leases belong to.
CREATE POLICY tenant_own_units ON Units FOR SELECT TO summit_app
    USING (EXISTS (
        SELECT 1 FROM Lease l JOIN Lease_Tenants lt ON lt.LeaseID = l.LeaseID
        WHERE l.uID = Units.uID AND lt.tID = (SELECT app_tenant_id())));

CREATE POLICY tenant_own_property ON Property FOR SELECT TO summit_app
    USING (EXISTS (
        SELECT 1 FROM Units u
        JOIN Lease l ON l.uID = u.uID
        JOIN Lease_Tenants lt ON lt.LeaseID = l.LeaseID
        WHERE u.pID = Property.pID AND lt.tID = (SELECT app_tenant_id())));

-- Charges and payments on their leases. Roommates share these.
CREATE POLICY tenant_read_charges ON Charge FOR SELECT TO summit_app
    USING (LeaseID IN (SELECT LeaseID FROM Lease_Tenants WHERE tID = (SELECT app_tenant_id())));

CREATE POLICY tenant_read_payments ON Payment FOR SELECT TO summit_app
    USING (LeaseID IN (SELECT LeaseID FROM Lease_Tenants WHERE tID = (SELECT app_tenant_id())));

/* Tickets on units they're leasing right now. Roommates see each
   other's tickets; someone who moved out doesn't see the next
   tenant's. */
CREATE POLICY tenant_read_tickets ON Maintenance_T FOR SELECT TO summit_app
    USING (tenant_has_active_lease_on(uID));

/* Tenants file tickets as themselves, for the unit they live in now.
   The status check stops them from inserting a ticket that's already
   "resolved", which would skip the workflow. */
CREATE POLICY tenant_file_ticket ON Maintenance_T FOR INSERT TO summit_app
    WITH CHECK (
        tID = (SELECT app_tenant_id())
        AND status = 'submitted'
        AND tenant_has_active_lease_on(uID));

/* A ticket's history is visible whenever the ticket itself is. This
   works because the subquery on Maintenance_T is itself subject to
   the tenant_read_tickets policy above. */
CREATE POLICY tenant_read_history ON Maintenance_Status_History FOR SELECT TO summit_app
    USING (EXISTS (SELECT 1 FROM Maintenance_T m WHERE m.mID = Maintenance_Status_History.mID));

/* Login and signup helpers.

   When someone logs in or signs up, nobody has an identity yet, so
   these steps can't go through the normal rules. These functions are
   the only way around them, and each does exactly one small thing.

   They're SECURITY DEFINER, meaning they run as their owner (the
   migration role). The search_path is pinned to public, pg_temp so
   nobody can shadow a table with a temp object and hijack the
   function's privileges. */

/* Login lookup by email, across tenants and admins. Deactivated
   accounts are filtered out here so the caller never has to think
   about them. If an email was reused after deactivation, only the
   active row comes back. */
CREATE FUNCTION auth_lookup_user(p_email CITEXT)
RETURNS TABLE (user_type TEXT, user_id INT, password_hash TEXT, signup_completed BOOLEAN,
               role TEXT, mfa_enabled BOOLEAN, mfa_secret_encrypted TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT 'tenant'::TEXT, t.tID, t.password_hash, t.signup_completed,
           NULL::TEXT, false, NULL::TEXT
    FROM Tenants t
    WHERE t.Email = p_email
      AND t.deactivated_at IS NULL
    UNION ALL
    SELECT 'admin'::TEXT, a.admin_id, a.password_hash, true,
           a.role::TEXT, a.mfa_enabled, a.mfa_secret_encrypted
    FROM Admin a
    WHERE a.email = p_email
      AND a.deactivated_at IS NULL
$$;

/* Signup: the tenant opens their invite link and picks a password.
   The app hashes the token from the URL before calling this — we
   never see the raw token. Returns the tenant ID, or nothing if the
   hash doesn't match an open invite.

   The WHERE clause is doing a lot of work here: the token must match,
   signup must not already be done, the tenant must be active, and the
   invite must not be expired. Any of those failing means zero rows
   updated and the function returns null. */
CREATE FUNCTION auth_complete_signup(p_token_hash TEXT, p_password_hash TEXT) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_tid INT;
BEGIN
    UPDATE Tenants
       SET password_hash = p_password_hash,
           signup_completed = true,
           signup_token_hash = NULL,             -- single use
           signup_token_expires_at = NULL
     WHERE signup_token_hash = p_token_hash
       AND signup_completed = false
       AND deactivated_at IS NULL
       AND (signup_token_expires_at IS NULL OR signup_token_expires_at > now())
    RETURNING Tenants.tID INTO v_tid;            -- null if no row matched
    RETURN v_tid;
END $$;

/* Lets a logged-in tenant change their own password. Admins can
   already update their own row through the admin_all policy. */
CREATE FUNCTION auth_set_password(p_new_hash TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    UPDATE Tenants
       SET password_hash = p_new_hash
     WHERE tID = app_tenant_id()                 -- only ever the caller's own row
       AND signup_completed = true               -- can't skip signup this way
       AND deactivated_at IS NULL;
    RETURN FOUND;                                -- true if one row updated
END $$;

/* Admins read the audit log through here. Direct SELECT isn't
   granted, and there's no RLS policy on audit_log, so this function
   (running as its owner) is the only way in. It refuses to return
   anything if the caller isn't an admin — the app_is_admin() check
   in the WHERE clause makes the whole thing return zero rows. */
CREATE FUNCTION read_audit_log(
    p_table  TEXT        DEFAULT NULL,           -- filter to one table, or null for all
    p_row_pk TEXT        DEFAULT NULL,           -- filter to one row's PK
    p_since  TIMESTAMPTZ DEFAULT NULL,           -- only entries at or after this time
    p_limit  INT         DEFAULT 500             -- cap the result size
) RETURNS SETOF audit_log
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT *
    FROM audit_log
    WHERE app_is_admin()
      AND (p_table  IS NULL OR table_name = p_table)
      AND (p_row_pk IS NULL OR row_pk     = p_row_pk)
      AND (p_since  IS NULL OR changed_at >= p_since)
    ORDER BY changed_at DESC                     -- newest first
    LIMIT COALESCE(p_limit, 500)
$$;

-- Lock the helper functions down to summit_app only. PUBLIC gets no
-- access, which means a random connection can't call them.
REVOKE ALL ON FUNCTION auth_lookup_user(CITEXT)             FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_complete_signup(TEXT, TEXT)     FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_set_password(TEXT)              FROM PUBLIC;
REVOKE ALL ON FUNCTION read_audit_log(TEXT, TEXT, TIMESTAMPTZ, INT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_lookup_user(CITEXT)             TO summit_app;
GRANT EXECUTE ON FUNCTION auth_complete_signup(TEXT, TEXT)     TO summit_app;
GRANT EXECUTE ON FUNCTION auth_set_password(TEXT)              TO summit_app;
GRANT EXECUTE ON FUNCTION read_audit_log(TEXT, TEXT, TIMESTAMPTZ, INT) TO summit_app;

/* Catalog documentation. These don't affect behavior; they show up
   in psql's \d+ and in any tool that reads pg_description. Worth
   keeping current reading. */
COMMENT ON TABLE  Tenants         IS 'Resident accounts. Soft-deleted via deactivated_at; never hard-deleted once on a lease.';
COMMENT ON COLUMN Tenants.signup_token_hash IS 'SHA-256 hex of the invite token. Raw token only ever exists in the email link.';
COMMENT ON TABLE  Charge          IS 'Debit side of the ledger: rent, fees, deposits. Editable; audit_log captures changes.';
COMMENT ON TABLE  Payment         IS 'Credit side of the ledger: money in and refunds out. Append-only except for status.';
COMMENT ON COLUMN Payment.direction IS '''charge'' = money in, ''refund'' = money back out. Refunds are their own rows.';
COMMENT ON TABLE  audit_log       IS 'Permanent change log. Written by SECURITY DEFINER triggers. Read via read_audit_log().';
COMMENT ON VIEW   lease_balance   IS 'Per-lease balance = charges - completed charges + completed refunds. Positive means owed.';

COMMIT;