/* 006  Juan's tenant side (tenant-side-ui 23d7a8e), made real.
   Additive, like 002–005: no earlier table or policy is edited.

   1. Cash App and Zelle. Neither has an API we can use, so the tenant sends
      the money in their own app and tells the portal ("I've sent it"). That
      is recorded as a Payment with status 'pending' (it does not move the
      balance: lease_balance counts 'completed' only) plus a Reported_Payments
      row. The office checks its account, then confirms it (status
      'completed') or rejects it (status 'failed', with a reason the tenant
      sees). Payment_Reviews keeps who decided and when. Nothing is deleted.
   2. Office_Settings: the office's own Cash App $cashtag and Zelle address,
      edited by the property manager (not an environment variable).
   3. Tenant_Notification_Prefs: which emails a tenant wants (email only).
   4. tenant_update_own_profile(): a tenant edits their own name and phone,
      nothing else (sign-in email and password stay with their own flows). */

/* ---- 1. Reported Cash App / Zelle payments ---- */

CREATE TABLE Reported_Payments (
    payID        INT PRIMARY KEY REFERENCES Payment(payID) ON DELETE RESTRICT,
    method       VARCHAR(10) NOT NULL CHECK (method IN ('cashapp', 'zelle')),
    reported_by  INT NOT NULL REFERENCES Tenants(tID) ON DELETE RESTRICT,
    reported_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reported_by ON Reported_Payments(reported_by);
CREATE TRIGGER trg_audit_reported_payments AFTER INSERT OR UPDATE OR DELETE ON Reported_Payments
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('payid');

ALTER TABLE Reported_Payments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON Reported_Payments TO summit_app;           -- append-only
-- Written as 'system' together with the Payment row (tenants never write the ledger).
CREATE POLICY system_reported ON Reported_Payments FOR ALL TO summit_app
    USING ((SELECT app_user_type()) = 'system') WITH CHECK ((SELECT app_user_type()) = 'system');
CREATE POLICY admin_read ON Reported_Payments FOR SELECT TO summit_app USING ((SELECT app_is_admin()));
-- A tenant sees reports on payments they can see (their own leases, through Payment's rules).
CREATE POLICY tenant_read ON Reported_Payments FOR SELECT TO summit_app
    USING ((SELECT app_tenant_id()) IS NOT NULL AND payID IN (SELECT payID FROM Payment));

CREATE TABLE Payment_Reviews (
    payID        INT PRIMARY KEY REFERENCES Reported_Payments(payID) ON DELETE RESTRICT,
    decision     VARCHAR(10) NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
    reason       VARCHAR(300),
    reviewed_by  INT NOT NULL REFERENCES Admin(admin_id),
    reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (decision = 'confirmed' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);
CREATE TRIGGER trg_audit_payment_reviews AFTER INSERT OR UPDATE OR DELETE ON Payment_Reviews
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('payid');

ALTER TABLE Payment_Reviews ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON Payment_Reviews TO summit_app;             -- one decision per report, kept
CREATE POLICY admin_all ON Payment_Reviews FOR ALL TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY tenant_read ON Payment_Reviews FOR SELECT TO summit_app
    USING ((SELECT app_tenant_id()) IS NOT NULL AND payID IN (SELECT payID FROM Payment));

/* ---- 2. The office's payment handles (one row) ---- */

CREATE TABLE Office_Settings (
    id              BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    -- A Cash App $cashtag: $ then a letter, then up to 19 letters, digits, - or _.
    cashapp_handle  VARCHAR(21) CHECK (cashapp_handle ~ '^\$[A-Za-z][A-Za-z0-9_-]{0,19}$'),
    -- The email address or US phone number the office's Zelle is enrolled with.
    zelle_handle    VARCHAR(120) CHECK (zelle_handle IS NULL OR length(btrim(zelle_handle)) > 0),
    updated_by      INT REFERENCES Admin(admin_id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO Office_Settings (id) VALUES (true);
CREATE TRIGGER trg_audit_office_settings AFTER INSERT OR UPDATE OR DELETE ON Office_Settings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

ALTER TABLE Office_Settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON Office_Settings TO summit_app;
GRANT UPDATE (cashapp_handle, zelle_handle, updated_by, updated_at) ON Office_Settings TO summit_app;
CREATE POLICY admin_all ON Office_Settings FOR ALL TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
-- Tenants read the handles to pay (they are what the office gives out anyway).
CREATE POLICY tenant_read ON Office_Settings FOR SELECT TO summit_app
    USING ((SELECT app_tenant_id()) IS NOT NULL);

/* ---- 3. Email notification choices (email only; no text messages) ---- */

CREATE TABLE Tenant_Notification_Prefs (
    tID               INT PRIMARY KEY REFERENCES Tenants(tID) ON DELETE RESTRICT,
    rent_due          BOOLEAN NOT NULL DEFAULT true,
    payment_receipts  BOOLEAN NOT NULL DEFAULT true,
    maintenance       BOOLEAN NOT NULL DEFAULT true,
    messages          BOOLEAN NOT NULL DEFAULT true,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE Tenant_Notification_Prefs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON Tenant_Notification_Prefs TO summit_app;
CREATE POLICY tenant_own ON Tenant_Notification_Prefs FOR ALL TO summit_app
    USING (tID = (SELECT app_tenant_id())) WITH CHECK (tID = (SELECT app_tenant_id()));
CREATE POLICY admin_read ON Tenant_Notification_Prefs FOR SELECT TO summit_app USING ((SELECT app_is_admin()));

/* ---- 4. A tenant edits their own name and phone ---- */

-- Tenants can only read their row (tenant_self). This changes exactly two
-- columns of exactly their row; the Tenants audit trigger records it.
CREATE FUNCTION tenant_update_own_profile(p_name TEXT, p_phone TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    me INT := app_tenant_id();
BEGIN
    IF me IS NULL OR p_name IS NULL OR length(btrim(p_name)) = 0 OR length(p_name) > 255
       OR (p_phone IS NOT NULL AND length(p_phone) > 40) THEN
        RETURN false;
    END IF;
    UPDATE Tenants SET Name = btrim(p_name), Phone = NULLIF(btrim(p_phone), '')
     WHERE tID = me AND deactivated_at IS NULL;
    RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION tenant_update_own_profile(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_update_own_profile(TEXT, TEXT) TO summit_app;
