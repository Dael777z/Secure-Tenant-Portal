-- ---------------------------------------------------------------------------
-- 004  Receipts for payments the office records (a photo of a check, a money
--      order stub, a cash receipt), stored in the database with the payment.
--
-- Additions only. One receipt per payment; deleting the payment (undoing an
-- office entry) deletes its receipt. Only image and PDF types, at most 4 MB,
-- so a hosted demo (Netlify functions take 6 MB requests) can carry one.
-- ---------------------------------------------------------------------------

CREATE TABLE Payment_Receipts (
  payID         INT PRIMARY KEY REFERENCES Payment(payID) ON DELETE CASCADE,
  filename      VARCHAR(200) NOT NULL,
  content_type  VARCHAR(40) NOT NULL
                CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes    INT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 4194304),
  data          BYTEA NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
