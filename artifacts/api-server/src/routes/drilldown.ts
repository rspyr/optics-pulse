import { Router, type IRouter } from "express";
import { db, leadsTable, jobsTable, soldEstimatesTable, funnelTypesTable, type RebateBreakdownItem } from "@workspace/db";
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

const router: IRouter = Router();

router.get("/drilldown/leads", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const status = req.query.status as string | undefined;
  const source = req.query.source as string | undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const offset = req.query.offset ? Number(req.query.offset) : 0;

  const scope = resolveListTenantScope(req, res, queryTenantId);
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
  const leads = await db.select().from(leadsTable).where(where)
    .orderBy(desc(leadsTable.createdAt)).limit(limit).offset(offset);

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

  const scope = resolveListTenantScope(req, res, queryTenantId);
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
  const jobs = await db.select().from(jobsTable).where(where)
    .orderBy(orderBy).limit(limit).offset(offset);

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

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;

  const conditions: SQL[] = [];
  if (scope.tenantId) conditions.push(eq(jobsTable.tenantId, scope.tenantId));
  conditions.push(eq(jobsTable.status, "completed"));
  if (startDate) conditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
  if (endDate) conditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);
  if (funnel) conditions.push(sql`${funnelNameExpr} = ${funnel}`);
  if (source) conditions.push(eq(leadsTable.source, source));

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

  // Sold estimates carry the itemized rebate breakdown + salesperson name.
  const estimates = jobIds.length > 0
    ? await db.select().from(soldEstimatesTable).where(inArray(soldEstimatesTable.jobId, jobIds))
    : [];
  const estimateByJobId = new Map<number, typeof estimates[number]>();
  for (const est of estimates) {
    if (est.jobId == null) continue;
    const existing = estimateByJobId.get(est.jobId);
    // Prefer the estimate with the largest rebate breakdown (most informative).
    if (!existing || (est.rebateAmount ?? 0) > (existing.rebateAmount ?? 0)) {
      estimateByJobId.set(est.jobId, est);
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
      }).from(leadsTable).where(inArray(leadsTable.id, leadIds))
    : [];
  const leadById = new Map(leads.map((l) => [l.id, l]));

  const result = jobs.map((job) => {
    const est = estimateByJobId.get(job.id);
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

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;

  const conditions: SQL[] = [];
  if (scope.tenantId) conditions.push(eq(jobsTable.tenantId, scope.tenantId));
  conditions.push(eq(jobsTable.status, "completed"));
  if (startDate) conditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
  if (endDate) conditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);
  if (funnel) conditions.push(sql`${funnelNameExpr} = ${funnel}`);
  if (source) conditions.push(eq(leadsTable.source, source));

  const where = and(...conditions);

  const [agg] = await db
    .select({
      revenue: sql<number>`COALESCE(SUM(${jobRevenueExpr}), 0)`,
      rebates: sql<number>`COALESCE(SUM(COALESCE(${jobsTable.invoiceRebateAmount}, 0)), 0)`,
      attributed: sql<number>`COALESCE(SUM(CASE WHEN ${jobsTable.matchLevel} IS NOT NULL THEN ${jobRevenueExpr} ELSE 0 END), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(jobsTable)
    .leftJoin(leadsTable, eq(jobsTable.leadId, leadsTable.id))
    .leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id))
    .where(where);

  res.json({
    revenue: round2(Number(agg?.revenue ?? 0)),
    rebates: round2(Number(agg?.rebates ?? 0)),
    attributed: round2(Number(agg?.attributed ?? 0)),
    count: Number(agg?.count ?? 0),
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

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;

  const conditions: SQL[] = [];
  if (scope.tenantId) conditions.push(eq(jobsTable.tenantId, scope.tenantId));
  conditions.push(eq(jobsTable.status, "completed"));
  if (startDate) conditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
  if (endDate) conditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);

  const where = and(...conditions);

  const rows = await db
    .selectDistinct({ funnel: funnelNameExpr, source: leadsTable.source })
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

  res.json({ funnels, sources });
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
