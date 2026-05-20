import { describe, it, expect, vi, beforeEach } from "vitest";

// Task #580: lock in the contract for `markEventManuallyMatched` — the helper
// that operator-action code paths (field-mapping rule save, per-lead funnel
// override, rule-scope re-derive fan-out) call to flip an `unmatched`
// attribution event to the new `manual` status. The behaviour was verified
// by hand when first added, but had no regression coverage until now.

const updateCalls: Array<{
  setValues: Record<string, unknown> | null;
  whereArgs: unknown[] | null;
  returnedRows: unknown[];
}> = [];
let updateReturningQueue: unknown[][] = [];

vi.mock("@workspace/db", () => ({
  db: {
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
  leadsTable: {},
  attributionEventsTable: {
    id: { __col: "attribution_events.id" },
    tenantId: { __col: "attribution_events.tenantId" },
    matchLevel: { __col: "attribution_events.matchLevel" },
  },
  fieldMappingRulesTable: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ __op: "eq", col, val })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  desc: vi.fn((c: unknown) => ({ __op: "desc", c })),
  gte: vi.fn((...args: unknown[]) => ({ __op: "gte", args })),
  lt: vi.fn((...args: unknown[]) => ({ __op: "lt", args })),
  inArray: vi.fn((c: unknown, vals: unknown) => ({ __op: "inArray", c, vals })),
}));

const emitAttributionEventUpdatedMock = vi.fn();
vi.mock("../socket", () => ({
  emitAttributionEventUpdated: (...args: unknown[]) => emitAttributionEventUpdatedMock(...args),
}));

vi.mock("./field-detection", () => ({
  detectFields: vi.fn(),
  extractPagePath: (u: string) => u,
  getFormIdentifier: (id: string | null, name: string | null) => id ?? name ?? "*",
}));
vi.mock("./funnel-normalizer", () => ({ normalizeFunnel: vi.fn() }));

function whereEqValues(args: unknown[] | null): unknown[] {
  if (!args) return [];
  const out: unknown[] = [];
  const walk = (xs: unknown[]) => {
    for (const a of xs) {
      if (!a || typeof a !== "object") continue;
      const op = (a as { __op?: string }).__op;
      if (op === "eq") out.push((a as { val: unknown }).val);
      else if (op === "and") walk((a as { args: unknown[] }).args);
    }
  };
  walk(args);
  return out;
}

describe("markEventManuallyMatched", () => {
  beforeEach(() => {
    updateCalls.length = 0;
    updateReturningQueue = [];
  });

  it("flips an unmatched event to manual with 100% confidence, clears unmatchedReason, and stamps manualSource (task #584)", async () => {
    const { markEventManuallyMatched } = await import("./re-derive-lead-funnel");
    updateReturningQueue.push([{ id: 123 }]);

    const flipped = await markEventManuallyMatched(42, 123, "field_mapping_rule:7");

    expect(flipped).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].setValues).toEqual({
      matchLevel: "manual",
      matchConfidence: 1.0,
      unmatchedReason: null,
      manualSource: "field_mapping_rule:7",
    });
  });

  it("is tenant-scoped: WHERE includes both eventId and tenantId so an event from a different tenant cannot be flipped", async () => {
    const { markEventManuallyMatched } = await import("./re-derive-lead-funnel");
    updateReturningQueue.push([{ id: 123 }]);

    await markEventManuallyMatched(42, 123, "funnel_override:lead/555");

    const eqVals = whereEqValues(updateCalls[0].whereArgs);
    expect(eqVals).toContain(42); // tenantId
    expect(eqVals).toContain(123); // eventId
  });

  it("only matches currently-unmatched rows so an auto-matched diamond/golden/silver/bronze event is never demoted to manual", async () => {
    const { markEventManuallyMatched } = await import("./re-derive-lead-funnel");
    updateReturningQueue.push([]);

    const flipped = await markEventManuallyMatched(42, 999, "field_mapping_rule:1");

    expect(flipped).toBe(0);
    const eqVals = whereEqValues(updateCalls[0].whereArgs);
    expect(eqVals).toContain("unmatched");
  });

  it("returns 0 when the targeted event does not exist (no rows returned by UPDATE...RETURNING)", async () => {
    const { markEventManuallyMatched } = await import("./re-derive-lead-funnel");
    updateReturningQueue.push([]);

    const flipped = await markEventManuallyMatched(42, 7777, "field_mapping_rule:1");

    expect(flipped).toBe(0);
  });

  // Task #584 — regression: each of the three flip sites writes a distinct,
  // expected manualSource value. The helper is the single chokepoint, so
  // verifying the stamp lands verbatim here covers the contract that the
  // three call-site tests below (field-mapping-rules.test.ts,
  // leads.funnel-override.test.ts, re-derive-jobs.test.ts) lock in for the
  // routes themselves.
  it("persists a distinct manualSource verbatim for each of the three operator-action paths (task #584)", async () => {
    const { markEventManuallyMatched } = await import("./re-derive-lead-funnel");

    updateReturningQueue.push([{ id: 1 }]);
    await markEventManuallyMatched(42, 1, "field_mapping_rule:123");
    expect(updateCalls[0].setValues).toMatchObject({ manualSource: "field_mapping_rule:123" });

    updateReturningQueue.push([{ id: 2 }]);
    await markEventManuallyMatched(42, 2, "funnel_override:lead/555");
    expect(updateCalls[1].setValues).toMatchObject({ manualSource: "funnel_override:lead/555" });

    updateReturningQueue.push([{ id: 3 }]);
    await markEventManuallyMatched(42, 3, "field_mapping_rule:scope");
    expect(updateCalls[2].setValues).toMatchObject({ manualSource: "field_mapping_rule:scope" });
  });
});
