-- ---------------------------------------------------------------------------
-- 010  Close two gaps found by the cross-tenant probe suite.
--
-- Both were found by tests/isolation.test.ts rather than by review, which is
-- the argument for writing those probes as adversarially as possible: neither
-- was visible from reading the policies, and both would have shipped.
--
-- ---------------------------------------------------------------------------
-- Finding 1: on-site staff could read lease financial terms.
--
-- `tenancies_read` admitted any role whose visible_tenancy_ids() covered the
-- row, and for staff that is every tenancy at their assigned properties —
-- correct for maintenance, wrong for money, because the tenancy row carries
-- monthly_rent_cents and deposit_cents. Staff could therefore read what every
-- resident in the building pays. Balances were never exposed (ledger_entries
-- denied them correctly), but `tenancy_balances` still returned one row per
-- unit, disclosing occupancy alongside the rent.
--
-- Row-Level Security is row-level: it cannot hide a column from one role and
-- show it to another. So the fix removes staff's need to read the table at all.
-- Work orders already carry property_id and unit_id denormalized for exactly
-- this reason; they now carry the resident too, and the maintenance read path
-- joins through that instead of through the tenancy.
-- ---------------------------------------------------------------------------

ALTER TABLE work_orders
  ADD COLUMN resident_user_id uuid REFERENCES users(id) ON DELETE RESTRICT;

UPDATE work_orders w
SET resident_user_id = t.resident_user_id
FROM tenancies t
WHERE t.id = w.tenancy_id AND w.resident_user_id IS NULL;

ALTER TABLE work_orders ALTER COLUMN resident_user_id SET NOT NULL;

COMMENT ON COLUMN work_orders.resident_user_id IS
  'Denormalized from the tenancy so that maintenance staff never need SELECT on tenancies, which carries lease financial terms they must not see. See migration 010.';

-- Keep it honest: a work order must always name the resident of its own tenancy.
CREATE OR REPLACE FUNCTION app.validate_work_order_resident() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tenancies t
    WHERE t.id = NEW.tenancy_id AND t.resident_user_id = NEW.resident_user_id
  ) THEN
    RAISE EXCEPTION 'work order resident does not match the tenancy it belongs to'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_orders_validate_resident
  BEFORE INSERT OR UPDATE OF tenancy_id, resident_user_id ON work_orders
  FOR EACH ROW EXECUTE FUNCTION app.validate_work_order_resident();

-- Reading a tenancy row now requires being able to read money: the resident
-- themselves, a manager, an owner, or the job runner. Staff are excluded.
DROP POLICY tenancies_read ON tenancies;
CREATE POLICY tenancies_read ON tenancies
  FOR SELECT
  USING (app.can_read_money() AND id = ANY (app.visible_tenancy_ids()));

-- The financial views get the same guard explicitly, rather than relying on the
-- policies of every table they happen to join. A view that leaks because a join
-- was added later is the kind of regression nobody notices.
CREATE OR REPLACE VIEW tenancy_balances
WITH (security_invoker = true) AS
SELECT
  t.id                       AS tenancy_id,
  t.property_id,
  t.organization_id,
  t.unit_id,
  u.label                    AS unit_label,
  p.name                     AS property_name,
  usr.display_name           AS resident_name,
  usr.email                  AS resident_email,
  t.status,
  t.monthly_rent_cents,
  t.rent_due_day,
  t.late_fee_hold_until,
  t.late_fee_hold_reason,
  COALESCE(l.balance_cents, 0)        AS balance_cents,
  COALESCE(l.charged_cents, 0)        AS lifetime_charged_cents,
  COALESCE(l.credited_cents, 0)       AS lifetime_credited_cents,
  l.last_entry_at,
  l.first_entry_at
FROM tenancies t
JOIN units u        ON u.id = t.unit_id
JOIN properties p   ON p.id = t.property_id
JOIN users usr      ON usr.id = t.resident_user_id
LEFT JOIN LATERAL (
  SELECT
    sum(e.amount_cents)                                          AS balance_cents,
    sum(e.amount_cents) FILTER (WHERE e.amount_cents > 0)        AS charged_cents,
    sum(e.amount_cents) FILTER (WHERE e.amount_cents < 0)        AS credited_cents,
    max(e.posted_at)                                             AS last_entry_at,
    min(e.posted_at)                                             AS first_entry_at
  FROM ledger_entries e
  WHERE e.tenancy_id = t.id
) l ON true
WHERE app.can_read_money();

CREATE OR REPLACE VIEW tenancy_period_activity
WITH (security_invoker = true) AS
SELECT
  t.id                  AS tenancy_id,
  t.property_id,
  t.organization_id,
  e.period,
  sum(e.amount_cents) FILTER (WHERE e.amount_cents > 0)               AS charged_cents,
  -sum(e.amount_cents) FILTER (WHERE e.amount_cents < 0)              AS credited_cents,
  sum(e.amount_cents)                                                  AS net_cents,
  sum(e.amount_cents) FILTER (WHERE e.category = 'late_fee')           AS late_fee_cents,
  count(*) FILTER (WHERE e.entry_type = 'reversal')                    AS reversal_count,
  min(e.effective_date) FILTER (WHERE e.entry_type = 'charge')         AS first_charge_date,
  max(e.posted_at)                                                     AS last_activity_at
FROM tenancies t
JOIN ledger_entries e ON e.tenancy_id = t.id
WHERE app.can_read_money()
GROUP BY t.id, t.property_id, t.organization_id, e.period;

/**
 * Resolve the identifiers a work order needs, for callers entitled to file one.
 *
 * SECURITY DEFINER because staff must be able to file a request on a resident's
 * behalf without being able to read the tenancy row themselves. It returns only
 * the four keys a work order carries — never a financial column — and it
 * refuses any caller who is not the resident, assigned staff, or a manager on
 * that property.
 */
CREATE OR REPLACE FUNCTION app.work_order_context(p_tenancy_id uuid)
RETURNS TABLE (organization_id uuid, property_id uuid, unit_id uuid, resident_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.organization_id, t.property_id, t.unit_id, t.resident_user_id
  FROM tenancies t
  WHERE t.id = p_tenancy_id
    AND (
      t.resident_user_id = app.current_user_id()
      OR app.is_system_job()
      OR EXISTS (
        SELECT 1 FROM staff_assignments sa
        WHERE sa.user_id = app.current_user_id()
          AND sa.property_id = t.property_id
          AND sa.revoked_at IS NULL
      )
    );
$$;

REVOKE ALL ON FUNCTION app.work_order_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.work_order_context(uuid) TO portal_app;

-- ---------------------------------------------------------------------------
-- Finding 2: revoking a staff assignment silently did nothing.
--
-- `staff_assignments_manage` admitted only role 'manager', so an UPDATE issued
-- under the system context matched no rows. RLS answers a refused UPDATE with
-- rowCount 0 rather than an error, so the revoke appeared to succeed and the
-- agent kept their access. The administrative CLI and the seed path both run as
-- system_job, which is exactly when someone would be revoking access in a
-- hurry.
-- ---------------------------------------------------------------------------

DROP POLICY staff_assignments_manage ON staff_assignments;
CREATE POLICY staff_assignments_manage ON staff_assignments
  FOR ALL
  USING (
    (app.current_role_name() = 'manager' AND property_id = ANY (app.visible_property_ids()))
    OR app.is_system_job()
  )
  WITH CHECK (
    (app.current_role_name() = 'manager' AND property_id = ANY (app.visible_property_ids()))
    OR app.is_system_job()
  );

GRANT SELECT ON tenancy_balances, tenancy_period_activity TO portal_app;

-- ---------------------------------------------------------------------------
-- Consequence of the above: the users policy reached residents *through*
-- tenancies, which staff can no longer read. Policy subqueries are themselves
-- subject to RLS, so locking the tenancy row silently cost staff the resident
-- names they need to do their job — caught by the probe that asserts staff can
-- still see a name on a request.
--
-- The membership question is answered by a SECURITY DEFINER helper instead. It
-- returns user ids and nothing else: no rent, no balance, no lease terms.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.visible_resident_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN app.current_role_name() IN ('staff','manager','owner') THEN
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

REVOKE ALL ON FUNCTION app.visible_resident_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.visible_resident_ids() TO portal_app;

DROP POLICY users_read ON users;
CREATE POLICY users_read ON users
  FOR SELECT
  USING (
    id = app.current_user_id()
    OR app.is_system_job()
    -- Residents at properties the caller is assigned to: names for work orders
    -- and rent rolls, resolved without reading the tenancy row itself.
    OR id = ANY (app.visible_resident_ids())
    -- A manager can see their own colleagues, to manage delegation.
    OR (app.current_role_name() = 'manager'
        AND EXISTS (
          SELECT 1 FROM staff_assignments sa
          WHERE sa.user_id = users.id
            AND sa.property_id = ANY (app.visible_property_ids())
        ))
  );

-- ---------------------------------------------------------------------------
-- Finding 3: the payment-transition trigger returned early when the status was
-- unchanged, so its "the amount of a submitted payment cannot change" check
-- never ran on a same-status UPDATE. The amount of a payment in flight could be
-- edited to anything. Found by tests/payments.test.ts.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.validate_payment_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
BEGIN
  -- Checked first, and unconditionally: the amount is immutable for the whole
  -- life of the row, not only across a status change.
  IF NEW.amount_cents <> OLD.amount_cents THEN
    RAISE EXCEPTION 'the amount of a submitted payment cannot change'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.tenancy_id <> OLD.tenancy_id THEN
    RAISE EXCEPTION 'a payment cannot be moved to a different tenancy'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'pending'    THEN ARRAY['processing','failed']
    WHEN 'processing' THEN ARRAY['settled','failed']
    WHEN 'settled'    THEN ARRAY['returned','refunded','disputed']
    WHEN 'disputed'   THEN ARRAY['settled','refunded']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'illegal payment transition % -> % on payment %',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
