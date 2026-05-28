import { db, notificationsTable, integrationSyncLogsTable, trackerHeartbeatsTable, trackerSubmitAttemptsTable, tenantsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";

export async function createNotification(params: {
  tenantId: number | null;
  type: string;
  severity: string;
  title: string;
  message: string;
  integration?: string;
  actionUrl?: string;
  actionLabel?: string;
}) {
  const [notification] = await db.insert(notificationsTable).values({
    tenantId: params.tenantId,
    type: params.type,
    severity: params.severity,
    title: params.title,
    message: params.message,
    integration: params.integration || null,
    actionUrl: params.actionUrl || null,
    actionLabel: params.actionLabel || null,
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

/**
 * Operator-visible alert when the nightly sync detected a tenant's watermark
 * had fallen so far behind that the catch-up window was clamped, and an
 * auto-backfill was enqueued to fill the gap. Distinct `type` ("sync_catchup")
 * from hard failures so the copy/severity reads as informational, not "broken".
 *
 * De-duplication: callers already gate the enqueue on the in-flight backfill
 * check, so this fires at most once per nightly tick. We additionally apply a
 * 1h per-(tenant, integration) cooldown to defend against re-emission if the
 * nightly job somehow runs twice in close succession.
 */
export async function emitSyncCatchupNotification(
  tenantId: number,
  integration: string,
  reason: string,
  days: number,
) {
  const cooldownMs = 60 * 60 * 1000;
  const [recent] = await db.select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.type, "sync_catchup"),
        eq(notificationsTable.integration, integration),
        sql`${notificationsTable.createdAt} > ${new Date(Date.now() - cooldownMs)}`,
      ),
    )
    .limit(1);

  if (recent) {
    console.log(`[Notifications] Suppressed duplicate sync catch-up notification for ${integration} (tenant ${tenantId}) — within cooldown`);
    return;
  }

  const integrationLabel = integration.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  await createNotification({
    tenantId,
    type: "sync_catchup",
    severity: "warning",
    title: `${integrationLabel} fell behind — auto-backfill started`,
    message: `Nightly sync was clamped (${reason}); auto-enqueued a ${days}-day backfill to catch up.`,
    integration,
  });

  console.log(`[Notifications] Created sync_catchup notification for ${integration} (tenant ${tenantId}, ${days}d, reason=${reason})`);
}

/**
 * Operator-visible alert when the sheet-sync poller has been drift-skipping
 * a connected Google Sheet for more than a few cycles — meaning new leads
 * are NOT being imported because someone added/renamed a column upstream
 * and the operator-approved mapping no longer fits the live headers.
 *
 * De-duplication: callers stamp `drift_notified_at` on the sheet config
 * once we fire, and only re-call this if drift persists past a fresh
 * grace window (i.e. the operator has not fixed it). A short
 * per-(tenant, sheet) cooldown defends against re-emission inside the
 * same drift episode.
 */
export async function emitSheetDriftNotification(params: {
  tenantId: number;
  sheetConfigId: number;
  sheetName: string;
  driftMinutes: number;
}) {
  const { tenantId, sheetConfigId, sheetName, driftMinutes } = params;
  const cooldownMs = 60 * 60 * 1000;
  const integrationKey = `google_sheets:${sheetConfigId}`;

  const [recent] = await db.select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.type, "sheet_headers_drift"),
        eq(notificationsTable.integration, integrationKey),
        sql`${notificationsTable.createdAt} > ${new Date(Date.now() - cooldownMs)}`,
      ),
    )
    .limit(1);

  if (recent) {
    console.log(`[Notifications] Suppressed duplicate sheet_headers_drift notification for sheet ${sheetConfigId} (tenant ${tenantId}) — within cooldown`);
    return false;
  }

  await createNotification({
    tenantId,
    type: "sheet_headers_drift",
    severity: "critical",
    title: `Lead sheet "${sheetName}" stopped importing — columns changed`,
    message:
      `Pulse has skipped ${driftMinutes} minute(s) of new leads from "${sheetName}" because its column headers no longer match the approved mapping. ` +
      `Re-analyze the sheet to re-approve the mapping and resume imports.`,
    integration: integrationKey,
    actionUrl: `/sales-manager?tenantId=${tenantId}&sheetConfig=${sheetConfigId}&reanalyze=1#sheet-config-${sheetConfigId}`,
    actionLabel: "Re-analyze sheet",
  });

  console.log(`[Notifications] Created sheet_headers_drift notification for sheet ${sheetConfigId} (tenant ${tenantId}, ${driftMinutes}m drifted)`);
  return true;
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

// stale = 5+ heartbeats and zero accepted/duplicate/resubmitted in trailing 7d (per tenant+domain)
const STALE_INSTALL_COOLDOWN_MS = 15 * 60 * 1000;
const STALE_INSTALL_HEARTBEAT_THRESHOLD = 5;

export async function checkStaleInstall() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cooldownSince = new Date(Date.now() - STALE_INSTALL_COOLDOWN_MS);
  let alertsCreated = 0;

  // group heartbeats by (tenant, domain), join successful submits + recent stale alert
  const result = await db.execute(sql`
    WITH hb AS (
      SELECT tsa.tenant_id, tsa.domain, COUNT(*)::int AS n
      FROM tracker_submit_attempts tsa
      WHERE tsa.kind = 'heartbeat'
        AND tsa.domain IS NOT NULL
        AND tsa.tenant_id IS NOT NULL
        AND tsa.created_at > ${sevenDaysAgo}
      GROUP BY tsa.tenant_id, tsa.domain
      HAVING COUNT(*) >= ${STALE_INSTALL_HEARTBEAT_THRESHOLD}
    ),
    ok_submits AS (
      SELECT tsa.tenant_id, tsa.domain, COUNT(*)::int AS n
      FROM tracker_submit_attempts tsa
      WHERE tsa.endpoint = 'submit'
        AND tsa.outcome IN ('accepted','duplicate','resubmitted')
        AND tsa.tenant_id IS NOT NULL
        AND tsa.domain IS NOT NULL
        AND tsa.created_at > ${sevenDaysAgo}
      GROUP BY tsa.tenant_id, tsa.domain
    )
    SELECT hb.tenant_id, hb.domain, hb.n AS heartbeat_count, t.name AS tenant_name
    FROM hb
    JOIN tenants t ON t.id = hb.tenant_id AND t.is_active = true
    LEFT JOIN ok_submits s ON s.tenant_id = hb.tenant_id AND s.domain = hb.domain
    WHERE COALESCE(s.n, 0) = 0
  `);
  const candidates = (result as unknown as { rows: Array<{
    tenant_id: number; domain: string; heartbeat_count: number; tenant_name: string;
  }> }).rows ?? [];

  for (const c of candidates) {
    const existing = await db.select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(and(
        eq(notificationsTable.tenantId, c.tenant_id),
        eq(notificationsTable.type, "stale_install"),
        sql`${notificationsTable.title} LIKE ${`%${c.domain}%`}`,
        sql`${notificationsTable.createdAt} > ${cooldownSince}`,
      ))
      .limit(1);
    if (existing.length > 0) continue;

    await createNotification({
      tenantId: c.tenant_id,
      type: "stale_install",
      severity: "warning",
      title: `Pulse install broken on ${c.domain} (${c.tenant_name})`,
      message: `${c.heartbeat_count} pulse.js heartbeats in the last 7 days from ${c.domain} but ZERO successful form submits. The tracker is loaded but cannot see the form — open Verify Tracker on this page to investigate.`,
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
