import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import React from "react";

import { AuthProvider, useAuth } from "@/components/auth-context";
import { useTenantFilter } from "@/hooks/use-tenant-filter";

// Simulates three admin surfaces sharing the same AuthContext provider —
// /internal (drives the picker via useAuth), /attribution and /admin/tenants
// (consume the selection). The contract under test: when /internal calls
// setSelectedTenantId, every other surface reads the same value, and the
// choice — including the explicit "All Tenants" sentinel — survives a
// simulated reload via localStorage.

const STORAGE_KEY = "agencyGodView.tenantId";

let internalState: ReturnType<typeof useAuth> | null = null;
let attributionState: ReturnType<typeof useTenantFilter> | null = null;
let adminTenantsState: ReturnType<typeof useAuth> | null = null;

function InternalSurface() {
  // /internal reads selectedTenantId from useAuth directly and exposes the
  // setter. This mirrors `artifacts/marketing-os/src/pages/internal.tsx`.
  const auth = useAuth();
  React.useEffect(() => { internalState = auth; });
  return null;
}

function AttributionSurface() {
  // /attribution consumes the shared selection through useTenantFilter.
  const s = useTenantFilter();
  React.useEffect(() => { attributionState = s; });
  return null;
}

function AdminTenantsSurface() {
  // /admin/tenants reads useAuth directly (same as the real page).
  const auth = useAuth();
  React.useEffect(() => { adminTenantsState = auth; });
  return null;
}

function App({ withAttribution = true }: { withAttribution?: boolean }) {
  return (
    <AuthProvider>
      <InternalSurface />
      {withAttribution && <AttributionSurface />}
      <AdminTenantsSurface />
    </AuthProvider>
  );
}

describe("Cross-page tenant filter — picking in one surface scopes the others", () => {
  beforeEach(() => {
    window.localStorage.clear();
    internalState = null;
    attributionState = null;
    adminTenantsState = null;

    // Mock all fetches:
    //  - /api/auth/me → an agency super_admin so useTenantFilter activates
    //  - /api/tenants → a small list
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/auth/me")) {
        return {
          ok: true,
          json: async () => ({
            id: 1,
            email: "admin@agency.test",
            name: "Admin",
            role: "super_admin",
            tenantId: null,
            tenantName: null,
            leaderboardConfig: null,
          }),
        } as Response;
      }
      if (url.endsWith("/tenants") || url.endsWith("/api/tenants")) {
        return {
          ok: true,
          json: async () => [
            { id: 11, name: "Acme" },
            { id: 22, name: "Beta" },
          ],
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("propagates a tenant pick from /internal to /attribution and /admin/tenants", async () => {
    render(<App />);

    // Wait for the auth fetch to land so isAgency becomes true and
    // useTenantFilter fires.
    await waitFor(() => {
      expect(internalState?.user?.role).toBe("super_admin");
    });
    // Avoid being misled by the first-visit auto-pick — clear it and pretend
    // the operator is making an explicit choice from /internal.
    await waitFor(() => {
      expect(attributionState?.tenants.length).toBe(2);
    });

    act(() => {
      internalState!.setSelectedTenantId(22);
    });

    await waitFor(() => {
      expect(internalState!.selectedTenantId).toBe(22);
      expect(attributionState!.localTenantId).toBe(22);
      expect(attributionState!.effectiveTenantId).toBe(22);
      expect(adminTenantsState!.selectedTenantId).toBe(22);
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("22");
  });

  it("propagates an explicit 'All Tenants' choice without per-page auto-defaults overwriting it", async () => {
    render(<App />);
    await waitFor(() => {
      expect(internalState?.user?.role).toBe("super_admin");
      expect(attributionState?.tenants.length).toBe(2);
    });

    act(() => {
      internalState!.setSelectedTenantId(null); // explicit All Tenants
    });

    // Give useTenantFilter's auto-default effect a chance to (incorrectly)
    // overwrite the choice. It must not.
    await new Promise((r) => setTimeout(r, 30));

    expect(internalState!.selectedTenantId).toBeNull();
    expect(internalState!.tenantSelectionMade).toBe(true);
    expect(attributionState!.localTenantId).toBeNull();
    expect(attributionState!.effectiveTenantId).toBeNull();
    expect(adminTenantsState!.selectedTenantId).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("all");
  });

  it("survives a simulated reload — choice rehydrates into every surface", async () => {
    // Seed the storage as if a previous session ended with tenant 22 picked.
    window.localStorage.setItem(STORAGE_KEY, "22");

    render(<App />);

    await waitFor(() => {
      expect(internalState?.selectedTenantId).toBe(22);
      expect(adminTenantsState?.selectedTenantId).toBe(22);
    });
    await waitFor(() => {
      expect(attributionState?.effectiveTenantId).toBe(22);
    });
  });

  it("survives a simulated reload of an explicit All Tenants choice", async () => {
    window.localStorage.setItem(STORAGE_KEY, "all");
    render(<App />);

    await waitFor(() => {
      expect(internalState?.tenantSelectionMade).toBe(true);
      expect(attributionState?.tenants.length).toBe(2);
    });
    // Auto-pick must not fire on reload of an explicit All Tenants choice.
    await new Promise((r) => setTimeout(r, 30));
    expect(internalState!.selectedTenantId).toBeNull();
    expect(attributionState!.effectiveTenantId).toBeNull();
    expect(adminTenantsState!.selectedTenantId).toBeNull();
  });
});
