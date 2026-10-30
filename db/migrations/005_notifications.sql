/* 005  Email notifications (sent through Resend). Additive, like 002-004.

   Tenants hear about: rent on the 1st, a bill gone past due, a message from the office.
   Property managers ('admin') hear about: a tenant's message, a lease ending within
   90 days, and (each manager can switch this off) a tenant's maintenance request.

   The emails are sent as 'system', which RLS shows almost nothing. So the
   recipients come from the SECURITY DEFINER functions below, and each returns
   nothing unless the caller is 'system'. Message bodies are never emailed. */

-- A manager's own switch for "a tenant filed a maintenance request" emails.
ALTER TABLE Admin ADD COLUMN notify_maintenance BOOLEAN NOT NULL DEFAULT true;

/* ---- What was already sent, so the scheduled emails go out once ------------
   key names the email and what it is about: 'rent_due:<tID>:2026-11',
   'past_due:<tID>:<chargeID>', 'lease_ending:<LeaseID>:<end_date>'. */
CREATE TABLE Notifications_Sent (
    key      VARCHAR(200) PRIMARY KEY,
    sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE Notifications_Sent ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON Notifications_Sent TO summit_app;      -- append-only
CREATE POLICY system_all ON Notifications_Sent FOR ALL TO summit_app
    USING ((SELECT app_user_type()) = 'system') WITH CHECK ((SELECT app_user_type()) = 'system');

/* ---- Who to email ------------------------------------------------------------ */

-- An active tenant's name and address.
CREATE FUNCTION notify_tenant(p_tid INT)
RETURNS TABLE (name TEXT, email TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.Name::TEXT, t.Email::TEXT FROM Tenants t
     WHERE t.tID = p_tid AND t.deactivated_at IS NULL AND COALESCE(app_user_type() = 'system', false)
$$;

-- Active property managers; for a maintenance email, only those who left it on.
CREATE FUNCTION notify_staff(p_maintenance BOOLEAN)
RETURNS TABLE (name TEXT, email TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.name::TEXT, a.email::TEXT FROM Admin a
     WHERE a.role = 'admin' AND a.deactivated_at IS NULL AND (NOT p_maintenance OR a.notify_maintenance)
       AND COALESCE(app_user_type() = 'system', false)
     ORDER BY a.admin_id
$$;

-- Unopened messages one side has written in a conversation. 1 means the one just sent,
-- so a burst of messages makes one email, not one each.
CREATE FUNCTION notify_unread_from(p_tid INT, p_from_office BOOLEAN) RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT count(*)::INT FROM Messages m
     WHERE m.tID = p_tid AND m.read_at IS NULL AND (m.sender_admin_id IS NOT NULL) = p_from_office
       AND COALESCE(app_user_type() = 'system', false)
$$;

-- Every tenant on a lease in effect on p_today, with the rent and what is owed.
CREATE FUNCTION notify_rent_due(p_today DATE)
RETURNS TABLE (tid INT, name TEXT, email TEXT, lease_id INT, unit_label TEXT, monthly_rent NUMERIC, balance NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.tID, t.Name::TEXT, t.Email::TEXT, l.LeaseID, 'Unit ' || u.UnitNum || ' - ' || p.Name, l.monthly_rent, b.balance
      FROM Lease l
      JOIN Lease_Tenants lt ON lt.LeaseID = l.LeaseID
      JOIN Tenants t ON t.tID = lt.tID AND t.deactivated_at IS NULL
      JOIN Units u ON u.uID = l.uID
      JOIN Property p ON p.pID = u.pID
      JOIN lease_balance b ON b.LeaseID = l.LeaseID
     WHERE l.start_date <= p_today AND (l.end_date IS NULL OR l.end_date >= p_today)
       AND COALESCE(app_user_type() = 'system', false)
$$;

/* A lease in effect on p_today whose oldest unpaid charge was due before p_today.
   Payments pay the oldest charges first (by due date), the way the ledger reads,
   so "oldest unpaid" is the first charge the payments so far do not cover. */
CREATE FUNCTION notify_past_due(p_today DATE)
RETURNS TABLE (tid INT, name TEXT, email TEXT, lease_id INT, unit_label TEXT, charge_id INT, due_date DATE, balance NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH current_leases AS (
        SELECT l.LeaseID, l.uID FROM Lease l
         WHERE l.start_date <= p_today AND (l.end_date IS NULL OR l.end_date >= p_today)
    ),
    paid AS (
        SELECT cl.LeaseID,
               COALESCE(SUM(CASE WHEN p.direction = 'charge' THEN p.amount ELSE -p.amount END), 0) AS net
          FROM current_leases cl
          LEFT JOIN Payment p ON p.LeaseID = cl.LeaseID AND p.status = 'completed'
         GROUP BY cl.LeaseID
    ),
    running AS (
        SELECT c.LeaseID, c.chargeID, c.due_date,
               SUM(c.amount) OVER (PARTITION BY c.LeaseID ORDER BY c.due_date, c.chargeID) AS through,
               SUM(c.amount) OVER (PARTITION BY c.LeaseID) AS charged
          FROM Charge c JOIN current_leases cl ON cl.LeaseID = c.LeaseID
    ),
    oldest AS (
        SELECT DISTINCT ON (r.LeaseID) r.LeaseID, r.chargeID, r.due_date, r.charged - pd.net AS balance
          FROM running r JOIN paid pd ON pd.LeaseID = r.LeaseID
         WHERE r.through > pd.net
         ORDER BY r.LeaseID, r.due_date, r.chargeID
    )
    SELECT t.tID, t.Name::TEXT, t.Email::TEXT, o.LeaseID, 'Unit ' || u.UnitNum || ' - ' || p.Name, o.chargeID, o.due_date, o.balance
      FROM oldest o
      JOIN current_leases cl ON cl.LeaseID = o.LeaseID
      JOIN Lease_Tenants lt ON lt.LeaseID = o.LeaseID
      JOIN Tenants t ON t.tID = lt.tID AND t.deactivated_at IS NULL
      JOIN Units u ON u.uID = cl.uID
      JOIN Property p ON p.pID = u.pID
     WHERE o.due_date < p_today AND o.balance > 0
       AND COALESCE(app_user_type() = 'system', false)
$$;

-- Leases whose last day is between p_today and p_days from now, with who is on them.
-- Skipped when the unit already has its next lease (a renewal or a new tenant).
CREATE FUNCTION notify_leases_ending(p_today DATE, p_days INT)
RETURNS TABLE (lease_id INT, end_date DATE, unit_label TEXT, tenant_names TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT l.LeaseID, l.end_date, 'Unit ' || u.UnitNum || ' - ' || p.Name,
           COALESCE((SELECT string_agg(t.Name, ', ' ORDER BY t.Name) FROM Lease_Tenants lt JOIN Tenants t ON t.tID = lt.tID
                      WHERE lt.LeaseID = l.LeaseID), '')
      FROM Lease l
      JOIN Units u ON u.uID = l.uID
      JOIN Property p ON p.pID = u.pID
     WHERE l.end_date BETWEEN p_today AND p_today + p_days
       AND NOT EXISTS (SELECT 1 FROM Lease nxt WHERE nxt.uID = l.uID AND nxt.start_date > l.end_date)
       AND COALESCE(app_user_type() = 'system', false)
     ORDER BY l.end_date, l.LeaseID
$$;

REVOKE ALL ON FUNCTION notify_tenant(INT), notify_staff(BOOLEAN), notify_unread_from(INT, BOOLEAN),
    notify_rent_due(DATE), notify_past_due(DATE), notify_leases_ending(DATE, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notify_tenant(INT), notify_staff(BOOLEAN), notify_unread_from(INT, BOOLEAN),
    notify_rent_due(DATE), notify_past_due(DATE), notify_leases_ending(DATE, INT) TO summit_app;
