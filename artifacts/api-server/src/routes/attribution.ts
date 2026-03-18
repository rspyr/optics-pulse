import { Router, type IRouter } from "express";
import { db, attributionEventsTable } from "@workspace/db";
import { eq, and, count, desc, SQL } from "drizzle-orm";
import { ListAttributionEventsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/attribution/events", async (req, res) => {
  const query = ListAttributionEventsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  if (query.tenantId) conditions.push(eq(attributionEventsTable.tenantId, query.tenantId));
  if (query.matchLevel) conditions.push(eq(attributionEventsTable.matchLevel, query.matchLevel as any));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const [events, [totalResult]] = await Promise.all([
    db.select().from(attributionEventsTable).where(where).orderBy(desc(attributionEventsTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: count() }).from(attributionEventsTable).where(where),
  ]);

  res.json({ events, total: totalResult.count });
});

export default router;
