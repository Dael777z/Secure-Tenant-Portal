-- ---------------------------------------------------------------------------
-- 015  Late-fee terms per lease.
--
-- Decided with the client on 2026-09-28: late fees are applied automatically,
-- but the terms belong to the lease, not only to the building. Most leases
-- charge after the 5th; some commercial leases charge after the 1st.
--
-- A lease with a row here uses it. A lease without one uses its property's
-- policy (006), so nothing changes for a lease until a manager sets its terms.
-- A fee that was applied is still removed the way every ledger row is — a
-- waiver that appends a reversal (plans.waiveFee) — never by deleting it.
-- ---------------------------------------------------------------------------

CREATE TABLE lease_late_fee_policies (
  tenancy_id        uuid PRIMARY KEY REFERENCES tenancies(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  enabled           boolean NOT NULL DEFAULT true,
  grace_days        smallint NOT NULL DEFAULT 5 CHECK (grace_days BETWEEN 0 AND 30),
  fee_type          text NOT NULL DEFAULT 'flat' CHECK (fee_type IN ('flat','percent')),
  flat_cents        bigint NOT NULL DEFAULT 0 CHECK (flat_cents >= 0),
  percent           numeric(5,2) NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 25),
  daily_cents       bigint NOT NULL DEFAULT 0 CHECK (daily_cents >= 0),
  max_cents         bigint NOT NULL DEFAULT 0 CHECK (max_cents >= 0),
  min_balance_cents bigint NOT NULL DEFAULT 0 CHECK (min_balance_cents >= 0),
  -- Why this lease differs, e.g. "Commercial lease, section 4(b)".
  note              text CHECK (note IS NULL OR length(note) <= 200),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lease_late_fee_policies_property_idx ON lease_late_fee_policies (property_id);

-- Organization and property come from the tenancy, so they cannot disagree
-- with it whatever the caller sends.
CREATE OR REPLACE FUNCTION app.lease_policy_from_tenancy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  SELECT t.organization_id, t.property_id INTO NEW.organization_id, NEW.property_id
  FROM tenancies t WHERE t.id = NEW.tenancy_id;
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'no such lease' USING ERRCODE = '23503';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER lease_late_fee_policies_scope
  BEFORE INSERT OR UPDATE ON lease_late_fee_policies
  FOR EACH ROW EXECUTE FUNCTION app.lease_policy_from_tenancy();

ALTER TABLE lease_late_fee_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_late_fee_policies FORCE ROW LEVEL SECURITY;

-- The resident reads the terms they are held to; staff read no lease terms.
CREATE POLICY lease_late_fee_read ON lease_late_fee_policies
  FOR SELECT USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));

CREATE POLICY lease_late_fee_write ON lease_late_fee_policies
  FOR ALL
  USING (app.current_role_name() IN ('manager','system_job') AND tenancy_id = ANY (app.visible_tenancy_ids()))
  WITH CHECK (app.current_role_name() IN ('manager','system_job') AND tenancy_id = ANY (app.visible_tenancy_ids()));

-- DELETE is how a lease goes back to its property's policy. It removes terms,
-- never money: applied fees live in the ledger.
GRANT SELECT, INSERT, UPDATE, DELETE ON lease_late_fee_policies TO portal_app;
