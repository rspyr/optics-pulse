import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the cancelled-snapshot cleanup helper. We don't have a
 * real database here, so we mock `@workspace/db` and `drizzle-orm` such
 * that the `db.execute(sql\`...\`)` call captures the SQL chunks it was
 * given. That lets us assert the DELETE targets the right type/status
 * and uses a retention window derived from `retentionDays`.
 */

const executeMock = vi.fn();
const sqlMock = vi.fn();

vi.mock("@workspace/db", () => ({
  db: { execute: executeMock },
  backgroundJobsTable: { __marker: "background_jobs" },
  pool: { connect: vi.fn() },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ __op: "eq", col, val })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  desc: vi.fn((col: unknown) => ({ __op: "desc", col })),
  sql: Object.assign(sqlMock, {}),
}));

vi.mock("../socket", () => ({
  emitRuleRederiveComplete: vi.fn(),
  emitRuleRederiveFailed: vi.fn(),
  emitSelectedLeadsRederiveCancelled: vi.fn(),
  emitSelectedLeadsRederiveComplete: vi.fn(),
  emitSelectedLeadsRederiveFailed: vi.fn(),
  emitSelectedLeadsRederiveProgress: vi.fn(),
}));

vi.mock("./background-jobs", () => ({
  registerJobHandler: vi.fn(),
  enqueueJob: vi.fn(),
  isJobCancelled: vi.fn(),
}));

vi.mock("./re-derive-lead-funnel", () => ({
  reDeriveLeadsForRuleScope: vi.fn(),
  reDeriveLeadFunnel: vi.fn(),
  countPendingRederiveLeadsForRuleScope: vi.fn(),
}));

// Capture the literal SQL fragments + interpolated values so we can assert
// the query targets `rederive_selected_leads` cancelled rows with the
// computed retention interval.
sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => ({
  __sql: true,
  strings: Array.from(strings),
  values,
}));

beforeEach(() => {
  executeMock.mockReset();
  sqlMock.mockClear();
});

describe("cleanupOldCancelledSelectedLeadsRederives", () => {
  it("rejects non-positive retentionDays without touching the db", async () => {
    const mod = await import("./re-derive-jobs");
    await expect(mod.cleanupOldCancelledSelectedLeadsRederives(0)).rejects.toThrow(
      /invalid retentionDays/,
    );
    await expect(mod.cleanupOldCancelledSelectedLeadsRederives(-3)).rejects.toThrow(
      /invalid retentionDays/,
    );
    await expect(mod.cleanupOldCancelledSelectedLeadsRederives(Number.NaN)).rejects.toThrow(
      /invalid retentionDays/,
    );
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("issues a DELETE filtered to cancelled rederive_selected_leads rows older than retentionDays, returning the deleted count", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ id: 11 }, { id: 12 }, { id: 13 }] });
    const mod = await import("./re-derive-jobs");

    const deleted = await mod.cleanupOldCancelledSelectedLeadsRederives(30);

    expect(deleted).toBe(3);
    expect(executeMock).toHaveBeenCalledTimes(1);
    const arg = executeMock.mock.calls[0]![0] as {
      strings: string[];
      values: unknown[];
    };
    const fullSql = arg.strings.join(" ");
    expect(fullSql).toMatch(/DELETE FROM background_jobs/i);
    expect(fullSql).toMatch(/status = 'cancelled'/);
    expect(fullSql).toMatch(/COALESCE\(completed_at, updated_at\)/);
    // The interpolated values: the job type token and the retention interval.
    expect(arg.values).toContain("rederive_selected_leads");
    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    expect(arg.values).toContain(`${expectedMs} milliseconds`);
  });

  it("returns 0 when nothing matches the retention window", async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    const mod = await import("./re-derive-jobs");
    const deleted = await mod.cleanupOldCancelledSelectedLeadsRederives(7);
    expect(deleted).toBe(0);
  });

  it("tolerates a result without a rows field (treats as zero)", async () => {
    executeMock.mockResolvedValueOnce({});
    const mod = await import("./re-derive-jobs");
    const deleted = await mod.cleanupOldCancelledSelectedLeadsRederives(7);
    expect(deleted).toBe(0);
  });
});

describe("startCancelledRederiveCleanupScheduler", () => {
  it("runs an initial sweep after the startup delay and then on a 24h interval, and stop clears both timers", async () => {
    vi.useFakeTimers();
    try {
      executeMock.mockResolvedValue({ rows: [{ id: 1 }] });
      const mod = await import("./re-derive-jobs");

      mod.startCancelledRederiveCleanupScheduler();
      expect(executeMock).not.toHaveBeenCalled();

      // Startup delay (60s) fires the first sweep.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(executeMock).toHaveBeenCalledTimes(1);

      // 24h interval fires another sweep.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(executeMock).toHaveBeenCalledTimes(2);

      mod.stopCancelledRederiveCleanupScheduler();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(executeMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
