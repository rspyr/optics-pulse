import { db, leadsTable, callAttemptsTable, usersTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { emitLeadResubmitted } from "../socket";
import { sendPushToUser } from "./push-notifications";

const TERMINAL_HUB_STATUSES = new Set(["appt_set", "appt_booked", "dead"]);

export interface ResubmissionResult {
  resubmitted: boolean;
  reactivated: boolean;
  leadId: number;
  reason?: string;
}

/**
 * Mark an existing lead as resubmitted. If the lead is in a non-terminal,
 * non-sold state, also reset the work cycle (status -> day_1, day 1).
 * Always sets resubmittedAt and logs a system entry to the unified timeline.
 * Preserves existing CSR assignment (no round-robin re-run, no cascade advance).
 */
export async function handleResubmission(
  tenantId: number,
  existingLeadId: number,
  sourceLabel: string,
): Promise<ResubmissionResult> {
  const [lead] = await db.select().from(leadsTable)
    .where(and(eq(leadsTable.id, existingLeadId), eq(leadsTable.tenantId, tenantId)));

  if (!lead) {
    return { resubmitted: false, reactivated: false, leadId: existingLeadId, reason: "lead_not_found" };
  }

  const now = new Date();
  const isTerminal = TERMINAL_HUB_STATUSES.has(lead.hubStatus) || lead.hasSoldEstimate;

  const updates: Record<string, unknown> = {
    resubmittedAt: now,
    resubmissionCount: sql`COALESCE(${leadsTable.resubmissionCount}, 0) + 1`,
    updatedAt: now,
  };

  if (!isTerminal) {
    updates.hubStatus = "day_1";
    updates.status = "new";
    updates.dayInSequence = 1;
    updates.callbackAt = null;
    updates.deadReason = null;
  }

  await db.update(leadsTable).set(updates).where(eq(leadsTable.id, existingLeadId));

  // Resolve a userId for the system timeline entry. Prefer the assigned CSR;
  // fall back to the most recent attempt's user; finally any tenant user.
  let attemptUserId: number | null = lead.assignedCsrId ?? null;
  if (!attemptUserId) {
    const [recent] = await db.select({ userId: callAttemptsTable.userId })
      .from(callAttemptsTable)
      .where(eq(callAttemptsTable.leadId, existingLeadId))
      .orderBy(desc(callAttemptsTable.attemptedAt))
      .limit(1);
    attemptUserId = recent?.userId ?? null;
  }
  if (!attemptUserId) {
    const [anyUser] = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.tenantId, tenantId))
      .limit(1);
    attemptUserId = anyUser?.id ?? null;
  }

  if (attemptUserId) {
    await db.insert(callAttemptsTable).values({
      leadId: existingLeadId,
      userId: attemptUserId,
      method: "system",
      outcome: "resubmission",
      platform: "native",
      actionType: "system",
      notes: `Lead resubmitted from ${sourceLabel}`,
    });
  }

  const reactivated = !isTerminal;

  if (reactivated && lead.assignedCsrId) {
    const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Lead";
    emitLeadResubmitted(tenantId, {
      leadId: existingLeadId,
      assignedCsrId: lead.assignedCsrId,
      leadName,
      source: sourceLabel,
      reactivated,
    });
    sendPushToUser(
      lead.assignedCsrId,
      "Lead Resubmitted",
      `${leadName} resubmitted from ${sourceLabel} — reach out again`,
      { leadId: existingLeadId, type: "lead-resubmitted", intent: "open-lead" },
    ).catch(err => console.error("[Push] handleResubmission push error:", err));
  }

  return {
    resubmitted: true,
    reactivated,
    leadId: existingLeadId,
  };
}
