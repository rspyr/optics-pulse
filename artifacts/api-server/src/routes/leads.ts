import { Router, type IRouter } from "express";
import { db, leadsTable } from "@workspace/db";
import { eq, and, count, desc, SQL } from "drizzle-orm";
import { ListLeadsQueryParams, GetLeadParams, UpdateLeadBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/leads", async (req, res) => {
  const query = ListLeadsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  if (query.tenantId) conditions.push(eq(leadsTable.tenantId, query.tenantId));
  if (query.status) conditions.push(eq(leadsTable.status, query.status as any));
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

router.get("/leads/:leadId", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  res.json(lead);
});

router.patch("/leads/:leadId", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const body = UpdateLeadBody.parse(req.body);
  const updateData: Record<string, any> = { updatedAt: new Date() };
  if (body.status) updateData.status = body.status;
  if (body.assignedTo) updateData.assignedTo = body.assignedTo;
  if (body.disposition) updateData.disposition = body.disposition;

  const [lead] = await db.update(leadsTable).set(updateData).where(eq(leadsTable.id, leadId)).returning();
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  res.json(lead);
});

export default router;
