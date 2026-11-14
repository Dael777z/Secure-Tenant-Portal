// Portfolios, property and tenant details, Compliance and Reports (009).
import { useState, type ChangeEvent, type FormEvent } from "react";
import { managerMessage } from "./api";
import {
  INSURANCE_STATUSES, INSURANCE_TEXT, TIME_ZONES, officeApi,
  type ComplianceInput, type ComplianceSettings, type Portfolio, type PropertyDetails, type ReportInfo, type TenantDetails,
} from "./additions-api";
import { Empty, Field, Kpi, Loading, LocalError, Modal, PageHeader, money, timeAgo, todayIso, useLoad, useManager, useSubmit } from "./ui";

const pct = (n: number) => `${Math.round(n * 100)}%`;
/** Blank → null, else trimmed. */
const orNull = (s: string) => (s.trim() ? s.trim() : null);

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="mgr-alert mgr-alert--error" role="alert">{error}</p> : null;
}

/* ------------------------------------------------------------------ *
 * Portfolios: properties grouped by the LLC or owner that holds them
 * ------------------------------------------------------------------ */

export function PortfoliosPage() {
  const { can, open, go, changed } = useManager();
  const { data, error } = useLoad(() => officeApi.portfolios());
  const [editing, setEditing] = useState<Portfolio | "new" | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const canEdit = can("users:provision");

  async function move(propertyId: number, portfolioId: number | null, name: string) {
    setMoving(propertyId);
    setFailed(null);
    try {
      const d = await officeApi.propertyDetails(propertyId);
      await officeApi.savePropertyDetails(propertyId, { portfolioId, city: d.city, state: d.state, zip: d.zip, timeZone: d.timeZone, notes: d.notes });
      changed(portfolioId === null ? `${name} removed from its portfolio.` : `${name} moved.`);
    } catch (e) {
      setFailed(managerMessage(e));
    } finally {
      setMoving(null);
    }
  }

  const portfolios = data?.portfolios ?? [];
  const totals = portfolios.reduce((t, p) => ({ units: t.units + p.units, occupied: t.occupied + p.occupied, rent: t.rent + p.monthlyRent }), { units: 0, occupied: 0, rent: 0 });
  const picker = (propertyId: number, current: number | null, name: string) =>
    canEdit && (
      <select aria-label={`Portfolio for ${name}`} value={current ?? ""} disabled={moving === propertyId} onChange={(e) => void move(propertyId, e.target.value ? Number(e.target.value) : null, name)}>
        <option value="">Not in a portfolio</option>
        {portfolios.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    );
  const propertyLink = (p: { id: number; name: string }) => (
    <a
      href={`#/properties/${p.id}`}
      onClick={(e) => {
        e.preventDefault();
        go({ name: "property", id: p.id });
      }}
    >
      {p.name}
    </a>
  );

  return (
    <>
      <PageHeader
        title="Portfolios"
        subtitle="Group properties by the LLC or owner that holds them. Totals come from current leases; reports can be filtered the same way."
        actions={
          canEdit && (
            <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => setEditing("new")}>
              + New portfolio
            </button>
          )
        }
      />
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          <div className="mgr-kpis">
            <Kpi label="Portfolios" value={String(portfolios.length)} />
            <Kpi label="Units in portfolios" value={String(totals.units)} note={totals.units ? `${pct(totals.occupied / totals.units)} occupied` : undefined} />
            <Kpi label="Monthly rent" value={money(totals.rent, false)} note="From active leases" />
            <Kpi label="Not in a portfolio" value={String(data.unassigned.length)} note={data.unassigned.length === 1 ? "property" : "properties"} tone={data.unassigned.length ? "warn" : undefined} />
          </div>
          <ErrorLine error={failed} />
          {portfolios.length === 0 && <Empty>No portfolios yet. Create one per LLC or owner, then move its properties into it.</Empty>}
          <div className="mgr-portfolios">
            {portfolios.map((f) => (
              <section key={f.id} className="mgr-card mgr-portfolio" aria-labelledby={`portfolio-${f.id}`}>
                <div className="mgr-card__head">
                  <div>
                    <h2 className="mgr-h2" id={`portfolio-${f.id}`}>
                      {f.name}
                    </h2>
                    <div className="mgr-muted">{f.entityName ?? "No legal entity recorded"}</div>
                  </div>
                  {canEdit && (
                    <div className="mgr-row-actions">
                      <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => setEditing(f)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="mgr-btn mgr-btn--danger-ghost mgr-btn--small"
                        onClick={() =>
                          open({
                            kind: "confirm",
                            title: "Retire portfolio",
                            body: `Retire ${f.name}? Its ${f.propertyCount} propert${f.propertyCount === 1 ? "y stays" : "ies stay"} in the portal, just not in a portfolio. The name can be used again.`,
                            confirmLabel: "Retire",
                            run: () => officeApi.retirePortfolio(f.id),
                            done: `${f.name} retired.`,
                          })
                        }
                      >
                        Retire
                      </button>
                    </div>
                  )}
                </div>
                <dl className="mgr-portfolio__stats">
                  <div>
                    <dt>Units</dt>
                    <dd>{f.units}</dd>
                  </div>
                  <div>
                    <dt>Occupied</dt>
                    <dd>{f.units ? pct(f.occupancy) : "—"}</dd>
                  </div>
                  <div>
                    <dt>Monthly rent</dt>
                    <dd>{money(f.monthlyRent, false)}</dd>
                  </div>
                  <div>
                    <dt>Outstanding</dt>
                    <dd className={f.outstanding > 0 ? "mgr-text-warn" : undefined}>{money(f.outstanding, false)}</dd>
                  </div>
                </dl>
                {f.notes && <p className="mgr-portfolio__notes">{f.notes}</p>}
                {f.properties.length === 0 ? (
                  <p className="mgr-muted">No properties yet. Move one in from “Not in a portfolio” below, or from a property's details.</p>
                ) : (
                  <ul className="mgr-portfolio__list">
                    {f.properties.map((p) => (
                      <li key={p.id}>
                        {propertyLink(p)}
                        <span className="mgr-muted">{p.address}</span>
                        {picker(p.id, f.id, p.name)}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
          {data.unassigned.length > 0 && (
            <section className="mgr-card" aria-labelledby="unassigned">
              <h2 className="mgr-h2" id="unassigned">
                Not in a portfolio
              </h2>
              <ul className="mgr-portfolio__list">
                {data.unassigned.map((p) => (
                  <li key={p.id}>
                    {propertyLink(p)}
                    <span className="mgr-muted">{p.address}</span>
                    {portfolios.length > 0 && picker(p.id, null, p.name)}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {editing && <PortfolioDialog portfolio={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function PortfolioDialog({ portfolio, onClose }: { portfolio: Portfolio | null; onClose: () => void }) {
  const { changed } = useManager();
  const [name, setName] = useState(portfolio?.name ?? "");
  const [entity, setEntity] = useState(portfolio?.entityName ?? "");
  const [notes, setNotes] = useState(portfolio?.notes ?? "");
  const { busy, error, run } = useSubmit(() => {
    changed(portfolio ? "Portfolio saved." : "Portfolio created.");
    onClose();
  });
  return (
    <Modal title={portfolio ? `Edit ${portfolio.name}` : "New portfolio"} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!name.trim()) throw new LocalError("Give the portfolio a name.");
            const input = { name: name.trim(), entityName: orNull(entity), notes: orNull(notes) };
            if (portfolio) await officeApi.updatePortfolio(portfolio.id, input);
            else await officeApi.createPortfolio(input);
          });
        }}
      >
        <Field label="Name">
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Hudson County buildings" autoFocus />
        </Field>
        <Field label="Legal entity" hint="The LLC or owner of record, as it appears on leases and tax forms.">
          <input value={entity} maxLength={200} onChange={(e) => setEntity(e.target.value)} placeholder="Example Holdings LLC" />
        </Field>
        <Field label="Notes">
          <textarea rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorLine error={error} />
        <div className="mgr-modal__actions">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy}>
            {busy ? "Saving…" : portfolio ? "Save" : "Create portfolio"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Property details (on the property page)
 * ------------------------------------------------------------------ */

export function PropertyDetailsCard({ propertyId }: { propertyId: number }) {
  const { can } = useManager();
  const { data, error } = useLoad(() => officeApi.propertyDetails(propertyId), [propertyId]);
  const [editing, setEditing] = useState(false);
  const zone = data?.timeZone ? TIME_ZONES.find(([z]) => z === data.timeZone)?.[1] ?? data.timeZone : null;
  return (
    <section className="mgr-card">
      <div className="mgr-card__head">
        <h2 className="mgr-h2">Details</h2>
        {can("users:provision") && data && (
          <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => setEditing(true)}>
            Edit details
          </button>
        )}
      </div>
      {data ? (
        <dl className="mgr-facts">
          <div>
            <dt>Portfolio</dt>
            <dd>{data.portfolioName ? <a href="#/portfolios">{data.portfolioName}</a> : "Not in a portfolio"}</dd>
          </div>
          <div>
            <dt>City, state, ZIP</dt>
            <dd>{[data.city, [data.state, data.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "—"}</dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{zone ?? "Office default"}</dd>
          </div>
          <div className="mgr-facts__wide">
            <dt>Notes</dt>
            <dd className="mgr-pre">{data.notes ?? "—"}</dd>
          </div>
        </dl>
      ) : (
        <Loading error={error} />
      )}
      {editing && data && <PropertyDetailsDialog details={data} onClose={() => setEditing(false)} />}
    </section>
  );
}

function PropertyDetailsDialog({ details, onClose }: { details: PropertyDetails; onClose: () => void }) {
  const { changed } = useManager();
  const portfolios = useLoad(() => officeApi.portfolios());
  const [portfolio, setPortfolio] = useState(details.portfolioId ? String(details.portfolioId) : "");
  const [city, setCity] = useState(details.city ?? "");
  const [state, setState] = useState(details.state ?? "");
  const [zip, setZip] = useState(details.zip ?? "");
  const [zone, setZone] = useState(details.timeZone ?? "");
  const [notes, setNotes] = useState(details.notes ?? "");
  const { busy, error, run } = useSubmit(() => {
    changed("Property details saved.");
    onClose();
  });
  return (
    <Modal title={`Details for ${details.name}`} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (state.trim() && !/^[A-Za-z]{2}$/.test(state.trim())) throw new LocalError("Use the two-letter state code, like NM.");
            if (zip.trim() && !/^\d{5}(-\d{4})?$/.test(zip.trim())) throw new LocalError("Use a 5-digit ZIP code, like 88011.");
            await officeApi.savePropertyDetails(details.propertyId, {
              portfolioId: portfolio ? Number(portfolio) : null,
              city: orNull(city),
              state: orNull(state)?.toUpperCase() ?? null,
              zip: orNull(zip),
              timeZone: zone || null,
              notes: orNull(notes),
            });
          });
        }}
      >
        <Field label="Portfolio">
          <select value={portfolio} onChange={(e) => setPortfolio(e.target.value)} disabled={!portfolios.data}>
            <option value="">Not in a portfolio</option>
            {portfolios.data?.portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="mgr-form__row mgr-form__row--address">
          <Field label="City">
            <input value={city} maxLength={80} onChange={(e) => setCity(e.target.value)} />
          </Field>
          <Field label="State">
            <input value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="NM" />
          </Field>
          <Field label="ZIP">
            <input value={zip} maxLength={10} inputMode="numeric" onChange={(e) => setZip(e.target.value)} />
          </Field>
        </div>
        <Field label="Time zone" hint="For this building's dates. Leave as the office default unless it is in another zone.">
          <select value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">Office default</option>
            {TIME_ZONES.map(([z, label]) => (
              <option key={z} value={z}>
                {label}
              </option>
            ))}
            {zone && !TIME_ZONES.some(([z]) => z === zone) && <option value={zone}>{zone}</option>}
          </select>
        </Field>
        <Field label="Notes" hint="Staff only: access codes, shut-off locations, vendors.">
          <textarea rows={4} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorLine error={error ?? (portfolios.error ? "Portfolios did not load; the portfolio can't be changed right now." : null)} />
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

/* ------------------------------------------------------------------ *
 * Tenant details (on the tenant page)
 * ------------------------------------------------------------------ */

export function TenantDetailsCard({ tenantId, name }: { tenantId: number; name: string }) {
  const { can } = useManager();
  const { data, error } = useLoad(() => officeApi.tenantDetails(tenantId), [tenantId]);
  const [editing, setEditing] = useState(false);
  const lapsed = !!data?.insuranceExpires && data.insuranceExpires < todayIso();
  return (
    <section className="mgr-card">
      <div className="mgr-card__head">
        <h2 className="mgr-h2">Insurance, emergency contact and notes</h2>
        {can("users:provision") && data && (
          <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {data ? (
        <dl className="mgr-facts">
          <div>
            <dt>Renters insurance</dt>
            <dd className={data.insuranceStatus === "expired" || data.insuranceStatus === "required" || lapsed ? "mgr-text-warn" : undefined}>
              {INSURANCE_TEXT[data.insuranceStatus]}
              {data.insuranceExpires && ` · ${lapsed ? "expired" : "expires"} ${data.insuranceExpires}`}
            </dd>
          </div>
          <div>
            <dt>Emergency contact</dt>
            <dd>
              {data.emergencyContactName ?? "—"}
              {data.emergencyContactPhone && (
                <>
                  {" · "}
                  <a href={`tel:${data.emergencyContactPhone.replace(/[^0-9+]/g, "")}`}>{data.emergencyContactPhone}</a>
                </>
              )}
            </dd>
          </div>
          <div className="mgr-facts__wide">
            <dt>Office notes (staff only)</dt>
            <dd className="mgr-pre">{data.notes ?? "—"}</dd>
          </div>
          {data.updatedAt && (
            <div className="mgr-facts__wide mgr-muted">
              Updated {timeAgo(data.updatedAt)}
              {data.updatedBy && ` by ${data.updatedBy}`}
            </div>
          )}
        </dl>
      ) : (
        <Loading error={error} />
      )}
      {editing && data && <TenantDetailsDialog details={data} name={name} onClose={() => setEditing(false)} />}
    </section>
  );
}

function TenantDetailsDialog({ details, name, onClose }: { details: TenantDetails; name: string; onClose: () => void }) {
  const { changed } = useManager();
  const [insurance, setInsurance] = useState(details.insuranceStatus);
  const [expires, setExpires] = useState(details.insuranceExpires ?? "");
  const [contact, setContact] = useState(details.emergencyContactName ?? "");
  const [phone, setPhone] = useState(details.emergencyContactPhone ?? "");
  const [notes, setNotes] = useState(details.notes ?? "");
  const { busy, error, run } = useSubmit(() => {
    changed("Tenant details saved.");
    onClose();
  });
  return (
    <Modal title={`${name}: insurance, emergency contact and notes`} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (phone.trim() && !/^[0-9+().\-\s]{7,40}$/.test(phone.trim())) throw new LocalError("Enter the phone number with digits, like (575) 555-0100.");
            await officeApi.saveTenantDetails(details.tenantId, {
              insuranceStatus: insurance,
              insuranceExpires: expires || null,
              emergencyContactName: orNull(contact),
              emergencyContactPhone: orNull(phone),
              notes: orNull(notes),
            });
          });
        }}
      >
        <div className="mgr-form__row">
          <Field label="Renters insurance">
            <select value={insurance} onChange={(e) => setInsurance(e.target.value as TenantDetails["insuranceStatus"])}>
              {INSURANCE_STATUSES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Policy expires">
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
        </div>
        <div className="mgr-form__row">
          <Field label="Emergency contact">
            <input value={contact} maxLength={120} onChange={(e) => setContact(e.target.value)} />
          </Field>
          <Field label="Their phone">
            <input value={phone} maxLength={40} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <Field label="Office notes" hint="Staff only. The resident never sees these.">
          <textarea rows={4} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
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

/* ------------------------------------------------------------------ *
 * Compliance: the office's own state values, used only to warn
 * ------------------------------------------------------------------ */

type ComplianceForm = Record<
  "state" | "securityDepositMaxMonths" | "lateFeeGraceDays" | "lateFeeMaxPercent" | "noticeToQuitDays" | "rentIncreaseNoticeDays" | "notes" | "references" | "depositInterestRequired" | "leadPaintDisclosureRequired",
  string
>;

const yesNo = (v: boolean | null) => (v === null ? "" : v ? "yes" : "no");
const toForm = (s: ComplianceSettings): ComplianceForm => ({
  state: s.state,
  securityDepositMaxMonths: s.securityDepositMaxMonths?.toString() ?? "",
  lateFeeGraceDays: s.lateFeeGraceDays?.toString() ?? "",
  lateFeeMaxPercent: s.lateFeeMaxPercent?.toString() ?? "",
  noticeToQuitDays: s.noticeToQuitDays?.toString() ?? "",
  rentIncreaseNoticeDays: s.rentIncreaseNoticeDays?.toString() ?? "",
  notes: s.notes ?? "",
  references: s.references ?? "",
  depositInterestRequired: yesNo(s.depositInterestRequired),
  leadPaintDisclosureRequired: yesNo(s.leadPaintDisclosureRequired),
});

function fromForm(f: ComplianceForm): ComplianceInput {
  const num = (value: string, label: string, rule: { min: number; max: number; integer?: boolean; decimals?: number }) => {
    if (!value.trim()) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < rule.min || n > rule.max || (rule.integer && !Number.isInteger(n))) {
      throw new LocalError(`${label}: enter ${rule.integer ? "a whole number" : "a number"} from ${rule.min} to ${rule.max}, or leave it blank.`);
    }
    if (rule.decimals !== undefined && Math.round(n * 10 ** rule.decimals) !== n * 10 ** rule.decimals) throw new LocalError(`${label}: use at most ${rule.decimals} decimal place.`);
    return n;
  };
  const bool = (v: string) => (v === "" ? null : v === "yes");
  if (!/^[A-Za-z]{2}$/.test(f.state.trim())) throw new LocalError("State: use the two-letter code, like NM.");
  return {
    state: f.state.trim().toUpperCase(),
    securityDepositMaxMonths: num(f.securityDepositMaxMonths, "Security deposit limit", { min: 0.1, max: 12, decimals: 1 }),
    lateFeeGraceDays: num(f.lateFeeGraceDays, "Grace period", { integer: true, min: 0, max: 60 }),
    lateFeeMaxPercent: num(f.lateFeeMaxPercent, "Late fee limit", { min: 0, max: 100 }),
    noticeToQuitDays: num(f.noticeToQuitDays, "Notice to quit", { integer: true, min: 0, max: 3650 }),
    rentIncreaseNoticeDays: num(f.rentIncreaseNoticeDays, "Rent increase notice", { integer: true, min: 0, max: 3650 }),
    depositInterestRequired: bool(f.depositInterestRequired),
    leadPaintDisclosureRequired: bool(f.leadPaintDisclosureRequired),
    notes: orNull(f.notes),
    references: orNull(f.references),
  };
}

export function CompliancePage() {
  const { can, changed, go } = useManager();
  const settings = useLoad(() => officeApi.compliance());
  const warnings = useLoad(() => officeApi.warnings());
  const [draft, setDraft] = useState<ComplianceForm | null>(null);
  const canEdit = can("users:provision");
  const { busy, error, run } = useSubmit(() => setDraft(null));
  const saved = settings.data;
  const form = draft ?? (saved ? toForm(saved) : null);
  const set = (key: keyof ComplianceForm) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setDraft({ ...form!, [key]: e.target.value });

  function save(e: FormEvent | React.MouseEvent, confirm: boolean) {
    e.preventDefault();
    void run(async () => {
      await officeApi.saveCompliance(fromForm(form!), confirm);
      changed(confirm ? "Saved and marked as reviewed." : "Compliance settings saved.");
    });
  }

  const numberField = (key: keyof ComplianceForm, label: string, hint: string, unit: string) => (
    <Field label={label} hint={hint}>
      <span className="mgr-input-unit">
        <input value={form![key]} inputMode="decimal" disabled={!canEdit} onChange={set(key)} placeholder="Not set" />
        <span>{unit}</span>
      </span>
    </Field>
  );
  const yesNoField = (key: keyof ComplianceForm, label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <select value={form![key]} disabled={!canEdit} onChange={set(key)}>
        <option value="">Not set</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </Field>
  );

  return (
    <>
      <PageHeader
        title="Compliance"
        subtitle="Your attorney's values for the rules that vary by state and city. The portal uses them only to warn you; it never blocks a lease, fee or notice."
      />
      <div className="mgr-alert mgr-compliance__notice" role="note">
        <strong>The portal ships with no legal rules.</strong> Every value below starts blank. Enter only what your attorney has confirmed for{" "}
        {saved?.state ?? "your state"} and each municipality you rent in (local rent-control and registration ordinances can be stricter than state law),
        and note the citations. Leaving a value blank turns its check off.
      </div>
      {!saved || !form ? (
        <Loading error={settings.error} />
      ) : (
        <div className="mgr-columns mgr-columns--request">
          <form className="mgr-card mgr-form" onSubmit={(e) => save(e, false)}>
            <div className="mgr-card__head">
              <h2 className="mgr-h2">Values</h2>
              <span className={saved.confirmedAt ? "mgr-pill mgr-pill--current" : "mgr-pill mgr-pill--due"}>
                {saved.confirmedAt ? `Reviewed ${new Date(saved.confirmedAt).toLocaleDateString("en-US")}${saved.confirmedBy ? ` by ${saved.confirmedBy}` : ""}` : "Not reviewed"}
              </span>
            </div>
            <Field label="State">
              <input value={form.state} maxLength={2} disabled={!canEdit} onChange={(e) => setDraft({ ...form, state: e.target.value.toUpperCase() })} />
            </Field>
            <div className="mgr-form__row">
              {numberField("securityDepositMaxMonths", "Security deposit limit", "Most a deposit may be, in months of rent.", "× rent")}
              {yesNoField("depositInterestRequired", "Deposit interest required", "Whether deposits must earn interest for the resident.")}
            </div>
            <div className="mgr-form__row">
              {numberField("lateFeeGraceDays", "Late fee grace period", "Days after the due date before a late fee may be charged.", "days")}
              {numberField("lateFeeMaxPercent", "Late fee limit", "Most late fees may total in a month, as a percent of rent.", "% of rent")}
            </div>
            <div className="mgr-form__row">
              {numberField("noticeToQuitDays", "Notice to quit", "Days of notice before a tenancy may end.", "days")}
              {numberField("rentIncreaseNoticeDays", "Rent increase notice", "Days of notice before a rent increase.", "days")}
            </div>
            {yesNoField("leadPaintDisclosureRequired", "Lead paint disclosure", "Whether a lead-based paint disclosure goes with each lease (e.g., pre-1978 buildings).")}
            <Field label="Citations" hint="Statutes, ordinances and dates checked. Shown to everyone who opens this page.">
              <textarea rows={3} maxLength={4000} value={form.references} disabled={!canEdit} onChange={set("references")} />
            </Field>
            <Field label="Notes">
              <textarea rows={3} maxLength={4000} value={form.notes} disabled={!canEdit} onChange={set("notes")} />
            </Field>
            <ErrorLine error={error} />
            {canEdit && (
              <div className="mgr-modal__actions">
                {draft && (
                  <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => setDraft(null)} disabled={busy}>
                    Discard changes
                  </button>
                )}
                <button type="submit" className="mgr-btn mgr-btn--secondary" disabled={busy || !draft}>
                  Save
                </button>
                <button type="button" className="mgr-btn mgr-btn--primary" disabled={busy} onClick={(e) => save(e, true)}>
                  {busy ? "Saving…" : "Save and mark reviewed"}
                </button>
              </div>
            )}
            {saved.updatedBy && (
              <p className="mgr-muted">
                Last changed {timeAgo(saved.updatedAt)} by {saved.updatedBy}.
              </p>
            )}
          </form>
          <section className="mgr-card" aria-labelledby="compliance-warnings">
            <h2 className="mgr-h2" id="compliance-warnings">
              Warnings
            </h2>
            {!warnings.data ? (
              <Loading error={warnings.error} />
            ) : warnings.data.length === 0 ? (
              <p className="mgr-muted">
                {[saved.securityDepositMaxMonths, saved.lateFeeGraceDays, saved.lateFeeMaxPercent].every((v) => v === null)
                  ? "Nothing to check yet: enter a deposit or late fee value."
                  : "No current lease or late fee rule is outside these values."}
              </p>
            ) : (
              <ul className="mgr-warnings">
                {warnings.data.map((w, i) => (
                  <li key={i}>
                    <p>{w.message}</p>
                    {w.unitId === null ? (
                      <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "payment-rules", tab: "late-fees" })}>
                        Open late fee rules
                      </button>
                    ) : (
                      <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "unit", id: w.unitId!, tab: w.code === "deposit_above_max" ? "charges" : "overview" })}>
                        Open unit
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mgr-muted mgr-compliance__checks">Checked: security deposits against rent, and each unit's late fee rule against the grace period and limit.</p>
          </section>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Reports: CSV downloads
 * ------------------------------------------------------------------ */

export function ReportsPage() {
  const { data, error } = useLoad(() => officeApi.reports());
  return (
    <>
      <PageHeader title="Reports" subtitle="Download as CSV for Excel, Google Sheets or your accountant. Dates and times are in the office's time zone." />
      {data ? (
        <div className="mgr-reports">
          {data.map((r) => (
            <ReportCard key={r.key} report={r} />
          ))}
        </div>
      ) : (
        <Loading error={error} />
      )}
    </>
  );
}

function ReportCard({ report }: { report: ReportInfo }) {
  const today = todayIso();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [year, setYear] = useState(today.slice(0, 4));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const years = Array.from({ length: 6 }, (_, i) => String(Number(today.slice(0, 4)) - i));
  const ranged = report.filters.includes("from");

  async function download() {
    setFailed(null);
    if (ranged && from > to) return setFailed("The start date is after the end date.");
    setBusy(true);
    try {
      await officeApi.download(report.href, ranged ? { from, to } : report.filters.includes("year") ? { year } : {});
    } catch (e) {
      setFailed(managerMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mgr-card mgr-report" aria-labelledby={`report-${report.key}`}>
      <h2 className="mgr-h2" id={`report-${report.key}`}>
        {report.name}
      </h2>
      <p className="mgr-muted">{report.description}</p>
      <div className="mgr-report__controls">
        {ranged && (
          <>
            <label className="mgr-field mgr-field--inline">
              <span className="mgr-field__label">From</span>
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="mgr-field mgr-field--inline">
              <span className="mgr-field__label">To</span>
              <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
        {report.filters.includes("year") && (
          <label className="mgr-field mgr-field--inline">
            <span className="mgr-field__label">Year</span>
            <select value={year} onChange={(e) => setYear(e.target.value)}>
              {years.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="mgr-btn mgr-btn--primary" disabled={busy} onClick={() => void download()}>
          {busy ? "Preparing…" : "Download CSV"}
        </button>
      </div>
      {failed && <p className="mgr-alert mgr-alert--error" role="alert">{failed}</p>}
    </section>
  );
}
