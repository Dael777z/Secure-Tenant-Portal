-- ---------------------------------------------------------------------------
-- 008  Grants.
--
-- RLS decides which rows a role reaches. Grants decide which *verbs* it has at
-- all. The two are independent, and the append-only guarantee wants both: RLS
-- has no UPDATE policy on the ledger, the trigger in 003 raises on UPDATE, and
-- the REVOKE below means the application role does not hold the privilege in the
-- first place. Three mechanisms, no single point of failure.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO portal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO portal_app;

-- The ledger: insert and read, nothing else, ever.
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM portal_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM portal_app;
REVOKE UPDATE, DELETE, TRUNCATE ON work_order_events FROM portal_app;

-- Structural tables are managed by migrations and an administrator, not by the
-- running application. A bug in a request handler should not be able to rename a
-- property or delete a unit.
REVOKE INSERT, UPDATE, DELETE ON organizations FROM portal_app;
REVOKE INSERT, UPDATE, DELETE ON properties FROM portal_app;
REVOKE INSERT, UPDATE, DELETE ON units FROM portal_app;
REVOKE DELETE ON users FROM portal_app;
REVOKE DELETE ON tenancies FROM portal_app;
REVOKE DELETE ON payments FROM portal_app;
REVOKE DELETE ON payment_plans FROM portal_app;
REVOKE DELETE ON charge_disputes FROM portal_app;
REVOKE DELETE ON work_orders FROM portal_app;

-- Webhook receipts and job bookkeeping carry no resident data and are written on
-- every provider callback, so they stay outside RLS and keep full grants.
GRANT SELECT, INSERT, UPDATE ON webhook_events TO portal_app;
GRANT SELECT, INSERT, UPDATE ON job_runs TO portal_app;

-- Anything a later migration adds is reachable by default; a new table that
-- needs narrower grants states so in its own migration, next to the table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO portal_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO portal_app;
