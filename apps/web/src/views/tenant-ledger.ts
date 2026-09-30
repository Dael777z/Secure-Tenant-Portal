/**
 * The resident's ledger, and the trace view behind any single line.
 *
 * This is the screen the project exists to build. Two properties are doing the
 * work:
 *
 * A running balance is shown beside every row, oldest to newest, so that a
 * resident can follow how the number got where it is rather than being handed a
 * total and asked to trust it. The comprehension test the proposal commits to —
 * show someone a month containing a partial payment and a waived fee and ask
 * what they owe and why — is a test of this column.
 *
 * Reversals are shown, not hidden. A charge that was later waived stays on the
 * page, struck through, with the waiver beneath it and the reason the manager
 * gave. The alternative, quietly removing it, is exactly the behaviour that
 * makes an incumbent portal's balance unarguable.
 */

import { openNewThreadDialog } from "./messages.ts";
import { h, render, icon, ICONS, openDialog, closeDialog } from "../core/dom.ts";
import { tenant, ApiError } from "../core/api.ts";
import { link, navigate, reportError, toast } from "../core/app.ts";
import {
  categoryLabel,
  date,
  dateTime,
  money,
  moneyClass,
  period as formatPeriod,
  signedMoney,
} from "../core/fmt.ts";
import type { LedgerEntry } from "/shared/ledger.js";

export async function tenantLedger(mount: HTMLElement, params: Record<string, string>): Promise<void> {
  const selectedPeriod = new URLSearchParams(location.search).get("period") ?? undefined;
  const data = await tenant.ledger({ period: selectedPeriod, limit: 500 });

  const periods = data.periods;

  render(
    mount,
    h(
      "div",
      { class: "container stack stack--lg" },
      h(
        "header",
        { class: "page-header" },
        h(
          "div",
          {},
          h("h1", {}, "Your ledger"),
          h(
            "p",
            { class: "lede" },
            "Every line on this page is the same line your property manager sees. " +
              "Nothing here is ever edited or deleted — a correction appears as its own entry, " +
              "with who made it and why.",
          ),
        ),
        h(
          "div",
          { class: "row row--tight" },
          h("span", { class: "eyebrow" }, "Balance"),
          h("span", { class: ["ledger-total", "money", moneyClass(data.balanceCents)] }, money(data.balanceCents)),
        ),
      ),

      periodFilter(periods.map((p) => p.period), selectedPeriod),

      periods.length === 0
        ? h("div", { class: "card" }, h("div", { class: "empty" }, "No entries yet."))
        : h("div", { class: "stack stack--lg" }, ...periods.map(periodSection)),
    ),
  );
}

function periodFilter(available: string[], selected?: string): HTMLElement {
  return h(
    "div",
    { class: "period-filter", role: "group", "aria-label": "Filter by month" },
    h(
      "a",
      {
        class: ["period-filter__item", !selected && "is-active"],
        href: "/ledger",
        onClick: (event: MouseEvent) => {
          event.preventDefault();
          navigate("/ledger");
        },
      },
      "All",
    ),
    ...available.slice(0, 14).map((key) =>
      h(
        "a",
        {
          class: ["period-filter__item", selected === key && "is-active"],
          href: `/ledger?period=${key}`,
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            navigate(`/ledger?period=${key}`);
          },
        },
        formatPeriod(key),
      ),
    ),
  );
}

function periodSection(summary: {
  period: string;
  entries: LedgerEntry[];
  openingBalance: number;
  closingBalance: number;
  charged: number;
  credited: number;
}): HTMLElement {
  // Oldest first within a month, so the running balance reads downward the way
  // a person adds figures up.
  const ordered = [...summary.entries].sort(
    (a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.postedAt.localeCompare(b.postedAt),
  );

  let running = summary.openingBalance;
  const rows = ordered.map((entry) => {
    running += entry.amountCents;
    return entryRow(entry, running);
  });

  return h(
    "section",
    { class: "card card--flush ledger-period" },
    h(
      "div",
      { class: "ledger-period__header" },
      h(
        "div",
        {},
        h("h2", { class: "card__title" }, formatPeriod(summary.period)),
        h(
          "p",
          { class: "ledger-period__summary" },
          `Started at ${money(summary.openingBalance)} · `,
          `${money(summary.charged)} charged · `,
          `${money(Math.abs(summary.credited))} paid or credited`,
        ),
      ),
      h(
        "div",
        { class: "ledger-period__closing" },
        h("span", { class: "eyebrow" }, "Ended at"),
        h("span", { class: ["money", moneyClass(summary.closingBalance)] }, money(summary.closingBalance)),
      ),
    ),

    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "ledger-table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", { scope: "col" }, "Date"),
            h("th", { scope: "col" }, "Description"),
            h("th", { scope: "col", class: "num" }, "Charge"),
            h("th", { scope: "col", class: "num" }, "Payment"),
            h("th", { scope: "col", class: "num" }, "Balance"),
            h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Details")),
          ),
        ),
        h("tbody", {}, ...rows),
      ),
    ),
  );
}

function entryRow(entry: LedgerEntry, runningBalance: number): HTMLElement {
  const isReversed = Boolean(entry.reversedByEntryId);
  const isReversal = entry.entryType === "reversal";
  const isAnnotation = entry.entryType === "annotation";

  return h(
    "tr",
    {
      class: ["is-clickable", isReversed && "row--reversed", isAnnotation && "row--annotation"],
      tabindex: "0",
      onClick: () => navigate(`/ledger/${entry.id}`),
      onKeydown: (event: KeyboardEvent) => {
        if (event.key === "Enter") navigate(`/ledger/${entry.id}`);
      },
    },
    h("td", { class: "nowrap" }, date(entry.effectiveDate, "short")),
    h(
      "td",
      {},
      h(
        "div",
        { class: "ledger-cell" },
        h("span", { class: "ledger-cell__text" }, entry.description),
        h(
          "span",
          { class: "ledger-cell__meta" },
          categoryLabel(entry.category),
          entry.actorName ? ` · ${entry.actorName}` : entry.actorRole === "system_job" ? " · automatic" : "",
          isReversed ? " · later reversed" : "",
        ),
        // The reason a person gave for a discretionary action is part of the
        // record the resident reads, not an internal note.
        entry.actorReason ? h("span", { class: "ledger-cell__reason" }, `“${entry.actorReason}”`) : null,
      ),
    ),
    h("td", { class: "num" }, entry.amountCents > 0 ? money(entry.amountCents) : ""),
    h(
      "td",
      { class: ["num", isReversal && entry.amountCents > 0 && "num--reversal"] },
      entry.amountCents < 0 ? money(Math.abs(entry.amountCents)) : "",
    ),
    h("td", { class: ["num", "ledger-running"] }, isAnnotation ? "" : money(runningBalance)),
    h("td", { class: "ledger-chevron" }, icon(ICONS.chevronRight, 15)),
  );
}

/* ------------------------------------------------------------------ *
 * The trace view: why is this line here?
 * ------------------------------------------------------------------ */

export async function tenantEntryTrace(mount: HTMLElement, params: Record<string, string>): Promise<void> {
  const trace = await tenant.trace(params.entryId);
  const entry = trace.entry;

  render(
    mount,
    h(
      "div",
      { class: "container container--narrow stack stack--lg" },
      h(
        "a",
        {
          class: "back-link",
          href: "/ledger",
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            history.length > 1 ? history.back() : navigate("/ledger");
          },
        },
        "← Back to ledger",
      ),

      h(
        "header",
        { class: "trace-header" },
        h("p", { class: "eyebrow" }, categoryLabel(entry.category)),
        h("h1", { class: "trace-header__amount money" }, signedMoney(entry.amountCents)),
        h("p", { class: "trace-header__description" }, entry.description),
      ),

      h(
        "section",
        { class: "card" },
        h("h2", { class: "card__title" }, "Where this came from"),
        h(
          "dl",
          { class: "dl" },
          h("dt", {}, "Effective"),
          h("dd", {}, date(entry.effectiveDate)),
          h("dt", {}, "Recorded"),
          h("dd", {}, dateTime(entry.postedAt)),
          h("dt", {}, "Accounted to"),
          h("dd", {}, formatPeriod(entry.period)),
          h("dt", {}, "Entered by"),
          h(
            "dd",
            {},
            entry.actorName ??
              (entry.actorRole === "system_job"
                ? "The system, on a schedule — no person entered this"
                : "—"),
          ),
          entry.actorReason ? h("dt", {}, "Reason given") : null,
          entry.actorReason ? h("dd", {}, entry.actorReason) : null,
        ),
      ),

      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            class: "btn btn--ghost",
            type: "button",
            onClick: () =>
              void openNewThreadDialog({
                ledgerEntryId: entry.id,
                topic: "payment",
                subject: `About: ${entry.description}`.slice(0, 140),
              }),
          },
          "Ask the office about this",
        ),
      ),

      // Why an automatic fee exists, in the property's own configured terms.
      trace.policyExplanation
        ? h(
            "section",
            { class: "notice notice--warn" },
            h(
              "div",
              { class: "notice__body" },
              h("span", { class: "notice__title" }, "Why this was charged automatically"),
              h("span", {}, trace.policyExplanation),
            ),
          )
        : null,

      trace.reversedBy
        ? h(
            "section",
            { class: "notice notice--good" },
            h(
              "div",
              { class: "notice__body" },
              h("span", { class: "notice__title" }, `This was reversed on ${date(trace.reversedBy.effectiveDate)}`),
              h(
                "span",
                {},
                `${money(Math.abs(trace.reversedBy.amountCents))} was reversed` +
                  (trace.reversedBy.actorName ? ` by ${trace.reversedBy.actorName}` : "") +
                  (trace.reversedBy.actorReason ? `: “${trace.reversedBy.actorReason}”` : "."),
              ),
            ),
          )
        : null,

      trace.reverses
        ? h(
            "section",
            { class: "card" },
            h("h2", { class: "card__title" }, "This corrects an earlier entry"),
            h(
              "p",
              {},
              link(`/ledger/${trace.reverses.id}`, trace.reverses.description),
              ` — ${signedMoney(trace.reverses.amountCents)} on ${date(trace.reverses.effectiveDate)}.`,
            ),
            h(
              "p",
              { class: "field__hint" },
              "The original entry is still on your ledger. Nothing is removed from this record; " +
                "a correction is added beside what it corrects.",
            ),
          )
        : null,

      trace.payment ? paymentCard(trace.payment) : null,
      trace.workOrder ? workOrderCard(trace.workOrder) : null,
      trace.dispute ? disputeCard(trace.dispute) : null,

      trace.relatedEntries.length > 0
        ? h(
            "section",
            { class: "card" },
            h("h2", { class: "card__title" }, "Related entries"),
            h(
              "ul",
              { class: "plain-list" },
              ...trace.relatedEntries.map((related) =>
                h(
                  "li",
                  {},
                  link(`/ledger/${related.id}`, related.description),
                  ` — ${signedMoney(related.amountCents)} on ${date(related.effectiveDate)}`,
                ),
              ),
            ),
          )
        : null,

      disputeSection(entry, trace.dispute),
    ),
  );
}

function paymentCard(payment: NonNullable<Awaited<ReturnType<typeof tenant.trace>>["payment"]>): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h("h2", { class: "card__title" }, "The payment behind this"),
    h(
      "dl",
      { class: "dl" },
      h("dt", {}, "Amount"),
      h("dd", { class: "money" }, money(payment.amountCents)),
      h("dt", {}, "Method"),
      h("dd", {}, payment.methodLabel ?? payment.method),
      h("dt", {}, "Status"),
      h("dd", {}, payment.status),
      payment.receiptNumber ? h("dt", {}, "Receipt") : null,
      payment.receiptNumber ? h("dd", { class: "money" }, payment.receiptNumber) : null,
      h("dt", {}, "Submitted"),
      h("dd", {}, dateTime(payment.submittedAt)),
      payment.settledAt ? h("dt", {}, "Cleared") : null,
      payment.settledAt ? h("dd", {}, dateTime(payment.settledAt)) : null,
      payment.failureMessage ? h("dt", {}, "What happened") : null,
      payment.failureMessage ? h("dd", {}, payment.failureMessage) : null,
    ),
  );
}

function workOrderCard(order: NonNullable<Awaited<ReturnType<typeof tenant.trace>>["workOrder"]>): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h("h2", { class: "card__title" }, "The maintenance request behind this"),
    h("p", {}, link(`/maintenance/${order.id}`, `${order.reference} — ${order.title}`)),
    h("p", { class: "field__hint" }, `Filed ${date(order.submittedAt)}. Status: ${order.status}.`),
  );
}

function disputeCard(dispute: NonNullable<Awaited<ReturnType<typeof tenant.trace>>["dispute"]>): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h("h2", { class: "card__title" }, "You disputed this charge"),
    h(
      "dl",
      { class: "dl" },
      h("dt", {}, "Opened"),
      h("dd", {}, date(dispute.openedAt)),
      h("dt", {}, "What you said"),
      h("dd", {}, dispute.reason),
      dispute.response ? h("dt", {}, "Their response") : null,
      dispute.response ? h("dd", {}, dispute.response) : null,
      dispute.respondedByName ? h("dt", {}, "Answered by") : null,
      dispute.respondedByName ? h("dd", {}, `${dispute.respondedByName} on ${date(dispute.respondedAt)}`) : null,
    ),
    // Settled it with the office, or opened it by mistake: take it back. Late
    // fees resume their normal course once no dispute is open.
    dispute.status === "open" || dispute.status === "responded"
      ? h(
          "button",
          {
            class: "btn btn--ghost",
            type: "button",
            onClick: async (event: MouseEvent) => {
              const button = event.currentTarget as HTMLButtonElement;
              if (button.dataset.armed !== "1") {
                button.dataset.armed = "1";
                button.textContent = "Withdraw it? Click again";
                setTimeout(() => {
                  button.dataset.armed = "";
                  button.textContent = "Withdraw dispute";
                }, 4000);
                return;
              }
              try {
                await tenant.withdrawDispute(dispute.id);
                toast("Dispute withdrawn.", "good");
                navigate(location.pathname, { replace: true });
              } catch (caught) {
                reportError(caught);
              }
            },
          },
          "Withdraw dispute",
        )
      : null,
  );
}

/**
 * Disputing a charge is a first-class action on the charge itself, not a form
 * buried in a help page. A resident who disagrees with a line should be able to
 * say so from the line.
 */
function disputeSection(entry: LedgerEntry, existing: unknown): HTMLElement | null {
  if (existing) return null;
  if (entry.entryType === "annotation" || entry.amountCents <= 0) return null;

  return h(
    "section",
    { class: "card" },
    h("h2", { class: "card__title" }, "Does this look wrong?"),
    h(
      "p",
      { class: "field__hint" },
      "Tell the office what you think is wrong with this charge. Your message and their answer both " +
        "attach to this entry permanently, and late fees stop accruing while a charge is under review.",
    ),
    h(
      "button",
      {
        class: "btn btn--ghost",
        type: "button",
        onClick: () => openDisputeDialog(entry),
      },
      "Dispute this charge",
    ),
  );
}

function openDisputeDialog(entry: LedgerEntry): void {
  const reason = h("textarea", {
    class: "textarea",
    id: "dispute-reason",
    required: true,
    placeholder:
      "For example: I paid this on the 3rd from the portal and have the confirmation. It shows as received on the 9th.",
  });
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Send dispute");

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
            await tenant.openDispute({ ledgerEntryId: entry.id, reason: reason.value });
            closeDialog(dialog);
            toast("Your dispute was sent. Late fees are paused while it is reviewed.", "good");
            navigate(`/ledger/${entry.id}`);
          } catch (caught) {
            error.textContent = caught instanceof ApiError ? caught.message : "Could not send that.";
            error.hidden = false;
            submit.disabled = false;
          }
        },
      },
      h("div", { class: "dialog__header" }, h("h2", { class: "dialog__title" }, "Dispute this charge")),
      h(
        "div",
        { class: "dialog__body" },
        h(
          "p",
          {},
          h("strong", {}, entry.description),
          ` — ${money(entry.amountCents)} on ${date(entry.effectiveDate)}`,
        ),
        h(
          "div",
          { class: "field" },
          h("label", { class: "field__label", for: "dispute-reason" }, "What is wrong with it?"),
          reason,
          h("span", { class: "field__hint" }, "A sentence or two is plenty. A person reads this."),
        ),
        error,
      ),
      h(
        "div",
        { class: "dialog__footer" },
        h("button", { class: "btn btn--ghost", type: "button", onClick: () => closeDialog(dialog) }, "Cancel"),
        submit,
      ),
    ),
  );

  document.body.appendChild(dialog);
  openDialog(dialog);
}
