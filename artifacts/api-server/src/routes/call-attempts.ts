import { Router, type IRouter, type Request } from "express";
import { db, callAttemptsTable, leadsTable, scheduledFollowupsTable } from "@workspace/db";
import { eq, desc, and, lte, gte } from "drizzle-orm";
import { analyzeContactPattern, logAttemptWithFollowup } from "../services/lead-scoring";
import { cancelAutoPass } from "../services/auto-pass-scheduler";
import type { SessionData } from "express-session";

const router: IRouter = Router();

async function verifyLeadTenantAccess(leadId: number, session: SessionData): Promise<boolean> {
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

const VALID_METHODS = ["call", "text", "email", "voicemail", "transfer", "voicemail_drop"] as const;
const VALID_OUTCOMES = [
  "answered", "voicemail", "no_answer", "busy", "sent",
  "left_voicemail", "vm_full", "vm_not_setup", "hung_up",
  "appointment_set", "call_back", "dead", "auto_passed",
  "transferred", "bad_number", "blocked", "out_of_service_area",
  "not_interested", "too_expensive", "no_response",
] as const;

router.get("/call-attempts/:leadId", async (req: Request, res): Promise<void> => {
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

router.post("/call-attempts", async (req: Request, res): Promise<void> => {
  const { leadId, method, outcome, platform, notes, attemptedAt } = req.body;
  const userId = req.session.userId;

  if (!leadId || !outcome || !userId) {
    res.status(400).json({ error: "leadId and outcome are required" });
    return;
  }

  const resolvedMethod = method || "call";
  if (!VALID_METHODS.includes(resolvedMethod)) {
    res.status(400).json({ error: `Invalid method. Must be one of: ${VALID_METHODS.join(", ")}` });
    return;
  }
  if (!VALID_OUTCOMES.includes(outcome)) {
    res.status(400).json({ error: `Invalid outcome. Must be one of: ${VALID_OUTCOMES.join(", ")}` });
    return;
  }

  if (!(await verifyLeadTenantAccess(leadId, req.session))) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  await logAttemptWithFollowup(db, {
    leadId,
    userId,
    method: resolvedMethod,
    outcome,
    platform: platform || "native",
    attemptedAt: attemptedAt ? new Date(attemptedAt) : undefined,
    notes: notes || null,
  });

  const realTouchMethods = ["call", "text", "voicemail_drop", "voicemail"];
  if (realTouchMethods.includes(resolvedMethod)) {
    cancelAutoPass(leadId);
  }

  const [attempt] = await db.select().from(callAttemptsTable)
    .where(eq(callAttemptsTable.leadId, leadId))
    .orderBy(desc(callAttemptsTable.attemptedAt))
    .limit(1);

  res.status(201).json(attempt);
});

router.patch("/call-attempts/:id", async (_req: Request, res): Promise<void> => {
  res.status(403).json({ error: "Action logs are append-only and cannot be modified" });
});

router.delete("/call-attempts/:id", async (_req: Request, res): Promise<void> => {
  res.status(403).json({ error: "Action logs are append-only and cannot be deleted" });
});

router.get("/call-attempts/:leadId/suggest", async (req: Request, res): Promise<void> => {
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

  const pendingFollowups = await db.select().from(scheduledFollowupsTable)
    .where(and(
      eq(scheduledFollowupsTable.leadId, leadId),
      eq(scheduledFollowupsTable.completed, false),
    ))
    .orderBy(scheduledFollowupsTable.scheduledFor);

  res.json({
    ...result,
    pendingFollowups: pendingFollowups.map(f => ({
      id: f.id,
      reason: f.reason,
      scheduledFor: f.scheduledFor.toISOString(),
    })),
  });
});

router.get("/scheduled-followups", async (req: Request, res): Promise<void> => {
  const tenantId = req.session.tenantId;
  const now = new Date();

  const followups = await db.select({
    id: scheduledFollowupsTable.id,
    leadId: scheduledFollowupsTable.leadId,
    reason: scheduledFollowupsTable.reason,
    scheduledFor: scheduledFollowupsTable.scheduledFor,
    leadFirstName: leadsTable.firstName,
    leadLastName: leadsTable.lastName,
    leadPhone: leadsTable.phone,
  })
    .from(scheduledFollowupsTable)
    .innerJoin(leadsTable, eq(scheduledFollowupsTable.leadId, leadsTable.id))
    .where(and(
      eq(scheduledFollowupsTable.completed, false),
      lte(scheduledFollowupsTable.scheduledFor, now),
      ...(tenantId ? [eq(leadsTable.tenantId, tenantId)] : []),
    ))
    .orderBy(scheduledFollowupsTable.scheduledFor)
    .limit(50);

  res.json(followups);
});

router.patch("/scheduled-followups/:id/complete", async (req: Request, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid followup id" }); return; }

  const [existing] = await db.select().from(scheduledFollowupsTable)
    .where(eq(scheduledFollowupsTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Followup not found" }); return; }

  if (!(await verifyLeadTenantAccess(existing.leadId, req.session))) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const [updated] = await db.update(scheduledFollowupsTable)
    .set({ completed: true, completedAt: new Date() })
    .where(eq(scheduledFollowupsTable.id, id))
    .returning();

  res.json(updated);
});

export default router;
