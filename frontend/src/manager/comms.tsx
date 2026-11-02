// Notices and Listings (009). Notices: write to one resident, a building or
// everyone on a current lease, and see every notice residents were given
// (rent reminders and payment confirmations too). Listings: offer a unit on
// the public /listings page and track who asks about it.
import { useMemo, useState } from "react";
import { managerApi, managerMessage } from "./api";
import {
  LEAD_SOURCES, LEAD_STATUSES, LISTING_STATUSES, NOTICE_STATUSES, NOTICE_TEMPLATES, commsApi,
  type Lead, type LeadStatus, type Listing, type ListingInput, type NoticeAudience, type NoticeRow,
} from "./additions-api";
import { Breadcrumbs, Empty, Field, Kpi, Loading, LocalError, Modal, PageHeader, money, timeAgo, useLoad, useManager, useSubmit } from "./ui";

const orNull = (s: string) => (s.trim() ? s.trim() : null);
const sentAt = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="mgr-alert mgr-alert--error" role="alert">{error}</p> : null;
}

/* ------------------------------------------------------------------ *
 * Notices
 * ------------------------------------------------------------------ */

interface Recipient {
  tenantId: number;
  name: string;
  unitLabel: string | null;
  portal: NoticeRow | null;
  email: NoticeRow | null;
}
interface NoticeGroup {
  key: string;
  first: NoticeRow;
  people: Recipient[];
}

/** One row per notice sent (a building-wide notice is one row with its residents), not one per delivery. */
function groupNotices(rows: NoticeRow[]): NoticeGroup[] {
  const groups = new Map<string, NoticeGroup>();
  for (const n of rows) {
    const key = [n.template, n.subject, n.body, n.createdBy ?? "", n.createdAt.slice(0, 19)].join("\u0001");
    const g = groups.get(key) ?? { key, first: n, people: [] };
    groups.set(key, g);
    let person = g.people.find((p) => p.tenantId === n.tenantId);
    if (!person) {
      person = { tenantId: n.tenantId, name: n.tenantName, unitLabel: n.unitLabel, portal: null, email: null };
      g.people.push(person);
    }
    if (n.channel === "email") person.email = n;
    else person.portal = n;
  }
  return [...groups.values()];
}

export function NoticesPage() {
  const { can, go } = useManager();
  const [search, setSearch] = useState("");
  const [template, setTemplate] = useState("");
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [writing, setWriting] = useState(false);
  const { data, error } = useLoad(() => commsApi.notices({ template, channel, status, q: search.trim() }), [template, channel, status, search]);
  const rows = data?.notices ?? [];
  const failed = rows.filter((n) => n.status === "failed").length;
  const groups = useMemo(() => groupNotices(rows), [rows]);

  return (
    <>
      <PageHeader
        title="Notices"
        subtitle="Send a notice to one resident, a building, or everyone on a current lease. Below is every notice the portal has given residents, including rent reminders and payment confirmations."
        actions={
          can("messages:manage") && (
            <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => setWriting(true)}>
              + New notice
            </button>
          )
        }
      />
      {data && !data.emailEnabled && (
        <div className="mgr-alert mgr-comms__note" role="note">
          <strong>Email is off.</strong> Notices appear in each resident's portal under Notices. Email is not set up on this server yet.
        </div>
      )}
      <div className="mgr-toolbar">
        <input type="search" aria-label="Search notices" placeholder="Search subject, text or resident" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="mgr-toolbar__filters">
          <select aria-label="Type" value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">All types</option>
            {Object.keys(NOTICE_TEMPLATES).map((t) => (
              <option key={t} value={t}>
                {NOTICE_TEMPLATES[t]}
              </option>
            ))}
          </select>
          <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">Portal and email</option>
            <option value="in_app">Resident portal</option>
            <option value="email">Email</option>
          </select>
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {Object.keys(NOTICE_STATUSES).map((s) => (
              <option key={s} value={s}>
                {NOTICE_STATUSES[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {failed > 0 && !status && (
        <p className="mgr-alert mgr-alert--error">
          {failed} email{failed === 1 ? "" : "s"} failed.{" "}
          <button type="button" className="mgr-btn mgr-btn--link" onClick={() => setStatus("failed")}>
            Show them
          </button>
        </p>
      )}
      {!data ? (
        <Loading error={error} />
      ) : rows.length === 0 ? (
        <Empty>{search || template || channel || status ? "No notices match." : "No notices yet. Rent reminders and payment confirmations appear here as they go out."}</Empty>
      ) : (
        <section className="mgr-card">
          <div className="mgr-table-wrap">
            <table className="mgr-table mgr-table--cards">
              <thead>
                <tr>
                  <th>Sent</th>
                  <th>To</th>
                  <th>Notice</th>
                  <th>Type</th>
                  <th>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <NoticeLine key={g.key} group={g} onTenant={(id) => go({ name: "tenant", id, tab: "overview" })} />
                ))}
              </tbody>
            </table>
          </div>
          {rows.length >= 500 && <p className="mgr-muted">Showing the newest 500 deliveries. Search or filter to find older notices.</p>}
        </section>
      )}
      {writing && data && <NewNoticeDialog emailEnabled={data.emailEnabled} onClose={() => setWriting(false)} />}
    </>
  );
}

function NoticeLine({ group, onTenant }: { group: NoticeGroup; onTenant: (tenantId: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [showWho, setShowWho] = useState(false);
  const n = group.first;
  const long = n.body.length > 140;
  const inPortal = group.people.filter((p) => p.portal);
  const read = inPortal.filter((p) => p.portal!.readAt).length;
  const emails = group.people.map((p) => p.email).filter((e): e is NoticeRow => e !== null);
  const emailCount = (s: string) => emails.filter((e) => e.status === s).length;
  const failedEmails = emailCount("failed");
  const one = group.people.length === 1 ? group.people[0]! : null;
  return (
    <tr className={failedEmails ? "mgr-row--alert" : undefined}>
      <td data-label="Sent" className="mgr-muted mgr-nowrap">
        {sentAt(n.createdAt)}
        <div>{n.createdBy ?? "Automatic"}</div>
      </td>
      <td data-label="To">
        {one ? (
          <>
            <button type="button" className="mgr-btn mgr-btn--link" onClick={() => onTenant(one.tenantId)}>
              {one.name}
            </button>
            {one.unitLabel && <div className="mgr-muted">{one.unitLabel}</div>}
          </>
        ) : (
          <>
            <strong>{group.people.length} residents</strong>
            <div>
              <button type="button" className="mgr-btn mgr-btn--link" aria-expanded={showWho} onClick={() => setShowWho(!showWho)}>
                {showWho ? "Hide who" : "Show who"}
              </button>
            </div>
          </>
        )}
      </td>
      <td data-label="Notice" className="mgr-notice">
        <strong>{n.subject}</strong>
        <p>{expanded || !long ? n.body : `${n.body.slice(0, 140)}…`}</p>
        {long && (
          <button type="button" className="mgr-btn mgr-btn--link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : "Show all"}
          </button>
        )}
        {showWho && (
          <ul className="mgr-notice__people">
            {group.people.map((p) => (
              <li key={p.tenantId}>
                <button type="button" className="mgr-btn mgr-btn--link" onClick={() => onTenant(p.tenantId)}>
                  {p.name}
                </button>
                {p.unitLabel && <span className="mgr-muted"> · {p.unitLabel}</span>}
                <span className="mgr-muted">
                  {" · "}
                  {p.portal ? (p.portal.readAt ? `read ${timeAgo(p.portal.readAt)}` : "not read yet") : ""}
                  {p.email && ` · email ${NOTICE_STATUSES[p.email.status]?.toLowerCase()}`}
                </span>
                {p.email?.error && <div className="mgr-muted mgr-notice__error">{p.email.error}</div>}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td data-label="Type">{NOTICE_TEMPLATES[n.template] ?? n.template}</td>
      <td data-label="Delivery" className="mgr-notice__delivery">
        {inPortal.length > 0 && (
          <div>
            <span className="mgr-pill mgr-pill--notice-sent">Portal</span> {one ? (read ? `Read ${timeAgo(one.portal!.readAt!)}` : "Not read yet") : `${read} of ${inPortal.length} read`}
          </div>
        )}
        {emails.length > 0 && (
          <div>
            <span className={`mgr-pill mgr-pill--notice-${failedEmails ? "failed" : emailCount("sent") === emails.length ? "sent" : emailCount("skipped") === emails.length ? "skipped" : "queued"}`}>Email</span>{" "}
            {one
              ? NOTICE_STATUSES[emails[0]!.status]
              : ([["sent", "sent"], ["failed", "failed"], ["skipped", "not sent"], ["queued", "waiting"], ["sending", "sending"]] as const)
                  .map(([s, label]) => [emailCount(s), label] as const)
                  .filter(([c]) => c > 0)
                  .map(([c, label]) => `${c} ${label}`)
                  .join(", ")}
            {one && emails[0]!.error && <div className="mgr-muted mgr-notice__error">{emails[0]!.error}</div>}
          </div>
        )}
      </td>
    </tr>
  );
}

function NewNoticeDialog({ emailEnabled, onClose }: { emailEnabled: boolean; onClose: () => void }) {
  const { changed } = useManager();
  const properties = useLoad(() => managerApi.properties());
  const tenants = useLoad(() => managerApi.tenants());
  const [audience, setAudience] = useState<"all" | "property" | "tenant">("all");
  const [target, setTarget] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [email, setEmail] = useState(emailEnabled);
  const [sent, setSent] = useState<string | null>(null);
  const { busy, error, run } = useSubmit(() => undefined);
  const choices =
    audience === "property"
      ? (properties.data ?? []).map((p) => ({ id: p.id, label: p.name }))
      : audience === "tenant"
        ? (tenants.data ?? []).map((t) => ({ id: t.id, label: t.unitLabel ? `${t.name} (${t.unitLabel})` : t.name }))
        : [];

  if (sent) {
    return (
      <Modal title="Notice sent" onClose={onClose}>
        <p>{sent}</p>
        <div className="mgr-modal__actions">
          <button type="button" className="mgr-btn mgr-btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="New notice" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (audience !== "all" && !target) throw new LocalError(audience === "tenant" ? "Choose the resident." : "Choose the building.");
            if (!subject.trim()) throw new LocalError("Add a subject.");
            if (!body.trim()) throw new LocalError("Write the notice.");
            const to: NoticeAudience = audience === "all" ? { kind: "all" } : { kind: audience, id: Number(target) };
            const result = await commsApi.send({ audience: to, subject: subject.trim(), body: body.trim(), email: emailEnabled && email });
            const who = `${result.recipients} resident${result.recipients === 1 ? "" : "s"}`;
            const how =
              !emailEnabled || !email
                ? "It appears in their portal under Notices."
                : `${result.emailsQueued} email${result.emailsQueued === 1 ? "" : "s"} going out${result.emailsSkipped ? `; ${result.emailsSkipped} resident${result.emailsSkipped === 1 ? " has" : "s have"} email notices turned off` : ""}.`;
            setSent(`Sent to ${who}. ${how}`);
            changed();
          });
        }}
      >
        <Field label="Send to">
          <select
            value={audience}
            onChange={(e) => {
              setAudience(e.target.value as typeof audience);
              setTarget("");
            }}
          >
            <option value="all">Everyone on a current lease</option>
            <option value="property">Residents of one building</option>
            <option value="tenant">One resident</option>
          </select>
        </Field>
        {audience !== "all" && (
          <Field label={audience === "tenant" ? "Resident" : "Building"}>
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!choices.length}>
              <option value="">{choices.length ? "Choose…" : "Loading…"}</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Subject">
          <input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} placeholder="Water shut-off Tuesday 9am to noon" />
        </Field>
        <Field label="Notice" hint={`${body.length} / 4000`}>
          <textarea rows={6} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <label className="mgr-check">
          <input type="checkbox" checked={emailEnabled && email} disabled={!emailEnabled} onChange={(e) => setEmail(e.target.checked)} />
          <span>{emailEnabled ? "Also email it (residents who turned off email notices are skipped)." : "Email is off on this server, so this goes to the resident portal only."}</span>
        </label>
        <p className="mgr-muted mgr-comms__legal">Formal legal notices (notice to quit, rent increase) may need to be served as the law requires. Sending one here does not replace that.</p>
        <ErrorLine error={error} />
        <div className="mgr-modal__actions">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy}>
            {busy ? "Sending…" : "Send notice"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Listings and leads
 * ------------------------------------------------------------------ */

export function ListingsPage() {
  const { can, go } = useManager();
  const { data, error } = useLoad(() => commsApi.listings());
  const leads = useLoad(() => commsApi.leads());
  const [creating, setCreating] = useState(false);
  const listings = data?.listings ?? [];
  const byId = useMemo(() => new Map(listings.map((l) => [l.id, l])), [listings]);
  return (
    <>
      <PageHeader
        title="Listings"
        subtitle="Offer a unit for rent, publish it to your public listings page, and keep track of who asks about it."
        actions={
          <>
            <a className="mgr-btn mgr-btn--ghost" href="/listings" target="_blank" rel="noopener noreferrer">
              Open public listings page
            </a>
            {can("users:provision") && (
              <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => setCreating(true)}>
                + New listing
              </button>
            )}
          </>
        }
      />
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          <div className="mgr-kpis">
            <Kpi label="Listed now" value={String(listings.filter((l) => l.status === "active").length)} note="On your public page" />
            <Kpi label="Drafts" value={String(listings.filter((l) => l.status === "draft").length)} note="Not public yet" />
            <Kpi label="New leads" value={String(listings.reduce((s, l) => s + l.newLeads, 0))} tone={listings.some((l) => l.newLeads) ? "warn" : undefined} note="Not contacted yet" />
            <Kpi label="Leads, all time" value={String(listings.reduce((s, l) => s + l.leads, 0))} />
          </div>
          <ZillowCard label={data.zillow.label} detail={data.zillow.detail} />
          {listings.length === 0 ? (
            <Empty>No listings yet. Create one for a vacant unit, or for a unit whose lease is ending.</Empty>
          ) : (
            <section className="mgr-card">
              <h2 className="mgr-h2">All listings</h2>
              <div className="mgr-table-wrap">
                <table className="mgr-table mgr-table--cards">
                  <thead>
                    <tr>
                      <th>Listing</th>
                      <th>Status</th>
                      <th>Asking rent</th>
                      <th>Available</th>
                      <th>Leads</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {listings.map((l) => (
                      <tr key={l.id} className={l.status === "ended" ? "mgr-row--muted" : undefined}>
                        <td data-label="Listing">
                          <a
                            href={`#/listings/${l.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              go({ name: "listing", id: l.id });
                            }}
                          >
                            <strong>{l.title}</strong>
                          </a>
                          <div className="mgr-muted">
                            Unit {l.unitNum} - {l.propertyName}
                          </div>
                        </td>
                        <td data-label="Status">
                          <span className={`mgr-pill mgr-pill--listing-${l.status}`}>{LISTING_STATUSES[l.status]}</span>
                        </td>
                        <td data-label="Asking rent">{money(l.askingRent)}</td>
                        <td data-label="Available">{day(l.availableOn)}</td>
                        <td data-label="Leads">
                          {l.leads}
                          {l.newLeads > 0 && <span className="mgr-badge mgr-comms__new">{l.newLeads} new</span>}
                        </td>
                        <td className="mgr-row-actions">
                          <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "listing", id: l.id })}>
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <section className="mgr-card">
            <h2 className="mgr-h2">Recent leads</h2>
            {!leads.data ? (
              <Loading error={leads.error} />
            ) : leads.data.length === 0 ? (
              <p className="mgr-muted">No leads yet. Inquiries from your public listings page appear here, and you can add people who call or email.</p>
            ) : (
              <LeadsTable leads={leads.data.slice(0, 25)} listingTitle={(id) => byId.get(id)?.title ?? "Listing"} onListing={(id) => go({ name: "listing", id })} />
            )}
          </section>
        </>
      )}
      {creating && <ListingDialog listing={null} onClose={() => setCreating(false)} />}
    </>
  );
}

function ZillowCard({ label, detail }: { label: string; detail: string }) {
  return (
    <section className="mgr-card mgr-zillow" aria-labelledby="zillow-heading">
      <div>
        <h2 className="mgr-h2" id="zillow-heading">
          Zillow
        </h2>
        <p className="mgr-muted">{detail}</p>
      </div>
      <div className="mgr-zillow__side">
        <span className="mgr-pill mgr-pill--zillow">{label}</span>
        <button type="button" className="mgr-btn mgr-btn--secondary" disabled aria-describedby="zillow-heading" title="Zillow is not connected yet">
          Connect Zillow
        </button>
      </div>
    </section>
  );
}

function LeadsTable({ leads, listingTitle, onListing }: { leads: Lead[]; listingTitle?: (listingId: number) => string; onListing?: (listingId: number) => void }) {
  const { can, changed } = useManager();
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  async function setStatus(lead: Lead, status: LeadStatus) {
    setBusy(lead.id);
    setFailed(null);
    try {
      await commsApi.setLeadStatus(lead.id, status);
      changed(`${lead.name}: ${LEAD_STATUSES.find(([s]) => s === status)![1].toLowerCase()}.`);
    } catch (e) {
      setFailed(managerMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <ErrorLine error={failed} />
      <div className="mgr-table-wrap">
        <table className="mgr-table mgr-table--cards">
          <thead>
            <tr>
              <th>Person</th>
              {listingTitle && <th>Listing</th>}
              <th>Message</th>
              <th>Came from</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td data-label="Person">
                  <strong>{l.name}</strong>
                  {l.email && (
                    <div>
                      <a href={`mailto:${l.email}`}>{l.email}</a>
                    </div>
                  )}
                  {l.phone && (
                    <div>
                      <a href={`tel:${l.phone.replace(/[^0-9+]/g, "")}`}>{l.phone}</a>
                    </div>
                  )}
                </td>
                {listingTitle && (
                  <td data-label="Listing">
                    <button type="button" className="mgr-btn mgr-btn--link" onClick={() => onListing?.(l.listingId)}>
                      {listingTitle(l.listingId)}
                    </button>
                  </td>
                )}
                <td data-label="Message" className="mgr-notice">
                  <p>{l.message ?? "—"}</p>
                </td>
                <td data-label="Came from" className="mgr-muted">
                  {LEAD_SOURCES[l.source]}
                  <div>{timeAgo(l.createdAt)}</div>
                </td>
                <td data-label="Status">
                  {can("users:provision") ? (
                    <select aria-label={`Status for ${l.name}`} value={l.status} disabled={busy === l.id} onChange={(e) => void setStatus(l, e.target.value as LeadStatus)}>
                      {LEAD_STATUSES.map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    LEAD_STATUSES.find(([s]) => s === l.status)![1]
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ListingPage({ id }: { id: number }) {
  const { can, open, go } = useManager();
  const { data, error } = useLoad(() => commsApi.listing(id), [id]);
  const [editing, setEditing] = useState(false);
  const [addingLead, setAddingLead] = useState(false);
  const canEdit = can("users:provision");
  if (!data) return <Loading error={error} />;
  const l = data;
  return (
    <>
      <Breadcrumbs trail={[["Listings", { name: "listings" }], [l.title, null]]} />
      <PageHeader
        title={l.title}
        subtitle={
          <>
            <a
              href={`#/units/${l.unitId}`}
              onClick={(e) => {
                e.preventDefault();
                go({ name: "unit", id: l.unitId, tab: "overview" });
              }}
            >
              Unit {l.unitNum} - {l.propertyName}
            </a>{" "}
            · <span className={`mgr-pill mgr-pill--listing-${l.status}`}>{LISTING_STATUSES[l.status]}</span>
          </>
        }
        actions={
          canEdit && (
            <>
              {l.status !== "ended" && (
                <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
              {l.status === "draft" && (
                <button
                  type="button"
                  className="mgr-btn mgr-btn--danger-ghost"
                  onClick={() =>
                    open({
                      kind: "confirm",
                      title: "Remove draft",
                      body: `Remove the draft "${l.title}"? It was never public.`,
                      confirmLabel: "Remove draft",
                      run: () => commsApi.removeDraft(l.id),
                      done: "Draft removed.",
                      after: { name: "listings" },
                    })
                  }
                >
                  Remove draft
                </button>
              )}
              {l.status === "active" && (
                <button
                  type="button"
                  className="mgr-btn mgr-btn--danger-ghost"
                  onClick={() =>
                    open({
                      kind: "confirm",
                      title: "End listing",
                      body: `End "${l.title}"? It comes off your public listings page and stops taking inquiries. Its leads are kept.`,
                      confirmLabel: "End listing",
                      run: () => commsApi.end(l.id),
                      done: "Listing ended.",
                    })
                  }
                >
                  End listing
                </button>
              )}
              {l.status === "draft" && (
                <button
                  type="button"
                  className="mgr-btn mgr-btn--primary"
                  onClick={() =>
                    open({
                      kind: "confirm",
                      title: "Publish listing",
                      body: `Publish "${l.title}" at ${money(l.askingRent)} a month? Anyone can see it on your public listings page and send an inquiry.`,
                      confirmLabel: "Publish",
                      run: () => commsApi.publish(l.id),
                      done: "Listing published.",
                    })
                  }
                >
                  Publish
                </button>
              )}
            </>
          )
        }
      />
      {l.occupied && l.status !== "ended" && (
        <p className="mgr-alert mgr-comms__note" role="note">
          This unit has a lease covering today. Make sure the move-in date fits when that lease ends.
        </p>
      )}
      <div className="mgr-columns mgr-columns--request">
        <section className="mgr-card">
          <h2 className="mgr-h2">Details</h2>
          <dl className="mgr-facts">
            <div>
              <dt>Asking rent</dt>
              <dd>{money(l.askingRent)} / month</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>{day(l.availableOn)}</dd>
            </div>
            <div>
              <dt>Bedrooms · baths</dt>
              <dd>
                {l.beds ?? "—"} · {l.baths ?? "—"}
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{l.sqft ? `${l.sqft.toLocaleString("en-US")} sq ft` : "—"}</dd>
            </div>
            <div>
              <dt>Pets</dt>
              <dd>{l.pets ?? "—"}</dd>
            </div>
            <div>
              <dt>Photos</dt>
              <dd>{l.photos ? `${l.photos} from the building and unit` : "None yet"}</dd>
            </div>
            <div className="mgr-facts__wide">
              <dt>Amenities</dt>
              <dd>{l.amenities.length ? l.amenities.join(" · ") : "—"}</dd>
            </div>
            <div className="mgr-facts__wide">
              <dt>Description</dt>
              <dd className="mgr-pre">{l.description ?? "—"}</dd>
            </div>
          </dl>
        </section>
        <div className="mgr-stack">
          <section className="mgr-card">
            <h2 className="mgr-h2">Where it shows</h2>
            <dl className="mgr-facts">
              <div className="mgr-facts__wide">
                <dt>Your public listings page</dt>
                <dd>
                  {l.status === "active" ? (
                    <a href="/listings" target="_blank" rel="noopener noreferrer">
                      Listed since {l.publishedAt ? new Date(l.publishedAt).toLocaleDateString("en-US") : ""}
                    </a>
                  ) : l.status === "draft" ? (
                    "Not yet: publish to list it"
                  ) : (
                    `Ended ${l.endedAt ? new Date(l.endedAt).toLocaleDateString("en-US") : ""}`
                  )}
                </dd>
              </div>
              <div className="mgr-facts__wide">
                <dt>Zillow</dt>
                <dd>
                  <span className="mgr-pill mgr-pill--zillow">Not Connected — Future Integration</span>
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
      <section className="mgr-card">
        <div className="mgr-card__head">
          <h2 className="mgr-h2">Leads ({l.leadList.length})</h2>
          {canEdit && l.status !== "ended" && (
            <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => setAddingLead(true)}>
              + Add lead
            </button>
          )}
        </div>
        {l.leadList.length === 0 ? <p className="mgr-muted">No one has asked about this listing yet.</p> : <LeadsTable leads={l.leadList} />}
      </section>
      {editing && <ListingDialog listing={l} onClose={() => setEditing(false)} />}
      {addingLead && <LeadDialog listingId={l.id} onClose={() => setAddingLead(false)} />}
    </>
  );
}

function ListingDialog({ listing, onClose }: { listing: Listing | null; onClose: () => void }) {
  const { changed, go } = useManager();
  const units = useLoad(() => (listing ? Promise.resolve([]) : managerApi.units()));
  const listed = useLoad(() => (listing ? Promise.resolve(new Set<number>()) : commsApi.listings().then((r) => new Set(r.listings.filter((l) => l.status !== "ended").map((l) => l.unitId)))));
  const [unit, setUnit] = useState("");
  const [title, setTitle] = useState(listing?.title ?? "");
  const [description, setDescription] = useState(listing?.description ?? "");
  const [rent, setRent] = useState(listing ? String(listing.askingRent) : "");
  const [available, setAvailable] = useState(listing?.availableOn ?? "");
  const [beds, setBeds] = useState(listing?.beds?.toString() ?? "");
  const [baths, setBaths] = useState(listing?.baths?.toString() ?? "");
  const [sqft, setSqft] = useState(listing?.sqft?.toString() ?? "");
  const [amenities, setAmenities] = useState(listing?.amenities.join(", ") ?? "");
  const [pets, setPets] = useState(listing?.pets ?? "");
  const { busy, error, run } = useSubmit(() => onClose());
  // Vacant units first.
  const choices = useMemo(() => [...(units.data ?? [])].sort((a, b) => Number(a.status !== "vacant") - Number(b.status !== "vacant")), [units.data]);

  function read(): ListingInput {
    const number = (text: string, label: string, rule: { max: number; half?: boolean; integer?: boolean }) => {
      if (!text.trim()) return null;
      const n = Number(text);
      if (!Number.isFinite(n) || n < 0 || n > rule.max || (rule.half && n * 2 !== Math.round(n * 2)) || (rule.integer && !Number.isInteger(n))) {
        throw new LocalError(`${label}: enter ${rule.integer ? "a whole number" : rule.half ? "a number like 1 or 1.5" : "a number"}, or leave it blank.`);
      }
      return n;
    };
    const askingRent = Number(rent.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(askingRent) || askingRent <= 0 || askingRent > 100_000 || Math.round(askingRent * 100) !== askingRent * 100) throw new LocalError("Enter the monthly rent, like 1650.");
    if (!title.trim()) throw new LocalError("Give the listing a headline.");
    const list = amenities.split(",").map((a) => a.trim()).filter(Boolean);
    if (list.length > 40 || list.some((a) => a.length > 60)) throw new LocalError("List up to 40 amenities, each under 60 characters, separated by commas.");
    return {
      title: title.trim(),
      description: orNull(description),
      askingRent,
      availableOn: available || null,
      beds: number(beds, "Bedrooms", { half: true, max: 20 }),
      baths: number(baths, "Bathrooms", { half: true, max: 20 }),
      sqft: number(sqft, "Square feet", { integer: true, max: 100_000 }),
      amenities: list,
      pets: orNull(pets),
    };
  }

  return (
    <Modal title={listing ? `Edit ${listing.title}` : "New listing"} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const input = read();
            if (listing) {
              await commsApi.updateListing(listing.id, input);
              changed("Listing saved.");
            } else {
              if (!unit) throw new LocalError("Choose the unit.");
              const made = await commsApi.createListing({ ...input, unitId: Number(unit) });
              changed("Draft saved. Publish it when it's ready.");
              go({ name: "listing", id: made.id });
            }
          });
        }}
      >
        {!listing && (
          <Field label="Unit">
            <select
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value);
                const picked = choices.find((u) => String(u.id) === e.target.value);
                if (picked && !rent && picked.monthlyRent) setRent(String(picked.monthlyRent));
                if (picked && !title) setTitle(`Unit ${picked.unitNum} at ${picked.propertyName}`);
              }}
              disabled={!units.data || !listed.data}
            >
              <option value="">{units.data && listed.data ? "Choose…" : "Loading…"}</option>
              {choices.map((u) => (
                <option key={u.id} value={u.id} disabled={listed.data?.has(u.id)}>
                  Unit {u.unitNum} - {u.propertyName}
                  {listed.data?.has(u.id) ? " (already listed)" : u.status === "vacant" ? " (vacant)" : u.endDate ? ` (lease ends ${u.endDate})` : " (leased)"}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Headline">
          <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Sunny 2-bedroom near the park" />
        </Field>
        <div className="mgr-form__row">
          <Field label="Asking rent (per month)">
            <input value={rent} inputMode="decimal" onChange={(e) => setRent(e.target.value)} placeholder="1650" />
          </Field>
          <Field label="Available from">
            <input type="date" value={available} onChange={(e) => setAvailable(e.target.value)} />
          </Field>
        </div>
        <div className="mgr-form__row">
          <Field label="Bedrooms">
            <input value={beds} inputMode="decimal" onChange={(e) => setBeds(e.target.value)} placeholder="2" />
          </Field>
          <Field label="Bathrooms">
            <input value={baths} inputMode="decimal" onChange={(e) => setBaths(e.target.value)} placeholder="1" />
          </Field>
          <Field label="Square feet">
            <input value={sqft} inputMode="numeric" onChange={(e) => setSqft(e.target.value)} placeholder="850" />
          </Field>
        </div>
        <Field label="Description">
          <textarea rows={5} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Amenities" hint="Separate with commas: Laundry in building, Heat included, Parking">
          <input value={amenities} onChange={(e) => setAmenities(e.target.value)} />
        </Field>
        <Field label="Pets">
          <input value={pets} maxLength={200} onChange={(e) => setPets(e.target.value)} placeholder="Cats OK; no dogs" />
        </Field>
        <p className="mgr-muted mgr-comms__legal">Listings must follow fair housing law: describe the home, not who should live there.</p>
        <ErrorLine error={error} />
        <div className="mgr-modal__actions">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy}>
            {busy ? "Saving…" : listing ? "Save" : "Save draft"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LeadDialog({ listingId, onClose }: { listingId: number; onClose: () => void }) {
  const { changed } = useManager();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const { busy, error, run } = useSubmit(() => {
    changed("Lead added.");
    onClose();
  });
  return (
    <Modal title="Add a lead" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!name.trim()) throw new LocalError("Add their name.");
            if (!email.trim() && !phone.trim()) throw new LocalError("Add an email or a phone number.");
            if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) throw new LocalError("That email address doesn't look right.");
            if (phone.trim() && !/^[0-9+().\-\s]{7,40}$/.test(phone.trim())) throw new LocalError("Enter the phone number with digits, like (575) 555-0100.");
            await commsApi.addLead(listingId, { name: name.trim(), email: orNull(email), phone: orNull(phone), message: orNull(notes) });
          });
        }}
      >
        <Field label="Name">
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="mgr-form__row">
          <Field label="Email">
            <input type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Phone">
            <input value={phone} maxLength={40} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Called about parking; wants to see it Saturday." />
        </Field>
        <ErrorLine error={error} />
        <div className="mgr-modal__actions">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy}>
            {busy ? "Saving…" : "Add lead"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
