import { Router, type IRouter } from "express";
import { db, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable, attributionEventsTable, tenantsTable } from "@workspace/db";
import { eq, and, gte, lte, count, sum, sql, inArray, SQL, desc } from "drizzle-orm";
import { requireRole, denyClientUser } from "../middleware/auth";
import { resolveListTenantScope } from "../lib/tenant-scope";

const router: IRouter = Router();

router.use("/dashboard", denyClientUser);

const jobDateExpr = sql`COALESCE(${jobsTable.invoiceDate}, ${jobsTable.completedAt}, ${jobsTable.createdAt})`;

export type AttributionMode = "attributed" | "unattributed" | "all";

function parseAttributionMode(raw: unknown): AttributionMode {
  if (raw === "unattributed" || raw === "all") return raw;
  return "attributed";
}

// Attributed = paid-touch leads/jobs.
// - lead.source matches google / meta / facebook (case-insensitive), OR
// - lead.matchedGclid is not null, OR
// - job.matchLevel in (diamond, golden, silver, bronze).
const leadAttributedExpr = sql`(
  ${leadsTable.source} ILIKE '%google%'
  OR ${leadsTable.source} ILIKE '%meta%'
  OR ${leadsTable.source} ILIKE '%facebook%'
  OR ${leadsTable.matchedGclid} IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM ${jobsTable} aj
    WHERE aj.lead_id = ${leadsTable.id}
      AND aj.tenant_id = ${leadsTable.tenantId}
      AND aj.match_level IN ('diamond','golden','silver','bronze')
  )
)`;
const jobAttributedExpr = sql`(${jobsTable.matchLevel} IN ('diamond','golden','silver','bronze'))`;

async function computeMetrics(
  tenantId: number | null,
  startDate?: string,
  endDate?: string,
  attribution: AttributionMode = "attributed",
) {
  const leadConditions: SQL[] = [];
  const jobConditions: SQL[] = [];
  const spendConditions: SQL[] = [];

  if (attribution === "attributed") {
    leadConditions.push(leadAttributedExpr);
    jobConditions.push(jobAttributedExpr);
  } else if (attribution === "unattributed") {
    leadConditions.push(sql`NOT ${leadAttributedExpr}`);
    jobConditions.push(sql`(${jobsTable.matchLevel} IS NULL OR ${jobsTable.matchLevel} = 'unmatched')`);
  }

  if (tenantId) {
    leadConditions.push(eq(leadsTable.tenantId, tenantId));
    jobConditions.push(eq(jobsTable.tenantId, tenantId));
    spendConditions.push(eq(campaignsTable.tenantId, tenantId));
  }
  if (startDate) {
    leadConditions.push(gte(leadsTable.createdAt, new Date(startDate)));
    jobConditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
    spendConditions.push(gte(campaignDailyStatsTable.date, startDate));
  }
  if (endDate) {
    leadConditions.push(lte(leadsTable.createdAt, new Date(endDate)));
    jobConditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);
    spendConditions.push(lte(campaignDailyStatsTable.date, endDate));
  }

  const leadWhere = leadConditions.length > 0 ? and(...leadConditions) : undefined;
  const jobWhere = jobConditions.length > 0 ? and(...jobConditions) : undefined;
  const spendWhere = spendConditions.length > 0 ? and(...spendConditions) : undefined;

  const closeRateConditions: SQL[] = [];
  closeRateConditions.push(sql`(${leadsTable.status} IN ('booked', 'sold') OR ${leadsTable.hubStatus} = 'appt_booked')`);
  if (tenantId) closeRateConditions.push(eq(leadsTable.tenantId, tenantId));
  if (startDate) closeRateConditions.push(gte(leadsTable.createdAt, new Date(startDate)));
  if (endDate) closeRateConditions.push(lte(leadsTable.createdAt, new Date(endDate)));
  if (attribution === "attributed") closeRateConditions.push(leadAttributedExpr);
  else if (attribution === "unattributed") closeRateConditions.push(sql`NOT ${leadAttributedExpr}`);

  // Ad spend has no meaning in the unattributed view (it's by definition
  // attributed to a paid platform). Skip the spend query entirely so ROAS
  // and CPL fall back to 0 / the unattributed lead count.
  const skipSpendQuery = attribution === "unattributed";

  const [leadStats, jobStats, platformSpendResult, closeRateStats] = await Promise.all([
    db.select({
      totalLeads: count(),
      bookedLeads: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.status} IN ('booked', 'sold') OR ${leadsTable.hubStatus} = 'appt_booked')`,
      soldLeads: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.status} = 'sold')`,
    }).from(leadsTable).where(leadWhere),
    db.select({
      totalJobs: count(),
      totalRevenue: sql<number>`COALESCE(SUM(CASE WHEN ${jobsTable.status} = 'completed' THEN COALESCE(${jobsTable.invoiceTotal} + COALESCE(${jobsTable.invoiceRebateAmount}, 0), ${jobsTable.revenue}) ELSE 0 END), 0)`,
      paidRevenue: sql<number>`COALESCE(SUM(CASE WHEN ${jobsTable.status} = 'completed' AND ${jobsTable.hasInvoice} = true AND (${jobsTable.invoiceBalance} = 0 OR ${jobsTable.invoicePaidOn} IS NOT NULL) THEN COALESCE(${jobsTable.invoicePaidAmount}, 0) + COALESCE(${jobsTable.invoiceRebateAmount}, 0) ELSE 0 END), 0)`,
      invoicedJobCount: sql<number>`COUNT(*) FILTER (WHERE ${jobsTable.hasInvoice} = true)`,
      matchedEvents: sql<number>`COUNT(*) FILTER (WHERE ${jobsTable.matchLevel} IS NOT NULL AND ${jobsTable.matchLevel} != 'unmatched')`,
    }).from(jobsTable).where(jobWhere),
    skipSpendQuery
      ? Promise.resolve([] as Array<{ platform: string | null; total: number }>)
      : db.select({
          platform: campaignsTable.platform,
          total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`,
        })
          .from(campaignDailyStatsTable)
          .innerJoin(campaignsTable, eq(campaignDailyStatsTable.campaignId, campaignsTable.id))
          .where(spendWhere)
          .groupBy(campaignsTable.platform),
    db.select({
      bookedWithInvoice: sql<number>`COUNT(DISTINCT ${leadsTable.id})`,
    })
      .from(leadsTable)
      .innerJoin(jobsTable, and(
        eq(jobsTable.leadId, leadsTable.id),
        eq(jobsTable.hasInvoice, true),
      ))
      .where(and(...closeRateConditions)),
  ]);

  const googleSpend = platformSpendResult.filter(r => r.platform === "google_ads" || r.platform === "google").reduce((s, r) => s + Number(r.total || 0), 0);
  const metaSpend = Number(platformSpendResult.find(r => r.platform === "meta")?.total || 0);
  const totalSpend = platformSpendResult.reduce((sum, r) => sum + Number(r.total || 0), 0);

  const totalLeads = Number(leadStats[0]?.totalLeads ?? 0);
  const bookedLeads = Number(leadStats[0]?.bookedLeads ?? 0);
  const soldLeads = Number(leadStats[0]?.soldLeads ?? 0);
  const totalRevenue = Number(jobStats[0]?.totalRevenue ?? 0);
  const paidRevenue = Number(jobStats[0]?.paidRevenue ?? 0);
  const unpaidRevenue = Math.round((totalRevenue - paidRevenue) * 100) / 100;
  const bookedWithInvoice = Number(closeRateStats[0]?.bookedWithInvoice ?? 0);
  const invoicedJobCount = Number(jobStats[0]?.invoicedJobCount ?? 0);
  const matchedEvents = Number(jobStats[0]?.matchedEvents ?? 0);
  const totalJobs = Number(jobStats[0]?.totalJobs ?? 0);

  const bookingRate = totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100 * 10) / 10 : 0;
  const closeRate = bookedLeads > 0 ? Math.round((bookedWithInvoice / bookedLeads) * 100 * 10) / 10 : 0;
  const avgSaleValue = invoicedJobCount > 0 ? Math.round(totalRevenue / invoicedJobCount) : (soldLeads > 0 ? Math.round(totalRevenue / soldLeads) : 0);
  const cpl = totalLeads > 0 ? Math.round((totalSpend / totalLeads) * 100) / 100 : 0;
  const roas = totalSpend > 0 ? Math.round((totalRevenue / totalSpend) * 100) / 100 : 0;
  const attributionMatchRate = totalJobs > 0 ? Math.round((matchedEvents / totalJobs) * 100 * 10) / 10 : 0;

  return {
    totalSpend: Math.round(totalSpend * 100) / 100,
    googleSpend: Math.round(googleSpend * 100) / 100,
    metaSpend: Math.round(metaSpend * 100) / 100,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    paidRevenue: Math.round(paidRevenue * 100) / 100,
    unpaidRevenue: unpaidRevenue > 0 ? unpaidRevenue : 0,
    roas,
    totalLeads,
    bookedLeads,
    soldLeads,
    invoicedJobCount,
    bookingRate,
    closeRate,
    avgSaleValue,
    cpl,
    attributionMatchRate,
  };
}

router.get("/dashboard/overview", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const attribution = parseAttributionMode(req.query.attribution);

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

  const current = await computeMetrics(tenantId, startDate, endDate, attribution);

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
      prevEnd.toISOString().split("T")[0],
      attribution,
    );
  }

  res.json({ ...current, previousPeriod });
});

router.get("/dashboard/spend-revenue", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const attribution = parseAttributionMode(req.query.attribution);

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

  const statsConditions: SQL[] = [];
  const jobConditions: SQL[] = [eq(jobsTable.status, "completed")];

  if (attribution === "attributed") {
    jobConditions.push(jobAttributedExpr);
  } else if (attribution === "unattributed") {
    jobConditions.push(sql`(${jobsTable.matchLevel} IS NULL OR ${jobsTable.matchLevel} = 'unmatched')`);
  }
  const skipSpend = attribution === "unattributed";

  if (tenantId) {
    statsConditions.push(eq(campaignsTable.tenantId, tenantId));
    jobConditions.push(eq(jobsTable.tenantId, tenantId));
  }
  const allJobConditions: SQL[] = [eq(jobsTable.status, "completed")];
  if (tenantId) {
    allJobConditions.push(eq(jobsTable.tenantId, tenantId));
  }

  if (startDate) {
    statsConditions.push(gte(campaignDailyStatsTable.date, startDate));
    jobConditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
  }
  if (endDate) {
    statsConditions.push(lte(campaignDailyStatsTable.date, endDate));
    jobConditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);
  }

  const statsWhere = statsConditions.length > 0 ? and(...statsConditions) : undefined;

  const [stats, revenueByDate, outOfRangeResult] = await Promise.all([
    skipSpend
      ? Promise.resolve([] as Array<{ date: string | Date; platform: string | null; spend: number | null }>)
      : db.select({
          date: campaignDailyStatsTable.date,
          platform: campaignsTable.platform,
          spend: campaignDailyStatsTable.spend,
        })
          .from(campaignDailyStatsTable)
          .innerJoin(campaignsTable, eq(campaignDailyStatsTable.campaignId, campaignsTable.id))
          .where(statsWhere)
          .orderBy(campaignDailyStatsTable.date),
    db.select({
      date: sql<string>`TO_CHAR(${jobDateExpr}, 'YYYY-MM-DD')`,
      revenue: sql<number>`COALESCE(SUM(COALESCE(${jobsTable.invoiceTotal} + COALESCE(${jobsTable.invoiceRebateAmount}, 0), ${jobsTable.revenue})), 0)`,
    })
      .from(jobsTable)
      .where(and(...jobConditions))
      .groupBy(sql`TO_CHAR(${jobDateExpr}, 'YYYY-MM-DD')`),
    (startDate || endDate) ? db.select({
      total: sql<number>`COALESCE(SUM(COALESCE(${jobsTable.invoiceTotal} + COALESCE(${jobsTable.invoiceRebateAmount}, 0), ${jobsTable.revenue})), 0)`,
      jobCount: sql<number>`COUNT(*)`,
    })
      .from(jobsTable)
      .where(and(
        ...allJobConditions,
        ...(startDate ? [sql`${jobDateExpr} < ${new Date(startDate)}`] : []),
      )) : Promise.resolve([{ total: 0, jobCount: 0 }]),
  ]);

  const dailyMap = new Map<string, { spend: number; googleSpend: number; metaSpend: number; revenue: number }>();

  for (const s of stats) {
    const dateStr = typeof s.date === 'string' ? s.date : String(s.date);
    const existing = dailyMap.get(dateStr) || { spend: 0, googleSpend: 0, metaSpend: 0, revenue: 0 };
    const amount = s.spend || 0;
    existing.spend += amount;
    if (s.platform === "google_ads" || s.platform === "google") {
      existing.googleSpend += amount;
    } else if (s.platform === "meta") {
      existing.metaSpend += amount;
    }
    dailyMap.set(dateStr, existing);
  }

  for (const r of revenueByDate) {
    if (r.date) {
      const existing = dailyMap.get(r.date) || { spend: 0, googleSpend: 0, metaSpend: 0, revenue: 0 };
      existing.revenue += Number(r.revenue) || 0;
      dailyMap.set(r.date, existing);
    }
  }

  const historicalRevenue = Number(outOfRangeResult[0]?.total ?? 0);
  const historicalJobCount = Number(outOfRangeResult[0]?.jobCount ?? 0);

  const result = Array.from(dailyMap.entries())
    .map(([date, data]) => ({
      date,
      spend: Math.round(data.spend * 100) / 100,
      googleSpend: Math.round(data.googleSpend * 100) / 100,
      metaSpend: Math.round(data.metaSpend * 100) / 100,
      revenue: Math.round(data.revenue * 100) / 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    daily: result,
    historicalRevenue: Math.round(historicalRevenue * 100) / 100,
    historicalJobCount,
  });
});

router.get("/dashboard/benchmarks", async (req, res) => {
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const leadConditions: SQL[] = [];
  const jobConditions: SQL[] = [];
  const spendConditions: SQL[] = [];

  leadConditions.push(
    inArray(leadsTable.tenantId,
      db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.isActive, true))
    )
  );
  jobConditions.push(
    inArray(jobsTable.tenantId,
      db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.isActive, true))
    )
  );
  spendConditions.push(
    inArray(campaignsTable.tenantId,
      db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.isActive, true))
    )
  );

  if (startDate) {
    leadConditions.push(gte(leadsTable.createdAt, new Date(startDate)));
    jobConditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
    spendConditions.push(gte(campaignDailyStatsTable.date, startDate));
  }
  if (endDate) {
    leadConditions.push(lte(leadsTable.createdAt, new Date(endDate)));
    jobConditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);
    spendConditions.push(lte(campaignDailyStatsTable.date, endDate));
  }

  const closeRateConditions: SQL[] = [
    sql`(${leadsTable.status} IN ('booked', 'sold') OR ${leadsTable.hubStatus} = 'appt_booked')`,
    inArray(leadsTable.tenantId,
      db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.isActive, true))
    ),
  ];
  if (startDate) closeRateConditions.push(gte(leadsTable.createdAt, new Date(startDate)));
  if (endDate) closeRateConditions.push(lte(leadsTable.createdAt, new Date(endDate)));

  const [leadStats, jobStats, spendResult, closeRateStats] = await Promise.all([
    db.select({
      totalLeads: count(),
      bookedLeads: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.status} IN ('booked', 'sold') OR ${leadsTable.hubStatus} = 'appt_booked')`,
      soldLeads: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.status} = 'sold')`,
    }).from(leadsTable).where(and(...leadConditions)),
    db.select({
      revenue: sql<number>`COALESCE(SUM(CASE WHEN ${jobsTable.status} = 'completed' THEN COALESCE(${jobsTable.invoiceTotal} + COALESCE(${jobsTable.invoiceRebateAmount}, 0), ${jobsTable.revenue}) ELSE 0 END), 0)`,
      invoicedJobCount: sql<number>`COUNT(*) FILTER (WHERE ${jobsTable.hasInvoice} = true)`,
    }).from(jobsTable).where(and(...jobConditions)),
    db.select({
      total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`,
    }).from(campaignDailyStatsTable)
      .innerJoin(campaignsTable, eq(campaignDailyStatsTable.campaignId, campaignsTable.id))
      .where(and(...spendConditions)),
    db.select({
      bookedWithInvoice: sql<number>`COUNT(DISTINCT ${leadsTable.id})`,
    })
      .from(leadsTable)
      .innerJoin(jobsTable, and(
        eq(jobsTable.leadId, leadsTable.id),
        eq(jobsTable.hasInvoice, true),
      ))
      .where(and(...closeRateConditions)),
  ]);

  const totalLeads = Number(leadStats[0]?.totalLeads ?? 0);
  const bookedLeads = Number(leadStats[0]?.bookedLeads ?? 0);
  const bookedWithInvoice = Number(closeRateStats[0]?.bookedWithInvoice ?? 0);
  const invoicedJobCount = Number(jobStats[0]?.invoicedJobCount ?? 0);
  const soldLeads = Number(leadStats[0]?.soldLeads ?? 0);
  const revenue = Number(jobStats[0]?.revenue ?? 0);
  const spend = Number(spendResult[0]?.total ?? 0);

  const avgSaleValue = invoicedJobCount > 0 ? Math.round((revenue / invoicedJobCount) * 100) / 100 : (soldLeads > 0 ? Math.round((revenue / soldLeads) * 100) / 100 : 0);

  res.json({
    cpl: totalLeads > 0 ? Math.round((spend / totalLeads) * 100) / 100 : 0,
    bookingRate: totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100 * 10) / 10 : 0,
    closeRate: bookedLeads > 0 ? Math.round((bookedWithInvoice / bookedLeads) * 100 * 10) / 10 : 0,
    avgSaleValue,
    roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0,
  });
});

// Deliberate, indexed cross-tenant overview for agency / super_admin users.
//
// Replaces the implicit unfiltered cross-tenant *list* path (an unbounded
// `ORDER BY created_at` over a whole base table) that the `requireTenant` guard
// on the /leads, /jobs and /drilldown/* endpoints now rejects. Instead of
// scanning entire base tables, this endpoint:
//   * Bounds every query to a date window (defaults to the last 30 days) so a
//     request can never devolve into an unbounded full-table read.
//   * Aggregates per-tenant in single `GROUP BY tenant_id` queries (no N+1
//     per-tenant loop, no `SELECT *`), served by the tenant-scoped
//     `(tenant_id, created_at)` indexes on leads/jobs (migration 0072) and the
//     `campaigns(tenant_id)` + `campaign_daily_stats(campaign_id, date)`
//     indexes added for spend (migration 0074).
//
// Response shape mirrors /admin/dashboard-stats so the agency "God View" can
// consume it as a drop-in, but the data is produced by grouped, indexed
// queries rather than a per-tenant `SELECT *` loop.
const CROSS_TENANT_DEFAULT_WINDOW_DAYS = 30;
const MONTHLY_BUDGET_DEFAULT = 15000;

router.get("/dashboard/cross-tenant-overview", requireRole("super_admin", "agency_user"), async (req, res) => {
  // Resolve a bounded date window. An explicit start/end always wins; otherwise
  // default to the trailing CROSS_TENANT_DEFAULT_WINDOW_DAYS so the aggregation
  // never runs unbounded over the full history of every table.
  const now = new Date();
  const rawStart = typeof req.query.startDate === "string" && req.query.startDate ? req.query.startDate : undefined;
  const rawEnd = typeof req.query.endDate === "string" && req.query.endDate ? req.query.endDate : undefined;
  const endDate = rawEnd ?? now.toISOString().split("T")[0];
  const defaultStart = new Date(now.getTime() - CROSS_TENANT_DEFAULT_WINDOW_DAYS * 86400000)
    .toISOString().split("T")[0];
  const startDate = rawStart ?? defaultStart;
  // Optional: scope the returned `tenants` array to one client. Agency averages
  // are always computed across every active tenant so they stay a stable
  // benchmark regardless of this filter.
  const filterTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;

  const startBound = new Date(startDate);
  const endBound = new Date(endDate + "T23:59:59.999Z");

  const tenants = await db.select({ id: tenantsTable.id, name: tenantsTable.name, monthlyBudget: tenantsTable.monthlyBudget })
    .from(tenantsTable).where(eq(tenantsTable.isActive, true));

  const tenantIds = tenants.map(t => t.id);
  if (tenantIds.length === 0) {
    res.json({
      dateRange: { startDate, endDate },
      tenants: [],
      agencyAverages: { cpl: 0, roas: 0, bookingRate: 0, totalSpend: 0, totalRevenue: 0, totalLeads: 0 },
    });
    return;
  }

  const [leadsByTenant, jobsByTenant, spendByTenant] = await Promise.all([
    db.select({
      tenantId: leadsTable.tenantId,
      totalLeads: count(),
      bookedLeads: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.status} IN ('booked', 'sold'))`,
      soldLeads: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.status} = 'sold')`,
    }).from(leadsTable)
      .where(and(
        inArray(leadsTable.tenantId, tenantIds),
        gte(leadsTable.createdAt, startBound),
        lte(leadsTable.createdAt, endBound),
      ))
      .groupBy(leadsTable.tenantId),
    db.select({
      tenantId: jobsTable.tenantId,
      mtdRevenue: sql<number>`COALESCE(SUM(CASE WHEN ${jobsTable.status} = 'completed' THEN ${jobsTable.revenue} ELSE 0 END), 0)`,
    }).from(jobsTable)
      .where(and(
        inArray(jobsTable.tenantId, tenantIds),
        gte(jobsTable.createdAt, startBound),
        lte(jobsTable.createdAt, endBound),
      ))
      .groupBy(jobsTable.tenantId),
    db.select({
      tenantId: campaignsTable.tenantId,
      total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`,
    }).from(campaignDailyStatsTable)
      .innerJoin(campaignsTable, eq(campaignDailyStatsTable.campaignId, campaignsTable.id))
      .where(and(
        inArray(campaignsTable.tenantId, tenantIds),
        gte(campaignDailyStatsTable.date, startDate),
        lte(campaignDailyStatsTable.date, endDate),
      ))
      .groupBy(campaignsTable.tenantId),
  ]);

  const leadMap = new Map(leadsByTenant.map(r => [r.tenantId, r]));
  const jobMap = new Map(jobsByTenant.map(r => [r.tenantId, r]));
  const spendMap = new Map(spendByTenant.map(r => [r.tenantId, r]));

  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  let totalAgencySpend = 0;
  let totalAgencyLeads = 0;
  let totalAgencyRevenue = 0;
  let totalAgencyBookedLeads = 0;

  const tenantStats = tenants.map(tenant => {
    const l = leadMap.get(tenant.id);
    const j = jobMap.get(tenant.id);
    const s = spendMap.get(tenant.id);

    const totalLeads = Number(l?.totalLeads ?? 0);
    const bookedLeads = Number(l?.bookedLeads ?? 0);
    const soldLeads = Number(l?.soldLeads ?? 0);
    const mtdRevenue = Number(j?.mtdRevenue ?? 0);
    const mtdSpend = Number(s?.total ?? 0);

    totalAgencySpend += mtdSpend;
    totalAgencyLeads += totalLeads;
    totalAgencyRevenue += mtdRevenue;
    totalAgencyBookedLeads += bookedLeads;

    const projectedSpend = dayOfMonth > 0 ? Math.round((mtdSpend / dayOfMonth) * daysInMonth) : 0;
    const monthlyBudget = tenant.monthlyBudget ?? MONTHLY_BUDGET_DEFAULT;
    const pacePercent = monthlyBudget > 0 ? Math.round((projectedSpend / monthlyBudget) * 100 * 10) / 10 : 0;

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      mtdSpend: Math.round(mtdSpend * 100) / 100,
      mtdRevenue: Math.round(mtdRevenue * 100) / 100,
      projectedSpend,
      monthlyBudget,
      overBudget: projectedSpend > monthlyBudget,
      pacePercent,
      overPace: pacePercent > 110,
      underPace: pacePercent < 85,
      cpl: totalLeads > 0 ? Math.round((mtdSpend / totalLeads) * 100) / 100 : 0,
      bookingRate: totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100 * 10) / 10 : 0,
      closeRate: bookedLeads > 0 ? Math.round((soldLeads / bookedLeads) * 100 * 10) / 10 : 0,
      roas: mtdSpend > 0 ? Math.round((mtdRevenue / mtdSpend) * 100) / 100 : 0,
      totalLeads,
      bookedLeads,
      soldLeads,
    };
  });

  const agencyAverages = {
    cpl: totalAgencyLeads > 0 ? Math.round((totalAgencySpend / totalAgencyLeads) * 100) / 100 : 0,
    roas: totalAgencySpend > 0 ? Math.round((totalAgencyRevenue / totalAgencySpend) * 100) / 100 : 0,
    bookingRate: totalAgencyLeads > 0 ? Math.round((totalAgencyBookedLeads / totalAgencyLeads) * 100 * 10) / 10 : 0,
    totalSpend: Math.round(totalAgencySpend * 100) / 100,
    totalRevenue: Math.round(totalAgencyRevenue * 100) / 100,
    totalLeads: totalAgencyLeads,
  };

  const filteredTenantStats = filterTenantId
    ? tenantStats.filter(t => t.tenantId === filterTenantId)
    : tenantStats;

  res.json({
    dateRange: { startDate, endDate },
    tenants: filteredTenantStats,
    agencyAverages,
  });
});

router.get("/dashboard/tenant-performance", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenants = await db.select({ id: tenantsTable.id, name: tenantsTable.name })
    .from(tenantsTable).where(eq(tenantsTable.isActive, true));

  const tenantIds = tenants.map(t => t.id);
  if (tenantIds.length === 0) {
    res.json([]);
    return;
  }

  const [leadsByTenant, jobsByTenant, spendByTenant, closeRateByTenant] = await Promise.all([
    db.select({
      tenantId: leadsTable.tenantId,
      totalLeads: count(),
      bookedLeads: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.status} IN ('booked', 'sold') OR ${leadsTable.hubStatus} = 'appt_booked')`,
      soldLeads: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.status} = 'sold')`,
    }).from(leadsTable)
      .where(inArray(leadsTable.tenantId, tenantIds))
      .groupBy(leadsTable.tenantId),
    db.select({
      tenantId: jobsTable.tenantId,
      mtdRevenue: sql<number>`COALESCE(SUM(CASE WHEN ${jobsTable.status} = 'completed' THEN COALESCE(${jobsTable.invoiceTotal} + COALESCE(${jobsTable.invoiceRebateAmount}, 0), ${jobsTable.revenue}) ELSE 0 END), 0)`,
      invoicedJobCount: sql<number>`COUNT(*) FILTER (WHERE ${jobsTable.hasInvoice} = true)`,
    }).from(jobsTable)
      .where(inArray(jobsTable.tenantId, tenantIds))
      .groupBy(jobsTable.tenantId),
    db.select({
      tenantId: campaignsTable.tenantId,
      total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`,
    }).from(campaignDailyStatsTable)
      .innerJoin(campaignsTable, eq(campaignDailyStatsTable.campaignId, campaignsTable.id))
      .where(inArray(campaignsTable.tenantId, tenantIds))
      .groupBy(campaignsTable.tenantId),
    db.select({
      tenantId: leadsTable.tenantId,
      bookedWithInvoice: sql<number>`COUNT(DISTINCT ${leadsTable.id})`,
    })
      .from(leadsTable)
      .innerJoin(jobsTable, and(
        eq(jobsTable.leadId, leadsTable.id),
        eq(jobsTable.hasInvoice, true),
      ))
      .where(and(
        inArray(leadsTable.tenantId, tenantIds),
        sql`(${leadsTable.status} IN ('booked', 'sold') OR ${leadsTable.hubStatus} = 'appt_booked')`,
      ))
      .groupBy(leadsTable.tenantId),
  ]);

  const leadMap = new Map(leadsByTenant.map(r => [r.tenantId, r]));
  const jobMap = new Map(jobsByTenant.map(r => [r.tenantId, r]));
  const spendMap = new Map(spendByTenant.map(r => [r.tenantId, r]));
  const closeRateMap = new Map(closeRateByTenant.map(r => [r.tenantId, r]));

  const results = tenants.map(tenant => {
    const l = leadMap.get(tenant.id);
    const j = jobMap.get(tenant.id);
    const s = spendMap.get(tenant.id);
    const cr = closeRateMap.get(tenant.id);

    const totalLeads = Number(l?.totalLeads ?? 0);
    const bookedLeads = Number(l?.bookedLeads ?? 0);
    const bookedWithInvoice = Number(cr?.bookedWithInvoice ?? 0);
    const mtdRevenue = Number(j?.mtdRevenue ?? 0);
    const mtdSpend = Number(s?.total ?? 0);

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      mtdSpend: Math.round(mtdSpend * 100) / 100,
      mtdRevenue: Math.round(mtdRevenue * 100) / 100,
      cpl: totalLeads > 0 ? Math.round((mtdSpend / totalLeads) * 100) / 100 : 0,
      bookingRate: totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100 * 10) / 10 : 0,
      closeRate: bookedLeads > 0 ? Math.round((bookedWithInvoice / bookedLeads) * 100 * 10) / 10 : 0,
      roas: mtdSpend > 0 ? Math.round((mtdRevenue / mtdSpend) * 100) / 100 : 0,
      leadCount: totalLeads,
    };
  });

  res.json(results);
});

export default router;
