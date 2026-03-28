import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/components/auth-context";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

export interface TenantOption {
  id: number;
  name: string;
  timezone?: string;
}

export function useTenantFilter(tenantIdOverride?: number) {
  const { user, isAgency, selectedTenantId: globalTenantId, setSelectedTenantId: setGlobalTenantId } = useAuth();

  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [localTenantId, setLocalTenantId] = useState<number | null>(
    tenantIdOverride ?? globalTenantId ?? user?.tenantId ?? null
  );

  useEffect(() => {
    if (!tenantIdOverride && globalTenantId !== null && globalTenantId !== localTenantId) {
      setLocalTenantId(globalTenantId);
    }
  }, [globalTenantId, tenantIdOverride]);

  useEffect(() => {
    if (isAgency && tenantIdOverride) {
      setGlobalTenantId(tenantIdOverride);
    }
  }, [isAgency, tenantIdOverride, setGlobalTenantId]);

  const setSelectedTenantId = useCallback((id: number | null) => {
    setLocalTenantId(id);
    setGlobalTenantId(id);
  }, [setGlobalTenantId]);

  useEffect(() => {
    if (!isAgency) return;
    fetch(`${API_BASE}/tenants`, { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          const mapped = data.map((t: { id: number; name: string; timezone?: string }) => ({
            id: t.id,
            name: t.name,
            timezone: t.timezone,
          }));
          setTenants(mapped);
          setLocalTenantId(prev => {
            if (prev !== null) return prev;
            if (mapped.length > 0) {
              setGlobalTenantId(mapped[0].id);
              return mapped[0].id;
            }
            return null;
          });
        }
      })
      .catch(() => {});
  }, [isAgency, setGlobalTenantId]);

  const effectiveTenantId = tenantIdOverride
    ?? (isAgency ? localTenantId : (user?.tenantId ?? null));

  return {
    tenants,
    localTenantId,
    effectiveTenantId,
    setSelectedTenantId,
    isAgency,
  };
}
