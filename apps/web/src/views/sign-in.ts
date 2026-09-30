/**
 * Sign in.
 *
 * One deliberate choice: the failure message never distinguishes "no such
 * account" from "wrong password", and the server takes the same time to say it
 * either way. Otherwise this form tells anyone who asks whether a given person
 * lives in the building.
 */

import { h, render } from "../core/dom.ts";
import { auth, ApiError } from "../core/api.ts";
import { navigate, refreshSession, state, toast } from "../core/app.ts";

export async function signIn(mount: HTMLElement): Promise<void> {
  const error = h("p", { class: "field__error", role: "alert", hidden: true });
  const email = h("input", {
    class: "input",
    id: "email",
    type: "email",
    name: "email",
    autocomplete: "username",
    required: true,
    placeholder: "you@example.com",
  });
  const password = h("input", {
    class: "input",
    id: "password",
    type: "password",
    name: "password",
    autocomplete: "current-password",
    required: true,
  });
  const submit = h("button", { class: "btn btn--primary btn--lg btn--block", type: "submit" }, "Sign in");

  const form = h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onSubmit: async (event: SubmitEvent) => {
        event.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        submit.setAttribute("aria-busy", "true");
        submit.textContent = "Signing in…";

        try {
          await auth.login(email.value.trim(), password.value);
          await refreshSession();
          navigate("/", { replace: true });
        } catch (caught) {
          const message =
            caught instanceof ApiError
              ? caught.message
              : "We could not reach the server. Please check your connection and try again.";
          error.textContent = message;
          error.hidden = false;
          password.value = "";
          password.focus();
        } finally {
          submit.disabled = false;
          submit.removeAttribute("aria-busy");
          submit.textContent = "Sign in";
        }
      },
    },
    h(
      "div",
      { class: "field" },
      h("label", { class: "field__label", for: "email" }, "Email address"),
      email,
    ),
    h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "sign-in__label-row" },
        h("label", { class: "field__label", for: "password" }, "Password"),
        h("a", { class: "sign-in__forgot", href: "/forgot-password", onClick: go("/forgot-password") }, "Forgot password?"),
      ),
      password,
    ),
    error,
    submit,
  );

  render(
    mount,
    authLayout(
      "Sign in",
      form,
      h(
        "p",
        { class: "sign-in__help" },
        "Forgot your password? ",
        h("a", { href: "/forgot-password", onClick: go("/forgot-password") }, "Email me a link to set a new one"),
        ". The leasing office can also reset it for you, and either way the reset is recorded on your account.",
      ),
    ),
  );

  email.focus();
}

/** Follow an in-app link without reloading the page. */
function go(path: string) {
  return (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(path);
  };
}

/** The two-panel page every signed-out screen shares. */
function authLayout(heading: string, ...content: Array<HTMLElement | null>): HTMLElement {
  return h(
    "div",
    { class: "sign-in" },
    h(
      "div",
      { class: "sign-in__panel" },
      h(
        "div",
        { class: "sign-in__brand" },
        h("span", { class: "sign-in__mark", "aria-hidden": "true" }, "◧"),
        h("span", {}, "Summit"),
      ),
      h("h1", { class: "sign-in__title" }, "Summit Residential Portal"),
      h("p", { class: "sign-in__tagline" }, "One record, two sides."),
    ),
    h(
      "div",
      { class: "sign-in__form-side" },
      h("div", { class: "sign-in__form" }, h("h2", { class: "sign-in__heading" }, heading), ...content),
    ),
  );
}

/**
 * Forgot password (020): ask for a link by email.
 *
 * The answer is the same whether or not the address has an account, for the
 * same reason sign-in's is: this form must not tell anyone who lives here.
 */
export async function forgotPassword(mount: HTMLElement): Promise<void> {
  const error = h("p", { class: "field__error", role: "alert", hidden: true });
  const email = h("input", {
    class: "input",
    id: "reset-email",
    type: "email",
    name: "email",
    autocomplete: "username",
    required: true,
    placeholder: "you@example.com",
  });
  const submit = h("button", { class: "btn btn--primary btn--lg btn--block", type: "submit" }, "Email me a link");
  const sent = h("div", { class: "notice notice--good", role: "status", hidden: true });

  const form = h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onSubmit: async (event: SubmitEvent) => {
        event.preventDefault();
        error.hidden = true;
        const address = email.value.trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
          error.textContent = "Enter the email address you sign in with.";
          error.hidden = false;
          email.focus();
          return;
        }
        submit.disabled = true;
        submit.textContent = "Sending…";
        try {
          const result = await auth.forgotPassword(address);
          sent.replaceChildren(h("div", { class: "notice__body" }, h("strong", {}, "Check your email"), h("span", {}, result.message)));
          sent.hidden = false;
          submit.textContent = "Send another link";
        } catch (caught) {
          error.textContent =
            caught instanceof ApiError ? caught.message : "We could not reach the server. Please check your connection and try again.";
          error.hidden = false;
          submit.textContent = "Email me a link";
        } finally {
          submit.disabled = false;
        }
      },
    },
    h(
      "p",
      { class: "sign-in__intro" },
      "Enter the email address you sign in with. We will send a link to set a new password. It works once, for 30 minutes.",
    ),
    h("div", { class: "field" }, h("label", { class: "field__label", for: "reset-email" }, "Email address"), email),
    error,
    submit,
  );

  render(
    mount,
    authLayout(
      "Forgot your password?",
      form,
      sent,
      h(
        "p",
        { class: "sign-in__help" },
        h("a", { href: "/sign-in", onClick: go("/sign-in") }, "Back to sign in"),
        ". No email? The leasing office can give you a temporary password instead.",
      ),
    ),
  );
  email.focus();
}

/**
 * The page a reset link opens: /reset-password#token=… (020).
 *
 * The token rides after "#", which the browser never sends to a server, and is
 * taken out of the address bar as soon as it is read, so it does not linger in
 * history for the next person at a shared computer.
 */
export async function resetPassword(mount: HTMLElement): Promise<void> {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
  if (fromHash) {
    sessionStorage.setItem("portal.resetToken", fromHash);
    history.replaceState({}, "", "/reset-password");
  }
  const token = fromHash ?? sessionStorage.getItem("portal.resetToken") ?? "";

  let valid = false;
  try {
    valid = token.length > 0 && (await auth.checkResetToken(token)).valid;
  } catch {
    valid = false;
  }

  if (!valid) {
    sessionStorage.removeItem("portal.resetToken");
    render(
      mount,
      authLayout(
        "This link no longer works",
        h(
          "p",
          { class: "sign-in__intro" },
          "Reset links work once, for 30 minutes, and only the newest one works. " +
            "If you already set a new password with it, sign in with that password.",
        ),
        h(
          "div",
          { class: "row" },
          h("a", { class: "btn btn--primary", href: "/forgot-password", onClick: go("/forgot-password") }, "Send a new link"),
          h("a", { class: "btn btn--ghost", href: "/sign-in", onClick: go("/sign-in") }, "Sign in"),
        ),
      ),
    );
    return;
  }

  const error = h("p", { class: "field__error", role: "alert", hidden: true });
  const next = h("input", { class: "input", id: "new-password", type: "password", autocomplete: "new-password", required: true, minlength: 12 });
  const confirm = h("input", { class: "input", id: "confirm-password", type: "password", autocomplete: "new-password", required: true });
  const submit = h("button", { class: "btn btn--primary btn--lg btn--block", type: "submit" }, "Set new password");

  const form = h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onSubmit: async (event: SubmitEvent) => {
        event.preventDefault();
        error.hidden = true;
        if (next.value.length < 12) {
          error.textContent = "Use at least 12 characters.";
          error.hidden = false;
          next.focus();
          return;
        }
        if (next.value !== confirm.value) {
          error.textContent = "The two passwords do not match.";
          error.hidden = false;
          confirm.focus();
          return;
        }
        submit.disabled = true;
        submit.textContent = "Saving…";
        try {
          await auth.resetPassword(token, next.value);
          sessionStorage.removeItem("portal.resetToken");
          await refreshSession();
          toast("Your new password is set, and you are signed in. Any other sign-ins on this account were ended.", "good");
          navigate("/", { replace: true });
        } catch (caught) {
          error.textContent = caught instanceof ApiError ? caught.message : "Could not set the password. Please try again.";
          error.hidden = false;
        } finally {
          submit.disabled = false;
          submit.textContent = "Set new password";
        }
      },
    },
    h(
      "p",
      { class: "sign-in__intro" },
      "Choose a new password. Saving it signs you in here and signs this account out everywhere else.",
    ),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field__label", for: "new-password" }, "New password"),
      next,
      h(
        "span",
        { class: "field__hint" },
        "At least 12 characters. Length matters far more than symbols — a passphrase of ordinary words is a good password.",
      ),
    ),
    h("div", { class: "field" }, h("label", { class: "field__label", for: "confirm-password" }, "Confirm new password"), confirm),
    error,
    submit,
  );

  render(mount, authLayout("Set a new password", form));
  next.focus();
}

/**
 * Forced password change. A temporary password issued by the office is a
 * credential a second person knows, so the first thing a resident does with it
 * is replace it — and every other session for that account ends when they do.
 */
export async function changePassword(mount: HTMLElement): Promise<void> {
  const error = h("p", { class: "field__error", role: "alert", hidden: true });
  const current = h("input", { class: "input", id: "current", type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { class: "input", id: "next", type: "password", autocomplete: "new-password", required: true, minlength: 12 });
  const confirm = h("input", { class: "input", id: "confirm", type: "password", autocomplete: "new-password", required: true });
  const submit = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Set new password");

  const form = h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onSubmit: async (event: SubmitEvent) => {
        event.preventDefault();
        error.hidden = true;

        if (!current.value || !next.value) {
          error.textContent = "Enter your current password and a new one.";
          error.hidden = false;
          return;
        }

        if (next.value !== confirm.value) {
          error.textContent = "The two new passwords do not match.";
          error.hidden = false;
          return;
        }

        submit.disabled = true;
        try {
          await auth.changePassword(current.value, next.value);
          toast("Password changed. Other sessions were signed out.", "good");
          await refreshSession();
          navigate("/", { replace: true });
        } catch (caught) {
          error.textContent = caught instanceof ApiError ? caught.message : "Could not change the password.";
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h("div", { class: "field" }, h("label", { class: "field__label", for: "current" }, "Current password"), current),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field__label", for: "next" }, "New password"),
      next,
      h(
        "span",
        { class: "field__hint" },
        "At least 12 characters. Length matters far more than symbols — a passphrase of ordinary words is a good password.",
      ),
    ),
    h("div", { class: "field" }, h("label", { class: "field__label", for: "confirm" }, "Confirm new password"), confirm),
    error,
    submit,
  );

  render(
    mount,
    h(
      "div",
      { class: "container container--narrow stack stack--lg" },
      h("h1", {}, state.user?.mustChangePassword ? "Choose a new password" : "Change your password"),
      h(
        "p",
        { class: "lede" },
        state.user?.mustChangePassword
          ? "Your account is using a temporary password that someone at the office also knows. " +
              "Setting your own ends every other session on this account."
          : "Setting a new password signs this account out everywhere else.",
      ),
      h("div", { class: "card" }, form),
    ),
  );

  current.focus();
}
