// Component coverage for the Command Center dashboard's "Spend vs Revenue
// Attribution" chart empty-state (Task #816).
//
// The chart card always stays on the page (unlike the sibling Budget Pace /
// Match Tier sections that used to vanish), but its empty message didn't
// distinguish loading from loaded-but-empty and read as a generic "No chart
// data available". This locks in the intended behaviour:
//   1. Chart request still in flight (data undefined) → a neutral "Loading…"
//      placeholder, NOT the empty-state copy (so it can't flash before the
//      request resolves).
//   2. Chart loaded with no daily rows → a friendly, consistent empty-state.
//   3. Chart loaded with data → the empty/loading copy is gone (no regression).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Recharts' ResponsiveContainer relies on ResizeObserver, which jsdom doesn't
// provide. Stub it so the populated-chart render doesn't throw.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

// Shared mutable holder the (hoisted) chart mock reads from so each test can
// swap the spend-vs-revenue response without re-mocking the module.
const chartState = vi.hoisted(() => ({
  data: undefined as
    | { daily: Array<{ date: string; spend: number; revenue: number }>; historicalRevenue: number; historicalJobCount: number }
    | undefined,
}));

vi.mock("@/components/auth-context", () => ({
  useAuth: () => ({ isAgency: true }),
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
      data: chartState.data,
    })) as unknown as typeof import("@workspace/api-client-react").useGetSpendRevenueChart,
    // Agency-only card; resolve it empty so it never throws and isn't under test here.
    useGetAdminDashboardStats: (() => ({
      ...makeApiClientHookStub(),
      data: { tenants: [] },
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
  chartState.data = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Command Center — Spend vs Revenue chart empty-state (Task #816)", () => {
  it("shows a neutral Loading placeholder while the chart request is in flight", async () => {
    chartState.data = undefined;

    renderDashboard();

    // The card header stays present...
    expect(await screen.findByText("Spend vs Revenue Attribution")).toBeInTheDocument();
    // ...with the loading placeholder, and NOT the empty-state copy.
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(
      screen.queryByText("No spend or revenue to show for this date range yet."),
    ).not.toBeInTheDocument();
  });

  it("shows a friendly empty-state once the chart loads with no daily rows", async () => {
    chartState.data = { daily: [], historicalRevenue: 0, historicalJobCount: 0 };

    renderDashboard();

    expect(await screen.findByText("Spend vs Revenue Attribution")).toBeInTheDocument();
    expect(
      screen.getByText("No spend or revenue to show for this date range yet."),
    ).toBeInTheDocument();
    // The transient loading copy must be gone once data has resolved.
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("renders the chart (no empty/loading copy) when daily data is present", async () => {
    chartState.data = {
      daily: [{ date: "2026-05-01", spend: 100, revenue: 500 }],
      historicalRevenue: 0,
      historicalJobCount: 0,
    };

    renderDashboard();

    expect(await screen.findByText("Spend vs Revenue Attribution")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No spend or revenue to show for this date range yet."),
    ).not.toBeInTheDocument();
  });
});
