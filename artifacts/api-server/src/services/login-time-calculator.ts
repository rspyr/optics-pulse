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

export async function getLoggedInSecondsForLeads(
  userId: number,
  leads: { leadId: number; assignedAt: Date; firstTouchAt: Date }[],
): Promise<Record<number, number>> {
  if (leads.length === 0) return {};

  const result: Record<number, number> = {};
  for (const lead of leads) {
    result[lead.leadId] = await getLoggedInSeconds(userId, lead.assignedAt, lead.firstTouchAt);
  }
  return result;
}

export async function hasAnyLoginSessions(userId: number): Promise<boolean> {
  const [result] = await db.select({
    count: sql<number>`COUNT(*)`,
  })
    .from(userLoginSessionsTable)
    .where(eq(userLoginSessionsTable.userId, userId))
    .limit(1);

  return Number(result?.count ?? 0) > 0;
}
