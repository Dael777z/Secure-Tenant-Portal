-- ---------------------------------------------------------------------------
-- 009  Aggregate views for the rent roll and the exception queue.
--
-- These exist because a manager opening a 300-unit rent roll should not cause
-- 300 round trips, and because the balance a resident sees and the balance a
-- manager sees must be computed by the same expression rather than by two
-- pieces of code that agree today.
--
-- Every view is a plain view, not materialized: a rent roll that is thirty
-- seconds stale is a rent roll that shows a payment as missing after it landed,
-- and that is precisely the disagreement this system exists to prevent. The
-- indexes in 003 are what make the live computation cheap enough to mean it.
--
-- Views inherit the RLS of their underlying tables when they are owned by a
-- role that does not bypass RLS, so a resident selecting from tenancy_balances
-- sees exactly one row: their own.
-- ---------------------------------------------------------------------------

CREATE VIEW tenancy_balances
WITH (security_invoker = true) AS
SELECT
  t.id                       AS tenancy_id,
  t.property_id,
  t.organization_id,
  t.unit_id,
  u.label                    AS unit_label,
  p.name                     AS property_name,
  usr.display_name           AS resident_name,
  usr.email                  AS resident_email,
  t.status,
  t.monthly_rent_cents,
  t.rent_due_day,
  t.late_fee_hold_until,
  t.late_fee_hold_reason,
  COALESCE(l.balance_cents, 0)        AS balance_cents,
  COALESCE(l.charged_cents, 0)        AS lifetime_charged_cents,
  COALESCE(l.credited_cents, 0)       AS lifetime_credited_cents,
  l.last_entry_at,
  l.first_entry_at
FROM tenancies t
JOIN units u        ON u.id = t.unit_id
JOIN properties p   ON p.id = t.property_id
JOIN users usr      ON usr.id = t.resident_user_id
LEFT JOIN LATERAL (
  SELECT
    sum(e.amount_cents)                                          AS balance_cents,
    sum(e.amount_cents) FILTER (WHERE e.amount_cents > 0)        AS charged_cents,
    sum(e.amount_cents) FILTER (WHERE e.amount_cents < 0)        AS credited_cents,
    max(e.posted_at)                                             AS last_entry_at,
    min(e.posted_at)                                             AS first_entry_at
  FROM ledger_entries e
  WHERE e.tenancy_id = t.id
) l ON true;

COMMENT ON VIEW tenancy_balances IS
  'The balance is the sum of the ledger. security_invoker means this view is subject to the caller''s RLS policies rather than its owner''s, so a resident selecting from it sees only their own row.';

-- One period, one tenancy: what was charged, what was collected against it, and
-- what remains. This is the row a rent roll is built from.
CREATE VIEW tenancy_period_activity
WITH (security_invoker = true) AS
SELECT
  t.id                  AS tenancy_id,
  t.property_id,
  t.organization_id,
  e.period,
  sum(e.amount_cents) FILTER (WHERE e.amount_cents > 0)               AS charged_cents,
  -sum(e.amount_cents) FILTER (WHERE e.amount_cents < 0)              AS credited_cents,
  sum(e.amount_cents)                                                  AS net_cents,
  sum(e.amount_cents) FILTER (WHERE e.category = 'late_fee')           AS late_fee_cents,
  count(*) FILTER (WHERE e.entry_type = 'reversal')                    AS reversal_count,
  min(e.effective_date) FILTER (WHERE e.entry_type = 'charge')         AS first_charge_date,
  max(e.posted_at)                                                     AS last_activity_at
FROM tenancies t
JOIN ledger_entries e ON e.tenancy_id = t.id
GROUP BY t.id, t.property_id, t.organization_id, e.period;

-- The most recent payment attempt per tenancy, which is what the rent roll's
-- "what happened last" column and half the exception queue are asking for.
CREATE VIEW tenancy_last_payment
WITH (security_invoker = true) AS
SELECT DISTINCT ON (pm.tenancy_id)
  pm.tenancy_id,
  pm.id            AS payment_id,
  pm.amount_cents,
  pm.status,
  pm.method,
  pm.failure_code,
  pm.failure_message,
  pm.submitted_at,
  pm.settled_at,
  pm.resolved_at
FROM payments pm
ORDER BY pm.tenancy_id, pm.submitted_at DESC;

-- Open obligations that a person needs to look at. The severity ordering is in
-- the shared package so client and server rank identically; this view supplies
-- the facts it ranks.
CREATE VIEW open_exceptions
WITH (security_invoker = true) AS
SELECT
  'payment_failed'::text AS kind,
  p.tenancy_id, p.property_id, p.id AS payment_id,
  NULL::uuid AS dispute_id, NULL::uuid AS ledger_entry_id,
  p.amount_cents, p.updated_at AS occurred_at,
  COALESCE(p.failure_message, 'Payment failed.') AS detail
FROM payments p WHERE p.status = 'failed'
UNION ALL
SELECT
  'payment_returned', p.tenancy_id, p.property_id, p.id,
  NULL::uuid, NULL::uuid,
  p.amount_cents, p.updated_at,
  COALESCE(p.failure_message, 'Payment returned by the bank after settling.')
FROM payments p WHERE p.status = 'returned'
UNION ALL
SELECT
  'dispute_open', d.tenancy_id, d.property_id, NULL::uuid,
  d.id, d.ledger_entry_id,
  abs(e.amount_cents), d.opened_at,
  d.reason
FROM charge_disputes d
JOIN ledger_entries e ON e.id = d.ledger_entry_id
WHERE d.status IN ('open','responded')
UNION ALL
SELECT
  'plan_missed', i.tenancy_id, i.property_id, NULL::uuid,
  NULL::uuid, NULL::uuid,
  i.amount_cents - i.paid_cents, (i.due_date + 1)::timestamptz,
  'Payment plan installment due ' || i.due_date::text || ' was not met in full.'
FROM payment_plan_installments i
JOIN payment_plans pl ON pl.id = i.payment_plan_id
WHERE pl.status = 'active'
  AND i.status IN ('scheduled','partial')
  AND i.due_date < current_date;

CREATE INDEX IF NOT EXISTS ledger_period_amount_idx
  ON ledger_entries (property_id, period, amount_cents);

GRANT SELECT ON tenancy_balances, tenancy_period_activity, tenancy_last_payment, open_exceptions
  TO portal_app;
