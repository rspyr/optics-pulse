import { describe, it, expect, vi, beforeEach } from "vitest";

const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; set: Record<string, unknown> }> = [];
let selectRowsQueue: Array<unknown[]> = [];
let updateReturning: unknown[] = [];

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
              returning: vi.fn().mockImplementation(() => Promise.resolve(updateReturning)),
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
  updateReturning = [];
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

describe("POST /funnel-aliases — re-resolve historical events", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("inserts the alias and re-resolves matching attribution events to the canonical funnel name", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]); // tenant association
    selectRowsQueue.push([]); // no existing alias row
    selectRowsQueue.push([{ name: "BOGO Free Smart Furnace" }]); // funnel type lookup
    updateReturning = [{ id: 101 }, { id: 102 }];

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "AC Breakdown Prevention",
    });

    expect(res.status).toBe(200);
    expect(insertCalls.some(c => c.table === "funnelAliasesTable")).toBe(true);
    expect(updateCalls.some(c => c.table === "attributionEventsTable" && c.set.resolvedFunnel === "BOGO Free Smart Furnace")).toBe(true);
    expect(res.json.updatedEventCount).toBe(2);
  });

  it("is a 200 no-op when the alias already maps to the same funnel type (no event update)", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]);
    selectRowsQueue.push([{ id: 7, alias: "ac breakdown prevention", funnelTypeId: 5 }]);

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "AC Breakdown Prevention",
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedEventCount).toBe(0);
    expect(insertCalls.some(c => c.table === "funnelAliasesTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "attributionEventsTable")).toBe(false);
  });

  it("returns 409 when the alias is mapped to a different funnel type and does not update events", async () => {
    selectRowsQueue.push([{ tenantId: 42, funnelTypeId: 5 }]);
    selectRowsQueue.push([{ id: 7, alias: "ac breakdown prevention", funnelTypeId: 9 }]);

    const res = await postJson(app, "/funnel-aliases?tenantId=42", {
      funnelTypeId: 5,
      alias: "AC Breakdown Prevention",
    });

    expect(res.status).toBe(409);
    expect(insertCalls.some(c => c.table === "funnelAliasesTable")).toBe(false);
    expect(updateCalls.some(c => c.table === "attributionEventsTable")).toBe(false);
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
  });
});
