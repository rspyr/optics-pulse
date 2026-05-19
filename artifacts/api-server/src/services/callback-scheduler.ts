import { db, leadsTable } from "@workspace/db";
import { and, lte, isNotNull, ne, asc, or, eq, sql } from "drizzle-orm";
import { enqueueSendPushToUser } from "./push-notification-jobs";
import { emitCallbackDue } from "../socket";

const CHECK_INTERVAL_MS = 60_000;

async function checkDueCallbacks() {
  try {
    const now = new Date();
    let offset = 0;
    const pageSize = 50;

    while (true) {
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
        .orderBy(asc(leadsTable.callbackAt))
        .limit(pageSize)
        .offset(offset);

      if (dueLeads.length === 0) break;

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

      if (dueLeads.length < pageSize) break;
      offset += pageSize;
    }
  } catch (err) {
    console.error("[CallbackScheduler] Error checking callbacks:", err);
  }
}

export function startCallbackScheduler() {
  console.log("[CallbackScheduler] Starting callback notification scheduler");
  setInterval(checkDueCallbacks, CHECK_INTERVAL_MS);
  setTimeout(checkDueCallbacks, 5000);
}
