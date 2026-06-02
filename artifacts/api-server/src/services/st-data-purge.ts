import { db, jobsTable, integrationSyncLogsTable, tenantsTable } from "@workspace/db";
import { and, or, isNull, isNotNull, lte, eq, sql } from "drizzle-orm";

async function purgeExpiredStData(): Promise<void> {
  const now = new Date();

  // Only the internal ServiceTitan ids are still purged at 24h. Customer name +
  // service address are retained indefinitely (Task #819) and, per the operator
  // decision in Task #825, phone + email are now ALSO retained indefinitely so
  // the revenue-attribution panel and lead matching keep working past 24h. The
  // job number (st_job_number) is a portal reference, not PII. None of those
  // appear in the predicate — keeping them out also stops retained rows from
  // being re-selected every cycle (which would inflate the purge count and
  // re-write unchanged rows).
  const hasAnyStPii = or(
    isNotNull(jobsTable.stJobId),
    isNotNull(jobsTable.stCustomerId),
    isNotNull(jobsTable.stLocationId),
  );

  const fallbackCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Hard retention bound: internal ST ids are ALWAYS purged after this window
  // regardless of enrichment state, so they can never linger indefinitely.
  const HARD_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;
  const hardCutoff = new Date(now.getTime() - HARD_CUTOFF_MS);

  // Safety gate (Task #825): the internal ids are the ONLY key that can re-fetch
  // a job's customer from ServiceTitan. If we strip them at 24h before
  // enrichment has captured the customer name, the row becomes a permanently
  // unrecoverable-by-id orphan (the failure mode this task fixes). So the normal
  // 24h purge is deferred until a real customer name is present; the `Customer
  // <id>` placeholder the sync writes when ST returned no customer counts as
  // "not yet enriched". The hard cutoff above still bounds total retention.
  const hasRecoverableName = and(
    isNotNull(jobsTable.customerName),
    sql`${jobsTable.customerName} !~ '^Customer [0-9]+$'`,
  );

  const expiredJobs = await db.select({
    id: jobsTable.id,
    tenantId: jobsTable.tenantId,
  }).from(jobsTable).where(
    and(
      hasAnyStPii,
      or(
        // Hard bound: purge regardless of enrichment state once well past 24h.
        lte(jobsTable.createdAt, hardCutoff),
        // Normal 24h purge, but only once the recoverable name is captured.
        and(
          hasRecoverableName,
          or(
            and(isNotNull(jobsTable.stDataExpiresAt), lte(jobsTable.stDataExpiresAt, now)),
            and(isNull(jobsTable.stDataExpiresAt), lte(jobsTable.createdAt, fallbackCutoff)),
          ),
        ),
      ),
    )
  );

  const tenants = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.isActive, true));
  const tenantCounts = new Map<number, number>();
  for (const tenant of tenants) {
    tenantCounts.set(tenant.id, 0);
  }

  if (expiredJobs.length > 0) {
    const expiredIds = expiredJobs.map((j) => j.id);

    await db.update(jobsTable)
      .set({
        // customerName, serviceAddress, stJobNumber, phone and email are all
        // deliberately retained: name + address survive past 24h (Task #819),
        // the job number is a portal reference (not PII), and phone + email are
        // now retained indefinitely too (Task #825) so attribution + lead
        // matching keep working. Only the internal ST ids are nulled.
        stJobId: null,
        stCustomerId: null,
        stLocationId: null,
        updatedAt: now,
      })
      .where(sql`${jobsTable.id} IN (${sql.join(expiredIds.map((id) => sql`${id}`), sql`, `)})`);

    for (const job of expiredJobs) {
      tenantCounts.set(job.tenantId, (tenantCounts.get(job.tenantId) || 0) + 1);
    }
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

  if (expiredJobs.length > 0) {
    console.log(`[ST Purge] Purged ST PII from ${expiredJobs.length} expired job(s) across ${tenantCounts.size} tenant(s)`);
  } else {
    console.log("[ST Purge] No expired ST data to purge");
  }
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
