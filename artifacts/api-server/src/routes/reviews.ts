import { Router, type IRouter } from "express";
import { db, reviewsTable, reviewDailyStatsTable } from "@workspace/db";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { parsePodiumWebhookPayload } from "../services/integrations/podium";

const router: IRouter = Router();

router.get("/reviews", async (req, res) => {
  const tenantId = req.session.tenantId;
  if (!tenantId) { res.status(403).json({ error: "Tenant required" }); return; }

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const reviews = await db.select().from(reviewsTable)
    .where(eq(reviewsTable.tenantId, tenantId))
    .orderBy(desc(reviewsTable.reviewDate))
    .limit(limit);

  res.json(reviews);
});

router.get("/reviews/stats", async (req, res) => {
  const tenantId = req.session.tenantId;
  if (!tenantId) { res.status(403).json({ error: "Tenant required" }); return; }

  const startDate = req.query.startDate as string || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const endDate = req.query.endDate as string || new Date().toISOString().split("T")[0];

  const stats = await db.select().from(reviewDailyStatsTable)
    .where(and(
      eq(reviewDailyStatsTable.tenantId, tenantId),
      gte(reviewDailyStatsTable.date, startDate),
      lte(reviewDailyStatsTable.date, endDate),
    ))
    .orderBy(reviewDailyStatsTable.date);

  const summary = await db.select({
    total: sql<number>`COUNT(*)::int`,
    avgRating: sql<number>`AVG(rating)::real`,
    positive: sql<number>`COUNT(*) FILTER (WHERE sentiment = 'positive')::int`,
    negative: sql<number>`COUNT(*) FILTER (WHERE sentiment = 'negative')::int`,
  }).from(reviewsTable)
    .where(and(
      eq(reviewsTable.tenantId, tenantId),
      gte(reviewsTable.reviewDate, startDate),
      lte(reviewsTable.reviewDate, endDate),
    ));

  res.json({
    dailyStats: stats,
    summary: summary[0] || { total: 0, avgRating: null, positive: 0, negative: 0 },
  });
});


router.get("/reviews/leaderboard", requireRole("super_admin", "agency_user"), async (_req, res) => {
  const result = await db.execute(sql`
    SELECT 
      r.tenant_id,
      t.name AS tenant_name,
      COUNT(*)::int AS total_reviews,
      AVG(r.rating)::real AS avg_rating,
      COUNT(*) FILTER (WHERE r.sentiment = 'positive')::int AS positive_count,
      COUNT(*) FILTER (WHERE r.rating = 5)::int AS five_star_count
    FROM reviews r
    JOIN tenants t ON r.tenant_id = t.id
    WHERE r.review_date >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY r.tenant_id, t.name
    ORDER BY avg_rating DESC, total_reviews DESC
  `);

  res.json(result.rows);
});

export default router;
