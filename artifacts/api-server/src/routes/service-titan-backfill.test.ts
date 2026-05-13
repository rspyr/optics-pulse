import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";
import { encryptConfig } from "../lib/encryption";

// ─── Db mock state ───────────────────────────────────────────────────────────

interface InsertCall { table: string; values: unknown[]; onConflict?: "update" | "nothing" }
interface UpdateCall { table: string; set: Record<string, unknown> }

const state = {
  selectQueue: [] as unknown[][],
  insertCalls: [] as InsertCall[],
  insertReturning: new Map<string, unknown[]>(),
  updateCalls: [] as UpdateCall[],
  executeQueue: [] as Array<{ rows: unknown[] }>,
  reset() {
    this.selectQueue = [];
    this.insertCalls = [];
    this.insertReturning.clear();
    this.updateCalls = [];
    this.executeQueue = [];
  },
};

function tableName(t: unknown): string {
  return (t as { __name?: string })?.__name || "unknown";
}

vi.mock("@workspace/db", () => {
  const tables = {
    tenantsTable: { __name: "tenants", id: "tenants.id" },
    campaignsTable: { __name: "campaigns" },
    campaignDailyStatsTable: { __name: "campaign_daily_stats" },
    integrationSyncLogsTable: { __name: "integration_sync_logs", id: "isl.id" },
    metaAdDailyStatsTable: { __name: "meta_ad_daily_stats" },
    metaAdAccountsTable: { __name: "meta_ad_accounts" },
    metaAdsTable: { __name: "meta_ads" },
    metaAdSetsTable: { __name: "meta_ad_sets" },
    jobsTable: {
      __name: "jobs",
      id: "jobs.id",
      tenantId: "jobs.tenantId",
      stJobId: "jobs.stJobId",
      stJobIdHash: "jobs.stJobIdHash",
      leadId: "jobs.leadId",
      customerPhone: "jobs.customerPhone",
      customerEmail: "jobs.customerEmail",
    },
    leadsTable: { __name: "leads", id: "leads.id" },
    soldEstimatesTable: { __name: "sold_estimates" },
    callAttemptsTable: { __name: "call_attempts" },
  };

  function makeSelectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const resolveResult = () => {
      const next = state.selectQueue.length ? state.selectQueue.shift() : [];
      return Promise.resolve(next);
    };
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue({
      limit: vi.fn().mockImplementation(resolveResult),
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(resolveResult),
        then: (r: Function) => resolveResult().then(r as (v: unknown) => unknown),
      }),
      then: (r: Function) => resolveResult().then(r as (v: unknown) => unknown),
    });
    chain.limit = vi.fn().mockImplementation(resolveResult);
    chain.then = (r: Function) => resolveResult().then(r as (v: unknown) => unknown);
    return chain;
  }

  const db = {
    select: vi.fn().mockImplementation(() => makeSelectChain()),
    insert: vi.fn().mockImplementation((table: unknown) => {
      const name = tableName(table);
      return {
        values: vi.fn().mockImplementation((vals: unknown) => {
          const valsArr = Array.isArray(vals) ? vals : [vals];
          const baseCall: InsertCall = { table: name, values: valsArr };
          state.insertCalls.push(baseCall);
          const returningRows = state.insertReturning.get(name) || [];
          const ret = {
            returning: vi.fn().mockResolvedValue(returningRows),
            then: (r: Function) => Promise.resolve(undefined).then(r as (v: unknown) => unknown),
          };
          return Object.assign(ret, {
            onConflictDoUpdate: vi.fn().mockImplementation(() => {
              baseCall.onConflict = "update";
              return ret;
            }),
            onConflictDoNothing: vi.fn().mockImplementation(() => {
              baseCall.onConflict = "nothing";
              return ret;
            }),
          });
        }),
      };
    }),
    update: vi.fn().mockImplementation((table: unknown) => {
      const name = tableName(table);
      return {
        set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          state.updateCalls.push({ table: name, set: vals });
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      };
    }),
    execute: vi.fn().mockImplementation(() => {
      const next = state.executeQueue.length ? state.executeQueue.shift()! : { rows: [] };
      return Promise.resolve(next);
    }),
  };

  return { db, ...tables };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  or: vi.fn((...args: unknown[]) => ({ __op: "or", args })),
  isNull: vi.fn((a: unknown) => ({ __op: "isNull", a })),
  isNotNull: vi.fn((a: unknown) => ({ __op: "isNotNull", a })),
  notInArray: vi.fn((...args: unknown[]) => ({ __op: "notInArray", args })),
  inArray: vi.fn((...args: unknown[]) => ({ __op: "inArray", args })),
  count: vi.fn((a: unknown) => ({ __op: "count", a })),
  desc: vi.fn((a: unknown) => ({ __op: "desc", a })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => ({ __sql: strings.join("?") }),
    {},
  ),
}));

vi.mock("../middleware/auth", () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../services/notifications", () => ({ emitSyncFailureNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../services/reconciliation", () => ({ runReconciliation: vi.fn() }));
vi.mock("../services/integrations/google-ads", () => ({
  fetchCampaignPerformance: vi.fn(), formatCampaignRow: vi.fn(),
}));
vi.mock("../services/integrations/podium", () => ({ syncPodiumReviews: vi.fn() }));
vi.mock("../services/integrations/meta", async () => {
  const actual = await vi.importActual<typeof import("../services/integrations/meta")>(
    "../services/integrations/meta",
  );
  class MockMetaAPIService {
    fetchAdDailyInsights() { return Promise.resolve([]); }
    fetchAdSets() { return Promise.resolve([]); }
    fetchAds() { return Promise.resolve([]); }
    listAdAccounts() { return Promise.resolve([]); }
    verifyToken() { return Promise.resolve({}); }
  }
  return { ...actual, MetaAPIService: MockMetaAPIService };
});

// Mock the ServiceTitan service module — expose configurable spies.
const stMocks = vi.hoisted(() => ({
  fetchCompletedJobs: vi.fn(),
  formatSTJobForSync: vi.fn(),
}));

vi.mock("../services/integrations/service-titan", () => ({
  fetchCompletedJobs: stMocks.fetchCompletedJobs,
  formatSTJobForSync: stMocks.formatSTJobForSync,
  fetchCustomerContactsById: vi.fn(),
  fetchLocationsByIds: vi.fn(),
  formatLocationAddress: vi.fn(),
  fetchInvoices: vi.fn(),
  parseInvoiceData: vi.fn(),
  fetchSoldEstimates: vi.fn(),
  parseEstimateData: vi.fn(),
  resolveEmployeeName: vi.fn(),
  clearEmployeeCache: vi.fn(),
}));

// ─── Test app + helpers ──────────────────────────────────────────────────────

let app: express.Express;

async function setupApp() {
  vi.resetModules();
  const mod = await import("./integrations");
  app = express();
  app.use(express.json());
  app.use(mod.default);
}

interface Resp { status: number; body: Record<string, unknown> }

function postJson(path: string, body: Record<string, unknown> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1", port, path, method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            server.close();
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, unknown> = {};
            try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  });
}

function tenantWithST(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    name: "Acme",
    stSyncPaused: false,
    serviceTitanId: "st-tenant-9",
    apiConfig: encryptConfig({
      serviceTitanClientId: "cid",
      serviceTitanClientSecret: "csec",
      serviceTitanAppKey: "appkey",
      serviceTitanTenantId: "st-tenant-9",
    }),
    ...overrides,
  };
}

beforeEach(async () => {
  state.reset();
  stMocks.fetchCompletedJobs.mockReset();
  stMocks.formatSTJobForSync.mockReset();
  state.insertReturning.set("integration_sync_logs", [{ id: 1 }]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await setupApp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /integrations/service_titan/backfill — days validation", () => {
  it("rejects days <= 30 with 400 (15-min scheduler already covers recent jobs)", async () => {
    const res = await postJson("/integrations/service_titan/backfill", { tenantId: 7, days: 30 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/days must be a number > 30/);
    expect(state.insertCalls.find((c) => c.table === "integration_sync_logs")).toBeUndefined();
    expect(stMocks.fetchCompletedJobs).not.toHaveBeenCalled();
  });

  it("rejects days > 1095 with 400 (ST backfill capped at ~3 years)", async () => {
    const res = await postJson("/integrations/service_titan/backfill", { tenantId: 7, days: 1096 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/cannot exceed 1095/);
    expect(state.insertCalls.find((c) => c.table === "integration_sync_logs")).toBeUndefined();
    expect(stMocks.fetchCompletedJobs).not.toHaveBeenCalled();
  });

  it("rejects missing tenantId with 400", async () => {
    const res = await postJson("/integrations/service_titan/backfill", { days: 60 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/tenantId required/);
  });
});

describe("POST /integrations/service_titan/backfill — early exits", () => {
  it("returns 404 when the tenant doesn't exist (no sync log opened)", async () => {
    state.selectQueue.push([]);
    const res = await postJson("/integrations/service_titan/backfill", { tenantId: 999, days: 60 });
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toMatch(/tenant not found/i);
    expect(state.insertCalls.find((c) => c.table === "integration_sync_logs")).toBeUndefined();
    expect(stMocks.fetchCompletedJobs).not.toHaveBeenCalled();
  });

  it("returns 400 when ST credentials are missing and finalizes the backfill log as error", async () => {
    state.selectQueue.push([{ id: 7, apiConfig: null, stSyncPaused: false }]);
    const res = await postJson("/integrations/service_titan/backfill", { tenantId: 7, days: 60 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/servicetitan not configured/i);
    expect(stMocks.fetchCompletedJobs).not.toHaveBeenCalled();

    const opened = state.insertCalls.find((c) => c.table === "integration_sync_logs");
    expect(opened).toBeDefined();
    const row = opened!.values[0] as Record<string, unknown>;
    expect(row.integration).toBe("service_titan");
    expect(row.syncType).toBe("backfill");
    expect(row.status).toBe("running");

    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
    expect(String(errLog!.set.errorMessage)).toMatch(/servicetitan not configured/i);
  });

  it("returns 400 when ST sync is paused for the tenant", async () => {
    state.selectQueue.push([tenantWithST({ stSyncPaused: true })]);
    const res = await postJson("/integrations/service_titan/backfill", { tenantId: 7, days: 60 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/paused/i);
    expect(stMocks.fetchCompletedJobs).not.toHaveBeenCalled();

    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
    expect(String(errLog!.set.errorMessage)).toMatch(/paused/i);
  });
});

describe("POST /integrations/service_titan/backfill — successful run", () => {
  it("inserts jobs rows and writes a 'completed' backfill sync log", async () => {
    // Order of db.select() calls inside backfillServiceTitanJobs:
    //   1. tenants
    //   inside processJobBatch (1 job):
    //     2. jobs lookup by stJobIdHash → not found
    //     3. jobs lookup by raw stJobId → not found
    //   inside matchJobsToLeads (totalSynced > 0 triggers it):
    //     4. unmatched jobs → empty (early return)
    state.selectQueue.push([tenantWithST()]);
    state.selectQueue.push([]); // jobs by hash
    state.selectQueue.push([]); // jobs by raw id
    state.selectQueue.push([]); // matchJobsToLeads unmatched

    // Per-tenant advisory lock acquired (shared with the 15-min sync).
    state.executeQueue.push({ rows: [{ got: true }] });

    stMocks.formatSTJobForSync.mockReturnValue({
      stJobId: "st-job-1",
      revenue: "999.99",
      status: "Completed",
      completedAt: new Date("2026-04-15"),
      customerName: "Jane Doe",
      customerPhone: "555-1234",
      customerEmail: "jane@example.com",
      serviceAddress: "1 Main St",
      stCustomerId: "cust-1",
      stLocationId: "loc-1",
      jobTypeName: "Repair",
      businessUnit: "BU1",
    });

    // 31-day window → 1 chunk (90-day chunks).
    stMocks.fetchCompletedJobs.mockImplementation(
      async (_cfg: unknown, _since: unknown, processBatch: (jobs: unknown[]) => Promise<void>) => {
        await processBatch([{ id: "st-job-1" }]);
      },
    );

    const res = await postJson("/integrations/service_titan/backfill", { tenantId: 7, days: 31 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.synced).toBe(1);
    expect(res.body.chunks).toBe(1);

    expect(stMocks.fetchCompletedJobs).toHaveBeenCalledTimes(1);
    // Confirm the chunk window args (since, before) were ISO timestamps.
    const callArgs = stMocks.fetchCompletedJobs.mock.calls[0];
    expect(typeof callArgs[1]).toBe("string");
    expect(typeof callArgs[3]).toBe("string");
    expect(callArgs[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(callArgs[3]).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A jobs row was inserted with the formatted ST job id.
    const jobIns = state.insertCalls.find((c) => c.table === "jobs");
    expect(jobIns).toBeDefined();
    const jobRow = jobIns!.values[0] as Record<string, unknown>;
    expect(jobRow.tenantId).toBe(7);
    expect(jobRow.stJobId).toBe("st-job-1");
    // The hash column is populated alongside the raw id.
    expect(typeof jobRow.stJobIdHash).toBe("string");
    expect((jobRow.stJobIdHash as string).length).toBe(64);

    // The sync log was opened with sync_type='backfill' and finalized as completed.
    const opened = state.insertCalls.find((c) => c.table === "integration_sync_logs");
    expect(opened).toBeDefined();
    const openedRow = opened!.values[0] as Record<string, unknown>;
    expect(openedRow.integration).toBe("service_titan");
    expect(openedRow.syncType).toBe("backfill");
    expect(openedRow.status).toBe("running");

    const completed = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "completed",
    );
    expect(completed).toBeDefined();
    expect(completed!.set.recordsProcessed).toBe(1);
    expect(completed!.set.errorMessage).toBeNull();
  });
});

describe("POST /integrations/service_titan/backfill — partial failure mid-chunk", () => {
  it("writes a 'partial: …' progress message and finalizes the backfill log as error when a later chunk throws", async () => {
    // 91-day window → 2 chunks. Chunk 1 inserts one job, chunk 2 throws.
    state.selectQueue.push([tenantWithST()]);
    state.selectQueue.push([]); // jobs by hash (chunk 1)
    state.selectQueue.push([]); // jobs by raw id (chunk 1)

    state.executeQueue.push({ rows: [{ got: true }] });

    stMocks.formatSTJobForSync.mockReturnValue({
      stJobId: "st-job-1",
      revenue: "10",
      status: "Completed",
      completedAt: new Date("2026-04-15"),
      customerName: "Jane",
      customerPhone: null,
      customerEmail: null,
      serviceAddress: null,
      stCustomerId: null,
      stLocationId: null,
      jobTypeName: null,
      businessUnit: null,
    });

    stMocks.fetchCompletedJobs.mockImplementationOnce(
      async (_cfg: unknown, _since: unknown, processBatch: (jobs: unknown[]) => Promise<void>) => {
        await processBatch([{ id: "st-job-1" }]);
      },
    );
    stMocks.fetchCompletedJobs.mockRejectedValueOnce(
      new Error("ServiceTitan API 500"),
    );

    const res = await postJson("/integrations/service_titan/backfill", { tenantId: 7, days: 91 });

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/servicetitan api 500/i);

    // Inner catch recorded the partial-failure with the running count.
    // Task #395: stored as structured columns (`partial: true`,
    // `errorCode: …`) instead of a `partial: <msg>` string in errorMessage.
    const partialUpdate = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs"
        && u.set.partial === true,
    );
    expect(partialUpdate).toBeDefined();
    expect(String(partialUpdate!.set.errorMessage)).toMatch(/servicetitan api 500/i);
    expect(partialUpdate!.set.errorCode).toBe("upstream_server_error");
    expect(partialUpdate!.set.recordsProcessed).toBe(1);

    // Outer catch finalized the log as 'error'.
    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
    expect(String(errLog!.set.errorMessage)).toMatch(/servicetitan api 500/i);

    expect(stMocks.fetchCompletedJobs).toHaveBeenCalledTimes(2);
  });
});
