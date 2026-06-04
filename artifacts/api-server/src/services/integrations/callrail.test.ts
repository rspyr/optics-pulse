import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  attributionEventsTable: {
    id: "attribution_events.id",
    tenantId: "attribution_events.tenant_id",
    externalId: "attribution_events.external_id",
    createdLeadId: "attribution_events.created_lead_id",
  },
  leadsTable: {
    id: "leads.id",
    tenantId: "leads.tenant_id",
    phone: "leads.phone",
  },
  integrationSyncLogsTable: {
    id: "integration_sync_logs.id",
  },
}));

vi.mock("../lead-notify-scheduler", () => ({
  scheduleOrEmitNewLead: vi.fn(),
}));

vi.mock("./rate-limiter", () => ({
  withRetry: async <T>(fn: () => Promise<T>) => fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchCallRailCalls", () => {
  it("requests attribution fields and parses source/campaign fallback data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_pages: 1,
        calls: [{
          id: "CAL_123",
          customer_phone_number: "+15035550123",
          customer_name: "Jane Caller",
          tracking_phone_number: "+15035550999",
          start_time: "2026-06-01T10:30:00.000-07:00",
          source_name: "Meta Ads Call Extension Number",
          landing_page_url: "https://example.com/daikin?utm_source=facebook&utm_campaign=daikin-fit&fbclid=fb_abc",
          milestones: {
            lead_created: {
              source: "Facebook Ads",
              medium: "paid_social",
              campaign: "Daikin Fit",
              landing_page_url_params: {
                fbclid: "fb_abc",
              },
            },
          },
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchCallRailCalls } = await import("./callrail");
    const calls = await fetchCallRailCalls({
      apiKey: "test-key",
      accountId: "ACC123",
      companyId: "COM123",
    }, "2026-05-01");

    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    const requestedFields = requestedUrl.searchParams.get("fields") || "";
    expect(requestedFields).toContain("source");
    expect(requestedFields).toContain("source_name");
    expect(requestedFields).toContain("utm_source");
    expect(requestedFields).toContain("fbclid");
    expect(requestedFields).toContain("milestones");

    expect(requestedUrl.searchParams.get("company_id")).toBe("COM123");
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe("Facebook Ads");
    expect(calls[0].sourceName).toBe("Meta Ads Call Extension Number");
    expect(calls[0].campaign).toBe("Daikin Fit");
    expect(calls[0].utmSource).toBe("facebook");
    expect(calls[0].fbclid).toBe("fb_abc");
  });
});
