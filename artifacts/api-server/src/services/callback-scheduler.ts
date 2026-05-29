import { db, leadsTable } from "@workspace/db";
import { and, lte, isNotNull, ne, asc, or, eq, sql } from "drizzle-orm";
import { enqueueSendPushToUser } from "./push-notification-jobs";
import { emitCallbackDue } from "../socket";
import { createGuardedRunner } from "../lib/reentrancy-guard";

const CHECK_INTERVAL_MS = 60_000;

export async function checkDueCallbacks() {
  try {
    const now = new Date();
    const pageSize = 50;

    while (true) {
      // Always re-query the first page of still-unnotified due leads. Because each
      // lead we process is marked notified (which removes it from this result set),
      // advancing a LIMIT/OFFSET cursor would skip the rows that shifted up into the
      // pages we already passed. Re-reading page one until it is empty guarantees we
      // process every due callback exactly once with no skips, regardless of batch size.
      const dueLeads = await db
        .select({
          id: leadsTable.id,
          tenantId: leadsTable.tenantId,
          firstName: leadsTable.firstName,
          lastName: leadsTable.lastName,
          phone: leadsTable.phone,
          callbackAt: leadsTable.callbackAt,
          assignedCsrId: leadsTable.assignedCsrId,
          callbackNotifiedAt: leadsTable.callbackNotifiedAt,
        })
        .from(leadsTable)
        .where(
          and(
            isNotNull(leadsTable.callbackAt),
            lte(leadsTable.callbackAt, now),
            isNotNull(leadsTable.assignedCsrId),
            ne(leadsTable.hubStatus, "dead"),
            or(
              sql`${leadsTable.callbackNotifiedAt} IS NULL`,
              sql`${leadsTable.callbackNotifiedAt} < ${leadsTable.callbackAt}`,
            ),
          )
        )
        // Unique id tiebreaker (same asc direction as callbackAt) gives a stable
        // total order so each page reads the oldest still-due callbacks first.
        .orderBy(asc(leadsTable.callbackAt), asc(leadsTable.id))
        .limit(pageSize);

      if (dueLeads.length === 0) break;

      let claimedInPage = 0;

      for (const lead of dueLeads) {
        if (!lead.assignedCsrId) continue;

        const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unknown";
        const phone = lead.phone || "";

        const claimed = await db
          .update(leadsTable)
          .set({ callbackNotifiedAt: new Date() })
          .where(
            and(
              eq(leadsTable.id, lead.id),
              or(
                sql`${leadsTable.callbackNotifiedAt} IS NULL`,
                sql`${leadsTable.callbackNotifiedAt} < ${leadsTable.callbackAt}`,
              ),
            ),
          )
          .returning({ id: leadsTable.id });

        if (claimed.length === 0) continue;

        claimedInPage++;

        await enqueueSendPushToUser({
          userId: lead.assignedCsrId,
          title: "Callback Due",
          body: `${name}${phone ? ` - ${phone}` : ""} is ready for a callback`,
          data: { type: "callback", leadId: lead.id, intent: "open-lead" },
          tenantId: lead.tenantId,
          source: "callback-scheduler",
        });

        emitCallbackDue(lead.tenantId, {
          leadId: lead.id,
          targetUserId: lead.assignedCsrId,
          leadName: name,
          phone: phone || undefined,
          callbackAt: lead.callbackAt?.toISOString(),
        });

        console.log(`[CallbackScheduler] Sent push for lead ${lead.id} to user ${lead.assignedCsrId}`);
      }

      // Safety guard: if nothing on this page could be claimed (e.g. every row was
      // already notified by a concurrent sweep), re-querying would return the same
      // rows forever. Stop instead of looping endlessly.
      if (claimedInPage === 0) break;
    }
  } catch (err) {
    console.error("[CallbackScheduler] Error checking callbacks:", err);
  }
}

// Re-entrancy guard. The scheduler fires on a fixed interval, but a sweep can
// take longer than that interval (lots of due callbacks, slow DB). Without a
// guard, each tick would start another overlapping sweep, piling up redundant
// DB work and connections. We let at most one sweep run at a time: a tick that
// fires while a sweep is still in progress is dropped (the next tick will pick
// up whatever remains). This guard lives at the scheduling layer, not inside
// `checkDueCallbacks`, so direct/concurrent callers (e.g. tests) are unaffected
// and the conditional-claim correctness guarantee still holds.
export const runGuardedSweep = createGuardedRunner(
  "CallbackScheduler",
  checkDueCallbacks,
);

export function startCallbackScheduler() {
  console.log("[CallbackScheduler] Starting callback notification scheduler");
  setInterval(() => {
    void runGuardedSweep();
  }, CHECK_INTERVAL_MS);
  setTimeout(() => {
    void runGuardedSweep();
  }, 5000);
}
