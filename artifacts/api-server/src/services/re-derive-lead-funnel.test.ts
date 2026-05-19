import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock state captured across all `db.select(...).from(...).where(...)...`
// chains. Each test seeds the queue with the rows each successive query
// should resolve to, in order: latestRule -> events -> leads.
let selectQueue: Array<{
  rows: unknown[];
  orderBy?: unknown[];
  selectArg?: unknown;
}> = [];
let nextSelectIndex = 0;

function makeChain() {
  const state: { selectArg?: unknown } = {};
  const chain = {
    from: vi.fn().mockReturnValue(undefined as unknown),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockImplementation((...args: unknown[]) => {
    const entry = selectQueue[nextSelectIndex];
    if (entry) entry.orderBy = args;
    return chain;
  });
  chain.limit.mockImplementation(() => {
    const entry = selectQueue[nextSelectIndex++];
    return Promise.resolve(entry?.rows ?? []);
  });
  // Some queries (the final leads filter) await directly off `.where(...)`
  // without `.orderBy().limit()`. We make `.where()` itself thenable so it
  // resolves to the next queued rows in that case.
  const originalWhere = chain.where.getMockImplementation();
  chain.where.mockImplementation((...args: unknown[]) => {
    originalWhere?.(...args);
    const thenable = {
      ...chain,
      then: (resolve: (v: unknown[]) => void) => {
        const entry = selectQueue[nextSelectIndex];
        // Only consume if no further orderBy/limit chains will be called.
        // To know that, we lazily defer to a microtask — but for the leads
        // query the awaiter calls .then immediately. We consume here.
        nextSelectIndex++;
        resolve(entry?.rows ?? []);
      },
    };
    return thenable;
  });
  return { chain, state };
}

vi.mock("@workspace/db", () => {
  return {
    db: {
      select: vi.fn().mockImplementation((selectArg?: unknown) => {
        const entry = selectQueue[nextSelectIndex];
        if (entry) entry.selectArg = selectArg;
        return makeChain().chain;
      }),
    },
    leadsTable: {
      id: { name: "id" },
      tenantId: { name: "tenantId" },
      updatedAt: { name: "updatedAt" },
    },
    attributionEventsTable: {
      createdLeadId: { name: "createdLeadId" },
      pageUrl: { name: "pageUrl" },
      formId: { name: "formId" },
      formName: { name: "formName" },
      tenantId: { name: "tenantId" },
      createdAt: { name: "createdAt" },
    },
    fieldMappingRulesTable: {
      tenantId: { name: "tenantId" },
      pageUrlPattern: { name: "pageUrlPattern" },
      formIdentifier: { name: "formIdentifier" },
      createdAt: { name: "createdAt" },
      updatedAt: { name: "updatedAt" },
    },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  desc: vi.fn((c: unknown) => ({ op: "desc", c })),
  gte: vi.fn((...args: unknown[]) => ({ op: "gte", args })),
  lt: vi.fn((...args: unknown[]) => ({ op: "lt", args })),
  inArray: vi.fn((c: unknown, vals: unknown) => ({ op: "inArray", c, vals })),
}));

vi.mock("./field-detection", () => ({
  detectFields: vi.fn(),
  extractPagePath: (u: string) => u, // events seeded with literal page paths
  getFormIdentifier: (id: string | null, name: string | null) => id ?? name ?? "*",
}));

vi.mock("./funnel-normalizer", () => ({
  normalizeFunnel: vi.fn(),
}));

describe("countPendingRederiveLeadsForRuleScope", () => {
  beforeEach(() => {
    selectQueue = [];
    nextSelectIndex = 0;
  });

  it("uses the rule's updatedAt (not createdAt) as the last-derived-before cutoff so edits to an existing rule count historical leads accurately", async () => {
    const { countPendingRederiveLeadsForRuleScope } = await import("./re-derive-lead-funnel");

    const ruleUpdatedAt = new Date("2026-05-01T00:00:00Z");
    // Lead 10 was touched after the rule was originally created but BEFORE
    // the latest rule update, so it still needs re-deriving on a retry.
    selectQueue.push({ rows: [{ updatedAt: ruleUpdatedAt }] }); // latestRule
    selectQueue.push({
      rows: [
        { createdLeadId: 10, pageUrl: "/contact", formId: "form-1", formName: null },
        { createdLeadId: 11, pageUrl: "/contact", formId: "form-1", formName: null },
      ],
    }); // events
    selectQueue.push({ rows: [{ id: 10 }] }); // leads filtered by lt(updatedAt, cutoff)

    const result = await countPendingRederiveLeadsForRuleScope(
      42,
      "/contact",
      "form-1",
    );

    expect(result.pendingLeads).toBe(1);
    expect(result.maxLeads).toBe(200);
    expect(result.hitLimit).toBe(false);
    expect(result.lastAttemptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const drizzle = await import("drizzle-orm");
    const orderByCalls = (drizzle.desc as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // The latestRule query must order by fieldMappingRulesTable.updatedAt
    // (not createdAt) so edits show the latest cutoff.
    const orderedColumns = orderByCalls.map((c) => (c[0] as { name?: string }).name);
    expect(orderedColumns).toContain("updatedAt");
  });

  it("excludes the actively-edited lead from the count so the failure hint matches the fan-out scope exactly", async () => {
    const { countPendingRederiveLeadsForRuleScope } = await import("./re-derive-lead-funnel");

    selectQueue.push({ rows: [{ updatedAt: new Date("2026-05-10T00:00:00Z") }] });
    selectQueue.push({
      rows: [
        { createdLeadId: 77, pageUrl: "/contact", formId: "form-1", formName: null },
        { createdLeadId: 78, pageUrl: "/contact", formId: "form-1", formName: null },
      ],
    });
    selectQueue.push({ rows: [{ id: 78 }] });

    const result = await countPendingRederiveLeadsForRuleScope(
      42,
      "/contact",
      "form-1",
      { excludeLeadId: 77 },
    );

    // Lead 77 was filtered out before the leads query ran, leaving only 78.
    expect(result.pendingLeads).toBe(1);
  });
});
