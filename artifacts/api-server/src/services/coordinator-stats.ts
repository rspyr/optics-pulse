import { db, coordinatorDailyStatsTable, leadsTable, callAttemptsTable, usersTable, tenantsTable, funnelTypesTable } from "@workspace/db";
import { eq, and, sql, gte, lte, count, inArray, ne } from "drizzle-orm";
import { parseSpiffConfig, computeSpiffCommission } from "../routes/sales-manager";
import { computeLoginAwareSpeeds } from "./login-time-calculator";

async function getLeadStatsByIdsAndDate(leadIds: number[], dayStart: Date, dayEnd: Date, bookerCsrId?: number) {
  if (leadIds.length === 0) return { bookingsCount: 0, soldCount: 0, avgSpeedToLead: 0, bookedLeads: [] as { status: string; funnelName: string | null }[] };

  const bookingConds = [
    inArray(leadsTable.id, leadIds),
    inArray(leadsTable.status, ["booked", "sold"]),
    eq(leadsTable.preBooked, false),
    gte(leadsTable.updatedAt, dayStart),
    lte(leadsTable.updatedAt, dayEnd),
  ];
  if (bookerCsrId !== undefined) {
    bookingConds.push(eq(leadsTable.bookedByCsrId, bookerCsrId));
  }

  const bookedSoldLeads = await db.select({ status: leadsTable.status, funnelId: leadsTable.funnelId, preBooked: leadsTable.preBooked })
    .from(leadsTable)
    .where(and(...bookingConds));

  const bookingsCount = bookedSoldLeads.length;
  const soldCount = bookedSoldLeads.filter(l => l.status === "sold").length;

  const firstTouchRows = await db.select({
    leadId: callAttemptsTable.leadId,
    userId: sql<number>`(ARRAY_AGG(${callAttemptsTable.userId} ORDER BY ${callAttemptsTable.attemptedAt} ASC))[1]`.as("first_touch_user"),
    firstTouchAt: sql<Date>`MIN(${callAttemptsTable.attemptedAt})`.as("first_touch_at"),
    assignedAt: leadsTable.assignedAt,
    wallClockSpeed: sql<number>`MIN(EXTRACT(EPOCH FROM (${callAttemptsTable.attemptedAt} - ${leadsTable.assignedAt})))`.as("wall_clock_speed"),
  })
    .from(callAttemptsTable)
    .innerJoin(leadsTable, eq(callAttemptsTable.leadId, leadsTable.id))
    .where(and(
      inArray(callAttemptsTable.leadId, leadIds),
      ne(callAttemptsTable.actionType, "transfer"),
      ne(callAttemptsTable.actionType, "system"),
      gte(callAttemptsTable.attemptedAt, dayStart),
      lte(callAttemptsTable.attemptedAt, dayEnd),
    ))
    .groupBy(callAttemptsTable.leadId, leadsTable.assignedAt);

  let avgSpeedValue = 0;
  if (firstTouchRows.length > 0) {
    const windows = firstTouchRows
      .filter(r => r.userId && r.assignedAt && r.firstTouchAt && Number(r.wallClockSpeed) > 0)
      .map(r => ({
        leadId: r.leadId,
        userId: Number(r.userId),
        assignedAt: new Date(r.assignedAt!),
        firstTouchAt: new Date(r.firstTouchAt!),
        wallClockSpeed: Math.max(0, Number(r.wallClockSpeed)),
      }));
    try {
      const speedResults = await computeLoginAwareSpeeds(windows);
      if (speedResults.length > 0) {
        avgSpeedValue = speedResults.reduce((sum, s) => sum + s.speed, 0) / speedResults.length;
      }
    } catch (err) {
      console.error("[CoordinatorStats] Login-aware speed computation failed, using wall-clock fallback:", err);
      const wallClockSpeeds = windows.filter(w => w.wallClockSpeed > 0).map(w => w.wallClockSpeed);
      if (wallClockSpeeds.length > 0) {
        avgSpeedValue = wallClockSpeeds.reduce((sum, s) => sum + s, 0) / wallClockSpeeds.length;
      }
    }
  }

  const funnelIds = [...new Set(bookedSoldLeads.map(l => l.funnelId).filter((id): id is number => id !== null))];
  let funnelNameLookup: Record<number, string> = {};
  if (funnelIds.length > 0) {
    const fRows = await db.select({ id: funnelTypesTable.id, name: funnelTypesTable.name })
      .from(funnelTypesTable).where(inArray(funnelTypesTable.id, funnelIds));
    funnelNameLookup = Object.fromEntries(fRows.map(f => [f.id, f.name]));
  }
  const bookedLeadsWithFunnel = bookedSoldLeads.map(l => ({
    status: l.status,
    funnelName: l.funnelId ? (funnelNameLookup[l.funnelId] || null) : null,
  }));

  return {
    bookingsCount,
    soldCount,
    avgSpeedToLead: Math.round(avgSpeedValue),
    bookedLeads: bookedLeadsWithFunnel,
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
      ne(callAttemptsTable.actionType, "transfer"),
      ne(callAttemptsTable.actionType, "system"),
    );

    const [callsResult] = await db.select({ count: count() })
      .from(callAttemptsTable)
      .where(userAttemptConds);
    const callsMade = callsResult.count;

    const leadIdsResult = await db.selectDistinct({ leadId: callAttemptsTable.leadId })
      .from(callAttemptsTable)
      .where(userAttemptConds);
    const handledLeadIds = leadIdsResult.map(r => r.leadId);

    const leadStats = await getLeadStatsByIdsAndDate(handledLeadIds, startOfDay, endOfDay, userId);

    const [tenantRow] = await db.select({ spiffConfig: tenantsTable.spiffConfig })
      .from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    const spiffConfig = parseSpiffConfig(tenantRow?.spiffConfig);

    const bookingRate = callsMade > 0 ? Math.round((leadStats.bookingsCount / callsMade) * 100) : 0;
    const commission = computeSpiffCommission(leadStats.bookedLeads, spiffConfig);

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

const ZERO_STATS: StatSnapshot = { callsMade: 0, bookingsCount: 0, bookingRate: 0, commission: 0, avgSpeedToLead: 0 };

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

async function getUserTodayStats(userId: number, tenantId: number | null = null): Promise<StatSnapshot> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const attemptConds = [
    eq(callAttemptsTable.userId, userId),
    gte(callAttemptsTable.attemptedAt, today),
    ne(callAttemptsTable.actionType, "transfer"),
    ne(callAttemptsTable.actionType, "system"),
  ];

  const [callsResult] = await db.select({ count: count() })
    .from(callAttemptsTable).where(and(...attemptConds));
  const callsMade = callsResult.count;

  const leadIdsResult = await db.selectDistinct({ leadId: callAttemptsTable.leadId })
    .from(callAttemptsTable).where(and(...attemptConds));
  const handledLeadIds = leadIdsResult.map(r => r.leadId);

  const leadStats = await getLeadStatsByIdsAndDate(handledLeadIds, today, endOfToday, userId);
  const bookingRate = callsMade > 0 ? Math.round((leadStats.bookingsCount / callsMade) * 100) : 0;

  const spiffConfig = await loadSpiffConfig(tenantId);
  const commission = computeSpiffCommission(leadStats.bookedLeads, spiffConfig);

  return {
    callsMade,
    bookingsCount: leadStats.bookingsCount,
    bookingRate,
    commission,
    avgSpeedToLead: leadStats.avgSpeedToLead,
  };
}

async function loadSpiffConfig(tenantId: number | null) {
  if (!tenantId) return parseSpiffConfig(null);
  const [row] = await db.select({ spiffConfig: tenantsTable.spiffConfig })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  return parseSpiffConfig(row?.spiffConfig);
}

async function getTenantTodayStats(tenantId: number): Promise<StatSnapshot> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const attemptConds = [
    gte(callAttemptsTable.attemptedAt, today),
    ne(callAttemptsTable.actionType, "transfer"),
    ne(callAttemptsTable.actionType, "system"),
  ];

  const usersInTenant = await db.select({ id: usersTable.id })
    .from(usersTable).where(eq(usersTable.tenantId, tenantId));
  const userIds = usersInTenant.map(u => u.id);

  if (userIds.length === 0) return { ...ZERO_STATS };

  const [callsResult] = await db.select({ count: count() })
    .from(callAttemptsTable)
    .where(and(inArray(callAttemptsTable.userId, userIds), ...attemptConds));
  const callsMade = callsResult.count;

  const leadIdsResult = await db.selectDistinct({ leadId: callAttemptsTable.leadId })
    .from(callAttemptsTable)
    .where(and(inArray(callAttemptsTable.userId, userIds), ...attemptConds));
  const handledLeadIds = leadIdsResult.map(r => r.leadId);

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const leadStats = await getLeadStatsByIdsAndDate(handledLeadIds, today, endOfToday);
  const bookingRate = callsMade > 0 ? Math.round((leadStats.bookingsCount / callsMade) * 100) : 0;

  const spiffConfig = await loadSpiffConfig(tenantId);
  const commission = computeSpiffCommission(leadStats.bookedLeads, spiffConfig);

  return {
    callsMade,
    bookingsCount: leadStats.bookingsCount,
    bookingRate,
    commission,
    avgSpeedToLead: leadStats.avgSpeedToLead,
  };
}

function buildScopeConds(tenantId: number | null, userId: number | null) {
  const conds = [];
  if (tenantId) conds.push(eq(coordinatorDailyStatsTable.tenantId, tenantId));
  if (userId) conds.push(eq(coordinatorDailyStatsTable.userId, userId));
  return conds;
}

async function getBaselineStats(baseConds: ReturnType<typeof buildScopeConds>, baseline: ComparisonBaseline): Promise<StatSnapshot> {
  const selectAgg = {
    totalCalls: sql<number>`COALESCE(SUM(calls_made), 0)`,
    totalBookings: sql<number>`COALESCE(SUM(bookings_count), 0)`,
    avgRate: sql<number>`COALESCE(AVG(booking_rate), 0)`,
    totalCommission: sql<number>`COALESCE(SUM(commission), 0)`,
    avgSpeed: sql<number>`COALESCE(AVG(avg_speed_to_lead), 0)`,
  };

  function aggToStats(row: { totalCalls: number; totalBookings: number; avgRate: number; totalCommission: number; avgSpeed: number }): StatSnapshot {
    return {
      callsMade: Number(row.totalCalls),
      bookingsCount: Number(row.totalBookings),
      bookingRate: Math.round(Number(row.avgRate)),
      commission: Number(row.totalCommission),
      avgSpeedToLead: Math.round(Number(row.avgSpeed)),
    };
  }

  if (baseline === "yesterday") {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const conds = [...baseConds, eq(coordinatorDailyStatsTable.date, yesterday.toISOString().split("T")[0])];
    const [row] = await db.select(selectAgg).from(coordinatorDailyStatsTable).where(and(...conds));
    return row ? aggToStats(row) : { ...ZERO_STATS };
  }

  if (baseline === "last_week") {
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    const conds = [...baseConds, eq(coordinatorDailyStatsTable.date, lastWeek.toISOString().split("T")[0])];
    const [row] = await db.select(selectAgg).from(coordinatorDailyStatsTable).where(and(...conds));
    return row ? aggToStats(row) : { ...ZERO_STATS };
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
    if (!avgRow) return { ...ZERO_STATS };
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
    if (!bestRow) return { ...ZERO_STATS };
    return {
      callsMade: Number(bestRow.maxCalls),
      bookingsCount: Number(bestRow.maxBookings),
      bookingRate: Number(bestRow.maxRate),
      commission: Number(bestRow.maxCommission),
      avgSpeedToLead: Number(bestRow.minSpeed),
    };
  }

  return { ...ZERO_STATS };
}

async function getTenantCoordinators(tenantId: number) {
  return db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.tenantId, tenantId));
}

export async function getComparisonStats(
  tenantId: number | null,
  userId: number | null,
  baseline: ComparisonBaseline,
) {
  if (userId) {
    const todayStats = await getUserTodayStats(userId, tenantId);
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

    const teamMembers = await getTenantCoordinators(tenantId);
    const coordinators = [];

    for (const member of teamMembers) {
      const coordToday = await getUserTodayStats(member.id, tenantId);
      const coordBaseConds = buildScopeConds(tenantId, member.id);
      const coordBaseline = await getBaselineStats(coordBaseConds, baseline);

      coordinators.push({
        userId: member.id,
        name: member.name,
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

  return {
    baseline,
    today: { ...ZERO_STATS },
    deltas: computeDeltas(ZERO_STATS, ZERO_STATS),
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

  return {
    dailyStats: dailyStats.map(s => ({
      date: s.date,
      userId: s.userId,
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
