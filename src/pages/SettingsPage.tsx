import { useState } from "react";
import { mockTenant } from "../data/mockData";
import { applyTextSize, getTextSize, type TextSize } from "../components/textSize";

// Email only
interface NotificationPrefs {
  rentDue: boolean;
  paymentReceipts: boolean;
  maintenance: boolean;
  messages: boolean;
}

const notificationOptions: { key: keyof NotificationPrefs; label: string; hint: string }[] = [
  { key: "rentDue", label: "Rent due reminders", hint: "Before rent is due and when it is late" },
  { key: "paymentReceipts", label: "Payment receipts", hint: "When a payment is received" },
  { key: "maintenance", label: "Maintenance updates", hint: "When a request changes status" },
  { key: "messages", label: "Messages from the office", hint: "When property management writes to you" },
];

const textSizeOptions: { key: TextSize; label: string }[] = [
  { key: "default", label: "Default" },
  { key: "large", label: "Large" },
  { key: "xlarge", label: "Extra large" },
];

interface Profile {
  name: string;
  email: string;
  phone: string;
}
/**
 * Settings: the tenant's own information.
 *
 * Shows read-only lease info (unit, address - set by the office) and an
 * editable contact section (View -> Edit -> Save / Cancel).
 *
 * SAVE IS LOCAL-ONLY for now. The backend has no endpoint for a tenant to
 * update their own profile, and GET /api/tenant/summary only returns name,
 * unit and address (no email or phone). To make it real:
 *   1. ask Scott for something like PATCH /api/tenant/profile {name, phone}
 *      (email is the login identity and password changes need their own
 *      secure flow, so those are better as separate routes),
 *   2. add the call next to newMaintenanceRequest in api/tenant.ts,
 *   3. call it in handleSave below, then `await refresh()` so the sidebar
 *      name updates too, and load email/phone from the summary.
 */
export function SettingsPage() {
//   const reference = {mockTenant };
  const [saved, setSaved] = useState<Profile>({ name: mockTenant.name, email: "", phone: "" });
  const [draft, setDraft] = useState<Profile>(saved);
  const [editing, setEditing] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPrefs>({
    rentDue: true,
    paymentReceipts: true,
    maintenance: true,
    messages: true,
  });
  const [textSize, setTextSize] = useState<TextSize>(getTextSize);

  function chooseTextSize(size: TextSize) {
    setTextSize(size);
    applyTextSize(size);
  }

  function startEdit() {
    setDraft(saved);
    setJustSaved(false);
    setEditing(true);
  }

  function handleCancel() {
    setDraft(saved);
    setEditing(false);
  }

  function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.name.trim()) return;
    // Placeholder for the real call
    setSaved({ name: draft.name.trim(), email: draft.email.trim(), phone: draft.phone.trim() });
    setEditing(false);
    setJustSaved(true);
  }

  const set = (key: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="settings-page">
      <section className="settings-card" aria-labelledby="settings-contact">
        <div className="settings-card-header">
          <h2 id="settings-contact">Your information</h2>
          {!editing && (
            <button type="button" className="btn btn--outline" onClick={startEdit}>
              Edit
            </button>
          )}
        </div>

        {justSaved && !editing && (
          <div className="settings-note" role="status">
            Saved on this screen only - it isn't stored on the server yet.
          </div>
        )}

        {editing ? (
          <form onSubmit={handleSave}>
            <div className="form-group">
              <label className="field-label" htmlFor="set-name">Full name</label>
              <input id="set-name" className="field-input" type="text" value={draft.name} onChange={set("name")} required />
            </div>
            <div className="form-group">
              <label className="field-label" htmlFor="set-email">Email</label>
              <input id="set-email" className="field-input" type="email" value={draft.email} onChange={set("email")} />
            </div>
            <div className="form-group">
              <label className="field-label" htmlFor="set-phone">Phone</label>
              <input id="set-phone" className="field-input" type="tel" value={draft.phone} onChange={set("phone")} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="submit" className="btn btn--primary" disabled={!draft.name.trim()}>Save changes</button>
              <button type="button" className="btn btn--outline" onClick={handleCancel}>Cancel</button>
            </div>
          </form>
        ) : (
          <dl className="settings-fields">
            <Field label="Full name" value={saved.name} />
            <Field label="Email" value={saved.email} />
            <Field label="Phone" value={saved.phone} />
          </dl>
        )}
      </section>

      <section className="settings-card" aria-labelledby="settings-notify">
        <div className="settings-card-header">
          <h2 id="settings-notify">Email notifications</h2>
        </div>
        <p className="settings-hint" style={{ margin: "0 0 12px" }}>
          {saved.email
            ? `Sent to ${saved.email}.`
            : "Add your email above to receive these."}
        </p>
        <div className="settings-toggles">
          {notificationOptions.map((option) => (
            <label key={option.key} className="settings-toggle">
              <input
                type="checkbox"
                checked={prefs[option.key]}
                onChange={(e) => setPrefs((prev) => ({ ...prev, [option.key]: e.target.checked }))}
              />
              <span>
                <span className="settings-toggle-label">{option.label}</span>
                <span className="settings-toggle-hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {/* Local-only: asked for a backend item per user (the office edits contact details in the database). */}
        <p className="settings-hint">These choices are kept on this screen only for now.</p>
      </section>

      <section className="settings-card" aria-labelledby="settings-display">
        <div className="settings-card-header">
          <h2 id="settings-display">Display</h2>
        </div>
        <div className="settings-segment" role="radiogroup" aria-label="Text size">
          {textSizeOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={textSize === option.key}
              className="settings-segment-btn"
              onClick={() => chooseTextSize(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="settings-hint">Makes text larger across the portal. Saved on this device.</p>
      </section>

      <section className="settings-card" aria-labelledby="settings-lease">
        <div className="settings-card-header">
          <h2 id="settings-lease">Your home</h2>
        </div>
        <dl className="settings-fields">
          <Field label="Unit" value={mockTenant.unitLabel} />
          <Field label="Address" value={mockTenant.address} />
        </dl>
        <p className="settings-hint">Unit and address come from your lease. Contact the office to change them.</p>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-field">
      <dt>{label}</dt>
      <dd>{value || <span className="settings-empty">Not added</span>}</dd>
    </div>
  );
}
