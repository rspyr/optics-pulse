import { Router, type IRouter } from "express";
import { db, leadsTable, callAttemptsTable, podiumMessagesTable, funnelTypesTable } from "@workspace/db";
import { eq, and, count, desc, sql, SQL, inArray, gte, lte } from "drizzle-orm";
import { ListLeadsQueryParams, GetLeadParams, UpdateLeadBody } from "@workspace/api-zod";
import { getHudStats, emitNewLead, emitLeadUpdated } from "../socket";
import { initiateCall, initiateText, getTenantCommConfig, getCommConfigStatus } from "../services/integrations/communication";
import { getSmartQueue } from "../services/lead-scoring";
import { getComparisonStats, getHistoricalStats, aggregateDailyStats } from "../services/coordinator-stats";
import type { ComparisonBaseline } from "../services/coordinator-stats";
import { parseFilterQuery } from "../services/parse-filter";

const router: IRouter = Router();

router.post("/leads/parse-filter", async (req, res) => {
  const { query } = req.body as { query?: string };

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    res.status(400).json({ error: "Query is required" });
    return;
  }

  if (query.length > 500) {
    res.status(400).json({ error: "Query too long" });
    return;
  }

  const role = req.session.userRole;
  const bodyTenantId = (req.body as { tenantId?: number }).tenantId;
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : undefined;
  const requestedTenantId = bodyTenantId || queryTenantId;
  const tenantId = (role === "super_admin" || role === "agency_user")
    ? (requestedTenantId || req.session.tenantId || 1)
    : req.session.tenantId || 1;

  try {
    const [sourcesResult, leadTypesResult, statusesResult, salespeopleResult, dispositionsResult] = await Promise.all([
      db.selectDistinct({ value: leadsTable.source }).from(leadsTable).where(eq(leadsTable.tenantId, tenantId)),
      db.selectDistinct({ value: leadsTable.leadType }).from(leadsTable).where(eq(leadsTable.tenantId, tenantId)),
      db.selectDistinct({ value: leadsTable.status }).from(leadsTable).where(eq(leadsTable.tenantId, tenantId)),
      db.selectDistinct({ value: leadsTable.assignedTo }).from(leadsTable).where(eq(leadsTable.tenantId, tenantId)),
      db.selectDistinct({ value: leadsTable.disposition }).from(leadsTable).where(eq(leadsTable.tenantId, tenantId)),
    ]);

    const filters = await parseFilterQuery(query.trim(), {
      sources: sourcesResult.map(r => r.value).filter(Boolean).sort() as string[],
      leadTypes: leadTypesResult.map(r => r.value).filter(Boolean).sort() as string[],
      statuses: statusesResult.map(r => r.value).filter(Boolean).sort() as string[],
      salespeople: salespeopleResult.map(r => r.value).filter(Boolean).sort() as string[],
      dispositions: dispositionsResult.map(r => r.value).filter(Boolean).sort() as string[],
    });

    const isEmpty = Object.keys(filters).length === 0;
    res.json({ filters, empty: isEmpty });
  } catch (err) {
    console.error("[ParseFilter] Error:", err);
    res.status(500).json({ error: "Failed to parse filter query" });
  }
});

router.get("/leads", async (req, res) => {
  const query = ListLeadsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  const role = req.session.userRole;
  const resolvedTenantId = (role === "super_admin" || role === "agency_user")
    ? (query.tenantId ?? null)
    : (req.session.tenantId ?? null);
  if (resolvedTenantId) conditions.push(eq(leadsTable.tenantId, resolvedTenantId));

  if (query.status) {
    const status = query.status as "new" | "contacted" | "booked" | "sold" | "lost" | "cancelled";
    conditions.push(eq(leadsTable.status, status));
  }
  if (query.source) conditions.push(eq(leadsTable.source, query.source));
  if (query.funnelId) conditions.push(eq(leadsTable.funnelId, query.funnelId));
  if (query.startDate) {
    const sd = new Date(query.startDate);
    if (!isNaN(sd.getTime())) conditions.push(gte(leadsTable.createdAt, sd));
  }
  if (query.endDate) {
    const ed = new Date(query.endDate);
    if (!isNaN(ed.getTime())) conditions.push(lte(leadsTable.createdAt, ed));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const [leads, [totalResult]] = await Promise.all([
    db.select().from(leadsTable).where(where).orderBy(desc(leadsTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: count() }).from(leadsTable).where(where),
  ]);

  res.json({ leads, total: totalResult.count });
});

router.get("/leads/hud/queue", async (req, res) => {
  const role = req.session.userRole;
  const tenantId = (role === "super_admin" || role === "agency_user")
    ? (req.query.tenantId ? Number(req.query.tenantId) : null)
    : req.session.tenantId ?? null;

  try {
    const result = await getSmartQueue(tenantId);

    const newLeads = result.leads
      .filter(l => l.bucket === "new")
      .map(l => ({ ...l.lead, _suggestion: l.suggestion }));
    const followUps = result.leads
      .filter(l => l.bucket === "followup")
      .map(l => ({ ...l.lead, _suggestion: l.suggestion }));
    const background = result.leads
      .filter(l => l.bucket === "background")
      .map(l => ({ ...l.lead, _suggestion: l.suggestion }));

    res.json({
      newLeads,
      followUps,
      background,
      total: result.total,
    });
  } catch (err) {
    console.error("[Pulse Queue] Smart queue error, falling back:", err);
    const conditions: SQL[] = [];
    if (tenantId) conditions.push(eq(leadsTable.tenantId, tenantId));
    conditions.push(inArray(leadsTable.status, ["new", "contacted"]));
    const where = and(...conditions);
    const leads = await db.select().from(leadsTable).where(where).orderBy(desc(leadsTable.createdAt)).limit(100);
    const now = Date.now();
    res.json({
      newLeads: leads.filter(l => l.status === "new"),
      followUps: leads.filter(l => l.status === "contacted" && (now - new Date(l.updatedAt).getTime()) < 86400000),
      background: leads.filter(l => l.status === "contacted" && (now - new Date(l.updatedAt).getTime()) >= 86400000),
      total: leads.length,
    });
  }
});

router.get("/leads/hud/stats", async (req, res) => {
  const role = req.session.userRole;
  const isManager = role === "super_admin" || role === "agency_user" || role === "client_admin";
  const tenantId = (role === "super_admin" || role === "agency_user")
    ? (req.query.tenantId ? Number(req.query.tenantId) : null)
    : req.session.tenantId ?? null;

  let csrId: number | null = null;
  if (role === "client_user") {
    csrId = (req.session as any)?.userId ?? null;
  } else if (req.query.csrId) {
    const parsed = Number(req.query.csrId);
    if (isManager && !isNaN(parsed)) {
      csrId = parsed;
    }
  }
  let startDate: Date | null = null;
  let endDate: Date | null = null;
  if (req.query.startDate) {
    const parsed = new Date(req.query.startDate as string);
    if (!isNaN(parsed.getTime())) startDate = parsed;
  }
  if (req.query.endDate) {
    const parsed = new Date(req.query.endDate as string);
    if (!isNaN(parsed.getTime())) endDate = parsed;
  }
  const stats = await getHudStats(tenantId, csrId, startDate, endDate);
  res.json(stats);
});

router.get("/leads/hud/comparison", async (req, res) => {
  const role = req.session.userRole;
  const isManager = role === "super_admin" || role === "agency_user";
  const tenantId = isManager
    ? (req.query.tenantId ? Number(req.query.tenantId) : null)
    : req.session.tenantId ?? null;

  let userId: number | null = null;
  if (!isManager) {
    userId = req.session.userId ?? null;
  } else if (req.query.userId) {
    userId = Number(req.query.userId);
  }

  const baseline = (req.query.baseline as string) || "yesterday";
  const validBaselines = ["yesterday", "last_week", "monthly_avg", "all_time_best"];
  if (!validBaselines.includes(baseline)) {
    res.status(400).json({ error: `Invalid baseline. Must be one of: ${validBaselines.join(", ")}` });
    return;
  }

  try {
    const result = await getComparisonStats(
      tenantId,
      userId,
      baseline as ComparisonBaseline,
    );
    res.json(result);
  } catch (err) {
    console.error("[Pulse Comparison]", err);
    res.status(500).json({ error: "Failed to fetch comparison stats" });
  }
});

router.get("/leads/hud/historical", async (req, res) => {
  const role = req.session.userRole;
  const isManager = role === "super_admin" || role === "agency_user";
  const tenantId = isManager
    ? (req.query.tenantId ? Number(req.query.tenantId) : null)
    : req.session.tenantId ?? null;

  let userId: number | null = null;
  if (!isManager) {
    userId = req.session.userId ?? null;
  } else if (req.query.userId) {
    userId = Number(req.query.userId);
  }

  const range = (req.query.range as string) || "30";
  const days = parseInt(range);
  const endDate = new Date().toISOString().split("T")[0];
  const startDateObj = new Date();
  startDateObj.setDate(startDateObj.getDate() - (isNaN(days) ? 30 : days));
  const startDate = (req.query.startDate as string) || startDateObj.toISOString().split("T")[0];
  const endDateParam = (req.query.endDate as string) || endDate;

  try {
    const result = await getHistoricalStats(tenantId, userId, startDate, endDateParam);
    res.json(result);
  } catch (err) {
    console.error("[Pulse Historical]", err);
    res.status(500).json({ error: "Failed to fetch historical stats" });
  }
});

router.post("/leads/hud/aggregate", async (req, res) => {
  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  const dateStr = (req.body.date as string) || new Date().toISOString().split("T")[0];
  try {
    const count = await aggregateDailyStats(dateStr);
    res.json({ success: true, coordinatorsProcessed: count, date: dateStr });
  } catch (err) {
    console.error("[Aggregate]", err);
    res.status(500).json({ error: "Aggregation failed" });
  }
});

router.get("/leads/comm-config", async (req, res) => {
  const role = req.session.userRole;
  const tenantId = (role === "super_admin" || role === "agency_user")
    ? (req.query.tenantId ? Number(req.query.tenantId) : null)
    : req.session.tenantId ?? null;

  if (!tenantId) {
    res.json({
      callPlatform: "native",
      textPlatform: "native",
      callReady: true,
      textReady: true,
      callStatusMessage: "Using native phone dialer",
      textStatusMessage: "Using native SMS app",
    });
    return;
  }

  try {
    const config = await getTenantCommConfig(tenantId);
    const status = getCommConfigStatus(config);
    res.json(status);
  } catch (err) {
    res.json({
      callPlatform: "native",
      textPlatform: "native",
      callReady: true,
      textReady: true,
      callStatusMessage: "Using native phone dialer",
      textStatusMessage: "Using native SMS app",
    });
  }
});

router.get("/leads/search", async (req, res) => {
  const role = req.session.userRole;
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : undefined;
  const resolvedTenantId = (role === "super_admin" || role === "agency_user")
    ? (queryTenantId ?? req.session.tenantId ?? null)
    : (req.session.tenantId ?? null);

  if (!resolvedTenantId) {
    res.json({ leads: [], total: 0 });
    return;
  }

  const q = ((req.query.q as string) || "").trim();
  const funnelId = req.query.funnelId ? Number(req.query.funnelId) : null;
  const dateType = (req.query.dateType as string) === "lastTouchpoint" ? "lastTouchpoint" : "created";
  const startDate = req.query.startDate ? new Date(req.query.startDate as string) : null;
  const endDate = req.query.endDate ? new Date(req.query.endDate as string) : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const validStartDate = startDate && !isNaN(startDate.getTime()) ? startDate : null;
  const validEndDate = endDate && !isNaN(endDate.getTime()) ? endDate : null;

  console.log(`[LeadSearch] tenant=${resolvedTenantId} q="${q}" funnelId=${funnelId} dateType=${dateType} startDate=${validStartDate?.toISOString() ?? "null"} endDate=${validEndDate?.toISOString() ?? "null"}`);

  if (!q && !funnelId && !validStartDate && !validEndDate) {
    console.log("[LeadSearch] No search criteria provided, returning empty");
    res.json({ leads: [], total: 0 });
    return;
  }

  try {
    const conditions: SQL[] = [eq(leadsTable.tenantId, resolvedTenantId)];

    if (funnelId) {
      conditions.push(eq(leadsTable.funnelId, funnelId));
    }

    const digitsOnly = q.replace(/\D/g, "");
    const isPhoneSearch = digitsOnly.length >= 1 && digitsOnly.length <= 15;

    let relevanceExpr: SQL;
    if (q) {
      const fuzzyConditions: SQL[] = [];

      fuzzyConditions.push(
        sql`(${leadsTable.firstName} % ${q} OR ${leadsTable.lastName} % ${q} OR (COALESCE(${leadsTable.firstName}, '') || ' ' || COALESCE(${leadsTable.lastName}, '')) % ${q})`
      );

      fuzzyConditions.push(
        sql`(${leadsTable.email} IS NOT NULL AND ${leadsTable.email} % ${q})`
      );

      if (isPhoneSearch) {
        fuzzyConditions.push(
          sql`(${leadsTable.phone} IS NOT NULL AND regexp_replace(${leadsTable.phone}, '[^0-9]', '', 'g') LIKE '%' || ${digitsOnly} || '%')`
        );
      }

      fuzzyConditions.push(
        sql`(LOWER(COALESCE(${leadsTable.firstName}, '')) LIKE LOWER(${`%${q}%`}) OR LOWER(COALESCE(${leadsTable.lastName}, '')) LIKE LOWER(${`%${q}%`}))`
      );

      fuzzyConditions.push(
        sql`(${leadsTable.email} IS NOT NULL AND LOWER(${leadsTable.email}) LIKE LOWER(${`%${q}%`}))`
      );

      conditions.push(sql`(${sql.join(fuzzyConditions, sql` OR `)})`);

      relevanceExpr = sql`(
        GREATEST(
          COALESCE(similarity(${leadsTable.firstName}, ${q}), 0),
          COALESCE(similarity(${leadsTable.lastName}, ${q}), 0),
          COALESCE(similarity(COALESCE(${leadsTable.firstName}, '') || ' ' || COALESCE(${leadsTable.lastName}, ''), ${q}), 0),
          COALESCE(similarity(${leadsTable.email}, ${q}), 0),
          CASE WHEN ${leadsTable.phone} IS NOT NULL AND regexp_replace(${leadsTable.phone}, '[^0-9]', '', 'g') LIKE '%' || ${digitsOnly} || '%' THEN 0.8 ELSE 0 END,
          CASE WHEN LOWER(COALESCE(${leadsTable.firstName}, '')) LIKE LOWER(${`%${q}%`}) OR LOWER(COALESCE(${leadsTable.lastName}, '')) LIKE LOWER(${`%${q}%`}) THEN 0.5 ELSE 0 END,
          CASE WHEN ${leadsTable.email} IS NOT NULL AND LOWER(${leadsTable.email}) LIKE LOWER(${`%${q}%`}) THEN 0.5 ELSE 0 END
        )
      )`;
    } else {
      relevanceExpr = sql`1`;
    }

    if (dateType === "created") {
      if (validStartDate) {
        conditions.push(gte(leadsTable.createdAt, validStartDate));
      }
      if (validEndDate) {
        conditions.push(lte(leadsTable.createdAt, validEndDate));
      }
    }

    const where = and(...conditions);

    if (dateType === "lastTouchpoint" && (validStartDate || validEndDate)) {
      const lastTouchpointExpr = sql`GREATEST(
        COALESCE((SELECT MAX(ca.attempted_at) FROM call_attempts ca WHERE ca.lead_id = ${leadsTable.id}), '1970-01-01'::timestamp),
        COALESCE((SELECT MAX(COALESCE(pm.podium_created_at, pm.created_at)) FROM podium_messages pm WHERE pm.lead_id = ${leadsTable.id}), '1970-01-01'::timestamp)
      )`;

      const touchpointConds: SQL[] = [...conditions];
      if (validStartDate) {
        touchpointConds.push(sql`${lastTouchpointExpr} >= ${validStartDate}`);
      }
      if (validEndDate) {
        touchpointConds.push(sql`${lastTouchpointExpr} <= ${validEndDate}`);
      }
      const tpWhere = and(...touchpointConds);

      const orderExpr = q ? desc(sql`relevance`) : desc(sql`last_touchpoint`);

      const [leads, [totalResult]] = await Promise.all([
        db
          .select({
            id: leadsTable.id,
            tenantId: leadsTable.tenantId,
            firstName: leadsTable.firstName,
            lastName: leadsTable.lastName,
            phone: leadsTable.phone,
            email: leadsTable.email,
            source: leadsTable.source,
            leadType: leadsTable.leadType,
            interestType: leadsTable.interestType,
            status: leadsTable.status,
            hubStatus: leadsTable.hubStatus,
            dayInSequence: leadsTable.dayInSequence,
            contactPreferences: leadsTable.contactPreferences,
            serviceType: leadsTable.serviceType,
            funnelId: leadsTable.funnelId,
            assignedCsrId: leadsTable.assignedCsrId,
            callbackAt: leadsTable.callbackAt,
            deadReason: leadsTable.deadReason,
            disposition: leadsTable.disposition,
            notes: leadsTable.notes,
            address: leadsTable.address,
            city: leadsTable.city,
            state: leadsTable.state,
            zip: leadsTable.zip,
            appointmentDate: leadsTable.appointmentDate,
            appointmentTime: leadsTable.appointmentTime,
            createdAt: leadsTable.createdAt,
            updatedAt: leadsTable.updatedAt,
            relevance: relevanceExpr.as("relevance"),
            lastTouchpoint: lastTouchpointExpr.as("last_touchpoint"),
          })
          .from(leadsTable)
          .where(tpWhere)
          .orderBy(orderExpr, desc(leadsTable.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(leadsTable).where(tpWhere),
      ]);

      console.log(`[LeadSearch] lastTouchpoint query returned ${leads.length} of ${totalResult.count} total`);
      res.json({ leads, total: totalResult.count });
      return;
    }

    const [leads, [totalResult]] = await Promise.all([
      db
        .select({
          id: leadsTable.id,
          tenantId: leadsTable.tenantId,
          firstName: leadsTable.firstName,
          lastName: leadsTable.lastName,
          phone: leadsTable.phone,
          email: leadsTable.email,
          source: leadsTable.source,
          leadType: leadsTable.leadType,
          interestType: leadsTable.interestType,
          status: leadsTable.status,
          hubStatus: leadsTable.hubStatus,
          dayInSequence: leadsTable.dayInSequence,
          contactPreferences: leadsTable.contactPreferences,
          serviceType: leadsTable.serviceType,
          funnelId: leadsTable.funnelId,
          assignedCsrId: leadsTable.assignedCsrId,
          callbackAt: leadsTable.callbackAt,
          deadReason: leadsTable.deadReason,
          disposition: leadsTable.disposition,
          notes: leadsTable.notes,
          address: leadsTable.address,
          city: leadsTable.city,
          state: leadsTable.state,
          zip: leadsTable.zip,
          appointmentDate: leadsTable.appointmentDate,
          appointmentTime: leadsTable.appointmentTime,
          createdAt: leadsTable.createdAt,
          updatedAt: leadsTable.updatedAt,
          relevance: relevanceExpr.as("relevance"),
        })
        .from(leadsTable)
        .where(where)
        .orderBy(q ? desc(sql`relevance`) : desc(leadsTable.createdAt), desc(leadsTable.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(leadsTable).where(where),
    ]);

    console.log(`[LeadSearch] query returned ${leads.length} of ${totalResult.count} total`);
    res.json({ leads, total: totalResult.count });
  } catch (err) {
    console.error("[LeadSearch] Error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

router.get("/leads/:leadId", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    if (lead.tenantId !== req.session.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }
  res.json(lead);
});

router.patch("/leads/:leadId", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const [existingLead] = await db.select({ tenantId: leadsTable.tenantId }).from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!existingLead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    if (existingLead.tenantId !== req.session.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }
  const body = UpdateLeadBody.parse(req.body);
  const updateData: Partial<typeof leadsTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  if (body.status) {
    updateData.status = body.status as "new" | "contacted" | "booked" | "sold" | "lost" | "cancelled";
  }
  if (body.assignedTo) updateData.assignedTo = body.assignedTo;
  if (body.disposition) updateData.disposition = body.disposition;

  const [lead] = await db.update(leadsTable).set(updateData).where(eq(leadsTable.id, leadId)).returning();
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  if (body.disposition && req.session.userId) {
    const dispositionToOutcome: Record<string, string> = {
      booked: "answered",
      callback_requested: "answered",
      not_interested: "answered",
      never_answered: "no_answer",
      out_of_area: "answered",
      looking_for_job: "answered",
      already_had_estimate: "answered",
      dont_remember: "answered",
    };
    const outcome = dispositionToOutcome[body.disposition] || "answered";
    try {
      const { logAttemptWithFollowup } = await import("../services/lead-scoring");
      await logAttemptWithFollowup(db, {
        leadId,
        userId: req.session.userId,
        method: "call",
        outcome,
        platform: "native",
        notes: `Disposition: ${body.disposition}`,
      });
      const { cancelAutoPass } = await import("../services/auto-pass-scheduler");
      cancelAutoPass(leadId);
    } catch (err) {
      console.error("[Leads] Auto-log call attempt on disposition failed:", err);
    }
  }

  emitLeadUpdated(lead.tenantId, lead as unknown as Record<string, unknown>);
  res.json(lead);
});

router.post("/leads/:leadId/call", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    if (lead.tenantId !== req.session.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  try {
    const result = await initiateCall(
      lead.tenantId,
      leadId,
      userId,
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to initiate call";
    res.status(500).json({ success: false, platform: "unknown", message });
  }
});

router.post("/leads/:leadId/text", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const { message: messageBody } = req.body || {};
  if (!messageBody || typeof messageBody !== "string") {
    res.status(400).json({ error: "Message body is required" });
    return;
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    if (lead.tenantId !== req.session.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  try {
    const result = await initiateText(
      lead.tenantId,
      leadId,
      userId,
      messageBody,
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send text";
    res.status(500).json({ success: false, platform: "unknown", message });
  }
});

export default router;
