import { describe, it, expect, vi, beforeEach } from "vitest";

interface SelectCall {
  table: string;
  whereArgs: unknown[];
}

const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; set: Record<string, unknown>; whereArgs: unknown[] }> = [];
const deleteCalls: Array<{ table: string; whereArgs: unknown[] }> = [];
const selectCalls: SelectCall[] = [];
const executeCalls: Array<{ sql: unknown }> = [];

let selectRowsQueue: Array<unknown[]> = [];
let executeRowsQueue: Array<Array<Record<string, unknown>>> = [];
let updateReturningQueue: Array<unknown[]> = [];
let insertReturningQueue: Array<unknown[]> = [];

const tableNameForCurrentSelect: { current: string } = { current: "" };

vi.mock("@workspace/db", () => {
  const tables = {
    subdomainFunnelRulesTable: {
      __name: "subdomainFunnelRulesTable",
      id: "id",
      tenantId: "tenantId",
      subdomain: "subdomain",
      funnelTypeId: "funnelTypeId",
      createdAt: "createdAt",
    },
    funnelTypesTable: { __name: "funnelTypesTable", id: "id", name: "name", slug: "slug" },
    tenantFunnelTypesTable: {
      __name: "tenantFunnelTypesTable",
      tenantId: "tenantId",
      funnelTypeId: "funnelTypeId",
    },
    attributionEventsTable: {
      __name: "attributionEventsTable",
      id: "id",
      tenantId: "tenantId",
      pageUrl: "pageUrl",
      resolvedFunnel: "resolvedFunnel",
    },
    leadsTable: {
      __name: "leadsTable",
      id: "id",
      tenantId: "tenantId",
      leadType: "leadType",
      funnelId: "funnelId",
      updatedAt: "updatedAt",
    },
  };

  function makeTerminal(rows: unknown[]) {
    const t: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
      limit: vi.fn().mockResolvedValue(rows),
      orderBy: vi.fn().mockImplementation(() => makeTerminal(rows)),
    };
    return t;
  }

  const db: Record<string, unknown> = {
    select: vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockImplementation((tbl: { __name: string }) => {
        tableNameForCurrentSelect.current = tbl?.__name ?? "";
        return chain;
      });
      chain.innerJoin = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockImplementation((...args: unknown[]) => {
        const rows = selectRowsQueue.length > 0 ? selectRowsQueue.shift()! : [];
        selectCalls.push({ table: tableNameForCurrentSelect.current, whereArgs: args });
        return makeTerminal(rows);
      });
      chain.orderBy = vi.fn().mockImplementation(() => {
        const rows = selectRowsQueue.length > 0 ? selectRowsQueue.shift()! : [];
        return makeTerminal(rows);
      });
      return chain;
    }),
    insert: vi.fn().mockImplementation((table: { __name: string }) => ({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        insertCalls.push({ table: table.__name, values: vals });
        return {
          returning: vi.fn().mockImplementation(() => {
            const rows = insertReturningQueue.length > 0
              ? insertReturningQueue.shift()!
              : [{ id: 999, ...vals }];
            return Promise.resolve(rows);
          }),
        };
      }),
    })),
    update: vi.fn().mockImplementation((table: { __name: string }) => ({
      set: vi.fn().mockImplementation((vals: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation((...whereArgs: unknown[]) => {
          updateCalls.push({ table: table.__name, set: vals, whereArgs });
          const result = {
            returning: vi.fn().mockImplementation(() => {
              const rows = updateReturningQueue.length > 0 ? updateReturningQueue.shift()! : [];
              return Promise.resolve(rows);
            }),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
          };
          return result;
        }),
      })),
    })),
    delete: vi.fn().mockImplementation((table: { __name: string }) => ({
      where: vi.fn().mockImplementation((...whereArgs: unknown[]) => {
        deleteCalls.push({ table: table.__name, whereArgs });
        return Promise.resolve(undefined);
      }),
    })),
    execute: vi.fn().mockImplementation((sql: unknown) => {
      executeCalls.push({ sql });
      const rows = executeRowsQueue.length > 0 ? executeRowsQueue.shift()! : [];
      return Promise.resolve({ rows });
    }),
  };
  return { db, ...tables };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  inArray: vi.fn((...args: unknown[]) => ({ __op: "inArray", args })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => ({ __sql: strings.join("?") }),
    {},
  ),
}));

vi.mock("../services/subdomain-funnel-resolver", () => ({
  invalidateSubdomainFunnelCache: vi.fn(),
  extractSubdomain: vi.fn(),
}));

const assertResourceTenantAccessMock = vi.fn();
vi.mock("../lib/tenant-scope", () => ({
  assertResourceTenantAccess: (req: unknown, res: unknown, tenantId: number, opts: unknown) =>
    assertResourceTenantAccessMock(req, res, tenantId, opts),
}));

import express, { type Request, type Response, type NextFunction } from "express";

let app: express.Express;

async function setupApp(role: string | undefined, tenantId: number | null) {
  vi.resetModules();
  insertCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  selectCalls.length = 0;
  executeCalls.length = 0;
  selectRowsQueue = [];
  executeRowsQueue = [];
  updateReturningQueue = [];
  insertReturningQueue = [];
  assertResourceTenantAccessMock.mockReset();
  assertResourceTenantAccessMock.mockReturnValue({ ok: true });
  const mod = await import("./subdomain-funnel-rules");
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

type Resp = { status: number; json: Record<string, unknown> };

function sendJson(method: string, path: string, body?: unknown): Promise<Resp> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body !== undefined ? JSON.stringify(body) : "";
      const headers: Record<string, string | number> = {};
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method, headers },
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
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe("subdomain-funnel-rules — manager role guard", () => {
  it("rejects unauthenticated callers with 403", async () => {
    await setupApp(undefined, null);
    const res = await sendJson("GET", "/subdomain-funnel-rules");
    expect(res.status).toBe(403);
    expect(String(res.json.error)).toMatch(/manager role/i);
  });

  it("rejects callers with a non-manager role (e.g. csr) with 403", async () => {
    await setupApp("csr", 42);
    const res = await sendJson("GET", "/subdomain-funnel-rules");
    expect(res.status).toBe(403);
  });

  it("allows client_admin", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([]);
    const res = await sendJson("GET", "/subdomain-funnel-rules");
    expect(res.status).toBe(200);
  });

  it("allows agency_user", async () => {
    await setupApp("agency_user", 42);
    selectRowsQueue.push([]);
    const res = await sendJson("GET", "/subdomain-funnel-rules");
    expect(res.status).toBe(200);
  });

  it("allows super_admin", async () => {
    await setupApp("super_admin", null);
    selectRowsQueue.push([]);
    const res = await sendJson("GET", "/subdomain-funnel-rules?tenantId=7");
    expect(res.status).toBe(200);
  });
});

describe("GET /subdomain-funnel-rules — tenant scoping", () => {
  it("returns an empty list when there is no tenant context", async () => {
    await setupApp("super_admin", null);
    const res = await sendJson("GET", "/subdomain-funnel-rules");
    expect(res.status).toBe(200);
    expect(res.json.rules).toEqual([]);
    // No DB query issued when tenantId is null.
    expect(selectCalls.length).toBe(0);
  });

  it("scopes the rule list to the caller's tenant for tenant-scoped roles", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([
      { id: 1, subdomain: "protect", funnelTypeId: 5, funnelName: "Protection Plan", createdAt: new Date() },
    ]);
    // Even if the URL says ?tenantId=999, the handler must use the session
    // tenantId (42) for client_admin.
    const res = await sendJson("GET", "/subdomain-funnel-rules?tenantId=999");
    expect(res.status).toBe(200);
    const rules = res.json.rules as Array<Record<string, unknown>>;
    expect(rules).toHaveLength(1);
    // The where-clause for the rule list select must reference tenantId=42.
    const flat = JSON.stringify(selectCalls);
    expect(flat).toContain("subdomainFunnelRulesTable");
    expect(flat).toContain('"tenantId",42');
    expect(flat).not.toContain('"tenantId",999');
  });

  it("honours ?tenantId= for cross-tenant roles (super_admin)", async () => {
    await setupApp("super_admin", null);
    selectRowsQueue.push([
      { id: 2, subdomain: "promo", funnelTypeId: 9, funnelName: "Promo", createdAt: new Date() },
    ]);
    const res = await sendJson("GET", "/subdomain-funnel-rules?tenantId=7");
    expect(res.status).toBe(200);
    expect(JSON.stringify(selectCalls)).toContain('"tenantId",7');
  });
});

describe("POST /subdomain-funnel-rules", () => {
  it("rejects when subdomain or funnelTypeId is missing", async () => {
    await setupApp("client_admin", 42);
    const res = await sendJson("POST", "/subdomain-funnel-rules", { subdomain: "" });
    expect(res.status).toBe(400);
    expect(insertCalls.length).toBe(0);
  });

  it("rejects when funnel type is not enabled for the tenant", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([]); // tenant assoc lookup → empty
    const res = await sendJson("POST", "/subdomain-funnel-rules", {
      subdomain: "protect",
      funnelTypeId: 5,
    });
    expect(res.status).toBe(400);
    expect(insertCalls.some((c) => c.table === "subdomainFunnelRulesTable")).toBe(false);
  });

  it("normalizes the subdomain (lowercase, trim, strip www.) before inserting", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([{ id: 5 }]); // tenant assoc
    selectRowsQueue.push([{ id: 5, name: "Protection Plan" }]); // funnel type
    selectRowsQueue.push([]); // existing rule check
    selectRowsQueue.push([{ funnelName: "Protection Plan" }]); // default funnel lookup (backfill)
    executeRowsQueue.push([]); // no candidate events

    const res = await sendJson("POST", "/subdomain-funnel-rules", {
      subdomain: "  WWW.Protect  ",
      funnelTypeId: 5,
    });

    expect(res.status).toBe(200);
    const insert = insertCalls.find((c) => c.table === "subdomainFunnelRulesTable");
    expect(insert).toBeDefined();
    expect(insert!.values.subdomain).toBe("protect");
    expect(insert!.values.tenantId).toBe(42);
    expect(insert!.values.funnelTypeId).toBe(5);
    expect((res.json.rule as Record<string, unknown>).subdomain).toBe("protect");
    expect(res.json.created).toBe(true);
  });

  it("updates an existing rule when the funnel type changes (no insert)", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([{ id: 5 }]); // tenant assoc
    selectRowsQueue.push([{ id: 5, name: "Protection Plan" }]); // funnel type
    selectRowsQueue.push([{ id: 7, tenantId: 42, subdomain: "protect", funnelTypeId: 9 }]); // existing
    selectRowsQueue.push([{ funnelName: "Protection Plan" }]); // default funnel for backfill
    executeRowsQueue.push([]);
    updateReturningQueue.push([{ id: 7 }]); // update().set().where().returning()

    const res = await sendJson("POST", "/subdomain-funnel-rules", {
      subdomain: "protect",
      funnelTypeId: 5,
    });

    expect(res.status).toBe(200);
    expect(res.json.created).toBe(false);
    expect(insertCalls.some((c) => c.table === "subdomainFunnelRulesTable")).toBe(false);
    const upd = updateCalls.find((c) => c.table === "subdomainFunnelRulesTable");
    expect(upd?.set.funnelTypeId).toBe(5);
  });

  it("backfill: re-resolves events that fell through to null OR the tenant default funnel", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([{ id: 5 }]);
    selectRowsQueue.push([{ id: 5, name: "Protection Plan" }]);
    selectRowsQueue.push([]); // no existing rule
    selectRowsQueue.push([{ funnelName: "Default Funnel" }]); // tenant default
    executeRowsQueue.push([
      { id: 101, created_lead_id: null, resolved_funnel: null },
      { id: 102, created_lead_id: null, resolved_funnel: "Default Funnel" },
      { id: 103, created_lead_id: null, resolved_funnel: "default funnel" }, // case-insensitive
    ]);

    const res = await sendJson("POST", "/subdomain-funnel-rules", {
      subdomain: "protect",
      funnelTypeId: 5,
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedEventCount).toBe(3);
    const upd = updateCalls.find((c) => c.table === "attributionEventsTable");
    expect(upd).toBeDefined();
    expect(upd!.set.resolvedFunnel).toBe("Protection Plan");
    const flat = JSON.stringify(upd!.whereArgs);
    expect(flat).toContain("101");
    expect(flat).toContain("102");
    expect(flat).toContain("103");
  });

  // The critical correctness path from the task description: an event that
  // already has an explicit non-default funnel (set by a finer-grained match
  // — funnel field, path alias, etc.) must NOT be clobbered by a coarser
  // subdomain rule.
  it("backfill: does NOT overwrite events whose resolved_funnel is an explicit non-default funnel", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([{ id: 5 }]);
    selectRowsQueue.push([{ id: 5, name: "Protection Plan" }]);
    selectRowsQueue.push([]);
    selectRowsQueue.push([{ funnelName: "Default Funnel" }]); // tenant default
    executeRowsQueue.push([
      // Explicit non-default funnel — came from an alias/field; must be left alone.
      { id: 201, created_lead_id: null, resolved_funnel: "BOGO Smart Furnace" },
      { id: 202, created_lead_id: null, resolved_funnel: "Some Other Specific Funnel" },
    ]);

    const res = await sendJson("POST", "/subdomain-funnel-rules", {
      subdomain: "protect",
      funnelTypeId: 5,
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedEventCount).toBe(0);
    expect(updateCalls.some((c) => c.table === "attributionEventsTable")).toBe(false);
    expect(updateCalls.some((c) => c.table === "leadsTable")).toBe(false);
  });

  it("backfill: propagates the new funnel to leads created from fell-through events", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([{ id: 5 }]);
    selectRowsQueue.push([{ id: 5, name: "Protection Plan" }]);
    selectRowsQueue.push([]);
    selectRowsQueue.push([{ funnelName: "Default Funnel" }]); // tenant default
    executeRowsQueue.push([
      { id: 301, created_lead_id: 9001, resolved_funnel: null },
      { id: 302, created_lead_id: 9002, resolved_funnel: "Default Funnel" },
    ]);
    // Lead snapshot — one fell-through (null), one already explicit; only
    // the first should be propagated to.
    selectRowsQueue.push([
      { id: 9001, leadType: null, funnelId: null },
      { id: 9002, leadType: "Some Explicit Funnel", funnelId: 12 },
    ]);

    const res = await sendJson("POST", "/subdomain-funnel-rules", {
      subdomain: "protect",
      funnelTypeId: 5,
    });

    expect(res.status).toBe(200);
    expect(res.json.updatedEventCount).toBe(2);
    expect(res.json.updatedLeadCount).toBe(1);
    const leadUpd = updateCalls.find((c) => c.table === "leadsTable");
    expect(leadUpd).toBeDefined();
    expect(leadUpd!.set.leadType).toBe("Protection Plan");
    expect(leadUpd!.set.funnelId).toBe(5);
    expect(leadUpd!.set.updatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(leadUpd!.whereArgs)).toContain("9001");
    expect(JSON.stringify(leadUpd!.whereArgs)).not.toContain("9002");
  });
});

describe("DELETE /subdomain-funnel-rules/:id", () => {
  it("rejects an invalid numeric id", async () => {
    await setupApp("client_admin", 42);
    const res = await sendJson("DELETE", "/subdomain-funnel-rules/not-a-number");
    expect(res.status).toBe(400);
    expect(deleteCalls.length).toBe(0);
  });

  it("returns 404 when the rule does not exist", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([]); // no row found
    const res = await sendJson("DELETE", "/subdomain-funnel-rules/123");
    expect(res.status).toBe(404);
    expect(deleteCalls.length).toBe(0);
    expect(assertResourceTenantAccessMock).not.toHaveBeenCalled();
  });

  it("delegates tenant scoping to assertResourceTenantAccess and does not delete on mismatch", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([{ id: 123, tenantId: 999, subdomain: "x", funnelTypeId: 1 }]);
    assertResourceTenantAccessMock.mockImplementation((_req, res) => {
      (res as Response).status(404).json({ error: "Rule not found" });
      return { ok: false };
    });

    const res = await sendJson("DELETE", "/subdomain-funnel-rules/123");
    expect(res.status).toBe(404);
    expect(assertResourceTenantAccessMock).toHaveBeenCalled();
    const callArgs = assertResourceTenantAccessMock.mock.calls[0];
    expect(callArgs[2]).toBe(999);
    expect(callArgs[3]).toMatchObject({ notFoundOnMismatch: true });
    expect(deleteCalls.length).toBe(0);
  });

  it("deletes the rule when the tenant check passes", async () => {
    await setupApp("client_admin", 42);
    selectRowsQueue.push([{ id: 123, tenantId: 42, subdomain: "protect", funnelTypeId: 5 }]);

    const res = await sendJson("DELETE", "/subdomain-funnel-rules/123");
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].table).toBe("subdomainFunnelRulesTable");
    expect(JSON.stringify(deleteCalls[0].whereArgs)).toContain("123");
  });
});
