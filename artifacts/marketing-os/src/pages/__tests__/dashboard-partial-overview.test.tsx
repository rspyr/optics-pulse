import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("@/components/auth-context", () => ({
  useAuth: () => ({ isAgency: true }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { mockApiClientReactModule, makeApiClientHookStub } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  return mockApiClientReactModule({
    useGetDashboardOverview: (() => ({
      ...makeApiClientHookStub(),
      data: {
        totalRevenue: 0,
        totalSpend: 0,
      },
    })) as unknown as typeof import("@workspace/api-client-react").useGetDashboardOverview,
    useGetSpendRevenueChart: (() => ({
      ...makeApiClientHookStub(),
      data: { daily: [], historicalRevenue: 0, historicalJobCount: 0 },
    })) as unknown as typeof import("@workspace/api-client-react").useGetSpendRevenueChart,
    useGetAdminDashboardStats: (() => ({
      ...makeApiClientHookStub(),
      data: { tenants: [] },
    })) as unknown as typeof import("@workspace/api-client-react").useGetAdminDashboardStats,
  });
});

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

describe("Command Center partial overview response", () => {
  it("does not crash when optional numeric metrics are missing", async () => {
    renderDashboard();

    expect(await screen.findByText("Command Center")).toBeInTheDocument();
    expect(screen.getByText("ROAS")).toBeInTheDocument();
    expect(screen.getByText("0.00x")).toBeInTheDocument();
  });
});
