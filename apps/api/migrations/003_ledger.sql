-- ---------------------------------------------------------------------------
-- 003  The shared ledger.
--
-- One table. Append-only. Read identically by the resident and the manager.
--
-- There is deliberately no `balance` column anywhere in this schema. A balance
-- is the sum of these rows and nothing else, which means the number the resident
-- sees and the number the manager sees cannot drift apart, because there is only
-- one number and it is derived on demand from rows neither party can alter.
--
-- Sign convention, enforced by CHECK constraints below:
--   positive  increases what the resident owes
--   negative  decreases what the resident owes
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,

  entry_type        text NOT NULL CHECK (entry_type IN
                      ('charge','payment','credit','adjustment','reversal','annotation')),
  category          text NOT NULL,
  amount_cents      bigint NOT NULL,
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),

  -- The accounting period this row belongs to, e.g. the month a rent charge
  -- covers. Distinct from effective_date: a fee assessed in April for March rent
  -- is accounted to March and takes effect in April.
  period            text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  effective_date    date NOT NULL,
  posted_at         timestamptz NOT NULL DEFAULT now(),

  reverses_entry_id uuid REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  payment_id        uuid,
  work_order_id     uuid,
  payment_plan_id   uuid,
  dispute_id        uuid,

  -- Who caused this row to exist. NULL means the scheduled job runner, which is
  -- itself a meaningful statement: no person decided this, a configured policy did.
  actor_user_id     uuid REFERENCES users(id) ON DELETE RESTRICT,
  actor_role        text CHECK (actor_role IN ('tenant','staff','manager','owner','system_job')),
  -- Required on discretionary actions by the application layer and by the
  -- constraint below. A waiver with no stated reason is a spreadsheet edit that
  -- happens to live in a database.
  actor_reason      text CHECK (actor_reason IS NULL OR length(actor_reason) BETWEEN 4 AND 1000),

  -- Every write carries one. Re-running the charge scheduler for a period, or a
  -- resident double-tapping Pay on a bad connection, produces one row.
  idempotency_key   text NOT NULL UNIQUE,

  -- Sign rules, per entry type.
  CONSTRAINT ledger_charge_is_positive
    CHECK (entry_type <> 'charge' OR amount_cents > 0),
  CONSTRAINT ledger_payment_is_negative
    CHECK (entry_type <> 'payment' OR amount_cents < 0),
  CONSTRAINT ledger_credit_is_negative
    CHECK (entry_type <> 'credit' OR amount_cents < 0),
  CONSTRAINT ledger_adjustment_is_nonzero
    CHECK (entry_type <> 'adjustment' OR amount_cents <> 0),
  -- An annotation carries no money. It exists so that a decision — a plan
  -- opened, an escalation paused — appears in the same stream of rows the
  -- resident already reads, with an actor and a reason attached.
  CONSTRAINT ledger_annotation_is_zero
    CHECK (entry_type <> 'annotation' OR amount_cents = 0),
  CONSTRAINT ledger_reversal_points_at_something
    CHECK (entry_type <> 'reversal' OR (reverses_entry_id IS NOT NULL AND amount_cents <> 0)),
  CONSTRAINT ledger_only_reversals_reverse
    CHECK (reverses_entry_id IS NULL OR entry_type = 'reversal')
);

COMMENT ON TABLE ledger_entries IS
  'Append-only. Never UPDATE, never DELETE. A correction is a new row of type reversal that points at the row being corrected. Enforced by trigger (below) and by REVOKE in 008_rls.sql.';

-- ---------------------------------------------------------------------------
-- Append-only enforcement.
-- ---------------------------------------------------------------------------

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- TRUNCATE bypasses row triggers entirely, so it needs its own statement-level
-- guard. Without this, the append-only property has a one-word hole in it.
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Reversal integrity.
--
-- A reversal must exactly undo its target and may only do so once. Both rules
-- live in the database because both are properties a resident is entitled to
-- rely on when reading their own history months later.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.validate_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target ledger_entries%ROWTYPE;
BEGIN
  IF NEW.reverses_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO target FROM ledger_entries WHERE id = NEW.reverses_entry_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversal target % does not exist', NEW.reverses_entry_id
      USING ERRCODE = '23503';
  END IF;

  IF target.tenancy_id <> NEW.tenancy_id THEN
    RAISE EXCEPTION 'a reversal must belong to the same tenancy as the row it reverses'
      USING ERRCODE = '23514';
  END IF;

  IF target.entry_type = 'reversal' THEN
    RAISE EXCEPTION 'a reversal cannot itself be reversed; append a fresh entry instead'
      USING ERRCODE = '23514';
  END IF;

  -- Partial reversals are legitimate — waiving half a fee is a real thing a
  -- manager does — but they may never exceed the original, and the running total
  -- of reversals against one row may never exceed it either.
  IF sign(NEW.amount_cents) = sign(target.amount_cents) THEN
    RAISE EXCEPTION 'a reversal must oppose the sign of the row it reverses'
      USING ERRCODE = '23514';
  END IF;

  IF abs(NEW.amount_cents) > abs(target.amount_cents) THEN
    RAISE EXCEPTION 'a reversal (%) cannot exceed the row it reverses (%)',
      NEW.amount_cents, target.amount_cents
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT COALESCE(sum(abs(amount_cents)), 0)
    FROM ledger_entries
    WHERE reverses_entry_id = NEW.reverses_entry_id
  ) + abs(NEW.amount_cents) > abs(target.amount_cents) THEN
    RAISE EXCEPTION 'reversals against entry % would exceed its original amount',
      NEW.reverses_entry_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_validate_reversal
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.validate_reversal();

-- ---------------------------------------------------------------------------
-- Discretion must be explained.
--
-- Any row written by a person that reduces what a resident owes, or that
-- corrects the record, carries a stated reason. This is the database half of
-- the design position that discretion should be legible rather than invisible.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.require_reason_for_discretion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_role IN ('manager','staff','owner')
     AND NEW.entry_type IN ('reversal','adjustment','credit','annotation')
     AND (NEW.actor_reason IS NULL OR length(trim(NEW.actor_reason)) < 4) THEN
    RAISE EXCEPTION
      'a % written by a % requires a stated reason', NEW.entry_type, NEW.actor_role
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_require_reason
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.require_reason_for_discretion();

-- ---------------------------------------------------------------------------
-- Indexes. The access patterns are: one resident's whole history, one
-- property's activity in one period, and reversal lookups.
-- ---------------------------------------------------------------------------

CREATE INDEX ledger_tenancy_effective_idx
  ON ledger_entries (tenancy_id, effective_date, posted_at);
CREATE INDEX ledger_property_period_idx
  ON ledger_entries (property_id, period);
CREATE INDEX ledger_tenancy_period_idx
  ON ledger_entries (tenancy_id, period);
CREATE INDEX ledger_reverses_idx
  ON ledger_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX ledger_payment_idx
  ON ledger_entries (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX ledger_work_order_idx
  ON ledger_entries (work_order_id) WHERE work_order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The audit log covers everything that is not a ledger row: logins, permission
-- grants, policy changes, exports. Also append-only, for the same reason.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id     uuid REFERENCES properties(id) ON DELETE RESTRICT,
  actor_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  actor_role      text,
  action          text NOT NULL,
  subject_type    text,
  subject_id      uuid,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address      inet,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE INDEX audit_log_subject_idx ON audit_log (subject_type, subject_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_property_idx ON audit_log (property_id, occurred_at DESC);
