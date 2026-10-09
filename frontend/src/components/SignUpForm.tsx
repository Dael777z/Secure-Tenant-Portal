// "Create your account" for a resident the office has already added (invite-only
// sign-up, agreed 10/1): they choose a password for the email on their lease,
// then are signed in. Uses the backend's POST /api/auth/signup.
import { useState } from "react";
import type { FormEvent } from "react";

interface SignUpFormProps {
  /** Signs in once the account exists. */
  onLogin: (email: string, password: string) => Promise<void>;
  onBack: () => void;
}

function signUpMessage(status: number, code: string | undefined): string {
  if (code === "SIGNUP_NOT_ALLOWED") {
    return "We couldn't create an account for that email. Use the email the leasing office has for you, or sign in if you already set a password.";
  }
  if (status === 400) return "Enter your email and a password of at least 8 characters.";
  if (status === 403) return "This page could not be verified. Reload it and try again.";
  return "We could not reach the server. Check your connection and try again.";
}

export function SignUpForm({ onLogin, onBack }: SignUpFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!email.trim() || password.length < 8) return setError("Enter your email and a password of at least 8 characters.");
    if (password !== confirm) return setError("The two passwords don't match.");

    setBusy(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(signUpMessage(res.status, body.error));
        return;
      }
      await onLogin(email.trim(), password);
    } catch {
      setError(signUpMessage(0, undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="login-form-heading">Create your account</h2>
      <p className="login-footnote">
        For residents the leasing office has added to a lease. Use the email they have for you and choose a password.
      </p>
      <form onSubmit={handleSubmit} noValidate>
        <div className="form-group">
          <label className="field-label field-label--dark" htmlFor="signup-email">Email address</label>
          <input id="signup-email" type="email" className="field-input field-input--light" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </div>
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
