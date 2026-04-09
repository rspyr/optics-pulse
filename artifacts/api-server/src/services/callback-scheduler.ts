import { db, leadsTable } from "@workspace/db";
import { and, lte, isNotNull, ne, asc } from "drizzle-orm";
import { sendPushToUser } from "./push-notifications";
import { emitCallbackDue } from "../socket";

const CHECK_INTERVAL_MS = 60_000;
const NOTIFIED_SET = new Map<number, number>();
const NOTIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

function pruneOldNotifications() {
  const cutoff = Date.now() - NOTIFICATION_EXPIRY_MS;
  for (const [id, ts] of NOTIFIED_SET) {
    if (ts < cutoff) NOTIFIED_SET.delete(id);
  }
}

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
        })
        .from(leadsTable)
        .where(
          and(
            isNotNull(leadsTable.callbackAt),
            lte(leadsTable.callbackAt, now),
            isNotNull(leadsTable.assignedCsrId),
            ne(leadsTable.hubStatus, "dead"),
          )
        )
        .orderBy(asc(leadsTable.callbackAt))
        .limit(pageSize)
        .offset(offset);

      if (dueLeads.length === 0) break;

      for (const lead of dueLeads) {
        if (!lead.assignedCsrId || NOTIFIED_SET.has(lead.id)) continue;

        const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unknown";
        const phone = lead.phone || "";

        await sendPushToUser(
          lead.assignedCsrId,
          "Callback Due",
          `${name}${phone ? ` - ${phone}` : ""} is ready for a callback`,
          { type: "callback", leadId: lead.id },
        );

        emitCallbackDue(lead.tenantId, {
          leadId: lead.id,
          targetUserId: lead.assignedCsrId,
          leadName: name,
          phone: phone || undefined,
          callbackAt: lead.callbackAt?.toISOString(),
        });

        NOTIFIED_SET.set(lead.id, Date.now());
        console.log(`[CallbackScheduler] Sent push for lead ${lead.id} to user ${lead.assignedCsrId}`);
      }

      if (dueLeads.length < pageSize) break;
      offset += pageSize;
    }

    pruneOldNotifications();
  } catch (err) {
    console.error("[CallbackScheduler] Error checking callbacks:", err);
  }
}

export function startCallbackScheduler() {
  console.log("[CallbackScheduler] Starting callback notification scheduler");
  setInterval(checkDueCallbacks, CHECK_INTERVAL_MS);
  setTimeout(checkDueCallbacks, 5000);
}
