import { describe, it, expect, vi, beforeEach } from "vitest";

const insertCalls: Array<{ values: Record<string, unknown> }> = [];
let selectRowsQueue: Array<unknown[]> = [];
const updateCalls: Array<{ setValues: Record<string, unknown> | null; whereArgs: unknown[] | null; returnedRows: unknown[] }> = [];
let updateReturningQueue: Array<unknown[]> = [];

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
    update: vi.fn().mockImplementation(() => {
      const call: { setValues: Record<string, unknown> | null; whereArgs: unknown[] | null; returnedRows: unknown[] } = {
        setValues: null,
        whereArgs: null,
        returnedRows: [],
      };
      updateCalls.push(call);
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        call.setValues = vals;
        return chain;
      });
      chain.where = vi.fn().mockImplementation((...args: unknown[]) => {
        call.whereArgs = args;
        return chain;
      });
      chain.returning = vi.fn().mockImplementation(() => {
        const next = updateReturningQueue.length > 0 ? updateReturningQueue.shift()! : [];
        call.returnedRows = next;
        return Promise.resolve(next);
      });
      return chain;
    }),
  },
  fieldMappingRulesTable: Symbol("fieldMappingRulesTable"),
  attributionEventsTable: { createdLeadId: Symbol("createdLeadId"), tenantId: Symbol("tenantId") },
  backgroundJobsTable: {
    id: { __col: "id" },
    tenantId: { __col: "tenantId" },
    type: { __col: "type" },
    status: { __col: "status" },
  },
}));

vi.mock("../services/field-detection", () => ({
  invalidateRuleCache: vi.fn(),
}));

const { emitRuleRederiveCompleteMock, emitRuleRederiveFailedMock, emitSelectedLeadsRederiveCancelledMock, getSelectedLeadsRederiveProgressMock, findLatestCancelledSelectedLeadsRederiveSnapshotForScopeMock, reDeriveLeadsForRuleScopeMock, reDeriveLeadFunnelMock, countPendingRederiveLeadsForRuleScopeMock, listPendingRederiveLeadsForRuleScopeMock, enqueueReDeriveLeadsForRuleScopeMock, enqueueReDeriveSelectedLeadsMock } = vi.hoisted(() => ({
  emitRuleRederiveCompleteMock: vi.fn(),
  emitRuleRederiveFailedMock: vi.fn(),
  emitSelectedLeadsRederiveCancelledMock: vi.fn(),
  getSelectedLeadsRederiveProgressMock: vi.fn(),
  findLatestCancelledSelectedLeadsRederiveSnapshotForScopeMock: vi.fn(),
  reDeriveLeadsForRuleScopeMock: vi.fn(),
  reDeriveLeadFunnelMock: vi.fn(),
  countPendingRederiveLeadsForRuleScopeMock: vi.fn(),
  listPendingRederiveLeadsForRuleScopeMock: vi.fn(),
  enqueueReDeriveLeadsForRuleScopeMock: vi.fn(),
  enqueueReDeriveSelectedLeadsMock: vi.fn(),
}));

vi.mock("../socket", () => ({
  emitRuleRederiveComplete: emitRuleRederiveCompleteMock,
  emitRuleRederiveFailed: emitRuleRederiveFailedMock,
  emitSelectedLeadsRederiveCancelled: emitSelectedLeadsRederiveCancelledMock,
  getSelectedLeadsRederiveProgress: getSelectedLeadsRederiveProgressMock,
  findLatestCancelledSelectedLeadsRederiveSnapshotForScope: findLatestCancelledSelectedLeadsRederiveSnapshotForScopeMock,
}));

vi.mock("../services/re-derive-lead-funnel", () => ({
  reDeriveLeadsForRuleScope: reDeriveLeadsForRuleScopeMock,
  reDeriveLeadFunnel: reDeriveLeadFunnelMock,
  countPendingRederiveLeadsForRuleScope: countPendingRederiveLeadsForRuleScopeMock,
  listPendingRederiveLeadsForRuleScope: listPendingRederiveLeadsForRuleScopeMock,
}));

vi.mock("../services/re-derive-jobs", () => ({
  enqueueReDeriveLeadsForRuleScope: enqueueReDeriveLeadsForRuleScopeMock,
  enqueueReDeriveSelectedLeads: enqueueReDeriveSelectedLeadsMock,
  REDERIVE_LEADS_FOR_RULE_SCOPE: "rederive_leads_for_rule_scope",
  REDERIVE_SELECTED_LEADS: "rederive_selected_leads",
  registerReDeriveJobHandlers: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ __op: "eq", col, val })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  inArray: vi.fn((col: unknown, vals: unknown[]) => ({ __op: "inArray", col, vals })),
}));

import express, { type Request, type Response, type NextFunction } from "express";

let app: express.Express;

async function setupApp(role: string | undefined, tenantId: number | null) {
  vi.resetModules();
  insertCalls.length = 0;
  selectRowsQueue = [];
  updateCalls.length = 0;
  updateReturningQueue = [];
  emitRuleRederiveCompleteMock.mockReset();
  emitRuleRederiveFailedMock.mockReset();
  emitSelectedLeadsRederiveCancelledMock.mockReset();
  getSelectedLeadsRederiveProgressMock.mockReset();
  findLatestCancelledSelectedLeadsRederiveSnapshotForScopeMock.mockReset();
  enqueueReDeriveSelectedLeadsMock.mockReset();
  reDeriveLeadsForRuleScopeMock.mockReset();
  reDeriveLeadFunnelMock.mockReset();
  countPendingRederiveLeadsForRuleScopeMock.mockReset();
  countPendingRederiveLeadsForRuleScopeMock.mockResolvedValue({
    pendingLeads: 0,
    hitLimit: false,
    maxLeads: 500,
    lastAttemptedAt: null,
  });
  listPendingRederiveLeadsForRuleScopeMock.mockReset();
  listPendingRederiveLeadsForRuleScopeMock.mockResolvedValue({
    leads: [],
    hitLimit: false,
    maxLeads: 500,
  });
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
    expect(emitRuleRederiveFailedMock).toHaveBeenCalledWith(42, expect.objectContaining({
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      reason: "queue full",
    }));
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

  it.each([
    {
      name: "empty pageUrlPattern",
      body: { pageUrlPattern: "", formIdentifier: "form1", fieldName: "field_3", mapsTo: "phone" },
    },
    {
      name: "non-string pageUrlPattern",
      body: { pageUrlPattern: 123, formIdentifier: "form1", fieldName: "field_3", mapsTo: "phone" },
    },
    {
      name: "empty formIdentifier",
      body: { pageUrlPattern: "/contact", formIdentifier: "", fieldName: "field_3", mapsTo: "phone" },
    },
    {
      name: "non-string formIdentifier",
      body: { pageUrlPattern: "/contact", formIdentifier: 7, fieldName: "field_3", mapsTo: "phone" },
    },
  ])("rejects bad inputs ($name) with 4xx before enqueueing a rederive job", async ({ body }) => {
    const res = await postJson(app, "/field-mapping-rules", body);
    expect(res.status).toBe(400);
    expect(insertCalls.length).toBe(0);
    expect(enqueueReDeriveLeadsForRuleScopeMock).not.toHaveBeenCalled();
    expect(emitRuleRederiveFailedMock).not.toHaveBeenCalled();
  });

  it("rejects zero/negative tenantId with 4xx before enqueueing a rederive job", async () => {
    await setupApp("super_admin", 0);
    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "form1",
      fieldName: "field_3",
      mapsTo: "phone",
    });
    // tenantId 0 is falsy -> hits the "No tenant context" guard first.
    expect(res.status).toBe(400);
    expect(insertCalls.length).toBe(0);
    expect(enqueueReDeriveLeadsForRuleScopeMock).not.toHaveBeenCalled();
  });

  it("rejects non-integer tenantId (e.g. NaN from a malformed ?tenantId query) with 4xx before enqueueing", async () => {
    await setupApp("super_admin", Number.NaN as unknown as number);
    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "form1",
      fieldName: "field_3",
      mapsTo: "phone",
    });
    expect(res.status).toBe(400);
    expect(insertCalls.length).toBe(0);
    expect(enqueueReDeriveLeadsForRuleScopeMock).not.toHaveBeenCalled();
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

describe("POST /field-mapping-rules/rederive-jobs/:id/cancel", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  function whereContains(args: unknown[] | null, value: unknown): boolean {
    if (!args) return false;
    for (const a of args) {
      if (!a || typeof a !== "object") continue;
      const op = (a as { __op?: string }).__op;
      if (op === "eq" && (a as { val: unknown }).val === value) return true;
      if (op === "inArray") {
        const vals = (a as { vals: unknown[] }).vals;
        if (Array.isArray(vals) && vals.includes(value)) return true;
      }
      if (op === "and") {
        if (whereContains((a as { args: unknown[] }).args, value)) return true;
      }
    }
    return false;
  }

  it("returns 400 when the :id path param is not a positive integer", async () => {
    const res = await postJson(app, "/field-mapping-rules/rederive-jobs/not-a-number/cancel", {});
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/job id/i);
  });

  it("returns 404 when the job belongs to a different tenant (tenant scoping)", async () => {
    // Row exists but tenantId differs from session tenant (42).
    selectRowsQueue.push([
      { id: 555, tenantId: 99, type: "rederive_selected_leads", status: "in_progress", payload: { leadIds: [1, 2] } },
    ]);

    const res = await postJson(app, "/field-mapping-rules/rederive-jobs/555/cancel", {});
    expect(res.status).toBe(404);
    // Must NOT have attempted any UPDATE — the row isn't ours to touch.
    expect(updateCalls).toHaveLength(0);
    expect(emitSelectedLeadsRederiveCancelledMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the job exists but is the wrong type (don't let this endpoint cancel arbitrary jobs)", async () => {
    selectRowsQueue.push([
      { id: 555, tenantId: 42, type: "some_other_job", status: "in_progress", payload: {} },
    ]);

    const res = await postJson(app, "/field-mapping-rules/rederive-jobs/555/cancel", {});
    expect(res.status).toBe(404);
    expect(updateCalls).toHaveLength(0);
  });

  it("returns 404 when the row doesn't exist", async () => {
    selectRowsQueue.push([]);
    const res = await postJson(app, "/field-mapping-rules/rederive-jobs/555/cancel", {});
    expect(res.status).toBe(404);
    expect(updateCalls).toHaveLength(0);
  });

  it("returns 409 when the row is already terminal (raced to completed/failed/cancelled between read and write)", async () => {
    // Read says in_progress, but the conditional UPDATE matches 0 rows
    // because something else flipped it terminal between the SELECT and the
    // UPDATE. We expect 409 + the current status so the UI can refresh.
    selectRowsQueue.push([
      { id: 555, tenantId: 42, type: "rederive_selected_leads", status: "completed", payload: { leadIds: [1, 2] } },
    ]);
    updateReturningQueue.push([]); // 0 rows flipped — already terminal

    const res = await postJson(app, "/field-mapping-rules/rederive-jobs/555/cancel", {});
    expect(res.status).toBe(409);
    expect(res.json.status).toBe("completed");
    expect(res.json.error).toMatch(/already completed/i);
    // We do not emit the cancelled event for an already-terminal row.
    expect(emitSelectedLeadsRederiveCancelledMock).not.toHaveBeenCalled();
  });

  it("happy path: flips status=cancelled for tenant-owned in_progress row, returns 200, and does NOT emit a pending-cancel event (handler emits with real partial counts)", async () => {
    const existing = { id: 555, tenantId: 42, type: "rederive_selected_leads", status: "in_progress", payload: { leadIds: [1, 2, 3] } };
    selectRowsQueue.push([existing]);
    updateReturningQueue.push([{ ...existing, status: "cancelled" }]);

    const res = await postJson(app, "/field-mapping-rules/rederive-jobs/555/cancel", {});
    expect(res.status).toBe(200);
    expect((res.json as { job: { id: number; status: string } }).job).toMatchObject({
      id: 555,
      status: "cancelled",
    });

    // Exactly one UPDATE issued, with status=cancelled, tenant-scoped, and
    // gated on status IN (pending, in_progress) so we don't stomp terminal rows.
    expect(updateCalls).toHaveLength(1);
    const upd = updateCalls[0];
    expect(upd.setValues).toMatchObject({ status: "cancelled" });
    expect(whereContains(upd.whereArgs, 555)).toBe(true);
    expect(whereContains(upd.whereArgs, 42)).toBe(true);
    expect(whereContains(upd.whereArgs, "rederive_selected_leads")).toBe(true);
    expect(whereContains(upd.whereArgs, "pending")).toBe(true);
    expect(whereContains(upd.whereArgs, "in_progress")).toBe(true);

    // For an in_progress row the handler will emit the cancelled event itself
    // with real partial counts — the route must NOT pre-emit a 0/N tick.
    expect(emitSelectedLeadsRederiveCancelledMock).not.toHaveBeenCalled();
  });

  it("when the row was still pending (no handler will ever run), the route itself emits a 0/N cancelled event so the sheet resolves immediately", async () => {
    const existing = { id: 555, tenantId: 42, type: "rederive_selected_leads", status: "pending", payload: { leadIds: [10, 20, 30] } };
    selectRowsQueue.push([existing]);
    updateReturningQueue.push([{ ...existing, status: "cancelled" }]);

    const res = await postJson(app, "/field-mapping-rules/rederive-jobs/555/cancel", {});
    expect(res.status).toBe(200);

    expect(emitSelectedLeadsRederiveCancelledMock).toHaveBeenCalledTimes(1);
    expect(emitSelectedLeadsRederiveCancelledMock).toHaveBeenCalledWith(42, {
      jobId: 555,
      total: 3,
      processed: 0,
      succeeded: 0,
      failed: 0,
      changed: 0,
      failedLeadIds: [],
      // The pending-cancel path surfaces the full leadIds list as "skipped"
      // so the sheet's "Re-derive the rest" affordance is wired up even
      // when the handler never ran.
      skippedLeadIds: [10, 20, 30],
      // No scope on this legacy-shaped payload, so both fields forward as
      // undefined — the snapshot just won't be discoverable by scope.
      pageUrlPattern: undefined,
      formIdentifier: undefined,
    });
  });

  it("a socket-emit failure on the pending-cancel path is logged but the route still returns 200", async () => {
    const existing = { id: 555, tenantId: 42, type: "rederive_selected_leads", status: "pending", payload: { leadIds: [1] } };
    selectRowsQueue.push([existing]);
    updateReturningQueue.push([{ ...existing, status: "cancelled" }]);
    emitSelectedLeadsRederiveCancelledMock.mockImplementationOnce(() => { throw new Error("socket down"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await postJson(app, "/field-mapping-rules/rederive-jobs/555/cancel", {});
    expect(res.status).toBe(200);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("forwards the scope from the cancelled job's payload so the snapshot is restorable by scope on sheet re-open", async () => {
    const existing = {
      id: 555,
      tenantId: 42,
      type: "rederive_selected_leads",
      status: "pending",
      payload: { leadIds: [1, 2, 3], pageUrlPattern: "/contact", formIdentifier: "contact-form" },
    };
    selectRowsQueue.push([existing]);
    updateReturningQueue.push([{ ...existing, status: "cancelled" }]);

    const res = await postJson(app, "/field-mapping-rules/rederive-jobs/555/cancel", {});
    expect(res.status).toBe(200);
    expect(emitSelectedLeadsRederiveCancelledMock).toHaveBeenCalledWith(42, expect.objectContaining({
      jobId: 555,
      total: 3,
      skippedLeadIds: [1, 2, 3],
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
    }));
  });
});

describe("GET /field-mapping-rules/cancelled-rederive-snapshot", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  it("returns 400 when scope params are missing", async () => {
    const res = await getJson(app, "/field-mapping-rules/cancelled-rederive-snapshot?tenantId=42");
    expect(res.status).toBe(400);
  });

  it("returns 404 when no cancelled snapshot exists for the scope (sheet falls back to 'no result yet')", async () => {
    findLatestCancelledSelectedLeadsRederiveSnapshotForScopeMock.mockReturnValueOnce(null);
    const res = await getJson(
      app,
      "/field-mapping-rules/cancelled-rederive-snapshot?tenantId=42&pageUrlPattern=%2Fcontact&formIdentifier=contact-form",
    );
    expect(res.status).toBe(404);
    expect(findLatestCancelledSelectedLeadsRederiveSnapshotForScopeMock).toHaveBeenCalledWith(42, "/contact", "contact-form");
  });

  it("returns the snapshot when one exists so the sheet can restore the cancelled state on re-open", async () => {
    findLatestCancelledSelectedLeadsRederiveSnapshotForScopeMock.mockReturnValueOnce({
      tenantId: 42,
      jobId: 777,
      total: 100,
      processed: 30,
      succeeded: 28,
      failed: 2,
      changed: 25,
      failedLeadIds: [101, 102],
      skippedLeadIds: [201, 202, 203],
      status: "cancelled",
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      updatedAt: new Date().toISOString(),
    });
    const res = await getJson(
      app,
      "/field-mapping-rules/cancelled-rederive-snapshot?tenantId=42&pageUrlPattern=%2Fcontact&formIdentifier=contact-form",
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      jobId: 777,
      status: "cancelled",
      skippedLeadIds: [201, 202, 203],
    });
  });
});
