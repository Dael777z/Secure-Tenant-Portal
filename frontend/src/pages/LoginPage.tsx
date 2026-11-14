import { useState } from "react";
import type { FormEvent } from "react";
import { loginMessage } from "../api/auth";
import { inviteTokenFromUrl, SignUpForm } from "../components/SignUpForm";
import { Brand } from "../theme/Brand";

interface LoginPageProps {
    /** Signs in against the backend; rejects with an AuthError on failure. */
    onLogin: (email: string, password: string) => Promise<void>;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opened from a sign-up link: start on "Create your account".
  const [signingUp, setSigningUp] = useState(() => inviteTokenFromUrl() !== null);
  // "Forgot password?" opens a note on how a reset works (the office or a property manager sends a new link).
  const [showResetHelp, setShowResetHelp] = useState(false);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }

    setIsSubmitting(true);

    onLogin(email, password)
      .catch((caught: unknown) => {
        setError(loginMessage(caught));
        setPassword("");
      })
      .finally(() => setIsSubmitting(false));
  }

   return (
    <div className="login-shell">
      <div className="login-brand-panel">
        <div className="login-brand-mark">
          <Brand sub="Summit Realty Portal" size={40} />
        </div>
        <h1 className="login-brand-title">
          Summit
          <br />
          Residential Portal
        </h1>
        <p className="login-brand-tagline">One record, two sides.</p>
      </div>

      <div className="login-form-panel">
        <div className="login-form-card">
          {signingUp ? (
            <SignUpForm onLogin={onLogin} onBack={() => setSigningUp(false)} />
          ) : (
          <>
          <h2 className="login-form-heading">Sign in</h2>

          <form onSubmit={handleSubmit} noValidate>
            <div className="form-group">
              <label className="field-label field-label--dark" htmlFor="login-email">
                Email address
              </label>
              <input
                id="login-email"
                type="email"
                className="field-input field-input--light"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </div>

            <div className="form-group">
              <div className="login-password-row">
                <label className="field-label field-label--dark" htmlFor="login-password">
                  Password
                </label>
                <button
                  type="button"
                  className="link-button link-button--dark"
                  aria-expanded={showResetHelp}
                  aria-controls="login-reset-help"
                  onClick={() => setShowResetHelp(!showResetHelp)}
                >
                  Forgot password?
                </button>
              </div>
              <input
                id="login-password"
                type="password"
                className="field-input field-input--light"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            {showResetHelp && (
              <div id="login-reset-help" className="login-footnote login-reset-help" role="note">
                <strong>Residents:</strong> call or message the leasing office and ask for a new sign-in link. It lets you choose a
                new password, and your old password stops working. <strong>Staff:</strong> ask a property manager to send you a new
                link from Team.
              </div>
            )}

            {error && (
              <div className="login-error" role="alert">
                {error}
              </div>
            )}

            <button type="submit" className="btn btn--primary login-submit" disabled={isSubmitting}>
              {isSubmitting ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <p className="login-footnote">
            New resident or teammate?{" "}
            <button type="button" className="link-button link-button--dark" onClick={() => setSigningUp(true)}>
              Create your account
            </button>{" "}
            with the link the office sent you.
          </p>
          </>
          )}
        </div>
      </div>
    </div>
  );
}