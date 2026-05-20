/**
 * Real-Postgres integration coverage for
 * `cleanupOldCancelledSelectedLeadsRederives`. The unit test in
 * `re-derive-jobs-cleanup.test.ts` mocks `db.execute` and only proves the
 * SQL string is shaped correctly. This file exercises the actual DELETE
 * against a live database so we know Postgres evaluates the
 * `COALESCE(completed_at, updated_at) < now() - interval` predicate the
 * way we expect.
 *
 * We seed background_jobs rows with carefully chosen ages and statuses
 * and assert that, after calling the cleanup with a 30-day retention
 * window:
 *   - cancelled rederive_selected_leads rows past the cutoff (by
 *     completed_at, OR by updated_at when completed_at is null) ARE
 *     deleted
 *   - cancelled rederive_selected_leads rows inside the window are kept
 *   - rows whose completed_at is recent but updated_at is old are kept
 *     (proves COALESCE prefers completed_at)
 *   - completed / failed / pending rederive_selected_leads rows are kept
 *     regardless of age
 *   - cancelled rows of OTHER job types are kept regardless of age
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const { db, backgroundJobsTable } = dbModule;

const { cleanupOldCancelledSelectedLeadsRederives } = await import("./re-derive-jobs");

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const REDERIVE_SELECTED_LEADS = "rederive_selected_leads";
const OTHER_JOB_TYPE = "rederive_cleanup_int_other_type";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

interface SeedSpec {
  label: string;
  type: string;
  status: string;
  completedAt: Date | null;
  updatedAt: Date;
  expectDeleted: boolean;
}

let seeded: Array<{ id: number; label: string; expectDeleted: boolean }> = [];

beforeAll(async () => {
  // Use distinctive markers in `payload` and an isolated `OTHER_JOB_TYPE`
  // so the test only touches rows it created — the dev DB can have real
  // background_jobs rows from other code paths.
  const marker = `cleanup-int-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const specs: SeedSpec[] = [
    // --- Cancelled rederive_selected_leads, past cutoff: must be deleted.
    {
      label: "cancelled-old-by-completedAt",
      type: REDERIVE_SELECTED_LEADS,
      status: "cancelled",
      completedAt: daysAgo(60),
      updatedAt: daysAgo(60),
      expectDeleted: true,
    },
    {
      // completedAt NULL (older rows that pre-date the column being
      // populated). COALESCE should fall back to updatedAt.
      label: "cancelled-old-by-updatedAt-null-completedAt",
      type: REDERIVE_SELECTED_LEADS,
      status: "cancelled",
      completedAt: null,
      updatedAt: daysAgo(45),
      expectDeleted: true,
    },
    {
      label: "cancelled-just-past-cutoff",
      type: REDERIVE_SELECTED_LEADS,
      status: "cancelled",
      completedAt: daysAgo(31),
      updatedAt: daysAgo(31),
      expectDeleted: true,
    },

    // --- Cancelled rederive_selected_leads, inside the window: kept.
    {
      label: "cancelled-recent",
      type: REDERIVE_SELECTED_LEADS,
      status: "cancelled",
      completedAt: daysAgo(5),
      updatedAt: daysAgo(5),
      expectDeleted: false,
    },
    {
      label: "cancelled-just-inside-cutoff",
      type: REDERIVE_SELECTED_LEADS,
      status: "cancelled",
      completedAt: daysAgo(29),
      updatedAt: daysAgo(29),
      expectDeleted: false,
    },
    {
      // completedAt is recent but updatedAt is old. COALESCE picks
      // completedAt first, so this row is INSIDE the retention window
      // and must be kept. Proves we're not just looking at updatedAt.
      label: "cancelled-completedAt-recent-updatedAt-old",
      type: REDERIVE_SELECTED_LEADS,
      status: "cancelled",
      completedAt: daysAgo(2),
      updatedAt: daysAgo(90),
      expectDeleted: false,
    },

    // --- Non-cancelled rederive_selected_leads of various ages: kept.
    {
      label: "completed-old",
      type: REDERIVE_SELECTED_LEADS,
      status: "completed",
      completedAt: daysAgo(120),
      updatedAt: daysAgo(120),
      expectDeleted: false,
    },
    {
      label: "failed-old",
      type: REDERIVE_SELECTED_LEADS,
      status: "failed",
      completedAt: daysAgo(120),
      updatedAt: daysAgo(120),
      expectDeleted: false,
    },
    {
      label: "pending-old",
      type: REDERIVE_SELECTED_LEADS,
      status: "pending",
      completedAt: null,
      updatedAt: daysAgo(120),
      expectDeleted: false,
    },

    // --- Cancelled rows of a DIFFERENT job type, old enough to be
    //     deleted if the type filter were missing: must be kept.
    {
      label: "other-type-cancelled-old",
      type: OTHER_JOB_TYPE,
      status: "cancelled",
      completedAt: daysAgo(120),
      updatedAt: daysAgo(120),
      expectDeleted: false,
    },
  ];

  seeded = [];
  for (const spec of specs) {
    const [row] = await db
      .insert(backgroundJobsTable)
      .values({
        type: spec.type,
        status: spec.status,
        payload: { __marker: marker, __label: spec.label },
        updatedAt: spec.updatedAt,
        completedAt: spec.completedAt,
        // createdAt defaults to now(); we only care about
        // updatedAt/completedAt for the predicate. runAt also defaults.
      })
      .returning({ id: backgroundJobsTable.id });
    seeded.push({ id: row.id, label: spec.label, expectDeleted: spec.expectDeleted });
  }
});

afterAll(async () => {
  if (seeded.length === 0) return;
  try {
    await db
      .delete(backgroundJobsTable)
      .where(inArray(backgroundJobsTable.id, seeded.map((s) => s.id)));
  } catch {
    /* best-effort cleanup */
  }
});

describe("cleanupOldCancelledSelectedLeadsRederives — real Postgres", () => {
  it("deletes only cancelled rederive_selected_leads rows past the retention window, honoring COALESCE(completed_at, updated_at)", async () => {
    const expectedDeletedIds = seeded.filter((s) => s.expectDeleted).map((s) => s.id).sort((a, b) => a - b);
    const expectedKeptIds = seeded.filter((s) => !s.expectDeleted).map((s) => s.id).sort((a, b) => a - b);

    const deletedCount = await cleanupOldCancelledSelectedLeadsRederives(RETENTION_DAYS);

    // The function may delete OTHER stale cancelled rederive_selected_leads
    // rows that pre-existed in the dev DB. We assert it deleted AT LEAST
    // the rows we expected, and (below) that none of the rows we expected
    // to keep were touched.
    expect(deletedCount).toBeGreaterThanOrEqual(expectedDeletedIds.length);

    const survivors = await db
      .select({ id: backgroundJobsTable.id })
      .from(backgroundJobsTable)
      .where(inArray(backgroundJobsTable.id, seeded.map((s) => s.id)));
    const survivorIds = survivors.map((r) => r.id).sort((a, b) => a - b);

    // Every row we expected to keep is still present.
    for (const id of expectedKeptIds) {
      expect(survivorIds).toContain(id);
    }
    // Every row we expected to delete is gone.
    for (const id of expectedDeletedIds) {
      expect(survivorIds).not.toContain(id);
    }
    // And the survivor set is exactly the kept set — nothing extra was
    // wiped from the seeded fixture.
    expect(survivorIds).toEqual(expectedKeptIds);
  });

  it("is idempotent — a second sweep deletes nothing from the seeded fixture", async () => {
    const beforeIds = (
      await db
        .select({ id: backgroundJobsTable.id })
        .from(backgroundJobsTable)
        .where(inArray(backgroundJobsTable.id, seeded.map((s) => s.id)))
    ).map((r) => r.id).sort((a, b) => a - b);

    await cleanupOldCancelledSelectedLeadsRederives(RETENTION_DAYS);

    const afterIds = (
      await db
        .select({ id: backgroundJobsTable.id })
        .from(backgroundJobsTable)
        .where(inArray(backgroundJobsTable.id, seeded.map((s) => s.id)))
    ).map((r) => r.id).sort((a, b) => a - b);

    expect(afterIds).toEqual(beforeIds);
  });

  it("rejects non-positive retentionDays even against a real DB (no DELETE issued)", async () => {
    // Insert one cancelled-old row and verify it survives a rejected call.
    const [row] = await db
      .insert(backgroundJobsTable)
      .values({
        type: REDERIVE_SELECTED_LEADS,
        status: "cancelled",
        payload: { __marker: "cleanup-int-reject" },
        updatedAt: daysAgo(120),
        completedAt: daysAgo(120),
      })
      .returning({ id: backgroundJobsTable.id });
    try {
      await expect(cleanupOldCancelledSelectedLeadsRederives(0)).rejects.toThrow(
        /invalid retentionDays/,
      );
      const [stillThere] = await db
        .select({ id: backgroundJobsTable.id })
        .from(backgroundJobsTable)
        .where(eq(backgroundJobsTable.id, row.id));
      expect(stillThere?.id).toBe(row.id);
    } finally {
      await db.delete(backgroundJobsTable).where(eq(backgroundJobsTable.id, row.id));
    }
  });
});
