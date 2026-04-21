import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, tenantsTable, trackerHeartbeatsTable, attributionEventsTable, googleSheetConfigsTable, ingestionAuditLogTable } from "@workspace/db";
import { eq, and, gte, isNotNull, ne, sql, desc } from "drizzle-orm";

const router: IRouter = Router();

function requireManagerRole(req: Request, res: Response, next: NextFunction) {
  const role = req.session.userRole;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied. Requires manager role." });
    return;
  }
  next();
}

function resolveTenantId(req: Request): number | null {
  const session = req.session;
  const role = session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    return req.query.tenantId ? Number(req.query.tenantId) : session.tenantId ?? null;
  }
  return session.tenantId ?? null;
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

  const role = req.session.userRole;
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

  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const previousMode = tenant.currentMode || "sheets";
  const userId = req.session.userId;

  await db.transaction(async (tx) => {
    await tx.update(tenantsTable)
      .set({ leadIngestionMode: mode, updatedAt: new Date() })
      .where(eq(tenantsTable.id, tenantId));

    if (mode === "tracker") {
      await tx.update(googleSheetConfigsTable)
        .set({ syncPaused: true })
        .where(eq(googleSheetConfigsTable.tenantId, tenantId));
    } else if ((mode === "sheets" || mode === "both") && previousMode === "tracker") {
      await tx.update(googleSheetConfigsTable)
        .set({ syncPaused: false })
        .where(eq(googleSheetConfigsTable.tenantId, tenantId));
    }

    await tx.insert(ingestionAuditLogTable).values({
      tenantId,
      previousMode,
      newMode: mode,
      changedBy: userId ? String(userId) : role,
    });
  });

  console.log(`[IngestionMode] Tenant ${tenantId}: ${previousMode} → ${mode} (changed by ${role})`);

  res.json({ success: true, mode, previousMode });
});

function hostFromUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

router.get("/ingestion-mode/status", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const heartbeats = await db.select().from(trackerHeartbeatsTable)
    .where(eq(trackerHeartbeatsTable.tenantId, tenantId))
    .orderBy(desc(trackerHeartbeatsTable.lastSeenAt));

  const recentEvents = await db.select({
    pageUrl: attributionEventsTable.pageUrl,
    landingPage: attributionEventsTable.landingPage,
    createdAt: attributionEventsTable.createdAt,
  })
    .from(attributionEventsTable)
    .where(and(
      eq(attributionEventsTable.tenantId, tenantId),
      gte(attributionEventsTable.createdAt, sevenDaysAgo),
    ));

  // Bucket events by host derived from pageUrl (fall back to landingPage).
  const eventsByHost = new Map<string, { last: Date; count24h: number; count7d: number }>();
  for (const ev of recentEvents) {
    const host = hostFromUrl(ev.pageUrl) || hostFromUrl(ev.landingPage);
    if (!host) continue;
    const prev = eventsByHost.get(host) || { last: new Date(0), count24h: 0, count7d: 0 };
    if (ev.createdAt > prev.last) prev.last = ev.createdAt;
    prev.count7d += 1;
    if (ev.createdAt > twentyFourHoursAgo) prev.count24h += 1;
    eventsByHost.set(host, prev);
  }

  type DomainStatus = "green" | "amber" | "red";
  // Dedupe heartbeats by normalized domain (latest wins). The upsert in /heartbeat
  // already enforces this in practice, but defending here protects the per-domain
  // cards from showing contradictory rows if duplicates ever land.
  const seenHosts = new Set<string>();
  const dedupedHeartbeats = [];
  for (const h of heartbeats) {
    if (!h.domain) continue;
    const host = h.domain.toLowerCase();
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    dedupedHeartbeats.push(h);
  }
  const domains = dedupedHeartbeats
    .map(h => {
      const host = (h.domain || "").toLowerCase();
      const stats = eventsByHost.get(host) || { last: null as Date | null, count24h: 0, count7d: 0 };
      const heartbeatHealthy = new Date(h.lastSeenAt) > twentyFourHoursAgo;
      let status: DomainStatus;
      let reason: string;
      if (!heartbeatHealthy) {
        status = "red";
        reason = "Heartbeat stale (no ping in last 24h). Tracker likely not loading on this domain.";
      } else if (stats.count24h === 0) {
        status = "amber";
        reason = "Tracker is loading and pinging heartbeats, but no form-fill events captured in the last 24h. Capture may be broken on this domain.";
      } else {
        status = "green";
        reason = "Healthy: tracker loading and capturing events.";
      }
      // mark hosts we've already reconciled with a heartbeat row so we can detect orphan event-only hosts below
      eventsByHost.delete(host);
      return {
        domain: host,
        status,
        reason,
        lastHeartbeat: h.lastSeenAt,
        firstPageUrl: h.firstPageUrl || null,
        lastEventAt: stats.last,
        eventCount24h: stats.count24h,
        eventCount7d: stats.count7d,
      };
    });

  // Domains that produced events but never sent a heartbeat — odd, surface as info-amber.
  for (const [host, stats] of eventsByHost.entries()) {
    domains.push({
      domain: host,
      status: "amber" as DomainStatus,
      reason: "Events received from this domain but no heartbeat — script may be loaded without the heartbeat-capable build.",
      lastHeartbeat: null,
      firstPageUrl: null,
      lastEventAt: stats.last,
      eventCount24h: stats.count24h,
      eventCount7d: stats.count7d,
    });
  }

  // Backwards-compatible tenant-level rollup.
  const latestHeartbeat = heartbeats[0] || null;
  const trackerHealthy = latestHeartbeat
    ? new Date(latestHeartbeat.lastSeenAt) > twentyFourHoursAgo
    : false;
  const recentEventCount = recentEvents.length;

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
    recentEventCount,
    activeSheetCount: activeSheets.length,
    domains,
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

  let apiBase: string | null = process.env.API_BASE_URL || null;
  if (!apiBase) {
    const prodDomains = process.env.REPLIT_DOMAINS;
    if (prodDomains) {
      const primaryDomain = prodDomains.split(",")[0]?.trim();
      apiBase = `https://${primaryDomain}`;
    } else if (process.env.REPLIT_DEV_DOMAIN) {
      apiBase = `https://${process.env.REPLIT_DEV_DOMAIN}`;
    }
  }

  if (!apiBase) {
    res.status(500).json({ error: "API base URL not configured. Set API_BASE_URL or deploy to Replit." });
    return;
  }

  const normalizedBase = apiBase.replace(/\/+$/, "").replace(/\/api$/, "");
  const scriptUrl = `${normalizedBase}/api/pulse.js`;
  const safeSlug = tenant.clientSlug.replace(/[\\'"<>&]/g, "");

  const snippet = `<!-- Pulse Attribution (GTM-compatible) -->
<script>
window.__pulseConfig = {
  clientId: "${safeSlug}",
  endpoint: "${normalizedBase}/api/collect/submit"
};
</script>
<script src="${scriptUrl}"></script>`;

  res.json({ snippet, clientSlug: tenant.clientSlug });
});

export default router;
