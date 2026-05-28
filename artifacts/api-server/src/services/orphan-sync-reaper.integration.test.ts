/**
 * Real-Postgres integration test for `reapOrphanedSyncLogs`.
 *
 * This is the startup orphan-reaper that runs at server boot (see
 * `src/index.ts`, before the schedulers start). Its job: any sync log left
 * `status='running'` by a worker that died (crash, OOM, deploy) — i.e. an
 * orphan with no live worker to ever finish or cancel it — must be flipped to
 * a terminal `error` state so the run doesn't sit "running" / "Cancelling…"
 * forever. The Force-cancel route in `routes/integrations.ts` explicitly
 * defers the restart case to this reaper, so this test pins that contract.
 *
 * We seed sync logs against a freshly-created throwaway tenant with carefully
 * chosen `started_at` ages and statuses, then assert that after a sweep:
 *   - stale `running` rows (started before the cutoff) ARE reaped → `error`
 *   - fresh `running` rows (inside the window) are left running (a genuinely
 *     in-flight backfill must not be killed)
 *   - already-terminal rows (completed / error / cancelled) are untouched,
 *     even when old enough to fall past the cutoff
 *   - the reaper writes the orphan error message + clears progress columns
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const { db, tenantsTable, integrationSyncLogsTable } = dbModule;

const { reapOrphanedSyncLogs } = await import("./orphan-sync-reaper");

const STALE_MINUTES = 15;
const MIN_MS = 60 * 1000;

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * MIN_MS);
}

async function resyncSerial(table: string, idCol = "id"): Promise<void> {
  await db.execute(
    sql.raw(
      `SELECT setval(pg_get_serial_sequence('${table}','${idCol}'), COALESCE((SELECT MAX(${idCol}) FROM ${table}), 0) + 1, false)`,
    ),
  );
}

async function createTestTenant(): Promise<number> {
  await resyncSerial("tenants");
  const slug = `orphan-reaper-int-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [row] = await db
    .insert(tenantsTable)
    .values({
      name: `Orphan Reaper Int ${slug}`,
      clientSlug: slug,
    })
    .returning({ id: tenantsTable.id });
  return row.id;
}

interface SeedSpec {
  label: string;
  status: "running" | "completed" | "error" | "cancelled";
  startedAt: Date;
  // Whether the reaper should flip this row to `error`.
  expectReaped: boolean;
}

let tenantId: number;
let seeded: Array<{ id: number; label: string; expectReaped: boolean }> = [];

beforeAll(async () => {
  tenantId = await createTestTenant();

  const specs: SeedSpec[] = [
    // --- Stale running orphans (no live worker): MUST be reaped.
    {
      label: "running-stale-1hr",
      status: "running",
      startedAt: minutesAgo(60),
      expectReaped: true,
    },
    {
      label: "running-just-past-cutoff",
      status: "running",
      startedAt: minutesAgo(STALE_MINUTES + 1),
      expectReaped: true,
    },

    // --- Fresh running rows (genuinely in-flight): MUST be left running.
    {
      label: "running-fresh-now",
      status: "running",
      startedAt: minutesAgo(0),
      expectReaped: false,
    },
    {
      label: "running-just-inside-cutoff",
      status: "running",
      startedAt: minutesAgo(STALE_MINUTES - 2),
      expectReaped: false,
    },

    // --- Already-terminal rows, old enough to be past the cutoff: MUST be
    //     left untouched regardless of age (only `running` is swept).
    {
      label: "completed-old",
      status: "completed",
      startedAt: minutesAgo(120),
      expectReaped: false,
    },
    {
      label: "error-old",
      status: "error",
      startedAt: minutesAgo(120),
      expectReaped: false,
    },
    {
      label: "cancelled-old",
      status: "cancelled",
      startedAt: minutesAgo(120),
      expectReaped: false,
    },
  ];

  seeded = [];
  for (const spec of specs) {
    const [row] = await db
      .insert(integrationSyncLogsTable)
      .values({
        tenantId,
        integration: "meta",
        syncType: "backfill",
        status: spec.status,
        startedAt: spec.startedAt,
        // Seed progress columns on the stale running rows so we can assert the
        // reaper clears them when it terminates the run.
        progressCurrentChunk: spec.status === "running" ? 3 : null,
        progressTotalChunks: spec.status === "running" ? 10 : null,
      })
      .returning({ id: integrationSyncLogsTable.id });
    seeded.push({ id: row.id, label: spec.label, expectReaped: spec.expectReaped });
  }
});

afterAll(async () => {
  try {
    await db
      .delete(integrationSyncLogsTable)
      .where(eq(integrationSyncLogsTable.tenantId, tenantId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  } catch {
    /* best-effort cleanup */
  }
});

describe("reapOrphanedSyncLogs — real Postgres", () => {
  it("flips stale running orphans to error and leaves fresh/terminal rows untouched", async () => {
    const reapedCount = await reapOrphanedSyncLogs(STALE_MINUTES);

    // The shared dev DB may contain other stale running rows; assert the
    // reaper handled AT LEAST our seeded orphans.
    const expectedReaped = seeded.filter((s) => s.expectReaped);
    expect(reapedCount).toBeGreaterThanOrEqual(expectedReaped.length);

    const rows = await db
      .select({
        id: integrationSyncLogsTable.id,
        status: integrationSyncLogsTable.status,
        errorMessage: integrationSyncLogsTable.errorMessage,
        errorCode: integrationSyncLogsTable.errorCode,
        completedAt: integrationSyncLogsTable.completedAt,
        progressCurrentChunk: integrationSyncLogsTable.progressCurrentChunk,
        progressTotalChunks: integrationSyncLogsTable.progressTotalChunks,
      })
      .from(integrationSyncLogsTable)
      .where(inArray(integrationSyncLogsTable.id, seeded.map((s) => s.id)));

    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const s of seeded) {
      const row = byId.get(s.id);
      expect(row, `row ${s.label} should still exist`).toBeDefined();
      if (!row) continue;

      if (s.expectReaped) {
        expect(row.status, `${s.label} should be reaped to error`).toBe("error");
        expect(row.errorMessage ?? "").toMatch(/orphaned by server restart/i);
        expect(row.errorCode).toBe("unknown");
        expect(row.completedAt).not.toBeNull();
        // Progress metadata is cleared so the UI doesn't render a stuck bar.
        expect(row.progressCurrentChunk).toBeNull();
        expect(row.progressTotalChunks).toBeNull();
      } else {
        // Not reaped: the status it was seeded with must be preserved.
        const original = seeded.find((x) => x.id === s.id)!;
        const expectedStatus = specStatusFor(original.label);
        expect(row.status, `${s.label} must be left untouched`).toBe(expectedStatus);
        expect(row.errorMessage ?? "").not.toMatch(/orphaned by server restart/i);
      }
    }
  });

  it("stamps the caller-supplied reason into the orphan error message (periodic sweep path)", async () => {
    // The periodic scheduler sweep reuses this same logic but passes a long
    // threshold + a "periodic reaper sweep" reason so the recovered row's
    // error message reflects how it was reaped (not "server restart"). Seed a
    // fresh stale orphan and reap it with a custom reason.
    const [orphan] = await db
      .insert(integrationSyncLogsTable)
      .values({
        tenantId,
        integration: "meta",
        syncType: "backfill",
        status: "running",
        startedAt: minutesAgo(90),
      })
      .returning({ id: integrationSyncLogsTable.id });

    const reaped = await reapOrphanedSyncLogs(60, "periodic reaper sweep");
    expect(reaped).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({
        status: integrationSyncLogsTable.status,
        errorMessage: integrationSyncLogsTable.errorMessage,
      })
      .from(integrationSyncLogsTable)
      .where(eq(integrationSyncLogsTable.id, orphan.id));

    expect(row.status).toBe("error");
    expect(row.errorMessage ?? "").toMatch(/orphaned by periodic reaper sweep/i);
    expect(row.errorMessage ?? "").not.toMatch(/server restart/i);

    seeded.push({ id: orphan.id, label: "running-periodic-reaped", expectReaped: true });
  });

  it("is idempotent — a second sweep does not re-touch already-terminal rows", async () => {
    // Snapshot the fresh-running rows; a second sweep should still not reap
    // them (they're inside the window) and must not disturb terminal rows.
    const before = await db
      .select({ id: integrationSyncLogsTable.id, status: integrationSyncLogsTable.status })
      .from(integrationSyncLogsTable)
      .where(inArray(integrationSyncLogsTable.id, seeded.map((s) => s.id)));

    await reapOrphanedSyncLogs(STALE_MINUTES);

    const after = await db
      .select({ id: integrationSyncLogsTable.id, status: integrationSyncLogsTable.status })
      .from(integrationSyncLogsTable)
      .where(inArray(integrationSyncLogsTable.id, seeded.map((s) => s.id)));

    const afterById = new Map(after.map((r) => [r.id, r.status]));
    for (const row of before) {
      expect(afterById.get(row.id)).toBe(row.status);
    }
  });
});

describe("reapOrphanedSyncLogs — inactivity-keyed periodic sweep", () => {
  // These tests pin the end-to-end periodic-sweep contract: staleness keys off
  // INACTIVITY — `COALESCE(progress_updated_at, started_at)` — not absolute
  // age. The periodic scheduler sweep (`reapOrphanedSyncLogs(threshold,
  // "periodic reaper sweep")`) recovers a backfill that stamped progress then
  // silently died, while a backfill that keeps stamping progress survives an
  // arbitrarily long run.

  async function insertRunningBackfill(opts: {
    startedAt: Date;
    progressUpdatedAt: Date | null;
  }): Promise<number> {
    const [row] = await db
      .insert(integrationSyncLogsTable)
      .values({
        tenantId,
        integration: "meta",
        syncType: "backfill",
        status: "running",
        startedAt: opts.startedAt,
        progressUpdatedAt: opts.progressUpdatedAt,
        progressCurrentChunk: 4,
        progressTotalChunks: 12,
      })
      .returning({ id: integrationSyncLogsTable.id });
    // Track for afterAll cleanup.
    seeded.push({ id: row.id, label: "inactivity-keyed", expectReaped: false });
    return row.id;
  }

  async function statusOf(id: number): Promise<string | undefined> {
    const [row] = await db
      .select({ status: integrationSyncLogsTable.status })
      .from(integrationSyncLogsTable)
      .where(eq(integrationSyncLogsTable.id, id));
    return row?.status;
  }

  it("recovers a backfill that stamped progress and then died, once it crosses the inactivity threshold", async () => {
    // A backfill that started long ago (well past the threshold) but is still
    // actively stamping progress: last activity is recent, so the sweep must
    // leave it running even though `started_at` is ancient.
    const id = await insertRunningBackfill({
      startedAt: minutesAgo(120),
      progressUpdatedAt: minutesAgo(2),
    });

    let reaped = await reapOrphanedSyncLogs(STALE_MINUTES, "periodic reaper sweep");
    expect(reaped).toBeGreaterThanOrEqual(0);
    expect(
      await statusOf(id),
      "a backfill still stamping progress must not be reaped despite an old started_at",
    ).toBe("running");

    // Now it "dies": its last progress stamp ages past the inactivity
    // threshold (no further progress writes). The next periodic sweep must
    // recover it to a terminal error state.
    await db
      .update(integrationSyncLogsTable)
      .set({ progressUpdatedAt: minutesAgo(STALE_MINUTES + 1) })
      .where(eq(integrationSyncLogsTable.id, id));

    reaped = await reapOrphanedSyncLogs(STALE_MINUTES, "periodic reaper sweep");
    expect(reaped).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({
        status: integrationSyncLogsTable.status,
        errorMessage: integrationSyncLogsTable.errorMessage,
        completedAt: integrationSyncLogsTable.completedAt,
        progressCurrentChunk: integrationSyncLogsTable.progressCurrentChunk,
        progressTotalChunks: integrationSyncLogsTable.progressTotalChunks,
      })
      .from(integrationSyncLogsTable)
      .where(eq(integrationSyncLogsTable.id, id));

    expect(row.status, "a dead backfill must be reaped to error").toBe("error");
    expect(row.errorMessage ?? "").toMatch(/orphaned by periodic reaper sweep/i);
    expect(row.completedAt).not.toBeNull();
    // Stuck progress metadata is cleared so the UI doesn't render a frozen bar.
    expect(row.progressCurrentChunk).toBeNull();
    expect(row.progressTotalChunks).toBeNull();
  });

  it("never reaps a run that keeps refreshing progress past the old 6-hour mark", async () => {
    // Started 8 hours ago — well past the legacy 6-hour (360-min) cutoff that
    // an absolute-age reaper would have killed. Because it keeps stamping
    // progress, every periodic sweep at the 360-min threshold must leave it
    // running, no matter how long the run goes.
    const PERIODIC_THRESHOLD = 360;
    const id = await insertRunningBackfill({
      startedAt: minutesAgo(8 * 60),
      progressUpdatedAt: minutesAgo(1),
    });

    // Simulate several scheduler ticks: each time the backfill refreshes
    // `progress_updated_at` just before the sweep runs, it survives — even
    // though `started_at` keeps getting older.
    for (let tick = 0; tick < 3; tick++) {
      await db
        .update(integrationSyncLogsTable)
        .set({ progressUpdatedAt: new Date() })
        .where(eq(integrationSyncLogsTable.id, id));

      await reapOrphanedSyncLogs(PERIODIC_THRESHOLD, "periodic reaper sweep");

      expect(
        await statusOf(id),
        `tick ${tick}: a backfill refreshing progress must outlive the 6-hour mark`,
      ).toBe("running");
    }
  });
});

function specStatusFor(label: string): string {
  if (label.startsWith("running")) return "running";
  if (label.startsWith("completed")) return "completed";
  if (label.startsWith("error")) return "error";
  if (label.startsWith("cancelled")) return "cancelled";
  throw new Error(`unknown label ${label}`);
}
