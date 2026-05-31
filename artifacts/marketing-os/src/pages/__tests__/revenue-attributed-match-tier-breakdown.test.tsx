// Component coverage for the "Revenue by Match Tier" breakdown card on the
// Revenue Attributed page (Task #809).
//
// The page's other tests return summary data WITHOUT the `byMatchLevel` field,
// so they only ever exercise the graceful-empty path (card hidden). This file
// closes that gap: it renders the page with a populated `byMatchLevel` array and
// asserts the card shows each tier row (label, corrected revenue, job count) in
// the server-provided rank order plus the reconciliation footnote — and that the
// card stays hidden when `byMatchLevel` is absent or empty.

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

import RevenueAttributed, { type RevenueJob } from "../revenue-attributed";
import { makeTenantFilterStub } from "@/test-utils/use-tenant-filter-mocks";
import { makeAuthStub } from "@/test-utils/auth-context-mocks";

const TENANT_ID = 42;

type MatchTierBreakdown = { tier: string; revenue: number; count: number };

// One completed job so the list renders normally; the card is driven entirely by
// the summary's `byMatchLevel`, independent of the list rows.
const JOBS: RevenueJob[] = [
  {
    id: 1, tenantId: TENANT_ID, stJobId: "ST-1", stInvoiceId: "INV-1",
    customerName: "Acme HVAC", jobType: "install", jobTypeName: "Install",
    status: "completed", revenue: 1000, invoiceTotal: 900, invoiceRebateAmount: 150,
    correctedRevenue: 1050, invoiceDate: "2026-05-01", completedAt: "2026-05-01",
    createdAt: "2026-05-01", matchLevel: "diamond", matchedGclid: "g1",
    rebateBreakdown: [], soldByName: null, lead: null,
  },
];

const FACETS = { funnels: [], sources: [], matchLevels: ["diamond", "golden", "silver", "unmatched"] };

// Builds a URL-aware fetch returning the given summary (with or without
// byMatchLevel) for the summary endpoint and a single-row list otherwise.
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
        headers: { get: (k: string) => (k === "X-Total-Count" ? String(JOBS.length) : null) },
        json: async () => JOBS,
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

beforeEach(() => {
  useTenantFilterMock.mockReset();
  useAuthMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Revenue Attributed — Match Tier breakdown card (Task #809)", () => {
  it("renders each tier row (label, revenue, count) in rank order plus the reconciliation footnote", async () => {
    // Server returns the tiers already sorted strongest → weakest; the card must
    // preserve that order. Non-unmatched revenue sums to attributed (1950).
    const byMatchLevel: MatchTierBreakdown[] = [
      { tier: "diamond", revenue: 1050, count: 2 },
      { tier: "golden", revenue: 600, count: 1 },
      { tier: "silver", revenue: 300, count: 1 },
      { tier: "unmatched", revenue: 500, count: 1 },
    ];
    setUser();
    installFetch({ revenue: 2450, rebates: 150, attributed: 1950, count: 5, byMatchLevel });

    render(<RevenueAttributed />);

    // The card is keyed off the summary fetch resolving with byMatchLevel.
    const heading = await screen.findByText("Revenue by Match Tier");
    // Card root: heading sits in the header's label div → header div → PremiumCard.
    const card = heading.parentElement!.parentElement!;

    // Every tier label is present (tierLabel capitalises the first letter).
    expect(within(card).getByText("Diamond")).toBeInTheDocument();
    expect(within(card).getByText("Golden")).toBeInTheDocument();
    expect(within(card).getByText("Silver")).toBeInTheDocument();
    expect(within(card).getByText("Unmatched")).toBeInTheDocument();

    // Rank order is preserved: labels appear strongest → weakest top to bottom.
    const labels = within(card)
      .getAllByText(/^(Diamond|Golden|Silver|Unmatched)$/)
      .map((el) => el.textContent);
    expect(labels).toEqual(["Diamond", "Golden", "Silver", "Unmatched"]);

    // Per-tier corrected revenue (formatCurrency → no fraction digits).
    expect(within(card).getByText("$1,050")).toBeInTheDocument();
    expect(within(card).getByText("$600")).toBeInTheDocument();
    expect(within(card).getByText("$300")).toBeInTheDocument();
    expect(within(card).getByText("$500")).toBeInTheDocument();

    // Per-tier job counts (singular vs. plural).
    expect(within(card).getByText("2 jobs")).toBeInTheDocument();
    expect(within(card).getAllByText("1 job")).toHaveLength(3);

    // Reconciliation footnote calls out that non-unmatched tiers sum to the
    // Attributed Revenue card's value.
    expect(
      within(card).getByText(/Non-unmatched tiers sum to Attributed Revenue \(\$1,950\)\./),
    ).toBeInTheDocument();
  });

  it("hides the breakdown card when byMatchLevel is absent (graceful-empty path)", async () => {
    setUser();
    installFetch({ revenue: 2450, rebates: 150, attributed: 1950, count: 5 });

    render(<RevenueAttributed />);

    // Wait for the page to settle (list row arrives) before asserting absence.
    await screen.findByText("Acme HVAC");
    expect(screen.queryByText("Revenue by Match Tier")).not.toBeInTheDocument();
  });

  it("hides the breakdown card when byMatchLevel is an empty array", async () => {
    setUser();
    installFetch({ revenue: 2450, rebates: 150, attributed: 1950, count: 5, byMatchLevel: [] });

    render(<RevenueAttributed />);

    await screen.findByText("Acme HVAC");
    await waitFor(() => expect(screen.getByText("Attributed Revenue")).toBeInTheDocument());
    expect(screen.queryByText("Revenue by Match Tier")).not.toBeInTheDocument();
  });
});
