-- ---------------------------------------------------------------------------
-- 020  Self-service password reset.
--
-- Until now only the office could issue a new (temporary) password. A person
-- who forgot theirs can now ask for a link by email and set a new one.
--
-- The link carries a random token. Only its SHA-256 hash is stored here, so
-- nobody who can read this table (a backup, a database administrator) can use
-- a pending link. A link:
--   * works once;
--   * expires 30 minutes after it is sent;
--   * stops working when a newer link is sent or the password changes.
--
-- Only the sign-in routes touch this table, in the system context, the same
-- way sign-in reads the users table before anyone is signed in. No signed-in
-- role can read it: not the resident, and not the office.
-- ---------------------------------------------------------------------------

CREATE TABLE password_reset_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  requested_ip    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  -- Set when a newer link is sent, or the password changes some other way.
  revoked_at      timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '2 hours')
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id, created_at DESC);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY password_reset_system_only ON password_reset_tokens
  FOR ALL
  USING (app.is_system_job())
  WITH CHECK (app.is_system_job());

-- No DELETE: a used or expired link stays as the record that a reset happened.
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO portal_app;

-- Any password change (the person's own, a reset link, or a temporary password
-- from the office) cancels every link still waiting. Otherwise an old email
-- sitting in someone's inbox could undo a change made because of a break-in.
CREATE OR REPLACE FUNCTION app.revoke_reset_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    UPDATE password_reset_tokens SET revoked_at = now()
    WHERE user_id = NEW.id AND used_at IS NULL AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_revoke_reset_links
  AFTER UPDATE OF password_hash ON users
  FOR EACH ROW EXECUTE FUNCTION app.revoke_reset_links();
