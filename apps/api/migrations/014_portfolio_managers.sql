-- ---------------------------------------------------------------------------
-- 014  Managers see the whole portfolio.
--
-- Decided with the client on 2026-09-28: Summit's property managers work the
-- portfolio together, and any manager must be able to see and act on every
-- property. Until now a manager reached only the properties listed for them in
-- staff_assignments, the same rule as on-site staff and owners.
--
-- What changes: role 'manager' now reaches every property, tenancy and resident
-- of the manager's own organization.
--
-- What does not change:
--   * on-site staff still reach only the properties they are assigned to, and
--     still no money (010);
--   * owners still reach only the properties they own;
--   * nobody reaches another organization. The organization is looked up from
--     the caller's own user row, not taken from the session setting, so a
--     forged app.org_id cannot widen it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.caller_org_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.organization_id FROM users u
  WHERE u.id = app.current_user_id() AND u.active;
$$;

REVOKE ALL ON FUNCTION app.caller_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caller_org_id() TO portal_app;

CREATE OR REPLACE FUNCTION app.visible_property_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE app.current_role_name()
    WHEN 'tenant' THEN
      COALESCE((SELECT array_agg(DISTINCT t.property_id) FROM tenancies t
                WHERE t.resident_user_id = app.current_user_id()), '{}')
    WHEN 'system_job' THEN
      COALESCE((SELECT array_agg(p.id) FROM properties p), '{}')
    WHEN 'manager' THEN
      COALESCE((SELECT array_agg(p.id) FROM properties p
                WHERE p.organization_id = (SELECT app.caller_org_id())), '{}')
    ELSE
      COALESCE((SELECT array_agg(sa.property_id) FROM staff_assignments sa
                WHERE sa.user_id = app.current_user_id()
                  AND sa.revoked_at IS NULL), '{}')
  END;
$$;

CREATE OR REPLACE FUNCTION app.visible_tenancy_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE app.current_role_name()
    WHEN 'tenant' THEN
      COALESCE((SELECT array_agg(t.id) FROM tenancies t
                WHERE t.resident_user_id = app.current_user_id()), '{}')
    WHEN 'system_job' THEN
      COALESCE((SELECT array_agg(t.id) FROM tenancies t), '{}')
    WHEN 'manager' THEN
      COALESCE((SELECT array_agg(t.id) FROM tenancies t
                WHERE t.organization_id = (SELECT app.caller_org_id())), '{}')
    ELSE
      COALESCE((SELECT array_agg(t.id) FROM tenancies t
                JOIN staff_assignments sa ON sa.property_id = t.property_id
                WHERE sa.user_id = app.current_user_id()
                  AND sa.revoked_at IS NULL), '{}')
  END;
$$;

CREATE OR REPLACE FUNCTION app.visible_resident_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN app.current_role_name() = 'manager' THEN
      COALESCE((SELECT array_agg(DISTINCT t.resident_user_id) FROM tenancies t
                WHERE t.organization_id = (SELECT app.caller_org_id())), '{}')
    WHEN app.current_role_name() IN ('staff','owner') THEN
      COALESCE((SELECT array_agg(DISTINCT t.resident_user_id)
                FROM tenancies t
                JOIN staff_assignments sa ON sa.property_id = t.property_id
                WHERE sa.user_id = app.current_user_id()
                  AND sa.revoked_at IS NULL), '{}')
    WHEN app.current_role_name() = 'system_job' THEN
      COALESCE((SELECT array_agg(t.resident_user_id) FROM tenancies t), '{}')
    ELSE '{}'
  END;
$$;

-- Managers see the rest of the team — other managers, on-site staff, owners —
-- in their organization, so a note or a message shows who wrote it and the
-- Access screen can list everyone. Residents are covered by users_read.
CREATE POLICY users_read_team ON users
  FOR SELECT
  USING (
    app.current_role_name() = 'manager'
    AND role IN ('staff','manager','owner')
    AND organization_id = (SELECT app.caller_org_id())
  );

-- Filing a request or starting a conversation (010, 011) checked the caller
-- against staff_assignments. A manager now reaches any tenancy in the
-- organization, so they can file and message there too.
CREATE OR REPLACE FUNCTION app.work_order_context(p_tenancy_id uuid)
RETURNS TABLE (organization_id uuid, property_id uuid, unit_id uuid, resident_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.organization_id, t.property_id, t.unit_id, t.resident_user_id
  FROM tenancies t
  WHERE t.id = p_tenancy_id
    AND (
      t.resident_user_id = app.current_user_id()
      OR app.is_system_job()
      OR (app.current_role_name() = 'manager' AND t.organization_id = (SELECT app.caller_org_id()))
      OR EXISTS (
        SELECT 1 FROM staff_assignments sa
        WHERE sa.user_id = app.current_user_id()
          AND sa.property_id = t.property_id
          AND sa.revoked_at IS NULL
      )
    );
$$;

-- Who hears about an event meant for management. Managers assigned to the
-- property are the ones responsible for it and get the email. A property with
-- no assigned manager — one just added, say — would otherwise tell nobody, so
-- it falls back to every active manager in the organization.
CREATE OR REPLACE FUNCTION app.notification_recipients(p_tenancy uuid, p_property uuid, p_audience text)
RETURNS TABLE (email text, phone text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH scope AS (
    SELECT COALESCE(p_property, (SELECT t.property_id FROM tenancies t WHERE t.id = p_tenancy)) AS property_id
  ),
  assigned AS (
    SELECT u.email, u.phone, u.display_name
    FROM staff_assignments sa JOIN users u ON u.id = sa.user_id, scope
    WHERE p_audience IN ('manager','staff')
      AND u.role = p_audience AND u.active AND sa.revoked_at IS NULL
      AND sa.property_id = scope.property_id
  )
  SELECT u.email, u.phone, u.display_name
  FROM tenancies t JOIN users u ON u.id = t.resident_user_id
  WHERE p_audience = 'resident' AND t.id = p_tenancy AND u.active
    AND app.caller_can_route(p_tenancy, p_property)
  UNION
  SELECT a.email, a.phone, a.display_name FROM assigned a
  WHERE app.caller_can_route(p_tenancy, p_property)
  UNION
  SELECT u.email, u.phone, u.display_name
  FROM users u JOIN properties p ON p.organization_id = u.organization_id, scope
  WHERE p_audience = 'manager' AND u.role = 'manager' AND u.active
    AND p.id = scope.property_id
    AND NOT EXISTS (SELECT 1 FROM assigned)
    AND app.caller_can_route(p_tenancy, p_property);
$$;
