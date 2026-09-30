-- ---------------------------------------------------------------------------
-- 016  More than one resident on a lease.
--
-- Decided with the client on 2026-09-28: most leases have one person on them,
-- but many have two or three (roommates, couples), and each of them needs their
-- own login, can see the shared account, and can pay part of the rent.
--
-- tenancies.resident_user_id stays the *primary* resident, the person the lease
-- is filed under. Everyone else on the lease is a row here. A person taken off
-- a lease keeps nothing: removed_at ends their access.
--
-- Contact details are name, email and phone only. The portal does not ask for
-- or store Social Security numbers; applicant screening happens with an
-- outside provider (see docs/MEETING-2026-09-28.md).
-- ---------------------------------------------------------------------------

CREATE TABLE tenancy_residents (
  tenancy_id        uuid NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  added_by_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  added_at          timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz,
  removed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY (tenancy_id, user_id)
);

CREATE INDEX tenancy_residents_user_idx ON tenancy_residents (user_id) WHERE removed_at IS NULL;

-- The leases the caller is on, as primary or as an additional resident.
CREATE OR REPLACE FUNCTION app.my_tenancy_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT id), '{}') FROM (
    SELECT t.id FROM tenancies t WHERE t.resident_user_id = app.current_user_id()
    UNION ALL
    SELECT r.tenancy_id FROM tenancy_residents r
    WHERE r.user_id = app.current_user_id() AND r.removed_at IS NULL
  ) mine;
$$;

-- Everyone on a lease right now: the primary resident and the others.
CREATE OR REPLACE FUNCTION app.lease_resident_ids(p_tenancy uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT id), '{}') FROM (
    SELECT t.resident_user_id AS id FROM tenancies t WHERE t.id = p_tenancy
    UNION ALL
    SELECT r.user_id FROM tenancy_residents r WHERE r.tenancy_id = p_tenancy AND r.removed_at IS NULL
  ) everyone;
$$;

CREATE OR REPLACE FUNCTION app.visible_tenancy_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE app.current_role_name()
    WHEN 'tenant' THEN app.my_tenancy_ids()
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

CREATE OR REPLACE FUNCTION app.visible_property_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE app.current_role_name()
    WHEN 'tenant' THEN
      COALESCE((SELECT array_agg(DISTINCT t.property_id) FROM tenancies t
                WHERE t.id = ANY (app.my_tenancy_ids())), '{}')
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

-- Residents a staff member, manager or owner may see the name of. Now includes
-- the additional residents on each lease.
CREATE OR REPLACE FUNCTION app.visible_resident_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH leases AS (
    SELECT t.id, t.resident_user_id FROM tenancies t
    WHERE (app.current_role_name() = 'manager' AND t.organization_id = (SELECT app.caller_org_id()))
       OR app.current_role_name() = 'system_job'
       OR (app.current_role_name() IN ('staff','owner') AND EXISTS (
             SELECT 1 FROM staff_assignments sa
             WHERE sa.user_id = app.current_user_id() AND sa.property_id = t.property_id
               AND sa.revoked_at IS NULL))
  )
  SELECT COALESCE(array_agg(DISTINCT id), '{}') FROM (
    SELECT resident_user_id AS id FROM leases
    UNION ALL
    SELECT r.user_id FROM tenancy_residents r JOIN leases l ON l.id = r.tenancy_id
    WHERE r.removed_at IS NULL
  ) everyone;
$$;

-- Filing a request, starting a conversation. Any resident on the lease may;
-- the request or conversation carries the name of the one who did it.
CREATE OR REPLACE FUNCTION app.work_order_context(p_tenancy_id uuid)
RETURNS TABLE (organization_id uuid, property_id uuid, unit_id uuid, resident_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.organization_id, t.property_id, t.unit_id,
         CASE WHEN app.current_role_name() = 'tenant' AND p_tenancy_id = ANY (app.my_tenancy_ids())
              THEN app.current_user_id() ELSE t.resident_user_id END
  FROM tenancies t
  WHERE t.id = p_tenancy_id
    AND (
      (app.current_role_name() = 'tenant' AND t.id = ANY (app.my_tenancy_ids()))
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

-- A work order names a resident of its own lease: the primary or one of the
-- others. Runs as definer because staff cannot read tenancies (010).
CREATE OR REPLACE FUNCTION app.validate_work_order_resident() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (NEW.resident_user_id = ANY (app.lease_resident_ids(NEW.tenancy_id))) THEN
    RAISE EXCEPTION 'work order resident does not match the tenancy it belongs to'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Everyone on the lease hears about their account.
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
  FROM users u
  WHERE p_audience = 'resident' AND p_tenancy IS NOT NULL
    AND u.id = ANY (app.lease_resident_ids(p_tenancy)) AND u.active
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

-- Who else is on my lease: first names and nothing else, for a resident's own
-- lease only. A resident cannot read other users' rows (007), so this is the
-- one thing they learn about a roommate from the portal.
CREATE OR REPLACE FUNCTION app.lease_member_names(p_tenancy uuid)
RETURNS TABLE (user_id uuid, display_name text, is_primary boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.display_name, u.id = t.resident_user_id
  FROM tenancies t JOIN users u ON u.id = ANY (app.lease_resident_ids(t.id))
  WHERE t.id = p_tenancy AND p_tenancy = ANY (app.visible_tenancy_ids())
  ORDER BY (u.id = t.resident_user_id) DESC, u.display_name;
$$;

REVOKE ALL ON FUNCTION app.my_tenancy_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lease_resident_ids(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lease_member_names(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_tenancy_ids() TO portal_app;
GRANT EXECUTE ON FUNCTION app.lease_resident_ids(uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION app.lease_member_names(uuid) TO portal_app;

ALTER TABLE tenancy_residents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy_residents FORCE ROW LEVEL SECURITY;

CREATE POLICY tenancy_residents_read ON tenancy_residents
  FOR SELECT USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

-- Adding and removing people goes through app.lease_add_resident /
-- app.lease_remove_resident (017), which check the caller and write the audit
-- trail. The application role holds no direct write on this table.
REVOKE INSERT, UPDATE, DELETE ON tenancy_residents FROM portal_app;
GRANT SELECT ON tenancy_residents TO portal_app;

-- ---------------------------------------------------------------------------
-- Each resident's bank account is their own.
--
-- Payment methods used to belong to the lease, so roommates would have seen
-- and paid from each other's bank accounts. A method now records whose it is,
-- and a resident reaches only their own. Managers and the payment pipeline
-- still see every method on the lease.
-- ---------------------------------------------------------------------------

ALTER TABLE payment_methods ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE RESTRICT;

UPDATE payment_methods m SET user_id = t.resident_user_id
FROM tenancies t WHERE t.id = m.tenancy_id AND m.user_id IS NULL;

CREATE OR REPLACE FUNCTION app.payment_method_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    IF app.current_role_name() = 'tenant' THEN
      NEW.user_id := app.current_user_id();
    ELSE
      SELECT t.resident_user_id INTO NEW.user_id FROM tenancies t WHERE t.id = NEW.tenancy_id;
    END IF;
  END IF;
  IF app.current_role_name() = 'tenant' AND NEW.user_id <> app.current_user_id() THEN
    RAISE EXCEPTION 'a resident can only add their own payment method' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_methods_owner
  BEFORE INSERT ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION app.payment_method_owner();

ALTER TABLE payment_methods ALTER COLUMN user_id SET NOT NULL;

CREATE POLICY payment_methods_own_only ON payment_methods
  AS RESTRICTIVE
  FOR ALL
  USING (app.current_role_name() <> 'tenant' OR user_id = app.current_user_id())
  WITH CHECK (app.current_role_name() <> 'tenant' OR user_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- The users policy, rewritten so each visibility list is computed once per
-- query rather than once per user row. With additional residents in the list
-- the per-row version cost 130 ms for 300 residents, which pushed the rent roll
-- past its one-second target (tests/notifications.test.ts). A scalar subquery
-- around a STABLE function becomes an InitPlan: evaluated once, then reused.
-- ---------------------------------------------------------------------------

DROP POLICY users_read ON users;
CREATE POLICY users_read ON users
  FOR SELECT
  USING (
    id = (SELECT app.current_user_id())
    OR (SELECT app.is_system_job())
    OR id = ANY ((SELECT app.visible_resident_ids())::uuid[])
    OR ((SELECT app.current_role_name()) = 'manager'
        AND EXISTS (
          SELECT 1 FROM staff_assignments sa
          WHERE sa.user_id = users.id
            AND sa.property_id = ANY ((SELECT app.visible_property_ids())::uuid[])
        ))
  );
