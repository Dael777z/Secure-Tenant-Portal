-- ---------------------------------------------------------------------------
-- 013  Notification routing that does not depend on who triggered it.
--
-- emit() used to look up the event's organization and its recipients with the
-- caller's own Row-Level Security context. That quietly broke two things:
--
--   * A resident cannot read the staff roster, so every resident-triggered
--     event meant for management (a dispute opened, a request filed) reached
--     nobody on the management side.
--   * On-site staff cannot read tenancy rows (010), so the organization lookup
--     returned NULL and a staff member's visible status change on a work order
--     failed with a 500 — staff could not do their main job.
--
-- The two functions below answer "where does this event belong" and "who
-- should hear about it" with definer rights, but only for a tenancy or
-- property the caller can already see. They return routing data, not records.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.caller_can_route(p_tenancy uuid, p_property uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.is_system_job()
      OR (p_tenancy IS NOT NULL AND p_tenancy = ANY (app.visible_tenancy_ids()))
      OR (p_property IS NOT NULL AND p_property = ANY (app.visible_property_ids()));
$$;

CREATE OR REPLACE FUNCTION app.notification_scope(p_tenancy uuid, p_property uuid)
RETURNS TABLE (organization_id uuid, property_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(t.organization_id, p.organization_id), COALESCE(p_property, t.property_id)
  FROM (SELECT 1) x
  LEFT JOIN tenancies t ON t.id = p_tenancy
  LEFT JOIN properties p ON p.id = p_property
  WHERE app.caller_can_route(p_tenancy, p_property);
$$;

CREATE OR REPLACE FUNCTION app.notification_recipients(p_tenancy uuid, p_property uuid, p_audience text)
RETURNS TABLE (email text, phone text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.email, u.phone, u.display_name
  FROM tenancies t JOIN users u ON u.id = t.resident_user_id
  WHERE p_audience = 'resident' AND t.id = p_tenancy AND u.active
    AND app.caller_can_route(p_tenancy, p_property)
  UNION
  SELECT u.email, u.phone, u.display_name
  FROM staff_assignments sa JOIN users u ON u.id = sa.user_id
  WHERE p_audience IN ('manager','staff')
    AND u.role = p_audience
    AND u.active
    AND sa.revoked_at IS NULL
    AND sa.property_id = COALESCE(p_property, (SELECT t.property_id FROM tenancies t WHERE t.id = p_tenancy))
    AND app.caller_can_route(p_tenancy, p_property);
$$;

REVOKE ALL ON FUNCTION app.caller_can_route(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notification_scope(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notification_recipients(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caller_can_route(uuid, uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION app.notification_scope(uuid, uuid) TO portal_app;
GRANT EXECUTE ON FUNCTION app.notification_recipients(uuid, uuid, text) TO portal_app;

-- Queuing the delivery rows. A resident may cause an email to the manager, but
-- may not read that email's row afterwards (notification_deliveries_read), and
-- PostgreSQL applies the read policy to INSERT … ON CONFLICT. So the insert runs
-- with definer rights, for an event the caller could route in the first place.
CREATE OR REPLACE FUNCTION app.enqueue_delivery(
  p_event uuid, p_audience text, p_channel text, p_recipient text, p_subject text, p_body text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record; n integer;
BEGIN
  SELECT id, organization_id, property_id, tenancy_id INTO e FROM notification_events WHERE id = p_event;
  IF NOT FOUND OR NOT app.caller_can_route(e.tenancy_id, e.property_id) THEN
    RETURN 0;
  END IF;
  INSERT INTO notification_deliveries
    (event_id, organization_id, property_id, tenancy_id, audience, channel, recipient, subject, body)
  VALUES (e.id, e.organization_id, e.property_id, e.tenancy_id, p_audience, p_channel, p_recipient, p_subject, p_body)
  ON CONFLICT (event_id, channel, recipient) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION app.enqueue_delivery(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enqueue_delivery(uuid, text, text, text, text, text) TO portal_app;
