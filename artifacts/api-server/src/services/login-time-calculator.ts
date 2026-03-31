import { db, userLoginSessionsTable } from "@workspace/db";
import { eq, and, sql, gte, lte, or, isNull } from "drizzle-orm";

export async function getLoggedInSecondsWithCoverage(
  userId: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ seconds: number; hasCoverage: boolean }> {
  const windowSeconds = Math.max(0, (windowEnd.getTime() - windowStart.getTime()) / 1000);

  const [result] = await db.execute(sql`
    WITH clipped AS (
      SELECT
        GREATEST(login_at, ${windowStart}::timestamp) AS seg_start,
        LEAST(COALESCE(logout_at, NOW()), ${windowEnd}::timestamp) AS seg_end
      FROM user_login_sessions
      WHERE user_id = ${userId}
        AND login_at <= ${windowEnd}::timestamp
        AND (logout_at IS NULL OR logout_at >= ${windowStart}::timestamp)
    ),
    ordered AS (
      SELECT seg_start, seg_end,
        MAX(seg_end) OVER (ORDER BY seg_start ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max_end
      FROM clipped
    ),
    merged AS (
      SELECT
        CASE WHEN seg_start > COALESCE(prev_max_end, '-infinity'::timestamp)
          THEN seg_start ELSE COALESCE(prev_max_end, seg_start) END AS merged_start,
        seg_end
      FROM ordered
      WHERE seg_end > COALESCE(prev_max_end, '-infinity'::timestamp)
    )
    SELECT
      COALESCE(SUM(EXTRACT(EPOCH FROM (seg_end - merged_start))), 0) AS total_seconds,
      COUNT(*) AS session_count
    FROM merged
  `);

  const row = (result as Record<string, unknown>);
  const sessionCount = Number(row?.session_count ?? 0);
  const totalSeconds = Math.min(
    Math.max(0, Math.round(Number(row?.total_seconds ?? 0))),
    windowSeconds,
  );

  return {
    seconds: totalSeconds,
    hasCoverage: sessionCount > 0,
  };
}

export interface LeadSpeedWindow {
  leadId: number;
  userId: number;
  assignedAt: Date;
  firstTouchAt: Date;
  wallClockSpeed: number;
}

export interface LeadSpeedResult {
  leadId: number;
  userId: number;
  speed: number;
}

export async function computeLoginAwareSpeeds(
  leads: LeadSpeedWindow[],
): Promise<LeadSpeedResult[]> {
  if (leads.length === 0) return [];

  const results: LeadSpeedResult[] = [];

  for (const lead of leads) {
    const { seconds, hasCoverage } = await getLoggedInSecondsWithCoverage(
      lead.userId,
      lead.assignedAt,
      lead.firstTouchAt,
    );

    results.push({
      leadId: lead.leadId,
      userId: lead.userId,
      speed: hasCoverage ? seconds : lead.wallClockSpeed,
    });
  }

  return results;
}
