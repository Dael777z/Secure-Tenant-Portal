import { useState } from "react";
import type { FormEvent } from "react";

interface LoginPageProps {
    onLogin: (email: string) => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }

    setIsSubmitting(true);

    window.setTimeout(() => {
      setIsSubmitting(false);
      onLogin(email);
    }, 500);
  }

   return (
    <div className="login-shell">
      <div className="login-brand-panel">
        <h1 className="login-brand-title">
          Summit
          <br />
          Residential Portal
        </h1>
        <p className="login-brand-tagline">One record, two sides.</p>
      </div>

      <div className="login-form-panel">
        <div className="login-form-card">
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
                <button type="button" className="link-button link-button--dark">
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
            Forgot your password?{" "}
            <button type="button" className="link-button link-button--dark">
              Email me a link to set a new one
            </button>
            . The leasing office can also reset it for you, and either way the reset is
            recorded on your account.
          </p>
        </div>
      </div>
    </div>
  );
}