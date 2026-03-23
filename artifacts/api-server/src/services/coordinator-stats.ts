import { db, coordinatorDailyStatsTable, leadsTable, callAttemptsTable, usersTable } from "@workspace/db";
import { eq, and, sql, gte, lte, count } from "drizzle-orm";

export async function aggregateDailyStats(dateStr: string) {
  const startOfDay = new Date(`${dateStr}T00:00:00`);
  const endOfDay = new Date(`${dateStr}T23:59:59.999`);

  const userRows = await db.selectDistinct({
    userId: callAttemptsTable.userId,
  }).from(callAttemptsTable)
    .where(and(
      gte(callAttemptsTable.attemptedAt, startOfDay),
      lte(callAttemptsTable.attemptedAt, endOfDay),
    ));

  let processed = 0;

  for (const { userId } of userRows) {
    if (!userId) continue;

    const [userRow] = await db.select({ tenantId: usersTable.tenantId })
      .from(usersTable).where(eq(usersTable.id, userId));
    if (!userRow?.tenantId) continue;
    const tenantId = userRow.tenantId;

    const attemptConds = and(
      eq(callAttemptsTable.userId, userId),
      gte(callAttemptsTable.attemptedAt, startOfDay),
      lte(callAttemptsTable.attemptedAt, endOfDay),
    );

    const [callsResult] = await db.select({ count: count() })
      .from(callAttemptsTable).where(attemptConds);

    const tenantLeadConds = and(
      eq(leadsTable.tenantId, tenantId),
      sql`${leadsTable.updatedAt} >= ${startOfDay}`,
      sql`${leadsTable.updatedAt} <= ${endOfDay}`,
    );

    const [bookedResult] = await db.select({ count: count() })
      .from(leadsTable).where(and(tenantLeadConds, eq(leadsTable.status, "booked")));

    const [soldResult] = await db.select({ count: count() })
      .from(leadsTable).where(and(tenantLeadConds, eq(leadsTable.status, "sold")));

    const [contactedResult] = await db.select({ count: count() })
      .from(leadsTable).where(and(tenantLeadConds, sql`${leadsTable.status} != 'new'`));

    const [newLeadsResult] = await db.select({ count: count() })
      .from(leadsTable).where(and(
        eq(leadsTable.tenantId, tenantId),
        sql`${leadsTable.createdAt} >= ${startOfDay}`,
        sql`${leadsTable.createdAt} <= ${endOfDay}`,
      ));

    const callsMade = contactedResult.count;
    const bookingsCount = bookedResult.count + soldResult.count;
    const bookingRate = callsMade > 0 ? Math.round((bookingsCount / callsMade) * 100) : 0;
    const commission = bookingsCount * 20;

    const [speedResult] = await db.select({
      avgSpeed: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${leadsTable.updatedAt} - ${leadsTable.createdAt}))), 0)`,
    }).from(leadsTable)
      .where(and(tenantLeadConds, sql`${leadsTable.status} != 'new'`));

    const avgSpeedToLead = Math.round(Number(speedResult?.avgSpeed ?? 0));

    await db.insert(coordinatorDailyStatsTable).values({
      userId,
      tenantId,
      date: dateStr,
      callsMade,
      bookingsCount,
      bookingRate,
      commission,
      avgSpeedToLead,
      soldCount: soldResult.count,
      newLeadsHandled: newLeadsResult.count,
    }).onConflictDoUpdate({
      target: [coordinatorDailyStatsTable.userId, coordinatorDailyStatsTable.date],
      set: {
        tenantId,
        callsMade,
        bookingsCount,
        bookingRate,
        commission,
        avgSpeedToLead,
        soldCount: soldResult.count,
        newLeadsHandled: newLeadsResult.count,
      },
    });
    processed++;
  }

  return processed;
}

export function startNightlyAggregation() {
  const runAggregation = async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split("T")[0];
    try {
      const ct = await aggregateDailyStats(dateStr);
      console.log(`[StatsAggregation] Aggregated daily stats for ${dateStr}: ${ct} coordinator(s)`);
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

export type ComparisonBaseline = "yesterday" | "last_week" | "monthly_avg" | "all_time_best";

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

async function getTodayLiveStats(tenantId: number | null) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tenantCond = tenantId ? eq(leadsTable.tenantId, tenantId) : undefined;

  const contactedConds = [
    sql`${leadsTable.status} != 'new'`,
    sql`${leadsTable.updatedAt} >= ${today}`,
  ];
  if (tenantCond) contactedConds.push(tenantCond);

  const bookedConds = [
    eq(leadsTable.status, "booked"),
    sql`${leadsTable.updatedAt} >= ${today}`,
  ];
  if (tenantCond) bookedConds.push(tenantCond);

  const soldConds = [
    eq(leadsTable.status, "sold"),
    sql`${leadsTable.updatedAt} >= ${today}`,
  ];
  if (tenantCond) soldConds.push(tenantCond);

  const speedConds = [
    sql`${leadsTable.status} != 'new'`,
    sql`${leadsTable.updatedAt} >= ${today}`,
  ];
  if (tenantCond) speedConds.push(tenantCond);

  const [contactedResult] = await db.select({ count: count() }).from(leadsTable).where(and(...contactedConds));
  const [bookedResult] = await db.select({ count: count() }).from(leadsTable).where(and(...bookedConds));
  const [soldResult] = await db.select({ count: count() }).from(leadsTable).where(and(...soldConds));
  const [speedResult] = await db.select({
    avgSpeed: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${leadsTable.updatedAt} - ${leadsTable.createdAt}))), 0)`,
  }).from(leadsTable).where(and(...speedConds));

  const callsMade = contactedResult.count;
  const bookingsCount = bookedResult.count + soldResult.count;
  const bookingRate = callsMade > 0 ? Math.round((bookingsCount / callsMade) * 100) : 0;
  const commission = bookingsCount * 20;
  const avgSpeedToLead = Math.round(Number(speedResult?.avgSpeed ?? 0));

  return { callsMade, bookingsCount, bookingRate, commission, avgSpeedToLead };
}

function buildBaselineConds(tenantId: number | null, userId: number | null) {
  const conds = [];
  if (tenantId) conds.push(eq(coordinatorDailyStatsTable.tenantId, tenantId));
  if (userId) conds.push(eq(coordinatorDailyStatsTable.userId, userId));
  return conds;
}

export async function getComparisonStats(
  tenantId: number | null,
  userId: number | null,
  baseline: ComparisonBaseline,
) {
  const todayStats = await getTodayLiveStats(tenantId);

  let baselineStats = { callsMade: 0, bookingsCount: 0, bookingRate: 0, commission: 0, avgSpeedToLead: 0 };

  const baseConds = buildBaselineConds(tenantId, userId);

  if (baseline === "yesterday") {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];
    const conds = [...baseConds, eq(coordinatorDailyStatsTable.date, yesterdayStr)];

    const [row] = await db.select({
      totalCalls: sql<number>`COALESCE(SUM(calls_made), 0)`,
      totalBookings: sql<number>`COALESCE(SUM(bookings_count), 0)`,
      avgRate: sql<number>`COALESCE(AVG(booking_rate), 0)`,
      totalCommission: sql<number>`COALESCE(SUM(commission), 0)`,
      avgSpeed: sql<number>`COALESCE(AVG(avg_speed_to_lead), 0)`,
    }).from(coordinatorDailyStatsTable).where(and(...conds));

    if (row) {
      baselineStats = {
        callsMade: Number(row.totalCalls),
        bookingsCount: Number(row.totalBookings),
        bookingRate: Math.round(Number(row.avgRate)),
        commission: Number(row.totalCommission),
        avgSpeedToLead: Math.round(Number(row.avgSpeed)),
      };
    }
  } else if (baseline === "last_week") {
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastWeekStr = lastWeek.toISOString().split("T")[0];
    const conds = [...baseConds, eq(coordinatorDailyStatsTable.date, lastWeekStr)];

    const [row] = await db.select({
      totalCalls: sql<number>`COALESCE(SUM(calls_made), 0)`,
      totalBookings: sql<number>`COALESCE(SUM(bookings_count), 0)`,
      avgRate: sql<number>`COALESCE(AVG(booking_rate), 0)`,
      totalCommission: sql<number>`COALESCE(SUM(commission), 0)`,
      avgSpeed: sql<number>`COALESCE(AVG(avg_speed_to_lead), 0)`,
    }).from(coordinatorDailyStatsTable).where(and(...conds));

    if (row) {
      baselineStats = {
        callsMade: Number(row.totalCalls),
        bookingsCount: Number(row.totalBookings),
        bookingRate: Math.round(Number(row.avgRate)),
        commission: Number(row.totalCommission),
        avgSpeedToLead: Math.round(Number(row.avgSpeed)),
      };
    }
  } else if (baseline === "monthly_avg") {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyStr = thirtyDaysAgo.toISOString().split("T")[0];
    const conds = [...baseConds, gte(coordinatorDailyStatsTable.date, thirtyStr)];

    const [avgRow] = await db.select({
      avgCalls: sql<number>`COALESCE(AVG(calls_made), 0)`,
      avgBookings: sql<number>`COALESCE(AVG(bookings_count), 0)`,
      avgRate: sql<number>`COALESCE(AVG(booking_rate), 0)`,
      avgCommission: sql<number>`COALESCE(AVG(commission), 0)`,
      avgSpeed: sql<number>`COALESCE(AVG(avg_speed_to_lead), 0)`,
    }).from(coordinatorDailyStatsTable).where(and(...conds));

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
    const conds = [...baseConds];

    const [bestRow] = await db.select({
      maxCalls: sql<number>`COALESCE(MAX(calls_made), 0)`,
      maxBookings: sql<number>`COALESCE(MAX(bookings_count), 0)`,
      maxRate: sql<number>`COALESCE(MAX(booking_rate), 0)`,
      maxCommission: sql<number>`COALESCE(MAX(commission), 0)`,
      minSpeed: sql<number>`COALESCE(MIN(NULLIF(avg_speed_to_lead, 0)), 0)`,
    }).from(coordinatorDailyStatsTable).where(conds.length > 0 ? and(...conds) : undefined);

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
    today: todayStats,
    deltas: {
      callsMade: computeDelta(todayStats.callsMade, baselineStats.callsMade),
      bookingsCount: computeDelta(todayStats.bookingsCount, baselineStats.bookingsCount),
      bookingRate: computeDelta(todayStats.bookingRate, baselineStats.bookingRate),
      commission: computeDelta(todayStats.commission, baselineStats.commission),
      avgSpeedToLead: computeDelta(todayStats.avgSpeedToLead, baselineStats.avgSpeedToLead),
    },
  };
}

export async function getHistoricalStats(
  tenantId: number | null,
  userId: number | null,
  startDate: string,
  endDate: string,
) {
  const conds = [
    gte(coordinatorDailyStatsTable.date, startDate),
    lte(coordinatorDailyStatsTable.date, endDate),
  ];
  if (tenantId) conds.push(eq(coordinatorDailyStatsTable.tenantId, tenantId));
  if (userId) conds.push(eq(coordinatorDailyStatsTable.userId, userId));

  const dailyStats = await db.select().from(coordinatorDailyStatsTable)
    .where(and(...conds))
    .orderBy(coordinatorDailyStatsTable.date);

  const bestConds = [];
  if (tenantId) bestConds.push(eq(coordinatorDailyStatsTable.tenantId, tenantId));
  if (userId) bestConds.push(eq(coordinatorDailyStatsTable.userId, userId));

  const [bestRow] = await db.select({
    maxCalls: sql<number>`COALESCE(MAX(calls_made), 0)`,
    maxCallsDate: sql<string>`(SELECT date FROM coordinator_daily_stats WHERE calls_made = (SELECT MAX(calls_made) FROM coordinator_daily_stats ${tenantId ? sql`WHERE tenant_id = ${tenantId}` : sql``} ${userId ? sql`${tenantId ? sql`AND` : sql`WHERE`} user_id = ${userId}` : sql``}) LIMIT 1)`,
    maxBookings: sql<number>`COALESCE(MAX(bookings_count), 0)`,
    maxBookingsDate: sql<string>`(SELECT date FROM coordinator_daily_stats WHERE bookings_count = (SELECT MAX(bookings_count) FROM coordinator_daily_stats ${tenantId ? sql`WHERE tenant_id = ${tenantId}` : sql``} ${userId ? sql`${tenantId ? sql`AND` : sql`WHERE`} user_id = ${userId}` : sql``}) LIMIT 1)`,
    maxRate: sql<number>`COALESCE(MAX(booking_rate), 0)`,
    maxRateDate: sql<string>`(SELECT date FROM coordinator_daily_stats WHERE booking_rate = (SELECT MAX(booking_rate) FROM coordinator_daily_stats ${tenantId ? sql`WHERE tenant_id = ${tenantId}` : sql``} ${userId ? sql`${tenantId ? sql`AND` : sql`WHERE`} user_id = ${userId}` : sql``}) LIMIT 1)`,
    maxCommission: sql<number>`COALESCE(MAX(commission), 0)`,
    maxCommissionDate: sql<string>`(SELECT date FROM coordinator_daily_stats WHERE commission = (SELECT MAX(commission) FROM coordinator_daily_stats ${tenantId ? sql`WHERE tenant_id = ${tenantId}` : sql``} ${userId ? sql`${tenantId ? sql`AND` : sql`WHERE`} user_id = ${userId}` : sql``}) LIMIT 1)`,
    minSpeed: sql<number>`COALESCE(MIN(NULLIF(avg_speed_to_lead, 0)), 0)`,
    minSpeedDate: sql<string>`(SELECT date FROM coordinator_daily_stats WHERE avg_speed_to_lead = (SELECT MIN(NULLIF(avg_speed_to_lead, 0)) FROM coordinator_daily_stats ${tenantId ? sql`WHERE tenant_id = ${tenantId}` : sql``} ${userId ? sql`${tenantId ? sql`AND` : sql`WHERE`} user_id = ${userId}` : sql``}) LIMIT 1)`,
  }).from(coordinatorDailyStatsTable).where(bestConds.length > 0 ? and(...bestConds) : undefined);

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
      callsMade: { value: Number(bestRow?.maxCalls ?? 0), date: bestRow?.maxCallsDate ?? null },
      bookingsCount: { value: Number(bestRow?.maxBookings ?? 0), date: bestRow?.maxBookingsDate ?? null },
      bookingRate: { value: Number(bestRow?.maxRate ?? 0), date: bestRow?.maxRateDate ?? null },
      commission: { value: Number(bestRow?.maxCommission ?? 0), date: bestRow?.maxCommissionDate ?? null },
      avgSpeedToLead: { value: Number(bestRow?.minSpeed ?? 0), date: bestRow?.minSpeedDate ?? null },
    },
    totalDays: dailyStats.length,
  };
}
