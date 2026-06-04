import { Router, type IRouter } from "express";
import { db, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable, attributionEventsTable, tenantsTable } from "@workspace/db";
import { eq, and, gte, lte, count, sum, sql, inArray, SQL, desc } from "drizzle-orm";
import { requireRole, denyClientUser } from "../middleware/auth";
import { resolveListTenantScope } from "../lib/tenant-scope";

const router: IRouter = Router();

router.use("/dashboard", denyClientUser);

const jobDateExpr = sql`COALESCE(${jobsTable.invoiceDate}, ${jobsTable.completedAt}, ${jobsTable.createdAt})`;
const UNMATCHED_TIER = "unmatched";
const CHALLENGE_UNASSIGNED_FUNNEL = "Unassigned";

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

function parseRepeatedStrings(raw: unknown): string[] {
  const vals = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return [
    ...new Set(
      vals
        .flatMap((v) => String(v).split(","))
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

function parseChallengeDateRange(rawStart: unknown, rawEnd: unknown) {
  const now = new Date();
  const defaultEnd = now.toISOString().split("T")[0];
  const defaultStart = new Date(now.getTime() - 30 * 86400000).toISOString().split("T")[0];
  const startDate = typeof rawStart === "string" && rawStart ? rawStart : defaultStart;
  const endDate = typeof rawEnd === "string" && rawEnd ? rawEnd : defaultEnd;
  return {
    startDate,
    endDate,
    startBound: new Date(`${startDate}T00:00:00.000Z`),
    endBound: new Date(`${endDate}T23:59:59.999Z`),
  };
}

type ChallengeRollupRow = {
  row_type: "summary" | "funnel";
  funnel: string;
  unique_pulse_leads: string | number | null;
  appointments_booked: string | number | null;
  total_jobs: string | number | null;
  cancelled_jobs: string | number | null;
  completed_estimate_jobs: string | number | null;
  total_estimate_value: string | number | null;
  sold_closed_value: string | number | null;
  sold_jobs: string | number | null;
  all_unique_pulse_leads: string | number | null;
};

type ChallengeMetricRow = {
  funnel: string | null;
  costPerLead: number;
  metaLeads: number;
  uniquePulseLeads: number;
  appointmentsBooked: number;
  bookingRate: number;
  cancellationRate: number;
  cancelledJobs: number;
  totalJobs: number;
  totalEstimateValue: number;
  totalSoldClosedValue: number;
  roasPotential: number;
  roasSold: number;
  totalSpend: number;
  completedEstimateJobs: number;
  averageCostPerInHomeAppointment: number;
  soldJobs: number;
  costToAcquireCustomer: number;
  averageClosedJobValue: number;
};

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function buildChallengeMetricRow(
  row: ChallengeRollupRow,
  allocatedSpend: number,
  allocatedMetaLeads: number,
): ChallengeMetricRow {
  const uniquePulseLeads = toNumber(row.unique_pulse_leads);
  const appointmentsBooked = toNumber(row.appointments_booked);
  const totalJobs = toNumber(row.total_jobs);
  const cancelledJobs = toNumber(row.cancelled_jobs);
  const completedEstimateJobs = toNumber(row.completed_estimate_jobs);
  const totalEstimateValue = toNumber(row.total_estimate_value);
  const totalSoldClosedValue = toNumber(row.sold_closed_value);
  const soldJobs = toNumber(row.sold_jobs);

  return {
    funnel: row.row_type === "summary" ? null : row.funnel,
    costPerLead: allocatedMetaLeads > 0 ? round2(allocatedSpend / allocatedMetaLeads) : 0,
    metaLeads: round1(allocatedMetaLeads),
    uniquePulseLeads,
    appointmentsBooked,
    bookingRate: uniquePulseLeads > 0 ? round1((appointmentsBooked / uniquePulseLeads) * 100) : 0,
    cancellationRate: totalJobs > 0 ? round1((cancelledJobs / totalJobs) * 100) : 0,
    cancelledJobs,
    totalJobs,
    totalEstimateValue: round2(totalEstimateValue),
    totalSoldClosedValue: round2(totalSoldClosedValue),
    roasPotential: allocatedSpend > 0 ? round2(totalEstimateValue / allocatedSpend) : 0,
    roasSold: allocatedSpend > 0 ? round2(totalSoldClosedValue / allocatedSpend) : 0,
    totalSpend: round2(allocatedSpend),
    completedEstimateJobs,
    averageCostPerInHomeAppointment: completedEstimateJobs > 0 ? round2(allocatedSpend / completedEstimateJobs) : 0,
    soldJobs,
    costToAcquireCustomer: soldJobs > 0 ? round2(allocatedSpend / soldJobs) : 0,
    averageClosedJobValue: soldJobs > 0 ? round2(totalSoldClosedValue / soldJobs) : 0,
  };
}

export function buildChallengeDashboardResponse(input: {
  rows: ChallengeRollupRow[];
  totalSpend: number;
  metaLeads: number;
  funnels: string[];
  selectedFunnels: string[];
  startDate: string;
  endDate: string;
}) {
  const summaryRow = input.rows.find((row) => row.row_type === "summary") ?? {
    row_type: "summary" as const,
    funnel: "All funnels",
    unique_pulse_leads: 0,
    appointments_booked: 0,
    total_jobs: 0,
    cancelled_jobs: 0,
    completed_estimate_jobs: 0,
    total_estimate_value: 0,
    sold_closed_value: 0,
    sold_jobs: 0,
    all_unique_pulse_leads: 0,
  };

  const allUniquePulseLeads = toNumber(summaryRow.all_unique_pulse_leads);
  const selectedUniquePulseLeads = toNumber(summaryRow.unique_pulse_leads);
  const selectedShare = input.selectedFunnels.length > 0
    ? (allUniquePulseLeads > 0 ? selectedUniquePulseLeads / allUniquePulseLeads : 0)
    : 1;

  const summary = buildChallengeMetricRow(
    summaryRow,
    input.totalSpend * selectedShare,
    input.metaLeads * selectedShare,
  );

  const byFunnel = input.rows
    .filter((row) => row.row_type === "funnel")
    .map((row) => {
      const share = allUniquePulseLeads > 0 ? toNumber(row.unique_pulse_leads) / allUniquePulseLeads : 0;
      return buildChallengeMetricRow(row, input.totalSpend * share, input.metaLeads * share);
    })
    .sort((a, b) => b.totalEstimateValue - a.totalEstimateValue || (a.funnel ?? "").localeCompare(b.funnel ?? ""));

  return {
    dateRange: { startDate: input.startDate, endDate: input.endDate },
    selectedFunnels: input.selectedFunnels,
    funnels: input.funnels,
    summary,
    byFunnel,
    allocation: {
      method: "pulse_lead_share",
      allUniquePulseLeads,
      note: "Campaign spend and Meta-reported leads are stored by campaign/date, so selected and per-funnel views allocate them by each funnel's share of unique Pulse leads in the same lead-received window.",
    },
  };
}

export type AttributionMode = "attributed" | "unattributed" | "all";

function parseAttributionMode(raw: unknown): AttributionMode {
  if (raw === "unattributed" || raw === "all") return raw;
  return "attributed";
}

router.get("/dashboard/challenge", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const selectedFunnels = parseRepeatedStrings(req.query.funnel);
  const { startDate, endDate, startBound, endBound } = parseChallengeDateRange(req.query.startDate, req.query.endDate);

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

  const tenantLeadFilter = tenantId ? sql`AND l.tenant_id = ${tenantId}` : sql``;
  const tenantCampaignFilter = tenantId ? sql`AND c.tenant_id = ${tenantId}` : sql``;
  const selectedFunnelFilter = selectedFunnels.length > 0
    ? sql`AND alc.funnel IN (${sql.join(selectedFunnels.map(f => sql`${f}`), sql`, `)})`
    : sql``;

  const rollupResult = await db.execute(sql`
    WITH all_lead_cohort AS (
      SELECT
        l.id,
        l.tenant_id,
        COALESCE(ft.name, l.lead_type, ${CHALLENGE_UNASSIGNED_FUNNEL}) AS funnel,
        (
          l.tenant_id::text || ':' ||
          COALESCE(
            NULLIF(REGEXP_REPLACE(COALESCE(l.phone, ''), '[^0-9]', '', 'g'), ''),
            NULLIF(LOWER(TRIM(COALESCE(l.email, ''))), ''),
            l.id::text
          )
        ) AS unique_key,
        (
          l.status IN ('booked', 'sold')
          OR l.hub_status IN ('appt_set', 'appt_booked')
          OR l.booked_at IS NOT NULL
          OR l.has_sold_estimate = true
        ) AS booked
      FROM leads l
      LEFT JOIN funnel_types ft ON ft.id = l.funnel_id
      WHERE l.created_at >= ${startBound}
        AND l.created_at <= ${endBound}
        ${tenantLeadFilter}
    ),
    lead_cohort AS (
      SELECT *
      FROM all_lead_cohort alc
      WHERE true
        ${selectedFunnelFilter}
    ),
    all_lead_total AS (
      SELECT COUNT(DISTINCT unique_key)::int AS all_unique_pulse_leads
      FROM all_lead_cohort
    ),
    lead_by_funnel AS (
      SELECT
        funnel,
        COUNT(DISTINCT unique_key)::int AS unique_pulse_leads,
        COUNT(DISTINCT unique_key) FILTER (WHERE booked)::int AS appointments_booked
      FROM lead_cohort
      GROUP BY funnel
    ),
    lead_total AS (
      SELECT
        COUNT(DISTINCT unique_key)::int AS unique_pulse_leads,
        COUNT(DISTINCT unique_key) FILTER (WHERE booked)::int AS appointments_booked
      FROM lead_cohort
    ),
    jobs_by_funnel AS (
      SELECT
        lc.funnel,
        COUNT(DISTINCT j.id)::int AS total_jobs,
        COUNT(DISTINCT j.id) FILTER (WHERE j.status = 'cancelled')::int AS cancelled_jobs,
        COUNT(DISTINCT j.id) FILTER (WHERE j.status = 'completed' AND sej.id IS NOT NULL)::int AS completed_estimate_jobs
      FROM lead_cohort lc
      JOIN jobs j ON j.lead_id = lc.id AND j.tenant_id = lc.tenant_id
      LEFT JOIN sold_estimates sej ON sej.job_id = j.id AND sej.tenant_id = j.tenant_id
      GROUP BY lc.funnel
    ),
    jobs_total AS (
      SELECT
        COUNT(DISTINCT j.id)::int AS total_jobs,
        COUNT(DISTINCT j.id) FILTER (WHERE j.status = 'cancelled')::int AS cancelled_jobs,
        COUNT(DISTINCT j.id) FILTER (WHERE j.status = 'completed' AND sej.id IS NOT NULL)::int AS completed_estimate_jobs
      FROM lead_cohort lc
      JOIN jobs j ON j.lead_id = lc.id AND j.tenant_id = lc.tenant_id
      LEFT JOIN sold_estimates sej ON sej.job_id = j.id AND sej.tenant_id = j.tenant_id
    ),
    estimate_options AS (
      SELECT
        lc.funnel,
        lc.unique_key,
        COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount
      FROM lead_cohort lc
      JOIN sold_estimates se ON se.tenant_id = lc.tenant_id AND se.lead_id = lc.id
      WHERE COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0

      UNION ALL

      SELECT
        lc.funnel,
        lc.unique_key,
        COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount
      FROM lead_cohort lc
      JOIN jobs j ON j.lead_id = lc.id AND j.tenant_id = lc.tenant_id
      JOIN sold_estimates se ON se.tenant_id = lc.tenant_id AND se.job_id = j.id
      WHERE se.lead_id IS NULL
        AND COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
    ),
    estimate_per_lead AS (
      SELECT funnel, unique_key, AVG(amount) AS avg_estimate
      FROM estimate_options
      GROUP BY funnel, unique_key
    ),
    estimates_by_funnel AS (
      SELECT funnel, COALESCE(SUM(avg_estimate), 0)::numeric AS total_estimate_value
      FROM estimate_per_lead
      GROUP BY funnel
    ),
    estimates_total AS (
      SELECT COALESCE(SUM(avg_estimate), 0)::numeric AS total_estimate_value
      FROM (
        SELECT unique_key, AVG(amount) AS avg_estimate
        FROM estimate_options
        GROUP BY unique_key
      ) x
    ),
    sold_options AS (
      SELECT
        lc.funnel,
        COALESCE(se.job_id::text, 'estimate:' || se.id::text) AS sold_key,
        COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount
      FROM lead_cohort lc
      JOIN sold_estimates se ON se.tenant_id = lc.tenant_id AND se.lead_id = lc.id
      WHERE COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
        AND (se.estimate_status IS NULL OR TRIM(se.estimate_status) = '' OR LOWER(se.estimate_status) = 'sold')

      UNION ALL

      SELECT
        lc.funnel,
        COALESCE(se.job_id::text, 'estimate:' || se.id::text) AS sold_key,
        COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount
      FROM lead_cohort lc
      JOIN jobs j ON j.lead_id = lc.id AND j.tenant_id = lc.tenant_id
      JOIN sold_estimates se ON se.tenant_id = lc.tenant_id AND se.job_id = j.id
      WHERE se.lead_id IS NULL
        AND COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
        AND (se.estimate_status IS NULL OR TRIM(se.estimate_status) = '' OR LOWER(se.estimate_status) = 'sold')
    ),
    sold_per_job AS (
      SELECT funnel, sold_key, SUM(amount) AS sold_value
      FROM sold_options
      GROUP BY funnel, sold_key
    ),
    sold_by_funnel AS (
      SELECT
        funnel,
        COALESCE(SUM(sold_value), 0)::numeric AS sold_closed_value,
        COUNT(DISTINCT sold_key)::int AS sold_jobs
      FROM sold_per_job
      GROUP BY funnel
    ),
    sold_total AS (
      SELECT
        COALESCE(SUM(sold_value), 0)::numeric AS sold_closed_value,
        COUNT(DISTINCT sold_key)::int AS sold_jobs
      FROM (
        SELECT sold_key, SUM(amount) AS sold_value
        FROM sold_options
        GROUP BY sold_key
      ) x
    ),
    funnel_names AS (
      SELECT DISTINCT funnel
      FROM lead_cohort
    )
    SELECT
      'summary'::text AS row_type,
      'All funnels'::text AS funnel,
      lt.unique_pulse_leads,
      lt.appointments_booked,
      COALESCE(jt.total_jobs, 0)::int AS total_jobs,
      COALESCE(jt.cancelled_jobs, 0)::int AS cancelled_jobs,
      COALESCE(jt.completed_estimate_jobs, 0)::int AS completed_estimate_jobs,
      COALESCE(et.total_estimate_value, 0)::numeric AS total_estimate_value,
      COALESCE(st.sold_closed_value, 0)::numeric AS sold_closed_value,
      COALESCE(st.sold_jobs, 0)::int AS sold_jobs,
      alt.all_unique_pulse_leads
    FROM lead_total lt
    CROSS JOIN all_lead_total alt
    CROSS JOIN jobs_total jt
    CROSS JOIN estimates_total et
    CROSS JOIN sold_total st

    UNION ALL

    SELECT
      'funnel'::text AS row_type,
      fn.funnel,
      COALESCE(lbf.unique_pulse_leads, 0)::int AS unique_pulse_leads,
      COALESCE(lbf.appointments_booked, 0)::int AS appointments_booked,
      COALESCE(jbf.total_jobs, 0)::int AS total_jobs,
      COALESCE(jbf.cancelled_jobs, 0)::int AS cancelled_jobs,
      COALESCE(jbf.completed_estimate_jobs, 0)::int AS completed_estimate_jobs,
      COALESCE(ebf.total_estimate_value, 0)::numeric AS total_estimate_value,
      COALESCE(sbf.sold_closed_value, 0)::numeric AS sold_closed_value,
      COALESCE(sbf.sold_jobs, 0)::int AS sold_jobs,
      alt.all_unique_pulse_leads
    FROM funnel_names fn
    CROSS JOIN all_lead_total alt
    LEFT JOIN lead_by_funnel lbf ON lbf.funnel = fn.funnel
    LEFT JOIN jobs_by_funnel jbf ON jbf.funnel = fn.funnel
    LEFT JOIN estimates_by_funnel ebf ON ebf.funnel = fn.funnel
    LEFT JOIN sold_by_funnel sbf ON sbf.funnel = fn.funnel
    ORDER BY row_type DESC, total_estimate_value DESC, funnel ASC
  `);

  const adResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(cds.spend), 0)::numeric AS total_spend,
      COALESCE(SUM(cds.conversions) FILTER (WHERE c.platform = 'meta'), 0)::numeric AS meta_leads
    FROM campaign_daily_stats cds
    JOIN campaigns c ON c.id = cds.campaign_id
    WHERE cds.date >= ${startDate}
      AND cds.date <= ${endDate}
      ${tenantCampaignFilter}
  `);

  const funnelResult = await db.execute(sql`
    SELECT DISTINCT COALESCE(ft.name, l.lead_type, ${CHALLENGE_UNASSIGNED_FUNNEL}) AS funnel
    FROM leads l
    LEFT JOIN funnel_types ft ON ft.id = l.funnel_id
    WHERE l.created_at >= ${startBound}
      AND l.created_at <= ${endBound}
      ${tenantLeadFilter}
    ORDER BY funnel ASC
  `);

  const rows = ((rollupResult as unknown as { rows?: ChallengeRollupRow[] }).rows ?? []);
  const adRow = ((adResult as unknown as { rows?: Array<{ total_spend: string | number; meta_leads: string | number }> }).rows ?? [])[0];
  const funnels = (((funnelResult as unknown as { rows?: Array<{ funnel: string }> }).rows ?? [])
    .map(row => row.funnel)
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0));

  res.json(buildChallengeDashboardResponse({
    rows,
    totalSpend: toNumber(adRow?.total_spend),
    metaLeads: toNumber(adRow?.meta_leads),
    funnels,
    selectedFunnels,
    startDate,
    endDate,
  }));
});

// Attributed = paid-touch leads/jobs.
// - lead.source matches google / meta / facebook (case-insensitive), OR
// - lead.matchedGclid is not null, OR
// - job.matchLevel is any real attribution tier (anything except NULL/unmatched).
const leadAttributedExpr = sql`(
  ${leadsTable.source} ILIKE '%google%'
  OR ${leadsTable.source} ILIKE '%meta%'
  OR ${leadsTable.source} ILIKE '%facebook%'
  OR ${leadsTable.matchedGclid} IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM ${jobsTable} aj
    WHERE aj.lead_id = ${leadsTable.id}
      AND aj.tenant_id = ${leadsTable.tenantId}
      AND aj.match_level IS NOT NULL
      AND aj.match_level <> ${UNMATCHED_TIER}
  )
)`;
const jobAttributedExpr = sql`(${jobsTable.matchLevel} IS NOT NULL AND ${jobsTable.matchLevel} <> ${UNMATCHED_TIER})`;

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
    jobConditions.push(sql`(${jobsTable.matchLevel} IS NULL OR ${jobsTable.matchLevel} = ${UNMATCHED_TIER})`);
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
      matchedEvents: sql<number>`COUNT(*) FILTER (WHERE ${jobsTable.matchLevel} IS NOT NULL AND ${jobsTable.matchLevel} != ${UNMATCHED_TIER})`,
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
    jobConditions.push(sql`(${jobsTable.matchLevel} IS NULL OR ${jobsTable.matchLevel} = ${UNMATCHED_TIER})`);
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
