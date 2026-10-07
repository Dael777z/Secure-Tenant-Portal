-- ---------------------------------------------------------------------------
-- 002  What sign-in needs, as agreed in Discord on 10/1/2026.
--
--   * Angel: keep Tenants and Admin as separate tables; roles live on the
--     Admin side.
--   * Scott + Angel: the office adds a tenant first; the tenant can only sign
--     up if they already exist. So a tenant row starts without a password, and
--     a check makes "signed up without a password" impossible.
--   * Scott's skeleton keeps refresh tokens in a session store; this is that
--     table. Only a SHA-256 hash of each token is stored.
-- ---------------------------------------------------------------------------

-- Tenants: invited first, password set at sign-up.
ALTER TABLE Tenants ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE Tenants ADD COLUMN signed_up BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE Tenants ADD CONSTRAINT tenants_signed_up_has_password
  CHECK (NOT signed_up OR password_hash IS NOT NULL);

-- Admin roles. The values are the staff roles in Scott's skeleton
-- (src/types/interfaces.ts); "tenant" is the Tenants table itself.
ALTER TABLE Admin ADD COLUMN role VARCHAR(30) NOT NULL DEFAULT 'property_manager'
  CHECK (role IN ('platform_admin', 'property_manager', 'maintenance_staff'));

-- Emails are stored the way the backend looks them up: trimmed and lower case.
ALTER TABLE Tenants ADD CONSTRAINT tenants_email_normalized CHECK (Email = lower(btrim(Email)));
ALTER TABLE Admin ADD CONSTRAINT admin_email_normalized CHECK (email = lower(btrim(email)));

-- One email, one account. UNIQUE covers each table; this covers both together,
-- so sign-in never has to guess whether an address is a tenant or staff.
CREATE FUNCTION email_not_used_elsewhere() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'tenants' AND EXISTS (SELECT 1 FROM Admin WHERE email = NEW.Email) THEN
    RAISE EXCEPTION 'email % already belongs to a staff account', NEW.Email USING ERRCODE = '23505';
  END IF;
  IF TG_TABLE_NAME = 'admin' AND EXISTS (SELECT 1 FROM Tenants WHERE Email = NEW.email) THEN
    RAISE EXCEPTION 'email % already belongs to a tenant account', NEW.email USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_email_unique_across BEFORE INSERT OR UPDATE OF Email ON Tenants
  FOR EACH ROW EXECUTE FUNCTION email_not_used_elsewhere();
CREATE TRIGGER admin_email_unique_across BEFORE INSERT OR UPDATE OF email ON Admin
  FOR EACH ROW EXECUTE FUNCTION email_not_used_elsewhere();

-- Refresh tokens (Scott's SessionRepository). Exactly one owner: a tenant or
-- an admin. Deleting the account deletes its sessions.
CREATE TABLE Refresh_Tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tID         INT REFERENCES Tenants(tID) ON DELETE CASCADE,
  admin_id    INT REFERENCES Admin(admin_id) ON DELETE CASCADE,
  token_hash  CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(tID, admin_id) = 1)
);

CREATE INDEX refresh_tokens_tenant_idx ON Refresh_Tokens (tID) WHERE tID IS NOT NULL;
CREATE INDEX refresh_tokens_admin_idx ON Refresh_Tokens (admin_id) WHERE admin_id IS NOT NULL;
