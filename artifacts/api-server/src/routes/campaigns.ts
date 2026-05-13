import { Router, type IRouter } from "express";
import {
  db,
  campaignsTable,
  campaignDailyStatsTable,
  metaAdAccountsTable,
  metaAdSetsTable,
  metaAdsTable,
  metaAdDailyStatsTable,
} from "@workspace/db";
import { eq, and, gte, lte, inArray, SQL, sql } from "drizzle-orm";
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

const round2 = (n: number) => Math.round(n * 100) / 100;
const cplOf = (spend: number, conv: number) => (conv > 0 ? round2(spend / conv) : 0);

router.get("/campaigns/meta-summary", async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  // enforceTenantScope auto-injects tenantId for non-agency users; if it's
  // still null here the caller is super_admin / agency_user, so we aggregate
  // across all tenants they can see (matching /dashboard/overview behavior).
  const campaignConds: SQL[] = [eq(campaignsTable.platform, "meta")];
  if (tenantId) campaignConds.push(eq(campaignsTable.tenantId, tenantId));

  const campaigns = await db.select().from(campaignsTable).where(and(...campaignConds));

  if (campaigns.length === 0) {
    res.json([]);
    return;
  }

  const externalIds = campaigns.map(c => c.externalId);
  const adAccountIds = Array.from(new Set(campaigns.map(c => c.metaAdAccountId).filter((x): x is string => !!x)));

  const tenantIdsInPlay = Array.from(new Set(campaigns.map(c => c.tenantId)));

  const accounts = adAccountIds.length > 0
    ? await db.select().from(metaAdAccountsTable)
        .where(and(inArray(metaAdAccountsTable.tenantId, tenantIdsInPlay), inArray(metaAdAccountsTable.accountId, adAccountIds)))
    : [];
  const currencyByAccount = new Map(accounts.map(a => [`${a.tenantId}:${a.accountId}`, a.currency]));

  const adStatsConds: SQL[] = [
    inArray(metaAdDailyStatsTable.tenantId, tenantIdsInPlay),
    inArray(metaAdDailyStatsTable.campaignExternalId, externalIds),
  ];
  if (startDate) adStatsConds.push(gte(metaAdDailyStatsTable.date, startDate));
  if (endDate) adStatsConds.push(lte(metaAdDailyStatsTable.date, endDate));

  const aggRows = await db.select({
    campaignExternalId: metaAdDailyStatsTable.campaignExternalId,
    spend: sql<number>`COALESCE(SUM(${metaAdDailyStatsTable.spend}), 0)`,
    impressions: sql<number>`COALESCE(SUM(${metaAdDailyStatsTable.impressions}), 0)`,
    clicks: sql<number>`COALESCE(SUM(${metaAdDailyStatsTable.clicks}), 0)`,
    conversions: sql<number>`COALESCE(SUM(${metaAdDailyStatsTable.conversions}), 0)`,
  })
    .from(metaAdDailyStatsTable)
    .where(and(...adStatsConds))
    .groupBy(metaAdDailyStatsTable.campaignExternalId);

  const aggByExt = new Map(aggRows.map(r => [r.campaignExternalId, r]));

  const result = campaigns.map(c => {
    const a = aggByExt.get(c.externalId);
    const spend = round2(Number(a?.spend ?? 0));
    const impressions = Number(a?.impressions ?? 0);
    const clicks = Number(a?.clicks ?? 0);
    const conversions = Number(a?.conversions ?? 0);
    const currency = (c.metaAdAccountId && currencyByAccount.get(`${c.tenantId}:${c.metaAdAccountId}`)) || c.currency || null;
    return {
      campaignId: c.id,
      externalId: c.externalId,
      name: c.name,
      status: c.status,
      currency,
      adAccountId: c.metaAdAccountId,
      spend,
      impressions,
      clicks,
      conversions,
      cpl: cplOf(spend, conversions),
    };
  }).sort((a, b) => b.spend - a.spend);

  res.json(result);
});

router.get("/campaigns/:campaignId/breakdown", async (req, res) => {
  const campaignId = Number(req.params.campaignId);
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  if (!campaignId || Number.isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaignId" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignId));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  // Tenant authorization: super_admin / agency_user may access any campaign;
  // every other role must match the campaign's tenant. enforceTenantScope
  // does not validate path-resolved resources like :campaignId.
  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    const sessionTenantId = req.session.tenantId;
    if (!sessionTenantId || sessionTenantId !== campaign.tenantId) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
  }

  if (campaign.platform !== "meta") {
    res.status(400).json({ error: "Breakdown is only available for Meta campaigns" });
    return;
  }

  const tenantId = campaign.tenantId;
  const externalId = campaign.externalId;

  let currency: string | null = campaign.currency ?? null;
  if (campaign.metaAdAccountId) {
    const [acct] = await db.select().from(metaAdAccountsTable)
      .where(and(eq(metaAdAccountsTable.tenantId, tenantId), eq(metaAdAccountsTable.accountId, campaign.metaAdAccountId)));
    if (acct) currency = acct.currency;
  }

  const statsConds: SQL[] = [
    eq(metaAdDailyStatsTable.tenantId, tenantId),
    eq(metaAdDailyStatsTable.campaignExternalId, externalId),
  ];
  if (startDate) statsConds.push(gte(metaAdDailyStatsTable.date, startDate));
  if (endDate) statsConds.push(lte(metaAdDailyStatsTable.date, endDate));

  const [adSets, ads, perAdAgg] = await Promise.all([
    db.select().from(metaAdSetsTable)
      .where(and(eq(metaAdSetsTable.tenantId, tenantId), eq(metaAdSetsTable.campaignExternalId, externalId))),
    db.select().from(metaAdsTable)
      .where(and(eq(metaAdsTable.tenantId, tenantId), eq(metaAdsTable.campaignExternalId, externalId))),
    db.select({
      adExternalId: metaAdDailyStatsTable.adExternalId,
      adSetExternalId: metaAdDailyStatsTable.adSetExternalId,
      spend: sql<number>`COALESCE(SUM(${metaAdDailyStatsTable.spend}), 0)`,
      impressions: sql<number>`COALESCE(SUM(${metaAdDailyStatsTable.impressions}), 0)`,
      clicks: sql<number>`COALESCE(SUM(${metaAdDailyStatsTable.clicks}), 0)`,
      conversions: sql<number>`COALESCE(SUM(${metaAdDailyStatsTable.conversions}), 0)`,
    })
      .from(metaAdDailyStatsTable)
      .where(and(...statsConds))
      .groupBy(metaAdDailyStatsTable.adExternalId, metaAdDailyStatsTable.adSetExternalId),
  ]);

  const adAgg = new Map(perAdAgg.map(r => [r.adExternalId, r]));

  const adsBySet = new Map<string, typeof ads>();
  const orphanAdSetExternalId = "__unassigned__";
  for (const ad of ads) {
    const key = ad.adSetExternalId || orphanAdSetExternalId;
    const list = adsBySet.get(key) || [];
    list.push(ad);
    adsBySet.set(key, list);
  }

  const buildAdRow = (ad: typeof ads[number]) => {
    const a = adAgg.get(ad.externalId);
    const spend = round2(Number(a?.spend ?? 0));
    const impressions = Number(a?.impressions ?? 0);
    const clicks = Number(a?.clicks ?? 0);
    const conversions = Number(a?.conversions ?? 0);
    return {
      externalId: ad.externalId,
      name: ad.name,
      status: ad.effectiveStatus,
      creativeId: ad.creativeId,
      spend,
      impressions,
      clicks,
      conversions,
      cpl: cplOf(spend, conversions),
    };
  };

  const knownAdSetIds = new Set(adSets.map(s => s.externalId));
  const adSetRows = adSets.map(s => {
    const adRows = (adsBySet.get(s.externalId) || []).map(buildAdRow);
    const spend = round2(adRows.reduce((sum, r) => sum + r.spend, 0));
    const impressions = adRows.reduce((sum, r) => sum + r.impressions, 0);
    const clicks = adRows.reduce((sum, r) => sum + r.clicks, 0);
    const conversions = adRows.reduce((sum, r) => sum + r.conversions, 0);
    return {
      externalId: s.externalId,
      name: s.name,
      status: s.effectiveStatus,
      dailyBudgetCents: s.dailyBudgetCents,
      spend,
      impressions,
      clicks,
      conversions,
      cpl: cplOf(spend, conversions),
      ads: adRows.sort((a, b) => b.spend - a.spend),
    };
  });

  const orphanAds: typeof ads = [];
  for (const ad of ads) {
    if (!ad.adSetExternalId || !knownAdSetIds.has(ad.adSetExternalId)) {
      orphanAds.push(ad);
    }
  }
  if (orphanAds.length > 0) {
    const adRows = orphanAds.map(buildAdRow);
    const spend = round2(adRows.reduce((sum, r) => sum + r.spend, 0));
    const impressions = adRows.reduce((sum, r) => sum + r.impressions, 0);
    const clicks = adRows.reduce((sum, r) => sum + r.clicks, 0);
    const conversions = adRows.reduce((sum, r) => sum + r.conversions, 0);
    adSetRows.push({
      externalId: orphanAdSetExternalId,
      name: "(Unassigned)",
      status: null,
      dailyBudgetCents: null,
      spend,
      impressions,
      clicks,
      conversions,
      cpl: cplOf(spend, conversions),
      ads: adRows.sort((a, b) => b.spend - a.spend),
    });
  }

  adSetRows.sort((a, b) => b.spend - a.spend);

  res.json({
    campaignId: campaign.id,
    externalId: campaign.externalId,
    name: campaign.name,
    currency,
    adAccountId: campaign.metaAdAccountId,
    adSets: adSetRows,
  });
});

export default router;
