import { and, eq, lt, sql } from "drizzle-orm";
import { db, integrationSyncLogsTable } from "@workspace/db";

/**
 * A run is an orphan if it has been `status='running'` with no forward progress
 * for longer than the threshold. Staleness keys off INACTIVITY, not absolute
 * age: `COALESCE(progress_updated_at, started_at)`. A backfill that keeps
 * stamping `progress_updated_at` survives an arbitrarily long run, while one
 * that stamps progress then dies is reaped once it crosses the threshold.
 * `progress_updated_at` is null until the first progress write, so until then
 * we fall back to `started_at`.
 */
const lastActivityExpr = sql`COALESCE(${integrationSyncLogsTable.progressUpdatedAt}, ${integrationSyncLogsTable.startedAt})`;

/**
 * Default inactivity window (minutes) before a `status='running'` row is
 * considered dead. Single source of truth for BOTH reaper entry points (the
 * startup reaper in `src/index.ts` and the periodic scheduler sweep in
 * `sync-scheduler.ts`) so they stay aligned.
 *
 * Sized off the longest gap a *healthy* backfill can go between progress
 * stamps. That gap used to be a whole Meta chunk: progress was stamped only at
 * the start of each 30-day chunk, and a single chunk's async insights report is
 * bounded by a ~5-min poll timeout (`fetchAdDailyInsightsAsync`) — which is why
 * this threshold sat at 15 min (~2.5x margin). The async poll loop now stamps a
 * mid-chunk liveness heartbeat (`heartbeatSyncLogProgress`, throttled to ~30s),
 * so the worst-case inter-stamp gap for a healthy run drops from ~5 min to the
 * heartbeat interval plus the (fast) report-paging/upsert tail. With that gap
 * shrunk, the threshold can be tightened to 5 min and still keep a wide margin,
 * recovering a silently-dead run within roughly one periodic sweep.
 *
 * Because staleness keys off INACTIVITY (not absolute `started_at` age), a
 * long-but-healthy backfill is protected by its own progress stamps regardless
 * of this value — so the old multi-hour buffer is no longer needed. The
 * `ORPHAN_REAPER_STALE_MINUTES` env var can still raise it if an operator sees
 * false reaps on unusually slow chunks.
 *
 * The UI's "Stalled" badge (`STALLED_PROGRESS_MS` in `internal.tsx`, 2 min)
 * is the leading early-warning that precedes this recovery threshold: both are
 * derived from the same `progress_updated_at` inactivity signal.
 */
export const DEFAULT_INACTIVITY_STALE_MINUTES = 5;

/**
 * Mark any `status='running'` sync log rows older than the threshold as
 * orphaned — the worker that owned them is gone (deploy, crash, OOM, a
 * silently-dead backfill loop). Without this, the row sits at "running"
 * forever and the UI gets stuck on "Cancelling…" because there's no worker
 * to pick up the cancel flag.
 *
 * Runs both at server startup (`reason="server restart"`, short threshold —
 * the previous process is definitely dead) and on a periodic scheduler sweep
 * while the process stays up (`reason="periodic reaper sweep"`, long
 * threshold) so a worker that dies mid-flight is recovered without waiting
 * for the next restart.
 *
 * Conservative threshold: only sweep rows whose `started_at` is older than
 * `staleMinutes`. A genuinely-running fresh backfill won't be touched — the
 * periodic caller passes a deliberately long threshold so legitimately
 * long-running backfills are never killed.
 */
export async function reapOrphanedSyncLogs(
  staleMinutes = DEFAULT_INACTIVITY_STALE_MINUTES,
  reason = "server restart",
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  const orphans = await db.select({ id: integrationSyncLogsTable.id, integration: integrationSyncLogsTable.integration, tenantId: integrationSyncLogsTable.tenantId, recordsProcessed: integrationSyncLogsTable.recordsProcessed })
    .from(integrationSyncLogsTable)
    .where(and(eq(integrationSyncLogsTable.status, "running"), lt(lastActivityExpr, cutoff)));

  if (orphans.length === 0) return 0;

  await db.update(integrationSyncLogsTable)
    .set({
      status: "error",
      completedAt: new Date(),
      errorMessage: `Sync orphaned by ${reason} (was running for > ${staleMinutes} min with no progress update)`,
      errorCode: "unknown",
      progressCurrentChunk: null,
      progressTotalChunks: null,
      progressWindowStart: null,
      progressWindowEnd: null,
    })
    .where(and(eq(integrationSyncLogsTable.status, "running"), lt(lastActivityExpr, cutoff)));

  for (const row of orphans) {
    console.warn(`[OrphanReaper] Marked sync log #${row.id} (${row.integration}, tenant ${row.tenantId}, ${row.recordsProcessed} rows) as orphaned — ${reason}`);
  }
  return orphans.length;
}
