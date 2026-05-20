// Tracker funnel-resolution waterfall coverage.
//
// The /collect/submit handler resolves an event's funnel from several
// sources in a specific precedence order:
//   1. Explicit `custom.funnel` slug from the page (highest)
//   2. detection.funnelRawValue → funnel-alias match
//   3. URL **path** → funnel-alias match
//   4. URL **subdomain** → subdomain-funnel rule
//
// If none of those fire, the event is persisted with `resolved_funnel =
// NULL` (task #575 removed the prior "tenant's first active funnel"
// fallback — see tracker.ts for the rationale). These tests pin down
// the middle of the waterfall: subdomain rules lose to explicit path
// aliases, and an event with no resolver hit stays unmatched. They
// guard against accidentally re-ordering the steps in tracker.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = {
  insertCalls: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  selectResults: [] as unknown[][],
  insertResults: [] as unknown[][],
  _selectIdx: 0,
  _insertIdx: 0,
  reset() {
    this._selectIdx = 0;
    this._insertIdx = 0;
    this.insertCalls = [];
    this.selectResults = [];
    this.insertResults = [];
  },
};

interface Thenable extends Record<string, unknown> {
  then: (resolve: Function, reject?: Function) => Promise<unknown>;
  [Symbol.iterator]: () => Generator<unknown>;
}

function makeThenable(rows: unknown[]): Thenable {
  return {
    then: (resolve: Function, reject?: Function) =>
      Promise.resolve(rows).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
    [Symbol.iterator]: function* () { yield* rows; },
  };
}

function makeSelectChain(getRows: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const thenable = () => makeThenable(getRows());
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.leftJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(
    Object.assign(thenable(), {
      limit: vi.fn().mockImplementation(() => Promise.resolve(getRows())),
      orderBy: vi.fn().mockReturnValue(
        Object.assign(thenable(), {
          limit: vi.fn().mockImplementation(() => Promise.resolve(getRows())),
        }),
      ),
    }),
  );
  chain.orderBy = vi.fn().mockReturnValue(
    Object.assign(thenable(), {
      limit: vi.fn().mockImplementation(() => Promise.resolve(getRows())),
    }),
  );
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(getRows()));
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(getRows()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  return chain;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => {
      const idx = mockDb._selectIdx++;
      return makeSelectChain(() => mockDb.selectResults[idx] || []);
    }),
    insert: vi.fn().mockImplementation((tbl: unknown) => ({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        const idx = mockDb._insertIdx++;
        mockDb.insertCalls.push({ table: tbl, values: vals });
        return {
          returning: vi.fn().mockResolvedValue(mockDb.insertResults[idx] || [{ id: idx + 1 }]),
          then: (resolve: Function) =>
            Promise.resolve(mockDb.insertResults[idx] || [{ id: idx + 1 }]).then(resolve as (v: unknown) => unknown),
        };
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
  },
  trackerHeartbeatsTable: Symbol("trackerHeartbeatsTable"),
  tenantsTable: Symbol("tenantsTable"),
  attributionEventsTable: Symbol("attributionEventsTable"),
  leadsTable: Symbol("leadsTable"),
  funnelTypesTable: Symbol("funnelTypesTable"),
  tenantFunnelTypesTable: Symbol("tenantFunnelTypesTable"),
  callAttemptsTable: Symbol("callAttemptsTable"),
}));

vi.mock("../socket", () => ({
  emitNewLead: vi.fn(),
  emitNewAttributionEvent: vi.fn(),
  emitLeadUpdated: vi.fn(),
}));

vi.mock("../services/lead-notify-scheduler", () => ({
  scheduleOrEmitNewLead: vi.fn(),
}));

vi.mock("../services/tracker-audit", () => ({
  logTrackerAttempt: vi.fn().mockResolvedValue(null),
  updateTrackerAttempt: vi.fn().mockResolvedValue(undefined),
  logTrackerDiagnostic: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/round-robin", () => ({
  assignLeadRoundRobin: vi.fn().mockResolvedValue({ assignedCsrId: null, reason: "no CSRs" }),
}));

vi.mock("../services/auto-pass-scheduler", () => ({
  scheduleAutoPass: vi.fn(),
}));

vi.mock("../utils/appointment-validation", () => ({
  isValidAppointmentValue: vi.fn().mockReturnValue(false),
}));

vi.mock("../services/source-normalizer", () => ({
  normalizeSource: vi.fn().mockImplementation((_tid: number, src: string) => Promise.resolve(src)),
}));

vi.mock("../services/field-detection", () => ({
  detectFields: vi.fn().mockResolvedValue({
    pii: { firstName: null, lastName: null, email: null, phone: null },
    source: null,
    funnel: null,
    funnelRawValue: null, // never produce a detection match — keeps the
    serviceType: null,    //  spotlight on the URL-based stages.
    addressParts: { street: null, city: null, state: null, zip: null },
    formFields: null,
    fields: [],
  }),
}));

const normalizeFunnelMock = vi.fn();
vi.mock("../services/funnel-normalizer", () => ({
  normalizeFunnel: (...args: unknown[]) => normalizeFunnelMock(...args),
}));

const resolveSubdomainFunnelMock = vi.fn();
vi.mock("../services/subdomain-funnel-resolver", () => ({
  resolveSubdomainFunnel: (...args: unknown[]) => resolveSubdomainFunnelMock(...args),
}));

vi.mock("../services/reconciliation", () => ({
  normalizeAddress: vi.fn().mockImplementation((addr: string) => addr),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  gte: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
}));

import express from "express";

let app: express.Express;

async function setupApp() {
  vi.resetModules();
  const mod = await import("./tracker");
  app = express();
  app.use(express.json());
  app.use(mod.default);
}

function sendRequest(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "POST",
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
      req.write(payload);
      req.end();
    });
  });
}

function findEventInsert(): Record<string, unknown> {
  // First insert in the submit handler is the attribution event row. Lead
  // creation only fires when PII is present + tenant.leadIngestionMode
  // permits — these tests deliberately avoid both.
  const event = mockDb.insertCalls[0]?.values as Record<string, unknown>;
  expect(event).toBeDefined();
  return event;
}

describe("/collect/submit funnel resolution waterfall", () => {
  beforeEach(async () => {
    mockDb.reset();
    vi.clearAllMocks();
    normalizeFunnelMock.mockReset();
    resolveSubdomainFunnelMock.mockReset();
    await setupApp();
  });

  it("subdomain rule wins over the tenant default funnel", async () => {
    mockDb.selectResults = [
      [{ id: 1, name: "Tenant", leadIngestionMode: "sheets" }], // tenant lookup
    ];
    // No tenant-default lookup will be hit because subdomain matches first;
    // even if it were, we'd want a different value here to expose a regression.
    normalizeFunnelMock.mockResolvedValue(null); // no path alias match
    resolveSubdomainFunnelMock.mockResolvedValue({
      funnelTypeId: 77,
      funnelName: "Protection Plan",
    });

    const res = await sendRequest("/collect/submit", {
      client_id: "tenant-1",
      page_url: "https://protect.example.com/quote",
      fields: {},
    });

    expect(res.status).toBe(200);
    const ev = findEventInsert();
    expect(ev.resolvedFunnel).toBe("Protection Plan");
    expect(resolveSubdomainFunnelMock).toHaveBeenCalledTimes(1);
  });

  it("path alias wins over the subdomain rule (alias short-circuits)", async () => {
    mockDb.selectResults = [
      [{ id: 1, name: "Tenant", leadIngestionMode: "sheets" }],
    ];
    // Alias for the URL path resolves; subdomain rule, if consulted, would
    // resolve to a different funnel — the test asserts it's never consulted.
    normalizeFunnelMock.mockResolvedValue({
      funnelTypeId: 9,
      funnelName: "Smart Furnace",
    });
    resolveSubdomainFunnelMock.mockResolvedValue({
      funnelTypeId: 77,
      funnelName: "Protection Plan (should-not-win)",
    });

    const res = await sendRequest("/collect/submit", {
      client_id: "tenant-1",
      page_url: "https://protect.example.com/smart-furnace",
      fields: {},
    });

    expect(res.status).toBe(200);
    const ev = findEventInsert();
    expect(ev.resolvedFunnel).toBe("Smart Furnace");
    // Critical: the subdomain stage must be skipped once a funnel has
    // already been resolved by the path-alias stage.
    expect(resolveSubdomainFunnelMock).not.toHaveBeenCalled();
    // The alias lookup was called with the lowercased path, not the full URL.
    const aliasCall = normalizeFunnelMock.mock.calls[0];
    expect(aliasCall[1]).toBe("/smart-furnace");
  });

  it("persists resolved_funnel as null when neither path alias nor subdomain rule matches (task #575)", async () => {
    mockDb.selectResults = [
      [{ id: 1, name: "Tenant", leadIngestionMode: "sheets" }], // tenant lookup
    ];
    normalizeFunnelMock.mockResolvedValue(null);
    resolveSubdomainFunnelMock.mockResolvedValue(null);

    const res = await sendRequest("/collect/submit", {
      client_id: "tenant-1",
      page_url: "https://protect.example.com/contact",
      fields: {},
    });

    expect(res.status).toBe(200);
    const ev = findEventInsert();
    // Task #575 — the prior "first active funnel" fallback was removed.
    // Unmatched events are now surfaced explicitly via resolved_funnel = null.
    expect(ev.resolvedFunnel).toBeNull();
    // Both finer stages were still attempted.
    expect(normalizeFunnelMock).toHaveBeenCalled();
    expect(resolveSubdomainFunnelMock).toHaveBeenCalled();
  });

  it("does not consult the subdomain rule when there is no page_url and leaves resolved_funnel null", async () => {
    mockDb.selectResults = [
      [{ id: 1, name: "Tenant", leadIngestionMode: "sheets" }],
    ];
    normalizeFunnelMock.mockResolvedValue(null);
    resolveSubdomainFunnelMock.mockResolvedValue({ funnelTypeId: 77, funnelName: "Protect" });

    const res = await sendRequest("/collect/submit", {
      client_id: "tenant-1",
      fields: {},
    });

    expect(res.status).toBe(200);
    expect(resolveSubdomainFunnelMock).not.toHaveBeenCalled();
    const ev = findEventInsert();
    expect(ev.resolvedFunnel).toBeNull();
  });
});
