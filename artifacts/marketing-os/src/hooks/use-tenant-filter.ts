import { useEffect, useCallback } from "react";
import { useAuth } from "@/components/auth-context";
import { useTenants, type TenantOption } from "@/hooks/use-tenants";

export type { TenantOption };

/**
 * Tenant filter hook shared by every admin surface that scopes itself by
 * tenant. Reads from / writes to the global persisted selection in
 * `AuthContext` so the header SCOPE chip and any per-page TENANT dropdown
 * always show the same value — including across navigation and full page
 * reloads.
 *
 * The tenant list itself is fetched once per session by the shared
 * `useTenants` hook (deduped + cached by react-query) so every consumer
 * sees the same loading flag and we don't refetch `/api/tenants` per page.
 *
 * No silent auto-pick: if the operator has not chosen a tenant, the page
 * receives `null` (= All Tenants) and is responsible for showing a "select
 * a tenant" prompt where a single-tenant context is required. We never
 * mutate the global selection on the operator's behalf — that's what was
 * causing the chip to swap to a random tenant on navigation.
 *
 * Passing `tenantIdOverride` pins this instance to a specific tenant (used by
 * embeds like the per-tenant settings panel) and also updates the global
 * selection so navigating away keeps that tenant in scope.
 */
export function useTenantFilter(tenantIdOverride?: number) {
  const {
    user,
    isAgency,
    selectedTenantId: globalTenantId,
    setSelectedTenantId: setGlobalTenantId,
  } = useAuth();

  const { tenants, tenantsLoading } = useTenants();

  useEffect(() => {
    if (isAgency && tenantIdOverride && tenantIdOverride !== globalTenantId) {
      setGlobalTenantId(tenantIdOverride);
    }
  }, [isAgency, tenantIdOverride, globalTenantId, setGlobalTenantId]);

  const setSelectedTenantId = useCallback((id: number | null) => {
    setGlobalTenantId(id);
  }, [setGlobalTenantId]);

  // `localTenantId` is kept for backwards compat with existing callers that
  // bind a <Select> to it. It mirrors the persisted global selection.
  const localTenantId = tenantIdOverride ?? globalTenantId;

  const effectiveTenantId = tenantIdOverride
    ?? (isAgency ? globalTenantId : (user?.tenantId ?? null));

  return {
    tenants,
    tenantsLoading,
    localTenantId,
    effectiveTenantId,
    setSelectedTenantId,
    isAgency,
  };
}
