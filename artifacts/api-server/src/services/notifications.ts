import { db, notificationsTable, integrationSyncLogsTable, trackerHeartbeatsTable, tenantsTable } from "@workspace/db";
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
