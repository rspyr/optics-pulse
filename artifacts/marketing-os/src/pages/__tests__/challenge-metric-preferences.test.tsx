import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Challenge from "../challenge";

vi.mock("@/hooks/use-tenant-filter", () => ({
  useTenantFilter: () => ({ effectiveTenantId: null }),
}));

vi.mock("@/components/auth-context", () => ({
  useAuth: () => ({
    user: { id: 1, role: "super_admin" },
  }),
}));

const challengeResponse = {
  dateRange: { startDate: "2026-06-01", endDate: "2026-06-30" },
  selectedFunnels: [],
  funnels: ["Install", "Repair"],
  allocation: {
    method: "pulse_lead_share",
    allUniquePulseLeads: 10,
    mappedSpend: 0,
    mappedMetaLeads: 0,
    unmappedSpend: 0,
    unmappedMetaLeads: 0,
    note: "Allocation note",
  },
  summary: {
    funnel: null,
    costPerLead: 100,
    metaLeads: 10,
    uniquePulseLeads: 10,
    appointmentsBooked: 5,
    bookingRate: 50,
    cancellationRate: 20,
    cancelledJobs: 2,
    totalJobs: 10,
    totalEstimateValue: 10000,
    totalSoldClosedValue: 5000,
    roasPotential: 10,
    roasSold: 5,
    totalSpend: 1000,
    completedEstimateJobs: 4,
    averageCostPerInHomeAppointment: 250,
    soldJobs: 2,
    costToAcquireCustomer: 500,
    averageClosedJobValue: 2500,
  },
  byFunnel: [
    {
      funnel: "Install",
      costPerLead: 100,
      metaLeads: 10,
      uniquePulseLeads: 10,
      appointmentsBooked: 5,
      bookingRate: 50,
      cancellationRate: 20,
      cancelledJobs: 2,
      totalJobs: 10,
      totalEstimateValue: 10000,
      totalSoldClosedValue: 5000,
      roasPotential: 10,
      roasSold: 5,
      totalSpend: 1000,
      completedEstimateJobs: 4,
      averageCostPerInHomeAppointment: 250,
      soldJobs: 2,
      costToAcquireCustomer: 500,
      averageClosedJobValue: 2500,
    },
    {
      funnel: "Repair",
      costPerLead: 200,
      metaLeads: 4,
      uniquePulseLeads: 6,
      appointmentsBooked: 3,
      bookingRate: 50,
      cancellationRate: 0,
      cancelledJobs: 0,
      totalJobs: 6,
      totalEstimateValue: 6000,
      totalSoldClosedValue: 3000,
      roasPotential: 3,
      roasSold: 1.5,
      totalSpend: 800,
      completedEstimateJobs: 2,
      soldJobs: 1,
      costToAcquireCustomer: 800,
      averageClosedJobValue: 3000,
    },
  ],
};

function installLocalStorageShim() {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, String(value))),
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

describe("Challenge metric preferences", () => {
  beforeEach(() => {
    installLocalStorageShim();
    window.localStorage.clear();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/users/me/preferences")) {
        return {
          ok: true,
          json: async () => ({
            challengeDashboardMetrics: {
              order: ["roasSold", "metaLeads", "costPerLead"],
              visibility: { costPerLead: false },
            },
          }),
        } as Response;
      }
      if (url.includes("/api/dashboard/challenge")) {
        return {
          ok: true,
          json: async () => challengeResponse,
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("applies saved visibility/order and opens the visible-count picker", async () => {
    const user = userEvent.setup();
    const { container } = render(<Challenge />);

    await screen.findByText("Per-Funnel Breakdown");
    await waitFor(() => expect(screen.queryByText("CPL")).not.toBeInTheDocument());

    const headerCells = Array.from(container.querySelectorAll("thead th")).map((cell) => cell.textContent?.trim());
    expect(headerCells.slice(0, 3)).toEqual(["Funnel", "ROAS Sold", "Meta Leads"]);

    const visibleButton = screen.getByRole("button", { name: /13 visible/i });
    await user.click(visibleButton);

    const menu = await screen.findByText("Column metrics");
    expect(menu).toBeInTheDocument();
    expect(within(document.body).getByText("Cost Per Lead")).toBeInTheDocument();
  });

  it("coordinates presentation hover across a funnel cell, funnel label, and metric label", async () => {
    const { container } = render(<Challenge />);

    await screen.findByText("Per-Funnel Breakdown");
    const metaLeadCell = screen.getByLabelText("Install Leads From Meta: 10");

    fireEvent.mouseEnter(metaLeadCell);

    expect(metaLeadCell).toHaveAttribute("data-challenge-hover", "active");
    expect(container.querySelectorAll('[data-challenge-hover="active"]')).toHaveLength(3);
  });

  it("keeps shared row and metric hover state while moving on one table axis", async () => {
    const { container } = render(<Challenge />);

    await screen.findByText("Per-Funnel Breakdown");
    const activeLabels = () =>
      Array.from(container.querySelectorAll('[data-challenge-hover="active"]')).map((element) => element.textContent?.trim());

    const installMetaCell = screen.getByLabelText("Install Leads From Meta: 10");
    const installPulseCell = screen.getByLabelText("Install Unique Pulse Leads: 10");
    const repairPulseCell = screen.getByLabelText("Repair Unique Pulse Leads: 6");
    const breakdownGrid = container.querySelector("[data-challenge-breakdown-grid]");

    fireEvent.mouseEnter(installMetaCell);
    expect(activeLabels()).toContain("Install");
    expect(activeLabels()).toContain("Meta Leads");

    fireEvent.mouseOut(installMetaCell, { relatedTarget: installPulseCell });
    expect(activeLabels()).toContain("Install");
    expect(activeLabels()).toContain("Pulse Leads");
    expect(activeLabels()).not.toContain("Meta Leads");

    fireEvent.mouseOut(installPulseCell, { relatedTarget: repairPulseCell });
    expect(activeLabels()).toContain("Repair");
    expect(activeLabels()).toContain("Pulse Leads");
    expect(activeLabels()).not.toContain("Install");

    expect(breakdownGrid).not.toBeNull();
    fireEvent.mouseLeave(breakdownGrid!);
    expect(activeLabels()).toHaveLength(0);
  });
});
