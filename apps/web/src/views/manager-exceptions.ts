/**
 * The exception queue — the manager's front door.
 *
 * This component inverts the usual dashboard. A manager's month-end problem is
 * not viewing two hundred rows; it is finding the four that need a person. So
 * the queue is what opens, ordered by severity and then by age, with the full
 * rent roll a click away rather than the other way round.
 *
 * Each row carries the actions that make sense for it, and the humane action is
 * listed first where there is one: a payment plan before a demand, a waiver
 * before an escalation. That ordering is a design position, not an accident —
 * the system should make the decent option the easy one.
 */

import { h, render, icon, ICONS, openDialog, closeDialog } from "../core/dom.ts";
import { manager, ApiError } from "../core/api.ts";
import { can, navigate, reportError, toast, state } from "../core/app.ts";
import { openNewThreadDialog } from "./messages.ts";
import { date, dateTime, money, parseAmount, relativeDays, todayIso } from "../core/fmt.ts";
import { EXCEPTION_LABELS } from "/shared/api.js";
import type { ExceptionRow } from "/shared/api.js";

const ACTION_LABELS: Record<string, string> = {
  contact_resident: "Message resident",
  open_payment_plan: "Open a payment plan",
  waive_fee: "Waive a fee",
  record_payment: "Record an offline payment",
  review_charge: "Review the charge",
  respond_to_dispute: "Respond",
  revise_plan: "Revise the plan",
  review_ledger: "Open the ledger",
  post_refund: "Review the credit",
};

export async function managerExceptions(mount: HTMLElement): Promise<void> {
  const [data, roll] = await Promise.all([manager.exceptions(), manager.rentRoll()]);

  const urgent = data.rows.filter((row) => row.severity >= 60);
  const rest = data.rows.filter((row) => row.severity < 60);

  render(
    mount,
    h(
      "div",
      { class: "container container--wide stack stack--lg" },
      h(
        "header",
        { class: "page-header" },
        h(
          "div",
          {},
          h("h1", {}, "Updates"),
          h(
            "p",
            { class: "lede" },
            data.rows.length === 0
              ? "Nothing outstanding. Every account is either square or on its way there."
              : `${data.rows.length} item${data.rows.length === 1 ? "" : "s"} across ${roll.totals.units} occupied units. ` +
                `Ordered by what will cost someone the most if it waits.`,
          ),
        ),
        h(
          "div",
          { class: "row row--tight" },
          h("span", { class: "perf-note" }, `computed in ${data.generatedInMs}ms`),
        ),
      ),

      statsRow(roll),

      urgent.length > 0
        ? h(
            "section",
            { class: "stack stack--sm" },
            h("h2", { class: "section-title" }, "Urgent"),
            ...urgent.map((row) => exceptionCard(row, true)),
          )
        : null,

      rest.length > 0
        ? h(
            "section",
            { class: "stack stack--sm" },
            h("h2", { class: "section-title" }, urgent.length > 0 ? "Everything else" : "Outstanding"),
            ...rest.map((row) => exceptionCard(row, false)),
          )
        : null,

      data.rows.length === 0
        ? h(
            "div",
            { class: "card" },
            h(
              "div",
              { class: "empty" },
              h("p", { class: "empty__title" }, "Queue is clear"),
              h("p", {}, "Nothing needs a decision right now."),
            ),
          )
        : null,
    ),
  );
}

function statsRow(roll: Awaited<ReturnType<typeof manager.rentRoll>>): HTMLElement {
  const rate = Math.round(roll.totals.collectionRate * 100);
  return h(
    "div",
    { class: "stat-row" },
    stat("Charged this period", money(roll.totals.chargedCents)),
    stat("Collected", money(roll.totals.collectedCents), rate >= 95 ? "good" : rate >= 85 ? "warn" : "bad"),
    stat("Outstanding", money(roll.totals.outstandingCents), roll.totals.outstandingCents > 0 ? "warn" : "good"),
    stat("Collection rate", `${rate}%`, rate >= 95 ? "good" : rate >= 85 ? "warn" : "bad"),
    stat("Occupied units", String(roll.totals.units)),
  );
}

function stat(label: string, value: string, tone?: string): HTMLElement {
  return h(
    "div",
    { class: "stat" },
    h("span", { class: "stat__label" }, label),
    h("span", { class: ["stat__value", "money", tone && `stat__value--${tone}`] }, value),
  );
}

function exceptionCard(row: ExceptionRow, urgent: boolean): HTMLElement {
  return h(
    "article",
    { class: ["exception", urgent && "exception--urgent"] },
    h(
      "div",
      { class: "exception__severity", "aria-hidden": "true" },
      h("span", { class: `severity-dot severity-dot--${toneFor(row.kind)}` }),
    ),

    h(
      "div",
      { class: "exception__body" },
      h(
        "div",
        { class: "exception__head" },
        h("span", { class: `badge badge--${toneFor(row.kind)}` }, EXCEPTION_LABELS[row.kind] ?? row.kind),
        h(
          "button",
          {
            class: "exception__unit",
            type: "button",
            onClick: () => navigate(`/manage/tenancy/${row.tenancyId}`),
          },
          `Unit ${row.unitLabel}`,
        ),
        h("span", { class: "exception__resident" }, row.residentName),
        h("span", { class: "exception__age" }, relativeDays(row.occurredAt.slice(0, 10))),
      ),
      h("p", { class: "exception__detail" }, row.detail),
      h(
        "div",
        { class: "exception__actions" },
        ...row.suggestedActions.filter(allowed).map((action, index) =>
          h(
            "button",
            {
              class: index === 0 ? "btn btn--ghost" : "btn btn--quiet",
              type: "button",
              onClick: () => runAction(action, row),
            },
            ACTION_LABELS[action] ?? action,
          ),
        ),
        h(
          "button",
          {
            class: "btn btn--quiet",
            type: "button",
            onClick: () => navigate(`/manage/tenancy/${row.tenancyId}`),
          },
          "Open account",
          icon(ICONS.chevronRight, 14),
        ),
      ),
    ),

    h("div", { class: "exception__amount money" }, money(row.amountCents)),
  );
}

function toneFor(kind: string): string {
  if (kind === "payment_returned" || kind === "payment_failed") return "bad";
  if (kind === "dispute_open" || kind === "autopay_blocked" || kind === "plan_missed") return "warn";
  if (kind === "unapplied_credit") return "info";
  if (kind === "severely_past_due") return "bad";
  return "warn";
}

/**
 * Which suggested actions this person can actually carry out. Owners are
 * read-only and have no messages, so they see only the actions that open
 * something; a button that ends in "you do not have access" is not offered.
 */
function allowed(action: string): boolean {
  switch (action) {
    case "open_payment_plan":
    case "record_payment":
    case "waive_fee":
    case "revise_plan":
      return can("ledger:write:discretionary");
    case "respond_to_dispute":
      return can("dispute:respond");
    case "contact_resident":
      return state.user?.role === "manager";
    default:
      return true;
  }
}

function runAction(action: string, row: ExceptionRow): void {
  switch (action) {
    case "contact_resident":
      void openNewThreadDialog({
        tenancyId: row.tenancyId,
        topic: "payment",
        subject: `${EXCEPTION_LABELS[row.kind]} — unit ${row.unitLabel}`,
        ledgerEntryId: row.ledgerEntryId ?? undefined,
      });
      break;
    case "open_payment_plan":
      openPlanDialog(row);
      break;
    case "record_payment":
      openRecordPaymentDialog(row);
      break;
    case "respond_to_dispute":
      if (row.disputeId) openDisputeDialog(row);
      else navigate(`/manage/tenancy/${row.tenancyId}`);
      break;
    case "waive_fee":
    case "review_charge":
    case "review_ledger":
      navigate(`/manage/tenancy/${row.tenancyId}`);
      break;
    default:
      navigate(`/manage/tenancy/${row.tenancyId}`);
  }
}

/* ------------------------------------------------------------------ *
 * Discretionary action dialogs
 *
 * Every one of these requires a written reason. That is enforced by the API
 * schema, not only here — but the form says why it is asking, because a manager
 * typing "per conversation 9/14" is the difference between a resident who was
 * granted grace and a resident who cannot prove they were.
 * ------------------------------------------------------------------ */

function dialogShell(title: string, body: HTMLElement[], onSubmit: () => Promise<void>, submitLabel: string): HTMLDialogElement {
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, submitLabel);

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
          submit.disabled = true;
          try {
            await onSubmit();
            closeDialog(dialog);
          } catch (caught) {
            error.textContent = caught instanceof ApiError ? caught.message : "That did not work.";
            error.hidden = false;
            submit.disabled = false;
          }
        },
      },
      h("div", { class: "dialog__header" }, h("h2", { class: "dialog__title" }, title)),
      h("div", { class: "dialog__body" }, ...body, error),
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
  return dialog;
}

export function openPlanDialog(row: { tenancyId: string; unitLabel: string; residentName: string; amountCents: number }): void {
  const total = h("input", {
    class: "input input--money",
    type: "text",
    inputmode: "decimal",
    value: (row.amountCents / 100).toFixed(2),
  });
  const installments = h("input", { class: "input", type: "number", min: 2, max: 12, value: 3 });
  const firstDue = h("input", { class: "input", type: "date", value: todayIso() });
  const interval = h("input", { class: "input", type: "number", min: 7, max: 31, value: 30 });
  const suspend = h("input", { type: "checkbox", checked: true });
  const reason = h("textarea", {
    class: "textarea",
    required: true,
    placeholder: "What was agreed, and why. The resident sees this on their ledger.",
  });

  dialogShell(
    `Payment plan — Unit ${row.unitLabel}`,
    [
      h("p", { class: "field__hint" }, `For ${row.residentName}.`),
      field("Total to spread", h("div", { class: "amount-input" }, h("span", { class: "amount-input__symbol" }, "$"), total)),
      field("Number of installments", installments),
      field("First installment due", firstDue),
      field("Days between installments", interval),
      h(
        "label",
        { class: "checkbox" },
        suspend,
        h(
          "span",
          {},
          h("strong", {}, "Pause late fees while the plan is followed"),
          h(
            "span",
            { class: "field__hint", style: { display: "block" } },
            "Recommended. A plan that still accrues fees is not really a plan.",
          ),
        ),
      ),
      field(
        "Reason",
        reason,
        "Required. This is recorded permanently on the ledger with your name, and the resident reads it.",
      ),
    ],
    async () => {
      const totalCents = parseAmount(total.value);
      if (!totalCents) throw new ApiError(400, "bad", "Enter a valid amount.");
      await manager.openPlan({
        tenancyId: row.tenancyId,
        totalCents,
        installments: Number(installments.value),
        firstDueDate: firstDue.value,
        intervalDays: Number(interval.value),
        reason: reason.value,
        suspendLateFees: suspend.checked,
      });
      toast("Payment plan opened. The resident has been told.", "good");
      navigate(location.pathname + location.search);
    },
    "Open plan",
  );
}

export function openRecordPaymentDialog(row: { tenancyId: string; unitLabel: string; amountCents: number }): void {
  const amount = h("input", {
    class: "input input--money",
    type: "text",
    inputmode: "decimal",
    value: (row.amountCents / 100).toFixed(2),
  });
  const method = h(
    "select",
    { class: "select" },
    h("option", { value: "check" }, "Check"),
    h("option", { value: "cash" }, "Cash"),
    h("option", { value: "money_order" }, "Money order"),
  );
  const received = h("input", { class: "input", type: "date", value: todayIso() });
  const reference = h("input", { class: "input", placeholder: "Check number, receipt number" });
  const reason = h("textarea", { class: "textarea", required: true, placeholder: "Where this payment came from." });

  dialogShell(
    `Record a payment — Unit ${row.unitLabel}`,
    [
      field("Amount received", h("div", { class: "amount-input" }, h("span", { class: "amount-input__symbol" }, "$"), amount)),
      field("How it was paid", method),
      field("Date received", received, "The date the money actually arrived, not today's date."),
      field("Reference", reference),
      field("Note", reason, "Required. Appears on the resident's ledger with your name."),
    ],
    async () => {
      const amountCents = parseAmount(amount.value);
      if (!amountCents) throw new ApiError(400, "bad", "Enter a valid amount.");
      await manager.recordPayment({
        tenancyId: row.tenancyId,
        amountCents,
        method: method.value as "check" | "cash" | "money_order",
        receivedOn: received.value,
        reference: reference.value || undefined,
        reason: reason.value,
      });
      toast("Payment recorded. A receipt was sent to the resident.", "good");
      navigate(location.pathname + location.search);
    },
    "Record payment",
  );
}

export function openWaiveDialog(entry: { id: string; description: string; amountCents: number }): void {
  const amount = h("input", {
    class: "input input--money",
    type: "text",
    inputmode: "decimal",
    value: (entry.amountCents / 100).toFixed(2),
  });
  const reason = h("textarea", { class: "textarea", required: true, placeholder: "Why this fee is being removed." });

  dialogShell(
    "Waive a charge",
    [
      h("p", {}, h("strong", {}, entry.description), ` — ${money(entry.amountCents)}`),
      field("Amount to waive", h("div", { class: "amount-input" }, h("span", { class: "amount-input__symbol" }, "$"), amount), "You can waive part of it."),
      field(
        "Reason",
        reason,
        "Required. The original charge stays on the ledger with this waiver beside it, so the record " +
          "shows both that it was charged and that you removed it.",
      ),
    ],
    async () => {
      const amountCents = parseAmount(amount.value);
      if (!amountCents) throw new ApiError(400, "bad", "Enter a valid amount.");
      await manager.waiveFee({ ledgerEntryId: entry.id, amountCents, reason: reason.value });
      toast("Waived. The resident has been told.", "good");
      navigate(location.pathname);
    },
    "Waive it",
  );
}

export function openDisputeDialog(row: { disputeId: string | null; unitLabel: string; detail: string; amountCents: number }): void {
  if (!row.disputeId) return;

  const response = h("textarea", {
    class: "textarea",
    required: true,
    placeholder: "Explain what you found. The resident reads this, attached to the charge.",
  });
  const resolutionInputs: HTMLInputElement[] = [];
  const adjustment = h("input", {
    class: "input input--money",
    type: "text",
    inputmode: "decimal",
    value: (row.amountCents / 100).toFixed(2),
  });
  const adjustmentField = h(
    "div",
    { hidden: true },
    field("Amount to credit back", h("div", { class: "amount-input" }, h("span", { class: "amount-input__symbol" }, "$"), adjustment)),
  );

  const choices = h(
    "div",
    { class: "radio-cards" },
    ...(
      [
        ["adjusted", "Correct it", "Post a reversal for all or part of the charge."],
        ["upheld", "The charge stands", "Explain why. Nothing changes on the ledger."],
        ["responded", "Reply without deciding yet", "Keeps the dispute open, and fees stay paused."],
      ] as const
    ).map(([value, title, note], index) => {
      const input = h("input", {
        type: "radio",
        name: "resolution",
        value,
        checked: index === 0,
        onChange: () => {
          adjustmentField.hidden = value !== "adjusted";
        },
      });
      resolutionInputs.push(input);
      return h(
        "label",
        { class: "radio-card" },
        input,
        h("span", { class: "radio-card__body" }, h("span", { class: "radio-card__title" }, title), h("span", { class: "radio-card__note" }, note)),
      );
    }),
  );

  adjustmentField.hidden = false;

  dialogShell(
    `Respond to a dispute — Unit ${row.unitLabel}`,
    [
      h("p", { class: "field__hint" }, `They said: “${row.detail}”`),
      field("What do you want to do?", choices),
      adjustmentField,
      field("Your response", response, "Required, and at least a sentence. This is the answer the resident gets."),
    ],
    async () => {
      const resolution = (resolutionInputs.find((input) => input.checked)?.value ?? "responded") as
        | "upheld"
        | "adjusted"
        | "responded";
      await manager.respondToDispute({
        disputeId: row.disputeId!,
        response: response.value,
        resolution,
        adjustmentCents: resolution === "adjusted" ? (parseAmount(adjustment.value) ?? undefined) : undefined,
      });
      toast("Response sent and attached to the charge.", "good");
      navigate(location.pathname + location.search);
    },
    "Send response",
  );
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h("span", { class: "field__label" }, label),
    control,
    hint ? h("span", { class: "field__hint" }, hint) : null,
  );
}
