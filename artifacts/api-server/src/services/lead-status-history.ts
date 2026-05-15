import { db, leadStatusHistoryTable } from "@workspace/db";

/**
 * Append a row to `lead_status_history` when a lead transitions between
 * hub_status values. Callers should pass the OLD status as `fromStatus` and
 * the NEW status as `toStatus`. No-op transitions (from === to) are dropped.
 *
 * This is the durable audit log for task #416 — failures propagate so the
 * surrounding mutation fails too rather than silently losing history. Wrap
 * the lead update + this call in a transaction (or accept fail-fast) at
 * call sites where atomicity is required.
 */
export async function recordLeadStatusChange(opts: {
  leadId: number;
  tenantId: number;
  fromStatus: string | null | undefined;
  toStatus: string;
  changedAt?: Date;
  changedByUserId?: number | null;
  reason?: string | null;
}): Promise<void> {
  if (opts.fromStatus === opts.toStatus) return;
  await db.insert(leadStatusHistoryTable).values({
    leadId: opts.leadId,
    tenantId: opts.tenantId,
    fromStatus: opts.fromStatus ?? null,
    toStatus: opts.toStatus,
    changedAt: opts.changedAt ?? new Date(),
    changedByUserId: opts.changedByUserId ?? null,
    reason: opts.reason ?? null,
  });
}
