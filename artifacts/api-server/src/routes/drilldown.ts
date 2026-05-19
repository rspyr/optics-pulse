import { Router, type IRouter } from "express";
import { db, leadsTable, jobsTable } from "@workspace/db";
import { eq, and, gte, lte, desc, SQL, inArray, sql } from "drizzle-orm";
import { resolveListTenantScope } from "../lib/tenant-scope";

// Matches the date expression used by /api/dashboard/spend-revenue so the
// drilldown returns the same jobs that the chart's revenue bar aggregated.
const jobDateExpr = sql`COALESCE(${jobsTable.invoiceDate}, ${jobsTable.completedAt}, ${jobsTable.createdAt})`;
const jobRevenueExpr = sql<number>`COALESCE(${jobsTable.invoiceTotal} + COALESCE(${jobsTable.invoiceRebateAmount}, 0), ${jobsTable.revenue})`;

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

  res.json(jobs);
});

export default router;
