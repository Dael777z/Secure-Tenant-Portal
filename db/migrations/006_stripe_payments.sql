/* 006  Online payments through Stripe (Cash App Pay first). Additive, like 002-005.

   A tenant's Cash App payment is one Payment row, written when the checkout
   starts: status 'pending', transaction_id = the Stripe PaymentIntent (pi_...),
   method 'Cash App Pay' in Payment_Details. Pending payments do not move the
   balance (lease_balance counts completed ones only). When Stripe says the money
   arrived, the row becomes 'completed' and the payment is on the ledger; a
   checkout Stripe cancels becomes 'failed'. A refund made in Stripe is its own
   'refund' row (transaction_id = re_...), like every other correction.

   Stripe_Payments keeps what Stripe says about each one; Stripe_Events records
   every webhook event handled. Both are written as 'system' only. */

/* ---- A payment's status only moves forward ----------------------------------
   pending → completed or failed; completed and failed are final. (001's guard
   already keeps every other column fixed.) */
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

/* ---- Stripe_Payments: one row per Payment that went through Stripe ---------- */
CREATE TABLE Stripe_Payments (
    payID              INT PRIMARY KEY REFERENCES Payment(payID) ON DELETE RESTRICT,
    payment_intent_id  VARCHAR(255) NOT NULL UNIQUE CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
    method_type        VARCHAR(30) NOT NULL CHECK (method_type IN ('cashapp')),   -- widen for cards, wallets...
    amount_cents       INT NOT NULL CHECK (amount_cents > 0),                      -- what was asked for
    amount_received_cents INT NOT NULL DEFAULT 0 CHECK (amount_received_cents >= 0),
    currency           CHAR(3) NOT NULL DEFAULT 'usd',
    stripe_status      VARCHAR(40) NOT NULL,          -- the PaymentIntent's status, as last seen
    cashtag            VARCHAR(64),                   -- the payer's $cashtag, once Cash App shares it
    failure_message    TEXT,                          -- Stripe's last error, shown to nobody but staff
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
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
