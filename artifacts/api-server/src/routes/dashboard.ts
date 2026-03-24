import { Router, type IRouter } from "express";
import { db, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable, attributionEventsTable, tenantsTable } from "@workspace/db";
import { eq, and, gte, lte, count, sum, sql, inArray, SQL, desc } from "drizzle-orm";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

async function computeMetrics(tenantId: number | null, startDate?: string, endDate?: string) {
  const leadConditions: SQL[] = [];
  const jobConditions: SQL[] = [];
  const spendConditions: SQL[] = [];

  let tenantHasCampaigns = true;
  if (tenantId) {
    leadConditions.push(eq(leadsTable.tenantId, tenantId));
    jobConditions.push(eq(jobsTable.tenantId, tenantId));
    spendConditions.push(eq(campaignsTable.tenantId, tenantId));
  }
  if (startDate) {
    leadConditions.push(gte(leadsTable.createdAt, new Date(startDate)));
    jobConditions.push(gte(jobsTable.createdAt, new Date(startDate)));
    spendConditions.push(gte(campaignDailyStatsTable.date, startDate));
  }
  if (endDate) {
    leadConditions.push(lte(leadsTable.createdAt, new Date(endDate)));
    jobConditions.push(lte(jobsTable.createdAt, new Date(endDate)));
    spendConditions.push(lte(campaignDailyStatsTable.date, endDate));
  }

  const leadWhere = leadConditions.length > 0 ? and(...leadConditions) : undefined;
  const jobWhere = jobConditions.length > 0 ? and(...jobConditions) : undefined;
  const spendWhere = spendConditions.length > 0 ? and(...spendConditions) : undefined;

  const [leads, jobs, platformSpendResult] = await Promise.all([
    db.select().from(leadsTable).where(leadWhere),
    db.select().from(jobsTable).where(jobWhere),
    db.select({
      platform: campaignsTable.platform,
      total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`,
    })
      .from(campaignDailyStatsTable)
      .innerJoin(campaignsTable, eq(campaignDailyStatsTable.campaignId, campaignsTable.id))
      .where(spendWhere)
      .groupBy(campaignsTable.platform),
  ]);

  const googleSpend = Number(platformSpendResult.find(r => r.platform === "google_ads")?.total || 0);
  const metaSpend = Number(platformSpendResult.find(r => r.platform === "meta")?.total || 0);
  const totalSpend = platformSpendResult.reduce((sum, r) => sum + Number(r.total || 0), 0);

  const totalLeads = leads.length;
  const bookedLeads = leads.filter(l => l.status === "booked" || l.status === "sold").length;
  const soldLeads = leads.filter(l => l.status === "sold").length;
  const totalRevenue = jobs.filter(j => j.status === "completed").reduce((s, j) => s + (j.revenue || 0), 0);
  const matchedEvents = jobs.filter(j => j.matchLevel && j.matchLevel !== "unmatched").length;
  const totalJobs = jobs.length;

  const bookingRate = totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100 * 10) / 10 : 0;
  const closeRate = bookedLeads > 0 ? Math.round((soldLeads / bookedLeads) * 100 * 10) / 10 : 0;
  const avgSaleValue = soldLeads > 0 ? Math.round(totalRevenue / soldLeads) : 0;
  const cpl = totalLeads > 0 ? Math.round((totalSpend / totalLeads) * 100) / 100 : 0;
  const roas = totalSpend > 0 ? Math.round((totalRevenue / totalSpend) * 100) / 100 : 0;
  const attributionMatchRate = totalJobs > 0 ? Math.round((matchedEvents / totalJobs) * 100 * 10) / 10 : 0;

  return {
    totalSpend: Math.round(totalSpend * 100) / 100,
    googleSpend: Math.round(googleSpend * 100) / 100,
    metaSpend: Math.round(metaSpend * 100) / 100,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    roas,
    totalLeads,
    bookedLeads,
    soldLeads,
    bookingRate,
    closeRate,
    avgSaleValue,
    cpl,
    attributionMatchRate,
  };
}

router.get("/dashboard/overview", async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const current = await computeMetrics(tenantId, startDate, endDate);

  let previousPeriod = null;
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const durationMs = end.getTime() - start.getTime();
    const prevEnd = new Date(start.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - durationMs);
    previousPeriod = await computeMetrics(
      tenantId,
      prevStart.toISOString().split("T")[0],
      prevEnd.toISOString().split("T")[0]
    );
  }

  res.json({ ...current, previousPeriod });
});

router.get("/dashboard/spend-revenue", async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const statsConditions: SQL[] = [];
  const jobConditions: SQL[] = [eq(jobsTable.status, "completed")];

  if (tenantId) {
    statsConditions.push(eq(campaignsTable.tenantId, tenantId));
    jobConditions.push(eq(jobsTable.tenantId, tenantId));
  }
  if (startDate) {
    statsConditions.push(gte(campaignDailyStatsTable.date, startDate));
    jobConditions.push(gte(jobsTable.completedAt, new Date(startDate)));
  }
  if (endDate) {
    statsConditions.push(lte(campaignDailyStatsTable.date, endDate));
    jobConditions.push(lte(jobsTable.completedAt, new Date(endDate)));
  }

  const statsWhere = statsConditions.length > 0 ? and(...statsConditions) : undefined;

  const [stats, jobs] = await Promise.all([
    db.select({
      date: campaignDailyStatsTable.date,
      platform: campaignsTable.platform,
      spend: campaignDailyStatsTable.spend,
    })
      .from(campaignDailyStatsTable)
      .innerJoin(campaignsTable, eq(campaignDailyStatsTable.campaignId, campaignsTable.id))
      .where(statsWhere)
      .orderBy(campaignDailyStatsTable.date),
    db.select().from(jobsTable).where(and(...jobConditions)),
  ]);

  const dailyMap = new Map<string, { spend: number; googleSpend: number; metaSpend: number; revenue: number }>();

  for (const s of stats) {
    const dateStr = typeof s.date === 'string' ? s.date : String(s.date);
    const existing = dailyMap.get(dateStr) || { spend: 0, googleSpend: 0, metaSpend: 0, revenue: 0 };
    const amount = s.spend || 0;
    existing.spend += amount;
    if (s.platform === "google_ads") {
      existing.googleSpend += amount;
    } else if (s.platform === "meta") {
      existing.metaSpend += amount;
    }
    dailyMap.set(dateStr, existing);
  }

  for (const j of jobs) {
    if (j.completedAt) {
      const dateStr = j.completedAt.toISOString().split("T")[0];
      const existing = dailyMap.get(dateStr) || { spend: 0, googleSpend: 0, metaSpend: 0, revenue: 0 };
      existing.revenue += j.revenue || 0;
      dailyMap.set(dateStr, existing);
    }
  }

  const result = Array.from(dailyMap.entries())
    .map(([date, data]) => ({
      date,
      spend: Math.round(data.spend * 100) / 100,
      googleSpend: Math.round(data.googleSpend * 100) / 100,
      metaSpend: Math.round(data.metaSpend * 100) / 100,
      revenue: Math.round(data.revenue * 100) / 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json(result);
});

router.get("/dashboard/benchmarks", async (req, res) => {
  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));

  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const allMetrics = await Promise.all(tenants.map(async (tenant) => {
    const leadConditions: SQL[] = [eq(leadsTable.tenantId, tenant.id)];
    const statsConditions: SQL[] = [eq(campaignsTable.tenantId, tenant.id)];
    if (startDate) {
      leadConditions.push(gte(leadsTable.createdAt, new Date(startDate)));
      statsConditions.push(gte(campaignDailyStatsTable.date, startDate));
    }
    if (endDate) {
      leadConditions.push(lte(leadsTable.createdAt, new Date(endDate)));
      statsConditions.push(lte(campaignDailyStatsTable.date, endDate));
    }

    const jobConditions: SQL[] = [eq(jobsTable.tenantId, tenant.id)];
    if (startDate) jobConditions.push(gte(jobsTable.createdAt, new Date(startDate)));
    if (endDate) jobConditions.push(lte(jobsTable.createdAt, new Date(endDate)));

    const [leads, jobs, spendResult] = await Promise.all([
      db.select().from(leadsTable).where(and(...leadConditions)),
      db.select().from(jobsTable).where(and(...jobConditions)),
      db.select({
        total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`
      }).from(campaignDailyStatsTable)
        .innerJoin(campaignsTable, eq(campaignDailyStatsTable.campaignId, campaignsTable.id))
        .where(and(...statsConditions)),
    ]);

    const totalLeads = leads.length;
    const bookedLeads = leads.filter(l => l.status === "booked" || l.status === "sold").length;
    const soldLeads = leads.filter(l => l.status === "sold").length;
    const revenue = jobs.filter(j => j.status === "completed").reduce((s, j) => s + (j.revenue || 0), 0);
    const spend = Number(spendResult[0]?.total || 0);

    return { totalLeads, bookedLeads, soldLeads, revenue, spend };
  }));

  const totals = allMetrics.reduce((acc, m) => ({
    totalLeads: acc.totalLeads + m.totalLeads,
    bookedLeads: acc.bookedLeads + m.bookedLeads,
    soldLeads: acc.soldLeads + m.soldLeads,
    revenue: acc.revenue + m.revenue,
    spend: acc.spend + m.spend,
  }), { totalLeads: 0, bookedLeads: 0, soldLeads: 0, revenue: 0, spend: 0 });

  const avgSaleValue = totals.soldLeads > 0 ? Math.round((totals.revenue / totals.soldLeads) * 100) / 100 : 0;

  res.json({
    cpl: totals.totalLeads > 0 ? Math.round((totals.spend / totals.totalLeads) * 100) / 100 : 0,
    bookingRate: totals.totalLeads > 0 ? Math.round((totals.bookedLeads / totals.totalLeads) * 100 * 10) / 10 : 0,
    closeRate: totals.bookedLeads > 0 ? Math.round((totals.soldLeads / totals.bookedLeads) * 100 * 10) / 10 : 0,
    avgSaleValue,
    roas: totals.spend > 0 ? Math.round((totals.revenue / totals.spend) * 100) / 100 : 0,
  });
});

router.get("/dashboard/tenant-performance", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));

  const results = await Promise.all(tenants.map(async (tenant) => {
    const [leads, jobs, spendResult] = await Promise.all([
      db.select().from(leadsTable).where(eq(leadsTable.tenantId, tenant.id)),
      db.select().from(jobsTable).where(eq(jobsTable.tenantId, tenant.id)),
      db.select({
        total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`
      }).from(campaignDailyStatsTable)
        .innerJoin(campaignsTable, eq(campaignDailyStatsTable.campaignId, campaignsTable.id))
        .where(eq(campaignsTable.tenantId, tenant.id)),
    ]);

    const totalLeads = leads.length;
    const bookedLeads = leads.filter(l => l.status === "booked" || l.status === "sold").length;
    const soldLeads = leads.filter(l => l.status === "sold").length;
    const mtdRevenue = jobs.filter(j => j.status === "completed").reduce((s, j) => s + (j.revenue || 0), 0);
    const mtdSpend = Number(spendResult[0]?.total || 0);

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      mtdSpend: Math.round(mtdSpend * 100) / 100,
      mtdRevenue: Math.round(mtdRevenue * 100) / 100,
      cpl: totalLeads > 0 ? Math.round((mtdSpend / totalLeads) * 100) / 100 : 0,
      bookingRate: totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100 * 10) / 10 : 0,
      closeRate: bookedLeads > 0 ? Math.round((soldLeads / bookedLeads) * 100 * 10) / 10 : 0,
      roas: mtdSpend > 0 ? Math.round((mtdRevenue / mtdSpend) * 100) / 100 : 0,
      leadCount: totalLeads,
    };
  }));

  res.json(results);
});

export default router;
