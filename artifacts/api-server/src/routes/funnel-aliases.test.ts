import { describe, it, expect, vi, beforeEach } from "vitest";

const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; set: Record<string, unknown> }> = [];
let selectRowsQueue: Array<unknown[]> = [];
let updateReturningQueue: Array<{ table: string; rows: unknown[] }> = [];

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
    },
    leadsTable: { __name: "leadsTable", id: "id", tenantId: "tenantId", leadType: "leadType", funnelId: "funnelId" },
  };
  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn().mockReturnValue(chain);
        chain.innerJoin = vi.fn().mockReturnValue(chain);
        chain.where = vi.fn().mockImplementation(() => {
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
            }),
          };
        }),
      })),
    },
    ...tables,
  };
});

vi.mock("../services/funnel-normalizer", () => ({
  invalidateFunnelCache: vi.fn(),
}));

vi.mock("../services/integrations/google-sheets", () => ({
  readRawSheetData: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
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
  selectRowsQueue = [];
  updateReturningQueue = [];
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

describe("POST /funnel-aliases — re-resolve historical events and leads", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("inserts the alias, re-resolves matching events, and propagates to leads.lead_type/funnel_id", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]); // tenant association
    selectRowsQueue.push([]); // no existing alias row
    selectRowsQueue.push([{ name: "BOGO Free Smart Furnace" }]); // funnel type lookup
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 101 }, { id: 102 }] });
    updateReturningQueue.push({ table: "leadsTable", rows: [{ id: 501 }, { id: 502 }, { id: 503 }, { id: 504 }] });

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

  it("returns updatedLeadCount=0 when no leads matched", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]);
    selectRowsQueue.push([]);
    selectRowsQueue.push([{ name: "BOGO Free Smart Furnace" }]);
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 101 }] });
    // no leadsTable rows enqueued → returning resolves to []

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "AC Breakdown Prevention",
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedEventCount).toBe(1);
    expect(res.json.updatedLeadCount).toBe(0);
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
    // Per-alias re-resolve queue
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 1 }] });
    updateReturningQueue.push({ table: "leadsTable", rows: [{ id: 501 }] });
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 2 }, { id: 3 }] });
    updateReturningQueue.push({ table: "leadsTable", rows: [{ id: 502 }, { id: 503 }, { id: 504 }] });

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
