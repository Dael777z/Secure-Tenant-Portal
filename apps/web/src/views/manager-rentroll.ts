/**
 * The rent roll, one tenancy's account, and the charge-posting screen.
 *
 * The rent roll is behind the exception queue rather than in front of it, on
 * purpose. It is here for the times a manager genuinely needs the whole picture
 * — a month-end review, an owner's question, an export for an accountant —
 * rather than as the default thing to scan.
 */

import { h, render, icon, ICONS } from "../core/dom.ts";
import { manager, ApiError } from "../core/api.ts";
import { can, navigate, reportError, state, toast } from "../core/app.ts";
import { openNewThreadDialog } from "./messages.ts";
import {
  addMonths,
  categoryLabel,
  compactMoney,
  currentPeriod,
  date,
  dateTime,
  money,
  moneyClass,
  percent,
  period as formatPeriod,
  signedMoney,
  todayIso,
  wholeMoney,
} from "../core/fmt.ts";
import { kpi, kpiRow, pager, pill, searchField, selectField, wsButton, wsHeader, type Tone } from "../core/workspace.ts";
import type { RentRollRow } from "/shared/api.js";
import { openPlanDialog, openRecordPaymentDialog, openWaiveDialog } from "./manager-exceptions.ts";
import { leaseSections, openAdjustDialog, openReverseDialog, reversible } from "./manager-portfolio.ts";

/**
 * Status in the prototype's words and pill colours (Table/RentRow → Status
 * pill). "Unpaid" splits in two by date: rent not yet due is "Due", rent past
 * its due date is "Overdue" — the distinction a manager actually acts on.
 */
function statusDisplay(row: RentRollRow, today: string): { label: string; tone: Tone } {
  switch (row.status) {
    case "paid":
      return { label: "Paid", tone: "success" };
    case "partial":
      return { label: "Partial", tone: "warning" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "credit":
      return { label: "Credit", tone: "info" };
    default:
      return row.dueDate < today || row.daysPastDue > 0
        ? { label: "Overdue", tone: "danger" }
        : { label: "Due", tone: "info" };
  }
}

const STATUS_FILTERS = [
  { value: "all", label: "All Statuses" },
  { value: "paid", label: "Paid" },
  { value: "partial", label: "Partial" },
  { value: "unpaid", label: "Unpaid / Overdue" },
  { value: "failed", label: "Failed" },
  { value: "credit", label: "Credit" },
];

const PAGE_SIZE = 25;

/**
 * Desktop / Rent Roll from the prototype.
 *
 * One request fetches the whole scope (a property, or every property the
 * caller can see); status and search filter it in the browser, so the four
 * figures at the top describe the portfolio and do not jump around as the
 * manager narrows the table. Numbers are still computed live from the ledger.
 */
export async function managerRentRoll(mount: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const period = params.get("period") ?? currentPeriod();
  const propertyId = params.get("propertyId") ?? "";
  let status = params.get("status") ?? "all";
  let search = params.get("search") ?? "";
  let page = 0;

  const [data, props] = await Promise.all([
    manager.rentRoll({ period, propertyId: propertyId || undefined, limit: 1000 }),
    manager.properties(),
  ]);

  const today = todayIso();
  const month = formatPeriod(period);
  const behind = data.rows.filter((row) => row.dueCents > 0).length;

  const setUrl = () => {
    const next = new URLSearchParams(location.search);
    status === "all" ? next.delete("status") : next.set("status", status);
    search ? next.set("search", search) : next.delete("search");
    const qs = next.toString();
    history.replaceState({}, "", qs ? `/manage/rent-roll?${qs}` : "/manage/rent-roll");
  };

  const tableHost = h("div", { class: "ws-panel ws-panel--rows", "aria-live": "polite" });

  const draw = () => {
    const needle = search.toLowerCase();
    const rows = data.rows.filter(
      (row) =>
        (status === "all" || row.status === status) &&
        (!needle || row.unitLabel.toLowerCase().includes(needle) || row.residentName.toLowerCase().includes(needle)),
    );
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const visible = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    render(
      tableHost,
      h(
        "div",
        { class: "ws-table-wrap" },
        h(
          "table",
          { class: "ws-table ws-table--roll" },
          h("caption", { class: "visually-hidden" }, `Rent roll for ${month}`),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col", class: "ws-col-68" }, "Unit"),
              h("th", { scope: "col", class: "ws-col-260" }, "Tenant"),
              h("th", { scope: "col", class: "ws-col-150" }, "Monthly Rent"),
              h("th", { scope: "col", class: "ws-col-130" }, "Balance"),
              h("th", { scope: "col", class: "ws-col-160" }, "Due Date"),
              h("th", { scope: "col" }, "Status"),
            ),
          ),
          h("tbody", {}, ...visible.map((row) => rollRow(row, today))),
        ),
      ),
      rows.length === 0 ? h("p", { class: "ws-empty" }, "No units match that filter.") : null,
      pager({
        page,
        pageSize: PAGE_SIZE,
        total: rows.length,
        noun: "units",
        onPage: (next) => {
          page = next;
          draw();
          tableHost.scrollIntoView({ block: "start", behavior: "smooth" });
        },
      }),
    );
  };

  render(
    mount,
    wsHeader(
      "Rent Roll",
      "Track balances, payment status, and monthly rent.",
      wsButton("Export rent roll", {
        href: manager.exportUrl({ period, propertyId: propertyId || undefined, audience: "accountant", format: "csv" }),
        download: true,
      }),
      "ws-header__control--button",
    ),
    kpiRow([
      kpi("Expected Rent", wholeMoney(data.totals.chargedCents), month),
      kpi("Collected", wholeMoney(data.totals.collectedCents), `${percent(data.totals.collectionRate)} collected`),
      kpi("Outstanding", wholeMoney(data.totals.outstandingCents), `Across ${behind} account${behind === 1 ? "" : "s"}`),
      kpi("Collection Rate", percent(data.totals.collectionRate), `${month.split(" ")[0]} portfolio total`),
    ]),
    h(
      "div",
      { class: "ws-filters", role: "search" },
      selectField({
        label: "Property",
        value: propertyId,
        choices: [{ value: "", label: "All Properties" }, ...props.properties.map((p) => ({ value: p.id, label: p.name }))],
        onChange: (value) => {
          const next = new URLSearchParams(location.search);
          value ? next.set("propertyId", value) : next.delete("propertyId");
          navigate(`/manage/rent-roll?${next.toString()}`);
        },
      }),
      selectField({
        label: "Status",
        value: status,
        choices: STATUS_FILTERS,
        onChange: (value) => {
          status = value;
          page = 0;
          setUrl();
          draw();
        },
      }),
      searchField({
        label: "Search the rent roll",
        placeholder: "Search tenant or unit",
        value: search,
        onSearch: (value) => {
          search = value;
          page = 0;
          setUrl();
          draw();
        },
      }),
      selectField({
        label: "Period",
        value: period,
        choices: Array.from({ length: 13 }, (_, i) => {
          const key = addMonths(currentPeriod(), -i);
          return { value: key, label: formatPeriod(key) };
        }),
        onChange: (value) => {
          const next = new URLSearchParams(location.search);
          value === currentPeriod() ? next.delete("period") : next.set("period", value);
          navigate(`/manage/rent-roll?${next.toString()}`);
        },
      }),
    ),
    tableHost,
  );

  draw();
}

function rollRow(row: RentRollRow, today: string): HTMLElement {
  const display = statusDisplay(row, today);
  const notes = [
    row.hasActivePlan ? "on a payment plan" : "",
    row.lateFeesPaused ? "fees paused" : "",
    row.openDisputes > 0 ? `${row.openDisputes} dispute${row.openDisputes === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const href = `/manage/tenancy/${row.tenancyId}`;

  return h(
    "tr",
    {
      class: "is-clickable",
      tabindex: "0",
      "aria-label": `Unit ${row.unitLabel}, ${row.residentName}, balance ${money(row.balanceCents)}, ${display.label}`,
      onClick: () => navigate(href),
      onKeydown: (event: KeyboardEvent) => {
        if (event.key === "Enter") navigate(href);
      },
    },
    h("td", {}, row.unitLabel),
    h("td", {}, row.residentName, notes.length ? h("span", { class: "ws-cell-meta" }, notes.join(" · ")) : null),
    h("td", { class: "ws-money" }, compactMoney(row.monthlyRentCents)),
    h("td", { class: "ws-money" }, compactMoney(row.balanceCents)),
    h("td", {}, date(row.dueDate, "long").replace(/^(\w{3})\w*/, "$1")),
    h(
      "td",
      {},
      pill(display.label, display.tone),
      row.daysPastDue > 30 ? h("span", { class: "ws-late" }, `${row.daysPastDue}d`) : null,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * One account
 * ------------------------------------------------------------------ */

export async function managerTenancy(mount: HTMLElement, params: Record<string, string>): Promise<void> {
  const data = await manager.tenancy(params.tenancyId);
  const tenancy = data.tenancy as Record<string, string | number | null>;

  render(
    mount,
    h(
      "div",
      { class: "container container--wide stack stack--lg" },
      h(
        "a",
        {
          class: "back-link",
          href: "/manage",
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            history.length > 1 ? history.back() : navigate("/manage");
          },
        },
        "← Back",
      ),

      h(
        "header",
        { class: "page-header" },
        h(
          "div",
          {},
          h("h1", {}, `Unit ${tenancy.unit_label} — ${tenancy.resident_name}`),
          h(
            "p",
            { class: "lede" },
            `${tenancy.property_name} · ${tenancy.resident_email}`,
            tenancy.resident_phone ? ` · ${tenancy.resident_phone}` : "",
          ),
        ),
        h(
          "div",
          { class: "account-balance" },
          h("span", { class: "eyebrow" }, "Balance"),
          h("span", { class: ["money", "account-balance__figure", moneyClass(data.balanceCents)] }, money(data.balanceCents)),
        ),
      ),

      tenancy.late_fee_hold_until
        ? h(
            "div",
            { class: "notice notice--good" },
            h(
              "div",
              { class: "notice__body" },
              h("span", { class: "notice__title" }, `Late fees paused until ${date(String(tenancy.late_fee_hold_until))}`),
              h("span", {}, String(tenancy.late_fee_hold_reason ?? "")),
            ),
          )
        : null,

      h(
        "div",
        { class: "row" },
        state.user?.role === "manager"
          ? h(
              "button",
              {
                class: "btn btn--ghost",
                type: "button",
                onClick: () =>
                  void openNewThreadDialog({
                    tenancyId: params.tenancyId,
                    subject: `Your account — unit ${tenancy.unit_label}`,
                    topic: "payment",
                  }),
              },
              "Message resident",
            )
          : null,
        !can("ledger:write:discretionary")
          ? null
          : h(
          "button",
          {
            class: "btn btn--ghost",
            type: "button",
            onClick: () =>
              openRecordPaymentDialog({
                tenancyId: params.tenancyId,
                unitLabel: String(tenancy.unit_label),
                amountCents: Math.max(0, data.balanceCents),
              }),
          },
          "Record an offline payment",
        ),
        can("ledger:write:discretionary")
          ? h(
              "button",
              {
                class: "btn btn--ghost",
                type: "button",
                onClick: () =>
                  openAdjustDialog({
                    tenancyId: params.tenancyId,
                    unitLabel: String(tenancy.unit_label),
                    residentName: String(tenancy.resident_name),
                  }),
              },
              "Add a charge or credit",
            )
          : null,
        data.activePlan || data.balanceCents <= 0 || !can("ledger:write:discretionary")
          ? null
          : h(
              "button",
              {
                class: "btn btn--ghost",
                type: "button",
                onClick: () =>
                  openPlanDialog({
                    tenancyId: params.tenancyId,
                    unitLabel: String(tenancy.unit_label),
                    residentName: String(tenancy.resident_name),
                    amountCents: Math.max(0, data.balanceCents),
                  }),
              },
              "Open a payment plan",
            ),
      ),

      data.activePlan ? planCard(data.activePlan) : null,
      disputesCard(data.disputes),

      h(
        "section",
        { class: "card card--flush" },
        h("div", { class: "card__header card__header--padded" }, h("h2", { class: "card__title" }, "Ledger")),
        h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", { scope: "col" }, "Date"),
                h("th", { scope: "col" }, "Entry"),
                h("th", { scope: "col" }, "Entered by"),
                h("th", { scope: "col", class: "num" }, "Amount"),
                h("th", { scope: "col" }, ""),
              ),
            ),
            h(
              "tbody",
              {},
              ...data.entries.map((entry) =>
                h(
                  "tr",
                  { class: [entry.reversedByEntryId && "row--reversed"] },
                  h("td", { class: "nowrap" }, date(entry.effectiveDate, "short")),
                  h(
                    "td",
                    {},
                    h(
                      "div",
                      { class: "ledger-cell" },
                      h("span", {}, entry.description),
                      h("span", { class: "ledger-cell__meta" }, categoryLabel(entry.category)),
                      entry.actorReason ? h("span", { class: "ledger-cell__reason" }, `“${entry.actorReason}”`) : null,
                    ),
                  ),
                  h(
                    "td",
                    { class: "nowrap" },
                    entry.actorName ?? (entry.actorRole === "system_job" ? h("em", {}, "automatic") : "—"),
                  ),
                  h("td", { class: ["num", moneyClass(entry.amountCents)] }, signedMoney(entry.amountCents)),
                  h(
                    "td",
                    {},
                    // Waiving is offered only where it is meaningful: an
                    // outstanding charge that has not already been reversed.
                    entry.amountCents > 0 && !entry.reversedByEntryId && entry.entryType === "charge" && can("ledger:write:discretionary")
                      ? h(
                          "button",
                          {
                            class: "btn btn--quiet",
                            type: "button",
                            onClick: () =>
                              openWaiveDialog({
                                id: entry.id,
                                description: entry.description,
                                amountCents: entry.amountCents,
                              }),
                          },
                          "Waive",
                        )
                      : reversible(entry) && can("ledger:write:discretionary")
                        ? h(
                            "button",
                            {
                              class: "btn btn--quiet",
                              type: "button",
                              title: "Entered by mistake? Cancel it with a reversing line.",
                              onClick: () =>
                                openReverseDialog({ id: entry.id, description: entry.description, amountCents: entry.amountCents }),
                            },
                            "Reverse",
                          )
                        : null,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),

      // Who is on the lease, its terms, its late-fee terms, its documents
      // (added after the 2026-09-28 client meeting).
      ...leaseSections(data, params.tenancyId),
    ),
  );
}

function planCard(plan: NonNullable<Awaited<ReturnType<typeof manager.tenancy>>["activePlan"]>): HTMLElement {
  return h(
    "section",
    { class: "card card--accent" },
    h("h2", { class: "card__title" }, `Payment plan — ${money(plan.totalCents)}`),
    h("p", { class: "field__hint" }, `Opened by ${plan.openedByName ?? "a manager"} on ${date(plan.openedAt)}: “${plan.reason}”`),
    h(
      "ol",
      { class: "installments" },
      ...plan.installments.map((installment) =>
        h(
          "li",
          { class: ["installment", `installment--${installment.status}`] },
          h("span", { class: "installment__date" }, date(installment.dueDate, "short")),
          h("span", { class: "installment__amount money" }, money(installment.amountCents)),
          h("span", { class: "installment__status" }, installment.status),
        ),
      ),
    ),
    can("ledger:write:discretionary")
      ? h(
          "button",
          {
            class: "btn btn--ghost",
            type: "button",
            onClick: () => {
              const reason = h("textarea", { class: "textarea", id: "plan-cancel-reason", required: true, minlength: "4", maxlength: "1000", placeholder: "Paid in full early." }) as HTMLTextAreaElement;
              const error = h("p", { class: "field__error", hidden: true, role: "alert" });
              const dialog = h(
                "dialog",
                { class: "dialog" },
                h(
                  "form",
                  {
                    method: "dialog",
                    onSubmit: async (event: SubmitEvent) => {
                      event.preventDefault();
                      try {
                        await manager.cancelPlan(plan.id, reason.value.trim());
                        dialog.close();
                        dialog.remove();
                        toast("Payment plan ended. Late fees follow the normal policy again.", "good");
                        navigate(location.pathname, { replace: true });
                      } catch (caught) {
                        error.textContent = caught instanceof ApiError ? caught.message : "Could not end the plan.";
                        error.hidden = false;
                      }
                    },
                  },
                  h("div", { class: "dialog__header" }, h("h2", { class: "dialog__title" }, "End this payment plan")),
                  h(
                    "div",
                    { class: "dialog__body" },
                    h("p", { class: "field__hint" }, "The balance stays as it is; only the installment schedule ends. The resident sees your reason."),
                    h("label", { class: "field", for: "plan-cancel-reason" }, h("span", { class: "field__label" }, "Reason"), reason),
                    error,
                  ),
                  h(
                    "div",
                    { class: "dialog__footer" },
                    h("button", { class: "btn btn--ghost", type: "button", onClick: () => { dialog.close(); dialog.remove(); } }, "Cancel"),
                    h("button", { class: "btn btn--primary", type: "submit" }, "End plan"),
                  ),
                ),
              ) as HTMLDialogElement;
              document.body.appendChild(dialog);
              dialog.showModal();
              reason.focus();
            },
          },
          "End this plan",
        )
      : null,
  );
}

function disputesCard(disputes: Awaited<ReturnType<typeof manager.tenancy>>["disputes"]): HTMLElement | null {
  const open = disputes.filter((d) => d.status === "open" || d.status === "responded");
  if (open.length === 0) return null;

  return h(
    "section",
    { class: "card" },
    h("h2", { class: "card__title" }, "Open disputes"),
    ...open.map((dispute) =>
      h(
        "div",
        { class: "stack stack--sm" },
        h("p", {}, h("strong", {}, `Opened ${date(dispute.openedAt)}: `), `“${dispute.reason}”`),
        dispute.response ? h("p", { class: "field__hint" }, `Your response: ${dispute.response}`) : null,
      ),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Posting a period's charges
 * ------------------------------------------------------------------ */

/**
 * Posting is idempotent, so running it twice is safe. The preview still exists,
 * because a manager should see the two hundred lines they are about to add
 * before they add them — and because the preview is computed by the same
 * function that posts, it cannot show one thing and do another.
 */
export async function managerCharges(mount: HTMLElement): Promise<void> {
  const period = new URLSearchParams(location.search).get("period") ?? currentPeriod();
  const preview = await manager.postCharges({ period, dryRun: true });

  const pending = preview.posted.filter((item) => !item.alreadyPosted);
  const alreadyThere = preview.posted.filter((item) => item.alreadyPosted);

  const post = h(
    "button",
    { class: "btn btn--primary", type: "button", disabled: pending.length === 0 },
    pending.length === 0 ? "Nothing to post" : `Post ${pending.length} charges (${money(preview.totalCents)})`,
  );

  post.addEventListener("click", async () => {
    post.disabled = true;
    post.textContent = "Posting…";
    try {
      const result = await manager.postCharges({ period, dryRun: false });
      toast(`Posted ${result.newCount} charges for ${formatPeriod(period)}.`, "good");
      navigate(`/manage/charges?period=${period}`);
    } catch (caught) {
      reportError(caught);
      post.disabled = false;
    }
  });

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
          h("h1", {}, "Post charges"),
          h(
            "p",
            { class: "lede" },
            `${formatPeriod(period)}. Posting the same period twice is safe — each charge carries a key, ` +
              `so a repeat run adds nothing.`,
          ),
        ),
        h("div", { class: "row row--tight" }, periodStepperCharges(period), post),
      ),

      alreadyThere.length > 0
        ? h(
            "div",
            { class: "notice notice--info" },
            h(
              "div",
              { class: "notice__body" },
              h("span", { class: "notice__title" }, `${alreadyThere.length} charges are already posted for this period`),
              h("span", {}, "They will not be added again."),
            ),
          )
        : null,

      pending.length === 0
        ? h(
            "div",
            { class: "card" },
            h(
              "div",
              { class: "empty" },
              h("p", { class: "empty__title" }, "Nothing left to post"),
              h("p", {}, `Everything scheduled for ${formatPeriod(period)} is already on the ledger.`),
            ),
          )
        : h(
            "section",
            { class: "card card--flush" },
            h(
              "div",
              { class: "card__header card__header--padded" },
              h("h2", { class: "card__title" }, "Will be posted"),
              h("span", { class: "money" }, money(preview.totalCents)),
            ),
            h(
              "div",
              { class: "table-wrap" },
              h(
                "table",
                {},
                h(
                  "thead",
                  {},
                  h(
                    "tr",
                    {},
                    h("th", { scope: "col" }, "Unit"),
                    h("th", { scope: "col" }, "Resident"),
                    h("th", { scope: "col" }, "Charge"),
                    h("th", { scope: "col", class: "num" }, "Amount"),
                  ),
                ),
                h(
                  "tbody",
                  {},
                  ...pending.map((item) =>
                    h(
                      "tr",
                      {},
                      h("td", {}, h("strong", {}, item.unitLabel)),
                      h("td", {}, item.residentName),
                      h("td", {}, item.description),
                      h("td", { class: "num" }, money(item.amountCents)),
                    ),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}

function periodStepperCharges(period: string): HTMLElement {
  const go = (target: string) => navigate(`/manage/charges?period=${target}`);
  return h(
    "div",
    { class: "stepper" },
    h("button", { class: "btn btn--quiet", type: "button", onClick: () => go(addMonths(period, -1)) }, "←"),
    h("span", { class: "stepper__label" }, formatPeriod(period)),
    h("button", { class: "btn btn--quiet", type: "button", onClick: () => go(addMonths(period, 1)) }, "→"),
  );
}
