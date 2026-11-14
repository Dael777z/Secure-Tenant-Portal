/* 013  Two-step sign-in for staff, and a 30-day limit on staff sessions.
   Needs 001-012. Adds two columns and two functions, and replaces the two
   refresh-token functions of 002 (same behaviour, one more value each).

   1. Two-step sign-in (TOTP). 001 already has Admin.mfa_secret_encrypted and
      mfa_enabled. The app encrypts the secret and checks the 6-digit code; the
      database keeps the secret and remembers the last code step that was
      accepted, so a code works once (someone who watched it being typed
      cannot use it again in the same 30 seconds).
   2. Sessions remember when they started. A refresh token is swapped for a
      new one on every use, so "started" has to travel from token to token;
      the app ends a staff session 30 days after its sign-in.
   3. Two more kinds of entry on the Activity page. */

/* ---- 1. Two-step sign-in ------------------------------------------------------- */
ALTER TABLE Admin ADD COLUMN mfa_last_step BIGINT;

/* Both run before anyone is signed in (the caller has just proved the password),
   so, like the other auth_* functions, they run as their owner. */

-- Start (or restart) setup: keep the new secret. Only while two-step sign-in is off;
-- once it is on, a new phone needs a property manager's "Reset sign-in".
CREATE FUNCTION auth_mfa_begin(p_admin_id INT, p_secret_encrypted TEXT) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH done AS (
        UPDATE Admin SET mfa_secret_encrypted = p_secret_encrypted
         WHERE admin_id = p_admin_id AND NOT mfa_enabled AND deactivated_at IS NULL AND signup_completed
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM done)
$$;

-- A correct code was typed for step p_step. False when that step (or a later one) was
-- already used. One UPDATE, so two racing requests with the same code cannot both win.
-- The first accepted code is also what turns two-step sign-in on.
CREATE FUNCTION auth_mfa_accept(p_admin_id INT, p_step BIGINT) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH done AS (
        UPDATE Admin SET mfa_enabled = true, mfa_last_step = p_step
         WHERE admin_id = p_admin_id AND mfa_secret_encrypted IS NOT NULL AND deactivated_at IS NULL
           AND (mfa_last_step IS NULL OR mfa_last_step < p_step)
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM done)
$$;

REVOKE ALL ON FUNCTION auth_mfa_begin(INT, TEXT), auth_mfa_accept(INT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_mfa_begin(INT, TEXT), auth_mfa_accept(INT, BIGINT) TO summit_app;

/* ---- 2. When a session started --------------------------------------------------- */
-- Sessions open right now count as started now.
ALTER TABLE Refresh_Tokens ADD COLUMN session_started_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP FUNCTION auth_store_refresh_token(TEXT, INT, TEXT, TIMESTAMPTZ);
DROP FUNCTION auth_consume_refresh_token(TEXT);

-- As in 002. p_session_started_at is null for a new sign-in, and the old token's for a swap.
CREATE FUNCTION auth_store_refresh_token(p_user_type TEXT, p_user_id INT, p_token_hash TEXT, p_expires_at TIMESTAMPTZ,
                                         p_session_started_at TIMESTAMPTZ DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_user_type = 'tenant' THEN
        INSERT INTO Refresh_Tokens (tID, token_hash, expires_at, session_started_at)
        VALUES (p_user_id, p_token_hash, p_expires_at, COALESCE(p_session_started_at, now()));
    ELSIF p_user_type = 'admin' THEN
        INSERT INTO Refresh_Tokens (admin_id, token_hash, expires_at, session_started_at)
        VALUES (p_user_id, p_token_hash, p_expires_at, COALESCE(p_session_started_at, now()));
    ELSE
        RAISE EXCEPTION 'unknown user type %', p_user_type USING ERRCODE = 'invalid_parameter_value';
    END IF;
END $$;

-- As in 002, and also says when the session started.
CREATE FUNCTION auth_consume_refresh_token(p_token_hash TEXT)
RETURNS TABLE (user_type TEXT, user_id INT, email TEXT, role TEXT, session_started_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH used AS (
        UPDATE Refresh_Tokens SET revoked = true
         WHERE token_hash = p_token_hash AND NOT revoked AND expires_at > now()
        RETURNING tID, admin_id, session_started_at
    )
    SELECT 'tenant'::TEXT, t.tID, t.Email::TEXT, 'tenant'::TEXT, u.session_started_at
      FROM used u JOIN Tenants t ON t.tID = u.tID
     WHERE t.deactivated_at IS NULL AND t.signup_completed
    UNION ALL
    SELECT 'admin'::TEXT, a.admin_id, a.email::TEXT, a.role::TEXT, u.session_started_at
      FROM used u JOIN Admin a ON a.admin_id = u.admin_id
     WHERE a.deactivated_at IS NULL
$$;

REVOKE ALL ON FUNCTION auth_store_refresh_token(TEXT, INT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ), auth_consume_refresh_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_store_refresh_token(TEXT, INT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ), auth_consume_refresh_token(TEXT) TO summit_app;

/* ---- 3. Activity page ------------------------------------------------------------ */
ALTER TABLE Security_Events
    DROP CONSTRAINT security_events_action_check,
    ADD CONSTRAINT security_events_action_check CHECK (action IN (
        'login_success', 'login_failed', 'signup_completed',
        'team_invite', 'team_update', 'team_deactivate', 'team_reset', 'team_reissue',
        'mfa_setup', 'mfa_failed'));
