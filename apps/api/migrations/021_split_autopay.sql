-- ---------------------------------------------------------------------------
-- 021  Split-rent autopay: each resident on a shared lease can have their own.
--
-- Until now a lease had one autopay, which drafted the whole balance from one
-- person's bank account. Roommates who split the rent had to pay by hand, or
-- pay each other back.
--
-- Now an autopay is either:
--   * the WHOLE BALANCE (share_cents IS NULL), as before. It is the only
--     autopay on the lease while it is on; or
--   * ONE PERSON'S SHARE (share_cents set): a fixed amount each month from that
--     person's own bank account. Each resident on the lease can have one, and a
--     lease can have several.
-- A lease never has both kinds at once: a whole-balance draft on top of the
-- shares would take the rent twice.
--
-- Each autopay belongs to the person who set it up, and draws on their own
-- bank account (016). Only they can change or stop it; the office can stop any.
-- ---------------------------------------------------------------------------

ALTER TABLE autopay_enrollments
  ADD COLUMN share_cents bigint CHECK (share_cents IS NULL OR share_cents > 0);

-- Every autopay records whose it is. Older rows without it belong to the owner
-- of the bank account they draw on.
UPDATE autopay_enrollments a SET created_by_user_id = m.user_id
FROM payment_methods m
WHERE m.id = a.payment_method_id AND a.created_by_user_id IS NULL;

-- One active autopay per person per lease (was: per lease).
DROP INDEX autopay_one_active_per_tenancy;
CREATE UNIQUE INDEX autopay_one_active_per_person
  ON autopay_enrollments (tenancy_id, created_by_user_id) WHERE active;

-- Fill in the owner, and keep the two kinds apart. Serialized per lease with an
-- advisory lock, so two roommates saving at the same moment cannot both get in.
CREATE OR REPLACE FUNCTION app.autopay_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  owner_id uuid;
BEGIN
  SELECT m.user_id INTO owner_id FROM payment_methods m WHERE m.id = NEW.payment_method_id;
  IF NEW.created_by_user_id IS NULL THEN
    NEW.created_by_user_id := owner_id;
  END IF;
  -- A share is always drawn from the sharer's own account.
  IF NEW.share_cents IS NOT NULL AND owner_id IS DISTINCT FROM NEW.created_by_user_id THEN
    RAISE EXCEPTION 'an autopay share must draw on the bank account of the person it belongs to'
      USING ERRCODE = '23514';
  END IF;

  IF NOT NEW.active THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('autopay:' || NEW.tenancy_id::text));

  IF NEW.share_cents IS NULL AND EXISTS (
    SELECT 1 FROM autopay_enrollments a
    WHERE a.tenancy_id = NEW.tenancy_id AND a.active AND a.id <> NEW.id
      AND a.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id
  ) THEN
    RAISE EXCEPTION 'another resident already has autopay on this lease; autopay for the whole balance would draft the rent twice'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.share_cents IS NOT NULL AND EXISTS (
    SELECT 1 FROM autopay_enrollments a
    WHERE a.tenancy_id = NEW.tenancy_id AND a.active AND a.id <> NEW.id
      AND a.share_cents IS NULL
      AND a.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id
  ) THEN
    RAISE EXCEPTION 'this lease already has autopay for the whole balance; it has to be turned off before anyone sets up a share'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER autopay_enrollments_rules
  BEFORE INSERT OR UPDATE OF active, share_cents, payment_method_id ON autopay_enrollments
  FOR EACH ROW EXECUTE FUNCTION app.autopay_rules();

ALTER TABLE autopay_enrollments ALTER COLUMN created_by_user_id SET NOT NULL;
