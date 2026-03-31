import { db, userLoginSessionsTable } from "@workspace/db";
import { eq, and, sql, gte, lte, or, isNull } from "drizzle-orm";

export async function getLoggedInSecondsWithCoverage(
  userId: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ seconds: number; hasCoverage: boolean }> {
  const [result] = await db.select({
    totalSeconds: sql<number>`COALESCE(SUM(
      EXTRACT(EPOCH FROM (
        LEAST(COALESCE(${userLoginSessionsTable.logoutAt}, NOW()), ${windowEnd}::timestamp)
        - GREATEST(${userLoginSessionsTable.loginAt}, ${windowStart}::timestamp)
      ))
    ), 0)`,
    sessionCount: sql<number>`COUNT(*)`,
  })
    .from(userLoginSessionsTable)
    .where(and(
      eq(userLoginSessionsTable.userId, userId),
      lte(userLoginSessionsTable.loginAt, windowEnd),
      or(
        isNull(userLoginSessionsTable.logoutAt),
        gte(userLoginSessionsTable.logoutAt, windowStart),
      ),
    ));

  const sessionCount = Number(result?.sessionCount ?? 0);
  const totalSeconds = Math.max(0, Math.round(Number(result?.totalSeconds ?? 0)));

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
