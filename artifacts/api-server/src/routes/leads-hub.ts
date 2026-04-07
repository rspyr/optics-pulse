import { Router, type IRouter, type Request } from "express";
import {
  db, leadsTable, callAttemptsTable, usersTable, scheduledFollowupsTable,
  funnelTypesTable, routingConfigTable, csrScheduleTable, tenantFunnelTypesTable,
  tenantsTable, leadSourceAliasesTable,
} from "@workspace/db";
import { eq, and, sql, desc, asc, gte, gt, lte, inArray, isNull, ne, count, or, isNotNull } from "drizzle-orm";
import { emitLeadUpdated, emitNewLead } from "../socket";
import { assignLeadRoundRobin } from "../services/round-robin";
import { normalizeSource } from "../services/source-normalizer";
import { scheduleAutoPass, cancelAutoPass, leadHasRealTouch, claimLead, releaseClaim, consumeClaim, hasActiveClaim } from "../services/auto-pass-scheduler";
import { syncPodiumConversationAssignment } from "../services/integrations/podium-api";

async function findRoutingConfigForLead(tenantId: number, funnelId: number | null) {
  if (funnelId) {
    const [specific] = await db.select().from(routingConfigTable)
      .where(and(
        eq(routingConfigTable.tenantId, tenantId),
        eq(routingConfigTable.isActive, true),
        eq(routingConfigTable.funnelTypeId, funnelId),
      ));
    if (specific) return specific;
  }
  const [fallback] = await db.select().from(routingConfigTable)
    .where(and(
      eq(routingConfigTable.tenantId, tenantId),
      eq(routingConfigTable.isActive, true),
      isNull(routingConfigTable.funnelTypeId),
    ));
  return fallback || null;
}

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
  if (!tenantId) { res.json({ newLeads: [], callbacks: [], reengagement: [], oldLeads: [], total: 0 }); return; }

  const tab = (req.query.tab as string) || "all";
  const sessionRole = (req.session as any)?.userRole as string | undefined;
  const assignedCsrId = sessionRole === "client_user"
    ? ((req.session as any)?.userId as number) ?? null
    : req.query.csrId ? Number(req.query.csrId) : null;

  const [tenant] = await db.select({ timezone: tenantsTable.timezone }).from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  const tz = tenant?.timezone || "America/New_York";

  const now = new Date();

  const visibilityFilter = or(isNull(leadsTable.visibleAfter), lte(leadsTable.visibleAfter, now));
  const baseConds = [eq(leadsTable.tenantId, tenantId), visibilityFilter];
  if (assignedCsrId) baseConds.push(eq(leadsTable.assignedCsrId, assignedCsrId));

  const activeStatuses = ["day_1", "day_2", "day_3", "day_4", "appt_booked"];
  const terminalStatuses = ["appt_set", "dead"];

  try {
    const noRealAttempts = sql`NOT EXISTS (SELECT 1 FROM call_attempts WHERE call_attempts.lead_id = ${leadsTable.id} AND call_attempts.action_type NOT IN ('transfer', 'system'))`;
    const hasRealAttempts = sql`EXISTS (SELECT 1 FROM call_attempts WHERE call_attempts.lead_id = ${leadsTable.id} AND call_attempts.action_type NOT IN ('transfer', 'system'))`;
    const newLeads = (tab === "all" || tab === "new") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        or(
          and(
            eq(leadsTable.hubStatus, "day_1"),
            isNull(leadsTable.callbackAt),
            noRealAttempts,
          ),
          and(
            eq(leadsTable.hubStatus, "appt_booked"),
            noRealAttempts,
          ),
        ),
      ))
      .orderBy(desc(leadsTable.createdAt)).limit(100) : [];

    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    const callbacks = (tab === "all" || tab === "callbacks") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        eq(leadsTable.hubStatus, "call_back"),
        isNotNull(leadsTable.callbackAt),
      ))
      .orderBy(asc(leadsTable.callbackAt)).limit(100) : [];

    const reengagement = (tab === "all" || tab === "reengagement") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        inArray(leadsTable.hubStatus, activeStatuses),
        hasRealAttempts,
        isNull(leadsTable.callbackAt),
        gt(leadsTable.createdAt, fiveDaysAgo),
      ))
      .orderBy(desc(leadsTable.updatedAt)).limit(100) : [];

    const oldLeads = (tab === "all" || tab === "old") ? await db.select().from(leadsTable)
      .where(and(
        ...baseConds,
        eq(leadsTable.hubStatus, "day_5_old"),
      ))
      .orderBy(desc(leadsTable.updatedAt)).limit(100) : [];

    const [totalResult] = await db.select({ count: count() }).from(leadsTable)
      .where(and(...baseConds, sql`${leadsTable.hubStatus} NOT IN ('appt_set', 'dead')`));

    type RoutingConfig = typeof routingConfigTable.$inferSelect;
    type LeadRow = typeof leadsTable.$inferSelect;

    const configs: RoutingConfig[] = await db.select().from(routingConfigTable)
      .where(and(eq(routingConfigTable.tenantId, tenantId), eq(routingConfigTable.isActive, true)));
    const configByFunnel = new Map<number | null, RoutingConfig>();
    let defaultConfig: RoutingConfig | null = null;
    for (const c of configs) {
      if (c.funnelTypeId !== null) configByFunnel.set(c.funnelTypeId, c);
      else defaultConfig = c;
    }

    const enrichNow = new Date();
    const pausedSchedules = await db.select().from(csrScheduleTable)
      .where(and(eq(csrScheduleTable.tenantId, tenantId), eq(csrScheduleTable.isPaused, true)));
    const pausedIds = new Set(
      pausedSchedules.filter(s => !s.pauseEnd || new Date(s.pauseEnd) > enrichNow).map(s => s.userId)
    );

    const allCascadeIds = new Set<number>();
    for (const c of configs) {
      for (const id of ((c.cascadeOrder as number[]) || [])) allCascadeIds.add(id);
    }
    const activeUserIds = new Set<number>();
    if (allCascadeIds.size > 0) {
      const activeUsers = await db.select({ id: usersTable.id })
        .from(usersTable)
        .where(and(
          eq(usersTable.tenantId, tenantId),
          eq(usersTable.isActive, true),
          inArray(usersTable.id, [...allCascadeIds]),
        ));
      for (const u of activeUsers) activeUserIds.add(u.id);
    }

    const activeOrderByConfigId = new Map<number, number[]>();
    for (const c of configs) {
      const raw = (c.cascadeOrder as number[]) || [];
      const active = raw.filter(id => !pausedIds.has(id) && activeUserIds.has(id));
      activeOrderByConfigId.set(c.id, active);
    }

    const autoPassStatuses = new Set(["day_1", "day_2", "day_3", "day_4"]);
    function enrichWithNextPass(leads: LeadRow[]): (LeadRow & { nextPassAt: string | null; passIntervalMinutes: number | null })[] {
      return leads.map(l => {
        if (!autoPassStatuses.has(l.hubStatus ?? "") || !l.assignedCsrId || !l.assignedAt) {
          return { ...l, nextPassAt: null, passIntervalMinutes: null };
        }
        const cfg = (l.funnelId ? configByFunnel.get(l.funnelId) : null) || defaultConfig;
        if (!cfg) {
          return { ...l, nextPassAt: null, passIntervalMinutes: null };
        }
        const activeOrder = activeOrderByConfigId.get(cfg.id) ?? [];
        if (activeOrder.length < 2) {
          return { ...l, nextPassAt: null, passIntervalMinutes: null };
        }
        const currentIdx = activeOrder.indexOf(l.assignedCsrId);
        let hasNextCsr: boolean;
        if (cfg.allowPassBack) {
          if (cfg.stickyAfterCascade && cfg.stickyCsrId
              && (l.cascadePassCount ?? 0) >= activeOrder.length - 1
              && cfg.stickyCsrId === l.assignedCsrId) {
            hasNextCsr = false;
          } else {
            hasNextCsr = true;
          }
        } else {
          hasNextCsr = (currentIdx >= 0 && currentIdx < activeOrder.length - 1) || currentIdx === -1;
        }
        if (!hasNextCsr) {
          return { ...l, nextPassAt: null, passIntervalMinutes: null };
        }
        const passMinutes = cfg.passIntervalMinutes ?? 1440;
        const assignedMs = new Date(l.assignedAt).getTime();
        const visibleMs = l.visibleAfter ? new Date(l.visibleAfter).getTime() : 0;
        const baseTime = Math.max(assignedMs, visibleMs);
        const nextPassAt = new Date(baseTime + passMinutes * 60 * 1000).toISOString();
        return { ...l, nextPassAt, passIntervalMinutes: passMinutes };
      });
    }

    const enrichedReengagement = enrichWithNextPass(reengagement);
    type EnrichedLead = (typeof enrichedReengagement)[number];
    type ReengageLead = EnrichedLead & { lastAttemptAt: string | null; attemptCount: number };
    let reengagementWithMeta: ReengageLead[] = enrichedReengagement.map(l => ({ ...l, lastAttemptAt: null, attemptCount: 0 }));
    if (reengagement.length > 0) {
      const reengageIds = reengagement.map(l => l.id);
      const attemptStats = await db
        .select({
          leadId: callAttemptsTable.leadId,
          lastAttemptAt: sql<string>`MAX(${callAttemptsTable.attemptedAt})`,
          attemptCount: sql<number>`COUNT(*)::int`,
        })
        .from(callAttemptsTable)
        .where(and(
          inArray(callAttemptsTable.leadId, reengageIds),
          sql`${callAttemptsTable.actionType} NOT IN ('transfer', 'system')`,
        ))
        .groupBy(callAttemptsTable.leadId);
      const statsMap = new Map(attemptStats.map(s => [s.leadId, s]));
      reengagementWithMeta = enrichedReengagement.map(l => {
        const stats = statsMap.get(l.id);
        return { ...l, lastAttemptAt: stats?.lastAttemptAt || null, attemptCount: stats?.attemptCount || 0 };
      });
    }

    res.json({
      newLeads: enrichWithNextPass(newLeads),
      callbacks: enrichWithNextPass(callbacks),
      reengagement: reengagementWithMeta,
      oldLeads: enrichWithNextPass(oldLeads),
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
  const archiveSessionRole = (req.session as any)?.userRole as string | undefined;
  const csrId = archiveSessionRole === "client_user"
    ? ((req.session as any)?.userId as number) ?? null
    : req.query.csrId ? Number(req.query.csrId) : null;
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

router.post("/leads-hub/:id/claim", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const leadId = parseInt(String(req.params.id));
  if (!leadId || isNaN(leadId)) { res.status(400).json({ error: "Invalid lead ID" }); return; }

  const [lead] = await db.select({ id: leadsTable.id, tenantId: leadsTable.tenantId, assignedCsrId: leadsTable.assignedCsrId })
    .from(leadsTable).where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const role = (req.session as any)?.userRole as string | undefined;
  const isAdmin = role && ["super_admin", "agency_user", "client_admin"].includes(role);
  if (!isAdmin && lead.assignedCsrId !== userId) {
    res.status(403).json({ error: "This lead has been reassigned to another CSR. Please refresh your queue." });
    return;
  }

  const result = claimLead(leadId, userId);
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }

  console.log(`[claim] Lead ${leadId} claimed by CSR ${userId}`);
  res.json({ ok: true });
});

router.post("/leads-hub/:id/release-claim", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const leadId = parseInt(String(req.params.id));
  if (!leadId || isNaN(leadId)) { res.status(400).json({ error: "Invalid lead ID" }); return; }

  const [lead] = await db.select({ id: leadsTable.id, tenantId: leadsTable.tenantId })
    .from(leadsTable).where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  releaseClaim(leadId, userId);
  console.log(`[claim] Lead ${leadId} claim released by CSR ${userId}`);
  res.json({ ok: true });
});

router.post("/leads-hub/action", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const { leadId, actionType, callResult, vmResult, textResult, deadReason, notes, callbackAt } = req.body;
  if (!leadId || !actionType) { res.status(400).json({ error: "leadId and actionType are required" }); return; }

  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const role = (req.session as any)?.userRole as string | undefined;
  const isAdmin = role && ["super_admin", "agency_user", "client_admin"].includes(role);
  if (!isAdmin) {
    const claimInfo = hasActiveClaim(leadId);
    if (claimInfo.claimed && claimInfo.csrId !== userId) {
      res.status(403).json({ error: "Another CSR is currently working this lead. Please try again later." });
      return;
    }
    const isAssigned = lead.assignedCsrId === userId;
    const holdsClaim = claimInfo.claimed && claimInfo.csrId === userId;
    if (!isAssigned && !holdsClaim) {
      res.status(403).json({ error: "This lead has been reassigned to another CSR. Please refresh your queue." });
      return;
    }
  }

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
    updates.bookedByCsrId = userId;
  }

  if (apptBookedOutcome && lead.hubStatus === "appt_booked") {
    const outcome = apptBookedOutcome;
    if (outcome === "confirmed") {
      updates.hubStatus = "appt_set";
      updates.status = "booked";
      updates.disposition = "booked";
      updates.bookedByCsrId = userId;
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

  const UNRESPONSIVE_THRESHOLD = 5;
  const skipAutoOld = ["appt_set", "appt_booked", "dead", "day_5_old"];
  const currentStatus = (updates.hubStatus as string) || lead.hubStatus;
  if (!skipAutoOld.includes(currentStatus)) {
    const [{ count: unresponsiveCount }] = await db
      .select({ count: count() })
      .from(callAttemptsTable)
      .where(and(
        eq(callAttemptsTable.leadId, leadId),
        or(
          and(
            eq(callAttemptsTable.actionType, "call"),
            inArray(callAttemptsTable.callResult, [
              "no_answer", "left_voicemail", "vm_full", "vm_not_setup",
              "bad_number", "hung_up", "blocked", "out_of_service_area",
            ]),
          ),
          and(
            eq(callAttemptsTable.actionType, "text"),
            inArray(callAttemptsTable.textResult, ["not_able_to", "no_need", "reached_out"]),
          ),
          eq(callAttemptsTable.actionType, "voicemail_drop"),
        ),
      ));

    if (unresponsiveCount >= UNRESPONSIVE_THRESHOLD) {
      updates.hubStatus = "day_5_old";
      updates.dayInSequence = 5;
    }
  }

  const postStatus = (updates.hubStatus as string) || lead.hubStatus;
  const skipAgeRule = ["appt_set", "appt_booked", "dead", "day_5_old"];
  if (!skipAgeRule.includes(postStatus)) {
    const leadAgeMs = Date.now() - new Date(lead.createdAt).getTime();
    if (leadAgeMs >= 5 * 24 * 60 * 60 * 1000) {
      updates.hubStatus = "day_5_old";
      updates.dayInSequence = 5;
    }
  }

  if (updates.hubStatus) {
    updates.status = hubStatusToLegacy(updates.hubStatus as HubStatus);
  }

  const realTouchActions = ["call", "text", "voicemail_drop", "voicemail"];
  const isRealTouch = realTouchActions.includes(actionType);

  if (isRealTouch && lead.assignedCsrId !== userId) {
    const [actingUser] = await db.select({ name: usersTable.name })
      .from(usersTable).where(eq(usersTable.id, userId));
    if (actingUser) {
      updates.assignedCsrId = userId;
      updates.assignedTo = actingUser.name;
      updates.assignedAt = new Date();
    }
  }

  const [updated] = await db.update(leadsTable).set(updates).where(eq(leadsTable.id, leadId)).returning();

  consumeClaim(leadId, userId);

  const activeAutoPassStatuses = ["day_1", "day_2", "day_3", "day_4"];
  const finalStatus = (updates.hubStatus as string) || lead.hubStatus;

  if (isRealTouch) {
    cancelAutoPass(leadId);
  } else if (!activeAutoPassStatuses.includes(finalStatus)) {
    cancelAutoPass(leadId);
  } else {
    cancelAutoPass(leadId);
    const alreadyTouched = await leadHasRealTouch(leadId);
    if (!alreadyTouched) {
      const config = await findRoutingConfigForLead(tenantId, lead.funnelId);
      if (config) {
        scheduleAutoPass(leadId, (config.passIntervalMinutes ?? 1440) * 60 * 1000);
      }
    }
  }

  emitLeadUpdated(lead.tenantId, updated as unknown as Record<string, unknown>);
  res.json({ lead: updated, action: { actionType, outcome } });
});

router.put("/leads-hub/action/:attemptId", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const role = req.session?.userRole as string | undefined;
  const allowedRoles = ["super_admin", "agency_user", "client_admin", "client_user"];
  if (!role || !allowedRoles.includes(role)) {
    res.status(403).json({ error: "Insufficient permissions" }); return;
  }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const attemptId = parseInt(String(req.params.attemptId));
  if (!attemptId || isNaN(attemptId)) { res.status(400).json({ error: "Invalid attempt ID" }); return; }

  const [attempt] = await db.select().from(callAttemptsTable).where(eq(callAttemptsTable.id, attemptId));
  if (!attempt) { res.status(404).json({ error: "Action not found" }); return; }

  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, attempt.leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(403).json({ error: "Access denied" }); return; }

  const isAdminRole = ["super_admin", "agency_user", "client_admin"].includes(role);
  if (!isAdminRole && attempt.userId !== userId) {
    res.status(403).json({ error: "You can only edit your own actions" }); return;
  }

  const { actionType, callResult, vmResult, textResult, deadReason, notes, spokeResult, callbackAt, appointmentSet } = req.body;

  const validCallResults = ["no_answer", "left_voicemail", "vm_full", "vm_not_setup", "bad_number", "spoke_with_customer", "hung_up", "blocked", "out_of_service_area"];
  const validTextResults = ["yes", "not_able_to", "dead", "no_need", "reached_out"];
  const validVmResults = ["yes", "no", "bad_number", "vm_full", "vm_not_setup", "spoke_with_customer"];
  const validActionTypes = ["call", "text", "voicemail_drop", "voicemail"];

  if (actionType !== undefined && !validActionTypes.includes(actionType)) {
    res.status(400).json({ error: "Invalid action type" }); return;
  }
  if (callResult !== undefined && callResult && !validCallResults.includes(callResult)) {
    res.status(400).json({ error: "Invalid call result" }); return;
  }
  if (textResult !== undefined && textResult && !validTextResults.includes(textResult)) {
    res.status(400).json({ error: "Invalid text result" }); return;
  }
  if (vmResult !== undefined && vmResult && !validVmResults.includes(vmResult)) {
    res.status(400).json({ error: "Invalid VM result" }); return;
  }

  const outcome = callResult || textResult || vmResult || actionType || attempt.outcome;

  const updateFields: Record<string, unknown> = {};
  if (actionType !== undefined) { updateFields.method = actionType; updateFields.actionType = actionType; }
  if (callResult !== undefined) updateFields.callResult = callResult || null;
  if (vmResult !== undefined) updateFields.vmResult = vmResult || null;
  if (textResult !== undefined) updateFields.textResult = textResult || null;
  if (deadReason !== undefined) updateFields.deadReason = deadReason || null;
  if (notes !== undefined) updateFields.notes = notes || null;
  if (outcome) updateFields.outcome = outcome;

  const [updated] = await db.update(callAttemptsTable).set(updateFields).where(eq(callAttemptsTable.id, attemptId)).returning();

  const leadUpdates: Record<string, unknown> = { updatedAt: new Date() };
  if (callResult === "spoke_with_customer" && spokeResult === "call_back" && callbackAt) {
    leadUpdates.hubStatus = "call_back";
    leadUpdates.callbackAt = new Date(callbackAt);
    leadUpdates.status = "contacted";
  } else if (callResult === "spoke_with_customer" && spokeResult === "appointment_set" && appointmentSet) {
    leadUpdates.hubStatus = "appt_set";
    leadUpdates.status = "booked";
    leadUpdates.disposition = "booked";
    leadUpdates.bookedByCsrId = userId;
    leadUpdates.callbackAt = null;
  } else if (deadReason) {
    leadUpdates.hubStatus = "dead";
    leadUpdates.status = "lost";
    leadUpdates.deadReason = deadReason;
    leadUpdates.callbackAt = null;
  } else if (callbackAt === null && spokeResult !== "call_back") {
    leadUpdates.callbackAt = null;
  }

  if (Object.keys(leadUpdates).length > 1) {
    await db.update(leadsTable).set(leadUpdates).where(eq(leadsTable.id, attempt.leadId));
  }

  res.json({ attempt: updated });
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
    actionType: "transfer",
    notes: `Transferred to ${targetUser.name}`,
  });

  const [updated] = await db.update(leadsTable)
    .set({
      assignedCsrId: targetCsrId,
      assignedTo: targetUser.name,
      assignedAt: new Date(),
      updatedAt: new Date(),
      cascadePassCount: 0,
      visibleAfter: null,
      manuallyTransferred: true,
    })
    .where(eq(leadsTable.id, leadId))
    .returning();

  cancelAutoPass(leadId);

  syncPodiumConversationAssignment(leadId, targetCsrId).catch(() => {});

  emitLeadUpdated(lead.tenantId, updated as unknown as Record<string, unknown>);
  res.json({ lead: updated });
});

router.get("/leads-hub/batch-transfer/preview", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const role = req.session?.userRole;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role as string)) {
    res.status(403).json({ error: "Insufficient permissions" }); return;
  }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const sourceCsrId = parseInt(String(req.query.sourceCsrId));
  if (!sourceCsrId) { res.status(400).json({ error: "sourceCsrId is required" }); return; }

  const [result] = await db.select({ count: count() })
    .from(leadsTable)
    .where(and(
      eq(leadsTable.tenantId, tenantId),
      eq(leadsTable.assignedCsrId, sourceCsrId),
      ne(leadsTable.hubStatus, "dead"),
    ));

  res.json({ count: result?.count || 0 });
});

router.post("/leads-hub/batch-transfer", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const role = req.session?.userRole;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role as string)) {
    res.status(403).json({ error: "Insufficient permissions" }); return;
  }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const { sourceCsrId, targetCsrId } = req.body;
  if (!sourceCsrId || !targetCsrId) { res.status(400).json({ error: "sourceCsrId and targetCsrId are required" }); return; }
  if (sourceCsrId === targetCsrId) { res.status(400).json({ error: "Source and target CSR cannot be the same" }); return; }

  const [targetUser] = await db.select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable).where(and(eq(usersTable.id, targetCsrId), eq(usersTable.tenantId, tenantId)));
  if (!targetUser) { res.status(404).json({ error: "Target CSR not found" }); return; }

  const [sourceUser] = await db.select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable).where(and(eq(usersTable.id, sourceCsrId), eq(usersTable.tenantId, tenantId)));
  if (!sourceUser) { res.status(404).json({ error: "Source CSR not found" }); return; }

  const leadsToTransfer = await db.select().from(leadsTable)
    .where(and(
      eq(leadsTable.tenantId, tenantId),
      eq(leadsTable.assignedCsrId, sourceCsrId),
      ne(leadsTable.hubStatus, "dead"),
    ));

  if (leadsToTransfer.length === 0) {
    res.json({ transferred: 0, message: "No active leads to transfer" });
    return;
  }

  const leadIds = leadsToTransfer.map(l => l.id);

  const auditEntries = leadIds.map(leadId => ({
    leadId,
    userId,
    method: "transfer" as const,
    outcome: "transferred" as const,
    platform: "native" as const,
    actionType: "transfer" as const,
    notes: `Batch transferred from ${sourceUser.name} to ${targetUser.name}`,
  }));

  await db.transaction(async (tx) => {
    await tx.insert(callAttemptsTable).values(auditEntries);

    await tx.update(leadsTable)
      .set({
        assignedCsrId: targetCsrId,
        assignedTo: targetUser.name,
        assignedAt: new Date(),
        updatedAt: new Date(),
        cascadePassCount: 0,
        visibleAfter: null,
        manuallyTransferred: true,
      })
      .where(and(
        eq(leadsTable.tenantId, tenantId),
        inArray(leadsTable.id, leadIds),
      ));
  });

  const updatedLeads = await db.select().from(leadsTable)
    .where(inArray(leadsTable.id, leadIds));

  for (const lead of updatedLeads) {
    cancelAutoPass(lead.id);
    syncPodiumConversationAssignment(lead.id, targetCsrId).catch(() => {});
    emitLeadUpdated(tenantId, lead as unknown as Record<string, unknown>);
  }

  res.json({ transferred: updatedLeads.length, message: `${updatedLeads.length} leads transferred from ${sourceUser.name} to ${targetUser.name}` });
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
        if (result.passIntervalMinutes != null) {
          scheduleAutoPass(lead.id, result.passIntervalMinutes * 60 * 1000);
        }

        await db.insert(callAttemptsTable).values({
          leadId: lead.id,
          userId: result.assignedCsrId,
          method: "system",
          outcome: "initial_assignment",
          platform: "native",
          actionType: "system",
          notes: `System: Lead initially assigned to ${result.csrName}`,
        });

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
  } else {
    const manualConfig = await findRoutingConfigForLead(tenantId, funnelId || null);
    if (manualConfig) {
      scheduleAutoPass(lead.id, (manualConfig.passIntervalMinutes ?? 1440) * 60 * 1000);
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
    const autoPassStatuses = ["day_1", "day_2", "day_3", "day_4"];
    const alreadyTouched = await leadHasRealTouch(leadId);
    if (!alreadyTouched && result.passIntervalMinutes != null && updated && autoPassStatuses.includes(updated.hubStatus)) {
      scheduleAutoPass(leadId, result.passIntervalMinutes * 60 * 1000);
    }
    res.json({ assignedCsrId: result.assignedCsrId, csrName: result.csrName, lead: updated });
  } else {
    res.json(result);
  }
});

router.patch("/leads-hub/:leadId/source", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const leadId = parseInt(String(req.params.leadId));
  const rawSource = typeof req.body?.source === "string" ? req.body.source.trim() : "";
  if (!rawSource) {
    res.status(400).json({ error: "source is required" });
    return;
  }
  const source = rawSource;

  const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const normalizedSource = await normalizeSource(tenantId, source);

  const [updated] = await db.update(leadsTable)
    .set({ source: normalizedSource, updatedAt: new Date() })
    .where(eq(leadsTable.id, leadId))
    .returning();

  emitLeadUpdated(tenantId, updated as unknown as Record<string, unknown>);
  res.json(updated);
});

router.get("/leads-hub/canonical-sources", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.json({ sources: [] }); return; }

  const rows = await db.select({ canonicalName: leadSourceAliasesTable.canonicalName })
    .from(leadSourceAliasesTable)
    .where(eq(leadSourceAliasesTable.tenantId, tenantId));

  const uniqueNames = [...new Set(rows.map(r => r.canonicalName))].sort();
  res.json({ sources: uniqueNames });
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
    bookedByCsrId: leadsTable.bookedByCsrId,
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

      if (l.funnelId) {
        const key = `${l.assignedCsrId}_${l.funnelId}`;
        if (!byCsrByFunnel[key]) byCsrByFunnel[key] = { csrId: l.assignedCsrId, funnelId: l.funnelId, total: 0, appointments: 0 };
        byCsrByFunnel[key].total++;
      }
    }

    if (isAppt(l.hubStatus)) {
      const bookerId = l.bookedByCsrId ?? l.assignedCsrId;
      if (bookerId) {
        if (!byCsr[bookerId]) byCsr[bookerId] = { total: 0, appointments: 0 };
        byCsr[bookerId].appointments++;

        if (l.funnelId) {
          const key = `${bookerId}_${l.funnelId}`;
          if (!byCsrByFunnel[key]) byCsrByFunnel[key] = { csrId: bookerId, funnelId: l.funnelId, total: 0, appointments: 0 };
          byCsrByFunnel[key].appointments++;
        }
      }
    }
  }

  const filteredLeadIds = filteredLeads.map(l => l.id);
  const allLeadCallConds = [
    gte(callAttemptsTable.attemptedAt, startDate),
    lte(callAttemptsTable.attemptedAt, endDate),
    sql`${callAttemptsTable.actionType} NOT IN ('transfer', 'system')`,
    sql`${callAttemptsTable.leadId} IN (SELECT id FROM leads WHERE tenant_id = ${tenantId})`,
  ];

  const callStats = await db.select({
    userId: callAttemptsTable.userId,
    actionType: callAttemptsTable.actionType,
    count: count(),
  }).from(callAttemptsTable)
    .where(and(...allLeadCallConds))
    .groupBy(callAttemptsTable.userId, callAttemptsTable.actionType);

  const csrCallStats: Record<number, { calls: number; texts: number; vms: number }> = {};
  for (const s of callStats) {
    if (!csrCallStats[s.userId]) csrCallStats[s.userId] = { calls: 0, texts: 0, vms: 0 };
    if (s.actionType === "call") csrCallStats[s.userId].calls = s.count;
    if (s.actionType === "text") csrCallStats[s.userId].texts = s.count;
    if (s.actionType === "voicemail_drop") csrCallStats[s.userId].vms = s.count;
  }

  const callsByFunnelRaw = await db.select({
    leadId: callAttemptsTable.leadId,
    actionType: callAttemptsTable.actionType,
    count: count(),
  }).from(callAttemptsTable)
    .where(and(...allLeadCallConds))
    .groupBy(callAttemptsTable.leadId, callAttemptsTable.actionType);

  const allTouchedLeadIds = [...new Set(callsByFunnelRaw.map(r => r.leadId))];
  let allLeadFunnelMap: Record<number, number> = { ...leadFunnelMap };
  const missingLeadIds = allTouchedLeadIds.filter(id => !(id in allLeadFunnelMap));
  if (missingLeadIds.length > 0) {
    const extraLeads = await db.select({ id: leadsTable.id, funnelId: leadsTable.funnelId })
      .from(leadsTable)
      .where(inArray(leadsTable.id, missingLeadIds));
    for (const l of extraLeads) {
      if (l.funnelId) allLeadFunnelMap[l.id] = l.funnelId;
    }
  }

  const callsByFunnel: Record<number, { calls: number; texts: number; vms: number }> = {};
  for (const r of callsByFunnelRaw) {
    const fId = allLeadFunnelMap[r.leadId];
    if (!fId) continue;
    if (!callsByFunnel[fId]) callsByFunnel[fId] = { calls: 0, texts: 0, vms: 0 };
    if (r.actionType === "call") callsByFunnel[fId].calls += r.count;
    if (r.actionType === "text") callsByFunnel[fId].texts += r.count;
    if (r.actionType === "voicemail_drop") callsByFunnel[fId].vms += r.count;
  }

  let totalCalls = 0, totalTexts = 0, totalVms = 0;
  for (const s of callStats) {
    if (s.actionType === "call") totalCalls += s.count;
    if (s.actionType === "text") totalTexts += s.count;
    if (s.actionType === "voicemail_drop") totalVms += s.count;
  }

  res.json({
    totalLeads,
    appointments,
    bookingRate,
    totalTouchpoints: totalCalls + totalTexts + totalVms,
    totalCalls,
    totalTexts,
    totalVms,
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


router.get("/leads-hub/stats/timeseries", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.json({ series: [] }); return; }

  const startDate = req.query.startDate ? new Date(req.query.startDate as string) : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    res.status(400).json({ error: "Invalid date parameters" }); return;
  }
  if (endDate < startDate) {
    res.status(400).json({ error: "endDate must be after startDate" }); return;
  }

  const funnelId = req.query.funnelId ? Number(req.query.funnelId) : null;
  const source = req.query.source ? String(req.query.source) : null;
  const includePreBooked = req.query.includePreBooked === "true";

  const baseConds = [
    eq(leadsTable.tenantId, tenantId),
    gte(leadsTable.createdAt, startDate),
    lte(leadsTable.createdAt, endDate),
  ];
  if (funnelId) baseConds.push(eq(leadsTable.funnelId, funnelId));
  if (source) baseConds.push(eq(leadsTable.source, source));

  const leads = await db.select({
    id: leadsTable.id,
    hubStatus: leadsTable.hubStatus,
    createdAt: leadsTable.createdAt,
    preBooked: leadsTable.preBooked,
  }).from(leadsTable).where(and(...baseConds));

  const filteredLeads = includePreBooked ? leads : leads.filter(l => !l.preBooked);

  const filteredLeadIds = filteredLeads.map(l => l.id);

  let touchByDay: Record<string, number> = {};
  if (filteredLeadIds.length > 0) {
    const touchConds = [
      gte(callAttemptsTable.attemptedAt, startDate),
      lte(callAttemptsTable.attemptedAt, endDate),
      sql`${callAttemptsTable.actionType} NOT IN ('transfer', 'system')`,
      inArray(callAttemptsTable.leadId, filteredLeadIds),
    ];
    const touchRows = await db.select({
      day: sql<string>`to_char(${callAttemptsTable.attemptedAt}, 'YYYY-MM-DD')`,
      count: count(),
    }).from(callAttemptsTable)
      .where(and(...touchConds))
      .groupBy(sql`to_char(${callAttemptsTable.attemptedAt}, 'YYYY-MM-DD')`);

    for (const r of touchRows) {
      touchByDay[r.day] = r.count;
    }
  }

  const isAppt = (status: string) => status === "appt_set" || status === "appt_booked";

  const dayMap: Record<string, { leads: number; appointments: number }> = {};
  for (const l of filteredLeads) {
    const day = new Date(l.createdAt).toISOString().slice(0, 10);
    if (!dayMap[day]) dayMap[day] = { leads: 0, appointments: 0 };
    dayMap[day].leads++;
    if (isAppt(l.hubStatus)) dayMap[day].appointments++;
  }

  const allDays = new Set([...Object.keys(dayMap), ...Object.keys(touchByDay)]);
  const current = new Date(startDate);
  while (current <= endDate) {
    allDays.add(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }

  const series = [...allDays].sort().map(day => {
    const d = dayMap[day] || { leads: 0, appointments: 0 };
    return {
      date: day,
      leads: d.leads,
      appointments: d.appointments,
      bookingRate: d.leads > 0 ? Math.round((d.appointments / d.leads) * 100) : 0,
      touchpoints: touchByDay[day] || 0,
    };
  });

  res.json({ series });
});

export default router;
