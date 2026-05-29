import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the drizzle query builder. Each db.select() call
// pops the next array from `selectResults` (so a handler that issues two
// selects gets two distinct result sets), and db.update().returning()
// resolves to `updateResults`.
const mockDb = {
  selectResults: [] as unknown[][],
  updateResults: [] as unknown[],
  _selectIdx: 0,
  reset() {
    this._selectIdx = 0;
    this.selectResults = [];
    this.updateResults = [];
  },
};

interface ThenableIterable extends Record<string, unknown> {
  then: (resolve: Function, reject?: Function) => Promise<unknown>;
  [Symbol.iterator]: () => Generator<unknown>;
}

function makeThenable(result: unknown[]): ThenableIterable {
  return {
    then: (resolve: Function, reject?: Function) =>
      Promise.resolve(result).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
    [Symbol.iterator]: function* () {
      yield* result;
    },
  };
}

// Supports the two select shapes this route uses:
//  - leads/search: .from().where().orderBy().limit()  (limit terminal)
//  - jobs/:id/lead: .from().where()                    (where terminal)
function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const thenResult = () => makeThenable(results());
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(
    Object.assign(thenResult(), {
      orderBy: vi.fn().mockReturnValue(
        Object.assign(thenResult(), {
          limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
        }),
      ),
      limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
    }),
  );
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  return chain;
}

function makeUpdateChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue({
    returning: vi.fn().mockImplementation(() => Promise.resolve(results())),
  });
  return chain;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => {
      const idx = mockDb._selectIdx++;
      return makeSelectChain(() => mockDb.selectResults[idx] || []);
    }),
    update: vi.fn().mockImplementation(() => makeUpdateChain(() => mockDb.updateResults)),
  },
  leadsTable: {
    id: "leads.id",
    tenantId: "leads.tenantId",
    firstName: "leads.firstName",
    lastName: "leads.lastName",
    phone: "leads.phone",
    email: "leads.email",
    source: "leads.source",
    status: "leads.status",
    createdAt: "leads.createdAt",
  },
  jobsTable: {
    id: "jobs.id",
    tenantId: "jobs.tenantId",
    leadId: "jobs.leadId",
    matchLevel: "jobs.matchLevel",
    updatedAt: "jobs.updatedAt",
    invoiceDate: "jobs.invoiceDate",
    completedAt: "jobs.completedAt",
    createdAt: "jobs.createdAt",
    invoiceTotal: "jobs.invoiceTotal",
    invoiceRebateAmount: "jobs.invoiceRebateAmount",
    revenue: "jobs.revenue",
    status: "jobs.status",
  },
  soldEstimatesTable: {
    id: "sold_estimates.id",
    jobId: "sold_estimates.jobId",
    rebateAmount: "sold_estimates.rebateAmount",
  },
  funnelTypesTable: {
    id: "funnel_types.id",
    name: "funnel_types.name",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...a: unknown[]) => ["eq", ...a]),
  and: vi.fn((...a: unknown[]) => ["and", ...a]),
  or: vi.fn((...a: unknown[]) => ["or", ...a]),
  gte: vi.fn((...a: unknown[]) => ["gte", ...a]),
  lte: vi.fn((...a: unknown[]) => ["lte", ...a]),
  desc: vi.fn((...a: unknown[]) => ["desc", ...a]),
  asc: vi.fn((...a: unknown[]) => ["asc", ...a]),
  inArray: vi.fn((...a: unknown[]) => ["inArray", ...a]),
  ilike: vi.fn((col: unknown, term: unknown) => ["ilike", col, term]),
  getTableColumns: vi.fn(() => ({})),
  sql: Object.assign(
    vi.fn((...a: unknown[]) => ["sql", ...a]),
    {},
  ),
}));

import express, { type Request, type Response, type NextFunction } from "express";

let app: express.Express;

async function setupApp(role: string | undefined, tenantId: number | null = null) {
  vi.resetModules();
  const mod = await import("./drilldown");
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

function request(
  expressApp: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {},
        },
        (res: { statusCode: number; on: Function }) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
          });
        },
      );
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const getJson = (a: express.Express, p: string) => request(a, "GET", p);
const patchJson = (a: express.Express, p: string, body: unknown) => request(a, "PATCH", p, body);

async function drizzleMock() {
  return import("drizzle-orm");
}

describe("GET /drilldown/leads/search — access control", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  for (const role of ["tenant_user", "client_admin", "client_user", undefined]) {
    it(`returns 403 for non-agency role: ${role ?? "(no role)"}`, async () => {
      await setupApp(role, 5);
      const res = await getJson(app, "/drilldown/leads/search?tenantId=5&q=an");

      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Only agency users can search leads for matching." });

      // Must short-circuit before any DB access.
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });
  }

  for (const role of ["super_admin", "agency_user"]) {
    it(`allows agency role: ${role}`, async () => {
      await setupApp(role, null);
      mockDb.selectResults = [[{ id: 1, firstName: "Ann", lastName: "Bee" }]];

      const res = await getJson(app, "/drilldown/leads/search?tenantId=5&q=an");

      expect(res.status).toBe(200);
      expect(res.json).toEqual([{ id: 1, firstName: "Ann", lastName: "Bee" }]);
    });
  }
});

describe("GET /drilldown/leads/search — required tenantId", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  it("returns 400 when tenantId is missing", async () => {
    await setupApp("super_admin", null);
    const res = await getJson(app, "/drilldown/leads/search?q=ann");

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "A tenantId is required to scope the lead search." });

    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
  });

  it("returns 400 when tenantId is non-numeric", async () => {
    await setupApp("super_admin", null);
    const res = await getJson(app, "/drilldown/leads/search?tenantId=abc&q=ann");

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "A tenantId is required to scope the lead search." });
  });
});

describe("GET /drilldown/leads/search — tenant scoping", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  it("always scopes the query to the supplied tenantId", async () => {
    await setupApp("super_admin", null);
    mockDb.selectResults = [[{ id: 1, firstName: "Ann", lastName: "Bee", tenantId: 5 }]];

    const res = await getJson(app, "/drilldown/leads/search?tenantId=5&q=ann");

    expect(res.status).toBe(200);
    const drizzle = await drizzleMock();
    const tenantEq = vi
      .mocked(drizzle.eq)
      .mock.calls.filter((c) => (c[0] as unknown) === "leads.tenantId");
    expect(tenantEq).toContainEqual(["leads.tenantId", 5]);
  });

  it("scopes to the requested tenant, not another tenant, even with an unrelated session tenantId", async () => {
    await setupApp("agency_user", null);
    mockDb.selectResults = [[]];

    const res = await getJson(app, "/drilldown/leads/search?tenantId=9&q=ann");

    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
    const drizzle = await drizzleMock();
    const tenantEq = vi
      .mocked(drizzle.eq)
      .mock.calls.filter((c) => (c[0] as unknown) === "leads.tenantId");
    // Only the requested tenant (9) is ever used to scope leads.
    expect(tenantEq).toContainEqual(["leads.tenantId", 9]);
    expect(tenantEq.every((c) => c[1] === 9)).toBe(true);
  });
});

describe("GET /drilldown/leads/search — q>=2 minimum", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  for (const q of ["", "a", " a "]) {
    it(`returns [] without querying for short q: "${q}"`, async () => {
      await setupApp("super_admin", null);
      const res = await getJson(app, `/drilldown/leads/search?tenantId=5&q=${encodeURIComponent(q)}`);

      expect(res.status).toBe(200);
      expect(res.json).toEqual([]);

      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });
  }

  it("queries when q has >= 2 characters", async () => {
    await setupApp("super_admin", null);
    mockDb.selectResults = [[{ id: 1 }]];

    const res = await getJson(app, "/drilldown/leads/search?tenantId=5&q=an");

    expect(res.status).toBe(200);
    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.select)).toHaveBeenCalled();
  });
});

describe("GET /drilldown/leads/search — match fields", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  it("matches against name, phone, email, and full-name with a wildcard term", async () => {
    await setupApp("super_admin", null);
    mockDb.selectResults = [[]];

    const res = await getJson(app, "/drilldown/leads/search?tenantId=5&q=Ann");

    expect(res.status).toBe(200);
    const drizzle = await drizzleMock();

    // The term is a substring (contains) match.
    const ilikeCols = vi.mocked(drizzle.ilike).mock.calls.map((c) => c[0]);
    const ilikeTerms = vi.mocked(drizzle.ilike).mock.calls.map((c) => c[1]);
    expect(ilikeCols).toContain("leads.firstName");
    expect(ilikeCols).toContain("leads.lastName");
    expect(ilikeCols).toContain("leads.phone");
    expect(ilikeCols).toContain("leads.email");
    // Five conditions: first, last, phone, email, full-name (first || ' ' || last).
    expect(vi.mocked(drizzle.ilike)).toHaveBeenCalledTimes(5);
    expect(ilikeTerms.every((t) => t === "%Ann%")).toBe(true);

    // All five conditions are OR'd together.
    expect(vi.mocked(drizzle.or).mock.calls[0].length).toBe(5);
  });

  it("caps the result limit at 25", async () => {
    await setupApp("super_admin", null);
    mockDb.selectResults = [[]];

    await getJson(app, "/drilldown/leads/search?tenantId=5&q=an&limit=100");

    const dbMod = await import("@workspace/db");
    // Find the limit() that was invoked on the select chain.
    const chain = vi.mocked(dbMod.db.select).mock.results[0].value as Record<string, unknown>;
    const whereResult = (chain.where as ReturnType<typeof vi.fn>).mock.results[0].value as Record<string, unknown>;
    const orderByResult = (whereResult.orderBy as ReturnType<typeof vi.fn>).mock.results[0].value as Record<string, unknown>;
    expect(orderByResult.limit).toHaveBeenCalledWith(25);
  });
});

describe("PATCH /drilldown/jobs/:id/lead — access control", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  it("returns 403 for a non-agency role", async () => {
    await setupApp("tenant_user", 5);
    const res = await patchJson(app, "/drilldown/jobs/10/lead", { leadId: 7 });

    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: "Only agency users can manually match jobs to leads." });

    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
  });
});

describe("PATCH /drilldown/jobs/:id/lead — happy path", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  it("matches a job to a lead in the same tenant and marks it manual", async () => {
    await setupApp("super_admin", null);
    mockDb.selectResults = [
      [{ id: 10, tenantId: 5 }], // job lookup
      [{ id: 7, tenantId: 5 }], // lead lookup
    ];
    mockDb.updateResults = [{ id: 10, leadId: 7, matchLevel: "manual" }];

    const res = await patchJson(app, "/drilldown/jobs/10/lead", { leadId: 7 });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: 10, leadId: 7, matchLevel: "manual" });

    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.update)).toHaveBeenCalled();
    const updateChain = vi.mocked(dbMod.db.update).mock.results[0].value as Record<string, unknown>;
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 7, matchLevel: "manual" }),
    );
  });

  it("clears the match (leadId null) and resets matchLevel", async () => {
    await setupApp("super_admin", null);
    mockDb.selectResults = [[{ id: 10, tenantId: 5 }]]; // job lookup only; no lead lookup when leadId null
    mockDb.updateResults = [{ id: 10, leadId: null, matchLevel: null }];

    const res = await patchJson(app, "/drilldown/jobs/10/lead", { leadId: null });

    expect(res.status).toBe(200);
    const dbMod = await import("@workspace/db");
    const updateChain = vi.mocked(dbMod.db.update).mock.results[0].value as Record<string, unknown>;
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: null, matchLevel: null }),
    );
  });
});

describe("PATCH /drilldown/jobs/:id/lead — cross-tenant lead rejected", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  it("returns 404 when the lead belongs to a different tenant than the job", async () => {
    await setupApp("super_admin", null);
    mockDb.selectResults = [
      [{ id: 10, tenantId: 5 }], // job is in tenant 5
      [{ id: 7, tenantId: 9 }], // lead is in tenant 9
    ];

    const res = await patchJson(app, "/drilldown/jobs/10/lead", { leadId: 7 });

    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "Lead not found" });

    // Must not perform the update when the lead is cross-tenant.
    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
  });

  it("returns 404 when the lead does not exist", async () => {
    await setupApp("super_admin", null);
    mockDb.selectResults = [
      [{ id: 10, tenantId: 5 }], // job
      [], // lead lookup misses
    ];

    const res = await patchJson(app, "/drilldown/jobs/10/lead", { leadId: 999 });

    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "Lead not found" });

    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
  });

  it("returns 404 when the job does not exist", async () => {
    await setupApp("super_admin", null);
    mockDb.selectResults = [[]]; // job lookup misses

    const res = await patchJson(app, "/drilldown/jobs/404/lead", { leadId: 7 });

    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "Job not found" });

    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid job id", async () => {
    await setupApp("super_admin", null);
    const res = await patchJson(app, "/drilldown/jobs/abc/lead", { leadId: 7 });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "Invalid job id" });
  });
});
