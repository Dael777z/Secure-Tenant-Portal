import { useEffect, useState } from "react";
import type { PageKey } from "./types";
import { Sidebar } from "./components/Sidebar";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";
import { PayRentPage } from "./pages/PayRentPage";
import { LedgerPage } from "./pages/LedgerPage";
import { MaintenancePage } from "./pages/MaintenancePage";
import { NoticesPage } from "./pages/NoticesPage";
import { mockTenant } from "./data/mockData";
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
  // Sign-in is real (backend /api/auth); the page data is still Juan's mock
  // data until the tenant API exists.
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

  // Unit and address are still mock; the name shown is who actually signed in.
  // (/auth/me does not return the email, so after a reload it says "Resident".)
  const shownName = user.email ?? "Resident";
  const tenant = { ...mockTenant, name: shownName, initials: shownName.slice(0, 1).toUpperCase() };

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
