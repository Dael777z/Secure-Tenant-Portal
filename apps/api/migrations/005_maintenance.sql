-- ---------------------------------------------------------------------------
-- 005  Maintenance intake and charge disputes.
--
-- Maintenance sits next to the ledger rather than off on its own because its
-- most valuable property is the link between them: a request resolved in a way
-- that warrants a rent credit posts that credit as a linked row, so the resident
-- finds the money and its cause in one place instead of an unexplained credit
-- they are afraid to spend.
-- ---------------------------------------------------------------------------

CREATE TABLE work_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  unit_id           uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,

  -- Short, human-quotable: "WO-4F21". Residents read this over the phone.
  reference         text NOT NULL UNIQUE,
  category          text NOT NULL CHECK (category IN
                      ('plumbing','electrical','hvac','appliance','pest',
                       'locks_keys','structural','common_area','other')),
  priority          text NOT NULL CHECK (priority IN ('emergency','urgent','routine')),
  status            text NOT NULL DEFAULT 'submitted' CHECK (status IN
                      ('submitted','acknowledged','scheduled','in_progress',
                       'resolved','closed','cancelled')),
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 140),
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  entry_permission  boolean NOT NULL DEFAULT false,

  submitted_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  assigned_to_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,

  submitted_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at   timestamptz,
  resolved_at       timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_orders_tenancy_idx ON work_orders (tenancy_id, submitted_at DESC);
CREATE INDEX work_orders_open_idx ON work_orders (property_id, priority, submitted_at)
  WHERE status IN ('submitted','acknowledged','scheduled','in_progress');

CREATE TRIGGER work_orders_touch BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE OR REPLACE FUNCTION app.validate_work_order_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  allowed := CASE OLD.status
    WHEN 'submitted'    THEN ARRAY['acknowledged','scheduled','in_progress','resolved','cancelled']
    WHEN 'acknowledged' THEN ARRAY['scheduled','in_progress','resolved','cancelled']
    WHEN 'scheduled'    THEN ARRAY['in_progress','resolved','cancelled']
    WHEN 'in_progress'  THEN ARRAY['resolved','scheduled','cancelled']
    -- A resident saying "this is not actually fixed" is the difference between a
    -- queue that reflects reality and one that reflects what staff clicked.
    WHEN 'resolved'     THEN ARRAY['closed','in_progress']
    WHEN 'closed'       THEN ARRAY['in_progress']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'illegal work order transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_orders_validate_transition
  BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION app.validate_work_order_transition();

-- The thread. Every status change and note appends here; nothing is edited, so
-- the history of a request is as reconstructible as the history of a charge.
CREATE TABLE work_order_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id     uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  kind              text NOT NULL CHECK (kind IN ('status','note','photo','credit')),
  from_status       text,
  to_status         text,
  note              text CHECK (note IS NULL OR length(note) <= 2000),
  author_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  author_role       text,
  -- Internal coordination notes never appear in the resident's thread.
  visible_to_resident boolean NOT NULL DEFAULT true,
  linked_ledger_entry_id uuid REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_order_events_wo_idx ON work_order_events (work_order_id, occurred_at);

CREATE TRIGGER work_order_events_append_only
  BEFORE UPDATE OR DELETE ON work_order_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE work_order_photos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id     uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  -- The object key in storage. The object itself is never publicly readable;
  -- the API mints a short-lived signed URL when someone entitled to it asks.
  -- These are photographs of the inside of somebody's home.
  object_key        text NOT NULL UNIQUE,
  content_type      text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','image/heic')),
  size_bytes        integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 15728640),
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_order_photos_wo_idx ON work_order_photos (work_order_id);

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_work_order_fk
    FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Disputes.
--
-- A dispute attaches to one specific ledger row, and the manager's answer
-- attaches to the same row. The resident does not have to keep a separate
-- record of having objected; the objection and the answer live with the charge.
-- ---------------------------------------------------------------------------

CREATE TABLE charge_disputes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  ledger_entry_id   uuid NOT NULL REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN
                      ('open','responded','resolved_adjusted','resolved_upheld','withdrawn')),
  reason            text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  opened_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  response          text CHECK (response IS NULL OR length(response) <= 4000),
  responded_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  responded_at      timestamptz,
  resolution_entry_id uuid REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One open dispute per charge. A second objection to the same row belongs in the
-- existing thread, not in a parallel one nobody reads.
CREATE UNIQUE INDEX charge_disputes_one_open_per_entry
  ON charge_disputes (ledger_entry_id) WHERE status IN ('open','responded');

CREATE INDEX charge_disputes_property_open_idx
  ON charge_disputes (property_id, opened_at) WHERE status IN ('open','responded');
CREATE INDEX charge_disputes_tenancy_idx ON charge_disputes (tenancy_id, opened_at DESC);

CREATE TRIGGER charge_disputes_touch BEFORE UPDATE ON charge_disputes
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_dispute_fk
    FOREIGN KEY (dispute_id) REFERENCES charge_disputes(id) ON DELETE RESTRICT;
