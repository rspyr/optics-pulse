import { Router, type IRouter } from "express";
import { db, campaignsTable, campaignDailyStatsTable } from "@workspace/db";
import { eq, and, gte, lte, inArray, SQL } from "drizzle-orm";
import { ListCampaignsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/campaigns", async (req, res) => {
  const query = ListCampaignsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  if (query.tenantId) conditions.push(eq(campaignsTable.tenantId, query.tenantId));
  if (query.platform) conditions.push(eq(campaignsTable.platform, query.platform));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const campaigns = await db.select().from(campaignsTable).where(where);
  res.json(campaigns);
});

router.get("/campaigns/stats", async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const conditions: SQL[] = [];

  if (tenantId) {
    const tenantCampaigns = await db.select({ id: campaignsTable.id }).from(campaignsTable).where(eq(campaignsTable.tenantId, tenantId));
    const campaignIds = tenantCampaigns.map(c => c.id);
    if (campaignIds.length === 0) {
      res.json({ totalSpend: 0, totalImpressions: 0, totalClicks: 0, totalConversions: 0, avgCpc: 0, avgCpl: 0, dailyStats: [] });
      return;
    }
    conditions.push(inArray(campaignDailyStatsTable.campaignId, campaignIds));
  }

  if (startDate) conditions.push(gte(campaignDailyStatsTable.date, startDate));
  if (endDate) conditions.push(lte(campaignDailyStatsTable.date, endDate));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const stats = await db.select().from(campaignDailyStatsTable).where(where);

  const totalSpend = stats.reduce((s, r) => s + (r.spend || 0), 0);
  const totalImpressions = stats.reduce((s, r) => s + (r.impressions || 0), 0);
  const totalClicks = stats.reduce((s, r) => s + (r.clicks || 0), 0);
  const totalConversions = stats.reduce((s, r) => s + (r.conversions || 0), 0);

  const dailyMap = new Map<string, { spend: number; impressions: number; clicks: number; conversions: number }>();
  for (const s of stats) {
    const dateStr = String(s.date);
    const existing = dailyMap.get(dateStr) || { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
    existing.spend += s.spend || 0;
    existing.impressions += s.impressions || 0;
    existing.clicks += s.clicks || 0;
    existing.conversions += s.conversions || 0;
    dailyMap.set(dateStr, existing);
  }

  const dailyStats = Array.from(dailyMap.entries()).map(([date, data]) => ({ date, ...data })).sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    totalSpend: Math.round(totalSpend * 100) / 100,
    totalImpressions,
    totalClicks,
    totalConversions,
    avgCpc: totalClicks > 0 ? Math.round((totalSpend / totalClicks) * 100) / 100 : 0,
    avgCpl: totalConversions > 0 ? Math.round((totalSpend / totalConversions) * 100) / 100 : 0,
    dailyStats,
  });
});

export default router;
