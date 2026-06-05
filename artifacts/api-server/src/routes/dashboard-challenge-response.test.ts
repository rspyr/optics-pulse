import { describe, expect, it, vi } from "vitest";

const tableProxy = (name: string) =>
  new Proxy({}, { get: (_target, prop) => `${name}.${String(prop)}` });

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn() },
  leadsTable: tableProxy("leads"),
  jobsTable: tableProxy("jobs"),
  campaignsTable: tableProxy("campaigns"),
  campaignDailyStatsTable: tableProxy("campaign_daily_stats"),
  attributionEventsTable: tableProxy("attribution_events"),
  tenantsTable: tableProxy("tenants"),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  count: vi.fn(),
  sum: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
  SQL: class {},
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { join: vi.fn((items: unknown[]) => items) },
  ),
}));

vi.mock("../middleware/auth", () => ({
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  denyClientUser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/tenant-scope", () => ({
  resolveListTenantScope: vi.fn(),
}));

const { buildChallengeDashboardResponse } = await import("./dashboard");

describe("buildChallengeDashboardResponse", () => {
  it("calculates cancellation rate from cancelled jobs divided by total jobs", () => {
    const response = buildChallengeDashboardResponse({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      selectedFunnels: [],
      funnels: ["Install"],
      totalSpend: 1000,
      metaLeads: 20,
      rows: [
        {
          row_type: "summary",
          funnel: "All funnels",
          meta_leads: 16,
          unique_pulse_leads: 10,
          appointments_booked: 5,
          total_jobs: 10,
          cancelled_jobs: 3,
          completed_estimate_jobs: 4,
          total_estimate_value: 50000,
          sold_closed_value: 25000,
          sold_jobs: 2,
          all_unique_pulse_leads: 10,
        },
        {
          row_type: "funnel",
          funnel: "Install",
          meta_leads: 7,
          unique_pulse_leads: 10,
          appointments_booked: 5,
          total_jobs: 4,
          cancelled_jobs: 1,
          completed_estimate_jobs: 2,
          total_estimate_value: 30000,
          sold_closed_value: 12000,
          sold_jobs: 1,
          all_unique_pulse_leads: 10,
        },
      ],
    });

    expect(response.summary.cancelledJobs).toBe(3);
    expect(response.summary.totalJobs).toBe(10);
    expect(response.summary.cancellationRate).toBe(30);
    expect(response.byFunnel[0]?.cancelledJobs).toBe(1);
    expect(response.byFunnel[0]?.totalJobs).toBe(4);
    expect(response.byFunnel[0]?.cancellationRate).toBe(25);
  });

  it("uses raw Meta lead submissions from the lead cohort for CPL instead of prorated campaign conversions", () => {
    const response = buildChallengeDashboardResponse({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      selectedFunnels: [],
      funnels: ["Install", "Heat Pump"],
      totalSpend: 1000,
      metaLeads: 20,
      rows: [
        {
          row_type: "summary",
          funnel: "All funnels",
          meta_leads: 50,
          unique_pulse_leads: 25,
          appointments_booked: 0,
          total_jobs: 0,
          cancelled_jobs: 0,
          completed_estimate_jobs: 0,
          total_estimate_value: 0,
          sold_closed_value: 0,
          sold_jobs: 0,
          all_unique_pulse_leads: 25,
        },
        {
          row_type: "funnel",
          funnel: "Install",
          meta_leads: 40,
          unique_pulse_leads: 20,
          appointments_booked: 0,
          total_jobs: 0,
          cancelled_jobs: 0,
          completed_estimate_jobs: 0,
          total_estimate_value: 200,
          sold_closed_value: 0,
          sold_jobs: 0,
          all_unique_pulse_leads: 25,
        },
        {
          row_type: "funnel",
          funnel: "Heat Pump",
          meta_leads: 5,
          unique_pulse_leads: 5,
          appointments_booked: 0,
          total_jobs: 0,
          cancelled_jobs: 0,
          completed_estimate_jobs: 0,
          total_estimate_value: 100,
          sold_closed_value: 0,
          sold_jobs: 0,
          all_unique_pulse_leads: 25,
        },
      ],
    });

    expect(response.summary.metaLeads).toBe(50);
    expect(response.summary.costPerLead).toBe(20);
    expect(response.byFunnel.map((row) => row.costPerLead)).toEqual([20, 40]);
  });

  it("uses saved Meta campaign mappings for per-funnel spend and Meta leads", () => {
    const response = buildChallengeDashboardResponse({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      selectedFunnels: ["Install"],
      funnels: ["Install", "Heat Pump"],
      totalSpend: 1000,
      metaLeads: 100,
      adRows: [
        { funnel: "Install", mapped: true, spend: 300, meta_leads: 30 },
        { funnel: "Heat Pump", mapped: true, spend: 200, meta_leads: 5 },
        { funnel: null, mapped: false, spend: 500, meta_leads: 65 },
      ],
      rows: [
        {
          row_type: "summary",
          funnel: "All funnels",
          meta_leads: 80,
          unique_pulse_leads: 25,
          appointments_booked: 0,
          total_jobs: 0,
          cancelled_jobs: 0,
          completed_estimate_jobs: 0,
          total_estimate_value: 30000,
          sold_closed_value: 0,
          sold_jobs: 0,
          all_unique_pulse_leads: 25,
        },
        {
          row_type: "funnel",
          funnel: "Install",
          meta_leads: 50,
          unique_pulse_leads: 20,
          appointments_booked: 0,
          total_jobs: 0,
          cancelled_jobs: 0,
          completed_estimate_jobs: 0,
          total_estimate_value: 20000,
          sold_closed_value: 0,
          sold_jobs: 0,
          all_unique_pulse_leads: 25,
        },
        {
          row_type: "funnel",
          funnel: "Heat Pump",
          meta_leads: 30,
          unique_pulse_leads: 5,
          appointments_booked: 0,
          total_jobs: 0,
          cancelled_jobs: 0,
          completed_estimate_jobs: 0,
          total_estimate_value: 10000,
          sold_closed_value: 0,
          sold_jobs: 0,
          all_unique_pulse_leads: 25,
        },
      ],
    });

    expect(response.allocation.method).toBe("meta_campaign_adset_funnel_mapping");
    expect(response.allocation.mappedSpend).toBe(500);
    expect(response.allocation.unmappedSpend).toBe(500);
    expect(response.summary.totalSpend).toBe(300);
    expect(response.summary.metaLeads).toBe(30);
    expect(response.summary.costPerLead).toBe(10);

    const install = response.byFunnel.find((row) => row.funnel === "Install");
    const heatPump = response.byFunnel.find((row) => row.funnel === "Heat Pump");
    expect(install?.totalSpend).toBe(300);
    expect(install?.costPerLead).toBe(10);
    expect(heatPump?.totalSpend).toBe(200);
    expect(heatPump?.costPerLead).toBe(40);
  });

  it("omits unmapped Meta rows from the all-funnels summary when mappings exist", () => {
    const response = buildChallengeDashboardResponse({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      selectedFunnels: [],
      funnels: ["Install", "Heat Pump"],
      totalSpend: 1000,
      metaLeads: 100,
      adRows: [
        { funnel: "Install", mapped: true, spend: 300, meta_leads: 30 },
        { funnel: "Heat Pump", mapped: true, spend: 200, meta_leads: 5 },
        { funnel: null, mapped: false, spend: 500, meta_leads: 65 },
      ],
      rows: [
        {
          row_type: "summary",
          funnel: "All funnels",
          meta_leads: 80,
          unique_pulse_leads: 25,
          appointments_booked: 0,
          total_jobs: 0,
          cancelled_jobs: 0,
          completed_estimate_jobs: 0,
          total_estimate_value: 30000,
          sold_closed_value: 0,
          sold_jobs: 0,
          all_unique_pulse_leads: 25,
        },
      ],
    });

    expect(response.summary.totalSpend).toBe(500);
    expect(response.summary.metaLeads).toBe(35);
    expect(response.allocation.unmappedSpend).toBe(500);
    expect(response.allocation.unmappedMetaLeads).toBe(65);
  });
});
