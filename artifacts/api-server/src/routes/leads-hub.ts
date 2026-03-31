import { Router, type IRouter, type Request } from "express";
import {
  db, leadsTable, callAttemptsTable, usersTable, scheduledFollowupsTable,
  funnelTypesTable, routingConfigTable, csrScheduleTable, tenantFunnelTypesTable,
  tenantsTable,
} from "@workspace/db";
import { eq, and, sql, desc, asc, gte, lte, inArray, isNull, ne, count, or, isNotNull } from "drizzle-orm";
import { emitLeadUpdated, emitNewLead } from "../socket";
import { assignLeadRoundRobin } from "../services/round-robin";
import { normalizeSource } from "../services/source-normalizer";

const router: IRouter = Router();

const VALID_HUB_STATUSES = ["day_1", "day_2", "day_3", "day_4", "day_5_old", "appt_set", "appt_booked", "call_back", "dead"] as const;
type HubStatus = typeof VALID_HUB_STATUSES[number];

function hubStatusToLegacy(hubStatus: HubStatus): string {
  switch (hubStatus) {
    case "day_1": return "new";
    case "day_2":
    case "day_3":
    case "day_4":
    case "day_5_old":
    case "call_back": return "contacted";
    case "appt_set": return "booked";
    case "appt_booked": return "new";
    case "dead": return "lost";
    default: return "new";
  }
}

function resolveTenantId(req: Request): number | null {
  const session = req.session as unknown as Record<string, unknown> | undefined;
  const role = session?.userRole as string | undefined;
  if (role === "super_admin" || role === "agency_user") {
    const queryTid = (req.query as Record<string, string>).tenantId;
    const bodyTid = (req.body as Record<string, unknown>)?.tenantId;
    return queryTid ? Number(queryTid) : bodyTid ? Number(bodyTid) : (session?.tenantId as number) ?? null;
  }
  return (session?.tenantId as number) ?? null;
}

router.get("/leads-hub/queue", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.json({ newLeads: [], today: [], callbacks: [], reengagement: [], oldLeads: [], total: 0 }); return; }

  const tab = (req.query.tab as string) || "all";
  const assignedCsrId = req.query.csrId ? Number(req.query.csrId) : null;

  const [tenant] = await db.select({ timezone: tenantsTable.timezone }).from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  const tz = tenant?.timezone || "America/New_York";

  const now = new Date();

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const tzParts = fmt.formatToParts(now);
  const g = (t: string) => parseInt(tzParts.find(p => p.type === t)?.value || "0");
  const todayDateStr = `${g("year")}-${String(g("month")).padStart(2, "0")}-${String(g("day")).padStart(2, "0")}`;

  const midnightWallUtc = Date.UTC(g("year"), g("month") - 1, g("day"), 0, 0, 0);
  const approxMidnightUtc = new Date(midnightWallUtc);
  const midParts = fmt.formatToParts(approxMidnightUtc);
  const gm = (t: string) => parseInt(midParts.find(p => p.type === t)?.value || "0");
  const wallAtMidnight = Date.UTC(gm("year"), gm("month") - 1, gm("day"), gm("hour") === 24 ? 0 : gm("hour"), gm("minute"), gm("second"));
  const midnightOffset = wallAtMidnight - approxMidnightUtc.getTime();
  const todayStartUtc = new Date(midnightWallUtc - midnightOffset);

  const visibilityFilter = or(isNull(leadsTable.visibleAfter), lte(leadsTable.visibleAfter, now));
  const baseConds = [eq(leadsTable.tenantId, tenantId), visibilityFilter];
  if (assignedCsrId) baseConds.push(eq(leadsTable.assignedCsrId, assignedCsrId));

  const activeStatuses = ["day_1", "day_2", "day_3", "day_4", "appt_booked"];
  const terminalStatuses = ["appt_set", "dead"];

  try {
    const newLeads = (tab === "all" || tab === "new") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        or(
          and(
            eq(leadsTable.hubStatus, "day_1"),
            isNull(leadsTable.callbackAt),
            sql`NOT EXISTS (SELECT 1 FROM call_attempts WHERE call_attempts.lead_id = ${leadsTable.id})`,
          ),
          and(
            eq(leadsTable.hubStatus, "appt_booked"),
            sql`NOT EXISTS (SELECT 1 FROM call_attempts WHERE call_attempts.lead_id = ${leadsTable.id})`,
          ),
        ),
      ))
      .orderBy(desc(leadsTable.createdAt)).limit(100) : [];

    const todayLeads = (tab === "all" || tab === "today") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        inArray(leadsTable.hubStatus, activeStatuses),
        sql`EXISTS (SELECT 1 FROM call_attempts WHERE call_attempts.lead_id = ${leadsTable.id})`,
        gte(leadsTable.updatedAt, todayStartUtc),
      ))
      .orderBy(desc(leadsTable.updatedAt)).limit(100) : [];

    const callbacks = (tab === "all" || tab === "callbacks") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        eq(leadsTable.hubStatus, "call_back"),
        isNotNull(leadsTable.callbackAt),
        lte(leadsTable.callbackAt, now),
      ))
      .orderBy(desc(leadsTable.callbackAt)).limit(100) : [];

    const reengagement = (tab === "all" || tab === "reengagement") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        eq(leadsTable.hubStatus, "day_5_old"),
        isNotNull(leadsTable.revisitDate),
        lte(leadsTable.revisitDate, todayDateStr),
      ))
      .orderBy(desc(leadsTable.revisitDate)).limit(100) : [];

    const oldLeads = (tab === "all" || tab === "old") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        eq(leadsTable.hubStatus, "day_5_old"),
        or(isNull(leadsTable.revisitDate), sql`${leadsTable.revisitDate} > ${todayDateStr}`),
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
      timezone: tz,
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

  const apptBookedOutcome = req.body.apptBookedOutcome as string | undefined;
  const outcome = apptBookedOutcome ? `appt_${apptBookedOutcome}` : (callResult || textResult || vmResult || actionType);

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
    notes: apptBookedOutcome === "canceled" ? (req.body.cancelReason || "appointment_canceled") : (notes || null),
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

  if (apptBookedOutcome && lead.hubStatus === "appt_booked") {
    const outcome = apptBookedOutcome;
    if (outcome === "confirmed") {
      updates.hubStatus = "appt_set";
      updates.status = "booked";
      updates.disposition = "booked";
    } else if (outcome === "rescheduled") {
      updates.hubStatus = "appt_booked";
    } else if (outcome === "canceled") {
      updates.hubStatus = "dead";
      updates.deadReason = req.body.cancelReason || "appointment_canceled";
    }
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

  if (shouldIncrementDay && !deadReason && !req.body.appointmentSet && !callbackAt && lead.hubStatus !== "appt_booked") {
    const newDay = Math.min(lead.dayInSequence + 1, 5);
    updates.dayInSequence = newDay;
    if (newDay >= 5 && lead.hubStatus !== "appt_set" && lead.hubStatus !== "dead") {
      updates.hubStatus = "day_5_old";
    } else if (newDay <= 4) {
      updates.hubStatus = `day_${newDay}`;
    }
  }

  if (updates.hubStatus) {
    updates.status = hubStatusToLegacy(updates.hubStatus as HubStatus);
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
    .set({ assignedCsrId: targetCsrId, assignedTo: targetUser.name, updatedAt: new Date(), cascadePassCount: 0 })
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

  let validatedCsrId: number | null = null;
  let csrName: string | null = null;
  if (assignedCsrId) {
    const [user] = await db.select({ id: usersTable.id, name: usersTable.name, isActive: usersTable.isActive })
      .from(usersTable)
      .where(and(eq(usersTable.id, assignedCsrId), eq(usersTable.tenantId, tenantId)));
    if (!user || !user.isActive) {
      res.status(400).json({ error: "Invalid or inactive CSR for this tenant" });
      return;
    }
    validatedCsrId = user.id;
    csrName = user.name;
  }

  const normalizedSource = await normalizeSource(tenantId, source);

  const [lead] = await db.insert(leadsTable).values({
    tenantId,
    firstName,
    lastName,
    phone: phone || null,
    email: email || null,
    source: normalizedSource,
    serviceType: serviceType || null,
    funnelId: funnelId || null,
    assignedCsrId: validatedCsrId,
    assignedTo: csrName,
    contactPreferences: contactPreferences || [],
    hubStatus: "day_1",
    dayInSequence: 1,
    status: "new",
  }).returning();

  if (!validatedCsrId) {
    try {
      const result = await assignLeadRoundRobin(tenantId, lead.id, funnelId || null);
      if (result.assignedCsrId) {
        const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
        emitNewLead(tenantId, (refreshed ?? lead) as unknown as Record<string, unknown>);
        res.status(201).json(refreshed ?? lead);
        return;
      } else {
        console.warn(`[LeadsHub Create] Lead ${lead.id} not assigned: ${result.reason}`);
      }
    } catch (err) {
      console.warn("[LeadsHub Create] Auto-assign round-robin failed for lead", lead.id, err);
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

  const { funnelTypeId, cascadeOrder, passIntervalMinutes, allowPassBack, stickyAfterCascade, stickyCsrId } = req.body;

  if (stickyAfterCascade && !allowPassBack) {
    res.status(400).json({ error: "Allow Pass-Back must be enabled to use Sticky After Cascade" });
    return;
  }

  if (stickyAfterCascade && !stickyCsrId) {
    res.status(400).json({ error: "A CSR must be selected when Sticky After Cascade is enabled" });
    return;
  }

  if (stickyCsrId) {
    const [csrExists] = await db.select({ id: usersTable.id, isActive: usersTable.isActive })
      .from(usersTable)
      .where(and(eq(usersTable.id, stickyCsrId), eq(usersTable.tenantId, tenantId)));
    if (!csrExists) {
      res.status(400).json({ error: "Selected sticky CSR does not belong to this tenant" });
      return;
    }
    if (!csrExists.isActive) {
      res.status(400).json({ error: "Selected sticky CSR is inactive" });
      return;
    }
  }

  const existing = await db.select().from(routingConfigTable)
    .where(and(
      eq(routingConfigTable.tenantId, tenantId),
      funnelTypeId ? eq(routingConfigTable.funnelTypeId, funnelTypeId) : isNull(routingConfigTable.funnelTypeId),
    ));

  if (existing.length > 0) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (cascadeOrder !== undefined) updates.cascadeOrder = cascadeOrder;
    if (passIntervalMinutes !== undefined) updates.passIntervalMinutes = passIntervalMinutes;
    if (allowPassBack !== undefined) updates.allowPassBack = allowPassBack;
    if (stickyAfterCascade !== undefined) updates.stickyAfterCascade = stickyAfterCascade;
    if (stickyCsrId !== undefined) updates.stickyCsrId = stickyCsrId;

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
      passIntervalMinutes: passIntervalMinutes || 1440,
      allowPassBack: allowPassBack || false,
      stickyAfterCascade: stickyAfterCascade || false,
      stickyCsrId: stickyCsrId || null,
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

  const result = await assignLeadRoundRobin(tenantId, leadId, funnelTypeId || null);
  if (result.assignedCsrId) {
    const [updated] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    res.json({ assignedCsrId: result.assignedCsrId, csrName: result.csrName, lead: updated });
  } else {
    res.json(result);
  }
});

router.get("/leads-hub/stats", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.json({ stats: {} }); return; }

  const startDate = req.query.startDate ? new Date(req.query.startDate as string) : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
  const funnelId = req.query.funnelId ? Number(req.query.funnelId) : null;
  const includePreBooked = req.query.includePreBooked === "true";

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
    preBooked: leadsTable.preBooked,
  }).from(leadsTable).where(and(...baseConds));

  const filteredLeads = includePreBooked ? leads : leads.filter(l => !l.preBooked);
  const totalLeads = filteredLeads.length;
  const appointments = filteredLeads.filter(l => l.hubStatus === "appt_set" || l.hubStatus === "appt_booked").length;
  const bookingRate = totalLeads > 0 ? Math.round((appointments / totalLeads) * 100) : 0;

  const bySource: Record<string, { total: number; appointments: number }> = {};
  const byFunnel: Record<number, { total: number; appointments: number }> = {};
  const byCsr: Record<number, { total: number; appointments: number }> = {};
  const byCsrByFunnel: Record<string, { csrId: number; funnelId: number; total: number; appointments: number }> = {};
  const leadFunnelMap: Record<number, number> = {};

  const isAppt = (status: string) => status === "appt_set" || status === "appt_booked";

  for (const l of filteredLeads) {
    if (!bySource[l.source]) bySource[l.source] = { total: 0, appointments: 0 };
    bySource[l.source].total++;
    if (isAppt(l.hubStatus)) bySource[l.source].appointments++;

    if (l.funnelId) {
      if (!byFunnel[l.funnelId]) byFunnel[l.funnelId] = { total: 0, appointments: 0 };
      byFunnel[l.funnelId].total++;
      if (isAppt(l.hubStatus)) byFunnel[l.funnelId].appointments++;
      leadFunnelMap[l.id] = l.funnelId;
    }

    if (l.assignedCsrId) {
      if (!byCsr[l.assignedCsrId]) byCsr[l.assignedCsrId] = { total: 0, appointments: 0 };
      byCsr[l.assignedCsrId].total++;
      if (isAppt(l.hubStatus)) byCsr[l.assignedCsrId].appointments++;

      if (l.funnelId) {
        const key = `${l.assignedCsrId}_${l.funnelId}`;
        if (!byCsrByFunnel[key]) byCsrByFunnel[key] = { csrId: l.assignedCsrId, funnelId: l.funnelId, total: 0, appointments: 0 };
        byCsrByFunnel[key].total++;
        if (isAppt(l.hubStatus)) byCsrByFunnel[key].appointments++;
      }
    }
  }

  const filteredLeadIds = filteredLeads.map(l => l.id);
  const callConds = [
    inArray(callAttemptsTable.leadId, filteredLeadIds.length > 0 ? filteredLeadIds : [0]),
    gte(callAttemptsTable.attemptedAt, startDate),
    lte(callAttemptsTable.attemptedAt, endDate),
  ];

  const callStats = filteredLeadIds.length > 0 ? await db.select({
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

  const callsByFunnelRaw = filteredLeadIds.length > 0 ? await db.select({
    leadId: callAttemptsTable.leadId,
    actionType: callAttemptsTable.actionType,
    count: count(),
  }).from(callAttemptsTable)
    .where(and(...callConds))
    .groupBy(callAttemptsTable.leadId, callAttemptsTable.actionType) : [];

  const callsByFunnel: Record<number, { calls: number; texts: number; vms: number }> = {};
  for (const r of callsByFunnelRaw) {
    const fId = leadFunnelMap[r.leadId];
    if (!fId) continue;
    if (!callsByFunnel[fId]) callsByFunnel[fId] = { calls: 0, texts: 0, vms: 0 };
    if (r.actionType === "call") callsByFunnel[fId].calls += r.count;
    if (r.actionType === "text") callsByFunnel[fId].texts += r.count;
    if (r.actionType === "voicemail_drop") callsByFunnel[fId].vms += r.count;
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
      ...(callsByFunnel[Number(funnelId)] || { calls: 0, texts: 0, vms: 0 }),
    })),
    byCsr: Object.entries(byCsr).map(([csrId, data]) => ({
      csrId: Number(csrId),
      ...data,
      bookingRate: data.total > 0 ? Math.round((data.appointments / data.total) * 100) : 0,
      ...(csrCallStats[Number(csrId)] || { calls: 0, texts: 0, vms: 0 }),
    })),
    byCsrByFunnel: Object.values(byCsrByFunnel).map(d => ({
      ...d,
      bookingRate: d.total > 0 ? Math.round((d.appointments / d.total) * 100) : 0,
    })),
  });
});

export async function evaluateAutoPass(): Promise<number> {
  let passed = 0;
  const configs = await db.select().from(routingConfigTable)
    .where(eq(routingConfigTable.isActive, true));

  const funnelSpecificIds = new Map<number, Set<number>>();
  for (const c of configs) {
    if (c.funnelTypeId !== null) {
      if (!funnelSpecificIds.has(c.tenantId)) funnelSpecificIds.set(c.tenantId, new Set());
      funnelSpecificIds.get(c.tenantId)!.add(c.funnelTypeId);
    }
  }

  for (const config of configs) {
    const passMinutes = config.passIntervalMinutes ?? 1440;
    const cutoff = new Date(Date.now() - passMinutes * 60 * 1000);

    const leadConditions = [
      eq(leadsTable.tenantId, config.tenantId),
      inArray(leadsTable.hubStatus, ["day_1", "day_2", "day_3", "day_4"]),
      isNotNull(leadsTable.assignedCsrId),
      lte(leadsTable.updatedAt, cutoff),
    ];

    if (config.funnelTypeId !== null) {
      leadConditions.push(eq(leadsTable.funnelId, config.funnelTypeId));
    } else {
      const specificFunnels = funnelSpecificIds.get(config.tenantId);
      if (specificFunnels && specificFunnels.size > 0) {
        leadConditions.push(
          or(isNull(leadsTable.funnelId), ...Array.from(specificFunnels).map(fid =>
            ne(leadsTable.funnelId, fid)
          ))!
        );
      }
    }

    const staleLeads = await db.select({
      id: leadsTable.id,
      assignedCsrId: leadsTable.assignedCsrId,
      tenantId: leadsTable.tenantId,
      cascadePassCount: leadsTable.cascadePassCount,
    }).from(leadsTable)
      .where(and(...leadConditions))
      .limit(50);

    if (staleLeads.length === 0) continue;

    const cascadeOrder = (config.cascadeOrder as number[]) || [];
    if (cascadeOrder.length < 2) continue;

    const now = new Date();
    const pausedSchedules = await db.select().from(csrScheduleTable)
      .where(and(eq(csrScheduleTable.tenantId, config.tenantId), eq(csrScheduleTable.isPaused, true)));
    const pausedIds = new Set(
      pausedSchedules.filter(s => !s.pauseEnd || new Date(s.pauseEnd) > now).map(s => s.userId)
    );
    const activeOrder = cascadeOrder.filter(id => !pausedIds.has(id));
    if (activeOrder.length < 2) continue;

    for (const lead of staleLeads) {
      const currentIdx = activeOrder.indexOf(lead.assignedCsrId!);
      let nextCsrId: number;

      if (config.allowPassBack) {
        if (config.stickyAfterCascade && config.stickyCsrId && (lead.cascadePassCount ?? 0) >= activeOrder.length - 1) {
          if (config.stickyCsrId === lead.assignedCsrId) {
            await db.update(leadsTable)
              .set({ updatedAt: new Date() })
              .where(eq(leadsTable.id, lead.id));
            continue;
          }
          nextCsrId = config.stickyCsrId;
        } else {
          nextCsrId = activeOrder[(currentIdx + 1) % activeOrder.length];
        }
      } else {
        if (currentIdx < activeOrder.length - 1) {
          nextCsrId = activeOrder[currentIdx + 1];
        } else {
          continue;
        }
      }

      const [nextUser] = await db.select({ name: usersTable.name })
        .from(usersTable)
        .where(and(eq(usersTable.id, nextCsrId), eq(usersTable.tenantId, config.tenantId)));
      if (!nextUser) continue;

      const newPassCount = (config.allowPassBack && config.stickyAfterCascade)
        ? (lead.cascadePassCount ?? 0) + 1
        : (lead.cascadePassCount ?? 0);
      await db.update(leadsTable)
        .set({ assignedCsrId: nextCsrId, assignedTo: nextUser.name, updatedAt: new Date(), cascadePassCount: newPassCount })
        .where(eq(leadsTable.id, lead.id));

      const passLabel = passMinutes >= 60 ? `${Math.round(passMinutes / 60)}h` : `${passMinutes}m`;
      await db.insert(callAttemptsTable).values({
        leadId: lead.id,
        userId: nextCsrId,
        method: "transfer",
        outcome: "auto_passed",
        platform: "native",
        actionType: "call",
        notes: `Auto-passed after ${passLabel} inactivity`,
      });

      passed++;
    }
  }

  return passed;
}

export default router;
