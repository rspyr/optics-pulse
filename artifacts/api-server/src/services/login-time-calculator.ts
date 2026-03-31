import { db, userLoginSessionsTable } from "@workspace/db";
import { eq, and, sql, gte, lte, or, isNull } from "drizzle-orm";

export async function getLoggedInSecondsWithCoverage(
  userId: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ seconds: number; hasCoverage: boolean }> {
  const windowSeconds = Math.max(0, (windowEnd.getTime() - windowStart.getTime()) / 1000);

  const overlappingSessions = await db.select({
    segStart: sql<Date>`GREATEST(${userLoginSessionsTable.loginAt}, ${windowStart}::timestamp)`.as("seg_start"),
    segEnd: sql<Date>`LEAST(COALESCE(${userLoginSessionsTable.logoutAt}, NOW()), ${windowEnd}::timestamp)`.as("seg_end"),
  })
    .from(userLoginSessionsTable)
    .where(and(
      eq(userLoginSessionsTable.userId, userId),
      lte(userLoginSessionsTable.loginAt, windowEnd),
      or(
        isNull(userLoginSessionsTable.logoutAt),
        gte(userLoginSessionsTable.logoutAt, windowStart),
      ),
    ))
    .orderBy(sql`seg_start ASC`);

  if (overlappingSessions.length === 0) {
    return { seconds: 0, hasCoverage: false };
  }

  const segments = overlappingSessions.map(s => ({
    start: new Date(s.segStart).getTime(),
    end: new Date(s.segEnd).getTime(),
  }));

  let totalMs = 0;
  let mergedEnd = -Infinity;

  for (const seg of segments) {
    if (seg.start >= mergedEnd) {
      totalMs += seg.end - seg.start;
      mergedEnd = seg.end;
    } else if (seg.end > mergedEnd) {
      totalMs += seg.end - mergedEnd;
      mergedEnd = seg.end;
    }
  }

  const totalSeconds = Math.min(
    Math.max(0, Math.round(totalMs / 1000)),
    Math.round(windowSeconds),
  );

  return {
    seconds: totalSeconds,
    hasCoverage: true,
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
