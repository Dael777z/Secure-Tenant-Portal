-- ---------------------------------------------------------------------------
-- 007  Row-Level Security.
--
-- This file is the isolation guarantee. Everything else is convenience.
--
-- The rule the whole design is arranged around: an authenticated resident who
-- reaches an endpoint that forgot its WHERE clause receives an empty set, not
-- another resident's rent record. The cross-tenant probe suite in
-- tests/isolation.test.ts proves this by running with the application's own
-- filters deliberately disabled — if those tests pass only because application
-- code is careful, they are not testing the thing they claim to test.
--
-- Two visibility helpers do the work. Both are STABLE, so PostgreSQL evaluates
-- each once per query rather than once per row, and both are SECURITY DEFINER,
-- so they can read the membership tables without recursing into the policies
-- that are asking them the question.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.visible_tenancy_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE app.current_role_name()
    WHEN 'tenant' THEN
      -- A resident reaches exactly their own tenancies. Plural because someone
      -- who transfers units keeps their history in the unit they left.
      COALESCE((SELECT array_agg(t.id) FROM tenancies t
                WHERE t.resident_user_id = app.current_user_id()), '{}')
    WHEN 'system_job' THEN
      COALESCE((SELECT array_agg(t.id) FROM tenancies t), '{}')
    ELSE
      -- Staff, managers and owners reach the tenancies of properties they are
      -- assigned to, and only while that assignment is live.
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
                WHERE t.resident_user_id = app.current_user_id()), '{}')
    WHEN 'system_job' THEN
      COALESCE((SELECT array_agg(p.id) FROM properties p), '{}')
    ELSE
      COALESCE((SELECT array_agg(sa.property_id) FROM staff_assignments sa
                WHERE sa.user_id = app.current_user_id()
                  AND sa.revoked_at IS NULL), '{}')
  END;
$$;

-- Financial visibility is a separate question from property visibility, and
-- keeping it separate is the whole delegation story: an on-site agent who
-- triages maintenance for a property must not thereby acquire its rent roll.
CREATE OR REPLACE FUNCTION app.can_read_money() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_role_name() IN ('tenant','manager','owner','system_job');
$$;

CREATE OR REPLACE FUNCTION app.can_write_money() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_role_name() IN ('manager','system_job');
$$;

REVOKE ALL ON FUNCTION app.visible_tenancy_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.visible_property_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.visible_tenancy_ids() TO portal_app;
GRANT EXECUTE ON FUNCTION app.visible_property_ids() TO portal_app;
GRANT EXECUTE ON FUNCTION app.can_read_money() TO portal_app;
GRANT EXECUTE ON FUNCTION app.can_write_money() TO portal_app;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO portal_app;
GRANT EXECUTE ON FUNCTION app.current_role_name() TO portal_app;
GRANT EXECUTE ON FUNCTION app.current_org_id() TO portal_app;
GRANT EXECUTE ON FUNCTION app.is_system_job() TO portal_app;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere that holds resident data.
--
-- FORCE matters: without it the table owner silently bypasses its own policies,
-- and a migration or a maintenance script run as the owner would quietly have
-- god mode over rows the policies exist to protect.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','properties','units','users','tenancies','staff_assignments','sessions',
    'ledger_entries','audit_log','payment_methods','payments','autopay_enrollments',
    'payment_plans','payment_plan_installments','work_orders','work_order_events',
    'work_order_photos','charge_disputes','recurring_charges','late_fee_policies',
    'notification_events','notification_deliveries'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The ledger.
--
-- Read: your own rows if you are a resident, your properties' rows if you are a
-- manager or owner. Staff are excluded by can_read_money() and see nothing here
-- at all, which is the delegation guarantee stated as a policy rather than as a
-- promise in a document.
-- ---------------------------------------------------------------------------

CREATE POLICY ledger_read ON ledger_entries
  FOR SELECT
  USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

-- Write: managers and the job runner only, and only into tenancies they can
-- already see. Residents never insert ledger rows; their payments become ledger
-- rows through the payment pipeline, under the system context, after the money
-- actually moves.
CREATE POLICY ledger_append ON ledger_entries
  FOR INSERT
  WITH CHECK (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

-- No UPDATE policy and no DELETE policy exist for this table, by intent. With
-- RLS enabled and no permissive policy for a command, that command matches no
-- rows for anyone. Combined with the trigger in 003 and the REVOKE in 008, the
-- append-only property is enforced three independent ways.

CREATE POLICY audit_read ON audit_log
  FOR SELECT
  USING (
    -- A resident may read audit entries about their own tenancy, which is what
    -- makes "who did this to my account, and when" answerable by the person it
    -- was done to rather than only by the party holding the software.
    (app.current_role_name() = 'tenant' AND subject_id = ANY (app.visible_tenancy_ids()))
    OR (app.current_role_name() IN ('manager','owner')
        AND property_id = ANY (app.visible_property_ids()))
    OR app.is_system_job()
  );

CREATE POLICY audit_append ON audit_log
  FOR INSERT WITH CHECK (app.current_user_id() IS NOT NULL OR app.is_system_job());

-- ---------------------------------------------------------------------------
-- Identity and structure.
-- ---------------------------------------------------------------------------

CREATE POLICY org_read ON organizations
  FOR SELECT USING (id = app.current_org_id() OR app.is_system_job());

CREATE POLICY properties_read ON properties
  FOR SELECT USING (id = ANY (app.visible_property_ids()));

CREATE POLICY units_read ON units
  FOR SELECT USING (property_id = ANY (app.visible_property_ids()));

-- A resident reads their own user row and nothing else — not their neighbours',
-- and not their manager's. Staff and managers read the users attached to
-- tenancies they can see, which is how a work order shows a name.
CREATE POLICY users_read ON users
  FOR SELECT
  USING (
    id = app.current_user_id()
    OR app.is_system_job()
    OR (app.current_role_name() IN ('staff','manager','owner')
        AND EXISTS (
          SELECT 1 FROM tenancies t
          WHERE t.resident_user_id = users.id
            AND t.property_id = ANY (app.visible_property_ids())
        ))
    OR (app.current_role_name() = 'manager'
        AND EXISTS (
          SELECT 1 FROM staff_assignments sa
          WHERE sa.user_id = users.id
            AND sa.property_id = ANY (app.visible_property_ids())
        ))
  );

CREATE POLICY users_self_update ON users
  FOR UPDATE
  USING (id = app.current_user_id() OR app.is_system_job())
  WITH CHECK (id = app.current_user_id() OR app.is_system_job());

CREATE POLICY tenancies_read ON tenancies
  FOR SELECT USING (id = ANY (app.visible_tenancy_ids()));

CREATE POLICY tenancies_manage ON tenancies
  FOR UPDATE
  USING (app.can_write_money() AND id = ANY (app.visible_tenancy_ids()))
  WITH CHECK (app.can_write_money() AND id = ANY (app.visible_tenancy_ids()));

CREATE POLICY staff_assignments_read ON staff_assignments
  FOR SELECT
  USING (user_id = app.current_user_id()
         OR (app.current_role_name() = 'manager' AND property_id = ANY (app.visible_property_ids()))
         OR app.is_system_job());

CREATE POLICY staff_assignments_manage ON staff_assignments
  FOR ALL
  USING (app.current_role_name() = 'manager' AND property_id = ANY (app.visible_property_ids()))
  WITH CHECK (app.current_role_name() = 'manager' AND property_id = ANY (app.visible_property_ids()));

-- Sessions are reached by token hash during authentication, before any user
-- context exists, so this table is governed by the grants in 008 rather than by
-- a row policy that would have nothing to bind against.
CREATE POLICY sessions_own ON sessions
  FOR ALL
  USING (user_id = app.current_user_id() OR app.current_user_id() IS NULL)
  WITH CHECK (user_id = app.current_user_id() OR app.current_user_id() IS NULL);

-- ---------------------------------------------------------------------------
-- Money-adjacent tables. Same shape throughout: readable by the resident it
-- concerns and by financial roles on that property; writable by the resident for
-- their own instruments, and by managers and the job runner.
-- ---------------------------------------------------------------------------

CREATE POLICY payment_methods_read ON payment_methods
  FOR SELECT USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

CREATE POLICY payment_methods_write ON payment_methods
  FOR INSERT WITH CHECK (tenancy_id = ANY (app.visible_tenancy_ids()) AND app.can_read_money());

CREATE POLICY payment_methods_update ON payment_methods
  FOR UPDATE
  USING (tenancy_id = ANY (app.visible_tenancy_ids()) AND app.can_read_money())
  WITH CHECK (tenancy_id = ANY (app.visible_tenancy_ids()) AND app.can_read_money());

CREATE POLICY payments_read ON payments
  FOR SELECT USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

CREATE POLICY payments_insert ON payments
  FOR INSERT WITH CHECK (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

-- Only the reconciliation path advances a payment's status: the resident who
-- submitted it cannot mark their own payment settled.
CREATE POLICY payments_update ON payments
  FOR UPDATE
  USING (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()))
  WITH CHECK (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

CREATE POLICY autopay_read ON autopay_enrollments
  FOR SELECT USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));
CREATE POLICY autopay_write ON autopay_enrollments
  FOR INSERT WITH CHECK (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));
CREATE POLICY autopay_update ON autopay_enrollments
  FOR UPDATE
  USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()))
  WITH CHECK (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

CREATE POLICY plans_read ON payment_plans
  FOR SELECT USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));
CREATE POLICY plans_write ON payment_plans
  FOR INSERT WITH CHECK (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));
CREATE POLICY plans_update ON payment_plans
  FOR UPDATE
  USING (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()))
  WITH CHECK (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

CREATE POLICY installments_read ON payment_plan_installments
  FOR SELECT USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));
CREATE POLICY installments_write ON payment_plan_installments
  FOR INSERT WITH CHECK (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));
CREATE POLICY installments_update ON payment_plan_installments
  FOR UPDATE
  USING (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()))
  WITH CHECK (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

CREATE POLICY recurring_read ON recurring_charges
  FOR SELECT USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));
CREATE POLICY recurring_write ON recurring_charges
  FOR ALL
  USING (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()))
  WITH CHECK (app.can_write_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

-- Residents can read the fee policy that applies to them. A policy the resident
-- cannot read is a rule they are held to and cannot check.
CREATE POLICY late_fee_read ON late_fee_policies
  FOR SELECT USING (property_id = ANY (app.visible_property_ids()));
CREATE POLICY late_fee_write ON late_fee_policies
  FOR ALL
  USING (app.current_role_name() IN ('manager','system_job')
         AND property_id = ANY (app.visible_property_ids()))
  WITH CHECK (app.current_role_name() IN ('manager','system_job')
              AND property_id = ANY (app.visible_property_ids()));

-- ---------------------------------------------------------------------------
-- Maintenance. This is where staff live, and the only place they do.
-- ---------------------------------------------------------------------------

CREATE POLICY work_orders_read ON work_orders
  FOR SELECT
  USING (
    (app.current_role_name() = 'tenant' AND tenancy_id = ANY (app.visible_tenancy_ids()))
    OR (app.current_role_name() IN ('staff','manager','system_job')
        AND property_id = ANY (app.visible_property_ids()))
  );

CREATE POLICY work_orders_insert ON work_orders
  FOR INSERT
  WITH CHECK (
    (app.current_role_name() = 'tenant' AND tenancy_id = ANY (app.visible_tenancy_ids()))
    OR (app.current_role_name() IN ('staff','manager','system_job')
        AND property_id = ANY (app.visible_property_ids()))
  );

CREATE POLICY work_orders_update ON work_orders
  FOR UPDATE
  USING (
    (app.current_role_name() = 'tenant' AND tenancy_id = ANY (app.visible_tenancy_ids()))
    OR (app.current_role_name() IN ('staff','manager','system_job')
        AND property_id = ANY (app.visible_property_ids()))
  )
  WITH CHECK (
    (app.current_role_name() = 'tenant' AND tenancy_id = ANY (app.visible_tenancy_ids()))
    OR (app.current_role_name() IN ('staff','manager','system_job')
        AND property_id = ANY (app.visible_property_ids()))
  );

-- Internal notes are filtered in the policy itself, not in a WHERE clause the
-- application has to remember on every read path.
CREATE POLICY work_order_events_read ON work_order_events
  FOR SELECT
  USING (
    (app.current_role_name() = 'tenant'
      AND tenancy_id = ANY (app.visible_tenancy_ids())
      AND visible_to_resident)
    OR (app.current_role_name() IN ('staff','manager','system_job')
        AND property_id = ANY (app.visible_property_ids()))
  );

CREATE POLICY work_order_events_insert ON work_order_events
  FOR INSERT
  WITH CHECK (
    (app.current_role_name() = 'tenant' AND tenancy_id = ANY (app.visible_tenancy_ids()))
    OR (app.current_role_name() IN ('staff','manager','system_job')
        AND property_id = ANY (app.visible_property_ids()))
  );

CREATE POLICY work_order_photos_read ON work_order_photos
  FOR SELECT
  USING (
    (app.current_role_name() = 'tenant' AND tenancy_id = ANY (app.visible_tenancy_ids()))
    OR (app.current_role_name() IN ('staff','manager','system_job')
        AND property_id = ANY (app.visible_property_ids()))
  );

CREATE POLICY work_order_photos_insert ON work_order_photos
  FOR INSERT
  WITH CHECK (
    (app.current_role_name() = 'tenant' AND tenancy_id = ANY (app.visible_tenancy_ids()))
    OR (app.current_role_name() IN ('staff','manager','system_job')
        AND property_id = ANY (app.visible_property_ids()))
  );

CREATE POLICY disputes_read ON charge_disputes
  FOR SELECT USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));
CREATE POLICY disputes_insert ON charge_disputes
  FOR INSERT WITH CHECK (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));
CREATE POLICY disputes_update ON charge_disputes
  FOR UPDATE
  USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()))
  WITH CHECK (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

-- ---------------------------------------------------------------------------
-- Notifications. A resident can read what was sent to them, which makes "I was
-- never told" a checkable claim rather than one person's word against another's.
-- ---------------------------------------------------------------------------

CREATE POLICY notification_events_read ON notification_events
  FOR SELECT
  USING (tenancy_id = ANY (app.visible_tenancy_ids())
         OR (app.current_role_name() IN ('manager','system_job')
             AND property_id = ANY (app.visible_property_ids())));

CREATE POLICY notification_events_insert ON notification_events
  FOR INSERT WITH CHECK (app.current_user_id() IS NOT NULL OR app.is_system_job());

CREATE POLICY notification_deliveries_read ON notification_deliveries
  FOR SELECT
  USING (
    (app.current_role_name() = 'tenant'
      AND tenancy_id = ANY (app.visible_tenancy_ids())
      AND audience = 'resident')
    OR (app.current_role_name() IN ('manager','system_job')
        AND property_id = ANY (app.visible_property_ids()))
  );

CREATE POLICY notification_deliveries_write ON notification_deliveries
  FOR INSERT WITH CHECK (app.current_user_id() IS NOT NULL OR app.is_system_job());

CREATE POLICY notification_deliveries_update ON notification_deliveries
  FOR UPDATE
  USING (app.is_system_job() OR app.current_role_name() = 'manager')
  WITH CHECK (app.is_system_job() OR app.current_role_name() = 'manager');
