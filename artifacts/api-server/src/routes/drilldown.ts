import { Router, type IRouter } from "express";
import { db, leadsTable, jobsTable, soldEstimatesTable, funnelTypesTable, type RebateBreakdownItem, type SoldEstimate } from "@workspace/db";
import { eq, and, gte, lte, asc, desc, SQL, inArray, sql, or, ilike, getTableColumns } from "drizzle-orm";
import { resolveListTenantScope, assertResourceTenantAccess } from "../lib/tenant-scope";

// Matches the date expression used by /api/dashboard/spend-revenue so the
// drilldown returns the same jobs that the chart's revenue bar aggregated.
const jobDateExpr = sql`COALESCE(${jobsTable.invoiceDate}, ${jobsTable.completedAt}, ${jobsTable.createdAt})`;
const jobRevenueExpr = sql<number>`COALESCE(${jobsTable.invoiceTotal} + COALESCE(${jobsTable.invoiceRebateAmount}, 0), ${jobsTable.revenue})`;
// Canonical funnel name for a job's originating lead: prefer the joined
// funnel_types.name (authoritative), falling back to the denormalised
// leads.lead_type the ingestion pipeline stamps. Used for the Funnel column,
// funnel filtering, and funnel sorting on the Revenue Attributed list. Depends
// on leadsTable + funnelTypesTable being left-joined into the query.
const funnelNameExpr = sql<string | null>`COALESCE(${funnelTypesTable.name}, ${leadsTable.leadType})`;

// Reconciliation stamps jobs it could not tie to a marketing touch with the
// literal tier "unmatched" (and leaves never-reconciled jobs NULL). Both mean
// "not attributed", so we treat NULL and "unmatched" as the same bucket for
// the Attributed total and the Match Level filter.
const UNMATCHED_TIER = "unmatched";
// A job counts as attributed only when it carries a real match tier — not NULL
// and not the "unmatched" sentinel.
const isAttributedExpr = sql`${jobsTable.matchLevel} IS NOT NULL AND ${jobsTable.matchLevel} <> ${UNMATCHED_TIER}`;
// Display/sort order for match tiers, strongest first. "gclid" is an exact
// click-id match; "manual" is a human-assigned match; "lead_funnel" is a
// linked lead with a known funnel but no stronger click/contact proof yet.
// "unmatched" sorts last.
// Any tier not listed here sorts after the known ones (then alphabetically).
const MATCH_LEVEL_ORDER = ["diamond", "golden", "silver", "bronze", "gclid", "manual", "lead_funnel", UNMATCHED_TIER];
function matchLevelRank(level: string): number {
  const i = MATCH_LEVEL_ORDER.indexOf(level);
  return i === -1 ? MATCH_LEVEL_ORDER.length : i;
}

// Parse the repeatable/comma-separated `matchLevel` query param into a deduped,
// lower-cased list. Accepts ?matchLevel=diamond&matchLevel=golden or
// ?matchLevel=diamond,golden. Empty/absent → [] (no filter).
function parseMatchLevels(raw: unknown): string[] {
  const vals = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const flat = vals
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(flat)];
}

// Build the SQL predicate for a match-level selection. Selecting "unmatched"
// also catches NULL matchLevel jobs so the bucket mirrors the Attributed math.
// Returns undefined when nothing is selected (no filtering).
function matchLevelCondition(levels: string[]): SQL | undefined {
  if (levels.length === 0) return undefined;
  const includeUnmatched = levels.includes(UNMATCHED_TIER);
  const realLevels = levels.filter((l) => l !== UNMATCHED_TIER);
  const ors: SQL[] = [];
  if (realLevels.length > 0) ors.push(inArray(jobsTable.matchLevel, realLevels));
  if (includeUnmatched) {
    ors.push(sql`(${jobsTable.matchLevel} IS NULL OR ${jobsTable.matchLevel} = ${UNMATCHED_TIER})`);
  }
  if (ors.length === 0) return undefined;
  return ors.length === 1 ? ors[0] : or(...ors);
}

function revenueAttributedSearchCondition(search: string): SQL | undefined {
  const q = search.trim();
  if (!q) return undefined;

  const needle = `%${q}%`;
  const phoneDigits = q.replace(/\D/g, "");
  const phoneNeedle = phoneDigits ? `%${phoneDigits}%` : null;
  const parts: SQL[] = [
    ilike(jobsTable.customerName, needle),
    ilike(jobsTable.customerPhone, needle),
    ilike(jobsTable.customerEmail, needle),
    ilike(jobsTable.stJobNumber, needle),
    ilike(jobsTable.jobTypeName, needle),
    ilike(leadsTable.firstName, needle),
    ilike(leadsTable.lastName, needle),
    ilike(leadsTable.email, needle),
    ilike(leadsTable.phone, needle),
    ilike(leadsTable.source, needle),
    ilike(leadsTable.originalSource, needle),
    sql`(${leadsTable.firstName} || ' ' || ${leadsTable.lastName}) ILIKE ${needle}`,
    sql`${funnelNameExpr} ILIKE ${needle}`,
  ];

  if (phoneNeedle) {
    parts.push(
      sql`regexp_replace(COALESCE(${jobsTable.customerPhone}, ''), '[^0-9]', '', 'g') ILIKE ${phoneNeedle}`,
      sql`regexp_replace(COALESCE(${leadsTable.phone}, ''), '[^0-9]', '', 'g') ILIKE ${phoneNeedle}`,
    );
  }

  return or(...parts);
}

// Revenue columns (subtotal, rebateAmount, invoiceTotal, invoiceRebateAmount)
// are stored as floating-point `real`, so summing them in JS can produce
// values like 1050.1500000000001 (900.10 + 150.05). We round corrected
// revenue to whole cents before returning it so clients never see spurious
// sub-cent precision drift. Matches the `Math.round(n * 100) / 100` money
// convention used across admin/campaigns/dashboard routes.
const round2 = (n: number) => Math.round(n * 100) / 100;
// Nullable variant: leaves null/undefined untouched (e.g. invoiceTotal,
// invoiceRebateAmount can be null) but rounds any real number to whole cents.
const round2Nullable = (n: number | null | undefined): number | null =>
  n == null ? null : round2(n);

type EstimateOption = {
  id: number;
  stEstimateId: string;
  stJobId: string | null;
  name: string | null;
  status: string | null;
  summary: string | null;
  subtotal: number;
  rebateAmount: number;
  totalAmount: number;
  soldByName: string | null;
  soldOn: Date | string | null;
  followUpOn: Date | string | null;
};

type PotentialEstimateInput = Pick<SoldEstimate, "jobId" | "totalAmount">;

function estimateAmount(est: Pick<SoldEstimate, "totalAmount" | "subtotal">): number {
  const amount = Number(est.totalAmount ?? est.subtotal ?? 0);
  return Number.isFinite(amount) ? round2(amount) : 0;
}

function isSoldEstimate(est: Pick<SoldEstimate, "estimateStatus">): boolean {
  const status = est.estimateStatus?.trim().toLowerCase();
  // Rows created before estimate_status existed came only from the sold-only
  // sync, so keep treating them as sold until a fresh sync backfills status.
  return status == null || status === "" || status === "sold";
}

function toEstimateOption(est: SoldEstimate): EstimateOption {
  return {
    id: est.id,
    stEstimateId: est.stEstimateId,
    stJobId: est.stJobId,
    name: est.estimateName,
    status: est.estimateStatus,
    summary: est.summary,
    subtotal: round2(Number(est.subtotal ?? 0)),
    rebateAmount: round2(Number(est.rebateAmount ?? 0)),
    totalAmount: estimateAmount(est),
    soldByName: est.soldByName,
    soldOn: est.soldOn,
    followUpOn: est.followUpOn,
  };
}

function estimatePotentialFromOptions(options: EstimateOption[]) {
  const amounts = options.map((o) => o.totalAmount).filter((n) => Number.isFinite(n) && n > 0);
  if (amounts.length === 0) {
    return { low: null as number | null, avg: null as number | null, high: null as number | null, count: 0 };
  }
  let low = amounts[0];
  let high = amounts[0];
  let total = 0;
  for (const amount of amounts) {
    total += amount;
    if (amount < low) low = amount;
    if (amount > high) high = amount;
  }
  return { low: round2(low), avg: round2(total / amounts.length), high: round2(high), count: amounts.length };
}

function summarizePotentialByJob(estimates: PotentialEstimateInput[]) {
  const byJob = new Map<number, { low: number; high: number; total: number; count: number }>();
  for (const est of estimates) {
    if (est.jobId == null) continue;
    const amount = Number(est.totalAmount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const rounded = round2(amount);
    const current = byJob.get(est.jobId);
    if (!current) {
      byJob.set(est.jobId, { low: rounded, high: rounded, total: rounded, count: 1 });
    } else {
      if (rounded < current.low) current.low = rounded;
      if (rounded > current.high) current.high = rounded;
      current.total += rounded;
      current.count += 1;
    }
  }

  let lowTotal = 0;
  let avgTotal = 0;
  let highTotal = 0;
  for (const job of byJob.values()) {
    lowTotal += job.low;
    avgTotal += job.total / job.count;
    highTotal += job.high;
  }
  return {
    potentialRevenueLow: round2(lowTotal),
    potentialRevenueAvg: round2(avgTotal),
    potentialRevenueHigh: round2(highTotal),
    potentialJobCount: byJob.size,
  };
}

const router: IRouter = Router();

router.get("/drilldown/leads", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const status = req.query.status as string | undefined;
  const source = req.query.source as string | undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const offset = req.query.offset ? Number(req.query.offset) : 0;

  const scope = resolveListTenantScope(req, res, queryTenantId, { requireTenant: true });
  if (!scope.ok) return;

  const conditions: SQL[] = [];
  if (scope.tenantId) conditions.push(eq(leadsTable.tenantId, scope.tenantId));
  if (startDate) conditions.push(gte(leadsTable.createdAt, new Date(startDate)));
  if (endDate) conditions.push(lte(leadsTable.createdAt, new Date(endDate + "T23:59:59.999Z")));
  if (status) {
    const statuses = status.split(",") as ("new" | "contacted" | "booked" | "sold" | "lost" | "cancelled")[];
    conditions.push(inArray(leadsTable.status, statuses));
  }
  if (source) conditions.push(eq(leadsTable.source, source));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  // Append the unique primary key as a deterministic tiebreaker so paging is
  // stable under LIMIT/OFFSET. createdAt ties constantly (bulk imports stamp
  // the same timestamp), and Postgres gives no guaranteed order among rows the
  // ORDER BY can't distinguish — so without a unique secondary key, two
  // requests for adjacent pages can overlap (a tied row served twice) or skip
  // rows entirely. leads.id is unique + monotonic, so appending it in the same
  // direction as the primary sort gives a total order: every page is a
  // disjoint, complete slice of one fixed sequence.
  const leads = await db.select().from(leadsTable).where(where)
    .orderBy(desc(leadsTable.createdAt), sql`${leadsTable.id} desc`).limit(limit).offset(offset);

  res.json(leads);
});

router.get("/drilldown/jobs", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const status = req.query.status as string | undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  // When `useJobDate=true`, filter by COALESCE(invoiceDate, completedAt, createdAt)
  // so the drilldown matches the same date bucketing the Command Center chart uses.
  const useJobDate = req.query.useJobDate === "true";
  // sort=revenue → biggest invoice first (for "what made up this revenue bar?" UX).
  const sortBy = req.query.sort === "revenue" ? "revenue" : "date";

  const scope = resolveListTenantScope(req, res, queryTenantId, { requireTenant: true });
  if (!scope.ok) return;

  const conditions: SQL[] = [];
  if (scope.tenantId) conditions.push(eq(jobsTable.tenantId, scope.tenantId));
  if (useJobDate) {
    // Match /dashboard/spend-revenue exactly: `<= new Date(endDate)` (midnight)
    // so the drilldown totals reconcile with the chart/card totals.
    if (startDate) conditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
    if (endDate) conditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);
  } else {
    if (startDate) conditions.push(gte(jobsTable.createdAt, new Date(startDate)));
    if (endDate) conditions.push(lte(jobsTable.createdAt, new Date(endDate + "T23:59:59.999Z")));
  }
  if (status) conditions.push(eq(jobsTable.status, status as "pending" | "in_progress" | "completed" | "cancelled"));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const orderBy = sortBy === "revenue" ? desc(jobRevenueExpr) : desc(jobsTable.createdAt);
  // Append the unique primary key as a deterministic tiebreaker so paging is
  // stable under LIMIT/OFFSET. Both the revenue sort (ties when two jobs share
  // a corrected revenue) and the date sort (ties when invoices share a
  // createdAt) leave rows the ORDER BY can't distinguish, and Postgres gives no
  // guaranteed order among them — so without a unique secondary key, adjacent
  // pages can overlap (a tied row served twice) or skip rows. jobs.id is unique
  // + monotonic, so appending it in the same direction as the primary sort
  // gives a total order: every page is a disjoint, complete slice.
  const jobs = await db.select().from(jobsTable).where(where)
    .orderBy(orderBy, sql`${jobsTable.id} desc`).limit(limit).offset(offset);

  // Money columns are floating-point `real`, so they can carry sub-cent drift
  // (e.g. 900.1000000001). Round every money field to whole cents before
  // returning so clients never display or aggregate spurious precision.
  res.json(jobs.map((job) => ({
    ...job,
    revenue: round2(job.revenue),
    invoiceTotal: round2Nullable(job.invoiceTotal),
    invoiceRebateAmount: round2Nullable(job.invoiceRebateAmount),
  })));
});

// Revenue Attributed: completed jobs in a date range, enriched with the
// originating lead summary, the salesperson + itemized rebate breakdown from
// sold_estimates, and the corrected (rebate-inclusive) revenue. Uses the same
// date/revenue math as /drilldown/jobs so totals reconcile with Command Center.
router.get("/drilldown/revenue-attributed", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  // `limit=all` (or 0/negative) returns every matching row — used by the CSV
  // export so it always covers the full date range regardless of UI paging.
  const rawLimit = req.query.limit;
  const noLimit = rawLimit === "all" || (rawLimit != null && Number(rawLimit) <= 0);
  const limit = noLimit ? null : rawLimit ? Number(rawLimit) : 200;
  // `offset` lets the UI page through long lists (matches /drilldown/jobs).
  // Ignored when there is no limit (CSV export pulls the whole range at once).
  const rawOffset = req.query.offset ? Number(req.query.offset) : 0;
  const offset = !noLimit && Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  // Optional filters on the originating lead. Funnel matches the canonical
  // funnel name (funnelNameExpr); source matches leads.source exactly. Both are
  // applied identically to the list, count, and summary so the cards/CSV always
  // reconcile with the visible rows under any active filter.
  const funnel = typeof req.query.funnel === "string" && req.query.funnel ? req.query.funnel : undefined;
  const source = typeof req.query.source === "string" && req.query.source ? req.query.source : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  // Optional multi-select match-tier filter (diamond/golden/silver/bronze/
  // manual/lead_funnel/unmatched). Applied identically to the list, count, and
  // summary so the cards/CSV reconcile with the visible rows under any active
  // selection.
  const matchLevels = parseMatchLevels(req.query.matchLevel);

  // Sort key + direction. Defaults to corrected-revenue desc (the historical
  // behaviour) so existing callers are unaffected.
  const sortExprByKey: Record<string, SQL> = {
    revenue: jobRevenueExpr,
    date: sql`${jobDateExpr}`,
    customer: sql`${jobsTable.customerName}`,
    funnel: sql`${funnelNameExpr}`,
    source: sql`${leadsTable.source}`,
  };
  const sortKey = typeof req.query.sort === "string" && req.query.sort in sortExprByKey ? req.query.sort : "revenue";
  const sortDir = req.query.dir === "asc" ? "asc" : "desc";
  const sortExpr = sortExprByKey[sortKey];
  const orderBy = sortDir === "asc" ? asc(sortExpr) : desc(sortExpr);
  // Deterministic tiebreaker so paging is stable under LIMIT/OFFSET. The text
  // (customer) and date sorts have many ties, and Postgres does not guarantee
  // any particular order among rows the ORDER BY can't distinguish — so without
  // a unique secondary key, two requests for adjacent pages can overlap (a tied
  // row served twice) or skip rows entirely. jobs.id is unique + monotonic, so
  // appending it (in the same direction as the primary sort) gives a total
  // order: every page is a disjoint, complete slice of one fixed sequence.
  // Built as raw SQL rather than asc()/desc() so the single-asc/desc-call
  // contract the mocked unit tests assert on stays intact.
  const idTiebreak = sortDir === "asc" ? sql`${jobsTable.id} asc` : sql`${jobsTable.id} desc`;

  // requireTenant: an unfiltered request (super_admin / agency_user with no
  // tenantId) would join jobs→leads→funnel_types over every tenant's completed
  // jobs and sort the whole result — an unindexed full-table scan after the
  // global keyset indexes were dropped. Force a concrete tenant first.
  const scope = resolveListTenantScope(req, res, queryTenantId, { requireTenant: true });
  if (!scope.ok) return;

  const conditions: SQL[] = [];
  if (scope.tenantId) conditions.push(eq(jobsTable.tenantId, scope.tenantId));
  conditions.push(eq(jobsTable.status, "completed"));
  if (startDate) conditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
  if (endDate) conditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);
  if (funnel) conditions.push(sql`${funnelNameExpr} = ${funnel}`);
  if (source) conditions.push(eq(leadsTable.source, source));
  const matchCond = matchLevelCondition(matchLevels);
  if (matchCond) conditions.push(matchCond);
  const searchCond = revenueAttributedSearchCondition(search);
  if (searchCond) conditions.push(searchCond);

  const where = and(...conditions);
  // Left-join the originating lead (+ its funnel type) so funnel/source filters
  // and sorting can reference them. Select the full job row plus the resolved
  // funnel name; lead detail is fetched in a second pass (below) to keep the
  // enrichment shape stable.
  const baseQuery = db
    .select({ ...getTableColumns(jobsTable), funnelName: funnelNameExpr })
    .from(jobsTable)
    .leftJoin(leadsTable, eq(jobsTable.leadId, leadsTable.id))
    .leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id))
    .where(where)
    .orderBy(orderBy, idTiebreak);
  const rows =
    limit == null
      ? await baseQuery
      : offset > 0
        ? await baseQuery.limit(limit).offset(offset)
        : await baseQuery.limit(limit);
  // Rows are flat job columns + the resolved funnelName; keep the funnel name
  // keyed by job id so it can be hoisted into the response below.
  const jobs = rows;
  const funnelByJobId = new Map(rows.map((r) => [r.id, r.funnelName]));

  // Total matching completed jobs for the range, independent of paging. Exposed
  // as a response header so both the paged UI (to show "X of N" + a real page
  // count) and the CSV export keep receiving a plain JSON array body. Must carry
  // the same joins/filters as the data query so the count tracks the filters.
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(jobsTable)
    .leftJoin(leadsTable, eq(jobsTable.leadId, leadsTable.id))
    .leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id))
    .where(where);
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");

  const jobIds = jobs.map((j) => j.id);
  const leadIds = [...new Set(jobs.map((j) => j.leadId).filter((v): v is number => v != null))];

  // Estimate rows carry two separate meanings:
  // - sold/status-less rows support existing actual-revenue audit fields
  // - every active row supports potential-revenue min/max options
  const estimates = jobIds.length > 0
    ? await db.select().from(soldEstimatesTable).where(inArray(soldEstimatesTable.jobId, jobIds))
    : [];
  const estimatesByJobId = new Map<number, typeof estimates>();
  const actualEstimateByJobId = new Map<number, typeof estimates[number]>();
  for (const est of estimates) {
    if (est.jobId == null) continue;
    const list = estimatesByJobId.get(est.jobId) ?? [];
    list.push(est);
    estimatesByJobId.set(est.jobId, list);
    if (!isSoldEstimate(est)) continue;
    const existing = actualEstimateByJobId.get(est.jobId);
    // Prefer the estimate with the largest rebate breakdown (most informative).
    if (!existing || (est.rebateAmount ?? 0) > (existing.rebateAmount ?? 0)) {
      actualEstimateByJobId.set(est.jobId, est);
    }
  }

  const leads = leadIds.length > 0
    ? await db.select({
        id: leadsTable.id,
        firstName: leadsTable.firstName,
        lastName: leadsTable.lastName,
        source: leadsTable.source,
        originalSource: leadsTable.originalSource,
        status: leadsTable.status,
        hubStatus: leadsTable.hubStatus,
        assignedTo: leadsTable.assignedTo,
        phone: leadsTable.phone,
        email: leadsTable.email,
        address: leadsTable.address,
        city: leadsTable.city,
        state: leadsTable.state,
        zip: leadsTable.zip,
      }).from(leadsTable).where(inArray(leadsTable.id, leadIds))
    : [];
  const leadById = new Map(leads.map((l) => [l.id, l]));

  const result = jobs.map((job) => {
    const est = actualEstimateByJobId.get(job.id);
    const estimateOptions = (estimatesByJobId.get(job.id) ?? [])
      .map(toEstimateOption)
      .filter((option) => option.totalAmount > 0)
      .sort((a, b) => a.totalAmount - b.totalAmount || a.id - b.id);
    const potential = estimatePotentialFromOptions(estimateOptions);
    const lead = job.leadId != null ? leadById.get(job.leadId) : undefined;
    const rebateBreakdown: RebateBreakdownItem[] = (est?.rebateBreakdown as RebateBreakdownItem[] | null) ?? [];
    const correctedRevenue = round2(
      job.invoiceTotal != null
        ? job.invoiceTotal + (job.invoiceRebateAmount ?? 0)
        : job.revenue,
    );
    const funnelName = funnelByJobId.get(job.id) ?? null;
    return {
      id: job.id,
      tenantId: job.tenantId,
      stJobId: job.stJobId,
      stInvoiceId: job.stInvoiceId,
      // Portal-findable ServiceTitan job number (also serves as the invoice
      // number — ServiceTitan has no separate invoice number). Task #819.
      stJobNumber: job.stJobNumber,
      customerName: job.customerName,
      // ServiceTitan contact fields surfaced for the match-explanation panel so
      // the UI can show exactly what came from the invoice vs. Optics/Pulse.
      customerPhone: job.customerPhone,
      customerEmail: job.customerEmail,
      serviceAddress: job.serviceAddress,
      jobType: job.jobType,
      jobTypeName: job.jobTypeName,
      status: job.status,
      revenue: round2(job.revenue),
      invoiceTotal: round2Nullable(job.invoiceTotal),
      invoiceRebateAmount: round2Nullable(job.invoiceRebateAmount),
      correctedRevenue,
      invoiceDate: job.invoiceDate,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      matchLevel: job.matchLevel,
      matchedGclid: job.matchedGclid,
      // Resolved funnel name + lead source, hoisted to the top level so the list
      // can render/sort the Funnel and Source columns without digging into lead.
      funnel: funnelName,
      source: lead?.source ?? null,
      rebateBreakdown,
      estimateOptions,
      potentialRevenueLow: potential.low,
      potentialRevenueAvg: potential.avg,
      potentialRevenueHigh: potential.high,
      potentialEstimateCount: potential.count,
      soldByName: est?.soldByName ?? lead?.assignedTo ?? null,
      lead: lead
        ? {
            id: lead.id,
            firstName: lead.firstName,
            lastName: lead.lastName,
            source: lead.source,
            originalSource: lead.originalSource,
            status: lead.status,
            hubStatus: lead.hubStatus,
            funnel: funnelName,
            phone: lead.phone,
            email: lead.email,
            address: lead.address,
            city: lead.city,
            state: lead.state,
            zip: lead.zip,
          }
        : null,
    };
  });

  res.json(result);
});

// Revenue Attributed summary: full-range totals for the summary cards, computed
// server-side so they reflect the entire date range regardless of which page of
// rows the UI is showing. Uses the same date/revenue/corrected-revenue math as
// /drilldown/revenue-attributed so the cards reconcile with the list + CSV.
router.get("/drilldown/revenue-attributed/summary", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  // Same lead-side filters as the list so the cards reconcile with the visible
  // rows + CSV under any active funnel/source filter.
  const funnel = typeof req.query.funnel === "string" && req.query.funnel ? req.query.funnel : undefined;
  const source = typeof req.query.source === "string" && req.query.source ? req.query.source : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const matchLevels = parseMatchLevels(req.query.matchLevel);

  // requireTenant: same heavy jobs→leads→funnel_types join as the list, here
  // aggregated with SUM/COUNT. An unfiltered request would scan every tenant's
  // completed jobs — reject it and make the caller pick a tenant first.
  const scope = resolveListTenantScope(req, res, queryTenantId, { requireTenant: true });
  if (!scope.ok) return;

  const conditions: SQL[] = [];
  if (scope.tenantId) conditions.push(eq(jobsTable.tenantId, scope.tenantId));
  conditions.push(eq(jobsTable.status, "completed"));
  if (startDate) conditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
  if (endDate) conditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);
  if (funnel) conditions.push(sql`${funnelNameExpr} = ${funnel}`);
  if (source) conditions.push(eq(leadsTable.source, source));
  const matchCond = matchLevelCondition(matchLevels);
  if (matchCond) conditions.push(matchCond);
  const searchCond = revenueAttributedSearchCondition(search);
  if (searchCond) conditions.push(searchCond);

  const where = and(...conditions);

  const [agg] = await db
    .select({
      revenue: sql<number>`COALESCE(SUM(${jobRevenueExpr}), 0)`,
      rebates: sql<number>`COALESCE(SUM(COALESCE(${jobsTable.invoiceRebateAmount}, 0)), 0)`,
      // Attributed = corrected revenue only for jobs with a real match tier.
      // Excludes the "unmatched" sentinel (and NULL) so it reflects revenue
      // genuinely tied to a marketing touch, not merely "reconciliation ran".
      attributed: sql<number>`COALESCE(SUM(CASE WHEN ${isAttributedExpr} THEN ${jobRevenueExpr} ELSE 0 END), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(jobsTable)
    .leftJoin(leadsTable, eq(jobsTable.leadId, leadsTable.id))
    .leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id))
    .where(where);

  // Per-match-tier rollup powering the "revenue by match tier" breakdown. Same
  // WHERE as the cards, grouped by tier, so the breakdown always reconciles with
  // the summary (attributed = SUM of every non-"unmatched" tier's corrected
  // revenue). The bucket expression mirrors isAttributedExpr exactly: NULL and
  // the literal "unmatched" sentinel fold into one "unmatched" bucket, and every
  // real tier is lower-cased so case variants merge (matching the lower-cased
  // facets + Match Level filter).
  //
  // GROUP BY references the first SELECT column by ordinal (`1`) rather than
  // repeating tierBucketExpr: drizzle parameterizes the "unmatched" literals, so
  // a repeated expression gets *different* bind-parameter positions in SELECT vs
  // GROUP BY and Postgres no longer sees them as the same expression (error
  // 42803, "must appear in the GROUP BY clause"). Ordinal grouping sidesteps it.
  const tierBucketExpr = sql<string>`CASE WHEN ${jobsTable.matchLevel} IS NULL OR ${jobsTable.matchLevel} = ${UNMATCHED_TIER} THEN ${UNMATCHED_TIER} ELSE LOWER(${jobsTable.matchLevel}) END`;
  const tierRows = await db
    .select({
      tier: tierBucketExpr,
      revenue: sql<number>`COALESCE(SUM(${jobRevenueExpr}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(jobsTable)
    .leftJoin(leadsTable, eq(jobsTable.leadId, leadsTable.id))
    .leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id))
    .where(where)
    .groupBy(sql`1`);

  const potentialJobs = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .leftJoin(leadsTable, eq(jobsTable.leadId, leadsTable.id))
    .leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id))
    .where(where);
  const potentialJobIds = potentialJobs.map((j) => j.id);
  const potentialEstimates = potentialJobIds.length > 0
    ? await db
        .select({ jobId: soldEstimatesTable.jobId, totalAmount: soldEstimatesTable.totalAmount })
        .from(soldEstimatesTable)
        .where(inArray(soldEstimatesTable.jobId, potentialJobIds))
    : [];
  const potentialSummary = summarizePotentialByJob(potentialEstimates);

  // Strongest tier first (diamond → unmatched), matching the facets ordering.
  const byMatchLevel = tierRows
    .map((r) => ({ tier: String(r.tier), revenue: round2(Number(r.revenue ?? 0)), count: Number(r.count ?? 0) }))
    .sort((a, b) => matchLevelRank(a.tier) - matchLevelRank(b.tier) || a.tier.localeCompare(b.tier));

  res.json({
    revenue: round2(Number(agg?.revenue ?? 0)),
    rebates: round2(Number(agg?.rebates ?? 0)),
    attributed: round2(Number(agg?.attributed ?? 0)),
    count: Number(agg?.count ?? 0),
    ...potentialSummary,
    byMatchLevel,
  });
});

// Revenue Attributed filter facets: the distinct funnels + sources present in
// the completed jobs for a tenant/date range. Deliberately NOT scoped by the
// funnel/source filters themselves so the dropdowns always offer every option
// in the range (letting the user pivot between filters without losing choices).
router.get("/drilldown/revenue-attributed/facets", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  // requireTenant: a SELECT DISTINCT over the same jobs→leads→funnel_types join.
  // An unfiltered request would distinct-scan every tenant's completed jobs —
  // reject it and make the caller pick a tenant first.
  const scope = resolveListTenantScope(req, res, queryTenantId, { requireTenant: true });
  if (!scope.ok) return;

  const conditions: SQL[] = [];
  if (scope.tenantId) conditions.push(eq(jobsTable.tenantId, scope.tenantId));
  conditions.push(eq(jobsTable.status, "completed"));
  if (startDate) conditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
  if (endDate) conditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);

  const where = and(...conditions);

  const rows = await db
    .selectDistinct({ funnel: funnelNameExpr, source: leadsTable.source, matchLevel: jobsTable.matchLevel })
    .from(jobsTable)
    .leftJoin(leadsTable, eq(jobsTable.leadId, leadsTable.id))
    .leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id))
    .where(where);

  const funnels = [...new Set(rows.map((r) => r.funnel).filter((v): v is string => !!v && v.trim() !== ""))].sort(
    (a, b) => a.localeCompare(b),
  );
  const sources = [...new Set(rows.map((r) => r.source).filter((v): v is string => !!v && v.trim() !== ""))].sort(
    (a, b) => a.localeCompare(b),
  );
  // Match tiers present in the range. NULL matchLevel folds into the
  // "unmatched" bucket so it mirrors the Attributed math + the filter; blank/
  // whitespace tiers are dropped (like funnels/sources) so the dropdown never
  // offers an unfilterable empty option. Sorted by tier strength (diamond →
  // unmatched) rather than alphabetically.
  const matchLevels = [
    ...new Set(
      rows
        .map((r) => (r.matchLevel == null ? UNMATCHED_TIER : r.matchLevel.trim().toLowerCase()))
        .filter((v) => v !== ""),
    ),
  ].sort((a, b) => matchLevelRank(a) - matchLevelRank(b) || a.localeCompare(b));

  res.json({ funnels, sources, matchLevels });
});

// Typeahead lead search for manual job→lead matching. Agency/admin only —
// the manual-match feature is agency-only (see PATCH below). Results are
// tenant-scoped: a tenantId must be supplied (the job's tenant) so the
// search never returns leads from another agency client.
router.get("/drilldown/leads/search", async (req, res) => {
  const role = (req.session as { userRole?: string } | undefined)?.userRole;
  const isAgency = role === "super_admin" || role === "agency_user";
  if (!isAgency) {
    res.status(403).json({ error: "Only agency users can search leads for matching." });
    return;
  }

  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  if (queryTenantId == null || !Number.isFinite(queryTenantId)) {
    res.status(400).json({ error: "A tenantId is required to scope the lead search." });
    return;
  }

  const q = ((req.query.q as string | undefined) ?? "").trim();
  const limit = Math.min(req.query.limit ? Number(req.query.limit) : 10, 25);
  if (q.length < 2) {
    res.json([]);
    return;
  }

  const term = `%${q}%`;
  const match = or(
    ilike(leadsTable.firstName, term),
    ilike(leadsTable.lastName, term),
    ilike(leadsTable.phone, term),
    ilike(leadsTable.email, term),
    ilike(sql`${leadsTable.firstName} || ' ' || ${leadsTable.lastName}`, term),
  );

  const leads = await db.select({
    id: leadsTable.id,
    firstName: leadsTable.firstName,
    lastName: leadsTable.lastName,
    phone: leadsTable.phone,
    email: leadsTable.email,
    source: leadsTable.source,
    status: leadsTable.status,
    createdAt: leadsTable.createdAt,
  }).from(leadsTable)
    .where(and(eq(leadsTable.tenantId, queryTenantId), match))
    .orderBy(desc(leadsTable.createdAt))
    .limit(limit);

  res.json(leads);
});

// Manually match a job to the correct lead when attribution is wrong/missing.
// Agency/admin only — clients have read-only access to revenue attribution.
router.patch("/drilldown/jobs/:id/lead", async (req, res) => {
  const role = (req.session as { userRole?: string } | undefined)?.userRole;
  const isAgency = role === "super_admin" || role === "agency_user";
  if (!isAgency) {
    res.status(403).json({ error: "Only agency users can manually match jobs to leads." });
    return;
  }

  const jobId = Number(req.params.id);
  if (!Number.isFinite(jobId)) { res.status(400).json({ error: "Invalid job id" }); return; }

  const rawLeadId = req.body?.leadId;
  const leadId = rawLeadId == null ? null : Number(rawLeadId);
  if (leadId != null && !Number.isFinite(leadId)) {
    res.status(400).json({ error: "Invalid leadId" });
    return;
  }

  const [job] = await db.select({ id: jobsTable.id, tenantId: jobsTable.tenantId }).from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  const jobAccess = assertResourceTenantAccess(req, res, job.tenantId, {
    notFoundOnMismatch: true, notFoundMessage: "Job not found",
  });
  if (!jobAccess.ok) return;

  if (leadId != null) {
    const [lead] = await db.select({ id: leadsTable.id, tenantId: leadsTable.tenantId }).from(leadsTable)
      .where(eq(leadsTable.id, leadId));
    if (!lead || lead.tenantId !== job.tenantId) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
  }

  const [updated] = await db.update(jobsTable)
    .set({ leadId, matchLevel: leadId != null ? "manual" : null, updatedAt: new Date() })
    .where(eq(jobsTable.id, jobId))
    .returning();

  res.json(updated);
});

export default router;
