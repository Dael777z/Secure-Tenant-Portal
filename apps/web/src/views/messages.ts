/**
 * Messages — one set of screens for both sides of a conversation.
 *
 *   /messages, /messages/:threadId                   a resident
 *   /manage/messages, /manage/messages/:threadId     managers and on-site staff
 *
 * The server decides what each person can see (Row-Level Security, migration
 * 011); these screens only choose which endpoints to call. A resident always
 * writes about their own tenancy. Management picks the resident; on-site staff
 * can open maintenance conversations only.
 */

import { h, render, openDialog, closeDialog, type Child } from "../core/dom.ts";
import { messages, manager, ApiError } from "../core/api.ts";
import { isManagerSide, linkHandler, navigate, refreshUnread, reportError, state, toast } from "../core/app.ts";
import { dateTime, timeAgo } from "../core/fmt.ts";
import { MESSAGE_TOPICS, MESSAGE_TOPIC_LABELS } from "/shared/api.js";
import type { Message, MessageThread } from "/shared/api.js";

type Side = "tenant" | "manager";

function side(): Side {
  return isManagerSide() ? "manager" : "tenant";
}

function base(): string {
  return side() === "manager" ? "/manage/messages" : "/messages";
}

function button(label: string, options: { primary?: boolean; onClick?: (e: MouseEvent) => void; type?: "button" | "submit"; disabled?: boolean } = {}): HTMLButtonElement {
  const managerSide = side() === "manager";
  const cls = managerSide
    ? ["ws-btn", options.primary ? "ws-btn--primary" : "ws-btn--secondary"]
    : ["btn", options.primary ? "btn--primary" : "btn--ghost"];
  return h(
    "button",
    { class: cls, type: options.type ?? "button", disabled: options.disabled ?? false, onClick: options.onClick ?? null },
    label,
  );
}

/* ------------------------------------------------------------------ *
 * The inbox
 * ------------------------------------------------------------------ */

export async function messagesInbox(mount: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const filter = params.get("filter") ?? "all";
  const status = filter === "open" || filter === "closed" ? filter : undefined;
  const data = await messages.list(side(), { status, unread: filter === "unread" ? "1" : undefined });

  const staff = state.user?.role === "staff";
  const filters: Array<[string, string]> = [
    ["all", "All"],
    ["unread", "Unread"],
    ["open", "Open"],
    ["closed", "Closed"],
  ];

  render(
    mount,
    h(
      "div",
      { class: ["msg-page", side() === "tenant" && "container container--narrow"] },
      h(
        "header",
        { class: "msg-page__header" },
        h("h1", { class: side() === "manager" ? "ws-h1" : "" }, "Messages"),
        h(
          "p",
          { class: side() === "manager" ? "ws-sub" : "lede" },
          side() === "manager"
            ? staff
              ? "Maintenance conversations with residents at your properties."
              : "Conversations with residents. Each one stays with the resident's account."
            : "Write to the office about anything — rent, a charge, a repair, your lease. Replies appear here and by email.",
        ),
      ),
      h(
        "div",
        { class: "msg-toolbar" },
        ...filters.map(([value, label]) =>
          side() === "manager"
            ? h(
                "button",
                {
                  class: ["ws-btn", filter === value ? "ws-btn--primary" : "ws-btn--secondary"],
                  type: "button",
                  "aria-pressed": filter === value ? "true" : "false",
                  onClick: () => navigate(value === "all" ? base() : `${base()}?filter=${value}`),
                },
                label,
              )
            : h(
                "button",
                {
                  class: ["chip", filter === value && "is-active"],
                  type: "button",
                  "aria-pressed": filter === value ? "true" : "false",
                  onClick: () => navigate(value === "all" ? base() : `${base()}?filter=${value}`),
                },
                label,
              ),
        ),
        h("span", { class: "msg-toolbar__spacer" }),
        button("+ New Message", { primary: true, onClick: () => void openNewThreadDialog() }),
      ),
      data.threads.length === 0
        ? h(
            "p",
            { class: "msg-empty" },
            filter === "all"
              ? "No conversations yet. Start one with “New Message”."
              : "Nothing here with that filter.",
          )
        : h("ul", { class: "msg-list" }, ...data.threads.map((thread) => h("li", {}, threadItem(thread)))),
    ),
  );
}

function threadItem(thread: MessageThread): HTMLElement {
  const href = `${base()}/${thread.id}`;
  const who =
    side() === "manager"
      ? `${thread.residentName ?? "Resident"} · Unit ${thread.unitLabel}`
      : thread.startedBy === "resident"
        ? "You started this"
        : "From the office";
  return h(
    "a",
    { class: ["msg-item", thread.unreadCount > 0 && "msg-item--unread"], href, onClick: linkHandler(href) },
    h("span", { class: "msg-item__subject" }, thread.subject),
    h(
      "span",
      { class: "msg-item__when" },
      thread.unreadCount > 0 ? h("span", { class: "msg-badge", "aria-label": `${thread.unreadCount} unread` }, String(thread.unreadCount)) : null,
      " ",
      timeAgo(thread.lastMessageAt),
    ),
    h(
      "span",
      { class: "msg-item__meta" },
      `${who} · ${MESSAGE_TOPIC_LABELS[thread.topic]}`,
      thread.status === "closed" ? " · closed" : "",
    ),
    thread.lastMessagePreview
      ? h(
          "span",
          { class: "msg-item__preview" },
          `${thread.lastFromResident === (side() === "tenant") ? "You" : thread.lastAuthorName ?? ""}: ${thread.lastMessagePreview}`,
        )
      : null,
  );
}

/* ------------------------------------------------------------------ *
 * One conversation
 * ------------------------------------------------------------------ */

export async function messagesThread(mount: HTMLElement, params: Record<string, string>): Promise<void> {
  const data = await messages.get(side(), params.threadId);
  const { thread } = data;
  // Opening the thread marked it read on the server; update the nav badge.
  refreshUnread(true);

  const textarea = h("textarea", {
    class: "textarea",
    id: "reply",
    placeholder: thread.status === "closed" ? "This conversation is closed." : "Write a reply…",
    disabled: thread.status === "closed",
    maxlength: "4000",
    "aria-label": "Reply",
  });
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const send = button("Send", { primary: true, type: "submit", disabled: thread.status === "closed" });

  const list = h("ol", { class: "msg-thread", "aria-live": "polite" }, ...data.messages.map(bubble));

  const related: Child[] = [];
  if (thread.ledgerEntryId && side() === "tenant") {
    const href = `/ledger/${thread.ledgerEntryId}`;
    related.push(h("a", { class: "msg-link", href, onClick: linkHandler(href) }, "View the charge this is about →"));
  }
  if (thread.ledgerEntryId && side() === "manager" && state.user?.role !== "staff") {
    const href = `/manage/tenancy/${thread.tenancyId}`;
    related.push(h("a", { class: "msg-link", href, onClick: linkHandler(href) }, "Open this resident's ledger →"));
  }
  if (thread.workOrderId) {
    const href = side() === "manager" ? `/manage/maintenance/${thread.workOrderId}` : `/maintenance/${thread.workOrderId}`;
    related.push(h("a", { class: "msg-link", href, onClick: linkHandler(href) }, "Open the maintenance request →"));
  }
  if (side() === "manager" && !thread.ledgerEntryId && state.user?.role === "manager") {
    const href = `/manage/tenancy/${thread.tenancyId}`;
    related.push(h("a", { class: "msg-link", href, onClick: linkHandler(href) }, "Open this resident's account →"));
  }

  const toggle = button(thread.status === "closed" ? "Reopen conversation" : "Close conversation", {
    onClick: async () => {
      toggle.disabled = true;
      try {
        await messages.setStatus(side(), thread.id, thread.status === "closed" ? "open" : "closed");
        toast(thread.status === "closed" ? "Conversation reopened." : "Conversation closed.", "good");
        navigate(location.pathname);
      } catch (caught) {
        reportError(caught);
        toggle.disabled = false;
      }
    },
  });

  render(
    mount,
    h(
      "div",
      { class: ["msg-page", side() === "tenant" && "container container--narrow"] },
      h(
        "a",
        { class: side() === "manager" ? "ws-back" : "back-link", href: base(), onClick: linkHandler(base()) },
        side() === "manager" ? [h("span", { class: "ws-back__arrow", "aria-hidden": "true" }, "←"), h("span", {}, "Messages")] : "← All messages",
      ),
      h(
        "header",
        {},
        h("h1", { class: side() === "manager" ? "ws-h2" : "" }, thread.subject),
        h(
          "p",
          { class: side() === "manager" ? "ws-detail__meta" : "field__hint" },
          side() === "manager" ? `${thread.residentName ?? "Resident"} · ${thread.propertyName} · Unit ${thread.unitLabel} · ` : "",
          MESSAGE_TOPIC_LABELS[thread.topic],
          thread.status === "closed" ? " · closed" : "",
        ),
      ),
      related.length ? h("div", { class: "msg-toolbar" }, ...related) : null,
      list,
      h(
        "form",
        {
          class: "msg-compose",
          onSubmit: async (event: SubmitEvent) => {
            event.preventDefault();
            error.hidden = true;
            const body = textarea.value.trim();
            if (!body) {
              error.textContent = "Write a message first.";
              error.hidden = false;
              textarea.focus();
              return;
            }
            send.disabled = true;
            try {
              const result = await messages.reply(side(), thread.id, body);
              list.appendChild(bubble(result.message));
              textarea.value = "";
              toast("Sent.", "good");
            } catch (caught) {
              error.textContent = caught instanceof ApiError ? caught.message : "Could not send that.";
              error.hidden = false;
            } finally {
              send.disabled = thread.status === "closed";
            }
          },
        },
        textarea,
        error,
        h("div", { class: "msg-compose__row" }, toggle, send),
      ),
    ),
  );
}

function bubble(message: Message): HTMLElement {
  const who = message.mine ? "You" : message.fromResident ? message.authorName : `${message.authorName} · ${roleWord(message.authorRole)}`;
  return h(
    "li",
    { class: ["msg-bubble", message.mine && "msg-bubble--mine"] },
    h("span", { class: "msg-bubble__who" }, `${who} · ${dateTime(message.createdAt)}`),
    h("p", { class: "msg-bubble__body" }, message.body),
  );
}

function roleWord(role: string): string {
  return role === "manager" ? "Property manager" : role === "staff" ? "On-site staff" : role === "system_job" ? "Automatic" : "Office";
}

/* ------------------------------------------------------------------ *
 * New conversation
 * ------------------------------------------------------------------ */

/**
 * Opens the compose dialog. `preset` lets other screens start a conversation
 * about something specific (a charge, a work order, a resident).
 */
export async function openNewThreadDialog(
  preset: { tenancyId?: string; subject?: string; topic?: string; ledgerEntryId?: string; workOrderId?: string } = {},
): Promise<void> {
  const management = side() === "manager";
  const staff = state.user?.role === "staff";

  let recipient: HTMLSelectElement | null = null;
  if (management && !preset.tenancyId) {
    let choices: Array<{ value: string; label: string }> = [];
    try {
      if (staff) {
        // Staff cannot read tenancies; the residents they can reach are the ones
        // with maintenance requests at their properties.
        const orders = await manager.workOrders({ status: "all" });
        const seen = new Set<string>();
        for (const order of orders.workOrders) {
          if (seen.has(order.tenancyId)) continue;
          seen.add(order.tenancyId);
          choices.push({ value: order.tenancyId, label: `${order.unitLabel} — ${order.residentName ?? "Resident"}` });
        }
      } else {
        const roll = await manager.rentRoll({ limit: 1000 });
        choices = roll.rows.map((row) => ({ value: row.tenancyId, label: `${row.unitLabel} — ${row.residentName} (${row.propertyName})` }));
      }
    } catch (caught) {
      reportError(caught);
      return;
    }
    recipient = h(
      "select",
      { class: "select", required: true, id: "msg-to" },
      h("option", { value: "" }, "Choose a resident"),
      ...choices.map((c) => h("option", { value: c.value }, c.label)),
    );
  }

  const topics = staff ? (["maintenance"] as const) : MESSAGE_TOPICS;
  const topic = h(
    "select",
    { class: "select", id: "msg-topic" },
    ...topics.map((value) => h("option", { value, selected: value === (preset.topic ?? (staff ? "maintenance" : "general")) }, MESSAGE_TOPIC_LABELS[value])),
  );
  const subject = h("input", { class: "input", id: "msg-subject", required: true, maxlength: "140", value: preset.subject ?? "", placeholder: "What is this about?" });
  const body = h("textarea", { class: "textarea", id: "msg-body", required: true, maxlength: "4000", placeholder: "Your message" });
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: management ? "ws-btn ws-btn--primary" : "btn btn--primary", type: "submit" }, "Send message");

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
            const result = await messages.start(side(), {
              tenancyId: preset.tenancyId ?? recipient?.value ?? undefined,
              subject: subject.value.trim(),
              topic: topic.value,
              body: body.value.trim(),
              ledgerEntryId: preset.ledgerEntryId,
              workOrderId: preset.workOrderId,
            });
            closeDialog(dialog);
            toast("Message sent.", "good");
            navigate(`${base()}/${result.thread.id}`);
          } catch (caught) {
            error.textContent = caught instanceof ApiError ? caught.message : "Could not send that.";
            error.hidden = false;
            submit.disabled = false;
          }
        },
      },
      h("div", { class: "dialog__header" }, h("h2", { class: "dialog__title" }, management ? "Message a resident" : "Message the office")),
      h(
        "div",
        { class: "dialog__body" },
        recipient ? h("label", { class: "field", for: "msg-to" }, h("span", { class: "field__label" }, "To"), recipient) : null,
        h("label", { class: "field", for: "msg-topic" }, h("span", { class: "field__label" }, "Topic"), topic),
        h("label", { class: "field", for: "msg-subject" }, h("span", { class: "field__label" }, "Subject"), subject),
        h("label", { class: "field", for: "msg-body" }, h("span", { class: "field__label" }, "Message"), body),
        error,
      ),
      h(
        "div",
        { class: "dialog__footer" },
        h("button", { class: management ? "ws-btn ws-btn--ghost" : "btn btn--ghost", type: "button", onClick: () => closeDialog(dialog) }, "Cancel"),
        submit,
      ),
    ),
  ) as HTMLDialogElement;

  document.body.appendChild(dialog);
  openDialog(dialog);
}
