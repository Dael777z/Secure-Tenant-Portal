/* 013  Zelle gets what Cash App got in 012, and the confirmation number becomes optional.

   1. Office_Settings.zelle_phone: the office's Zelle can show an email address
      and a phone number. zelle_handle (006) held either; from here on it is
      the email, and a phone number already stored there moves to zelle_phone.
   2. Office_Settings.require_payment_ref: whether a tenant must type the
      payment's confirmation number when they report a Cash App / Zelle
      payment. Off by default: the screenshot is always required, the number
      is recommended. The property manager switches it in Settings.
   3. Office_Payment_Qr: one QR code image per method ('cashapp', 'zelle').
      It replaces Office_Cashapp_Qr (012), whose row is carried over. */

/* ---- 1 and 2. The office's settings ---- */

ALTER TABLE Office_Settings
    ADD COLUMN zelle_phone          VARCHAR(40) CHECK (zelle_phone IS NULL OR length(btrim(zelle_phone)) > 0),
    ADD COLUMN require_payment_ref  BOOLEAN NOT NULL DEFAULT false;
GRANT UPDATE (zelle_phone, require_payment_ref) ON Office_Settings TO summit_app;

-- A phone number stored as the Zelle handle becomes the Zelle phone.
UPDATE Office_Settings SET zelle_phone = zelle_handle, zelle_handle = NULL
 WHERE zelle_handle IS NOT NULL AND position('@' IN zelle_handle) = 0;

/* ---- 3. One QR code per method ---- */

CREATE TABLE Office_Payment_Qr (
    method        VARCHAR(10) PRIMARY KEY CHECK (method IN ('cashapp', 'zelle')),
    filename      VARCHAR(200) NOT NULL,
    content_type  VARCHAR(40) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    size_bytes    INT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),   -- 5 MB
    data          BYTEA NOT NULL,
    uploaded_by   INT REFERENCES Admin(admin_id),
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (octet_length(data) = size_bytes)
);

INSERT INTO Office_Payment_Qr (method, filename, content_type, size_bytes, data, uploaded_by, uploaded_at)
SELECT 'cashapp', filename, content_type, size_bytes, data, uploaded_by, uploaded_at FROM Office_Cashapp_Qr;
DROP TABLE Office_Cashapp_Qr;

CREATE TRIGGER trg_audit_office_payment_qr AFTER INSERT OR UPDATE OR DELETE ON Office_Payment_Qr
    FOR EACH ROW EXECUTE FUNCTION audit_file_change('method');

ALTER TABLE Office_Payment_Qr ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON Office_Payment_Qr TO summit_app;
CREATE POLICY admin_all ON Office_Payment_Qr FOR ALL TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
-- Tenants see the codes to pay (they are what the office gives out anyway).
CREATE POLICY tenant_read ON Office_Payment_Qr FOR SELECT TO summit_app
    USING ((SELECT app_tenant_id()) IS NOT NULL);
