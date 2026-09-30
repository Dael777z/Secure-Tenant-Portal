-- ---------------------------------------------------------------------------
-- 019  Photos of properties and units.
--
-- A manager adds pictures of a building (its front, the grounds) and of each
-- unit (for listing it, or as a move-in record). One photo of each property,
-- and one of each unit, can be the cover shown in lists.
--
-- Who sees them:
--   * managers: every photo in the organization (014);
--   * owners and on-site staff: photos of the properties they are assigned to;
--   * residents: the photos of their own building and their own unit only,
--     never the inside of a neighbour's home.
-- A removed photo is hidden, not deleted, so "who removed what" stays answerable.
-- ---------------------------------------------------------------------------

CREATE TABLE property_photos (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  -- NULL for a photo of the property as a whole.
  unit_id             uuid REFERENCES units(id) ON DELETE RESTRICT,
  object_key          text NOT NULL UNIQUE,
  content_type        text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes          integer NOT NULL CHECK (size_bytes > 0),
  caption             text CHECK (caption IS NULL OR length(caption) <= 140),
  is_cover            boolean NOT NULL DEFAULT false,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  removed_at          timestamptz,
  removed_by_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX property_photos_property_idx ON property_photos (property_id, uploaded_at DESC) WHERE removed_at IS NULL;

-- At most one live cover per property and one per unit.
CREATE UNIQUE INDEX property_photos_one_property_cover
  ON property_photos (property_id) WHERE is_cover AND unit_id IS NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX property_photos_one_unit_cover
  ON property_photos (unit_id) WHERE is_cover AND unit_id IS NOT NULL AND removed_at IS NULL;

-- Organization comes from the property; a unit must belong to that property.
CREATE OR REPLACE FUNCTION app.photo_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  SELECT p.organization_id INTO NEW.organization_id FROM properties p WHERE p.id = NEW.property_id;
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'no such property' USING ERRCODE = '23503';
  END IF;
  IF NEW.unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM units u WHERE u.id = NEW.unit_id AND u.property_id = NEW.property_id
  ) THEN
    RAISE EXCEPTION 'that unit is not at this property' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER property_photos_scope
  BEFORE INSERT ON property_photos
  FOR EACH ROW EXECUTE FUNCTION app.photo_scope();

ALTER TABLE property_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_photos FORCE ROW LEVEL SECURITY;

-- The units a resident lives in (their current and past leases).
CREATE OR REPLACE FUNCTION app.my_unit_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT t.unit_id), '{}') FROM tenancies t
  WHERE t.id = ANY (app.my_tenancy_ids());
$$;
REVOKE ALL ON FUNCTION app.my_unit_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_unit_ids() TO portal_app;

CREATE POLICY property_photos_read ON property_photos
  FOR SELECT USING (
    property_id = ANY ((SELECT app.visible_property_ids())::uuid[])
    AND (
      (SELECT app.current_role_name()) <> 'tenant'
      OR (removed_at IS NULL AND (unit_id IS NULL OR unit_id = ANY ((SELECT app.my_unit_ids())::uuid[])))
    )
  );

CREATE POLICY property_photos_insert ON property_photos
  FOR INSERT WITH CHECK (
    app.current_role_name() = 'manager'
    AND property_id = ANY (app.visible_property_ids())
    AND uploaded_by_user_id = app.current_user_id()
  );

CREATE POLICY property_photos_update ON property_photos
  FOR UPDATE
  USING (app.current_role_name() = 'manager' AND property_id = ANY (app.visible_property_ids()))
  WITH CHECK (app.current_role_name() = 'manager' AND property_id = ANY (app.visible_property_ids()));

-- Caption, cover and removal are the only changes a photo takes.
REVOKE UPDATE, DELETE ON property_photos FROM portal_app;
GRANT SELECT, INSERT ON property_photos TO portal_app;
GRANT UPDATE (caption, is_cover, removed_at, removed_by_user_id) ON property_photos TO portal_app;
