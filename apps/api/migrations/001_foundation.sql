-- ---------------------------------------------------------------------------
-- 001  Foundation: schemas, database roles, and the request-context helpers
--      that every Row-Level Security policy in this system binds against.
--
-- The security posture of this deployment rests on one decision made here: the
-- application connects as `portal_app`, a role that is not a superuser and does
-- not have BYPASSRLS. A forgotten WHERE clause in application code therefore
-- returns an empty set rather than another resident's rent record. Application
-- filters remain in place as the first line; the database is the last one, and
-- it is placed where a developer mistake cannot reach past it.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;
COMMENT ON SCHEMA app IS
  'Request-context helpers and guard triggers. Contains no business data.';

-- ---------------------------------------------------------------------------
-- Request context.
--
-- The API sets these three settings with SET LOCAL at the start of every
-- transaction, so they live and die with that transaction and cannot leak
-- between pooled connections. `true` in current_setting() means "missing is
-- null, not an error", which is what makes an unauthenticated connection see
-- nothing rather than fail loudly and confusingly.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_role_name() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), 'none');
$$;

CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid;
$$;

-- A deliberate escape hatch for the scheduled job runner, which posts charges
-- and accrues fees on behalf of no one. It is a distinct, named context rather
-- than "connect as superuser", so that every row a job writes still records that
-- a job wrote it, and so that turning it on is visible in a code review.
CREATE OR REPLACE FUNCTION app.is_system_job() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.role', true) = 'system_job';
$$;

-- ---------------------------------------------------------------------------
-- Guard triggers.
-- ---------------------------------------------------------------------------

-- The append-only guarantee. Attached to the ledger and to the audit log. This
-- is belt and suspenders with the REVOKE in 008: the REVOKE stops the
-- application role, and this stops everyone, including a migration written in a
-- hurry at 2am and including the table owner.
CREATE OR REPLACE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; % is not permitted. Correct a row by appending a reversal.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Database roles.
--
-- portal_owner owns every object and runs migrations.
-- portal_app is what the API connects as, all day, for every request.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_app') THEN
    CREATE ROLE portal_app LOGIN;
  END IF;
END
$$;

-- Stated explicitly rather than relied on as a default, because this single
-- property is what the entire isolation argument rests on.
ALTER ROLE portal_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;

GRANT USAGE ON SCHEMA app TO portal_app;
GRANT USAGE ON SCHEMA public TO portal_app;
