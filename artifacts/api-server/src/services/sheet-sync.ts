import { db, leadsTable, googleSheetConfigsTable, funnelTypesTable, callAttemptsTable, tenantsTable, unroutedSheetRowsTable, usersTable } from "@workspace/db";
import { eq, and, isNotNull, ne, inArray, desc, sql } from "drizzle-orm";
import { readRawSheetData } from "./integrations/google-sheets";
import { emitLeadUpdated } from "../socket";
import { scheduleOrEmitNewLead } from "./lead-notify-scheduler";
import { assignLeadRoundRobin } from "./round-robin";
import { scheduleAutoPass } from "./auto-pass-scheduler";
import { isValidAppointmentValue } from "../utils/appointment-validation";
import { isPreBookedCellValue } from "../utils/pre-booked-trigger";
import { normalizeSource } from "./source-normalizer";
import { normalizePhone } from "../lib/phone-utils";
import { emitSheetDriftNotification, emitSheetSyncStalledNotification } from "./notifications";
import { createGuardedRunner } from "../lib/reentrancy-guard";
import { handleResubmission } from "./lead-resubmission";
import { createLeadWithDedupe, LEAD_INQUIRY_DEDUPE_WINDOW_MS } from "./lead-dedupe";

const DRIFT_ALERT_THRESHOLD_MS = 10 * 60 * 1000;

const UPDATABLE_FIELDS = [
  "appointmentDate", "appointmentTime", "appointmentBooked",
  "addOns", "address", "city", "state", "zip",
] as const;

/** Parse a sheet submission timestamp (e.g. the mapped `dateTime` column). */
function parseSubmissionMs(value: string | undefined | null): number | null {
  if (!value) return null;
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? t : null;
}

export interface OrderedRow {
  row: ReturnType<typeof mapRawRows>[number];
  index: number;
  ms: number | null;
}

/** True when row `a` represents a later submission than row `b`. */
export function rowIsLater(a: OrderedRow, b: OrderedRow): boolean {
  if (a.ms !== null && b.ms !== null) return a.ms !== b.ms ? a.ms > b.ms : a.index > b.index;
  if (a.ms !== null) return true;
  if (b.ms !== null) return false;
  return a.index > b.index;
}

/**
 * Collapse mapped rows to a single latest submission per normalized phone.
 * Deterministic latest-wins (by submission timestamp, tie-broken by sheet
 * order) — this is what kills the per-cycle appointment oscillation.
 */
export function buildLatestRowByPhone(rows: ReturnType<typeof mapRawRows>): Map<string, OrderedRow> {
  const latest = new Map<string, OrderedRow>();
  rows.forEach((row, index) => {
    const phone = normalizePhone(row.phone || "");
    if (!phone) return;
    const candidate: OrderedRow = { row, index, ms: parseSubmissionMs(row.dateTime) };
    const existing = latest.get(phone);
    if (!existing || rowIsLater(candidate, existing)) latest.set(phone, candidate);
  });
  return latest;
}

/** A lead's stored state, as far as the rescan write rules care about it. */
export interface RescanLeadState {
  appointmentDate: string | null;
  appointmentTime: string | null;
  /** Maps to leadsTable.preBooked. */
  appointmentBooked: boolean | null;
  addOns: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  hubStatus: string | null;
  hasSoldEstimate: boolean | null;
}

/**
 * Decide which fields (if any) a rescanned sheet row should write back onto an
 * existing lead. Pure: no DB, no clock, no side-effects — returns the set of
 * column updates (empty object means "no-op, leave the lead untouched").
 *
 * The non-obvious rules this enforces:
 *   - A CSR-confirmed appointment (`appt_set`) or a sold lead is authoritative;
 *     its appointment date/time/booked flag must NEVER be overwritten by a sheet
 *     row, even a later one with a different date.
 *   - Only changed values are written (write-only-on-real-change) so a row that
 *     already matches the lead produces no churn.
 *   - A dead lead is never promoted back to `appt_booked`.
 */
export function computeRescanUpdates(
  existingLead: RescanLeadState,
  row: ReturnType<typeof mapRawRows>[number],
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};

  const newApptDate = row.appointmentDate || null;
  const newApptTime = row.appointmentTime || null;
  const newAddOns = row.addOns || null;
  const newAddress = row.address || null;
  const newCity = row.city || null;
  const newState = row.state || null;
  const newZip = row.zip || null;
  const newApptBooked = isPreBookedCellValue(row.appointmentBooked);

  // A CSR-confirmed appointment (appt_set) or a sold lead is authoritative —
  // never let a sheet row silently overwrite its appointment.
  const apptLocked = existingLead.hubStatus === "appt_set" || existingLead.hasSoldEstimate;

  if (!apptLocked) {
    if (newApptDate && newApptDate !== existingLead.appointmentDate) updates.appointmentDate = newApptDate;
    if (newApptTime && newApptTime !== existingLead.appointmentTime) updates.appointmentTime = newApptTime;
  }
  if (newAddOns && newAddOns !== existingLead.addOns) updates.addOns = newAddOns;
  if (newAddress && newAddress !== existingLead.address) updates.address = newAddress;
  if (newCity && newCity !== existingLead.city) updates.city = newCity;
  if (newState && newState !== existingLead.state) updates.state = newState;
  if (newZip && newZip !== existingLead.zip) updates.zip = newZip;

  const hasNewApptInfo = newApptBooked || isValidAppointmentValue(newApptDate) || isValidAppointmentValue(newApptTime);
  if (hasNewApptInfo && !existingLead.appointmentBooked && !apptLocked) {
    updates.preBooked = true;
    if (existingLead.hubStatus !== "appt_set" && existingLead.hubStatus !== "dead") {
      updates.hubStatus = "appt_booked";
    }
    updates.visibleAfter = null;
  }

  return updates;
}

function headersMatch(current: string[], saved: string[]): boolean {
  if (current.length !== saved.length) return false;
  const currentSet = new Set(current);
  return saved.every(h => currentSet.has(h));
}

function resolveFunnelForRow(
  row: Record<string, string>,
  funnelColumn: string | null,
  funnelValueMap: Record<string, number> | null,
  defaultFunnelTypeId: number | null,
): number | null {
  if (funnelColumn && funnelValueMap) {
    const value = (row[funnelColumn] || "").trim();
    if (value && funnelValueMap[value] !== undefined) {
      return funnelValueMap[value];
    }
  }
  return defaultFunnelTypeId;
}

let syncing = false;

// Safety net: a sweep should finish in seconds. If one ever exceeds this
// (e.g. an unforeseen hang the per-read timeouts don't cover), force-release
// the lock so future ticks can run instead of sheet sync freezing forever.
const MAX_SWEEP_MS = 4 * 60 * 1000;
let syncWatchdog: ReturnType<typeof setTimeout> | null = null;

// Health/alerting state. Tracked PER TENANT: a tenant is "fully-failed" for a
// sweep when every one of its connected sheets threw (auth/connection/timeout)
// and none imported — the signature of a broken Google connection for that
// tenant. We count consecutive fully-failed sweeps per tenant and alert that
// tenant's operators once it crosses the threshold, so one healthy tenant can
// never mask another tenant's silent outage.
const STALL_ALERT_CYCLES = 5;
let lastSuccessfulSweepAt: number | null = null;
let lastSweepError: string | null = null;
const consecutiveFullyFailedByTenant = new Map<number, number>();

export function getSheetSyncHealth() {
  const stalledTenantIds = [...consecutiveFullyFailedByTenant.entries()]
    .filter(([, n]) => n >= STALL_ALERT_CYCLES)
    .map(([tenantId]) => tenantId);
  return {
    syncing,
    lastSuccessfulSweepAt,
    lastSweepError,
    stalledTenantIds,
    stalled: stalledTenantIds.length > 0,
  };
}

async function syncAllSheets(): Promise<void> {
  if (syncing) return;
  syncing = true;
  if (syncWatchdog) clearTimeout(syncWatchdog);
  syncWatchdog = setTimeout(() => {
    console.error(`[SheetSync] Watchdog: sweep exceeded ${MAX_SWEEP_MS}ms — force-releasing lock so future ticks can run`);
    syncing = false;
  }, MAX_SWEEP_MS);
  try {
    const trackerOnlyTenants = await db.select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.leadIngestionMode, "tracker"));
    const trackerOnlyIds = new Set(trackerOnlyTenants.map(t => t.id));

    const allConfigs = await db.select().from(googleSheetConfigsTable)
      .where(and(
        isNotNull(googleSheetConfigsTable.googleSheetId),
        isNotNull(googleSheetConfigsTable.googleSheetTab),
        isNotNull(googleSheetConfigsTable.columnMapping),
        isNotNull(googleSheetConfigsTable.mappingHeaders),
        isNotNull(googleSheetConfigsTable.syncRowWatermark),
        ne(googleSheetConfigsTable.syncPaused, true),
      ));

    const configs = allConfigs.filter(c => !trackerOnlyIds.has(c.tenantId));

    if (configs.length === 0) return;

    let totalImported = 0;
    let driftSkipped = 0;
    let errorCount = 0;
    let lastErrorMessage: string | null = null;

    // Per-tenant tallies so stall detection is scoped to each tenant's own
    // sheets — a healthy tenant must never reset a broken tenant's counter.
    type TenantTally = { sheets: number; imported: number; errors: number; lastError: string | null };
    const perTenant = new Map<number, TenantTally>();
    const tallyFor = (tenantId: number): TenantTally => {
      let t = perTenant.get(tenantId);
      if (!t) { t = { sheets: 0, imported: 0, errors: 0, lastError: null }; perTenant.set(tenantId, t); }
      return t;
    };

    for (const config of configs) {
      const tally = tallyFor(config.tenantId);
      tally.sheets++;
      try {
        const count = await syncSingleSheet(config);
        if (count === -1) driftSkipped++;
        else { totalImported += count; tally.imported += count; }
      } catch (err) {
        errorCount++;
        tally.errors++;
        lastErrorMessage = err instanceof Error ? err.message : String(err);
        tally.lastError = lastErrorMessage;
        console.error(`[SheetSync] Error syncing sheet config ${config.id} (tenant ${config.tenantId}):`, err);
      }
    }

    if (totalImported > 0 || driftSkipped > 0 || errorCount > 0) {
      console.log(`[SheetSync] Cycle complete: ${configs.length} sheet(s) checked, ${totalImported} lead(s) imported, ${driftSkipped} drift-skipped, ${errorCount} error(s)`);
    }

    // Per-tenant stall accounting: a tenant whose EVERY sheet threw and which
    // imported nothing this sweep has a (probably) broken Google connection.
    for (const [tenantId, tally] of perTenant) {
      const fullyFailed = tally.errors === tally.sheets && tally.imported === 0;
      if (fullyFailed) {
        const n = (consecutiveFullyFailedByTenant.get(tenantId) ?? 0) + 1;
        consecutiveFullyFailedByTenant.set(tenantId, n);
        lastSweepError = tally.lastError;
        console.warn(`[SheetSync] Tenant ${tenantId}: fully-failed sweep #${n} (all ${tally.sheets} sheet(s) errored). Last error: ${tally.lastError}`);
        if (n >= STALL_ALERT_CYCLES) {
          try {
            await emitSheetSyncStalledNotification({
              tenantId,
              stalledCycles: n,
              errorMessage: tally.lastError,
            });
          } catch (err) {
            console.error(`[SheetSync] Failed to emit stall notification for tenant ${tenantId}:`, err);
          }
        }
      } else {
        const prev = consecutiveFullyFailedByTenant.get(tenantId) ?? 0;
        if (prev > 0) {
          console.log(`[SheetSync] Tenant ${tenantId} recovered after ${prev} fully-failed sweep(s)`);
        }
        consecutiveFullyFailedByTenant.delete(tenantId);
      }
    }

    // Drop counters for tenants no longer in the active config set (paused or
    // removed) so the stall map can't accumulate stale entries.
    for (const tenantId of [...consecutiveFullyFailedByTenant.keys()]) {
      if (!perTenant.has(tenantId)) consecutiveFullyFailedByTenant.delete(tenantId);
    }

    if (errorCount < configs.length) {
      lastSuccessfulSweepAt = Date.now();
      if (errorCount === 0) lastSweepError = null;
    }
  } finally {
    if (syncWatchdog) {
      clearTimeout(syncWatchdog);
      syncWatchdog = null;
    }
    syncing = false;
  }
}

async function rescanExistingRows(
  config: typeof googleSheetConfigsTable.$inferSelect,
  currentHeaders: string[],
  rawRows: string[][],
  mapping: Record<string, string>,
): Promise<number> {
  const existingRows = rawRows.slice(0, config.syncRowWatermark!);
  if (existingRows.length === 0) return 0;

  const hasUpdatableMapping = Object.values(mapping).some(f => (UPDATABLE_FIELDS as readonly string[]).includes(f));
  if (!hasUpdatableMapping) return 0;

  const allMappedRows = mapRawRows(currentHeaders, existingRows, mapping);
  // Collapse duplicate-phone rows to one deterministic latest submission per
  // phone. Comparing the lead against a stable "latest" each cycle is what
  // stops the appointment date from oscillating across sync cycles.
  const latestByPhone = buildLatestRowByPhone(allMappedRows);

  const existingLeads = await db.select({
    id: leadsTable.id,
    phone: leadsTable.phone,
    appointmentDate: leadsTable.appointmentDate,
    appointmentTime: leadsTable.appointmentTime,
    appointmentBooked: leadsTable.preBooked,
    addOns: leadsTable.addOns,
    address: leadsTable.address,
    city: leadsTable.city,
    state: leadsTable.state,
    zip: leadsTable.zip,
    hubStatus: leadsTable.hubStatus,
    hasSoldEstimate: leadsTable.hasSoldEstimate,
  }).from(leadsTable)
    .where(eq(leadsTable.tenantId, config.tenantId));

  const leadByPhone = new Map<string, typeof existingLeads[number]>();
  for (const l of existingLeads) {
    if (l.phone) leadByPhone.set(normalizePhone(l.phone), l);
  }

  let updated = 0;
  for (const [normalizedPhone, { row }] of latestByPhone) {
    const existingLead = leadByPhone.get(normalizedPhone);
    if (!existingLead) continue;

    const updates = computeRescanUpdates(existingLead, row);

    if (Object.keys(updates).length === 0) continue;

    updates.updatedAt = new Date();
    await db.update(leadsTable)
      .set(updates)
      .where(eq(leadsTable.id, existingLead.id));

    if (updates.hubStatus && updates.hubStatus !== existingLead.hubStatus) {
      const { recordLeadStatusChange } = await import("./lead-status-history");
      await recordLeadStatusChange({
        leadId: existingLead.id,
        tenantId: config.tenantId,
        fromStatus: existingLead.hubStatus,
        toStatus: updates.hubStatus as string,
        reason: `sheet_sync:${config.id}`,
      });
    }

    const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, existingLead.id));
    if (refreshed) {
      emitLeadUpdated(config.tenantId, refreshed as unknown as Record<string, unknown>);
    }

    updated++;
  }

  if (updated > 0) {
    console.log(`[SheetSync] Re-scan updated ${updated} existing lead(s) for sheet config ${config.id} (tenant ${config.tenantId})`);
  }

  return updated;
}

async function handleDriftDetected(config: typeof googleSheetConfigsTable.$inferSelect): Promise<void> {
  const now = new Date();
  const driftStart = config.driftDetectedAt ?? now;

  if (!config.driftDetectedAt) {
    await db.update(googleSheetConfigsTable)
      .set({ driftDetectedAt: now })
      .where(eq(googleSheetConfigsTable.id, config.id));
  }

  const driftAgeMs = now.getTime() - driftStart.getTime();
  if (driftAgeMs < DRIFT_ALERT_THRESHOLD_MS) return;
  if (config.driftNotifiedAt) return;

  try {
    const emitted = await emitSheetDriftNotification({
      tenantId: config.tenantId,
      sheetConfigId: config.id,
      sheetName: config.name,
      driftMinutes: Math.round(driftAgeMs / 60000),
    });
    if (emitted) {
      await db.update(googleSheetConfigsTable)
        .set({ driftNotifiedAt: now })
        .where(eq(googleSheetConfigsTable.id, config.id));
    }
  } catch (err) {
    console.error(`[SheetSync] Failed to emit drift notification for sheet config ${config.id}:`, err);
  }
}

export async function syncSingleSheet(config: typeof googleSheetConfigsTable.$inferSelect): Promise<number> {
  const sheetId = config.googleSheetId;
  const tab = config.googleSheetTab;
  const mapping = config.columnMapping as Record<string, string>;
  const savedHeaders = config.mappingHeaders as string[];
  const watermark = config.syncRowWatermark!;
  const funnelColumn = config.funnelColumn;
  const funnelValueMap = config.funnelValueMap as Record<string, number> | null;
  const defaultFunnelTypeId = config.defaultFunnelTypeId;

  const { headers: currentHeaders, rawRows } = await readRawSheetData(sheetId, tab);

  if (!headersMatch(currentHeaders, savedHeaders)) {
    console.warn(`[SheetSync] Headers changed for sheet config ${config.id} (tenant ${config.tenantId}) — skipping`);
    await handleDriftDetected(config);
    return -1;
  }

  if (config.driftDetectedAt) {
    await db.update(googleSheetConfigsTable)
      .set({ driftDetectedAt: null, driftNotifiedAt: null })
      .where(eq(googleSheetConfigsTable.id, config.id));
    console.log(`[SheetSync] Drift resolved for sheet config ${config.id} (tenant ${config.tenantId}) — headers match again`);
  }

  await rescanExistingRows(config, currentHeaders, rawRows, mapping);

  if (rawRows.length <= watermark) return 0;

  const newRawRows = rawRows.slice(watermark);

  const rows = mapRawRows(currentHeaders, newRawRows, mapping);
  if (rows.length === 0) {
    await db.update(googleSheetConfigsTable)
      .set({ syncRowWatermark: rawRows.length })
      .where(eq(googleSheetConfigsTable.id, config.id));
    return 0;
  }

  const funnelIds = new Set<number>();
  if (defaultFunnelTypeId) funnelIds.add(defaultFunnelTypeId);
  if (funnelValueMap) Object.values(funnelValueMap).forEach(id => funnelIds.add(id));

  let allFunnels: Record<number, { name: string }> = {};
  if (funnelIds.size > 0) {
    const funnels = await db.select().from(funnelTypesTable)
      .where(inArray(funnelTypesTable.id, [...funnelIds]));
    for (const f of funnels) {
      allFunnels[f.id] = { name: f.name };
    }
  }

  let imported = 0;
  const newLeads: (typeof leadsTable.$inferSelect)[] = [];
  // Near-term duplicate rows are deferred and processed per matched lead in
  // ascending submission order AFTER the main loop, so the latest booking lands
  // on the lead even if rows arrive out of timestamp order.
  const deferredResub = new Map<number, OrderedRow[]>();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const nameFields = [row.firstName, row.lastName, row.fullName].filter(Boolean).join(" ").toLowerCase();
    if (!row.firstName && !row.lastName) continue;
    if (nameFields.includes("test")) continue;

    const resolvedFunnelId = resolveFunnelForRow(row, funnelColumn, funnelValueMap, defaultFunnelTypeId);
    if (!resolvedFunnelId) {
      const unmatchedValue = funnelColumn ? (row[funnelColumn] || "").trim() : "";
      console.warn(`[SheetSync] Unrouted row in sheet config ${config.id} — no matching funnel for value "${unmatchedValue || "N/A"}"; persisting to admin queue`);
      try {
        await db.insert(unroutedSheetRowsTable).values({
          tenantId: config.tenantId,
          sheetConfigId: config.id,
          funnelColumn: funnelColumn || null,
          unmatchedValue: unmatchedValue || null,
          rowData: row as Record<string, string>,
          reason: "no_funnel_match",
          source: "sheet_sync",
        });
      } catch (err) {
        console.error(`[SheetSync] Failed to record unrouted row for sheet config ${config.id}:`, err);
      }
      continue;
    }

    const isPreBooked = isPreBookedCellValue(row.appointmentBooked);
    const hasApptDetails = isValidAppointmentValue(row.appointmentDate) || isValidAppointmentValue(row.appointmentTime);
    const effectivePreBooked = isPreBooked || hasApptDetails;
    const funnelName = allFunnels[resolvedFunnelId]?.name;

    const mappedFields = Object.values(mapping);
    const hasApptFieldsMapped = mappedFields.some(f => f === "appointmentDate" || f === "appointmentTime" || f === "addOns");
    const visibleAfter = hasApptFieldsMapped && !effectivePreBooked
      ? new Date(Date.now() + 3 * 60 * 1000)
      : null;

    const normalizedIntakeSource = await normalizeSource(config.tenantId, row.source || "Unknown");
    const dedupeResult = await createLeadWithDedupe(
      config.tenantId,
      { phone: row.phone, email: row.email },
      async (tx, lockedIdentity) => {
        const [lead] = await tx.insert(leadsTable).values({
          tenantId: config.tenantId,
          firstName: row.firstName || "Unknown",
          lastName: row.lastName || "",
          phone: lockedIdentity.phone,
          email: lockedIdentity.email,
          source: normalizedIntakeSource,
          originalSource: normalizedIntakeSource,
          serviceType: row.serviceType || null,
          notes: row.notes || null,
          address: row.address || null,
          city: row.city || null,
          state: row.state || null,
          zip: row.zip || null,
          appointmentDate: row.appointmentDate || null,
          appointmentTime: row.appointmentTime || null,
          addOns: row.addOns || null,
          visibleAfter,
          funnelId: resolvedFunnelId,
          leadType: funnelName || null,
          hubStatus: effectivePreBooked ? "appt_booked" : "day_1",
          dayInSequence: 1,
          status: "new",
          preBooked: effectivePreBooked,
          contactPreferences: [],
        }).returning();
        return lead;
      },
      {
        createdAfter: new Date(Date.now() - LEAD_INQUIRY_DEDUPE_WINDOW_MS),
        funnelId: resolvedFunnelId,
        requireSameFunnelWhenKnown: true,
        skipDeadLeads: true,
      },
    );

    if (dedupeResult.deduplicated) {
      const list = deferredResub.get(dedupeResult.lead.id) ?? [];
      list.push({ row, index: rowIndex, ms: parseSubmissionMs(row.dateTime) });
      deferredResub.set(dedupeResult.lead.id, list);
      continue;
    }

    const lead = dedupeResult.lead;

    if (lead) {
      const { recordLeadStatusChange } = await import("./lead-status-history");
      await recordLeadStatusChange({
        leadId: lead.id,
        tenantId: config.tenantId,
        fromStatus: null,
        toStatus: lead.hubStatus,
        changedAt: lead.createdAt ?? undefined,
        reason: "sheet_sync_create",
      });
      try {
        const result = await assignLeadRoundRobin(config.tenantId, lead.id, resolvedFunnelId || null);
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
          console.warn(`[SheetSync] Lead ${lead.id} not assigned: ${result.reason}`);
        }
      } catch (err) {
        console.warn("[SheetSync] Auto-assign failed for lead", lead.id, err);
      }
    }
    newLeads.push(lead);
    imported++;
  }

  // Process deferred repeat submissions: ascending submission order so the
  // last (latest) call is the one that adopts the appointment onto the lead.
  for (const [existingLeadId, list] of deferredResub) {
    // Ascending by submission order (same comparator as backfill) so the last
    // call is the latest submission and its booking is the one adopted.
    list.sort((a, b) => (rowIsLater(a, b) ? 1 : -1));
    for (const { row, ms } of list) {
      try {
        const resubSource = await normalizeSource(config.tenantId, row.source || "Form");
        await handleResubmission(config.tenantId, existingLeadId, resubSource, {
          appointmentDate: row.appointmentDate || null,
          appointmentTime: row.appointmentTime || null,
          addOns: row.addOns || null,
          submittedAt: ms !== null ? new Date(ms) : null,
        });
      } catch (err) {
        console.error(`[SheetSync] Failed to record resubmission for lead ${existingLeadId} (sheet config ${config.id}):`, err);
      }
    }
    const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, existingLeadId));
    if (refreshed) emitLeadUpdated(config.tenantId, refreshed as unknown as Record<string, unknown>);
  }

  await db.update(googleSheetConfigsTable)
    .set({ syncRowWatermark: rawRows.length })
    .where(eq(googleSheetConfigsTable.id, config.id));

  for (const lead of newLeads) {
    scheduleOrEmitNewLead(lead.id, (lead.visibleAfter as Date | null) ?? null);
  }

  if (imported > 0) {
    console.log(`[SheetSync] Synced ${imported} new lead(s) for sheet config ${config.id} (tenant ${config.tenantId})`);
  }

  return imported;
}

interface MappedRow {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  source: string;
  serviceType: string;
  [key: string]: string;
}

const LEAD_DB_FIELDS = new Set([
  "firstName", "lastName", "fullName", "phone", "email",
  "source", "serviceType", "status", "dateTime", "appointmentBooked",
  "address", "city", "state", "zip", "appointmentDate", "appointmentTime", "addOns",
  "__skip__", "notes", "__funnel__",
]);

function mapRawRows(headers: string[], rawRows: string[][], mapping: Record<string, string>): MappedRow[] {
  const rows: MappedRow[] = [];

  for (const row of rawRows) {
    const obj: Record<string, string> = {};
    const notesParts: string[] = [];
    const sourceParts: string[] = [];
    for (let j = 0; j < headers.length; j++) {
      const headerKey = headers[j];
      const normalized = mapping[headerKey] || headerKey;
      if (normalized && normalized !== "__skip__") {
        const val = (row[j] || "").trim();
        if (normalized === "__funnel__") {
          obj[headerKey] = val;
        } else if (normalized === "source") {
          if (val) sourceParts.push(val);
        } else if (normalized === "notes" || !LEAD_DB_FIELDS.has(normalized)) {
          if (val) notesParts.push(`${headerKey}: ${val}`);
        } else {
          obj[normalized] = val;
        }
      }
    }

    if (sourceParts.length > 0) {
      obj.source = sourceParts[0];
    }

    if (notesParts.length > 0) {
      obj.notes = notesParts.join("\n");
    }

    if (obj.fullName && !obj.firstName) {
      const parts = obj.fullName.split(/\s+/);
      obj.firstName = parts[0] || "";
      obj.lastName = parts.slice(1).join(" ") || "";
    }

    if (!obj.firstName && !obj.phone) continue;

    rows.push({
      firstName: obj.firstName || "",
      lastName: obj.lastName || "",
      phone: obj.phone || "",
      email: obj.email || "",
      source: obj.source || "",
      serviceType: obj.serviceType || "",
      ...obj,
    });
  }

  return rows;
}

let syncTimer: ReturnType<typeof setInterval> | null = null;

export function startSheetSyncScheduler(): void {
  if (syncTimer) clearInterval(syncTimer);

  // Re-entrancy guard: a 60s poll can outlast its interval when a sheet is
  // large or the DB is slow, so the next tick skips instead of stacking an
  // overlapping sync. We also bound the sweep at the guard boundary: if
  // syncAllSheets ever hangs past MAX_SWEEP_MS (beyond the per-read timeouts),
  // this rejection lets the guarded runner release its own in-progress flag so
  // future ticks are not skipped forever.
  const runSheetSweep = createGuardedRunner("SheetSync", async () => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`[SheetSync] sweep exceeded ${MAX_SWEEP_MS}ms — abandoning so the scheduler lock releases`)),
        MAX_SWEEP_MS,
      );
      syncAllSheets().then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  });
  syncTimer = setInterval(() => {
    void runSheetSweep().catch((err) => {
      console.error("[SheetSync] Scheduled sync failed:", err);
    });
  }, 60 * 1000);

  console.log("[SheetSync] Scheduler started: polling sheets every 60s for new leads");
}

export function stopSheetSyncScheduler(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/**
 * One-time backfill: walk each configured sheet, group historical rows by
 * phone, and create a discrete "resubmission" timeline entry for every repeat
 * submission (all rows after the first/original) of an existing lead — capturing
 * that submission's source + appointment. Also adopts the latest booking onto
 * the lead (unless CSR-confirmed/sold).
 *
 * Idempotent: each candidate row is keyed by (submission time, appt date, appt
 * time) and skipped if a matching resubmission entry already exists, so re-runs
 * create nothing and unrelated (e.g. CallRail) resubmission attempts never
 * suppress historical sheet rows. The lead is only mutated when at least one new
 * entry is created, and resubmissionCount is never lowered.
 */
export async function backfillResubmissionTimeline(): Promise<{ entriesCreated: number; leadsUpdated: number }> {
  const configs = await db.select().from(googleSheetConfigsTable)
    .where(and(
      isNotNull(googleSheetConfigsTable.googleSheetId),
      isNotNull(googleSheetConfigsTable.googleSheetTab),
      isNotNull(googleSheetConfigsTable.columnMapping),
      isNotNull(googleSheetConfigsTable.mappingHeaders),
    ));

  let entriesCreated = 0;
  let leadsUpdated = 0;

  for (const config of configs) {
    const mapping = config.columnMapping as Record<string, string>;
    const savedHeaders = config.mappingHeaders as string[];

    let currentHeaders: string[];
    let rawRows: string[][];
    try {
      const data = await readRawSheetData(config.googleSheetId, config.googleSheetTab);
      currentHeaders = data.headers;
      rawRows = data.rawRows;
    } catch (err) {
      console.warn(`[Backfill][Resub] Could not read sheet for config ${config.id} (tenant ${config.tenantId}):`, (err as Error).message);
      continue;
    }

    if (!headersMatch(currentHeaders, savedHeaders)) {
      console.warn(`[Backfill][Resub] Headers drifted for config ${config.id} (tenant ${config.tenantId}) — skipping`);
      continue;
    }

    const mappedRows = mapRawRows(currentHeaders, rawRows, mapping);

    // Build a normalized-phone → lead map for this tenant so we match leads even
    // when a legacy lead's phone was stored in a non-normalized format.
    const tenantLeads = await db.select().from(leadsTable)
      .where(eq(leadsTable.tenantId, config.tenantId));
    const leadByPhone = new Map<string, typeof tenantLeads[number]>();
    for (const l of tenantLeads) {
      if (l.phone) leadByPhone.set(normalizePhone(l.phone), l);
    }

    // Group rows by normalized phone, preserving sheet order via index.
    const byPhone = new Map<string, OrderedRow[]>();
    mappedRows.forEach((row, index) => {
      const phone = normalizePhone(row.phone || "");
      if (!phone) return;
      const list = byPhone.get(phone) ?? [];
      list.push({ row, index, ms: parseSubmissionMs(row.dateTime) });
      byPhone.set(phone, list);
    });

    for (const [phone, group] of byPhone) {
      if (group.length < 2) continue;

      const lead = leadByPhone.get(phone);
      if (!lead) continue;

      // Sort ascending: earliest submission first (the original/creation row).
      group.sort((a, b) => (rowIsLater(a, b) ? 1 : -1));
      const resubRows = group.slice(1); // all submissions after the first

      // Idempotency: build a set of (submission time, appt date, appt time)
      // keys already recorded as resubmission entries for this lead. A row whose
      // key already exists is skipped, so re-runs create nothing and unrelated
      // (e.g. CallRail) resubmission attempts never suppress historical sheet
      // rows. Rows with no parseable submission time fall back to the lead's
      // createdAt so the key is still stable across runs.
      const leadCreatedMs = lead.createdAt ? lead.createdAt.getTime() : 0;
      const resubKey = (ms: number, apptDate: string | null, apptTime: string | null) =>
        `${ms}|${apptDate ?? ""}|${apptTime ?? ""}`;
      const existingResub = await db.select({
        attemptedAt: callAttemptsTable.attemptedAt,
        appointmentDate: callAttemptsTable.appointmentDate,
        appointmentTime: callAttemptsTable.appointmentTime,
      })
        .from(callAttemptsTable)
        .where(and(eq(callAttemptsTable.leadId, lead.id), eq(callAttemptsTable.outcome, "resubmission")));
      const seen = new Set<string>();
      for (const e of existingResub) {
        const ms = e.attemptedAt ? e.attemptedAt.getTime() : leadCreatedMs;
        seen.add(resubKey(ms, e.appointmentDate ?? null, e.appointmentTime ?? null));
      }

      // Resolve a user for the system timeline entries (once per lead).
      let attemptUserId: number | null = lead.assignedCsrId ?? null;
      if (!attemptUserId) {
        const [recent] = await db.select({ userId: callAttemptsTable.userId })
          .from(callAttemptsTable)
          .where(eq(callAttemptsTable.leadId, lead.id))
          .orderBy(desc(callAttemptsTable.attemptedAt))
          .limit(1);
        attemptUserId = recent?.userId ?? null;
      }
      if (!attemptUserId) {
        const [anyUser] = await db.select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.tenantId, config.tenantId))
          .limit(1);
        attemptUserId = anyUser?.id ?? null;
      }
      if (!attemptUserId) continue;

      let createdForLead = 0;
      for (const { row, ms } of resubRows) {
        const apptDate = isValidAppointmentValue(row.appointmentDate) ? row.appointmentDate!.trim() : null;
        const apptTime = isValidAppointmentValue(row.appointmentTime) ? row.appointmentTime!.trim() : null;
        const rowMs = ms !== null ? ms : leadCreatedMs;
        const key = resubKey(rowMs, apptDate, apptTime);
        if (seen.has(key)) continue;
        seen.add(key);

        const sourceLabel = await normalizeSource(config.tenantId, row.source || "Form");
        const bookedLabel = (apptDate || apptTime)
          ? ` — booked ${[apptDate, apptTime].filter(Boolean).join(" ")}`
          : "";
        await db.insert(callAttemptsTable).values({
          leadId: lead.id,
          userId: attemptUserId,
          method: "system",
          outcome: "resubmission",
          platform: "native",
          actionType: "system",
          notes: `Lead resubmitted from ${sourceLabel}${bookedLabel}`,
          appointmentDate: apptDate,
          appointmentTime: apptTime,
          attemptedAt: new Date(rowMs),
        });
        entriesCreated++;
        createdForLead++;
      }

      // Only mutate the lead when we actually recorded new history — keeps a
      // re-run a true no-op (no churn on updatedAt/resubmittedAt or emits).
      if (createdForLead === 0) continue;

      // Adopt the latest booking + resubmission metadata onto the lead.
      const latest = resubRows[resubRows.length - 1];
      const latestApptDate = isValidAppointmentValue(latest.row.appointmentDate) ? latest.row.appointmentDate!.trim() : null;
      const latestApptTime = isValidAppointmentValue(latest.row.appointmentTime) ? latest.row.appointmentTime!.trim() : null;
      const apptLocked = lead.hubStatus === "appt_set" || lead.hasSoldEstimate;
      const latestMs = latest.ms !== null ? latest.ms : leadCreatedMs;

      const leadUpdates: Record<string, unknown> = {
        // Never lower an existing count (other sources also increment it).
        resubmissionCount: sql`GREATEST(COALESCE(${leadsTable.resubmissionCount}, 0), ${resubRows.length})`,
        resubmittedAt: new Date(latestMs),
        updatedAt: new Date(),
      };
      if (!apptLocked && (latestApptDate || latestApptTime)) {
        if (latestApptDate) leadUpdates.appointmentDate = latestApptDate;
        if (latestApptTime) leadUpdates.appointmentTime = latestApptTime;
        leadUpdates.preBooked = true;
        leadUpdates.visibleAfter = null;
        if (lead.hubStatus !== "appt_booked" && lead.hubStatus !== "dead") {
          leadUpdates.hubStatus = "appt_booked";
        }
      }

      await db.update(leadsTable).set(leadUpdates).where(eq(leadsTable.id, lead.id));
      leadsUpdated++;

      if (leadUpdates.hubStatus && leadUpdates.hubStatus !== lead.hubStatus) {
        const { recordLeadStatusChange } = await import("./lead-status-history");
        await recordLeadStatusChange({
          leadId: lead.id,
          tenantId: config.tenantId,
          fromStatus: lead.hubStatus,
          toStatus: leadUpdates.hubStatus as string,
          changedAt: leadUpdates.resubmittedAt as Date,
          reason: "backfill_resubmission",
        });
      }

      const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
      if (refreshed) emitLeadUpdated(config.tenantId, refreshed as unknown as Record<string, unknown>);
    }
  }

  console.log(`[Backfill][Resub] Created ${entriesCreated} resubmission entr(ies) across ${leadsUpdated} lead(s)`);
  return { entriesCreated, leadsUpdated };
}
