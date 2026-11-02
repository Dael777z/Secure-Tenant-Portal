/* 009  Office tools, maintenance detail, leasing, notices and documents.
   Needs 001-008. Adds tables and columns only; nothing earlier is removed.

   1. Staff accounts: teammates are invited with a sign-up link (like tenants),
      so Admin gets the same signup columns and a last sign-in time.
      Security_Events records sign-ins and team changes for the Activity page.
   2. Portfolios: groups of properties (one legal owner). Property gains city,
      state, ZIP, time zone, notes and its portfolio.
   3. Tenant_Details: renters insurance, emergency contact, office notes.
   4. Compliance_Settings: the office's state rules (deposit limit, late fee
      grace and limit, notice periods), checked against leases and late fee rules.
   5. Maintenance: a 'rejected' stage, who it is assigned to, labor and
      materials cost (booked once as an expense), when it was completed, staff
      notes, and photos from staff or the resident.
   6. Documents: files the office keeps on a property, unit, tenant or lease,
      optionally shared with the resident.
   7. Notifications_Sent: every notice a resident gets (written by the office,
      or automatic: payment received, rent due, rent past due).
   8. Listings and Leads: vacant units advertised on the public /listings page,
      and the people who ask about them. */

/* ---- 1. Staff accounts ------------------------------------------------------- */
ALTER TABLE Admin
    ALTER COLUMN password_hash DROP NOT NULL,
    ADD COLUMN signup_completed        BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN signup_token_hash       TEXT,
    ADD COLUMN signup_token_expires_at TIMESTAMPTZ,
    ADD COLUMN last_login_at           TIMESTAMPTZ,
    ADD COLUMN created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- An account that can sign in has a password; an invited one has a token instead.
    ADD CONSTRAINT admin_signed_up_has_password CHECK (NOT signup_completed OR password_hash IS NOT NULL);
CREATE UNIQUE INDEX admin_signup_token ON Admin (signup_token_hash) WHERE signup_token_hash IS NOT NULL;

-- Same as 001, except an invited teammate (no password yet) reports signup_completed = false.
CREATE OR REPLACE FUNCTION auth_lookup_user(p_email CITEXT)
RETURNS TABLE (user_type TEXT, user_id INT, password_hash TEXT, signup_completed BOOLEAN,
               role TEXT, mfa_enabled BOOLEAN, mfa_secret_encrypted TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT 'tenant'::TEXT, t.tID, t.password_hash, t.signup_completed,
           NULL::TEXT, false, NULL::TEXT
    FROM Tenants t
    WHERE t.Email = p_email
      AND t.deactivated_at IS NULL
    UNION ALL
    SELECT 'admin'::TEXT, a.admin_id, a.password_hash, a.signup_completed,
           a.role::TEXT, a.mfa_enabled, a.mfa_secret_encrypted
    FROM Admin a
    WHERE a.email = p_email
      AND a.deactivated_at IS NULL
$$;

/* A teammate opens their invite link and picks a password. Like
   auth_complete_signup() for tenants: one UPDATE checks the token, its
   expiry and the account's state, so two racing requests cannot both win. */
CREATE FUNCTION auth_complete_staff_signup(p_token_hash TEXT, p_password_hash TEXT)
RETURNS TABLE (admin_id INT, email TEXT, role TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE Admin a
       SET password_hash = p_password_hash,
           signup_completed = true,
           signup_token_hash = NULL,
           signup_token_expires_at = NULL
     WHERE a.signup_token_hash = p_token_hash
       AND a.signup_completed = false
       AND a.deactivated_at IS NULL
       AND (a.signup_token_expires_at IS NULL OR a.signup_token_expires_at > now())
    RETURNING a.admin_id, a.email::TEXT, a.role::TEXT
$$;

CREATE TABLE Security_Events (
    eventID    BIGSERIAL PRIMARY KEY,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor      TEXT,                    -- "admin:3", "tenant:42", or null (an unknown email)
    action     VARCHAR(30) NOT NULL CHECK (action IN (
                   'login_success', 'login_failed', 'signup_completed',
                   'team_invite', 'team_update', 'team_deactivate', 'team_reset', 'team_reissue')),
    summary    VARCHAR(300) NOT NULL,
    details    JSONB
);
CREATE INDEX idx_security_events_at ON Security_Events (at DESC);
CREATE TRIGGER trg_security_events_no_change BEFORE UPDATE OR DELETE ON Security_Events
    FOR EACH ROW EXECUTE FUNCTION forbid_modification();

/* Sign-ins happen before anyone is known, so they are written through this
   function rather than a policy. A tenant's own sign-ins are recorded too,
   but only staff can read the table. */
CREATE FUNCTION record_security_event(p_actor TEXT, p_action TEXT, p_summary TEXT, p_details JSONB)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    INSERT INTO Security_Events (actor, action, summary, details) VALUES (p_actor, p_action, left(p_summary, 300), p_details);
    IF p_action = 'login_success' AND p_actor LIKE 'admin:%' THEN
        UPDATE Admin SET last_login_at = now() WHERE admin_id = substr(p_actor, 7)::INT;
    END IF;
END $$;
REVOKE ALL ON FUNCTION record_security_event(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_complete_staff_signup(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_security_event(TEXT, TEXT, TEXT, JSONB) TO summit_app;
GRANT EXECUTE ON FUNCTION auth_complete_staff_signup(TEXT, TEXT) TO summit_app;

/* ---- 2. Portfolios and property details ----------------------------------------- */
CREATE TABLE Portfolios (
    portfolio_id  SERIAL PRIMARY KEY,
    name          CITEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    entity_name   VARCHAR(200),              -- the legal owner, like "Woodcrest Holdings LLC"
    notes         VARCHAR(2000),
    created_by    INT REFERENCES Admin(admin_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at    TIMESTAMPTZ                -- set instead of deleting; its properties are unassigned
);
CREATE UNIQUE INDEX portfolio_active_name ON Portfolios (name) WHERE retired_at IS NULL;

ALTER TABLE Property
    ADD COLUMN portfolio_id INT REFERENCES Portfolios(portfolio_id) ON DELETE RESTRICT,
    ADD COLUMN city         VARCHAR(80),
    ADD COLUMN state        CHAR(2) CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
    ADD COLUMN zip          VARCHAR(10) CHECK (zip IS NULL OR zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
    ADD COLUMN time_zone    VARCHAR(40),
    ADD COLUMN notes        VARCHAR(4000);

/* ---- 3. Tenant details ---------------------------------------------------------- */
CREATE TABLE Tenant_Details (
    tID                      INT PRIMARY KEY REFERENCES Tenants(tID) ON DELETE RESTRICT,
    notes                    VARCHAR(4000),
    insurance_status         VARCHAR(15) NOT NULL DEFAULT 'not_required'
                             CHECK (insurance_status IN ('not_required', 'required', 'on_file', 'expired')),
    insurance_expires        DATE,
    emergency_contact_name   VARCHAR(120),
    emergency_contact_phone  VARCHAR(40),
    updated_by               INT REFERENCES Admin(admin_id),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* ---- 4. Compliance settings (one row) -------------------------------------------- */
CREATE TABLE Compliance_Settings (
    id                              BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    state                           CHAR(2) NOT NULL DEFAULT 'NM' CHECK (state ~ '^[A-Z]{2}$'),
    security_deposit_max_months     NUMERIC(3,1) CHECK (security_deposit_max_months BETWEEN 0.1 AND 12),
    deposit_interest_required       BOOLEAN,
    late_fee_grace_days             INT CHECK (late_fee_grace_days BETWEEN 0 AND 60),
    late_fee_max_percent            NUMERIC(5,2) CHECK (late_fee_max_percent BETWEEN 0 AND 100),
    notice_to_quit_days             INT CHECK (notice_to_quit_days BETWEEN 0 AND 3650),
    rent_increase_notice_days       INT CHECK (rent_increase_notice_days BETWEEN 0 AND 3650),
    lead_paint_disclosure_required  BOOLEAN,
    notes                           VARCHAR(4000),
    "references"                    VARCHAR(4000),
    confirmed_at                    TIMESTAMPTZ,    -- when someone last marked these as reviewed
    confirmed_by                    INT REFERENCES Admin(admin_id),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by                      INT REFERENCES Admin(admin_id)
);
INSERT INTO Compliance_Settings (id) VALUES (true);

/* ---- 5. Maintenance --------------------------------------------------------------- */
ALTER TABLE Maintenance_T DROP CONSTRAINT maintenance_t_status_check;
ALTER TABLE Maintenance_T ADD CONSTRAINT maintenance_t_status_check
    CHECK (status IN ('submitted', 'in_review', 'scheduled', 'in_progress', 'resolved', 'rejected'));
ALTER TABLE Maintenance_T
    ADD COLUMN assigned_to     INT REFERENCES Admin(admin_id) ON DELETE RESTRICT,
    ADD COLUMN labor_cost      NUMERIC(10,2) CHECK (labor_cost >= 0),
    ADD COLUMN materials_cost  NUMERIC(10,2) CHECK (materials_cost >= 0),
    ADD COLUMN completed_at    TIMESTAMPTZ,
    ADD COLUMN expense_id      INT REFERENCES Expenses(expID) ON DELETE RESTRICT;

-- Completed (or rejected) stamps the time; reopening clears it.
CREATE FUNCTION maintenance_completed_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('resolved', 'rejected') AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('resolved', 'rejected')) THEN
        NEW.completed_at := now();
    ELSIF NEW.status NOT IN ('resolved', 'rejected') THEN
        NEW.completed_at := NULL;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_maintenance_completed_at BEFORE INSERT OR UPDATE OF status ON Maintenance_T
    FOR EACH ROW EXECUTE FUNCTION maintenance_completed_at();
UPDATE Maintenance_T SET completed_at = updated_at WHERE status = 'resolved';

CREATE TABLE Maintenance_Notes (
    noteID      SERIAL PRIMARY KEY,
    mID         INT NOT NULL REFERENCES Maintenance_T(mID) ON DELETE RESTRICT,
    admin_id    INT REFERENCES Admin(admin_id) DEFAULT (NULLIF(current_setting('app.user_id', true), '')::INT),
    body        VARCHAR(2000) NOT NULL CHECK (length(btrim(body)) > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_maintenance_notes ON Maintenance_Notes (mID, created_at);

CREATE TABLE Maintenance_Attachments (
    attID         SERIAL PRIMARY KEY,
    mID           INT NOT NULL REFERENCES Maintenance_T(mID) ON DELETE RESTRICT,
    filename      VARCHAR(200) NOT NULL,
    content_type  VARCHAR(40) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    size_bytes    INT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),   -- 5 MB
    sha256_hex    CHAR(64) NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
    data          BYTEA NOT NULL,
    admin_id      INT REFERENCES Admin(admin_id),     -- staff upload
    tID           INT REFERENCES Tenants(tID),        -- the resident's upload
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(admin_id, tID) <= 1),
    CHECK (octet_length(data) = size_bytes),
    CHECK (sha256_hex = encode(sha256(data), 'hex'))
);
CREATE INDEX idx_maintenance_attachments ON Maintenance_Attachments (mID);

/* ---- 6. Documents -------------------------------------------------------------- */
CREATE TABLE Documents (
    docID               SERIAL PRIMARY KEY,
    scope               VARCHAR(10) NOT NULL CHECK (scope IN ('property', 'unit', 'tenant', 'lease')),
    pID                 INT REFERENCES Property(pID) ON DELETE RESTRICT,
    uID                 INT REFERENCES Units(uID) ON DELETE RESTRICT,
    tID                 INT REFERENCES Tenants(tID) ON DELETE RESTRICT,
    LeaseID             INT REFERENCES Lease(LeaseID) ON DELETE RESTRICT,
    category            VARCHAR(12) NOT NULL DEFAULT 'other'
                        CHECK (category IN ('lease', 'inspection', 'insurance', 'notice', 'receipt', 'other')),
    title               VARCHAR(200) NOT NULL CHECK (length(btrim(title)) > 0),
    filename            VARCHAR(200) NOT NULL,
    content_type        VARCHAR(40) NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
    size_bytes          INT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),   -- 10 MB
    sha256_hex          CHAR(64) NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
    data                BYTEA NOT NULL,
    shared_with_tenant  BOOLEAN NOT NULL DEFAULT false,
    uploaded_by         INT REFERENCES Admin(admin_id),
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    hidden_at           TIMESTAMPTZ,                         -- removed from view; kept on record
    -- Exactly the column that matches the scope.
    CHECK ((scope = 'property' AND pID IS NOT NULL AND num_nonnulls(uID, tID, LeaseID) = 0)
        OR (scope = 'unit'     AND uID IS NOT NULL AND num_nonnulls(pID, tID, LeaseID) = 0)
        OR (scope = 'tenant'   AND tID IS NOT NULL AND num_nonnulls(pID, uID, LeaseID) = 0)
        OR (scope = 'lease'    AND LeaseID IS NOT NULL AND num_nonnulls(pID, uID, tID) = 0)),
    CHECK (octet_length(data) = size_bytes),
    CHECK (sha256_hex = encode(sha256(data), 'hex'))
);
CREATE INDEX idx_documents_scope ON Documents (scope, pID, uID, tID, LeaseID) WHERE hidden_at IS NULL;

/* ---- 7. Notices to residents -------------------------------------------------- */
CREATE TABLE Notifications_Sent (
    notID            SERIAL PRIMARY KEY,
    tID              INT NOT NULL REFERENCES Tenants(tID) ON DELETE RESTRICT,
    LeaseID          INT REFERENCES Lease(LeaseID) ON DELETE RESTRICT,
    channel          VARCHAR(10) NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email')),
    template         VARCHAR(20) NOT NULL CHECK (template IN (
                         'rent_upcoming', 'rent_due', 'rent_overdue', 'payment_received',
                         'maintenance_update', 'manual', 'invite', 'lease_ending', 'custom')),
    subject          VARCHAR(200) NOT NULL,
    body             VARCHAR(5000) NOT NULL,
    status           VARCHAR(10) NOT NULL DEFAULT 'sent' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
    error            VARCHAR(500),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by       INT REFERENCES Admin(admin_id),
    sent_at          TIMESTAMPTZ,
    read_at          TIMESTAMPTZ,
    source_payment   INT REFERENCES Payment(payID) ON DELETE RESTRICT,
    source_reminder  INT REFERENCES Rent_Reminders_Sent(remID) ON DELETE RESTRICT
);
CREATE INDEX idx_notifications_tenant ON Notifications_Sent (tID, created_at DESC);
CREATE INDEX idx_notifications_created ON Notifications_Sent (created_at DESC);

-- "$1,234.50"
CREATE FUNCTION fmt_money(p NUMERIC) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT '$' || to_char(p, 'FM999,999,990.00') $$;

/* A completed payment (money in) tells every resident on the lease. Written
   as the definer, since the payment may be the system's or a tenant's. */
CREATE FUNCTION notify_payment_received() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    -- The property's own time zone when the office set one; otherwise the app's default (config.ts).
    v_tz TEXT;
BEGIN
    IF NEW.status <> 'completed' OR NEW.direction <> 'charge' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN RETURN NEW; END IF;
    SELECT COALESCE(p.time_zone, 'America/Denver') INTO v_tz
    FROM Lease l JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID
    WHERE l.LeaseID = NEW.LeaseID;
    INSERT INTO Notifications_Sent (tID, LeaseID, template, subject, body, sent_at, source_payment)
    SELECT lt.tID, NEW.LeaseID, 'payment_received',
           'Payment received: ' || fmt_money(NEW.amount),
           'We received your payment of ' || fmt_money(NEW.amount) || ' on '
               || trim(to_char(NEW."timestamp" AT TIME ZONE COALESCE(v_tz, 'America/Denver'), 'FMMonth FMDD, YYYY'))
               || '. Thank you. Your receipt is in the resident portal.',
           now(), NEW.payID
    FROM Lease_Tenants lt
    WHERE lt.LeaseID = NEW.LeaseID;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_notify_payment_received AFTER INSERT OR UPDATE OF status ON Payment
    FOR EACH ROW EXECUTE FUNCTION notify_payment_received();

-- Each rent reminder the nightly job records becomes a notice for the lease's residents.
CREATE FUNCTION notify_rent_reminder() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_day TEXT := trim(to_char(NEW.due_date, 'FMMonth FMDD, YYYY'));
BEGIN
    INSERT INTO Notifications_Sent (tID, LeaseID, template, subject, body, sent_at, source_reminder)
    SELECT lt.tID, NEW.LeaseID,
           CASE NEW.kind WHEN 'upcoming' THEN 'rent_upcoming' WHEN 'due' THEN 'rent_due' ELSE 'rent_overdue' END,
           CASE NEW.kind WHEN 'upcoming' THEN 'Rent is due ' || v_day WHEN 'due' THEN 'Rent is due today' ELSE 'Rent is past due' END,
           CASE NEW.kind
               WHEN 'upcoming' THEN 'Rent of ' || fmt_money(NEW.amount) || ' is due ' || v_day || '. You can pay in the resident portal.'
               WHEN 'due' THEN 'Rent of ' || fmt_money(NEW.amount) || ' is due today, ' || v_day || '. You can pay in the resident portal.'
               ELSE fmt_money(NEW.amount) || ' of rent due ' || v_day || ' is still unpaid. Please pay in the resident portal, or contact the office.'
           END,
           now(), NEW.remID
    FROM Lease_Tenants lt
    WHERE lt.LeaseID = NEW.LeaseID;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_notify_rent_reminder AFTER INSERT ON Rent_Reminders_Sent
    FOR EACH ROW EXECUTE FUNCTION notify_rent_reminder();

/* ---- 8. Listings and leads ------------------------------------------------------- */
CREATE TABLE Listings (
    listingID      SERIAL PRIMARY KEY,
    uID            INT NOT NULL REFERENCES Units(uID) ON DELETE RESTRICT,
    status         VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'ended')),
    title          VARCHAR(120) NOT NULL CHECK (length(btrim(title)) > 0),
    description    VARCHAR(4000),
    asking_rent    NUMERIC(10,2) NOT NULL CHECK (asking_rent > 0),
    available_on   DATE,
    beds           NUMERIC(3,1) CHECK (beds >= 0 AND beds * 2 = round(beds * 2)),
    baths          NUMERIC(3,1) CHECK (baths >= 0 AND baths * 2 = round(baths * 2)),
    sqft           INT CHECK (sqft >= 0),
    amenities      TEXT[] NOT NULL DEFAULT '{}',
    pets           VARCHAR(200),
    created_by     INT REFERENCES Admin(admin_id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at   TIMESTAMPTZ,
    ended_at       TIMESTAMPTZ
);
-- One open (draft or listed) listing per unit; ended ones stay as history.
CREATE UNIQUE INDEX listing_open_unit ON Listings (uID) WHERE status <> 'ended';

CREATE TABLE Leads (
    leadID      SERIAL PRIMARY KEY,
    listingID   INT NOT NULL REFERENCES Listings(listingID) ON DELETE RESTRICT,
    name        VARCHAR(120) NOT NULL CHECK (length(btrim(name)) > 0),
    email       CITEXT,
    phone       VARCHAR(40),
    message     VARCHAR(2000),
    source      VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'website', 'zillow')),
    status      VARCHAR(10) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(email, phone) >= 1)
);
CREATE INDEX idx_leads_listing ON Leads (listingID, created_at DESC);

/* The public /listings page reads listed homes without signing in. These
   functions return only what a listing shows; nothing else is reachable. */
CREATE FUNCTION public_listings()
RETURNS TABLE (id INT, title TEXT, description TEXT, asking_rent NUMERIC, available_on DATE, beds NUMERIC, baths NUMERIC,
               sqft INT, amenities TEXT[], pets TEXT, city TEXT, photo_ids INT[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT l.listingID, l.title::TEXT, l.description::TEXT, l.asking_rent, l.available_on, l.beds, l.baths,
           l.sqft, l.amenities, l.pets::TEXT, p.city::TEXT,
           COALESCE((SELECT array_agg(i.imgID ORDER BY (i.uID IS NULL), i.sort_order, i.imgID)
                     FROM Property_Images i
                     WHERE i.deactivated_at IS NULL AND (i.uID = u.uID OR i.pID = u.pID)), '{}')
    FROM Listings l
    JOIN Units u ON u.uID = l.uID
    JOIN Property p ON p.pID = u.pID
    WHERE l.status = 'active' AND u.deactivated_at IS NULL AND p.deactivated_at IS NULL
    ORDER BY l.published_at DESC NULLS LAST, l.listingID
$$;

CREATE FUNCTION public_listing_photo(p_listing INT, p_image INT)
RETURNS TABLE (content_type TEXT, data BYTEA)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT i.content_type::TEXT, i.data
    FROM Listings l
    JOIN Units u ON u.uID = l.uID
    JOIN Property_Images i ON i.imgID = p_image AND i.deactivated_at IS NULL AND (i.uID = u.uID OR i.pID = u.pID)
    WHERE l.listingID = p_listing AND l.status = 'active'
$$;

-- An inquiry from the public page. Returns the lead's id, or null when the listing is not listed.
CREATE FUNCTION public_inquire(p_listing INT, p_name TEXT, p_email TEXT, p_phone TEXT, p_message TEXT)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_id INT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM Listings WHERE listingID = p_listing AND status = 'active') THEN RETURN NULL; END IF;
    INSERT INTO Leads (listingID, name, email, phone, message, source)
    VALUES (p_listing, p_name, p_email, p_phone, p_message, 'website')
    RETURNING leadID INTO v_id;
    RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public_listings() FROM PUBLIC;
REVOKE ALL ON FUNCTION public_listing_photo(INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_inquire(INT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_listings() TO summit_app;
GRANT EXECUTE ON FUNCTION public_listing_photo(INT, INT) TO summit_app;
GRANT EXECUTE ON FUNCTION public_inquire(INT, TEXT, TEXT, TEXT, TEXT) TO summit_app;

/* ---- Change log ------------------------------------------------------------------ */
CREATE TRIGGER trg_audit_property AFTER INSERT OR UPDATE OR DELETE ON Property
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('pid');
CREATE TRIGGER trg_audit_units AFTER INSERT OR UPDATE OR DELETE ON Units
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('uid');
CREATE TRIGGER trg_audit_portfolios AFTER INSERT OR UPDATE OR DELETE ON Portfolios
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('portfolio_id');
CREATE TRIGGER trg_audit_tenant_details AFTER INSERT OR UPDATE OR DELETE ON Tenant_Details
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('tid');
CREATE TRIGGER trg_audit_compliance AFTER INSERT OR UPDATE OR DELETE ON Compliance_Settings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER trg_audit_maintenance_notes AFTER INSERT OR UPDATE OR DELETE ON Maintenance_Notes
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('noteid');
CREATE TRIGGER trg_audit_listings AFTER INSERT OR UPDATE OR DELETE ON Listings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('listingid');
CREATE TRIGGER trg_audit_leads AFTER INSERT OR UPDATE OR DELETE ON Leads
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('leadid');
CREATE TRIGGER trg_audit_notifications AFTER INSERT ON Notifications_Sent
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('notid');
-- Files: the row without its bytes (audit_file_change from 007).
CREATE TRIGGER trg_audit_documents AFTER INSERT OR UPDATE OR DELETE ON Documents
    FOR EACH ROW EXECUTE FUNCTION audit_file_change('docid');
CREATE TRIGGER trg_audit_maintenance_attachments AFTER INSERT OR UPDATE OR DELETE ON Maintenance_Attachments
    FOR EACH ROW EXECUTE FUNCTION audit_file_change('attid');

/* ---- Who can see what -------------------------------------------------------------- */
GRANT SELECT, INSERT ON Security_Events TO summit_app;
GRANT SELECT, INSERT, UPDATE ON Portfolios, Tenant_Details, Compliance_Settings, Documents, Listings, Leads TO summit_app;
GRANT SELECT, INSERT ON Maintenance_Notes, Maintenance_Attachments TO summit_app;
GRANT DELETE ON Listings TO summit_app;   -- drafts only (the store checks; a listed one is ended instead)
GRANT SELECT, INSERT ON Notifications_Sent TO summit_app;
GRANT UPDATE (read_at) ON Notifications_Sent TO summit_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO summit_app;

ALTER TABLE Security_Events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE Portfolios              ENABLE ROW LEVEL SECURITY;
ALTER TABLE Tenant_Details          ENABLE ROW LEVEL SECURITY;
ALTER TABLE Compliance_Settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE Maintenance_Notes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE Maintenance_Attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE Documents               ENABLE ROW LEVEL SECURITY;
ALTER TABLE Notifications_Sent      ENABLE ROW LEVEL SECURITY;
ALTER TABLE Listings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE Leads                   ENABLE ROW LEVEL SECURITY;

-- Property managers: everything.
CREATE POLICY admin_read   ON Security_Events         FOR SELECT TO summit_app USING ((SELECT app_is_admin()));
CREATE POLICY admin_insert ON Security_Events         FOR INSERT TO summit_app WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Portfolios              FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Tenant_Details          FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Compliance_Settings     FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Maintenance_Notes       FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Maintenance_Attachments FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Documents               FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Notifications_Sent      FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Listings                FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Leads                   FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));

-- Maintenance staff: the queue's notes and photos, and the teammates it can be assigned to.
CREATE POLICY maint_all ON Maintenance_Notes FOR ALL TO summit_app
    USING ((SELECT app_is_maintenance())) WITH CHECK ((SELECT app_is_maintenance()) AND admin_id = (SELECT app_admin_id()));
CREATE POLICY maint_all ON Maintenance_Attachments FOR ALL TO summit_app
    USING ((SELECT app_is_maintenance())) WITH CHECK ((SELECT app_is_maintenance()) AND admin_id = (SELECT app_admin_id()) AND tID IS NULL);
CREATE POLICY maint_read_staff ON Admin FOR SELECT TO summit_app
    USING ((SELECT app_is_maintenance()) AND deactivated_at IS NULL);

-- Tenants: photos on their own requests, their own notices, and documents the office shared with them.
CREATE POLICY tenant_read_photos ON Maintenance_Attachments FOR SELECT TO summit_app
    USING (EXISTS (SELECT 1 FROM Maintenance_T m WHERE m.mID = Maintenance_Attachments.mID AND m.tID = (SELECT app_tenant_id())));
CREATE POLICY tenant_add_photos ON Maintenance_Attachments FOR INSERT TO summit_app
    WITH CHECK (tID = (SELECT app_tenant_id()) AND admin_id IS NULL
                AND EXISTS (SELECT 1 FROM Maintenance_T m WHERE m.mID = Maintenance_Attachments.mID AND m.tID = (SELECT app_tenant_id())
                            AND m.status NOT IN ('resolved', 'rejected') AND m.deactivated_at IS NULL));
CREATE POLICY tenant_own_notices ON Notifications_Sent FOR SELECT TO summit_app
    USING (tID = (SELECT app_tenant_id()));
CREATE POLICY tenant_mark_read ON Notifications_Sent FOR UPDATE TO summit_app
    USING (tID = (SELECT app_tenant_id())) WITH CHECK (tID = (SELECT app_tenant_id()));
CREATE POLICY tenant_shared_docs ON Documents FOR SELECT TO summit_app
    USING (shared_with_tenant AND hidden_at IS NULL AND (
        tID = (SELECT app_tenant_id())
        OR LeaseID IN (SELECT lt.LeaseID FROM Lease_Tenants lt WHERE lt.tID = (SELECT app_tenant_id()))
        OR uID IN (SELECT l.uID FROM Lease l JOIN Lease_Tenants lt ON lt.LeaseID = l.LeaseID WHERE lt.tID = (SELECT app_tenant_id()))
        OR pID IN (SELECT u.pID FROM Lease l JOIN Lease_Tenants lt ON lt.LeaseID = l.LeaseID JOIN Units u ON u.uID = l.uID
                   WHERE lt.tID = (SELECT app_tenant_id()))));
