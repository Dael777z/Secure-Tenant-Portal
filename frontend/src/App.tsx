import { useEffect, useState } from "react";
import type { PageKey } from "./types";
import { Sidebar } from "./components/Sidebar";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";
import { PayRentPage } from "./pages/PayRentPage";
import { LedgerPage } from "./pages/LedgerPage";
import { MaintenancePage } from "./pages/MaintenancePage";
import { NoticesPage } from "./pages/NoticesPage";
import { TenantDataProvider, useTenantData } from "./data/tenantData";
import { currentUser, login, logout, type SessionUser } from "./api/auth";
import "./styles/portal.css";

const pageTitles: Record<PageKey, string> = {
  home: "Home",
  pay: "Pay Rent",
  ledger: "Ledger View",
  maintenance: "Maintenance",
  notices: "Notices",
};

/* Root of the tenant-facing Resident Portal. */
export default function App() {
  // Sign-in is real (backend /api/auth). Once in, TenantDataProvider loads the
  // tenant's own lease, ledger, requests and notices from /api/tenant/summary.
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [activePage, setActivePage] = useState<PageKey>("home");

  useEffect(() => {
    currentUser()
      .then(setUser)
      .finally(() => setChecked(true));
  }, []);

  async function handleLogin(email: string, password: string) {
    setUser(await login(email, password));
    setActivePage("home");
  }

  async function handleLogout() {
    await logout().catch(() => undefined);
    setUser(null);
  }

  if (!checked) {
    return <div className="portal-loading" aria-busy="true">Loading…</div>;
  }

  if (!user) {
    return <LoginPage onLogin={handleLogin} />;
  }

  if (user.role !== "tenant") {
    return (
      <div className="login-shell">
        <div className="login-form-panel">
          <div className="login-form-card">
            <h2 className="login-form-heading">Signed in as staff</h2>
            <p>The property manager side is not built yet. This screen is the resident portal.</p>
            <button type="button" className="btn btn--primary" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <TenantDataProvider>
      <TenantShell activePage={activePage} onNavigate={setActivePage} onLogout={handleLogout} />
    </TenantDataProvider>
  );
}

/* The resident portal once signed in: Juan's layout, with the tenant's own data. */
function TenantShell({
  activePage,
  onNavigate,
  onLogout,
}: {
  activePage: PageKey;
  onNavigate: (page: PageKey) => void;
  onLogout: () => void;
}) {
  const { tenant } = useTenantData();
  const setActivePage = onNavigate;
  const handleLogout = onLogout;

  return (
    <div className="portal-shell">
      <Sidebar tenant={tenant} activePage={activePage} onNavigate={setActivePage} onLogout={handleLogout} />
      <main className="portal-main">
        <header className="portal-header">
          <h1>{pageTitles[activePage]}</h1>
        </header>
        <div className="portal-content">
          {activePage === "home" && <HomePage onNavigate={setActivePage} />}
          {activePage === "pay" && <PayRentPage />}
          {activePage === "ledger" && <LedgerPage />}
          {activePage === "maintenance" && <MaintenancePage />}
          {activePage === "notices" && <NoticesPage />}
        </div>
      </main>
    </div>
  );
} 
