import { Router, type IRouter } from "express";
import { db, leadsTable, jobsTable, soldEstimatesTable, type RebateBreakdownItem } from "@workspace/db";
import { eq, and, gte, lte, desc, SQL, inArray, sql, or, ilike } from "drizzle-orm";
import { resolveListTenantScope, assertResourceTenantAccess } from "../lib/tenant-scope";

// Matches the date expression used by /api/dashboard/spend-revenue so the
// drilldown returns the same jobs that the chart's revenue bar aggregated.
const jobDateExpr = sql`COALESCE(${jobsTable.invoiceDate}, ${jobsTable.completedAt}, ${jobsTable.createdAt})`;
const jobRevenueExpr = sql<number>`COALESCE(${jobsTable.invoiceTotal} + COALESCE(${jobsTable.invoiceRebateAmount}, 0), ${jobsTable.revenue})`;

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

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;

  const conditions: SQL[] = [];
  if (scope.tenantId) conditions.push(eq(jobsTable.tenantId, scope.tenantId));
  conditions.push(eq(jobsTable.status, "completed"));
  if (startDate) conditions.push(sql`${jobDateExpr} >= ${new Date(startDate)}`);
  if (endDate) conditions.push(sql`${jobDateExpr} <= ${new Date(endDate)}`);

  const where = and(...conditions);
  const baseQuery = db.select().from(jobsTable).where(where).orderBy(desc(jobRevenueExpr));
  const jobs =
    limit == null
      ? await baseQuery
      : offset > 0
        ? await baseQuery.limit(limit).offset(offset)
        : await baseQuery.limit(limit);

  // Total matching completed jobs for the range, independent of paging. Exposed
  // as a response header so both the paged UI (to show "X of N" + a real page
  // count) and the CSV export keep receiving a plain JSON array body.
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(jobsTable)
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
    return {
      id: job.id,
      tenantId: job.tenantId,
      stJobId: job.stJobId,
      stInvoiceId: job.stInvoiceId,
      customerName: job.customerName,
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
          }
        : null,
    };
  });

  res.json(result);
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
