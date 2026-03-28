import { Router, type IRouter } from "express";
import {
  db, leadsTable, callAttemptsTable, usersTable, scheduledFollowupsTable,
  funnelTypesTable, routingConfigTable, csrScheduleTable, tenantFunnelTypesTable,
} from "@workspace/db";
import { eq, and, sql, desc, asc, gte, lte, inArray, isNull, ne, count, or, isNotNull } from "drizzle-orm";
import { emitLeadUpdated, emitNewLead } from "../socket";

const router: IRouter = Router();

function resolveTenantId(req: any): number | null {
  const role = req.session?.userRole;
  if (role === "super_admin" || role === "agency_user") {
    return req.query.tenantId ? Number(req.query.tenantId) : req.body?.tenantId ? Number(req.body.tenantId) : req.session.tenantId ?? null;
  }
  return req.session?.tenantId ?? null;
}

router.get("/leads-hub/queue", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.json({ newLeads: [], today: [], callbacks: [], reengagement: [], oldLeads: [], total: 0 }); return; }

  const tab = (req.query.tab as string) || "all";
  const assignedCsrId = req.query.csrId ? Number(req.query.csrId) : null;
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const baseConds = [eq(leadsTable.tenantId, tenantId)];
  if (assignedCsrId) baseConds.push(eq(leadsTable.assignedCsrId, assignedCsrId));

  const activeStatuses = ["day_1", "day_2", "day_3", "day_4"];
  const terminalStatuses = ["appt_set", "dead"];

  try {
    const newLeads = (tab === "all" || tab === "new") ? await db.select().from(leadsTable)
      .where(and(...baseConds, eq(leadsTable.hubStatus, "day_1"), isNull(leadsTable.callbackAt)))
      .orderBy(asc(leadsTable.createdAt)).limit(100) : [];

    const todayLeads = (tab === "all" || tab === "today") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        inArray(leadsTable.hubStatus, activeStatuses),
        ne(leadsTable.hubStatus, "day_1"),
      ))
      .orderBy(asc(leadsTable.updatedAt)).limit(100) : [];

    const callbacks = (tab === "all" || tab === "callbacks") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        eq(leadsTable.hubStatus, "call_back"),
        isNotNull(leadsTable.callbackAt),
        lte(leadsTable.callbackAt, now),
      ))
      .orderBy(asc(leadsTable.callbackAt)).limit(100) : [];

    const reengagement = (tab === "all" || tab === "reengagement") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        eq(leadsTable.hubStatus, "day_5_old"),
        isNotNull(leadsTable.revisitDate),
        lte(leadsTable.revisitDate, now.toISOString().split("T")[0]),
      ))
      .orderBy(asc(leadsTable.revisitDate)).limit(100) : [];

    const oldLeads = (tab === "all" || tab === "old") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        eq(leadsTable.hubStatus, "day_5_old"),
        or(isNull(leadsTable.revisitDate), sql`${leadsTable.revisitDate} > CURRENT_DATE`),
      ))
      .orderBy(desc(leadsTable.updatedAt)).limit(100) : [];

    const [totalResult] = await db.select({ count: count() }).from(leadsTable)
      .where(and(...baseConds, sql`${leadsTable.hubStatus} NOT IN ('appt_set', 'dead')`));

    res.json({
      newLeads,
      today: todayLeads,
      callbacks,
      reengagement,
      oldLeads,
      total: totalResult.count,
    });
  } catch (err) {
    console.error("[LeadsHub Queue]", err);
    res.status(500).json({ error: "Failed to fetch queue" });
  }
});

router.get("/leads-hub/archive", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.json({ leads: [], total: 0 }); return; }

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const month = req.query.month as string | undefined;
  const source = req.query.source as string | undefined;
  const serviceType = req.query.serviceType as string | undefined;
  const csrId = req.query.csrId ? Number(req.query.csrId) : null;
  const status = req.query.status as string | undefined;

  const conds = [eq(leadsTable.tenantId, tenantId), inArray(leadsTable.hubStatus, ["appt_set", "dead"])];
  if (source) conds.push(eq(leadsTable.source, source));
  if (serviceType) conds.push(eq(leadsTable.serviceType, serviceType));
  if (csrId) conds.push(eq(leadsTable.assignedCsrId, csrId));
  if (status) conds.push(eq(leadsTable.hubStatus, status));
  if (month) {
    const [year, m] = month.split("-").map(Number);
    const start = new Date(year, m - 1, 1);
    const end = new Date(year, m, 1);
    conds.push(gte(leadsTable.createdAt, start));
    conds.push(lte(leadsTable.createdAt, end));
  }

  const where = and(...conds);
  const [leads, [totalResult]] = await Promise.all([
    db.select().from(leadsTable).where(where).orderBy(desc(leadsTable.updatedAt)).limit(limit).offset(offset),
    db.select({ count: count() }).from(leadsTable).where(where),
  ]);

  res.json({ leads, total: totalResult.count });
});

router.post("/leads-hub/action", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const { leadId, actionType, callResult, vmResult, textResult, deadReason, notes, callbackAt, revisitDate } = req.body;
  if (!leadId || !actionType) { res.status(400).json({ error: "leadId and actionType are required" }); return; }

  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const outcome = callResult || textResult || vmResult || actionType;

  await db.insert(callAttemptsTable).values({
    leadId,
    userId,
    method: actionType,
    outcome,
    platform: "native",
    actionType,
    callResult: callResult || null,
    vmResult: vmResult || null,
    textResult: textResult || null,
    deadReason: deadReason || null,
    notes: notes || null,
  });

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (callResult === "spoke_with_customer" || textResult === "yes") {
    if (callbackAt) {
      updates.hubStatus = "call_back";
      updates.callbackAt = new Date(callbackAt);
    }
  }

  if (deadReason) {
    updates.hubStatus = "dead";
    updates.deadReason = deadReason;
  }

  if (callResult === "spoke_with_customer" && req.body.appointmentSet) {
    updates.hubStatus = "appt_set";
    updates.status = "booked";
    updates.disposition = "booked";
  }

  if (callbackAt && !deadReason && !req.body.appointmentSet) {
    updates.hubStatus = "call_back";
    updates.callbackAt = new Date(callbackAt);
  }

  if (revisitDate) {
    updates.revisitDate = revisitDate;
  }

  const shouldIncrementDay = (
    actionType === "call" && (callResult === "no_answer" || callResult === "left_voicemail" || callResult === "vm_full" || callResult === "vm_not_setup")
  ) || actionType === "voicemail_drop";

  if (shouldIncrementDay && !deadReason && !req.body.appointmentSet && !callbackAt) {
    const newDay = Math.min(lead.dayInSequence + 1, 5);
    updates.dayInSequence = newDay;
    if (newDay >= 5 && lead.hubStatus !== "appt_set" && lead.hubStatus !== "dead") {
      updates.hubStatus = "day_5_old";
    } else if (newDay <= 4) {
      updates.hubStatus = `day_${newDay}`;
    }
  }

  const [updated] = await db.update(leadsTable).set(updates).where(eq(leadsTable.id, leadId)).returning();

  emitLeadUpdated(lead.tenantId, updated as unknown as Record<string, unknown>);
  res.json({ lead: updated, action: { actionType, outcome } });
});

router.get("/leads-hub/:leadId/history", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const leadId = parseInt(String(req.params.leadId));
  const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const attempts = await db.select({
    id: callAttemptsTable.id,
    leadId: callAttemptsTable.leadId,
    userId: callAttemptsTable.userId,
    method: callAttemptsTable.method,
    outcome: callAttemptsTable.outcome,
    platform: callAttemptsTable.platform,
    attemptedAt: callAttemptsTable.attemptedAt,
    notes: callAttemptsTable.notes,
    actionType: callAttemptsTable.actionType,
    callResult: callAttemptsTable.callResult,
    vmResult: callAttemptsTable.vmResult,
    textResult: callAttemptsTable.textResult,
    deadReason: callAttemptsTable.deadReason,
  }).from(callAttemptsTable)
    .where(eq(callAttemptsTable.leadId, leadId))
    .orderBy(desc(callAttemptsTable.attemptedAt));

  const userIds = [...new Set(attempts.map(a => a.userId))];
  let userMap: Record<number, string> = {};
  if (userIds.length > 0) {
    const users = await db.select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable).where(inArray(usersTable.id, userIds));
    userMap = Object.fromEntries(users.map(u => [u.id, u.name]));
  }

  const history = attempts.map(a => ({
    ...a,
    csrName: userMap[a.userId] || "Unknown",
  }));

  res.json({ history });
});

router.post("/leads-hub/:leadId/transfer", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const leadId = parseInt(String(req.params.leadId));
  const { targetCsrId } = req.body;
  if (!targetCsrId) { res.status(400).json({ error: "targetCsrId is required" }); return; }

  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const [targetUser] = await db.select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable).where(and(eq(usersTable.id, targetCsrId), eq(usersTable.tenantId, tenantId)));
  if (!targetUser) { res.status(404).json({ error: "Target CSR not found" }); return; }

  await db.insert(callAttemptsTable).values({
    leadId,
    userId,
    method: "transfer",
    outcome: "transferred",
    platform: "native",
    actionType: "call",
    notes: `Transferred to ${targetUser.name}`,
  });

  const [updated] = await db.update(leadsTable)
    .set({ assignedCsrId: targetCsrId, assignedTo: targetUser.name, updatedAt: new Date() })
    .where(eq(leadsTable.id, leadId))
    .returning();

  emitLeadUpdated(lead.tenantId, updated as unknown as Record<string, unknown>);
  res.json({ lead: updated });
});

router.post("/leads-hub/create", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const { firstName, lastName, phone, email, source, serviceType, funnelId, assignedCsrId, contactPreferences } = req.body;
  if (!firstName || !lastName || !source) {
    res.status(400).json({ error: "firstName, lastName, and source are required" });
    return;
  }

  const [lead] = await db.insert(leadsTable).values({
    tenantId,
    firstName,
    lastName,
    phone: phone || null,
    email: email || null,
    source,
    serviceType: serviceType || null,
    funnelId: funnelId || null,
    assignedCsrId: assignedCsrId || null,
    assignedTo: null,
    contactPreferences: contactPreferences || [],
    hubStatus: "day_1",
    dayInSequence: 1,
    status: "new",
  }).returning();

  if (assignedCsrId) {
    const [user] = await db.select({ name: usersTable.name }).from(usersTable)
      .where(and(eq(usersTable.id, assignedCsrId), eq(usersTable.tenantId, tenantId)));
    if (user) {
      await db.update(leadsTable).set({ assignedTo: user.name }).where(eq(leadsTable.id, lead.id));
    }
  }

  emitNewLead(tenantId, lead as unknown as Record<string, unknown>);
  res.status(201).json(lead);
});

router.get("/leads-hub/csrs", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.json({ csrs: [] }); return; }

  const users = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role })
    .from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true)));

  const schedules = await db.select().from(csrScheduleTable)
    .where(eq(csrScheduleTable.tenantId, tenantId));
  const scheduleMap: Record<number, typeof schedules[0]> = {};
  for (const s of schedules) scheduleMap[s.userId] = s;

  const now = new Date();
  const csrs = users.map(u => {
    const schedule = scheduleMap[u.id];
    let isPaused = schedule?.isPaused || false;
    if (isPaused && schedule?.pauseEnd && new Date(schedule.pauseEnd) < now) {
      isPaused = false;
    }
    return {
      ...u,
      isPaused,
      pauseStart: schedule?.pauseStart || null,
      pauseEnd: schedule?.pauseEnd || null,
    };
  });

  res.json({ csrs });
});

router.get("/leads-hub/routing-config", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.json({ configs: [] }); return; }

  const configs = await db.select().from(routingConfigTable)
    .where(eq(routingConfigTable.tenantId, tenantId))
    .orderBy(asc(routingConfigTable.funnelTypeId));

  res.json({ configs });
});

router.put("/leads-hub/routing-config", async (req, res) => {
  const role = req.session?.userRole;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied" }); return;
  }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const { funnelTypeId, cascadeOrder, passIntervalHours, allowPassBack } = req.body;

  const existing = await db.select().from(routingConfigTable)
    .where(and(
      eq(routingConfigTable.tenantId, tenantId),
      funnelTypeId ? eq(routingConfigTable.funnelTypeId, funnelTypeId) : isNull(routingConfigTable.funnelTypeId),
    ));

  if (existing.length > 0) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (cascadeOrder !== undefined) updates.cascadeOrder = cascadeOrder;
    if (passIntervalHours !== undefined) updates.passIntervalHours = passIntervalHours;
    if (allowPassBack !== undefined) updates.allowPassBack = allowPassBack;

    const [updated] = await db.update(routingConfigTable)
      .set(updates)
      .where(eq(routingConfigTable.id, existing[0].id))
      .returning();
    res.json(updated);
  } else {
    const [created] = await db.insert(routingConfigTable).values({
      tenantId,
      funnelTypeId: funnelTypeId || null,
      cascadeOrder: cascadeOrder || [],
      passIntervalHours: passIntervalHours || 24,
      allowPassBack: allowPassBack || false,
    }).returning();
    res.json(created);
  }
});

router.put("/leads-hub/csr-schedule/:userId", async (req, res) => {
  const role = req.session?.userRole;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied" }); return;
  }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const targetUserId = parseInt(String(req.params.userId));
  const { isPaused, pauseStart, pauseEnd } = req.body;

  const [targetUser] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(and(eq(usersTable.id, targetUserId), eq(usersTable.tenantId, tenantId)));
  if (!targetUser) { res.status(404).json({ error: "User not found in this tenant" }); return; }

  const existing = await db.select().from(csrScheduleTable)
    .where(and(eq(csrScheduleTable.tenantId, tenantId), eq(csrScheduleTable.userId, targetUserId)));

  if (existing.length > 0) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (isPaused !== undefined) updates.isPaused = isPaused;
    if (pauseStart !== undefined) updates.pauseStart = pauseStart ? new Date(pauseStart) : null;
    if (pauseEnd !== undefined) updates.pauseEnd = pauseEnd ? new Date(pauseEnd) : null;

    const [updated] = await db.update(csrScheduleTable)
      .set(updates)
      .where(eq(csrScheduleTable.id, existing[0].id))
      .returning();
    res.json(updated);
  } else {
    const [created] = await db.insert(csrScheduleTable).values({
      tenantId,
      userId: targetUserId,
      isPaused: isPaused || false,
      pauseStart: pauseStart ? new Date(pauseStart) : null,
      pauseEnd: pauseEnd ? new Date(pauseEnd) : null,
    }).returning();
    res.json(created);
  }
});

router.post("/leads-hub/assign-round-robin", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const { leadId, funnelTypeId } = req.body;
  if (!leadId) { res.status(400).json({ error: "leadId is required" }); return; }

  const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const configs = await db.select().from(routingConfigTable)
    .where(and(
      eq(routingConfigTable.tenantId, tenantId),
      eq(routingConfigTable.isActive, true),
      funnelTypeId ? eq(routingConfigTable.funnelTypeId, funnelTypeId) : isNull(routingConfigTable.funnelTypeId),
    ));

  let config = configs[0];
  if (!config && funnelTypeId) {
    const fallback = await db.select().from(routingConfigTable)
      .where(and(eq(routingConfigTable.tenantId, tenantId), eq(routingConfigTable.isActive, true), isNull(routingConfigTable.funnelTypeId)));
    config = fallback[0];
  }

  if (!config || !config.cascadeOrder || (config.cascadeOrder as number[]).length === 0) {
    res.json({ assignedCsrId: null, reason: "No routing config" });
    return;
  }

  const now = new Date();
  const pausedSchedules = await db.select().from(csrScheduleTable)
    .where(and(eq(csrScheduleTable.tenantId, tenantId), eq(csrScheduleTable.isPaused, true)));
  const pausedUserIds = new Set(
    pausedSchedules
      .filter(s => !s.pauseEnd || new Date(s.pauseEnd) > now)
      .map(s => s.userId)
  );

  const order = (config.cascadeOrder as number[]).filter(id => !pausedUserIds.has(id));
  if (order.length === 0) {
    res.json({ assignedCsrId: null, reason: "All CSRs are paused" });
    return;
  }

  const recentAssignments = await db.select({
    assignedCsrId: leadsTable.assignedCsrId,
    count: count(),
  }).from(leadsTable)
    .where(and(
      eq(leadsTable.tenantId, tenantId),
      isNotNull(leadsTable.assignedCsrId),
      gte(leadsTable.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    ))
    .groupBy(leadsTable.assignedCsrId);

  const assignmentCounts: Record<number, number> = {};
  for (const r of recentAssignments) {
    if (r.assignedCsrId) assignmentCounts[r.assignedCsrId] = r.count;
  }

  let selectedCsrId = order[0];
  let minAssignments = assignmentCounts[order[0]] || 0;
  for (const csrId of order) {
    const c = assignmentCounts[csrId] || 0;
    if (c < minAssignments) {
      minAssignments = c;
      selectedCsrId = csrId;
    }
  }

  const [user] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, selectedCsrId));
  const [updated] = await db.update(leadsTable)
    .set({ assignedCsrId: selectedCsrId, assignedTo: user?.name || null, updatedAt: new Date() })
    .where(eq(leadsTable.id, leadId))
    .returning();

  res.json({ assignedCsrId: selectedCsrId, csrName: user?.name, lead: updated });
});

router.get("/leads-hub/stats", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.json({ stats: {} }); return; }

  const startDate = req.query.startDate ? new Date(req.query.startDate as string) : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
  const funnelId = req.query.funnelId ? Number(req.query.funnelId) : null;

  const baseConds = [
    eq(leadsTable.tenantId, tenantId),
    gte(leadsTable.createdAt, startDate),
    lte(leadsTable.createdAt, endDate),
  ];
  if (funnelId) baseConds.push(eq(leadsTable.funnelId, funnelId));

  const leads = await db.select({
    id: leadsTable.id,
    hubStatus: leadsTable.hubStatus,
    source: leadsTable.source,
    funnelId: leadsTable.funnelId,
    assignedCsrId: leadsTable.assignedCsrId,
    serviceType: leadsTable.serviceType,
  }).from(leadsTable).where(and(...baseConds));

  const totalLeads = leads.length;
  const appointments = leads.filter(l => l.hubStatus === "appt_set").length;
  const bookingRate = totalLeads > 0 ? Math.round((appointments / totalLeads) * 100) : 0;

  const bySource: Record<string, { total: number; appointments: number }> = {};
  const byFunnel: Record<number, { total: number; appointments: number }> = {};
  const byCsr: Record<number, { total: number; appointments: number }> = {};

  for (const l of leads) {
    if (!bySource[l.source]) bySource[l.source] = { total: 0, appointments: 0 };
    bySource[l.source].total++;
    if (l.hubStatus === "appt_set") bySource[l.source].appointments++;

    if (l.funnelId) {
      if (!byFunnel[l.funnelId]) byFunnel[l.funnelId] = { total: 0, appointments: 0 };
      byFunnel[l.funnelId].total++;
      if (l.hubStatus === "appt_set") byFunnel[l.funnelId].appointments++;
    }

    if (l.assignedCsrId) {
      if (!byCsr[l.assignedCsrId]) byCsr[l.assignedCsrId] = { total: 0, appointments: 0 };
      byCsr[l.assignedCsrId].total++;
      if (l.hubStatus === "appt_set") byCsr[l.assignedCsrId].appointments++;
    }
  }

  const callConds = [
    inArray(callAttemptsTable.leadId, leads.map(l => l.id).length > 0 ? leads.map(l => l.id) : [0]),
    gte(callAttemptsTable.attemptedAt, startDate),
    lte(callAttemptsTable.attemptedAt, endDate),
  ];

  const callStats = leads.length > 0 ? await db.select({
    userId: callAttemptsTable.userId,
    actionType: callAttemptsTable.actionType,
    count: count(),
  }).from(callAttemptsTable)
    .where(and(...callConds))
    .groupBy(callAttemptsTable.userId, callAttemptsTable.actionType) : [];

  const csrCallStats: Record<number, { calls: number; texts: number; vms: number }> = {};
  for (const s of callStats) {
    if (!csrCallStats[s.userId]) csrCallStats[s.userId] = { calls: 0, texts: 0, vms: 0 };
    if (s.actionType === "call") csrCallStats[s.userId].calls = s.count;
    if (s.actionType === "text") csrCallStats[s.userId].texts = s.count;
    if (s.actionType === "voicemail_drop") csrCallStats[s.userId].vms = s.count;
  }

  res.json({
    totalLeads,
    appointments,
    bookingRate,
    bySource: Object.entries(bySource).map(([source, data]) => ({
      source,
      ...data,
      bookingRate: data.total > 0 ? Math.round((data.appointments / data.total) * 100) : 0,
    })),
    byFunnel: Object.entries(byFunnel).map(([funnelId, data]) => ({
      funnelId: Number(funnelId),
      ...data,
      bookingRate: data.total > 0 ? Math.round((data.appointments / data.total) * 100) : 0,
    })),
    byCsr: Object.entries(byCsr).map(([csrId, data]) => ({
      csrId: Number(csrId),
      ...data,
      bookingRate: data.total > 0 ? Math.round((data.appointments / data.total) * 100) : 0,
      ...(csrCallStats[Number(csrId)] || { calls: 0, texts: 0, vms: 0 }),
    })),
  });
});

export default router;
