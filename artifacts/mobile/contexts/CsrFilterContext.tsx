import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useAuth } from "./AuthContext";
import { useTenant } from "./TenantContext";
import { useApi } from "@/hooks/useApi";

const MANAGER_ROLES = ["client_admin", "agency_user", "super_admin"];

interface CsrOption {
  id: number;
  name: string;
}

interface CsrFilterContextType {
  csrList: CsrOption[];
  selectedCsrId: number | null;
  setSelectedCsrId: (id: number | null) => void;
  isManager: boolean;
}

const CsrFilterContext = createContext<CsrFilterContextType>({
  csrList: [],
  selectedCsrId: null,
  setSelectedCsrId: () => {},
  isManager: false,
});

export function useCsrFilter() {
  return useContext(CsrFilterContext);
}

export function CsrFilterProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { effectiveTenantId } = useTenant();
  const { apiFetch } = useApi();
  const [csrList, setCsrList] = useState<CsrOption[]>([]);
  const [selectedCsrId, setSelectedCsrId] = useState<number | null>(null);

  const isManager = MANAGER_ROLES.includes(user?.role || "");

  useEffect(() => {
    if (!isManager || !effectiveTenantId) {
      setCsrList([]);
      return;
    }
    apiFetch(`/api/leads-hub/csrs?tenantId=${effectiveTenantId}`)
      .then(d => setCsrList(d.csrs || []))
      .catch(() => {});
  }, [effectiveTenantId, isManager]);

  useEffect(() => {
    setSelectedCsrId(null);
  }, [effectiveTenantId]);

  return (
    <CsrFilterContext.Provider value={{ csrList, selectedCsrId, setSelectedCsrId, isManager }}>
      {children}
    </CsrFilterContext.Provider>
  );
}
