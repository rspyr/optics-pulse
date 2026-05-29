import { Router, type IRouter } from "express";
import { db, jobsTable } from "@workspace/db";
import { eq, and, count, desc, SQL } from "drizzle-orm";
import { ListJobsQueryParams } from "@workspace/api-zod";
import { resolveListTenantScope } from "../lib/tenant-scope";

const router: IRouter = Router();

router.get("/jobs", async (req, res) => {
  const query = ListJobsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  const scope = resolveListTenantScope(req, res, query.tenantId, { requireTenant: true });
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
    // Append the unique primary key as a deterministic tiebreaker so paging is
    // stable under LIMIT/OFFSET. createdAt ties (bulk imports stamp the same
    // timestamp), and Postgres gives no guaranteed order among rows the ORDER BY
    // can't distinguish — so without a unique secondary key, adjacent pages can
    // overlap (a tied row served twice) or skip rows. jobs.id is unique +
    // monotonic, so appending it in the same direction gives a total order.
    db.select().from(jobsTable).where(where).orderBy(desc(jobsTable.createdAt), desc(jobsTable.id)).limit(limit).offset(offset),
    db.select({ count: count() }).from(jobsTable).where(where),
  ]);

  res.json({ jobs, total: totalResult.count });
});

export default router;
