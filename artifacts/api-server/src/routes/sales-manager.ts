import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, callAttemptsTable, leadsTable, usersTable, coordinatorDailyStatsTable, changeLogsTable, scriptsTable, tenantsTable } from "@workspace/db";
import { eq, and, sql, gte, lte, count, inArray, desc, ne, isNotNull } from "drizzle-orm";
import { generateCoachingInsights } from "../services/coaching-insights";

export interface SpiffConfig {
  default: number;
  byLeadType: Record<string, number>;
}

const DEFAULT_SPIFF_CONFIG: SpiffConfig = { default: 20, byLeadType: {} };

export function parseSpiffConfig(raw: unknown): SpiffConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SPIFF_CONFIG };
  const obj = raw as Record<string, unknown>;
  return {
    default: typeof obj.default === "number" && obj.default >= 0 ? obj.default : 20,
    byLeadType: obj.byLeadType && typeof obj.byLeadType === "object"
      ? Object.fromEntries(
          Object.entries(obj.byLeadType as Record<string, unknown>)
            .filter(([, v]) => typeof v === "number" && v >= 0)
            .map(([k, v]) => [k, v as number])
        )
      : {},
  };
}

export function computeSpiffCommission(
  leads: { status: string; leadType: string | null }[],
  spiffConfig: SpiffConfig,
): number {
  let total = 0;
  for (const lead of leads) {
    if (lead.status !== "booked" && lead.status !== "sold") continue;
    const lt = lead.leadType || "";
    const amount = lt && spiffConfig.byLeadType[lt] !== undefined
      ? spiffConfig.byLeadType[lt]
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
  const role = (req.session as Record<string, unknown>)?.userRole as string | undefined;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied. Requires manager role." });
    return;
  }
  next();
}

function resolveTenantId(req: Request): number | null {
  const session = req.session as Record<string, unknown>;
  const role = session?.userRole as string | undefined;
  if (role === "super_admin" || role === "agency_user") {
    return req.query.tenantId ? Number(req.query.tenantId) : (session.tenantId as number | null) ?? null;
  }
  return (session?.tenantId as number | null) ?? null;
}

router.use(requireManagerRole);

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
    ))
    .groupBy(callAttemptsTable.userId);

  const callCountMap: Record<number, number> = {};
  for (const a of todayAttempts) callCountMap[a.userId] = a.callCount;

  const todayLeadIds = await db.selectDistinct({ leadId: callAttemptsTable.leadId, userId: callAttemptsTable.userId })
    .from(callAttemptsTable)
    .where(and(
      inArray(callAttemptsTable.userId, userIds),
      gte(callAttemptsTable.attemptedAt, today),
    ));

  const leadIdsByUser: Record<number, number[]> = {};
  for (const r of todayLeadIds) {
    if (!leadIdsByUser[r.userId]) leadIdsByUser[r.userId] = [];
    leadIdsByUser[r.userId].push(r.leadId);
  }

  const allLeadIds = [...new Set(todayLeadIds.map(r => r.leadId))];
  let leadStatusMap: Record<number, string> = {};
  let leadTypeMap: Record<number, string | null> = {};
  if (allLeadIds.length > 0) {
    const leads = await db.select({ id: leadsTable.id, status: leadsTable.status, leadType: leadsTable.leadType })
      .from(leadsTable).where(inArray(leadsTable.id, allLeadIds));
    leadStatusMap = Object.fromEntries(leads.map(l => [l.id, l.status]));
    leadTypeMap = Object.fromEntries(leads.map(l => [l.id, l.leadType]));
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
    const speedRows = await db.select({
      userId: callAttemptsTable.userId,
      avgSpeed: sql<number>`avg(extract(epoch from (${callAttemptsTable.attemptedAt} - ${leadsTable.createdAt})))`.as("avg_speed"),
    })
      .from(callAttemptsTable)
      .innerJoin(leadsTable, eq(callAttemptsTable.leadId, leadsTable.id))
      .where(and(
        inArray(callAttemptsTable.userId, userIds),
        gte(callAttemptsTable.attemptedAt, today),
      ))
      .groupBy(callAttemptsTable.userId);
    for (const r of speedRows) {
      speedToLeadByUser[r.userId] = Math.max(0, Math.round(Number(r.avgSpeed)));
    }
  }

  const coordinators = users.map(user => {
    const calls = callCountMap[user.id] || 0;
    const userLeadIds = leadIdsByUser[user.id] || [];
    const userLeads = userLeadIds.map(id => ({ status: leadStatusMap[id] || "", leadType: leadTypeMap[id] || null }));
    const bookings = userLeads.filter(l => ["booked", "sold"].includes(l.status)).length;
    const bookingRate = calls > 0 ? Math.round((bookings / calls) * 100) : 0;
    const commission = computeSpiffCommission(userLeads, spiffConfig);

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
  const role = (req.session as Record<string, unknown>)?.userRole as string | undefined;
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
