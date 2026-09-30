-- ---------------------------------------------------------------------------
-- 004  Payment methods, payments, autopay, and payment plans.
--
-- The organizing idea: "paid" is a state with a tail. A card decision arrives in
-- seconds; an ACH debit settles in days and can be returned days after that. The
-- schema therefore records a payment's whole life, including the part that
-- happens after the resident has been told the money went through.
-- ---------------------------------------------------------------------------

CREATE TABLE payment_methods (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  kind              text NOT NULL CHECK (kind IN ('ach','card')),
  -- What the provider gave us in exchange for the sensitive part. No PAN and no
  -- full account number is ever stored, or ever reaches this server: the
  -- browser exchanges them with the provider directly. That is what keeps a
  -- self-hosted operator at SAQ-A rather than in full PCI scope.
  provider          text NOT NULL,
  provider_token    text NOT NULL,
  institution       text,
  last4             text CHECK (last4 IS NULL OR last4 ~ '^\d{4}$'),
  brand             text,
  exp_month         smallint CHECK (exp_month IS NULL OR exp_month BETWEEN 1 AND 12),
  exp_year          smallint CHECK (exp_year IS NULL OR exp_year BETWEEN 2000 AND 2100),
  verified          boolean NOT NULL DEFAULT false,
  verified_at       timestamptz,
  removed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_token)
);

CREATE INDEX payment_methods_tenancy_idx
  ON payment_methods (tenancy_id) WHERE removed_at IS NULL;

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id          uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  payment_method_id   uuid REFERENCES payment_methods(id) ON DELETE RESTRICT,

  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  method              text NOT NULL CHECK (method IN ('ach','card','check','cash','money_order')),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','settled','failed','returned','refunded','disputed')),

  provider            text NOT NULL DEFAULT 'manual',
  provider_reference  text,
  method_label        text,
  receipt_number      text UNIQUE,

  failure_code        text,
  failure_message     text,

  -- Supplied by the client on submission. Two requests carrying the same key
  -- produce one payment, which is the difference between a flaky connection and
  -- a double-drafted rent payment on an account running close to the line.
  idempotency_key     text NOT NULL UNIQUE,

  initiated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  initiated_by_role   text,
  -- True when a manager recorded a payment the resident made outside the portal.
  recorded_by_manager boolean NOT NULL DEFAULT false,

  submitted_at        timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz,
  resolved_at         timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payments_failure_fields_agree
    CHECK ((status IN ('failed','returned')) = (failure_code IS NOT NULL))
);

CREATE INDEX payments_tenancy_idx ON payments (tenancy_id, submitted_at DESC);
CREATE INDEX payments_property_status_idx ON payments (property_id, status);
CREATE INDEX payments_provider_ref_idx ON payments (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
-- Used by the exception queue, which asks "what is unresolved right now" on
-- every dashboard load.
CREATE INDEX payments_open_idx ON payments (property_id, updated_at DESC)
  WHERE status IN ('pending','processing','failed','returned','disputed');

CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The payment state machine, enforced in the database. The application also
-- checks it, in shared/payments.ts, which the client imports — but a transition
-- that slips past both application layers still cannot corrupt the record.
CREATE OR REPLACE FUNCTION app.validate_payment_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'pending'    THEN ARRAY['processing','failed']
    WHEN 'processing' THEN ARRAY['settled','failed']
    -- A return or a chargeback arrives after the money was already credited.
    WHEN 'settled'    THEN ARRAY['returned','refunded','disputed']
    WHEN 'disputed'   THEN ARRAY['settled','refunded']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'illegal payment transition % -> % on payment %',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.amount_cents <> OLD.amount_cents THEN
    RAISE EXCEPTION 'the amount of a submitted payment cannot change'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_validate_transition
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION app.validate_payment_transition();

-- ---------------------------------------------------------------------------
-- Webhook receipts.
--
-- Every inbound provider event is recorded before it is acted on, keyed by the
-- provider's own event id. A replayed webhook finds its row already present and
-- does nothing, which is what stops a retrying provider from posting a payment
-- to the ledger four times.
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  signature_valid   boolean NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  processing_error  text,
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX webhook_events_unprocessed_idx
  ON webhook_events (received_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Autopay.
-- ---------------------------------------------------------------------------

CREATE TABLE autopay_enrollments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  payment_method_id uuid NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  day_of_month      smallint NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  -- A ceiling the resident sets on what may be drafted without asking again.
  -- Autopay with no cap is a standing authorization to empty someone's account
  -- after a billing error; the cap bounds the blast radius of a mistake.
  cap_cents         bigint CHECK (cap_cents IS NULL OR cap_cents > 0),
  active            boolean NOT NULL DEFAULT true,
  last_drafted_period text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX autopay_one_active_per_tenancy
  ON autopay_enrollments (tenancy_id) WHERE active;

-- ---------------------------------------------------------------------------
-- Payment plans.
--
-- A plan does not change what is owed; it changes when it is due and, by
-- default, suspends fee accrual on the covered amount. Opening one writes an
-- annotation to the ledger so the resident sees the arrangement in the same
-- place they see everything else about their account.
-- ---------------------------------------------------------------------------

CREATE TABLE payment_plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  total_cents       bigint NOT NULL CHECK (total_cents > 0),
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','completed','defaulted','cancelled')),
  reason            text NOT NULL CHECK (length(reason) BETWEEN 4 AND 1000),
  suspends_late_fees boolean NOT NULL DEFAULT true,
  opened_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_plans_tenancy_idx ON payment_plans (tenancy_id, status);
CREATE UNIQUE INDEX payment_plans_one_active_per_tenancy
  ON payment_plans (tenancy_id) WHERE status = 'active';

CREATE TABLE payment_plan_installments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_plan_id   uuid NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  sequence          smallint NOT NULL CHECK (sequence >= 1),
  due_date          date NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  paid_cents        bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  status            text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','paid','partial','missed')),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_plan_id, sequence)
);

CREATE INDEX plan_installments_due_idx ON payment_plan_installments (due_date)
  WHERE status IN ('scheduled','partial');

CREATE TRIGGER payment_plans_touch BEFORE UPDATE ON payment_plans
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER plan_installments_touch BEFORE UPDATE ON payment_plan_installments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The ledger's soft references, wired now that their targets exist.
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_payment_fk
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT,
  ADD CONSTRAINT ledger_plan_fk
    FOREIGN KEY (payment_plan_id) REFERENCES payment_plans(id) ON DELETE RESTRICT;
