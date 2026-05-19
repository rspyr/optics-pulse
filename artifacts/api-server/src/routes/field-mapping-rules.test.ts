import { describe, it, expect, vi, beforeEach } from "vitest";

const insertCalls: Array<{ values: Record<string, unknown> }> = [];
let selectRowsQueue: Array<unknown[]> = [];

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const next = selectRowsQueue.length > 0 ? selectRowsQueue.shift() : [];
          return Promise.resolve(next);
        }),
      }),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        insertCalls.push({ values: vals });
        return {
          returning: vi.fn().mockResolvedValue([{ id: 99, ...vals }]),
        };
      }),
    })),
  },
  fieldMappingRulesTable: Symbol("fieldMappingRulesTable"),
  attributionEventsTable: { createdLeadId: Symbol("createdLeadId"), tenantId: Symbol("tenantId") },
}));

vi.mock("../services/field-detection", () => ({
  invalidateRuleCache: vi.fn(),
}));

const { emitRuleRederiveCompleteMock, emitRuleRederiveFailedMock, reDeriveLeadsForRuleScopeMock, reDeriveLeadFunnelMock, enqueueReDeriveLeadsForRuleScopeMock } = vi.hoisted(() => ({
  emitRuleRederiveCompleteMock: vi.fn(),
  emitRuleRederiveFailedMock: vi.fn(),
  reDeriveLeadsForRuleScopeMock: vi.fn(),
  reDeriveLeadFunnelMock: vi.fn(),
  enqueueReDeriveLeadsForRuleScopeMock: vi.fn(),
}));

vi.mock("../socket", () => ({
  emitRuleRederiveComplete: emitRuleRederiveCompleteMock,
  emitRuleRederiveFailed: emitRuleRederiveFailedMock,
}));

vi.mock("../services/re-derive-lead-funnel", () => ({
  reDeriveLeadsForRuleScope: reDeriveLeadsForRuleScopeMock,
  reDeriveLeadFunnel: reDeriveLeadFunnelMock,
}));

vi.mock("../services/re-derive-jobs", () => ({
  enqueueReDeriveLeadsForRuleScope: enqueueReDeriveLeadsForRuleScopeMock,
  REDERIVE_LEADS_FOR_RULE_SCOPE: "rederive_leads_for_rule_scope",
  registerReDeriveJobHandlers: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));

import express, { type Request, type Response, type NextFunction } from "express";

let app: express.Express;

async function setupApp(role: string | undefined, tenantId: number | null) {
  vi.resetModules();
  insertCalls.length = 0;
  selectRowsQueue = [];
  emitRuleRederiveCompleteMock.mockReset();
  emitRuleRederiveFailedMock.mockReset();
  reDeriveLeadsForRuleScopeMock.mockReset();
  reDeriveLeadFunnelMock.mockReset();
  enqueueReDeriveLeadsForRuleScopeMock.mockReset();
  enqueueReDeriveLeadsForRuleScopeMock.mockResolvedValue({ id: 1 });
  const mod = await import("./field-mapping-rules");
  app = express();
  app.use(express.json());
  // Stub session — the real route reads req.session.userRole / tenantId.
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
            resolve({
              status: res.statusCode,
              json: data ? JSON.parse(data) : {},
            });
          });
        },
      );
      req.end();
    });
  });
}

describe("GET /field-mapping-rules/suggestions", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("returns an empty suggestions object when the tenant has no rules", async () => {
    selectRowsQueue.push([]);
    const res = await getJson(app, "/field-mapping-rules/suggestions");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ suggestions: {} });
  });

  it("returns suggestions keyed by normalized field name", async () => {
    selectRowsQueue.push([
      { id: 1, fieldName: "q1_first", mapsTo: "firstName", createdAt: new Date("2025-01-01") },
      { id: 2, fieldName: "signup_zipcode", mapsTo: "zip", createdAt: new Date("2025-01-02") },
      { id: 3, fieldName: "Q1 First", mapsTo: "firstName", createdAt: new Date("2025-01-03") },
    ]);
    const res = await getJson(app, "/field-mapping-rules/suggestions");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      suggestions: {
        q1_first: "firstName",
        signup_zipcode: "zip",
      },
    });
  });

  it("picks the most-frequently-used target when the same field name has been mapped multiple ways", async () => {
    selectRowsQueue.push([
      { id: 1, fieldName: "field_3", mapsTo: "phone", createdAt: new Date("2025-01-01") },
      { id: 2, fieldName: "field_3", mapsTo: "phone", createdAt: new Date("2025-01-02") },
      { id: 3, fieldName: "field_3", mapsTo: "email", createdAt: new Date("2025-01-03") },
    ]);
    const res = await getJson(app, "/field-mapping-rules/suggestions");
    expect(res.json).toEqual({ suggestions: { field_3: "phone" } });
  });

  it("breaks ties on count by preferring the most recently created mapping", async () => {
    selectRowsQueue.push([
      { id: 1, fieldName: "field_3", mapsTo: "phone", createdAt: new Date("2025-01-01") },
      { id: 2, fieldName: "field_3", mapsTo: "email", createdAt: new Date("2025-02-01") },
    ]);
    const res = await getJson(app, "/field-mapping-rules/suggestions");
    expect(res.json).toEqual({ suggestions: { field_3: "email" } });
  });

  it("ignores rows whose mapsTo is not a recognised semantic target", async () => {
    selectRowsQueue.push([
      { id: 1, fieldName: "weird_field", mapsTo: "garbage", createdAt: new Date("2025-01-01") },
    ]);
    const res = await getJson(app, "/field-mapping-rules/suggestions");
    expect(res.json).toEqual({ suggestions: {} });
  });

  it("rejects non-manager roles", async () => {
    await setupApp("csr", 42);
    selectRowsQueue.push([]);
    const res = await getJson(app, "/field-mapping-rules/suggestions");
    expect(res.status).toBe(403);
  });

  it("returns empty suggestions when no tenant context resolves", async () => {
    await setupApp("client_admin", null);
    const res = await getJson(app, "/field-mapping-rules/suggestions");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ suggestions: {} });
  });
});

describe("POST /field-mapping-rules", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("inserts a rule scoped to tenant, page, form, and field", async () => {
    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "ac-breakdown-prevention",
      fieldName: "field_3",
      mapsTo: "phone",
    });
    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values).toEqual({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "ac-breakdown-prevention",
      fieldName: "field_3",
      mapsTo: "phone",
      priority: 0,
    });
  });

  it("rejects non-manager roles", async () => {
    await setupApp("csr", 42);
    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "form1",
      fieldName: "field_3",
      mapsTo: "phone",
    });
    expect(res.status).toBe(403);
    expect(insertCalls.length).toBe(0);
  });

  it("enqueues a rederive-leads-for-rule-scope background job with the request's scope (so the job handler can emit rule-rederive-complete after fan-out)", async () => {
    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "ac-breakdown-prevention",
      fieldName: "field_3",
      mapsTo: "phone",
    });
    expect(res.status).toBe(200);

    expect(enqueueReDeriveLeadsForRuleScopeMock).toHaveBeenCalledTimes(1);
    expect(enqueueReDeriveLeadsForRuleScopeMock).toHaveBeenCalledWith({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "ac-breakdown-prevention",
      excludeLeadId: null,
    });

    // The route itself must NOT emit the socket event — that's the job
    // handler's responsibility, and the handler is mocked out here.
    expect(emitRuleRederiveCompleteMock).not.toHaveBeenCalled();
  });

  it("enqueues with excludeLeadId resolved from attributionEventId so the open lead isn't re-derived twice", async () => {
    // First select in route is the duplicate-rule lookup -> empty (insert path).
    // Second select is the attribution-event lookup for createdLeadId.
    selectRowsQueue = [
      [],
      [{ createdLeadId: 77, tenantId: 42 }],
    ];
    reDeriveLeadFunnelMock.mockResolvedValue({ changed: false });

    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/quote",
      formIdentifier: "quote-form",
      fieldName: "field_9",
      mapsTo: "email",
      attributionEventId: 1234,
    });
    expect(res.status).toBe(200);

    expect(enqueueReDeriveLeadsForRuleScopeMock).toHaveBeenCalledTimes(1);
    expect(enqueueReDeriveLeadsForRuleScopeMock).toHaveBeenCalledWith({
      tenantId: 42,
      pageUrlPattern: "/quote",
      formIdentifier: "quote-form",
      excludeLeadId: 77,
    });
  });

  it("still returns 200 when enqueueing the rederive job fails (failure is logged, save is not undone), AND emits rule-rederive-failed so the panel can show the retry hint", async () => {
    enqueueReDeriveLeadsForRuleScopeMock.mockRejectedValue(new Error("queue full"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      fieldName: "field_3",
      mapsTo: "phone",
    });
    expect(res.status).toBe(200);
    expect((res.json as { rule: unknown }).rule).toBeTruthy();
    expect(enqueueReDeriveLeadsForRuleScopeMock).toHaveBeenCalledTimes(1);
    expect(emitRuleRederiveCompleteMock).not.toHaveBeenCalled();
    expect(emitRuleRederiveFailedMock).toHaveBeenCalledTimes(1);
    expect(emitRuleRederiveFailedMock).toHaveBeenCalledWith(42, {
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      reason: "queue full",
    });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("still returns 200 and logs (does not crash) when emitRuleRederiveFailed itself throws after an enqueue failure", async () => {
    enqueueReDeriveLeadsForRuleScopeMock.mockRejectedValue(new Error("queue full"));
    emitRuleRederiveFailedMock.mockImplementationOnce(() => { throw new Error("socket down"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      fieldName: "field_3",
      mapsTo: "phone",
    });
    expect(res.status).toBe(200);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("rejects unknown mapsTo targets", async () => {
    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "form1",
      fieldName: "field_3",
      mapsTo: "phon",
    });
    expect(res.status).toBe(400);
    expect((res.json.error as string)).toContain("mapsTo must be one of");
    expect(insertCalls.length).toBe(0);
  });
});
