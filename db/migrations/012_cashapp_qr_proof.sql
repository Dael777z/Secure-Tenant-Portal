/* 012  Cash App: the office's QR code, and proof of a reported payment.
   Additive, like 002-011: no earlier table or policy is edited.

   1. Office_Cashapp_Qr: one image (the QR code from the office's Cash App)
      the property manager uploads. Tenants see it on Pay rent, above the
      $cashtag they can still copy.
   2. Reported_Payments.transaction_ref: what the tenant's Cash App shows for
      the payment (its identifier), typed in when they report it.
   3. Reported_Payment_Proofs: the tenant's screenshot of that payment. The
      office looks at it before confirming or rejecting the report.

   The files live in their own tables with audit_file_change() (007), so the
   audit log records who uploaded what and never the bytes. */

/* ---- 1. The office's Cash App QR code (one row) ---- */

CREATE TABLE Office_Cashapp_Qr (
    id            BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    filename      VARCHAR(200) NOT NULL,
    content_type  VARCHAR(40) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    size_bytes    INT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),   -- 5 MB
    data          BYTEA NOT NULL,
    uploaded_by   INT REFERENCES Admin(admin_id),
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (octet_length(data) = size_bytes)
);
CREATE TRIGGER trg_audit_office_cashapp_qr AFTER INSERT OR UPDATE OR DELETE ON Office_Cashapp_Qr
    FOR EACH ROW EXECUTE FUNCTION audit_file_change('id');

ALTER TABLE Office_Cashapp_Qr ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON Office_Cashapp_Qr TO summit_app;
CREATE POLICY admin_all ON Office_Cashapp_Qr FOR ALL TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
-- Tenants see the code to pay (it is what the office gives out anyway).
CREATE POLICY tenant_read ON Office_Cashapp_Qr FOR SELECT TO summit_app
    USING ((SELECT app_tenant_id()) IS NOT NULL);

/* ---- 2. The payment's identifier in the tenant's app ---- */

ALTER TABLE Reported_Payments
    ADD COLUMN transaction_ref VARCHAR(120) CHECK (transaction_ref IS NULL OR length(btrim(transaction_ref)) > 0);

/* ---- 3. The tenant's screenshot of the payment ---- */

CREATE TABLE Reported_Payment_Proofs (
    payID         INT PRIMARY KEY REFERENCES Reported_Payments(payID) ON DELETE RESTRICT,
    filename      VARCHAR(200) NOT NULL,
    content_type  VARCHAR(40) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    size_bytes    INT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),   -- 5 MB
    sha256_hex    CHAR(64) NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
    data          BYTEA NOT NULL,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (octet_length(data) = size_bytes),
    CHECK (sha256_hex = encode(sha256(data), 'hex'))
);
CREATE TRIGGER trg_audit_reported_payment_proofs AFTER INSERT OR UPDATE OR DELETE ON Reported_Payment_Proofs
    FOR EACH ROW EXECUTE FUNCTION audit_file_change('payid');

ALTER TABLE Reported_Payment_Proofs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON Reported_Payment_Proofs TO summit_app;      -- append-only, like the report
-- Written as 'system' together with the Payment and Reported_Payments rows.
CREATE POLICY system_proofs ON Reported_Payment_Proofs FOR ALL TO summit_app
    USING ((SELECT app_user_type()) = 'system') WITH CHECK ((SELECT app_user_type()) = 'system');
CREATE POLICY admin_read ON Reported_Payment_Proofs FOR SELECT TO summit_app USING ((SELECT app_is_admin()));
-- A tenant sees proof on payments they can see (their own leases, through Payment's rules).
CREATE POLICY tenant_read ON Reported_Payment_Proofs FOR SELECT TO summit_app
    USING ((SELECT app_tenant_id()) IS NOT NULL AND payID IN (SELECT payID FROM Payment));
