// Documents (009): everything on file in one list — uploaded documents, signed
// leases and payment receipts — with a switch to share an upload with the
// resident. The same list sits on the unit and tenant pages, filtered to them.
import { useEffect, useMemo, useState } from "react";
import { managerApi } from "./api";
import {
  DOC_CATEGORIES, DOC_CATEGORY_TEXT, DOC_KIND_TEXT, DOC_SCOPES, DOCUMENT_ACCEPT, DOCUMENT_MAX_BYTES, docsApi, fileSize, readFile,
  type DocCategory, type DocScope, type HubDocument,
} from "./additions-api";
import { Empty, Field, Loading, LocalError, Modal, PageHeader, ViewCard, timeAgo, useLoad, useManager, useSubmit } from "./ui";

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="mgr-alert mgr-alert--error" role="alert">{error}</p> : null;
}

/** "Aisha Okafor · Unit 103 - Woodcrest Apartments", "Lease · Unit 101 - ...". */
function belongsTo(d: HubDocument): string {
  const place = [d.unitNum ? `Unit ${d.unitNum}` : null, d.propertyName].filter(Boolean).join(" - ");
  if (d.scope === "tenant") return d.tenantName ? `${d.tenantName}${place ? ` · ${place}` : ""}` : place;
  if (d.scope === "lease") return `Lease${place ? ` · ${place}` : ""}`;
  return place || "—";
}

/** The list of documents. With `scope`, only those on that unit or tenant (inside its page). */
export function DocumentsHub({ scope, scopeId, label }: { scope?: DocScope; scopeId?: number; label?: string }) {
  const { can, open, changed } = useManager();
  const embedded = scope !== undefined;
  const [category, setCategory] = useState<DocCategory | "">("");
  const [where, setWhere] = useState<DocScope | "">("");
  const [search, setSearch] = useState("");
  const [sharedOnly, setSharedOnly] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<HubDocument | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The switch flips at once; this holds the new value until the reload shows it.
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const { data, error } = useLoad(() => docsApi.hub(embedded ? { scope, id: scopeId } : {}), [scope, scopeId]);

  useEffect(
    () =>
      setPending((was) => {
        const still = Object.fromEntries(Object.entries(was).filter(([id, v]) => data?.find((d) => d.kind === "document" && d.id === Number(id))?.sharedWithTenant !== v));
        return Object.keys(still).length === Object.keys(was).length ? was : still;
      }),
    [data],
  );

  const q = search.trim().toLowerCase();
  const all = data ?? [];
  const rows = all.filter(
    (d) =>
      (!category || d.category === category) &&
      (!where || d.scope === where) &&
      (!sharedOnly || d.sharedWithTenant) &&
      (!q || `${d.title} ${d.filename} ${belongsTo(d)} ${d.tenantName ?? ""}`.toLowerCase().includes(q)),
  );
  const canEdit = can("users:provision");

  async function save(d: HubDocument, work: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusyId(d.id);
    setFailed(null);
    try {
      await work();
      changed(done);
      return true;
    } catch {
      setFailed("That change did not save. Refresh and try again.");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  const uploadButton = canEdit && (
    <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => setUploading(true)}>
      Upload document
    </button>
  );

  return (
    <>
      {embedded ? (
        <div className="mgr-card__head mgr-hub__head">
          <h2 className="mgr-h2">Documents</h2>
          {uploadButton}
        </div>
      ) : (
        <PageHeader
          title="Documents"
          subtitle="Everything on file: uploaded documents, signed leases and payment receipts. Files open only for signed-in staff; residents see only what you share with them."
          actions={uploadButton}
        />
      )}
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          {!embedded && (
            <div className="mgr-viewcards">
              <ViewCard label="All documents" value={String(all.length)} note="View all" active={!category && !sharedOnly} onClick={() => { setCategory(""); setSharedOnly(false); }} />
              <ViewCard label="Leases" value={String(all.filter((d) => d.category === "lease").length)} note="View leases" active={category === "lease"} onClick={() => setCategory(category === "lease" ? "" : "lease")} />
              <ViewCard label="Receipts" value={String(all.filter((d) => d.category === "receipt").length)} note="View receipts" active={category === "receipt"} onClick={() => setCategory(category === "receipt" ? "" : "receipt")} />
              <ViewCard label="Shared with residents" value={String(all.filter((d) => d.sharedWithTenant).length)} note="View shared" active={sharedOnly} onClick={() => setSharedOnly(!sharedOnly)} />
            </div>
          )}
          <div className="mgr-toolbar">
            <input type="search" aria-label="Search documents" placeholder="Search title, file, unit or tenant" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="mgr-toolbar__filters">
              <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as DocCategory | "")}>
                <option value="">All categories</option>
                {DOC_CATEGORIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              {!embedded && (
                <select aria-label="Belongs to" value={where} onChange={(e) => setWhere(e.target.value as DocScope | "")}>
                  <option value="">Anywhere</option>
                  {DOC_SCOPES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l} documents
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <ErrorLine error={failed} />
          {rows.length === 0 ? (
            <Empty>{all.length === 0 ? "No documents yet." : "No documents match."}</Empty>
          ) : (
            <section className="mgr-card">
              <div className="mgr-table-wrap">
                <table className="mgr-table mgr-table--cards">
                  <thead>
                    <tr>
                      <th scope="col">Document</th>
                      <th scope="col">Belongs to</th>
                      <th scope="col">Category</th>
                      <th scope="col">Resident sees it</th>
                      <th scope="col">Uploaded</th>
                      <th scope="col">
                        <span className="mgr-sr">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => {
                      const shared = pending[d.id] ?? d.sharedWithTenant;
                      return (
                        <tr key={`${d.kind}-${d.id}-${d.href}`}>
                          <th scope="row">
                            {d.title}
                            <div className="mgr-muted">
                              {d.filename} · {fileSize(d.sizeBytes)}
                              {d.kind !== "document" && ` · ${DOC_KIND_TEXT[d.kind]}`}
                            </div>
                          </th>
                          <td data-label="Belongs to">{belongsTo(d)}</td>
                          <td data-label="Category">{DOC_CATEGORY_TEXT[d.category]}</td>
                          <td data-label="Resident sees it">
                            {d.kind === "document" ? (
                              canEdit ? (
                                <label className="mgr-switch">
                                  <input
                                    type="checkbox"
                                    checked={shared}
                                    disabled={busyId === d.id}
                                    onChange={(e) => {
                                      const next = e.target.checked;
                                      setPending((p) => ({ ...p, [d.id]: next }));
                                      void save(d, () => docsApi.update(d.id, { sharedWithTenant: next }), next ? "Shared with the resident." : "No longer shared.").then(
                                        (ok) =>
                                          !ok &&
                                          setPending((p) => {
                                            const { [d.id]: _gone, ...rest } = p;
                                            return rest;
                                          }),
                                      );
                                    }}
                                  />
                                  <span>{shared ? "Shared" : "Office only"}</span>
                                </label>
                              ) : d.sharedWithTenant ? (
                                "Shared"
                              ) : (
                                "Office only"
                              )
                            ) : (
                              <span className="mgr-muted">{d.kind === "lease_pdf" ? "Yes (their lease)" : "No"}</span>
                            )}
                          </td>
                          <td data-label="Uploaded" className="mgr-muted">
                            {timeAgo(d.uploadedAt)}
                            {d.uploadedBy && <div>{d.uploadedBy}</div>}
                          </td>
                          <td className="mgr-row-actions">
                            <a className="mgr-btn mgr-btn--secondary mgr-btn--small" href={d.href} target="_blank" rel="noopener noreferrer">
                              Open
                            </a>
                            {canEdit && d.kind === "document" && (
                              <>
                                <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" disabled={busyId === d.id} onClick={() => setEditing(d)}>
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="mgr-btn mgr-btn--small mgr-btn--danger-ghost"
                                  disabled={busyId === d.id}
                                  onClick={() =>
                                    open({
                                      kind: "confirm",
                                      title: "Remove document",
                                      body: `Remove "${d.title}"? It disappears from this list and from the resident's portal. The file stays on record for the audit log.`,
                                      confirmLabel: "Remove",
                                      run: () => docsApi.hide(d.id),
                                      done: "Document removed.",
                                    })
                                  }
                                >
                                  Remove
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
      {uploading && <UploadDocumentDialog fixed={embedded ? { scope: scope!, id: scopeId!, label: label ?? "" } : null} onClose={() => setUploading(false)} />}
      {editing && <EditDocumentDialog doc={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** What a document can be filed against, for the upload dialog's picker. */
function useScopeChoices(load: boolean) {
  const { data } = useLoad(async () => {
    if (!load) return null;
    const [properties, units, tenants] = await Promise.all([managerApi.properties(), managerApi.units(), managerApi.tenants()]);
    return {
      property: properties.map((p) => ({ id: p.id, label: p.name })),
      unit: units.map((u) => ({ id: u.id, label: `Unit ${u.unitNum} - ${u.propertyName}` })),
      tenant: tenants.map((t) => ({ id: t.id, label: t.unitLabel ? `${t.name} (${t.unitLabel})` : t.name })),
      lease: units
        .filter((u) => u.leaseId)
        .map((u) => ({ id: u.leaseId!, label: `Unit ${u.unitNum} - ${u.propertyName}${u.tenants.length ? ` (${u.tenants.map((t) => t.name).join(", ")})` : ""}` })),
    } as Record<DocScope, Array<{ id: number; label: string }>>;
  }, [load]);
  return data;
}

function UploadDocumentDialog({ fixed, onClose }: { fixed: { scope: DocScope; id: number; label: string } | null; onClose: () => void }) {
  const { changed } = useManager();
  const choices = useScopeChoices(fixed === null);
  const [scope, setScope] = useState<DocScope>(fixed?.scope ?? "property");
  const [target, setTarget] = useState(fixed ? String(fixed.id) : "");
  const [category, setCategory] = useState<DocCategory>("other");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [share, setShare] = useState(false);
  const { busy, error, run } = useSubmit(() => {
    changed(share ? "Document uploaded and shared with the resident." : "Document uploaded.");
    onClose();
  });
  const options = useMemo(() => (choices ? choices[scope] : []), [choices, scope]);

  return (
    <Modal title={fixed ? `Upload a document for ${fixed.label}` : "Upload a document"} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const id = Number(target);
            if (!Number.isInteger(id) || id <= 0) throw new LocalError(`Pick the ${scope} this belongs to.`);
            if (!file) throw new LocalError("Choose a file.");
            if (!title.trim()) throw new LocalError("Give the document a title.");
            let upload;
            try {
              upload = await readFile(file, { accept: DOCUMENT_ACCEPT, maxBytes: DOCUMENT_MAX_BYTES });
            } catch (caught) {
              throw new LocalError((caught as Error).message);
            }
            await docsApi.upload({ scope, id, category, title: title.trim(), sharedWithTenant: share, ...upload });
          });
        }}
      >
        {!fixed && (
          <>
            <Field label="Belongs to">
              <select
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as DocScope);
                  setTarget("");
                }}
              >
                {DOC_SCOPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l === "Lease" ? "A current lease" : `A ${l.toLowerCase()}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={DOC_SCOPES.find(([v]) => v === scope)![1]}>
              <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!choices}>
                <option value="">{choices ? "Choose…" : "Loading…"}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field label="File" hint="PDF, or a JPEG, PNG or WebP photo, up to 10 MB.">
          <input
            type="file"
            accept={DOCUMENT_ACCEPT}
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              setFile(picked);
              if (picked && !title) setTitle(picked.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").slice(0, 200));
            }}
          />
        </Field>
        <Field label="Title">
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Move-in inspection, renter's insurance…" />
        </Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value as DocCategory)}>
            {DOC_CATEGORIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <label className="mgr-check">
          <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
          <span>Share with the resident. Only residents with an active lease on this {scope === "tenant" ? "account" : scope} can open it.</span>
        </label>
        <ErrorLine error={error} />
        <div className="mgr-modal__actions">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy}>
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditDocumentDialog({ doc, onClose }: { doc: HubDocument; onClose: () => void }) {
  const { changed } = useManager();
  const [title, setTitle] = useState(doc.title);
  const [category, setCategory] = useState<DocCategory>(doc.category);
  const { busy, error, run } = useSubmit(() => {
    changed("Document updated.");
    onClose();
  });
  return (
    <Modal title="Edit document" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!title.trim()) throw new LocalError("Give the document a title.");
            await docsApi.update(doc.id, { title: title.trim(), category });
          });
        }}
      >
        <Field label="Title">
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value as DocCategory)}>
            {DOC_CATEGORIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <ErrorLine error={error} />
        <div className="mgr-modal__actions">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
