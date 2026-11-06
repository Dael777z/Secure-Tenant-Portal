// Search (009): one box for residents, units, properties, portfolios, requests,
// listings, documents and payments. Opens with "/" or Ctrl/⌘+K. Maintenance
// staff search only maintenance requests (the server decides).
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { search, type SearchHit, type SearchKind } from "./additions-api";

const GROUPS: Array<[SearchKind, string]> = [
  ["tenant", "Residents"],
  ["unit", "Units"],
  ["property", "Properties"],
  ["portfolio", "Portfolios"],
  ["maintenance", "Maintenance"],
  ["listing", "Listings"],
  ["document", "Documents"],
  ["payment", "Payments"],
];

/** Where a result opens (a hash route). */
function hrefFor(hit: SearchHit): string {
  switch (hit.kind) {
    case "tenant":
      return `#/tenants/${hit.id}`;
    case "unit":
      return `#/units/${hit.id}`;
    case "property":
      return `#/properties/${hit.id}`;
    case "portfolio":
      return "#/portfolios";
    case "maintenance":
      return `#/maintenance/${hit.id}`;
    case "listing":
      return `#/listings/${hit.id}`;
    case "document":
      return hit.tenantId ? `#/tenants/${hit.tenantId}?tab=documents` : hit.unitId ? `#/units/${hit.unitId}?tab=documents` : hit.leaseId ? `#/leases/${hit.leaseId}` : "#/documents";
    case "payment":
      return hit.leaseId ? `#/leases/${hit.leaseId}` : "#/payments?period=this-month";
  }
}

/** "/" (outside a text box) or Ctrl/⌘+K anywhere opens search. */
export function useSearchShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        open();
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
}

export function SearchButton({ onOpen, compact }: { onOpen: () => void; compact?: boolean }) {
  return (
    <button type="button" className={`mgr-search-btn${compact ? " mgr-search-btn--compact" : ""}`} onClick={onOpen} aria-haspopup="dialog" aria-keyshortcuts="/ Control+K">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <span>Search</span>
      {!compact && <kbd aria-hidden="true">/</kbd>}
    </button>
  );
}

export function SearchDialog({ onClose, onlyMaintenance }: { onClose: () => void; onlyMaintenance: boolean }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();
  const optionId = (i: number) => `${uid}-hit-${i}`;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => before?.focus?.();
  }, []);

  // Ask the server 180 ms after the typing stops; a newer query cancels the older one.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setState("idle");
      return;
    }
    const abort = new AbortController();
    setState("loading");
    const timer = window.setTimeout(() => {
      search(q, abort.signal)
        .then((found) => {
          setHits(found);
          setActive(0);
          setState("done");
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") setState("error");
        });
    }, 180);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const ordered = useMemo(() => GROUPS.flatMap(([kind]) => hits.filter((h) => h.kind === kind)), [hits]);
  const openHit = useCallback(
    (hit: SearchHit) => {
      onClose();
      window.location.hash = hrefFor(hit);
    },
    [onClose],
  );

  useEffect(() => {
    list.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!ordered.length) return;
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + ordered.length) % ordered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = ordered[active];
      if (hit) openHit(hit);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const q = query.trim();
  let index = -1;
  return (
    <div className="mgr-modal-backdrop mgr-search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mgr-search" role="dialog" aria-modal="true" aria-label="Search">
        <div className="mgr-search__bar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-expanded={ordered.length > 0}
            aria-controls={`${uid}-list`}
            aria-activedescendant={ordered.length ? optionId(active) : undefined}
            aria-autocomplete="list"
            aria-label="Search"
            placeholder={onlyMaintenance ? "Search maintenance requests" : "Search residents, units, properties, requests, documents, payments…"}
            value={query}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <button type="button" className="mgr-search__close" onClick={onClose}>
            Esc
          </button>
        </div>
        <div className="mgr-search__results" id={`${uid}-list`} role="listbox" aria-label="Results" ref={list}>
          {GROUPS.map(([kind, label]) => {
            const group = hits.filter((h) => h.kind === kind);
            if (!group.length) return null;
            return (
              <div key={kind} role="group" aria-label={label} className="mgr-search__group">
                <div className="mgr-search__label" aria-hidden="true">
                  {label}
                </div>
                {group.map((hit) => {
                  index += 1;
                  const i = index;
                  return (
                    <a
                      key={`${hit.kind}-${hit.id}-${hit.title}`}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === active}
                      href={hrefFor(hit)}
                      tabIndex={-1}
                      className={`mgr-search__hit${i === active ? " mgr-search__hit--active" : ""}`}
                      onMouseMove={() => setActive(i)}
                      onClick={(e) => {
                        e.preventDefault();
                        openHit(hit);
                      }}
                    >
                      <span className="mgr-search__title">{hit.title}</span>
                      {hit.detail && <span className="mgr-search__detail">{hit.detail}</span>}
                    </a>
                  );
                })}
              </div>
            );
          })}
        </div>
        <p className="mgr-search__status" role="status" aria-live="polite">
          {q.length < 2
            ? `Type at least 2 characters.${onlyMaintenance ? "" : " A name, email, phone, unit, address, request, file name or confirmation number."}`
            : state === "loading"
              ? "Searching…"
              : state === "error"
                ? "Search isn't available right now. Try again in a moment."
                : ordered.length
                  ? `${ordered.length} result${ordered.length === 1 ? "" : "s"}. ↑ ↓ to move, Enter to open.`
                  : `Nothing matches “${q}”.`}
        </p>
      </div>
    </div>
  );
}
