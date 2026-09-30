-- ---------------------------------------------------------------------------
-- 002  Identity: organizations, properties, units, people, and tenancies.
--
-- Every table that will ever hold resident data carries `property_id` from the
-- start, even where it is derivable by join. RLS policies that must join to
-- decide visibility are both slower and easier to get wrong than policies that
-- read a column on the row in front of them.
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  legal_name      text,
  contact_email   text NOT NULL,
  contact_phone   text,
  timezone        text NOT NULL DEFAULT 'America/Denver',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE properties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  address_line1   text NOT NULL,
  address_line2   text,
  city            text NOT NULL,
  state           text NOT NULL,
  postal_code     text NOT NULL,
  unit_count      integer NOT NULL DEFAULT 0 CHECK (unit_count >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE units (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  label           text NOT NULL,
  bedrooms        smallint CHECK (bedrooms >= 0),
  bathrooms       numeric(3,1) CHECK (bathrooms >= 0),
  square_feet     integer CHECK (square_feet > 0),
  market_rent_cents bigint NOT NULL DEFAULT 0 CHECK (market_rent_cents >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, label)
);

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- Stored lowercase and constrained to it, so that address comparison is a
  -- plain equality test everywhere instead of a lower() call someone forgets.
  email                 text NOT NULL CHECK (email = lower(email) AND position('@' in email) > 1),
  display_name          text NOT NULL,
  phone                 text,
  role                  text NOT NULL CHECK (role IN ('tenant','staff','manager','owner')),
  password_hash         text NOT NULL,
  password_algorithm    text NOT NULL DEFAULT 'scrypt',
  must_change_password  boolean NOT NULL DEFAULT false,
  failed_login_count    integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (email);

COMMENT ON COLUMN users.password_algorithm IS
  'Which KDF produced password_hash. Rows are re-hashed on next successful login when this is not the current algorithm, so a parameter upgrade never requires a reset email.';

-- A tenancy is the relationship between a resident and a unit over a span of
-- time. It — not the user and not the unit — is what the ledger hangs from,
-- because a resident who moves between units keeps two distinct rent records and
-- a unit outlives every resident in it.
CREATE TABLE tenancies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  unit_id             uuid NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  resident_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  starts_on           date NOT NULL,
  ends_on             date,
  monthly_rent_cents  bigint NOT NULL CHECK (monthly_rent_cents >= 0),
  rent_due_day        smallint NOT NULL DEFAULT 1 CHECK (rent_due_day BETWEEN 1 AND 31),
  deposit_cents       bigint NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('pending','active','ended','evicted')),
  -- Set when a payment fails through no fault of the resident. While this is in
  -- the future, no late fee accrues. It is a column rather than an inference so
  -- that both parties can see the pause and its reason on the ledger.
  late_fee_hold_until date,
  late_fee_hold_reason text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

-- One active tenancy per unit at a time. Two active tenancies on one unit means
-- two people are being charged for the same room, which is the kind of error
-- that should be impossible rather than caught in review.
CREATE UNIQUE INDEX tenancies_one_active_per_unit
  ON tenancies (unit_id) WHERE status = 'active';

-- Which properties a staff member, manager, or owner may reach. A resident has
-- no row here; their access comes from their tenancy.
CREATE TABLE staff_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  granted_by      uuid REFERENCES users(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  UNIQUE (user_id, property_id)
);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The token itself is never stored. What is stored is a SHA-256 of it, so a
  -- database disclosure does not hand an attacker a set of live sessions.
  token_hash      text NOT NULL UNIQUE,
  csrf_token      text NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  -- Rotation: a refreshed session supersedes its predecessor rather than
  -- extending it, so a stolen token has a bounded life even if it is never used.
  rotated_from    uuid REFERENCES sessions(id) ON DELETE SET NULL,
  revoked_at      timestamptz,
  user_agent      text,
  ip_address      inet
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER properties_touch BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER tenancies_touch BEFORE UPDATE ON tenancies
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
