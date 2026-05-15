import { db, coordinatorDailyStatsTable, leadsTable, callAttemptsTable, usersTable, tenantsTable, funnelTypesTable } from "@workspace/db";
import { eq, and, sql, gte, lte, count, inArray, ne } from "drizzle-orm";
import { parseSpiffConfig, computeSpiffCommission } from "../routes/sales-manager";
import { computeLoginAwareSpeeds, type LeadSpeedWindow } from "./login-time-calculator";

/**
 * A "first-response" event for a (user, lead) pair: the user's earliest
 * non-transfer / non-system call attempt that occurred on or after the lead's
 * current `assignedAt`. There is at most one such event per assignment.
 *
 * Speed-to-lead is measured exclusively from these events — follow-up touches
 * on later days do not produce additional events and therefore do not inflate
 * a CSR's daily speed-to-lead average.
 */
export interface FirstResponseEvent {
  leadId: number;
  userId: number;
  assignedAt: Date;
  firstTouchAt: Date;
  wallClockSpeed: number;
}

/**
 * Find first-response events whose `firstTouchAt` falls in [dayStart, dayEnd].
 *
 * If `userIds` is empty/undefined, returns events for all users (used by
 * tenant-wide aggregation). If `bookerCsrId` is undefined, all CSRs match.
 */
export async function getFirstResponseEvents(
  userIds: number[] | undefined,
  dayStart: Date,
  dayEnd: Date,
): Promise<FirstResponseEvent[]> {
  if (userIds && userIds.length === 0) return [];

  const baseConds = [
    ne(callAttemptsTable.actionType, "transfer"),
    ne(callAttemptsTable.actionType, "system"),
    gte(callAttemptsTable.attemptedAt, leadsTable.assignedAt),
  ];
  if (userIds && userIds.length > 0) {
    baseConds.push(inArray(callAttemptsTable.userId, userIds));
  }

  const rows = await db
    .select({
      leadId: callAttemptsTable.leadId,
      userId: callAttemptsTable.userId,
      assignedAt: leadsTable.assignedAt,
      firstTouchAt: sql<Date>`MIN(${callAttemptsTable.attemptedAt})`.as("first_touch_at"),
    })
    .from(callAttemptsTable)
    .innerJoin(leadsTable, eq(callAttemptsTable.leadId, leadsTable.id))
    .where(and(...baseConds))
    .groupBy(callAttemptsTable.leadId, callAttemptsTable.userId, leadsTable.assignedAt)
    .having(and(
      gte(sql`MIN(${callAttemptsTable.attemptedAt})`, dayStart),
      lte(sql`MIN(${callAttemptsTable.attemptedAt})`, dayEnd),
    ));

  return rows
    .filter(r => r.userId !== null && r.assignedAt && r.firstTouchAt)
    .map(r => {
      const assignedAt = new Date(r.assignedAt as Date);
      const firstTouchAt = new Date(r.firstTouchAt as Date);
      const wallClockSpeed = Math.max(0, (firstTouchAt.getTime() - assignedAt.getTime()) / 1000);
      return {
        leadId: r.leadId,
        userId: Number(r.userId),
        assignedAt,
        firstTouchAt,
        wallClockSpeed,
      };
    });
}

/**
 * Average login-aware speed across first-response events. Returns 0 when
 * there are no qualifying events. Falls back to wall-clock if the login-aware
 * computation throws.
 */
export async function computeAvgSpeedFromEvents(events: FirstResponseEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const windows: LeadSpeedWindow[] = events
    .filter(e => e.wallClockSpeed > 0)
    .map(e => ({
      leadId: e.leadId,
      userId: e.userId,
      assignedAt: e.assignedAt,
      firstTouchAt: e.firstTouchAt,
      wallClockSpeed: e.wallClockSpeed,
    }));
  if (windows.length === 0) return 0;
  try {
    const speedResults = await computeLoginAwareSpeeds(windows);
    if (speedResults.length === 0) return 0;
    return speedResults.reduce((sum, s) => sum + s.speed, 0) / speedResults.length;
  } catch (err) {
    console.error("[CoordinatorStats] Login-aware speed computation failed, using wall-clock fallback:", err);
    const wallClock = windows.map(w => w.wallClockSpeed);
    return wallClock.reduce((sum, n) => sum + n, 0) / wallClock.length;
  }
}

async function getBookingStatsByIdsAndDate(
  leadIds: number[],
  dayStart: Date,
  dayEnd: Date,
  bookerCsrId?: number,
) {
  if (leadIds.length === 0) {
    return { bookingsCount: 0, soldCount: 0, bookedLeads: [] as { status: string; funnelName: string | null }[] };
  }

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

  const funnelIds = [...new Set(bookedSoldLeads.map(l => l.funnelId).filter((id): id is number => id !== null))];
  let funnelNameLookup: Record<number, string> = {};
  if (funnelIds.length > 0) {
    const fRows = await db.select({ id: funnelTypesTable.id, name: funnelTypesTable.name })
      .from(funnelTypesTable).where(inArray(funnelTypesTable.id, funnelIds));
    funnelNameLookup = Object.fromEntries(fRows.map(f => [f.id, f.name]));
  }
  const bookedLeads = bookedSoldLeads.map(l => ({
    status: l.status,
    funnelName: l.funnelId ? (funnelNameLookup[l.funnelId] || null) : null,
  }));

  return { bookingsCount, soldCount, bookedLeads };
}

/**
 * Compute the day's stats for a single CSR (or, when `userIds` covers the
 * whole tenant, the tenant aggregate).
 *
 * Speed-to-lead and newLeadsHandled are derived from first-response events
 * only — repeat touches on previously-handled leads do not contribute.
 */
async function getCoordinatorDayStats(opts: {
  dayStart: Date;
  dayEnd: Date;
  speedUserIds: number[];
  scopeLeadIds: number[];
  bookerCsrId?: number;
}) {
  const { dayStart, dayEnd, speedUserIds, scopeLeadIds, bookerCsrId } = opts;

  const events = await getFirstResponseEvents(speedUserIds, dayStart, dayEnd);
  const avgSpeedValue = await computeAvgSpeedFromEvents(events);
  const booking = await getBookingStatsByIdsAndDate(scopeLeadIds, dayStart, dayEnd, bookerCsrId);

  return {
    bookingsCount: booking.bookingsCount,
    soldCount: booking.soldCount,
    bookedLeads: booking.bookedLeads,
    avgSpeedToLead: Math.round(avgSpeedValue),
    newLeadsHandled: events.length,
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

    const leadStats = await getCoordinatorDayStats({
      dayStart: startOfDay,
      dayEnd: endOfDay,
      speedUserIds: [userId],
      scopeLeadIds: handledLeadIds,
      bookerCsrId: userId,
    });

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
      newLeadsHandled: leadStats.newLeadsHandled,
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
        newLeadsHandled: leadStats.newLeadsHandled,
      },
    });
    processed++;
  }

  return processed;
}

export interface BackfillResult {
  processed: number;
  failedDates: string[];
}

/**
 * Re-aggregate `coordinator_daily_stats` for every day in [startDateStr, endDateStr]
 * using the current logic. Existing rows are overwritten via the same upsert
 * path the nightly job uses, so this is safe to re-run.
 *
 * Used to correct historical numbers after a calculation change (e.g. the
 * speed-to-lead follow-up fix).
 *
 * Note: speed-to-lead events for prior assignments cannot be reconstructed for
 * leads that were later auto-passed, because `leads.assignedAt` is mutated on
 * each pass. Backfilled days will reflect each lead's *current* assignment.
 * Forward-going aggregation is unaffected. A follow-up task should introduce
 * an assignment-history table so backfills are exact.
 */
export async function backfillDailyStats(startDateStr: string, endDateStr: string): Promise<BackfillResult> {
  const start = new Date(`${startDateStr}T00:00:00Z`);
  const end = new Date(`${endDateStr}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    throw new Error(`Invalid date range: ${startDateStr} .. ${endDateStr}`);
  }

  let processed = 0;
  const failedDates: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const dateStr = cursor.toISOString().split("T")[0];
    try {
      const n = await aggregateDailyStats(dateStr);
      processed += n;
      console.log(`[StatsBackfill] ${dateStr}: re-aggregated ${n} coordinator(s)`);
    } catch (err) {
      console.error(`[StatsBackfill] ${dateStr}: failed`, err);
      failedDates.push(dateStr);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { processed, failedDates };
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

  const leadStats = await getCoordinatorDayStats({
    dayStart: today,
    dayEnd: endOfToday,
    speedUserIds: [userId],
    scopeLeadIds: handledLeadIds,
    bookerCsrId: userId,
  });
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
  const leadStats = await getCoordinatorDayStats({
    dayStart: today,
    dayEnd: endOfToday,
    speedUserIds: userIds,
    scopeLeadIds: handledLeadIds,
  });
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
