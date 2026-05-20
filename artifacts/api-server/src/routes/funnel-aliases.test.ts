import { describe, it, expect, vi, beforeEach } from "vitest";

const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; set: Record<string, unknown> }> = [];
const selectWhereArgs: unknown[][] = [];
let selectRowsQueue: Array<unknown[]> = [];
let updateReturningQueue: Array<{ table: string; rows: unknown[] }> = [];
let executeRowsQueue: Array<unknown[]> = [];

vi.mock("@workspace/db", () => {
  const tables = {
    funnelAliasesTable: { __name: "funnelAliasesTable", id: "id", tenantId: "tenantId", funnelTypeId: "funnelTypeId", alias: "alias" },
    funnelTypesTable: { __name: "funnelTypesTable", id: "id", name: "name", slug: "slug" },
    tenantFunnelTypesTable: { __name: "tenantFunnelTypesTable", tenantId: "tenantId", funnelTypeId: "funnelTypeId" },
    googleSheetConfigsTable: { __name: "googleSheetConfigsTable" },
    attributionEventsTable: {
      __name: "attributionEventsTable",
      id: "id",
      tenantId: "tenantId",
      resolvedFunnel: "resolvedFunnel",
      formFields: "formFields",
    },
    leadsTable: { __name: "leadsTable", id: "id", tenantId: "tenantId", leadType: "leadType", funnelId: "funnelId", funnelOverriddenAt: "funnel_overridden_at" },
    leadAttributionCorrectionsTable: { __name: "leadAttributionCorrectionsTable" },
  };
  const db: Record<string, unknown> = {
    select: vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.innerJoin = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockImplementation((...args: unknown[]) => {
        selectWhereArgs.push(args);
        const next = selectRowsQueue.length > 0 ? selectRowsQueue.shift() : [];
        return Promise.resolve(next);
      });
      chain.orderBy = vi.fn().mockImplementation(() => {
        const next = selectRowsQueue.length > 0 ? selectRowsQueue.shift() : [];
        return Promise.resolve(next);
      });
      return chain;
    }),
    insert: vi.fn().mockImplementation((table: { __name: string }) => ({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        insertCalls.push({ table: table.__name, values: vals });
        return {
          returning: vi.fn().mockResolvedValue([{ id: 99, ...vals }]),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      }),
    })),
    update: vi.fn().mockImplementation((table: { __name: string }) => ({
      set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        updateCalls.push({ table: table.__name, set: vals });
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockImplementation(() => {
              const idx = updateReturningQueue.findIndex(e => e.table === table.__name);
              if (idx >= 0) {
                return Promise.resolve(updateReturningQueue.splice(idx, 1)[0].rows);
              }
              return Promise.resolve([]);
            }),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
          }),
        };
      }),
    })),
  };
  // The lead-update + audit-insert is wrapped in db.transaction(); resolve
  // by passing the same mocked db as the transaction handle so insert /
  // update calls inside the callback flow into the same tracking arrays.
  db.transaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  // Task #549: /funnel-aliases/preview uses raw db.execute. Honor a queue of
  // canned row arrays so each preview test can return its own counts.
  db.execute = vi.fn().mockImplementation(() => {
    const next = executeRowsQueue.length > 0 ? executeRowsQueue.shift()! : [];
    return Promise.resolve({ rows: next });
  });
  return { db, ...tables };
});

vi.mock("../services/funnel-normalizer", () => ({
  invalidateFunnelCache: vi.fn(),
}));

vi.mock("../services/integrations/google-sheets", () => ({
  readRawSheetData: vi.fn(),
}));

vi.mock("../services/lead-rerouting", () => ({
  reRouteLeadsAfterAttributionChange: vi.fn().mockResolvedValue({ attempted: 0, reassigned: 0, skippedTouched: 0, skippedTerminal: 0 }),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  inArray: vi.fn((...args: unknown[]) => ({ __op: "inArray", args })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      __sql: strings.join("?"),
      // Surface interpolated column refs so tests can assert that the
      // override-exclusion column appears in the WHERE clause.
      __values: values,
    }),
    {},
  ),
}));

import express, { type Request, type Response, type NextFunction } from "express";

let app: express.Express;

async function setupApp(role: string | undefined, tenantId: number | null) {
  vi.resetModules();
  insertCalls.length = 0;
  updateCalls.length = 0;
  selectWhereArgs.length = 0;
  selectRowsQueue = [];
  updateReturningQueue = [];
  executeRowsQueue = [];
  const mod = await import("./funnel-aliases");
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: { userRole?: string; tenantId?: number | null } }).session = {
      userRole: role,
      tenantId,
    };
    next();
  });
  app.use(mod.default);
}

function postJson(
  expressApp: express.Express,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(expressApp);
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
            resolve({
              status: res.statusCode,
              json: data ? JSON.parse(data) : {},
            });
          });
        },
      );
      req.write(payload);
      req.end();
    });
  });
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

describe("POST /funnel-aliases — re-resolve historical events and leads", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("inserts the alias, re-resolves matching events, and propagates to leads.lead_type/funnel_id", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]); // tenant association
    selectRowsQueue.push([]); // no existing alias row
    selectRowsQueue.push([{ name: "BOGO Free Smart Furnace" }]); // funnel type lookup
    // snapshot select for matched leads (id + oldLeadType)
    selectRowsQueue.push([
      { id: 501, oldLeadType: "ac" },
      { id: 502, oldLeadType: "ac" },
      { id: 503, oldLeadType: "ac" },
      { id: 504, oldLeadType: "ac" },
    ]);
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 101 }, { id: 102 }] });

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "AC Breakdown Prevention",
    });

    expect(res.status).toBe(200);
    expect(insertCalls.some(c => c.table === "funnelAliasesTable")).toBe(true);
    const eventUpdate = updateCalls.find(c => c.table === "attributionEventsTable");
    expect(eventUpdate?.set.resolvedFunnel).toBe("BOGO Free Smart Furnace");
    const leadUpdate = updateCalls.find(c => c.table === "leadsTable");
    expect(leadUpdate?.set.leadType).toBe("BOGO Free Smart Furnace");
    expect(leadUpdate?.set.funnelId).toBe(5);
    expect(leadUpdate?.set.updatedAt).toBeInstanceOf(Date);
    expect(res.json.updatedEventCount).toBe(2);
    expect(res.json.updatedLeadCount).toBe(4);
  });

  it("widens lead matching via attribution_events.created_lead_id even when leads.lead_type does not equal the alias key", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]); // tenant association
    selectRowsQueue.push([]); // no existing alias row
    selectRowsQueue.push([{ name: "BOGO Free Smart Furnace" }]); // funnel type lookup
    // Snapshot returns a lead whose lead_type is something else entirely
    // ("service") but is matched via the event linkage OR-branch.
    selectRowsQueue.push([{ id: 777, oldLeadType: "service" }]);
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 9001 }] });

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "AC Breakdown Prevention",
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedLeadCount).toBe(1);
    const leadUpdate = updateCalls.find(c => c.table === "leadsTable");
    expect(leadUpdate?.set.leadType).toBe("BOGO Free Smart Furnace");
    expect(leadUpdate?.set.funnelId).toBe(5);
    // Audit row must capture the actual prior lead_type ("service"), not
    // the alias key.
    const auditInsert = insertCalls.find(c => c.table === "leadAttributionCorrectionsTable");
    const auditRows = auditInsert!.values as unknown as Array<{ leadId: number; oldValue: string; field: string }>;
    expect(auditRows[0]).toMatchObject({ leadId: 777, oldValue: "service", field: "funnel" });
    // Guards against regressing back to direct-match-only matcher: the
    // leads-snapshot WHERE-clause must reference attribution_events and
    // form_fields (the OR-branch SQL).
    const matchedLeadsWhere = selectWhereArgs.find(args => {
      const j = JSON.stringify(args);
      return j.includes("attribution_events") && j.includes("form_fields");
    });
    expect(matchedLeadsWhere).toBeDefined();
  });

  it("is a 200 no-op when the alias already maps to the same funnel type (no event or lead update)", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]);
    selectRowsQueue.push([{ id: 7, alias: "ac breakdown prevention", funnelTypeId: 5 }]);

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "AC Breakdown Prevention",
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedEventCount).toBe(0);
    expect(res.json.updatedLeadCount).toBe(0);
    expect(insertCalls.some(c => c.table === "funnelAliasesTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "attributionEventsTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "leadsTable")).toBe(false);
  });

  it("returns 409 when the alias is mapped to a different funnel type and does not update events or leads", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]);
    selectRowsQueue.push([{ id: 7, alias: "ac breakdown prevention", funnelTypeId: 9 }]);

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "AC Breakdown Prevention",
    });

    expect(res.status).toBe(409);
    expect(insertCalls.some(c => c.table === "funnelAliasesTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "attributionEventsTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "leadsTable")).toBe(false);
  });

  it("rejects when funnel type is not enabled for the tenant", async () => {
    selectRowsQueue.push([]); // no tenant association

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "anything",
    });

    expect(res.status).toBe(400);
    expect(insertCalls.some(c => c.table === "funnelAliasesTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "attributionEventsTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "leadsTable")).toBe(false);
  });

  // Task #549: a tenant-wide alias retag must skip every lead that already
  // carries a per-lead override. The exclusion lives in the WHERE clause of
  // the leads-snapshot select inside reResolveFunnelForLeads.
  it("excludes leads with funnel_overridden_at set from tenant-wide alias retag", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]); // tenant association
    selectRowsQueue.push([]); // no existing alias row
    selectRowsQueue.push([{ name: "BOGO Free Smart Furnace" }]); // funnel type lookup
    selectRowsQueue.push([{ id: 501, oldLeadType: "ac" }]); // snapshot
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 101 }] });

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "AC Breakdown Prevention",
    });

    expect(res.status).toBe(200);
    // The matched-leads WHERE clause must reference funnel_overridden_at.
    // Drizzle's sql template renders ${leadsTable.funnelOverriddenAt} as
    // the column identifier we put on the mocked table.
    // The matched-leads WHERE clause must reference the override column
    // (mocked as the column identifier "funnel_overridden_at") and the SQL
    // fragment "? IS NULL" so a future refactor can't drop the exclusion.
    const matchedLeadsWhere = selectWhereArgs.find(args => {
      const j = JSON.stringify(args);
      return j.includes("funnel_overridden_at") && j.includes("? IS NULL");
    });
    expect(matchedLeadsWhere).toBeDefined();
  });

  it("returns updatedLeadCount=0 when no leads matched", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]);
    selectRowsQueue.push([]);
    selectRowsQueue.push([{ name: "BOGO Free Smart Furnace" }]);
    selectRowsQueue.push([]); // empty snapshot
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 101 }] });

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "AC Breakdown Prevention",
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedEventCount).toBe(1);
    expect(res.json.updatedLeadCount).toBe(0);
  });
});

describe("GET /funnel-aliases/preview — Task #549 dry-run scope", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("returns the canonical name plus the count of events and leads that would be retagged", async () => {
    selectRowsQueue.push([{ name: "Webinar" }]); // funnel type lookup
    executeRowsQueue.push([{ cnt: 12 }]); // events count
    executeRowsQueue.push([{ cnt: 47 }]); // leads count

    const res = await getJson(app, "/funnel-aliases/preview?tenantId=42&alias=ac%20breakdown%20prevention&funnelTypeId=5");

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ events: 12, leads: 47, canonicalName: "Webinar", alias: "ac breakdown prevention", funnelTypeId: 5 });
  });

  it("400s when alias or funnelTypeId is missing", async () => {
    const res = await getJson(app, "/funnel-aliases/preview?tenantId=42&alias=&funnelTypeId=5");
    expect(res.status).toBe(400);
  });
});

describe("POST /funnel-aliases/bulk — re-resolve historical events and leads", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("propagates each newly created alias to leads and reports the totals", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]); // tenant association
    selectRowsQueue.push([]); // existing check for alias 1
    selectRowsQueue.push([]); // existing check for alias 2
    selectRowsQueue.push([{ name: "BOGO Free Smart Furnace" }]); // funnel type lookup once
    // Per-alias snapshot selects (1 row for alias 1, 3 rows for alias 2)
    selectRowsQueue.push([{ id: 501, oldLeadType: "x" }]);
    selectRowsQueue.push([{ id: 502, oldLeadType: "y" }, { id: 503, oldLeadType: "z" }, { id: 504, oldLeadType: "w" }]);
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 1 }] });
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 2 }, { id: 3 }] });

    const res = await postJson(app, "/funnel-aliases/bulk?tenantId=42", {
      funnelTypeId: 5,
      aliases: ["ac breakdown prevention", "ac repair"],
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedEventCount).toBe(3);
    expect(res.json.updatedLeadCount).toBe(4);
    expect(updateCalls.filter(c => c.table === "leadsTable").length).toBe(2);
  });

  it("rejects bulk when funnel type is not enabled for the tenant", async () => {
    selectRowsQueue.push([]); // no tenant association

    const res = await postJson(app, "/funnel-aliases/bulk?tenantId=42", {
      funnelTypeId: 5,
      aliases: ["fb"],
    });

    expect(res.status).toBe(400);
    expect(insertCalls.some(c => c.table === "funnelAliasesTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "leadsTable")).toBe(false);
  });
});
