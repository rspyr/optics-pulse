import { db, leadsTable, googleSheetConfigsTable, funnelTypesTable, callAttemptsTable } from "@workspace/db";
import { eq, and, isNotNull, ne, inArray } from "drizzle-orm";
import { readRawSheetData } from "./integrations/google-sheets";
import { emitNewLead, emitLeadUpdated } from "../socket";
import { assignLeadRoundRobin } from "./round-robin";
import { scheduleAutoPass } from "./auto-pass-scheduler";
import { isValidAppointmentValue } from "../utils/appointment-validation";
import { normalizeSource } from "./source-normalizer";

const UPDATABLE_FIELDS = [
  "appointmentDate", "appointmentTime", "appointmentBooked",
  "addOns", "address", "city", "state", "zip",
] as const;

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

async function syncAllSheets(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const configs = await db.select().from(googleSheetConfigsTable)
      .where(and(
        isNotNull(googleSheetConfigsTable.googleSheetId),
        isNotNull(googleSheetConfigsTable.googleSheetTab),
        isNotNull(googleSheetConfigsTable.columnMapping),
        isNotNull(googleSheetConfigsTable.mappingHeaders),
        isNotNull(googleSheetConfigsTable.syncRowWatermark),
        ne(googleSheetConfigsTable.syncPaused, true),
      ));

    if (configs.length === 0) return;

    let totalImported = 0;
    let driftSkipped = 0;
    let errorCount = 0;

    for (const config of configs) {
      try {
        const count = await syncSingleSheet(config);
        if (count === -1) driftSkipped++;
        else totalImported += count;
      } catch (err) {
        errorCount++;
        console.error(`[SheetSync] Error syncing sheet config ${config.id} (tenant ${config.tenantId}):`, err);
      }
    }

    if (totalImported > 0 || driftSkipped > 0 || errorCount > 0) {
      console.log(`[SheetSync] Cycle complete: ${configs.length} sheet(s) checked, ${totalImported} lead(s) imported, ${driftSkipped} drift-skipped, ${errorCount} error(s)`);
    }
  } finally {
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
  }).from(leadsTable)
    .where(eq(leadsTable.tenantId, config.tenantId));

  const leadByPhone = new Map<string, typeof existingLeads[number]>();
  for (const l of existingLeads) {
    if (l.phone) leadByPhone.set(l.phone.replace(/[^0-9]/g, ""), l);
  }

  let updated = 0;
  for (const row of allMappedRows) {
    const normalizedPhone = row.phone.replace(/[^0-9]/g, "");
    if (!normalizedPhone) continue;

    const existingLead = leadByPhone.get(normalizedPhone);
    if (!existingLead) continue;

    const updates: Record<string, unknown> = {};

    const newApptDate = row.appointmentDate || null;
    const newApptTime = row.appointmentTime || null;
    const newAddOns = row.addOns || null;
    const newAddress = row.address || null;
    const newCity = row.city || null;
    const newState = row.state || null;
    const newZip = row.zip || null;
    const newApptBooked = (row.appointmentBooked || "").toLowerCase().trim() === "yes";

    if (newApptDate && newApptDate !== existingLead.appointmentDate) updates.appointmentDate = newApptDate;
    if (newApptTime && newApptTime !== existingLead.appointmentTime) updates.appointmentTime = newApptTime;
    if (newAddOns && newAddOns !== existingLead.addOns) updates.addOns = newAddOns;
    if (newAddress && newAddress !== existingLead.address) updates.address = newAddress;
    if (newCity && newCity !== existingLead.city) updates.city = newCity;
    if (newState && newState !== existingLead.state) updates.state = newState;
    if (newZip && newZip !== existingLead.zip) updates.zip = newZip;

    const hasNewApptInfo = newApptBooked || isValidAppointmentValue(newApptDate) || isValidAppointmentValue(newApptTime);
    if (hasNewApptInfo && !existingLead.appointmentBooked) {
      updates.preBooked = true;
      if (existingLead.hubStatus !== "appt_set" && existingLead.hubStatus !== "dead") {
        updates.hubStatus = "appt_booked";
      }
      updates.visibleAfter = null;
    }

    if (Object.keys(updates).length === 0) continue;

    updates.updatedAt = new Date();
    await db.update(leadsTable)
      .set(updates)
      .where(eq(leadsTable.id, existingLead.id));

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

async function syncSingleSheet(config: typeof googleSheetConfigsTable.$inferSelect): Promise<number> {
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
    return -1;
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

  const existingLeads = await db.select({ phone: leadsTable.phone })
    .from(leadsTable)
    .where(eq(leadsTable.tenantId, config.tenantId));
  const existingPhones = new Set<string>();
  for (const l of existingLeads) {
    if (l.phone) existingPhones.add(l.phone.replace(/[^0-9]/g, ""));
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

  for (const row of rows) {
    const normalizedPhone = row.phone.replace(/[^0-9]/g, "");
    if (normalizedPhone && existingPhones.has(normalizedPhone)) continue;
    if (!row.firstName && !row.lastName) continue;
    const nameFields = [row.firstName, row.lastName, row.fullName].filter(Boolean).join(" ").toLowerCase();
    if (nameFields.includes("test")) continue;

    const resolvedFunnelId = resolveFunnelForRow(row, funnelColumn, funnelValueMap, defaultFunnelTypeId);
    if (!resolvedFunnelId) {
      console.warn(`[SheetSync] Skipping row in sheet config ${config.id} — no matching funnel for value "${funnelColumn ? row[funnelColumn] : "N/A"}"`);
      continue;
    }

    if (normalizedPhone) existingPhones.add(normalizedPhone);

    let parsedCreatedAt: Date | undefined;
    if (row.dateTime) {
      const d = new Date(row.dateTime);
      if (!isNaN(d.getTime())) parsedCreatedAt = d;
    }

    const isPreBooked = (row.appointmentBooked || "").toLowerCase().trim() === "yes";
    const hasApptDetails = isValidAppointmentValue(row.appointmentDate) || isValidAppointmentValue(row.appointmentTime);
    const effectivePreBooked = isPreBooked || hasApptDetails;
    const funnelName = allFunnels[resolvedFunnelId]?.name;

    const mappedFields = Object.values(mapping);
    const hasApptFieldsMapped = mappedFields.some(f => f === "appointmentDate" || f === "appointmentTime" || f === "addOns");
    const visibleAfter = hasApptFieldsMapped && !effectivePreBooked
      ? new Date(Date.now() + 10 * 60 * 1000)
      : null;

    const [lead] = await db.insert(leadsTable).values({
      tenantId: config.tenantId,
      firstName: row.firstName || "Unknown",
      lastName: row.lastName || "",
      phone: row.phone || null,
      email: row.email || null,
      source: await normalizeSource(config.tenantId, row.source || funnelName || "Google Sheet"),
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
      hubStatus: effectivePreBooked ? "appt_booked" : "day_1",
      dayInSequence: 1,
      status: "new",
      preBooked: effectivePreBooked,
      contactPreferences: [],
      ...(parsedCreatedAt ? { createdAt: parsedCreatedAt } : {}),
    }).returning();

    if (lead) {
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
              notes: `System: Lead visibility delayed 10 minutes (auto-book window)`,
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

  await db.update(googleSheetConfigsTable)
    .set({ syncRowWatermark: rawRows.length })
    .where(eq(googleSheetConfigsTable.id, config.id));

  for (const lead of newLeads) {
    const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
    emitNewLead(config.tenantId, (refreshed ?? lead) as unknown as Record<string, unknown>);
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
    for (let j = 0; j < headers.length; j++) {
      const headerKey = headers[j];
      const normalized = mapping[headerKey] || headerKey;
      if (normalized && normalized !== "__skip__") {
        const val = (row[j] || "").trim();
        if (normalized === "__funnel__") {
          obj[headerKey] = val;
        } else if (normalized === "notes" || !LEAD_DB_FIELDS.has(normalized)) {
          if (val) notesParts.push(`${headerKey}: ${val}`);
        } else {
          obj[normalized] = val;
        }
      }
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

  syncTimer = setInterval(() => {
    syncAllSheets().catch((err) => {
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
