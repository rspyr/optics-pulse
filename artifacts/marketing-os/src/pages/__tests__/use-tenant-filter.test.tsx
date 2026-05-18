import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import React from "react";

const authState = vi.hoisted(() => ({
  selectedTenantId: null as number | null,
  tenantSelectionMade: false,
  setSelectedTenantId: vi.fn(),
  user: null as { id: number; tenantId: number | null } | null,
  isAgency: true,
}));

vi.mock("@/components/auth-context", () => ({
  useAuth: () => authState,
}));

import { useTenantFilter } from "@/hooks/use-tenant-filter";

function Harness({
  override,
  onState,
}: {
  override?: number;
  onState: (s: ReturnType<typeof useTenantFilter>) => void;
}) {
  const s = useTenantFilter(override);
  React.useEffect(() => { onState(s); });
  return null;
}

function mockTenantsFetch(tenants: Array<{ id: number; name: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(tenants),
    }),
  );
}

describe("useTenantFilter — auto-default & override behavior", () => {
  beforeEach(() => {
    authState.selectedTenantId = null;
    authState.tenantSelectionMade = false;
    authState.user = null;
    authState.isAgency = true;
    authState.setSelectedTenantId = vi.fn((id: number | null) => {
      authState.selectedTenantId = id;
      authState.tenantSelectionMade = true;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("auto-picks the first tenant when no selection has been made yet", async () => {
    mockTenantsFetch([{ id: 11, name: "Acme" }, { id: 22, name: "Beta" }]);
    let latest: ReturnType<typeof useTenantFilter> | null = null;
    render(<Harness onState={(s) => { latest = s; }} />);

    await waitFor(() => {
      expect(authState.setSelectedTenantId).toHaveBeenCalledWith(11);
    });
    expect(latest!.tenants).toHaveLength(2);
  });

  it("does NOT auto-pick when the operator explicitly chose 'All Tenants'", async () => {
    authState.selectedTenantId = null;
    authState.tenantSelectionMade = true; // explicit "All"
    mockTenantsFetch([{ id: 11, name: "Acme" }, { id: 22, name: "Beta" }]);

    render(<Harness onState={() => {}} />);

    await waitFor(() => {
      // fetch happened
      expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });
    // give the effect time to run; auto-pick must not happen
    await new Promise((r) => setTimeout(r, 20));
    expect(authState.setSelectedTenantId).not.toHaveBeenCalled();
  });

  it("does NOT auto-pick when a specific tenant is already selected", async () => {
    authState.selectedTenantId = 7;
    authState.tenantSelectionMade = true;
    mockTenantsFetch([{ id: 11, name: "Acme" }]);

    render(<Harness onState={() => {}} />);

    await waitFor(() => {
      expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(authState.setSelectedTenantId).not.toHaveBeenCalled();
  });

  it("does not fetch tenants for non-agency users", async () => {
    authState.isAgency = false;
    mockTenantsFetch([{ id: 11, name: "Acme" }]);

    render(<Harness onState={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not auto-pick when the tenant list is empty", async () => {
    mockTenantsFetch([]);
    render(<Harness onState={() => {}} />);
    await waitFor(() => {
      expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(authState.setSelectedTenantId).not.toHaveBeenCalled();
  });

  it("tenantIdOverride pins the global selection to the override value", async () => {
    authState.selectedTenantId = 5;
    authState.tenantSelectionMade = true;
    mockTenantsFetch([{ id: 5, name: "Acme" }]);

    render(<Harness override={99} onState={() => {}} />);
    await waitFor(() => {
      expect(authState.setSelectedTenantId).toHaveBeenCalledWith(99);
    });
  });

  it("tenantIdOverride drives effectiveTenantId and localTenantId regardless of global state", async () => {
    authState.selectedTenantId = 5;
    authState.tenantSelectionMade = true;
    mockTenantsFetch([{ id: 5, name: "Acme" }]);

    let latest: ReturnType<typeof useTenantFilter> | null = null;
    render(<Harness override={42} onState={(s) => { latest = s; }} />);
    await waitFor(() => {
      expect(latest).not.toBeNull();
      expect(latest!.effectiveTenantId).toBe(42);
      expect(latest!.localTenantId).toBe(42);
    });
  });

  it("falls back to the user's own tenant for non-agency users", async () => {
    authState.isAgency = false;
    authState.user = { id: 1, tenantId: 555 };

    let latest: ReturnType<typeof useTenantFilter> | null = null;
    render(<Harness onState={(s) => { latest = s; }} />);
    await waitFor(() => {
      expect(latest).not.toBeNull();
      expect(latest!.effectiveTenantId).toBe(555);
    });
  });

  it("setSelectedTenantId delegates to the global setter (null = All Tenants)", async () => {
    mockTenantsFetch([{ id: 11, name: "Acme" }]);
    let latest: ReturnType<typeof useTenantFilter> | null = null;
    render(<Harness onState={(s) => { latest = s; }} />);
    await waitFor(() => { expect(latest).not.toBeNull(); });

    const setter = authState.setSelectedTenantId as ReturnType<typeof vi.fn>;
    setter.mockClear();
    act(() => { latest!.setSelectedTenantId(null); });
    expect(setter).toHaveBeenCalledWith(null);
  });
});
