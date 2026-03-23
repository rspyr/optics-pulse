import { Router, type IRouter } from "express";
import { db, leadsTable, callAttemptsTable } from "@workspace/db";
import { eq, and, count, desc, sql, SQL, inArray } from "drizzle-orm";
import { ListLeadsQueryParams, GetLeadParams, UpdateLeadBody } from "@workspace/api-zod";
import { getHudStats, emitNewLead, emitLeadUpdated } from "../socket";
import { initiateCall, initiateText, getTenantCommConfig, getCommConfigStatus } from "../services/integrations/communication";
import { getSmartQueue } from "../services/lead-scoring";
import { getComparisonStats, getHistoricalStats, aggregateDailyStats } from "../services/coordinator-stats";
import type { ComparisonBaseline } from "../services/coordinator-stats";

const router: IRouter = Router();

router.get("/leads", async (req, res) => {
  const query = ListLeadsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  if (query.tenantId) conditions.push(eq(leadsTable.tenantId, query.tenantId));
  if (query.status) {
    const status = query.status as "new" | "contacted" | "booked" | "sold" | "lost" | "cancelled";
    conditions.push(eq(leadsTable.status, status));
  }
  if (query.source) conditions.push(eq(leadsTable.source, query.source));

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
    console.error("[HUD Queue] Smart queue error, falling back:", err);
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
  const tenantId = (role === "super_admin" || role === "agency_user")
    ? (req.query.tenantId ? Number(req.query.tenantId) : null)
    : req.session.tenantId ?? null;

  const stats = await getHudStats(tenantId);
  res.json(stats);
});

router.get("/leads/hud/comparison", async (req, res) => {
  const role = req.session.userRole;
  const tenantId = (role === "super_admin" || role === "agency_user")
    ? (req.query.tenantId ? Number(req.query.tenantId) : null)
    : req.session.tenantId ?? null;

  const baseline = (req.query.baseline as string) || "yesterday";
  const validBaselines = ["yesterday", "last_week", "monthly_avg", "all_time_best"];
  if (!validBaselines.includes(baseline)) {
    res.status(400).json({ error: `Invalid baseline. Must be one of: ${validBaselines.join(", ")}` });
    return;
  }

  try {
    const result = await getComparisonStats(
      tenantId,
      baseline as ComparisonBaseline,
    );
    res.json(result);
  } catch (err) {
    console.error("[HUD Comparison]", err);
    res.status(500).json({ error: "Failed to fetch comparison stats" });
  }
});

router.get("/leads/hud/historical", async (req, res) => {
  const role = req.session.userRole;
  const tenantId = (role === "super_admin" || role === "agency_user")
    ? (req.query.tenantId ? Number(req.query.tenantId) : null)
    : req.session.tenantId ?? null;

  const range = (req.query.range as string) || "30";
  const days = parseInt(range);
  const endDate = new Date().toISOString().split("T")[0];
  const startDateObj = new Date();
  startDateObj.setDate(startDateObj.getDate() - (isNaN(days) ? 30 : days));
  const startDate = (req.query.startDate as string) || startDateObj.toISOString().split("T")[0];
  const endDateParam = (req.query.endDate as string) || endDate;

  try {
    const result = await getHistoricalStats(tenantId, startDate, endDateParam);
    res.json(result);
  } catch (err) {
    console.error("[HUD Historical]", err);
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
