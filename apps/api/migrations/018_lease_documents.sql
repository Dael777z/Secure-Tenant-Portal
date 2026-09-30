-- ---------------------------------------------------------------------------
-- 018  Lease documents and in-portal signatures.
--
-- From the 2026-09-28 meeting: managers upload lease PDFs by hand today, and
-- RentRedi lets residents sign in the app. Here a manager attaches a PDF to a
-- lease and can ask the residents on it to sign; each resident sees it, can
-- download it, and signs by typing their name.
--
-- What a signature records, so it can be checked later: who (their account),
-- what they typed, when, from where (IP address and browser), and the SHA-256
-- of the exact file they were shown. If the file were ever swapped, the hash
-- would no longer match. Signatures are append-only.
--
-- Whether a typed-name signature is enough for a given lease is a legal
-- question for the team's lawyer; see docs/MEETING-2026-09-28.md.
-- ---------------------------------------------------------------------------

CREATE TABLE lease_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  property_id         uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  tenancy_id          uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  file_name           text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  content_type        text NOT NULL CHECK (content_type = 'application/pdf'),
  size_bytes          integer NOT NULL CHECK (size_bytes > 0),
  sha256              text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key          text NOT NULL UNIQUE,
  requires_signature  boolean NOT NULL DEFAULT false,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  -- Withdrawn by the office (uploaded to the wrong lease, replaced by a newer
  -- version). The row and any signatures stay; residents stop seeing it.
  withdrawn_at        timestamptz,
  withdrawn_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX lease_documents_tenancy_idx ON lease_documents (tenancy_id, uploaded_at DESC);

CREATE TABLE lease_document_signatures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES lease_documents(id) ON DELETE RESTRICT,
  tenancy_id    uuid NOT NULL REFERENCES tenancies(id) ON DELETE RESTRICT,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  typed_name    text NOT NULL CHECK (length(trim(typed_name)) BETWEEN 2 AND 120),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  signed_at     timestamptz NOT NULL DEFAULT now(),
  ip_address    inet,
  user_agent    text CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  UNIQUE (document_id, user_id)
);

CREATE TRIGGER lease_document_signatures_append_only
  BEFORE UPDATE OR DELETE ON lease_document_signatures
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- A document takes its place from its lease.
CREATE OR REPLACE FUNCTION app.document_from_tenancy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  SELECT t.organization_id, t.property_id INTO NEW.organization_id, NEW.property_id
  FROM tenancies t WHERE t.id = NEW.tenancy_id;
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'no such lease' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lease_documents_scope
  BEFORE INSERT ON lease_documents
  FOR EACH ROW EXECUTE FUNCTION app.document_from_tenancy();

-- A signature must be the signer's own, on a live document of their own lease,
-- and must carry the hash of the file as it is stored.
CREATE OR REPLACE FUNCTION app.validate_signature() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record;
BEGIN
  SELECT tenancy_id, sha256, withdrawn_at INTO d FROM lease_documents WHERE id = NEW.document_id;
  IF NOT FOUND OR d.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'that document is not available to sign' USING ERRCODE = '23514';
  END IF;
  NEW.tenancy_id := d.tenancy_id;
  IF NOT (NEW.user_id = ANY (app.lease_resident_ids(d.tenancy_id))) THEN
    RAISE EXCEPTION 'only a resident on this lease can sign it' USING ERRCODE = '42501';
  END IF;
  IF NEW.document_sha256 <> d.sha256 THEN
    RAISE EXCEPTION 'the document changed since it was shown; reload and read it again' USING ERRCODE = '23514';
  END IF;
  NEW.signed_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER lease_document_signatures_validate
  BEFORE INSERT ON lease_document_signatures
  FOR EACH ROW EXECUTE FUNCTION app.validate_signature();

ALTER TABLE lease_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE lease_document_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_document_signatures FORCE ROW LEVEL SECURITY;

-- Leases carry rent, so staff read none of this (010). Residents see the live
-- documents of their own lease; managers and owners see everything on theirs.
CREATE POLICY lease_documents_read ON lease_documents
  FOR SELECT USING (
    app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids())
    AND (withdrawn_at IS NULL OR app.current_role_name() <> 'tenant')
  );
CREATE POLICY lease_documents_insert ON lease_documents
  FOR INSERT WITH CHECK (
    app.current_role_name() = 'manager' AND tenancy_id = ANY (app.visible_tenancy_ids())
    AND uploaded_by_user_id = app.current_user_id()
  );
CREATE POLICY lease_documents_withdraw ON lease_documents
  FOR UPDATE
  USING (app.current_role_name() = 'manager' AND tenancy_id = ANY (app.visible_tenancy_ids()))
  WITH CHECK (app.current_role_name() = 'manager' AND tenancy_id = ANY (app.visible_tenancy_ids()));

CREATE POLICY lease_document_signatures_read ON lease_document_signatures
  FOR SELECT USING (app.can_read_money() AND tenancy_id = ANY (app.visible_tenancy_ids()));
CREATE POLICY lease_document_signatures_insert ON lease_document_signatures
  FOR INSERT WITH CHECK (app.current_role_name() = 'tenant' AND user_id = app.current_user_id());

-- Withdrawing is the only change a document ever takes.
REVOKE UPDATE, DELETE ON lease_documents FROM portal_app;
GRANT SELECT, INSERT ON lease_documents TO portal_app;
GRANT UPDATE (withdrawn_at, withdrawn_by_user_id) ON lease_documents TO portal_app;
REVOKE UPDATE, DELETE ON lease_document_signatures FROM portal_app;
GRANT SELECT, INSERT ON lease_document_signatures TO portal_app;
