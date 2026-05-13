import { Router, type IRouter } from "express";
import { db, jobsTable } from "@workspace/db";
import { eq, and, count, desc, SQL } from "drizzle-orm";
import { ListJobsQueryParams } from "@workspace/api-zod";
import { resolveListTenantScope } from "../lib/tenant-scope";

const router: IRouter = Router();

router.get("/jobs", async (req, res) => {
  const query = ListJobsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  const scope = resolveListTenantScope(req, res, query.tenantId);
  if (!scope.ok) return;
  if (scope.tenantId) conditions.push(eq(jobsTable.tenantId, scope.tenantId));
  if (query.status) {
    const status = query.status as "pending" | "in_progress" | "completed" | "cancelled";
    conditions.push(eq(jobsTable.status, status));
  }

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
