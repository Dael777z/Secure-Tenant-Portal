// "Create your account" for a resident the leasing office has invited. The
// office sends a sign-up link (/signup?token=...); the token in it says who the
// resident is, so they only choose a password, then are signed in.
// Uses the backend's POST /api/auth/signup { token, password }.
import { useState } from "react";
import type { FormEvent } from "react";

interface SignUpFormProps {
  /** Signs in once the account exists. */
  onLogin: (email: string, password: string) => Promise<void>;
  onBack: () => void;
}

/** The invite token from the sign-up link, if the page was opened from one. */
export function inviteTokenFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("token");
}

function signUpMessage(status: number, code: string | undefined): string {
  if (code === "SIGNUP_NOT_ALLOWED") {
    return "This sign-up link has expired or was already used. Ask the leasing office for a new one, or sign in if you already set a password.";
  }
  if (code === "PASSWORD_TOO_COMMON") return "That password is too easy to guess. Choose a less common one, such as a few words strung together.";
  if (status === 400) return "Choose a password of at least 8 characters.";
  if (status === 403) return "This page could not be verified. Reload it and try again.";
  return "We could not reach the server. Check your connection and try again.";
}

export function SignUpForm({ onLogin, onBack }: SignUpFormProps) {
  const [token] = useState(inviteTokenFromUrl);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Choose a password of at least 8 characters.");
    if (password !== confirm) return setError("The two passwords don't match.");

    setBusy(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; email?: string };
      if (!res.ok || !body.email) {
        setError(signUpMessage(res.status, body.error));
        return;
      }
      // The link has done its job; keep the token out of the address bar and history.
      window.history.replaceState(null, "", "/");
      await onLogin(body.email, password);
    } catch {
      setError(signUpMessage(0, undefined));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <>
        <h2 className="login-form-heading">Create your account</h2>
        <p className="login-footnote">
          Accounts are set up by the leasing office. Open the sign-up link they sent you, or ask them for a new one.
        </p>
        <p className="login-footnote">
          Already have a password?{" "}
          <button type="button" className="link-button link-button--dark" onClick={onBack}>Sign in</button>
        </p>
      </>
    );
  }

  return (
    <>
      <h2 className="login-form-heading">Create your account</h2>
      <p className="login-footnote">Choose a password for your resident account.</p>
      <form onSubmit={handleSubmit} noValidate>
        <div className="form-group">
          <label className="field-label field-label--dark" htmlFor="signup-password">Password (8 or more characters)</label>
          <input id="signup-password" type="password" className="field-input field-input--light" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="form-group">
          <label className="field-label field-label--dark" htmlFor="signup-confirm">Password again</label>
          <input id="signup-confirm" type="password" className="field-input field-input--light" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
        {error && <div className="login-error" role="alert">{error}</div>}
        <button type="submit" className="btn btn--primary login-submit" disabled={busy}>
          {busy ? "Creating your account..." : "Create account"}
        </button>
      </form>
      <p className="login-footnote">
        Already have a password?{" "}
        <button type="button" className="link-button link-button--dark" onClick={onBack}>Sign in</button>
      </p>
    </>
  );
}
