-- ---------------------------------------------------------------------------
-- 001  Core schema, transcribed from Angel's table sheet and ERD (10/1/2026).
--
-- Table and column names are Angel's, unchanged (Postgres folds unquoted
-- names to lower case, so "UnitNum" is stored as unitnum and both spellings
-- work in queries). Changes agreed afterwards go in later files, never here,
-- so this file always matches the sheet.
-- ---------------------------------------------------------------------------

CREATE TABLE Property (
  pID      SERIAL PRIMARY KEY,
  Name     VARCHAR(255) NOT NULL,
  Address  TEXT NOT NULL
);

CREATE TABLE Units (
  uID      SERIAL PRIMARY KEY,
  pID      INT NOT NULL REFERENCES Property(pID) ON DELETE CASCADE,
  UnitNum  VARCHAR(20) NOT NULL
);

CREATE TABLE Tenants (
  tID            SERIAL PRIMARY KEY,
  Name           VARCHAR(255) NOT NULL,
  Phone          VARCHAR(20),
  Email          VARCHAR(255) NOT NULL UNIQUE,   -- login identifier
  password_hash  TEXT NOT NULL
);

CREATE TABLE Lease (
  LeaseID       SERIAL PRIMARY KEY,
  uID           INT NOT NULL REFERENCES Units(uID) ON DELETE RESTRICT,
  start_date    DATE NOT NULL,
  end_date      DATE,
  ammount_owed  NUMERIC(10,2) NOT NULL
);

-- Several tenants on one lease (cosigners / payees), one tenant on several leases.
CREATE TABLE Lease_Tenants (
  LeaseID  INT NOT NULL REFERENCES Lease(LeaseID) ON DELETE CASCADE,
  tID      INT NOT NULL REFERENCES Tenants(tID) ON DELETE CASCADE,
  PRIMARY KEY (LeaseID, tID)
);

CREATE TABLE Payment (
  payID      SERIAL PRIMARY KEY,
  LeaseID    INT NOT NULL REFERENCES Lease(LeaseID) ON DELETE RESTRICT,
  ammount    NUMERIC(10,2) NOT NULL,
  timestamp  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE Maintenance_T (
  mID     SERIAL PRIMARY KEY,
  uID     INT NOT NULL REFERENCES Units(uID) ON DELETE CASCADE,
  tID     INT REFERENCES Tenants(tID) ON DELETE SET NULL,
  status  VARCHAR(20) NOT NULL DEFAULT 'submitted'
          CHECK (status IN ('submitted', 'in_progress', 'resolved'))
);

CREATE TABLE Admin (
  admin_id       SERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  email          VARCHAR(255) NOT NULL UNIQUE,   -- login identifier
  password_hash  TEXT NOT NULL
);
