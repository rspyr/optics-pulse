import { Router, type IRouter } from "express";
import { db, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable, attributionEventsTable, tenantsTable } from "@workspace/db";
import { eq, and, gte, lte, count, sum, sql, inArray, SQL, desc } from "drizzle-orm";
import { requireRole, denyClientUser } from "../middleware/auth";
import { resolveListTenantScope } from "../lib/tenant-scope";
import {
  CHALLENGE_JOB_ATTRIBUTION_WINDOW_DAYS,
  CHALLENGE_JOB_LEAD_GRACE_DAYS,
} from "../services/challenge-job-attribution";

const router: IRouter = Router();

router.use("/dashboard", denyClientUser);

const jobDateExpr = sql`COALESCE(${jobsTable.invoiceDate}, ${jobsTable.completedAt}, ${jobsTable.createdAt})`;
const UNMATCHED_TIER = "unmatched";
const CHALLENGE_UNASSIGNED_FUNNEL = "Unassigned";
const CHALLENGE_WEIGHTED_LOOKBACK_DAYS = 730;
const CHALLENGE_WEIGHTED_HALF_LIFE_DAYS = 180;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

function challengeJobAttributionAtSql() {
  return sql`
    COALESCE(
      j.st_job_origin_at,
      j.completed_at,
      CASE WHEN j.status IN ('pending', 'in_progress') THEN j.created_at ELSE NULL END
    )
  `;
}

function challengeCancellationAtSql() {
  return sql`
    COALESCE(
      j.st_cancelled_at,
      CASE WHEN j.status = 'cancelled' THEN j.completed_at ELSE NULL END
    )
  `;
}

function challengeLeadWindowSql(attributionAt: SQL) {
  return sql`
    AND ${attributionAt} >= lc.created_at - (${CHALLENGE_JOB_LEAD_GRACE_DAYS}::int * INTERVAL '1 day')
    AND ${attributionAt} <= lc.created_at + (${CHALLENGE_JOB_ATTRIBUTION_WINDOW_DAYS}::int * INTERVAL '1 day')
  `;
}

function challengeJobAttributionWindowSql() {
  return challengeLeadWindowSql(challengeJobAttributionAtSql());
}

function challengeEstimateAttributionWindowSql() {
  const estimateAttributionAt = sql`
    COALESCE(
      ${challengeJobAttributionAtSql()},
      se.st_estimate_created_at,
      se.sold_on
    )
  `;

  return challengeLeadWindowSql(estimateAttributionAt);
}

function challengeWeightedLeadWindowSql(attributionAt: SQL) {
  return sql`
    AND ${attributionAt} >= lc.created_at - (${CHALLENGE_JOB_LEAD_GRACE_DAYS}::int * INTERVAL '1 day')
    AND ${attributionAt} <= lc.created_at + (${CHALLENGE_WEIGHTED_LOOKBACK_DAYS}::int * INTERVAL '1 day')
  `;
}

function challengeRecencyWeightSql(attributionAt: SQL) {
  return sql`
    EXP(
      -GREATEST(EXTRACT(EPOCH FROM (${attributionAt} - lc.created_at)) / 86400.0, 0)
      / ${CHALLENGE_WEIGHTED_HALF_LIFE_DAYS}
    )
  `;
}

function challengeLeadIdentitySql(alias: string) {
  return sql.raw(`(
    ${alias}.tenant_id::text || ':' ||
    COALESCE(
      NULLIF(REGEXP_REPLACE(COALESCE(${alias}.phone, ''), '[^0-9]', '', 'g'), ''),
      NULLIF(LOWER(TRIM(COALESCE(${alias}.email, ''))), ''),
      ${alias}.id::text
    )
  )`);
}

function challengeLeadIsMetaSql(alias: string) {
  return sql.raw(`(
    LOWER(COALESCE(NULLIF(${alias}.original_source, ''), ${alias}.source, '')) LIKE '%meta%'
    OR LOWER(COALESCE(NULLIF(${alias}.original_source, ''), ${alias}.source, '')) LIKE '%facebook%'
    OR LOWER(COALESCE(NULLIF(${alias}.original_source, ''), ${alias}.source, '')) LIKE '%instagram%'
    OR LOWER(COALESCE(NULLIF(${alias}.original_source, ''), ${alias}.source, '')) IN ('fb', 'ig')
  )`);
}

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

function parseRepeatedNumbers(raw: unknown): number[] {
  return parseRepeatedStrings(raw)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function parsePositiveInt(raw: unknown, fallback: number, max = 365): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
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
  meta_leads: string | number | null;
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

type ChallengeAdRow = {
  funnel: string | null;
  mapped: boolean | string | number | null;
  spend: string | number | null;
  meta_leads: string | number | null;
};

type ChallengeMetricRow = {
  funnel: string | null;
  activeDays: number;
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
  allocatedMetaLeads: number | null,
): ChallengeMetricRow {
  const metaLeads = allocatedMetaLeads == null ? toNumber(row.meta_leads) : allocatedMetaLeads;
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
    activeDays: 0,
    costPerLead: metaLeads > 0 ? round2(allocatedSpend / metaLeads) : 0,
    metaLeads: round1(metaLeads),
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
  adRows?: ChallengeAdRow[];
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
    meta_leads: 0,
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
  const adRows = input.adRows ?? [];
  const mappedByFunnel = new Map<string, { spend: number; metaLeads: number }>();
  let mappedSpend = 0;
  let mappedMetaLeads = 0;
  let unmappedSpend = 0;
  let unmappedMetaLeads = 0;

  for (const row of adRows) {
    const spend = toNumber(row.spend);
    const metaLeads = toNumber(row.meta_leads);
    const mapped = row.mapped === true || row.mapped === "true" || row.mapped === 1;
    if (mapped && row.funnel) {
      const existing = mappedByFunnel.get(row.funnel) ?? { spend: 0, metaLeads: 0 };
      existing.spend += spend;
      existing.metaLeads += metaLeads;
      mappedByFunnel.set(row.funnel, existing);
      mappedSpend += spend;
      mappedMetaLeads += metaLeads;
    } else {
      unmappedSpend += spend;
      unmappedMetaLeads += metaLeads;
    }
  }

  const hasCampaignMappings = mappedByFunnel.size > 0;
  const selectedMappedTotals = input.selectedFunnels.reduce((totals, funnel) => {
    const row = mappedByFunnel.get(funnel);
    if (!row) return totals;
    totals.spend += row.spend;
    totals.metaLeads += row.metaLeads;
    return totals;
  }, { spend: 0, metaLeads: 0 });
  const selectedSpend = hasCampaignMappings
    ? (input.selectedFunnels.length > 0 ? selectedMappedTotals.spend : mappedSpend)
    : input.totalSpend * selectedShare;
  const selectedMetaLeads = hasCampaignMappings
    ? (input.selectedFunnels.length > 0 ? selectedMappedTotals.metaLeads : mappedMetaLeads)
    : null;

  const summary = buildChallengeMetricRow(
    summaryRow,
    selectedSpend,
    selectedMetaLeads,
  );

  const byFunnel = input.rows
    .filter((row) => row.row_type === "funnel")
    .map((row) => {
      const share = allUniquePulseLeads > 0 ? toNumber(row.unique_pulse_leads) / allUniquePulseLeads : 0;
      const mapped = row.funnel ? mappedByFunnel.get(row.funnel) : null;
      return buildChallengeMetricRow(
        row,
        hasCampaignMappings ? (mapped?.spend ?? 0) : input.totalSpend * share,
        hasCampaignMappings ? (mapped?.metaLeads ?? 0) : null,
      );
    })
    .sort((a, b) => b.totalEstimateValue - a.totalEstimateValue || (a.funnel ?? "").localeCompare(b.funnel ?? ""));

  return {
    dateRange: { startDate: input.startDate, endDate: input.endDate },
    selectedFunnels: input.selectedFunnels,
    funnels: input.funnels,
    summary,
    byFunnel,
    allocation: {
      method: hasCampaignMappings ? "meta_campaign_adset_funnel_mapping" : "pulse_lead_share",
      allUniquePulseLeads,
      mappedSpend: round2(mappedSpend),
      mappedMetaLeads: round1(mappedMetaLeads),
      unmappedSpend: round2(unmappedSpend),
      unmappedMetaLeads: round1(unmappedMetaLeads),
      note: hasCampaignMappings
        ? "Per-funnel spend and Meta Leads use saved Meta campaign/ad-set funnel mappings. Any unmapped Meta spend is excluded until it is assigned."
        : "No Meta campaign/ad-set funnel map exists yet, so selected and per-funnel views allocate spend by each funnel's share of unique Pulse leads in the same lead-received window. Meta Leads count raw Meta-sourced lead submissions received in that window, while Pulse Leads are deduped.",
    },
  };
}

type ChallengeRunRule = "newest" | "oldest" | "best" | "average";
type ChallengeCompareMode = "client_funnels" | "funnel_clients";
type ChallengeViewMode = "funnel" | "impact";
type ChallengeAttributionModel = "strict" | "weighted";
type ChallengeBestBy =
  | "activeDays"
  | "costPerLead"
  | "metaLeads"
  | "uniquePulseLeads"
  | "appointmentsBooked"
  | "bookingRate"
  | "cancellationRate"
  | "totalEstimateValue"
  | "totalSoldClosedValue"
  | "roasPotential"
  | "roasSold"
  | "totalSpend"
  | "averageCostPerInHomeAppointment"
  | "costToAcquireCustomer"
  | "averageClosedJobValue";

const CHALLENGE_BEST_BY_KEYS = new Set<ChallengeBestBy>([
  "activeDays",
  "costPerLead",
  "metaLeads",
  "uniquePulseLeads",
  "appointmentsBooked",
  "bookingRate",
  "cancellationRate",
  "totalEstimateValue",
  "totalSoldClosedValue",
  "roasPotential",
  "roasSold",
  "totalSpend",
  "averageCostPerInHomeAppointment",
  "costToAcquireCustomer",
  "averageClosedJobValue",
]);
const LOWER_IS_BETTER = new Set<ChallengeBestBy>([
  "costPerLead",
  "cancellationRate",
  "averageCostPerInHomeAppointment",
  "costToAcquireCustomer",
]);
const CHALLENGE_RUNS_CACHE_TTL_MS = 45_000;
const CHALLENGE_RUNS_CACHE_MAX = 80;

const challengeRunsResponseCache = new Map<string, { body: unknown; expiresAt: number }>();
const challengeRunsInflight = new Map<string, Promise<unknown>>();

function getChallengeRunsCachedResponse(cacheKey: string): unknown | null {
  const cached = challengeRunsResponseCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    challengeRunsResponseCache.delete(cacheKey);
    return null;
  }
  return cached.body;
}

function setChallengeRunsCachedResponse(cacheKey: string, body: unknown) {
  challengeRunsResponseCache.set(cacheKey, {
    body,
    expiresAt: Date.now() + CHALLENGE_RUNS_CACHE_TTL_MS,
  });
  if (challengeRunsResponseCache.size <= CHALLENGE_RUNS_CACHE_MAX) return;
  const oldestKey = [...challengeRunsResponseCache.entries()]
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]?.[0];
  if (oldestKey) challengeRunsResponseCache.delete(oldestKey);
}

type ChallengeRunRawRow = {
  run_id: string | number;
  group_run_count: string | number | null;
  tenant_id: string | number;
  tenant_name: string;
  funnel_type_id: string | number;
  funnel_name: string;
  run_name: string;
  start_date: string;
  end_date: string | null;
  status: string;
  active_days: string | number | null;
  meta_leads: string | number | null;
  unique_pulse_leads: string | number | null;
  appointments_booked: string | number | null;
  total_jobs: string | number | null;
  cancelled_jobs: string | number | null;
  completed_estimate_jobs: string | number | null;
  total_estimate_value: string | number | null;
  sold_closed_value: string | number | null;
  sold_jobs: string | number | null;
  total_spend: string | number | null;
};

type ChallengeRunMetricRow = ChallengeMetricRow & {
  rowKey: string;
  rowLabel: string;
  tenantId: number;
  tenantName: string;
  funnelTypeId: number;
  funnelName: string;
  runId: number | null;
  runName: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  runCount: number;
  selectedRunIds: number[];
};

function parseChallengeRunRule(raw: unknown): ChallengeRunRule {
  if (raw === "oldest" || raw === "best" || raw === "average") return raw;
  return "newest";
}

function parseChallengeCompareMode(raw: unknown): ChallengeCompareMode {
  return raw === "funnel_clients" ? "funnel_clients" : "client_funnels";
}

function parseChallengeViewMode(raw: unknown): ChallengeViewMode {
  return raw === "impact" ? "impact" : "funnel";
}

function parseChallengeAttributionModel(raw: unknown): ChallengeAttributionModel {
  return raw === "weighted" ? "weighted" : "strict";
}

function parseChallengeBestBy(raw: unknown): ChallengeBestBy {
  return typeof raw === "string" && CHALLENGE_BEST_BY_KEYS.has(raw as ChallengeBestBy)
    ? raw as ChallengeBestBy
    : "roasSold";
}

function buildChallengeRunMetricRow(row: ChallengeRunRawRow): ChallengeRunMetricRow {
  const metaLeads = toNumber(row.meta_leads);
  const uniquePulseLeads = toNumber(row.unique_pulse_leads);
  const appointmentsBooked = toNumber(row.appointments_booked);
  const totalJobs = toNumber(row.total_jobs);
  const cancelledJobs = toNumber(row.cancelled_jobs);
  const completedEstimateJobs = toNumber(row.completed_estimate_jobs);
  const totalEstimateValue = toNumber(row.total_estimate_value);
  const totalSoldClosedValue = toNumber(row.sold_closed_value);
  const soldJobs = toNumber(row.sold_jobs);
  const totalSpend = toNumber(row.total_spend);
  const runId = Number(row.run_id);
  const tenantId = Number(row.tenant_id);
  const funnelTypeId = Number(row.funnel_type_id);

  return {
    rowKey: `run:${runId}`,
    rowLabel: row.funnel_name,
    funnel: row.funnel_name,
    tenantId,
    tenantName: row.tenant_name,
    funnelTypeId,
    funnelName: row.funnel_name,
    runId,
    runName: row.run_name,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    runCount: Math.max(1, toNumber(row.group_run_count)),
    selectedRunIds: [runId],
    activeDays: toNumber(row.active_days),
    costPerLead: metaLeads > 0 ? round2(totalSpend / metaLeads) : 0,
    metaLeads: round1(metaLeads),
    uniquePulseLeads,
    appointmentsBooked,
    bookingRate: uniquePulseLeads > 0 ? round1((appointmentsBooked / uniquePulseLeads) * 100) : 0,
    cancellationRate: totalJobs > 0 ? round1((cancelledJobs / totalJobs) * 100) : 0,
    cancelledJobs,
    totalJobs,
    totalEstimateValue: round2(totalEstimateValue),
    totalSoldClosedValue: round2(totalSoldClosedValue),
    roasPotential: totalSpend > 0 ? round2(totalEstimateValue / totalSpend) : 0,
    roasSold: totalSpend > 0 ? round2(totalSoldClosedValue / totalSpend) : 0,
    totalSpend: round2(totalSpend),
    completedEstimateJobs,
    averageCostPerInHomeAppointment: completedEstimateJobs > 0 ? round2(totalSpend / completedEstimateJobs) : 0,
    soldJobs,
    costToAcquireCustomer: soldJobs > 0 ? round2(totalSpend / soldJobs) : 0,
    averageClosedJobValue: soldJobs > 0 ? round2(totalSoldClosedValue / soldJobs) : 0,
  };
}

function averageChallengeRunRows(rows: ChallengeRunMetricRow[], mode: ChallengeCompareMode): ChallengeRunMetricRow {
  const first = rows[0];
  const divisor = Math.max(rows.length, 1);
  const avg = (key: keyof ChallengeMetricRow) => round2(rows.reduce((sum, row) => sum + toNumber(row[key]), 0) / divisor);
  return {
    ...first,
    rowKey: mode === "funnel_clients" ? `tenant:${first.tenantId}` : `funnel:${first.funnelTypeId}`,
    rowLabel: mode === "funnel_clients" ? first.tenantName : first.funnelName,
    funnel: mode === "funnel_clients" ? first.tenantName : first.funnelName,
    runId: null,
    runName: "Average run",
    startDate: null,
    endDate: null,
    status: null,
    runCount: rows.length,
    selectedRunIds: rows.flatMap((row) => row.selectedRunIds),
    activeDays: avg("activeDays"),
    costPerLead: avg("costPerLead"),
    metaLeads: avg("metaLeads"),
    uniquePulseLeads: avg("uniquePulseLeads"),
    appointmentsBooked: avg("appointmentsBooked"),
    bookingRate: avg("bookingRate"),
    cancellationRate: avg("cancellationRate"),
    cancelledJobs: avg("cancelledJobs"),
    totalJobs: avg("totalJobs"),
    totalEstimateValue: avg("totalEstimateValue"),
    totalSoldClosedValue: avg("totalSoldClosedValue"),
    roasPotential: avg("roasPotential"),
    roasSold: avg("roasSold"),
    totalSpend: avg("totalSpend"),
    completedEstimateJobs: avg("completedEstimateJobs"),
    averageCostPerInHomeAppointment: avg("averageCostPerInHomeAppointment"),
    soldJobs: avg("soldJobs"),
    costToAcquireCustomer: avg("costToAcquireCustomer"),
    averageClosedJobValue: avg("averageClosedJobValue"),
  };
}

function summarizeChallengeRunRows(rows: ChallengeRunMetricRow[]): ChallengeRunMetricRow {
  const base = rows[0] ?? {
    rowKey: "summary",
    rowLabel: "Selected comparison",
    funnel: null,
    tenantId: 0,
    tenantName: "Selected comparison",
    funnelTypeId: 0,
    funnelName: "Selected comparison",
    runId: null,
    runName: null,
    startDate: null,
    endDate: null,
    status: null,
    runCount: 0,
    selectedRunIds: [],
  };
  const metaLeads = rows.reduce((sum, row) => sum + row.metaLeads, 0);
  const uniquePulseLeads = rows.reduce((sum, row) => sum + row.uniquePulseLeads, 0);
  const appointmentsBooked = rows.reduce((sum, row) => sum + row.appointmentsBooked, 0);
  const totalJobs = rows.reduce((sum, row) => sum + row.totalJobs, 0);
  const cancelledJobs = rows.reduce((sum, row) => sum + row.cancelledJobs, 0);
  const completedEstimateJobs = rows.reduce((sum, row) => sum + row.completedEstimateJobs, 0);
  const totalEstimateValue = rows.reduce((sum, row) => sum + row.totalEstimateValue, 0);
  const totalSoldClosedValue = rows.reduce((sum, row) => sum + row.totalSoldClosedValue, 0);
  const totalSpend = rows.reduce((sum, row) => sum + row.totalSpend, 0);
  const soldJobs = rows.reduce((sum, row) => sum + row.soldJobs, 0);
  const activeDays = rows.length > 0
    ? round1(rows.reduce((sum, row) => sum + row.activeDays, 0) / rows.length)
    : 0;

  return {
    ...base,
    rowKey: "summary",
    rowLabel: "Selected comparison",
    funnel: null,
    tenantId: 0,
    tenantName: "Selected comparison",
    funnelTypeId: 0,
    funnelName: "Selected comparison",
    runId: null,
    runName: null,
    startDate: null,
    endDate: null,
    status: null,
    runCount: rows.reduce((sum, row) => sum + row.runCount, 0),
    selectedRunIds: rows.flatMap((row) => row.selectedRunIds),
    activeDays,
    costPerLead: metaLeads > 0 ? round2(totalSpend / metaLeads) : 0,
    metaLeads: round1(metaLeads),
    uniquePulseLeads,
    appointmentsBooked,
    bookingRate: uniquePulseLeads > 0 ? round1((appointmentsBooked / uniquePulseLeads) * 100) : 0,
    cancellationRate: totalJobs > 0 ? round1((cancelledJobs / totalJobs) * 100) : 0,
    cancelledJobs,
    totalJobs,
    totalEstimateValue: round2(totalEstimateValue),
    totalSoldClosedValue: round2(totalSoldClosedValue),
    roasPotential: totalSpend > 0 ? round2(totalEstimateValue / totalSpend) : 0,
    roasSold: totalSpend > 0 ? round2(totalSoldClosedValue / totalSpend) : 0,
    totalSpend: round2(totalSpend),
    completedEstimateJobs,
    averageCostPerInHomeAppointment: completedEstimateJobs > 0 ? round2(totalSpend / completedEstimateJobs) : 0,
    soldJobs,
    costToAcquireCustomer: soldJobs > 0 ? round2(totalSpend / soldJobs) : 0,
    averageClosedJobValue: soldJobs > 0 ? round2(totalSoldClosedValue / soldJobs) : 0,
  };
}

function selectChallengeRowsForComparison(
  runRows: ChallengeRunMetricRow[],
  mode: ChallengeCompareMode,
  runRule: ChallengeRunRule,
  bestBy: ChallengeBestBy,
): ChallengeRunMetricRow[] {
  const groups = new Map<string, ChallengeRunMetricRow[]>();
  for (const row of runRows) {
    const key = mode === "funnel_clients" ? String(row.tenantId) : String(row.funnelTypeId);
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  const selected: ChallengeRunMetricRow[] = [];
  for (const rows of groups.values()) {
    const sorted = [...rows].sort((a, b) => {
      const aStart = a.startDate ?? "";
      const bStart = b.startDate ?? "";
      return bStart.localeCompare(aStart) || (b.runId ?? 0) - (a.runId ?? 0);
    });
    const groupRunCount = Math.max(...sorted.map((item) => item.runCount), sorted.length);
    let row: ChallengeRunMetricRow;
    if (runRule === "average") {
      row = averageChallengeRunRows(sorted, mode);
    } else if (runRule === "oldest") {
      row = sorted[sorted.length - 1];
    } else if (runRule === "best") {
      row = [...sorted].sort((a, b) => {
        const av = toNumber(a[bestBy]);
        const bv = toNumber(b[bestBy]);
        if (LOWER_IS_BETTER.has(bestBy)) {
          const aScore = bestBy === "cancellationRate" ? (a.totalJobs > 0 ? av : Number.POSITIVE_INFINITY) : (av > 0 ? av : Number.POSITIVE_INFINITY);
          const bScore = bestBy === "cancellationRate" ? (b.totalJobs > 0 ? bv : Number.POSITIVE_INFINITY) : (bv > 0 ? bv : Number.POSITIVE_INFINITY);
          return aScore - bScore || (b.startDate ?? "").localeCompare(a.startDate ?? "");
        }
        return bv - av || (b.startDate ?? "").localeCompare(a.startDate ?? "");
      })[0];
    } else {
      row = sorted[0];
    }

    selected.push({
      ...row,
      rowKey: mode === "funnel_clients" ? `tenant:${row.tenantId}` : `funnel:${row.funnelTypeId}`,
      rowLabel: mode === "funnel_clients" ? row.tenantName : row.funnelName,
      funnel: mode === "funnel_clients" ? row.tenantName : row.funnelName,
      runCount: runRule === "average" ? row.runCount : groupRunCount,
    });
  }

  return selected.sort((a, b) =>
    b.totalEstimateValue - a.totalEstimateValue
    || b.totalSoldClosedValue - a.totalSoldClosedValue
    || a.rowLabel.localeCompare(b.rowLabel)
  );
}

function numberInSql(columnSql: SQL, values: number[]): SQL | null {
  if (values.length === 0) return null;
  return sql`${columnSql} IN (${sql.join(values.map((value) => sql`${value}`), sql`, `)})`;
}

function challengeStrictRunOutcomeCtes() {
  return sql`
      jobs_by_run AS (
        SELECT
          lc.run_id,
          COUNT(DISTINCT j.id)::int AS total_jobs,
          COUNT(DISTINCT j.id) FILTER (WHERE j.status = 'cancelled')::int AS cancelled_jobs,
          COUNT(DISTINCT j.id) FILTER (WHERE j.status = 'completed' AND sej.id IS NOT NULL)::int AS completed_estimate_jobs
        FROM lead_cohort lc
        JOIN jobs j ON j.lead_id = lc.id AND j.tenant_id = lc.tenant_id
          ${challengeJobAttributionWindowSql()}
        LEFT JOIN sold_estimates sej ON sej.job_id = j.id AND sej.tenant_id = j.tenant_id
        GROUP BY lc.run_id
      ),
      estimate_options AS (
        SELECT
          lc.run_id,
          lc.unique_key,
          COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount
        FROM lead_cohort lc
        JOIN sold_estimates se ON se.tenant_id = lc.tenant_id AND se.lead_id = lc.id
        LEFT JOIN jobs j ON j.id = se.job_id AND j.tenant_id = se.tenant_id
        WHERE COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
          ${challengeEstimateAttributionWindowSql()}

        UNION ALL

        SELECT
          lc.run_id,
          lc.unique_key,
          COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount
        FROM lead_cohort lc
        JOIN jobs j ON j.lead_id = lc.id AND j.tenant_id = lc.tenant_id
        JOIN sold_estimates se ON se.tenant_id = lc.tenant_id AND se.job_id = j.id
        WHERE se.lead_id IS NULL
          AND COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
          ${challengeEstimateAttributionWindowSql()}
      ),
      estimate_per_lead AS (
        SELECT run_id, unique_key, AVG(amount) AS avg_estimate
        FROM estimate_options
        GROUP BY run_id, unique_key
      ),
      estimates_by_run AS (
        SELECT run_id, COALESCE(SUM(avg_estimate), 0)::numeric AS total_estimate_value
        FROM estimate_per_lead
        GROUP BY run_id
      ),
      sold_options AS (
        SELECT
          lc.run_id,
          COALESCE(se.job_id::text, 'estimate:' || se.id::text) AS sold_key,
          COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount
        FROM lead_cohort lc
        JOIN sold_estimates se ON se.tenant_id = lc.tenant_id AND se.lead_id = lc.id
        LEFT JOIN jobs j ON j.id = se.job_id AND j.tenant_id = se.tenant_id
        WHERE COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
          AND (se.estimate_status IS NULL OR TRIM(se.estimate_status) = '' OR LOWER(se.estimate_status) = 'sold')
          ${challengeEstimateAttributionWindowSql()}

        UNION ALL

        SELECT
          lc.run_id,
          COALESCE(se.job_id::text, 'estimate:' || se.id::text) AS sold_key,
          COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount
        FROM lead_cohort lc
        JOIN jobs j ON j.lead_id = lc.id AND j.tenant_id = lc.tenant_id
        JOIN sold_estimates se ON se.tenant_id = lc.tenant_id AND se.job_id = j.id
        WHERE se.lead_id IS NULL
          AND COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
          AND (se.estimate_status IS NULL OR TRIM(se.estimate_status) = '' OR LOWER(se.estimate_status) = 'sold')
          ${challengeEstimateAttributionWindowSql()}
      ),
      sold_per_job AS (
        SELECT run_id, sold_key, SUM(amount) AS sold_value
        FROM sold_options
        GROUP BY run_id, sold_key
      ),
      sold_by_run AS (
        SELECT
          run_id,
          COALESCE(SUM(sold_value), 0)::numeric AS sold_closed_value,
          COUNT(DISTINCT sold_key)::int AS sold_jobs
        FROM sold_per_job
        GROUP BY run_id
      )`;
}

function challengeWeightedRunOutcomeCtes() {
  const jobAttributionAt = challengeJobAttributionAtSql();
  const estimateAttributionAt = sql`
    COALESCE(
      ${challengeJobAttributionAtSql()},
      se.st_estimate_created_at,
      se.sold_on
    )
  `;

  return sql`
      job_weight_candidates AS (
        SELECT run_id, job_id, status, has_completed_estimate, raw_weight
        FROM (
          SELECT
            lc.run_id,
            j.id AS job_id,
            j.status,
            (j.status = 'completed' AND EXISTS (
              SELECT 1 FROM sold_estimates sej
              WHERE sej.job_id = j.id AND sej.tenant_id = j.tenant_id
            )) AS has_completed_estimate,
            ${challengeRecencyWeightSql(jobAttributionAt)} AS raw_weight,
            ROW_NUMBER() OVER (PARTITION BY lc.run_id, j.id ORDER BY lc.created_at DESC, lc.id DESC)::int AS run_candidate_rank
          FROM lead_cohort lc
          JOIN jobs j ON j.tenant_id = lc.tenant_id
          JOIN leads event_lead ON event_lead.id = j.lead_id AND event_lead.tenant_id = j.tenant_id
          WHERE ${jobAttributionAt} IS NOT NULL
            AND ${challengeLeadIdentitySql("event_lead")} = lc.unique_key
            ${challengeWeightedLeadWindowSql(jobAttributionAt)}
        ) ranked
        WHERE run_candidate_rank = 1
      ),
      job_weights AS (
        SELECT
          run_id,
          job_id,
          status,
          has_completed_estimate,
          raw_weight / NULLIF(SUM(raw_weight) OVER (PARTITION BY job_id), 0) AS weight
        FROM job_weight_candidates
      ),
      jobs_by_run AS (
        SELECT
          run_id,
          COALESCE(SUM(weight), 0)::numeric AS total_jobs,
          COALESCE(SUM(weight) FILTER (WHERE status = 'cancelled'), 0)::numeric AS cancelled_jobs,
          COALESCE(SUM(weight) FILTER (WHERE has_completed_estimate), 0)::numeric AS completed_estimate_jobs
        FROM job_weights
        GROUP BY run_id
      ),
      estimate_events AS (
        SELECT
          se.id AS estimate_id,
          se.tenant_id,
          ${challengeLeadIdentitySql("event_lead")} AS event_unique_key,
          COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount,
          ${estimateAttributionAt} AS event_at
        FROM sold_estimates se
        LEFT JOIN jobs j ON j.id = se.job_id AND j.tenant_id = se.tenant_id
        JOIN leads event_lead ON event_lead.id = COALESCE(se.lead_id, j.lead_id) AND event_lead.tenant_id = se.tenant_id
        WHERE COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
      ),
      estimate_weight_candidates AS (
        SELECT run_id, unique_key, estimate_id, amount, raw_weight
        FROM (
          SELECT
            lc.run_id,
            lc.unique_key,
            ee.estimate_id,
            ee.amount,
            ${challengeRecencyWeightSql(sql`ee.event_at`)} AS raw_weight,
            ROW_NUMBER() OVER (PARTITION BY lc.run_id, ee.estimate_id ORDER BY lc.created_at DESC, lc.id DESC)::int AS run_candidate_rank
          FROM estimate_events ee
          JOIN lead_cohort lc ON lc.tenant_id = ee.tenant_id AND lc.unique_key = ee.event_unique_key
          WHERE ee.event_at IS NOT NULL
            ${challengeWeightedLeadWindowSql(sql`ee.event_at`)}
        ) ranked
        WHERE run_candidate_rank = 1
      ),
      estimate_weights AS (
        SELECT
          run_id,
          unique_key,
          estimate_id,
          amount,
          raw_weight / NULLIF(SUM(raw_weight) OVER (PARTITION BY estimate_id), 0) AS weight
        FROM estimate_weight_candidates
      ),
      estimate_per_lead AS (
        SELECT run_id, unique_key, AVG(amount * weight) AS avg_estimate
        FROM estimate_weights
        GROUP BY run_id, unique_key
      ),
      estimates_by_run AS (
        SELECT run_id, COALESCE(SUM(avg_estimate), 0)::numeric AS total_estimate_value
        FROM estimate_per_lead
        GROUP BY run_id
      ),
      sold_events AS (
        SELECT
          sold_key,
          tenant_id,
          event_unique_key,
          MIN(event_at) AS event_at,
          SUM(amount) AS amount
        FROM (
          SELECT
            COALESCE(se.job_id::text, 'estimate:' || se.id::text) AS sold_key,
            se.tenant_id,
            ${challengeLeadIdentitySql("event_lead")} AS event_unique_key,
            COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount,
            ${estimateAttributionAt} AS event_at
          FROM sold_estimates se
          LEFT JOIN jobs j ON j.id = se.job_id AND j.tenant_id = se.tenant_id
          JOIN leads event_lead ON event_lead.id = COALESCE(se.lead_id, j.lead_id) AND event_lead.tenant_id = se.tenant_id
          WHERE COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
            AND (se.estimate_status IS NULL OR TRIM(se.estimate_status) = '' OR LOWER(se.estimate_status) = 'sold')
        ) x
        WHERE event_at IS NOT NULL
        GROUP BY sold_key, tenant_id, event_unique_key
      ),
      sold_weight_candidates AS (
        SELECT run_id, tenant_id, sold_key, amount, raw_weight
        FROM (
          SELECT
            lc.run_id,
            se.tenant_id,
            se.sold_key,
            se.amount,
            ${challengeRecencyWeightSql(sql`se.event_at`)} AS raw_weight,
            ROW_NUMBER() OVER (PARTITION BY lc.run_id, se.tenant_id, se.sold_key ORDER BY lc.created_at DESC, lc.id DESC)::int AS run_candidate_rank
          FROM sold_events se
          JOIN lead_cohort lc ON lc.tenant_id = se.tenant_id AND lc.unique_key = se.event_unique_key
          WHERE se.event_at IS NOT NULL
            ${challengeWeightedLeadWindowSql(sql`se.event_at`)}
        ) ranked
        WHERE run_candidate_rank = 1
      ),
      sold_weights AS (
        SELECT
          run_id,
          tenant_id,
          sold_key,
          amount,
          raw_weight / NULLIF(SUM(raw_weight) OVER (PARTITION BY tenant_id, sold_key), 0) AS weight
        FROM sold_weight_candidates
      ),
      sold_by_run AS (
        SELECT
          run_id,
          COALESCE(SUM(amount * weight), 0)::numeric AS sold_closed_value,
          COALESCE(SUM(weight), 0)::numeric AS sold_jobs
        FROM sold_weights
        GROUP BY run_id
      )`;
}

function challengeRunOutcomeCtes(attributionModel: ChallengeAttributionModel) {
  return attributionModel === "weighted"
    ? challengeWeightedRunOutcomeCtes()
    : challengeStrictRunOutcomeCtes();
}

router.get("/dashboard/challenge/runs", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const selectedClientTenantIds = parseRepeatedNumbers(req.query.clientTenantId);
  const selectedFunnelTypeIds = parseRepeatedNumbers(req.query.funnelTypeId);
  const selectedRunIds = parseRepeatedNumbers(req.query.runId);
  const viewMode = parseChallengeViewMode(req.query.viewMode);
  const attributionModel = parseChallengeAttributionModel(req.query.attributionModel);
  const mode = parseChallengeCompareMode(req.query.mode);
  const runRule = parseChallengeRunRule(req.query.runRule);
  const bestBy = parseChallengeBestBy(req.query.bestBy);
  const dayStart = parsePositiveInt(req.query.dayStart, 1);
  const dayEnd = Math.max(dayStart, parsePositiveInt(req.query.dayEnd, 30));
  const {
    startDate: impactStartDate,
    endDate: impactEndDate,
    startBound: impactStartBound,
    endBound: impactEndBound,
  } = parseChallengeDateRange(req.query.startDate, req.query.endDate);

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  const tenantId = scope.tenantId;
  const cacheKey = JSON.stringify({
    role: req.session.userRole ?? null,
    sessionTenantId: req.session.tenantId ?? null,
    scopedTenantId: tenantId ?? null,
    viewMode,
    attributionModel,
    mode,
    runRule,
    bestBy,
    dayStart,
    dayEnd,
    impactStartDate: viewMode === "impact" ? impactStartDate : null,
    impactEndDate: viewMode === "impact" ? impactEndDate : null,
    selectedClientTenantIds: [...selectedClientTenantIds].sort((a, b) => a - b),
    selectedFunnelTypeIds: [...selectedFunnelTypeIds].sort((a, b) => a - b),
    selectedRunIds: [...selectedRunIds].sort((a, b) => a - b),
  });
  const cached = getChallengeRunsCachedResponse(cacheKey);
  if (cached) {
    res.setHeader("X-Optics-Cache", "hit");
    res.json(cached);
    return;
  }

  const existingRequest = challengeRunsInflight.get(cacheKey);
  if (existingRequest) {
    const body = await existingRequest;
    res.setHeader("X-Optics-Cache", "deduped");
    res.json(body);
    return;
  }

  const responsePromise = (async () => {
    const scopeConditions: SQL[] = [sql`fr.status <> 'archived'`];
    if (tenantId) scopeConditions.push(sql`fr.tenant_id = ${tenantId}`);
    const scopedWhereClause = sql`WHERE ${sql.join(scopeConditions, sql` AND `)}`;

    const runConditions: SQL[] = [...scopeConditions];
    const clientFilter = numberInSql(sql`fr.tenant_id`, selectedClientTenantIds);
    const funnelFilter = numberInSql(sql`fr.funnel_type_id`, selectedFunnelTypeIds);
    const runFilter = numberInSql(sql`fr.id`, selectedRunIds);
    if (clientFilter) runConditions.push(clientFilter);
    if (funnelFilter) runConditions.push(funnelFilter);
    if (runFilter) runConditions.push(runFilter);
    const runWhereClause = sql`WHERE ${sql.join(runConditions, sql` AND `)}`;
    const startOffset = dayStart - 1;
    const endOffset = dayEnd - 1;
    const groupPartition = mode === "funnel_clients" ? sql`fr.tenant_id` : sql`fr.funnel_type_id`;
    const runRankOrder = runRule === "oldest"
      ? sql`start_date ASC, run_id ASC`
      : sql`start_date DESC, run_id DESC`;
    const runRankFilter = runRule === "newest" || runRule === "oldest"
      ? sql`AND run_rank = 1`
      : sql``;

    if (viewMode === "impact") {
      const selectedTenantFilter = !tenantId && selectedClientTenantIds.length > 0
        ? numberInSql(sql`l.tenant_id`, selectedClientTenantIds)
        : null;
      const selectedCampaignTenantFilter = !tenantId && selectedClientTenantIds.length > 0
        ? numberInSql(sql`c.tenant_id`, selectedClientTenantIds)
        : null;
      const impactLeadTenantFilter = tenantId
        ? sql`AND l.tenant_id = ${tenantId}`
        : selectedTenantFilter
          ? sql`AND ${selectedTenantFilter}`
          : sql``;
      const impactCampaignTenantFilter = tenantId
        ? sql`AND c.tenant_id = ${tenantId}`
        : selectedCampaignTenantFilter
          ? sql`AND ${selectedCampaignTenantFilter}`
          : sql``;

      const [clientsResult, funnelsResult, timelineResult, metricsResult] = await Promise.all([
        db.execute(sql`
          SELECT
            t.id,
            t.name,
            COUNT(fr.id)::int AS "runCount"
          FROM funnel_runs fr
          JOIN tenants t ON t.id = fr.tenant_id
          ${scopedWhereClause}
          GROUP BY t.id, t.name
          ORDER BY t.name ASC
        `),
        db.execute(sql`
          SELECT
            ft.id,
            ft.name,
            COUNT(fr.id)::int AS "runCount"
          FROM funnel_runs fr
          JOIN funnel_types ft ON ft.id = fr.funnel_type_id
          ${scopedWhereClause}
          GROUP BY ft.id, ft.name
          ORDER BY ft.name ASC
        `),
        db.execute(sql`
          SELECT
            fr.id,
            fr.tenant_id AS "tenantId",
            t.name AS "tenantName",
            fr.funnel_type_id AS "funnelTypeId",
            ft.name AS "funnelName",
            fr.name,
            fr.start_date AS "startDate",
            fr.end_date AS "endDate",
            fr.status,
            GREATEST(1, (COALESCE(fr.end_date, CURRENT_DATE) - fr.start_date + 1))::int AS "activeDays"
          FROM funnel_runs fr
          JOIN tenants t ON t.id = fr.tenant_id
          JOIN funnel_types ft ON ft.id = fr.funnel_type_id
          ${runWhereClause}
          ORDER BY fr.start_date DESC, fr.id DESC
        `),
        db.execute(sql`
          WITH lead_identity AS (
            SELECT
              l.id,
              l.tenant_id,
              l.created_at,
              ${challengeLeadIdentitySql("l")} AS unique_key,
              (
                l.status IN ('booked', 'sold')
                OR l.hub_status IN ('appt_set', 'appt_booked')
                OR l.booked_at IS NOT NULL
                OR l.has_sold_estimate = true
              ) AS booked,
              ${challengeLeadIsMetaSql("l")} AS is_meta_lead
            FROM leads l
            WHERE TRUE
              ${impactLeadTenantFilter}
          ),
          meta_touch_keys AS (
            SELECT tenant_id, unique_key, MIN(created_at) AS first_meta_at
            FROM lead_identity
            WHERE is_meta_lead
            GROUP BY tenant_id, unique_key
          ),
          meta_leads_window AS (
            SELECT
              COUNT(*)::numeric AS meta_leads,
              COUNT(DISTINCT unique_key)::numeric AS unique_pulse_leads,
              COUNT(DISTINCT unique_key) FILTER (WHERE booked)::numeric AS appointments_booked
            FROM lead_identity
            WHERE is_meta_lead
              AND created_at >= ${impactStartBound}
              AND created_at <= ${impactEndBound}
          ),
          job_events_base AS (
            SELECT
              j.id,
              j.tenant_id,
              el.unique_key,
              ${challengeJobAttributionAtSql()} AS booked_at,
              j.completed_at,
              ${challengeCancellationAtSql()} AS cancelled_at,
              j.status,
              EXISTS (
                SELECT 1 FROM sold_estimates sej
                WHERE sej.job_id = j.id AND sej.tenant_id = j.tenant_id
              ) AS has_estimate
            FROM jobs j
            JOIN lead_identity el ON el.id = j.lead_id AND el.tenant_id = j.tenant_id
          ),
          job_events AS (
            SELECT jeb.*
            FROM job_events_base jeb
            JOIN meta_touch_keys mt
              ON mt.tenant_id = jeb.tenant_id
              AND mt.unique_key = jeb.unique_key
              AND mt.first_meta_at <= GREATEST(
                COALESCE(jeb.booked_at, '-infinity'::timestamp),
                COALESCE(jeb.completed_at, '-infinity'::timestamp),
                COALESCE(jeb.cancelled_at, '-infinity'::timestamp)
              )
          ),
          jobs_window AS (
            SELECT
              COUNT(DISTINCT id) FILTER (
                WHERE (booked_at >= ${impactStartBound} AND booked_at <= ${impactEndBound})
                  OR (completed_at >= ${impactStartBound} AND completed_at <= ${impactEndBound})
                  OR (cancelled_at >= ${impactStartBound} AND cancelled_at <= ${impactEndBound})
              )::numeric AS total_jobs,
              COUNT(DISTINCT id) FILTER (
                WHERE cancelled_at >= ${impactStartBound} AND cancelled_at <= ${impactEndBound}
              )::numeric AS cancelled_jobs,
              COUNT(DISTINCT id) FILTER (
                WHERE status = 'completed'
                  AND has_estimate
                  AND completed_at >= ${impactStartBound}
                  AND completed_at <= ${impactEndBound}
              )::numeric AS completed_estimate_jobs
            FROM job_events
          ),
          estimate_events AS (
            SELECT
              COALESCE(se.job_id::text, 'lead:' || se.lead_id::text, 'estimate:' || se.id::text) AS estimate_group_key,
              se.id AS estimate_id,
              se.tenant_id,
              el.unique_key,
              COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount,
              COALESCE(se.st_estimate_created_at, ${challengeJobAttributionAtSql()}, se.sold_on) AS estimate_at
            FROM sold_estimates se
            LEFT JOIN jobs j ON j.id = se.job_id AND j.tenant_id = se.tenant_id
            JOIN lead_identity el ON el.id = COALESCE(se.lead_id, j.lead_id) AND el.tenant_id = se.tenant_id
            WHERE COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
          ),
          meta_estimate_events AS (
            SELECT ee.*
            FROM estimate_events ee
            JOIN meta_touch_keys mt
              ON mt.tenant_id = ee.tenant_id
              AND mt.unique_key = ee.unique_key
              AND mt.first_meta_at <= ee.estimate_at
            WHERE ee.estimate_at >= ${impactStartBound}
              AND ee.estimate_at <= ${impactEndBound}
          ),
          estimate_per_opportunity AS (
            SELECT estimate_group_key, AVG(amount) AS avg_estimate
            FROM meta_estimate_events
            GROUP BY estimate_group_key
          ),
          estimates_total AS (
            SELECT COALESCE(SUM(avg_estimate), 0)::numeric AS total_estimate_value
            FROM estimate_per_opportunity
          ),
          sold_events AS (
            SELECT
              sold_key,
              tenant_id,
              unique_key,
              MIN(sold_at) AS sold_at,
              SUM(amount) AS sold_value
            FROM (
              SELECT
                COALESCE(se.job_id::text, 'estimate:' || se.id::text) AS sold_key,
                se.tenant_id,
                el.unique_key,
                COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount,
                COALESCE(se.sold_on, se.st_estimate_created_at, ${challengeJobAttributionAtSql()}) AS sold_at
              FROM sold_estimates se
              LEFT JOIN jobs j ON j.id = se.job_id AND j.tenant_id = se.tenant_id
              JOIN lead_identity el ON el.id = COALESCE(se.lead_id, j.lead_id) AND el.tenant_id = se.tenant_id
              WHERE COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
                AND (se.estimate_status IS NULL OR TRIM(se.estimate_status) = '' OR LOWER(se.estimate_status) = 'sold')
            ) x
            WHERE sold_at IS NOT NULL
            GROUP BY sold_key, tenant_id, unique_key
          ),
          meta_sold_events AS (
            SELECT se.*
            FROM sold_events se
            JOIN meta_touch_keys mt
              ON mt.tenant_id = se.tenant_id
              AND mt.unique_key = se.unique_key
              AND mt.first_meta_at <= se.sold_at
            WHERE se.sold_at >= ${impactStartBound}
              AND se.sold_at <= ${impactEndBound}
          ),
          sold_total AS (
            SELECT
              COALESCE(SUM(sold_value), 0)::numeric AS sold_closed_value,
              COUNT(DISTINCT sold_key)::numeric AS sold_jobs
            FROM meta_sold_events
          ),
          spend_total AS (
            SELECT
              COALESCE(SUM(cds.spend), 0)::numeric AS total_spend
            FROM campaign_daily_stats cds
            JOIN campaigns c ON c.id = cds.campaign_id
            WHERE c.platform = 'meta'
              AND cds.date >= ${impactStartDate}
              AND cds.date <= ${impactEndDate}
              ${impactCampaignTenantFilter}
          ),
          activity_days AS (
            SELECT created_at::date AS activity_day
            FROM lead_identity
            WHERE is_meta_lead
              AND created_at >= ${impactStartBound}
              AND created_at <= ${impactEndBound}

            UNION

            SELECT cds.date AS activity_day
            FROM campaign_daily_stats cds
            JOIN campaigns c ON c.id = cds.campaign_id
            WHERE c.platform = 'meta'
              AND cds.date >= ${impactStartDate}
              AND cds.date <= ${impactEndDate}
              ${impactCampaignTenantFilter}
              AND COALESCE(cds.spend, 0) > 0

            UNION

            SELECT booked_at::date FROM job_events
            WHERE booked_at >= ${impactStartBound} AND booked_at <= ${impactEndBound}

            UNION

            SELECT completed_at::date FROM job_events
            WHERE completed_at >= ${impactStartBound} AND completed_at <= ${impactEndBound}

            UNION

            SELECT cancelled_at::date FROM job_events
            WHERE cancelled_at >= ${impactStartBound} AND cancelled_at <= ${impactEndBound}

            UNION

            SELECT estimate_at::date FROM meta_estimate_events

            UNION

            SELECT sold_at::date FROM meta_sold_events
          ),
          active_days AS (
            SELECT COUNT(DISTINCT activity_day)::numeric AS active_days
            FROM activity_days
            WHERE activity_day IS NOT NULL
          )
          SELECT
            0 AS run_id,
            1 AS group_run_count,
            0 AS tenant_id,
            'Meta channel'::text AS tenant_name,
            0 AS funnel_type_id,
            'Meta Impact'::text AS funnel_name,
            ${`Impact since ${impactStartDate}`}::text AS run_name,
            ${impactStartDate}::date AS start_date,
            ${impactEndDate}::date AS end_date,
            'active'::text AS status,
            COALESCE(ad.active_days, 0)::numeric AS active_days,
            COALESCE(mlw.meta_leads, 0)::numeric AS meta_leads,
            COALESCE(mlw.unique_pulse_leads, 0)::numeric AS unique_pulse_leads,
            COALESCE(mlw.appointments_booked, 0)::numeric AS appointments_booked,
            COALESCE(jw.total_jobs, 0)::numeric AS total_jobs,
            COALESCE(jw.cancelled_jobs, 0)::numeric AS cancelled_jobs,
            COALESCE(jw.completed_estimate_jobs, 0)::numeric AS completed_estimate_jobs,
            COALESCE(et.total_estimate_value, 0)::numeric AS total_estimate_value,
            COALESCE(st.sold_closed_value, 0)::numeric AS sold_closed_value,
            COALESCE(st.sold_jobs, 0)::numeric AS sold_jobs,
            COALESCE(sp.total_spend, 0)::numeric AS total_spend
          FROM meta_leads_window mlw
          CROSS JOIN jobs_window jw
          CROSS JOIN estimates_total et
          CROSS JOIN sold_total st
          CROSS JOIN spend_total sp
          CROSS JOIN active_days ad
        `),
      ]);

      const availableClients = ((clientsResult as unknown as { rows?: Array<{ id: number; name: string; runCount: number }> }).rows ?? [])
        .map((row) => ({ id: Number(row.id), name: row.name, runCount: Number(row.runCount ?? 0) }));
      const availableFunnels = ((funnelsResult as unknown as { rows?: Array<{ id: number; name: string; runCount: number }> }).rows ?? [])
        .map((row) => ({ id: Number(row.id), name: row.name, runCount: Number(row.runCount ?? 0) }));
      const timelineRows = ((timelineResult as unknown as { rows?: Array<{
        id: number;
        tenantId: number;
        tenantName: string;
        funnelTypeId: number;
        funnelName: string;
        name: string;
        startDate: string;
        endDate: string | null;
        status: string;
        activeDays: number;
      }> }).rows ?? []);
      const metricRows = ((metricsResult as unknown as { rows?: ChallengeRunRawRow[] }).rows ?? []);
      const impactRow = buildChallengeRunMetricRow(metricRows[0] ?? {
        run_id: 0,
        group_run_count: 1,
        tenant_id: 0,
        tenant_name: "Meta channel",
        funnel_type_id: 0,
        funnel_name: "Meta Impact",
        run_name: "Impact",
        start_date: impactStartDate,
        end_date: impactEndDate,
        status: "active",
        active_days: 0,
        meta_leads: 0,
        unique_pulse_leads: 0,
        appointments_booked: 0,
        total_jobs: 0,
        cancelled_jobs: 0,
        completed_estimate_jobs: 0,
        total_estimate_value: 0,
        sold_closed_value: 0,
        sold_jobs: 0,
        total_spend: 0,
      });
      const row = {
        ...impactRow,
        rowKey: "impact:meta",
        rowLabel: "Meta Impact",
        funnel: "Meta Impact",
      };

      return {
        viewMode,
        attributionModel: "strict",
        compareMode: mode,
        dateRange: { startDate: impactStartDate, endDate: impactEndDate },
        dayRange: {
          startDay: dayStart,
          endDay: dayEnd,
          label: `Since ${impactStartDate}`,
        },
        runRule,
        bestBy,
        selectedTenantIds: selectedClientTenantIds,
        selectedFunnelTypeIds,
        selectedRunIds,
        availableClients,
        availableFunnels,
        selectedRuns: timelineRows,
        impactTimeline: timelineRows,
        summary: row,
        byFunnel: [row],
        rows: [row],
        allocation: {
          method: "meta_impact_outcome_window",
          note: "Meta Impact shows outcomes inside the selected date range when the customer has any prior Meta lead touch in the downstream attribution model. Campaign starts are date shortcuts only; older Meta journeys can still produce in-window revenue, estimates, jobs, and cancellations.",
        },
      };
    }

    const [clientsResult, funnelsResult, metricsResult] = await Promise.all([
    db.execute(sql`
      SELECT
        t.id,
        t.name,
        COUNT(fr.id)::int AS "runCount"
      FROM funnel_runs fr
      JOIN tenants t ON t.id = fr.tenant_id
      ${scopedWhereClause}
      GROUP BY t.id, t.name
      ORDER BY t.name ASC
    `),
    db.execute(sql`
      SELECT
        ft.id,
        ft.name,
        COUNT(fr.id)::int AS "runCount"
      FROM funnel_runs fr
      JOIN funnel_types ft ON ft.id = fr.funnel_type_id
      ${scopedWhereClause}
      GROUP BY ft.id, ft.name
      ORDER BY ft.name ASC
    `),
    db.execute(sql`
      WITH candidate_runs AS (
        SELECT
          fr.id AS run_id,
          ${groupPartition} AS comparison_group_key,
          fr.tenant_id,
          t.name AS tenant_name,
          fr.funnel_type_id,
          ft.name AS funnel_name,
          fr.name AS run_name,
          fr.start_date,
          fr.end_date,
          fr.status,
          (fr.start_date + (${startOffset}::int * INTERVAL '1 day'))::date AS window_start,
          LEAST(
            (fr.start_date + (${endOffset}::int * INTERVAL '1 day'))::date,
            COALESCE(fr.end_date, CURRENT_DATE)
          ) AS window_end
        FROM funnel_runs fr
        JOIN tenants t ON t.id = fr.tenant_id
        JOIN funnel_types ft ON ft.id = fr.funnel_type_id
        ${runWhereClause}
      ),
      valid_candidates AS (
        SELECT *
        FROM candidate_runs
        WHERE window_start <= window_end
      ),
      ranked_runs AS (
        SELECT
          valid_candidates.*,
          COUNT(*) OVER (PARTITION BY comparison_group_key)::int AS group_run_count,
          ROW_NUMBER() OVER (PARTITION BY comparison_group_key ORDER BY ${runRankOrder})::int AS run_rank
        FROM valid_candidates
      ),
      valid_runs AS (
        SELECT *
        FROM ranked_runs
        WHERE TRUE
        ${runRankFilter}
      ),
      lead_cohort AS (
        SELECT
          vr.run_id,
          l.id,
          l.tenant_id,
          l.created_at,
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
        FROM valid_runs vr
        JOIN leads l
          ON l.tenant_id = vr.tenant_id
          AND (
            l.funnel_id = vr.funnel_type_id
            OR (
              l.funnel_id IS NULL
              AND l.lead_type IS NOT NULL
              AND LOWER(TRIM(l.lead_type)) = LOWER(TRIM(vr.funnel_name))
            )
          )
          AND l.created_at >= vr.window_start::timestamp
          AND l.created_at < (vr.window_end + INTERVAL '1 day')::timestamp
      ),
      lead_by_run AS (
        SELECT
          run_id,
          COUNT(DISTINCT unique_key)::int AS unique_pulse_leads,
          COUNT(DISTINCT unique_key) FILTER (WHERE booked)::int AS appointments_booked
        FROM lead_cohort
        GROUP BY run_id
      ),
      ${challengeRunOutcomeCtes(attributionModel)},
      spend_by_run AS (
        SELECT
          vr.run_id,
          COALESCE(SUM(mads.spend), 0)::numeric AS total_spend,
          COALESCE(SUM(mads.conversions), 0)::numeric AS meta_leads
        FROM valid_runs vr
        JOIN campaigns c
          ON c.tenant_id = vr.tenant_id
          AND c.platform = 'meta'
        JOIN meta_ad_daily_stats mads
          ON mads.tenant_id = vr.tenant_id
          AND mads.campaign_external_id = c.external_id
          AND mads.date >= vr.window_start
          AND mads.date <= vr.window_end
        LEFT JOIN campaign_funnel_mappings ad_cfm
          ON ad_cfm.tenant_id = vr.tenant_id
          AND ad_cfm.campaign_id = c.id
          AND ad_cfm.ad_set_external_id = mads.ad_set_external_id
        LEFT JOIN campaign_funnel_mappings campaign_cfm
          ON campaign_cfm.tenant_id = vr.tenant_id
          AND campaign_cfm.campaign_id = c.id
          AND campaign_cfm.ad_set_external_id IS NULL
        WHERE COALESCE(ad_cfm.funnel_type_id, campaign_cfm.funnel_type_id) = vr.funnel_type_id
        GROUP BY vr.run_id
      ),
      activity_days AS (
        SELECT lc.run_id, l.created_at::date AS activity_day
        FROM lead_cohort lc
        JOIN leads l ON l.id = lc.id AND l.tenant_id = lc.tenant_id

        UNION

        SELECT vr.run_id, mads.date AS activity_day
        FROM valid_runs vr
        JOIN campaigns c
          ON c.tenant_id = vr.tenant_id
          AND c.platform = 'meta'
        JOIN meta_ad_daily_stats mads
          ON mads.tenant_id = vr.tenant_id
          AND mads.campaign_external_id = c.external_id
          AND mads.date >= vr.window_start
          AND mads.date <= vr.window_end
        LEFT JOIN campaign_funnel_mappings ad_cfm
          ON ad_cfm.tenant_id = vr.tenant_id
          AND ad_cfm.campaign_id = c.id
          AND ad_cfm.ad_set_external_id = mads.ad_set_external_id
        LEFT JOIN campaign_funnel_mappings campaign_cfm
          ON campaign_cfm.tenant_id = vr.tenant_id
          AND campaign_cfm.campaign_id = c.id
          AND campaign_cfm.ad_set_external_id IS NULL
        WHERE COALESCE(ad_cfm.funnel_type_id, campaign_cfm.funnel_type_id) = vr.funnel_type_id
          AND (
            COALESCE(mads.spend, 0) > 0
            OR COALESCE(mads.conversions, 0) > 0
          )
      ),
      active_days AS (
        SELECT run_id, COUNT(DISTINCT activity_day)::int AS active_days
        FROM activity_days
        GROUP BY run_id
      )
      SELECT
        vr.run_id,
        vr.group_run_count,
        vr.tenant_id,
        vr.tenant_name,
        vr.funnel_type_id,
        vr.funnel_name,
        vr.run_name,
        vr.start_date,
        vr.end_date,
        vr.status,
        COALESCE(ad.active_days, 0)::int AS active_days,
        COALESCE(spr.meta_leads, 0)::numeric AS meta_leads,
        COALESCE(lbr.unique_pulse_leads, 0)::int AS unique_pulse_leads,
        COALESCE(lbr.appointments_booked, 0)::int AS appointments_booked,
        COALESCE(jbr.total_jobs, 0)::numeric AS total_jobs,
        COALESCE(jbr.cancelled_jobs, 0)::numeric AS cancelled_jobs,
        COALESCE(jbr.completed_estimate_jobs, 0)::numeric AS completed_estimate_jobs,
        COALESCE(ebr.total_estimate_value, 0)::numeric AS total_estimate_value,
        COALESCE(sbr.sold_closed_value, 0)::numeric AS sold_closed_value,
        COALESCE(sbr.sold_jobs, 0)::numeric AS sold_jobs,
        COALESCE(spr.total_spend, 0)::numeric AS total_spend
      FROM valid_runs vr
      LEFT JOIN lead_by_run lbr ON lbr.run_id = vr.run_id
      LEFT JOIN jobs_by_run jbr ON jbr.run_id = vr.run_id
      LEFT JOIN estimates_by_run ebr ON ebr.run_id = vr.run_id
      LEFT JOIN sold_by_run sbr ON sbr.run_id = vr.run_id
      LEFT JOIN spend_by_run spr ON spr.run_id = vr.run_id
      LEFT JOIN active_days ad ON ad.run_id = vr.run_id
      ORDER BY vr.start_date DESC, vr.run_id DESC
    `),
  ]);

  const availableClients = ((clientsResult as unknown as { rows?: Array<{ id: number; name: string; runCount: number }> }).rows ?? [])
    .map((row) => ({ id: Number(row.id), name: row.name, runCount: Number(row.runCount ?? 0) }));
  const availableFunnels = ((funnelsResult as unknown as { rows?: Array<{ id: number; name: string; runCount: number }> }).rows ?? [])
    .map((row) => ({ id: Number(row.id), name: row.name, runCount: Number(row.runCount ?? 0) }));
  const runRawRows = ((metricsResult as unknown as { rows?: ChallengeRunRawRow[] }).rows ?? []);
  const runMetrics = runRawRows.map(buildChallengeRunMetricRow);
  const rows = selectChallengeRowsForComparison(runMetrics, mode, runRule, bestBy);
  const summary = summarizeChallengeRunRows(rows);

    return {
      viewMode,
      attributionModel,
      compareMode: mode,
      dayRange: {
        startDay: dayStart,
        endDay: dayEnd,
        label: `Days ${dayStart}-${dayEnd}`,
      },
      runRule,
      bestBy,
      selectedTenantIds: selectedClientTenantIds,
      selectedFunnelTypeIds,
      selectedRunIds,
      availableClients,
      availableFunnels,
      selectedRuns: runMetrics.map((row) => ({
        id: row.runId,
        tenantId: row.tenantId,
        tenantName: row.tenantName,
        funnelTypeId: row.funnelTypeId,
        funnelName: row.funnelName,
        name: row.runName,
        startDate: row.startDate,
        endDate: row.endDate,
        status: row.status,
        activeDays: row.activeDays,
      })),
      summary,
      byFunnel: rows,
      rows,
      allocation: {
        method: attributionModel === "weighted" ? "weighted_recency_funnel_attribution" : "meta_campaign_adset_funnel_mapping",
        note: attributionModel === "weighted"
          ? `Weighted Funnel Mode keeps leads and spend in each run window, then splits downstream jobs, cancellations, estimates, and sold value across prior funnel entries for the same customer using recency weighting over a ${CHALLENGE_WEIGHTED_LOOKBACK_DAYS}-day lookback.`
          : "Run comparisons use funnel-day windows. Leads are included by the day they were received inside that run window; jobs, cancellations, estimates, and sold value come from those same leads. Spend and Meta Leads use saved Meta campaign/ad-set mappings for the same run days.",
      },
    };
  })();

  challengeRunsInflight.set(cacheKey, responsePromise);
  try {
    const body = await responsePromise;
    setChallengeRunsCachedResponse(cacheKey, body);
    res.setHeader("X-Optics-Cache", "miss");
    res.json(body);
  } finally {
    challengeRunsInflight.delete(cacheKey);
  }
});

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
        l.created_at,
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
        ) AS booked,
        (
          LOWER(COALESCE(NULLIF(l.original_source, ''), l.source, '')) LIKE '%meta%'
          OR LOWER(COALESCE(NULLIF(l.original_source, ''), l.source, '')) LIKE '%facebook%'
          OR LOWER(COALESCE(NULLIF(l.original_source, ''), l.source, '')) LIKE '%instagram%'
          OR LOWER(COALESCE(NULLIF(l.original_source, ''), l.source, '')) IN ('fb', 'ig')
        ) AS is_meta_lead
      FROM leads l
      LEFT JOIN tenant_funnel_types tft ON tft.funnel_type_id = l.funnel_id AND tft.tenant_id = l.tenant_id
      LEFT JOIN funnel_types ft ON ft.id = tft.funnel_type_id
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
        COUNT(*) FILTER (WHERE is_meta_lead)::int AS meta_leads,
        COUNT(DISTINCT unique_key)::int AS unique_pulse_leads,
        COUNT(DISTINCT unique_key) FILTER (WHERE booked)::int AS appointments_booked
      FROM lead_cohort
      GROUP BY funnel
    ),
    lead_total AS (
      SELECT
        COUNT(*) FILTER (WHERE is_meta_lead)::int AS meta_leads,
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
        ${challengeJobAttributionWindowSql()}
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
        ${challengeJobAttributionWindowSql()}
      LEFT JOIN sold_estimates sej ON sej.job_id = j.id AND sej.tenant_id = j.tenant_id
    ),
    estimate_options AS (
      SELECT
        lc.funnel,
        lc.unique_key,
        COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0)::numeric AS amount
      FROM lead_cohort lc
      JOIN sold_estimates se ON se.tenant_id = lc.tenant_id AND se.lead_id = lc.id
      LEFT JOIN jobs j ON j.id = se.job_id AND j.tenant_id = se.tenant_id
      WHERE COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
        ${challengeEstimateAttributionWindowSql()}

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
        ${challengeEstimateAttributionWindowSql()}
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
      LEFT JOIN jobs j ON j.id = se.job_id AND j.tenant_id = se.tenant_id
      WHERE COALESCE(NULLIF(se.total_amount, 0), se.subtotal, 0) > 0
        AND (se.estimate_status IS NULL OR TRIM(se.estimate_status) = '' OR LOWER(se.estimate_status) = 'sold')
        ${challengeEstimateAttributionWindowSql()}

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
        ${challengeEstimateAttributionWindowSql()}
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
      lt.meta_leads,
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
      COALESCE(lbf.meta_leads, 0)::int AS meta_leads,
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
      COALESCE(SUM(cds.conversions), 0)::numeric AS meta_leads
    FROM campaign_daily_stats cds
    JOIN campaigns c ON c.id = cds.campaign_id
    WHERE cds.date >= ${startDate}
      AND cds.date <= ${endDate}
      AND c.platform = 'meta'
      ${tenantCampaignFilter}
  `);

  const adMappingResult = await db.execute(sql`
    SELECT
      CASE
        WHEN effective.funnel_type_id IS NOT NULL AND ft.id IS NOT NULL THEN ft.name
        ELSE NULL
      END AS funnel,
      (effective.funnel_type_id IS NOT NULL AND ft.id IS NOT NULL) AS mapped,
      COALESCE(SUM(effective.spend), 0)::numeric AS spend,
      COALESCE(SUM(effective.meta_leads), 0)::numeric AS meta_leads
    FROM (
      SELECT
        c.tenant_id,
        COALESCE(ad_cfm.funnel_type_id, campaign_cfm.funnel_type_id) AS funnel_type_id,
        mads.spend,
        mads.conversions AS meta_leads
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
      WHERE mads.date >= ${startDate}
        AND mads.date <= ${endDate}
        ${tenantId ? sql`AND c.tenant_id = ${tenantId}` : sql``}
    ) effective
    LEFT JOIN tenant_funnel_types tft
      ON tft.tenant_id = effective.tenant_id
      AND tft.funnel_type_id = effective.funnel_type_id
    LEFT JOIN funnel_types ft
      ON ft.id = tft.funnel_type_id
    GROUP BY effective.funnel_type_id, ft.id, ft.name
  `);

  const funnelResult = await db.execute(sql`
    SELECT DISTINCT COALESCE(ft.name, l.lead_type, ${CHALLENGE_UNASSIGNED_FUNNEL}) AS funnel
    FROM leads l
    LEFT JOIN tenant_funnel_types tft ON tft.funnel_type_id = l.funnel_id AND tft.tenant_id = l.tenant_id
    LEFT JOIN funnel_types ft ON ft.id = tft.funnel_type_id
    WHERE l.created_at >= ${startBound}
      AND l.created_at <= ${endBound}
      ${tenantLeadFilter}
    ORDER BY funnel ASC
  `);

  const rows = ((rollupResult as unknown as { rows?: ChallengeRollupRow[] }).rows ?? []);
  const adRow = ((adResult as unknown as { rows?: Array<{ total_spend: string | number; meta_leads: string | number }> }).rows ?? [])[0];
  const adRows = ((adMappingResult as unknown as { rows?: ChallengeAdRow[] }).rows ?? []);
  const funnels = (((funnelResult as unknown as { rows?: Array<{ funnel: string }> }).rows ?? [])
    .map(row => row.funnel)
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0));

  res.json(buildChallengeDashboardResponse({
    rows,
    adRows,
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
