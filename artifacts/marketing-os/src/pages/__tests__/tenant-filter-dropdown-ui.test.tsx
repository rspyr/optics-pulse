import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor, within } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider, useAuth } from "@/components/auth-context";
import { TenantScopeChip } from "@/components/tenant-scope-chip";

const tenantList = [
  { id: 11, name: "Acme", isActive: true },
  { id: 22, name: "Beta", isActive: true },
];

vi.mock("@workspace/api-client-react", async () => {
  const { mockApiClientReactModule, makeApiClientHookStub } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  return mockApiClientReactModule({
    useListTenants: (() => ({
      ...makeApiClientHookStub(),
      data: tenantList,
    })) as unknown as typeof import("@workspace/api-client-react").useListTenants,
  });
});

import Internal from "../internal";
import Attribution from "../attribution";

const STORAGE_KEY = "agencyGodView.tenantId";

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
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
    if (url.endsWith("/api/tenants") || url.endsWith("/tenants")) {
      return {
        ok: true,
        json: async () => tenantList.map((t) => ({ id: t.id, name: t.name })),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
}

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
}

function AuthProbe({ onReady }: { onReady: (a: ReturnType<typeof useAuth>) => void }) {
  const auth = useAuth();
  React.useEffect(() => {
    onReady(auth);
  });
  return null;
}

function tenantComboboxesIn(host: HTMLElement) {
  return within(host)
    .queryAllByRole("combobox")
    .filter((trigger) => /All Tenants|Acme|Beta/.test(trigger.textContent ?? ""));
}

describe("Tenant scope UI", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", makeFetchMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("master Scope chip renders 'All Tenants' when nothing is selected and the tenant name when one is selected", async () => {
    window.localStorage.setItem(STORAGE_KEY, "all");

    let auth: ReturnType<typeof useAuth> | null = null;
    renderWithProviders(
      <>
        <AuthProbe onReady={(a) => { auth = a; }} />
        <TenantScopeChip />
      </>,
    );

    await waitFor(() => expect(auth?.user?.role).toBe("super_admin"));
    expect(screen.getByTestId("tenant-scope-chip").textContent).toContain("All Tenants");

    act(() => { auth!.setSelectedTenantId(22); });
    await waitFor(() => {
      expect(screen.getByTestId("tenant-scope-chip").textContent).toContain("Beta");
    });

    act(() => { auth!.setSelectedTenantId(null); });
    await waitFor(() => {
      expect(screen.getByTestId("tenant-scope-chip").textContent).toContain("All Tenants");
    });
  });

  it("/internal and /attribution no longer render page-level tenant selectors", async () => {
    window.localStorage.setItem(STORAGE_KEY, "all");

    let auth: ReturnType<typeof useAuth> | null = null;
    renderWithProviders(
      <>
        <AuthProbe onReady={(a) => { auth = a; }} />
        <TenantScopeChip />
        <div data-testid="internal-host"><Internal /></div>
        <div data-testid="attribution-host"><Attribution /></div>
      </>,
    );

    await waitFor(() => expect(auth?.user?.role).toBe("super_admin"));
    await waitFor(() => {
      expect(screen.getByTestId("tenant-scope-chip").textContent).toContain("All Tenants");
    });

    const internalHost = screen.getByTestId("internal-host");
    const attributionHost = screen.getByTestId("attribution-host");
    expect(tenantComboboxesIn(internalHost)).toEqual([]);
    expect(tenantComboboxesIn(attributionHost)).toEqual([]);

    act(() => { auth!.setSelectedTenantId(11); });
    await waitFor(() => {
      expect(screen.getByTestId("tenant-scope-chip").textContent).toContain("Acme");
    });
    expect(tenantComboboxesIn(internalHost)).toEqual([]);
    expect(tenantComboboxesIn(attributionHost)).toEqual([]);
  });
});
