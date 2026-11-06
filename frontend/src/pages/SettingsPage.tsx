import { useState } from "react";
import { useTenantData } from "../data/tenantData";
import { messageFor, tenantApi, type NotificationPrefs } from "../api/tenant";
import { applyTextSize, getTextSize, type TextSize } from "../components/textSize";

// Juan's Settings page (tenant-side-ui 23d7a8e), saved to the server:
// name and phone (PUT /tenant/profile), email notification choices
// (PUT /tenant/notifications). The email is the sign-in, so it is shown
// but not edited here. Text size stays on this device.

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

interface Draft {
  name: string;
  phone: string;
}

export function SettingsPage() {
  const { tenant, contact, notificationPrefs, refresh } = useTenantData();
  const [draft, setDraft] = useState<Draft>({ name: tenant.name, phone: contact.phone ?? "" });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [prefs, setPrefs] = useState<NotificationPrefs>(notificationPrefs);
  const [prefsState, setPrefsState] = useState<"idle" | "saving" | "saved">("idle");
  const [prefsError, setPrefsError] = useState<string | null>(null);

  const [textSize, setTextSize] = useState<TextSize>(getTextSize);

  function chooseTextSize(size: TextSize) {
    setTextSize(size);
    applyTextSize(size);
  }

  function startEdit() {
    setDraft({ name: tenant.name, phone: contact.phone ?? "" });
    setJustSaved(false);
    setProfileError(null);
    setEditing(true);
  }

  function handleCancel() {
    setEditing(false);
    setProfileError(null);
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) return;
    setSaving(true);
    setProfileError(null);
    try {
      await tenantApi.updateProfile(name, draft.phone.trim());
      await refresh(); // the sidebar greeting shows the new name too
      setEditing(false);
      setJustSaved(true);
    } catch (caught) {
      setProfileError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  }

  async function togglePref(key: keyof NotificationPrefs, value: boolean) {
    const before = prefs;
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    setPrefsState("saving");
    setPrefsError(null);
    try {
      await tenantApi.saveNotificationPrefs(next);
      setPrefsState("saved");
    } catch (caught) {
      setPrefs(before); // put the switch back: it was not saved
      setPrefsState("idle");
      setPrefsError(messageFor(caught));
    }
  }

  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
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
            Saved.
          </div>
        )}

        {editing ? (
          <form onSubmit={handleSave}>
            <div className="form-group">
              <label className="field-label" htmlFor="set-name">Full name</label>
              <input id="set-name" className="field-input" type="text" value={draft.name} onChange={set("name")} maxLength={255} required />
            </div>
            <div className="form-group">
              <label className="field-label" htmlFor="set-email">Email</label>
              <input id="set-email" className="field-input" type="email" value={contact.email} readOnly aria-describedby="set-email-hint" />
              <p id="set-email-hint" className="settings-hint" style={{ marginTop: 6 }}>
                This is how you sign in. Contact the office to change it.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label" htmlFor="set-phone">Phone</label>
              <input id="set-phone" className="field-input" type="tel" value={draft.phone} onChange={set("phone")} maxLength={40} />
            </div>
            {profileError && (
              <div className="login-error" role="alert" style={{ marginBottom: 12 }}>
                {profileError}
              </div>
            )}
            <div className="settings-actions">
              <button type="submit" className="btn btn--primary" disabled={saving || !draft.name.trim()}>
                {saving ? "Saving..." : "Save changes"}
              </button>
              <button type="button" className="btn btn--outline" onClick={handleCancel} disabled={saving}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <dl className="settings-fields">
            <Field label="Full name" value={tenant.name} />
            <Field label="Email" value={contact.email} />
            <Field label="Phone" value={contact.phone ?? ""} />
          </dl>
        )}
      </section>

      <section className="settings-card" aria-labelledby="settings-notify">
        <div className="settings-card-header">
          <h2 id="settings-notify">Email notifications</h2>
        </div>
        <p className="settings-hint" style={{ margin: "0 0 12px" }}>
          Sent to {contact.email}.
        </p>
        <div className="settings-toggles">
          {notificationOptions.map((option) => (
            <label key={option.key} className="settings-toggle">
              <input
                type="checkbox"
                checked={prefs[option.key]}
                disabled={prefsState === "saving"}
                onChange={(e) => void togglePref(option.key, e.target.checked)}
              />
              <span>
                <span className="settings-toggle-label">{option.label}</span>
                <span className="settings-toggle-hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {prefsError ? (
          <div className="login-error" role="alert" style={{ marginTop: 12 }}>
            {prefsError}
          </div>
        ) : (
          <p className="settings-hint" role="status">
            {prefsState === "saving" ? "Saving..." : prefsState === "saved" ? "Saved." : "Changes save as you switch them."}
          </p>
        )}
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
          <Field label="Unit" value={tenant.unitLabel} />
          <Field label="Address" value={tenant.address} />
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
