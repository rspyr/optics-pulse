import { db, coordinatorDailyStatsTable, leadsTable, callAttemptsTable, usersTable } from "@workspace/db";
import { eq, and, sql, desc, gte, lte, avg, count } from "drizzle-orm";

export async function aggregateDailyStats(dateStr: string) {
  const startOfDay = new Date(`${dateStr}T00:00:00`);
  const endOfDay = new Date(`${dateStr}T23:59:59.999`);

  const userRows = await db.selectDistinct({ userId: callAttemptsTable.userId })
    .from(callAttemptsTable)
    .where(and(
      gte(callAttemptsTable.attemptedAt, startOfDay),
      lte(callAttemptsTable.attemptedAt, endOfDay),
    ));

  for (const { userId } of userRows) {
    const [callsResult] = await db.select({ count: count() })
      .from(callAttemptsTable)
      .where(and(
        eq(callAttemptsTable.userId, userId),
        gte(callAttemptsTable.attemptedAt, startOfDay),
        lte(callAttemptsTable.attemptedAt, endOfDay),
      ));

    const [bookingsResult] = await db.select({ count: count() })
      .from(callAttemptsTable)
      .where(and(
        eq(callAttemptsTable.userId, userId),
        eq(callAttemptsTable.outcome, "answered"),
        gte(callAttemptsTable.attemptedAt, startOfDay),
        lte(callAttemptsTable.attemptedAt, endOfDay),
      ));

    const callsMade = callsResult.count;
    const bookingsCount = bookingsResult.count;
    const bookingRate = callsMade > 0 ? Math.round((bookingsCount / callsMade) * 100) : 0;
    const commission = bookingsCount * 20;

    const [speedResult] = await db.select({
      avgSpeed: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${leadsTable.updatedAt} - ${leadsTable.createdAt}))), 0)`,
    }).from(callAttemptsTable)
      .innerJoin(leadsTable, eq(callAttemptsTable.leadId, leadsTable.id))
      .where(and(
        eq(callAttemptsTable.userId, userId),
        eq(callAttemptsTable.outcome, "answered"),
        gte(callAttemptsTable.attemptedAt, startOfDay),
        lte(callAttemptsTable.attemptedAt, endOfDay),
      ));

    await db.insert(coordinatorDailyStatsTable).values({
      userId,
      date: dateStr,
      callsMade,
      bookingsCount,
      bookingRate,
      commission,
      avgSpeedToLead: Math.round(Number(speedResult?.avgSpeed ?? 0)),
      soldCount: 0,
      newLeadsHandled: callsMade,
    }).onConflictDoUpdate({
      target: [coordinatorDailyStatsTable.userId, coordinatorDailyStatsTable.date],
      set: {
        callsMade,
        bookingsCount,
        bookingRate,
        commission,
        avgSpeedToLead: Math.round(Number(speedResult?.avgSpeed ?? 0)),
        newLeadsHandled: callsMade,
      },
    });
  }

  return userRows.length;
}

export function startNightlyAggregation() {
  const runAggregation = async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split("T")[0];
    try {
      const count = await aggregateDailyStats(dateStr);
      console.log(`[StatsAggregation] Aggregated daily stats for ${dateStr}: ${count} coordinator(s)`);
    } catch (err) {
      console.error("[StatsAggregation] Failed:", err);
    }
  };

  const now = new Date();
  const next2am = new Date(now);
  next2am.setHours(2, 0, 0, 0);
  if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
  const msUntil2am = next2am.getTime() - now.getTime();

  setTimeout(() => {
    runAggregation();
    setInterval(runAggregation, 24 * 60 * 60 * 1000);
  }, msUntil2am);

  console.log(`[StatsAggregation] Nightly aggregation scheduled for 2:00 AM (in ${Math.round(msUntil2am / 60000)} minutes)`);
}

type ComparisonBaseline = "yesterday" | "last_week" | "monthly_avg" | "all_time_best";

interface StatDelta {
  value: number;
  baseline: number;
  delta: number;
  percentChange: number;
  direction: "up" | "down" | "flat";
}

function computeDelta(current: number, baseline: number): StatDelta {
  const delta = current - baseline;
  const percentChange = baseline > 0 ? Math.round((delta / baseline) * 100) : current > 0 ? 100 : 0;
  return {
    value: current,
    baseline,
    delta,
    percentChange,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
  };
}

export async function getComparisonStats(
  userId: number | null,
  tenantId: number | null,
  baseline: ComparisonBaseline,
) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayStr = today.toISOString().split("T")[0];

  const todayConds = [];
  if (userId) todayConds.push(eq(callAttemptsTable.userId, userId));
  todayConds.push(gte(callAttemptsTable.attemptedAt, today));

  const [todayCalls] = await db.select({ count: count() }).from(callAttemptsTable).where(and(...todayConds));
  const [todayBookings] = await db.select({ count: count() }).from(callAttemptsTable).where(and(
    ...todayConds,
    eq(callAttemptsTable.outcome, "answered"),
  ));

  const callsMade = todayCalls.count;
  const bookingsCount = todayBookings.count;
  const bookingRate = callsMade > 0 ? Math.round((bookingsCount / callsMade) * 100) : 0;
  const commission = bookingsCount * 20;

  const speedConds = [];
  if (userId) speedConds.push(eq(callAttemptsTable.userId, userId));
  speedConds.push(gte(callAttemptsTable.attemptedAt, today));
  speedConds.push(eq(callAttemptsTable.outcome, "answered"));

  const [speedResult] = await db.select({
    avgSpeed: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${leadsTable.updatedAt} - ${leadsTable.createdAt}))), 0)`,
  }).from(callAttemptsTable)
    .innerJoin(leadsTable, eq(callAttemptsTable.leadId, leadsTable.id))
    .where(and(...speedConds));

  const avgSpeed = Math.round(Number(speedResult?.avgSpeed ?? 0));

  let baselineStats = { callsMade: 0, bookingsCount: 0, bookingRate: 0, commission: 0, avgSpeedToLead: 0 };

  const statsConds = [];
  if (userId) statsConds.push(eq(coordinatorDailyStatsTable.userId, userId));

  if (baseline === "yesterday") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];
    const rows = await db.select().from(coordinatorDailyStatsTable).where(and(
      ...statsConds,
      eq(coordinatorDailyStatsTable.date, yesterdayStr),
    ));
    if (rows.length > 0) {
      const r = rows[0];
      baselineStats = { callsMade: r.callsMade, bookingsCount: r.bookingsCount, bookingRate: r.bookingRate, commission: r.commission, avgSpeedToLead: r.avgSpeedToLead };
    }
  } else if (baseline === "last_week") {
    const lastWeek = new Date(today);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastWeekStr = lastWeek.toISOString().split("T")[0];
    const rows = await db.select().from(coordinatorDailyStatsTable).where(and(
      ...statsConds,
      eq(coordinatorDailyStatsTable.date, lastWeekStr),
    ));
    if (rows.length > 0) {
      const r = rows[0];
      baselineStats = { callsMade: r.callsMade, bookingsCount: r.bookingsCount, bookingRate: r.bookingRate, commission: r.commission, avgSpeedToLead: r.avgSpeedToLead };
    }
  } else if (baseline === "monthly_avg") {
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyStr = thirtyDaysAgo.toISOString().split("T")[0];
    const [avgRow] = await db.select({
      avgCalls: sql<number>`COALESCE(AVG(calls_made), 0)`,
      avgBookings: sql<number>`COALESCE(AVG(bookings_count), 0)`,
      avgRate: sql<number>`COALESCE(AVG(booking_rate), 0)`,
      avgCommission: sql<number>`COALESCE(AVG(commission), 0)`,
      avgSpeed: sql<number>`COALESCE(AVG(avg_speed_to_lead), 0)`,
    }).from(coordinatorDailyStatsTable).where(and(
      ...statsConds,
      gte(coordinatorDailyStatsTable.date, thirtyStr),
    ));
    if (avgRow) {
      baselineStats = {
        callsMade: Math.round(Number(avgRow.avgCalls)),
        bookingsCount: Math.round(Number(avgRow.avgBookings)),
        bookingRate: Math.round(Number(avgRow.avgRate)),
        commission: Math.round(Number(avgRow.avgCommission)),
        avgSpeedToLead: Math.round(Number(avgRow.avgSpeed)),
      };
    }
  } else if (baseline === "all_time_best") {
    const [bestRow] = await db.select({
      maxCalls: sql<number>`COALESCE(MAX(calls_made), 0)`,
      maxBookings: sql<number>`COALESCE(MAX(bookings_count), 0)`,
      maxRate: sql<number>`COALESCE(MAX(booking_rate), 0)`,
      maxCommission: sql<number>`COALESCE(MAX(commission), 0)`,
      minSpeed: sql<number>`COALESCE(MIN(NULLIF(avg_speed_to_lead, 0)), 0)`,
    }).from(coordinatorDailyStatsTable).where(and(...statsConds));
    if (bestRow) {
      baselineStats = {
        callsMade: Number(bestRow.maxCalls),
        bookingsCount: Number(bestRow.maxBookings),
        bookingRate: Number(bestRow.maxRate),
        commission: Number(bestRow.maxCommission),
        avgSpeedToLead: Number(bestRow.minSpeed),
      };
    }
  }

  return {
    baseline,
    today: { callsMade, bookingsCount, bookingRate, commission, avgSpeedToLead: avgSpeed },
    deltas: {
      callsMade: computeDelta(callsMade, baselineStats.callsMade),
      bookingsCount: computeDelta(bookingsCount, baselineStats.bookingsCount),
      bookingRate: computeDelta(bookingRate, baselineStats.bookingRate),
      commission: computeDelta(commission, baselineStats.commission),
      avgSpeedToLead: computeDelta(avgSpeed, baselineStats.avgSpeedToLead),
    },
  };
}

export async function getHistoricalStats(
  userId: number | null,
  tenantId: number | null,
  startDate: string,
  endDate: string,
) {
  const conds = [];
  if (userId) conds.push(eq(coordinatorDailyStatsTable.userId, userId));
  conds.push(gte(coordinatorDailyStatsTable.date, startDate));
  conds.push(lte(coordinatorDailyStatsTable.date, endDate));

  const dailyStats = await db.select().from(coordinatorDailyStatsTable)
    .where(and(...conds))
    .orderBy(coordinatorDailyStatsTable.date);

  const allTimeConds = [];
  if (userId) allTimeConds.push(eq(coordinatorDailyStatsTable.userId, userId));

  const [bestCalls] = await db.select({
    val: sql<number>`MAX(calls_made)`,
    date: sql<string>`(SELECT date FROM coordinator_daily_stats WHERE calls_made = (SELECT MAX(calls_made) FROM coordinator_daily_stats ${userId ? sql`WHERE user_id = ${userId}` : sql``}) LIMIT 1)`,
  }).from(coordinatorDailyStatsTable).where(and(...allTimeConds));

  const [bestBookings] = await db.select({
    val: sql<number>`MAX(bookings_count)`,
  }).from(coordinatorDailyStatsTable).where(and(...allTimeConds));

  const [bestRate] = await db.select({
    val: sql<number>`MAX(booking_rate)`,
  }).from(coordinatorDailyStatsTable).where(and(...allTimeConds));

  const [bestCommission] = await db.select({
    val: sql<number>`MAX(commission)`,
  }).from(coordinatorDailyStatsTable).where(and(...allTimeConds));

  const [bestSpeed] = await db.select({
    val: sql<number>`MIN(NULLIF(avg_speed_to_lead, 0))`,
  }).from(coordinatorDailyStatsTable).where(and(...allTimeConds));

  return {
    dailyStats: dailyStats.map(s => ({
      date: s.date,
      callsMade: s.callsMade,
      bookingsCount: s.bookingsCount,
      bookingRate: s.bookingRate,
      commission: s.commission,
      avgSpeedToLead: s.avgSpeedToLead,
      soldCount: s.soldCount,
    })),
    personalBests: {
      callsMade: { value: Number(bestCalls?.val ?? 0) },
      bookingsCount: { value: Number(bestBookings?.val ?? 0) },
      bookingRate: { value: Number(bestRate?.val ?? 0) },
      commission: { value: Number(bestCommission?.val ?? 0) },
      avgSpeedToLead: { value: Number(bestSpeed?.val ?? 0) },
    },
    totalDays: dailyStats.length,
  };
}

export async function seedTodayStats() {
  const todayStr = new Date().toISOString().split("T")[0];
  try {
    const count = await aggregateDailyStats(todayStr);
    console.log(`[StatsAggregation] Seeded today's stats: ${count} coordinator(s)`);
  } catch (err) {
    console.error("[StatsAggregation] Seed failed:", err);
  }
}
