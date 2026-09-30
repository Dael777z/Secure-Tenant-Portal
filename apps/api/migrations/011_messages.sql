-- ---------------------------------------------------------------------------
-- 011  Messages between residents and management.
--
-- The sponsor asked for "one place for tenants to message" (9/27 meeting), and
-- the prototype's sidebar and mobile home both carry a Messages entry. RentRedi
-- offers titled chat threads; this adds the same shape with two differences
-- that follow from the rest of the schema:
--
--   * A thread can be tied to the thing it is about — a ledger entry or a work
--     order — so "why was I charged this?" sits next to the charge.
--   * Messages are append-only, like the ledger. Nobody edits what they said
--     after the other party has read it.
--
-- Visibility is Row-Level Security, as everywhere else:
--   resident  their own tenancy's threads
--   manager   threads at properties they are assigned to
--   staff     only maintenance threads at their properties (no money talk)
--   owner     none — resident correspondence is not an owner report
-- ---------------------------------------------------------------------------

CREATE TABLE message_threads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id          uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  -- Copied from the tenancy by the trigger below. On-site staff cannot read
  -- tenancy rows (010), but they can read units and resident names, so the
  -- thread carries what a maintenance conversation needs to show.
  unit_id             uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  resident_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject             text NOT NULL CHECK (length(subject) BETWEEN 1 AND 140),
  topic               text NOT NULL DEFAULT 'general'
                        CHECK (topic IN ('general','payment','maintenance','lease','other')),
  ledger_entry_id     uuid REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  work_order_id       uuid REFERENCES work_orders(id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by_role     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_message_at     timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz
);

CREATE INDEX message_threads_property_idx ON message_threads (property_id, last_message_at DESC);
CREATE INDEX message_threads_tenancy_idx ON message_threads (tenancy_id, last_message_at DESC);
CREATE INDEX message_threads_unit_idx ON message_threads (unit_id);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           uuid NOT NULL REFERENCES message_threads(id) ON DELETE RESTRICT,
  -- Copied from the thread by the trigger below, never trusted from the caller.
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id          uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  author_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_role         text NOT NULL,
  -- A snapshot of the author's name. Residents cannot read a manager's user row
  -- (users_read in 007), and a message should say who wrote it even so.
  author_name         text NOT NULL,
  body                text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_thread_idx ON messages (thread_id, created_at);

CREATE TABLE message_reads (
  thread_id           uuid NOT NULL REFERENCES message_threads(id) ON DELETE RESTRICT,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  last_read_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

-- A thread takes its organization, property, unit and resident from the tenancy,
-- through the same scoped lookup work orders use (010): a resident's own
-- tenancy, or one at a property the caller is assigned to. Anything else is
-- refused before the row exists, whatever the caller supplied.
CREATE OR REPLACE FUNCTION app.thread_from_tenancy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM app.work_order_context(NEW.tenancy_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenancy % is not one this account can message', NEW.tenancy_id USING ERRCODE = '42501';
  END IF;
  NEW.organization_id := c.organization_id;
  NEW.property_id := c.property_id;
  NEW.unit_id := c.unit_id;
  NEW.resident_user_id := c.resident_user_id;
  NEW.created_at := now();
  NEW.last_message_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER message_threads_from_tenancy
  BEFORE INSERT ON message_threads
  FOR EACH ROW EXECUTE FUNCTION app.thread_from_tenancy();

-- A message takes its place, property and tenancy from its thread, and moves
-- the thread's last_message_at. Runs as the invoker, so a caller who cannot see
-- the thread gets no row back and the NOT NULL columns refuse the insert.
CREATE OR REPLACE FUNCTION app.message_from_thread() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE th record;
BEGIN
  SELECT organization_id, property_id, tenancy_id, status INTO th
  FROM message_threads WHERE id = NEW.thread_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'thread % is not visible', NEW.thread_id USING ERRCODE = '42501';
  END IF;
  IF th.status = 'closed' THEN
    RAISE EXCEPTION 'this conversation is closed' USING ERRCODE = 'P0001';
  END IF;
  NEW.organization_id := th.organization_id;
  NEW.property_id := th.property_id;
  NEW.tenancy_id := th.tenancy_id;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_from_thread
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION app.message_from_thread();

-- Row-Level Security ---------------------------------------------------------

ALTER TABLE message_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE message_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reads FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app.can_see_thread(p_tenancy uuid, p_property uuid, p_topic text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE app.current_role_name()
    WHEN 'tenant' THEN p_tenancy = ANY (app.visible_tenancy_ids())
    WHEN 'manager' THEN p_property = ANY (app.visible_property_ids())
    WHEN 'staff' THEN p_topic = 'maintenance' AND p_property = ANY (app.visible_property_ids())
    WHEN 'system_job' THEN true
    ELSE false
  END;
$$;
GRANT EXECUTE ON FUNCTION app.can_see_thread(uuid, uuid, text) TO portal_app;

CREATE POLICY message_threads_read ON message_threads
  FOR SELECT USING (app.can_see_thread(tenancy_id, property_id, topic));

CREATE POLICY message_threads_insert ON message_threads
  FOR INSERT WITH CHECK (
    app.can_see_thread(tenancy_id, property_id, topic)
    AND (created_by_user_id = app.current_user_id() OR app.is_system_job())
  );

CREATE POLICY message_threads_update ON message_threads
  FOR UPDATE
  USING (app.can_see_thread(tenancy_id, property_id, topic))
  WITH CHECK (app.can_see_thread(tenancy_id, property_id, topic));

-- A message is visible exactly when its thread is: the subquery is itself
-- filtered by message_threads_read, so the two policies cannot drift apart.
CREATE POLICY messages_read ON messages
  FOR SELECT USING (thread_id IN (SELECT id FROM message_threads));

CREATE POLICY messages_insert ON messages
  FOR INSERT WITH CHECK (
    thread_id IN (SELECT id FROM message_threads)
    AND (author_user_id = app.current_user_id() OR app.is_system_job())
  );

CREATE POLICY message_reads_own ON message_reads
  FOR ALL
  USING (user_id = app.current_user_id() AND thread_id IN (SELECT id FROM message_threads))
  WITH CHECK (user_id = app.current_user_id() AND thread_id IN (SELECT id FROM message_threads));

-- Grants ---------------------------------------------------------------------

GRANT SELECT, INSERT ON message_threads TO portal_app;
-- Only the columns a conversation legitimately changes: open/closed and recency.
REVOKE UPDATE ON message_threads FROM portal_app;
GRANT UPDATE (status, closed_at, last_message_at) ON message_threads TO portal_app;
REVOKE DELETE, TRUNCATE ON message_threads FROM portal_app;

-- Append-only, like the ledger.
GRANT SELECT, INSERT ON messages TO portal_app;
REVOKE UPDATE, DELETE, TRUNCATE ON messages FROM portal_app;

GRANT SELECT, INSERT, UPDATE ON message_reads TO portal_app;
REVOKE DELETE, TRUNCATE ON message_reads FROM portal_app;
