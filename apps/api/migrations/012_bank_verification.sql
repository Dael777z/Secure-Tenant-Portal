-- ---------------------------------------------------------------------------
-- 012  Bank-account verification by micro-deposits.
--
-- With the portal set to bank transfers only, a resident who adds a bank
-- account must be able to prove it is theirs, or they can never pay: before
-- this migration nothing ever marked an account verified. This is the manual
-- rung of the fallback ladder the RentRedi audit describes (instant bank login
-- → micro-deposits): the processor sends two small deposits, the resident types
-- the amounts back, and three wrong tries lock the account for review.
-- ---------------------------------------------------------------------------

ALTER TABLE payment_methods
  ADD COLUMN verification_attempts smallint NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0),
  ADD COLUMN verification_locked_at timestamptz;
