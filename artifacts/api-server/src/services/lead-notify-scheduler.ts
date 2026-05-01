import { db, leadsTable } from "@workspace/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { emitNewLead } from "../socket";

const timers = new Map<number, ReturnType<typeof setTimeout>>();

const MAX_DELAY_MS = 2_147_483_000;

async function fireNewLeadEmit(leadId: number): Promise<void> {
  timers.delete(leadId);
  try {
    const claimed = await db
      .update(leadsTable)
      .set({ newLeadNotifiedAt: new Date() })
      .where(and(eq(leadsTable.id, leadId), isNull(leadsTable.newLeadNotifiedAt)))
      .returning({ id: leadsTable.id });

    if (claimed.length === 0) {
      return;
    }

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    if (!lead) return;

    emitNewLead(lead.tenantId, lead as unknown as Record<string, unknown>);
  } catch (err) {
    console.error(`[LeadNotifyScheduler] Failed to fire new-lead emit for lead ${leadId}:`, err);
  }
}

export function scheduleOrEmitNewLead(leadId: number, visibleAfter: Date | null): void {
  const now = Date.now();
  const fireAt = visibleAfter ? visibleAfter.getTime() : now;
  const delayMs = Math.max(0, fireAt - now);

  if (delayMs === 0) {
    void fireNewLeadEmit(leadId);
    return;
  }

  const existing = timers.get(leadId);
  if (existing) clearTimeout(existing);

  const cappedDelay = Math.min(delayMs, MAX_DELAY_MS);
  const timer = setTimeout(() => {
    if (cappedDelay < delayMs) {
      scheduleOrEmitNewLead(leadId, visibleAfter);
    } else {
      void fireNewLeadEmit(leadId);
    }
  }, cappedDelay);
  timer.unref?.();
  timers.set(leadId, timer);
}

export async function recoverPendingNewLeadEmits(): Promise<void> {
  try {
    const pending = await db
      .select({ id: leadsTable.id, visibleAfter: leadsTable.visibleAfter })
      .from(leadsTable)
      .where(and(isNotNull(leadsTable.visibleAfter), isNull(leadsTable.newLeadNotifiedAt)));

    let scheduled = 0;
    let firedNow = 0;
    for (const row of pending) {
      const va = row.visibleAfter as Date | null;
      if (!va) continue;
      if (va.getTime() <= Date.now()) {
        firedNow++;
      } else {
        scheduled++;
      }
      scheduleOrEmitNewLead(row.id, va);
    }

    if (pending.length > 0) {
      console.log(
        `[LeadNotifyScheduler] Recovered ${pending.length} pending new-lead emit(s): ${firedNow} firing now, ${scheduled} scheduled for later`,
      );
    }
  } catch (err) {
    console.error("[LeadNotifyScheduler] Recovery failed:", err);
  }
}

export function _clearAllTimersForTesting(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

export function _hasPendingTimer(leadId: number): boolean {
  return timers.has(leadId);
}
