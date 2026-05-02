import { describe, it, expect, vi, beforeEach } from "vitest";

const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; set: Record<string, unknown> }> = [];
const selectWhereArgs: unknown[][] = [];
let selectRowsQueue: Array<unknown[]> = [];
let updateReturningQueue: Array<{ table: string; rows: unknown[] }> = [];

vi.mock("@workspace/db", () => {
  const tables = {
    leadSourceAliasesTable: { __name: "leadSourceAliasesTable", id: "id", tenantId: "tenantId", canonicalName: "canonicalName", alias: "alias" },
    attributionEventsTable: {
      __name: "attributionEventsTable",
      id: "id",
      tenantId: "tenantId",
      utmSource: "utmSource",
      referrer: "referrer",
      resolvedLeadSource: "resolvedLeadSource",
    },
    leadsTable: { __name: "leadsTable", id: "id", tenantId: "tenantId", source: "source" },
    leadAttributionCorrectionsTable: { __name: "leadAttributionCorrectionsTable" },
  };
  const db: Record<string, unknown> = {
    select: vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
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
  return { db, ...tables };
});

vi.mock("../services/source-normalizer", () => ({
  invalidateSourceCache: vi.fn(),
  DEFAULT_SOURCE_ALIASES: [],
  normalizeSource: vi.fn(),
}));

vi.mock("../services/lead-rerouting", () => ({
  reRouteLeadsAfterAttributionChange: vi.fn().mockResolvedValue({ attempted: 0, reassigned: 0, skippedTouched: 0, skippedTerminal: 0 }),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  inArray: vi.fn((...args: unknown[]) => ({ __op: "inArray", args })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => ({ __sql: strings.join("?") }),
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
  const mod = await import("./lead-source-aliases");
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

describe("POST /lead-source-aliases — re-resolve historical events and leads", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("inserts the alias, re-resolves matching events, and propagates to leads.source", async () => {
    selectRowsQueue.push([]); // no existing alias row
    // snapshot select for matched leads (id + oldSource)
    selectRowsQueue.push([{ id: 501, oldSource: "fb" }, { id: 502, oldSource: "facebook" }]);
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 101 }, { id: 102 }, { id: 103 }] });

    const res = await postJson(app, "/lead-source-aliases?tenantId=42", {
      canonicalName: "Meta",
      alias: "https://facebook.com/",
    });

    expect(res.status).toBe(200);
    expect(insertCalls.some(c => c.table === "leadSourceAliasesTable")).toBe(true);
    const eventUpdate = updateCalls.find(c => c.table === "attributionEventsTable");
    expect(eventUpdate?.set.resolvedLeadSource).toBe("Meta");
    const leadUpdate = updateCalls.find(c => c.table === "leadsTable");
    expect(leadUpdate?.set.source).toBe("Meta");
    expect(res.json.updatedEventCount).toBe(3);
    expect(res.json.updatedLeadCount).toBe(2);
    // Per-lead audit rows must be written with the prior raw value, not the alias key.
    const auditInsert = insertCalls.find(c => c.table === "leadAttributionCorrectionsTable");
    expect(auditInsert).toBeDefined();
    const auditRows = auditInsert!.values as unknown as Array<{ leadId: number; oldValue: string; newValue: string; field: string }>;
    expect(auditRows.map(r => r.leadId).sort()).toEqual([501, 502]);
    expect(auditRows.every(r => r.field === "source" && r.newValue === "Meta")).toBe(true);
    expect(auditRows.find(r => r.leadId === 501)?.oldValue).toBe("fb");
  });

  it("widens lead matching via attribution_events.created_lead_id even when leads.source does not equal the alias key", async () => {
    selectRowsQueue.push([]); // no existing alias row
    // Snapshot returns a lead whose denormalized source is "form" (i.e.
    // would NOT match the alias key directly), but is matched via the
    // event linkage OR-branch — the helper trusts the snapshot here.
    selectRowsQueue.push([{ id: 777, oldSource: "form" }]);
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 9001 }] });

    const res = await postJson(app, "/lead-source-aliases?tenantId=42", {
      canonicalName: "Meta",
      alias: "https://facebook.com/",
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedLeadCount).toBe(1);
    const leadUpdate = updateCalls.find(c => c.table === "leadsTable");
    expect(leadUpdate?.set.source).toBe("Meta");
    // Audit row must capture the actual prior value ("form"), not the alias key.
    const auditInsert = insertCalls.find(c => c.table === "leadAttributionCorrectionsTable");
    const auditRows = auditInsert!.values as unknown as Array<{ leadId: number; oldValue: string }>;
    expect(auditRows[0]).toMatchObject({ leadId: 777, oldValue: "form" });
    // And the leads-snapshot WHERE-clause must reference attribution_events
    // so the SQL widening is actually in place — guards against regressing
    // back to the direct-match-only matcher.
    const matchedLeadsWhere = selectWhereArgs.find(args =>
      JSON.stringify(args).includes("attribution_events"),
    );
    expect(matchedLeadsWhere).toBeDefined();
  });

  it("is a 200 no-op when the alias already maps to the same canonical (no event or lead update)", async () => {
    selectRowsQueue.push([{ id: 7, alias: "fb", canonicalName: "Meta" }]);

    const res = await postJson(app, "/lead-source-aliases?tenantId=42", {
      canonicalName: "Meta",
      alias: "fb",
    });

    expect(res.status).toBe(200);
    expect(insertCalls.some(c => c.table === "leadSourceAliasesTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "attributionEventsTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "leadsTable")).toBe(false);
  });

  it("returns 409 when the alias is mapped to a different canonical and does not touch events or leads", async () => {
    selectRowsQueue.push([{ id: 7, alias: "fb", canonicalName: "Meta" }]);

    const res = await postJson(app, "/lead-source-aliases?tenantId=42", {
      canonicalName: "Google",
      alias: "fb",
    });

    expect(res.status).toBe(409);
    expect(insertCalls.some(c => c.table === "leadSourceAliasesTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "attributionEventsTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "leadsTable")).toBe(false);
  });

  it("scopes the leads update by tenant so other tenants are untouched", async () => {
    selectRowsQueue.push([]); // no existing alias row
    selectRowsQueue.push([{ id: 501, oldSource: "fb" }]); // snapshot
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [] });

    await postJson(app, "/lead-source-aliases?tenantId=42", {
      canonicalName: "Meta",
      alias: "fb",
    });

    const leadUpdate = updateCalls.find(c => c.table === "leadsTable");
    expect(leadUpdate).toBeDefined();
    expect(leadUpdate?.set.source).toBe("Meta");
    expect(leadUpdate?.set.updatedAt).toBeInstanceOf(Date);
  });

  it("returns updatedLeadCount=0 even when no leads matched", async () => {
    selectRowsQueue.push([]);
    selectRowsQueue.push([]); // empty snapshot
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 101 }] });

    const res = await postJson(app, "/lead-source-aliases?tenantId=42", {
      canonicalName: "Meta",
      alias: "fb",
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedEventCount).toBe(1);
    expect(res.json.updatedLeadCount).toBe(0);
  });
});

describe("POST /lead-source-aliases/bulk — re-resolve historical events and leads", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("propagates each newly created alias to leads.source and reports the totals", async () => {
    // Two aliases, both new
    selectRowsQueue.push([]); // existing check for alias 1
    selectRowsQueue.push([]); // existing check for alias 2
    // Per-alias loop runs reResolveSourceForAlias (event update) then
    // reResolveSourceForLeads (snapshot select). Order of selects after
    // the two existing checks: snapshot for alias 1, snapshot for alias 2.
    selectRowsQueue.push([{ id: 501, oldSource: "fb" }]);
    selectRowsQueue.push([{ id: 502, oldSource: "x" }, { id: 503, oldSource: "y" }, { id: 504, oldSource: "z" }]);
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 1 }] });
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 2 }, { id: 3 }] });

    const res = await postJson(app, "/lead-source-aliases/bulk?tenantId=42", {
      canonicalName: "Meta",
      aliases: ["fb", "facebook"],
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedEventCount).toBe(3);
    expect(res.json.updatedLeadCount).toBe(4);
    expect(updateCalls.filter(c => c.table === "leadsTable").length).toBe(2);
  });
});
