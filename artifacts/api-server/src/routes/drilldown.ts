import { Router, type IRouter } from "express";
import { db, leadsTable, jobsTable } from "@workspace/db";
import { eq, and, gte, lte, desc, SQL, inArray } from "drizzle-orm";

const router: IRouter = Router();

router.get("/drilldown/leads", async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const status = req.query.status as string | undefined;
  const source = req.query.source as string | undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const offset = req.query.offset ? Number(req.query.offset) : 0;

  const conditions: SQL[] = [];
  if (tenantId) conditions.push(eq(leadsTable.tenantId, tenantId));
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
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const status = req.query.status as string | undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const offset = req.query.offset ? Number(req.query.offset) : 0;

  const conditions: SQL[] = [];
  if (tenantId) conditions.push(eq(jobsTable.tenantId, tenantId));
  if (startDate) conditions.push(gte(jobsTable.createdAt, new Date(startDate)));
  if (endDate) conditions.push(lte(jobsTable.createdAt, new Date(endDate + "T23:59:59.999Z")));
  if (status) conditions.push(eq(jobsTable.status, status as "pending" | "in_progress" | "completed" | "cancelled"));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const jobs = await db.select().from(jobsTable).where(where)
    .orderBy(desc(jobsTable.createdAt)).limit(limit).offset(offset);

  res.json(jobs);
});

export default router;
