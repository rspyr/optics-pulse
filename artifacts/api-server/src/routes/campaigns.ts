import { Router, type IRouter } from "express";
import {
  db,
  campaignsTable,
  campaignFunnelMappingsTable,
  campaignDailyStatsTable,
  funnelTypesTable,
  metaAdAccountsTable,
  metaAdSetsTable,
  metaAdsTable,
  metaAdDailyStatsTable,
  tenantFunnelTypesTable,
} from "@workspace/db";
import { eq, and, gte, lte, inArray, SQL, sql, asc } from "drizzle-orm";
import { ListCampaignsQueryParams } from "@workspace/api-zod";
import { resolveListTenantScope, assertResourceTenantAccess } from "../lib/tenant-scope";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

router.get("/campaigns", async (req, res) => {
  const query = ListCampaignsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  const scope = resolveListTenantScope(req, res, query.tenantId);
  if (!scope.ok) return;
  if (scope.tenantId) conditions.push(eq(campaignsTable.tenantId, scope.tenantId));
  if (query.platform) conditions.push(eq(campaignsTable.platform, query.platform));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const campaigns = await db.select().from(campaignsTable).where(where);
  res.json(campaigns);
});

router.get("/campaigns/stats", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

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

function normalizeCampaignText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function suggestFunnel(campaignName: string, funnels: Array<{ id: number; name: string }>) {
  const normalizedCampaign = normalizeCampaignText(campaignName);
  if (!normalizedCampaign) return null;

  return funnels
    .map((funnel) => ({ funnel, normalized: normalizeCampaignText(funnel.name) }))
    .filter(({ normalized }) => normalized.length > 0 && normalizedCampaign.includes(normalized))
    .sort((a, b) => b.normalized.length - a.normalized.length)[0]?.funnel ?? null;
}

router.get("/campaigns/meta-funnel-mappings", requireRole("super_admin", "agency_user", "client_admin"), async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  const tenantId = scope.tenantId;
  if (!tenantId) {
    res.status(400).json({ error: "Select a client to map Meta campaigns to funnels." });
    return;
  }

  const funnels = await db.select({
    id: funnelTypesTable.id,
    name: funnelTypesTable.name,
  })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(funnelTypesTable.id, tenantFunnelTypesTable.funnelTypeId))
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId))
    .orderBy(asc(funnelTypesTable.name));

  const result = await db.execute(sql`
    SELECT
      c.id AS campaign_id,
      c.external_id,
      c.name,
      c.status,
      c.currency,
      c.meta_ad_account_id,
      cfm.funnel_type_id,
      ft.name AS funnel_name,
      cfm.mapping_source,
      COALESCE(SUM(cds.spend), 0)::numeric AS spend,
      COALESCE(SUM(cds.conversions), 0)::numeric AS conversions
    FROM campaigns c
    LEFT JOIN campaign_daily_stats cds
      ON cds.campaign_id = c.id
      ${startDate ? sql`AND cds.date >= ${startDate}` : sql``}
      ${endDate ? sql`AND cds.date <= ${endDate}` : sql``}
    LEFT JOIN campaign_funnel_mappings cfm
      ON cfm.campaign_id = c.id
      AND cfm.tenant_id = c.tenant_id
    LEFT JOIN tenant_funnel_types tft
      ON tft.tenant_id = c.tenant_id
      AND tft.funnel_type_id = cfm.funnel_type_id
    LEFT JOIN funnel_types ft
      ON ft.id = tft.funnel_type_id
    WHERE c.tenant_id = ${tenantId}
      AND c.platform = 'meta'
    GROUP BY c.id, c.external_id, c.name, c.status, c.currency, c.meta_ad_account_id, cfm.funnel_type_id, ft.name, cfm.mapping_source
    ORDER BY spend DESC, c.name ASC
  `);

  type CampaignMappingRow = {
    campaign_id: number;
    external_id: string;
    name: string;
    status: string;
    currency: string | null;
    meta_ad_account_id: string | null;
    funnel_type_id: number | null;
    funnel_name: string | null;
    mapping_source: string | null;
    spend: string | number | null;
    conversions: string | number | null;
  };

  const campaigns = ((result as unknown as { rows?: CampaignMappingRow[] }).rows ?? []).map((row) => {
    const suggested = row.funnel_type_id ? null : suggestFunnel(row.name, funnels);
    const spend = Number(row.spend ?? 0);
    const conversions = Number(row.conversions ?? 0);
    return {
      campaignId: Number(row.campaign_id),
      externalId: row.external_id,
      name: row.name,
      status: row.status,
      currency: row.currency,
      adAccountId: row.meta_ad_account_id,
      spend: round2(Number.isFinite(spend) ? spend : 0),
      conversions: Number.isFinite(conversions) ? conversions : 0,
      cpl: cplOf(Number.isFinite(spend) ? spend : 0, Number.isFinite(conversions) ? conversions : 0),
      funnelTypeId: row.funnel_type_id == null ? null : Number(row.funnel_type_id),
      funnelName: row.funnel_name,
      mappingSource: row.mapping_source,
      suggestedFunnelTypeId: suggested?.id ?? null,
      suggestedFunnelName: suggested?.name ?? null,
    };
  });

  const unmappedSpend = campaigns
    .filter((campaign) => campaign.funnelTypeId == null && campaign.spend > 0)
    .reduce((sum, campaign) => sum + campaign.spend, 0);
  const unmappedConversions = campaigns
    .filter((campaign) => campaign.funnelTypeId == null && campaign.conversions > 0)
    .reduce((sum, campaign) => sum + campaign.conversions, 0);

  res.json({
    dateRange: { startDate: startDate ?? null, endDate: endDate ?? null },
    funnels,
    campaigns,
    unmappedSpend: round2(unmappedSpend),
    unmappedConversions,
  });
});

router.put("/campaigns/:campaignId/funnel-mapping", requireRole("super_admin", "agency_user", "client_admin"), async (req, res) => {
  const campaignId = Number(req.params.campaignId);
  if (!campaignId || Number.isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaignId" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignId)).limit(1);
  if (!campaign || campaign.platform !== "meta") {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  const access = assertResourceTenantAccess(req, res, campaign.tenantId, {
    notFoundOnMismatch: true,
    notFoundMessage: "Campaign not found",
  });
  if (!access.ok) return;

  const rawFunnelTypeId = (req.body as { funnelTypeId?: unknown } | undefined)?.funnelTypeId;
  const funnelTypeId = rawFunnelTypeId == null || rawFunnelTypeId === ""
    ? null
    : Number(rawFunnelTypeId);

  if (funnelTypeId == null) {
    await db.delete(campaignFunnelMappingsTable)
      .where(eq(campaignFunnelMappingsTable.campaignId, campaignId));
    res.json({ campaignId, funnelTypeId: null, funnelName: null });
    return;
  }

  if (!Number.isFinite(funnelTypeId) || funnelTypeId <= 0) {
    res.status(400).json({ error: "Invalid funnelTypeId" });
    return;
  }

  const [tenantFunnel] = await db.select({
    id: funnelTypesTable.id,
    name: funnelTypesTable.name,
  })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(funnelTypesTable.id, tenantFunnelTypesTable.funnelTypeId))
    .where(and(
      eq(tenantFunnelTypesTable.tenantId, campaign.tenantId),
      eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId),
    ))
    .limit(1);

  if (!tenantFunnel) {
    res.status(400).json({ error: "That funnel is not enabled for this client." });
    return;
  }

  const userId = req.session.userId ?? null;
  await db.execute(sql`
    INSERT INTO campaign_funnel_mappings (
      tenant_id,
      campaign_id,
      funnel_type_id,
      mapping_source,
      created_by_user_id,
      updated_by_user_id,
      created_at,
      updated_at
    )
    VALUES (
      ${campaign.tenantId},
      ${campaignId},
      ${funnelTypeId},
      'manual',
      ${userId},
      ${userId},
      NOW(),
      NOW()
    )
    ON CONFLICT (campaign_id)
    DO UPDATE SET
      funnel_type_id = EXCLUDED.funnel_type_id,
      mapping_source = 'manual',
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = NOW()
  `);

  res.json({
    campaignId,
    funnelTypeId,
    funnelName: tenantFunnel.name,
  });
});

router.get("/campaigns/meta-summary", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  // resolveListTenantScope forces the session tenantId for non-admin
  // roles (mirroring /attribution/events). For super_admin / agency_user
  // a null tenantId means "aggregate across all tenants they can see"
  // (matching /dashboard/overview behavior).
  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

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
  // does not validate path-resolved resources like :campaignId. Use 404 on
  // mismatch to keep the response indistinguishable from "does not exist".
  const access = assertResourceTenantAccess(req, res, campaign.tenantId, {
    notFoundOnMismatch: true,
    notFoundMessage: "Campaign not found",
  });
  if (!access.ok) return;

  if (campaign.platform !== "meta") {
    res.status(404).json({ error: "Campaign not found" });
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
      creativeThumbnailUrl: ad.creativeThumbnailUrl,
      creativeTitle: ad.creativeTitle,
      creativeBody: ad.creativeBody,
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
