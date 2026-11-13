// Sorting for every manager table: click a column header to sort by it, click
// again to flip the order. The choice is kept per table for the visit, so
// coming back to a screen keeps the order you left it in.
import { useMemo, useState, type ReactNode } from "react";

export type SortDir = "asc" | "desc";
export type SortValue = string | number | null | undefined;
export type SortKeys<T> = Record<string, (row: T) => SortValue>;

const remembered = new Map<string, { key: string; dir: SortDir }>();

function compare(a: SortValue, b: SortValue): number {
  // Blanks always last, whichever way the column is sorted (flipped back below).
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "" ? 0 : 1;
  if (b === null || b === undefined || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en-US", { numeric: true, sensitivity: "base" });
}

export interface Sorter<T> {
  rows: T[];
  key: string;
  dir: SortDir;
  toggle: (key: string) => void;
}

/**
 * Sort `rows` by one of `keys`. `id` names the table so its order is
 * remembered; `initial` is the starting column and direction.
 */
export function useSort<T>(id: string, rows: T[], keys: SortKeys<T>, initial: { key: string; dir: SortDir }): Sorter<T> {
  const [state, setState] = useState(() => remembered.get(id) ?? initial);
  const sorted = useMemo(() => {
    const get = keys[state.key];
    if (!get) return rows;
    const sign = state.dir === "asc" ? 1 : -1;
    return [...rows].sort((x, y) => {
      const a = get(x);
      const b = get(y);
      const blankA = a === null || a === undefined || a === "";
      const blankB = b === null || b === undefined || b === "";
      if (blankA || blankB) return compare(a, b);
      return sign * compare(a, b);
    });
    // `keys` is rebuilt every render; the column and direction are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, state.key, state.dir]);

  const toggle = (key: string) => {
    const next: { key: string; dir: SortDir } =
      state.key === key ? { key, dir: state.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir(rows, keys[key]) };
    remembered.set(id, next);
    setState(next);
  };
  return { rows: sorted, key: state.key, dir: state.dir, toggle };
}

/** Numbers start largest-first (who owes the most); words start A–Z. */
function defaultDir<T>(rows: T[], get?: (row: T) => SortValue): SortDir {
  if (!get) return "asc";
  const sample = rows.map(get).find((v) => v !== null && v !== undefined && v !== "");
  return typeof sample === "number" ? "desc" : "asc";
}

/** A column header that sorts its table. */
export function SortTh<T>({ sorter, k, children, num, className }: { sorter: Sorter<T>; k: string; children: ReactNode; num?: boolean; className?: string }) {
  const active = sorter.key === k;
  return (
    <th scope="col" className={[num ? "mgr-num" : "", className ?? ""].join(" ").trim() || undefined} aria-sort={active ? (sorter.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={`mgr-sort${active ? " mgr-sort--active" : ""}`} onClick={() => sorter.toggle(k)}>
        {children}
        <span className="mgr-sort__arrow" aria-hidden="true">
          {active ? (sorter.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

/** "Sort by" menu for screens laid out as cards or lists rather than tables. */
export function SortSelect<T>({ sorter, options }: { sorter: Sorter<T>; options: Array<[string, string]> }) {
  return (
    <label className="mgr-sort-select">
      <span className="mgr-muted">Sort by</span>
      <select value={sorter.key} onChange={(e) => sorter.toggle(e.target.value)} aria-label="Sort by">
        {options.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => sorter.toggle(sorter.key)} aria-label={`Order: ${sorter.dir === "asc" ? "ascending" : "descending"}. Flip`}>
        {sorter.dir === "asc" ? "▲ Ascending" : "▼ Descending"}
      </button>
    </label>
  );
}
