import { db, userLoginSessionsTable } from "@workspace/db";
import { eq, and, sql, gte, lte, or, isNull } from "drizzle-orm";

export async function getLoggedInSeconds(
  userId: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const [result] = await db.select({
    totalSeconds: sql<number>`COALESCE(SUM(
      EXTRACT(EPOCH FROM (
        LEAST(COALESCE(${userLoginSessionsTable.logoutAt}, NOW()), ${windowEnd}::timestamp)
        - GREATEST(${userLoginSessionsTable.loginAt}, ${windowStart}::timestamp)
      ))
    ), 0)`,
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

  return Math.max(0, Math.round(Number(result?.totalSeconds ?? 0)));
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

  const userIds = [...new Set(leads.map(l => l.userId))];

  const sessionCountRows = await db.select({
    userId: userLoginSessionsTable.userId,
    sessionCount: sql<number>`COUNT(*)`.as("session_count"),
  })
    .from(userLoginSessionsTable)
    .where(sql`${userLoginSessionsTable.userId} IN (${sql.join(userIds.map(id => sql`${id}`), sql`, `)})`)
    .groupBy(userLoginSessionsTable.userId);

  const sessionCountByUser: Record<number, number> = {};
  for (const row of sessionCountRows) {
    sessionCountByUser[row.userId] = Number(row.sessionCount);
  }

  const results: LeadSpeedResult[] = [];

  const leadsNeedingOverlap: LeadSpeedWindow[] = [];
  for (const lead of leads) {
    if ((sessionCountByUser[lead.userId] ?? 0) === 0) {
      results.push({ leadId: lead.leadId, userId: lead.userId, speed: lead.wallClockSpeed });
    } else {
      leadsNeedingOverlap.push(lead);
    }
  }

  const CHUNK_SIZE = 50;
  for (let i = 0; i < leadsNeedingOverlap.length; i += CHUNK_SIZE) {
    const chunk = leadsNeedingOverlap.slice(i, i + CHUNK_SIZE);

    const overlapValues: Record<number, number> = {};
    for (const lead of chunk) {
      const overlap = await getLoggedInSeconds(lead.userId, lead.assignedAt, lead.firstTouchAt);
      overlapValues[lead.leadId] = overlap;
    }

    for (const lead of chunk) {
      const overlapSeconds = overlapValues[lead.leadId] ?? 0;
      results.push({
        leadId: lead.leadId,
        userId: lead.userId,
        speed: overlapSeconds,
      });
    }
  }

  return results;
}
