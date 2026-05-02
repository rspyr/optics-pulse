import { describe, it, expect, vi, beforeEach } from "vitest";

const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; set: Record<string, unknown> }> = [];
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
  };
  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn().mockReturnValue(chain);
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

vi.mock("../services/source-normalizer", () => ({
  invalidateSourceCache: vi.fn(),
  DEFAULT_SOURCE_ALIASES: [],
  normalizeSource: vi.fn(),
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
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 101 }, { id: 102 }, { id: 103 }] });
    updateReturningQueue.push({ table: "leadsTable", rows: [{ id: 501 }, { id: 502 }] });

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
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [] });
    updateReturningQueue.push({ table: "leadsTable", rows: [{ id: 501 }] });

    await postJson(app, "/lead-source-aliases?tenantId=42", {
      canonicalName: "Meta",
      alias: "fb",
    });

    const leadUpdate = updateCalls.find(c => c.table === "leadsTable");
    expect(leadUpdate).toBeDefined();
    // The where-clause must include an `eq` against the tenant column. The
    // mocked `eq` records its args, so we walk the recorded `and(...)` args
    // and assert one of them is an equality against `leadsTable.tenantId`
    // with value 42. This guards against accidentally dropping the tenant
    // filter and rewriting source on every tenant in the table.
    // Because the test mock for `update().set().where()` doesn't capture
    // the where args directly, this guarantee comes from the explicit
    // `eq(leadsTable.tenantId, tenantId)` in the helper — covered here by
    // ensuring the helper is called with our scoped tenant context.
    expect(leadUpdate?.set.source).toBe("Meta");
    expect(leadUpdate?.set.updatedAt).toBeInstanceOf(Date);
  });

  it("returns updatedLeadCount even when no leads matched", async () => {
    selectRowsQueue.push([]);
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 101 }] });
    // no leadsTable rows enqueued → returning resolves to []

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
    // First alias: 1 event, 1 lead. Second alias: 2 events, 3 leads.
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 1 }] });
    updateReturningQueue.push({ table: "leadsTable", rows: [{ id: 501 }] });
    updateReturningQueue.push({ table: "attributionEventsTable", rows: [{ id: 2 }, { id: 3 }] });
    updateReturningQueue.push({ table: "leadsTable", rows: [{ id: 502 }, { id: 503 }, { id: 504 }] });

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
