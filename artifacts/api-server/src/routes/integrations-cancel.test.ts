import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

// ─── Db mock state ───────────────────────────────────────────────────────────
//
// The cancel route does exactly two db touches:
//   1. db.select().from().where(eq()).limit(1)  → load the target sync log
//   2. (force only) db.update().set({...}).where(eq())  → hard-flip to cancelled
//      (non-force) db.update().set({cancelRequested:true}).where(eq())
//
// We feed the select from `state.selectRow` and record every update's .set()
// payload into `state.updates` so a test can assert the exact column writes.

const state = {
  selectRow: [] as unknown[],
  updates: [] as Record<string, unknown>[],
  reset() {
    this.selectRow = [];
    this.updates = [];
  },
};

vi.mock("@workspace/db", () => {
  const tables = {
    integrationSyncLogsTable: {
      __name: "integration_sync_logs",
      id: "isl.id",
      status: "isl.status",
      cancelRequested: "isl.cancelRequested",
    },
    tenantsTable: { __name: "tenants", id: "tenants.id" },
    jobsTable: { __name: "jobs" },
  };

  function makeSelectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockImplementation(() => Promise.resolve(state.selectRow));
    return chain;
  }

  function makeUpdateChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn().mockImplementation((vals: Record<string, unknown>) => {
      state.updates.push(vals);
      return chain;
    });
    chain.where = vi.fn().mockImplementation(() => Promise.resolve(undefined));
    return chain;
  }

  const db = {
    select: vi.fn().mockImplementation(() => makeSelectChain()),
    update: vi.fn().mockImplementation(() => makeUpdateChain()),
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

vi.mock("../services/sync-scheduler", () => ({
  backfillGoogleAdsCampaigns: vi.fn(),
  backfillServiceTitanJobs: vi.fn(),
  syncServiceTitanEstimates: vi.fn(),
  syncServiceTitanInvoices: vi.fn(),
  syncGoogleAdsCampaigns: vi.fn(),
  syncMetaCampaigns: vi.fn(),
}));

vi.mock("../lib/encryption", () => ({
  decryptConfig: vi.fn().mockReturnValue({}),
}));

vi.mock("../middleware/auth", () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
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

function post(path: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "POST" },
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

function runningLog(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    status: "running",
    cancelRequested: false,
    ...overrides,
  };
}

describe("POST /integrations/sync-logs/:id/cancel — force escape hatch", () => {
  it("force=true hard-flips a running sync log to cancelled with the operator error message", async () => {
    state.selectRow = [runningLog()];

    const res = await post("/integrations/sync-logs/77/cancel?force=true");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, logId: 77, forced: true });

    // Exactly one update — the hard-flip — and it sets the terminal state
    // directly rather than just raising the cooperative cancel flag.
    expect(state.updates).toHaveLength(1);
    const wrote = state.updates[0];
    expect(wrote.status).toBe("cancelled");
    expect(wrote.errorMessage).toBe("Force-cancelled by operator");
    expect(wrote.completedAt).toBeInstanceOf(Date);
    // Force path does NOT go through the cooperative flag.
    expect(wrote.cancelRequested).toBeUndefined();
    // Progress columns are cleared so the UI doesn't render stale chunk state.
    expect(wrote.progressCurrentChunk).toBeNull();
    expect(wrote.progressTotalChunks).toBeNull();
  });

  it("without force, only raises the cooperative cancel flag (no hard-flip)", async () => {
    state.selectRow = [runningLog()];

    const res = await post("/integrations/sync-logs/77/cancel");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, logId: 77, forced: false });

    expect(state.updates).toHaveLength(1);
    const wrote = state.updates[0];
    expect(wrote.cancelRequested).toBe(true);
    // Cooperative path must NOT terminate the row itself.
    expect(wrote.status).toBeUndefined();
    expect(wrote.completedAt).toBeUndefined();
  });

  it("returns 409 (and writes nothing) when the run already finished, even with force", async () => {
    state.selectRow = [runningLog({ status: "completed" })];

    const res = await post("/integrations/sync-logs/77/cancel?force=true");

    expect(res.status).toBe(409);
    expect(state.updates).toHaveLength(0);
  });

  it("returns 404 (and writes nothing) when the sync log does not exist", async () => {
    state.selectRow = [];

    const res = await post("/integrations/sync-logs/999/cancel?force=true");

    expect(res.status).toBe(404);
    expect(state.updates).toHaveLength(0);
  });

  it("rejects an invalid sync log id with 400 before touching the db", async () => {
    const res = await post("/integrations/sync-logs/abc/cancel?force=true");

    expect(res.status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });
});
