import { enqueueJob, registerJobHandler } from "./background-jobs";
import { syncPodiumConversationAssignment } from "./integrations/podium-api";

export const SYNC_PODIUM_CONVERSATION_ASSIGNMENT =
  "sync_podium_conversation_assignment";

interface SyncPodiumAssignmentPayload {
  leadId: number;
  targetCsrId: number;
  tenantId: number;
}

function parsePayload(p: Record<string, unknown>): SyncPodiumAssignmentPayload {
  const leadId = p["leadId"];
  const targetCsrId = p["targetCsrId"];
  const tenantId = p["tenantId"];
  if (
    typeof leadId !== "number" ||
    typeof targetCsrId !== "number" ||
    typeof tenantId !== "number"
  ) {
    throw new Error(
      `Invalid payload for ${SYNC_PODIUM_CONVERSATION_ASSIGNMENT}: ${JSON.stringify(p)}`,
    );
  }
  return { leadId, targetCsrId, tenantId };
}

export function registerPodiumSyncJobHandlers(): void {
  registerJobHandler(SYNC_PODIUM_CONVERSATION_ASSIGNMENT, async (payload) => {
    const args = parsePayload(payload);
    await syncPodiumConversationAssignment(args.leadId, args.targetCsrId);
    return { leadId: args.leadId, targetCsrId: args.targetCsrId };
  });
}

/**
 * Enqueue a durable Podium conversation reassignment. Replaces the prior
 * `syncPodiumConversationAssignment(...).catch(() => {})` fire-and-forget,
 * so the reassignment survives an api-server restart and gets retried on
 * transient Podium API failures instead of silently disappearing.
 */
export async function enqueueSyncPodiumConversationAssignment(
  args: SyncPodiumAssignmentPayload,
) {
  return enqueueJob(
    SYNC_PODIUM_CONVERSATION_ASSIGNMENT,
    args as unknown as Record<string, unknown>,
    { tenantId: args.tenantId },
  );
}
