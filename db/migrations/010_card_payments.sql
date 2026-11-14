/* 010  Debit/credit cards, Apple Pay and Google Pay, through Stripe. Additive, like 002-009.
   Needs 001-009 (008 for the current list of charge kinds).

   A card payment is one Payment row, written when the tenant presses Pay:
   status 'pending', transaction_id = the Stripe PaymentIntent (pi_...), and the
   card in Payment_Details.method ("Visa •••• 4242", "Apple Pay (Visa •••• 4242)").
   Pending payments do not move the balance (lease_balance counts completed ones
   only). When Stripe says the money arrived, the row becomes 'completed' and the
   payment is on the ledger; a PaymentIntent Stripe cancels becomes 'failed'. A
   refund made in Stripe is its own 'refund' row (transaction_id = re_...), like
   every other correction.

   To Stripe, Apple Pay and Google Pay are cards, so method_type is 'card' and
   `wallet` says which, if any. The card details are what Stripe shows (brand and
   last four digits); card numbers never reach this server.

   The processing fee is passed on to the tenant: the checkout charges rent + fee,
   and when it completes the fee becomes its own Charge (kind 'processing_fee'),
   so the balance goes down by exactly the rent and the ledger shows the fee.

   Stripe_Payments keeps what Stripe says about each payment; Stripe_Events records
   every webhook event handled. Both are written as 'system' only. */

/* ---- A payment's status only moves forward ----------------------------------
   pending → completed or failed; completed and failed are final. (001's guard
   already keeps every other column fixed; 006's office review only decides
   pending reports.) */
CREATE FUNCTION payment_guard_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'a % payment cannot become %', OLD.status, NEW.status
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_payment_guard_status BEFORE UPDATE OF status ON Payment
    FOR EACH ROW EXECUTE FUNCTION payment_guard_status();

/* ---- The processing fee is a kind of charge ---------------------------------- */
ALTER TABLE Charge DROP CONSTRAINT charge_kind_check;
ALTER TABLE Charge ADD CONSTRAINT charge_kind_check
    CHECK (kind IN ('rent', 'deposit', 'late_fee', 'utility', 'proration', 'other', 'parking', 'hoa', 'repair', 'non_compliance', 'misc_income',
                    'processing_fee'));

/* ---- Stripe_Payments: one row per Payment that went through Stripe ---------- */
CREATE TABLE Stripe_Payments (
    payID                  INT PRIMARY KEY REFERENCES Payment(payID) ON DELETE RESTRICT,
    payment_intent_id      VARCHAR(255) NOT NULL UNIQUE CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
    method_type            VARCHAR(30) NOT NULL CHECK (method_type IN ('card')),   -- widen for other Stripe methods
    amount_cents           INT NOT NULL CHECK (amount_cents > 0),                   -- what was charged, fee included
    amount_received_cents  INT NOT NULL DEFAULT 0 CHECK (amount_received_cents >= 0),
    currency               CHAR(3) NOT NULL DEFAULT 'usd',
    stripe_status          VARCHAR(40) NOT NULL,          -- the PaymentIntent's status, as last seen
    failure_message        TEXT,                          -- Stripe's last error, shown to nobody but staff
    fee_cents              INT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),           -- the processing fee inside amount_cents
    fee_charge_id          INT UNIQUE REFERENCES Charge(chargeID) ON DELETE RESTRICT, -- the Charge it became (set once)
    card_brand             VARCHAR(20),                   -- visa, mastercard, amex, discover, ...
    card_last4             CHAR(4) CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
    card_funding           VARCHAR(10),                   -- credit, debit, prepaid, unknown
    wallet                 VARCHAR(20) CHECK (wallet IS NULL OR wallet IN ('apple_pay', 'google_pay', 'link', 'samsung_pay', 'masterpass', 'visa_checkout', 'amex_express_checkout')),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT stripe_fee_within_amount CHECK (fee_cents < amount_cents)
);
CREATE TRIGGER trg_stripe_payments_updated BEFORE UPDATE ON Stripe_Payments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_stripe_payments AFTER INSERT OR UPDATE OR DELETE ON Stripe_Payments
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('payid');
CREATE TRIGGER trg_stripe_payments_no_delete BEFORE DELETE ON Stripe_Payments
    FOR EACH ROW EXECUTE FUNCTION forbid_modification();

ALTER TABLE Stripe_Payments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON Stripe_Payments TO summit_app;
CREATE POLICY system_all ON Stripe_Payments FOR ALL TO summit_app
    USING ((SELECT app_user_type()) = 'system') WITH CHECK ((SELECT app_user_type()) = 'system');
CREATE POLICY admin_read ON Stripe_Payments FOR SELECT TO summit_app
    USING ((SELECT app_is_admin()));
-- A tenant sees the ones on their own leases (the same rule as Payment).
CREATE POLICY tenant_read ON Stripe_Payments FOR SELECT TO summit_app
    USING (EXISTS (SELECT 1 FROM Payment p WHERE p.payID = Stripe_Payments.payID));

/* ---- Stripe_Events: every webhook event handled, once ----------------------- */
CREATE TABLE Stripe_Events (
    event_id     VARCHAR(255) PRIMARY KEY,           -- evt_...
    type         VARCHAR(100) NOT NULL,              -- payment_intent.succeeded, charge.refunded, ...
    object_id    VARCHAR(255),                       -- the pi_ / ch_ / re_ it was about
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE Stripe_Events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON Stripe_Events TO summit_app;    -- append-only
CREATE POLICY system_all ON Stripe_Events FOR ALL TO summit_app
    USING ((SELECT app_user_type()) = 'system') WITH CHECK ((SELECT app_user_type()) = 'system');
CREATE POLICY admin_read ON Stripe_Events FOR SELECT TO summit_app
    USING ((SELECT app_is_admin()));

/* ---- 'system' (which settles Stripe payments) may add a processing fee, and see the ones
   it added (INSERT ... RETURNING needs that); nothing else on Charge. ---------------- */
CREATE POLICY system_fee_insert ON Charge FOR INSERT TO summit_app
    WITH CHECK ((SELECT app_user_type()) = 'system' AND kind = 'processing_fee');
CREATE POLICY system_fee_read ON Charge FOR SELECT TO summit_app
    USING ((SELECT app_user_type()) = 'system' AND kind = 'processing_fee');
