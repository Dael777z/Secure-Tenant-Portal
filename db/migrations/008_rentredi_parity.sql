/* 008  Day-to-day management, as in RentRedi: maintenance stages, priority
   and type; more kinds of charge; late fee rules that post fees by
   themselves; rent reminders; and where the office is notified.
   Needs 001-007 (007 for Lease_Documents, 006 for Office_Settings).

   1. Maintenance_T: stages New → In review → Scheduled → In progress →
      Completed (resolved), a priority, a request type and the day it is
      scheduled for.
   2. Charge.kind adds parking, HOA, repairs billed to the resident,
      non-compliance fees and miscellaneous income.
   3. Late_Fee_Rules: one active rule for everything, per property or per
      unit (the unit's wins, then the property's). apply_late_fees() posts the
      fees as ordinary late_fee charges, once per rent charge per day late;
      Late_Fee_Postings remembers what it posted so a second run adds nothing.
   4. Rent_Reminder_Rules and Rent_Reminders_Sent: send_rent_reminders()
      records the reminders a tenant sees in the portal (before the due day,
      on it, and every day while late if the rule says so).
   5. Office_Settings: where the office is notified, and about what.

   Fees and reminders are worked out from the ledger: payments apply to the
   oldest charge first (the same rule as the app), counted in the property's
   time zone. Only an admin or the 'system' identity can run the jobs. */

/* ---- 1. Maintenance ---------------------------------------------------------- */
ALTER TABLE Maintenance_T DROP CONSTRAINT maintenance_t_status_check;
ALTER TABLE Maintenance_T ADD CONSTRAINT maintenance_t_status_check
    CHECK (status IN ('submitted', 'in_review', 'scheduled', 'in_progress', 'resolved'));
ALTER TABLE Maintenance_T
    ADD COLUMN priority      VARCHAR(10) NOT NULL DEFAULT 'none'
                             CHECK (priority IN ('none', 'low', 'medium', 'high', 'emergency')),
    ADD COLUMN request_type  VARCHAR(20) NOT NULL DEFAULT 'other'
                             CHECK (request_type IN ('appliance', 'plumbing', 'electrical', 'hvac', 'pest', 'locks', 'property', 'other')),
    ADD COLUMN scheduled_for DATE;

/* ---- 2. Kinds of charge ------------------------------------------------------- */
ALTER TABLE Charge DROP CONSTRAINT charge_kind_check;
ALTER TABLE Charge ADD CONSTRAINT charge_kind_check
    CHECK (kind IN ('rent', 'deposit', 'late_fee', 'utility', 'proration', 'other', 'parking', 'hoa', 'repair', 'non_compliance', 'misc_income'));

/* ---- 3. Late fee rules ------------------------------------------------------- */
CREATE TABLE Late_Fee_Rules (
    ruleID          SERIAL PRIMARY KEY,
    pID             INT REFERENCES Property(pID) ON DELETE RESTRICT,   -- null: every property
    uID             INT REFERENCES Units(uID)    ON DELETE RESTRICT,   -- null: every unit of pID
    grace_days      INT NOT NULL CHECK (grace_days BETWEEN 0 AND 60),  -- days late before the first fee
    first_amount    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (first_amount >= 0),
    first_type      VARCHAR(7) NOT NULL DEFAULT 'flat' CHECK (first_type IN ('flat', 'percent')),
    daily_amount    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (daily_amount >= 0),
    daily_type      VARCHAR(7) NOT NULL DEFAULT 'flat' CHECK (daily_type IN ('flat', 'percent')),
    max_amount      NUMERIC(10,2) CHECK (max_amount IS NULL OR max_amount > 0),   -- null: no limit
    max_type        VARCHAR(7) NOT NULL DEFAULT 'flat' CHECK (max_type IN ('flat', 'percent')),
    created_by      INT REFERENCES Admin(admin_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deactivated_at  TIMESTAMPTZ,
    CHECK (uID IS NULL OR pID IS NOT NULL),
    CHECK (first_amount > 0 OR daily_amount > 0),
    CHECK (first_type <> 'percent' OR first_amount <= 100),
    CHECK (daily_type <> 'percent' OR daily_amount <= 100),
    CHECK (max_type <> 'percent' OR max_amount IS NULL OR max_amount <= 100)
);
-- One active rule per scope (all / a property / a unit).
CREATE UNIQUE INDEX late_fee_rules_one_active ON Late_Fee_Rules (COALESCE(pID, 0), COALESCE(uID, 0)) WHERE deactivated_at IS NULL;

CREATE TABLE Late_Fee_Postings (
    rent_chargeID  INT NOT NULL REFERENCES Charge(chargeID) ON DELETE RESTRICT,
    days_late      INT NOT NULL CHECK (days_late >= 0),
    fee_chargeID   INT NOT NULL UNIQUE REFERENCES Charge(chargeID) ON DELETE RESTRICT,
    ruleID         INT NOT NULL REFERENCES Late_Fee_Rules(ruleID) ON DELETE RESTRICT,
    posted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rent_chargeID, days_late)
);

CREATE TRIGGER trg_audit_late_fee_rules AFTER INSERT OR UPDATE OR DELETE ON Late_Fee_Rules
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('ruleid');

/* ---- 4. Rent reminders -------------------------------------------------------- */
CREATE TABLE Rent_Reminder_Rules (
    ruleID            SERIAL PRIMARY KEY,
    pID               INT REFERENCES Property(pID) ON DELETE RESTRICT,
    uID               INT REFERENCES Units(uID)    ON DELETE RESTRICT,
    days_before       INT NOT NULL CHECK (days_before BETWEEN 0 AND 30),
    repeat_after_due  BOOLEAN NOT NULL DEFAULT true,
    created_by        INT REFERENCES Admin(admin_id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deactivated_at    TIMESTAMPTZ,
    CHECK (uID IS NULL OR pID IS NOT NULL)
);
CREATE UNIQUE INDEX reminder_rules_one_active ON Rent_Reminder_Rules (COALESCE(pID, 0), COALESCE(uID, 0)) WHERE deactivated_at IS NULL;
CREATE TRIGGER trg_audit_reminder_rules AFTER INSERT OR UPDATE OR DELETE ON Rent_Reminder_Rules
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('ruleid');

CREATE TABLE Rent_Reminders_Sent (
    remID      SERIAL PRIMARY KEY,
    LeaseID    INT NOT NULL REFERENCES Lease(LeaseID) ON DELETE RESTRICT,
    chargeID   INT REFERENCES Charge(chargeID) ON DELETE RESTRICT,   -- null for "coming up" (not billed yet)
    kind       VARCHAR(10) NOT NULL CHECK (kind IN ('upcoming', 'due', 'overdue')),
    due_date   DATE NOT NULL,
    amount     NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    sent_on    DATE NOT NULL,
    UNIQUE (LeaseID, due_date, kind, sent_on)
);
CREATE INDEX idx_reminders_lease ON Rent_Reminders_Sent (LeaseID, sent_on DESC);

/* ---- 5. Office notifications ----------------------------------------------------- */
ALTER TABLE Office_Settings
    ADD COLUMN notify_email             VARCHAR(254) CHECK (notify_email IS NULL OR notify_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    ADD COLUMN notify_new_maintenance   BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN notify_tenant_message    BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN notify_reported_payment  BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN notify_late_rent         BOOLEAN NOT NULL DEFAULT true;
GRANT UPDATE (notify_email, notify_new_maintenance, notify_tenant_message, notify_reported_payment, notify_late_rent) ON Office_Settings TO summit_app;

/* ---- Access -------------------------------------------------------------------- */
GRANT SELECT, INSERT, UPDATE ON Late_Fee_Rules, Late_Fee_Postings, Rent_Reminder_Rules, Rent_Reminders_Sent TO summit_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO summit_app;
ALTER TABLE Late_Fee_Rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE Late_Fee_Postings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE Rent_Reminder_Rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE Rent_Reminders_Sent ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_all ON Late_Fee_Rules      FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Late_Fee_Postings   FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Rent_Reminder_Rules FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
CREATE POLICY admin_all ON Rent_Reminders_Sent FOR ALL TO summit_app USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
-- A tenant reads the reminders on leases they are on.
CREATE POLICY tenant_read ON Rent_Reminders_Sent FOR SELECT TO summit_app
    USING (LeaseID IN (SELECT LeaseID FROM Lease_Tenants WHERE tID = (SELECT app_tenant_id())));

/* ---- The jobs ---------------------------------------------------------------------- */

/* What is still unpaid on a charge at the end of p_day: payments (less refunds)
   completed by then pay the lease's charges oldest due first. Runs with the
   caller's rights, so row-level security applies to anyone but the jobs. */
CREATE FUNCTION charge_unpaid_on(p_charge INT, p_day DATE, p_tz TEXT) RETURNS NUMERIC
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    WITH c AS (SELECT LeaseID, amount, due_date, chargeID FROM Charge WHERE chargeID = p_charge),
         owed AS (SELECT COALESCE(sum(x.amount), 0) AS s FROM Charge x, c
                   WHERE x.LeaseID = c.LeaseID AND (x.due_date, x.chargeID) <= (c.due_date, c.chargeID)),
         paid AS (SELECT COALESCE(sum(CASE WHEN p.direction = 'charge' THEN p.amount ELSE -p.amount END), 0) AS s FROM Payment p, c
                   WHERE p.LeaseID = c.LeaseID AND p.status = 'completed' AND (p."timestamp" AT TIME ZONE p_tz)::date <= p_day)
    SELECT GREATEST(0, LEAST(c.amount, owed.s - GREATEST(paid.s, 0))) FROM c, owed, paid
$$;

/* The active rule for a unit: its own, else its property's, else the rule for all. */
CREATE FUNCTION late_fee_rule_for(p_unit INT) RETURNS SETOF Late_Fee_Rules
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    SELECT r.* FROM Late_Fee_Rules r JOIN Units u ON u.uID = p_unit
     WHERE r.deactivated_at IS NULL
       AND (r.uID = p_unit OR (r.uID IS NULL AND r.pID = u.pID) OR (r.uID IS NULL AND r.pID IS NULL))
     ORDER BY (r.uID IS NULL), (r.pID IS NULL)
     LIMIT 1
$$;

CREATE FUNCTION reminder_rule_for(p_unit INT) RETURNS SETOF Rent_Reminder_Rules
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    SELECT r.* FROM Rent_Reminder_Rules r JOIN Units u ON u.uID = p_unit
     WHERE r.deactivated_at IS NULL
       AND (r.uID = p_unit OR (r.uID IS NULL AND r.pID = u.pID) OR (r.uID IS NULL AND r.pID IS NULL))
     ORDER BY (r.uID IS NULL), (r.pID IS NULL)
     LIMIT 1
$$;

/* A fee in dollars: flat, or a percent of the rent (rounded to the cent). */
CREATE FUNCTION late_fee_amount(p_amount NUMERIC, p_type TEXT, p_rent NUMERIC) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN p_type = 'percent' THEN round(p_rent * p_amount) / 100 ELSE p_amount END
$$;

/* Post every late fee due by p_today that is not posted yet. For each rent
   charge, the first fee on the grace day and the daily fee on each day after,
   while it was unpaid on that day, never more than the rule's limit in all,
   and never for a day before the rule existed. Safe to repeat. Returns how
   many fees it added. */
CREATE FUNCTION apply_late_fees(p_today DATE, p_tz TEXT) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    rc       RECORD;
    rule     Late_Fee_Rules%ROWTYPE;
    k        INT;
    d        DATE;
    fee      NUMERIC;
    cap      NUMERIC;
    posted   NUMERIC;
    fee_id   INT;
    added    INT := 0;
BEGIN
    IF NOT COALESCE(app_is_admin() OR app_user_type() = 'system', false) THEN
        RETURN 0;
    END IF;
    FOR rc IN SELECT c.chargeID, c.LeaseID, c.amount, c.due_date, l.uID
                FROM Charge c JOIN Lease l ON l.LeaseID = c.LeaseID
               WHERE c.kind = 'rent' AND c.due_date < p_today
               ORDER BY c.due_date, c.chargeID LOOP
        SELECT * INTO rule FROM late_fee_rule_for(rc.uID);
        CONTINUE WHEN NOT FOUND;
        CONTINUE WHEN rc.due_date + rule.grace_days > p_today;
        cap := CASE WHEN rule.max_amount IS NULL THEN NULL ELSE late_fee_amount(rule.max_amount, rule.max_type, rc.amount) END;
        SELECT COALESCE(sum(fc.amount), 0) INTO posted
          FROM Late_Fee_Postings lp JOIN Charge fc ON fc.chargeID = lp.fee_chargeID
         WHERE lp.rent_chargeID = rc.chargeID;
        CONTINUE WHEN cap IS NOT NULL AND posted >= cap;
        FOR k IN rule.grace_days .. (p_today - rc.due_date) LOOP
            d := rc.due_date + k;
            CONTINUE WHEN d < (rule.created_at AT TIME ZONE p_tz)::date;
            CONTINUE WHEN EXISTS (SELECT 1 FROM Late_Fee_Postings WHERE rent_chargeID = rc.chargeID AND days_late = k);
            -- Paid by that day: no fee that day, nor any day after.
            EXIT WHEN charge_unpaid_on(rc.chargeID, d, p_tz) <= 0;
            fee := CASE WHEN k = rule.grace_days THEN late_fee_amount(rule.first_amount, rule.first_type, rc.amount)
                        ELSE late_fee_amount(rule.daily_amount, rule.daily_type, rc.amount) END;
            IF cap IS NOT NULL THEN fee := LEAST(fee, cap - posted); END IF;
            CONTINUE WHEN fee <= 0;
            INSERT INTO Charge (LeaseID, kind, amount, due_date, description)
            VALUES (rc.LeaseID, 'late_fee', fee, d,
                    'Late fee - ' || to_char(rc.due_date, 'FMMonth YYYY') || ' rent, ' || k || ' day' || CASE WHEN k = 1 THEN '' ELSE 's' END || ' late')
            RETURNING chargeID INTO fee_id;
            INSERT INTO Late_Fee_Postings (rent_chargeID, days_late, fee_chargeID, ruleID) VALUES (rc.chargeID, k, fee_id, rule.ruleID);
            posted := posted + fee;
            added := added + 1;
            EXIT WHEN cap IS NOT NULL AND posted >= cap;
        END LOOP;
    END LOOP;
    RETURN added;
END $$;

/* Record today's reminders: "coming up" days_before the next due day, "due"
   on the day, and "overdue" every day while a rent charge is unpaid (when the
   rule repeats). Safe to repeat. Returns how many it recorded. */
CREATE FUNCTION send_rent_reminders(p_today DATE, p_tz TEXT) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    l       RECORD;
    rule    Rent_Reminder_Rules%ROWTYPE;
    target  DATE;
    m       INT;
    rc      RECORD;
    unpaid  NUMERIC;
    n       INT;
    added   INT := 0;
BEGIN
    IF NOT COALESCE(app_is_admin() OR app_user_type() = 'system', false) THEN
        RETURN 0;
    END IF;
    FOR l IN SELECT LeaseID, uID, start_date, end_date, monthly_rent FROM Lease
              WHERE start_date <= p_today + 30 AND (end_date IS NULL OR end_date >= p_today) LOOP
        SELECT * INTO rule FROM reminder_rule_for(l.uID);
        CONTINUE WHEN NOT FOUND;

        -- Coming up: is p_today + days_before one of this lease's due days?
        IF rule.days_before > 0 THEN
            target := p_today + rule.days_before;
            m := ((extract(year FROM target) - extract(year FROM l.start_date)) * 12
                  + extract(month FROM target) - extract(month FROM l.start_date))::int;
            IF m >= 0 AND (l.start_date + m * interval '1 month')::date = target
               AND (l.end_date IS NULL OR target <= l.end_date) THEN
                INSERT INTO Rent_Reminders_Sent (LeaseID, chargeID, kind, due_date, amount, sent_on)
                VALUES (l.LeaseID, NULL, 'upcoming', target, l.monthly_rent, p_today)
                ON CONFLICT DO NOTHING;
                GET DIAGNOSTICS n = ROW_COUNT;
                added := added + n;
            END IF;
        END IF;

        -- Due today, and (if the rule repeats) still unpaid after the due day.
        FOR rc IN SELECT chargeID, due_date FROM Charge
                   WHERE LeaseID = l.LeaseID AND kind = 'rent' AND due_date <= p_today
                     AND (due_date = p_today OR rule.repeat_after_due) LOOP
            unpaid := charge_unpaid_on(rc.chargeID, p_today, p_tz);
            CONTINUE WHEN unpaid <= 0;
            INSERT INTO Rent_Reminders_Sent (LeaseID, chargeID, kind, due_date, amount, sent_on)
            VALUES (l.LeaseID, rc.chargeID, CASE WHEN rc.due_date = p_today THEN 'due' ELSE 'overdue' END, rc.due_date, unpaid, p_today)
            ON CONFLICT DO NOTHING;
            GET DIAGNOSTICS n = ROW_COUNT;
            added := added + n;
        END LOOP;
    END LOOP;
    RETURN added;
END $$;

COMMENT ON TABLE Late_Fee_Rules IS 'Late fee rules: one active per scope (all, a property, a unit). Retired with deactivated_at.';
COMMENT ON TABLE Late_Fee_Postings IS 'Which late fee charge apply_late_fees() posted for which rent charge and day late.';
COMMENT ON TABLE Rent_Reminder_Rules IS 'When tenants are reminded about rent: days before, and daily while late.';
COMMENT ON TABLE Rent_Reminders_Sent IS 'The reminders recorded for each lease (shown to the tenant in the portal).';
