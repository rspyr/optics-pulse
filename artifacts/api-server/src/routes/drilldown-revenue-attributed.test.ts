// Coverage for the money-facing + access-control contract of the
// Revenue Attributed drilldown (task: attributed-revenue endpoint tests):
//
//   GET   /drilldown/revenue-attributed
//   PATCH /drilldown/jobs/:id/lead
//
// What we assert:
//   1. Corrected (rebate-inclusive) revenue math reconciles with the
//      same formula /drilldown/jobs orders by, for the same job range.
//   2. The itemized rebate breakdown + salesperson name flow through
//      from sold_estimates, with the "largest rebate wins" de-dupe and
//      the lead.assignedTo fallback for soldByName.
//   3. Clients cannot call the manual-match endpoint (agency-only) and
//      cannot see another tenant's jobs (list scope is forced to the
//      session tenant, never the attacker-supplied query.tenantId).
//
// Like the sibling tenant-scope tests, this exercises the real express
// router end-to-end with drizzle + the db mocked out, so no real
// database is required. The corrected-revenue formula under test is:
//   COALESCE(invoiceTotal + COALESCE(invoiceRebateAmount, 0), revenue)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NO_TENANT_ASSIGNED_ERROR } from "../lib/tenant-scope";

const mockDb = {
  selectResults: [] as unknown[][],
  updateResults: [] as unknown[][],
  _selectIdx: 0,
  _updateIdx: 0,
  reset() {
    this._selectIdx = 0;
    this._updateIdx = 0;
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

// Permissive select chain: supports both the jobs query
// (.where(...).orderBy(...).limit(...)) and the terminal awaited
// .where(inArray(...)) used for the sold_estimates / leads lookups.
function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const thenResult = () => makeThenable(results());
  const passthrough = () => chain;
  chain.from = vi.fn().mockImplementation(passthrough);
  chain.innerJoin = vi.fn().mockImplementation(passthrough);
  chain.leftJoin = vi.fn().mockImplementation(passthrough);
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  // .limit() may be terminal, or chained with .offset() (e.g. /drilldown/jobs
  // does `.orderBy(...).limit(n).offset(m)`), so the limit return must also
  // expose .offset resolving to the same results.
  const limitReturn = () =>
    Object.assign(thenResult(), {
      offset: vi.fn().mockImplementation(() => Promise.resolve(results())),
    });
  chain.where = vi.fn().mockImplementation(() =>
    Object.assign(thenResult(), {
      orderBy: vi.fn().mockReturnValue(
        Object.assign(thenResult(), {
          limit: vi.fn().mockImplementation(limitReturn),
        }),
      ),
      limit: vi.fn().mockImplementation(limitReturn),
    }),
  );
  chain.orderBy = vi.fn().mockReturnValue(
    Object.assign(thenResult(), { limit: vi.fn().mockImplementation(limitReturn) }),
  );
  chain.limit = vi.fn().mockImplementation(limitReturn);
  return chain;
}

function makeUpdateChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(results()));
  return chain;
}

vi.mock("@workspace/db", () => {
  const tablecol = (t: string) => new Proxy({}, { get: (_, k) => `${t}.${String(k)}` });
  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const idx = mockDb._selectIdx++;
        return makeSelectChain(() => mockDb.selectResults[idx] || []);
      }),
      update: vi.fn().mockImplementation(() => {
        const idx = mockDb._updateIdx++;
        return makeUpdateChain(() => mockDb.updateResults[idx] || []);
      }),
    },
    leadsTable: tablecol("leads"),
    jobsTable: tablecol("jobs"),
    soldEstimatesTable: tablecol("sold_estimates"),
  };
});

function asAble(obj: Record<string, unknown>) {
  obj.as = vi.fn().mockReturnValue(obj);
  return obj;
}
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...a: unknown[]) => asAble({ __op: "eq", a })),
  and: vi.fn((...a: unknown[]) => asAble({ __op: "and", a })),
  or: vi.fn((...a: unknown[]) => asAble({ __op: "or", a })),
  desc: vi.fn((...a: unknown[]) => asAble({ __op: "desc", a })),
  sql: Object.assign(
    vi.fn((..._a: unknown[]) => asAble({ __op: "sql" })),
    { join: vi.fn((...a: unknown[]) => asAble({ __op: "sql.join", a })) },
  ),
  inArray: vi.fn((...a: unknown[]) => asAble({ __op: "inArray", a })),
  gte: vi.fn((...a: unknown[]) => asAble({ __op: "gte", a })),
  lte: vi.fn((...a: unknown[]) => asAble({ __op: "lte", a })),
  SQL: class {},
}));

import express, { type Request, type Response, type NextFunction } from "express";

async function setupApp(role: string, tenantId: number | null) {
  vi.resetModules();
  const mod = await import("./drilldown");
  const app = express();
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
  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | unknown[] }> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const server = http.createServer(app);
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
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() }
            : {},
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
      req.on("error", (err: unknown) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function tenantEqArgsFor(table: string): Promise<unknown[]> {
  const drizzle = await import("drizzle-orm");
  return vi
    .mocked(drizzle.eq)
    .mock.calls.filter((c) => (c[0] as unknown as string) === `${table}.tenantId`)
    .map((c) => c[1]);
}

// The corrected-revenue formula the route computes in JS, mirroring the
// jobRevenueExpr that /drilldown/jobs orders by.
function correctedRevenueOf(job: {
  invoiceTotal: number | null;
  invoiceRebateAmount: number | null;
  revenue: number;
}): number {
  return job.invoiceTotal != null ? job.invoiceTotal + (job.invoiceRebateAmount ?? 0) : job.revenue;
}

describe("GET /drilldown/revenue-attributed", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  describe("corrected-revenue math reconciles with /drilldown/jobs", () => {
    // A range of completed jobs: two with invoices (rebate added back),
    // one falling back to legacy `revenue` because invoiceTotal is null.
    const jobs = [
      { id: 1, tenantId: 7, leadId: null, stJobId: "j1", stInvoiceId: "i1", customerName: "A",
        jobType: "hvac", jobTypeName: "HVAC", status: "completed",
        revenue: 1000, invoiceTotal: 900, invoiceRebateAmount: 150,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
      { id: 2, tenantId: 7, leadId: null, stJobId: "j2", stInvoiceId: "i2", customerName: "B",
        jobType: "plumb", jobTypeName: "Plumbing", status: "completed",
        revenue: 500, invoiceTotal: 500, invoiceRebateAmount: null,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
      { id: 3, tenantId: 7, leadId: null, stJobId: "j3", stInvoiceId: null, customerName: "C",
        jobType: "elec", jobTypeName: "Electrical", status: "completed",
        revenue: 750, invoiceTotal: null, invoiceRebateAmount: null,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
    ];

    it("computes correctedRevenue = invoiceTotal + invoiceRebateAmount, falling back to revenue", async () => {
      const app = await setupApp("super_admin", null);
      // selects: [0] jobs. No estimates/leads (no jobIds estimates seeded, leadIds empty).
      mockDb.selectResults = [jobs, [], []];

      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7&startDate=2026-01-01&endDate=2026-12-31");

      expect(res.status).toBe(200);
      const rows = res.json as Array<{ id: number; correctedRevenue: number }>;
      const byId = new Map(rows.map((r) => [r.id, r.correctedRevenue]));
      expect(byId.get(1)).toBe(1050); // 900 + 150
      expect(byId.get(2)).toBe(500); //  500 + 0
      expect(byId.get(3)).toBe(750); //  fallback to revenue
    });

    it("totals reconcile with the same formula applied to /drilldown/jobs rows", async () => {
      // revenue-attributed run
      const app1 = await setupApp("super_admin", null);
      mockDb.selectResults = [jobs, [], []];
      const attributed = await request(app1, "GET", "/drilldown/revenue-attributed?tenantId=7");
      expect(attributed.status).toBe(200);
      const attributedTotal = (attributed.json as Array<{ correctedRevenue: number }>)
        .reduce((sum, r) => sum + r.correctedRevenue, 0);

      // /drilldown/jobs run over the same job range — it returns raw rows
      // and orders by jobRevenueExpr; applying that same formula here must
      // yield the identical total the drilldown surfaced.
      mockDb.reset();
      vi.clearAllMocks();
      const app2 = await setupApp("super_admin", null);
      mockDb.selectResults = [jobs];
      const jobsRes = await request(app2, "GET", "/drilldown/jobs?tenantId=7&useJobDate=true&sort=revenue");
      expect(jobsRes.status).toBe(200);
      const jobsTotal = (jobsRes.json as typeof jobs).reduce((sum, j) => sum + correctedRevenueOf(j), 0);

      expect(attributedTotal).toBe(jobsTotal);
      expect(attributedTotal).toBe(1050 + 500 + 750);
    });
  });

  describe("itemized rebate breakdown + soldByName from sold_estimates", () => {
    const baseJob = {
      id: 10, tenantId: 7, leadId: 99, stJobId: "j10", stInvoiceId: "i10", customerName: "Estimate Co",
      jobType: "hvac", jobTypeName: "HVAC", status: "completed",
      revenue: 2000, invoiceTotal: 1800, invoiceRebateAmount: 300,
      invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null,
    };

    it("passes through the itemized breakdown and salesperson name", async () => {
      const breakdown = [
        { label: "ETO", amount: 200 },
        { label: "ODEE", amount: 100 },
      ];
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [baseJob],
        [{ jobId: 10, soldByName: "Dana Sells", rebateAmount: 300, rebateBreakdown: breakdown }],
        [{ id: 99, firstName: "Lead", lastName: "Person", source: "ppc", originalSource: "ppc",
          status: "sold", hubStatus: null, assignedTo: "Fallback Rep" }],
      ];

      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7");

      expect(res.status).toBe(200);
      const row = (res.json as Array<Record<string, unknown>>)[0];
      expect(row.soldByName).toBe("Dana Sells");
      expect(row.rebateBreakdown).toEqual(breakdown);
      expect(row.correctedRevenue).toBe(2100); // 1800 + 300
    });

    it("prefers the estimate with the largest rebate when a job has duplicates", async () => {
      const small = [{ label: "ETO", amount: 50 }];
      const big = [{ label: "ETO", amount: 200 }, { label: "ODEE", amount: 100 }];
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [baseJob],
        [
          { jobId: 10, soldByName: "Small Rebate Rep", rebateAmount: 50, rebateBreakdown: small },
          { jobId: 10, soldByName: "Big Rebate Rep", rebateAmount: 300, rebateBreakdown: big },
        ],
        [],
      ];

      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7");

      expect(res.status).toBe(200);
      const row = (res.json as Array<Record<string, unknown>>)[0];
      expect(row.soldByName).toBe("Big Rebate Rep");
      expect(row.rebateBreakdown).toEqual(big);
    });

    it("falls back to lead.assignedTo for soldByName when there is no estimate", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [baseJob],
        [], // no sold estimate for this job
        [{ id: 99, firstName: "Lead", lastName: "Person", source: "ppc", originalSource: "ppc",
          status: "sold", hubStatus: null, assignedTo: "Fallback Rep" }],
      ];

      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7");

      expect(res.status).toBe(200);
      const row = (res.json as Array<Record<string, unknown>>)[0];
      expect(row.soldByName).toBe("Fallback Rep");
      expect(row.rebateBreakdown).toEqual([]);
      expect((row.lead as { id: number }).id).toBe(99);
    });
  });

  describe("tenant scoping (clients cannot see other tenants' jobs)", () => {
    it("returns 403 'No tenant assigned' for a tenant-scoped role with no session tenant, and never reads the DB", async () => {
      const app = await setupApp("tenant_user", null);
      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=9");
      expect(res.status).toBe(403);
      expect(res.json).toEqual(NO_TENANT_ASSIGNED_ERROR);
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });

    it("forces the session tenantId, ignoring an attacker-supplied query.tenantId", async () => {
      const app = await setupApp("tenant_user", 7);
      mockDb.selectResults = [[], [], []];
      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=9");
      expect(res.status).toBeLessThan(500);
      const tenantArgs = await tenantEqArgsFor("jobs");
      expect(tenantArgs).toContain(7);
      expect(tenantArgs).not.toContain(9);
      expect(tenantArgs).not.toContain("9");
    });
  });
});

describe("PATCH /drilldown/jobs/:id/lead (manual match — agency only)", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  for (const role of ["client_user", "client_admin", "tenant_user"]) {
    it(`rejects ${role} with 403 and never reads or writes the DB`, async () => {
      const app = await setupApp(role, 7);
      const res = await request(app, "PATCH", "/drilldown/jobs/5/lead", { leadId: 42 });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Only agency users can manually match jobs to leads." });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
      expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
    });
  }

  it("allows agency_user to manually match a job to a lead", async () => {
    const app = await setupApp("agency_user", 1);
    mockDb.selectResults = [
      [{ id: 5, tenantId: 7 }], // job lookup
      [{ id: 42, tenantId: 7 }], // lead lookup
    ];
    mockDb.updateResults = [[{ id: 5, leadId: 42, matchLevel: "manual" }]];

    const res = await request(app, "PATCH", "/drilldown/jobs/5/lead", { leadId: 42 });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: 5, leadId: 42, matchLevel: "manual" });
    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.update)).toHaveBeenCalled();
  });

  it("allows super_admin to clear a job's lead (leadId null)", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[{ id: 5, tenantId: 7 }]];
    mockDb.updateResults = [[{ id: 5, leadId: null, matchLevel: null }]];

    const res = await request(app, "PATCH", "/drilldown/jobs/5/lead", { leadId: null });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: 5, leadId: null, matchLevel: null });
  });

  it("rejects a lead that belongs to a different tenant than the job (404)", async () => {
    const app = await setupApp("agency_user", 1);
    mockDb.selectResults = [
      [{ id: 5, tenantId: 7 }], // job in tenant 7
      [{ id: 42, tenantId: 9 }], // lead in tenant 9 — mismatch
    ];

    const res = await request(app, "PATCH", "/drilldown/jobs/5/lead", { leadId: 42 });

    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "Lead not found" });
    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
  });
});
