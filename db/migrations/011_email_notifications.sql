/* 011  Email notifications, sent through Resend. Additive, like 002-010.
   Needs 006 (the tenant's email choices), 008 (the office's notification settings)
   and 009 (Notifications_Sent).

   Until now the portal kept everyone's email choices and recorded each notice a
   resident got (009, channel 'in_app'), but sent no email. With RESEND_API_KEY and
   EMAIL_FROM set, the app sends:

     to residents (each can turn a kind off in Settings, 006)            choice
       rent reminders     the 'rent_upcoming' / 'rent_due' / 'rent_overdue' notices
                          from the office's reminder rules (008)           rent_due
       payment receipts   the 'payment_received' notices (009)             payment_receipts
       office notices     a notice the office sends with "email" ticked    messages
       office messages    a message from the office, once per unread burst messages
       repair updates     a maintenance request moves to a new stage       maintenance

     to the office (Office_Settings, 008: notify_email, or every property
     manager's own sign-in email when that is empty)                       setting
       a tenant's message, once per unread burst                           notify_tenant_message
       a new maintenance request                                           notify_new_maintenance
       a Cash App / Zelle payment reported to confirm                      notify_reported_payment
       rent gone late: one summary a day                                   notify_late_rent
       a lease ending within 90 days                                       (always)

   A notice's email is a Notifications_Sent row of its own: channel 'email', the
   same template, subject, body, author and time as the in-app notice, and email_of
   pointing at it. It is 'queued' until the app sends it, then 'sent' or 'failed'
   (error says why), or 'skipped' when the resident turned that kind off. The other
   emails (messages, maintenance, the office's) leave no row; the daily and lease
   ones are recorded in Scheduled_Emails_Sent so each goes out once.

   The app sends as 'system', which RLS shows almost nothing. So recipients and the
   queue go through the SECURITY DEFINER functions below, and each does nothing
   unless the caller is 'system'. Message bodies are never emailed. */

/* ---- A notice's email ------------------------------------------------------- */
ALTER TABLE Notifications_Sent
    ADD COLUMN email_of      INT UNIQUE REFERENCES Notifications_Sent(notID) ON DELETE RESTRICT,
    ADD COLUMN attempted_at  TIMESTAMPTZ,      -- when the app last picked it up to send
    ADD CONSTRAINT notification_email_of_email CHECK (email_of IS NULL OR channel = 'email');
CREATE INDEX idx_notifications_email_queue ON Notifications_Sent (notID) WHERE channel = 'email' AND status IN ('queued', 'sending');

/* ---- Scheduled office emails already sent, so each goes out once -------------
   key names the email and what it is about: 'late_rent:2026-11-06',
   'lease_ending:<LeaseID>:<end_date>'. */
CREATE TABLE Scheduled_Emails_Sent (
    key      VARCHAR(200) PRIMARY KEY,
    sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE Scheduled_Emails_Sent ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON Scheduled_Emails_Sent TO summit_app;      -- append-only
CREATE POLICY system_all ON Scheduled_Emails_Sent FOR ALL TO summit_app
    USING ((SELECT app_user_type()) = 'system') WITH CHECK ((SELECT app_user_type()) = 'system');

/* ---- Who wants what ----------------------------------------------------------- */

-- Whether a tenant wants this kind of email (006; no row yet means everything on).
-- p_choice: 'rent_due', 'payment_receipts', 'maintenance', 'messages'. Null for anyone but 'system'.
CREATE FUNCTION tenant_wants_email(p_tid INT, p_choice TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT CASE WHEN COALESCE(app_user_type() = 'system', false) THEN
        COALESCE((SELECT CASE p_choice
                             WHEN 'rent_due' THEN np.rent_due
                             WHEN 'payment_receipts' THEN np.payment_receipts
                             WHEN 'maintenance' THEN np.maintenance
                             WHEN 'messages' THEN np.messages
                         END
                    FROM Tenant_Notification_Prefs np WHERE np.tID = p_tid), true)
    END
$$;

-- An active tenant's name and address, when they want this kind of email (p_choice null: any).
CREATE FUNCTION notify_tenant(p_tid INT, p_choice TEXT)
RETURNS TABLE (name TEXT, email TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.Name::TEXT, t.Email::TEXT FROM Tenants t
     WHERE t.tID = p_tid AND t.deactivated_at IS NULL
       AND (p_choice IS NULL OR tenant_wants_email(p_tid, p_choice))
       AND COALESCE(app_user_type() = 'system', false)
$$;

-- Where the office hears about p_topic ('message', 'maintenance', 'reported_payment', 'late_rent',
-- 'lease_ending'): the office's notify_email, or else every active property manager who has
-- signed up. Nothing when the office turned that topic off (008).
CREATE FUNCTION notify_office(p_topic TEXT)
RETURNS TABLE (name TEXT, email TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH s AS (
        SELECT os.notify_email,
               CASE p_topic
                   WHEN 'message' THEN os.notify_tenant_message
                   WHEN 'maintenance' THEN os.notify_new_maintenance
                   WHEN 'reported_payment' THEN os.notify_reported_payment
                   WHEN 'late_rent' THEN os.notify_late_rent
                   ELSE true
               END AS wanted
          FROM Office_Settings os
         WHERE COALESCE(app_user_type() = 'system', false)
    )
    SELECT 'Property office'::TEXT, s.notify_email::TEXT FROM s WHERE s.wanted AND s.notify_email IS NOT NULL
    UNION ALL
    SELECT a.name::TEXT, a.email::TEXT FROM Admin a, s
     WHERE s.wanted AND s.notify_email IS NULL
       AND a.role = 'admin' AND a.deactivated_at IS NULL AND a.signup_completed
$$;

-- Unopened messages one side has written in a conversation. 1 means the one just sent,
-- so a burst of messages makes one email, not one each.
CREATE FUNCTION notify_unread_from(p_tid INT, p_from_office BOOLEAN) RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT count(*)::INT FROM Messages m
     WHERE m.tID = p_tid AND m.read_at IS NULL AND (m.sender_admin_id IS NOT NULL) = p_from_office
       AND COALESCE(app_user_type() = 'system', false)
$$;

/* A lease in effect on p_today whose oldest unpaid charge was due before p_today
   (the office's daily late-rent summary). Payments pay the oldest charges first (by
   due date), the way the ledger reads, so "oldest unpaid" is the first charge the
   payments so far do not cover. */
CREATE FUNCTION notify_past_due(p_today DATE)
RETURNS TABLE (lease_id INT, unit_label TEXT, tenant_names TEXT, due_date DATE, balance NUMERIC)
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
        SELECT DISTINCT ON (r.LeaseID) r.LeaseID, r.due_date, r.charged - pd.net AS balance
          FROM running r JOIN paid pd ON pd.LeaseID = r.LeaseID
         WHERE r.through > pd.net
         ORDER BY r.LeaseID, r.due_date, r.chargeID
    )
    SELECT o.LeaseID, 'Unit ' || u.UnitNum || ' - ' || p.Name,
           COALESCE((SELECT string_agg(t.Name, ', ' ORDER BY t.Name) FROM Lease_Tenants lt JOIN Tenants t ON t.tID = lt.tID
                      WHERE lt.LeaseID = o.LeaseID), ''),
           o.due_date, o.balance
      FROM oldest o
      JOIN current_leases cl ON cl.LeaseID = o.LeaseID
      JOIN Units u ON u.uID = cl.uID
      JOIN Property p ON p.pID = u.pID
     WHERE o.due_date < p_today AND o.balance > 0
       AND COALESCE(app_user_type() = 'system', false)
     ORDER BY o.due_date, p.Name, u.UnitNum
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

/* ---- The queue of notice emails --------------------------------------------- */

-- The email choice a notice falls under.
CREATE FUNCTION notice_email_choice(p_template TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_template IN ('rent_upcoming', 'rent_due', 'rent_overdue') THEN 'rent_due'
        WHEN p_template = 'payment_received' THEN 'payment_receipts'
        WHEN p_template = 'maintenance_update' THEN 'maintenance'
        ELSE 'messages'
    END
$$;

/* Give each in-app notice (of these templates, written since p_since) its email:
   'queued', or 'skipped' when the resident turned that kind of email off or their
   account is closed. Returns how many it added; a notice never gets two. */
CREATE FUNCTION queue_notice_emails(p_since TIMESTAMPTZ, p_templates TEXT[]) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_added INT;
BEGIN
    IF NOT COALESCE(app_user_type() = 'system', false) THEN RETURN 0; END IF;
    INSERT INTO Notifications_Sent (tID, LeaseID, channel, template, subject, body, status, error,
                                    created_at, created_by, source_payment, source_reminder, email_of)
    SELECT n.tID, n.LeaseID, 'email', n.template, n.subject, n.body,
           CASE WHEN w.wanted THEN 'queued' ELSE 'skipped' END,
           CASE WHEN w.wanted THEN NULL
                WHEN t.deactivated_at IS NOT NULL THEN 'The resident''s account is closed.'
                ELSE 'The resident turned these emails off in Settings.' END,
           n.created_at, n.created_by, n.source_payment, n.source_reminder, n.notID
      FROM Notifications_Sent n
      JOIN Tenants t ON t.tID = n.tID
      CROSS JOIN LATERAL (SELECT t.deactivated_at IS NULL AND tenant_wants_email(n.tID, notice_email_choice(n.template)) AS wanted) w
     WHERE n.channel = 'in_app' AND n.template = ANY (p_templates) AND n.created_at >= p_since
       AND NOT EXISTS (SELECT 1 FROM Notifications_Sent e WHERE e.email_of = n.notID)
    ON CONFLICT (email_of) DO NOTHING;
    GET DIAGNOSTICS v_added = ROW_COUNT;
    RETURN v_added;
END $$;

/* Take up to p_limit queued emails to send: they become 'sending', and come back with
   the resident's address. First, a send that never finished (the app stopped part-way)
   is queued again (Resend drops a repeat with the same idempotency key), and emails
   queued before p_oldest are skipped rather than sent late. */
CREATE FUNCTION claim_notice_emails(p_limit INT, p_oldest TIMESTAMPTZ)
RETURNS TABLE (id INT, tid INT, name TEXT, email TEXT, template TEXT, subject TEXT, body TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NOT COALESCE(app_user_type() = 'system', false) THEN RETURN; END IF;
    UPDATE Notifications_Sent SET status = 'queued'
     WHERE channel = 'email' AND status = 'sending' AND attempted_at < now() - interval '15 minutes';
    UPDATE Notifications_Sent SET status = 'skipped', error = 'Not sent: it was too old by the time email could go out.'
     WHERE channel = 'email' AND status = 'queued' AND created_at < p_oldest;
    UPDATE Notifications_Sent n SET status = 'skipped', error = 'The resident''s account is closed.'
      FROM Tenants t
     WHERE n.channel = 'email' AND n.status = 'queued' AND t.tID = n.tID AND t.deactivated_at IS NOT NULL;
    RETURN QUERY
    WITH picked AS (
        SELECT e.notID FROM Notifications_Sent e
         WHERE e.channel = 'email' AND e.status = 'queued'
         ORDER BY e.notID LIMIT p_limit
           FOR UPDATE SKIP LOCKED
    ), claimed AS (
        UPDATE Notifications_Sent e SET status = 'sending', attempted_at = now()
          FROM picked WHERE e.notID = picked.notID
        RETURNING e.notID, e.tID, e.template, e.subject, e.body
    )
    SELECT c.notID, c.tID, t.Name::TEXT, t.Email::TEXT, c.template::TEXT, c.subject::TEXT, c.body::TEXT
      FROM claimed c JOIN Tenants t ON t.tID = c.tID
     ORDER BY c.notID;
END $$;

-- How a send went: 'sent', or 'failed' with why.
CREATE FUNCTION finish_notice_email(p_id INT, p_sent BOOLEAN, p_error TEXT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE Notifications_Sent
       SET status = CASE WHEN p_sent THEN 'sent' ELSE 'failed' END,
           sent_at = CASE WHEN p_sent THEN now() END,
           error = CASE WHEN p_sent THEN NULL ELSE left(COALESCE(p_error, 'Not delivered.'), 500) END
     WHERE notID = p_id AND channel = 'email' AND status = 'sending'
       AND COALESCE(app_user_type() = 'system', false)
$$;

REVOKE ALL ON FUNCTION tenant_wants_email(INT, TEXT), notify_tenant(INT, TEXT), notify_office(TEXT), notify_unread_from(INT, BOOLEAN),
    notify_past_due(DATE), notify_leases_ending(DATE, INT), queue_notice_emails(TIMESTAMPTZ, TEXT[]),
    claim_notice_emails(INT, TIMESTAMPTZ), finish_notice_email(INT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_wants_email(INT, TEXT), notify_tenant(INT, TEXT), notify_office(TEXT), notify_unread_from(INT, BOOLEAN),
    notify_past_due(DATE), notify_leases_ending(DATE, INT), queue_notice_emails(TIMESTAMPTZ, TEXT[]),
    claim_notice_emails(INT, TIMESTAMPTZ), finish_notice_email(INT, BOOLEAN, TEXT) TO summit_app;
