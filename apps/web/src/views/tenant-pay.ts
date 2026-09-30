/**
 * Paying rent, and autopay.
 *
 * The care in this file is concentrated on the confirmation step, because that
 * is where the proposal's usability work says hesitation shows up: a person about
 * to move a large fraction of their monthly income wants to know exactly what
 * will be taken, from where, and when it will actually leave their account.
 *
 * Three specifics:
 *
 * The idempotency key is generated once, when the form is opened, and reused for
 * every retry of that attempt. A key generated per request would make a retry a
 * second charge, which is the exact failure this mechanism exists to prevent.
 *
 * The balance the screen showed is sent with the payment. If the ledger has
 * moved since the page loaded, the server refuses rather than charging a
 * different number than the one the person agreed to.
 *
 * The button is disabled for the whole round trip and says what it is doing.
 */

import { h, render, icon, ICONS, openDialog, closeDialog } from "../core/dom.ts";
import { tenant, ApiError, type TenantSummary } from "../core/api.ts";
import { navigate, reportError, state, toast } from "../core/app.ts";
import { date, money, parseAmount, PAYMENT_STATUS_LABELS, paymentStatusTone } from "../core/fmt.ts";
import type { AutopayEnrollment, PaymentMethodSummary } from "/shared/payments.js";

export async function tenantPay(mount: HTMLElement): Promise<void> {
  const data = await tenant.summary();
  render(mount, layout(data));

  if (location.hash === "#autopay") {
    document.getElementById("autopay")?.scrollIntoView({ block: "start" });
  }
}

function layout(data: TenantSummary): HTMLElement {
  return h(
    "div",
    { class: "container container--narrow stack stack--lg" },
    h(
      "header",
      {},
      h("h1", {}, "Pay rent"),
      h(
        "p",
        { class: "lede" },
        "Your balance is ",
        h("strong", { class: "money" }, money(data.balance.balanceCents)),
        data.balance.dueDate ? `, due ${date(data.balance.dueDate)}.` : ".",
      ),
    ),
    payForm(data),
    // The add form appears once: in the pay card when there is nothing to pay
    // with yet, otherwise here.
    methodsSection(data, data.paymentMethods.some((m) => m.verified && (data.cardsAccepted || m.kind !== "card"))),
    autopaySection(data),
    historySection(data),
  );
}

/* ------------------------------------------------------------------ *
 * The payment form
 * ------------------------------------------------------------------ */

function payForm(data: TenantSummary): HTMLElement {
  const balance = data.balance.balanceCents;
  // A card saved before the property went bank-only stays listed below, but
  // cannot be chosen here; the API refuses it too.
  const usable = data.paymentMethods.filter((m) => m.verified && (data.cardsAccepted || m.kind !== "card"));

  if (usable.length === 0) {
    return h(
      "section",
      { class: "card" },
      h("h2", { class: "card__title" }, "Add a way to pay"),
      h(
        "p",
        { class: "field__hint" },
        data.paymentMethods.some((m) => !m.verified)
          ? "Your bank account needs verifying before you can pay from it. Use “Verify” under Your payment methods, below."
          : data.paymentMethods.length > 0
            ? "This property takes bank transfers only. Add a bank account to pay — there is no fee."
            : "You have not added a payment method yet.",
      ),
      h("div", { class: "spacer", style: { height: "1rem" } }),
      addMethodForm(data.cardsAccepted),
    );
  }

  // One key for this form instance. Every retry of this attempt reuses it, so a
  // flaky connection cannot produce two charges.
  const idempotencyKey = crypto.randomUUID();

  const amountInput = h("input", {
    class: "input input--money",
    id: "amount",
    type: "text",
    inputmode: "decimal",
    value: balance > 0 ? (balance / 100).toFixed(2) : "",
    "aria-describedby": "amount-hint",
  });

  const methodInputs: HTMLInputElement[] = [];
  const methodChoices = h(
    "div",
    { class: "radio-cards" },
    ...usable.map((method, index) => {
      const input = h("input", {
        type: "radio",
        name: "method",
        value: method.id,
        checked: index === 0,
      });
      methodInputs.push(input);
      return h(
        "label",
        { class: "radio-card" },
        input,
        h(
          "span",
          { class: "radio-card__body" },
          h("span", { class: "radio-card__title" }, method.label),
          h(
            "span",
            { class: "radio-card__note" },
            method.kind === "ach"
              ? "Bank transfer — no fee, takes 3–5 business days to clear"
              : "Card — clears immediately",
          ),
        ),
      );
    }),
  );

  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "btn btn--primary btn--lg btn--block", type: "submit" }, "Review payment");

  const form = h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onSubmit: (event: SubmitEvent) => {
        event.preventDefault();
        error.hidden = true;

        const amountCents = parseAmount(amountInput.value);
        if (amountCents === null || amountCents <= 0) {
          error.textContent = "Enter an amount, like 1200.00";
          error.hidden = false;
          amountInput.focus();
          return;
        }

        const selected = methodInputs.find((input) => input.checked);
        const method = usable.find((m) => m.id === selected?.value);
        if (!method) {
          error.textContent = "Choose a payment method.";
          error.hidden = false;
          return;
        }

        showConfirmation({ amountCents, method, balance, idempotencyKey, error, form });
      },
    },
    h(
      "div",
      { class: "field" },
      h("label", { class: "field__label", for: "amount" }, "Amount"),
      h(
        "div",
        { class: "amount-input" },
        h("span", { class: "amount-input__symbol" }, "$"),
        amountInput,
      ),
      h(
        "span",
        { class: "field__hint", id: "amount-hint" },
        balance > 0
          ? `Your full balance is ${money(balance)}. You can pay less — a partial payment is recorded ` +
              `as a partial payment, not as a missed one.`
          : "You do not owe anything right now. Paying ahead leaves a credit on your account.",
      ),
    ),
    h("div", { class: "field" }, h("span", { class: "field__label" }, "Pay from"), methodChoices),
    error,
    submit,
  );

  return h("section", { class: "card" }, h("h2", { class: "card__title" }, "Make a payment"), form);
}

/**
 * The confirmation step.
 *
 * It exists because "how much, from where, and when does it actually leave my
 * account" are three separate questions, and a single-click pay button answers
 * none of them before the money is gone.
 */
function showConfirmation(options: {
  amountCents: number;
  method: PaymentMethodSummary;
  balance: number;
  idempotencyKey: string;
  error: HTMLElement;
  form: HTMLFormElement;
}): void {
  const { amountCents, method, balance, idempotencyKey } = options;
  const remaining = balance - amountCents;

  const confirmError = h("p", { class: "field__error", hidden: true, role: "alert" });
  const confirm = h("button", { class: "btn btn--primary btn--lg", type: "button" }, `Pay ${money(amountCents)}`);

  const panel = h(
    "div",
    { class: "confirm-panel", role: "group", "aria-label": "Confirm payment" },
    h("h3", { class: "confirm-panel__title" }, "Confirm this payment"),
    h(
      "dl",
      { class: "dl confirm-panel__details" },
      h("dt", {}, "Amount"),
      h("dd", { class: "money confirm-panel__amount" }, money(amountCents)),
      h("dt", {}, "From"),
      h("dd", {}, method.label),
      h("dt", {}, "When it clears"),
      h(
        "dd",
        {},
        method.kind === "ach"
          ? "3–5 business days. Your balance updates when the money lands, not today."
          : "Immediately.",
      ),
      h("dt", {}, "Balance after"),
      h(
        "dd",
        { class: "money" },
        remaining > 0
          ? `${money(remaining)} still owed`
          : remaining === 0
            ? "$0.00 — paid in full"
            : `${money(Math.abs(remaining))} credit`,
      ),
    ),
    method.kind === "ach"
      ? h(
          "p",
          { class: "confirm-panel__note" },
          icon(ICONS.clock, 15),
          h(
            "span",
            {},
            "Bank transfers can be returned by your bank for several days after they appear to go " +
              "through. If that happens you will be told straight away, the amount goes back on your " +
              "balance, and late fees are paused while it is sorted out.",
          ),
        )
      : null,
    confirmError,
    h(
      "div",
      { class: "row" },
      confirm,
      h(
        "button",
        {
          class: "btn btn--ghost",
          type: "button",
          onClick: () => panel.remove(),
        },
        "Go back",
      ),
    ),
  );

  confirm.addEventListener("click", async () => {
    confirmError.hidden = true;
    confirm.disabled = true;
    confirm.setAttribute("aria-busy", "true");
    confirm.textContent = "Sending…";

    try {
      const result = await tenant.pay(
        { amountCents, paymentMethodId: method.id, expectedBalanceCents: balance },
        idempotencyKey,
      );

      if (result.payment.status === "failed") {
        confirmError.textContent =
          result.payment.failureMessage ?? "That payment did not go through. Nothing was taken.";
        confirmError.hidden = false;
        confirm.disabled = false;
        confirm.removeAttribute("aria-busy");
        confirm.textContent = `Pay ${money(amountCents)}`;
        return;
      }

      toast(
        result.deduplicated
          ? "That payment was already submitted — you have not been charged twice."
          : method.kind === "ach"
            ? "Payment submitted. It will clear in a few business days."
            : "Payment submitted.",
        "good",
      );
      navigate("/");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        // The ledger moved under them. Say so plainly rather than charging a
        // number they never saw.
        confirmError.textContent = caught.message;
        confirmError.hidden = false;
      } else if (caught instanceof ApiError) {
        confirmError.textContent = caught.message;
        confirmError.hidden = false;
      } else {
        reportError(caught);
      }
      confirm.disabled = false;
      confirm.removeAttribute("aria-busy");
      confirm.textContent = `Pay ${money(amountCents)}`;
    }
  });

  options.form.appendChild(panel);
  panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  confirm.focus();
}

/* ------------------------------------------------------------------ *
 * Payment methods
 * ------------------------------------------------------------------ */

function methodsSection(data: TenantSummary, showAddForm: boolean): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h("h2", { class: "card__title" }, "Your payment methods"),
    data.paymentMethods.length === 0
      ? h("p", { class: "field__hint" }, "None yet.")
      : h(
          "ul",
          { class: "method-list" },
          ...data.paymentMethods.map((method) =>
            h(
              "li",
              { class: "method-list__item" },
              h(
                "div",
                {},
                h("span", { class: "method-list__label" }, method.label),
                h(
                  "span",
                  { class: "method-list__meta" },
                  method.kind === "ach" ? "Bank account" : "Card",
                  method.kind === "card" && !data.cardsAccepted ? " · not accepted here (bank transfers only)" : "",
                  method.verified
                    ? ""
                    : method.verificationLocked
                      ? " · locked after wrong amounts — the office will contact you"
                      : " · needs verifying",
                  method.isAutopayDefault ? " · used for autopay" : "",
                ),
              ),
              h(
                "div",
                { class: "row row--tight" },
                method.kind === "ach" && !method.verified && !method.verificationLocked
                  ? h("button", { class: "btn btn--ghost", type: "button", onClick: () => openVerifyDialog(method) }, "Verify")
                  : null,
                removeButton(method.id),
              ),
            ),
          ),
        ),
    showAddForm ? h("div", { style: { height: "1rem" } }) : null,
    showAddForm ? addMethodForm(data.cardsAccepted) : null,
  );
}

/** Two clicks to remove, so a stray tap cannot delete someone's bank account. */
function removeButton(methodId: string): HTMLButtonElement {
  let armed = false;
  let timer: ReturnType<typeof setTimeout>;
  const button: HTMLButtonElement = h(
    "button",
    {
      class: "btn btn--quiet",
      type: "button",
      onClick: async () => {
        if (!armed) {
          armed = true;
          button.textContent = "Confirm remove";
          button.classList.add("btn--danger");
          timer = setTimeout(() => {
            armed = false;
            button.textContent = "Remove";
            button.classList.remove("btn--danger");
          }, 5000);
          return;
        }
        clearTimeout(timer);
        button.disabled = true;
        try {
          await tenant.removePaymentMethod(methodId);
          toast("Payment method removed.", "good");
          navigate("/pay");
        } catch (caught) {
          reportError(caught);
          button.disabled = false;
        }
      },
    },
    "Remove",
  );
  return button;
}

/**
 * Micro-deposit verification: two small deposits arrive in the account within
 * a day or two; typing them back proves the account is yours. Three wrong tries
 * lock it for the office to review.
 */
function openVerifyDialog(method: PaymentMethodSummary): void {
  const first = h("input", { class: "input input--money", id: "dep-1", inputmode: "numeric", placeholder: "32", maxlength: "2", required: true });
  const second = h("input", { class: "input input--money", id: "dep-2", inputmode: "numeric", placeholder: "45", maxlength: "2", required: true });
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Verify account");

  const dialog = h(
    "dialog",
    { class: "dialog" },
    h(
      "form",
      {
        method: "dialog",
        onSubmit: async (event: SubmitEvent) => {
          event.preventDefault();
          error.hidden = true;
          const a = Number(first.value.replace(/\D/g, ""));
          const b = Number(second.value.replace(/\D/g, ""));
          if (!(a >= 1 && a <= 99 && b >= 1 && b <= 99)) {
            error.textContent = "Enter each deposit in cents — for $0.32, type 32.";
            error.hidden = false;
            return;
          }
          submit.disabled = true;
          try {
            await tenant.verifyBank(method.id, [a, b]);
            closeDialog(dialog);
            toast("Bank account verified. You can pay from it now.", "good");
            navigate("/pay");
          } catch (caught) {
            error.textContent = caught instanceof ApiError ? caught.message : "Could not verify that.";
            error.hidden = false;
            submit.disabled = false;
          }
        },
      },
      h("div", { class: "dialog__header" }, h("h2", { class: "dialog__title" }, `Verify ${method.label}`)),
      h(
        "div",
        { class: "dialog__body" },
        h(
          "p",
          { class: "field__hint" },
          "Two small deposits (under $1 each) were sent to this account. They take one to two business days to appear. " +
            "Enter the amounts in cents, in any order.",
        ),
        method.simulatedDepositsCents
          ? h(
              "div",
              { class: "notice notice--info" },
              h(
                "div",
                { class: "notice__body" },
                h("span", { class: "notice__title" }, "Simulated payments"),
                h("span", {}, `This portal is running without a real processor. The test deposits are ${method.simulatedDepositsCents[0]}¢ and ${method.simulatedDepositsCents[1]}¢.`),
              ),
            )
          : null,
        h(
          "div",
          { class: "row" },
          h("label", { class: "field", for: "dep-1" }, h("span", { class: "field__label" }, "First deposit (¢)"), first),
          h("label", { class: "field", for: "dep-2" }, h("span", { class: "field__label" }, "Second deposit (¢)"), second),
        ),
        h("p", { class: "field__hint" }, `${method.verificationAttemptsLeft} ${method.verificationAttemptsLeft === 1 ? "try" : "tries"} left.`),
        error,
      ),
      h(
        "div",
        { class: "dialog__footer" },
        h("button", { class: "btn btn--ghost", type: "button", onClick: () => closeDialog(dialog) }, "Cancel"),
        submit,
      ),
    ),
  ) as HTMLDialogElement;
  document.body.appendChild(dialog);
  openDialog(dialog);
}

/**
 * In this build the provider token is produced by the mock provider. With Stripe
 * configured, this is where Stripe Elements or Plaid Link mounts and hands back
 * a token — the card number and full account number never reach our server,
 * which is what keeps a self-hosted operator out of full PCI scope.
 */
function addMethodForm(cardsAccepted: boolean): HTMLElement {
  const kind = h("select", { class: "select", id: "method-kind" },
    h("option", { value: "ach" }, "Bank account (no fee)"),
    cardsAccepted ? h("option", { value: "card" }, "Debit or credit card") : null,
  );
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "btn btn--ghost", type: "submit" }, "Add payment method");

  return h(
    "form",
    {
      class: "stack stack--sm",
      onSubmit: async (event: SubmitEvent) => {
        event.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          await tenant.addPaymentMethod({
            kind: kind.value as "ach" | "card",
            providerToken: `demo_${crypto.randomUUID()}`,
          });
          toast("Payment method added.", "good");
          navigate("/pay");
        } catch (caught) {
          error.textContent = caught instanceof ApiError ? caught.message : "Could not add that.";
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h("div", { class: "field" }, h("label", { class: "field__label", for: "method-kind" }, "Add a new method"), kind),
    h(
      "span",
      { class: "field__hint" },
      "With a live payment provider configured, this is where the provider's own secure form appears. " +
        "Your full card or account number is never sent to this server.",
    ),
    error,
    submit,
  );
}

/* ------------------------------------------------------------------ *
 * Autopay
 * ------------------------------------------------------------------ */

function autopaySection(data: TenantSummary): HTMLElement {
  const me = state.user?.id;
  const all = data.balance.leaseAutopays ?? (data.balance.autopay ? [data.balance.autopay] : []);
  const mine = all.find((a) => a.setUpByUserId === me) ?? (data.balance.autopay?.setUpByMe ? data.balance.autopay : null);
  const others = all.filter((a) => a !== mine && a.setUpByUserId !== me);
  const members = data.leaseMembers ?? [];
  const shared = members.length > 1;
  const wholeByOther = others.find((a) => a.shareCents == null) ?? null;

  const card = h("section", { class: "card stack", id: "autopay" });
  const parts: Array<HTMLElement | null> = [];

  if (mine) {
    parts.push(h("h2", { class: "card__title" }, mine.shareCents != null ? "Autopay is on for your share" : "Autopay is on"));
    parts.push(myAutopay(mine));
  } else if (wholeByOther) {
    parts.push(h("h2", { class: "card__title" }, "Autopay is on"));
  } else {
    parts.push(h("h2", { class: "card__title" }, shared ? "Autopay for your share" : "Set up autopay"));
  }

  // On a shared lease, everyone sees who has autopay and for what (021).
  if (shared && others.length > 0) {
    parts.push(
      h(
        "div",
        { class: "autopay-lease" },
        h("h3", { class: "autopay-lease__title" }, "Others on your lease"),
        h(
          "ul",
          { class: "autopay-lease__list" },
          ...others.map((a) =>
            h(
              "li",
              {},
              h("strong", {}, a.setUpByName ?? "Another resident"),
              a.shareCents != null
                ? ` — their share, ${money(a.shareCents)}, on the ${ordinal(a.dayOfMonth)} of each month`
                : ` — the whole balance, on the ${ordinal(a.dayOfMonth)} of each month`,
            ),
          ),
        ),
      ),
    );
  }

  if (!mine && wholeByOther) {
    parts.push(
      h(
        "p",
        { class: "field__hint" },
        `${wholeByOther.setUpByName ?? "Another resident on your lease"} set up autopay for the whole balance from their own bank account, ` +
          "so it covers you too and only they can change it. You can still pay any amount yourself. " +
          "If you would rather split the rent, they can turn theirs off and each of you can set up autopay for your own share.",
      ),
    );
  }

  const canSetUp = !wholeByOther || mine !== null;
  if (canSetUp) {
    const form = autopayForm(data, { mine, sharedLease: shared, othersHaveAutopay: others.length > 0, members: members.length });
    if (mine) {
      form.hidden = true;
      const change = h(
        "button",
        {
          class: "btn btn--ghost",
          type: "button",
          onClick: () => {
            form.hidden = !form.hidden;
            change.textContent = form.hidden ? "Change autopay" : "Keep it as it is";
          },
        },
        "Change autopay",
      );
      parts.push(
        h(
          "div",
          { class: "row" },
          change,
          h(
            "button",
            {
              class: "btn btn--ghost",
              type: "button",
              onClick: async () => {
                try {
                  await tenant.cancelAutopay();
                  toast(shared ? "Your autopay is off. Anyone else's on your lease is unchanged." : "Autopay turned off.", "good");
                  navigate("/pay");
                } catch (caught) {
                  reportError(caught);
                }
              },
            },
            "Turn off autopay",
          ),
        ),
      );
    }
    parts.push(form);
  }

  card.append(...parts.filter((p): p is HTMLElement => p !== null));
  return card;
}

function myAutopay(enrollment: AutopayEnrollment): HTMLElement {
  return h(
    "div",
    { class: "stack stack--sm" },
    h(
      "dl",
      { class: "dl" },
      enrollment.shareCents != null ? h("dt", {}, "Your share") : null,
      enrollment.shareCents != null ? h("dd", {}, `${money(enrollment.shareCents)} each month`) : null,
      h("dt", {}, "From"),
      h("dd", {}, enrollment.methodLabel),
      h("dt", {}, "Each month on the"),
      h("dd", {}, String(enrollment.dayOfMonth)),
      h("dt", {}, "Limit"),
      h(
        "dd",
        {},
        enrollment.capCents
          ? `${money(enrollment.capCents)} — anything above this will not draft automatically`
          : "No limit set",
      ),
      enrollment.nextDraftDate ? h("dt", {}, "Next draft") : null,
      enrollment.nextDraftDate
        ? h(
            "dd",
            {},
            enrollment.shareCents != null
              ? // A share is drafted after that month's rent posts, so today's
                // balance understates it; say what it will take at most.
                `Up to ${money(Math.max(0, enrollment.shareCents - (enrollment.paidByHandThisCycleCents ?? 0)))} on ${date(enrollment.nextDraftDate)}`
              : `${money(enrollment.nextDraftAmountCents ?? 0)} on ${date(enrollment.nextDraftDate)}`,
          )
        : null,
    ),
    enrollment.shareCents != null && (enrollment.paidByHandThisCycleCents ?? 0) > 0
      ? h(
          "p",
          { class: "field__hint" },
          `You already paid ${money(enrollment.paidByHandThisCycleCents ?? 0)} yourself since your last draft, so the next one takes only the rest of your share.`,
        )
      : null,
    enrollment.shareCents != null
      ? h(
          "p",
          { class: "field__hint" },
          "A share draft never takes more than the lease still owes, so if your roommates have already paid, it takes less or nothing.",
        )
      : null,
    enrollment.nextDraftBlockedReason
      ? h("div", { class: "notice notice--warn" }, h("div", { class: "notice__body" }, h("span", {}, enrollment.nextDraftBlockedReason)))
      : null,
  );
}

function autopayForm(
  data: TenantSummary,
  options: { mine: AutopayEnrollment | null; sharedLease: boolean; othersHaveAutopay: boolean; members: number },
): HTMLElement {
  const usable = data.paymentMethods.filter((m) => m.verified && (data.cardsAccepted || m.kind !== "card"));
  if (usable.length === 0) {
    return h("p", { class: "field__hint" }, "Add and verify a bank account above first. Autopay always draws on your own account.");
  }

  const { mine, sharedLease, othersHaveAutopay } = options;
  const rent = data.balance.nextChargeCents ?? 0;
  const suggestedShare = mine?.shareCents ?? Math.round(rent / Math.max(1, options.members));

  // What autopay takes. Only a shared lease is offered the choice; the whole
  // balance is not possible once someone else has autopay (021).
  const shareMode = h("input", { type: "radio", name: "autopay-mode", value: "share", id: "autopay-mode-share" });
  const wholeMode = h("input", { type: "radio", name: "autopay-mode", value: "whole", id: "autopay-mode-whole" });
  const wholeAllowed = !othersHaveAutopay;
  const startWithShare = sharedLease && (mine ? mine.shareCents != null : true);
  shareMode.checked = startWithShare;
  wholeMode.checked = !startWithShare;
  wholeMode.disabled = !wholeAllowed;

  const share = h("input", {
    class: "input input--money",
    id: "autopay-share",
    type: "text",
    inputmode: "decimal",
    value: (suggestedShare / 100).toFixed(2),
  });
  const shareField = h(
    "div",
    { class: "field" },
    h("label", { class: "field__label", for: "autopay-share" }, "Your share each month"),
    h("div", { class: "amount-input" }, h("span", { class: "amount-input__symbol" }, "$"), share),
    h(
      "span",
      { class: "field__hint" },
      "Agree the split with your roommates. If you pay part of it yourself during the month, the draft takes only the rest.",
    ),
  );

  const methodSelect = h(
    "select",
    { class: "select", id: "autopay-method" },
    ...usable.map((method) => h("option", { value: method.id, selected: method.id === mine?.paymentMethodId }, method.label)),
  );
  const day = h("input", { class: "input", id: "autopay-day", type: "number", min: 1, max: 28, value: mine?.dayOfMonth ?? 1 });
  const capEnabled = h("input", { type: "checkbox", checked: mine ? mine.capCents != null : true });
  const cap = h("input", {
    class: "input input--money",
    id: "autopay-cap",
    type: "text",
    inputmode: "decimal",
    value: ((mine?.capCents ?? Math.round(rent * 1.25)) / 100).toFixed(2),
  });
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, mine ? "Save changes" : "Turn on autopay");

  const syncMode = () => {
    shareField.hidden = !shareMode.checked;
  };
  shareMode.addEventListener("change", syncMode);
  wholeMode.addEventListener("change", syncMode);
  syncMode();

  const modeChoice = sharedLease
    ? h(
        "fieldset",
        { class: "field autopay-mode" },
        h("legend", { class: "field__label" }, "What should autopay take?"),
        h(
          "label",
          { class: "checkbox", for: "autopay-mode-share" },
          shareMode,
          h(
            "span",
            {},
            h("strong", {}, "My share of the rent"),
            h("span", { class: "field__hint", style: { display: "block" } }, "A set amount each month, from your own bank account. Each roommate can set up their own."),
          ),
        ),
        h(
          "label",
          { class: "checkbox", for: "autopay-mode-whole" },
          wholeMode,
          h(
            "span",
            {},
            h("strong", {}, "The whole balance"),
            h(
              "span",
              { class: "field__hint", style: { display: "block" } },
              wholeAllowed
                ? "Everything the lease owes, from your account. Then no one else on the lease can add autopay."
                : "Not available: someone else on your lease already has autopay, and this would take the rent twice.",
            ),
          ),
        ),
      )
    : null;

  return h(
    "form",
    {
      class: "stack",
      onSubmit: async (event: SubmitEvent) => {
        event.preventDefault();
        error.hidden = true;
        const capCents = capEnabled.checked ? parseAmount(cap.value) : null;
        if (capEnabled.checked && (capCents === null || capCents <= 0)) {
          error.textContent = "Enter a limit, or uncheck the box.";
          error.hidden = false;
          return;
        }
        let shareCents: number | null = null;
        if (sharedLease && shareMode.checked) {
          shareCents = parseAmount(share.value);
          if (shareCents === null || shareCents <= 0) {
            error.textContent = "Enter your share, for example 600.00.";
            error.hidden = false;
            share.focus();
            return;
          }
        }
        submit.disabled = true;
        try {
          await tenant.enrollAutopay({
            paymentMethodId: methodSelect.value,
            dayOfMonth: Number(day.value),
            capCents,
            shareCents,
          });
          toast(
            shareCents !== null
              ? `Autopay is on for your share of ${money(shareCents)}. You will be told three days before each draft.`
              : "Autopay is on. You will be told three days before each draft.",
            "good",
          );
          navigate("/pay");
        } catch (caught) {
          error.textContent = caught instanceof ApiError ? caught.message : "Could not set that up.";
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    },
    modeChoice,
    sharedLease ? shareField : null,
    h("div", { class: "field" }, h("label", { class: "field__label", for: "autopay-method" }, "Draft from"), methodSelect),
    h(
      "div",
      { class: "field" },
      h("label", { class: "field__label", for: "autopay-day" }, "Day of the month"),
      day,
      h("span", { class: "field__hint" }, "1 to 28, so the date exists in every month."),
    ),
    h(
      "div",
      { class: "field" },
      h(
        "label",
        { class: "checkbox" },
        capEnabled,
        h(
          "span",
          {},
          h("strong", {}, "Set a limit on what can be drafted"),
          h(
            "span",
            { class: "field__hint", style: { display: "block" } },
            "Strongly recommended. If a charge ever pushes the amount above this, autopay will " +
              "not draft it — you will be told instead, and nothing will be taken. This is your " +
              "protection against a billing mistake becoming an unexpected withdrawal.",
          ),
        ),
      ),
      h("div", { class: "amount-input" }, h("span", { class: "amount-input__symbol" }, "$"), cap),
    ),
    h("p", { class: "field__hint" }, "You will get an email three days before every draft telling you the amount and the date."),
    error,
    submit,
  );
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

function historySection(data: TenantSummary): HTMLElement {
  const pending = data.balance.pendingPayments ?? [];
  if (pending.length === 0) return h("div", {});

  return h(
    "section",
    { class: "card card--flush" },
    h("div", { class: "card__header card__header--padded" }, h("h2", { class: "card__title" }, "In progress")),
    h(
      "ul",
      { class: "entry-list" },
      ...pending.map((payment) =>
        h(
          "li",
          { class: "entry" },
          h(
            "div",
            { class: "entry__main" },
            h("span", { class: "entry__description" }, payment.methodLabel ?? payment.method),
            h("span", { class: "entry__meta" }, `Submitted ${date(payment.submittedAt)}`),
          ),
          h("span", { class: "entry__amount money" }, money(payment.amountCents)),
          h(
            "span",
            { class: `badge badge--${paymentStatusTone(payment.status)}` },
            PAYMENT_STATUS_LABELS[payment.status] ?? payment.status,
          ),
        ),
      ),
    ),
  );
}
