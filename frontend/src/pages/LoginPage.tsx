import { useState } from "react";
import type { FormEvent } from "react";
import { beginMfaSetup, loginMessage, secondStepFor } from "../api/auth";
import { inviteTokenFromUrl, SignUpForm } from "../components/SignUpForm";
import { Brand } from "../theme/Brand";

interface LoginPageProps {
    /** Signs in against the backend; rejects with an AuthError on failure. `code` is a staff member's 6-digit code. */
    onLogin: (email: string, password: string, code?: string) => Promise<void>;
}

/** Staff two-step sign-in: what the authenticator app needs at first-time setup. */
interface MfaSetup { secret: string; uri: string; qr: string }

export function LoginPage({ onLogin }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opened from a sign-up link: start on "Create your account".
  const [signingUp, setSigningUp] = useState(() => inviteTokenFromUrl() !== null);
  // "Forgot password?" opens a note on how a reset works (the office or a property manager sends a new link).
  const [showResetHelp, setShowResetHelp] = useState(false);
  // Staff only: after a right password the form asks for the 6-digit code ("code"),
  // with the QR code above it the first time ("setup").
  const [step, setStep] = useState<"password" | "code" | "setup">("password");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<MfaSetup | null>(null);

  /**
   * Sign in; when the server asks for the second step, move the form to it instead of failing.
   * Also what the sign-up form calls, so a new teammate goes straight from choosing a password to setup.
   */
  async function signIn(asEmail: string, asPassword: string, withCode?: string) {
    try {
      await onLogin(asEmail, asPassword, withCode);
    } catch (caught) {
      const next = secondStepFor(caught);
      if (!next) throw caught;
      if (next === "setup") {
        const started = await beginMfaSetup(asEmail, asPassword);
        const { toDataURL } = await import("qrcode");   // only staff setting up ever load it
        setSetup({ ...started, qr: await toDataURL(started.uri, { margin: 1, width: 200 }) });
      }
      setEmail(asEmail);
      setPassword(asPassword);
      setCode("");
      setSigningUp(false);
      setStep(next);
    }
  }

  function backToPassword() {
    setStep("password");
    setPassword("");
    setCode("");
    setSetup(null);
    setError(null);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }
    if (step !== "password" && !/^\d{6}$/.test(code.replace(/\s/g, ""))) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }

    setIsSubmitting(true);

    signIn(email, password, step === "password" ? undefined : code)
      .catch((caught: unknown) => {
        setCode("");
        if (step === "password") setPassword("");
        setError(loginMessage(caught));
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
            <SignUpForm onLogin={signIn} onBack={() => setSigningUp(false)} />
          ) : (
          <>
          <h2 className="login-form-heading">{step === "setup" ? "Set up two-step sign-in" : step === "code" ? "Enter your code" : "Sign in"}</h2>

          <form onSubmit={handleSubmit} noValidate>
            {step !== "password" && (
            <>
              {step === "setup" && setup ? (
                <div className="login-footnote login-mfa-setup">
                  <p>
                    Staff accounts need a code from an authenticator app at every sign-in. Open one on your phone (Google
                    Authenticator, Microsoft Authenticator or your phone's built-in passwords app), scan this, then enter the
                    6-digit code it shows.
                  </p>
                  <img className="login-mfa-qr" src={setup.qr} width={200} height={200} alt="QR code to scan with your authenticator app" />
                  <p>
                    On this phone? <a href={setup.uri}>Open your authenticator app</a>, or type this key into it:{" "}
                    <code className="login-mfa-key">{setup.secret.match(/.{4}/g)?.join(" ")}</code>
                  </p>
                </div>
              ) : (
                <p className="login-footnote login-mfa-setup">Open your authenticator app and enter the 6-digit code for Summit Portal.</p>
              )}
              <div className="form-group">
                <label className="field-label field-label--dark" htmlFor="login-code">
                  6-digit code
                </label>
                <input
                  id="login-code"
                  className="field-input field-input--light"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
            </>
            )}

            {step === "password" && (
            <>
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
            </>
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

          {step !== "password" && (
            <p className="login-footnote">
              New phone, or no code? Ask a property manager to reset your sign-in from Team.{" "}
              <button type="button" className="link-button link-button--dark" onClick={backToPassword}>
                Back to sign in
              </button>
            </p>
          )}
          {step === "password" && (
          <p className="login-footnote">
            New resident or teammate?{" "}
            <button type="button" className="link-button link-button--dark" onClick={() => setSigningUp(true)}>
              Create your account
            </button>{" "}
            with the link the office sent you.
          </p>
          )}
          </>
          )}
        </div>
      </div>
    </div>
  );
}