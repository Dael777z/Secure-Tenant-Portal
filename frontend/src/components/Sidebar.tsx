import type { ReactElement } from "react";
import type { PageKey, Tenant } from "../types";
import { Brand, ThemeSwitch } from "../theme/Brand";
import { useEffect, useRef, useState } from "react";

// Simple inline icons
const icons: Record<PageKey, ReactElement> = {
  home: (
    <svg className="portal-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </svg>
  ),
  pay: (
    <svg className="portal-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
    </svg>
  ),
  ledger: (
    <svg className="portal-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 4h13l3 3v13H4z" />
      <path d="M8 9h9M8 13h9M8 17h5" />
    </svg>
  ),
  maintenance: (
    <svg className="portal-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 7l3 3-8.5 8.5H5.5V15.5z" />
      <path d="M17.5 3.5l3 3-2 2-3-3z" />
    </svg>
  ),
  documents: (
    <svg className="portal-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  ),
  notices: (
    <svg className="portal-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 01-3.4 0" />
    </svg>
  ),
  settings: (
    <svg className="portal-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3"/>
    </svg>
  ),
};

/** "Good morning" / "Good afternoon" / "Good evening", by the device's clock. */
function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

const navItems: { key: PageKey; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "pay", label: "Pay rent" },
  { key: "ledger", label: "Ledger" },
  { key: "maintenance", label: "Maintenance" },
  { key: "documents", label: "Documents" },
  { key: "notices", label: "Notices" },
  { key: "settings", label: "Settings" },
];

// On phones these pages sit behind the "More" tab (see portal.css).
const MORE_PAGES: PageKey[] = ["ledger", "documents", "settings"];

interface SidebarProps {
  tenant: Tenant;
  activePage: PageKey;
  onNavigate: (page: PageKey) => void;
  onLogout: () => void; 
}

export function Sidebar({ tenant, activePage, onNavigate, onLogout }: SidebarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  
  //Escape closes the "More" sheet. 
  useEffect(() => {
    if (!moreOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [moreOpen]);
  
  return (
    <aside className="portal-sidebar" aria-label="Resident portal navigation">
      <div className="portal-brand">
        <Brand sub="Resident portal" size={32} />
      </div>
      <div className="portal-greeting">
        <div className="portal-avatar" aria-hidden="true">
          {tenant.initials}
        </div>
        <div className="portal-greeting-text">
          <div className="portal-greeting-hi">{greeting()},</div>
          <div className="portal-greeting-name">{tenant.name}</div>
        </div>
      </div>

      <div className="portal-unit-card">
        <div className="portal-unit-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 11l9-7 9 7" />
            <path d="M5 10v10h14V10" />
          </svg>
        </div>
        <div>
          <div className="portal-unit-name">{tenant.unitLabel}</div>
          <div className="portal-unit-address">{tenant.address}</div>
        </div>
      </div>

      <nav className="portal-nav">
        {navItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={"portal-nav-item" + (MORE_PAGES.includes(item.key) ? " portal-nav-item--more" : "")}
            aria-current={activePage === item.key ? "page" : undefined}
            onClick={() => onNavigate(item.key)}
          >
            {icons[item.key]}
            {item.label}
          </button>
        ))}
        <button
          ref={moreButtonRef}
          type="button"
          className="portal-nav-item portal-nav-more"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-current={MORE_PAGES.includes(activePage) ? "page" : undefined}
          onClick={() => setMoreOpen(true)}
        >
          <svg className="portal-nav-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
          More
        </button>
      </nav>

      {moreOpen && (
        <div className="portal-more-backdrop" onClick={() => setMoreOpen(false)}>
          <div
            className="portal-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More pages"
            onClick={(event) => event.stopPropagation()}
          >
            {navItems
              .filter((item) => MORE_PAGES.includes(item.key))
              .map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  className="portal-nav-item"
                  aria-current={activePage === item.key ? "page" : undefined}
                  autoFocus={index === 0}
                  onClick={() => {
                    setMoreOpen(false);
                    onNavigate(item.key);
                  }}
                >
                  {icons[item.key]}
                  {item.label}
                </button>
              ))}
          </div>
        </div>
      )}

      <div className="portal-sidebar-footer">
        <ThemeSwitch />
        <button
          type="button"
          className="portal-nav-item"
          onClick={onLogout}
        >
          <svg className="portal-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
            <path d="M16 17l5-5-5-5" />
            <path d="M21 12H9" />
          </svg>
          Sign out
        </button>
      </div>

    </aside>
  );
}
