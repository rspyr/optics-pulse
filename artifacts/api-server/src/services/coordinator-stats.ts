import { db, coordinatorDailyStatsTable, leadsTable, callAttemptsTable, usersTable } from "@workspace/db";
import { eq, and, sql, gte, lte, count, inArray, ne } from "drizzle-orm";

async function getLeadStatsByIds(leadIds: number[]) {
  if (leadIds.length === 0) return { bookingsCount: 0, soldCount: 0, avgSpeedToLead: 0 };

  const [bookedResult] = await db.select({ count: count() })
    .from(leadsTable)
    .where(and(inArray(leadsTable.id, leadIds), sql`${leadsTable.status} IN ('booked', 'sold')`));

  const [soldResult] = await db.select({ count: count() })
    .from(leadsTable)
    .where(and(inArray(leadsTable.id, leadIds), eq(leadsTable.status, "sold")));

  const [speedResult] = await db.select({
    avgSpeed: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${leadsTable.updatedAt} - ${leadsTable.createdAt}))), 0)`,
  }).from(leadsTable)
    .where(and(inArray(leadsTable.id, leadIds), ne(leadsTable.status, "new")));

  return {
    bookingsCount: bookedResult.count + soldResult.count,
    soldCount: soldResult.count,
    avgSpeedToLead: Math.round(Number(speedResult?.avgSpeed ?? 0)),
  };
}

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

    const userAttemptConds = and(
      eq(callAttemptsTable.userId, userId),
      gte(callAttemptsTable.attemptedAt, startOfDay),
      lte(callAttemptsTable.attemptedAt, endOfDay),
    );

    const [callsResult] = await db.select({ count: count() })
      .from(callAttemptsTable)
      .where(userAttemptConds);
    const callsMade = callsResult.count;

    const leadIdsResult = await db.selectDistinct({ leadId: callAttemptsTable.leadId })
      .from(callAttemptsTable)
      .where(userAttemptConds);
    const handledLeadIds = leadIdsResult.map(r => r.leadId);

    const leadStats = await getLeadStatsByIds(handledLeadIds);

    const bookingRate = callsMade > 0 ? Math.round((leadStats.bookingsCount / callsMade) * 100) : 0;
    const commission = leadStats.bookingsCount * 20;

    await db.insert(coordinatorDailyStatsTable).values({
      userId,
      tenantId,
      date: dateStr,
      callsMade,
      bookingsCount: leadStats.bookingsCount,
      bookingRate,
      commission,
      avgSpeedToLead: leadStats.avgSpeedToLead,
      soldCount: leadStats.soldCount,
      newLeadsHandled: handledLeadIds.length,
    }).onConflictDoUpdate({
      target: [coordinatorDailyStatsTable.userId, coordinatorDailyStatsTable.date],
      set: {
        tenantId,
        callsMade,
        bookingsCount: leadStats.bookingsCount,
        bookingRate,
        commission,
        avgSpeedToLead: leadStats.avgSpeedToLead,
        soldCount: leadStats.soldCount,
        newLeadsHandled: handledLeadIds.length,
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

interface StatSnapshot {
  callsMade: number;
  bookingsCount: number;
  bookingRate: number;
  commission: number;
  avgSpeedToLead: number;
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

function computeDeltas(today: StatSnapshot, baseline: StatSnapshot) {
  return {
    callsMade: computeDelta(today.callsMade, baseline.callsMade),
    bookingsCount: computeDelta(today.bookingsCount, baseline.bookingsCount),
    bookingRate: computeDelta(today.bookingRate, baseline.bookingRate),
    commission: computeDelta(today.commission, baseline.commission),
    avgSpeedToLead: computeDelta(today.avgSpeedToLead, baseline.avgSpeedToLead),
  };
}

async function getUserTodayStats(userId: number): Promise<StatSnapshot> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const attemptConds = [
    eq(callAttemptsTable.userId, userId),
    gte(callAttemptsTable.attemptedAt, today),
  ];

  const [callsResult] = await db.select({ count: count() })
    .from(callAttemptsTable).where(and(...attemptConds));
  const callsMade = callsResult.count;

  const leadIdsResult = await db.selectDistinct({ leadId: callAttemptsTable.leadId })
    .from(callAttemptsTable).where(and(...attemptConds));
  const handledLeadIds = leadIdsResult.map(r => r.leadId);

  const leadStats = await getLeadStatsByIds(handledLeadIds);
  const bookingRate = callsMade > 0 ? Math.round((leadStats.bookingsCount / callsMade) * 100) : 0;

  return {
    callsMade,
    bookingsCount: leadStats.bookingsCount,
    bookingRate,
    commission: leadStats.bookingsCount * 20,
    avgSpeedToLead: leadStats.avgSpeedToLead,
  };
}

async function getTenantTodayStats(tenantId: number): Promise<StatSnapshot> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [contactedResult] = await db.select({ count: count() }).from(leadsTable)
    .where(and(eq(leadsTable.tenantId, tenantId), ne(leadsTable.status, "new"), gte(leadsTable.updatedAt, today)));

  const [bookedResult] = await db.select({ count: count() }).from(leadsTable)
    .where(and(eq(leadsTable.tenantId, tenantId), sql`${leadsTable.status} IN ('booked', 'sold')`, gte(leadsTable.updatedAt, today)));

  const [speedResult] = await db.select({
    avgSpeed: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${leadsTable.updatedAt} - ${leadsTable.createdAt}))), 0)`,
  }).from(leadsTable)
    .where(and(eq(leadsTable.tenantId, tenantId), ne(leadsTable.status, "new"), gte(leadsTable.updatedAt, today)));

  const callsMade = contactedResult.count;
  const bookingsCount = bookedResult.count;
  const bookingRate = callsMade > 0 ? Math.round((bookingsCount / callsMade) * 100) : 0;

  return {
    callsMade,
    bookingsCount,
    bookingRate,
    commission: bookingsCount * 20,
    avgSpeedToLead: Math.round(Number(speedResult?.avgSpeed ?? 0)),
  };
}

function buildScopeConds(tenantId: number | null, userId: number | null) {
  const conds = [];
  if (tenantId) conds.push(eq(coordinatorDailyStatsTable.tenantId, tenantId));
  if (userId) conds.push(eq(coordinatorDailyStatsTable.userId, userId));
  return conds;
}

async function getBaselineStats(baseConds: ReturnType<typeof buildScopeConds>, baseline: ComparisonBaseline): Promise<StatSnapshot> {
  const zero: StatSnapshot = { callsMade: 0, bookingsCount: 0, bookingRate: 0, commission: 0, avgSpeedToLead: 0 };

  const selectAgg = {
    totalCalls: sql<number>`COALESCE(SUM(calls_made), 0)`,
    totalBookings: sql<number>`COALESCE(SUM(bookings_count), 0)`,
    avgRate: sql<number>`COALESCE(AVG(booking_rate), 0)`,
    totalCommission: sql<number>`COALESCE(SUM(commission), 0)`,
    avgSpeed: sql<number>`COALESCE(AVG(avg_speed_to_lead), 0)`,
  };

  if (baseline === "yesterday") {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const conds = [...baseConds, eq(coordinatorDailyStatsTable.date, yesterday.toISOString().split("T")[0])];
    const [row] = await db.select(selectAgg).from(coordinatorDailyStatsTable).where(and(...conds));
    if (!row) return zero;
    return {
      callsMade: Number(row.totalCalls),
      bookingsCount: Number(row.totalBookings),
      bookingRate: Math.round(Number(row.avgRate)),
      commission: Number(row.totalCommission),
      avgSpeedToLead: Math.round(Number(row.avgSpeed)),
    };
  }

  if (baseline === "last_week") {
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    const conds = [...baseConds, eq(coordinatorDailyStatsTable.date, lastWeek.toISOString().split("T")[0])];
    const [row] = await db.select(selectAgg).from(coordinatorDailyStatsTable).where(and(...conds));
    if (!row) return zero;
    return {
      callsMade: Number(row.totalCalls),
      bookingsCount: Number(row.totalBookings),
      bookingRate: Math.round(Number(row.avgRate)),
      commission: Number(row.totalCommission),
      avgSpeedToLead: Math.round(Number(row.avgSpeed)),
    };
  }

  if (baseline === "monthly_avg") {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const conds = [...baseConds, gte(coordinatorDailyStatsTable.date, thirtyDaysAgo.toISOString().split("T")[0])];
    const [avgRow] = await db.select({
      avgCalls: sql<number>`COALESCE(AVG(calls_made), 0)`,
      avgBookings: sql<number>`COALESCE(AVG(bookings_count), 0)`,
      avgRate: sql<number>`COALESCE(AVG(booking_rate), 0)`,
      avgCommission: sql<number>`COALESCE(AVG(commission), 0)`,
      avgSpeed: sql<number>`COALESCE(AVG(avg_speed_to_lead), 0)`,
    }).from(coordinatorDailyStatsTable).where(and(...conds));
    if (!avgRow) return zero;
    return {
      callsMade: Math.round(Number(avgRow.avgCalls)),
      bookingsCount: Math.round(Number(avgRow.avgBookings)),
      bookingRate: Math.round(Number(avgRow.avgRate)),
      commission: Math.round(Number(avgRow.avgCommission)),
      avgSpeedToLead: Math.round(Number(avgRow.avgSpeed)),
    };
  }

  if (baseline === "all_time_best") {
    const [bestRow] = await db.select({
      maxCalls: sql<number>`COALESCE(MAX(calls_made), 0)`,
      maxBookings: sql<number>`COALESCE(MAX(bookings_count), 0)`,
      maxRate: sql<number>`COALESCE(MAX(booking_rate), 0)`,
      maxCommission: sql<number>`COALESCE(MAX(commission), 0)`,
      minSpeed: sql<number>`COALESCE(MIN(NULLIF(avg_speed_to_lead, 0)), 0)`,
    }).from(coordinatorDailyStatsTable).where(baseConds.length > 0 ? and(...baseConds) : undefined);
    if (!bestRow) return zero;
    return {
      callsMade: Number(bestRow.maxCalls),
      bookingsCount: Number(bestRow.maxBookings),
      bookingRate: Number(bestRow.maxRate),
      commission: Number(bestRow.maxCommission),
      avgSpeedToLead: Number(bestRow.minSpeed),
    };
  }

  return zero;
}

export async function getComparisonStats(
  tenantId: number | null,
  userId: number | null,
  baseline: ComparisonBaseline,
) {
  if (userId) {
    const todayStats = await getUserTodayStats(userId);
    const baseConds = buildScopeConds(tenantId, userId);
    const baselineStats = await getBaselineStats(baseConds, baseline);

    return {
      baseline,
      today: todayStats,
      deltas: computeDeltas(todayStats, baselineStats),
    };
  }

  if (tenantId) {
    const tenantTodayStats = await getTenantTodayStats(tenantId);

    const coordinatorUserIds = await db.selectDistinct({ userId: coordinatorDailyStatsTable.userId })
      .from(coordinatorDailyStatsTable)
      .where(eq(coordinatorDailyStatsTable.tenantId, tenantId));

    const coordinators = [];
    for (const { userId: uid } of coordinatorUserIds) {
      const [user] = await db.select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable).where(eq(usersTable.id, uid));
      if (!user) continue;

      const coordToday = await getUserTodayStats(user.id);
      const coordBaseConds = buildScopeConds(tenantId, user.id);
      const coordBaseline = await getBaselineStats(coordBaseConds, baseline);

      coordinators.push({
        userId: user.id,
        name: user.name,
        today: coordToday,
        deltas: computeDeltas(coordToday, coordBaseline),
      });
    }

    const tenantBaseConds = buildScopeConds(tenantId, null);
    const tenantBaseline = await getBaselineStats(tenantBaseConds, baseline);

    return {
      baseline,
      today: tenantTodayStats,
      deltas: computeDeltas(tenantTodayStats, tenantBaseline),
      coordinators,
    };
  }

  const zero: StatSnapshot = { callsMade: 0, bookingsCount: 0, bookingRate: 0, commission: 0, avgSpeedToLead: 0 };
  return {
    baseline,
    today: zero,
    deltas: computeDeltas(zero, zero),
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

  const bestConds = buildScopeConds(tenantId, userId);

  const [bestRow] = await db.select({
    maxCalls: sql<number>`COALESCE(MAX(calls_made), 0)`,
    maxCallsDate: sql<string>`(array_agg(date ORDER BY calls_made DESC))[1]`,
    maxBookings: sql<number>`COALESCE(MAX(bookings_count), 0)`,
    maxBookingsDate: sql<string>`(array_agg(date ORDER BY bookings_count DESC))[1]`,
    maxRate: sql<number>`COALESCE(MAX(booking_rate), 0)`,
    maxRateDate: sql<string>`(array_agg(date ORDER BY booking_rate DESC))[1]`,
    maxCommission: sql<number>`COALESCE(MAX(commission), 0)`,
    maxCommissionDate: sql<string>`(array_agg(date ORDER BY commission DESC))[1]`,
    minSpeed: sql<number>`COALESCE(MIN(NULLIF(avg_speed_to_lead, 0)), 0)`,
    minSpeedDate: sql<string>`(array_agg(date ORDER BY CASE WHEN avg_speed_to_lead > 0 THEN avg_speed_to_lead ELSE 999999 END ASC))[1]`,
  }).from(coordinatorDailyStatsTable).where(bestConds.length > 0 ? and(...bestConds) : undefined);

  const mapDay = (s: typeof dailyStats[0]) => ({
    date: s.date,
    userId: s.userId,
    callsMade: s.callsMade,
    bookingsCount: s.bookingsCount,
    bookingRate: s.bookingRate,
    commission: s.commission,
    avgSpeedToLead: s.avgSpeedToLead,
    soldCount: s.soldCount,
  });

  return {
    dailyStats: dailyStats.map(mapDay),
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
