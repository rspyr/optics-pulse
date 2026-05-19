import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the cancel-protection on `markCompleted` and
 * `markRetryOrFailed`. The contract we want to verify: when a job is
 * mid-run and the cancel endpoint races to flip the row to `cancelled`,
 * neither of these helpers should clobber that terminal state by
 * re-flipping the row to `completed` or `failed`.
 *
 * We don't have a real database here, so we mock `@workspace/db` and
 * `drizzle-orm` such that the `where(...)` arguments are captured verbatim
 * — that lets us assert the helpers always include an
 * `eq(status, "in_progress")` predicate in their conditional update.
 */

const updateCalls: Array<{
  setValues: Record<string, unknown> | null;
  whereArgs: unknown[] | null;
  returningCalled: boolean;
}> = [];
let flippedReturnRows: Array<{ id: number }> = [{ id: 1 }];

vi.mock("@workspace/db", () => {
  const tableMarker = {
    id: { __col: "id" },
    status: { __col: "status" },
  };
  return {
    db: {
      update: vi.fn().mockImplementation(() => {
        const call = { setValues: null as Record<string, unknown> | null, whereArgs: null as unknown[] | null, returningCalled: false };
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
          call.returningCalled = true;
          return Promise.resolve(flippedReturnRows);
        });
        // Awaiting the chain without .returning() should resolve too (used by
        // markRetryOrFailed's branches). We make the chain itself thenable.
        (chain as unknown as PromiseLike<unknown>).then = (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve(undefined).then(onFulfilled);
        return chain;
      }),
    },
    pool: { connect: vi.fn() },
    backgroundJobsTable: tableMarker,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ __op: "eq", col, val })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  sql: vi.fn(),
}));

import { markCompleted, markRetryOrFailed } from "./background-jobs";

function findEqClause(args: unknown[] | null, value: unknown): { found: boolean; col: unknown } {
  if (!args) return { found: false, col: null };
  for (const a of args) {
    if (a && typeof a === "object" && (a as { __op?: string }).__op === "eq") {
      const cast = a as { col: unknown; val: unknown };
      if (cast.val === value) return { found: true, col: cast.col };
    }
    if (a && typeof a === "object" && (a as { __op?: string }).__op === "and") {
      const nested = (a as { args: unknown[] }).args;
      const r = findEqClause(nested, value);
      if (r.found) return r;
    }
  }
  return { found: false, col: null };
}

describe("markCompleted — cancel-protection", () => {
  beforeEach(() => {
    updateCalls.length = 0;
    flippedReturnRows = [{ id: 42 }];
  });

  it("guards the status flip with eq(status, 'in_progress') so a row already flipped to 'cancelled' is not clobbered", async () => {
    await markCompleted(42, { ok: true });

    // First update is the conditional status flip; it must match on
    // status = "in_progress" so a concurrent cancel (status=cancelled) is
    // skipped silently.
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const first = updateCalls[0];
    expect(first.returningCalled).toBe(true);
    const inProgress = findEqClause(first.whereArgs, "in_progress");
    expect(inProgress.found).toBe(true);
    const byId = findEqClause(first.whereArgs, 42);
    expect(byId.found).toBe(true);
    expect(first.setValues).toMatchObject({ status: "completed" });
  });

  it("when 0 rows match the conditional flip (row is already terminal/cancelled), falls back to a result-only update that preserves status", async () => {
    flippedReturnRows = []; // simulate concurrent cancel
    await markCompleted(42, { ok: true, partial: 3 });

    expect(updateCalls).toHaveLength(2);
    const fallback = updateCalls[1];
    // The fallback update must NOT include `status` in its set payload —
    // otherwise it would stomp the `cancelled` state.
    expect(fallback.setValues).toBeTruthy();
    expect(Object.keys(fallback.setValues!)).not.toContain("status");
    // It still records the partial result so the operator UI can see counts.
    expect(fallback.setValues).toMatchObject({ result: { ok: true, partial: 3 } });
  });

  it("when the conditional flip succeeds (row was still in_progress), the result-only fallback update is NOT issued", async () => {
    flippedReturnRows = [{ id: 42 }]; // happy path
    await markCompleted(42, { ok: true });

    expect(updateCalls).toHaveLength(1);
  });
});

describe("markRetryOrFailed — cancel-protection on the final 'failed' flip", () => {
  beforeEach(() => {
    updateCalls.length = 0;
    flippedReturnRows = [];
  });

  it("guards the 'failed' flip with eq(status, 'in_progress') so a concurrently-cancelled row is not stomped", async () => {
    const job = {
      id: 7,
      attempts: 3,
      maxAttempts: 3,
      type: "rederive_selected_leads",
    } as unknown as Parameters<typeof markRetryOrFailed>[0];

    const outcome = await markRetryOrFailed(job, new Error("boom"));
    expect(outcome).toBe("failed");

    expect(updateCalls).toHaveLength(1);
    const u = updateCalls[0];
    expect(u.setValues).toMatchObject({ status: "failed" });
    expect(findEqClause(u.whereArgs, "in_progress").found).toBe(true);
    expect(findEqClause(u.whereArgs, 7).found).toBe(true);
  });

  it("guards the 'retry' (back-to-pending) flip with eq(status, 'in_progress') so a concurrently-cancelled row stays cancelled", async () => {
    const job = {
      id: 8,
      attempts: 1,
      maxAttempts: 5,
      type: "rederive_selected_leads",
    } as unknown as Parameters<typeof markRetryOrFailed>[0];

    const outcome = await markRetryOrFailed(job, new Error("transient"));
    expect(outcome).toBe("retry");

    expect(updateCalls).toHaveLength(1);
    const u = updateCalls[0];
    expect(u.setValues).toMatchObject({ status: "pending" });
    expect(findEqClause(u.whereArgs, "in_progress").found).toBe(true);
    expect(findEqClause(u.whereArgs, 8).found).toBe(true);
  });
});
