import { Router, type IRouter } from "express";
import { db, leadsTable } from "@workspace/db";
import { eq, and, count, desc, sql, SQL, inArray } from "drizzle-orm";
import { ListLeadsQueryParams, GetLeadParams, UpdateLeadBody } from "@workspace/api-zod";
import { getHudStats, emitNewLead, emitLeadUpdated } from "../socket";

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

  const conditions: SQL[] = [];
  if (tenantId) conditions.push(eq(leadsTable.tenantId, tenantId));
  conditions.push(inArray(leadsTable.status, ["new", "contacted"]));

  const where = and(...conditions);
  const leads = await db.select().from(leadsTable).where(where).orderBy(desc(leadsTable.createdAt)).limit(100);

  const now = Date.now();
  const newLeads = leads.filter(l => l.status === "new");
  const followUps = leads.filter(l => {
    if (l.status !== "contacted") return false;
    const age = now - new Date(l.updatedAt).getTime();
    return age < 24 * 60 * 60 * 1000;
  });
  const background = leads.filter(l => {
    if (l.status !== "contacted") return false;
    const age = now - new Date(l.updatedAt).getTime();
    return age >= 24 * 60 * 60 * 1000;
  });

  res.json({
    newLeads,
    followUps,
    background,
    total: leads.length,
  });
});

router.get("/leads/hud/stats", async (req, res) => {
  const role = req.session.userRole;
  const tenantId = (role === "super_admin" || role === "agency_user")
    ? (req.query.tenantId ? Number(req.query.tenantId) : null)
    : req.session.tenantId ?? null;

  const stats = await getHudStats(tenantId);
  res.json(stats);
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
  emitLeadUpdated(lead.tenantId, lead as unknown as Record<string, unknown>);
  res.json(lead);
});

export default router;
