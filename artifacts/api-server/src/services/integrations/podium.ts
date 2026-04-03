import { db, reviewsTable, reviewDailyStatsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

interface PodiumConfig {
  apiToken: string;
  locationId: string;
}

interface PodiumReview {
  uid: string;
  reviewerName: string;
  rating: number;
  body: string;
  publishDate: string;
}

export async function fetchPodiumReviews(
  config: PodiumConfig,
  sinceDate?: string,
): Promise<PodiumReview[]> {
  const url = new URL("https://api.podium.com/v4/reviews");
  url.searchParams.set("locationUid", config.locationId);
  if (sinceDate) {
    url.searchParams.set("startDate", sinceDate);
  }
  url.searchParams.set("limit", "100");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      Accept: "application/json",
      "podium-version": "2024-04-01",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Podium API error ${res.status}: ${text}`);
  }

  const data = await res.json() as { data?: Record<string, unknown>[]; reviews?: Record<string, unknown>[] };
  return (data.data || data.reviews || []).map((r: Record<string, unknown>) => ({
    uid: String(r.uid || r.id || ""),
    reviewerName: String(r.reviewerName || r.reviewer_name || "Anonymous"),
    rating: Number(r.rating || r.starRating || 0),
    body: String(r.body || r.comment || ""),
    publishDate: String(r.publishDate || r.publish_date || r.createdAt || new Date().toISOString()),
  }));
}

function classifySentiment(rating: number, body: string): string {
  if (rating >= 4) return "positive";
  if (rating <= 2) return "negative";
  const lower = body.toLowerCase();
  if (lower.includes("great") || lower.includes("excellent") || lower.includes("amazing")) return "positive";
  if (lower.includes("terrible") || lower.includes("awful") || lower.includes("worst")) return "negative";
  return "neutral";
}

export async function syncPodiumReviews(
  tenantId: number,
  config: PodiumConfig,
): Promise<{ synced: number; newReviews: number }> {
  const sinceDate = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];

  let reviews: PodiumReview[];
  try {
    reviews = await fetchPodiumReviews(config, sinceDate);
  } catch (err) {
    console.error(`[Podium] Fetch error for tenant ${tenantId}:`, err);
    return { synced: 0, newReviews: 0 };
  }

  let newReviews = 0;
  for (const review of reviews) {
    const existing = await db.select().from(reviewsTable)
      .where(and(
        eq(reviewsTable.tenantId, tenantId),
        eq(reviewsTable.externalId, review.uid),
      ))
      .limit(1);

    if (existing.length === 0) {
      const reviewDate = review.publishDate.split("T")[0];
      await db.insert(reviewsTable).values({
        tenantId,
        platform: "podium",
        externalId: review.uid,
        reviewerName: review.reviewerName,
        rating: review.rating,
        body: review.body,
        sentiment: classifySentiment(review.rating, review.body),
        reviewDate,
      });
      newReviews++;
    }
  }

  await refreshDailyStats(tenantId);

  console.log(`[Podium] Synced ${reviews.length} reviews for tenant ${tenantId} (${newReviews} new)`);
  return { synced: reviews.length, newReviews };
}

async function refreshDailyStats(tenantId: number) {
  const result = await db.execute(sql`
    SELECT 
      review_date,
      COUNT(*)::int AS total,
      AVG(rating)::real AS avg_rating,
      COUNT(*) FILTER (WHERE sentiment = 'positive')::int AS positive,
      COUNT(*) FILTER (WHERE sentiment = 'negative')::int AS negative,
      COUNT(*) FILTER (WHERE sentiment = 'neutral')::int AS neutral
    FROM reviews
    WHERE tenant_id = ${tenantId}
    GROUP BY review_date
    ORDER BY review_date DESC
    LIMIT 90
  `);

  for (const row of result.rows) {
    const r = row as Record<string, unknown>;
    const dateStr = String(r.review_date);
    const existing = await db.select().from(reviewDailyStatsTable)
      .where(and(
        eq(reviewDailyStatsTable.tenantId, tenantId),
        eq(reviewDailyStatsTable.date, dateStr),
      ))
      .limit(1);

    const values = {
      totalReviews: Number(r.total) || 0,
      averageRating: Number(r.avg_rating) || null,
      positiveCount: Number(r.positive) || 0,
      negativeCount: Number(r.negative) || 0,
      neutralCount: Number(r.neutral) || 0,
    };

    if (existing.length > 0) {
      await db.update(reviewDailyStatsTable).set(values).where(eq(reviewDailyStatsTable.id, existing[0].id));
    } else {
      await db.insert(reviewDailyStatsTable).values({ tenantId, date: dateStr, ...values });
    }
  }
}

export function parsePodiumWebhookPayload(body: Record<string, unknown>): {
  externalId: string;
  reviewerName: string;
  rating: number;
  reviewBody: string;
  reviewDate: string;
} | null {
  try {
    const data = (body.data || body) as Record<string, unknown>;
    return {
      externalId: String(data.uid || data.id || ""),
      reviewerName: String(data.reviewerName || data.reviewer_name || "Anonymous"),
      rating: Number(data.rating || data.starRating || 0),
      reviewBody: String(data.body || data.comment || ""),
      reviewDate: String(data.publishDate || data.publish_date || new Date().toISOString()).split("T")[0],
    };
  } catch {
    return null;
  }
}
