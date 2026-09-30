/**
 * Maintenance: filing a request, and following one.
 *
 * Written for a phone, because that is where these are actually filed — usually
 * while standing in front of the problem. Hence the large touch targets, the
 * camera-first photo control, and priority choices that describe situations
 * rather than asking someone to rank their own emergency.
 */

import { h, render, icon, ICONS } from "../core/dom.ts";
import { tenant, ApiError } from "../core/api.ts";
import { navigate, reportError, toast } from "../core/app.ts";
import { date, dateTime, money, workOrderTone, WORK_ORDER_STATUS_LABELS } from "../core/fmt.ts";
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

export async function tenantMaintenance(mount: HTMLElement): Promise<void> {
  const data = await tenant.workOrders();

  render(
    mount,
    h(
      "div",
      { class: "container container--narrow stack stack--lg" },
      h(
        "header",
        { class: "page-header" },
        h("div", {}, h("h1", {}, "Maintenance")),
        h(
          "button",
          { class: "btn btn--primary", type: "button", onClick: () => navigate("/maintenance/new") },
          icon(ICONS.plus, 16),
          h("span", {}, "New request"),
        ),
      ),

      data.workOrders.length === 0
        ? h(
            "div",
            { class: "card" },
            h(
              "div",
              { class: "empty" },
              h("p", { class: "empty__title" }, "No requests yet"),
              h("p", {}, "When something in your home needs attention, file it here and you can follow it."),
            ),
          )
        : h(
            "div",
            { class: "stack stack--sm" },
            ...data.workOrders.map((order) => requestCard(order)),
          ),
    ),
  );
}

function requestCard(order: WorkOrder): HTMLElement {
  return h(
    "article",
    {
      class: "request-card",
      tabindex: "0",
      role: "button",
      onClick: () => navigate(`/maintenance/${order.id}`),
      onKeydown: (event: KeyboardEvent) => {
        if (event.key === "Enter") navigate(`/maintenance/${order.id}`);
      },
    },
    h(
      "div",
      { class: "request-card__head" },
      h("span", { class: `badge badge--${workOrderTone(order.status)}` }, WORK_ORDER_STATUS_LABELS[order.status]),
      order.priority === "emergency" ? h("span", { class: "badge badge--bad" }, "Emergency") : null,
      h("span", { class: "request-card__ref" }, order.reference),
    ),
    h("h2", { class: "request-card__title" }, order.title),
    h(
      "p",
      { class: "request-card__meta" },
      `Filed ${date(order.submittedAt)}`,
      order.resolvedAt ? ` · resolved ${date(order.resolvedAt)}` : "",
      order.creditCents ? ` · ${money(order.creditCents)} credited to your account` : "",
    ),
    icon(ICONS.chevronRight, 18),
  );
}

/* ------------------------------------------------------------------ *
 * Filing a request
 * ------------------------------------------------------------------ */

export async function tenantNewRequest(mount: HTMLElement): Promise<void> {
  const { priorityGuidance } = await tenant.workOrders();

  const title = h("input", {
    class: "input",
    id: "wo-title",
    required: true,
    maxlength: 140,
    placeholder: "Kitchen sink is backing up",
  });
  const description = h("textarea", {
    class: "textarea",
    id: "wo-description",
    required: true,
    placeholder:
      "What is wrong, when it started, and anything you have already tried. The more specific, the better the first visit goes.",
  });
  const category = h(
    "select",
    { class: "select", id: "wo-category" },
    ...CATEGORIES.map((item) => h("option", { value: item.value }, item.label)),
  );

  const priorityInputs: HTMLInputElement[] = [];
  const priorities = h(
    "div",
    { class: "radio-cards" },
    ...(["emergency", "urgent", "routine"] as const).map((value, index) => {
      const input = h("input", { type: "radio", name: "priority", value, checked: index === 2 });
      priorityInputs.push(input);
      return h(
        "label",
        { class: "radio-card" },
        input,
        h(
          "span",
          { class: "radio-card__body" },
          h(
            "span",
            { class: "radio-card__title" },
            value === "emergency" ? "Emergency" : value === "urgent" ? "Urgent" : "Routine",
          ),
          h("span", { class: "radio-card__note" }, priorityGuidance[value] ?? ""),
        ),
      );
    }),
  );

  const entry = h("input", { type: "checkbox", checked: false });
  const photos = h("input", {
    class: "input",
    id: "wo-photos",
    type: "file",
    accept: "image/*",
    multiple: true,
    capture: "environment",
  });

  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "btn btn--primary btn--lg btn--block", type: "submit" }, "Submit request");

  render(
    mount,
    h(
      "div",
      { class: "container container--narrow stack stack--lg" },
      h(
        "a",
        {
          class: "back-link",
          href: "/maintenance",
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            navigate("/maintenance");
          },
        },
        "← Back",
      ),
      h("h1", {}, "New maintenance request"),

      h(
        "form",
        {
          class: "card stack",
          novalidate: true,
          onSubmit: async (event: SubmitEvent) => {
            event.preventDefault();
            error.hidden = true;

            if (title.value.trim().length < 3) {
              error.textContent = "Give the request a short title.";
              error.hidden = false;
              title.focus();
              return;
            }
            if (description.value.trim().length < 10) {
              error.textContent = "Please describe the problem in a sentence or two.";
              error.hidden = false;
              description.focus();
              return;
            }

            submit.disabled = true;
            submit.textContent = "Sending…";

            try {
              const { workOrder } = await tenant.submitWorkOrder({
                category: category.value,
                priority: priorityInputs.find((input) => input.checked)?.value ?? "routine",
                title: title.value,
                description: description.value,
                entryPermission: entry.checked,
              });

              const files = Array.from(photos.files ?? []);
              if (files.length > 0) {
                submit.textContent = `Uploading ${files.length} photo${files.length === 1 ? "" : "s"}…`;
                for (const file of files) {
                  try {
                    await tenant.uploadPhoto(workOrder.id, file);
                  } catch {
                    // A photo that will not upload must not lose the request
                    // itself — the text is the part that matters.
                    toast(`Could not upload ${file.name}. The request was still filed.`, "bad");
                  }
                }
              }

              toast(`Request ${workOrder.reference} filed.`, "good");
              navigate(`/maintenance/${workOrder.id}`);
            } catch (caught) {
              error.textContent = caught instanceof ApiError ? caught.message : "Could not file that.";
              error.hidden = false;
              submit.disabled = false;
              submit.textContent = "Submit request";
            }
          },
        },
        h("div", { class: "field" }, h("label", { class: "field__label", for: "wo-title" }, "What is wrong?"), title),
        h("div", { class: "field" }, h("label", { class: "field__label", for: "wo-category" }, "Type"), category),
        h("div", { class: "field" }, h("span", { class: "field__label" }, "How urgent is it?"), priorities),
        h(
          "div",
          { class: "field" },
          h("label", { class: "field__label", for: "wo-description" }, "Describe it"),
          description,
        ),
        h(
          "div",
          { class: "field" },
          h("label", { class: "field__label", for: "wo-photos" }, "Photos (optional)"),
          photos,
          h(
            "span",
            { class: "field__hint" },
            "A photo usually saves a visit. These are only visible to you and to the maintenance team.",
          ),
        ),
        h(
          "div",
          { class: "field" },
          h(
            "label",
            { class: "checkbox" },
            entry,
            h(
              "span",
              {},
              h("strong", {}, "Maintenance may enter if I am not home"),
              h(
                "span",
                { class: "field__hint", style: { display: "block" } },
                "Leave this unchecked and someone will arrange a time with you first.",
              ),
            ),
          ),
        ),
        error,
        submit,
      ),
    ),
  );

  title.focus();
}

/* ------------------------------------------------------------------ *
 * Following a request
 * ------------------------------------------------------------------ */

export async function tenantRequestDetail(mount: HTMLElement, params: Record<string, string>): Promise<void> {
  const { workOrder } = await tenant.workOrder(params.workOrderId);

  const note = h("textarea", { class: "textarea", id: "note", placeholder: "Anything to add?" });
  const noteError = h("p", { class: "field__error", hidden: true, role: "alert" });

  render(
    mount,
    h(
      "div",
      { class: "container container--narrow stack stack--lg" },
      h(
        "a",
        {
          class: "back-link",
          href: "/maintenance",
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            navigate("/maintenance");
          },
        },
        "← All requests",
      ),

      h(
        "header",
        { class: "stack stack--sm" },
        h(
          "div",
          { class: "row row--tight" },
          h("span", { class: `badge badge--${workOrderTone(workOrder.status)}` }, WORK_ORDER_STATUS_LABELS[workOrder.status]),
          h("span", { class: "request-card__ref" }, workOrder.reference),
        ),
        h("h1", {}, workOrder.title),
        h("p", { class: "lede" }, workOrder.description),
      ),

      workOrder.creditCents
        ? h(
            "div",
            { class: "notice notice--good" },
            h(
              "div",
              { class: "notice__body" },
              h("span", { class: "notice__title" }, `${money(workOrder.creditCents)} was credited to your account`),
              h(
                "span",
                {},
                "This appears on your ledger linked to this request, so it is clear what it was for.",
              ),
              workOrder.creditLedgerEntryId
                ? h(
                    "a",
                    {
                      href: `/ledger/${workOrder.creditLedgerEntryId}`,
                      onClick: (event: MouseEvent) => {
                        event.preventDefault();
                        navigate(`/ledger/${workOrder.creditLedgerEntryId}`);
                      },
                    },
                    "See it on your ledger",
                  )
                : null,
            ),
          )
        : null,

      workOrder.photos.length > 0
        ? h(
            "section",
            { class: "card" },
            h("h2", { class: "card__title" }, "Photos"),
            h(
              "div",
              { class: "photo-grid" },
              ...workOrder.photos.map((photo) =>
                h("img", { class: "photo-grid__item", src: photo.url, alt: "Photo attached to this request", loading: "lazy" }),
              ),
            ),
          )
        : null,

      h(
        "section",
        { class: "card" },
        h("h2", { class: "card__title" }, "History"),
        h(
          "ol",
          { class: "timeline" },
          ...workOrder.events.map((event) =>
            h(
              "li",
              { class: "timeline__item" },
              h("span", { class: "timeline__dot", "aria-hidden": "true" }),
              h(
                "div",
                { class: "timeline__body" },
                h(
                  "span",
                  { class: "timeline__title" },
                  event.kind === "status" && event.toStatus
                    ? `Marked ${WORK_ORDER_STATUS_LABELS[event.toStatus] ?? event.toStatus}`
                    : event.kind === "credit"
                      ? "Credit applied"
                      : event.kind === "photo"
                        ? "Photo added"
                        : "Note",
                ),
                event.note ? h("p", { class: "timeline__note" }, event.note) : null,
                h(
                  "span",
                  { class: "timeline__meta" },
                  dateTime(event.at),
                  event.authorName ? ` · ${event.authorName}` : "",
                ),
              ),
            ),
          ),
        ),
      ),

      h(
        "section",
        { class: "card" },
        h("h2", { class: "card__title" }, "Add to this request"),
        h(
          "form",
          {
            class: "stack stack--sm",
            onSubmit: async (event: SubmitEvent) => {
              event.preventDefault();
              noteError.hidden = true;
              if (note.value.trim().length < 2) return;
              try {
                await tenant.addWorkOrderNote(workOrder.id, note.value);
                toast("Added.", "good");
                navigate(`/maintenance/${workOrder.id}`);
              } catch (caught) {
                noteError.textContent = caught instanceof ApiError ? caught.message : "Could not add that.";
                noteError.hidden = false;
              }
            },
          },
          note,
          noteError,
          h("button", { class: "btn btn--ghost", type: "submit" }, "Add note"),
        ),

        // Reopening matters: a queue that only staff can advance is a queue that
        // reflects what staff clicked rather than whether the problem is fixed.
        workOrder.status === "resolved" || workOrder.status === "closed"
          ? h(
              "div",
              { class: "stack stack--sm", style: { marginTop: "1.5rem" } },
              h("p", { class: "field__hint" }, "Still not fixed? Reopen it and someone will come back."),
              h(
                "button",
                {
                  class: "btn btn--ghost",
                  type: "button",
                  onClick: async () => {
                    const reason = note.value.trim() || "The problem is not resolved.";
                    try {
                      await tenant.reopenWorkOrder(workOrder.id, reason);
                      toast("Reopened.", "good");
                      navigate(`/maintenance/${workOrder.id}`);
                    } catch (caught) {
                      reportError(caught);
                    }
                  },
                },
                "Reopen this request",
              ),
            )
          : null,
      ),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Notices
 * ------------------------------------------------------------------ */

/**
 * Every message this system sent the resident, kept where they can read it.
 *
 * This turns "I was never told" from one party's word against the other's into
 * something either of them can check.
 */
export async function tenantNotices(mount: HTMLElement): Promise<void> {
  const { notifications } = await tenant.notifications();

  render(
    mount,
    h(
      "div",
      { class: "container container--narrow stack stack--lg" },
      h(
        "header",
        {},
        h("h1", {}, "Notices sent to you"),
        h(
          "p",
          { class: "lede" },
          "Every message this system has sent you about your account, kept here whether or not " +
            "it reached your inbox.",
        ),
      ),

      notifications.length === 0
        ? h("div", { class: "card" }, h("div", { class: "empty" }, "Nothing sent yet."))
        : h(
            "div",
            { class: "stack stack--sm" },
            ...notifications.map((item) =>
              h(
                "details",
                { class: "notice-item" },
                h(
                  "summary",
                  { class: "notice-item__summary" },
                  h("span", { class: "notice-item__subject" }, item.subject || item.event_type),
                  h(
                    "span",
                    { class: "notice-item__meta" },
                    dateTime(item.sent_at ?? item.created_at),
                    " · ",
                    item.channel,
                    item.status === "sent" ? "" : ` · ${item.status}`,
                  ),
                ),
                h("pre", { class: "notice-item__body" }, item.body),
              ),
            ),
          ),
    ),
  );
}
