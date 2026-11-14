/* 003  Maintenance staff: the third role in the proposal (tenant, property
   manager, staff member). Additive, like 002: no 001 or 002 policy is edited.

   A maintenance staff member is an Admin row with role 'maintenance_staff'.
   Angel's admin policies check app.user_role = 'admin', so these accounts get
   none of them. The policies below give them the maintenance queue and what it
   shows (the unit, the property, who reported it) and their own Admin row.
   They see no leases, charges, payments, receipts or bank accounts. */

-- Angel's comment on Admin.role: "widen this when we add roles".
ALTER TABLE Admin DROP CONSTRAINT admin_role_check;
ALTER TABLE Admin ADD CONSTRAINT admin_role_check CHECK (role IN ('admin', 'maintenance_staff'));

CREATE FUNCTION app_is_maintenance() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        NULLIF(current_setting('app.user_type', true), '') = 'admin'
        AND current_setting('app.user_role', true) = 'maintenance_staff',
        false)
$$;

-- The signed-in staff member's admin_id, or null.
CREATE FUNCTION app_admin_id() RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN NULLIF(current_setting('app.user_type', true), '') = 'admin'
                THEN NULLIF(current_setting('app.user_id', true), '')::INT
           END
$$;

-- Any staff member reads their own account row (the name in the sidebar).
CREATE POLICY staff_self ON Admin FOR SELECT TO summit_app
    USING (admin_id = (SELECT app_admin_id()));

-- The queue: read, file (as the office, so no tenant), and move through statuses.
CREATE POLICY maint_read_tickets ON Maintenance_T FOR SELECT TO summit_app
    USING ((SELECT app_is_maintenance()));
CREATE POLICY maint_file_ticket ON Maintenance_T FOR INSERT TO summit_app
    WITH CHECK ((SELECT app_is_maintenance()) AND tID IS NULL AND status = 'submitted');
CREATE POLICY maint_update_tickets ON Maintenance_T FOR UPDATE TO summit_app
    USING ((SELECT app_is_maintenance())) WITH CHECK ((SELECT app_is_maintenance()));
CREATE POLICY maint_read_history ON Maintenance_Status_History FOR SELECT TO summit_app
    USING ((SELECT app_is_maintenance()));

-- What a ticket shows: where it is, and who reported it (to arrange access).
CREATE POLICY maint_read_units ON Units FOR SELECT TO summit_app
    USING ((SELECT app_is_maintenance()));
CREATE POLICY maint_read_property ON Property FOR SELECT TO summit_app
    USING ((SELECT app_is_maintenance()));
CREATE POLICY maint_read_tenants ON Tenants FOR SELECT TO summit_app
    USING ((SELECT app_is_maintenance()));
