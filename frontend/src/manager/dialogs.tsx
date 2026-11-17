// Every add/edit form on the manager side, opened as a dialog from the quick
// actions bar or from a screen. Each one closes and refreshes on success.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isNetworkError, managerApi, PAYMENT_METHODS, RECEIPT_ACCEPT, readReceipt, REQUEST_PRIORITIES, REQUEST_TYPES, type NewPerson, type ReceiptUpload, type RequestPriority, type RequestType, type UnitRow } from "./api";
import { ChargeWizard, CreateNewDialog, LateFeeRuleDialog, LeaseDocumentDialog, ReminderRuleDialog } from "./ops";
import { ExpenseDialog, RejectReportDialog, RenewalDialog } from "./finance";
import { Field, LocalError, Modal, money, todayIso, useLoad, useManager, useSubmit, type Dialog } from "./ui";

type Props<K extends Dialog["kind"]> = Extract<Dialog, { kind: K }> & { onClose: () => void };

export function DialogHost({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  switch (dialog.kind) {
    case "lease":
      return <NewLeaseDialog {...dialog} onClose={onClose} />;
    case "property":
      return <PropertyDialog {...dialog} onClose={onClose} />;
    case "unit":
      return <UnitDialog {...dialog} onClose={onClose} />;
    case "payment":
      return <PaymentDialog {...dialog} onClose={onClose} />;
    case "tenant":
      return <InviteTenantDialog {...dialog} onClose={onClose} />;
    case "editTenant":
      return <EditTenantDialog {...dialog} onClose={onClose} />;
    case "maintenance":
      return <MaintenanceDialog {...dialog} onClose={onClose} />;
    case "rent":
      return <RentDialog {...dialog} onClose={onClose} />;
    case "endLease":
      return <EndLeaseDialog {...dialog} onClose={onClose} />;
    case "addResident":
      return <AddResidentDialog {...dialog} onClose={onClose} />;
    case "attachReceipt":
      return <AttachReceiptDialog {...dialog} onClose={onClose} />;
    case "charge":
      return <ChargeWizard {...dialog} onClose={onClose} />;
    case "lateFeeRule":
      return <LateFeeRuleDialog {...dialog} onClose={onClose} />;
    case "reminderRule":
      return <ReminderRuleDialog {...dialog} onClose={onClose} />;
    case "leaseDocument":
      return <LeaseDocumentDialog {...dialog} onClose={onClose} />;
    case "create":
      return <CreateNewDialog {...dialog} onClose={onClose} />;
    case "expense":
      return <ExpenseDialog {...dialog} onClose={onClose} />;
    case "renewal":
      return <RenewalDialog {...dialog} onClose={onClose} />;
    case "rejectReport":
      return <RejectReportDialog {...dialog} onClose={onClose} />;
    case "confirm":
      return <ConfirmDialog {...dialog} onClose={onClose} />;
  }
}

/* ------------------------------------------------------------------ */

function Actions({ busy, label, onClose, danger, loading }: { busy: boolean; label: string; onClose: () => void; danger?: boolean; loading?: boolean }) {
  return (
    <div className="mgr-modal__actions">
      <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
        Cancel
      </button>
      <button type="submit" className={`mgr-btn ${danger ? "mgr-btn--danger" : "mgr-btn--primary"}`} disabled={busy || loading}>
        {busy ? "Saving…" : loading ? "Loading…" : label}
      </button>
    </div>
  );
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="mgr-alert mgr-alert--error" role="alert">
      {error}
    </p>
  ) : null;
}

function parseMoney(value: string, what: string): number {
  const n = Number(value.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 100_000 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new LocalError(`Enter ${what} as a dollar amount, like 950 or 950.00.`);
  }
  return Math.round(n * 100) / 100;
}

function unitLabel(u: Pick<UnitRow, "unitNum" | "propertyName">): string {
  return `Unit ${u.unitNum} - ${u.propertyName}`;
}

/** New residents typed into a form: name + email required, phone optional. */
function PeopleRows({ people, onChange }: { people: NewPerson[]; onChange: (p: NewPerson[]) => void }) {
  const set = (i: number, key: keyof NewPerson, value: string) =>
    onChange(people.map((p, j) => (i === j ? { ...p, [key]: value } : p)));
  return (
    <div className="mgr-people">
      {people.map((p, i) => (
        <div className="mgr-people__row" key={i}>
          <input aria-label={`Resident ${i + 1} name`} placeholder="Full name" value={p.name} onChange={(e) => set(i, "name", e.target.value)} />
          <input aria-label={`Resident ${i + 1} email`} placeholder="Email" type="email" value={p.email} onChange={(e) => set(i, "email", e.target.value)} />
          <input aria-label={`Resident ${i + 1} phone`} placeholder="Phone (optional)" value={p.phone} onChange={(e) => set(i, "phone", e.target.value)} />
          <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" aria-label={`Remove resident ${i + 1}`} onClick={() => onChange(people.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="mgr-btn mgr-btn--link" onClick={() => onChange([...people, { name: "", email: "", phone: "" }])}>
        + Add a new resident
      </button>
    </div>
  );
}

function cleanPeople(people: NewPerson[]): NewPerson[] {
  const filled = people.filter((p) => p.name.trim() || p.email.trim() || p.phone.trim());
  for (const p of filled) {
    if (!p.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email.trim())) {
      throw new LocalError("Each new resident needs a name and a valid email address.");
    }
  }
  return filled.map((p) => ({ name: p.name.trim(), email: p.email.trim(), phone: p.phone.trim() }));
}

/* ------------------------------------------------------------------ *
 * + New lease
 * ------------------------------------------------------------------ */

function NewLeaseDialog({ unitId, onClose }: Props<"lease">) {
  const { changed, go } = useManager();
  const units = useLoad(() => managerApi.units());
  const tenants = useLoad(() => managerApi.tenants());
  const [unit, setUnit] = useState(unitId ? String(unitId) : "");
  const [start, setStart] = useState(todayIso());
  const [end, setEnd] = useState("");
  const [rent, setRent] = useState("");
  const [existing, setExisting] = useState<number[]>([]);
  const [people, setPeople] = useState<NewPerson[]>([{ name: "", email: "", phone: "" }]);
  const createdId = useRef(0);
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Lease created. Send new residents their sign-up link from Tenants.");
    if (createdId.current) go({ name: "lease", id: createdId.current });
  });

  const vacant = (units.data ?? []).filter((u) => u.status === "vacant");
  const free = (tenants.data ?? []).filter((t) => t.leaseId === null);

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(
      async () => {
        if (!unit) throw new LocalError("Choose a vacant unit.");
        const monthlyRent = parseMoney(rent, "the monthly rent");
        if (end && end <= start) throw new LocalError("The end date must be after the start date.");
        const newTenants = cleanPeople(people);
        if (existing.length + newTenants.length === 0) throw new LocalError("Add at least one resident to the lease.");
        createdId.current = (await managerApi.createLease({ unitId: Number(unit), startDate: start, endDate: end || null, monthlyRent, tenantIds: existing, newTenants })).id;
      },
      { EMAIL_IN_USE: "One of the new residents' emails is already in use. Pick them from the list instead." },
    );
  }

  return (
    <Modal title="New lease" onClose={onClose}>
      <form className="mgr-form" onSubmit={submit}>
        <Field label="Unit" hint={vacant.length === 0 && units.data ? "Every unit is leased. Add a unit or end a lease first." : undefined}>
          <select value={unit} onChange={(e) => setUnit(e.target.value)} required>
            <option value="">Choose a vacant unit…</option>
            {vacant.map((u) => (
              <option key={u.id} value={u.id}>
                {unitLabel(u)}
              </option>
            ))}
          </select>
        </Field>
        <div className="mgr-form__row">
          <Field label="Start date">
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
          </Field>
          <Field label="End date" hint="Leave blank for month-to-month.">
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Monthly rent">
            <input inputMode="decimal" placeholder="950.00" value={rent} onChange={(e) => setRent(e.target.value)} required />
          </Field>
        </div>
        <fieldset className="mgr-fieldset">
          <legend>Residents on the lease</legend>
          {free.length > 0 && (
            <div className="mgr-checklist">
              <span className="mgr-field__hint">People already in the system without a lease:</span>
              {free.map((t) => (
                <label key={t.id} className="mgr-check">
                  <input
                    type="checkbox"
                    checked={existing.includes(t.id)}
                    onChange={(e) => setExisting(e.target.checked ? [...existing, t.id] : existing.filter((x) => x !== t.id))}
                  />
                  {t.name} <span className="mgr-muted">{t.email}</span>
                </label>
              ))}
            </div>
          )}
          <PeopleRows people={people} onChange={setPeople} />
          <span className="mgr-field__hint">New residents get an invitation and set their own password when they sign up.</span>
        </fieldset>
        <ErrorText error={error} />
        <Actions busy={busy} loading={!units.data || !tenants.data} label="Create lease" onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * + Add property / edit property
 * ------------------------------------------------------------------ */

function PropertyDialog({ id, name: initialName, address: initialAddress, onClose }: Props<"property">) {
  const { changed, go } = useManager();
  const [name, setName] = useState(initialName ?? "");
  const [address, setAddress] = useState(initialAddress ?? "");
  const savedId = useRef(0);
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed(id ? "Property updated." : "Property added.");
    if (!id && savedId.current) go({ name: "property", id: savedId.current });
  });

  return (
    <Modal title={id ? "Edit property" : "Add property"} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            savedId.current = (await managerApi.saveProperty(id ?? null, { name: name.trim(), address: address.trim() })).id;
          });
        }}
      >
        <Field label="Property name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} required placeholder="Woodcrest Apartments" />
        </Field>
        <Field label="Street address">
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={500} required placeholder="2400 Woodcrest Dr, Las Cruces, NM 88011" />
        </Field>
        <ErrorText error={error} />
        <Actions busy={busy} label={id ? "Save" : "Add property"} onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * + Add unit / rename unit
 * ------------------------------------------------------------------ */

function UnitDialog({ id, propertyId, unitNum: initialNum, onClose }: Props<"unit">) {
  const { changed } = useManager();
  const properties = useLoad(() => managerApi.properties());
  const [property, setProperty] = useState(propertyId ? String(propertyId) : "");
  const [unitNum, setUnitNum] = useState(initialNum ?? "");
  const [more, setMore] = useState(false);
  const { busy, error, run } = useSubmit(() => {
    changed(id ? "Unit updated." : `Unit ${unitNum.trim()} added.`);
    if (more && !id) setUnitNum("");
    else onClose();
  });

  return (
    <Modal title={id ? "Edit unit" : "Add unit"} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            async () => {
              if (!property) throw new LocalError("Choose a property.");
              await managerApi.saveUnit(id ?? null, { propertyId: Number(property), unitNum: unitNum.trim() });
            },
            { VALIDATION_ERROR: "That property already has a unit with this number." },
          );
        }}
      >
        <Field label="Property">
          <select value={property} onChange={(e) => setProperty(e.target.value)} required>
            <option value="">Choose a property…</option>
            {(properties.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Unit number">
          <input value={unitNum} onChange={(e) => setUnitNum(e.target.value)} maxLength={20} required placeholder="113" />
        </Field>
        {!id && (
          <label className="mgr-check">
            <input type="checkbox" checked={more} onChange={(e) => setMore(e.target.checked)} /> Add another after this one
          </label>
        )}
        <ErrorText error={error} />
        <Actions busy={busy} loading={!properties.data} label={id ? "Save" : "Add unit"} onClose={onClose} />
      </form>
    </Modal>
  );
}

/** Pick a receipt photo or PDF, or take a photo with the phone's camera; checked as soon as it is picked. */
function ReceiptPicker({ value, onChange }: { value: ReceiptUpload | null; onChange: (r: ReceiptUpload | null) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const pick = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    setProblem(null);
    if (!file) return;
    setReading(true);
    readReceipt(file)
      .then((r) => onChange(r))
      .catch((err: Error) => {
        onChange(null);
        setProblem(err.message);
      })
      .finally(() => {
        input.value = "";
        setReading(false);
      });
  };
  return (
    <div className="mgr-field">
      <span className="mgr-field__label">Receipt (optional)</span>
      <div className="mgr-receipt-pick">
        {/* On a phone this opens the camera straight away. */}
        <label className="mgr-btn mgr-btn--secondary mgr-receipt-pick__camera">
          Take photo
          <input type="file" accept="image/*" capture="environment" className="mgr-visually-hidden" aria-label="Take a photo of the receipt" onChange={(e) => pick(e.currentTarget)} />
        </label>
        <label className="mgr-btn mgr-btn--ghost">
          Choose file
          <input type="file" accept={RECEIPT_ACCEPT} className="mgr-visually-hidden" aria-label="Receipt file" onChange={(e) => pick(e.currentTarget)} />
        </label>
      </div>
      {reading && <span className="mgr-field__hint">Reading the photo…</span>}
      {value && !reading && (
        <span className="mgr-field__hint">
          Attached: {value.filename}{" "}
          <button type="button" className="mgr-link-btn" onClick={() => onChange(null)}>
            Remove
          </button>
        </span>
      )}
      {!value && !reading && !problem && <span className="mgr-field__hint">A photo of the check, money order or cash receipt, or a PDF. Stored with the payment.</span>}
      {problem && <span className="mgr-alert mgr-alert--error" role="alert">{problem}</span>}
    </div>
  );
}

/** A fresh id for one payment, so a retry after a dropped connection can't record it twice. */
const newPaymentKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** Whether the phone has a connection right now (updates as it comes and goes). */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

const matchesUnit = (u: UnitRow, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${u.unitNum} ${u.propertyName} ${u.tenants.map((t) => t.name).join(" ")}`.toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
};

/* ------------------------------------------------------------------ *
 * Record a payment (check, cash, money order taken at the office or
 * at the door). Built to be used on a phone: find the unit by number
 * or name, one tap for the full balance, a photo of the check, and a
 * key per payment so a retry on a weak connection is never a second
 * payment.
 * ------------------------------------------------------------------ */

function PaymentDialog({ leaseId, onClose }: Props<"payment">) {
  const { changed } = useManager();
  const units = useLoad(() => managerApi.units());
  const online = useOnline();
  const leased = (units.data ?? []).filter((u) => u.leaseId !== null);
  const [query, setQuery] = useState("");
  const [lease, setLease] = useState(leaseId ? String(leaseId) : "");
  const chosen = leased.find((u) => String(u.leaseId) === lease);
  const shown = leased.filter((u) => matchesUnit(u, query) || String(u.leaseId) === lease);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>(PAYMENT_METHODS[0]);
  const [payer, setPayer] = useState("");
  const [receipt, setReceipt] = useState<ReceiptUpload | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [paymentKey, setPaymentKey] = useState(newPaymentKey);
  const [mayHaveSent, setMayHaveSent] = useState(false);
  const { busy, error, run } = useSubmit(() => changed("Payment recorded."));

  const choose = (value: string) => {
    setLease(value);
    setPayer("");
    setAmount("");
  };

  const startOver = () => {
    setConfirmation(null);
    setQuery("");
    setLease("");
    setAmount("");
    setPayer("");
    setReceipt(null);
    setMayHaveSent(false);
    setPaymentKey(newPaymentKey());
  };

  if (confirmation) {
    return (
      <Modal title="Payment recorded" onClose={onClose}>
        <div className="mgr-form">
          <p className="mgr-pay-done">
            <span className="mgr-pay-done__amount">{money(Number(amount || chosen?.balance || 0))}</span>
            <span>{chosen ? `${unitLabel(chosen)} · ${method}` : method}</span>
          </p>
          <p>
            Confirmation <strong className="mgr-mono">{confirmation}</strong>
          </p>
          <p className="mgr-muted">
            It's on the resident's ledger now, and everyone on the lease gets a "Payment received" notice (by email too, if email is on).
            {receipt ? " The receipt photo is stored with it." : ""}
          </p>
          <div className="mgr-modal__actions">
            <button type="button" className="mgr-btn mgr-btn--secondary" onClick={startOver}>
              Record another
            </button>
            <button type="button" className="mgr-btn mgr-btn--primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Record a payment" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!lease) throw new LocalError("Choose the unit this payment is for.");
            const amt = parseMoney(amount || (chosen && chosen.balance > 0 ? String(chosen.balance) : ""), "the amount received");
            if (typeof navigator !== "undefined" && navigator.onLine === false) {
              throw new LocalError("No connection, so nothing was sent. When you have signal, tap Record payment again.");
            }
            try {
              const result = await managerApi.recordPayment(Number(lease), { amount: amt, method, tenantId: payer ? Number(payer) : null, receipt, idempotencyKey: paymentKey });
              if (!amount) setAmount(amt.toFixed(2));
              setConfirmation(result.confirmation);
            } catch (err) {
              if (!isNetworkError(err)) throw err;
              // It may have reached the server. The same key makes a retry safe.
              setMayHaveSent(true);
              throw new LocalError("The connection dropped before the portal answered. Tap Record payment again: if it already went through, you'll see the same confirmation, not a second payment.");
            }
          });
        }}
      >
        {!online && (
          <p className="mgr-alert mgr-alert--warn" role="status">
            No connection. You can fill this in; it sends when you tap Record payment with signal.
          </p>
        )}
        {!leaseId && (
          <Field label="Find the unit" hint={units.data ? `${shown.length} of ${leased.length} leased units` : undefined}>
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              placeholder="Unit number or tenant name"
              value={query}
              onChange={(e) => {
                const q = e.target.value;
                setQuery(q);
                const hits = leased.filter((u) => matchesUnit(u, q));
                if (q.trim() && hits.length === 1) choose(String(hits[0]!.leaseId));
              }}
            />
          </Field>
        )}
        <Field label="Unit">
          <select value={lease} onChange={(e) => choose(e.target.value)} required disabled={mayHaveSent}>
            <option value="">{shown.length ? "Choose a unit…" : "No unit matches"}</option>
            {shown.map((u) => (
              <option key={u.leaseId} value={u.leaseId!}>
                {unitLabel(u)} · {u.tenants.map((t) => t.name).join(", ")} · {u.balance > 0 ? `owes ${money(u.balance)}` : "paid up"}
              </option>
            ))}
          </select>
        </Field>
        <div className="mgr-form__row">
          <Field label="Amount received">
            <input
              inputMode="decimal"
              enterKeyHint="done"
              placeholder={chosen && chosen.balance > 0 ? chosen.balance.toFixed(2) : "0.00"}
              value={amount}
              disabled={mayHaveSent}
              onChange={(e) => setAmount(e.target.value)}
            />
            {chosen && chosen.balance > 0 && (
              <button type="button" className="mgr-chip-btn" disabled={mayHaveSent} onClick={() => setAmount(chosen.balance.toFixed(2))}>
                Full balance {money(chosen.balance)}
              </button>
            )}
          </Field>
          <Field label="Method">
            <select value={method} onChange={(e) => setMethod(e.target.value)} disabled={mayHaveSent}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
        </div>
        {chosen && chosen.tenants.length > 0 && (
          <Field label="Paid by">
            <select value={payer} onChange={(e) => setPayer(e.target.value)} disabled={mayHaveSent}>
              <option value="">Not recorded</option>
              {chosen.tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!mayHaveSent && <ReceiptPicker value={receipt} onChange={setReceipt} />}
        <ErrorText error={error} />
        <Actions busy={busy} loading={!units.data} label="Record payment" onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * + Invite tenant / edit tenant
 * ------------------------------------------------------------------ */

function InviteTenantDialog({ onClose }: Props<"tenant">) {
  const { changed } = useManager();
  const [person, setPerson] = useState<NewPerson>({ name: "", email: "", phone: "" });
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed(`${person.name.trim()} invited. Copy their sign-up link from Tenants, and add them to a lease from New lease.`);
  });
  return (
    <Modal title="Invite tenant" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const [p] = cleanPeople([person]);
            if (!p) throw new LocalError("Enter the tenant's name and email.");
            await managerApi.inviteTenant(p);
          });
        }}
      >
        <Field label="Full name">
          <input value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} required maxLength={255} />
        </Field>
        <Field label="Email" hint="They sign in with this address. Send them the sign-up link from Tenants to choose a password.">
          <input type="email" value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} required maxLength={255} />
        </Field>
        <Field label="Phone (optional)">
          <input value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} maxLength={20} />
        </Field>
        <ErrorText error={error} />
        <Actions busy={busy} label="Invite tenant" onClose={onClose} />
      </form>
    </Modal>
  );
}

function EditTenantDialog({ id, name: initialName, phone: initialPhone, onClose }: Props<"editTenant">) {
  const { changed } = useManager();
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone ?? "");
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Contact details saved.");
  });
  return (
    <Modal title="Edit tenant" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => managerApi.updateTenant(id, { name: name.trim(), phone: phone.trim() }));
        }}
      >
        <Field label="Full name">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={255} />
        </Field>
        <Field label="Phone">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} />
        </Field>
        <p className="mgr-field__hint">The email address is the tenant's sign-in, so only they can change it.</p>
        <ErrorText error={error} />
        <Actions busy={busy} label="Save" onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Maintenance request (from the office or on-site staff)
 * ------------------------------------------------------------------ */

function MaintenanceDialog({ unitId, onClose }: Props<"maintenance">) {
  const { changed } = useManager();
  const queue = useLoad(() => managerApi.maintenance());
  const [unit, setUnit] = useState(unitId ? String(unitId) : "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<RequestPriority>("none");
  const [requestType, setRequestType] = useState<RequestType>("other");
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Request added to the queue.");
  });
  return (
    <Modal title="Maintenance request" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!unit) throw new LocalError("Choose the unit.");
            await managerApi.createMaintenance({ unitId: Number(unit), title: title.trim(), description: description.trim(), priority, requestType });
          });
        }}
      >
        <Field label="Unit">
          <select value={unit} onChange={(e) => setUnit(e.target.value)} required>
            <option value="">Choose a unit…</option>
            {(queue.data?.units ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What needs fixing">
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} placeholder="Water heater leaking" />
        </Field>
        <div className="mgr-form__row">
          <Field label="Type">
            <select value={requestType} onChange={(e) => setRequestType(e.target.value as RequestType)}>
              {REQUEST_TYPES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value as RequestPriority)}>
              {REQUEST_PRIORITIES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Details (optional)">
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
        </Field>
        <ErrorText error={error} />
        <Actions busy={busy} loading={!queue.data} label="Add request" onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Lease changes
 * ------------------------------------------------------------------ */

function RentDialog({ leaseId, monthlyRent, onClose }: Props<"rent">) {
  const { changed } = useManager();
  const [rent, setRent] = useState(monthlyRent.toFixed(2));
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Rent updated.");
  });
  return (
    <Modal title="Change monthly rent" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => managerApi.updateLease(leaseId, { monthlyRent: parseMoney(rent, "the monthly rent") }));
        }}
      >
        <Field label="Monthly rent" hint="The lease table stores one rent amount, so this applies to every month of the lease, past ones included.">
          <input inputMode="decimal" value={rent} onChange={(e) => setRent(e.target.value)} required />
        </Field>
        <ErrorText error={error} />
        <Actions busy={busy} label="Save rent" onClose={onClose} />
      </form>
    </Modal>
  );
}

function EndLeaseDialog({ leaseId, label, onClose }: Props<"endLease">) {
  const { changed, go } = useManager();
  const [end, setEnd] = useState(todayIso());
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Lease ended. The unit shows as vacant from the day after.");
    go({ name: "rent-roll" });
  });
  return (
    <Modal title="End lease" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => managerApi.updateLease(leaseId, { endDate: end }), {
            VALIDATION_ERROR: "The end date cannot be before the lease started.",
          });
        }}
      >
        <p>
          End the lease on <strong>{label}</strong>. Rent stops being charged after the last day, and the unit opens up for a new lease.
        </p>
        <Field label="Last day of the lease">
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </Field>
        <ErrorText error={error} />
        <Actions busy={busy} label="End lease" onClose={onClose} danger />
      </form>
    </Modal>
  );
}

function AddResidentDialog({ leaseId, onClose }: Props<"addResident">) {
  const { changed } = useManager();
  const tenants = useLoad(() => managerApi.tenants());
  const free = (tenants.data ?? []).filter((t) => t.leaseId === null);
  const [existing, setExisting] = useState("");
  const [person, setPerson] = useState<NewPerson>({ name: "", email: "", phone: "" });
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Resident added to the lease.");
  });
  return (
    <Modal title="Add a resident or cosigner" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            async () => {
              if (existing) return managerApi.addTenantToLease(leaseId, { tenantId: Number(existing) });
              const [p] = cleanPeople([person]);
              if (!p) throw new LocalError("Pick someone from the list or enter a new resident.");
              return managerApi.addTenantToLease(leaseId, { newTenant: p });
            },
            { EMAIL_IN_USE: "That email is already in use. Pick the person from the list instead." },
          );
        }}
      >
        {free.length > 0 && (
          <Field label="Someone already in the system">
            <select value={existing} onChange={(e) => setExisting(e.target.value)}>
              <option value="">— or enter a new person below —</option>
              {free.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.email})
                </option>
              ))}
            </select>
          </Field>
        )}
        {!existing && (
          <>
            <Field label="Full name">
              <input value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} maxLength={255} />
            </Field>
            <div className="mgr-form__row">
              <Field label="Email">
                <input type="email" value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} maxLength={255} />
              </Field>
              <Field label="Phone (optional)">
                <input value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} maxLength={20} />
              </Field>
            </div>
          </>
        )}
        <ErrorText error={error} />
        <Actions busy={busy} loading={!tenants.data} label="Add to lease" onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Attach a receipt to a payment already recorded
 * ------------------------------------------------------------------ */

function AttachReceiptDialog({ leaseId, paymentId, label, onClose }: Props<"attachReceipt">) {
  const { changed } = useManager();
  const [receipt, setReceipt] = useState<ReceiptUpload | null>(null);
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Receipt saved.");
  });
  return (
    <Modal title="Attach a receipt" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!receipt) throw new LocalError("Choose the receipt file first.");
            await managerApi.attachReceipt(leaseId, paymentId, receipt);
          });
        }}
      >
        <p>For the payment: {label}</p>
        <ReceiptPicker value={receipt} onChange={setReceipt} />
        <ErrorText error={error} />
        <Actions busy={busy} label="Save receipt" onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Confirm a delete (the server explains if something must stay)
 * ------------------------------------------------------------------ */

function ConfirmDialog({ title, body, confirmLabel, run: work, done, after, onClose }: Props<"confirm">) {
  const { changed, go } = useManager();
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed(done);
    if (after) go(after);
  });
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(work);
        }}
      >
        <p>{body}</p>
        <ErrorText error={error} />
        <Actions busy={busy} label={confirmLabel} onClose={onClose} danger />
      </form>
    </Modal>
  );
}
