// Component coverage for the Command Center dashboard's "Budget Pace by Client"
// agency card empty-state (Task #815).
//
// The card used to return null whenever the admin stats came back with no
// tenants, so for an agency with no client budgets configured the whole section
// silently vanished — the same "is this section missing?" confusion the Match
// Tier empty-state (Task #809/#814) was meant to fix.
//
// This locks in the intended behaviour:
//   1. Agency user + admin stats loaded with NO tenants → a friendly
//      empty-state card ("No client budgets to show yet.") renders instead of
//      nothing.
//   2. Agency user + admin stats still loading (data undefined) → the card
//      renders NOTHING (we must distinguish loading from loaded-but-empty so
//      the empty-state doesn't flash before the stats resolve).
//   3. Non-agency/client user → the card stays hidden entirely, even once the
//      (irrelevant) stats resolve empty.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Shared mutable holders the (hoisted) mocks read from so each test can swap the
// auth role and the admin-stats response without re-mocking the modules.
const authState = vi.hoisted(() => ({ isAgency: true }));
const adminStatsState = vi.hoisted(() => ({
  data: undefined as { tenants: unknown[] } | undefined,
}));

vi.mock("@/components/auth-context", () => ({
  useAuth: () => ({ isAgency: authState.isAgency }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { mockApiClientReactModule, makeApiClientHookStub } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  // A minimal but complete overview so Dashboard renders past its skeleton and
  // the Spend-vs-Revenue chart card (every field the metrics row reads).
  const overview = {
    totalRevenue: 0, totalSpend: 0, roas: 0, totalLeads: 0, bookedLeads: 0,
    soldLeads: 0, bookingRate: 0, closeRate: 0, cpl: 0, avgSaleValue: 0,
    attributionMatchRate: 0, invoicedJobCount: 0, paidRevenue: 0, unpaidRevenue: 0,
  };
  return mockApiClientReactModule({
    useGetDashboardOverview: (() => ({
      ...makeApiClientHookStub(),
      data: overview,
    })) as unknown as typeof import("@workspace/api-client-react").useGetDashboardOverview,
    useGetSpendRevenueChart: (() => ({
      ...makeApiClientHookStub(),
      data: { daily: [], historicalRevenue: 0, historicalJobCount: 0 },
    })) as unknown as typeof import("@workspace/api-client-react").useGetSpendRevenueChart,
    useGetAdminDashboardStats: (() => ({
      ...makeApiClientHookStub(),
      data: adminStatsState.data,
    })) as unknown as typeof import("@workspace/api-client-react").useGetAdminDashboardStats,
  });
});

// MetaCampaignBreakdown fires its own fetches and isn't under test here.
vi.mock("@/components/MetaCampaignBreakdown", () => ({
  MetaCampaignBreakdown: () => null,
}));

import Dashboard from "../dashboard";

function renderDashboard() {
  const { hook } = memoryLocation({ path: "/" });
  return render(
    <Router hook={hook}>
      <Dashboard />
    </Router>,
  );
}

beforeEach(() => {
  authState.isAgency = true;
  adminStatsState.data = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Command Center — Budget Pace by Client empty-state (Task #815)", () => {
  it("renders a friendly empty-state for an agency once admin stats load with no tenants", async () => {
    authState.isAgency = true;
    adminStatsState.data = { tenants: [] };

    renderDashboard();

    // The section header stays present (no longer vanishing)...
    expect(await screen.findByText("Budget Pace by Client")).toBeInTheDocument();
    // ...alongside the friendly empty-state copy.
    expect(screen.getByText("No client budgets to show yet.")).toBeInTheDocument();
  });

  it("renders nothing while admin stats are still loading (data undefined)", async () => {
    authState.isAgency = true;
    adminStatsState.data = undefined;

    renderDashboard();

    // The dashboard itself has rendered (its title is present)...
    expect(await screen.findByText("Command Center")).toBeInTheDocument();
    // ...but the budget card must not appear — neither the populated header nor
    // the empty-state — until the stats resolve.
    expect(screen.queryByText("Budget Pace by Client")).not.toBeInTheDocument();
    expect(screen.queryByText("No client budgets to show yet.")).not.toBeInTheDocument();
  });

  it("stays hidden for a non-agency/client user even when stats resolve empty", async () => {
    authState.isAgency = false;
    adminStatsState.data = { tenants: [] };

    renderDashboard();

    expect(await screen.findByText("Command Center")).toBeInTheDocument();
    expect(screen.queryByText("Budget Pace by Client")).not.toBeInTheDocument();
    expect(screen.queryByText("No client budgets to show yet.")).not.toBeInTheDocument();
  });
});
