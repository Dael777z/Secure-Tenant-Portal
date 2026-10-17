/* 002  What the portal adds to the database dev's schema (001).
   Additive only: no 001 table changes meaning, no 001 policy is edited.
   Every new table has RLS on; summit_app gets the fewest grants that work.
   Each section says why it is needed. */

/* ---- Sessions: hashed refresh tokens --------------------------------------
   RLS on, no policy, no grant: reached only through the functions below. */
CREATE TABLE Refresh_Tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tID         INT REFERENCES Tenants(tID) ON DELETE CASCADE,
    admin_id    INT REFERENCES Admin(admin_id) ON DELETE CASCADE,
    token_hash  VARCHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),   -- SHA-256 hex
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(tID, admin_id) = 1)                                          -- exactly one owner
);
CREATE INDEX idx_refresh_tenant ON Refresh_Tokens(tID)      WHERE tID IS NOT NULL;
CREATE INDEX idx_refresh_admin  ON Refresh_Tokens(admin_id) WHERE admin_id IS NOT NULL;
CREATE INDEX idx_refresh_expiry ON Refresh_Tokens(expires_at);
ALTER TABLE Refresh_Tokens ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION auth_store_refresh_token(p_user_type TEXT, p_user_id INT, p_token_hash TEXT, p_expires_at TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_user_type = 'tenant' THEN
        INSERT INTO Refresh_Tokens (tID, token_hash, expires_at) VALUES (p_user_id, p_token_hash, p_expires_at);
    ELSIF p_user_type = 'admin' THEN
        INSERT INTO Refresh_Tokens (admin_id, token_hash, expires_at) VALUES (p_user_id, p_token_hash, p_expires_at);
    ELSE
        RAISE EXCEPTION 'unknown user type %', p_user_type USING ERRCODE = 'invalid_parameter_value';
    END IF;
END $$;

-- Use a token up (one statement, so two racing requests cannot both win) and say whose it was.
-- Nothing comes back for an unknown, used or expired token, or a deactivated / not-signed-up account.
CREATE FUNCTION auth_consume_refresh_token(p_token_hash TEXT)
RETURNS TABLE (user_type TEXT, user_id INT, email TEXT, role TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH used AS (
        UPDATE Refresh_Tokens SET revoked = true
         WHERE token_hash = p_token_hash AND NOT revoked AND expires_at > now()
        RETURNING tID, admin_id
    )
    SELECT 'tenant'::TEXT, t.tID, t.Email::TEXT, 'tenant'::TEXT
      FROM used u JOIN Tenants t ON t.tID = u.tID
     WHERE t.deactivated_at IS NULL AND t.signup_completed
    UNION ALL
    SELECT 'admin'::TEXT, a.admin_id, a.email::TEXT, a.role::TEXT
      FROM used u JOIN Admin a ON a.admin_id = u.admin_id
     WHERE a.deactivated_at IS NULL
$$;

CREATE FUNCTION auth_revoke_refresh_token(p_token_hash TEXT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE Refresh_Tokens SET revoked = true WHERE token_hash = p_token_hash AND NOT revoked
$$;

-- "Sign out everywhere": the account itself or an admin; anyone else changes nothing.
CREATE FUNCTION auth_revoke_all_tokens(p_user_type TEXT, p_user_id INT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NOT (app_is_admin() OR (app_user_type() = p_user_type
            AND NULLIF(current_setting('app.user_id', true), '')::INT = p_user_id)) THEN
        RETURN;
    END IF;
    UPDATE Refresh_Tokens SET revoked = true
     WHERE NOT revoked AND ((p_user_type = 'tenant' AND tID = p_user_id) OR (p_user_type = 'admin' AND admin_id = p_user_id));
END $$;

/* ---- Soft deletes and a maintenance title ---------------------------------- */
ALTER TABLE Maintenance_T
    ADD COLUMN title          VARCHAR(120) NOT NULL DEFAULT 'Maintenance request',
    ADD COLUMN deactivated_at TIMESTAMPTZ;
ALTER TABLE Property ADD COLUMN deactivated_at TIMESTAMPTZ;

/* ---- Monthly rent ------------------------------------------------------------
   One rent charge per lease per due date, so re-running can never double-bill.
   First month due on the start date, later months on the 1st, up to today and
   not past end_date. Admin or 'system' only (system has no policy on Charge). */
CREATE UNIQUE INDEX charge_one_rent_per_due_date ON Charge (LeaseID, due_date) WHERE kind = 'rent';

CREATE FUNCTION generate_rent_charges(p_today DATE, p_lease INT DEFAULT NULL) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE inserted INT;
BEGIN
    -- COALESCE: with no identity, app_user_type() is NULL and NOT(NULL) would let this through.
    IF NOT COALESCE(app_is_admin() OR app_user_type() = 'system', false) THEN
        RETURN 0;
    END IF;
    INSERT INTO Charge (LeaseID, kind, amount, due_date, description)
    SELECT d.LeaseID, 'rent', d.monthly_rent, d.due_date, 'Rent - ' || to_char(d.due_date, 'FMMonth YYYY')
      FROM (SELECT l.LeaseID, l.monthly_rent, l.end_date,
                   CASE WHEN m.month_start::date <= l.start_date THEN l.start_date ELSE m.month_start::date END AS due_date
              FROM Lease l
             CROSS JOIN LATERAL generate_series(date_trunc('month', l.start_date::timestamp), p_today::timestamp, interval '1 month') AS m(month_start)
             WHERE p_lease IS NULL OR l.LeaseID = p_lease) d
     WHERE d.due_date <= p_today AND (d.end_date IS NULL OR d.due_date <= d.end_date)
    ON CONFLICT (LeaseID, due_date) WHERE kind = 'rent' DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    RETURN inserted;
END $$;

/* ---- Payment_Details: method and payer (Payment itself stays untouched) ---- */
CREATE TABLE Payment_Details (
    payID   INT PRIMARY KEY REFERENCES Payment(payID) ON DELETE RESTRICT,
    tID     INT REFERENCES Tenants(tID) ON DELETE SET NULL,   -- null: the office could not attribute it
    method  VARCHAR(60) NOT NULL
);
CREATE INDEX idx_payment_details_tid ON Payment_Details(tID) WHERE tID IS NOT NULL;
ALTER TABLE Payment_Details ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON Payment_Details TO summit_app;              -- append-only, like Payment
CREATE POLICY admin_all ON Payment_Details FOR ALL TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY system_insert ON Payment_Details FOR INSERT TO summit_app  -- tenant payments are written as 'system'
    WITH CHECK ((SELECT app_user_type()) = 'system');
CREATE POLICY tenant_read ON Payment_Details FOR SELECT TO summit_app    -- visible when the payment is
    USING (EXISTS (SELECT 1 FROM Payment p WHERE p.payID = Payment_Details.payID));
CREATE TRIGGER trg_audit_payment_details AFTER INSERT OR UPDATE OR DELETE ON Payment_Details
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('payid');

/* ---- Payment_Receipts: a photo/PDF of an office payment. Staff only; not audited (the file would land in audit_log). */
CREATE TABLE Payment_Receipts (
    payID         INT PRIMARY KEY REFERENCES Payment(payID) ON DELETE RESTRICT,
    filename      VARCHAR(200) NOT NULL,
    content_type  VARCHAR(40) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
    size_bytes    INT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 4194304),   -- 4 MB
    data          BYTEA NOT NULL,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE Payment_Receipts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON Payment_Receipts TO summit_app;
CREATE POLICY admin_all ON Payment_Receipts FOR ALL TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));

/* ---- Bank_Accounts: Plaid links. The tenant's own rows only; staff get no access to the encrypted token. */
CREATE TABLE Bank_Accounts (
    bID               SERIAL PRIMARY KEY,
    tID               INT NOT NULL REFERENCES Tenants(tID) ON DELETE RESTRICT,
    plaid_item_id     VARCHAR(100) NOT NULL,
    plaid_account_id  VARCHAR(100) NOT NULL,
    access_token_enc  TEXT NOT NULL,                     -- AES-256-GCM
    name              VARCHAR(120) NOT NULL,
    mask              VARCHAR(4),
    subtype           VARCHAR(40),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tID, plaid_account_id)
);
CREATE INDEX idx_bank_accounts_tid ON Bank_Accounts(tID);
ALTER TABLE Bank_Accounts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON Bank_Accounts TO summit_app;
CREATE POLICY tenant_own_banks ON Bank_Accounts FOR ALL TO summit_app
    USING (tID = (SELECT app_tenant_id())) WITH CHECK (tID = (SELECT app_tenant_id()));

/* ---- Function and sequence grants ------------------------------------------ */
REVOKE ALL ON FUNCTION auth_store_refresh_token(TEXT, INT, TEXT, TIMESTAMPTZ), auth_consume_refresh_token(TEXT),
    auth_revoke_refresh_token(TEXT), auth_revoke_all_tokens(TEXT, INT), generate_rent_charges(DATE, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_store_refresh_token(TEXT, INT, TEXT, TIMESTAMPTZ), auth_consume_refresh_token(TEXT),
    auth_revoke_refresh_token(TEXT), auth_revoke_all_tokens(TEXT, INT), generate_rent_charges(DATE, INT) TO summit_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO summit_app;
