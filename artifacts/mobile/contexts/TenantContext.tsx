import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useAuth } from "./AuthContext";
import { useApi } from "@/hooks/useApi";

interface Tenant {
  id: number;
  name: string;
  isDemo?: boolean;
}

interface TenantContextType {
  tenants: Tenant[];
  selectedTenantId: number | null;
  setSelectedTenantId: (id: number | null) => void;
  effectiveTenantId: number | null;
  isAgency: boolean;
}

const TenantContext = createContext<TenantContextType>({
  tenants: [],
  selectedTenantId: null,
  setSelectedTenantId: () => {},
  effectiveTenantId: null,
  isAgency: false,
});

export function useTenant() {
  return useContext(TenantContext);
}

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { apiFetch } = useApi();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null);

  const isAgency = user?.role === "super_admin" || user?.role === "agency_user";

  useEffect(() => {
    if (!user || !isAgency) {
      setTenants([]);
      return;
    }

    (async () => {
      try {
        const data = await apiFetch("/api/tenants");
        const list = Array.isArray(data) ? data : data.tenants || [];
        setTenants(list);
        if (list.length > 0 && !selectedTenantId) {
          setSelectedTenantId(list[0].id);
        }
      } catch (err) {
        console.error("[Tenant] Failed to fetch tenants:", err);
      }
    })();
  }, [user?.id, isAgency]);

  const effectiveTenantId = isAgency ? selectedTenantId : (user?.tenantId ?? null);

  return (
    <TenantContext.Provider value={{ tenants, selectedTenantId, setSelectedTenantId, effectiveTenantId, isAgency }}>
      {children}
    </TenantContext.Provider>
  );
}
