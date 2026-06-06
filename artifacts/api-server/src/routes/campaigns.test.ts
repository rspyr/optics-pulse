import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = {
  selectResults: [] as unknown[][],
  _selectIdx: 0,
  reset() {
    this._selectIdx = 0;
    this.selectResults = [];
  },
};

interface Thenable extends Record<string, unknown> {
  then: (resolve: Function, reject?: Function) => Promise<unknown>;
}

function thenable(result: unknown[]): Thenable {
  return {
    then: (resolve: Function, reject?: Function) =>
      Promise.resolve(result).then(
        resolve as (v: unknown) => unknown,
        reject as (e: unknown) => unknown,
      ),
  };
}

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const lazy = () => thenable(results());
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(
    Object.assign(lazy(), {
      groupBy: vi.fn().mockImplementation(() => Promise.resolve(results())),
      orderBy: vi.fn().mockReturnValue(lazy()),
      limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
    }),
  );
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(
      resolve as (v: unknown) => unknown,
      reject as (e: unknown) => unknown,
    );
  return chain;
}

vi.mock("@workspace/db", () => {
  const tbl = (name: string, cols: string[]) =>
    Object.fromEntries([["__name", name], ...cols.map((c) => [c, `${name}.${c}`])]);
  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const idx = mockDb._selectIdx++;
        return makeSelectChain(() => mockDb.selectResults[idx] || []);
      }),
    },
    campaignsTable: tbl("campaigns", [
      "id",
      "tenantId",
      "platform",
      "externalId",
      "name",
      "status",
      "currency",
      "metaAdAccountId",
    ]),
    campaignDailyStatsTable: tbl("campaign_daily_stats", [
      "campaignId",
      "date",
      "spend",
      "impressions",
      "clicks",
      "conversions",
    ]),
    campaignFunnelMappingsTable: tbl("campaign_funnel_mappings", [
      "id",
      "tenantId",
      "campaignId",
      "adSetExternalId",
      "funnelTypeId",
    ]),
    campaignFunnelMatchCodesTable: tbl("campaign_funnel_match_codes", [
      "id",
      "funnelTypeId",
      "code",
    ]),
    funnelTypesTable: tbl("funnel_types", ["id", "name", "slug"]),
    tenantFunnelTypesTable: tbl("tenant_funnel_types", ["tenantId", "funnelTypeId"]),
    metaAdAccountsTable: tbl("meta_ad_accounts", [
      "tenantId",
      "accountId",
      "currency",
    ]),
    metaAdSetsTable: tbl("meta_ad_sets", [
      "tenantId",
      "campaignExternalId",
      "externalId",
      "name",
      "effectiveStatus",
      "dailyBudgetCents",
    ]),
    metaAdsTable: tbl("meta_ads", [
      "tenantId",
      "campaignExternalId",
      "externalId",
      "adSetExternalId",
      "name",
      "effectiveStatus",
      "creativeId",
    ]),
    metaAdDailyStatsTable: tbl("meta_ad_daily_stats", [
      "tenantId",
      "campaignExternalId",
      "adSetExternalId",
      "adExternalId",
      "date",
      "spend",
      "impressions",
      "clicks",
      "conversions",
    ]),
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...a: unknown[]) => a),
  and: vi.fn((...a: unknown[]) => a),
  gte: vi.fn((...a: unknown[]) => a),
  lte: vi.fn((...a: unknown[]) => a),
  inArray: vi.fn((...a: unknown[]) => a),
  asc: vi.fn((...a: unknown[]) => a),
  sql: Object.assign(vi.fn((...a: unknown[]) => a), {}),
}));

vi.mock("@workspace/api-zod", () => ({
  ListCampaignsQueryParams: { parse: (q: unknown) => q },
}));

import express, { type Request, type Response, type NextFunction } from "express";

let app: express.Express;

async function setupApp(role: string = "super_admin", tenantId: number | null = null) {
  vi.resetModules();
  const mod = await import("./campaigns");
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: 1,
      userRole: role,
      tenantId,
    };
    next();
  });
  app.use(mod.default);
}

function getJson(
  expressApp: express.Express,
  path: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET" },
        (res: { statusCode: number; on: Function }) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : {} });
          });
        },
      );
      req.end();
    });
  });
}

function sendJson(
  expressApp: express.Express,
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body === undefined ? "" : JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res: { statusCode: number; on: Function }) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : {} });
          });
        },
      );
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe("meta-funnel-match-codes authorization", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  it("forbids client_admin from creating a global match code", async () => {
    await setupApp("client_admin", 5);
    const res = await sendJson(app, "POST", "/campaigns/meta-funnel-match-codes", {
      tenantId: 5,
      funnelTypeId: 1,
      code: "foo",
    });
    expect(res.status).toBe(403);
  });

  it("forbids client_admin from deleting a global match code", async () => {
    await setupApp("client_admin", 5);
    const res = await sendJson(app, "DELETE", "/campaigns/meta-funnel-match-codes/1");
    expect(res.status).toBe(403);
  });

  it("forbids client_user from mutating global match codes", async () => {
    await setupApp("client_user", 5);
    const res = await sendJson(app, "POST", "/campaigns/meta-funnel-match-codes", {
      tenantId: 5,
      funnelTypeId: 1,
      code: "foo",
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /campaigns/meta-summary", () => {
  beforeEach(async () => {
    mockDb.reset();
    vi.clearAllMocks();
    await setupApp();
  });

  it("returns [] without querying stats when there are no Meta campaigns", async () => {
    mockDb.selectResults = [[]];
    const res = await getJson(app, "/campaigns/meta-summary");
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
    // Only the campaigns lookup ran; no accounts / stats queries.
    expect(mockDb._selectIdx).toBe(1);
  });

  it("aggregates per-campaign spend and resolves currency from meta_ad_accounts", async () => {
    mockDb.selectResults = [
      // campaigns
      [
        {
          id: 11,
          tenantId: 5,
          platform: "meta",
          externalId: "c-ext-1",
          name: "Camp A",
          status: "ACTIVE",
          currency: "USD",
          metaAdAccountId: "act_111",
        },
        {
          id: 12,
          tenantId: 5,
          platform: "meta",
          externalId: "c-ext-2",
          name: "Camp B",
          status: "PAUSED",
          // No metaAdAccountId — falls back to campaign.currency.
          currency: "EUR",
          metaAdAccountId: null,
        },
      ],
      // ad accounts: account override beats the campaign.currency value.
      [{ tenantId: 5, accountId: "act_111", currency: "GBP" }],
      // aggregated meta_ad_daily_stats per campaign external id
      [
        { campaignExternalId: "c-ext-1", spend: 100, impressions: 1000, clicks: 50, conversions: 10 },
        { campaignExternalId: "c-ext-2", spend: 25.5, impressions: 200, clicks: 5, conversions: 0 },
      ],
    ];

    const res = await getJson(
      app,
      "/campaigns/meta-summary?tenantId=5&startDate=2026-04-01&endDate=2026-04-30",
    );
    expect(res.status).toBe(200);

    // Date range must be passed through to the stats query.
    const drizzle = await import("drizzle-orm");
    expect(vi.mocked(drizzle.gte)).toHaveBeenCalledWith(
      "meta_ad_daily_stats.date",
      "2026-04-01",
    );
    expect(vi.mocked(drizzle.lte)).toHaveBeenCalledWith(
      "meta_ad_daily_stats.date",
      "2026-04-30",
    );

    const rows = res.json as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // Sorted by spend desc.
    expect(rows[0].externalId).toBe("c-ext-1");
    expect(rows[0].currency).toBe("GBP"); // overridden by meta_ad_accounts row
    expect(rows[0].spend).toBe(100);
    expect(rows[0].cpl).toBe(10);
    expect(rows[1].externalId).toBe("c-ext-2");
    expect(rows[1].currency).toBe("EUR"); // fallback to campaign.currency
    expect(rows[1].spend).toBe(25.5);
    expect(rows[1].cpl).toBe(0); // 0 conversions => 0
  });

  it("treats campaigns with no daily stats as zero (not missing)", async () => {
    mockDb.selectResults = [
      [
        {
          id: 21,
          tenantId: 5,
          platform: "meta",
          externalId: "c-zero",
          name: "Zero",
          status: "ACTIVE",
          currency: null,
          metaAdAccountId: null,
        },
      ],
      [], // no accounts queried (no ad account id)
      [], // no agg rows
    ];
    const res = await getJson(app, "/campaigns/meta-summary?tenantId=5");
    expect(res.status).toBe(200);
    const rows = res.json as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        campaignId: 21,
        externalId: "c-zero",
        name: "Zero",
        status: "ACTIVE",
        currency: null,
        adAccountId: null,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        cpl: 0,
      },
    ]);
  });
});

describe("GET /campaigns/:campaignId/breakdown", () => {
  beforeEach(async () => {
    mockDb.reset();
    vi.clearAllMocks();
    await setupApp();
  });

  it("returns 400 for an invalid campaignId", async () => {
    const res = await getJson(app, "/campaigns/not-a-number/breakdown");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the campaign does not exist", async () => {
    mockDb.selectResults = [[]];
    const res = await getJson(app, "/campaigns/9999/breakdown");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the campaign is not a Meta campaign", async () => {
    mockDb.selectResults = [
      [
        {
          id: 7,
          tenantId: 5,
          platform: "google",
          externalId: "g-1",
          name: "Google Camp",
          status: "ACTIVE",
          currency: "USD",
          metaAdAccountId: null,
        },
      ],
    ];
    const res = await getJson(app, "/campaigns/7/breakdown");
    expect(res.status).toBe(404);
  });

  it("returns 404 for non-super-admin users from a different tenant", async () => {
    await setupApp("manager", 99); // session tenant 99, campaign tenant 5
    mockDb.selectResults = [
      [
        {
          id: 8,
          tenantId: 5,
          platform: "meta",
          externalId: "m-1",
          name: "Other tenant",
          status: "ACTIVE",
          currency: "USD",
          metaAdAccountId: null,
        },
      ],
    ];
    const res = await getJson(app, "/campaigns/8/breakdown");
    expect(res.status).toBe(404);
  });

  it("groups ads by ad set, resolves currency from meta_ad_accounts, and sorts by spend", async () => {
    mockDb.selectResults = [
      // 1: campaign lookup
      [
        {
          id: 30,
          tenantId: 5,
          platform: "meta",
          externalId: "camp-30",
          name: "Big Camp",
          status: "ACTIVE",
          currency: "USD",
          metaAdAccountId: "act_999",
        },
      ],
      // 2: meta_ad_accounts lookup -> currency override
      [{ tenantId: 5, accountId: "act_999", currency: "CAD" }],
      // Promise.all order: 3 = adSets, 4 = ads, 5 = perAdAgg
      // 3: ad sets
      [
        {
          tenantId: 5,
          externalId: "set-A",
          campaignExternalId: "camp-30",
          name: "Set A",
          effectiveStatus: "ACTIVE",
          dailyBudgetCents: 5000,
        },
        {
          tenantId: 5,
          externalId: "set-B",
          campaignExternalId: "camp-30",
          name: "Set B",
          effectiveStatus: "PAUSED",
          dailyBudgetCents: null,
        },
      ],
      // 4: ads -- two in Set A, one in Set B
      [
        {
          tenantId: 5,
          externalId: "ad-a1",
          adSetExternalId: "set-A",
          campaignExternalId: "camp-30",
          name: "Ad A1",
          effectiveStatus: "ACTIVE",
          creativeId: "cr-a1",
        },
        {
          tenantId: 5,
          externalId: "ad-a2",
          adSetExternalId: "set-A",
          campaignExternalId: "camp-30",
          name: "Ad A2",
          effectiveStatus: "ACTIVE",
          creativeId: "cr-a2",
        },
        {
          tenantId: 5,
          externalId: "ad-b1",
          adSetExternalId: "set-B",
          campaignExternalId: "camp-30",
          name: "Ad B1",
          effectiveStatus: "PAUSED",
          creativeId: "cr-b1",
        },
      ],
      // 5: per-ad aggregated stats
      [
        { adExternalId: "ad-a1", adSetExternalId: "set-A", spend: 80, impressions: 800, clicks: 40, conversions: 8 },
        { adExternalId: "ad-a2", adSetExternalId: "set-A", spend: 20, impressions: 200, clicks: 10, conversions: 2 },
        { adExternalId: "ad-b1", adSetExternalId: "set-B", spend: 5, impressions: 50, clicks: 1, conversions: 0 },
      ],
    ];

    const res = await getJson(app, "/campaigns/30/breakdown?startDate=2026-05-01&endDate=2026-05-13");
    expect(res.status).toBe(200);

    // The date range must be applied to the per-ad stats query, not just
    // accepted and ignored. Assert the drizzle predicate helpers were
    // called with the date column and the supplied bounds.
    const drizzle = await import("drizzle-orm");
    expect(vi.mocked(drizzle.gte)).toHaveBeenCalledWith(
      "meta_ad_daily_stats.date",
      "2026-05-01",
    );
    expect(vi.mocked(drizzle.lte)).toHaveBeenCalledWith(
      "meta_ad_daily_stats.date",
      "2026-05-13",
    );

    const body = res.json as Record<string, unknown>;
    expect(body.campaignId).toBe(30);
    expect(body.currency).toBe("CAD"); // resolved from meta_ad_accounts
    expect(body.adAccountId).toBe("act_999");
    const adSets = body.adSets as Array<Record<string, unknown>>;
    expect(adSets).toHaveLength(2);
    // Sorted by spend desc: Set A (100) before Set B (5).
    expect(adSets[0].externalId).toBe("set-A");
    expect(adSets[0].spend).toBe(100);
    expect(adSets[0].conversions).toBe(10);
    expect(adSets[0].cpl).toBe(10);
    const setAAds = adSets[0].ads as Array<Record<string, unknown>>;
    expect(setAAds.map((a) => a.externalId)).toEqual(["ad-a1", "ad-a2"]);
    expect(setAAds[0].spend).toBe(80);
    expect(adSets[1].externalId).toBe("set-B");
    expect(adSets[1].spend).toBe(5);
    expect(adSets[1].cpl).toBe(0);
  });

  it("falls back to the campaign currency when there is no metaAdAccountId", async () => {
    mockDb.selectResults = [
      [
        {
          id: 31,
          tenantId: 5,
          platform: "meta",
          externalId: "camp-31",
          name: "No Account",
          status: "ACTIVE",
          currency: "AUD",
          metaAdAccountId: null,
        },
      ],
      // No accounts query because metaAdAccountId is null. Promise.all next.
      [], // ad sets
      [], // ads
      [], // per-ad agg
    ];
    const res = await getJson(app, "/campaigns/31/breakdown");
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body.currency).toBe("AUD");
    expect(body.adSets).toEqual([]);
  });

  it("buckets ads with a missing/unknown ad_set into an (Unassigned) row", async () => {
    mockDb.selectResults = [
      [
        {
          id: 32,
          tenantId: 5,
          platform: "meta",
          externalId: "camp-32",
          name: "Orphan Camp",
          status: "ACTIVE",
          currency: "USD",
          metaAdAccountId: "act_orphan",
        },
      ],
      [{ tenantId: 5, accountId: "act_orphan", currency: "USD" }],
      // ad sets: only set-X exists
      [
        {
          tenantId: 5,
          externalId: "set-X",
          campaignExternalId: "camp-32",
          name: "Set X",
          effectiveStatus: "ACTIVE",
          dailyBudgetCents: 1000,
        },
      ],
      // ads: one belongs to set-X (known), one to a deleted set-GONE, one with null adSetExternalId.
      [
        {
          tenantId: 5,
          externalId: "ad-known",
          adSetExternalId: "set-X",
          campaignExternalId: "camp-32",
          name: "Known",
          effectiveStatus: "ACTIVE",
          creativeId: "cr1",
        },
        {
          tenantId: 5,
          externalId: "ad-orphan-1",
          adSetExternalId: "set-GONE",
          campaignExternalId: "camp-32",
          name: "Orphaned",
          effectiveStatus: "ACTIVE",
          creativeId: "cr2",
        },
        {
          tenantId: 5,
          externalId: "ad-orphan-2",
          adSetExternalId: null,
          campaignExternalId: "camp-32",
          name: "No Set",
          effectiveStatus: "ACTIVE",
          creativeId: "cr3",
        },
      ],
      // per-ad agg
      [
        { adExternalId: "ad-known", adSetExternalId: "set-X", spend: 50, impressions: 500, clicks: 25, conversions: 5 },
        { adExternalId: "ad-orphan-1", adSetExternalId: "set-GONE", spend: 70, impressions: 700, clicks: 35, conversions: 7 },
        { adExternalId: "ad-orphan-2", adSetExternalId: null, spend: 30, impressions: 300, clicks: 15, conversions: 3 },
      ],
    ];

    const res = await getJson(app, "/campaigns/32/breakdown");
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    const adSets = body.adSets as Array<Record<string, unknown>>;
    expect(adSets).toHaveLength(2);
    // Orphan bucket totals 100 (70+30), beats Set X (50), so orphan is first.
    expect(adSets[0].externalId).toBe("__unassigned__");
    expect(adSets[0].name).toBe("(Unassigned)");
    expect(adSets[0].status).toBeNull();
    expect(adSets[0].dailyBudgetCents).toBeNull();
    expect(adSets[0].spend).toBe(100);
    const orphanAds = adSets[0].ads as Array<Record<string, unknown>>;
    expect(orphanAds.map((a) => a.externalId).sort()).toEqual(["ad-orphan-1", "ad-orphan-2"]);
    expect(adSets[1].externalId).toBe("set-X");
    expect(adSets[1].spend).toBe(50);
    const knownAds = adSets[1].ads as Array<Record<string, unknown>>;
    expect(knownAds).toHaveLength(1);
    expect(knownAds[0].externalId).toBe("ad-known");
  });
});
