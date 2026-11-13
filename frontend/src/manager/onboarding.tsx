// Onboarding: a step-by-step "Set up a property" flow (property → units →
// residents & leases → review), and the getting-started checklist on the
// Dashboard. The wizard uses the same endpoints as the single dialogs; it
// saves nothing until the last step, then creates each piece in order and
// shows what worked.
import { useMemo, useState } from "react";
import { managerApi, type DashboardData, type NewPerson } from "./api";
import { financeApi } from "./finance-api";
import { Empty, Field, Loading, isoDate, money, todayIso, useLoad, useManager } from "./ui";

/* ------------------------------------------------------------------ *
 * Getting started (Dashboard)
 * ------------------------------------------------------------------ */

let dismissed = false;

export function GettingStarted({ data }: { data: DashboardData }) {
  const { go, can } = useManager();
  const [hidden, setHidden] = useState(dismissed);
  const money30 = useLoad(() => financeApi.overview("this-month"));
  const expiring = useLoad(() => financeApi.expiring(90));
  if (hidden || !can("users:provision")) return null;

  const notSignedUp = data.updates.filter((u) => u.kind === "not_signed_up").length;
  const unnotified = (expiring.data ?? []).filter((l) => !l.lastNotice).length;
  const steps: Array<{ title: string; detail: string; done: boolean; action: string; run: () => void }> = [
    { title: "Add a property", detail: "Name and address of a building you manage.", done: data.properties > 0, action: "Set up a property", run: () => go({ name: "setup" }) },
    { title: "Add its units", detail: "Every apartment or space you rent out.", done: data.units > 0, action: "Add units", run: () => go({ name: "setup" }) },
    { title: "Put residents on leases", detail: "Rent, dates and who lives there. Rent is billed every month automatically.", done: data.occupied > 0, action: "Lease a unit", run: () => go({ name: "rent-roll", filter: "vacant" }) },
    {
      title: "Get residents signed up",
      detail: notSignedUp ? `${notSignedUp} resident${notSignedUp === 1 ? " has" : "s have"} not signed up. Send them their sign-up link.` : "Residents pay and message you from their own portal.",
      done: data.occupied > 0 && notSignedUp === 0,
      action: "Open Tenants",
      run: () => go({ name: "tenants" }),
    },
    {
      title: "Log this month's expenses",
      detail: "Repairs, utilities, insurance and taxes, so Profit & Loss is complete.",
      done: (money30.data?.expenses.length ?? 0) > 0,
      action: "Open Finance",
      run: () => go({ name: "finance", period: "this-month" }),
    },
    {
      title: "Reach out about renewals",
      detail: unnotified ? `${unnotified} lease${unnotified === 1 ? " ends" : "s end"} within 90 days with no renewal notice yet.` : "Leases ending in the next 90 days have all been contacted.",
      done: expiring.data !== null && unnotified === 0,
      action: "Open Renewals",
      run: () => go({ name: "renewals", days: 90 }),
    },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const next = steps.find((s) => !s.done);

  return (
    <section className="mgr-card mgr-start" aria-labelledby="mgr-start">
      <div className="mgr-card__head">
        <div>
          <h2 className="mgr-h2" id="mgr-start">Getting started</h2>
          <p className="mgr-muted">
            {done} of {steps.length} done{next ? ` · next: ${next.title.toLowerCase()}` : ""}
          </p>
        </div>
        <button
          type="button"
          className="mgr-btn mgr-btn--ghost mgr-btn--small"
          onClick={() => {
            dismissed = true;
            setHidden(true);
          }}
        >
          Hide for now
        </button>
      </div>
      <div className="mgr-progress" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-label="Setup progress">
        <span style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="mgr-start__list">
        {steps.map((s) => (
          <li key={s.title} className={`mgr-start__item${s.done ? " mgr-start__item--done" : ""}${s === next ? " mgr-start__item--next" : ""}`}>
            <span className="mgr-start__check" aria-hidden="true">
              {s.done ? "✓" : ""}
            </span>
            <div>
              <strong>{s.title}</strong>
              <span className="mgr-muted">{s.detail}</span>
            </div>
            {!s.done && (
              <button type="button" className={`mgr-btn ${s === next ? "mgr-btn--primary" : "mgr-btn--secondary"} mgr-btn--small`} onClick={s.run}>
                {s.action}
              </button>
            )}
            {s.done && <span className="mgr-sr">Done</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Set up a property (wizard)
 * ------------------------------------------------------------------ */

interface UnitPlan {
  unitNum: string;
  leased: boolean;
  rent: string;
  start: string;
  end: string;
  people: NewPerson[];
}

type Step = 0 | 1 | 2 | 3;
const STEPS = ["Property", "Units", "Residents & leases", "Review"];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function blankUnit(unitNum: string, rent: string): UnitPlan {
  return { unitNum, leased: false, rent, start: todayIso(), end: "", people: [{ name: "", email: "", phone: "" }] };
}

function rentOk(v: string) {
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 && n <= 100_000;
}

interface Outcome {
  label: string;
  ok: boolean;
  detail?: string;
}

export function SetupPage() {
  const { go, changed, can } = useManager();
  const properties = useLoad(() => managerApi.properties());
  const [step, setStep] = useState<Step>(0);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [existingId, setExistingId] = useState("");
  const existingUnits = useLoad(() => (existingId ? managerApi.units(Number(existingId)) : Promise.resolve([])), [existingId]);

  // Units: generate a run of numbers, or type them.
  const [from, setFrom] = useState("101");
  const [count, setCount] = useState("6");
  const [typed, setTyped] = useState("");
  const [defaultRent, setDefaultRent] = useState("");
  const [units, setUnits] = useState<UnitPlan[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [createdPropertyId, setCreatedPropertyId] = useState<number | null>(null);

  const taken = useMemo(() => new Set((existingUnits.data ?? []).map((u) => u.unitNum.toLowerCase())), [existingUnits.data]);

  if (!can("users:provision")) return <Empty>Your role cannot add properties.</Empty>;
  if (!properties.data) return <Loading error={properties.error} />;

  const propertyName = mode === "new" ? name.trim() : properties.data.find((p) => String(p.id) === existingId)?.name ?? "";

  function addUnits(nums: string[]) {
    const have = new Set(units.map((u) => u.unitNum.toLowerCase()));
    const fresh = nums.map((n) => n.trim()).filter((n) => n && n.length <= 20 && !have.has(n.toLowerCase()) && !taken.has(n.toLowerCase()));
    const unique = [...new Map(fresh.map((n) => [n.toLowerCase(), n])).values()];
    setUnits([...units, ...unique.map((n) => blankUnit(n, defaultRent))]);
  }
  function generate() {
    const n = Math.min(200, Math.max(1, Number(count) || 0));
    const m = from.trim().match(/^(.*?)(\d+)$/);
    if (!m) {
      setProblem("Start from a number, like 101 or A1.");
      return;
    }
    const [, prefix, digits] = m;
    const start = Number(digits);
    const width = digits!.length;
    setProblem(null);
    addUnits(Array.from({ length: n }, (_, i) => `${prefix}${String(start + i).padStart(width, "0")}`));
  }
  const setUnit = (i: number, patch: Partial<UnitPlan>) => setUnits(units.map((u, j) => (i === j ? { ...u, ...patch } : u)));

  function check(target: Step): string | null {
    if (target >= 1) {
      if (mode === "new" && (!name.trim() || !address.trim())) return "Give the property a name and an address.";
      if (mode === "new" && properties.data!.some((p) => p.name.toLowerCase() === name.trim().toLowerCase())) return "You already have a property with that name. Pick “Add to a property I have” instead.";
      if (mode === "existing" && !existingId) return "Pick the property to add units to.";
    }
    if (target >= 2 && units.length === 0) return "Add at least one unit.";
    if (target >= 3) {
      for (const u of units.filter((x) => x.leased)) {
        if (!rentOk(u.rent)) return `Unit ${u.unitNum}: enter the monthly rent.`;
        if (!u.start) return `Unit ${u.unitNum}: enter the lease start date.`;
        if (u.end && u.end <= u.start) return `Unit ${u.unitNum}: the end date must be after the start date.`;
        const filled = u.people.filter((p) => p.name.trim() || p.email.trim() || p.phone.trim());
        if (filled.length === 0) return `Unit ${u.unitNum}: add at least one resident, or mark it vacant.`;
        if (filled.some((p) => !p.name.trim() || !EMAIL.test(p.email.trim()))) return `Unit ${u.unitNum}: each resident needs a name and a valid email.`;
      }
      const emails = units.filter((u) => u.leased).flatMap((u) => u.people.map((p) => p.email.trim().toLowerCase()).filter(Boolean));
      const dup = emails.find((e, i) => emails.indexOf(e) !== i);
      if (dup) return `${dup} is on two leases. Each resident can be on one lease here.`;
    }
    return null;
  }
  function moveTo(target: Step) {
    const p = target > step ? check(target) : null;
    setProblem(p);
    if (!p) {
      setStep(target);
      window.scrollTo(0, 0);
    }
  }

  async function finish() {
    const p = check(3);
    if (p) {
      setProblem(p);
      return;
    }
    setRunning(true);
    const log: Outcome[] = [];
    const push = (o: Outcome) => {
      log.push(o);
      setOutcomes([...log]);
    };
    try {
      let propertyId = Number(existingId);
      if (mode === "new") {
        propertyId = (await managerApi.saveProperty(null, { name: name.trim(), address: address.trim() })).id;
        push({ label: `Property “${name.trim()}”`, ok: true });
      }
      setCreatedPropertyId(propertyId);
      for (const u of units) {
        let unitId: number;
        try {
          unitId = (await managerApi.saveUnit(null, { propertyId, unitNum: u.unitNum })).id;
          push({ label: `Unit ${u.unitNum}`, ok: true });
        } catch (e) {
          push({ label: `Unit ${u.unitNum}`, ok: false, detail: (e as { code?: string }).code === "VALIDATION_ERROR" ? "That unit number is already used." : "Could not be added." });
          continue;
        }
        if (!u.leased) continue;
        const people = u.people.filter((x) => x.name.trim()).map((x) => ({ name: x.name.trim(), email: x.email.trim(), phone: x.phone.trim() }));
        try {
          await managerApi.createLease({
            unitId,
            startDate: u.start,
            endDate: u.end || null,
            monthlyRent: Math.round(Number(u.rent.replace(/[$,\s]/g, "")) * 100) / 100,
            tenantIds: [],
            newTenants: people,
          });
          push({ label: `Lease for Unit ${u.unitNum} (${people.map((x) => x.name).join(", ")})`, ok: true });
        } catch (e) {
          const code = (e as { code?: string }).code;
          push({ label: `Lease for Unit ${u.unitNum}`, ok: false, detail: code === "EMAIL_IN_USE" ? "A resident's email is already in use. Add the lease from the unit with “New lease” and pick them from the list." : "Could not be created. Add it from the unit with “New lease”." });
        }
      }
    } catch {
      push({ label: `Property “${name.trim()}”`, ok: false, detail: "Could not be created. Nothing else was added." });
    } finally {
      setRunning(false);
      changed();
    }
  }

  const leased = units.filter((u) => u.leased);
  const monthly = leased.reduce((s, u) => s + (rentOk(u.rent) ? Number(u.rent.replace(/[$,\s]/g, "")) : 0), 0);

  // Finished: what was created, and where to go next.
  if (outcomes && !running) {
    const failed = outcomes.filter((o) => !o.ok);
    return (
      <>
        <header className="mgr-page-header">
          <div>
            <h1 className="mgr-h1">{failed.length ? "Set up, with a few things to finish" : "Property set up"}</h1>
            <p className="mgr-subtitle">{propertyName}</p>
          </div>
        </header>
        <section className="mgr-card">
          <ul className="mgr-outcomes">
            {outcomes.map((o, i) => (
              <li key={i} className={o.ok ? "mgr-outcome--ok" : "mgr-outcome--fail"}>
                <span aria-hidden="true">{o.ok ? "✓" : "!"}</span> {o.label}
                {o.detail && <span className="mgr-muted"> — {o.detail}</span>}
              </li>
            ))}
          </ul>
          <h2 className="mgr-h2">Next steps</h2>
          <ol className="mgr-next">
            {leased.length > 0 && <li>Send new residents their sign-up link from <strong>Tenants</strong> (Copy sign-up link), so they can pay and message you.</li>}
            {leased.length > 0 && <li>If anyone already owes from before, add it on their lease with <strong>Add charge</strong>; record payments you already received with <strong>Record a payment</strong>.</li>}
            <li>Log the building's regular costs (utilities, insurance, taxes) under <strong>Finance → Add expense</strong>, so Profit &amp; Loss is right from month one.</li>
          </ol>
          <div className="mgr-row-actions">
            {createdPropertyId ? (
              <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => go({ name: "property", id: createdPropertyId })}>
                Open the property
              </button>
            ) : null}
            {leased.length > 0 && (
              <button type="button" className="mgr-btn mgr-btn--secondary" onClick={() => go({ name: "tenants" })}>
                Send sign-up links
              </button>
            )}
            <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => go({ name: "dashboard" })}>
              Back to the dashboard
            </button>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <header className="mgr-page-header">
        <div>
          <h1 className="mgr-h1">Set up a property</h1>
          <p className="mgr-subtitle">Four short steps. Nothing is saved until you finish, and you can go back to any step.</p>
        </div>
        <div className="mgr-page-actions">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => go({ name: "properties" })}>
            Cancel
          </button>
        </div>
      </header>
      <ol className="mgr-stepper" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className={`mgr-stepper__step${i === step ? " mgr-stepper__step--current" : ""}${i < step ? " mgr-stepper__step--done" : ""}`} aria-current={i === step ? "step" : undefined}>
            <button type="button" onClick={() => moveTo(i as Step)} disabled={running}>
              <span className="mgr-stepper__num">{i < step ? "✓" : i + 1}</span>
              <span className="mgr-stepper__label">{label}</span>
            </button>
          </li>
        ))}
      </ol>

      <section className="mgr-card mgr-wizard">
        {step === 0 && (
          <>
            <h2 className="mgr-h2">Which property?</h2>
            <div className="mgr-choice" role="radiogroup" aria-label="New or existing property">
              <label className={`mgr-choice__opt${mode === "new" ? " mgr-choice__opt--on" : ""}`}>
                <input type="radio" name="mode" checked={mode === "new"} onChange={() => setMode("new")} />
                <strong>A new property</strong>
                <span className="mgr-muted">A building that is not in the portal yet.</span>
              </label>
              <label className={`mgr-choice__opt${mode === "existing" ? " mgr-choice__opt--on" : ""}`}>
                <input type="radio" name="mode" checked={mode === "existing"} onChange={() => setMode("existing")} disabled={properties.data.length === 0} />
                <strong>Add to a property I have</strong>
                <span className="mgr-muted">{properties.data.length ? "More units for an existing building." : "You have no properties yet."}</span>
              </label>
            </div>
            {mode === "new" ? (
              <div className="mgr-form">
                <Field label="Property name">
                  <input value={name} maxLength={100} placeholder="Woodcrest Apartments" onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Street address" hint="Residents see this on their portal.">
                  <input value={address} maxLength={200} placeholder="2400 Woodcrest Dr, Las Cruces, NM 88011" onChange={(e) => setAddress(e.target.value)} />
                </Field>
              </div>
            ) : (
              <div className="mgr-form">
                <Field label="Property">
                  <select value={existingId} onChange={(e) => setExistingId(e.target.value)}>
                    <option value="">Choose…</option>
                    {properties.data.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.units} units)
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <h2 className="mgr-h2">Units at {propertyName}</h2>
            <p className="mgr-muted">Number a run of units in one go, or type them. You can mix both and remove any you don't need.</p>
            <div className="mgr-wizard__tools">
              <div className="mgr-form__row">
                <Field label="First unit number">
                  <input value={from} maxLength={20} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label="How many">
                  <input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} />
                </Field>
                <div className="mgr-field mgr-field--button">
                  <button type="button" className="mgr-btn mgr-btn--secondary" onClick={generate}>
                    Add {Math.min(200, Number(count) || 0) || ""} units
                  </button>
                </div>
              </div>
              <div className="mgr-form__row">
                <Field label="Or type unit numbers" hint="Separated by commas or spaces: A1, A2, B1">
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addUnits(typed.split(/[\s,]+/));
                      setTyped("");
                    }
                  }} />
                </Field>
                <div className="mgr-field mgr-field--button">
                  <button type="button" className="mgr-btn mgr-btn--secondary" onClick={() => {
                    addUnits(typed.split(/[\s,]+/));
                    setTyped("");
                  }}>
                    Add
                  </button>
                </div>
              </div>
              <Field label="Usual monthly rent (optional)" hint="Fills in the rent for units you lease in the next step; you can change each one.">
                <input inputMode="decimal" placeholder="950" value={defaultRent} onChange={(e) => {
                  const v = e.target.value;
                  setUnits(units.map((u) => (u.rent === defaultRent ? { ...u, rent: v } : u)));
                  setDefaultRent(v);
                }} />
              </Field>
            </div>
            {taken.size > 0 && <p className="mgr-field__hint">Already at this property: {[...(existingUnits.data ?? [])].map((u) => u.unitNum).join(", ")}. Those numbers are skipped.</p>}
            {units.length === 0 ? (
              <Empty>No units yet.</Empty>
            ) : (
              <>
                <p>
                  <strong>{units.length}</strong> unit{units.length === 1 ? "" : "s"} to add
                  <button type="button" className="mgr-btn mgr-btn--link" onClick={() => setUnits([])}>
                    Clear all
                  </button>
                </p>
                <ul className="mgr-chips">
                  {units.map((u, i) => (
                    <li key={u.unitNum} className="mgr-chip">
                      {u.unitNum}
                      <button type="button" aria-label={`Remove unit ${u.unitNum}`} onClick={() => setUnits(units.filter((_, j) => j !== i))}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="mgr-h2">Who lives where?</h2>
            <p className="mgr-muted">Mark the units that are rented and add the residents. Leave the rest vacant; you can lease them any time from the Rent Roll.</p>
            <div className="mgr-row-actions">
              <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => setUnits(units.map((u) => ({ ...u, leased: true })))}>
                Mark all rented
              </button>
              <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => setUnits(units.map((u) => ({ ...u, leased: false })))}>
                Mark all vacant
              </button>
              <span className="mgr-muted">
                {leased.length} rented · {units.length - leased.length} vacant
              </span>
            </div>
            <ul className="mgr-plan">
              {units.map((u, i) => (
                <li key={u.unitNum} className={`mgr-plan__unit${u.leased ? " mgr-plan__unit--leased" : ""}`}>
                  <div className="mgr-plan__head">
                    <strong>Unit {u.unitNum}</strong>
                    <div className="mgr-seg" role="group" aria-label={`Unit ${u.unitNum} status`}>
                      <button type="button" aria-pressed={!u.leased} className={!u.leased ? "mgr-seg--on" : undefined} onClick={() => setUnit(i, { leased: false })}>
                        Vacant
                      </button>
                      <button type="button" aria-pressed={u.leased} className={u.leased ? "mgr-seg--on" : undefined} onClick={() => setUnit(i, { leased: true })}>
                        Rented
                      </button>
                    </div>
                  </div>
                  {u.leased && (
                    <div className="mgr-plan__body">
                      <div className="mgr-form__row">
                        <Field label="Monthly rent">
                          <input inputMode="decimal" placeholder="950.00" value={u.rent} onChange={(e) => setUnit(i, { rent: e.target.value })} />
                        </Field>
                        <Field label="Lease start">
                          <input type="date" value={u.start} onChange={(e) => setUnit(i, { start: e.target.value })} />
                        </Field>
                        <Field label="Lease end" hint="Blank = month-to-month">
                          <input type="date" value={u.end} onChange={(e) => setUnit(i, { end: e.target.value })} />
                        </Field>
                      </div>
                      {u.people.map((p, k) => (
                        <div className="mgr-people__row" key={k}>
                          <input aria-label={`Unit ${u.unitNum} resident ${k + 1} name`} placeholder="Full name" value={p.name} onChange={(e) => setUnit(i, { people: u.people.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })} />
                          <input aria-label={`Unit ${u.unitNum} resident ${k + 1} email`} type="email" placeholder="Email" value={p.email} onChange={(e) => setUnit(i, { people: u.people.map((x, j) => (j === k ? { ...x, email: e.target.value } : x)) })} />
                          <input aria-label={`Unit ${u.unitNum} resident ${k + 1} phone`} placeholder="Phone (optional)" value={p.phone} onChange={(e) => setUnit(i, { people: u.people.map((x, j) => (j === k ? { ...x, phone: e.target.value } : x)) })} />
                          {u.people.length > 1 && (
                            <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => setUnit(i, { people: u.people.filter((_, j) => j !== k) })}>
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                      <button type="button" className="mgr-btn mgr-btn--link" onClick={() => setUnit(i, { people: [...u.people, { name: "", email: "", phone: "" }] })}>
                        + Another resident on this lease
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="mgr-h2">Review</h2>
            <div className="mgr-kpis">
              <div className="mgr-kpi">
                <span className="mgr-kpi__label">Property</span>
                <span className="mgr-kpi__value mgr-kpi__value--text">{propertyName}</span>
                <span className="mgr-kpi__note">{mode === "new" ? address : "Existing property"}</span>
              </div>
              <div className="mgr-kpi">
                <span className="mgr-kpi__label">Units</span>
                <span className="mgr-kpi__value">{units.length}</span>
                <span className="mgr-kpi__note">
                  {leased.length} rented · {units.length - leased.length} vacant
                </span>
              </div>
              <div className="mgr-kpi">
                <span className="mgr-kpi__label">Monthly rent</span>
                <span className="mgr-kpi__value">{money(monthly, false)}</span>
                <span className="mgr-kpi__note">Billed on the 1st, starting with each lease</span>
              </div>
              <div className="mgr-kpi">
                <span className="mgr-kpi__label">New residents</span>
                <span className="mgr-kpi__value">{leased.reduce((s, u) => s + u.people.filter((p) => p.name.trim()).length, 0)}</span>
                <span className="mgr-kpi__note">Each gets a sign-up link</span>
              </div>
            </div>
            <div className="mgr-table-wrap">
              <table className="mgr-table">
                <thead>
                  <tr>
                    <th scope="col">Unit</th>
                    <th scope="col">Status</th>
                    <th scope="col">Residents</th>
                    <th scope="col" className="mgr-num">Rent</th>
                    <th scope="col">Lease</th>
                  </tr>
                </thead>
                <tbody>
                  {units.map((u) => (
                    <tr key={u.unitNum}>
                      <th scope="row">{u.unitNum}</th>
                      <td>{u.leased ? <span className="mgr-pill mgr-pill--current">Rented</span> : <span className="mgr-pill mgr-pill--vacant">Vacant</span>}</td>
                      <td>{u.leased ? u.people.filter((p) => p.name.trim()).map((p) => p.name.trim()).join(", ") : "—"}</td>
                      <td className="mgr-num">{u.leased ? money(Number(u.rent.replace(/[$,\s]/g, "")) || 0) : "—"}</td>
                      <td className="mgr-muted">{u.leased ? `${isoDate(u.start)} – ${u.end ? isoDate(u.end) : "month to month"}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {running && outcomes && (
              <p className="mgr-loading" aria-busy="true">
                Creating… {outcomes.length} done
              </p>
            )}
          </>
        )}

        {problem && (
          <p className="mgr-alert mgr-alert--error" role="alert">
            {problem}
          </p>
        )}
        <div className="mgr-wizard__nav">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => moveTo((step - 1) as Step)} disabled={step === 0 || running}>
            ← Back
          </button>
          {step < 3 ? (
            <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => moveTo((step + 1) as Step)}>
              Next: {STEPS[step + 1]} →
            </button>
          ) : (
            <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => void finish()} disabled={running}>
              {running ? "Creating…" : `Create ${mode === "new" ? "property, " : ""}${units.length} unit${units.length === 1 ? "" : "s"}${leased.length ? ` and ${leased.length} lease${leased.length === 1 ? "" : "s"}` : ""}`}
            </button>
          )}
        </div>
      </section>
    </>
  );
}
