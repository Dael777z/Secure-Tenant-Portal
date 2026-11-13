// Settings → Team and Settings → Activity (009): everyone with an office
// sign-in, and who changed what. Property managers only.
import { useState } from "react";
import { teamApi, type ActivityEntry, type ActivityFilter, type SignUpLink, type StaffRoleKey, type TeamMember } from "./additions-api";
import { Empty, Field, Loading, LocalError, Modal, PageHeader, timeAgo, useLoad, useManager, useSubmit } from "./ui";

const ROLE_TEXT: Record<StaffRoleKey, string> = { admin: "Property manager", maintenance_staff: "Maintenance" };
const STATUS_TEXT: Record<TeamMember["status"], string> = { active: "Active", invited: "Invited", deactivated: "Deactivated" };

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="mgr-alert mgr-alert--error" role="alert">{error}</p> : null;
}

/** A sign-up link to copy and send (the portal does not email it). */
function LinkBox({ link, note }: { link: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mgr-team-link">
      <p className="mgr-muted">{note}</p>
      <div className="mgr-team-link__row">
        <input readOnly value={link} aria-label="Sign-up link" onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="mgr-btn mgr-btn--secondary"
          onClick={() => {
            navigator.clipboard?.writeText(link).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const { changed } = useManager();
  const [form, setForm] = useState<{ name: string; email: string; role: StaffRoleKey }>({ name: "", email: "", role: "admin" });
  const [made, setMade] = useState<SignUpLink | null>(null);
  const { busy, error, run } = useSubmit(() => changed("Invitation created."));
  return (
    <Modal title="Invite a teammate" onClose={onClose}>
      {made ? (
        <>
          <LinkBox
            link={made.inviteLink}
            note={`Send this link to ${form.name}. It works once and expires ${new Date(made.expiresAt).toLocaleDateString()}. They choose their own password.`}
          />
          <div className="mgr-modal__actions">
            <button type="button" className="mgr-btn mgr-btn--primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form
          className="mgr-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (!form.name.trim()) throw new LocalError("Enter their name.");
              if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) throw new LocalError("Enter a valid email address.");
              setMade(await teamApi.invite({ name: form.name.trim(), email: form.email.trim(), role: form.role }));
            });
          }}
        >
          <Field label="Name">
            <input value={form.name} maxLength={255} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Email" hint="Their sign-in. It can't already belong to a tenant or another teammate.">
            <input type="email" value={form.email} maxLength={254} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Role" hint="Property managers see and change everything. Maintenance staff see only the maintenance queue.">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as StaffRoleKey })}>
              <option value="admin">Property manager</option>
              <option value="maintenance_staff">Maintenance</option>
            </select>
          </Field>
          <ErrorLine error={error} />
          <div className="mgr-modal__actions">
            <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy}>
              {busy ? "Creating…" : "Create invitation"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function EditMemberDialog({ member, onClose }: { member: TeamMember; onClose: () => void }) {
  const { changed } = useManager();
  const [form, setForm] = useState({ name: member.name, role: member.role });
  const { busy, error, run } = useSubmit(() => {
    changed("Teammate updated.");
    onClose();
  });
  return (
    <Modal title={`Edit ${member.name}`} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!form.name.trim()) throw new LocalError("Enter their name.");
            const change: { name?: string; role?: StaffRoleKey } = {};
            if (form.name.trim() !== member.name) change.name = form.name.trim();
            if (form.role !== member.role) change.role = form.role;
            if (Object.keys(change).length) await teamApi.update(member.id, change);
          });
        }}
      >
        <Field label="Name">
          <input value={form.name} maxLength={255} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Role" hint="A role change applies from their next sign-in.">
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as StaffRoleKey })}>
            <option value="admin">Property manager</option>
            <option value="maintenance_staff">Maintenance</option>
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

/** A new sign-up link (not signed up yet), or a sign-in reset (forgot their password). */
function NewLinkDialog({ member, onClose }: { member: TeamMember; onClose: () => void }) {
  const { changed } = useManager();
  const [made, setMade] = useState<SignUpLink | null>(null);
  const { busy, error, run } = useSubmit(() => changed());
  const reset = member.status === "active";
  return (
    <Modal title={reset ? `Reset sign-in for ${member.name}` : `New sign-up link for ${member.name}`} onClose={onClose}>
      {made ? (
        <LinkBox
          link={made.inviteLink}
          note={
            reset
              ? "Their old password and sessions no longer work. Send them this link to choose a new password; it works once."
              : "The previous link no longer works. This one works once."
          }
        />
      ) : reset ? (
        <p className="mgr-muted">For a teammate who forgot their password. Their current password stops working and they are signed out everywhere; the link lets them choose a new one.</p>
      ) : (
        <p className="mgr-muted">Make a new link for {member.email}. Any earlier link stops working.</p>
      )}
      <ErrorLine error={error} />
      <div className="mgr-modal__actions">
        <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
          {made ? "Done" : "Cancel"}
        </button>
        {!made && (
          <button
            type="button"
            className={`mgr-btn ${reset ? "mgr-btn--danger" : "mgr-btn--primary"}`}
            disabled={busy}
            onClick={() => void run(async () => setMade(reset ? await teamApi.resetSignIn(member.id) : await teamApi.reissue(member.id)))}
          >
            {busy ? "Making…" : reset ? "Reset and make link" : "Make new link"}
          </button>
        )}
      </div>
    </Modal>
  );
}

type TeamDialog = { kind: "invite" } | { kind: "edit"; member: TeamMember } | { kind: "link"; member: TeamMember };

export function TeamPage() {
  const { open, changed, user, can } = useManager();
  const { data, error } = useLoad(() => teamApi.team());
  const [dialog, setDialog] = useState<TeamDialog | null>(null);
  const [showFormer, setShowFormer] = useState(false);
  const canEdit = can("users:provision");
  const me = Number(user.user_id.replace(/^admin:/, ""));
  const deactivate = (m: TeamMember) =>
    open({
      kind: "confirm",
      title: `Deactivate ${m.name}?`,
      body: "They are signed out everywhere and can't sign in again. Their history stays on record. You can invite them again later.",
      confirmLabel: "Deactivate",
      run: () => teamApi.deactivate(m.id),
      done: `${m.name} was deactivated.`,
    });
  const shown = data?.filter((m) => showFormer || m.status !== "deactivated") ?? [];
  const former = data?.filter((m) => m.status === "deactivated").length ?? 0;

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Everyone with an office sign-in. Property managers see everything; maintenance staff see the maintenance queue only."
        actions={
          canEdit && (
            <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => setDialog({ kind: "invite" })}>
              + Invite teammate
            </button>
          )
        }
      />
      {!data ? (
        <Loading error={error} />
      ) : shown.length === 0 ? (
        <Empty>No teammates yet. Invite one to share the work.</Empty>
      ) : (
        <section className="mgr-card">
          <div className="mgr-table-wrap">
            <table className="mgr-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last sign-in</th>
                  {canEdit && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={m.id} className={m.status === "deactivated" ? "mgr-team-row--former" : undefined}>
                    <th scope="row">
                      {m.name}
                      {m.id === me && <span className="mgr-muted"> (you)</span>}
                    </th>
                    <td>
                      <a href={`mailto:${m.email}`}>{m.email}</a>
                    </td>
                    <td>
                      <span className={`mgr-pill mgr-team-role mgr-team-role--${m.role}`}>{ROLE_TEXT[m.role]}</span>
                    </td>
                    <td>
                      <span className={`mgr-pill mgr-team-status mgr-team-status--${m.status}`}>{STATUS_TEXT[m.status]}</span>
                      {m.status === "active" && (
                        <span className={`mgr-team-mfa${m.mfaEnabled ? " mgr-team-mfa--on" : ""}`}>{m.mfaEnabled ? "2-step on" : "2-step off"}</span>
                      )}
                    </td>
                    <td>{m.lastLoginAt ? timeAgo(m.lastLoginAt) : "Never"}</td>
                    {canEdit && (
                      <td className="mgr-team-actions">
                        <div className="mgr-team-actions__row">
                          {m.status !== "deactivated" && (
                            <button type="button" className="mgr-btn mgr-btn--link" onClick={() => setDialog({ kind: "edit", member: m })}>
                              Edit
                            </button>
                          )}
                          {m.status === "invited" && (
                            <button type="button" className="mgr-btn mgr-btn--link" onClick={() => setDialog({ kind: "link", member: m })}>
                              New link
                            </button>
                          )}
                          {m.status === "active" && m.id !== me && (
                            <button type="button" className="mgr-btn mgr-btn--link" onClick={() => setDialog({ kind: "link", member: m })}>
                              Reset sign-in
                            </button>
                          )}
                          {m.status !== "deactivated" && m.id !== me && (
                            <button type="button" className="mgr-btn mgr-btn--danger-ghost" onClick={() => deactivate(m)}>
                              Deactivate
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {former > 0 && (
            <button type="button" className="mgr-btn mgr-btn--link" onClick={() => setShowFormer(!showFormer)}>
              {showFormer ? "Hide former teammates" : `Show former teammates (${former})`}
            </button>
          )}
        </section>
      )}
      {dialog?.kind === "invite" && (
        <InviteDialog
          onClose={() => {
            setDialog(null);
            changed();
          }}
        />
      )}
      {dialog?.kind === "edit" && <EditMemberDialog member={dialog.member} onClose={() => setDialog(null)} />}
      {dialog?.kind === "link" && <NewLinkDialog member={dialog.member} onClose={() => setDialog(null)} />}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Activity: the change log and sign-ins (read-only)
 * ------------------------------------------------------------------ */

const RECORDS: Array<[string, string]> = [
  ["", "All records"],
  ["payment", "Payments"],
  ["charge", "Charges"],
  ["lease", "Leases"],
  ["lease_tenants", "Lease residents"],
  ["tenants", "Tenants"],
  ["maintenance_t", "Maintenance"],
  ["expenses", "Expenses"],
  ["admin", "Staff accounts"],
  ["late_fee_rules", "Late fee rules"],
  ["office_settings", "Office settings"],
];
const PERIODS: Array<[string, string]> = [
  ["", "Any time"],
  ["1", "Last 24 hours"],
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
];
const PAGE = 100;
const sinceDays = (days: string) => (days ? new Date(Date.now() - Number(days) * 86_400_000).toISOString() : "");

function EntryDetails({ entry }: { entry: ActivityEntry }) {
  return entry.details ? (
    <details className="mgr-log__details">
      <summary>Details</summary>
      <pre>{JSON.stringify(entry.details, null, 2)}</pre>
    </details>
  ) : null;
}

export function ActivityPage() {
  const [kind, setKind] = useState("");
  const [table, setTable] = useState("");
  const [days, setDays] = useState("30");
  const [limit, setLimit] = useState(PAGE);
  const filter: ActivityFilter = { kind, table: kind === "security" ? "" : table, since: sinceDays(days), limit };
  const { data, error } = useLoad(() => teamApi.activity(filter), [kind, table, days, limit]);
  const pick = (set: (v: string) => void) => (value: string) => {
    set(value);
    setLimit(PAGE);
  };

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Who changed what, and when: every change to the records, plus sign-ins and team changes. Nothing here can be edited or deleted."
        actions={
          <a className="mgr-btn mgr-btn--secondary" href={teamApi.activityCsvUrl(filter)} download>
            Export CSV
          </a>
        }
      />
      <div className="mgr-toolbar">
        <div className="mgr-toolbar__filters" role="group" aria-label="Filter activity">
          <select aria-label="Show" value={kind} onChange={(e) => pick(setKind)(e.target.value)}>
            <option value="">Everything</option>
            <option value="change">Record changes</option>
            <option value="security">Sign-ins and team</option>
          </select>
          <select aria-label="Records" value={table} onChange={(e) => pick(setTable)(e.target.value)} disabled={kind === "security"}>
            {RECORDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select aria-label="When" value={days} onChange={(e) => pick(setDays)(e.target.value)}>
            {PERIODS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : data.length === 0 ? (
        <Empty>Nothing happened in this period.</Empty>
      ) : (
        <section className="mgr-card">
          <ol className="mgr-log">
            {data.map((e, i) => (
              <li
                key={`${e.at}-${i}`}
                className={`mgr-log__item mgr-log__item--${e.kind}${e.action === "login_failed" || e.action === "mfa_failed" ? " mgr-log__item--warn" : ""}`}
              >
                <time dateTime={e.at} className="mgr-log__time">
                  {new Date(e.at).toLocaleString()}
                </time>
                <div className="mgr-log__body">
                  <p className="mgr-log__summary">{e.summary}</p>
                  <p className="mgr-muted">
                    {e.byName ?? e.by ?? "Unknown"}
                    {e.kind === "change" ? ` · ${e.action.toLowerCase()}` : ""}
                  </p>
                  <EntryDetails entry={e} />
                </div>
              </li>
            ))}
          </ol>
          {data.length >= limit && limit < 1000 && (
            <div className="mgr-log-more">
              <button type="button" className="mgr-btn mgr-btn--secondary" onClick={() => setLimit(Math.min(limit + PAGE, 1000))}>
                Show more
              </button>
            </div>
          )}
          {data.length >= 1000 && <p className="mgr-muted">Showing the newest 1,000. Narrow the filters, or export CSV.</p>}
        </section>
      )}
    </>
  );
}
