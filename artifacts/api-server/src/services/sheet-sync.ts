import { db, leadsTable, tenantFunnelTypesTable, funnelTypesTable } from "@workspace/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { readRawSheetData } from "./integrations/google-sheets";
import { emitNewLead } from "../socket";

function headersMatch(current: string[], saved: string[]): boolean {
  if (current.length !== saved.length) return false;
  const currentSet = new Set(current);
  return saved.every(h => currentSet.has(h));
}

let syncing = false;

async function syncAllSheets(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const associations = await db.select().from(tenantFunnelTypesTable)
      .where(and(
        isNotNull(tenantFunnelTypesTable.googleSheetId),
        isNotNull(tenantFunnelTypesTable.googleSheetTab),
        isNotNull(tenantFunnelTypesTable.columnMapping),
        isNotNull(tenantFunnelTypesTable.mappingHeaders),
        isNotNull(tenantFunnelTypesTable.syncRowWatermark),
      ));

    if (associations.length === 0) return;

    let totalImported = 0;
    let driftSkipped = 0;
    let errorCount = 0;

    for (const assoc of associations) {
      try {
        const count = await syncSingleSheet(assoc);
        if (count === -1) driftSkipped++;
        else totalImported += count;
      } catch (err) {
        errorCount++;
        console.error(`[SheetSync] Error syncing tenant ${assoc.tenantId} / funnel ${assoc.funnelTypeId}:`, err);
      }
    }

    if (totalImported > 0 || driftSkipped > 0 || errorCount > 0) {
      console.log(`[SheetSync] Cycle complete: ${associations.length} sheet(s) checked, ${totalImported} lead(s) imported, ${driftSkipped} drift-skipped, ${errorCount} error(s)`);
    }
  } finally {
    syncing = false;
  }
}

async function syncSingleSheet(assoc: typeof tenantFunnelTypesTable.$inferSelect): Promise<number> {
  const sheetId = assoc.googleSheetId!;
  const tab = assoc.googleSheetTab!;
  const mapping = assoc.columnMapping as Record<string, string>;
  const savedHeaders = assoc.mappingHeaders as string[];
  const watermark = assoc.syncRowWatermark!;

  const { headers: currentHeaders, rawRows } = await readRawSheetData(sheetId, tab);

  if (!headersMatch(currentHeaders, savedHeaders)) {
    console.warn(`[SheetSync] Headers changed for tenant ${assoc.tenantId} / funnel ${assoc.funnelTypeId} — skipping`);
    return -1;
  }

  if (rawRows.length <= watermark) return 0;

  const newRawRows = rawRows.slice(watermark);

  const rows = mapRawRows(currentHeaders, newRawRows, mapping);
  if (rows.length === 0) {
    await db.update(tenantFunnelTypesTable)
      .set({ syncRowWatermark: rawRows.length })
      .where(and(
        eq(tenantFunnelTypesTable.tenantId, assoc.tenantId),
        eq(tenantFunnelTypesTable.funnelTypeId, assoc.funnelTypeId),
      ));
    return 0;
  }

  const existingLeads = await db.select({ phone: leadsTable.phone })
    .from(leadsTable)
    .where(eq(leadsTable.tenantId, assoc.tenantId));
  const existingPhones = new Set<string>();
  for (const l of existingLeads) {
    if (l.phone) existingPhones.add(l.phone.replace(/[^0-9]/g, ""));
  }

  const [funnel] = await db.select().from(funnelTypesTable).where(eq(funnelTypesTable.id, assoc.funnelTypeId));

  let imported = 0;
  const newLeads: (typeof leadsTable.$inferSelect)[] = [];

  for (const row of rows) {
    const normalizedPhone = row.phone.replace(/[^0-9]/g, "");
    if (normalizedPhone && existingPhones.has(normalizedPhone)) continue;
    if (!row.firstName && !row.lastName) continue;
    if (normalizedPhone) existingPhones.add(normalizedPhone);

    let parsedCreatedAt: Date | undefined;
    if (row.dateTime) {
      const d = new Date(row.dateTime);
      if (!isNaN(d.getTime())) parsedCreatedAt = d;
    }

    const [lead] = await db.insert(leadsTable).values({
      tenantId: assoc.tenantId,
      firstName: row.firstName || "Unknown",
      lastName: row.lastName || "",
      phone: row.phone || null,
      email: row.email || null,
      source: row.source || funnel?.name || "Google Sheet",
      serviceType: row.serviceType || null,
      funnelId: assoc.funnelTypeId,
      hubStatus: "day_1",
      dayInSequence: 1,
      status: "new",
      contactPreferences: [],
      ...(parsedCreatedAt ? { createdAt: parsedCreatedAt } : {}),
    }).returning();

    newLeads.push(lead);
    imported++;
  }

  await db.update(tenantFunnelTypesTable)
    .set({ syncRowWatermark: rawRows.length })
    .where(and(
      eq(tenantFunnelTypesTable.tenantId, assoc.tenantId),
      eq(tenantFunnelTypesTable.funnelTypeId, assoc.funnelTypeId),
    ));

  for (const lead of newLeads) {
    emitNewLead(assoc.tenantId, lead as unknown as Record<string, unknown>);
  }

  if (imported > 0) {
    console.log(`[SheetSync] Synced ${imported} new lead(s) for tenant ${assoc.tenantId} / funnel ${assoc.funnelTypeId}`);
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

function mapRawRows(headers: string[], rawRows: string[][], mapping: Record<string, string>): MappedRow[] {
  const rows: MappedRow[] = [];

  for (const row of rawRows) {
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const headerKey = headers[j];
      const normalized = mapping[headerKey] || headerKey;
      if (normalized && normalized !== "__skip__") {
        obj[normalized] = (row[j] || "").trim();
      }
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
