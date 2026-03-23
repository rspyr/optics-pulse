import { db, callAttemptsTable, leadsTable, usersTable, coordinatorDailyStatsTable } from "@workspace/db";
import { eq, and, sql, gte, count, inArray, desc } from "drizzle-orm";

interface CoachingInsight {
  type: "positive" | "warning" | "suggestion";
  title: string;
  detail: string;
  coordinatorId?: number;
  coordinatorName?: string;
  metric?: string;
  value?: number;
}

export async function generateCoachingInsights(tenantId: number): Promise<CoachingInsight[]> {
  const insights: CoachingInsight[] = [];

  const users = await db.select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.tenantId, tenantId));

  if (users.length === 0) return insights;
  const userIds = users.map(u => u.id);
  const userMap = Object.fromEntries(users.map(u => [u.id, u.name]));

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysStr = thirtyDaysAgo.toISOString().split("T")[0];

  const recentStats = await db.select()
    .from(coordinatorDailyStatsTable)
    .where(and(
      eq(coordinatorDailyStatsTable.tenantId, tenantId),
      gte(coordinatorDailyStatsTable.date, thirtyDaysStr),
    ));

  const statsByUser: Record<number, typeof recentStats> = {};
  for (const s of recentStats) {
    if (!statsByUser[s.userId]) statsByUser[s.userId] = [];
    statsByUser[s.userId].push(s);
  }

  for (const userId of userIds) {
    const userStats = statsByUser[userId] || [];
    if (userStats.length < 2) continue;
    const name = userMap[userId];

    const avgRate = userStats.reduce((sum, s) => sum + s.bookingRate, 0) / userStats.length;
    const avgCalls = userStats.reduce((sum, s) => sum + s.callsMade, 0) / userStats.length;
    const avgSpeed = userStats.reduce((sum, s) => sum + s.avgSpeedToLead, 0) / userStats.length;

    if (avgRate >= 40) {
      insights.push({
        type: "positive",
        title: `${name} is a top performer`,
        detail: `Averaging ${Math.round(avgRate)}% booking rate over the last ${userStats.length} days. Consider having them mentor newer team members.`,
        coordinatorId: userId,
        coordinatorName: name,
        metric: "bookingRate",
        value: Math.round(avgRate),
      });
    }

    if (avgRate < 15 && avgCalls > 3) {
      insights.push({
        type: "warning",
        title: `${name} has a low booking rate`,
        detail: `Only ${Math.round(avgRate)}% booking rate despite averaging ${Math.round(avgCalls)} calls/day. Review their call approach and script adherence.`,
        coordinatorId: userId,
        coordinatorName: name,
        metric: "bookingRate",
        value: Math.round(avgRate),
      });
    }

    if (avgSpeed > 300) {
      insights.push({
        type: "warning",
        title: `${name}'s speed-to-lead needs improvement`,
        detail: `Average speed-to-lead is ${Math.round(avgSpeed / 60)}m ${Math.round(avgSpeed % 60)}s. Industry best practice is under 5 minutes.`,
        coordinatorId: userId,
        coordinatorName: name,
        metric: "avgSpeedToLead",
        value: Math.round(avgSpeed),
      });
    }

    const recent7 = userStats.slice(-7);
    const prior7 = userStats.slice(-14, -7);
    if (recent7.length >= 3 && prior7.length >= 3) {
      const recentAvgRate = recent7.reduce((s, r) => s + r.bookingRate, 0) / recent7.length;
      const priorAvgRate = prior7.reduce((s, r) => s + r.bookingRate, 0) / prior7.length;
      const diff = recentAvgRate - priorAvgRate;
      if (diff < -10) {
        insights.push({
          type: "warning",
          title: `${name}'s booking rate is declining`,
          detail: `Down ${Math.abs(Math.round(diff))} percentage points week-over-week (${Math.round(priorAvgRate)}% → ${Math.round(recentAvgRate)}%). Consider a 1:1 coaching session.`,
          coordinatorId: userId,
          coordinatorName: name,
          metric: "bookingRate",
          value: Math.round(diff),
        });
      } else if (diff > 10) {
        insights.push({
          type: "positive",
          title: `${name}'s booking rate is trending up`,
          detail: `Up ${Math.round(diff)} percentage points week-over-week (${Math.round(priorAvgRate)}% → ${Math.round(recentAvgRate)}%). Great improvement!`,
          coordinatorId: userId,
          coordinatorName: name,
          metric: "bookingRate",
          value: Math.round(diff),
        });
      }
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sourceBreakdown = await db.select({
    source: leadsTable.source,
    total: count(),
    booked: sql<number>`SUM(CASE WHEN ${leadsTable.status} IN ('booked', 'sold') THEN 1 ELSE 0 END)`,
  }).from(leadsTable)
    .where(and(
      eq(leadsTable.tenantId, tenantId),
      gte(leadsTable.createdAt, thirtyDaysAgo),
    ))
    .groupBy(leadsTable.source);

  for (const src of sourceBreakdown) {
    const total = Number(src.total);
    const booked = Number(src.booked);
    if (total < 5) continue;
    const rate = Math.round((booked / total) * 100);

    if (rate < 10) {
      insights.push({
        type: "suggestion",
        title: `${src.source} leads have low conversion`,
        detail: `Only ${rate}% booking rate from ${src.source} (${booked}/${total} leads). Review the ${src.source} call script or lead quality.`,
        metric: "sourceBookingRate",
        value: rate,
      });
    }
    if (rate > 40) {
      insights.push({
        type: "positive",
        title: `${src.source} leads convert well`,
        detail: `${rate}% booking rate from ${src.source} (${booked}/${total} leads). Consider increasing spend on this channel.`,
        metric: "sourceBookingRate",
        value: rate,
      });
    }
  }

  const teamAvgSpeed = recentStats.length > 0
    ? recentStats.reduce((s, r) => s + r.avgSpeedToLead, 0) / recentStats.length
    : 0;

  if (teamAvgSpeed > 0) {
    const speedMin = Math.floor(teamAvgSpeed / 60);
    const speedSec = Math.round(teamAvgSpeed % 60);
    insights.push({
      type: teamAvgSpeed > 300 ? "warning" : teamAvgSpeed > 180 ? "suggestion" : "positive",
      title: `Team average speed-to-lead: ${speedMin}m ${speedSec}s`,
      detail: teamAvgSpeed > 300
        ? "Well above the 5-minute industry benchmark. Focus on faster initial contact."
        : teamAvgSpeed > 180
        ? "Decent but room for improvement. Aim for under 3 minutes."
        : "Excellent speed-to-lead. Keep it up!",
      metric: "teamSpeedToLead",
      value: Math.round(teamAvgSpeed),
    });
  }

  insights.sort((a, b) => {
    const order = { warning: 0, suggestion: 1, positive: 2 };
    return order[a.type] - order[b.type];
  });

  return insights;
}
