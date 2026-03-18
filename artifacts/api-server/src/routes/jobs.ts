import { Router, type IRouter } from "express";
import { db, jobsTable } from "@workspace/db";
import { eq, and, count, desc, SQL } from "drizzle-orm";
import { ListJobsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/jobs", async (req, res) => {
  const query = ListJobsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  if (query.tenantId) conditions.push(eq(jobsTable.tenantId, query.tenantId));
  if (query.status) conditions.push(eq(jobsTable.status, query.status as any));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const [jobs, [totalResult]] = await Promise.all([
    db.select().from(jobsTable).where(where).orderBy(desc(jobsTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: count() }).from(jobsTable).where(where),
  ]);

  res.json({ jobs, total: totalResult.count });
});

export default router;
