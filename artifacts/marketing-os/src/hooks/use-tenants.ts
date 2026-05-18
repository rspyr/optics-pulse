import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/auth-context";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

export interface TenantOption {
  id: number;
  name: string;
  timezone?: string;
}

/**
 * Shared tenant list source for every tenant-scoped admin surface.
 *
 * Fetches `/api/tenants` once per session (deduped + cached by react-query)
 * so that the header SCOPE chip, per-page TENANT dropdowns, and "Select a
 * tenant" empty states all read from the same source and show a consistent
 * loading skeleton instead of issuing duplicate requests on every page.
 *
 * Non-agency users never trigger the fetch — they don't have a list to
 * choose from.
 */
export function useTenants() {
  const { isAgency } = useAuth();

  const query = useQuery<TenantOption[]>({
    queryKey: ["tenants-list"],
    enabled: isAgency,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/tenants`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load tenants (${res.status})`);
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map((t: { id: number; name: string; timezone?: string }) => ({
        id: t.id,
        name: t.name,
        timezone: t.timezone,
      }));
    },
  });

  return {
    tenants: query.data ?? [],
    tenantsLoading: isAgency ? query.isPending : false,
  };
}
