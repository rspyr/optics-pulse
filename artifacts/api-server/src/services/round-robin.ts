import { db, leadsTable, usersTable, routingConfigTable, csrScheduleTable } from "@workspace/db";
import { eq, and, isNull, isNotNull, gte, count } from "drizzle-orm";

export interface RoundRobinResult {
  assignedCsrId: number | null;
  csrName: string | null;
  reason?: string;
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
    const { inArray } = await import("drizzle-orm");
    const clientCsrs = await db.select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(and(
        eq(usersTable.tenantId, tenantId),
        eq(usersTable.isActive, true),
        inArray(usersTable.role, ["client_user", "client_admin"]),
      ))
      .orderBy(usersTable.id);
    if (clientCsrs.length === 0) {
      return { assignedCsrId: null, csrName: null, reason: "No routing config and no active CSRs" };
    }

    const recentCount = await db.select({
      assignedCsrId: leadsTable.assignedCsrId,
      count: count(),
    }).from(leadsTable)
      .where(and(eq(leadsTable.tenantId, tenantId), isNotNull(leadsTable.assignedCsrId)))
      .groupBy(leadsTable.assignedCsrId);
    const countMap: Record<number, number> = {};
    for (const r of recentCount) {
      if (r.assignedCsrId) countMap[r.assignedCsrId] = r.count;
    }
    let bestCsr = clientCsrs[0];
    let bestCount = countMap[clientCsrs[0].id] || 0;
    for (const csr of clientCsrs) {
      const c = countMap[csr.id] || 0;
      if (c < bestCount) { bestCount = c; bestCsr = csr; }
    }

    await db.update(leadsTable)
      .set({ assignedCsrId: bestCsr.id, assignedTo: bestCsr.name, updatedAt: new Date() })
      .where(eq(leadsTable.id, leadId));

    console.warn(`[RoundRobin] No routing config for tenant ${tenantId}; fallback assigned lead ${leadId} to ${bestCsr.name}`);
    return { assignedCsrId: bestCsr.id, csrName: bestCsr.name, reason: "Fallback (no routing config)" };
  }

  const now = new Date();
  const pausedSchedules = await db.select().from(csrScheduleTable)
    .where(and(eq(csrScheduleTable.tenantId, tenantId), eq(csrScheduleTable.isPaused, true)));
  const pausedUserIds = new Set(
    pausedSchedules
      .filter(s => !s.pauseEnd || new Date(s.pauseEnd) > now)
      .map(s => s.userId)
  );

  const order = (config.cascadeOrder as number[]).filter(id => !pausedUserIds.has(id));
  if (order.length === 0) {
    return { assignedCsrId: null, csrName: null, reason: "All CSRs are paused" };
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

  const [user] = await db.select({ name: usersTable.name, isActive: usersTable.isActive })
    .from(usersTable)
    .where(and(eq(usersTable.id, selectedCsrId), eq(usersTable.tenantId, tenantId)));
  if (!user || !user.isActive) {
    return { assignedCsrId: null, csrName: null, reason: "Selected CSR not found or inactive in this tenant" };
  }

  const [updated] = await db.update(leadsTable)
    .set({ assignedCsrId: selectedCsrId, assignedTo: user.name, updatedAt: new Date(), cascadePassCount: 0 })
    .where(eq(leadsTable.id, leadId))
    .returning();

  return { assignedCsrId: selectedCsrId, csrName: user.name };
}
