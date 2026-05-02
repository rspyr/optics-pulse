import { db, leadsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { assignLeadRoundRobin } from "./round-robin";
import { scheduleAutoPass, leadHasRealTouch } from "./auto-pass-scheduler";

const REROUTABLE_HUB_STATUSES = new Set([
  "day_1", "day_2", "day_3", "day_4", "day_5_old", "call_back",
]);

export interface ReRouteResult {
  attempted: number;
  reassigned: number;
  skippedTouched: number;
  skippedTerminal: number;
}

/**
 * Re-runs round-robin routing for the given lead IDs after their funnel/source
 * attribution was corrected by an alias save. Only leads still in an
 * actionable hubStatus (day_1..day_5_old, call_back) and with no real CSR
 * touch yet are reassigned — booked / appt_set / dead leads, and leads a
 * rep has already started working, are left alone so we don't yank work
 * mid-flow.
 *
 * Priority scoring is computed on read (see getSmartQueue /
 * analyzeContactPattern) and reads the lead's current funnel/source row,
 * so it picks up the new attribution automatically on the next queue load
 * — no separate recompute step is needed here.
 */
export async function reRouteLeadsAfterAttributionChange(
  tenantId: number,
  leadIds: number[],
): Promise<ReRouteResult> {
  const result: ReRouteResult = { attempted: 0, reassigned: 0, skippedTouched: 0, skippedTerminal: 0 };
  if (leadIds.length === 0) return result;

  const leads = await db.select({
    id: leadsTable.id,
    hubStatus: leadsTable.hubStatus,
    funnelId: leadsTable.funnelId,
  }).from(leadsTable).where(and(
    eq(leadsTable.tenantId, tenantId),
    inArray(leadsTable.id, leadIds),
  ));

  for (const lead of leads) {
    if (!REROUTABLE_HUB_STATUSES.has(lead.hubStatus)) {
      result.skippedTerminal++;
      continue;
    }
    const touched = await leadHasRealTouch(lead.id);
    if (touched) {
      result.skippedTouched++;
      continue;
    }
    result.attempted++;
    const rr = await assignLeadRoundRobin(tenantId, lead.id, lead.funnelId ?? null);
    if (rr.assignedCsrId) {
      result.reassigned++;
      if (rr.passIntervalMinutes != null) {
        scheduleAutoPass(lead.id, rr.passIntervalMinutes * 60 * 1000);
      }
    }
  }

  return result;
}
