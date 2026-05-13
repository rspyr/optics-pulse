import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = {
  selectResults: [] as unknown[][],
  _selectIdx: 0,
  resetCounters() {
    this._selectIdx = 0;
    this.selectResults = [];
  },
};

interface ThenableIterable extends Record<string, unknown> {
  then: (resolve: Function, reject?: Function) => Promise<unknown>;
  [Symbol.iterator]: () => Generator<unknown>;
}

function makeThenable(result: unknown[]): ThenableIterable {
  const obj: ThenableIterable = {
    then: (resolve: Function, reject?: Function) =>
      Promise.resolve(result).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
    [Symbol.iterator]: function* () {
      yield* result;
    },
  };
  return obj;
}

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const thenResult = () => makeThenable(results());
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(
    Object.assign(thenResult(), {
      limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
      orderBy: vi.fn().mockReturnValue(
        Object.assign(thenResult(), {
          limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
          offset: vi.fn().mockReturnValue(
            Object.assign(thenResult(), {
              limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
            }),
          ),
        }),
      ),
    }),
  );
  chain.orderBy = vi.fn().mockReturnValue(
    Object.assign(thenResult(), { limit: vi.fn().mockImplementation(() => Promise.resolve(results())) }),
  );
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  return chain;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => {
      const idx = mockDb._selectIdx++;
      return makeSelectChain(() => mockDb.selectResults[idx] || []);
    }),
  },
  attributionEventsTable: {
    id: "attribution_events.id",
    tenantId: "attribution_events.tenantId",
    matchLevel: "attribution_events.matchLevel",
  },
  reconciliationRunsTable: Symbol("reconciliationRunsTable"),
  jobsTable: {
    id: "jobs.id",
    tenantId: "jobs.tenantId",
    matchedGclid: "jobs.matchedGclid",
    leadId: "jobs.leadId",
    matchLevel: "jobs.matchLevel",
    customerName: "jobs.customerName",
    stJobId: "jobs.stJobId",
    revenue: "jobs.revenue",
    ociUploadedAt: "jobs.ociUploadedAt",
    enhancedConversionUploadedAt: "jobs.enhancedConversionUploadedAt",
    capiUploadedAt: "jobs.capiUploadedAt",
    serviceAddress: "jobs.serviceAddress",
  },
  leadsTable: {
    id: "leads.id",
    tenantId: "leads.tenantId",
    phone: "leads.phone",
    email: "leads.email",
    firstName: "leads.firstName",
    lastName: "leads.lastName",
  },
}));

vi.mock("../socket", () => ({
  emitNewLead: vi.fn(),
  emitNewAttributionEvent: vi.fn(),
  emitLeadUpdated: vi.fn(),
}));

vi.mock("../services/reconciliation", () => ({
  runReconciliation: vi.fn(),
  getReconciliationStatus: vi.fn(),
}));

// Mock the tracker module so we don't have to drag in its full
// dependency tree. The endpoint only uses these three helpers; we keep
// them as spies so we can assert that the recompute path is or isn't
// taken depending on the row state.
vi.mock("./tracker", () => ({
  extractFieldNamesForOperator: vi
    .fn()
    .mockImplementation((fields: Record<string, unknown> | null | undefined) => {
      if (!fields || typeof fields !== "object") return [];
      return Object.keys(fields).filter((k) => !k.startsWith("_"));
    }),
  computeUnmatchedReason: vi.fn().mockReturnValue("RECOMPUTED REASON"),
  extractPiiFromFields: vi
    .fn()
    .mockReturnValue({ phone: null, email: null, firstName: null, lastName: null }),
}));

vi.mock("../lib/phone-utils", () => ({
  hashValue: vi.fn().mockImplementation((v: string) => `h:${v}`),
  hashPhone: vi.fn().mockImplementation((v: string) => `hp:${v}`),
}));

vi.mock("@workspace/api-zod", () => ({
  ListAttributionEventsQueryParams: { parse: (q: unknown) => q },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...a: unknown[]) => a),
  and: vi.fn((...a: unknown[]) => a),
  or: vi.fn((...a: unknown[]) => a),
  count: vi.fn((...a: unknown[]) => a),
  desc: vi.fn((...a: unknown[]) => a),
  sql: vi.fn((...a: unknown[]) => a),
}));

import express, { type Request, type Response, type NextFunction } from "express";

let app: express.Express;

async function setupApp(role: string = "super_admin", tenantId: number | null = null) {
  vi.resetModules();
  const mod = await import("./attribution");
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Stub session — bypass the express-session typing because the real route
    // only reads req.session.userId / userRole / tenantId.
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
): Promise<{ status: number; json: Record<string, unknown> }> {
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

function makeBaseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tenantId: 5,
    matchLevel: "unmatched",
    unmatchedReason: null,
    formFields: { field_a: "x", field_b: "y" },
    gclid: null,
    fbclid: null,
    wbraid: null,
    msclkid: null,
    ttclid: null,
    liFatId: null,
    hashedPhone: null,
    hashedEmail: null,
    billingAddress: null,
    ...overrides,
  };
}

describe("GET /attribution/events/:id — unmatchedReason contract", () => {
  beforeEach(async () => {
    mockDb.resetCounters();
    vi.clearAllMocks();
    await setupApp();
  });

  it("returns the persisted unmatchedReason verbatim and does NOT recompute when stored", async () => {
    const stored = "Click ID present but no phone or email field detected.";
    mockDb.selectResults = [
      [
        makeBaseEvent({
          id: 101,
          matchLevel: "unmatched",
          unmatchedReason: stored,
        }),
      ],
    ];

    const res = await getJson(app, "/attribution/events/101");

    expect(res.status).toBe(200);
    const event = (res.json as Record<string, unknown>).event as Record<string, unknown>;
    expect(event.unmatchedReason).toBe(stored);

    // The recompute helper must NOT have been invoked when a stored
    // reason is present — that's the whole point of persisting it at
    // insert time (Task #263).
    const trackerMod = await import("./tracker");
    expect(vi.mocked(trackerMod.computeUnmatchedReason)).not.toHaveBeenCalled();
  });

  it("recomputes via the shared helper and returns a non-null reason when stored is null on an unmatched row", async () => {
    mockDb.selectResults = [
      [
        makeBaseEvent({
          id: 102,
          matchLevel: "unmatched",
          unmatchedReason: null,
        }),
      ],
    ];

    const res = await getJson(app, "/attribution/events/102");

    expect(res.status).toBe(200);
    const event = (res.json as Record<string, unknown>).event as Record<string, unknown>;
    expect(event.unmatchedReason).toBe("RECOMPUTED REASON");
    expect(event.unmatchedReason).not.toBeNull();

    const trackerMod = await import("./tracker");
    expect(vi.mocked(trackerMod.computeUnmatchedReason)).toHaveBeenCalledTimes(1);
  });

  it("resolves matchedJob via gclid lookup when event.gclid is present", async () => {
    const job = {
      id: 901,
      customerName: "Acme HVAC",
      stJobId: "ST-1",
      matchLevel: "diamond",
      matchedGclid: "gclid-abc",
      revenue: 12500,
      leadId: null,
      ociUploadedAt: null,
      enhancedConversionUploadedAt: null,
      capiUploadedAt: null,
    };
    mockDb.selectResults = [
      [makeBaseEvent({ id: 201, gclid: "gclid-abc" })],
      [job],
    ];

    const res = await getJson(app, "/attribution/events/201");

    expect(res.status).toBe(200);
    expect(res.json.matchedJob).toEqual(job);
    expect(res.json.matchedLead).toBeNull();
  });

  it("resolves matchedJob + matchedLead via hashedPhone → golden job", async () => {
    const lead = { id: 71, phone: "555-1234", firstName: "Ann", lastName: "Bee" };
    const job = {
      id: 902,
      customerName: "Bee Plumbing",
      stJobId: "ST-2",
      matchLevel: "golden",
      matchedGclid: null,
      revenue: 4200,
      leadId: 71,
      ociUploadedAt: null,
      enhancedConversionUploadedAt: null,
      capiUploadedAt: null,
    };
    mockDb.selectResults = [
      [makeBaseEvent({ id: 202, hashedPhone: "hp:555-1234" })],
      [lead],
      [job],
    ];

    const res = await getJson(app, "/attribution/events/202");

    expect(res.status).toBe(200);
    expect(res.json.matchedJob).toEqual(job);
    expect(res.json.matchedLead).toEqual({ id: 71, firstName: "Ann", lastName: "Bee" });
  });

  it("resolves matchedJob + matchedLead via hashedEmail → silver job", async () => {
    const lead = { id: 82, email: "foo@bar.com", firstName: "Cee", lastName: "Dee" };
    const job = {
      id: 903,
      customerName: "Cee Roofing",
      stJobId: "ST-3",
      matchLevel: "silver",
      matchedGclid: null,
      revenue: 7800,
      leadId: 82,
      ociUploadedAt: null,
      enhancedConversionUploadedAt: null,
      capiUploadedAt: null,
    };
    mockDb.selectResults = [
      [makeBaseEvent({ id: 203, hashedEmail: "h:foo@bar.com" })],
      [lead],
      [job],
    ];

    const res = await getJson(app, "/attribution/events/203");

    expect(res.status).toBe(200);
    expect(res.json.matchedJob).toEqual(job);
    expect(res.json.matchedLead).toEqual({ id: 82, firstName: "Cee", lastName: "Dee" });
  });

  it("resolves matchedJob via normalized billing address → bronze job", async () => {
    const job = {
      id: 904,
      customerName: "Dee Electric",
      stJobId: "ST-4",
      matchLevel: "bronze",
      matchedGclid: null,
      revenue: 3300,
      leadId: null,
      ociUploadedAt: null,
      enhancedConversionUploadedAt: null,
      capiUploadedAt: null,
      serviceAddress: "123 main st",
    };
    mockDb.selectResults = [
      [makeBaseEvent({ id: 204, billingAddress: "123 Main Street." })],
      [job],
    ];

    const res = await getJson(app, "/attribution/events/204");

    expect(res.status).toBe(200);
    const matched = res.json.matchedJob as Record<string, unknown>;
    expect(matched).not.toBeNull();
    expect(matched.id).toBe(904);
    expect(matched.matchLevel).toBe("bronze");
    expect(res.json.matchedLead).toBeNull();
  });

  it("returns unmatchedReason: null on matched rows regardless of any stored value", async () => {
    mockDb.selectResults = [
      [
        makeBaseEvent({
          id: 103,
          matchLevel: "golden",
          // Stale leftover value that should NOT leak through to the
          // response — matched rows have no business surfacing an
          // unmatched-reason hint.
          unmatchedReason: "STALE STORED VALUE THAT SHOULD BE IGNORED",
          hashedPhone: null,
        }),
      ],
    ];

    const res = await getJson(app, "/attribution/events/103");

    expect(res.status).toBe(200);
    const event = (res.json as Record<string, unknown>).event as Record<string, unknown>;
    expect(event.unmatchedReason).toBeNull();

    // Matched rows must never trigger the recompute helper either.
    const trackerMod = await import("./tracker");
    expect(vi.mocked(trackerMod.computeUnmatchedReason)).not.toHaveBeenCalled();
  });
});
