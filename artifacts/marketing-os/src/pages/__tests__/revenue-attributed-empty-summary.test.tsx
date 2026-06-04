// Component coverage for the empty-state consistency of the Revenue Attributed
// page's summary cards (Task #814).
//
// Task #809 gave the "Revenue by Match Tier" breakdown card a friendly
// empty-state instead of vanishing. The follow-up audit (Task #814) confirmed
// the only card on this page that previously hid entirely was the Match Tier
// card; the top-row summary cards (Corrected Revenue, Attributed Revenue,
// Potential, Rebate Add-Backs, Jobs) and the Revenue-by-Job table already degrade
// gracefully and never disappear.
//
// This file locks in that page-wide consistency so a future change can't
// regress the summary cards into vanishing: when the summary loads with an
// all-zero / empty range, every summary card stays present and reads "$0"/"0"
// (not blank, not stuck on the "—" loading placeholder), and the Match Tier
// empty-state renders alongside them. It also asserts the loading placeholder
// ("—") is shown only before the summary resolves, matching the Match Tier
// card's "after the summary has loaded, not while loading" behaviour.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";

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

const FACETS = { funnels: [], sources: [], matchLevels: [] };

// Builds a URL-aware fetch returning the given summary for the summary endpoint
// and an EMPTY job list (the empty-range scenario) for the list endpoint.
function installFetch(summary: Record<string, unknown>) {
  vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/drilldown/revenue-attributed/facets")) {
      return { ok: true, status: 200, json: async () => FACETS } as Response;
    }
    if (url.includes("/api/drilldown/revenue-attributed/summary")) {
      return { ok: true, status: 200, json: async () => summary } as Response;
    }
    if (url.includes("/api/drilldown/revenue-attributed")) {
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === "X-Total-Count" ? "0" : null) },
        json: async () => [],
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

function setUser() {
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
        id: 1, email: "agency@acme.test", name: "Agency Op", role: "agency_user",
        tenantId: TENANT_ID, tenantName: "Acme", leaderboardConfig: null,
      },
      isAgency: true,
      isClient: false,
      effectiveTenantId: TENANT_ID,
    }),
  );
}

// Locates the summary card whose uppercase label matches, then reads its value
// node. Card markup: <PremiumCard><div>{icon}{label}</div><div>{value}</div>.
function summaryCardValue(label: string): string {
  // SummaryCard markup: <PremiumCard><div>{icon}{label}</div><div class="font-display">{value}</div>.
  // The label text lives in the first child div, so its parent is the card root.
  const labelNode = screen.getByText(label);
  const card = labelNode.parentElement!;
  const value = within(card).getByText((_, el) =>
    el?.classList.contains("font-display") === true && el.tagName === "DIV",
  );
  return value.textContent ?? "";
}

beforeEach(() => {
  useTenantFilterMock.mockReset();
  useAuthMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Revenue Attributed — summary cards stay present on an empty range (Task #814)", () => {
  it("renders every summary card as $0/0 (not vanished, not stuck on —) once an empty summary loads", async () => {
    setUser();
    installFetch({ revenue: 0, rebates: 0, attributed: 0, count: 0, byMatchLevel: [] });

    render(<RevenueAttributed />);

    // The Match Tier empty card resolving is our signal the summary has loaded.
    await screen.findByText("No attributed revenue in this range.");

    // All summary cards remain on the page with their empty (zero) values.
    expect(summaryCardValue("Corrected Revenue")).toBe("$0");
    expect(summaryCardValue("Attributed Revenue")).toBe("$0");
    expect(summaryCardValue("Potential (Low)")).toBe("$0");
    expect(summaryCardValue("Rebate Add-Backs")).toBe("$0");
    expect(summaryCardValue("Jobs")).toBe("0");

    // The loading placeholder must be gone now that the summary has resolved.
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("shows the — loading placeholder only before the summary resolves", async () => {
    setUser();
    // Summary endpoint never resolves; list + facets respond so the page renders.
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/drilldown/revenue-attributed/summary")) {
        return new Promise(() => {}) as unknown as Response;
      }
      if (url.includes("/api/drilldown/revenue-attributed/facets")) {
        return { ok: true, status: 200, json: async () => FACETS } as Response;
      }
      if (url.includes("/api/drilldown/revenue-attributed")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (k: string) => (k === "X-Total-Count" ? "0" : null) },
          json: async () => [],
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    render(<RevenueAttributed />);

    // Each summary card shows the — placeholder while the summary is pending.
    await waitFor(() => {
    expect(summaryCardValue("Corrected Revenue")).toBe("—");
    });
    expect(summaryCardValue("Attributed Revenue")).toBe("—");
    expect(summaryCardValue("Potential (Low)")).toBe("—");
    expect(summaryCardValue("Rebate Add-Backs")).toBe("—");
    expect(summaryCardValue("Jobs")).toBe("—");

    // The Match Tier card (empty or populated) must NOT appear before load,
    // matching its "after the summary has loaded, not while loading" guard.
    expect(screen.queryByText("No attributed revenue in this range.")).not.toBeInTheDocument();
    expect(screen.queryByText("Revenue by Match Tier")).not.toBeInTheDocument();
  });
});
