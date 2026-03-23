import { Router, type IRouter } from "express";
import { db, callAttemptsTable, leadsTable } from "@workspace/db";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { analyzeContactPattern } from "../services/lead-scoring";

const router: IRouter = Router();

async function verifyLeadTenantAccess(leadId: number, session: any): Promise<boolean> {
  const role = session.userRole;
  if (role === "super_admin" || role === "agency_user") return true;

  const tenantId = session.tenantId;
  if (!tenantId) return false;

  const [lead] = await db.select({ tenantId: leadsTable.tenantId })
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId))
    .limit(1);

  return lead?.tenantId === tenantId;
}

router.get("/call-attempts/:leadId", async (req, res): Promise<void> => {
  const leadId = parseInt(String(req.params.leadId));
  if (isNaN(leadId)) { res.status(400).json({ error: "Invalid leadId" }); return; }

  if (!(await verifyLeadTenantAccess(leadId, req.session))) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const attempts = await db.select().from(callAttemptsTable)
    .where(eq(callAttemptsTable.leadId, leadId))
    .orderBy(desc(callAttemptsTable.attemptedAt));
  res.json(attempts);
});

router.post("/call-attempts", async (req, res): Promise<void> => {
  const { leadId, outcome, notes } = req.body;
  const userId = req.session.userId;

  if (!leadId || !outcome || !userId) {
    res.status(400).json({ error: "leadId and outcome are required" });
    return;
  }

  if (!(await verifyLeadTenantAccess(leadId, req.session))) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const [attempt] = await db.insert(callAttemptsTable).values({
    leadId,
    userId,
    outcome,
    notes: notes || null,
  }).returning();

  res.status(201).json(attempt);
});

router.get("/call-attempts/:leadId/suggest", async (req, res): Promise<void> => {
  const leadId = parseInt(String(req.params.leadId));
  if (isNaN(leadId)) { res.status(400).json({ error: "Invalid leadId" }); return; }

  if (!(await verifyLeadTenantAccess(leadId, req.session))) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const attempts = await db.select().from(callAttemptsTable)
    .where(eq(callAttemptsTable.leadId, leadId))
    .orderBy(desc(callAttemptsTable.attemptedAt));

  const result = analyzeContactPattern(attempts);
  res.json(result);
});

export default router;
