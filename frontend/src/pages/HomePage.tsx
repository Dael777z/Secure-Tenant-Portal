import type { ReactElement } from "react";
import type { PageKey } from "../types";
import { useTenantData } from "../data/tenantData";
import { formatBalance, formatCurrency } from "../components/formatCurrency";

// Big labelled shortcuts on the home page: one tap to each thing a resident does.
const tiles: { key: PageKey; label: string; color: string; icon: ReactElement }[] = [
  {
    key: "pay",
    label: "Pay Rent",
    color: "var(--p-success)",
    icon: (
      <>
        <path d="M12 2v20" />
        <path d="M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
      </>
    ),
  },
  {
    key: "maintenance",
    label: "Repair",
    color: "var(--p-muted)",
    icon: <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.8-3.8a6 6 0 01-7.9 7.9l-6.9 6.9a2.1 2.1 0 01-3-3l6.9-6.9a6 6 0 017.9-7.9z" />,
  },
  {
    key: "ledger",
    label: "Ledger",
    color: "var(--p-link)",
    icon: (
      <>
        <path d="M4 4h13l3 3v13H4z" />
        <path d="M8 9h9M8 13h9M8 17h5" />
      </>
    ),
  },
  {
    key: "notices",
    label: "Notices",
    color: "var(--p-link)",
    icon: (
      <>
        <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 01-3.4 0" />
      </>
    ),
  },
  {
    key: "documents",
    label: "Documents",
    color: "var(--p-warn)",
    icon: <path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  },
  {
    key: "settings",
    label: "Settings",
    color: "var(--p-muted)",
    icon: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0116 0" />
      </>
    ),
  },
];

interface HomePageProps {
  onNavigate: (page: PageKey) => void;
}

export function HomePage({ onNavigate }: HomePageProps) {
  const { currentBalance, rentDueDate, lateFeeGraceDate, ledger, maintenanceRequests, notices } = useTenantData();
  const recentActivity = ledger.slice(0, 3);
  const openRequests = maintenanceRequests.filter((r) => r.status !== "resolved");
  const recentNotices = notices.slice(0, 2);

  return (
    <div className="home-grid">
      <div>
        <section className="portal-panel" aria-labelledby="rent-due-heading">
          <div id="rent-due-heading" className="rent-due-label">
            {currentBalance < 0 ? "Credit" : "Rent Due"}
          </div>
          <div className="rent-due-amount">{formatCurrency(Math.abs(currentBalance))}</div>
          <div className="rent-due-sub">
            {currentBalance > 0
              ? `Due: ${rentDueDate} - No late fee before ${lateFeeGraceDate}`
              : currentBalance < 0
                ? `Paid ahead. It goes toward your next rent, due ${rentDueDate}.`
                : `Nothing due now. Next rent is due ${rentDueDate}.`}
          </div>
          {currentBalance > 0 ? (
            <span className="status-pill status-pill--due-soon">Due soon</span>
          ) : (
            <span className="status-pill status-pill--paid">{currentBalance < 0 ? "Paid ahead" : "Paid up"}</span>
          )}

          <div className="home-actions">
            <button type="button" className="btn btn--primary" onClick={() => onNavigate("pay")}>
              {currentBalance > 0 ? "Pay Rent" : "Pay ahead"}
            </button>
            <button type="button" className="btn btn--outline" onClick={() => onNavigate("ledger")}>
              View Ledger
            </button>
          </div>
        </section>

        <nav className="home-tiles" aria-label="Shortcuts">
          {tiles.map((tile) => (
            <button key={tile.key} type="button" className="home-tile" onClick={() => onNavigate(tile.key)}>
              <svg viewBox="0 0 24 24" fill="none" stroke={tile.color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {tile.icon}
              </svg>
              {tile.label}
            </button>
          ))}
        </nav>

        <section className="portal-panel">
          <h2 className="recent-activity-title">Recent activity</h2>
          <div>
            {recentActivity.map((entry) => (
              <div className="ledger-row" key={entry.id}>
                <div>
                  <div className="ledger-row-desc">{entry.description}</div>
                  <div className="ledger-row-date">{entry.date}</div>
                </div>
                <div>
                  <div
                    className={
                      "ledger-row-amount" + (entry.amount > 0 ? " ledger-row-amount--credit" : "")
                    }
                  >
                    {entry.amount > 0 ? "+" : ""}
                    {formatCurrency(entry.amount)}
                  </div>
                  <div className="ledger-row-balance">bal {formatBalance(entry.balanceAfter)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div>
        <section className="portal-panel" aria-labelledby="open-maintenance-heading">
          <div className="side-panel-header">
            <h3 id="open-maintenance-heading">Open Repairs</h3>
            <button type="button" className="link-button" onClick={() => onNavigate("maintenance")}>
              View all
            </button>
          </div>
          {openRequests.length === 0 ? (
            <p className="mini-item-sub">No open requests.</p>
          ) : (
            openRequests.map((req) => (
              <div className="mini-item" key={req.id}>
                <div className="mini-item-title">{req.title}</div>
                <div className="mini-item-sub">{req.submittedDate}</div>
              </div>
            ))
          )}
        </section>

        <section className="portal-panel" aria-labelledby="recent-notices-heading">
          <div className="side-panel-header">
            <h3 id="recent-notices-heading">Recent Notices</h3>
            <button type="button" className="link-button" onClick={() => onNavigate("notices")}>
              View all
            </button>
          </div>
          {recentNotices.map((notice) => (
            <div className="mini-item" key={notice.id}>
              <div className="mini-item-title">{notice.title}</div>
              <div className="mini-item-sub">{notice.timestamp}</div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
