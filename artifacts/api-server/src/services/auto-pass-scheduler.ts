import {
  db, leadsTable, usersTable, routingConfigTable, csrScheduleTable, callAttemptsTable, podiumMessagesTable,
} from "@workspace/db";
import { eq, and, inArray, isNull, isNotNull, or, ne, sql } from "drizzle-orm";
import { emitLeadUpdated } from "../socket";
import { syncPodiumConversationAssignment } from "./integrations/podium-api";

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const timerScheduledAt = new Map<number, { scheduledAt: number; delayMs: number }>();

const CLAIM_TTL_MS = 5 * 60 * 1000;

interface LeadClaim {
  csrId: number;
  claimedAt: number;
  remainingAutoPassMs: number | null;
}

const claims = new Map<number, LeadClaim>();

const claimExpiry = new Map<number, ReturnType<typeof setTimeout>>();

export function claimLead(leadId: number, csrId: number): { ok: boolean; error?: string } {
  const existing = claims.get(leadId);
  if (existing) {
    if (existing.csrId === csrId && Date.now() - existing.claimedAt < CLAIM_TTL_MS) {
      existing.claimedAt = Date.now();
      const oldExpiry = claimExpiry.get(leadId);
      if (oldExpiry) clearTimeout(oldExpiry);
      const expiryTimer = setTimeout(() => {
        const claim = claims.get(leadId);
        if (claim && claim.csrId === csrId) {
          releaseClaim(leadId, csrId);
        }
      }, CLAIM_TTL_MS);
      expiryTimer.unref();
      claimExpiry.set(leadId, expiryTimer);
      return { ok: true };
    }
    if (Date.now() - existing.claimedAt < CLAIM_TTL_MS) {
      return { ok: false, error: "Lead is currently claimed by another CSR" };
    }
    claims.delete(leadId);
    const oldExpiry = claimExpiry.get(leadId);
    if (oldExpiry) { clearTimeout(oldExpiry); claimExpiry.delete(leadId); }
  }

  let remainingMs: number | null = null;
  const timerInfo = timerScheduledAt.get(leadId);
  const timer = timers.get(leadId);
  if (timer && timerInfo) {
    clearTimeout(timer);
    timers.delete(leadId);
    const elapsed = Date.now() - timerInfo.scheduledAt;
    remainingMs = Math.max(0, timerInfo.delayMs - elapsed);
    timerScheduledAt.delete(leadId);
  } else if (timer) {
    clearTimeout(timer);
    timers.delete(leadId);
    remainingMs = 60000;
  }

  claims.set(leadId, { csrId, claimedAt: Date.now(), remainingAutoPassMs: remainingMs });

  const expiryTimer = setTimeout(() => {
    const claim = claims.get(leadId);
    if (claim && claim.csrId === csrId) {
      releaseClaim(leadId, csrId);
    }
  }, CLAIM_TTL_MS);
  expiryTimer.unref();
  claimExpiry.set(leadId, expiryTimer);

  return { ok: true };
}

export function releaseClaim(leadId: number, csrId: number): void {
  const claim = claims.get(leadId);
  if (!claim || claim.csrId !== csrId) return;
  claims.delete(leadId);
  const expiry = claimExpiry.get(leadId);
  if (expiry) { clearTimeout(expiry); claimExpiry.delete(leadId); }

  if (claim.remainingAutoPassMs !== null) {
    scheduleAutoPass(leadId, claim.remainingAutoPassMs);
  }
}

export function consumeClaim(leadId: number, csrId: number): void {
  const claim = claims.get(leadId);
  if (claim && claim.csrId === csrId) {
    claims.delete(leadId);
    const expiry = claimExpiry.get(leadId);
    if (expiry) { clearTimeout(expiry); claimExpiry.delete(leadId); }
  }
}

export function hasActiveClaim(leadId: number): { claimed: boolean; csrId?: number } {
  const claim = claims.get(leadId);
  if (!claim) return { claimed: false };
  if (Date.now() - claim.claimedAt >= CLAIM_TTL_MS) {
    claims.delete(leadId);
    return { claimed: false };
  }
  return { claimed: true, csrId: claim.csrId };
}

const AUTO_PASS_STATUSES = ["day_1", "day_2", "day_3", "day_4"] as const;

type StickyConfig = {
  allowPassBack: boolean | null;
  stickyAfterCascade: boolean | null;
  stickyCsrId: number | null;
  backupStickyCsrId?: number | null;
};

/**
 * Resolves the effective sticky CSR for a given active order. If the primary
 * sticky CSR is in the active order, it wins. Otherwise, if a backup sticky
 * CSR is configured and is in the active order, the backup is used. Returns
 * null when neither is available (i.e. the sticky redirect is disabled).
 */
export function resolveActiveStickyCsrId(config: StickyConfig, activeOrder: number[]): number | null {
  if (config.stickyCsrId && activeOrder.includes(config.stickyCsrId)) return config.stickyCsrId;
  if (config.backupStickyCsrId && activeOrder.includes(config.backupStickyCsrId)) return config.backupStickyCsrId;
  return null;
}

export function isStickyActiveInOrder(config: StickyConfig, activeOrder: number[]): boolean {
  return resolveActiveStickyCsrId(config, activeOrder) !== null;
}

export function isStickyTerminalAtRest(
  config: StickyConfig,
  assignedCsrId: number,
  cascadePassCount: number,
  activeOrder: number[],
): boolean {
  if (!config.allowPassBack || !config.stickyAfterCascade || !config.stickyCsrId) return false;
  const effectiveStickyId = resolveActiveStickyCsrId(config, activeOrder);
  if (effectiveStickyId === null) return false;
  if (assignedCsrId !== effectiveStickyId) return false;
  return cascadePassCount >= activeOrder.length - 1;
}

export function isStickyTerminalOnTransition(
  config: StickyConfig,
  nextCsrId: number,
  newPassCount: number,
  priorPassCount: number,
  activeOrder: number[],
): { terminal: boolean; reason: 'end_of_cycle' | 'rotation_arrival' | null } {
  if (!config.allowPassBack || !config.stickyAfterCascade || !config.stickyCsrId) return { terminal: false, reason: null };
  const effectiveStickyId = resolveActiveStickyCsrId(config, activeOrder);
  if (effectiveStickyId === null) return { terminal: false, reason: null };
  if (nextCsrId !== effectiveStickyId) return { terminal: false, reason: null };
  if (newPassCount >= activeOrder.length - 1) return { terminal: true, reason: 'end_of_cycle' };
  if (priorPassCount > 0) return { terminal: true, reason: 'rotation_arrival' };
  return { terminal: false, reason: null };
}

export interface PickNextCsrInput {
  config: StickyConfig;
  assignedCsrId: number;
  cascadePassCount: number;
  activeOrder: number[];
}

export type PickNextCsrResult =
  | { action: 'pass'; nextCsrId: number; viaSticky: boolean; rotationLandedOnSticky: boolean }
  | { action: 'terminal_at_sticky' }
  | { action: 'no_next' };

export function pickNextCsrForCascade(input: PickNextCsrInput): PickNextCsrResult {
  const { config, assignedCsrId, cascadePassCount, activeOrder } = input;
  const currentIdx = activeOrder.indexOf(assignedCsrId);
  const effectiveStickyId = resolveActiveStickyCsrId(config, activeOrder);

  if (config.allowPassBack) {
    if (isStickyTerminalAtRest(config, assignedCsrId, cascadePassCount, activeOrder)) {
      return { action: 'terminal_at_sticky' };
    }

    let nextCsrId: number;
    let viaSticky = false;
    if (config.stickyAfterCascade && config.stickyCsrId && effectiveStickyId !== null
        && cascadePassCount >= activeOrder.length - 1) {
      nextCsrId = effectiveStickyId;
      viaSticky = true;
    } else if (currentIdx === -1) {
      nextCsrId = activeOrder[0];
    } else {
      nextCsrId = activeOrder[(currentIdx + 1) % activeOrder.length];
    }

    const rotationLandedOnSticky = !!(
      !viaSticky
      && config.stickyAfterCascade
      && config.stickyCsrId
      && effectiveStickyId !== null
      && nextCsrId === effectiveStickyId
      && cascadePassCount > 0
      && cascadePassCount < activeOrder.length - 1
    );

    return { action: 'pass', nextCsrId, viaSticky, rotationLandedOnSticky };
  }

  if (currentIdx === -1) {
    return { action: 'pass', nextCsrId: activeOrder[0], viaSticky: false, rotationLandedOnSticky: false };
  }
  if (currentIdx < activeOrder.length - 1) {
    return { action: 'pass', nextCsrId: activeOrder[currentIdx + 1], viaSticky: false, rotationLandedOnSticky: false };
  }
  return { action: 'no_next' };
}

export function scheduleAutoPass(leadId: number, delayMs: number): void {
  cancelAutoPass(leadId);
  if (delayMs < 0) delayMs = 0;
  const timer = setTimeout(() => {
    timers.delete(leadId);
    timerScheduledAt.delete(leadId);
    fireAutoPass(leadId).catch(err => {
      console.error(`[auto-pass] Error firing auto-pass for lead ${leadId}:`, err);
    });
  }, delayMs);
  timer.unref();
  timers.set(leadId, timer);
  timerScheduledAt.set(leadId, { scheduledAt: Date.now(), delayMs });
}

export function cancelAutoPass(leadId: number): void {
  const existing = timers.get(leadId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(leadId);
    timerScheduledAt.delete(leadId);
  }
}

export function getActiveTimerCount(): number {
  return timers.size;
}

async function getActiveOrderForConfig(config: typeof routingConfigTable.$inferSelect): Promise<{ order: number[]; userMap: Map<number, string> }> {
  const cascadeOrder = (config.cascadeOrder as number[]) || [];
  if (cascadeOrder.length === 0) return { order: [], userMap: new Map() };

  const now = new Date();
  const pausedSchedules = await db.select().from(csrScheduleTable)
    .where(and(eq(csrScheduleTable.tenantId, config.tenantId), eq(csrScheduleTable.isPaused, true)));
  const activePaused = pausedSchedules.filter(s => !s.pauseEnd || new Date(s.pauseEnd) > now);
  const pausedIds = new Set(activePaused.map(s => s.userId));
  const intentionalPausedIds = new Set(activePaused.filter(s => s.pauseSource === "manager" || s.pauseSource === "self").map(s => s.userId));

  let unpausedOrder = cascadeOrder.filter(id => !pausedIds.has(id));
  if (unpausedOrder.length === 0) {
    const autoPausedFallback = cascadeOrder.filter(id => !intentionalPausedIds.has(id));
    if (autoPausedFallback.length > 0) {
      console.log(`[auto-pass] Tenant ${config.tenantId}: All CSRs paused — falling back to auto-paused (disconnected) CSRs`);
      unpausedOrder = [...autoPausedFallback];
    } else {
      console.log(`[auto-pass] Tenant ${config.tenantId}: All CSRs intentionally paused — no fallback`);
    }
  }

  const activeUsers = await db.select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(and(
      eq(usersTable.tenantId, config.tenantId),
      eq(usersTable.isActive, true),
      inArray(usersTable.id, unpausedOrder),
    ));
  const userMap = new Map(activeUsers.map(u => [u.id, u.name]));

  const invalidIds = unpausedOrder.filter(id => !userMap.has(id));
  if (invalidIds.length > 0) {
    console.warn(`[auto-pass] Tenant ${config.tenantId}: cascade_order contains invalid/inactive user IDs: [${invalidIds.join(", ")}]`);
  }

  const order = unpausedOrder.filter(id => userMap.has(id));
  return { order, userMap };
}

async function findConfigForLead(lead: { tenantId: number; funnelId: number | null }): Promise<typeof routingConfigTable.$inferSelect | null> {
  if (lead.funnelId) {
    const [specific] = await db.select().from(routingConfigTable)
      .where(and(
        eq(routingConfigTable.tenantId, lead.tenantId),
        eq(routingConfigTable.isActive, true),
        eq(routingConfigTable.funnelTypeId, lead.funnelId),
      ));
    if (specific) return specific;
  }

  const [fallback] = await db.select().from(routingConfigTable)
    .where(and(
      eq(routingConfigTable.tenantId, lead.tenantId),
      eq(routingConfigTable.isActive, true),
      isNull(routingConfigTable.funnelTypeId),
    ));
  return fallback || null;
}

export async function leadHasRealTouch(leadId: number): Promise<boolean> {
  const [callResult] = await db.select({ id: callAttemptsTable.id })
    .from(callAttemptsTable)
    .where(and(
      eq(callAttemptsTable.leadId, leadId),
      ne(callAttemptsTable.actionType, "transfer"),
      ne(callAttemptsTable.actionType, "system"),
    ))
    .limit(1);
  if (callResult) return true;

  const [podiumResult] = await db.select({ id: podiumMessagesTable.id })
    .from(podiumMessagesTable)
    .where(and(
      eq(podiumMessagesTable.leadId, leadId),
      eq(podiumMessagesTable.direction, "outbound"),
    ))
    .limit(1);
  return !!podiumResult;
}

async function fireAutoPass(leadId: number): Promise<void> {
  const [lead] = await db.select({
    id: leadsTable.id,
    tenantId: leadsTable.tenantId,
    assignedCsrId: leadsTable.assignedCsrId,
    hubStatus: leadsTable.hubStatus,
    funnelId: leadsTable.funnelId,
    cascadePassCount: leadsTable.cascadePassCount,
    manuallyTransferred: leadsTable.manuallyTransferred,
  }).from(leadsTable).where(eq(leadsTable.id, leadId));

  if (!lead || !lead.assignedCsrId) return;
  if (lead.manuallyTransferred) {
    console.log(`[auto-pass] Lead ${leadId}: manually transferred, skipping auto-pass`);
    return;
  }
  if (!(AUTO_PASS_STATUSES as readonly string[]).includes(lead.hubStatus)) return;

  const claimInfo = hasActiveClaim(leadId);
  if (claimInfo.claimed) {
    console.log(`[auto-pass] Lead ${leadId}: active claim by CSR ${claimInfo.csrId}, deferring auto-pass`);
    scheduleAutoPass(leadId, CLAIM_TTL_MS);
    return;
  }

  const touched = await leadHasRealTouch(leadId);
  if (touched) {
    console.log(`[auto-pass] Lead ${leadId}: has real call attempts, skipping auto-pass`);
    return;
  }

  const config = await findConfigForLead(lead);
  if (!config) return;

  const { order: activeOrder, userMap } = await getActiveOrderForConfig(config);

  if (activeOrder.length === 0) {
    const passMinutes = config.passIntervalMinutes ?? 1440;
    await db.update(leadsTable)
      .set({ updatedAt: new Date() })
      .where(eq(leadsTable.id, leadId));
    console.warn(`[auto-pass] Lead ${leadId}: no active CSRs in cascade, retrying in ${passMinutes}m`);
    scheduleAutoPass(leadId, passMinutes * 60 * 1000);
    return;
  }

  if (activeOrder.length === 1) {
    const passMinutes = config.passIntervalMinutes ?? 1440;
    await db.update(leadsTable)
      .set({ updatedAt: new Date() })
      .where(eq(leadsTable.id, leadId));
    console.warn(`[auto-pass] Lead ${leadId}: single-CSR cascade (tenant ${lead.tenantId}), no next CSR available`);
    scheduleAutoPass(leadId, passMinutes * 60 * 1000);
    return;
  }

  const cascadePassCount = lead.cascadePassCount ?? 0;
  const decision = pickNextCsrForCascade({
    config,
    assignedCsrId: lead.assignedCsrId,
    cascadePassCount,
    activeOrder,
  });

  const effectiveStickyForLog = resolveActiveStickyCsrId(config, activeOrder);
  const stickyLabelForLog = effectiveStickyForLog !== null && effectiveStickyForLog === config.backupStickyCsrId
    ? `backup sticky CSR ${effectiveStickyForLog}`
    : `sticky CSR ${effectiveStickyForLog ?? config.stickyCsrId}`;

  if (decision.action === 'terminal_at_sticky') {
    console.log(`[auto-pass] Lead ${leadId}: at ${stickyLabelForLog} after full cycle (terminal) — no further passes`);
    return;
  }
  if (decision.action === 'no_next') {
    return;
  }

  const nextCsrId = decision.nextCsrId;

  if (decision.viaSticky) {
    console.log(`[auto-pass] Lead ${leadId}: end-of-cycle redirect to ${stickyLabelForLog}`);
  }
  if (decision.rotationLandedOnSticky) {
    console.log(`[auto-pass] Lead ${leadId}: rotation reached ${stickyLabelForLog} — sticking`);
  }

  let resolvedName = userMap.get(nextCsrId);
  if (!resolvedName) {
    const [nextUser] = await db.select({ name: usersTable.name, isActive: usersTable.isActive })
      .from(usersTable)
      .where(and(eq(usersTable.id, nextCsrId), eq(usersTable.tenantId, lead.tenantId)));
    if (!nextUser || !nextUser.isActive) {
      const passMinutes = config.passIntervalMinutes ?? 1440;
      console.warn(`[auto-pass] Lead ${leadId}: target CSR ${nextCsrId} is inactive/missing, retrying in ${passMinutes}m`);
      scheduleAutoPass(leadId, passMinutes * 60 * 1000);
      return;
    }
    resolvedName = nextUser.name;
  }
  if (!resolvedName) return;

  let newPassCount = (config.allowPassBack && config.stickyAfterCascade)
    ? (lead.cascadePassCount ?? 0) + 1
    : (lead.cascadePassCount ?? 0);

  const stickyResult = isStickyTerminalOnTransition(config, nextCsrId, newPassCount, lead.cascadePassCount ?? 0, activeOrder);

  if (stickyResult.terminal && stickyResult.reason === 'rotation_arrival') {
    newPassCount = Math.max(newPassCount, activeOrder.length - 1);
  }

  const [updated] = await db.update(leadsTable)
    .set({
      assignedCsrId: nextCsrId,
      assignedTo: resolvedName,
      assignedAt: new Date(),
      updatedAt: new Date(),
      cascadePassCount: newPassCount,
    })
    .where(eq(leadsTable.id, leadId))
    .returning();

  const passMinutes = config.passIntervalMinutes ?? 1440;
  const passLabel = passMinutes >= 60 ? `${Math.round(passMinutes / 60)}h` : `${passMinutes}m`;

  await db.insert(callAttemptsTable).values({
    leadId,
    userId: nextCsrId,
    method: "transfer",
    outcome: "auto_passed",
    platform: "native",
    actionType: "transfer",
    notes: `Auto-passed after ${passLabel} inactivity`,
  });

  console.log(`[auto-pass] Lead ${leadId}: passed to ${resolvedName} (CSR ${nextCsrId})`);

  syncPodiumConversationAssignment(leadId, nextCsrId).catch(() => {});

  if (updated) {
    emitLeadUpdated(lead.tenantId, updated as unknown as Record<string, unknown>);
  }

  if (stickyResult.terminal) {
    console.log(`[auto-pass] Lead ${leadId}: arrived at sticky CSR ${nextCsrId} (terminal:${stickyResult.reason}) — no further timers`);
  } else {
    const canPassAgain = config.allowPassBack ||
      (activeOrder.indexOf(nextCsrId) < activeOrder.length - 1);
    if (canPassAgain) {
      scheduleAutoPass(leadId, passMinutes * 60 * 1000);
    }
  }
}

export async function recoverTimers(): Promise<number> {
  console.log("[auto-pass] Recovering per-lead timers...");

  const configs = await db.select().from(routingConfigTable)
    .where(eq(routingConfigTable.isActive, true));

  if (configs.length === 0) {
    console.log("[auto-pass] No active routing configs found");
    return 0;
  }

  const funnelSpecificIds = new Map<number, Set<number>>();
  for (const c of configs) {
    if (c.funnelTypeId !== null) {
      if (!funnelSpecificIds.has(c.tenantId)) funnelSpecificIds.set(c.tenantId, new Set());
      funnelSpecificIds.get(c.tenantId)!.add(c.funnelTypeId);
    }
  }

  let scheduled = 0;

  for (const config of configs) {
    const passMinutes = config.passIntervalMinutes ?? 1440;
    const passMs = passMinutes * 60 * 1000;

    const leadConditions = [
      eq(leadsTable.tenantId, config.tenantId),
      inArray(leadsTable.hubStatus, AUTO_PASS_STATUSES),
      isNotNull(leadsTable.assignedCsrId),
      eq(leadsTable.manuallyTransferred, false),
    ];

    if (config.funnelTypeId !== null) {
      leadConditions.push(eq(leadsTable.funnelId, config.funnelTypeId));
    } else {
      const specificFunnels = funnelSpecificIds.get(config.tenantId);
      if (specificFunnels && specificFunnels.size > 0) {
        const excludedFunnelIds = Array.from(specificFunnels);
        leadConditions.push(
          or(
            isNull(leadsTable.funnelId),
            and(...excludedFunnelIds.map(fid => ne(leadsTable.funnelId, fid)))
          )!
        );
      }
    }

    const noRealAttempts = sql`NOT EXISTS (SELECT 1 FROM call_attempts WHERE call_attempts.lead_id = ${leadsTable.id} AND call_attempts.action_type NOT IN ('transfer', 'system'))`;
    leadConditions.push(noRealAttempts);

    const noPodiumOutbound = sql`NOT EXISTS (SELECT 1 FROM podium_messages WHERE podium_messages.lead_id = ${leadsTable.id} AND podium_messages.direction = 'outbound')`;
    leadConditions.push(noPodiumOutbound);

    const leads = await db.select({
      id: leadsTable.id,
      assignedAt: leadsTable.assignedAt,
      visibleAfter: leadsTable.visibleAfter,
      assignedCsrId: leadsTable.assignedCsrId,
      cascadePassCount: leadsTable.cascadePassCount,
    }).from(leadsTable)
      .where(and(...leadConditions));

    const { order: activeRecoverOrder } = await getActiveOrderForConfig(config);

    const RECOVERY_STAGGER_MS = parseInt(process.env.AUTOPASS_RECOVERY_STAGGER_MS || "5000", 10);
    const MAX_STALENESS_FACTOR = parseFloat(process.env.AUTOPASS_MAX_STALENESS_FACTOR || "2");
    let staggerIndex = 0;

    for (const lead of leads) {
      if (timers.has(lead.id)) continue;

      if (activeRecoverOrder.length >= 2
          && isStickyTerminalAtRest(config, lead.assignedCsrId!, lead.cascadePassCount ?? 0, activeRecoverOrder)) {
        continue;
      }

      const assignedMs = new Date(lead.assignedAt).getTime();
      const visibleMs = lead.visibleAfter ? new Date(lead.visibleAfter).getTime() : 0;
      const baseTime = Math.max(assignedMs, visibleMs);
      const elapsed = Date.now() - baseTime;
      const remaining = passMs - elapsed;

      if (remaining <= 0) {
        const overdueMs = Math.abs(remaining);
        const stalenessThreshold = passMs * MAX_STALENESS_FACTOR;

        const expiryTime = new Date(baseTime + passMs).toISOString();

        if (overdueMs > stalenessThreshold) {
          console.warn(`[auto-pass][recovery] Lead ${lead.id}: timer expired at ${expiryTime} (${Math.round(overdueMs / 60000)}m ago, threshold ${Math.round(stalenessThreshold / 60000)}m) — too stale, skipping`);
          continue;
        }

        const staggerDelay = RECOVERY_STAGGER_MS * staggerIndex;
        staggerIndex++;
        console.log(`[auto-pass][recovery] Lead ${lead.id}: timer expired at ${expiryTime} (${Math.round(overdueMs / 1000)}s ago), scheduling with ${Math.round(staggerDelay / 1000)}s stagger`);
        scheduleAutoPass(lead.id, staggerDelay);
      } else {
        scheduleAutoPass(lead.id, remaining);
      }
      scheduled++;
    }
  }

  console.log(`[auto-pass] Recovered ${scheduled} timer(s) across ${configs.length} config(s)`);
  return scheduled;
}

export interface StrandedRerouteInput {
  config: { stickyAfterCascade: boolean | null; stickyCsrId: number | null; backupStickyCsrId?: number | null };
  stickyPauseSchedule: { isPaused: boolean; pauseEnd: Date | null } | null;
  activeOrder: number[];
  now: Date;
}

export type StrandedRerouteDecision =
  | { shouldReroute: false; reason: 'no_sticky_config' | 'sticky_not_paused' | 'pause_expired' | 'no_active_csrs' | 'sticky_still_in_active_order' }
  | { shouldReroute: true; targetCsrId: number; viaBackup: boolean };

export function evaluateStrandedRerouteEligibility(input: StrandedRerouteInput): StrandedRerouteDecision {
  const { config, stickyPauseSchedule, activeOrder, now } = input;
  if (!config.stickyAfterCascade || !config.stickyCsrId) {
    return { shouldReroute: false, reason: 'no_sticky_config' };
  }
  if (!stickyPauseSchedule || !stickyPauseSchedule.isPaused) {
    return { shouldReroute: false, reason: 'sticky_not_paused' };
  }
  if (stickyPauseSchedule.pauseEnd && stickyPauseSchedule.pauseEnd <= now) {
    return { shouldReroute: false, reason: 'pause_expired' };
  }
  if (activeOrder.length === 0) {
    return { shouldReroute: false, reason: 'no_active_csrs' };
  }
  if (activeOrder.includes(config.stickyCsrId)) {
    return { shouldReroute: false, reason: 'sticky_still_in_active_order' };
  }
  if (config.backupStickyCsrId
      && config.backupStickyCsrId !== config.stickyCsrId
      && activeOrder.includes(config.backupStickyCsrId)) {
    return { shouldReroute: true, targetCsrId: config.backupStickyCsrId, viaBackup: true };
  }
  return { shouldReroute: true, targetCsrId: activeOrder[0], viaBackup: false };
}

export async function rerouteLeadsStrandedOnPausedStickyCsr(): Promise<number> {
  const configs = await db.select().from(routingConfigTable)
    .where(and(
      eq(routingConfigTable.isActive, true),
      eq(routingConfigTable.stickyAfterCascade, true),
      isNotNull(routingConfigTable.stickyCsrId),
    ));

  if (configs.length === 0) return 0;

  const now = new Date();
  let totalRerouted = 0;

  for (const config of configs) {
    if (!config.stickyCsrId) continue;

    const [stickySched] = await db.select().from(csrScheduleTable)
      .where(and(
        eq(csrScheduleTable.tenantId, config.tenantId),
        eq(csrScheduleTable.userId, config.stickyCsrId),
        eq(csrScheduleTable.isPaused, true),
      ));

    const { order: activeOrder, userMap } = await getActiveOrderForConfig(config);

    const decision = evaluateStrandedRerouteEligibility({
      config,
      stickyPauseSchedule: stickySched
        ? { isPaused: stickySched.isPaused, pauseEnd: stickySched.pauseEnd }
        : null,
      activeOrder,
      now,
    });

    if (!decision.shouldReroute) {
      if (decision.reason === 'no_active_csrs') {
        console.warn(`[auto-pass][reroute] Tenant ${config.tenantId}: paused sticky CSR ${config.stickyCsrId} but no active CSRs available for reroute`);
      }
      continue;
    }

    const targetCsrId = decision.targetCsrId;

    const leadConditions = [
      eq(leadsTable.tenantId, config.tenantId),
      eq(leadsTable.assignedCsrId, config.stickyCsrId),
      inArray(leadsTable.hubStatus, AUTO_PASS_STATUSES),
      eq(leadsTable.manuallyTransferred, false),
    ];
    if (config.funnelTypeId !== null) {
      leadConditions.push(eq(leadsTable.funnelId, config.funnelTypeId));
    }

    const stranded = await db.select({
      id: leadsTable.id,
      tenantId: leadsTable.tenantId,
    }).from(leadsTable).where(and(...leadConditions));

    if (stranded.length === 0) continue;

    const targetName = userMap.get(targetCsrId);
    if (!targetName) continue;

    for (const lead of stranded) {
      const [updated] = await db.update(leadsTable)
        .set({
          assignedCsrId: targetCsrId,
          assignedTo: targetName,
          assignedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(leadsTable.id, lead.id))
        .returning();

      await db.insert(callAttemptsTable).values({
        leadId: lead.id,
        userId: targetCsrId,
        method: "transfer",
        outcome: "auto_passed",
        platform: "native",
        actionType: "transfer",
        notes: "Re-routed: previous CSR is paused",
      });

      if (updated) {
        emitLeadUpdated(lead.tenantId, updated as unknown as Record<string, unknown>);
      }

      const passMinutes = config.passIntervalMinutes ?? 1440;
      scheduleAutoPass(lead.id, passMinutes * 60 * 1000);
      totalRerouted++;
      const targetLabel = decision.viaBackup ? `backup sticky CSR` : `next-active CSR`;
      console.log(`[auto-pass][reroute] Lead ${lead.id}: re-routed from paused sticky CSR ${config.stickyCsrId} to ${targetLabel} ${targetName} (CSR ${targetCsrId})`);
    }
  }

  if (totalRerouted > 0) {
    console.log(`[auto-pass][reroute] Re-routed ${totalRerouted} lead(s) stranded on paused sticky CSRs`);
  }
  return totalRerouted;
}
