import { db, notificationsTable, integrationSyncLogsTable, trackerHeartbeatsTable, trackerSubmitAttemptsTable, tenantsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";

export async function createNotification(params: {
  tenantId: number | null;
  type: string;
  severity: string;
  title: string;
  message: string;
  integration?: string;
}) {
  const [notification] = await db.insert(notificationsTable).values({
    tenantId: params.tenantId,
    type: params.type,
    severity: params.severity,
    title: params.title,
    message: params.message,
    integration: params.integration || null,
  }).returning();
  return notification;
}

export async function emitSyncFailureNotification(tenantId: number, integration: string, errorMessage: string) {
  const cooldownMs = 15 * 60 * 1000;
  const [recentNotification] = await db.select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.type, "sync_failure"),
        eq(notificationsTable.integration, integration),
        sql`${notificationsTable.createdAt} > ${new Date(Date.now() - cooldownMs)}`,
      ),
    )
    .limit(1);

  if (recentNotification) {
    console.log(`[Notifications] Suppressed duplicate sync failure notification for ${integration} (tenant ${tenantId}) — within cooldown`);
    return;
  }

  const recentLogs = await db.select({
    status: integrationSyncLogsTable.status,
  })
    .from(integrationSyncLogsTable)
    .where(
      and(
        eq(integrationSyncLogsTable.tenantId, tenantId),
        eq(integrationSyncLogsTable.integration, integration),
      ),
    )
    .orderBy(desc(integrationSyncLogsTable.completedAt))
    .limit(5);

  let consecutiveFailures = 0;
  for (const log of recentLogs) {
    if (log.status === "error") {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  const integrationLabel = integration.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const severity = consecutiveFailures >= 3 ? "critical" : "warning";
  const title = consecutiveFailures >= 3
    ? `${integrationLabel} sync failing repeatedly (${consecutiveFailures}x)`
    : `${integrationLabel} sync failed`;

  await createNotification({
    tenantId,
    type: "sync_failure",
    severity,
    title,
    message: errorMessage,
    integration,
  });

  console.log(`[Notifications] Created ${severity} notification for ${integration} sync failure (tenant ${tenantId}, ${consecutiveFailures} consecutive)`);
}

export async function checkStaleHeartbeats() {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const tenants = await db.select({ id: tenantsTable.id, name: tenantsTable.name })
    .from(tenantsTable)
    .where(eq(tenantsTable.isActive, true));

  const heartbeats = await db.select().from(trackerHeartbeatsTable);

  let alertsCreated = 0;

  for (const tenant of tenants) {
    const tenantHeartbeats = heartbeats.filter(h => h.tenantId === tenant.id);
    if (tenantHeartbeats.length === 0) continue;

    const latest = tenantHeartbeats.sort(
      (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
    )[0];

    if (new Date(latest.lastSeenAt) < twentyFourHoursAgo) {
      const existingRecent = await db.select({ id: notificationsTable.id })
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.tenantId, tenant.id),
            eq(notificationsTable.type, "stale_heartbeat"),
            eq(notificationsTable.isDismissed, false),
            sql`${notificationsTable.createdAt} > ${new Date(Date.now() - 24 * 60 * 60 * 1000)}`,
          ),
        )
        .limit(1);

      if (existingRecent.length === 0) {
        const hoursStale = Math.round((Date.now() - new Date(latest.lastSeenAt).getTime()) / (60 * 60 * 1000));
        await createNotification({
          tenantId: tenant.id,
          type: "stale_heartbeat",
          severity: "warning",
          title: `Tracker heartbeat stale for ${tenant.name}`,
          message: `No heartbeat received in ${hoursStale} hours. Last seen: ${new Date(latest.lastSeenAt).toISOString()}`,
        });
        alertsCreated++;
      }
    }
  }

  if (alertsCreated > 0) {
    console.log(`[Notifications] Created ${alertsCreated} stale heartbeat alerts`);
  }
}

/**
 * Detect "tracker installed but never collecting submits" — the silent
 * failure mode that prompted Task #248. A tenant is considered to have a
 * stale install when:
 *
 *   - At least 5 heartbeats have arrived in the last 7 days (the page is
 *     definitely being visited and pulse.js is loading), AND
 *   - Zero successful /collect/submit attempts have arrived in the last
 *     7 days from any of that tenant's heartbeat domains.
 *
 * The 5-heartbeat floor is the smallest sample where "never submitted"
 * starts to mean "the install is broken" rather than "the page got one
 * accidental visit". Below that threshold we leave the tenant alone to
 * avoid false alarms on test/staging hosts.
 *
 * Notifications use a 15-minute cooldown — short enough to stay loud
 * during an active outage, long enough to avoid notification spam if a
 * page is in active development with the tracker getting toggled.
 */
const STALE_INSTALL_COOLDOWN_MS = 15 * 60 * 1000;
const STALE_INSTALL_HEARTBEAT_THRESHOLD = 5;

export async function checkStaleInstall() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const tenants = await db.select({ id: tenantsTable.id, name: tenantsTable.name })
    .from(tenantsTable)
    .where(eq(tenantsTable.isActive, true));

  let alertsCreated = 0;

  for (const tenant of tenants) {
    // Heartbeat EVENT count from the audit table (kind='heartbeat'); using
    // tracker_heartbeats would undercount because it's upsert-on-change.
    const [hbRow] = await db.select({
      n: sql<number>`COUNT(*)::int`,
      sampleDomain: sql<string | null>`MIN(${trackerSubmitAttemptsTable.domain})`,
    })
      .from(trackerSubmitAttemptsTable)
      .where(and(
        eq(trackerSubmitAttemptsTable.tenantId, tenant.id),
        eq(trackerSubmitAttemptsTable.kind, "heartbeat"),
        sql`${trackerSubmitAttemptsTable.createdAt} > ${sevenDaysAgo}`,
      ));
    const heartbeatCount = hbRow?.n ?? 0;
    const sampleDomain = hbRow?.sampleDomain ?? "(unknown)";

    if (heartbeatCount < STALE_INSTALL_HEARTBEAT_THRESHOLD) continue;

    // Successful submit outcomes are accepted|duplicate|resubmitted (the
    // legacy "ok" value would mark every healthy tenant stale).
    const [submitRow] = await db.select({
      n: sql<number>`COUNT(*)::int`,
    })
      .from(trackerSubmitAttemptsTable)
      .where(and(
        eq(trackerSubmitAttemptsTable.tenantId, tenant.id),
        eq(trackerSubmitAttemptsTable.endpoint, "submit"),
        sql`${trackerSubmitAttemptsTable.outcome} IN ('accepted', 'duplicate', 'resubmitted')`,
        sql`${trackerSubmitAttemptsTable.createdAt} > ${sevenDaysAgo}`,
      ));

    const submitCount = submitRow?.n ?? 0;
    if (submitCount > 0) continue;

    // Cooldown check — don't re-notify within 15 minutes for the same tenant.
    const cooldownSince = new Date(Date.now() - STALE_INSTALL_COOLDOWN_MS);
    const existingRecent = await db.select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(and(
        eq(notificationsTable.tenantId, tenant.id),
        eq(notificationsTable.type, "stale_install"),
        sql`${notificationsTable.createdAt} > ${cooldownSince}`,
      ))
      .limit(1);
    if (existingRecent.length > 0) continue;

    await createNotification({
      tenantId: tenant.id,
      type: "stale_install",
      // "warning" not "error": the tracker IS loading and beaconing, the
      // pages are live — but submits never arrive. That's a stuck-pipeline
      // signal that warrants attention without paging an on-call.
      severity: "warning",
      title: `Pulse install broken for ${tenant.name}`,
      message: `pulse.js heartbeats are arriving (${heartbeatCount} in the last 7 days, e.g. from ${sampleDomain}) but ZERO successful form submits. The tracker is loaded but cannot see the form — open Verify Tracker on this page to investigate.`,
    });
    alertsCreated++;
  }

  if (alertsCreated > 0) {
    console.log(`[Notifications] Created ${alertsCreated} stale-install alerts`);
  }
}

let staleInstallTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the stale-install monitor. Runs once at startup (after a short
 * delay so the DB is warm) then every 15 minutes — matching the cooldown
 * window so a fixed install will reset the alert promptly once submits
 * resume.
 */
export function startStaleInstallMonitor() {
  if (staleInstallTimer) clearInterval(staleInstallTimer);

  setTimeout(() => {
    checkStaleInstall().catch(err =>
      console.error("[Notifications] Initial stale-install check failed:", err)
    );
  }, 30_000);

  staleInstallTimer = setInterval(() => {
    checkStaleInstall().catch(err =>
      console.error("[Notifications] Periodic stale-install check failed:", err)
    );
  }, STALE_INSTALL_COOLDOWN_MS);

  console.log("[Notifications] Stale-install monitor started (every 15min, threshold 5+ heartbeats and 0 submits in 7d)");
}

let heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeatMonitor() {
  if (heartbeatCheckTimer) clearInterval(heartbeatCheckTimer);

  checkStaleHeartbeats().catch(err =>
    console.error("[Notifications] Initial heartbeat check failed:", err)
  );

  heartbeatCheckTimer = setInterval(async () => {
    try {
      await checkStaleHeartbeats();
    } catch (err) {
      console.error("[Notifications] Heartbeat check failed:", err);
    }
  }, 60 * 60 * 1000);

  console.log("[Notifications] Heartbeat monitor started (checks every 60 min)");
}

export function stopHeartbeatMonitor() {
  if (heartbeatCheckTimer) {
    clearInterval(heartbeatCheckTimer);
    heartbeatCheckTimer = null;
  }
}
