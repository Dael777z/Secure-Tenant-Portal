// One maintenance request in full (009): what's wrong, the work (stage,
// assignee, priority, type, schedule), its costs (booked once as a repairs
// expense), photos, staff notes and its history. Also the dashboard's
// maintenance summary card.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ManagerApiError, REQUEST_PRIORITIES, REQUEST_STATUSES, REQUEST_TYPES, managerApi, managerMessage, type RequestStatus } from "./api";
import { PHOTO_ACCEPT, PHOTO_MAX_BYTES, docsApi, fileSize, readFile, type MaintenanceDetail, type StaffRoleKey } from "./additions-api";
import { Breadcrumbs, Empty, Loading, PageHeader, StatusPill, isoDate, money, timeAgo, useLoad, useManager } from "./ui";

const STATUS_TEXT = Object.fromEntries(REQUEST_STATUSES) as Record<RequestStatus, string>;
const TYPE_TEXT = Object.fromEntries(REQUEST_TYPES) as Record<string, string>;
const PRIORITY_TEXT = Object.fromEntries(REQUEST_PRIORITIES) as Record<string, string>;
const ROLE_TEXT: Record<StaffRoleKey, string> = { admin: "Property manager", maintenance_staff: "Maintenance" };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** "120", "$35.50" → a number; blank → null; anything else → undefined (not valid). */
function amount(text: string): number | null | undefined {
  const t = text.trim().replace(/[$,]/g, "");
  if (!t) return null;
  if (/^\d+(\.\d{1,2})?$/.test(t)) return Number(t);
  return undefined;
}

/** The unit as a link for managers; plain text for maintenance staff (they have no unit page). */
function UnitLink({ unitId, children }: { unitId: number; children: ReactNode }) {
  const { go, can } = useManager();
  return can("ledger:read:property") ? (
    <a
      href={`#/units/${unitId}`}
      onClick={(e) => {
        e.preventDefault();
        go({ name: "unit", id: unitId, tab: "overview" });
      }}
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

type Save = (work: () => Promise<unknown>, done: string) => Promise<void>;

export function MaintenanceDetailPage({ id }: { id: number }) {
  const { go, can, changed } = useManager();
  const { data, error } = useLoad(() => docsApi.request(id), [id]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;

  const save: Save = async (work, done) => {
    setBusy(true);
    setFailed(null);
    try {
      await work();
      changed(done);
    } catch (e) {
      // A message from readFile (a file we could not send) is shown as is; API errors get plain words.
      setFailed(e instanceof Error && !(e instanceof ManagerApiError) && !(e instanceof TypeError) ? e.message : managerMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const r = data;
  const closed = r.status === "resolved" || r.status === "rejected";

  return (
    <>
      <Breadcrumbs trail={[["Maintenance", { name: "maintenance" }], [r.title, null]]} />
      <PageHeader
        title={r.title}
        subtitle={
          <>
            <UnitLink unitId={r.unitId}>
              Unit {r.unitNum} - {r.propertyName}
            </UnitLink>{" "}
            · {r.tenantName ? `from ${r.tenantName}` : "from the office"} · submitted {when(r.createdAt)}
          </>
        }
        actions={<StatusPill status={r.status} />}
      />
      {failed && <p className="mgr-alert mgr-alert--error" role="alert">{failed}</p>}
      <div className="mgr-columns mgr-columns--request">
        <div className="mgr-stack">
          <section className="mgr-card">
            <h2 className="mgr-h2">What's wrong</h2>
            <p className="mgr-request__desc">{r.description || <span className="mgr-muted">No details given.</span>}</p>
            <dl className="mgr-facts">
              <div>
                <dt>Type</dt>
                <dd>{TYPE_TEXT[r.requestType] ?? r.requestType}</dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>{PRIORITY_TEXT[r.priority] ?? r.priority}</dd>
              </div>
              <div>
                <dt>Resident</dt>
                <dd>
                  {r.tenantId && can("ledger:read:property") ? (
                    <a
                      href={`#/tenants/${r.tenantId}`}
                      onClick={(e) => {
                        e.preventDefault();
                        go({ name: "tenant", id: r.tenantId!, tab: "overview" });
                      }}
                    >
                      {r.tenantName}
                    </a>
                  ) : (
                    r.tenantName ?? "The office"
                  )}
                </dd>
              </div>
              {r.tenantPhone && (
                <div>
                  <dt>Phone</dt>
                  <dd>
                    <a href={`tel:${r.tenantPhone.replace(/[^\d+]/g, "")}`}>{r.tenantPhone}</a>
                  </dd>
                </div>
              )}
              {r.completedAt && (
                <div>
                  <dt>{r.status === "rejected" ? "Closed" : "Completed"}</dt>
                  <dd>{when(r.completedAt)}</dd>
                </div>
              )}
            </dl>
          </section>
          <PhotosCard request={r} busy={busy} save={save} />
          <NotesCard request={r} busy={busy} save={save} />
          <section className="mgr-card">
            <h2 className="mgr-h2">History</h2>
            <ol className="mgr-timeline">
              <li>
                <strong>Submitted</strong> <span className="mgr-muted">{when(r.createdAt)}</span>
              </li>
              {r.history
                .filter((h) => h.from !== null)
                .map((h, i) => (
                  <li key={i}>
                    <strong>{STATUS_TEXT[h.to] ?? h.to}</strong>
                    {h.from && <span className="mgr-muted"> from {STATUS_TEXT[h.from] ?? h.from}</span>}{" "}
                    <span className="mgr-muted">· {when(h.at)}</span>
                  </li>
                ))}
            </ol>
          </section>
        </div>
        <div className="mgr-stack">
          <WorkCard request={r} busy={busy} save={save} closed={closed} />
          <CostsCard request={r} busy={busy} save={save} canBook={can("ledger:adjust")} />
        </div>
      </div>
    </>
  );
}

function WorkCard({ request: r, busy, save, closed }: { request: MaintenanceDetail; busy: boolean; save: Save; closed: boolean }) {
  return (
    <section className="mgr-card">
      <h2 className="mgr-h2">Work</h2>
      <div className="mgr-form">
        <label className="mgr-field">
          <span className="mgr-field__label">Stage</span>
          <select
            value={r.status}
            disabled={busy}
            onChange={(e) => {
              const status = e.target.value as RequestStatus;
              void save(() => managerApi.updateMaintenance(r.id, { status }), status === "rejected" ? "Request rejected. The resident sees it as closed." : `Moved to ${STATUS_TEXT[status]}.`);
            }}
          >
            {REQUEST_STATUSES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {r.status === "rejected" && <span className="mgr-field__hint">Closed without the work. Say why in a message to the resident.</span>}
        </label>
        <label className="mgr-field">
          <span className="mgr-field__label">Assigned to</span>
          <select
            value={r.assignedTo ?? ""}
            disabled={busy}
            onChange={(e) => {
              const to = e.target.value ? Number(e.target.value) : null;
              void save(() => docsApi.updateWork(r.id, { assignedTo: to }), to ? "Assigned." : "No one assigned.");
            }}
          >
            <option value="">No one yet</option>
            {r.assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({ROLE_TEXT[a.role] ?? a.role})
              </option>
            ))}
          </select>
        </label>
        <label className="mgr-field">
          <span className="mgr-field__label">Priority</span>
          <select value={r.priority} disabled={busy} onChange={(e) => void save(() => managerApi.updateMaintenance(r.id, { priority: e.target.value as MaintenanceDetail["priority"] }), "Priority updated.")}>
            {REQUEST_PRIORITIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="mgr-field">
          <span className="mgr-field__label">Type</span>
          <select value={r.requestType} disabled={busy} onChange={(e) => void save(() => managerApi.updateMaintenance(r.id, { requestType: e.target.value as MaintenanceDetail["requestType"] }), "Request type updated.")}>
            {REQUEST_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="mgr-field">
          <span className="mgr-field__label">Scheduled for</span>
          <input
            type="date"
            value={r.scheduledFor ?? ""}
            disabled={busy || closed}
            onChange={(e) => {
              const day = e.target.value;
              void save(
                () =>
                  managerApi.updateMaintenance(
                    r.id,
                    day ? { scheduledFor: day, ...(r.status === "submitted" || r.status === "in_review" ? { status: "scheduled" as const } : {}) } : { scheduledFor: null },
                  ),
                day ? `Scheduled for ${isoDate(day)}.` : "Schedule cleared.",
              );
            }}
          />
        </label>
      </div>
    </section>
  );
}

function CostsCard({ request: r, busy, save, canBook }: { request: MaintenanceDetail; busy: boolean; save: Save; canBook: boolean }) {
  const shown = (v: number | null) => (v === null ? "" : String(v));
  const [labor, setLabor] = useState(shown(r.laborCost));
  const [materials, setMaterials] = useState(shown(r.materialsCost));
  const [invalid, setInvalid] = useState<string | null>(null);
  useEffect(() => {
    setLabor(shown(r.laborCost));
    setMaterials(shown(r.materialsCost));
  }, [r.laborCost, r.materialsCost]);
  const total = (r.laborCost ?? 0) + (r.materialsCost ?? 0);
  const edited = labor !== shown(r.laborCost) || materials !== shown(r.materialsCost);
  const booked = r.expenseId !== null;
  return (
    <section className="mgr-card">
      <h2 className="mgr-h2">Costs</h2>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          const l = amount(labor);
          const m = amount(materials);
          if (l === undefined || m === undefined) return setInvalid("Enter amounts like 120 or 35.50.");
          setInvalid(null);
          void save(() => docsApi.updateWork(r.id, { laborCost: l, materialsCost: m }), "Costs saved.");
        }}
      >
        <label className="mgr-field">
          <span className="mgr-field__label">Labor</span>
          <input inputMode="decimal" value={labor} placeholder="0.00" disabled={busy || booked} onChange={(e) => setLabor(e.target.value)} />
        </label>
        <label className="mgr-field">
          <span className="mgr-field__label">Materials</span>
          <input inputMode="decimal" value={materials} placeholder="0.00" disabled={busy || booked} onChange={(e) => setMaterials(e.target.value)} />
        </label>
        {invalid && <p className="mgr-alert mgr-alert--error" role="alert">{invalid}</p>}
        {!booked && (
          <button type="submit" className="mgr-btn mgr-btn--secondary" disabled={busy || !edited}>
            Save costs
          </button>
        )}
      </form>
      <p className="mgr-cost-total">
        Total <strong>{money(total)}</strong>
      </p>
      {booked ? (
        <p className="mgr-muted">Recorded as a repairs expense. Costs are locked so the books match.</p>
      ) : canBook ? (
        <button
          type="button"
          className="mgr-btn mgr-btn--primary"
          disabled={busy || edited || total <= 0}
          title={edited ? "Save the costs first" : total <= 0 ? "Enter labor or materials first" : undefined}
          onClick={() => void save(() => docsApi.recordExpense(r.id), `Recorded ${money(total)} as a repairs expense.`)}
        >
          Record as expense
        </button>
      ) : (
        <p className="mgr-muted">A property manager records these as an expense.</p>
      )}
    </section>
  );
}

function NotesCard({ request: r, busy, save }: { request: MaintenanceDetail; busy: boolean; save: Save }) {
  const [text, setText] = useState("");
  return (
    <section className="mgr-card">
      <div className="mgr-card__head">
        <h2 className="mgr-h2">Internal notes</h2>
        <span className="mgr-muted">Staff only. Residents never see these.</span>
      </div>
      {r.notes.length === 0 ? (
        <Empty>No notes yet.</Empty>
      ) : (
        <ul className="mgr-notes">
          {r.notes.map((n) => (
            <li key={n.id}>
              <p>{n.body}</p>
              <span className="mgr-muted">
                {n.author ?? "Staff"} · {timeAgo(n.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          const body = text.trim();
          if (body)
            void save(async () => {
              await docsApi.addNote(r.id, body);
              setText("");
            }, "Note added.");
        }}
      >
        <label className="mgr-field">
          <span className="mgr-field__label">Add a note</span>
          <textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Parts ordered, access times, what was found…" />
        </label>
        <button type="submit" className="mgr-btn mgr-btn--secondary" disabled={busy || !text.trim()}>
          Add note
        </button>
      </form>
    </section>
  );
}

function PhotosCard({ request: r, busy, save }: { request: MaintenanceDetail; busy: boolean; save: Save }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="mgr-card">
      <div className="mgr-card__head">
        <h2 className="mgr-h2">Photos</h2>
        <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" disabled={busy} onClick={() => input.current?.click()}>
          + Add photo
        </button>
        <input
          ref={input}
          type="file"
          accept={PHOTO_ACCEPT}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void save(async () => docsApi.addPhoto(r.id, await readFile(file, { accept: PHOTO_ACCEPT, maxBytes: PHOTO_MAX_BYTES })), "Photo added.");
          }}
        />
      </div>
      {r.attachments.length === 0 ? (
        <Empty>No photos yet. JPEG, PNG or WebP, up to 5 MB each.</Empty>
      ) : (
        <ul className="mgr-photos">
          {r.attachments.map((a) => (
            <li key={a.id}>
              <a href={docsApi.photoUrl(r.id, a.id)} target="_blank" rel="noopener noreferrer">
                <img src={docsApi.photoUrl(r.id, a.id)} alt={a.filename} loading="lazy" />
              </a>
              <span className="mgr-muted">
                {a.fromTenant ? "From the resident" : a.uploadedBy ?? "Staff"} · {fileSize(a.sizeBytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The dashboard's maintenance card: the queue by stage, over a period
 * ------------------------------------------------------------------ */

const FUNNEL: RequestStatus[] = ["submitted", "in_review", "scheduled", "in_progress", "resolved", "rejected"];

export function MaintenanceSummaryCard() {
  const { go } = useManager();
  const [days, setDays] = useState(30);
  const { data, error } = useLoad(() => docsApi.summary(days), [days]);
  const most = data ? Math.max(1, ...FUNNEL.map((s) => data.byStatus[s] ?? 0)) : 1;
  return (
    <section className="mgr-card">
      <div className="mgr-card__head">
        <h2 className="mgr-h2">Maintenance</h2>
        <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 30, 60, 90, 365].map((d) => (
            <option key={d} value={d}>
              {d === 365 ? "Last 12 months" : `Last ${d} days`}
            </option>
          ))}
        </select>
      </div>
      {data ? (
        <>
          <p className="mgr-muted">
            {data.open} open · {data.averageDaysToComplete === null ? "nothing completed in this period" : `${data.averageDaysToComplete} days to complete, on average`}
          </p>
          <ul className="mgr-funnel">
            {FUNNEL.map((s) => {
              const n = data.byStatus[s] ?? 0;
              return (
                <li key={s}>
                  <button type="button" className="mgr-funnel__row" onClick={() => go({ name: "maintenance", view: s })}>
                    <span className="mgr-funnel__label">{STATUS_TEXT[s]}</span>
                    <span className="mgr-funnel__bar" aria-hidden="true">
                      <span className={`mgr-funnel__fill mgr-funnel__fill--${s}`} style={{ width: `${(n / most) * 100}%` }} />
                    </span>
                    <span className="mgr-funnel__count">{n}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <Loading error={error} />
      )}
    </section>
  );
}
