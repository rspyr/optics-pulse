import { Router, type IRouter } from "express";
import { db, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable, attributionEventsTable, tenantsTable } from "@workspace/db";
import { eq, and, gte, lte, count, sum, sql, inArray, SQL, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/dashboard/overview", async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const leadConditions: SQL[] = [];
  const jobConditions: SQL[] = [];
  const spendConditions: SQL[] = [];

  if (tenantId) {
    leadConditions.push(eq(leadsTable.tenantId, tenantId));
    jobConditions.push(eq(jobsTable.tenantId, tenantId));
    const tenantCampaigns = await db.select({ id: campaignsTable.id }).from(campaignsTable).where(eq(campaignsTable.tenantId, tenantId));
    const campaignIds = tenantCampaigns.map(c => c.id);
    if (campaignIds.length > 0) {
      spendConditions.push(inArray(campaignDailyStatsTable.campaignId, campaignIds));
    }
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

  const [leads, jobs, spendResult] = await Promise.all([
    db.select().from(leadsTable).where(leadWhere),
    db.select().from(jobsTable).where(jobWhere),
    db.select({ total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)` }).from(campaignDailyStatsTable).where(spendWhere),
  ]);

  const totalLeads = leads.length;
  const bookedLeads = leads.filter(l => l.status === "booked" || l.status === "sold").length;
  const soldLeads = leads.filter(l => l.status === "sold").length;
  const totalRevenue = jobs.filter(j => j.status === "completed").reduce((s, j) => s + (j.revenue || 0), 0);
  const totalSpend = Number(spendResult[0]?.total || 0);
  const matchedEvents = jobs.filter(j => j.matchedGclid).length;
  const totalJobs = jobs.length;

  const bookingRate = totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100 * 10) / 10 : 0;
  const closeRate = bookedLeads > 0 ? Math.round((soldLeads / bookedLeads) * 100 * 10) / 10 : 0;
  const avgSaleValue = soldLeads > 0 ? Math.round(totalRevenue / soldLeads) : 0;
  const cpl = totalLeads > 0 ? Math.round((totalSpend / totalLeads) * 100) / 100 : 0;
  const roas = totalSpend > 0 ? Math.round((totalRevenue / totalSpend) * 100) / 100 : 0;
  const attributionMatchRate = totalJobs > 0 ? Math.round((matchedEvents / totalJobs) * 100 * 10) / 10 : 0;

  res.json({
    totalSpend: Math.round(totalSpend * 100) / 100,
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
    previousPeriod: null,
  });
});

router.get("/dashboard/spend-revenue", async (req, res) => {
  const stats = await db.select().from(campaignDailyStatsTable).orderBy(campaignDailyStatsTable.date);
  const jobs = await db.select().from(jobsTable).where(eq(jobsTable.status, "completed"));

  const dailyMap = new Map<string, { spend: number; revenue: number }>();

  for (const s of stats) {
    const dateStr = typeof s.date === 'string' ? s.date : String(s.date);
    const existing = dailyMap.get(dateStr) || { spend: 0, revenue: 0 };
    existing.spend += s.spend || 0;
    dailyMap.set(dateStr, existing);
  }

  for (const j of jobs) {
    if (j.completedAt) {
      const dateStr = j.completedAt.toISOString().split("T")[0];
      const existing = dailyMap.get(dateStr) || { spend: 0, revenue: 0 };
      existing.revenue += j.revenue || 0;
      dailyMap.set(dateStr, existing);
    }
  }

  const result = Array.from(dailyMap.entries())
    .map(([date, data]) => ({
      date,
      spend: Math.round(data.spend * 100) / 100,
      revenue: Math.round(data.revenue * 100) / 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json(result);
});

router.get("/dashboard/tenant-performance", async (req, res) => {
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
