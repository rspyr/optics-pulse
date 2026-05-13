import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

// ─── Db mock state ───────────────────────────────────────────────────────────
//
// The /integrations/sync-status route fans out several db.select() calls in
// Promise.all. We feed each one from a FIFO `selectQueue`: every terminal
// .limit() / .where() (when no limit is chained) shifts the next array off the
// queue. Tests must enqueue rows in the exact order the route awaits them.

const state = {
  selectQueue: [] as unknown[][],
  reset() {
    this.selectQueue = [];
  },
};

vi.mock("@workspace/db", () => {
  const tables = {
    integrationSyncLogsTable: {
      __name: "integration_sync_logs",
      id: "isl.id",
      tenantId: "isl.tenantId",
      integration: "isl.integration",
      syncType: "isl.syncType",
      status: "isl.status",
      createdAt: "isl.createdAt",
    },
    tenantsTable: { __name: "tenants", id: "tenants.id" },
    jobsTable: { __name: "jobs", tenantId: "jobs.tenantId", matchLevel: "jobs.matchLevel" },
  };

  function makeSelectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const resolveResult = () => {
      const next = state.selectQueue.length ? state.selectQueue.shift() : [];
      return Promise.resolve(next);
    };
    const terminal = {
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(resolveResult),
        then: (r: Function) => resolveResult().then(r as (v: unknown) => unknown),
      }),
      limit: vi.fn().mockImplementation(resolveResult),
      then: (r: Function) => resolveResult().then(r as (v: unknown) => unknown),
    };
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(terminal);
    chain.orderBy = terminal.orderBy;
    chain.limit = terminal.limit;
    chain.then = terminal.then;
    return chain;
  }

  const db = {
    select: vi.fn().mockImplementation(() => makeSelectChain()),
  };

  return { db, ...tables };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  desc: vi.fn((a: unknown) => ({ __op: "desc", a })),
  notInArray: vi.fn((...args: unknown[]) => ({ __op: "notInArray", args })),
  inArray: vi.fn((...args: unknown[]) => ({ __op: "inArray", args })),
  isNotNull: vi.fn((a: unknown) => ({ __op: "isNotNull", a })),
  isNull: vi.fn((a: unknown) => ({ __op: "isNull", a })),
  count: vi.fn((a: unknown) => ({ __op: "count", a })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => ({ __sql: strings.join("?") }),
    {},
  ),
}));

vi.mock("../middleware/auth", () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../services/sync-scheduler", () => ({
  syncGoogleAdsCampaigns: vi.fn(),
  syncMetaCampaigns: vi.fn(),
}));

vi.mock("../lib/encryption", () => ({
  decryptConfig: vi.fn().mockReturnValue({}),
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

function getJson(path: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET" },
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
      req.end();
    });
  });
}

beforeEach(async () => {
  state.reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await setupApp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Build a minimal sync-log row matching the columns the route reads.
interface SyncLogRow {
  id: number;
  tenantId: number | null;
  integration: string;
  syncType: string;
  status: string;
  recordsProcessed: number;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
}

function log(overrides: Partial<SyncLogRow>): SyncLogRow {
  return {
    id: 1,
    tenantId: null,
    integration: "meta",
    syncType: "backfill",
    status: "completed",
    recordsProcessed: 0,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

// Enqueue the four select results the route awaits in Promise.all, in order:
//   1. dataSyncLogs    (.limit(60))
//   2. purgeLogs       (.limit(1))
//   3. runningLogs     (.limit(10))
//   4. outboundLogs    (.limit(30))
//   5. pendingCounts   (.where() thenable, no limit)
// When the route is called WITHOUT tenantId, no tenants lookup happens.
function queueSyncStatusSelects(opts: {
  dataSyncLogs?: SyncLogRow[];
  purgeLogs?: SyncLogRow[];
  runningLogs?: SyncLogRow[];
  outboundLogs?: SyncLogRow[];
  pendingCounts?: Array<{ ociPending: number; enhancedPending: number; capiPending: number }>;
}) {
  state.selectQueue.push(opts.dataSyncLogs ?? []);
  state.selectQueue.push(opts.purgeLogs ?? []);
  state.selectQueue.push(opts.runningLogs ?? []);
  state.selectQueue.push(opts.outboundLogs ?? []);
  state.selectQueue.push(opts.pendingCounts ?? [{ ociPending: 0, enhancedPending: 0, capiPending: 0 }]);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /integrations/sync-status — backfillStatus map", () => {
  it("emits a per-integration backfillStatus entry for every integration that has a sync_type='backfill' row", async () => {
    const startedAt = new Date("2026-05-10T12:00:00Z");
    const completedAt = new Date("2026-05-10T12:30:00Z");
    queueSyncStatusSelects({
      dataSyncLogs: [
        log({
          id: 11, integration: "service_titan", syncType: "backfill",
          status: "completed", recordsProcessed: 42, errorMessage: null,
          startedAt, completedAt,
        }),
        log({
          id: 12, integration: "google_ads", syncType: "backfill",
          status: "completed", recordsProcessed: 7, errorMessage: null,
          startedAt, completedAt,
        }),
        log({
          id: 13, integration: "meta", syncType: "backfill",
          status: "completed", recordsProcessed: 99, errorMessage: null,
          startedAt, completedAt,
        }),
      ],
    });

    const res = await getJson("/integrations/sync-status");
    expect(res.status).toBe(200);

    const backfillStatus = res.body.backfillStatus as Record<string, Record<string, unknown>>;
    expect(Object.keys(backfillStatus).sort()).toEqual(["google_ads", "meta", "service_titan"]);

    expect(backfillStatus.service_titan.status).toBe("completed");
    expect(backfillStatus.service_titan.recordsProcessed).toBe(42);
    expect(backfillStatus.service_titan.startedAt).toBe(startedAt.toISOString());
    expect(backfillStatus.service_titan.completedAt).toBe(completedAt.toISOString());

    expect(backfillStatus.google_ads.recordsProcessed).toBe(7);
    expect(backfillStatus.meta.recordsProcessed).toBe(99);
  });

  it("omits integrations that have NO backfill row (other syncTypes don't synthesize one)", async () => {
    queueSyncStatusSelects({
      dataSyncLogs: [
        // Daily sync only — must not produce a backfillStatus entry.
        log({
          id: 1, integration: "google_ads", syncType: "daily",
          status: "completed", recordsProcessed: 5,
        }),
        // Only meta has a real backfill row.
        log({
          id: 2, integration: "meta", syncType: "backfill",
          status: "completed", recordsProcessed: 11,
        }),
      ],
    });

    const res = await getJson("/integrations/sync-status");
    expect(res.status).toBe(200);

    const backfillStatus = res.body.backfillStatus as Record<string, unknown>;
    expect(Object.keys(backfillStatus)).toEqual(["meta"]);
    expect(backfillStatus.google_ads).toBeUndefined();
    expect(backfillStatus.service_titan).toBeUndefined();
  });

  it("surfaces the running-progress string from errorMessage on an in-flight backfill", async () => {
    const startedAt = new Date("2026-05-12T09:00:00Z");
    queueSyncStatusSelects({
      dataSyncLogs: [
        log({
          id: 21, integration: "service_titan", syncType: "backfill",
          status: "running", recordsProcessed: 1234,
          // The backfill writer stashes a human-readable progress string in
          // errorMessage while the run is still in flight; the route must
          // surface it as `progress` (not as an actual error).
          errorMessage: "chunk 3/10 — 30%",
          startedAt, completedAt: null,
        }),
      ],
      runningLogs: [
        log({
          id: 21, integration: "service_titan", syncType: "backfill",
          status: "running", recordsProcessed: 1234,
          errorMessage: "chunk 3/10 — 30%",
          startedAt, completedAt: null,
        }),
      ],
    });

    const res = await getJson("/integrations/sync-status");
    expect(res.status).toBe(200);

    const backfillStatus = res.body.backfillStatus as Record<string, Record<string, unknown>>;
    expect(backfillStatus.service_titan).toBeDefined();
    expect(backfillStatus.service_titan.status).toBe("running");
    expect(backfillStatus.service_titan.progress).toBe("chunk 3/10 — 30%");
    expect(backfillStatus.service_titan.startedAt).toBe(startedAt.toISOString());
    expect(backfillStatus.service_titan.completedAt).toBeNull();
    expect(backfillStatus.service_titan.recordsProcessed).toBe(1234);
  });

  it("metaBackfillStatus back-compat alias equals backfillStatus.meta when meta has a backfill row", async () => {
    const startedAt = new Date("2026-05-11T10:00:00Z");
    const completedAt = new Date("2026-05-11T10:45:00Z");
    queueSyncStatusSelects({
      dataSyncLogs: [
        log({
          id: 31, integration: "meta", syncType: "backfill",
          status: "completed", recordsProcessed: 250,
          errorMessage: null, startedAt, completedAt,
        }),
        log({
          id: 32, integration: "google_ads", syncType: "backfill",
          status: "completed", recordsProcessed: 7,
          startedAt, completedAt,
        }),
      ],
    });

    const res = await getJson("/integrations/sync-status");
    expect(res.status).toBe(200);

    const backfillStatus = res.body.backfillStatus as Record<string, unknown>;
    expect(res.body.metaBackfillStatus).toEqual(backfillStatus.meta);
    // And specifically NOT equal to a sibling's entry — guards against a
    // future refactor accidentally aliasing the wrong integration.
    expect(res.body.metaBackfillStatus).not.toEqual(backfillStatus.google_ads);
  });

  it("metaBackfillStatus back-compat alias is null when meta has no backfill row", async () => {
    queueSyncStatusSelects({
      dataSyncLogs: [
        log({
          id: 41, integration: "service_titan", syncType: "backfill",
          status: "completed", recordsProcessed: 3,
        }),
      ],
    });

    const res = await getJson("/integrations/sync-status");
    expect(res.status).toBe(200);

    const backfillStatus = res.body.backfillStatus as Record<string, unknown>;
    expect(backfillStatus.meta).toBeUndefined();
    expect(res.body.metaBackfillStatus).toBeNull();
  });
});
