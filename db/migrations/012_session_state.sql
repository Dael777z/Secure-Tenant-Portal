/* 012  An access token stops working the moment its account changes.
   Needs 001-011. Adds a column, two triggers and one function; nothing earlier is edited.

   Before this, deactivating a teammate, resetting their sign-in or changing
   their role revoked their refresh tokens only. The access token they already
   held (a signed JWT, good for up to 15 minutes) kept working, with the role
   it was issued with, because the app trusted its claims without looking at
   the account. A deactivated property manager could use that window to invite
   a new property manager and keep access for good.

   Now every access token carries the account's token_version, and the app
   asks auth_session_state() on every request: the account must still be
   active and signed up, with the same role and the same token_version.

   1. token_version on Admin and Tenants. A trigger raises it whenever the
      account is deactivated (or reactivated), has its sign-in reset, or (staff)
      changes role. It is a trigger so that no code path, present or future,
      can make one of those changes and forget to end the sessions. The version
      (not just "is the account active") is what keeps an old token dead after
      a reset account signs up again.
   2. auth_session_state(): the per-request check. */

/* ---- 1. Token versions --------------------------------------------------------- */
ALTER TABLE Admin   ADD COLUMN token_version INT NOT NULL DEFAULT 0;
ALTER TABLE Tenants ADD COLUMN token_version INT NOT NULL DEFAULT 0;

CREATE FUNCTION bump_admin_token_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
       OR NEW.role IS DISTINCT FROM OLD.role
       OR (OLD.signup_completed AND NOT NEW.signup_completed) THEN   -- sign-in reset
        NEW.token_version := OLD.token_version + 1;
    ELSE
        NEW.token_version := OLD.token_version;                      -- nothing else moves it, in either direction
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION bump_tenant_token_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
       OR (OLD.signup_completed AND NOT NEW.signup_completed) THEN
        NEW.token_version := OLD.token_version + 1;
    ELSE
        NEW.token_version := OLD.token_version;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_admin_token_version BEFORE UPDATE ON Admin
    FOR EACH ROW EXECUTE FUNCTION bump_admin_token_version();
CREATE TRIGGER trg_tenants_token_version BEFORE UPDATE ON Tenants
    FOR EACH ROW EXECUTE FUNCTION bump_tenant_token_version();

/* ---- 2. The per-request check ---------------------------------------------------
   Called before the request has an identity (it is how the identity is
   confirmed), so, like the other auth_* functions, it runs as its owner.
   One row for an account that may use the portal right now; none for an
   unknown, deactivated or not-signed-up account. */
CREATE FUNCTION auth_session_state(p_user_type TEXT, p_user_id INT)
RETURNS TABLE (role TEXT, token_version INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT 'tenant'::TEXT, t.token_version
      FROM Tenants t
     WHERE p_user_type = 'tenant' AND t.tID = p_user_id
       AND t.deactivated_at IS NULL AND t.signup_completed
    UNION ALL
    SELECT a.role::TEXT, a.token_version
      FROM Admin a
     WHERE p_user_type = 'admin' AND a.admin_id = p_user_id
       AND a.deactivated_at IS NULL AND a.signup_completed
$$;

REVOKE ALL ON FUNCTION auth_session_state(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_session_state(TEXT, INT) TO summit_app;
