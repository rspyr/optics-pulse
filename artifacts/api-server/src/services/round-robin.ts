import { db, leadsTable, usersTable, routingConfigTable, csrScheduleTable } from "@workspace/db";
import { eq, and, isNull, isNotNull, gte, count, inArray } from "drizzle-orm";

export interface RoundRobinResult {
  assignedCsrId: number | null;
  csrName: string | null;
  reason?: string;
  passIntervalMinutes?: number;
}

export async function assignLeadRoundRobin(
  tenantId: number,
  leadId: number,
  funnelTypeId?: number | null,
): Promise<RoundRobinResult> {
  const configs = await db.select().from(routingConfigTable)
    .where(and(
      eq(routingConfigTable.tenantId, tenantId),
      eq(routingConfigTable.isActive, true),
      funnelTypeId ? eq(routingConfigTable.funnelTypeId, funnelTypeId) : isNull(routingConfigTable.funnelTypeId),
    ));

  let config = configs[0];
  if (!config && funnelTypeId) {
    const fallback = await db.select().from(routingConfigTable)
      .where(and(eq(routingConfigTable.tenantId, tenantId), eq(routingConfigTable.isActive, true), isNull(routingConfigTable.funnelTypeId)));
    config = fallback[0];
  }

  if (!config || !config.cascadeOrder || (config.cascadeOrder as number[]).length === 0) {
    return { assignedCsrId: null, csrName: null, reason: "No routing config" };
  }

  const now = new Date();
  const pausedSchedules = await db.select().from(csrScheduleTable)
    .where(and(eq(csrScheduleTable.tenantId, tenantId), eq(csrScheduleTable.isPaused, true)));
  const pausedUserIds = new Set(
    pausedSchedules
      .filter(s => !s.pauseEnd || new Date(s.pauseEnd) > now)
      .map(s => s.userId)
  );

  let rawOrder = (config.cascadeOrder as number[]).filter(id => !pausedUserIds.has(id));
  if (rawOrder.length === 0) {
    console.log(`[RoundRobin] Tenant ${tenantId}: All CSRs paused — falling back to full cascade order`);
    rawOrder = config.cascadeOrder as number[];
  }

  const activeUsers = await db.select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(and(
      eq(usersTable.tenantId, tenantId),
      eq(usersTable.isActive, true),
      inArray(usersTable.id, rawOrder),
    ));
  const activeUserMap = new Map(activeUsers.map(u => [u.id, u.name]));

  const invalidIds = rawOrder.filter(id => !activeUserMap.has(id));
  if (invalidIds.length > 0) {
    console.warn(`[RoundRobin] Tenant ${tenantId}: cascade_order contains invalid/inactive user IDs: [${invalidIds.join(", ")}]`);
  }

  const order = rawOrder.filter(id => activeUserMap.has(id));
  if (order.length === 0) {
    return { assignedCsrId: null, csrName: null, reason: "All CSRs in cascade_order are inactive or missing" };
  }

  const passMinutes = config.passIntervalMinutes ?? 1440;
  const passWindow = new Date(now.getTime() - passMinutes * 60 * 1000);

  const recentAssignments = await db.select({
    assignedCsrId: leadsTable.assignedCsrId,
    count: count(),
  }).from(leadsTable)
    .where(and(
      eq(leadsTable.tenantId, tenantId),
      isNotNull(leadsTable.assignedCsrId),
      gte(leadsTable.createdAt, passWindow),
    ))
    .groupBy(leadsTable.assignedCsrId);

  const assignmentCounts: Record<number, number> = {};
  for (const r of recentAssignments) {
    if (r.assignedCsrId) assignmentCounts[r.assignedCsrId] = r.count;
  }

  let selectedCsrId = order[0];
  let minAssignments = assignmentCounts[order[0]] || 0;
  for (const csrId of order) {
    const c = assignmentCounts[csrId] || 0;
    if (c < minAssignments) {
      minAssignments = c;
      selectedCsrId = csrId;
    }
  }

  if (!config.allowPassBack) {
    const [currentLead] = await db.select({ assignedCsrId: leadsTable.assignedCsrId })
      .from(leadsTable).where(eq(leadsTable.id, leadId));
    if (currentLead?.assignedCsrId === selectedCsrId) {
      const alternates = order.filter(id => id !== selectedCsrId);
      if (alternates.length > 0) {
        let altMin = assignmentCounts[alternates[0]] || 0;
        let altSelected = alternates[0];
        for (const id of alternates) {
          const c = assignmentCounts[id] || 0;
          if (c < altMin) { altMin = c; altSelected = id; }
        }
        selectedCsrId = altSelected;
      }
    }
  }

  const csrName = activeUserMap.get(selectedCsrId)!;

  const [updated] = await db.update(leadsTable)
    .set({ assignedCsrId: selectedCsrId, assignedTo: csrName, updatedAt: new Date(), assignedAt: new Date(), cascadePassCount: 0 })
    .where(eq(leadsTable.id, leadId))
    .returning();

  return { assignedCsrId: selectedCsrId, csrName, passIntervalMinutes: passMinutes };
}
