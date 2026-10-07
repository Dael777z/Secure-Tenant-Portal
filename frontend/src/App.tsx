import { useState } from "react";
import type { PageKey } from "./types";
import { Sidebar } from "./components/Sidebar";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";
import { PayRentPage } from "./pages/PayRentPage";
import { LedgerPage } from "./pages/LedgerPage";
import { MaintenancePage } from "./pages/MaintenancePage";
import { NoticesPage } from "./pages/NoticesPage";
import { mockTenant } from "./data/mockData";
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
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [activePage, setActivePage] = useState<PageKey>("home");

  if (!isAuthenticated) {
    return ( 
    <LoginPage onLogin={() => {
      setIsAuthenticated(true);
      setActivePage("home");
        }}
      />
    );
  }

  return (
    <div className="portal-shell">
      <Sidebar tenant={mockTenant} activePage={activePage} onNavigate={setActivePage} onLogout={() => setIsAuthenticated(false)} />
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
