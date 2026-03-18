import { Router, type IRouter } from "express";
import { db, trainingItemsTable, trainingDismissalsTable, trainingEmailLogsTable, tenantsTable, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable } from "@workspace/db";
import { eq, and, desc, inArray, sql, SQL, gte, lte } from "drizzle-orm";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

const VALID_CONTENT_TYPES = ["free_tip", "paid_course"] as const;
const VALID_METRICS = ["booking_rate", "close_rate", "cpl", "roas", "avg_sale_value"] as const;
const VALID_DIRECTIONS = ["below", "above"] as const;

function validateId(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

router.get("/training/items", async (req, res) => {
  const showInactive = req.query.activeOnly === "false";
  if (showInactive && !["super_admin", "agency_user"].includes(req.session.userRole || "")) {
    res.status(403).json({ error: "Only agency users can view inactive items" });
    return;
  }

  const conditions: SQL[] = [];
  if (!showInactive) conditions.push(eq(trainingItemsTable.isActive, true));

  const items = await db.select().from(trainingItemsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(trainingItemsTable.sortOrder, trainingItemsTable.createdAt);

  res.json(items);
});

router.get("/training/items/:id", async (req, res) => {
  const id = validateId(String(req.params.id));
  if (!id) { res.status(400).json({ error: "Invalid training item ID" }); return; }

  const [item] = await db.select().from(trainingItemsTable).where(eq(trainingItemsTable.id, id));
  if (!item) { res.status(404).json({ error: "Training item not found" }); return; }

  if (!item.isActive && !["super_admin", "agency_user"].includes(req.session.userRole || "")) {
    res.status(404).json({ error: "Training item not found" });
    return;
  }

  res.json(item);
});

router.post("/training/items", requireRole("super_admin", "agency_user"), async (req, res) => {
  const { title, description, category, contentType, metricTrigger, thresholdValue, thresholdDirection, price, url, thumbnailUrl, sortOrder, isActive } = req.body;

  if (!title || typeof title !== "string" || !description || typeof description !== "string" || !category || typeof category !== "string") {
    res.status(400).json({ error: "Title, description, and category are required strings" });
    return;
  }

  const ct = contentType || "free_tip";
  if (!VALID_CONTENT_TYPES.includes(ct)) {
    res.status(400).json({ error: `contentType must be one of: ${VALID_CONTENT_TYPES.join(", ")}` });
    return;
  }

  if (metricTrigger && !VALID_METRICS.includes(metricTrigger)) {
    res.status(400).json({ error: `metricTrigger must be one of: ${VALID_METRICS.join(", ")}` });
    return;
  }

  const dir = thresholdDirection || "below";
  if (!VALID_DIRECTIONS.includes(dir)) {
    res.status(400).json({ error: `thresholdDirection must be one of: ${VALID_DIRECTIONS.join(", ")}` });
    return;
  }

  const parsedThreshold = thresholdValue != null ? Number(thresholdValue) : null;
  if (parsedThreshold !== null && !Number.isFinite(parsedThreshold)) {
    res.status(400).json({ error: "thresholdValue must be a valid number" });
    return;
  }

  const parsedPrice = price != null ? Number(price) : null;
  if (parsedPrice !== null && (!Number.isFinite(parsedPrice) || parsedPrice < 0)) {
    res.status(400).json({ error: "price must be a valid non-negative number" });
    return;
  }

  const [item] = await db.insert(trainingItemsTable).values({
    title: title.trim(),
    description: description.trim(),
    category: category.trim(),
    contentType: ct,
    metricTrigger: metricTrigger || null,
    thresholdValue: parsedThreshold,
    thresholdDirection: dir,
    price: parsedPrice,
    url: url || null,
    thumbnailUrl: thumbnailUrl || null,
    sortOrder: sortOrder != null ? Number(sortOrder) || 0 : 0,
    isActive: isActive !== false,
  }).returning();

  res.status(201).json(item);
});

router.put("/training/items/:id", requireRole("super_admin", "agency_user"), async (req, res) => {
  const id = validateId(String(req.params.id));
  if (!id) { res.status(400).json({ error: "Invalid training item ID" }); return; }

  const { title, description, category, contentType, metricTrigger, thresholdValue, thresholdDirection, price, url, thumbnailUrl, sortOrder, isActive } = req.body;

  if (contentType !== undefined && !VALID_CONTENT_TYPES.includes(contentType)) {
    res.status(400).json({ error: `contentType must be one of: ${VALID_CONTENT_TYPES.join(", ")}` });
    return;
  }
  if (metricTrigger !== undefined && metricTrigger !== null && metricTrigger !== "" && !VALID_METRICS.includes(metricTrigger)) {
    res.status(400).json({ error: `metricTrigger must be one of: ${VALID_METRICS.join(", ")}` });
    return;
  }
  if (thresholdDirection !== undefined && !VALID_DIRECTIONS.includes(thresholdDirection)) {
    res.status(400).json({ error: `thresholdDirection must be one of: ${VALID_DIRECTIONS.join(", ")}` });
    return;
  }

  const [item] = await db.update(trainingItemsTable)
    .set({
      ...(title !== undefined && { title: String(title).trim() }),
      ...(description !== undefined && { description: String(description).trim() }),
      ...(category !== undefined && { category: String(category).trim() }),
      ...(contentType !== undefined && { contentType }),
      ...(metricTrigger !== undefined && { metricTrigger: metricTrigger || null }),
      ...(thresholdValue !== undefined && { thresholdValue: thresholdValue != null ? Number(thresholdValue) : null }),
      ...(thresholdDirection !== undefined && { thresholdDirection }),
      ...(price !== undefined && { price: price != null ? Number(price) : null }),
      ...(url !== undefined && { url: url || null }),
      ...(thumbnailUrl !== undefined && { thumbnailUrl: thumbnailUrl || null }),
      ...(sortOrder !== undefined && { sortOrder: Number(sortOrder) || 0 }),
      ...(isActive !== undefined && { isActive }),
      updatedAt: new Date(),
    })
    .where(eq(trainingItemsTable.id, id))
    .returning();

  if (!item) { res.status(404).json({ error: "Training item not found" }); return; }
  res.json(item);
});

router.delete("/training/items/:id", requireRole("super_admin", "agency_user"), async (req, res) => {
  const id = validateId(String(req.params.id));
  if (!id) { res.status(400).json({ error: "Invalid training item ID" }); return; }

  await db.delete(trainingDismissalsTable).where(eq(trainingDismissalsTable.trainingItemId, id));
  await db.delete(trainingEmailLogsTable).where(eq(trainingEmailLogsTable.trainingItemId, id));
  await db.delete(trainingItemsTable).where(eq(trainingItemsTable.id, id));
  res.json({ success: true });
});

async function computeTenantMetrics(tenantId: number) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const startDate = thirtyDaysAgo.toISOString().split("T")[0];
  const endDate = now.toISOString().split("T")[0];

  const [leads, jobs, tenantCampaigns] = await Promise.all([
    db.select().from(leadsTable).where(
      and(eq(leadsTable.tenantId, tenantId), gte(leadsTable.createdAt, thirtyDaysAgo))
    ),
    db.select().from(jobsTable).where(
      and(eq(jobsTable.tenantId, tenantId), gte(jobsTable.createdAt, thirtyDaysAgo))
    ),
    db.select({ id: campaignsTable.id }).from(campaignsTable).where(eq(campaignsTable.tenantId, tenantId)),
  ]);

  const campaignIds = tenantCampaigns.map(c => c.id);
  let totalSpend = 0;
  if (campaignIds.length > 0) {
    const [spendResult] = await db.select({
      total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`
    }).from(campaignDailyStatsTable).where(
      and(
        inArray(campaignDailyStatsTable.campaignId, campaignIds),
        gte(campaignDailyStatsTable.date, startDate),
        lte(campaignDailyStatsTable.date, endDate)
      )
    );
    totalSpend = Number(spendResult?.total || 0);
  }

  const totalLeads = leads.length;
  const bookedLeads = leads.filter(l => l.status === "booked" || l.status === "sold").length;
  const soldLeads = leads.filter(l => l.status === "sold").length;
  const totalRevenue = jobs.filter(j => j.status === "completed").reduce((s, j) => s + (j.revenue || 0), 0);

  return {
    booking_rate: totalLeads > 0 ? (bookedLeads / totalLeads) * 100 : 0,
    close_rate: bookedLeads > 0 ? (soldLeads / bookedLeads) * 100 : 0,
    cpl: totalLeads > 0 ? totalSpend / totalLeads : 0,
    roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
    avg_sale_value: soldLeads > 0 ? totalRevenue / soldLeads : 0,
  };
}

router.get("/training/contextual", async (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: "Authentication required" }); return; }
  if (!req.session.tenantId) { res.status(403).json({ error: "Tenant context required" }); return; }

  const tenantId = req.session.tenantId;
  const userId = req.session.userId;

  const [items, dismissals, metrics] = await Promise.all([
    db.select().from(trainingItemsTable).where(eq(trainingItemsTable.isActive, true)),
    db.select().from(trainingDismissalsTable).where(
      and(eq(trainingDismissalsTable.tenantId, tenantId), eq(trainingDismissalsTable.userId, userId))
    ),
    computeTenantMetrics(tenantId),
  ]);

  const dismissedIds = new Set(dismissals.map(d => d.trainingItemId));

  const triggered = items.filter(item => {
    if (dismissedIds.has(item.id)) return false;
    if (!item.metricTrigger || item.thresholdValue == null) return false;

    const metricValue = metrics[item.metricTrigger as keyof typeof metrics];
    if (metricValue === undefined) return false;

    const direction = item.thresholdDirection || "below";
    if (direction === "below") return metricValue < item.thresholdValue;
    return metricValue > item.thresholdValue;
  });

  res.json({
    items: triggered.sort((a, b) => a.sortOrder - b.sortOrder),
    metrics,
  });
});

router.post("/training/dismiss/:id", async (req, res) => {
  if (!req.session.userId) { res.status(401).json({ error: "Authentication required" }); return; }
  if (!req.session.tenantId) { res.status(403).json({ error: "Tenant context required" }); return; }

  const trainingItemId = validateId(String(req.params.id));
  if (!trainingItemId) { res.status(400).json({ error: "Invalid training item ID" }); return; }

  const tenantId = req.session.tenantId;
  const userId = req.session.userId;

  const existing = await db.select().from(trainingDismissalsTable).where(
    and(
      eq(trainingDismissalsTable.trainingItemId, trainingItemId),
      eq(trainingDismissalsTable.tenantId, tenantId),
      eq(trainingDismissalsTable.userId, userId)
    )
  );

  if (existing.length === 0) {
    await db.insert(trainingDismissalsTable).values({ trainingItemId, tenantId, userId });
  }

  res.json({ success: true });
});

router.post("/training/check-alerts", requireRole("super_admin", "agency_user"), async (_req, res) => {
  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
  const items = await db.select().from(trainingItemsTable).where(
    and(eq(trainingItemsTable.isActive, true), sql`${trainingItemsTable.metricTrigger} IS NOT NULL`)
  );

  const alerts: { tenantId: number; tenantName: string; metric: string; value: number; threshold: number; trainingTitle: string }[] = [];

  for (const tenant of tenants) {
    const metrics = await computeTenantMetrics(tenant.id);

    for (const item of items) {
      if (!item.metricTrigger || item.thresholdValue == null) continue;

      const metricValue = metrics[item.metricTrigger as keyof typeof metrics];
      if (metricValue === undefined) continue;

      const direction = item.thresholdDirection || "below";
      const triggered = direction === "below" ? metricValue < item.thresholdValue : metricValue > item.thresholdValue;

      if (triggered) {
        const recentLog = await db.select().from(trainingEmailLogsTable).where(
          and(
            eq(trainingEmailLogsTable.tenantId, tenant.id),
            eq(trainingEmailLogsTable.trainingItemId, item.id),
            gte(trainingEmailLogsTable.sentAt, new Date(Date.now() - 7 * 86400000))
          )
        );

        if (recentLog.length === 0) {
          alerts.push({
            tenantId: tenant.id,
            tenantName: tenant.name,
            metric: item.metricTrigger,
            value: Math.round(metricValue * 100) / 100,
            threshold: item.thresholdValue,
            trainingTitle: item.title,
          });

          await db.insert(trainingEmailLogsTable).values({
            tenantId: tenant.id,
            trainingItemId: item.id,
            metricTrigger: item.metricTrigger,
            metricValue: Math.round(metricValue * 100) / 100,
            thresholdValue: item.thresholdValue,
          });
        }
      }
    }
  }

  res.json({
    alertsGenerated: alerts.length,
    alerts,
    message: alerts.length > 0
      ? `${alerts.length} metric alert(s) detected. In production, emails would be sent to tenant owners.`
      : "All tenant metrics are within thresholds.",
  });
});

router.get("/training/email-logs", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = req.query.tenantId ? validateId(String(req.query.tenantId)) : undefined;
  const conditions: SQL[] = [];
  if (tenantId) conditions.push(eq(trainingEmailLogsTable.tenantId, tenantId));

  const logs = await db.select().from(trainingEmailLogsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(trainingEmailLogsTable.sentAt))
    .limit(100);

  res.json(logs);
});

export default router;
