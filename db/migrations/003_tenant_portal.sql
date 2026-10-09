-- ---------------------------------------------------------------------------
-- 003  What Juan's tenant pages and Dael's Plaid flow need from the database.
--
-- Additions only: nothing in 001/002 changes meaning, and every new column
-- has a default, so existing rows and Angel's own queries keep working.
-- Proposed in docs/M1-DATABASE-INTEGRATION.md; Angel can rename or reshape.
-- ---------------------------------------------------------------------------

-- Juan's Maintenance page shows a title, a description and a submitted date.
ALTER TABLE Maintenance_T
  ADD COLUMN title        VARCHAR(120) NOT NULL DEFAULT 'Maintenance request',
  ADD COLUMN description  TEXT NOT NULL DEFAULT '',
  ADD COLUMN created_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- Juan's ledger shows who paid how, with a confirmation number. A lease can
-- have several payers (Lease_Tenants), so the payment records which one.
ALTER TABLE Payment
  ADD COLUMN tID           INT REFERENCES Tenants(tID) ON DELETE SET NULL,
  ADD COLUMN method        VARCHAR(60),
  ADD COLUMN confirmation  VARCHAR(30) UNIQUE;

-- Dael's Plaid link. What is kept is what is needed to use the account again
-- and to show it to the tenant: Plaid's ids, the encrypted access token, and
-- the last four digits. The full account number is not stored (client, 9/27:
-- name, email and phone only).
CREATE TABLE Bank_Accounts (
  bID                SERIAL PRIMARY KEY,
  tID                INT NOT NULL REFERENCES Tenants(tID) ON DELETE CASCADE,
  plaid_item_id      VARCHAR(100) NOT NULL,
  plaid_account_id   VARCHAR(100) NOT NULL,
  access_token_enc   TEXT NOT NULL,          -- AES-256-GCM, see src/utils/secrets.ts
  name               VARCHAR(120) NOT NULL,
  mask               VARCHAR(4),
  subtype            VARCHAR(40),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tID, plaid_account_id)
);
