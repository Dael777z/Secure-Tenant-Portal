import type { PageKey } from "../types";
import { useTenantData } from "../data/tenantData";
import { formatCurrency } from "../components/formatCurrency";

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
            Rent Due
          </div>
          <div className="rent-due-amount">{formatCurrency(currentBalance)}</div>
          <div className="rent-due-sub">
            Due: {rentDueDate} - No late fee before {lateFeeGraceDate}
          </div>
          <span className="status-pill status-pill--due-soon">Due soon</span>

          <div className="home-actions">
            <button type="button" className="btn btn--primary" onClick={() => onNavigate("pay")}>
              Pay Rent
            </button>
            <button type="button" className="btn btn--outline" onClick={() => onNavigate("ledger")}>
              View Ledger
            </button>
          </div>

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
                  <div className="ledger-row-balance">bal {formatCurrency(entry.balanceAfter)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div>
        <section className="portal-panel" aria-labelledby="open-maintenance-heading">
          <div className="side-panel-header">
            <h3 id="open-maintenance-heading">Open Maintenance</h3>
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
