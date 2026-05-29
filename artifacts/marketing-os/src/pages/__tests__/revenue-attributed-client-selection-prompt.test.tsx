// Component coverage for the "no client selected" gate on the Revenue
// Attributed page (Task #738). Agency / super-admin users browse across
// tenants, but the revenue endpoints reject a cross-tenant request with a raw
// HTTP 400 when no client is in scope. The page now shows a friendly
// "Select a client to view revenue." prompt and — critically — fires NO
// fetch to the revenue-attributed / summary / facets endpoints in that state.
//
// The contract this file locks in (none of which the API route tests can see):
//
//   1. As an agency user with effectiveTenantId == null, the prompt is shown
//      and not one of the three revenue endpoints is hit.
//   2. Once a client is selected, the normal list/summary/facets fetches fire.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { useTenantFilterMock, useAuthMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  useTenantFilterMock: vi.fn(),
  useAuthMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/hooks/use-tenant-filter", async () => {
  const { mockUseTenantFilterModule } = await import("@/test-utils/use-tenant-filter-mocks");
  return mockUseTenantFilterModule({
    useTenantFilter: useTenantFilterMock as unknown as typeof import("@/hooks/use-tenant-filter")["useTenantFilter"],
  });
});

vi.mock("@/components/auth-context", async () => {
  const { mockAuthContextModule } = await import("@/test-utils/auth-context-mocks");
  return mockAuthContextModule({
    useAuth: useAuthMock as unknown as typeof import("@/components/auth-context")["useAuth"],
  });
});

vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

import RevenueAttributed from "../revenue-attributed";
import { makeTenantFilterStub } from "@/test-utils/use-tenant-filter-mocks";
import { makeAuthStub } from "@/test-utils/auth-context-mocks";

const TENANT_ID = 42;

// Every URL the component asks fetch for, so we can assert which revenue
// endpoints were (or were not) hit.
let fetchUrls: string[] = [];

function isRevenueEndpoint(url: string): boolean {
  return url.includes("/api/drilldown/revenue-attributed");
}

function makeJob(id: number) {
  return {
    id,
    tenantId: TENANT_ID,
    stJobId: `ST-${id}`,
    stInvoiceId: null,
    customerName: `Customer ${id}`,
    jobType: "install",
    jobTypeName: "Install",
    status: "completed",
    revenue: 1000,
    invoiceTotal: 1000,
    invoiceRebateAmount: null,
    correctedRevenue: 1000,
    invoiceDate: "2026-05-01",
    completedAt: "2026-05-01",
    createdAt: "2026-05-01",
    matchLevel: null,
    matchedGclid: null,
    rebateBreakdown: [],
    soldByName: null,
    lead: null,
  };
}

function installFetch() {
  vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchUrls.push(url);
    if (url.includes("/api/drilldown/revenue-attributed/summary")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ revenue: 0, rebates: 0, attributed: 0, count: 0 }),
      } as Response;
    }
    if (url.includes("/api/drilldown/revenue-attributed/facets")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ funnels: [], sources: [] }),
      } as Response;
    }
    if (url.includes("/api/drilldown/revenue-attributed")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [makeJob(1)],
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

// Agency user, but no client picked yet (effectiveTenantId == null).
function setAgencyNoClient() {
  useTenantFilterMock.mockReturnValue(
    makeTenantFilterStub({
      isAgency: true,
      effectiveTenantId: null,
      localTenantId: null,
      tenants: [{ id: TENANT_ID, name: "Acme" }],
    }),
  );
  useAuthMock.mockReturnValue(
    makeAuthStub({
      user: {
        id: 1,
        email: "agency@acme.test",
        name: "Agency Op",
        role: "agency_user",
        tenantId: null,
        tenantName: null,
        leaderboardConfig: null,
      },
      isAgency: true,
      isClient: false,
      effectiveTenantId: null,
    }),
  );
}

// Agency user with a client now in scope.
function setAgencyWithClient() {
  useTenantFilterMock.mockReturnValue(
    makeTenantFilterStub({
      isAgency: true,
      effectiveTenantId: TENANT_ID,
      localTenantId: TENANT_ID,
      tenants: [{ id: TENANT_ID, name: "Acme" }],
    }),
  );
  useAuthMock.mockReturnValue(
    makeAuthStub({
      user: {
        id: 1,
        email: "agency@acme.test",
        name: "Agency Op",
        role: "agency_user",
        tenantId: TENANT_ID,
        tenantName: "Acme",
        leaderboardConfig: null,
      },
      isAgency: true,
      isClient: false,
      effectiveTenantId: TENANT_ID,
    }),
  );
}

beforeEach(() => {
  fetchUrls = [];
  useTenantFilterMock.mockReset();
  useAuthMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Revenue Attributed — no-client-selected gate (Task #738)", () => {
  it("shows the prompt and fires no revenue fetch for an agency user with no client", async () => {
    setAgencyNoClient();
    installFetch();
    render(<RevenueAttributed />);

    // The friendly prompt is shown instead of the loading/list state.
    expect(
      await screen.findByText("Select a client to view revenue."),
    ).toBeInTheDocument();

    // Give the gated useEffects a chance to (incorrectly) fire.
    await new Promise((r) => setTimeout(r, 80));

    const revenueCalls = fetchUrls.filter(isRevenueEndpoint);
    expect(
      revenueCalls,
      `Revenue Attributed hit revenue endpoints with no client in scope:\n` +
        revenueCalls.map((u) => `  ${u}`).join("\n"),
    ).toEqual([]);
  });

  it("fires the normal list/summary/facets fetches once a client is selected", async () => {
    // Start with no client picked: prompt shown, no revenue fetch.
    setAgencyNoClient();
    installFetch();
    const { rerender } = render(<RevenueAttributed />);

    await screen.findByText("Select a client to view revenue.");
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchUrls.filter(isRevenueEndpoint)).toEqual([]);

    // Pick a client — the page re-reads the (now non-null) effectiveTenantId
    // and the gated fetches must fire.
    setAgencyWithClient();
    rerender(<RevenueAttributed />);

    await screen.findByText("Customer 1");

    await waitFor(() => {
      const revenueCalls = fetchUrls.filter(isRevenueEndpoint);
      expect(revenueCalls.some((u) => u.includes("/revenue-attributed/summary"))).toBe(true);
      expect(revenueCalls.some((u) => u.includes("/revenue-attributed/facets"))).toBe(true);
      expect(
        revenueCalls.some(
          (u) => u.includes("/revenue-attributed") && !u.includes("/summary") && !u.includes("/facets"),
        ),
      ).toBe(true);
    });

    // Every revenue fetch carries the selected tenant id.
    for (const u of fetchUrls.filter(isRevenueEndpoint)) {
      expect(u).toContain(`tenantId=${TENANT_ID}`);
    }
  });
});
