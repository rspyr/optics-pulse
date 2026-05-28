import { Router, type IRouter } from "express";
import {
  db,
  unroutedSheetRowsTable,
  googleSheetConfigsTable,
  funnelTypesTable,
  tenantFunnelTypesTable,
  leadsTable,
  callAttemptsTable,
} from "@workspace/db";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { assertResourceTenantAccess } from "../lib/tenant-scope";
import { assignLeadRoundRobin } from "../services/round-robin";
import { scheduleAutoPass } from "../services/auto-pass-scheduler";
import { scheduleOrEmitNewLead } from "../services/lead-notify-scheduler";
import { isValidAppointmentValue } from "../utils/appointment-validation";
import { isPreBookedCellValue } from "../utils/pre-booked-trigger";
import { normalizeSource } from "../services/source-normalizer";
import { handleResubmission } from "../services/lead-resubmission";
import { emitLeadUpdated } from "../socket";

const router: IRouter = Router();

router.get(
  "/tenants/:tenantId/unrouted-sheet-rows",
  requireRole("super_admin", "agency_user", "client_admin"),
  async (req, res): Promise<void> => {
    const tenantId = parseInt(String(req.params.tenantId));
    if (Number.isNaN(tenantId)) {
      res.status(400).json({ error: "Invalid tenantId" });
      return;
    }

    const access = assertResourceTenantAccess(req, res, tenantId, {
      notFoundOnMismatch: true, notFoundMessage: "Tenant not found",
    });
    if (!access.ok) return;

    const includeResolved = String(req.query.includeResolved || "") === "true";
    const sheetConfigIdParam = req.query.sheetConfigId
      ? parseInt(String(req.query.sheetConfigId))
      : null;

    const conditions = [eq(unroutedSheetRowsTable.tenantId, tenantId)];
    if (!includeResolved) conditions.push(isNull(unroutedSheetRowsTable.resolvedAt));
    if (sheetConfigIdParam) conditions.push(eq(unroutedSheetRowsTable.sheetConfigId, sheetConfigIdParam));

    const rows = await db
      .select()
      .from(unroutedSheetRowsTable)
      .where(and(...conditions))
      .orderBy(desc(unroutedSheetRowsTable.createdAt))
      .limit(500);

    res.json(rows);
  },
);

router.get(
  "/tenants/:tenantId/unrouted-sheet-rows/counts",
  requireRole("super_admin", "agency_user", "client_admin"),
  async (req, res): Promise<void> => {
    const tenantId = parseInt(String(req.params.tenantId));
    if (Number.isNaN(tenantId)) {
      res.status(400).json({ error: "Invalid tenantId" });
      return;
    }

    const access = assertResourceTenantAccess(req, res, tenantId, {
      notFoundOnMismatch: true, notFoundMessage: "Tenant not found",
    });
    if (!access.ok) return;

    const counts = await db
      .select({
        sheetConfigId: unroutedSheetRowsTable.sheetConfigId,
        count: sql<number>`count(*)::int`,
      })
      .from(unroutedSheetRowsTable)
      .where(and(
        eq(unroutedSheetRowsTable.tenantId, tenantId),
        isNull(unroutedSheetRowsTable.resolvedAt),
      ))
      .groupBy(unroutedSheetRowsTable.sheetConfigId);

    const total = counts.reduce((sum, c) => sum + (c.count || 0), 0);
    res.json({ total, perSheet: counts });
  },
);

router.post(
  "/unrouted-sheet-rows/:id/resolve",
  requireRole("super_admin", "agency_user"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [row] = await db
      .select()
      .from(unroutedSheetRowsTable)
      .where(eq(unroutedSheetRowsTable.id, id));

    if (!row) {
      res.status(404).json({ error: "Unrouted row not found" });
      return;
    }

    const access = assertResourceTenantAccess(req, res, row.tenantId, {
      notFoundOnMismatch: true, notFoundMessage: "Unrouted row not found",
    });
    if (!access.ok) return;

    const userId = (req.session as unknown as Record<string, unknown>).userId as number | undefined;

    const [updated] = await db
      .update(unroutedSheetRowsTable)
      .set({ resolvedAt: new Date(), resolvedByUserId: userId ?? null })
      .where(eq(unroutedSheetRowsTable.id, id))
      .returning();

    res.json(updated);
  },
);

router.delete(
  "/unrouted-sheet-rows/:id",
  requireRole("super_admin", "agency_user"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [row] = await db
      .select({ tenantId: unroutedSheetRowsTable.tenantId })
      .from(unroutedSheetRowsTable)
      .where(eq(unroutedSheetRowsTable.id, id));

    if (!row) {
      res.status(404).json({ error: "Unrouted row not found" });
      return;
    }

    const access = assertResourceTenantAccess(req, res, row.tenantId, {
      notFoundOnMismatch: true, notFoundMessage: "Unrouted row not found",
    });
    if (!access.ok) return;

    await db.delete(unroutedSheetRowsTable).where(eq(unroutedSheetRowsTable.id, id));
    res.json({ success: true });
  },
);

router.post(
  "/unrouted-sheet-rows/:id/route-to-funnel",
  requireRole("super_admin", "agency_user"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const { funnelId: funnelIdRaw, addToValueMap } = req.body as {
      funnelId?: number | string;
      addToValueMap?: boolean;
    };
    const funnelId = typeof funnelIdRaw === "string" ? parseInt(funnelIdRaw) : funnelIdRaw;
    if (!funnelId || Number.isNaN(funnelId)) {
      res.status(400).json({ error: "funnelId is required" });
      return;
    }

    const [row] = await db
      .select()
      .from(unroutedSheetRowsTable)
      .where(eq(unroutedSheetRowsTable.id, id));

    if (!row) {
      res.status(404).json({ error: "Unrouted row not found" });
      return;
    }

    const access = assertResourceTenantAccess(req, res, row.tenantId, {
      notFoundOnMismatch: true, notFoundMessage: "Unrouted row not found",
    });
    if (!access.ok) return;

    if (row.resolvedAt) {
      res.status(409).json({ error: "Row has already been resolved" });
      return;
    }

    const [funnelAccess] = await db
      .select({ id: funnelTypesTable.id, name: funnelTypesTable.name, isActive: funnelTypesTable.isActive })
      .from(funnelTypesTable)
      .innerJoin(
        tenantFunnelTypesTable,
        and(
          eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id),
          eq(tenantFunnelTypesTable.tenantId, row.tenantId),
        ),
      )
      .where(eq(funnelTypesTable.id, funnelId));

    if (!funnelAccess || !funnelAccess.isActive) {
      res.status(400).json({ error: "Funnel not available for this tenant" });
      return;
    }

    const [config] = await db
      .select()
      .from(googleSheetConfigsTable)
      .where(eq(googleSheetConfigsTable.id, row.sheetConfigId));
    if (!config) {
      res.status(404).json({ error: "Sheet config not found" });
      return;
    }

    const data = (row.rowData || {}) as Record<string, string>;
    const userId = (req.session as unknown as Record<string, unknown>).userId as number | undefined;

    const normalizedPhone = (data.phone || "").replace(/[^0-9]/g, "");

    if (normalizedPhone) {
      const [dup] = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(and(
          eq(leadsTable.tenantId, row.tenantId),
          eq(leadsTable.phone, data.phone),
        ));
      if (dup) {
        try {
          await handleResubmission(row.tenantId, dup.id, "Google Sheets");
          const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, dup.id));
          if (refreshed) emitLeadUpdated(row.tenantId, refreshed as unknown as Record<string, unknown>);
        } catch (err) {
          console.warn("[UnroutedRoute] Resubmission failed for lead", dup.id, err);
        }
        await maybeUpdateValueMap(config, row, funnelId, !!addToValueMap);
        const [updated] = await db
          .update(unroutedSheetRowsTable)
          .set({ resolvedAt: new Date(), resolvedByUserId: userId ?? null })
          .where(eq(unroutedSheetRowsTable.id, id))
          .returning();
        res.json({ unroutedRow: updated, leadId: dup.id, resubmitted: true });
        return;
      }
    }

    const isPreBooked = isPreBookedCellValue(data.appointmentBooked);
    const hasApptDetails = isValidAppointmentValue(data.appointmentDate) || isValidAppointmentValue(data.appointmentTime);
    const effectivePreBooked = isPreBooked || hasApptDetails;

    const customMapping = (config.columnMapping || {}) as Record<string, string>;
    const customMappingValues = Object.values(customMapping);
    const hasApptFieldsMapped = customMappingValues.some(f => f === "appointmentDate" || f === "appointmentTime" || f === "addOns");
    const visibleAfter = hasApptFieldsMapped && !effectivePreBooked
      ? new Date(Date.now() + 3 * 60 * 1000)
      : null;

    const normalizedIntakeSource = await normalizeSource(row.tenantId, data.source || "Unknown");

    const [lead] = await db.insert(leadsTable).values({
      tenantId: row.tenantId,
      firstName: data.firstName || "Unknown",
      lastName: data.lastName || "",
      phone: data.phone || null,
      email: data.email || null,
      source: normalizedIntakeSource,
      originalSource: normalizedIntakeSource,
      serviceType: data.serviceType || null,
      notes: data.notes || null,
      address: data.address || null,
      city: data.city || null,
      state: data.state || null,
      zip: data.zip || null,
      appointmentDate: data.appointmentDate || null,
      appointmentTime: data.appointmentTime || null,
      addOns: data.addOns || null,
      visibleAfter,
      funnelId,
      leadType: funnelAccess.name || null,
      hubStatus: effectivePreBooked ? "appt_booked" : "day_1",
      dayInSequence: 1,
      status: "new",
      preBooked: effectivePreBooked,
      contactPreferences: [],
    }).returning();

    if (lead) {
      const { recordLeadStatusChange } = await import("../services/lead-status-history");
      await recordLeadStatusChange({
        leadId: lead.id,
        tenantId: row.tenantId,
        fromStatus: null,
        toStatus: lead.hubStatus,
        changedAt: lead.createdAt ?? undefined,
        reason: "unrouted_row_reroute",
      });

      try {
        const result = await assignLeadRoundRobin(row.tenantId, lead.id, funnelId);
        if (result.assignedCsrId && result.passIntervalMinutes != null) {
          const passIntervalMs = result.passIntervalMinutes * 60 * 1000;
          const visibilityDelayMs = visibleAfter ? Math.max(0, visibleAfter.getTime() - Date.now()) : 0;
          scheduleAutoPass(lead.id, passIntervalMs + visibilityDelayMs);

          await db.insert(callAttemptsTable).values({
            leadId: lead.id,
            userId: result.assignedCsrId,
            method: "system",
            outcome: "initial_assignment",
            platform: "native",
            actionType: "system",
            notes: `System: Lead initially assigned to ${result.csrName}`,
          });

          if (visibleAfter) {
            await db.insert(callAttemptsTable).values({
              leadId: lead.id,
              userId: result.assignedCsrId,
              method: "system",
              outcome: "visibility_delay",
              platform: "native",
              actionType: "system",
              notes: `System: Lead visibility delayed 3 minutes (auto-book window)`,
            });
          }
        } else if (!result.assignedCsrId) {
          console.warn(`[UnroutedRoute] Lead ${lead.id} not assigned: ${result.reason}`);
        }
      } catch (err) {
        console.warn("[UnroutedRoute] Auto-assign failed for lead", lead.id, err);
      }

      scheduleOrEmitNewLead(lead.id, (lead.visibleAfter as Date | null) ?? null);
    }

    const valueMapUpdated = await maybeUpdateValueMap(config, row, funnelId, !!addToValueMap);

    const [updated] = await db
      .update(unroutedSheetRowsTable)
      .set({ resolvedAt: new Date(), resolvedByUserId: userId ?? null })
      .where(eq(unroutedSheetRowsTable.id, id))
      .returning();

    res.json({
      unroutedRow: updated,
      leadId: lead?.id ?? null,
      valueMapUpdated,
    });
  },
);

async function maybeUpdateValueMap(
  config: typeof googleSheetConfigsTable.$inferSelect,
  row: typeof unroutedSheetRowsTable.$inferSelect,
  funnelId: number,
  addToValueMap: boolean,
): Promise<boolean> {
  if (!addToValueMap) return false;
  const funnelColumn = config.funnelColumn || row.funnelColumn;
  const unmatchedValue = (row.unmatchedValue || "").trim();
  if (!funnelColumn || !unmatchedValue) return false;

  const currentMap = (config.funnelValueMap as Record<string, number> | null) || {};
  const nextMap = { ...currentMap, [unmatchedValue]: funnelId };

  await db.update(googleSheetConfigsTable)
    .set({
      funnelColumn,
      funnelValueMap: nextMap,
      updatedAt: new Date(),
    })
    .where(eq(googleSheetConfigsTable.id, config.id));
  return true;
}

export default router;
