import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

interface UpdateCall {
  table: string;
  set: Record<string, unknown>;
  whereArg: unknown;
}

interface SelectCall {
  fromTable?: string;
  whereArg?: unknown;
  selection?: unknown;
  distinct: boolean;
  groupByArgs?: unknown[];
  orderByArgs?: unknown[];
  limit?: unknown;
  offset?: unknown;
}

const state = {
  selectQueue: [] as unknown[][],
  selectCalls: [] as SelectCall[],
  updateCalls: [] as UpdateCall[],
  updateReturning: new Map<string, unknown[]>(),
  reset() {
    this.selectQueue = [];
    this.selectCalls = [];
    this.updateCalls = [];
    this.updateReturning.clear();
  },
};

function tableName(t: unknown): string {
  return (t as { __name?: string })?.__name || "unknown";
}

vi.mock("@workspace/db", () => {
  const tables = {
    backgroundJobsTable: {
      __name: "background_jobs",
      id: "bj.id",
      tenantId: "bj.tenantId",
      type: "bj.type",
      status: "bj.status",
      createdAt: "bj.createdAt",
      completedAt: "bj.completedAt",
      updatedAt: "bj.updatedAt",
      payload: "bj.payload",
      result: "bj.result",
    },
    tenantsTable: {
      __name: "tenants",
      id: "tenants.id",
      name: "tenants.name",
    },
  };

  function makeSelectChain(call: SelectCall): Record<string, unknown> {
    const resolveResult = () => {
      const next = state.selectQueue.length ? state.selectQueue.shift() : [];
      return Promise.resolve(next);
    };
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn().mockImplementation((t: unknown) => {
      call.fromTable = tableName(t);
      return chain;
    });
    chain.leftJoin = vi.fn().mockImplementation(() => chain);
    chain.where = vi.fn().mockImplementation((w: unknown) => {
      call.whereArg = w;
      return chain;
    });
    chain.orderBy = vi.fn().mockImplementation((...args: unknown[]) => {
      call.orderByArgs = args;
      return chain;
    });
    chain.groupBy = vi.fn().mockImplementation((...args: unknown[]) => {
      call.groupByArgs = args;
      return chain;
    });
    chain.limit = vi.fn().mockImplementation((n: unknown) => {
      call.limit = n;
      return chain;
    });
    chain.offset = vi.fn().mockImplementation((n: unknown) => {
      call.offset = n;
      return chain;
    });
    chain.then = (r: Function) => resolveResult().then(r as (v: unknown) => unknown);
    return chain;
  }

  const db = {
    select: vi.fn().mockImplementation((selection?: unknown) => {
      const call: SelectCall = { selection, distinct: false };
      state.selectCalls.push(call);
      return makeSelectChain(call);
    }),
    selectDistinct: vi.fn().mockImplementation((selection?: unknown) => {
      const call: SelectCall = { selection, distinct: true };
      state.selectCalls.push(call);
      return makeSelectChain(call);
    }),
    update: vi.fn().mockImplementation((table: unknown) => {
      const name = tableName(table);
      return {
        set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          return {
            where: vi.fn().mockImplementation((whereArg: unknown) => {
              const call: UpdateCall = { table: name, set: vals, whereArg };
              state.updateCalls.push(call);
              const rows = state.updateReturning.get(name) || [];
              return {
                returning: vi.fn().mockResolvedValue(rows),
                then: (r: Function) =>
                  Promise.resolve(undefined).then(r as (v: unknown) => unknown),
              };
            }),
          };
        }),
      };
    }),
  };

  return { db, ...tables };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  desc: vi.fn((a: unknown) => ({ __op: "desc", a })),
  count: vi.fn(() => ({ __op: "count" })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ __op: "inArray", col, vals })),
  isNull: vi.fn((col: unknown) => ({ __op: "isNull", col })),
}));

const cleanupSpy = vi.fn<(retentionDays: number) => Promise<number>>();
vi.mock("../services/re-derive-jobs", () => ({
  REDERIVE_SELECTED_LEADS: "rederive_selected_leads",
  cleanupOldCancelledSelectedLeadsRederives: (n: number) => cleanupSpy(n),
}));

// ─── Test app + helpers ──────────────────────────────────────────────────────

let app: express.Express;
let currentSession: { userId?: number; userRole?: string } = {};

async function setupApp() {
  vi.resetModules();
  const mod = await import("./admin-background-jobs");
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Mirror express-session's req.session shape used by requireRole.
    (req as unknown as { session: typeof currentSession }).session = {
      ...currentSession,
    };
    next();
  });
  app.use(mod.default);
}

interface Resp {
  status: number;
  body: Record<string, unknown>;
}

function request(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body !== undefined ? JSON.stringify(body) : "";
      const headers: Record<string, string | number> = {};
      if (payload) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(payload);
      }
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            server.close();
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, unknown> = {};
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch {
              parsed = { raw: text };
            }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const asAgency = { userId: 1, userRole: "agency_user" };
const asSuperAdmin = { userId: 2, userRole: "super_admin" };
const asClientAdmin = { userId: 3, userRole: "client_admin" };
const asClientUser = { userId: 4, userRole: "client_user" };

beforeEach(async () => {
  state.reset();
  cleanupSpy.mockReset();
  currentSession = { ...asAgency };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await setupApp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── GET /admin/background-jobs ──────────────────────────────────────────────

function queueListResponses(opts: {
  rows: unknown[];
  total: number;
  types: string[];
  statusCounts: Array<{ status: string; count: number }>;
}) {
  // Order in route:
  //   1. rows                  (db.select().from().where().orderBy().limit().offset())
  //   2. [{count: total}]      (db.select({count}).from().where())
  //   3. typeRows              (db.selectDistinct({type}).from())
  //   4. statusRows            (db.select({status, count}).from().groupBy())
  state.selectQueue.push(opts.rows);
  state.selectQueue.push([{ count: opts.total }]);
  state.selectQueue.push(opts.types.map((t) => ({ type: t })));
  state.selectQueue.push(opts.statusCounts);
}

describe("GET /admin/background-jobs — role enforcement", () => {
  it("rejects client_admin callers with 403", async () => {
    currentSession = { ...asClientAdmin };
    const res = await request("GET", "/admin/background-jobs");
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/Insufficient permissions/);
  });

  it("rejects client_user callers with 403", async () => {
    currentSession = { ...asClientUser };
    const res = await request("GET", "/admin/background-jobs");
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    currentSession = {};
    const res = await request("GET", "/admin/background-jobs");
    expect(res.status).toBe(401);
  });

  it("allows super_admin", async () => {
    currentSession = { ...asSuperAdmin };
    queueListResponses({ rows: [], total: 0, types: [], statusCounts: [] });
    const res = await request("GET", "/admin/background-jobs");
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/background-jobs — list shape, filters & pagination", () => {
  it("returns jobs, total, default pagination, sorted types, and statusCounts map", async () => {
    const jobs = [
      { id: 1, type: "sync.meta", status: "completed" },
      { id: 2, type: "sync.google", status: "failed" },
    ];
    queueListResponses({
      rows: jobs,
      total: 42,
      // Intentionally unsorted; route should sort.
      types: ["sync.meta", "sync.google", "rederive"],
      statusCounts: [
        { status: "pending", count: 3 },
        { status: "completed", count: 30 },
        { status: "failed", count: 9 },
      ],
    });

    const res = await request("GET", "/admin/background-jobs");
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual(jobs);
    expect(res.body.total).toBe(42);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    expect(res.body.types).toEqual(["rederive", "sync.google", "sync.meta"]);
    expect(res.body.statusCounts).toEqual({
      pending: 3,
      completed: 30,
      failed: 9,
    });
  });

  it("clamps limit to the [1, 500] window and parses offset", async () => {
    queueListResponses({ rows: [], total: 0, types: [], statusCounts: [] });
    const res = await request(
      "GET",
      "/admin/background-jobs?limit=9999&offset=25",
    );
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
    expect(res.body.offset).toBe(25);
  });

  it("clamps limit to 1 when caller passes 0 or negative values", async () => {
    queueListResponses({ rows: [], total: 0, types: [], statusCounts: [] });
    const res = await request("GET", "/admin/background-jobs?limit=-5");
    expect(res.status).toBe(200);
    // parseInt("-5") → -5, max(_, 1) → 1.
    expect(res.body.limit).toBe(1);
  });

  it("rejects unknown status filter with 400 before hitting the db", async () => {
    const res = await request(
      "GET",
      "/admin/background-jobs?status=bogus",
    );
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/status must be one of/);
    // No selects should have been issued — assert the mock directly rather
    // than relying on the queue, which can stay empty either way.
    expect(state.selectCalls.length).toBe(0);
  });

  it("applies the status filter to the where clause when one is provided", async () => {
    queueListResponses({ rows: [], total: 0, types: [], statusCounts: [] });
    const res = await request(
      "GET",
      "/admin/background-jobs?status=failed",
    );
    expect(res.status).toBe(200);

    // Route emits `where(and(eq(status, "failed")))` against the rows
    // select and the count select; the type-distinct + groupBy selects
    // are unfiltered.
    const filteredSelects = state.selectCalls.filter((c) => c.whereArg !== undefined);
    expect(filteredSelects.length).toBe(2);
    for (const sel of filteredSelects) {
      const where = sel.whereArg as { __op: string; args: unknown[] };
      expect(where.__op).toBe("and");
      const conditions = where.args as Array<{ __op: string; args: unknown[] }>;
      expect(conditions.some((c) => c.__op === "eq" && c.args.includes("failed"))).toBe(true);
    }
  });

  it("applies the type filter to the where clause when one is provided", async () => {
    queueListResponses({ rows: [], total: 0, types: [], statusCounts: [] });
    const res = await request(
      "GET",
      "/admin/background-jobs?type=sync.meta",
    );
    expect(res.status).toBe(200);

    const filteredSelects = state.selectCalls.filter((c) => c.whereArg !== undefined);
    expect(filteredSelects.length).toBe(2);
    for (const sel of filteredSelects) {
      const where = sel.whereArg as { __op: string; args: unknown[] };
      expect(where.__op).toBe("and");
      const conditions = where.args as Array<{ __op: string; args: unknown[] }>;
      expect(conditions.some((c) => c.__op === "eq" && c.args.includes("sync.meta"))).toBe(true);
    }
  });

  it("combines status and type filters in a single and(...) clause", async () => {
    queueListResponses({ rows: [], total: 0, types: [], statusCounts: [] });
    const res = await request(
      "GET",
      "/admin/background-jobs?status=pending&type=rederive",
    );
    expect(res.status).toBe(200);

    const filtered = state.selectCalls.filter((c) => c.whereArg !== undefined);
    expect(filtered.length).toBe(2);
    for (const sel of filtered) {
      const where = sel.whereArg as { __op: string; args: unknown[] };
      const conditions = where.args as Array<{ __op: string; args: unknown[] }>;
      expect(conditions).toHaveLength(2);
      const literals = conditions.flatMap((c) => c.args);
      expect(literals).toContain("pending");
      expect(literals).toContain("rederive");
    }
  });

  it("issues no where clause when no filters are provided", async () => {
    queueListResponses({ rows: [], total: 0, types: [], statusCounts: [] });
    const res = await request("GET", "/admin/background-jobs");
    expect(res.status).toBe(200);
    // None of the four selects should carry a where condition.
    expect(state.selectCalls.every((c) => c.whereArg === undefined)).toBe(true);
  });

  it("accepts each known status value", async () => {
    for (const status of ["pending", "in_progress", "completed", "failed"]) {
      state.reset();
      queueListResponses({ rows: [], total: 0, types: [], statusCounts: [] });
      const res = await request(
        "GET",
        `/admin/background-jobs?status=${status}`,
      );
      expect(res.status).toBe(200);
    }
  });

  it("accepts a free-form type filter without validating it", async () => {
    queueListResponses({ rows: [], total: 0, types: [], statusCounts: [] });
    const res = await request(
      "GET",
      "/admin/background-jobs?type=sync.meta",
    );
    expect(res.status).toBe(200);
  });
});

// ─── POST /admin/background-jobs/:id/retry ───────────────────────────────────

describe("POST /admin/background-jobs/:id/retry — role enforcement", () => {
  it("rejects client_admin with 403", async () => {
    currentSession = { ...asClientAdmin };
    const res = await request("POST", "/admin/background-jobs/1/retry", {});
    expect(res.status).toBe(403);
  });

  it("rejects client_user with 403", async () => {
    currentSession = { ...asClientUser };
    const res = await request("POST", "/admin/background-jobs/1/retry", {});
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    currentSession = {};
    const res = await request("POST", "/admin/background-jobs/1/retry", {});
    expect(res.status).toBe(401);
  });

  it("allows super_admin", async () => {
    currentSession = { ...asSuperAdmin };
    state.selectQueue.push([
      { id: 1, status: "failed", attempts: 1, lastError: "boom", completedAt: new Date() },
    ]);
    state.updateReturning.set("background_jobs", [{ id: 1, status: "pending" }]);
    const res = await request("POST", "/admin/background-jobs/1/retry", {});
    expect(res.status).toBe(200);
  });
});

describe("POST /admin/background-jobs/:id/retry — input validation", () => {
  it("rejects non-integer ids with 400", async () => {
    const res = await request("POST", "/admin/background-jobs/abc/retry", {});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Invalid job id/);
    // No db work attempted.
    expect(state.updateCalls.length).toBe(0);
  });

  it("rejects zero or negative ids with 400", async () => {
    const res = await request("POST", "/admin/background-jobs/0/retry", {});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Invalid job id/);
  });

  it("returns 404 when the job does not exist", async () => {
    state.selectQueue.push([]); // existing lookup → empty
    const res = await request("POST", "/admin/background-jobs/99/retry", {});
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toMatch(/Job not found/);
    // The atomic conditional update is issued but no-ops: its WHERE predicate
    // includes status='failed', so a non-existent row matches nothing and the
    // returning() is empty, falling through to the 404 lookup.
    expect(state.updateCalls.length).toBe(1);
  });
});

describe("POST /admin/background-jobs/:id/retry — status guard", () => {
  it.each(["pending", "in_progress", "completed"])(
    "returns 409 when the job is %s",
    async (status) => {
      state.selectQueue.push([
        { id: 7, status, lastError: null, completedAt: null },
      ]);
      const res = await request("POST", "/admin/background-jobs/7/retry", {});
      expect(res.status).toBe(409);
      expect(String(res.body.error)).toMatch(
        /Only failed jobs can be retried/,
      );
      expect(String(res.body.error)).toContain(`current status: ${status}`);
      // The atomic conditional update is issued but no-ops: its WHERE predicate
      // includes status='failed', so a non-failed job matches nothing and the
      // returning() is empty, leaving the job's state untouched.
      expect(state.updateCalls.length).toBe(1);
    },
  );
});

describe("POST /admin/background-jobs/:id/retry — happy path", () => {
  it("resets the failed job back to pending and clears last_error/completedAt without touching attempts", async () => {
    state.selectQueue.push([
      {
        id: 42,
        type: "sync.meta",
        status: "failed",
        attempts: 3,
        maxAttempts: 5,
        lastError: "boom",
        completedAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]);
    const updatedRow = {
      id: 42,
      status: "pending",
      lastError: null,
      completedAt: null,
      attempts: 3,
    };
    state.updateReturning.set("background_jobs", [updatedRow]);

    const res = await request("POST", "/admin/background-jobs/42/retry", {});
    expect(res.status).toBe(200);
    expect(res.body.job).toEqual(updatedRow);

    // Exactly one update against the right table.
    expect(state.updateCalls.length).toBe(1);
    const call = state.updateCalls[0];
    expect(call.table).toBe("background_jobs");

    // Reset fields are present and correctly typed; attempts is untouched
    // so retries still count against max_attempts.
    expect(call.set.status).toBe("pending");
    expect(call.set.lastError).toBeNull();
    expect(call.set.completedAt).toBeNull();
    expect(call.set.lockedAt).toBeNull();
    expect(call.set.lockedBy).toBeNull();
    expect(call.set.runAt).toBeInstanceOf(Date);
    expect(call.set.updatedAt).toBeInstanceOf(Date);
    expect("attempts" in call.set).toBe(false);
  });
});

// ─── GET /admin/rederive-jobs/cancelled ──────────────────────────────────────

describe("GET /admin/rederive-jobs/cancelled — role enforcement", () => {
  it("rejects client_admin with 403", async () => {
    currentSession = { ...asClientAdmin };
    const res = await request("GET", "/admin/rederive-jobs/cancelled");
    expect(res.status).toBe(403);
  });

  it("rejects client_user with 403", async () => {
    currentSession = { ...asClientUser };
    const res = await request("GET", "/admin/rederive-jobs/cancelled");
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    currentSession = {};
    const res = await request("GET", "/admin/rederive-jobs/cancelled");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/rederive-jobs/cancelled — list shape", () => {
  it("returns cancelled rederive jobs with scope + counts and falls back when result is empty", async () => {
    // 1st select: rows (joined with tenants). 2nd select: count.
    state.selectQueue.push([
      {
        id: 11,
        tenantId: 5,
        tenantName: "Acme",
        payload: {
          leadIds: [1, 2, 3, 4],
          pageUrlPattern: "/booking",
          formIdentifier: "main-form",
        },
        result: {
          total: 4,
          processed: 2,
          succeeded: 2,
          failed: 0,
          changed: 1,
        },
        createdAt: "2026-05-01T00:00:00Z",
        completedAt: "2026-05-01T00:01:00Z",
        updatedAt: "2026-05-01T00:01:00Z",
      },
      {
        // Pending-cancel row: handler never ran, result is empty. The
        // route should fall back to total=leadIds.length and processed=0.
        id: 12,
        tenantId: null,
        tenantName: null,
        payload: {
          leadIds: [99, 100],
          pageUrlPattern: "/foo",
          formIdentifier: "bar",
        },
        result: null,
        createdAt: "2026-05-02T00:00:00Z",
        completedAt: null,
        updatedAt: "2026-05-02T00:00:30Z",
      },
    ]);
    state.selectQueue.push([{ count: 2 }]);

    const res = await request("GET", "/admin/rederive-jobs/cancelled");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const jobs = res.body.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: 11,
      tenantId: 5,
      tenantName: "Acme",
      pageUrlPattern: "/booking",
      formIdentifier: "main-form",
      total: 4,
      processed: 2,
      succeeded: 2,
      failed: 0,
      changed: 1,
    });
    expect(jobs[1]).toMatchObject({
      id: 12,
      tenantId: null,
      tenantName: null,
      pageUrlPattern: "/foo",
      formIdentifier: "bar",
      total: 2, // fallback to leadIds.length
      processed: 0,
      succeeded: 0,
      failed: 0,
      changed: 0,
    });
  });

  it("clamps limit to the [1, 500] window", async () => {
    state.selectQueue.push([]);
    state.selectQueue.push([{ count: 0 }]);
    const res = await request(
      "GET",
      "/admin/rederive-jobs/cancelled?limit=9999",
    );
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
  });
});

// ─── POST /admin/rederive-jobs/cleanup ───────────────────────────────────────

describe("POST /admin/rederive-jobs/cleanup — role enforcement", () => {
  it("rejects client_admin with 403", async () => {
    currentSession = { ...asClientAdmin };
    const res = await request("POST", "/admin/rederive-jobs/cleanup", {});
    expect(res.status).toBe(403);
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers with 401", async () => {
    currentSession = {};
    const res = await request("POST", "/admin/rederive-jobs/cleanup", {});
    expect(res.status).toBe(401);
    expect(cleanupSpy).not.toHaveBeenCalled();
  });
});

describe("POST /admin/rederive-jobs/cleanup — happy path & validation", () => {
  it("defaults retentionDays to 30 and returns the deleted count", async () => {
    cleanupSpy.mockResolvedValue(7);
    const res = await request("POST", "/admin/rederive-jobs/cleanup", {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletedCount: 7, retentionDays: 30 });
    expect(cleanupSpy).toHaveBeenCalledExactlyOnceWith(30);
  });

  it("accepts a custom retentionDays override", async () => {
    cleanupSpy.mockResolvedValue(3);
    const res = await request("POST", "/admin/rederive-jobs/cleanup", {
      retentionDays: 7,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletedCount: 3, retentionDays: 7 });
    expect(cleanupSpy).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("rejects zero or negative retentionDays with 400", async () => {
    const res = await request("POST", "/admin/rederive-jobs/cleanup", {
      retentionDays: 0,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/positive number/);
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it("rejects non-numeric retentionDays with 400", async () => {
    const res = await request("POST", "/admin/rederive-jobs/cleanup", {
      retentionDays: "abc",
    });
    expect(res.status).toBe(400);
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it("surfaces a 500 when the cleanup service throws", async () => {
    cleanupSpy.mockRejectedValue(new Error("boom"));
    const res = await request("POST", "/admin/rederive-jobs/cleanup", {});
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toMatch(/boom/);
  });
});
