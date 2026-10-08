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
import { SESSION_CHECK } from "./api/session";
import { ManagerApp } from "./manager/ManagerApp";
import "./styles/portal.css";

const pageTitles: Record<PageKey, string> = {
  home: "Home",
  pay: "Pay Rent",
  ledger: "Ledger View",
  maintenance: "Maintenance",
  notices: "Notices",
};

/* Root of the portal: residents get the resident portal, staff the manager side. */
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

  // A call was refused (401/403): maybe the session ended, or someone signed in
  // as a different person in another tab. Ask who is signed in now, and switch
  // to the right side if it changed.
  useEffect(() => {
    const check = () => {
      void currentUser().then((now) => {
        setUser((was) => (now?.user_id === was?.user_id && now?.role === was?.role ? was : now));
      });
    };
    window.addEventListener(SESSION_CHECK, check);
    return () => window.removeEventListener(SESSION_CHECK, check);
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

  // Staff (property managers, maintenance) get the manager side; what each
  // role can do there comes from its permissions.
  if (user.role !== "tenant") {
    return <ManagerApp user={user} onLogout={handleLogout} />;
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
