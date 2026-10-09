// The manager side: what property managers and on-site maintenance staff see
// after signing in. Same sign-in and session as the resident portal; the
// backend decides what each role may do (Scott's RBAC permissions), and this
// only hides what the role cannot use.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionUser } from "../api/auth";
import { managerApi, type StaffProfile } from "./api";
import { DialogHost } from "./dialogs";
import {
  DashboardPage,
  LeasePage,
  MaintenancePage,
  PropertiesPage,
  PropertyPage,
  RentRollPage,
  TenantsPage,
  UpdatesPage,
} from "./pages";
import { ManagerContext, initials, parseRoute, routeHash, type Dialog, type ManagerContextValue, type Route } from "./ui";
import "./manager.css";

const ROLE_LABELS: Record<string, string> = {
  property_manager: "Property Manager",
  maintenance_staff: "Maintenance",
  platform_admin: "Administrator",
};

interface NavItem {
  label: string;
  route: Route;
  matches: Route["name"][];
  permission: string;
}

const NAV: NavItem[] = [
  { label: "Dashboard", route: { name: "dashboard" }, matches: ["dashboard"], permission: "ledger:read:property" },
  { label: "Properties", route: { name: "properties" }, matches: ["properties", "property"], permission: "ledger:read:property" },
  { label: "Rent Roll", route: { name: "rent-roll" }, matches: ["rent-roll", "lease"], permission: "ledger:read:property" },
  { label: "Tenants", route: { name: "tenants" }, matches: ["tenants"], permission: "ledger:read:property" },
  { label: "Maintenance", route: { name: "maintenance" }, matches: ["maintenance"], permission: "maintenance:manage" },
  { label: "Updates", route: { name: "updates" }, matches: ["updates"], permission: "ledger:read:property" },
];

export function ManagerApp({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const can = useCallback((permission: string) => user.permissions.includes(permission), [user.permissions]);
  const home: Route = can("ledger:read:property") ? { name: "dashboard" } : { name: "maintenance" };
  const allowed = useCallback(
    (route: Route) => NAV.some((n) => n.matches.includes(route.name) && can(n.permission)),
    [can],
  );

  const [route, setRoute] = useState<Route>(() => {
    const r = parseRoute(location.hash);
    return r && allowed(r) ? r : home;
  });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [version, setVersion] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    managerApi.me().then(setProfile, () => setProfile(null));
  }, []);

  // Keep the route in the URL hash so Back, Forward and reload work.
  useEffect(() => {
    const onHash = () => {
      const r = parseRoute(location.hash);
      const next = r && allowed(r) ? r : home;
      if (location.hash !== routeHash(next)) history.replaceState(null, "", routeHash(next));
      setRoute(next);
      setMenuOpen(false);
    };
    window.addEventListener("hashchange", onHash);
    if (location.hash !== routeHash(route)) history.replaceState(null, "", routeHash(route));
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const go = useCallback((next: Route) => {
    const hash = routeHash(next);
    if (location.hash === hash) setRoute(next);
    else location.hash = hash;
    window.scrollTo(0, 0);
  }, []);

  const ctx: ManagerContextValue = useMemo(
    () => ({
      user,
      can,
      go,
      open: setDialog,
      version,
      changed: (message?: string) => {
        setVersion((v) => v + 1);
        if (message) setToast(message);
      },
    }),
    [user, can, go, version],
  );

  const name = profile?.name ?? user.email ?? "Staff";
  const nav = NAV.filter((n) => can(n.permission));

  return (
    <ManagerContext.Provider value={ctx}>
      <div className="mgr-shell">
        <aside className={`mgr-sidebar${menuOpen ? " mgr-sidebar--open" : ""}`} aria-label="Manager navigation">
          <div className="mgr-brand">
            <span className="mgr-brand__mark" aria-hidden="true">SP</span>
            <span>
              <strong>Secure Tenant Portal</strong>
              <span className="mgr-brand__sub">{can("ledger:read:property") ? "Manager workspace" : "Maintenance workspace"}</span>
            </span>
          </div>
          <nav className="mgr-nav">
            {nav.map((n) => {
              const active = n.matches.includes(route.name);
              return (
                <a
                  key={n.label}
                  href={routeHash(n.route)}
                  className={`mgr-nav__item${active ? " mgr-nav__item--active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    go(n.route);
                    setMenuOpen(false);
                  }}
                >
                  {n.label}
                </a>
              );
            })}
          </nav>
          <div className="mgr-me">
            <span className="mgr-me__avatar" aria-hidden="true">{initials(name)}</span>
            <span className="mgr-me__text">
              <strong>{name}</strong>
              <span>{ROLE_LABELS[user.role] ?? user.role}</span>
            </span>
          </div>
          <button type="button" className="mgr-signout" onClick={onLogout}>
            Sign out
          </button>
        </aside>
        {menuOpen && <div className="mgr-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
        <div className="mgr-main">
          <div className="mgr-topbar">
            <button type="button" className="mgr-menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
              ☰ Menu
            </button>
            <span className="mgr-topbar__title">Secure Tenant Portal</span>
          </div>
          <main className="mgr-content" id="main">
            {route.name === "dashboard" && <DashboardPage name={name} />}
            {route.name === "properties" && <PropertiesPage />}
            {route.name === "property" && <PropertyPage id={route.id} />}
            {route.name === "rent-roll" && <RentRollPage filter={route.filter} />}
            {route.name === "tenants" && <TenantsPage />}
            {route.name === "lease" && <LeasePage id={route.id} />}
            {route.name === "maintenance" && <MaintenancePage />}
            {route.name === "updates" && <UpdatesPage />}
          </main>
        </div>
        {dialog && <DialogHost dialog={dialog} onClose={() => setDialog(null)} />}
        {toast && (
          <div className="mgr-toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </ManagerContext.Provider>
  );
}
