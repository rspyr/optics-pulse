import { db, leadsTable, callAttemptsTable, usersTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { emitLeadResubmitted } from "../socket";
import { enqueueSendPushToUser } from "./push-notification-jobs";
import { recordLeadStatusChange } from "./lead-status-history";
import { isValidAppointmentValue } from "../utils/appointment-validation";

const TERMINAL_HUB_STATUSES = new Set(["appt_set", "appt_booked", "dead"]);

export interface ResubmissionResult {
  resubmitted: boolean;
  reactivated: boolean;
  leadId: number;
  reason?: string;
}

export interface ResubmissionOptions {
  /** Appointment date booked on this particular submission, if any. */
  appointmentDate?: string | null;
  /** Appointment time booked on this particular submission, if any. */
  appointmentTime?: string | null;
  /** Add-ons captured on this submission, if any. */
  addOns?: string | null;
  /** When this submission actually occurred (e.g. sheet timestamp). Defaults to now. */
  submittedAt?: Date | null;
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
  options: ResubmissionOptions = {},
): Promise<ResubmissionResult> {
  const [lead] = await db.select().from(leadsTable)
    .where(and(eq(leadsTable.id, existingLeadId), eq(leadsTable.tenantId, tenantId)));

  if (!lead) {
    return { resubmitted: false, reactivated: false, leadId: existingLeadId, reason: "lead_not_found" };
  }

  const now = new Date();
  const submittedAt = options.submittedAt ?? now;
  const apptDate = isValidAppointmentValue(options.appointmentDate) ? options.appointmentDate!.trim() : null;
  const apptTime = isValidAppointmentValue(options.appointmentTime) ? options.appointmentTime!.trim() : null;
  const hasNewBooking = Boolean(apptDate || apptTime);

  // A CSR-confirmed appointment (appt_set) or a sold lead is authoritative —
  // never silently overwrite its appointment, but still log the new submission.
  const apptLocked = lead.hubStatus === "appt_set" || lead.hasSoldEstimate;
  const isTerminal = TERMINAL_HUB_STATUSES.has(lead.hubStatus) || lead.hasSoldEstimate;

  const updates: Record<string, unknown> = {
    resubmittedAt: now,
    resubmissionCount: sql`COALESCE(${leadsTable.resubmissionCount}, 0) + 1`,
    updatedAt: now,
  };

  let reactivated = false;

  if (hasNewBooking && !apptLocked) {
    // Latest booking wins: this submission carries an appointment and the lead
    // is not in a protected state, so adopt it as the current appointment.
    if (apptDate) updates.appointmentDate = apptDate;
    if (apptTime) updates.appointmentTime = apptTime;
    if (options.addOns) updates.addOns = options.addOns;
    updates.preBooked = true;
    updates.visibleAfter = null;
    // A dead lead is not silently reopened by a resubmission booking (matches
    // the backfill path); its booking fields are recorded but it stays dead.
    if (lead.hubStatus !== "appt_booked" && lead.hubStatus !== "dead") {
      updates.hubStatus = "appt_booked";
    }
  } else if (!isTerminal) {
    updates.hubStatus = "day_1";
    updates.status = "new";
    updates.dayInSequence = 1;
    updates.callbackAt = null;
    updates.callbackNotifiedAt = null;
    updates.deadReason = null;
    reactivated = true;
  }

  await db.update(leadsTable).set(updates).where(eq(leadsTable.id, existingLeadId));

  const newHubStatus = updates.hubStatus as string | undefined;
  if (newHubStatus && newHubStatus !== lead.hubStatus) {
    await recordLeadStatusChange({
      leadId: existingLeadId,
      tenantId,
      fromStatus: lead.hubStatus,
      toStatus: newHubStatus,
      changedAt: now,
      changedByUserId: lead.assignedCsrId ?? null,
      reason: `resubmission:${sourceLabel}`,
    });
  }

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
    const bookedLabel = hasNewBooking
      ? ` — booked ${[apptDate, apptTime].filter(Boolean).join(" ")}`
      : "";
    await db.insert(callAttemptsTable).values({
      leadId: existingLeadId,
      userId: attemptUserId,
      method: "system",
      outcome: "resubmission",
      platform: "native",
      actionType: "system",
      notes: `Lead resubmitted from ${sourceLabel}${bookedLabel}`,
      appointmentDate: apptDate,
      appointmentTime: apptTime,
      attemptedAt: submittedAt,
    });
  }

  if (reactivated && lead.assignedCsrId) {
    const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Lead";
    emitLeadResubmitted(tenantId, {
      leadId: existingLeadId,
      assignedCsrId: lead.assignedCsrId,
      leadName,
      source: sourceLabel,
      reactivated,
    });
    try {
      await enqueueSendPushToUser({
        userId: lead.assignedCsrId,
        title: "Lead Resubmitted",
        body: `${leadName} resubmitted from ${sourceLabel} — reach out again`,
        data: { leadId: existingLeadId, type: "lead-resubmitted", intent: "open-lead" },
        tenantId,
        source: "lead-resubmission",
      });
    } catch (err) {
      console.error("[Push] handleResubmission enqueue error:", err);
    }
  }

  return {
    resubmitted: true,
    reactivated,
    leadId: existingLeadId,
  };
}
