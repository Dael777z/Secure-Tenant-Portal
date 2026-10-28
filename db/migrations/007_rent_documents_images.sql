/* 005  Rent on the lease's start day, lease documents, and property photos.
   Needs 001-004 first (003 for the maintenance-staff helper).
 
   1. Rent is due on the lease's start day each month: a lease starting on
      the 15th is due on the 15th, and one starting on the 31st is due on the
      last day of shorter months. Same function name, arguments and
      permissions as 002. Rent charges 002 already made are moved to the new
      dates by the UPDATE below; that rewrites due dates, so only do it on
      test data. The function also won't add a second rent charge in a month
      that already has one.
   2. Lease_Documents: the signed lease PDF, one per lease. A renewal is its
      own lease, so it gets its own document.
   3. Property_Images: photos of a property or of one of its units.
 
   Files are stored in the database for now, like Payment_Receipts. Each one
   carries a SHA-256 that the database checks, and the database records who
   uploaded it. List queries should never select the data column. */

/* ---- 1. Rent on the start day ---------------------------------------- */

CREATE OR REPLACE FUNCTION generate_rent_charges(p_today DATE, p_lease INT DEFAULT NULL) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE inserted INT;
BEGIN
    -- COALESCE: with no identity, app_user_type() is NULL and NOT(NULL) would let this through.
    IF NOT COALESCE(app_is_admin() OR app_user_type() = 'system', false) THEN
        RETURN 0;
    END IF;
    INSERT INTO Charge (LeaseID, kind, amount, due_date, description)
    SELECT l.LeaseID, 'rent', l.monthly_rent, d.due_date, 'Rent - ' || to_char(d.due_date, 'FMMonth YYYY')
      FROM Lease l
     CROSS JOIN LATERAL (
            -- start_date + n months, counted from the start date each time
            -- (not month to month), so a lease starting on the 31st doesn't
            -- slide to the 28th for good after February.
            SELECT (l.start_date + n * interval '1 month')::date AS due_date
              FROM generate_series(0, GREATEST(0,
                     ((extract(year FROM p_today) - extract(year FROM l.start_date)) * 12
                      + extract(month FROM p_today) - extract(month FROM l.start_date))::int)) AS n
           ) d
     WHERE (p_lease IS NULL OR l.LeaseID = p_lease)
       AND d.due_date <= p_today
       AND (l.end_date IS NULL OR d.due_date <= l.end_date)
       AND NOT EXISTS (          -- that month is already billed (e.g. by 002's schedule)
              SELECT 1 FROM Charge c
               WHERE c.LeaseID = l.LeaseID AND c.kind = 'rent'
                 AND c.due_date >= date_trunc('month', d.due_date)::date
                 AND c.due_date <  (date_trunc('month', d.due_date) + interval '1 month')::date)
    ON CONFLICT (LeaseID, due_date) WHERE kind = 'rent' DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    RETURN inserted;
END $$;


/* Move rent charges made by 002's schedule onto the start-day schedule.
   A charge in the lease's n-th month goes to start_date + n months, the same
   rule the function uses. Left alone: a charge already on the right date,
   and one whose target date already has a rent charge. If a lease somehow has
   two rent charges in one month, only the earliest is moved and the other
   stays where it is, so the unique index is never hit and the migration
   can't abort; the leftover shows up as a second charge in that month for
   someone to clean up. */
UPDATE Charge c
   SET due_date = t.new_due
  FROM (SELECT chargeID, new_due,
               row_number() OVER (PARTITION BY LeaseID, new_due ORDER BY due_date, chargeID) AS rn
          FROM (SELECT ch.chargeID, ch.LeaseID, ch.due_date,
                       (l.start_date + (((extract(year FROM ch.due_date) - extract(year FROM l.start_date)) * 12
                                         + extract(month FROM ch.due_date) - extract(month FROM l.start_date))::int)
                                       * interval '1 month')::date AS new_due
                  FROM Charge ch
                  JOIN Lease l ON l.LeaseID = ch.LeaseID
                 WHERE ch.kind = 'rent'
                   AND ch.due_date >= date_trunc('month', l.start_date)::date) q) t
 WHERE c.chargeID = t.chargeID
   AND t.rn = 1
   AND c.due_date <> t.new_due
   AND NOT EXISTS (SELECT 1 FROM Charge o
                    WHERE o.LeaseID = c.LeaseID AND o.kind = 'rent' AND o.due_date = t.new_due);


/* ---- 2. Lease_Documents ----------------------------------------------------
   One PDF per lease (the key is the lease itself). An admin can upload again
   to replace a bad scan; the checksum and uploaded_by show it changed, and
   the audit log records the change without the file. The database checks
   that the checksum and size match the bytes it was given. */
CREATE TABLE Lease_Documents (
    LeaseID       INT PRIMARY KEY REFERENCES Lease(LeaseID) ON DELETE RESTRICT,
    filename      VARCHAR(200) NOT NULL,
    content_type  VARCHAR(40) NOT NULL CHECK (content_type = 'application/pdf'),
    size_bytes    INT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),   -- 25 MB
    sha256_hex    CHAR(64) NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
    data          BYTEA NOT NULL,
    uploaded_by   INT REFERENCES Admin(admin_id),
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (octet_length(data) = size_bytes),
    CHECK (sha256_hex = encode(sha256(data), 'hex'))
);

/* ---- 3. Property_Images ----------------------------------------------------
   Many photos per property or unit. Each row belongs to exactly one of the
   two. sort_order is the display order (lowest is the cover). Photos are
   hidden with deactivated_at, never deleted. */
CREATE TABLE Property_Images (
    imgID           SERIAL PRIMARY KEY,
    pID             INT REFERENCES Property(pID) ON DELETE RESTRICT,
    uID             INT REFERENCES Units(uID)    ON DELETE RESTRICT,
    filename        VARCHAR(200) NOT NULL,
    content_type    VARCHAR(40) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    size_bytes      INT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),   -- 5 MB
    sha256_hex      CHAR(64) NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
    data            BYTEA NOT NULL,
    caption         VARCHAR(200),
    sort_order      INT NOT NULL DEFAULT 0,
    uploaded_by     INT REFERENCES Admin(admin_id),
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deactivated_at  TIMESTAMPTZ,
    CHECK (num_nonnulls(pID, uID) = 1),                    -- a property photo or a unit photo, never both
    CHECK (octet_length(data) = size_bytes),
    CHECK (sha256_hex = encode(sha256(data), 'hex'))
);
CREATE INDEX idx_images_property ON Property_Images (pID, sort_order) WHERE pID IS NOT NULL;
CREATE INDEX idx_images_unit     ON Property_Images (uID, sort_order) WHERE uID IS NOT NULL;

/* ---- Who uploaded it is set by the database, not by the caller --------------
   uploaded_by and uploaded_at come from the signed-in admin and the clock,
   whatever the app sends. They change only when the file itself is replaced.
   Hiding a photo or editing a caption leaves them alone, and nobody can
   rewrite them directly. (app_admin_id() is from 003.) */
CREATE FUNCTION set_file_uploader() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.data IS NOT DISTINCT FROM OLD.data THEN
        NEW.uploaded_by := OLD.uploaded_by;
        NEW.uploaded_at := OLD.uploaded_at;
    ELSE
        NEW.uploaded_by := app_admin_id();
        NEW.uploaded_at := now();
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_lease_documents_uploader BEFORE INSERT OR UPDATE ON Lease_Documents
    FOR EACH ROW EXECUTE FUNCTION set_file_uploader();
CREATE TRIGGER trg_property_images_uploader BEFORE INSERT OR UPDATE ON Property_Images
    FOR EACH ROW EXECUTE FUNCTION set_file_uploader();

/* ---- Audit: who uploaded what, never the file --------------------------------
   Same as audit_row_change() from 001, except the secret it removes is the
   file data. (A 25 MB PDF in the audit log would be a bad day.) */
CREATE FUNCTION audit_file_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    old_j JSONB;
    new_j JSONB;
    src   JSONB;
    pk    TEXT := '';
    k     TEXT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN old_j := to_jsonb(OLD) - 'data'; END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN new_j := to_jsonb(NEW) - 'data'; END IF;
    src := COALESCE(new_j, old_j);
    FOREACH k IN ARRAY TG_ARGV LOOP
        pk := pk || CASE WHEN pk = '' THEN '' ELSE ':' END || COALESCE(src ->> k, '');
    END LOOP;
    INSERT INTO audit_log (table_name, row_pk, action, old_data, new_data, changed_by)
    VALUES (
        TG_TABLE_NAME, pk, TG_OP, old_j, new_j,
        COALESCE(
            NULLIF(concat_ws(':',
                NULLIF(current_setting('app.user_type', true), ''),
                NULLIF(current_setting('app.user_id',   true), '')), ''),
            session_user::TEXT)
    );
    RETURN NULL;
END $$;

CREATE TRIGGER trg_audit_lease_documents AFTER INSERT OR UPDATE OR DELETE ON Lease_Documents
    FOR EACH ROW EXECUTE FUNCTION audit_file_change('leaseid');
CREATE TRIGGER trg_audit_property_images AFTER INSERT OR UPDATE OR DELETE ON Property_Images
    FOR EACH ROW EXECUTE FUNCTION audit_file_change('imgid');

/* ---- Access ---------------------------------------------------------------- */
GRANT SELECT, INSERT, UPDATE ON Lease_Documents TO summit_app;
GRANT SELECT, INSERT, UPDATE ON Property_Images TO summit_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO summit_app;

ALTER TABLE Lease_Documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE Property_Images ENABLE ROW LEVEL SECURITY;

-- Admins: everything.
CREATE POLICY admin_all ON Lease_Documents FOR ALL TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Property_Images FOR ALL TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));

-- A tenant reads the documents of leases they are on. Maintenance staff see none.
CREATE POLICY tenant_read_lease_docs ON Lease_Documents FOR SELECT TO summit_app
    USING (LeaseID IN (SELECT LeaseID FROM Lease_Tenants WHERE tID = (SELECT app_tenant_id())));

-- A tenant sees photos of their own property and unit. The subqueries are
-- themselves subject to the tenant rules on Units and Property, so they only
-- find the ones that tenant is allowed to see. Hidden photos stay hidden.
CREATE POLICY tenant_read_images ON Property_Images FOR SELECT TO summit_app
    USING (deactivated_at IS NULL AND (
              EXISTS (SELECT 1 FROM Units u    WHERE u.uID = Property_Images.uID)
           OR EXISTS (SELECT 1 FROM Property p WHERE p.pID = Property_Images.pID)));

-- Maintenance staff can see photos (useful on a repair), not lease documents.
CREATE POLICY maint_read_images ON Property_Images FOR SELECT TO summit_app
    USING ((SELECT app_is_maintenance()) AND deactivated_at IS NULL);

COMMENT ON TABLE Lease_Documents IS 'The signed lease PDF, one per lease. Checksum verified by the database.';
COMMENT ON TABLE Property_Images IS 'Photos of a property or a unit. Hidden with deactivated_at, never deleted.';