/* 005  Finance: expenses for Profit & Loss, and lease renewal notices.
   Additive, like 002–004: no earlier table or policy is edited.

   Income needs no new table: it is the ledger (Charge and Payment). What the
   portal could not record before is money going out, so the office can see
   profit and loss per property and per month. And for the 90-day lease
   expiration list, a record of when the office sent the renewal notice, so
   no one sends it twice and the list shows who has been contacted.

   Both are property managers' only ('admin'): maintenance staff and tenants
   see neither. Nothing is deleted: an expense entered by mistake is voided
   (voided_at), and stays in the audit log. */

CREATE TABLE Expenses (
    expID        SERIAL PRIMARY KEY,
    pID          INT REFERENCES Property(pID) ON DELETE RESTRICT,   -- null: the whole portfolio (insurance, software)
    uID          INT REFERENCES Units(uID) ON DELETE RESTRICT,      -- optional: a repair on one unit
    category     VARCHAR(30) NOT NULL
                 CHECK (category IN ('repairs','utilities','insurance','taxes','mortgage','management','supplies','legal','marketing','other')),
    amount       NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    spent_on     DATE NOT NULL,
    vendor       VARCHAR(120),
    description  VARCHAR(300),
    created_by   INT REFERENCES Admin(admin_id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    voided_at    TIMESTAMPTZ,                                       -- set instead of deleting
    -- A unit, when given, must belong to the property.
    CHECK (uID IS NULL OR pID IS NOT NULL)
);
CREATE INDEX idx_expenses_spent ON Expenses(spent_on) WHERE voided_at IS NULL;
CREATE INDEX idx_expenses_property ON Expenses(pID) WHERE voided_at IS NULL;

CREATE FUNCTION expense_unit_matches_property() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.uID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM Units WHERE uID = NEW.uID AND pID = NEW.pID) THEN
        RAISE EXCEPTION 'unit % is not in property %', NEW.uID, NEW.pID USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_expense_unit BEFORE INSERT OR UPDATE ON Expenses
    FOR EACH ROW EXECUTE FUNCTION expense_unit_matches_property();
CREATE TRIGGER trg_audit_expenses AFTER INSERT OR UPDATE OR DELETE ON Expenses
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('expid');

ALTER TABLE Expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_all ON Expenses FOR ALL TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
GRANT SELECT, INSERT ON Expenses TO summit_app;
GRANT UPDATE (voided_at) ON Expenses TO summit_app;          -- the only change: void it

/* When the office told a lease's residents that it ends soon (the renewal
   notice). One row per notice; the newest per lease is what the list shows. */
CREATE TABLE Lease_Renewal_Notices (
    noticeID   SERIAL PRIMARY KEY,
    LeaseID    INT NOT NULL REFERENCES Lease(LeaseID) ON DELETE RESTRICT,
    sent_by    INT REFERENCES Admin(admin_id),
    sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    recipients INT NOT NULL CHECK (recipients >= 0)            -- residents messaged
);
CREATE INDEX idx_renewal_lease ON Lease_Renewal_Notices(LeaseID, sent_at DESC);

ALTER TABLE Lease_Renewal_Notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_all ON Lease_Renewal_Notices FOR ALL TO summit_app
    USING ((SELECT app_is_admin())) WITH CHECK ((SELECT app_is_admin()));
GRANT SELECT, INSERT ON Lease_Renewal_Notices TO summit_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO summit_app;
