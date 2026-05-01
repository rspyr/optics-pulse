import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

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
  return {
    then: (resolve: Function, reject?: Function) =>
      Promise.resolve(result).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
    [Symbol.iterator]: function* () {
      yield* result;
    },
  };
}

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const lazy = () => makeThenable(results());
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(
    Object.assign(lazy(), {
      groupBy: vi.fn().mockImplementation(() => Promise.resolve(results())),
      limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
      orderBy: vi.fn().mockReturnValue(
        Object.assign(lazy(), {
          limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
        }),
      ),
    }),
  );
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
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
    delete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  },
  leadsTable: {
    id: "leads.id",
    tenantId: "leads.tenantId",
    hubStatus: "leads.hubStatus",
    source: "leads.source",
    funnelId: "leads.funnelId",
    assignedCsrId: "leads.assignedCsrId",
    bookedByCsrId: "leads.bookedByCsrId",
    serviceType: "leads.serviceType",
    preBooked: "leads.preBooked",
    createdAt: "leads.createdAt",
    updatedAt: "leads.updatedAt",
  },
  callAttemptsTable: {
    leadId: "callAttempts.leadId",
    userId: "callAttempts.userId",
    actionType: "callAttempts.actionType",
    attemptedAt: "callAttempts.attemptedAt",
  },
  usersTable: Symbol("usersTable"),
  scheduledFollowupsTable: Symbol("scheduledFollowupsTable"),
  funnelTypesTable: { id: "funnelTypes.id", name: "funnelTypes.name" },
  routingConfigTable: Symbol("routingConfigTable"),
  csrScheduleTable: Symbol("csrScheduleTable"),
  tenantFunnelTypesTable: Symbol("tenantFunnelTypesTable"),
  tenantsTable: { id: "tenants.id", spiffConfig: "tenants.spiffConfig", timezone: "tenants.timezone" },
  leadSourceAliasesTable: Symbol("leadSourceAliasesTable"),
  soldEstimatesTable: Symbol("soldEstimatesTable"),
  isUnknownSource: () => false,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...a: unknown[]) => a),
  and: vi.fn((...a: unknown[]) => a),
  sql: vi.fn((...a: unknown[]) => a),
  desc: vi.fn((...a: unknown[]) => a),
  asc: vi.fn((...a: unknown[]) => a),
  gte: vi.fn((...a: unknown[]) => a),
  gt: vi.fn((...a: unknown[]) => a),
  lte: vi.fn((...a: unknown[]) => a),
  inArray: vi.fn((...a: unknown[]) => a),
  isNull: vi.fn((...a: unknown[]) => a),
  ne: vi.fn((...a: unknown[]) => a),
  count: vi.fn((...a: unknown[]) => a),
  or: vi.fn((...a: unknown[]) => a),
  isNotNull: vi.fn((...a: unknown[]) => a),
}));

vi.mock("../socket", () => ({
  emitLeadUpdated: vi.fn(),
  emitNewLead: vi.fn(),
  emitNewAttributionEvent: vi.fn(),
  getHudStats: vi.fn(),
}));

vi.mock("../services/lead-notify-scheduler", () => ({
  scheduleOrEmitNewLead: vi.fn(),
}));

vi.mock("../services/round-robin", () => ({
  assignLeadRoundRobin: vi.fn(),
}));

vi.mock("../services/source-normalizer", () => ({
  normalizeSource: vi.fn().mockImplementation((s: string) => s),
}));

vi.mock("../services/auto-pass-scheduler", () => ({
  scheduleAutoPass: vi.fn(),
  cancelAutoPass: vi.fn(),
  leadHasRealTouch: vi.fn(),
  claimLead: vi.fn(),
  releaseClaim: vi.fn(),
  consumeClaim: vi.fn(),
  hasActiveClaim: vi.fn(),
  isStickyTerminalAtRest: vi.fn(),
}));

vi.mock("../services/integrations/podium-api", () => ({
  syncPodiumConversationAssignment: vi.fn(),
}));

// Stub the heavy services that sales-manager.ts pulls in transitively so the
// router import doesn't need a real DB.
vi.mock("../services/coaching-insights", () => ({
  generateCoachingInsights: vi.fn(),
}));
vi.mock("../services/login-time-calculator", () => ({
  computeLoginAwareSpeeds: vi.fn().mockResolvedValue([]),
}));

import express, { type Request, type Response, type NextFunction } from "express";

let app: express.Express;

async function setupApp(role: string = "client_admin", tenantId: number | null = 5) {
  vi.resetModules();
  const mod = await import("./leads-hub");
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
  reqPath: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        { hostname: "127.0.0.1", port, path: reqPath, method: "GET" },
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

// A shared fixture that exercises the toggle: 3 normal leads (one is an
// appointment) plus 2 pre-booked leads whose current hub_status has
// progressed past appt_set/appt_booked. This is the exact shape that broke
// the 1:1 invariant before Task #337 — pre-booked + sold/dead would
// otherwise inflate Total Leads without showing up in the booking tile.
function buildFixture() {
  const leads = [
    { id: 1, hubStatus: "appt_set", source: "google", funnelId: 10, assignedCsrId: 100, bookedByCsrId: 100, serviceType: "install", preBooked: false },
    { id: 2, hubStatus: "day_2", source: "google", funnelId: 10, assignedCsrId: 100, bookedByCsrId: null, serviceType: "install", preBooked: false },
    { id: 3, hubStatus: "day_3", source: "facebook", funnelId: 11, assignedCsrId: 101, bookedByCsrId: null, serviceType: "service", preBooked: false },
    // Pre-booked, but moved on to "sold" — the regression scenario.
    { id: 4, hubStatus: "sold", source: "google", funnelId: 10, assignedCsrId: 100, bookedByCsrId: null, serviceType: "install", preBooked: true },
    // Pre-booked, but moved on to "dead".
    { id: 5, hubStatus: "dead", source: "facebook", funnelId: 11, assignedCsrId: 101, bookedByCsrId: null, serviceType: "service", preBooked: true },
  ];
  // bookedActivityRows: the route's SQL filters preBooked=false, so only the
  // single appt_set row comes back.
  const bookedActivityRows = [{ funnelId: 10, preBooked: false }];
  const tenantRow = [{ spiffConfig: { default: 25, byFunnel: {} } }];
  // funnelTypes lookup: only fires if there's an eligible (non-pre-booked)
  // funnelId in bookedActivityRows.
  const funnelNames = [{ id: 10, name: "Plumbing" }];
  // contactedRow: 3 leads with hub_status NOT IN ('day_1') and preBooked=false
  // (leads 1, 2, 3).
  const contactedRow = [{ count: 3 }];

  return {
    leads,
    fixtures: [
      leads,                // [0] filteredLeads source
      bookedActivityRows,   // [1] bookedActivityRows
      tenantRow,            // [2] tenantsTable spiffConfig
      funnelNames,          // [3] spiff funnel name lookup
      contactedRow,         // [4] contacted denominator
      [],                   // [5] callStats
      [],                   // [6] callsByFunnelRaw
    ],
  };
}

async function runStats(query: string, fixtures: unknown[][]) {
  mockDb._selectIdx = 0;
  mockDb.selectResults = fixtures;
  return getJson(app, `/leads-hub/stats${query}`);
}

describe("GET /leads-hub/stats — Include Pre-Booked toggle", () => {
  beforeEach(async () => {
    mockDb.resetCounters();
    vi.clearAllMocks();
    await setupApp();
  });

  describe("today range (activity-based bookedInWindow)", () => {
    it("toggle off: bookedInWindow excludes pre-booked leads", async () => {
      const { fixtures } = buildFixture();
      const res = await runStats("?includePreBooked=false", fixtures);

      expect(res.status).toBe(200);
      expect(res.json.totalLeads).toBe(3);
      expect(res.json.appointments).toBe(1);
      expect(res.json.bookedInWindow).toBe(1);
      // 1 booked / 3 contacted denominator
      expect(res.json.activityBookingRate).toBe(33);
    });

    it("toggle on: bookedInWindow gains pre-booked 1:1 with the lead tile", async () => {
      const { fixtures } = buildFixture();
      const off = await runStats("?includePreBooked=false", fixtures);
      const on = await runStats("?includePreBooked=true", fixtures);

      const offTotal = off.json.totalLeads as number;
      const onTotal = on.json.totalLeads as number;
      const offBooked = off.json.bookedInWindow as number;
      const onBooked = on.json.bookedInWindow as number;

      // The whole point of the toggle: the booking count must move by the
      // same delta as the lead count when pre-booked is folded in.
      expect(onTotal - offTotal).toBe(2);
      expect(onBooked - offBooked).toBe(2);
      expect(onTotal - offTotal).toBe(onBooked - offBooked);

      // Activity-based denominator also gains pre-booked, keeping the rate
      // internally consistent: 3 booked / 5 contacted = 60%.
      expect(on.json.activityBookingRate).toBe(60);
    });
  });

  describe("non-today range (appointments by createdAt)", () => {
    const window = "?startDate=2024-01-01T00:00:00.000Z&endDate=2024-01-07T23:59:59.999Z";

    it("toggle off: appointments tile excludes pre-booked leads", async () => {
      const { fixtures } = buildFixture();
      const res = await runStats(`${window}&includePreBooked=false`, fixtures);

      expect(res.status).toBe(200);
      expect(res.json.totalLeads).toBe(3);
      expect(res.json.appointments).toBe(1);
      expect(res.json.bookingRate).toBe(33);
    });

    it("toggle on: appointments tile gains pre-booked 1:1 with the lead tile", async () => {
      const { fixtures } = buildFixture();
      const off = await runStats(`${window}&includePreBooked=false`, fixtures);
      const on = await runStats(`${window}&includePreBooked=true`, fixtures);

      const offTotal = off.json.totalLeads as number;
      const onTotal = on.json.totalLeads as number;
      const offAppts = off.json.appointments as number;
      const onAppts = on.json.appointments as number;

      expect(onTotal - offTotal).toBe(2);
      expect(onAppts - offAppts).toBe(2);
      expect(onTotal - offTotal).toBe(onAppts - offAppts);

      // 3 appointments / 5 leads = 60% headline booking rate
      expect(on.json.bookingRate).toBe(60);
    });
  });

  it("counts pre-booked leads as bookings even when their hub_status has progressed (sold/dead)", async () => {
    // The whole regression class: leads 4 (sold) and 5 (dead) are pre-booked
    // and would NOT match "appt_set"/"appt_booked" anymore. Toggling on must
    // still count them as bookings, otherwise +N leads come with +0
    // bookings and the booking-rate tile collapses.
    const { fixtures } = buildFixture();
    const on = await runStats("?includePreBooked=true", fixtures);

    expect(on.json.totalLeads).toBe(5);
    // 1 actual appt_set + 2 pre-booked-with-progressed-status = 3
    expect(on.json.appointments).toBe(3);
    expect(on.json.bookedInWindow).toBe(3);
  });

  it("spiff dollars stay excluded from pre-booked leads regardless of toggle state", async () => {
    const { fixtures } = buildFixture();
    const off = await runStats("?includePreBooked=false", fixtures);
    const on = await runStats("?includePreBooked=true", fixtures);

    // Only the single non-pre-booked booked row earns spiff (1 × $25 default).
    // Pre-booked leads must never produce spiff payouts, so toggling the
    // dashboard view doesn't change this number.
    expect(off.json.spiffEarned).toBe(25);
    expect(on.json.spiffEarned).toBe(25);
  });

  it("bySource breakdown reconciles with the headline appointments count", async () => {
    const { fixtures } = buildFixture();

    for (const toggle of ["false", "true"]) {
      const res = await runStats(`?includePreBooked=${toggle}`, fixtures);
      const bySource = res.json.bySource as Array<{ appointments: number; total: number }>;

      const sourceApptSum = bySource.reduce((s, r) => s + r.appointments, 0);
      const sourceLeadSum = bySource.reduce((s, r) => s + r.total, 0);
      expect(sourceApptSum).toBe(res.json.appointments);
      expect(sourceLeadSum).toBe(res.json.totalLeads);
    }
  });

  it("byFunnel breakdown reconciles with the headline appointments count", async () => {
    const { fixtures } = buildFixture();

    for (const toggle of ["false", "true"]) {
      const res = await runStats(`?includePreBooked=${toggle}`, fixtures);
      const byFunnel = res.json.byFunnel as Array<{ appointments: number; total: number }>;

      const funnelApptSum = byFunnel.reduce((s, r) => s + r.appointments, 0);
      const funnelLeadSum = byFunnel.reduce((s, r) => s + r.total, 0);
      expect(funnelApptSum).toBe(res.json.appointments);
      expect(funnelLeadSum).toBe(res.json.totalLeads);
    }
  });
});

describe("Pulse mobile getHudStats — unaffected by includePreBooked toggle", () => {
  it("hard-codes preBooked=false and exposes no toggle parameter", () => {
    // Source-level guard: the dashboard toggle lives only in the
    // /leads-hub/stats route. Pulse mobile's HUD calls getHudStats directly
    // and must keep its own pre-booked-exclusion contract — adding a toggle
    // there would silently change CSR-facing numbers and spiff payouts.
    const socketPath = path.join(__dirname, "..", "socket.ts");
    const src = readFileSync(socketPath, "utf8");

    const start = src.indexOf("export async function getHudStats");
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport ", start + 1);
    const body = next === -1 ? src.slice(start) : src.slice(start, next);

    // No toggle parameter, no toggle reference anywhere in the function.
    expect(body).not.toContain("includePreBooked");

    // Pre-booked is excluded in BOTH the appointments-counted condition and
    // the contacted-denominator condition.
    const occurrences = body.match(/eq\(leadsTable\.preBooked,\s*false\)/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});
