import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, callAttemptsTable, leadsTable, usersTable, coordinatorDailyStatsTable, changeLogsTable, scriptsTable, tenantsTable, funnelTypesTable } from "@workspace/db";
import { eq, and, sql, gte, lte, count, inArray, desc, ne, isNotNull } from "drizzle-orm";
import { generateCoachingInsights } from "../services/coaching-insights";
import { computeLoginAwareSpeeds } from "../services/login-time-calculator";

export interface SpiffConfig {
  default: number;
  byFunnel: Record<string, number>;
}

const DEFAULT_SPIFF_CONFIG: SpiffConfig = { default: 20, byFunnel: {} };

export function parseSpiffConfig(raw: unknown): SpiffConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SPIFF_CONFIG };
  const obj = raw as Record<string, unknown>;
  const byFunnelRaw = obj.byFunnel ?? obj.byLeadType;
  return {
    default: typeof obj.default === "number" && obj.default >= 0 ? obj.default : 20,
    byFunnel: byFunnelRaw && typeof byFunnelRaw === "object"
      ? Object.fromEntries(
          Object.entries(byFunnelRaw as Record<string, unknown>)
            .filter(([, v]) => typeof v === "number" && v >= 0)
            .map(([k, v]) => [k, v as number])
        )
      : {},
  };
}

export function computeSpiffCommission(
  leads: { status: string; funnelName: string | null; preBooked?: boolean }[],
  spiffConfig: SpiffConfig,
): number {
  let total = 0;
  for (const lead of leads) {
    if (lead.preBooked) continue;
    if (lead.status !== "booked" && lead.status !== "sold") continue;
    const fn = lead.funnelName || "";
    const amount = fn && spiffConfig.byFunnel[fn] !== undefined
      ? spiffConfig.byFunnel[fn]
      : spiffConfig.default;
    total += amount;
  }
  return total;
}

async function getTenantSpiffConfig(tenantId: number): Promise<SpiffConfig> {
  const [tenant] = await db.select({ spiffConfig: tenantsTable.spiffConfig })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  return parseSpiffConfig(tenant?.spiffConfig);
}

const router: IRouter = Router();

function requireManagerRole(req: Request, res: Response, next: NextFunction) {
  const role = req.session.userRole;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied. Requires manager role." });
    return;
  }
  next();
}

function resolveTenantId(req: Request): number | null {
  const session = req.session;
  const role = session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    return req.query.tenantId ? Number(req.query.tenantId) : session.tenantId ?? null;
  }
  return session.tenantId ?? null;
}

router.use("/sales-manager", requireManagerRole);

router.get("/sales-manager/team", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ coordinators: [], teamTotals: null });
    return;
  }

  const users = await db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.tenantId, tenantId));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const userIds = users.map(u => u.id);

  if (userIds.length === 0) {
    res.json({ coordinators: [], teamTotals: null });
    return;
  }

  const todayAttempts = await db.select({
    userId: callAttemptsTable.userId,
    callCount: count(),
  }).from(callAttemptsTable)
    .where(and(
      inArray(callAttemptsTable.userId, userIds),
      gte(callAttemptsTable.attemptedAt, today),
      ne(callAttemptsTable.actionType, "transfer"),
      ne(callAttemptsTable.actionType, "system"),
    ))
    .groupBy(callAttemptsTable.userId);

  const callCountMap: Record<number, number> = {};
  for (const a of todayAttempts) callCountMap[a.userId] = a.callCount;

  const todayLeadIds = await db.selectDistinct({ leadId: callAttemptsTable.leadId, userId: callAttemptsTable.userId })
    .from(callAttemptsTable)
    .where(and(
      inArray(callAttemptsTable.userId, userIds),
      gte(callAttemptsTable.attemptedAt, today),
      ne(callAttemptsTable.actionType, "transfer"),
      ne(callAttemptsTable.actionType, "system"),
    ));

  const leadIdsByUser: Record<number, number[]> = {};
  for (const r of todayLeadIds) {
    if (!leadIdsByUser[r.userId]) leadIdsByUser[r.userId] = [];
    leadIdsByUser[r.userId].push(r.leadId);
  }

  const allLeadIds = [...new Set(todayLeadIds.map(r => r.leadId))];
  let leadStatusMap: Record<number, string> = {};
  let leadFunnelIdMap: Record<number, number | null> = {};
  let preBookedMap: Record<number, boolean> = {};
  let leadBookedByCsrMap: Record<number, number | null> = {};
  if (allLeadIds.length > 0) {
    const leads = await db.select({ id: leadsTable.id, status: leadsTable.status, funnelId: leadsTable.funnelId, preBooked: leadsTable.preBooked, bookedByCsrId: leadsTable.bookedByCsrId })
      .from(leadsTable).where(inArray(leadsTable.id, allLeadIds));
    leadStatusMap = Object.fromEntries(leads.map(l => [l.id, l.status]));
    leadFunnelIdMap = Object.fromEntries(leads.map(l => [l.id, l.funnelId]));
    preBookedMap = Object.fromEntries(leads.map(l => [l.id, l.preBooked ?? false]));
    leadBookedByCsrMap = Object.fromEntries(leads.map(l => [l.id, l.bookedByCsrId]));
  }

  const funnelIdSet = new Set(Object.values(leadFunnelIdMap).filter((id): id is number => id !== null));
  let funnelNameMap: Record<number, string> = {};
  if (funnelIdSet.size > 0) {
    const funnelRows = await db.select({ id: funnelTypesTable.id, name: funnelTypesTable.name })
      .from(funnelTypesTable).where(inArray(funnelTypesTable.id, [...funnelIdSet]));
    funnelNameMap = Object.fromEntries(funnelRows.map(f => [f.id, f.name]));
  }

  const spiffConfig = await getTenantSpiffConfig(tenantId);

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const weekStats = await db.select()
    .from(coordinatorDailyStatsTable)
    .where(and(
      inArray(coordinatorDailyStatsTable.userId, userIds),
      gte(coordinatorDailyStatsTable.date, sevenDaysAgo.toISOString().split("T")[0]),
    ));

  const weekStatsByUser: Record<number, typeof weekStats> = {};
  for (const s of weekStats) {
    if (!weekStatsByUser[s.userId]) weekStatsByUser[s.userId] = [];
    weekStatsByUser[s.userId].push(s);
  }

  let speedToLeadByUser: Record<number, number> = {};
  if (allLeadIds.length > 0) {
    const firstTouchPerLeadRows = await db.select({
      userId: sql<number>`(ARRAY_AGG(${callAttemptsTable.userId} ORDER BY ${callAttemptsTable.attemptedAt} ASC))[1]`.as("first_touch_user"),
      leadId: callAttemptsTable.leadId,
      firstTouchAt: sql<Date>`MIN(${callAttemptsTable.attemptedAt})`.as("first_touch_at"),
      assignedAt: leadsTable.assignedAt,
      wallClockSpeed: sql<number>`MIN(EXTRACT(EPOCH FROM (${callAttemptsTable.attemptedAt} - ${leadsTable.assignedAt})))`.as("wall_clock_speed"),
    })
      .from(callAttemptsTable)
      .innerJoin(leadsTable, eq(callAttemptsTable.leadId, leadsTable.id))
      .where(and(
        inArray(callAttemptsTable.userId, userIds),
        gte(callAttemptsTable.attemptedAt, today),
        ne(callAttemptsTable.actionType, "transfer"),
        ne(callAttemptsTable.actionType, "system"),
      ))
      .groupBy(callAttemptsTable.leadId, leadsTable.assignedAt);

    const windows = firstTouchPerLeadRows
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
      const speedsByUser: Record<number, number[]> = {};
      for (const sr of speedResults) {
        if (!speedsByUser[sr.userId]) speedsByUser[sr.userId] = [];
        speedsByUser[sr.userId].push(sr.speed);
      }
      for (const [uid, speeds] of Object.entries(speedsByUser)) {
        if (speeds.length > 0) {
          speedToLeadByUser[Number(uid)] = Math.round(speeds.reduce((s, v) => s + v, 0) / speeds.length);
        }
      }
    } catch (err) {
      console.error("[SalesManager] Login-aware speed computation failed, using wall-clock fallback:", err);
      const speedsByUser: Record<number, number[]> = {};
      for (const w of windows) {
        if (w.wallClockSpeed > 0) {
          if (!speedsByUser[w.userId]) speedsByUser[w.userId] = [];
          speedsByUser[w.userId].push(w.wallClockSpeed);
        }
      }
      for (const [uid, speeds] of Object.entries(speedsByUser)) {
        if (speeds.length > 0) {
          speedToLeadByUser[Number(uid)] = Math.round(speeds.reduce((s, v) => s + v, 0) / speeds.length);
        }
      }
    }
  }

  const coordinators = users.map(user => {
    const calls = callCountMap[user.id] || 0;
    const userLeadIds = leadIdsByUser[user.id] || [];
    const userLeads = userLeadIds
      .filter(id => leadBookedByCsrMap[id] === user.id)
      .map(id => {
        const fId = leadFunnelIdMap[id];
        return { status: leadStatusMap[id] || "", funnelName: fId ? (funnelNameMap[fId] || null) : null, preBooked: preBookedMap[id] || false };
      });
    const nonPreBookedLeads = userLeads.filter(l => !l.preBooked);
    const bookings = nonPreBookedLeads.filter(l => ["booked", "sold"].includes(l.status)).length;
    const bookingRate = calls > 0 ? Math.round((bookings / calls) * 100) : 0;
    const commission = computeSpiffCommission(nonPreBookedLeads, spiffConfig);

    const ws = weekStatsByUser[user.id] || [];
    const weekAvgRate = ws.length > 0
      ? Math.round(ws.reduce((s, r) => s + r.bookingRate, 0) / ws.length)
      : 0;
    const weekTotalCalls = ws.reduce((s, r) => s + r.callsMade, 0);
    const weekTotalBookings = ws.reduce((s, r) => s + r.bookingsCount, 0);

    return {
      id: user.id,
      name: user.name,
      role: user.role,
      email: user.email,
      today: {
        callsMade: calls,
        bookings,
        bookingRate,
        commission,
        speedToLead: speedToLeadByUser[user.id] || 0,
      },
      week: {
        avgBookingRate: weekAvgRate,
        totalCalls: weekTotalCalls,
        totalBookings: weekTotalBookings,
        daysActive: ws.length,
      },
    };
  });

  coordinators.sort((a, b) => b.today.bookings - a.today.bookings || b.today.callsMade - a.today.callsMade);

  const teamTotals = {
    callsMade: coordinators.reduce((s, c) => s + c.today.callsMade, 0),
    bookings: coordinators.reduce((s, c) => s + c.today.bookings, 0),
    bookingRate: 0,
    commission: coordinators.reduce((s, c) => s + c.today.commission, 0),
    activeCoordinators: coordinators.filter(c => c.today.callsMade > 0).length,
    totalCoordinators: coordinators.length,
  };
  teamTotals.bookingRate = teamTotals.callsMade > 0 ? Math.round((teamTotals.bookings / teamTotals.callsMade) * 100) : 0;

  res.json({ coordinators, teamTotals });
});

router.get("/sales-manager/activity-feed", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ activities: [] });
    return;
  }

  const limit = Math.min(Number(req.query.limit) || 50, 100);

  const usersInTenant = await db.select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable).where(eq(usersTable.tenantId, tenantId));
  const userIds = usersInTenant.map(u => u.id);
  const userNameMap = Object.fromEntries(usersInTenant.map(u => [u.id, u.name]));

  if (userIds.length === 0) {
    res.json({ activities: [] });
    return;
  }

  const attempts = await db.select({
    id: callAttemptsTable.id,
    leadId: callAttemptsTable.leadId,
    userId: callAttemptsTable.userId,
    method: callAttemptsTable.method,
    outcome: callAttemptsTable.outcome,
    platform: callAttemptsTable.platform,
    attemptedAt: callAttemptsTable.attemptedAt,
    notes: callAttemptsTable.notes,
  }).from(callAttemptsTable)
    .where(inArray(callAttemptsTable.userId, userIds))
    .orderBy(desc(callAttemptsTable.attemptedAt))
    .limit(limit);

  const leadIds = [...new Set(attempts.map(a => a.leadId))];
  let leadMap: Record<number, { firstName: string; lastName: string; source: string; status: string }> = {};
  if (leadIds.length > 0) {
    const leads = await db.select({
      id: leadsTable.id,
      firstName: leadsTable.firstName,
      lastName: leadsTable.lastName,
      source: leadsTable.source,
      status: leadsTable.status,
    }).from(leadsTable).where(inArray(leadsTable.id, leadIds));
    leadMap = Object.fromEntries(leads.map(l => [l.id, l]));
  }

  const activities = attempts.map(a => ({
    id: a.id,
    coordinatorName: userNameMap[a.userId] || "Unknown",
    coordinatorId: a.userId,
    leadName: leadMap[a.leadId] ? `${leadMap[a.leadId].firstName} ${leadMap[a.leadId].lastName}` : "Unknown",
    leadSource: leadMap[a.leadId]?.source || "",
    leadStatus: leadMap[a.leadId]?.status || "",
    method: a.method,
    outcome: a.outcome,
    platform: a.platform,
    attemptedAt: a.attemptedAt,
    notes: a.notes,
  }));

  res.json({ activities });
});

router.get("/sales-manager/coaching-insights", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ insights: [] });
    return;
  }

  try {
    const insights = await generateCoachingInsights(tenantId);
    res.json({ insights });
  } catch (err) {
    console.error("[SalesManager] Coaching insights error:", err);
    res.json({ insights: [] });
  }
});

router.get("/sales-manager/recent-script-changes", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ changes: [] });
    return;
  }

  const changes = await db.select()
    .from(changeLogsTable)
    .where(and(
      eq(changeLogsTable.tenantId, tenantId),
      eq(changeLogsTable.category, "scripts"),
    ))
    .orderBy(desc(changeLogsTable.date))
    .limit(10);

  res.json({ changes });
});

router.get("/sales-manager/spiff-config", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ spiffConfig: DEFAULT_SPIFF_CONFIG });
    return;
  }
  const config = await getTenantSpiffConfig(tenantId);
  res.json({ spiffConfig: config });
});

router.put("/sales-manager/spiff-config", async (req, res) => {
  const role = req.session.userRole;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }
  const raw = req.body?.spiffConfig;
  if (!raw || typeof raw !== "object") {
    res.status(400).json({ error: "Invalid spiff config" });
    return;
  }
  const config = parseSpiffConfig(raw);
  await db.update(tenantsTable).set({ spiffConfig: config, updatedAt: new Date() }).where(eq(tenantsTable.id, tenantId));
  res.json({ spiffConfig: config });
});

router.get("/sales-manager/spiffs-audit", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ leads: [], totalSpiff: 0 });
    return;
  }

  const spiffConfig = await getTenantSpiffConfig(tenantId);

  const conds: any[] = [
    eq(leadsTable.tenantId, tenantId),
    inArray(leadsTable.status, ["booked", "sold"]),
    eq(leadsTable.preBooked, false),
  ];

  if (req.query.csrId) {
    const parsed = Number(req.query.csrId);
    if (isNaN(parsed)) { res.status(400).json({ error: "Invalid csrId" }); return; }
    conds.push(eq(leadsTable.bookedByCsrId, parsed));
  }
  if (req.query.funnelId) {
    const parsed = Number(req.query.funnelId);
    if (isNaN(parsed)) { res.status(400).json({ error: "Invalid funnelId" }); return; }
    conds.push(eq(leadsTable.funnelId, parsed));
  }
  if (req.query.startDate) {
    const d = new Date(req.query.startDate as string);
    if (isNaN(d.getTime())) { res.status(400).json({ error: "Invalid startDate" }); return; }
    conds.push(gte(leadsTable.updatedAt, d));
  }
  if (req.query.endDate) {
    const end = new Date(req.query.endDate as string);
    if (isNaN(end.getTime())) { res.status(400).json({ error: "Invalid endDate" }); return; }
    end.setHours(23, 59, 59, 999);
    conds.push(lte(leadsTable.updatedAt, end));
  }

  const rows = await db.select({
    id: leadsTable.id,
    firstName: leadsTable.firstName,
    lastName: leadsTable.lastName,
    status: leadsTable.status,
    funnelId: leadsTable.funnelId,
    bookedByCsrId: leadsTable.bookedByCsrId,
    updatedAt: leadsTable.updatedAt,
  })
    .from(leadsTable)
    .where(and(...conds))
    .orderBy(desc(leadsTable.updatedAt));

  const csrIds = [...new Set(rows.map(r => r.bookedByCsrId).filter((id): id is number => id !== null))];
  let csrNameMap: Record<number, string> = {};
  if (csrIds.length > 0) {
    const csrRows = await db.select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable).where(inArray(usersTable.id, csrIds));
    csrNameMap = Object.fromEntries(csrRows.map(c => [c.id, c.name]));
  }

  const funnelIds = [...new Set(rows.map(r => r.funnelId).filter((id): id is number => id !== null))];
  let funnelNameMap: Record<number, string> = {};
  if (funnelIds.length > 0) {
    const fRows = await db.select({ id: funnelTypesTable.id, name: funnelTypesTable.name })
      .from(funnelTypesTable).where(inArray(funnelTypesTable.id, funnelIds));
    funnelNameMap = Object.fromEntries(fRows.map(f => [f.id, f.name]));
  }

  let totalSpiff = 0;
  const leads = rows.map(r => {
    const funnelName = r.funnelId ? (funnelNameMap[r.funnelId] || null) : null;
    const amount = funnelName && spiffConfig.byFunnel[funnelName] !== undefined
      ? spiffConfig.byFunnel[funnelName]
      : spiffConfig.default;
    totalSpiff += amount;
    return {
      id: r.id,
      leadName: [r.firstName, r.lastName].filter(Boolean).join(" ") || "Unknown",
      csrName: r.bookedByCsrId ? (csrNameMap[r.bookedByCsrId] || "Unassigned") : "Unassigned",
      csrId: r.bookedByCsrId,
      funnelName: funnelName || "Default",
      funnelId: r.funnelId,
      status: r.status,
      spiffAmount: amount,
      date: r.updatedAt,
    };
  });

  res.json({ leads, totalSpiff });
});

router.get("/sales-manager/lead-types", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ leadTypes: [] });
    return;
  }
  const rows = await db.selectDistinct({ leadType: leadsTable.leadType })
    .from(leadsTable)
    .where(and(eq(leadsTable.tenantId, tenantId), isNotNull(leadsTable.leadType)));
  const leadTypes = rows.map(r => r.leadType).filter(Boolean).sort();
  res.json({ leadTypes });
});

export default router;
