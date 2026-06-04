import { afterEach, describe, expect, it, vi } from "vitest";
import { db, attributionEventsTable, integrationSyncLogsTable, leadsTable } from "@workspace/db";

vi.mock("@workspace/db", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
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

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
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

describe("syncCallRailCalls", () => {
  it("reuses an event's existing linked lead before creating an attribution-only lead", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_pages: 1,
        calls: [{
          id: "CAL_existing",
          customer_name: "Anonymous Caller",
          start_time: "2026-06-01T10:30:00.000-07:00",
          source_name: "Website pool",
          source: "Google Organic",
          campaign: "Website pool",
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const insertCalls: unknown[] = [];
    const updateCalls: unknown[] = [];

    vi.mocked(db.insert).mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation((values: unknown) => {
        insertCalls.push({ table, values });
        return {
          returning: vi.fn().mockResolvedValue(table === integrationSyncLogsTable ? [{ id: 10 }] : []),
        };
      }),
    }) as never);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 700, createdLeadId: 70 }]),
        }),
      }),
    } as never);

    vi.mocked(db.update).mockImplementation((table: unknown) => ({
      set: vi.fn().mockImplementation((values: unknown) => {
        updateCalls.push({ table, values });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }) as never);

    const { syncCallRailCalls } = await import("./callrail");
    const result = await syncCallRailCalls(1, {
      apiKey: "test-key",
      accountId: "ACC123",
    }, {
      days: 30,
      createLeadMode: "attribution_only",
    });

    expect(result).toEqual({ synced: 1, newCalls: 0, updatedCalls: 1 });
    expect(insertCalls.filter((call) => (call as { table: unknown }).table === leadsTable)).toHaveLength(0);
    expect(updateCalls.some((call) => {
      const update = call as { table: unknown; values: Record<string, unknown> };
      return update.table === attributionEventsTable && update.values.createdLeadId === 70;
    })).toBe(true);
  });
});
