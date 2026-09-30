/**
 * Building blocks for the manager workspace, one per component in the Figma
 * prototype's library (Card/KPI, Field/Dropdown, Field/Search, Button, Status
 * Pill, Item/Activity, Item/Alert, Card/Panel, Progress/Bar, pagination).
 *
 * They are plain functions over h(), like the rest of the client, so a screen
 * reads as a list of the same components the design file is built from.
 */

import { h, type Child } from "./dom.ts";
import { linkHandler } from "./app.ts";

export type Tone = "success" | "danger" | "warning" | "info" | "muted";

/** Page title, subtitle, and the control that sits to its right (Header). */
export function wsHeader(title: string, subtitle: string, control?: Child, controlClass = ""): HTMLElement {
  return h(
    "header",
    { class: "ws-header" },
    h(
      "div",
      { class: "ws-header__title" },
      h("h1", { class: "ws-h1" }, title),
      h("p", { class: "ws-sub" }, subtitle),
    ),
    control ? h("div", { class: ["ws-header__control", controlClass] }, control) : null,
  );
}

/** Card/KPI. Pass `href` to make the whole card a link to the screen behind the number. */
export function kpi(title: string, value: string, detail: string, href?: string): HTMLElement {
  const children = [
    h("span", { class: "ws-kpi__title" }, title),
    h("span", { class: "ws-kpi__value" }, value),
    h("span", { class: "ws-kpi__detail" }, detail),
  ];
  return href
    ? h("a", { class: "ws-kpi", href, onClick: linkHandler(href) }, ...children)
    : h("div", { class: "ws-kpi" }, ...children);
}

export function kpiRow(cards: HTMLElement[], mobile = false): HTMLElement {
  return h("section", { class: ["ws-kpis", mobile && "ws-kpis--mobile"], "aria-label": "Key figures" }, ...cards);
}

/** Field/Dropdown, as a real <select> so it works with a keyboard and a screen reader. */
export function selectField(options: {
  label: string;
  value: string;
  choices: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  width?: "default" | "wide" | "block";
}): HTMLElement {
  const select = h(
    "select",
    {
      "aria-label": options.label,
      onChange: (event: Event) => options.onChange((event.target as HTMLSelectElement).value),
    },
    ...options.choices.map((choice) =>
      h("option", { value: choice.value, selected: choice.value === options.value }, choice.label),
    ),
  );
  return h(
    "label",
    {
      class: [
        "ws-field",
        "ws-field--select",
        options.width === "wide" && "ws-field--wide",
        options.width === "block" && "ws-field--block",
      ],
    },
    select,
  );
}

/** Field/Search. Calls back after the person pauses typing, not on every key. */
export function searchField(options: {
  label: string;
  placeholder: string;
  value: string;
  onSearch: (value: string) => void;
}): HTMLElement {
  const input = h("input", {
    type: "search",
    placeholder: options.placeholder,
    value: options.value,
    "aria-label": options.label,
  });
  let timer: ReturnType<typeof setTimeout>;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => options.onSearch(input.value.trim()), 300);
  });
  return h("label", { class: ["ws-field", "ws-field--search"] }, input);
}

/** Button — Style=Primary / Secondary / Ghost. Give `href` for navigation, `onClick` for an action. */
export function wsButton(
  label: Child,
  options: {
    style?: "primary" | "secondary" | "ghost";
    href?: string;
    onClick?: (event: MouseEvent) => void;
    disabled?: boolean;
    block?: boolean;
    download?: boolean;
    type?: "button" | "submit";
  } = {},
): HTMLElement {
  const cls = ["ws-btn", `ws-btn--${options.style ?? "primary"}`, options.block && "ws-btn--block"];
  if (options.href) {
    return h(
      "a",
      {
        class: cls,
        href: options.href,
        download: options.download || null,
        onClick: options.download ? null : linkHandler(options.href),
      },
      label,
    );
  }
  return h(
    "button",
    { class: cls, type: options.type ?? "button", disabled: options.disabled ?? false, onClick: options.onClick ?? null },
    label,
  );
}

/** Status Pill. `compact` is the mobile detail variant with a leading dot. */
export function pill(label: string, tone: Tone, compact = false): HTMLElement {
  return h(
    "span",
    { class: ["ws-pill", compact && "ws-pill--compact", `ws-tone--${tone}`] },
    compact ? h("span", { "aria-hidden": "true" }, "●") : null,
    h("span", {}, label),
  );
}

/** "Showing 1–6 of 248 units", Previous, Next →. */
export function pager(options: {
  page: number;
  pageSize: number;
  total: number;
  noun: string;
  onPage: (page: number) => void;
}): HTMLElement {
  const first = options.total === 0 ? 0 : options.page * options.pageSize + 1;
  const last = Math.min(options.total, (options.page + 1) * options.pageSize);
  const pages = Math.max(1, Math.ceil(options.total / options.pageSize));
  return h(
    "nav",
    { class: "ws-pager", "aria-label": "Pages" },
    h("p", { class: "ws-pager__count", "aria-live": "polite" }, `Showing ${first}–${last} of ${options.total} ${options.noun}`),
    wsButton("Previous", {
      style: "ghost",
      disabled: options.page <= 0,
      onClick: () => options.onPage(options.page - 1),
    }),
    wsButton("Next →", {
      style: "secondary",
      disabled: options.page >= pages - 1,
      onClick: () => options.onPage(options.page + 1),
    }),
  );
}

/** Item/Activity. */
export function activityItem(title: string, detail: string, time: string, href?: string | null): HTMLElement {
  const children = [
    h("span", { class: "ws-activity__dot", "aria-hidden": "true" }, "●"),
    h(
      "span",
      { class: "ws-activity__text" },
      h("span", { class: "ws-activity__title" }, title),
      h("span", { class: "ws-activity__detail" }, detail),
    ),
    h("span", { class: "ws-activity__time" }, time),
  ];
  return href
    ? h("a", { class: "ws-activity__item", href, onClick: linkHandler(href) }, ...children)
    : h("div", { class: "ws-activity__item" }, ...children);
}

/** Item/Alert. */
export function alertItem(title: string, detail: string, meta: string, href?: string | null): HTMLElement {
  const children = [
    h("span", { class: "ws-alert__title" }, title),
    detail ? h("span", { class: "ws-alert__detail" }, detail) : null,
    h("span", { class: "ws-alert__meta" }, href ? `${meta}  →` : meta),
  ];
  return href
    ? h("a", { class: "ws-alert", href, onClick: linkHandler(href) }, ...children)
    : h("div", { class: "ws-alert" }, ...children);
}

/** Card/Panel — a quick action on the mobile home. */
export function actionCard(title: string, sub: string, href: string): HTMLElement {
  return h(
    "a",
    { class: "ws-action", href, onClick: linkHandler(href) },
    h("span", { class: "ws-action__title" }, title),
    h("span", { class: "ws-action__sub" }, sub),
  );
}

/** Progress/Bar. */
export function progress(fraction: number, label: string): HTMLElement {
  const clamped = Math.max(0, Math.min(1, fraction));
  return h(
    "div",
    {
      class: "ws-progress",
      role: "progressbar",
      "aria-label": label,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(Math.round(clamped * 100)),
    },
    h("div", { class: "ws-progress__fill", style: { width: `${clamped * 100}%` } }),
  );
}

/** Work-order priority in the prototype's words, with the data model's word kept as a tooltip. */
export const PRIORITY_DISPLAY: Record<string, { label: string; tone: Tone }> = {
  emergency: { label: "High", tone: "danger" },
  urgent: { label: "Medium", tone: "warning" },
  routine: { label: "Low", tone: "muted" },
};

/** Work-order status in the prototype's pill colours. */
export function workOrderPill(status: string, label: string, compact = false): HTMLElement {
  const tone: Tone =
    status === "resolved" || status === "closed"
      ? "success"
      : status === "scheduled" || status === "acknowledged"
        ? "warning"
        : status === "cancelled"
          ? "muted"
          : "info";
  return pill(label, tone, compact);
}
