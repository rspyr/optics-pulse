import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, tenantsTable, trackerHeartbeatsTable, attributionEventsTable, googleSheetConfigsTable } from "@workspace/db";
import { eq, and, gte, isNotNull, ne, sql, desc } from "drizzle-orm";

const router: IRouter = Router();

function requireManagerRole(req: Request, res: Response, next: NextFunction) {
  const role = (req.session as Record<string, unknown>)?.userRole as string | undefined;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied. Requires manager role." });
    return;
  }
  next();
}

function resolveTenantId(req: Request): number | null {
  const session = req.session as Record<string, unknown>;
  const role = session?.userRole as string | undefined;
  if (role === "super_admin" || role === "agency_user") {
    return req.query.tenantId ? Number(req.query.tenantId) : (session.tenantId as number | null) ?? null;
  }
  return (session?.tenantId as number | null) ?? null;
}

router.use("/ingestion-mode", requireManagerRole);

router.get("/ingestion-mode", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const [tenant] = await db.select({ leadIngestionMode: tenantsTable.leadIngestionMode })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));

  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  res.json({ mode: tenant.leadIngestionMode });
});

router.put("/ingestion-mode", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const role = (req as any).session?.role || (req as any).user?.role;
  if (!role || !["super_admin", "agency_user"].includes(role)) {
    res.status(403).json({ error: "Only agency admins can change ingestion mode" });
    return;
  }

  const { mode } = req.body;
  const valid = ["sheets", "both", "tracker"];
  if (!mode || !valid.includes(mode)) {
    res.status(400).json({ error: `mode must be one of: ${valid.join(", ")}` });
    return;
  }

  const [tenant] = await db.select({ currentMode: tenantsTable.leadIngestionMode })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  const previousMode = tenant?.currentMode || "sheets";

  await db.update(tenantsTable)
    .set({ leadIngestionMode: mode, updatedAt: new Date() })
    .where(eq(tenantsTable.id, tenantId));

  if (mode === "tracker" && previousMode !== "tracker") {
    await db.update(googleSheetConfigsTable)
      .set({ syncPaused: true })
      .where(eq(googleSheetConfigsTable.tenantId, tenantId));
  } else if (mode === "sheets" && previousMode === "tracker") {
    await db.update(googleSheetConfigsTable)
      .set({ syncPaused: false })
      .where(eq(googleSheetConfigsTable.tenantId, tenantId));
  }

  console.log(`[IngestionMode] Tenant ${tenantId}: ${previousMode} → ${mode} (changed by ${role})`);

  res.json({ success: true, mode, previousMode });
});

router.get("/ingestion-mode/status", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [latestHeartbeat] = await db.select().from(trackerHeartbeatsTable)
    .where(eq(trackerHeartbeatsTable.tenantId, tenantId))
    .orderBy(desc(trackerHeartbeatsTable.lastSeenAt))
    .limit(1);
  const trackerHealthy = latestHeartbeat
    ? new Date(latestHeartbeat.lastSeenAt) > twentyFourHoursAgo
    : false;

  const [eventCount] = await db.select({ count: sql<number>`count(*)::int` })
    .from(attributionEventsTable)
    .where(and(
      eq(attributionEventsTable.tenantId, tenantId),
      gte(attributionEventsTable.createdAt, sevenDaysAgo),
    ));

  const activeSheets = await db.select({ id: googleSheetConfigsTable.id })
    .from(googleSheetConfigsTable)
    .where(and(
      eq(googleSheetConfigsTable.tenantId, tenantId),
      ne(googleSheetConfigsTable.syncPaused, true),
      isNotNull(googleSheetConfigsTable.columnMapping),
    ));

  res.json({
    trackerHealthy,
    lastHeartbeat: latestHeartbeat?.lastSeenAt || null,
    heartbeatDomain: latestHeartbeat?.domain || null,
    recentEventCount: eventCount?.count || 0,
    activeSheetCount: activeSheets.length,
  });
});

router.get("/ingestion-mode/gtm-snippet", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const [tenant] = await db.select({ clientSlug: tenantsTable.clientSlug })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));

  if (!tenant || !tenant.clientSlug) {
    res.status(404).json({ error: "Tenant not found or missing client slug" });
    return;
  }

  const apiBase = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/api-server`
    : process.env.API_BASE_URL || "";

  const trackerUrl = `${apiBase}/tracker.js`;

  const snippet = `<!-- Pulse Attribution Tracker -->
<script src="${trackerUrl}" data-client-id="${tenant.clientSlug}"></script>`;

  res.json({ snippet, clientSlug: tenant.clientSlug });
});

export default router;
