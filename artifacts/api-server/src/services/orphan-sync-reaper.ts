import { and, eq, lt, sql } from "drizzle-orm";
import { db, integrationSyncLogsTable } from "@workspace/db";

/**
 * On server startup, mark any `status='running'` sync log rows older than
 * the threshold as orphaned — the worker that owned them is gone (deploy,
 * crash, OOM). Without this, the row sits at "running" forever and the UI
 * gets stuck on "Cancelling…" because there's no worker to pick up the
 * cancel flag.
 *
 * Conservative threshold: only sweep rows whose `started_at` is older than
 * `staleMinutes`. A genuinely-running fresh backfill won't be touched.
 */
export async function reapOrphanedSyncLogs(staleMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  const orphans = await db.select({ id: integrationSyncLogsTable.id, integration: integrationSyncLogsTable.integration, tenantId: integrationSyncLogsTable.tenantId, recordsProcessed: integrationSyncLogsTable.recordsProcessed })
    .from(integrationSyncLogsTable)
    .where(and(eq(integrationSyncLogsTable.status, "running"), lt(integrationSyncLogsTable.startedAt, cutoff)));

  if (orphans.length === 0) return 0;

  await db.update(integrationSyncLogsTable)
    .set({
      status: "error",
      completedAt: new Date(),
      errorMessage: `Sync orphaned by server restart (was running for > ${staleMinutes} min with no progress update)`,
      errorCode: "unknown",
      progressCurrentChunk: null,
      progressTotalChunks: null,
      progressWindowStart: null,
      progressWindowEnd: null,
    })
    .where(and(eq(integrationSyncLogsTable.status, "running"), lt(integrationSyncLogsTable.startedAt, cutoff)));

  for (const row of orphans) {
    console.warn(`[OrphanReaper] Marked sync log #${row.id} (${row.integration}, tenant ${row.tenantId}, ${row.recordsProcessed} rows) as orphaned — server restart`);
  }
  return orphans.length;
}
