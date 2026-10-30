/* 007  The Cash App Pay processing fee, passed on to the tenant. Additive.

   A Cash App checkout charges rent + fee. When it completes, the fee becomes its
   own Charge (kind 'processing_fee') on the lease, and the Payment is the whole
   amount, so the balance goes down by exactly the rent and the ledger shows the fee.
   Stripe_Payments.fee_cents is the fee inside amount_cents; fee_charge_id is the
   Charge it became (set once, so the fee is never charged twice). */

ALTER TABLE Charge DROP CONSTRAINT charge_kind_check;
ALTER TABLE Charge ADD CONSTRAINT charge_kind_check
    CHECK (kind IN ('rent', 'deposit', 'late_fee', 'utility', 'proration', 'other', 'processing_fee'));

ALTER TABLE Stripe_Payments
    ADD COLUMN fee_cents      INT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
    ADD COLUMN fee_charge_id  INT UNIQUE REFERENCES Charge(chargeID) ON DELETE RESTRICT,
    ADD CONSTRAINT stripe_fee_within_amount CHECK (fee_cents < amount_cents);

/* 'system' (which settles Stripe payments) may add a processing fee, and see the ones
   it added (INSERT ... RETURNING needs that); nothing else on Charge. */
CREATE POLICY system_fee_insert ON Charge FOR INSERT TO summit_app
    WITH CHECK ((SELECT app_user_type()) = 'system' AND kind = 'processing_fee');
CREATE POLICY system_fee_read ON Charge FOR SELECT TO summit_app
    USING ((SELECT app_user_type()) = 'system' AND kind = 'processing_fee');
