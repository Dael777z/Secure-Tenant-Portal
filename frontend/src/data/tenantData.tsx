// The signed-in tenant's data, loaded from the backend once and shared by
// every page. It replaces the mock data the pages started with (mockData.ts is
// kept as a reference for the shapes).
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { messageFor, tenantApi, type TenantSummary } from "../api/tenant";

interface TenantData extends TenantSummary {
  /** Load again after a change (a payment, a new request, a linked bank). */
  refresh: () => Promise<void>;
}

const TenantDataContext = createContext<TenantData | null>(null);

export function TenantDataProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<TenantSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSummary(await tenantApi.summary());
      setError(null);
    } catch (caught) {
      setError(messageFor(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error && !summary) return <div className="portal-loading" role="alert">{error}</div>;
  if (!summary) return <div className="portal-loading" aria-busy="true">Loading your account…</div>;

  return <TenantDataContext.Provider value={{ ...summary, refresh }}>{children}</TenantDataContext.Provider>;
}

export function useTenantData(): TenantData {
  const data = useContext(TenantDataContext);
  if (!data) throw new Error("useTenantData must be inside <TenantDataProvider>");
  return data;
}
