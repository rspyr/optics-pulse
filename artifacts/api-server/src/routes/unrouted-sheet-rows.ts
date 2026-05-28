import { Router, type IRouter } from "express";
import {
  db,
  unroutedSheetRowsTable,
  googleSheetConfigsTable,
  funnelTypesTable,
  tenantFunnelTypesTable,
  leadsTable,
  callAttemptsTable,
  usersTable,
} from "@workspace/db";
import { eq, and, isNull, desc, sql, inArray } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { assertResourceTenantAccess } from "../lib/tenant-scope";
import { assignLeadRoundRobin } from "../services/round-robin";
import { scheduleAutoPass, cancelAutoPass } from "../services/auto-pass-scheduler";
import { scheduleOrEmitNewLead } from "../services/lead-notify-scheduler";
import { isValidAppointmentValue } from "../utils/appointment-validation";
import { isPreBookedCellValue } from "../utils/pre-booked-trigger";
import { normalizeSource } from "../services/source-normalizer";
import { handleResubmission } from "../services/lead-resubmission";
import { emitLeadUpdated } from "../socket";
import { normalizePhone, normalizedPhoneSql, phoneMatchesSql } from "../lib/phone-utils";

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
      .select({
        id: unroutedSheetRowsTable.id,
        tenantId: unroutedSheetRowsTable.tenantId,
        sheetConfigId: unroutedSheetRowsTable.sheetConfigId,
        funnelColumn: unroutedSheetRowsTable.funnelColumn,
        unmatchedValue: unroutedSheetRowsTable.unmatchedValue,
        rowData: unroutedSheetRowsTable.rowData,
        reason: unroutedSheetRowsTable.reason,
        source: unroutedSheetRowsTable.source,
        createdAt: unroutedSheetRowsTable.createdAt,
        resolvedAt: unroutedSheetRowsTable.resolvedAt,
        resolvedByUserId: unroutedSheetRowsTable.resolvedByUserId,
        resolvedLeadId: unroutedSheetRowsTable.resolvedLeadId,
        resolvedByUserName: usersTable.name,
        resolvedLeadFunnelId: leadsTable.funnelId,
      })
      .from(unroutedSheetRowsTable)
      .leftJoin(usersTable, eq(usersTable.id, unroutedSheetRowsTable.resolvedByUserId))
      .leftJoin(leadsTable, eq(leadsTable.id, unroutedSheetRowsTable.resolvedLeadId))
      .where(and(...conditions))
      .orderBy(desc(unroutedSheetRowsTable.createdAt))
      .limit(500);

    // Surface a "matches existing lead" hint for unresolved rows whose phone
    // already belongs to a lead in this tenant. Phones are normalized on both
    // sides (digits-only, leading "1" stripped) via normalizePhone, so the
    // hint matches what routeRowToFunnel would do regardless of formatting
    // differences like "(555) 123-4567" vs "5551234567".
    const normalizedByRowId = new Map<number, string>();
    const normalizedPhones = new Set<string>();
    for (const r of rows) {
      if (r.resolvedAt) continue;
      const data = (r.rowData || {}) as Record<string, string>;
      const normalized = normalizePhone(data.phone || "");
      if (!normalized) continue;
      normalizedByRowId.set(r.id, normalized);
      normalizedPhones.add(normalized);
    }

    const matchByNormalizedPhone = new Map<string, number>();
    if (normalizedPhones.size > 0) {
      // Compare against the normalized form of leads.phone in SQL so this
      // also catches existing leads whose phone column was stored in a
      // legacy format (pre-backfill) or via any insert path that did not
      // normalize.
      //
      // NOTE on the IN-list shape: drizzle's `sql` tag spreads a JS array
      // passed via `${arr}` into separate bind params (`$2, $3, ...`),
      // which makes the natural-looking `= ANY(${arr})` produce invalid
      // SQL (`ANY(($2, $3))`) and 500 the request the moment any
      // unresolved row carries a phone. Build an explicit IN-list via
      // sql.join so each phone is a real positional param.
      const phonesList = Array.from(normalizedPhones);
      const matches = await db
        .select({ id: leadsTable.id, phone: leadsTable.phone })
        .from(leadsTable)
        .where(and(
          eq(leadsTable.tenantId, tenantId),
          sql`${normalizedPhoneSql(leadsTable.phone)} IN (${sql.join(phonesList.map(p => sql`${p}`), sql`, `)})`,
        ));
      for (const m of matches) {
        const key = normalizePhone(m.phone || "");
        if (key && !matchByNormalizedPhone.has(key)) matchByNormalizedPhone.set(key, m.id);
      }
    }

    const enriched = rows.map(r => {
      const normalized = normalizedByRowId.get(r.id);
      const matchedLeadId = normalized ? matchByNormalizedPhone.get(normalized) ?? null : null;
      return { ...r, existingLeadIdByPhone: matchedLeadId };
    });

    res.json(enriched);
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

type RouteResult =
  | { ok: true; rowId: number; leadId: number | null; resubmitted?: boolean; valueMapUpdated: boolean }
  | { ok: false; rowId: number; status: number; error: string };

async function routeRowToFunnel(
  rowId: number,
  funnelId: number,
  addToValueMap: boolean,
  userId: number | undefined,
  expectedTenantId: number,
): Promise<RouteResult> {
  const [row] = await db
    .select()
    .from(unroutedSheetRowsTable)
    .where(eq(unroutedSheetRowsTable.id, rowId));

  if (!row) return { ok: false, rowId, status: 404, error: "Unrouted row not found" };
  if (row.tenantId !== expectedTenantId) {
    return { ok: false, rowId, status: 404, error: "Unrouted row not found" };
  }
  if (row.resolvedAt) {
    return { ok: false, rowId, status: 409, error: "Row has already been resolved" };
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
    return { ok: false, rowId, status: 400, error: "Funnel not available for this tenant" };
  }

  const [config] = await db
    .select()
    .from(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.id, row.sheetConfigId));
  if (!config) {
    return { ok: false, rowId, status: 404, error: "Sheet config not found" };
  }

  const data = (row.rowData || {}) as Record<string, string>;
  const normalizedPhone = normalizePhone(data.phone || "");

  if (normalizedPhone) {
    const [dup] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(
        eq(leadsTable.tenantId, row.tenantId),
        phoneMatchesSql(leadsTable.phone, normalizedPhone),
      ));
    if (dup) {
      try {
        await handleResubmission(row.tenantId, dup.id, "Google Sheets");
        const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, dup.id));
        if (refreshed) emitLeadUpdated(row.tenantId, refreshed as unknown as Record<string, unknown>);
      } catch (err) {
        console.warn("[UnroutedRoute] Resubmission failed for lead", dup.id, err);
      }
      const valueMapUpdated = await maybeUpdateValueMap(config, row, funnelId, addToValueMap);
      await db
        .update(unroutedSheetRowsTable)
        .set({ resolvedAt: new Date(), resolvedByUserId: userId ?? null, resolvedLeadId: dup.id, resolvedVia: "resubmission" })
        .where(eq(unroutedSheetRowsTable.id, rowId));
      return { ok: true, rowId, leadId: dup.id, resubmitted: true, valueMapUpdated };
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
    phone: normalizedPhone || null,
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

  const valueMapUpdated = await maybeUpdateValueMap(config, row, funnelId, addToValueMap);

  await db
    .update(unroutedSheetRowsTable)
    .set({
      resolvedAt: new Date(),
      resolvedByUserId: userId ?? null,
      resolvedLeadId: lead?.id ?? null,
      resolvedVia: lead?.id ? "new_lead" : null,
    })
    .where(eq(unroutedSheetRowsTable.id, rowId));

  return { ok: true, rowId, leadId: lead?.id ?? null, valueMapUpdated };
}

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

    const userId = (req.session as unknown as Record<string, unknown>).userId as number | undefined;
    const result = await routeRowToFunnel(id, funnelId, !!addToValueMap, userId, row.tenantId);

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const [updated] = await db
      .select()
      .from(unroutedSheetRowsTable)
      .where(eq(unroutedSheetRowsTable.id, id));

    let leadInfo: { id: number; name: string; assignedTo: string | null } | null = null;
    if (result.leadId) {
      const [leadRow] = await db
        .select({
          id: leadsTable.id,
          firstName: leadsTable.firstName,
          lastName: leadsTable.lastName,
          assignedTo: leadsTable.assignedTo,
        })
        .from(leadsTable)
        .where(eq(leadsTable.id, result.leadId));
      if (leadRow) {
        leadInfo = {
          id: leadRow.id,
          name: `${leadRow.firstName || ""} ${leadRow.lastName || ""}`.trim() || "Lead",
          assignedTo: leadRow.assignedTo ?? null,
        };
      }
    }

    res.json({
      unroutedRow: updated,
      leadId: result.leadId,
      resubmitted: result.resubmitted,
      valueMapUpdated: result.valueMapUpdated,
      lead: leadInfo,
    });
  },
);

router.post(
  "/unrouted-sheet-rows/bulk-route-to-funnel",
  requireRole("super_admin", "agency_user"),
  async (req, res): Promise<void> => {
    const { rowIds: rowIdsRaw, funnelId: funnelIdRaw, addToValueMap } = req.body as {
      rowIds?: Array<number | string>;
      funnelId?: number | string;
      addToValueMap?: boolean;
    };

    const funnelId = typeof funnelIdRaw === "string" ? parseInt(funnelIdRaw) : funnelIdRaw;
    if (!funnelId || Number.isNaN(funnelId)) {
      res.status(400).json({ error: "funnelId is required" });
      return;
    }

    if (!Array.isArray(rowIdsRaw) || rowIdsRaw.length === 0) {
      res.status(400).json({ error: "rowIds must be a non-empty array" });
      return;
    }
    if (rowIdsRaw.length > 200) {
      res.status(400).json({ error: "Cannot bulk-route more than 200 rows at once" });
      return;
    }

    const rowIds = Array.from(new Set(
      rowIdsRaw
        .map(r => typeof r === "string" ? parseInt(r) : r)
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n)),
    ));
    if (rowIds.length === 0) {
      res.status(400).json({ error: "rowIds must be a non-empty array" });
      return;
    }

    const rows = await db
      .select({ id: unroutedSheetRowsTable.id, tenantId: unroutedSheetRowsTable.tenantId })
      .from(unroutedSheetRowsTable)
      .where(inArray(unroutedSheetRowsTable.id, rowIds));

    const tenantIds = new Set(rows.map(r => r.tenantId));
    if (tenantIds.size !== 1) {
      res.status(400).json({ error: "All rows must belong to the same tenant" });
      return;
    }
    const tenantId = rows[0].tenantId;

    const access = assertResourceTenantAccess(req, res, tenantId, {
      notFoundOnMismatch: true, notFoundMessage: "Unrouted row not found",
    });
    if (!access.ok) return;

    const userId = (req.session as unknown as Record<string, unknown>).userId as number | undefined;
    const knownIds = new Set(rows.map(r => r.id));
    const results: RouteResult[] = [];

    for (const rid of rowIds) {
      if (!knownIds.has(rid)) {
        results.push({ ok: false, rowId: rid, status: 404, error: "Unrouted row not found" });
        continue;
      }
      try {
        const r = await routeRowToFunnel(rid, funnelId, !!addToValueMap, userId, tenantId);
        results.push(r);
      } catch (err) {
        console.error("[UnroutedBulkRoute] Row failed", rid, err);
        results.push({ ok: false, rowId: rid, status: 500, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    const failed = results.length - succeeded;

    res.json({
      total: results.length,
      succeeded,
      failed,
      results: results.map(r =>
        r.ok
          ? { rowId: r.rowId, ok: true, leadId: r.leadId, resubmitted: r.resubmitted ?? false, valueMapUpdated: r.valueMapUpdated }
          : { rowId: r.rowId, ok: false, error: r.error }
      ),
    });
  },
);

const UNDO_WINDOW_MS = 60 * 1000;

router.post(
  "/unrouted-sheet-rows/:id/undo-route",
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

    if (!row.resolvedAt || !row.resolvedLeadId) {
      res.status(409).json({ error: "Row is not in an undoable state" });
      return;
    }

    // Source of truth for undo eligibility: only "new_lead" resolutions
    // created the lead in this routing event. "resubmission" rows point at
    // pre-existing leads whose history must not be destroyed.
    if (row.resolvedVia !== "new_lead") {
      res.status(409).json({ error: "Cannot undo a resubmission to an existing lead" });
      return;
    }

    const resolvedAtMs = new Date(row.resolvedAt).getTime();
    if (Date.now() - resolvedAtMs > UNDO_WINDOW_MS) {
      res.status(409).json({ error: "Undo window has expired" });
      return;
    }

    const leadId = row.resolvedLeadId;
    cancelAutoPass(leadId);

    const result = await db.transaction(async (tx) => {
      await tx.delete(callAttemptsTable).where(eq(callAttemptsTable.leadId, leadId));
      const deletedLeads = await tx
        .delete(leadsTable)
        .where(eq(leadsTable.id, leadId))
        .returning({ id: leadsTable.id });
      const [reopened] = await tx
        .update(unroutedSheetRowsTable)
        .set({ resolvedAt: null, resolvedByUserId: null, resolvedLeadId: null, resolvedVia: null })
        .where(eq(unroutedSheetRowsTable.id, id))
        .returning();
      return { reopened, deletedLeadId: deletedLeads[0]?.id ?? null };
    });

    res.json({ unroutedRow: result.reopened, deletedLeadId: result.deletedLeadId });
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
