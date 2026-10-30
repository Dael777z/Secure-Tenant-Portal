/* 004  Messages between a tenant and the property office. Additive, like 002
   and 003: no earlier table or policy is edited.

   Each tenant has one conversation with the office (Message_Threads, one row
   per tenant). Property managers ('admin') share it: any of them can read and
   reply, archive and unarchive. Maintenance staff have no access, like the
   ledger. A tenant reads and writes only their own conversation.

   read_at is the receipt: set once, when the other side opens the
   conversation. A message is never edited or deleted. */

CREATE TABLE Message_Threads (
    tID              INT PRIMARY KEY REFERENCES Tenants(tID),
    last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at      TIMESTAMPTZ,                       -- the office's Archive; null = in the inbox
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_threads_recent ON Message_Threads(last_message_at DESC);

CREATE TABLE Messages (
    msgID            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tID              INT NOT NULL REFERENCES Message_Threads(tID),
    sender_admin_id  INT REFERENCES Admin(admin_id),    -- null: the tenant wrote it
    sender_name      VARCHAR(255),                       -- the manager's name, as it was when sent (tenants cannot read Admin)
    body             VARCHAR(2000) NOT NULL CHECK (length(btrim(body)) > 0),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at          TIMESTAMPTZ                         -- when the other side opened it
);
CREATE INDEX idx_messages_thread ON Messages(tID, created_at, msgID);
CREATE INDEX idx_messages_unread ON Messages(tID) WHERE read_at IS NULL;

/* Before a message is saved: its conversation exists (made on the first
   message from either side), a manager's message carries their name, and the
   times come from the database, not the caller. Runs as the owner, so it can
   read Admin and write Message_Threads for a tenant. */
CREATE FUNCTION message_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    NEW.created_at := now();
    NEW.read_at := NULL;
    NEW.sender_name := CASE WHEN NEW.sender_admin_id IS NULL THEN NULL
                            ELSE (SELECT name FROM Admin WHERE admin_id = NEW.sender_admin_id) END;
    INSERT INTO Message_Threads (tID) VALUES (NEW.tID) ON CONFLICT (tID) DO NOTHING;
    RETURN NEW;
END $$;

/* After: the conversation moves to the top, and a tenant's new message brings
   an archived conversation back to the inbox. */
CREATE FUNCTION message_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    UPDATE Message_Threads
       SET last_message_at = NEW.created_at,
           archived_at = CASE WHEN NEW.sender_admin_id IS NULL THEN NULL ELSE archived_at END
     WHERE tID = NEW.tID;
    RETURN NEW;
END $$;

/* Messages are append-only: the only change is read_at, from null to a time,
   and never back. (The column grant below says the same.) */
CREATE FUNCTION message_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.msgID <> OLD.msgID OR NEW.tID <> OLD.tID OR NEW.body <> OLD.body
       OR NEW.sender_admin_id IS DISTINCT FROM OLD.sender_admin_id
       OR NEW.sender_name IS DISTINCT FROM OLD.sender_name OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'messages cannot be edited' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
        RAISE EXCEPTION 'a read receipt cannot change' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER message_before_insert BEFORE INSERT ON Messages FOR EACH ROW EXECUTE FUNCTION message_before_insert();
CREATE TRIGGER message_after_insert AFTER INSERT ON Messages FOR EACH ROW EXECUTE FUNCTION message_after_insert();
CREATE TRIGGER message_guard_update BEFORE UPDATE ON Messages FOR EACH ROW EXECUTE FUNCTION message_guard_update();
CREATE TRIGGER messages_no_delete BEFORE DELETE ON Messages FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- The fewest grants that work: no DELETE, and only read_at / archived_at can change.
GRANT SELECT, INSERT              ON Messages        TO summit_app;
GRANT UPDATE (read_at)            ON Messages        TO summit_app;
GRANT SELECT                      ON Message_Threads TO summit_app;
GRANT UPDATE (archived_at)        ON Message_Threads TO summit_app;

ALTER TABLE Message_Threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE Messages        ENABLE ROW LEVEL SECURITY;

-- Property managers: every conversation; they write only as themselves.
CREATE POLICY admin_read ON Message_Threads FOR SELECT TO summit_app USING ((SELECT app_is_admin()));
CREATE POLICY admin_archive ON Message_Threads FOR UPDATE TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_read ON Messages FOR SELECT TO summit_app USING ((SELECT app_is_admin()));
CREATE POLICY admin_send ON Messages FOR INSERT TO summit_app
    WITH CHECK ((SELECT app_is_admin()) AND sender_admin_id = (SELECT app_admin_id()));
-- Mark the tenant's messages read (not their own).
CREATE POLICY admin_mark_read ON Messages FOR UPDATE TO summit_app
    USING ((SELECT app_is_admin()) AND sender_admin_id IS NULL)
    WITH CHECK ((SELECT app_is_admin()) AND sender_admin_id IS NULL);

-- A tenant: their own conversation only.
CREATE POLICY tenant_read ON Message_Threads FOR SELECT TO summit_app USING (tID = (SELECT app_tenant_id()));
CREATE POLICY tenant_read ON Messages FOR SELECT TO summit_app USING (tID = (SELECT app_tenant_id()));
CREATE POLICY tenant_send ON Messages FOR INSERT TO summit_app
    WITH CHECK (tID = (SELECT app_tenant_id()) AND sender_admin_id IS NULL);
-- Mark the office's messages read (not their own).
CREATE POLICY tenant_mark_read ON Messages FOR UPDATE TO summit_app
    USING (tID = (SELECT app_tenant_id()) AND sender_admin_id IS NOT NULL)
    WITH CHECK (tID = (SELECT app_tenant_id()) AND sender_admin_id IS NOT NULL);
