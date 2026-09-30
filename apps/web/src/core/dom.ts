/**
 * A very small DOM layer.
 *
 * Not a framework. `h()` builds elements, `render()` swaps them in, and that is
 * the whole abstraction. This exists rather than React for the same reason the
 * database client exists rather than `pg`: the deployment target is a property
 * manager's own server, there is no build step to run or keep working, and the
 * client is small enough that a framework would be more code than the
 * application it carries.
 *
 * Text goes in through `textContent`, never `innerHTML`, so a maintenance
 * description a resident typed cannot become script in a manager's browser.
 * There is exactly one escape hatch — `raw()` — and it is used only for inline
 * SVG icons defined in this codebase.
 */

type Falsy = null | undefined | false | "";
export type Child = Node | string | number | Falsy | Child[];

export interface Attrs {
  class?: string | (string | Falsy)[];
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string | number | undefined>;
  [key: string]: unknown;
}

/**
 * Build an element.
 *
 *   h("button", { class: "btn", onClick: pay }, "Pay $1,200.00")
 *
 * Attributes starting with `on` become listeners, `class` accepts an array with
 * falsy entries dropped, and everything else is set as an attribute or, for
 * form state, as a property.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "class") {
      element.className = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value);
    } else if (key === "style" && typeof value === "object") {
      Object.assign(element.style, value);
    } else if (key === "dataset" && typeof value === "object") {
      for (const [dataKey, dataValue] of Object.entries(value as Record<string, unknown>)) {
        if (dataValue !== undefined) element.dataset[dataKey] = String(dataValue);
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "value" || key === "checked" || key === "disabled" || key === "selected") {
      // Form state is a property, not an attribute; setting the attribute only
      // changes the default and leaves a re-rendered input showing stale data.
      (element as unknown as Record<string, unknown>)[key] = value;
    } else if (value === true) {
      element.setAttribute(key, "");
    } else {
      element.setAttribute(key, String(value));
    }
  }

  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === "") continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    // Strings and numbers become text nodes. This is the line that makes stored
    // XSS impossible through the ordinary path.
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function render(container: Element, ...children: Child[]): void {
  container.replaceChildren();
  append(container, children);
}

export function clear(container: Element): void {
  container.replaceChildren();
}

/**
 * The single innerHTML escape hatch, for inline SVG defined in this codebase.
 * It is never called with anything that came from the server or from a person.
 */
export function raw(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

export function icon(path: string, size = 18): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
  node.setAttribute("d", path);
  svg.appendChild(node);
  return svg;
}

export const ICONS = {
  home: "M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  ledger: "M4 4h16v16H4zM8 8h8M8 12h8M8 16h5",
  card: "M2 7h20v10H2zM2 11h20",
  wrench: "M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-2-2 8-8z",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  check: "M20 6 9 17l-5-5",
  chevronRight: "m9 18 6-6-6-6",
  chevronDown: "m6 9 6 6 6-6",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  plus: "M12 5v14M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
} as const;

/** Focus trap and Escape handling for a modal, so keyboard users are not stranded. */
export function openDialog(dialog: HTMLDialogElement): void {
  dialog.showModal();
  const focusable = dialog.querySelector<HTMLElement>(
    "input:not([type=hidden]), select, textarea, button:not([disabled]), [href]",
  );
  focusable?.focus();
}

export function closeDialog(dialog: HTMLDialogElement): void {
  dialog.close();
  dialog.remove();
}
