// Small building blocks shared by the manager screens.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { SessionUser } from "../api/auth";
import { managerMessage } from "./api";
import type { FinancePeriod } from "./finance-api";

/* ------------------------------------------------------------------ *
 * Routes (kept in the URL hash so Back and reload work)
 * ------------------------------------------------------------------ */

export type Route =
  | { name: "dashboard" }
  | { name: "properties" }
  | { name: "property"; id: number }
  | { name: "rent-roll"; filter?: "owing" | "current" | "vacant" }
  | { name: "tenants" }
  | { name: "lease"; id: number }
  | { name: "maintenance" }
  | { name: "messages"; tenantId?: number }
  | { name: "updates" }
  | { name: "finance"; period: FinancePeriod }
  | { name: "pnl"; period: FinancePeriod }
  | { name: "performance" }
  | { name: "renewals"; days: number }
  | { name: "setup" };

const PERIOD_KEYS: FinancePeriod[] = ["this-month", "30d", "90d", "ytd", "12m"];
const periodFrom = (query: string, fallback: FinancePeriod): FinancePeriod => {
  const p = new URLSearchParams(query).get("period");
  return PERIOD_KEYS.includes(p as FinancePeriod) ? (p as FinancePeriod) : fallback;
};

export function parseRoute(hash: string): Route | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [head, id] = path.split("/");
  const n = Number(id);
  switch (head) {
    case "dashboard":
      return { name: "dashboard" };
    case "properties":
      return Number.isInteger(n) && n > 0 ? { name: "property", id: n } : { name: "properties" };
    case "rent-roll": {
      const filter = new URLSearchParams(query).get("status");
      return filter === "owing" || filter === "current" || filter === "vacant" ? { name: "rent-roll", filter } : { name: "rent-roll" };
    }
    case "tenants":
      return { name: "tenants" };
    case "leases":
      return Number.isInteger(n) && n > 0 ? { name: "lease", id: n } : null;
    case "maintenance":
      return { name: "maintenance" };
    case "updates":
      return { name: "updates" };
    case "messages":
      return Number.isInteger(n) && n > 0 ? { name: "messages", tenantId: n } : { name: "messages" };
    case "finance":
      return { name: "finance", period: periodFrom(query, "this-month") };
    case "profit-and-loss":
      return { name: "pnl", period: periodFrom(query, "ytd") };
    case "performance":
      return { name: "performance" };
    case "renewals": {
      const d = Number(new URLSearchParams(query).get("days"));
      return { name: "renewals", days: [30, 60, 90, 180].includes(d) ? d : 90 };
    }
    case "setup":
      return { name: "setup" };
    default:
      return null;
  }
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case "property":
      return `#/properties/${route.id}`;
    case "lease":
      return `#/leases/${route.id}`;
    case "rent-roll":
      return route.filter ? `#/rent-roll?status=${route.filter}` : "#/rent-roll";
    case "messages":
      return route.tenantId ? `#/messages/${route.tenantId}` : "#/messages";
    case "finance":
      return `#/finance?period=${route.period}`;
    case "pnl":
      return `#/profit-and-loss?period=${route.period}`;
    case "renewals":
      return `#/renewals?days=${route.days}`;
    default:
      return `#/${route.name}`;
  }
}

/* ------------------------------------------------------------------ *
 * Dialogs the quick actions and screens can open
 * ------------------------------------------------------------------ */

export type Dialog =
  | { kind: "lease"; unitId?: number }
  | { kind: "property"; id?: number; name?: string; address?: string }
  | { kind: "unit"; propertyId?: number; id?: number; unitNum?: string }
  | { kind: "payment"; leaseId?: number }
  | { kind: "tenant" }
  | { kind: "editTenant"; id: number; name: string; phone: string | null }
  | { kind: "maintenance"; unitId?: number }
  | { kind: "rent"; leaseId: number; monthlyRent: number }
  | { kind: "endLease"; leaseId: number; label: string }
  | { kind: "addResident"; leaseId: number }
  | { kind: "attachReceipt"; leaseId: number; paymentId: number; label: string }
  | { kind: "charge"; leaseId: number; label: string }
  | { kind: "expense"; propertyId?: number }
  | { kind: "renewal"; leaseId: number; label: string; residents: string[] }
  | {
      kind: "confirm";
      title: string;
      body: string;
      confirmLabel: string;
      run: () => Promise<unknown>;
      done: string;
      /** Where to go afterwards (for example, off a lease page that no longer exists). */
      after?: Route;
    };

/* ------------------------------------------------------------------ *
 * App context
 * ------------------------------------------------------------------ */

export interface ManagerContextValue {
  user: SessionUser;
  can: (permission: string) => boolean;
  go: (route: Route) => void;
  open: (dialog: Dialog) => void;
  /** Bumped after every change; screens reload when it moves. */
  version: number;
  changed: (message?: string) => void;
}

export const ManagerContext = createContext<ManagerContextValue | null>(null);

export function useManager(): ManagerContextValue {
  const ctx = useContext(ManagerContext);
  if (!ctx) throw new Error("useManager outside ManagerApp");
  return ctx;
}

/** Load something, again whenever data changes anywhere in the app. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const { version } = useManager();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    setError(null);
    loadRef
      .current()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(managerMessage(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);

  return { data, error };
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function money(amount: number, cents = true): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

/** "2026-10-01" → "Oct 1, 2026" (no time-zone shift). */
export function isoDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(`${value}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/* ------------------------------------------------------------------ *
 * Components
 * ------------------------------------------------------------------ */

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mgr-page-header">
      <div>
        <h1 className="mgr-h1">{title}</h1>
        {subtitle && <p className="mgr-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="mgr-page-actions">{actions}</div>}
    </header>
  );
}

export function Loading({ error }: { error: string | null }) {
  if (error) return <p className="mgr-alert mgr-alert--error" role="alert">{error}</p>;
  return <p className="mgr-loading" aria-busy="true">Loading…</p>;
}

export function Kpi({ label, value, note, onClick, tone }: { label: string; value: string; note?: string; onClick?: () => void; tone?: "warn" | "good" }) {
  const body = (
    <>
      <span className="mgr-kpi__label">{label}</span>
      <span className={`mgr-kpi__value${tone ? ` mgr-kpi__value--${tone}` : ""}`}>{value}</span>
      {note && <span className="mgr-kpi__note">{note}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className="mgr-kpi mgr-kpi--link" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="mgr-kpi">{body}</div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  vacant: "Vacant",
  current: "Paid up",
  owing: "Owes rent",
  submitted: "New",
  in_progress: "In progress",
  resolved: "Resolved",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`mgr-pill mgr-pill--${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="mgr-empty">{children}</p>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", onKey);
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not(.mgr-modal__close)")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, []);
  return (
    <div className="mgr-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mgr-modal" role="dialog" aria-modal="true" aria-labelledby="mgr-modal-title" ref={ref}>
        <header className="mgr-modal__header">
          <h2 id="mgr-modal-title" className="mgr-h2">{title}</h2>
          <button type="button" className="mgr-modal__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mgr-field">
      <span className="mgr-field__label">{label}</span>
      {children}
      {hint && <span className="mgr-field__hint">{hint}</span>}
    </label>
  );
}

/** Submit handling for a dialog form: busy state, error text, close on success. */
export function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (work: () => Promise<unknown>, messages: Record<string, string> = {}) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        onDone();
      } catch (e) {
        const code = (e as { code?: string }).code;
        setError((code && messages[code]) || (e instanceof LocalError ? e.message : managerMessage(e)));
      } finally {
        setBusy(false);
      }
    },
    [onDone],
  );
  return { busy, error, run };
}

/**
 * Tables that don't fit their box show each row as a card ("Owed  $1,820.00").
 * This gives every body and footer cell a data-label with its column's
 * heading, so the CSS can print it (cells labelled by hand are left alone),
 * and switches a table to cards only while it is too wide to show whole.
 */
export function useTableLabels(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const label = () => {
      frame = 0;
      for (const table of el.querySelectorAll<HTMLTableElement>("table.mgr-table")) {
        const heads = [...table.querySelectorAll("thead tr:last-child th")].map((th) => (th.textContent ?? "").replace(/[▲▼↕]/g, "").trim());
        for (const tr of table.querySelectorAll("tbody tr, tfoot tr")) {
          let col = 0;
          for (const cell of tr.children as HTMLCollectionOf<HTMLTableCellElement>) {
            if (cell.tagName === "TD" && !cell.hasAttribute("data-label")) cell.setAttribute("data-label", heads[col] ?? "");
            col += cell.colSpan || 1;
          }
        }
      }
    };
    // A table that is wider than its box at its narrowest becomes cards
    // (one per row), so nothing ever scrolls sideways. Checked again on
    // every resize and content change; measured in table form each time.
    const fit = () => {
      for (const table of el.querySelectorAll<HTMLTableElement>("table.mgr-table")) {
        const box = table.parentElement;
        if (!box) continue;
        table.classList.remove("mgr-table--cards");
        const tooWide = table.scrollWidth > box.clientWidth + 1;
        table.classList.toggle("mgr-table--cards", tooWide);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        label();
        fit();
      });
    };
    const watch = new MutationObserver(schedule);
    watch.observe(el, { childList: true, subtree: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    label();
    fit();
    return () => {
      watch.disconnect();
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [root]);
}

/** A check that fails in the browser, before anything is sent. */
export class LocalError extends Error {}
