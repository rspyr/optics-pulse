import { db, jobsTable, integrationSyncLogsTable } from "@workspace/db";
import { and, or, isNotNull, lte, eq, sql } from "drizzle-orm";

async function purgeExpiredStData(): Promise<void> {
  const now = new Date();

  const hasAnyStPii = or(
    isNotNull(jobsTable.customerName),
    isNotNull(jobsTable.customerPhone),
    isNotNull(jobsTable.customerEmail),
    isNotNull(jobsTable.serviceAddress),
    isNotNull(jobsTable.stJobId),
    isNotNull(jobsTable.stCustomerId),
    isNotNull(jobsTable.stLocationId),
  );

  const expiredJobs = await db.select({
    id: jobsTable.id,
    tenantId: jobsTable.tenantId,
  }).from(jobsTable).where(
    and(
      isNotNull(jobsTable.stDataExpiresAt),
      lte(jobsTable.stDataExpiresAt, now),
      hasAnyStPii,
    )
  );

  if (expiredJobs.length === 0) {
    console.log("[ST Purge] No expired ST data to purge");
    return;
  }

  const expiredIds = expiredJobs.map((j) => j.id);

  await db.update(jobsTable)
    .set({
      customerName: null,
      customerPhone: null,
      customerEmail: null,
      serviceAddress: null,
      stJobId: null,
      stCustomerId: null,
      stLocationId: null,
      updatedAt: now,
    })
    .where(sql`${jobsTable.id} IN (${sql.join(expiredIds.map((id) => sql`${id}`), sql`, `)})`);

  const tenantCounts = new Map<number, number>();
  for (const job of expiredJobs) {
    tenantCounts.set(job.tenantId, (tenantCounts.get(job.tenantId) || 0) + 1);
  }

  for (const [tenantId, count] of tenantCounts) {
    await db.insert(integrationSyncLogsTable).values({
      tenantId,
      integration: "service_titan",
      syncType: "st_data_purge",
      status: "completed",
      recordsProcessed: count,
      startedAt: now,
      completedAt: new Date(),
    });
  }

  console.log(`[ST Purge] Purged ST PII from ${expiredJobs.length} expired job(s) across ${tenantCounts.size} tenant(s)`);
}

let purgeTimer: ReturnType<typeof setInterval> | null = null;

export function startStDataPurgeScheduler(): void {
  if (purgeTimer) clearInterval(purgeTimer);

  const interval = 60 * 60 * 1000;

  purgeExpiredStData().catch((err) => {
    console.error("[ST Purge] Initial purge failed:", err);
  });

  purgeTimer = setInterval(() => {
    purgeExpiredStData().catch((err) => {
      console.error("[ST Purge] Scheduled purge failed:", err);
    });
  }, interval);

  console.log("[ST Purge] Scheduler started: purging expired ST data every 60 min");
}

export function stopStDataPurgeScheduler(): void {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}
