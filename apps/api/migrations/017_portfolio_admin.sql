-- ---------------------------------------------------------------------------
-- 017  Managers set up the portfolio from the portal.
--
-- Until now properties, units, residents and leases came only from the seed or
-- an administrator at the database (008 keeps the running application from
-- writing structural tables at all). Replacing RentRedi means a manager has to
-- do this themselves: add a property, add its units, add a resident, start and
-- end a lease, put a roommate on a lease.
--
-- The application still holds no INSERT or UPDATE on properties or units. Each
-- change goes through one of the narrow functions below, which run with
-- definer rights, check that the caller is an active manager, keep every row in
-- the caller's own organization, and accept only the columns they name. A bug
-- in a request handler can call one of these; it cannot rename a property it
-- was never asked to touch or move a unit to another organization.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.require_manager() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid;
BEGIN
  IF app.current_role_name() <> 'manager' THEN
    RAISE EXCEPTION 'only a property manager can change the portfolio' USING ERRCODE = '42501';
  END IF;
  org := app.caller_org_id();
  IF org IS NULL THEN
    RAISE EXCEPTION 'this account is not active' USING ERRCODE = '42501';
  END IF;
  RETURN org;
END;
$$;

-- Properties -----------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.admin_save_property(
  p_id uuid, p_name text, p_line1 text, p_line2 text, p_city text, p_state text, p_postal text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := app.require_manager(); result uuid;
BEGIN
  IF length(trim(coalesce(p_name, ''))) = 0 OR length(trim(coalesce(p_line1, ''))) = 0
     OR length(trim(coalesce(p_city, ''))) = 0 OR length(trim(coalesce(p_state, ''))) = 0
     OR length(trim(coalesce(p_postal, ''))) = 0 THEN
    RAISE EXCEPTION 'a property needs a name and a full address' USING ERRCODE = '23514';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO properties (organization_id, name, address_line1, address_line2, city, state, postal_code)
    VALUES (org, trim(p_name), trim(p_line1), nullif(trim(coalesce(p_line2, '')), ''), trim(p_city),
            upper(trim(p_state)), trim(p_postal))
    RETURNING id INTO result;
  ELSE
    UPDATE properties SET name = trim(p_name), address_line1 = trim(p_line1),
           address_line2 = nullif(trim(coalesce(p_line2, '')), ''), city = trim(p_city),
           state = upper(trim(p_state)), postal_code = trim(p_postal), updated_at = now()
    WHERE id = p_id AND organization_id = org
    RETURNING id INTO result;
    IF result IS NULL THEN
      RAISE EXCEPTION 'no such property' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN result;
END;
$$;

-- Units ----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.admin_save_unit(
  p_id uuid, p_property uuid, p_label text, p_bedrooms smallint, p_bathrooms numeric, p_rent_cents bigint
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := app.require_manager(); result uuid; prop uuid;
BEGIN
  IF length(trim(coalesce(p_label, ''))) = 0 THEN
    RAISE EXCEPTION 'a unit needs a label, like 1A or 102' USING ERRCODE = '23514';
  END IF;
  IF p_id IS NULL THEN
    SELECT id INTO prop FROM properties WHERE id = p_property AND organization_id = org;
    IF prop IS NULL THEN
      RAISE EXCEPTION 'no such property' USING ERRCODE = '42501';
    END IF;
    INSERT INTO units (property_id, label, bedrooms, bathrooms, market_rent_cents)
    VALUES (prop, trim(p_label), p_bedrooms, p_bathrooms, coalesce(p_rent_cents, 0))
    RETURNING id INTO result;
  ELSE
    UPDATE units u SET label = trim(p_label), bedrooms = p_bedrooms, bathrooms = p_bathrooms,
           market_rent_cents = coalesce(p_rent_cents, 0)
    FROM properties p
    WHERE u.id = p_id AND p.id = u.property_id AND p.organization_id = org
    RETURNING u.id, u.property_id INTO result, prop;
    IF result IS NULL THEN
      RAISE EXCEPTION 'no such unit' USING ERRCODE = '42501';
    END IF;
  END IF;
  UPDATE properties SET unit_count = (SELECT count(*) FROM units WHERE property_id = prop), updated_at = now()
  WHERE id = prop;
  RETURN result;
END;
$$;

-- Residents ------------------------------------------------------------------
--
-- Name, email, phone. No Social Security number, no date of birth, no bank
-- details: the client does not want the liability, and screening an applicant
-- happens with an outside provider before a resident is ever added here.

CREATE OR REPLACE FUNCTION app.admin_create_resident(
  p_email text, p_name text, p_phone text, p_password_hash text, p_algorithm text
) RETURNS TABLE (user_id uuid, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := app.require_manager(); existing record; result uuid;
BEGIN
  IF length(trim(coalesce(p_name, ''))) = 0 THEN
    RAISE EXCEPTION 'a resident needs a name' USING ERRCODE = '23514';
  END IF;
  SELECT id, organization_id, role INTO existing FROM users WHERE email = lower(trim(p_email));
  IF FOUND THEN
    -- The same person moving to another unit, or going on a second lease,
    -- keeps one login.
    IF existing.organization_id = org AND existing.role = 'tenant' THEN
      RETURN QUERY SELECT existing.id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'that email address already belongs to another account' USING ERRCODE = '23505';
  END IF;
  INSERT INTO users (organization_id, email, display_name, phone, role, password_hash, password_algorithm,
                     must_change_password)
  VALUES (org, lower(trim(p_email)), trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), 'tenant',
          p_password_hash, p_algorithm, true)
  RETURNING id INTO result;
  RETURN QUERY SELECT result, true;
END;
$$;

CREATE OR REPLACE FUNCTION app.admin_update_resident(p_user uuid, p_name text, p_email text, p_phone text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := app.require_manager(); n integer;
BEGIN
  UPDATE users SET display_name = trim(p_name), email = lower(trim(p_email)),
         phone = nullif(trim(coalesce(p_phone, '')), ''), updated_at = now()
  WHERE id = p_user AND organization_id = org AND role = 'tenant';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'no such resident' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- A new temporary password, for a resident who is locked out or never got
-- theirs. They must change it at their next sign-in, and their open sessions
-- end.
CREATE OR REPLACE FUNCTION app.admin_reset_resident_password(p_user uuid, p_password_hash text, p_algorithm text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := app.require_manager(); n integer;
BEGIN
  UPDATE users SET password_hash = p_password_hash, password_algorithm = p_algorithm,
         must_change_password = true, failed_login_count = 0, locked_until = NULL, updated_at = now()
  WHERE id = p_user AND organization_id = org AND role = 'tenant';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'no such resident' USING ERRCODE = '42501';
  END IF;
  UPDATE sessions SET revoked_at = now() WHERE user_id = p_user AND revoked_at IS NULL;
END;
$$;

-- Leases ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.admin_create_lease(
  p_unit uuid, p_resident uuid, p_starts date, p_ends date, p_rent_cents bigint,
  p_due_day smallint, p_deposit_cents bigint
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := app.require_manager(); u record; result uuid;
BEGIN
  SELECT un.id, un.property_id INTO u
  FROM units un JOIN properties p ON p.id = un.property_id
  WHERE un.id = p_unit AND p.organization_id = org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such unit' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_resident AND organization_id = org AND role = 'tenant') THEN
    RAISE EXCEPTION 'no such resident' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM tenancies WHERE unit_id = p_unit AND status = 'active') THEN
    RAISE EXCEPTION 'this unit already has an active lease; end it first' USING ERRCODE = '23505';
  END IF;
  INSERT INTO tenancies (organization_id, property_id, unit_id, resident_user_id, starts_on, ends_on,
                         monthly_rent_cents, rent_due_day, deposit_cents, status)
  VALUES (org, u.property_id, p_unit, p_resident, p_starts, p_ends, p_rent_cents,
          coalesce(p_due_day, 1), coalesce(p_deposit_cents, 0), 'active')
  RETURNING id INTO result;
  RETURN result;
END;
$$;

-- Change a lease's terms going forward. Charges already posted are not touched:
-- they are ledger rows, and the ledger is append-only.
CREATE OR REPLACE FUNCTION app.admin_update_lease(
  p_tenancy uuid, p_ends date, p_rent_cents bigint, p_due_day smallint, p_deposit_cents bigint
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := app.require_manager(); n integer;
BEGIN
  UPDATE tenancies SET ends_on = p_ends, monthly_rent_cents = p_rent_cents,
         rent_due_day = coalesce(p_due_day, rent_due_day), deposit_cents = coalesce(p_deposit_cents, deposit_cents),
         updated_at = now()
  WHERE id = p_tenancy AND organization_id = org AND status = 'active';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'no such active lease' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Ending a lease frees the unit, stops autopay, and takes everyone off it. The
-- ledger stays: whatever is still owed is still owed, and the former
-- residents can still be shown their history by the office.
CREATE OR REPLACE FUNCTION app.admin_end_lease(p_tenancy uuid, p_ends date) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := app.require_manager(); n integer;
BEGIN
  UPDATE tenancies SET status = 'ended', ends_on = p_ends, updated_at = now()
  WHERE id = p_tenancy AND organization_id = org AND status = 'active' AND p_ends >= starts_on;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'no such active lease, or the end date is before it started' USING ERRCODE = '42501';
  END IF;
  UPDATE autopay_enrollments SET active = false WHERE tenancy_id = p_tenancy AND active;
  UPDATE tenancy_residents SET removed_at = now(), removed_by_user_id = app.current_user_id()
  WHERE tenancy_id = p_tenancy AND removed_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app.lease_add_resident(p_tenancy uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := app.require_manager();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenancies WHERE id = p_tenancy AND organization_id = org AND status = 'active') THEN
    RAISE EXCEPTION 'no such active lease' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND organization_id = org AND role = 'tenant') THEN
    RAISE EXCEPTION 'no such resident' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM tenancies WHERE id = p_tenancy AND resident_user_id = p_user) THEN
    RETURN; -- already the primary resident
  END IF;
  INSERT INTO tenancy_residents (tenancy_id, user_id, organization_id, added_by_user_id)
  VALUES (p_tenancy, p_user, org, app.current_user_id())
  ON CONFLICT (tenancy_id, user_id) DO UPDATE
    SET removed_at = NULL, removed_by_user_id = NULL, added_at = now(), added_by_user_id = app.current_user_id();
END;
$$;

CREATE OR REPLACE FUNCTION app.lease_remove_resident(p_tenancy uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := app.require_manager(); n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM tenancies WHERE id = p_tenancy AND resident_user_id = p_user) THEN
    RAISE EXCEPTION 'the primary resident cannot be taken off the lease; end the lease instead'
      USING ERRCODE = '23514';
  END IF;
  UPDATE tenancy_residents SET removed_at = now(), removed_by_user_id = app.current_user_id()
  WHERE tenancy_id = p_tenancy AND user_id = p_user AND organization_id = org AND removed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'that person is not on this lease' USING ERRCODE = '42501';
  END IF;
  -- Their bank account leaves with them; their autopay stops.
  UPDATE autopay_enrollments a SET active = false
  FROM payment_methods m
  WHERE a.payment_method_id = m.id AND a.tenancy_id = p_tenancy AND m.user_id = p_user AND a.active;
END;
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app.require_manager()',
    'app.admin_save_property(uuid, text, text, text, text, text, text)',
    'app.admin_save_unit(uuid, uuid, text, smallint, numeric, bigint)',
    'app.admin_create_resident(text, text, text, text, text)',
    'app.admin_update_resident(uuid, text, text, text)',
    'app.admin_reset_resident_password(uuid, text, text)',
    'app.admin_create_lease(uuid, uuid, date, date, bigint, smallint, bigint)',
    'app.admin_update_lease(uuid, date, bigint, smallint, bigint)',
    'app.admin_end_lease(uuid, date)',
    'app.lease_add_resident(uuid, uuid)',
    'app.lease_remove_resident(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO portal_app', f);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Organization settings: where applicants are screened.
--
-- Applicant screening (credit, background) needs a Social Security number, and
-- the client does not want to hold one. So the portal holds a link to the
-- screening provider the office uses, and nothing the applicant types there.
-- ---------------------------------------------------------------------------

CREATE TABLE organization_settings (
  organization_id    uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  screening_provider text CHECK (screening_provider IS NULL OR length(screening_provider) <= 80),
  screening_url      text CHECK (screening_url IS NULL OR screening_url ~ '^https://[^\s]+$'),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_settings_read ON organization_settings
  FOR SELECT USING (organization_id = (SELECT app.caller_org_id()) OR app.is_system_job());
CREATE POLICY organization_settings_write ON organization_settings
  FOR ALL
  USING (app.current_role_name() = 'manager' AND organization_id = (SELECT app.caller_org_id()))
  WITH CHECK (app.current_role_name() = 'manager' AND organization_id = (SELECT app.caller_org_id()));

GRANT SELECT, INSERT, UPDATE ON organization_settings TO portal_app;
