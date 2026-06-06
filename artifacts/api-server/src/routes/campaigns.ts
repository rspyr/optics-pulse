import { Router, type IRouter } from "express";
import {
  db,
  campaignsTable,
  campaignFunnelMappingsTable,
  campaignFunnelMatchCodesTable,
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

type FunnelMappingOption = {
  id: number;
  name: string;
  slug: string;
  matchCodes: Array<{ id: number; code: string }>;
};

function suggestFunnel(textValues: string[], funnels: FunnelMappingOption[]) {
  const normalizedTitle = normalizeCampaignText(textValues.filter(Boolean).join(" "));
  if (!normalizedTitle) return null;

  return funnels
    .flatMap((funnel) => {
      const terms = [
        { value: funnel.name, matchedCode: null as string | null },
        { value: funnel.slug, matchedCode: funnel.slug },
        ...funnel.matchCodes.map((code) => ({ value: code.code, matchedCode: code.code })),
      ];
      return terms.map((term) => ({
        funnel,
        matchedCode: term.matchedCode,
        normalized: normalizeCampaignText(term.value),
      }));
    })
    .filter(({ normalized }) => normalized.length >= 2 && normalizedTitle.includes(normalized))
    .sort((a, b) => b.normalized.length - a.normalized.length)[0] ?? null;
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
    slug: funnelTypesTable.slug,
  })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(funnelTypesTable.id, tenantFunnelTypesTable.funnelTypeId))
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId))
    .orderBy(asc(funnelTypesTable.name));

  const funnelIds = funnels.map((funnel) => funnel.id);
  const matchCodes = funnelIds.length > 0
    ? await db.select({
      id: campaignFunnelMatchCodesTable.id,
      funnelTypeId: campaignFunnelMatchCodesTable.funnelTypeId,
      code: campaignFunnelMatchCodesTable.code,
    })
      .from(campaignFunnelMatchCodesTable)
      .where(inArray(campaignFunnelMatchCodesTable.funnelTypeId, funnelIds))
      .orderBy(asc(campaignFunnelMatchCodesTable.code))
    : [];

  const codesByFunnel = new Map<number, Array<{ id: number; code: string }>>();
  for (const code of matchCodes) {
    const list = codesByFunnel.get(code.funnelTypeId) ?? [];
    list.push({ id: code.id, code: code.code });
    codesByFunnel.set(code.funnelTypeId, list);
  }

  const funnelOptions: FunnelMappingOption[] = funnels.map((funnel) => ({
    ...funnel,
    matchCodes: codesByFunnel.get(funnel.id) ?? [],
  }));

  const campaignResult = await db.execute(sql`
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
      AND cfm.ad_set_external_id IS NULL
    LEFT JOIN tenant_funnel_types tft
      ON tft.tenant_id = c.tenant_id
      AND tft.funnel_type_id = cfm.funnel_type_id
    LEFT JOIN funnel_types ft
      ON ft.id = tft.funnel_type_id
    WHERE c.tenant_id = ${tenantId}
      AND c.platform = 'meta'
    GROUP BY c.id, c.external_id, c.name, c.status, c.currency, c.meta_ad_account_id, cfm.funnel_type_id, ft.name, cfm.mapping_source
    HAVING COALESCE(SUM(cds.spend), 0) > 0
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

  const campaigns = ((campaignResult as unknown as { rows?: CampaignMappingRow[] }).rows ?? []).map((row) => {
    const suggested = row.funnel_type_id ? null : suggestFunnel([row.name], funnelOptions);
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
      suggestedFunnelTypeId: suggested?.funnel.id ?? null,
      suggestedFunnelName: suggested?.funnel.name ?? null,
      suggestedMatchCode: suggested?.matchedCode ?? null,
    };
  });

  const adSetResult = await db.execute(sql`
    SELECT
      c.id AS campaign_id,
      c.external_id AS campaign_external_id,
      c.name AS campaign_name,
      mas.external_id AS ad_set_external_id,
      mas.name AS ad_set_name,
      mas.effective_status,
      mas.ad_account_id,
      ad_cfm.funnel_type_id,
      ad_ft.name AS funnel_name,
      ad_cfm.mapping_source,
      campaign_cfm.funnel_type_id AS campaign_funnel_type_id,
      campaign_ft.name AS campaign_funnel_name,
      campaign_cfm.mapping_source AS campaign_mapping_source,
      COALESCE(SUM(mads.spend), 0)::numeric AS spend,
      COALESCE(SUM(mads.conversions), 0)::numeric AS conversions
    FROM meta_ad_sets mas
    JOIN campaigns c
      ON c.tenant_id = mas.tenant_id
      AND c.external_id = mas.campaign_external_id
      AND c.platform = 'meta'
    LEFT JOIN meta_ad_daily_stats mads
      ON mads.tenant_id = mas.tenant_id
      AND mads.ad_set_external_id = mas.external_id
      ${startDate ? sql`AND mads.date >= ${startDate}` : sql``}
      ${endDate ? sql`AND mads.date <= ${endDate}` : sql``}
    LEFT JOIN campaign_funnel_mappings ad_cfm
      ON ad_cfm.tenant_id = mas.tenant_id
      AND ad_cfm.campaign_id = c.id
      AND ad_cfm.ad_set_external_id = mas.external_id
    LEFT JOIN tenant_funnel_types ad_tft
      ON ad_tft.tenant_id = mas.tenant_id
      AND ad_tft.funnel_type_id = ad_cfm.funnel_type_id
    LEFT JOIN funnel_types ad_ft
      ON ad_ft.id = ad_tft.funnel_type_id
    LEFT JOIN campaign_funnel_mappings campaign_cfm
      ON campaign_cfm.tenant_id = mas.tenant_id
      AND campaign_cfm.campaign_id = c.id
      AND campaign_cfm.ad_set_external_id IS NULL
    LEFT JOIN tenant_funnel_types campaign_tft
      ON campaign_tft.tenant_id = mas.tenant_id
      AND campaign_tft.funnel_type_id = campaign_cfm.funnel_type_id
    LEFT JOIN funnel_types campaign_ft
      ON campaign_ft.id = campaign_tft.funnel_type_id
    WHERE mas.tenant_id = ${tenantId}
    GROUP BY
      c.id,
      c.external_id,
      c.name,
      mas.external_id,
      mas.name,
      mas.effective_status,
      mas.ad_account_id,
      ad_cfm.funnel_type_id,
      ad_ft.name,
      ad_cfm.mapping_source,
      campaign_cfm.funnel_type_id,
      campaign_ft.name,
      campaign_cfm.mapping_source
    HAVING COALESCE(SUM(mads.spend), 0) > 0
    ORDER BY spend DESC, c.name ASC, mas.name ASC
  `);

  type AdSetMappingRow = {
    campaign_id: number;
    campaign_external_id: string;
    campaign_name: string;
    ad_set_external_id: string;
    ad_set_name: string;
    effective_status: string | null;
    ad_account_id: string | null;
    funnel_type_id: number | null;
    funnel_name: string | null;
    mapping_source: string | null;
    campaign_funnel_type_id: number | null;
    campaign_funnel_name: string | null;
    campaign_mapping_source: string | null;
    spend: string | number | null;
    conversions: string | number | null;
  };

  const adSets = ((adSetResult as unknown as { rows?: AdSetMappingRow[] }).rows ?? []).map((row) => {
    const explicitFunnelTypeId = row.funnel_type_id == null ? null : Number(row.funnel_type_id);
    const inheritedFunnelTypeId = row.campaign_funnel_type_id == null ? null : Number(row.campaign_funnel_type_id);
    const effectiveFunnelTypeId = explicitFunnelTypeId ?? inheritedFunnelTypeId;
    const suggested = effectiveFunnelTypeId ? null : suggestFunnel([row.ad_set_name, row.campaign_name], funnelOptions);
    const spend = Number(row.spend ?? 0);
    const conversions = Number(row.conversions ?? 0);
    return {
      campaignId: Number(row.campaign_id),
      campaignExternalId: row.campaign_external_id,
      campaignName: row.campaign_name,
      adSetExternalId: row.ad_set_external_id,
      name: row.ad_set_name,
      status: row.effective_status,
      adAccountId: row.ad_account_id,
      spend: round2(Number.isFinite(spend) ? spend : 0),
      conversions: Number.isFinite(conversions) ? conversions : 0,
      cpl: cplOf(Number.isFinite(spend) ? spend : 0, Number.isFinite(conversions) ? conversions : 0),
      funnelTypeId: explicitFunnelTypeId,
      funnelName: row.funnel_name,
      mappingSource: row.mapping_source,
      campaignFunnelTypeId: inheritedFunnelTypeId,
      campaignFunnelName: row.campaign_funnel_name,
      campaignMappingSource: row.campaign_mapping_source,
      effectiveFunnelTypeId,
      effectiveFunnelName: row.funnel_name ?? row.campaign_funnel_name,
      effectiveMappingLevel: explicitFunnelTypeId ? "ad_set" : (inheritedFunnelTypeId ? "campaign" : null),
      suggestedFunnelTypeId: suggested?.funnel.id ?? null,
      suggestedFunnelName: suggested?.funnel.name ?? null,
      suggestedMatchCode: suggested?.matchedCode ?? null,
    };
  });

  const effectiveMappingResult = await db.execute(sql`
    SELECT
      COALESCE(ad_cfm.funnel_type_id, campaign_cfm.funnel_type_id) AS funnel_type_id,
      COALESCE(SUM(mads.spend), 0)::numeric AS spend,
      COALESCE(SUM(mads.conversions), 0)::numeric AS conversions
    FROM meta_ad_daily_stats mads
    JOIN campaigns c
      ON c.tenant_id = mads.tenant_id
      AND c.external_id = mads.campaign_external_id
      AND c.platform = 'meta'
    LEFT JOIN campaign_funnel_mappings ad_cfm
      ON ad_cfm.tenant_id = mads.tenant_id
      AND ad_cfm.campaign_id = c.id
      AND ad_cfm.ad_set_external_id = mads.ad_set_external_id
    LEFT JOIN campaign_funnel_mappings campaign_cfm
      ON campaign_cfm.tenant_id = mads.tenant_id
      AND campaign_cfm.campaign_id = c.id
      AND campaign_cfm.ad_set_external_id IS NULL
    WHERE mads.tenant_id = ${tenantId}
      ${startDate ? sql`AND mads.date >= ${startDate}` : sql``}
      ${endDate ? sql`AND mads.date <= ${endDate}` : sql``}
    GROUP BY COALESCE(ad_cfm.funnel_type_id, campaign_cfm.funnel_type_id)
  `);

  const effectiveRows = ((effectiveMappingResult as unknown as { rows?: Array<{ funnel_type_id: number | null; spend: string | number | null; conversions: string | number | null }> }).rows ?? []);
  const unmappedSpend = effectiveRows
    .filter((row) => row.funnel_type_id == null)
    .reduce((sum, row) => sum + toFiniteNumber(row.spend), 0);
  const unmappedConversions = effectiveRows
    .filter((row) => row.funnel_type_id == null)
    .reduce((sum, row) => sum + toFiniteNumber(row.conversions), 0);

  res.json({
    dateRange: { startDate: startDate ?? null, endDate: endDate ?? null },
    funnels: funnelOptions,
    campaigns,
    adSets,
    unmappedSpend: round2(unmappedSpend),
    unmappedConversions,
  });
});

function toFiniteNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

router.post("/campaigns/meta-funnel-match-codes", requireRole("super_admin", "agency_user", "client_admin"), async (req, res) => {
  const body = req.body as { tenantId?: unknown; funnelTypeId?: unknown; code?: unknown } | undefined;
  const scope = resolveListTenantScope(req, res, body?.tenantId ? Number(body.tenantId) : null);
  if (!scope.ok) return;
  const tenantId = scope.tenantId;
  if (!tenantId) {
    res.status(400).json({ error: "Select a client before adding a match code." });
    return;
  }

  const funnelTypeId = Number(body?.funnelTypeId);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!Number.isFinite(funnelTypeId) || funnelTypeId <= 0 || !code) {
    res.status(400).json({ error: "funnelTypeId and code are required." });
    return;
  }

  const [tenantFunnel] = await db.select({
    id: funnelTypesTable.id,
    name: funnelTypesTable.name,
  })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(funnelTypesTable.id, tenantFunnelTypesTable.funnelTypeId))
    .where(and(
      eq(tenantFunnelTypesTable.tenantId, tenantId),
      eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId),
    ))
    .limit(1);

  if (!tenantFunnel) {
    res.status(400).json({ error: "That funnel is not enabled for this client." });
    return;
  }

  const [existing] = await db.select({
    id: campaignFunnelMatchCodesTable.id,
    funnelTypeId: campaignFunnelMatchCodesTable.funnelTypeId,
  })
    .from(campaignFunnelMatchCodesTable)
    .where(sql`LOWER(${campaignFunnelMatchCodesTable.code}) = LOWER(${code})`)
    .limit(1);

  if (existing && existing.funnelTypeId !== funnelTypeId) {
    res.status(409).json({ error: "That code is already assigned to another funnel." });
    return;
  }

  const userId = req.session.userId ?? null;
  if (existing) {
    const [updated] = await db.update(campaignFunnelMatchCodesTable)
      .set({ code, updatedByUserId: userId, updatedAt: new Date() })
      .where(eq(campaignFunnelMatchCodesTable.id, existing.id))
      .returning({
        id: campaignFunnelMatchCodesTable.id,
        funnelTypeId: campaignFunnelMatchCodesTable.funnelTypeId,
        code: campaignFunnelMatchCodesTable.code,
      });
    res.json({ ...updated, funnelName: tenantFunnel.name });
    return;
  }

  const [saved] = await db.insert(campaignFunnelMatchCodesTable).values({
    funnelTypeId,
    code,
    createdByUserId: userId,
    updatedByUserId: userId,
  }).returning({
    id: campaignFunnelMatchCodesTable.id,
    funnelTypeId: campaignFunnelMatchCodesTable.funnelTypeId,
    code: campaignFunnelMatchCodesTable.code,
  });

  res.status(201).json({ ...saved, funnelName: tenantFunnel.name });
});

router.delete("/campaigns/meta-funnel-match-codes/:id", requireRole("super_admin", "agency_user", "client_admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid code id." });
    return;
  }

  const [existing] = await db.select({
    id: campaignFunnelMatchCodesTable.id,
    funnelTypeId: campaignFunnelMatchCodesTable.funnelTypeId,
  }).from(campaignFunnelMatchCodesTable)
    .where(eq(campaignFunnelMatchCodesTable.id, id))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Match code not found." });
    return;
  }

  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    const tenantId = req.session.tenantId ?? null;
    if (!tenantId) {
      res.status(403).json({ error: "No tenant assigned" });
      return;
    }
    const [tenantFunnel] = await db.select({ funnelTypeId: tenantFunnelTypesTable.funnelTypeId })
      .from(tenantFunnelTypesTable)
      .where(and(
        eq(tenantFunnelTypesTable.tenantId, tenantId),
        eq(tenantFunnelTypesTable.funnelTypeId, existing.funnelTypeId),
      ))
      .limit(1);
    if (!tenantFunnel) {
      res.status(404).json({ error: "Match code not found." });
      return;
    }
  }

  await db.delete(campaignFunnelMatchCodesTable)
    .where(eq(campaignFunnelMatchCodesTable.id, id));
  res.json({ success: true });
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

  const body = req.body as { funnelTypeId?: unknown; mappingLevel?: unknown; adSetExternalId?: unknown } | undefined;
  const rawFunnelTypeId = body?.funnelTypeId;
  const funnelTypeId = rawFunnelTypeId == null || rawFunnelTypeId === ""
    ? null
    : Number(rawFunnelTypeId);
  const adSetExternalId = typeof body?.adSetExternalId === "string" && body.adSetExternalId.trim()
    ? body.adSetExternalId.trim()
    : null;
  const mappingLevel = body?.mappingLevel === "ad_set" || adSetExternalId ? "ad_set" : "campaign";

  if (mappingLevel === "ad_set") {
    if (!adSetExternalId) {
      res.status(400).json({ error: "adSetExternalId is required for ad set mappings." });
      return;
    }
    const [adSet] = await db.select({
      externalId: metaAdSetsTable.externalId,
      campaignExternalId: metaAdSetsTable.campaignExternalId,
    })
      .from(metaAdSetsTable)
      .where(and(
        eq(metaAdSetsTable.tenantId, campaign.tenantId),
        eq(metaAdSetsTable.externalId, adSetExternalId),
      ))
      .limit(1);
    if (!adSet || adSet.campaignExternalId !== campaign.externalId) {
      res.status(404).json({ error: "Ad set not found for this campaign." });
      return;
    }
  }

  if (funnelTypeId == null) {
    await db.execute(sql`
      DELETE FROM campaign_funnel_mappings
      WHERE tenant_id = ${campaign.tenantId}
        AND campaign_id = ${campaignId}
        ${mappingLevel === "ad_set"
          ? sql`AND ad_set_external_id = ${adSetExternalId}`
          : sql`AND ad_set_external_id IS NULL`}
    `);
    res.json({ campaignId, adSetExternalId, mappingLevel, funnelTypeId: null, funnelName: null });
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
  if (mappingLevel === "ad_set") {
    await db.execute(sql`
      INSERT INTO campaign_funnel_mappings (
        tenant_id,
        campaign_id,
        ad_set_external_id,
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
        ${adSetExternalId},
        ${funnelTypeId},
        'manual',
        ${userId},
        ${userId},
        NOW(),
        NOW()
      )
      ON CONFLICT (tenant_id, campaign_id, ad_set_external_id) WHERE ad_set_external_id IS NOT NULL
      DO UPDATE SET
        funnel_type_id = EXCLUDED.funnel_type_id,
        mapping_source = 'manual',
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = NOW()
    `);
  } else {
    await db.execute(sql`
      INSERT INTO campaign_funnel_mappings (
        tenant_id,
        campaign_id,
        ad_set_external_id,
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
        NULL,
        ${funnelTypeId},
        'manual',
        ${userId},
        ${userId},
        NOW(),
        NOW()
      )
      ON CONFLICT (campaign_id) WHERE ad_set_external_id IS NULL
      DO UPDATE SET
        funnel_type_id = EXCLUDED.funnel_type_id,
        mapping_source = 'manual',
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = NOW()
    `);
  }

  res.json({
    campaignId,
    adSetExternalId,
    mappingLevel,
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
