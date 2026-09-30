/**
 * The resident's overview.
 *
 * The screen a person lands on when they open this to check whether they are
 * square. It answers three questions in order, and nothing else competes with
 * them: what do I owe, why, and what happens next.
 *
 * The balance is stated once, large, with the date it is due. Underneath it, the
 * charges that compose it — not a summary, the actual lines, because the whole
 * argument of this system is that a resident sees the record rather than a
 * number derived from it. Anything unusual (a paused fee, a payment still in
 * flight, an open dispute) is raised to the top rather than left to be
 * discovered, since those are exactly the states where an uninformed resident
 * makes an expensive decision.
 */

import { h, render, icon, ICONS } from "../core/dom.ts";
import { tenant, type TenantSummary } from "../core/api.ts";
import { link, linkHandler, navigate, state } from "../core/app.ts";
import {
  categoryLabel,
  date,
  money,
  moneyClass,
  paymentStatusTone,
  PAYMENT_STATUS_LABELS,
  relativeDays,
  signedMoney,
  workOrderTone,
  WORK_ORDER_STATUS_LABELS,
} from "../core/fmt.ts";

export async function tenantOverview(mount: HTMLElement): Promise<void> {
  const data = await tenant.summary();
  const { balance } = data;
  const owes = balance.balanceCents > 0;
  const inCredit = balance.balanceCents < 0;

  render(
    mount,
    h(
      "div",
      { class: "container stack stack--lg" },
      data.homePhotoId
        ? h("img", { class: "home-photo", src: `/api/v1/property-photos/${data.homePhotoId}`, alt: "Your home" })
        : null,
      balanceHero(data),
      alerts(data),
      h(
        "div",
        { class: "overview-grid" },
        h(
          "div",
          { class: "stack" },
          recentActivity(data),
          openRequests(data),
        ),
        h(
          "div",
          { class: "stack" },
          autopayCard(data),
          policyCard(data),
          statementCard(),
        ),
      ),
    ),
  );
}

function balanceHero(data: TenantSummary): HTMLElement {
  const { balance } = data;
  const owes = balance.balanceCents > 0;
  const inCredit = balance.balanceCents < 0;
  const pending = balance.pendingPayments ?? [];
  const pendingTotal = pending.reduce((sum, p) => sum + p.amountCents, 0);

  return h(
    "section",
    { class: ["balance-hero", owes && "balance-hero--owed", inCredit && "balance-hero--credit"] },
    h(
      "div",
      { class: "balance-hero__main" },
      h("p", { class: "eyebrow" }, inCredit ? "Credit on your account" : "Your balance"),
      h(
        "p",
        { class: ["balance-hero__figure", "money"] },
        money(Math.abs(balance.balanceCents)),
      ),
      h(
        "p",
        { class: "balance-hero__context" },
        inCredit
          ? "You have paid more than you owe. This carries forward against your next charge."
          : owes
            ? balance.dueDate
              ? `Due ${date(balance.dueDate)} — ${relativeDays(balance.dueDate)}.`
              : "Due now."
            : "You are all square. Nothing is owed right now.",
      ),

      pendingTotal > 0
        ? h(
            "p",
            { class: "balance-hero__pending" },
            icon(ICONS.clock, 15),
            h(
              "span",
              {},
              `${money(pendingTotal)} is on its way. Bank payments take a few days to clear — ` +
                `your balance updates when the money actually lands, not when you press pay.`,
            ),
          )
        : null,
    ),

    h(
      "div",
      { class: "balance-hero__actions" },
      owes
        ? h(
            "button",
            { class: "btn btn--primary btn--lg", type: "button", onClick: () => navigate("/pay") },
            `Pay ${money(balance.balanceCents)}`,
          )
        : null,
      h(
        "button",
        { class: "btn btn--ghost", type: "button", onClick: () => navigate("/pay") },
        owes ? "Pay another amount" : "Make a payment",
      ),
      link("/ledger", h("span", { class: "btn btn--quiet" }, "See every line")),
    ),
  );
}

/**
 * Anything that changes what the resident should do today, hoisted above the
 * fold. These are the states where not knowing costs money.
 */
function alerts(data: TenantSummary): HTMLElement | null {
  const { balance } = data;
  const notices: HTMLElement[] = [];

  if (balance.lateFeesPausedUntil) {
    notices.push(
      notice(
        "good",
        `Late fees are paused until ${date(balance.lateFeesPausedUntil)}`,
        balance.lateFeePauseReason ??
          "A payment did not complete through no fault of yours, so fee accrual is suspended while it is sorted out.",
      ),
    );
  }

  const failed = (balance.pendingPayments ?? []).filter(
    (p) => p.status === "failed" || p.status === "returned",
  );
  for (const payment of failed) {
    notices.push(
      notice(
        "bad",
        `A payment of ${money(payment.amountCents)} did not go through`,
        payment.failureMessage ??
          "Nothing was taken from your account, and the amount has been added back to your balance.",
      ),
    );
  }

  if (balance.activePlan) {
    const plan = balance.activePlan;
    const next = plan.installments.find((i) => i.status !== "paid");
    notices.push(
      notice(
        "info",
        `You are on a payment plan for ${money(plan.totalCents)}`,
        next
          ? `Next installment: ${money(next.amountCents - next.paidCents)} on ${date(next.dueDate)}. ` +
              (plan.suspendsLateFees ? "Late fees do not accrue while you follow this plan." : "")
          : "All installments are paid.",
      ),
    );
  }

  if (balance.autopay?.nextDraftBlockedReason) {
    notices.push(notice("warn", "Autopay will not draft this month", balance.autopay.nextDraftBlockedReason));
  }

  for (const dispute of data.openDisputes) {
    notices.push(
      notice(
        "info",
        dispute.status === "responded" ? "Your dispute has a response" : "You have an open dispute",
        dispute.status === "responded" && dispute.response
          ? dispute.response
          : "Late fees are paused on this account while a charge is under review.",
      ),
    );
  }

  if (data.documentsToSign > 0) {
    notices.push(
      h(
        "a",
        { class: "notice notice--warn notice--link", href: "/documents", onClick: linkHandler("/documents") },
        h(
          "div",
          { class: "notice__body" },
          h("span", { class: "notice__title" }, `${data.documentsToSign === 1 ? "A document is" : `${data.documentsToSign} documents are`} waiting for your signature`),
          h("span", {}, "Open Documents to read and sign. →"),
        ),
      ),
    );
  }

  // On a shared lease, who else is on it. The account, and its balance, are shared.
  const others = (data.leaseMembers ?? []).filter((m) => m.userId !== state.user?.id);
  if (others.length > 0) {
    notices.push(
      notice(
        "info",
        `This account is shared with ${others.map((m) => m.name).join(" and ")}`,
        "You all see the same balance and history, and any of you can pay part or all of it. Each person's bank account stays their own.",
      ),
    );
  }

  if (notices.length === 0) return null;
  return h("div", { class: "stack stack--sm" }, ...notices);
}

function notice(tone: string, title: string, body: string): HTMLElement {
  return h(
    "div",
    { class: `notice notice--${tone}` },
    h("div", { class: "notice__body" }, h("span", { class: "notice__title" }, title), h("span", {}, body)),
  );
}

function recentActivity(data: TenantSummary): HTMLElement {
  return h(
    "section",
    { class: "card card--flush" },
    h(
      "div",
      { class: "card__header card__header--padded" },
      h("h2", { class: "card__title" }, "Recent activity"),
      link("/ledger", "Full ledger"),
    ),
    data.recentEntries.length === 0
      ? h("div", { class: "empty" }, "Nothing on this account yet.")
      : h(
          "ul",
          { class: "entry-list" },
          ...data.recentEntries.slice(0, 8).map((entry) =>
            h(
              "li",
              {
                class: ["entry", entry.reversedByEntryId && "entry--reversed"],
                tabindex: "0",
                role: "button",
                onClick: () => navigate(`/ledger/${entry.id}`),
                onKeydown: (event: KeyboardEvent) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    navigate(`/ledger/${entry.id}`);
                  }
                },
              },
              h(
                "div",
                { class: "entry__main" },
                h("span", { class: "entry__description" }, entry.description),
                h(
                  "span",
                  { class: "entry__meta" },
                  date(entry.effectiveDate),
                  " · ",
                  categoryLabel(entry.category),
                  entry.actorName ? ` · by ${entry.actorName}` : "",
                  entry.reversedByEntryId ? " · reversed" : "",
                ),
              ),
              h("span", { class: ["entry__amount", moneyClass(entry.amountCents)] }, signedMoney(entry.amountCents)),
              icon(ICONS.chevronRight, 16),
            ),
          ),
        ),
  );
}

function openRequests(data: TenantSummary): HTMLElement | null {
  if (data.openWorkOrders.length === 0) return null;

  return h(
    "section",
    { class: "card card--flush" },
    h(
      "div",
      { class: "card__header card__header--padded" },
      h("h2", { class: "card__title" }, "Open maintenance requests"),
      link("/maintenance", "All requests"),
    ),
    h(
      "ul",
      { class: "entry-list" },
      ...data.openWorkOrders.map((order) =>
        h(
          "li",
          {
            class: "entry",
            tabindex: "0",
            role: "button",
            onClick: () => navigate(`/maintenance/${order.id}`),
          },
          h(
            "div",
            { class: "entry__main" },
            h("span", { class: "entry__description" }, order.title),
            h("span", { class: "entry__meta" }, order.reference, " · filed ", date(order.submittedAt)),
          ),
          h(
            "span",
            { class: `badge badge--${workOrderTone(order.status)}` },
            WORK_ORDER_STATUS_LABELS[order.status] ?? order.status,
          ),
          icon(ICONS.chevronRight, 16),
        ),
      ),
    ),
  );
}

function autopayCard(data: TenantSummary): HTMLElement {
  const enrollment = data.balance.autopay;

  return h(
    "section",
    { class: "card" },
    h("div", { class: "card__header" }, h("h2", { class: "card__title" }, "Autopay")),
    enrollment
      ? h(
          "div",
          { class: "stack stack--sm" },
          enrollment.setUpByMe === false
            ? h(
                "p",
                {},
                "On. ",
                h("strong", {}, enrollment.setUpByName ?? "Another resident"),
                " pays the whole balance from their bank account on the ",
                h("strong", {}, ordinal(enrollment.dayOfMonth)),
                " of each month.",
              )
            : enrollment.shareCents != null
              ? h(
                  "p",
                  {},
                  "On for your share, ",
                  h("strong", {}, money(enrollment.shareCents)),
                  ", drafting from ",
                  h("strong", {}, enrollment.methodLabel),
                  " on the ",
                  h("strong", {}, ordinal(enrollment.dayOfMonth)),
                  " of each month.",
                )
              : h(
                  "p",
                  {},
                  "On, drafting from ",
                  h("strong", {}, enrollment.methodLabel),
                  " on the ",
                  h("strong", {}, ordinal(enrollment.dayOfMonth)),
                  " of each month.",
                ),
          enrollment.nextDraftDate
            ? h(
                "p",
                { class: "field__hint" },
                `Next draft: ${money(enrollment.nextDraftAmountCents ?? 0)} on ${date(enrollment.nextDraftDate)}.`,
              )
            : null,
          enrollment.setUpByMe === false
            ? null
            : enrollment.capCents
            ? h(
                "p",
                { class: "field__hint" },
                `Your limit is ${money(enrollment.capCents)}. Anything above that will not draft ` +
                  `automatically — you will be told instead, and nothing will be taken.`,
              )
            : h(
                "p",
                { class: "field__hint" },
                "No limit set. Setting one means an unexpected charge cannot be drafted without you seeing it first.",
              ),
          h(
            "button",
            { class: "btn btn--ghost", type: "button", onClick: () => navigate("/pay#autopay") },
            enrollment.setUpByMe === false ? "See autopay" : "Change autopay",
          ),
        )
      : h(
          "div",
          { class: "stack stack--sm" },
          h("p", {}, "Off. Rent is paid manually."),
          h(
            "p",
            { class: "field__hint" },
            "If you turn it on, you can cap how much may be drafted without asking you first.",
          ),
          h(
            "button",
            { class: "btn btn--ghost", type: "button", onClick: () => navigate("/pay#autopay") },
            "Set up autopay",
          ),
        ),
  );
}

function policyCard(data: TenantSummary): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h("div", { class: "card__header" }, h("h2", { class: "card__title" }, "Late fee policy")),
    h("p", { class: "field__hint" }, data.balance.lateFeePolicy),
  );
}

function statementCard(): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h("div", { class: "card__header" }, h("h2", { class: "card__title" }, "Your records")),
    h(
      "p",
      { class: "field__hint" },
      "Download your complete account history as a spreadsheet. It includes every charge, " +
        "payment, correction, and the reason given for each — yours to keep, and usable " +
        "without an account here.",
    ),
    h(
      "a",
      { class: "btn btn--ghost", href: tenant.statementUrl(), download: true },
      icon(ICONS.download, 16),
      h("span", {}, "Download statement"),
    ),
  );
}

function ordinal(day: number): string {
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suffix}`;
}
