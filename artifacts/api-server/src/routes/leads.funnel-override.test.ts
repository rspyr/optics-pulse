import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #549: focused unit coverage for the per-lead funnel override endpoints
// (POST/DELETE /leads/:leadId/funnel-override). Other lead-route paths are
// covered elsewhere; this suite mocks every external dependency leads.ts
// imports so the override branch can run in isolation.

type SelectChain = {
  __name?: string;
};

const insertCalls: Array<{ table: string; values: unknown }> = [];
const updateCalls: Array<{ table: string; set: Record<string, unknown>; whereSqlIncludes: (s: string) => boolean }> = [];
const transactionMock = vi.fn();

let selectRowsQueue: Array<unknown[]> = [];

function makeWhereTracker() {
  let lastWhere: unknown[] = [];
  return {
    record(args: unknown[]) { lastWhere = args; },
    includes(s: string) { return JSON.stringify(lastWhere).includes(s); },
  };
}

vi.mock("@workspace/db", () => {
  const tables = {
    leadsTable: { __name: "leadsTable", id: "leads.id", tenantId: "leads.tenantId", funnelOverriddenAt: "leads.funnelOverriddenAt" },
    funnelTypesTable: { __name: "funnelTypesTable", id: "ft.id", name: "ft.name" },
    attributionEventsTable: { __name: "attributionEventsTable", id: "ae.id", tenantId: "ae.tenantId", resolvedFunnel: "ae.resolvedFunnel" },
    leadAttributionCorrectionsTable: { __name: "leadAttributionCorrectionsTable" },
    tenantFunnelTypesTable: { __name: "tenantFunnelTypesTable", tenantId: "tft.tenantId", funnelTypeId: "tft.funnelTypeId" },
    callAttemptsTable: { __name: "callAttemptsTable" },
    podiumMessagesTable: { __name: "podiumMessagesTable" },
    leadMergesTable: { __name: "leadMergesTable" },
  };
  const db: Record<string, unknown> = {
    select: vi.fn().mockImplementation(() => {
      const chain: SelectChain & Record<string, unknown> = {};
      chain.from = vi.fn().mockImplementation((tbl: { __name: string }) => {
        chain.__name = tbl.__name;
        return chain;
      });
      chain.where = vi.fn().mockImplementation((..._args: unknown[]) => {
        const next = selectRowsQueue.length > 0 ? selectRowsQueue.shift() : [];
        const obj: Record<string, unknown> = Promise.resolve(next) as unknown as Record<string, unknown>;
        // Allow .limit() chain too.
        (Object.assign(obj as object, {
          limit: vi.fn().mockImplementation(() => Promise.resolve(next)),
        }));
        return obj;
      });
      chain.limit = vi.fn().mockImplementation(() => {
        const next = selectRowsQueue.length > 0 ? selectRowsQueue.shift() : [];
        return Promise.resolve(next);
      });
      return chain;
    }),
    insert: vi.fn().mockImplementation((table: { __name: string }) => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        insertCalls.push({ table: table.__name, values: vals });
        return Promise.resolve(undefined);
      }),
    })),
    update: vi.fn().mockImplementation((table: { __name: string }) => {
      const tracker = makeWhereTracker();
      const call = { table: table.__name, set: {} as Record<string, unknown>, whereSqlIncludes: tracker.includes };
      updateCalls.push(call);
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        call.set = vals;
        return chain;
      });
      chain.where = vi.fn().mockImplementation((...args: unknown[]) => {
        tracker.record(args);
        return Promise.resolve(undefined);
      });
      return chain;
    }),
  };
  transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  db.transaction = transactionMock;
  return { db, ...tables };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ __op: "eq", col, val })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  count: vi.fn(() => ({ __op: "count" })),
  desc: vi.fn((c: unknown) => ({ __op: "desc", c })),
  sql: Object.assign((s: TemplateStringsArray) => ({ __sql: s.join("?") }), {}),
  SQL: class SQL {},
  inArray: vi.fn(() => ({ __op: "inArray" })),
  gte: vi.fn(() => ({ __op: "gte" })),
  lte: vi.fn(() => ({ __op: "lte" })),
}));

const reDeriveLeadFunnelMock = vi.fn().mockResolvedValue(undefined);
const redetectAndPersistEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/re-derive-lead-funnel", () => ({
  reDeriveLeadFunnel: reDeriveLeadFunnelMock,
  redetectAndPersistEvent: redetectAndPersistEventMock,
}));

vi.mock("../services/lead-rerouting", () => ({
  reRouteLeadsAfterAttributionChange: vi.fn().mockResolvedValue({ attempted: 0, reassigned: 0, skippedTouched: 0, skippedTerminal: 0 }),
}));

vi.mock("@workspace/api-zod", () => ({
  GetLeadParams: { parse: (p: { leadId: string }) => ({ leadId: Number(p.leadId) }) },
  ListLeadsQueryParams: { parse: (q: unknown) => q },
  UpdateLeadBody: { parse: (b: unknown) => b },
}));

vi.mock("../socket", () => ({
  emitLeadUpdated: vi.fn(),
  getHudStats: vi.fn().mockResolvedValue({}),
}));

vi.mock("../services/integrations/communication", () => ({
  initiateCall: vi.fn(),
  initiateText: vi.fn(),
  getTenantCommConfig: vi.fn(),
  getCommConfigStatus: vi.fn(),
}));

vi.mock("../services/lead-scoring", () => ({ getSmartQueue: vi.fn() }));
vi.mock("../services/coordinator-stats", () => ({
  getComparisonStats: vi.fn(), getHistoricalStats: vi.fn(), aggregateDailyStats: vi.fn(),
}));
vi.mock("../services/parse-filter", () => ({ parseFilterQuery: vi.fn() }));
vi.mock("../lib/tenant-scope", () => ({
  resolveListTenantScope: vi.fn(),
  assertResourceTenantAccess: vi.fn(),
}));
vi.mock("../services/lead-booking-cache", () => ({ resetBookingCache: vi.fn() }));

import express, { type Request, type Response, type NextFunction } from "express";

let app: express.Express;

async function setupApp(role: string, tenantId: number, userId = 7) {
  vi.resetModules();
  insertCalls.length = 0;
  updateCalls.length = 0;
  selectRowsQueue = [];
  reDeriveLeadFunnelMock.mockClear();
  redetectAndPersistEventMock.mockClear();
  const mod = await import("./leads");
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: { userRole?: string; tenantId?: number | null; userId?: number } }).session = {
      userRole: role,
      tenantId,
      userId,
    };
    next();
  });
  app.use(mod.default);
}

function request(method: "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body !== undefined ? JSON.stringify(body) : "";
      const req = http.request(
        {
          hostname: "127.0.0.1", port, path, method,
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        },
        (res: { statusCode: number; on: Function }) => {
          let data = "";
          res.on("data", (c: string) => (data += c));
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

describe("POST /leads/:leadId/funnel-override — Task #549", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("400s when funnelTypeId is missing or invalid", async () => {
    selectRowsQueue.push([{ id: 555, tenantId: 42, leadType: "ac" }]);
    const res = await request("POST", "/leads/555/funnel-override", { funnelTypeId: 0 });
    expect(res.status).toBe(400);
    expect(updateCalls.some(c => c.table === "leadsTable")).toBe(false);
  });

  it("404s when the lead does not exist", async () => {
    selectRowsQueue.push([]);
    const res = await request("POST", "/leads/999/funnel-override", { funnelTypeId: 5 });
    expect(res.status).toBe(404);
  });

  it("rejects cross-tenant access for non-admin sessions", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([{ id: 555, tenantId: 99, leadType: "ac" }]);
    const res = await request("POST", "/leads/555/funnel-override", { funnelTypeId: 5 });
    expect(res.status).toBe(403);
    expect(updateCalls.some(c => c.table === "leadsTable")).toBe(false);
  });

  it("rejects a funnel type that is not enabled for the tenant", async () => {
    selectRowsQueue.push([{ id: 555, tenantId: 42, leadType: "ac" }]); // existing lead
    selectRowsQueue.push([{ id: 5, name: "Webinar" }]);                 // funnel type lookup
    selectRowsQueue.push([]);                                            // tenant_funnel_types empty
    const res = await request("POST", "/leads/555/funnel-override", { funnelTypeId: 5 });
    expect(res.status).toBe(400);
    expect(updateCalls.some(c => c.table === "leadsTable")).toBe(false);
  });

  it("pins funnel fields, stamps funnel_overridden_at, writes audit row, and tenant-scopes the event update", async () => {
    selectRowsQueue.push([{ id: 555, tenantId: 42, leadType: "ac" }]); // existing lead
    selectRowsQueue.push([{ id: 5, name: "Webinar" }]);                 // funnel type
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]);          // tenant assoc
    selectRowsQueue.push([{ id: 555, tenantId: 42, leadType: "Webinar" }]); // post-update reload

    const res = await request("POST", "/leads/555/funnel-override", { funnelTypeId: 5, attributionEventId: 1234 });

    expect(res.status).toBe(200);
    const leadUpdate = updateCalls.find(c => c.table === "leadsTable");
    expect(leadUpdate?.set.leadType).toBe("Webinar");
    expect(leadUpdate?.set.funnelId).toBe(5);
    expect(leadUpdate?.set.funnelOverriddenAt).toBeInstanceOf(Date);
    expect(leadUpdate?.set.funnelOverriddenByUserId).toBe(7);

    const audit = insertCalls.find(c => c.table === "leadAttributionCorrectionsTable");
    expect(audit).toBeDefined();
    expect((audit?.values as { field: string }).field).toBe("funnel");
    expect((audit?.values as { newValue: string }).newValue).toBe("Webinar");

    // Event update must be tenant-scoped in the WHERE clause itself.
    const eventUpdate = updateCalls.find(c => c.table === "attributionEventsTable");
    expect(eventUpdate?.set.resolvedFunnel).toBe("Webinar");
    expect(eventUpdate?.whereSqlIncludes("ae.tenantId")).toBe(true);
  });
});

describe("DELETE /leads/:leadId/funnel-override — Task #549", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("returns cleared=false when the lead has no override", async () => {
    selectRowsQueue.push([{ id: 555, tenantId: 42, leadType: "Webinar", funnelOverriddenAt: null }]);
    const res = await request("DELETE", "/leads/555/funnel-override");
    expect(res.status).toBe(200);
    expect(res.json.cleared).toBe(false);
    expect(updateCalls.some(c => c.table === "leadsTable")).toBe(false);
    expect(reDeriveLeadFunnelMock).not.toHaveBeenCalled();
  });

  it("clears the override, re-derives the lead, and redetects the open event when attributionEventId is provided", async () => {
    selectRowsQueue.push([{ id: 555, tenantId: 42, leadType: "Webinar", funnelOverriddenAt: new Date() }]);
    selectRowsQueue.push([{ tenantId: 42 }]); // event tenant lookup
    selectRowsQueue.push([{ id: 555, tenantId: 42, leadType: "ac", funnelOverriddenAt: null }]); // reload

    const res = await request("DELETE", "/leads/555/funnel-override?attributionEventId=1234");

    expect(res.status).toBe(200);
    expect(res.json.cleared).toBe(true);
    const leadUpdate = updateCalls.find(c => c.table === "leadsTable");
    expect(leadUpdate?.set.funnelOverriddenAt).toBeNull();
    expect(leadUpdate?.set.funnelOverriddenByUserId).toBeNull();
    expect(reDeriveLeadFunnelMock).toHaveBeenCalledWith(42, 555);
    expect(redetectAndPersistEventMock).toHaveBeenCalledWith(42, 1234);
  });

  it("does not redetect an event that belongs to a different tenant", async () => {
    selectRowsQueue.push([{ id: 555, tenantId: 42, leadType: "Webinar", funnelOverriddenAt: new Date() }]);
    selectRowsQueue.push([{ tenantId: 99 }]); // cross-tenant event
    selectRowsQueue.push([{ id: 555, tenantId: 42, leadType: "ac" }]); // reload

    const res = await request("DELETE", "/leads/555/funnel-override?attributionEventId=1234");

    expect(res.status).toBe(200);
    expect(redetectAndPersistEventMock).not.toHaveBeenCalled();
  });
});
