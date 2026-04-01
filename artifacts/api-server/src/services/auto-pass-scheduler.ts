import {
  db, leadsTable, usersTable, routingConfigTable, csrScheduleTable, callAttemptsTable,
} from "@workspace/db";
import { eq, and, inArray, isNull, isNotNull, or, ne } from "drizzle-orm";
import { emitLeadUpdated } from "../socket";

const timers = new Map<number, ReturnType<typeof setTimeout>>();

const AUTO_PASS_STATUSES = ["day_1", "day_2", "day_3", "day_4"];

export function scheduleAutoPass(leadId: number, delayMs: number): void {
  cancelAutoPass(leadId);
  if (delayMs < 0) delayMs = 0;
  const timer = setTimeout(() => {
    timers.delete(leadId);
    fireAutoPass(leadId).catch(err => {
      console.error(`[auto-pass] Error firing auto-pass for lead ${leadId}:`, err);
    });
  }, delayMs);
  timer.unref();
  timers.set(leadId, timer);
}

export function cancelAutoPass(leadId: number): void {
  const existing = timers.get(leadId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(leadId);
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
  const pausedIds = new Set(
    pausedSchedules.filter(s => !s.pauseEnd || new Date(s.pauseEnd) > now).map(s => s.userId)
  );

  const unpausedOrder = cascadeOrder.filter(id => !pausedIds.has(id));
  if (unpausedOrder.length === 0) return { order: [], userMap: new Map() };

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

async function fireAutoPass(leadId: number): Promise<void> {
  const [lead] = await db.select({
    id: leadsTable.id,
    tenantId: leadsTable.tenantId,
    assignedCsrId: leadsTable.assignedCsrId,
    hubStatus: leadsTable.hubStatus,
    funnelId: leadsTable.funnelId,
    cascadePassCount: leadsTable.cascadePassCount,
  }).from(leadsTable).where(eq(leadsTable.id, leadId));

  if (!lead || !lead.assignedCsrId) return;
  if (!AUTO_PASS_STATUSES.includes(lead.hubStatus)) return;

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

  const currentIdx = activeOrder.indexOf(lead.assignedCsrId);
  let nextCsrId: number;

  if (config.allowPassBack) {
    if (config.stickyAfterCascade && config.stickyCsrId && (lead.cascadePassCount ?? 0) >= activeOrder.length - 1) {
      if (config.stickyCsrId === lead.assignedCsrId) {
        console.log(`[auto-pass] Lead ${leadId}: at sticky CSR ${config.stickyCsrId} (terminal) — no further passes`);
        return;
      }
      nextCsrId = config.stickyCsrId;
    } else {
      if (currentIdx === -1) {
        nextCsrId = activeOrder[0];
      } else {
        nextCsrId = activeOrder[(currentIdx + 1) % activeOrder.length];
      }
    }
  } else {
    if (currentIdx === -1) {
      nextCsrId = activeOrder[0];
    } else if (currentIdx < activeOrder.length - 1) {
      nextCsrId = activeOrder[currentIdx + 1];
    } else {
      return;
    }
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

  const newPassCount = (config.allowPassBack && config.stickyAfterCascade)
    ? (lead.cascadePassCount ?? 0) + 1
    : (lead.cascadePassCount ?? 0);

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

  if (updated) {
    emitLeadUpdated(lead.tenantId, updated as unknown as Record<string, unknown>);
  }

  const isStickyTerminal = config.allowPassBack
    && config.stickyAfterCascade && config.stickyCsrId
    && config.stickyCsrId === nextCsrId
    && newPassCount >= activeOrder.length - 1;

  if (isStickyTerminal) {
    console.log(`[auto-pass] Lead ${leadId}: arrived at sticky CSR ${nextCsrId} (terminal) — no further timers`);
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

    const leads = await db.select({
      id: leadsTable.id,
      assignedAt: leadsTable.assignedAt,
      assignedCsrId: leadsTable.assignedCsrId,
      cascadePassCount: leadsTable.cascadePassCount,
    }).from(leadsTable)
      .where(and(...leadConditions));

    const { order: activeRecoverOrder } = await getActiveOrderForConfig(config);

    for (const lead of leads) {
      if (timers.has(lead.id)) continue;

      if (activeRecoverOrder.length >= 2
          && config.allowPassBack && config.stickyAfterCascade && config.stickyCsrId
          && (lead.cascadePassCount ?? 0) >= activeRecoverOrder.length - 1
          && config.stickyCsrId === lead.assignedCsrId) {
        continue;
      }

      const elapsed = Date.now() - new Date(lead.assignedAt).getTime();
      const remaining = passMs - elapsed;
      scheduleAutoPass(lead.id, remaining);
      scheduled++;
    }
  }

  console.log(`[auto-pass] Recovered ${scheduled} timer(s) across ${configs.length} config(s)`);
  return scheduled;
}
