/**
 * Maintenance triage, and the access matrix.
 *
 * Triage is the one area on-site staff can reach, and it is worth noticing what
 * is absent from their view: no balances, no rent roll, no payment history. That
 * is enforced by Row-Level Security rather than by hiding buttons — a staff
 * session that requested ledger rows directly would receive an empty set.
 *
 * The access page exists so a manager can check that for themselves. The
 * proposal treats this as a usability requirement: if a manager cannot verify
 * without help that an agent cannot read the rent roll, the permission model is
 * not legible enough, no matter how correct the database is.
 */

import { openNewThreadDialog } from "./messages.ts";
import { h, render, icon, ICONS, openDialog, closeDialog } from "../core/dom.ts";
import { manager, ApiError } from "../core/api.ts";
import { navigate, reportError, toast, state, linkHandler } from "../core/app.ts";
import {
  currentPeriod,
  date,
  dateTime,
  money,
  parseAmount,
  parseTimestamp,
  titleCase,
  WORK_ORDER_STATUS_LABELS,
} from "../core/fmt.ts";
import { kpi, kpiRow, pager, PRIORITY_DISPLAY, selectField, workOrderPill, wsButton, wsHeader } from "../core/workspace.ts";
import type { WorkOrder } from "/shared/maintenance.js";

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "hvac", label: "Heating or cooling" },
  { value: "appliance", label: "Appliance" },
  { value: "pest", label: "Pests" },
  { value: "locks_keys", label: "Locks or keys" },
  { value: "structural", label: "Doors, windows, walls, floors" },
  { value: "common_area", label: "Shared areas" },
  { value: "other", label: "Something else" },
];

const categoryName = (value: string): string => CATEGORIES.find((c) => c.value === value)?.label ?? value;

const OPEN = new Set(["submitted", "acknowledged", "scheduled", "in_progress"]);

const STATUS_FILTERS = [
  { value: "all", label: "All Statuses" },
  { value: "open", label: "Open (not resolved)" },
  { value: "submitted", label: "Submitted" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "scheduled", label: "Scheduled" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
];

const PRIORITY_FILTERS = [
  { value: "all", label: "All Priorities" },
  { value: "emergency", label: "High (emergency)" },
  { value: "urgent", label: "Medium (urgent)" },
  { value: "routine", label: "Low (routine)" },
];

const PAGE_SIZE = 25;

function isOverdue(order: WorkOrder, targetHours: Record<string, number>): { overdue: boolean; age: number; target: number } {
  const age = hoursSince(order.submittedAt);
  const target = targetHours[order.priority] ?? 120;
  return { overdue: OPEN.has(order.status) && age > target, age, target };
}

/**
 * Desktop / Maintenance Queue from the prototype.
 *
 * The four figures and the filters are computed from one list of every request
 * the caller can see (RLS decides which). Open requests sort first —
 * emergencies, then oldest — because that is the order the queue should be
 * worked; finished ones follow, newest first.
 */
export async function managerMaintenance(mount: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const propertyId = params.get("propertyId") ?? "";
  let status = params.get("status") ?? "all";
  let priority = params.get("priority") ?? "all";
  let page = 0;

  const [data, props] = await Promise.all([
    manager.workOrders({ status: "all", propertyId: propertyId || undefined }),
    manager.properties(),
  ]);

  const month = currentPeriod();
  const all = [...data.workOrders].sort((a, b) => {
    const openA = OPEN.has(a.status) ? 0 : 1;
    const openB = OPEN.has(b.status) ? 0 : 1;
    if (openA !== openB) return openA - openB;
    if (openA === 0) {
      const rank = (w: WorkOrder) => (w.priority === "emergency" ? 0 : w.priority === "urgent" ? 1 : 2);
      return rank(a) - rank(b) || a.submittedAt.localeCompare(b.submittedAt);
    }
    return (b.resolvedAt ?? b.submittedAt).localeCompare(a.resolvedAt ?? a.submittedAt);
  });

  const open = all.filter((w) => OPEN.has(w.status));
  const high = open.filter((w) => w.priority === "emergency");
  const underway = open.filter((w) => w.status === "scheduled" || w.status === "in_progress");
  const completed = all.filter((w) => (w.status === "resolved" || w.status === "closed") && (w.resolvedAt ?? "").startsWith(month));
  const overdueCount = open.filter((w) => isOverdue(w, data.targetHours).overdue).length;

  const setUrl = () => {
    const next = new URLSearchParams(location.search);
    status === "all" ? next.delete("status") : next.set("status", status);
    priority === "all" ? next.delete("priority") : next.set("priority", priority);
    const qs = next.toString();
    history.replaceState({}, "", qs ? `/manage/maintenance?${qs}` : "/manage/maintenance");
  };

  const tableHost = h("div", { class: "ws-panel ws-panel--rows", "aria-live": "polite" });

  const draw = () => {
    const rows = all.filter(
      (w) =>
        (status === "all" || (status === "open" ? OPEN.has(w.status) : w.status === status)) &&
        (priority === "all" || w.priority === priority),
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
          { class: "ws-table ws-table--queue" },
          h("caption", { class: "visually-hidden" }, "Maintenance requests"),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col", class: "ws-col-80", style: { width: "110px" } }, "Request"),
              h("th", { scope: "col", class: "ws-col-80" }, "Unit"),
              h("th", { scope: "col" }, "Description"),
              h("th", { scope: "col", class: "ws-col-160" }, "Priority"),
              h("th", { scope: "col", style: { width: "246px" } }, "Status"),
            ),
          ),
          h("tbody", {}, ...visible.map((order) => queueRow(order, data.targetHours))),
        ),
      ),
      rows.length === 0 ? h("p", { class: "ws-empty" }, "No requests match that filter.") : null,
      pager({
        page,
        pageSize: PAGE_SIZE,
        total: rows.length,
        noun: "requests",
        onPage: (next) => {
          page = next;
          draw();
        },
      }),
    );
  };

  const isManager = state.user?.role === "manager";

  render(
    mount,
    wsHeader(
      "Maintenance Queue",
      "Triage requests and keep every repair moving.",
      isManager ? wsButton("+ New Request", { onClick: () => void openNewRequestDialog(propertyId) }) : null,
      "ws-header__control--button",
    ),
    kpiRow([
      kpi("Open Requests", String(open.length), propertyId ? "At this property" : "Across all properties"),
      kpi("High Priority", String(high.length), high.length ? "Needs attention" : "No emergencies open"),
      kpi("In Progress", String(underway.length), "Scheduled or underway"),
      kpi("Completed", String(completed.length), "This month"),
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
          navigate(`/manage/maintenance?${next.toString()}`);
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
      selectField({
        label: "Priority",
        value: priority,
        choices: PRIORITY_FILTERS,
        onChange: (value) => {
          priority = value;
          page = 0;
          setUrl();
          draw();
        },
      }),
    ),
    overdueCount > 0
      ? h(
          "p",
          { class: "ws-sub", role: "status" },
          h("span", { class: "ws-tone--danger" }, "● "),
          `${overdueCount} open request${overdueCount === 1 ? " is" : "s are"} past the response target for its priority.`,
        )
      : null,
    tableHost,
  );

  draw();
}

function queueRow(order: WorkOrder, targetHours: Record<string, number>): HTMLElement {
  const display = PRIORITY_DISPLAY[order.priority];
  const { overdue, age, target } = isOverdue(order, targetHours);
  const href = `/manage/maintenance/${order.id}`;
  const meta = [
    order.residentName ?? "",
    `filed ${date(order.submittedAt.slice(0, 10), "short")}`,
    order.photos.length ? `${order.photos.length} photo${order.photos.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);

  return h(
    "tr",
    {
      class: "is-clickable",
      tabindex: "0",
      "aria-label": `${order.reference}, unit ${order.unitLabel}, ${order.title}, ${display.label} priority, ${WORK_ORDER_STATUS_LABELS[order.status]}`,
      onClick: () => navigate(href),
      onKeydown: (event: KeyboardEvent) => {
        if (event.key === "Enter") navigate(href);
      },
    },
    h("td", { class: "nowrap" }, order.reference),
    h("td", {}, order.unitLabel),
    h(
      "td",
      {},
      order.title,
      h("span", { class: "ws-cell-meta" }, meta.join(" · ")),
    ),
    h("td", { class: `ws-tone--${display.tone}`, title: `${titleCase(order.priority)} — ${target}h response target` }, display.label),
    h(
      "td",
      {},
      workOrderPill(order.status, WORK_ORDER_STATUS_LABELS[order.status]),
      overdue ? h("span", { class: "ws-late" }, `${Math.round(age)}h / ${target}h`) : null,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * One request (Mobile / Maintenance Detail, also used on desktop)
 * ------------------------------------------------------------------ */

export async function managerWorkOrderDetail(mount: HTMLElement, params: Record<string, string>): Promise<void> {
  const [{ workOrder: order }, queue] = await Promise.all([
    manager.workOrder(params.workOrderId),
    // Only for the response targets; small and cached by the browser.
    manager.workOrders({ status: "open" }).catch(() => ({ workOrders: [], targetHours: {} as Record<string, number> })),
  ]);
  const display = PRIORITY_DISPLAY[order.priority];
  const { overdue, age, target } = isOverdue(order, queue.targetHours);
  const photo = order.photos[0];

  render(
    mount,
    h(
      "div",
      { class: "ws-detail" },
      h(
        "a",
        { class: "ws-back", href: "/manage/maintenance", onClick: linkHandler("/manage/maintenance") },
        h("span", { class: "ws-back__arrow", "aria-hidden": "true" }, "←"),
        h("span", {}, "Maintenance Request"),
      ),
      h(
        "div",
        { class: "ws-detail__title" },
        workOrderPill(order.status, WORK_ORDER_STATUS_LABELS[order.status], true),
        h("h1", { class: "ws-h2" }, order.title),
        h("p", { class: "ws-detail__meta" }, `${order.propertyName} · Unit ${order.unitLabel} · ${order.reference}`),
      ),
      photo
        ? h(
            "a",
            { class: "ws-photo ws-photo--filled", href: photo.url, target: "_blank", rel: "noopener" },
            h("img", { src: photo.url, alt: `Photo attached to ${order.reference}` }),
          )
        : h(
            "div",
            { class: "ws-photo" },
            h("span", { class: "ws-photo__glyph", "aria-hidden": "true" }, "▧"),
            h("span", { class: "ws-photo__caption" }, "No photo attached"),
          ),
      order.photos.length > 1
        ? h("p", { class: "ws-detail__meta" }, `${order.photos.length - 1} more photo${order.photos.length === 2 ? "" : "s"} in the history below.`)
        : null,
      h("p", { class: "ws-detail__body" }, order.description),
      h(
        "dl",
        { class: "ws-facts" },
        fact("Priority", h("span", { class: `ws-tone--${display.tone}` }, `${display.label} (${order.priority})`)),
        fact("Category", categoryName(order.category)),
        fact("Assigned To", order.assignedToName ?? "Unassigned"),
        fact("Resident", order.residentName ?? "—"),
        fact("Entry", order.entryPermission ? "Permitted without the resident home" : "Arrange entry first"),
        fact("Filed", dateTime(order.submittedAt)),
        fact(
          "Response Target",
          OPEN.has(order.status)
            ? h("span", { class: overdue ? "ws-tone--danger" : "" }, `${target} hours — ${overdue ? `overdue (${Math.round(age)}h old)` : `${Math.round(age)}h so far`}`)
            : order.resolvedAt
              ? `Resolved ${dateTime(order.resolvedAt)}`
              : "—",
        ),
        order.creditCents ? fact("Rent Credit", money(order.creditCents)) : null,
      ),
      h(
        "div",
        { class: "ws-actions" },
        wsButton("Update Status", { onClick: () => openTriageDialog(order) }),
        wsButton("Add Note", { style: "secondary", onClick: () => openTriageDialog(order, { noteOnly: true }) }),
      ),
      h(
        "button",
        {
          class: "ws-btn ws-btn--ghost",
          type: "button",
          style: { alignSelf: "flex-start", paddingLeft: "0" },
          onClick: () =>
            void openNewThreadDialog({
              tenancyId: order.tenancyId,
              workOrderId: order.id,
              topic: "maintenance",
              subject: `${order.reference} — ${order.title}`.slice(0, 140),
            }),
        },
        "Message the resident about this →",
      ),
      h("h2", { class: "ws-h3" }, "History"),
      h(
        "ol",
        { class: "ws-timeline" },
        ...[...order.events].reverse().map((event) =>
          h(
            "li",
            { class: "ws-timeline__item" },
            h("span", { class: ["ws-activity__dot", event.visibleToResident ? "" : "ws-tone--warning"], "aria-hidden": "true" }, "●"),
            h(
              "div",
              {},
              h(
                "div",
                {},
                event.kind === "status" && event.toStatus
                  ? `Marked ${WORK_ORDER_STATUS_LABELS[event.toStatus]}`
                  : event.kind === "credit"
                    ? "Rent credit posted"
                    : event.kind === "photo"
                      ? "Photo added"
                      : "Note",
              ),
              event.note ? h("div", { class: "ws-timeline__note" }, event.note) : null,
              h(
                "div",
                { class: "ws-timeline__meta" },
                `${event.authorName ?? "System"} · ${dateTime(event.at)}${event.visibleToResident ? "" : " · internal, not shown to the resident"}`,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function fact(label: string, value: string | HTMLElement): HTMLElement {
  return h(
    "div",
    { class: "ws-facts__row" },
    h("dt", { class: "ws-facts__label" }, label),
    h("dd", { class: "ws-facts__value", style: { margin: "0" } }, value),
  );
}

/* ------------------------------------------------------------------ *
 * + New Request (filed by the office on a resident's behalf)
 * ------------------------------------------------------------------ */

export async function openNewRequestDialog(propertyId: string): Promise<void> {
  let roll;
  try {
    roll = await manager.rentRoll({ propertyId: propertyId || undefined, limit: 1000 });
  } catch (caught) {
    reportError(caught);
    return;
  }

  const unit = h(
    "select",
    { class: "select", required: true },
    h("option", { value: "" }, "Choose a unit"),
    ...roll.rows.map((row) => h("option", { value: row.tenancyId }, `${row.unitLabel} — ${row.residentName}${propertyId ? "" : ` (${row.propertyName})`}`)),
  );
  const category = h("select", { class: "select" }, ...CATEGORIES.map((c) => h("option", { value: c.value }, c.label)));
  const priority = h(
    "select",
    { class: "select" },
    h("option", { value: "routine" }, "Low — routine (5 business days)"),
    h("option", { value: "urgent" }, "Medium — urgent (1 business day)"),
    h("option", { value: "emergency" }, "High — emergency (4 hours)"),
  );
  const title = h("input", { class: "input", maxlength: "140", required: true, placeholder: "Kitchen faucet leaking" });
  const description = h("textarea", {
    class: "textarea",
    required: true,
    placeholder: "What the resident reported, where, and since when.",
  });
  const entry = h("input", { type: "checkbox", checked: false });
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "ws-btn ws-btn--primary", type: "submit" }, "File request");

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
          if (!unit.value) {
            error.textContent = "Choose the unit this request is for.";
            error.hidden = false;
            return;
          }
          submit.disabled = true;
          try {
            const result = await manager.createWorkOrder({
              tenancyId: unit.value,
              category: category.value,
              priority: priority.value,
              title: title.value.trim(),
              description: description.value.trim(),
              entryPermission: entry.checked,
            });
            closeDialog(dialog);
            toast(`${result.workOrder.reference} filed for unit ${result.workOrder.unitLabel}.`, "good");
            navigate(`/manage/maintenance/${result.workOrder.id}`);
          } catch (caught) {
            error.textContent = caught instanceof ApiError ? caught.message : "Could not file that request.";
            error.hidden = false;
            submit.disabled = false;
          }
        },
      },
      h("div", { class: "dialog__header" }, h("h2", { class: "dialog__title" }, "New maintenance request")),
      h(
        "div",
        { class: "dialog__body" },
        h("p", { class: "field__hint" }, "For a request reported by phone or in person. It appears in the resident's own maintenance thread, filed under your name."),
        h("label", { class: "field" }, h("span", { class: "field__label" }, "Unit"), unit),
        h("label", { class: "field" }, h("span", { class: "field__label" }, "Category"), category),
        h("label", { class: "field" }, h("span", { class: "field__label" }, "Priority"), priority),
        h("label", { class: "field" }, h("span", { class: "field__label" }, "Title"), title),
        h("label", { class: "field" }, h("span", { class: "field__label" }, "What is wrong"), description),
        h("label", { class: "checkbox" }, entry, h("span", {}, "The resident allows entry when they are not home")),
        error,
      ),
      h(
        "div",
        { class: "dialog__footer" },
        h("button", { class: "ws-btn ws-btn--ghost", type: "button", onClick: () => closeDialog(dialog) }, "Cancel"),
        submit,
      ),
    ),
  ) as HTMLDialogElement;

  document.body.appendChild(dialog);
  openDialog(dialog);
}

/**
 * The fuller update. Resolving can post a rent credit linked to the request,
 * which is the connection that earns maintenance its place next to the ledger —
 * the resident sees the money and its cause in one place.
 */
function openTriageDialog(order: WorkOrder, options: { noteOnly?: boolean } = {}): void {
  const isManager = state.user?.role === "manager";
  const noteOnly = options.noteOnly ?? false;

  const status = h(
    "select",
    { class: "select" },
    h("option", { value: "" }, "Leave status unchanged"),
    ...["acknowledged", "scheduled", "in_progress", "resolved", "closed"].map((value) =>
      h("option", { value, selected: false }, WORK_ORDER_STATUS_LABELS[value]),
    ),
  );
  const note = h("textarea", { class: "textarea", placeholder: "What was found, what was done, what happens next." });
  const visible = h("input", { type: "checkbox", checked: true });
  const creditEnabled = h("input", { type: "checkbox", checked: false });
  const credit = h("input", { class: "input input--money", type: "text", inputmode: "decimal", value: "0.00", disabled: true });
  const creditReason = h("input", { class: "input", placeholder: "Three days without hot water", disabled: true });

  creditEnabled.addEventListener("change", () => {
    credit.disabled = !creditEnabled.checked;
    creditReason.disabled = !creditEnabled.checked;
  });

  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "ws-btn ws-btn--primary", type: "submit" }, noteOnly ? "Save note" : "Save update");

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
          if (noteOnly && !note.value.trim()) {
            error.textContent = "Write the note first.";
            error.hidden = false;
            return;
          }
          submit.disabled = true;
          try {
            await manager.updateWorkOrder(order.id, {
              status: status.value || undefined,
              note: note.value || undefined,
              visibleToResident: visible.checked,
              creditCents: creditEnabled.checked ? (parseAmount(credit.value) ?? undefined) : undefined,
              creditReason: creditEnabled.checked ? creditReason.value : undefined,
            });
            closeDialog(dialog);
            toast(`${order.reference} updated.`, "good");
            navigate(location.pathname + location.search);
          } catch (caught) {
            error.textContent = caught instanceof ApiError ? caught.message : "Could not save that.";
            error.hidden = false;
            submit.disabled = false;
          }
        },
      },
      h(
        "div",
        { class: "dialog__header" },
        h("h2", { class: "dialog__title" }, `${noteOnly ? "Add a note to" : "Update"} ${order.reference} — ${order.title}`),
      ),
      h(
        "div",
        { class: "dialog__body" },
        noteOnly ? null : h("div", { class: "field" }, h("span", { class: "field__label" }, "Status"), status),
        h("div", { class: "field" }, h("span", { class: "field__label" }, "Note"), note),
        h(
          "label",
          { class: "checkbox" },
          visible,
          h(
            "span",
            {},
            h("strong", {}, "The resident can see this note"),
            h(
              "span",
              { class: "field__hint", style: { display: "block" } },
              "Uncheck for internal coordination. Internal notes never appear in the resident's thread.",
            ),
          ),
        ),

        // Posting money is a manager action. Staff triage; they do not touch the
        // ledger, and the API refuses it independently of this being hidden.
        isManager && !noteOnly
          ? h(
              "div",
              { class: "stack stack--sm", style: { borderTop: "1px solid var(--line)", paddingTop: "1rem" } },
              h(
                "label",
                { class: "checkbox" },
                creditEnabled,
                h(
                  "span",
                  {},
                  h("strong", {}, "Credit the resident's account for this"),
                  h(
                    "span",
                    { class: "field__hint", style: { display: "block" } },
                    "Posts a linked credit to their ledger, so the money and its cause appear together.",
                  ),
                ),
              ),
              h("div", { class: "amount-input" }, h("span", { class: "amount-input__symbol" }, "$"), credit),
              creditReason,
            )
          : null,
        error,
      ),
      h(
        "div",
        { class: "dialog__footer" },
        h("button", { class: "ws-btn ws-btn--ghost", type: "button", onClick: () => closeDialog(dialog) }, "Cancel"),
        submit,
      ),
    ),
  ) as HTMLDialogElement;

  document.body.appendChild(dialog);
  openDialog(dialog);
}

function hoursSince(iso: string): number {
  const parsed = parseTimestamp(iso);
  if (Number.isNaN(parsed)) return 0;
  return (Date.now() - parsed) / 3_600_000;
}

/* ------------------------------------------------------------------ *
 * Access
 * ------------------------------------------------------------------ */

export async function managerAccess(mount: HTMLElement): Promise<void> {
  const data = await manager.staff();

  const byProperty = new Map<string, typeof data.staff>();
  for (const person of data.staff) {
    const list = byProperty.get(person.property_name) ?? [];
    list.push(person);
    byProperty.set(person.property_name, list);
  }

  render(
    mount,
    h(
      "div",
      { class: "container container--wide stack stack--lg" },
      h(
        "header",
        {},
        h("h1", {}, "Who can see what"),
        h(
          "p",
          { class: "lede" },
          "These limits are enforced by the database, not by hiding buttons. A staff session that " +
            "asked for rent-roll data directly would receive an empty result, because the rows are " +
            "not visible to that role at all.",
        ),
      ),

      h(
        "section",
        { class: "card card--flush" },
        h("div", { class: "card__header card__header--padded" }, h("h2", { class: "card__title" }, "What each role can do")),
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
                h("th", { scope: "col" }, "Role"),
                h("th", { scope: "col" }, "What it means"),
                h("th", { scope: "col" }, "Can read the ledger"),
                h("th", { scope: "col" }, "Can change money"),
                h("th", { scope: "col" }, "Can triage maintenance"),
              ),
            ),
            h(
              "tbody",
              {},
              ...(Object.keys(data.capabilitiesByRole) as Array<keyof typeof data.capabilitiesByRole>).map((role) => {
                const caps = data.capabilitiesByRole[role];
                return h(
                  "tr",
                  {},
                  h("td", {}, h("strong", {}, data.roleLabels[role])),
                  h("td", { class: "role-description" }, data.roleDescriptions[role]),
                  yesNo(caps.includes("ledger:read:property") || caps.includes("ledger:read:own")),
                  yesNo(caps.includes("ledger:write:discretionary")),
                  yesNo(caps.includes("workorder:triage")),
                );
              }),
            ),
          ),
        ),
      ),

      ...Array.from(byProperty.entries()).map(([property, people]) =>
        h(
          "section",
          { class: "card card--flush" },
          h("div", { class: "card__header card__header--padded" }, h("h2", { class: "card__title" }, property)),
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
                  h("th", { scope: "col" }, "Person"),
                  h("th", { scope: "col" }, "Role"),
                  h("th", { scope: "col" }, "Granted"),
                  h("th", { scope: "col" }, "Status"),
                ),
              ),
              h(
                "tbody",
                {},
                ...people.map((person) =>
                  h(
                    "tr",
                    {},
                    h(
                      "td",
                      {},
                      h("div", { class: "ledger-cell" }, h("span", {}, person.display_name), h("span", { class: "ledger-cell__meta" }, person.email)),
                    ),
                    h("td", {}, data.roleLabels[person.role] ?? person.role),
                    h("td", { class: "nowrap" }, date(person.granted_at.slice(0, 10), "short")),
                    h(
                      "td",
                      {},
                      person.revoked_at
                        ? h("span", { class: "badge badge--neutral" }, "Revoked")
                        : h("span", { class: "badge badge--good" }, "Active"),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),

      h(
        "section",
        { class: "card" },
        h("h2", { class: "card__title" }, "Check it yourself"),
        h(
          "p",
          { class: "field__hint" },
          "Sign in as the on-site staff account and try to reach the rent roll. The navigation does not " +
            "offer it, and typing the address directly returns nothing — not an error page that hints " +
            "the data exists, but an empty result, because the database does not return those rows to " +
            "that role.",
        ),
      ),
    ),
  );
}

function yesNo(value: boolean): HTMLElement {
  return h(
    "td",
    {},
    value
      ? h("span", { class: "badge badge--good" }, "Yes")
      : h("span", { class: "badge badge--neutral" }, "No"),
  );
}
