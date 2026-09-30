-- ---------------------------------------------------------------------------
-- 006  Recurring charges, late-fee policy, and the notification pipeline.
-- ---------------------------------------------------------------------------

CREATE TABLE recurring_charges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  category          text NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  description       text NOT NULL,
  day_of_month      smallint NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 31),
  starts_on         date NOT NULL,
  ends_on           date,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX recurring_charges_tenancy_idx ON recurring_charges (tenancy_id) WHERE active;
CREATE INDEX recurring_charges_property_idx ON recurring_charges (property_id) WHERE active;

-- ---------------------------------------------------------------------------
-- Late-fee policy.
--
-- Disabled by default, deliberately. Automated escalation is a policy a manager
-- configures with their eyes open, not a behaviour the software brings with it.
-- The row records who last changed it, because "the system did it automatically"
-- is not an answer a resident can do anything with.
-- ---------------------------------------------------------------------------

CREATE TABLE late_fee_policies (
  property_id       uuid PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  enabled           boolean NOT NULL DEFAULT false,
  grace_days        smallint NOT NULL DEFAULT 5 CHECK (grace_days BETWEEN 0 AND 30),
  fee_type          text NOT NULL DEFAULT 'flat' CHECK (fee_type IN ('flat','percent')),
  flat_cents        bigint NOT NULL DEFAULT 0 CHECK (flat_cents >= 0),
  percent           numeric(5,2) NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 25),
  -- Optional per-day accrual on top of the one-time fee, capped by max_cents.
  daily_cents       bigint NOT NULL DEFAULT 0 CHECK (daily_cents >= 0),
  max_cents         bigint NOT NULL DEFAULT 0 CHECK (max_cents >= 0),
  -- Balances under this threshold never draw a fee. A $3 utility rounding
  -- difference should not cost someone $50.
  min_balance_cents bigint NOT NULL DEFAULT 0 CHECK (min_balance_cents >= 0),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at        timestamptz
);

-- ---------------------------------------------------------------------------
-- Notifications.
--
-- Two tables: what happened, and each attempt to tell somebody about it. The
-- split is what makes exactly-once delivery testable — an event is recorded once
-- under a key derived from what happened, and a delivery is unique per
-- (event, channel, recipient), so a replayed webhook or a re-run job cannot send
-- a resident four copies of the same late notice.
-- ---------------------------------------------------------------------------

CREATE TABLE notification_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id       uuid REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id        uuid REFERENCES tenancies(id) ON DELETE RESTRICT,
  event_type        text NOT NULL,
  -- Derived from the facts of the event, never from a timestamp or a random id.
  dedupe_key        text NOT NULL UNIQUE,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_events_tenancy_idx
  ON notification_events (tenancy_id, occurred_at DESC);

CREATE TABLE notification_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id       uuid REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id        uuid REFERENCES tenancies(id) ON DELETE RESTRICT,
  audience          text NOT NULL CHECK (audience IN ('resident','manager','staff')),
  channel           text NOT NULL CHECK (channel IN ('email','sms')),
  recipient         text NOT NULL,
  subject           text NOT NULL,
  body              text NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts          smallint NOT NULL DEFAULT 0,
  last_error        text,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, channel, recipient)
);

CREATE INDEX notification_deliveries_pending_idx
  ON notification_deliveries (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX notification_deliveries_tenancy_idx
  ON notification_deliveries (tenancy_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Job runs. The scheduler records what it did and when, so that a charge that
-- did not post is a question with an answer rather than a mystery.
-- ---------------------------------------------------------------------------

CREATE TABLE job_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name          text NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  status            text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error')),
  items_processed   integer NOT NULL DEFAULT 0,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  error             text
);

CREATE INDEX job_runs_name_idx ON job_runs (job_name, started_at DESC);
