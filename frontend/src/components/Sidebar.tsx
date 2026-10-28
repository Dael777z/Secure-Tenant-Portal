import type { ReactElement } from "react";
import type { PageKey, Tenant } from "../types";

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
  notices: (
    <svg className="portal-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 01-3.4 0" />
    </svg>
  ),
};

const navItems: { key: PageKey; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "pay", label: "Pay rent" },
  { key: "ledger", label: "Ledger" },
  { key: "maintenance", label: "Maintenance" },
  { key: "notices", label: "Notices" },
];

interface SidebarProps {
  tenant: Tenant;
  activePage: PageKey;
  onNavigate: (page: PageKey) => void;
  onLogout: () => void; 
}

export function Sidebar({ tenant, activePage, onNavigate, onLogout }: SidebarProps) {
  return (
    <aside className="portal-sidebar" aria-label="Resident portal navigation">
      <div className="portal-greeting">
        <div className="portal-avatar" aria-hidden="true">
          {tenant.initials}
        </div>
        <div className="portal-greeting-text">
          <div className="portal-greeting-hi">Good morning,</div>
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
            className="portal-nav-item"
            aria-current={activePage === item.key ? "page" : undefined}
            onClick={() => onNavigate(item.key)}
          >
            {icons[item.key]}
            {item.label}
          </button>
        ))}
      </nav>

      <div className="portal-sidebar-footer" style={{ marginTop: "auto", paddingTop: "1rem" }}>
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
