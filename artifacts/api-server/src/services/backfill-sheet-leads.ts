import crypto from "crypto";
import {
  db,
  leadsTable,
  attributionEventsTable,
  tenantsTable,
  funnelTypesTable,
  callAttemptsTable,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { readRawSheetData } from "./integrations/google-sheets";
import { normalizeSource } from "./source-normalizer";
import { assignLeadRoundRobin } from "./round-robin";
import { scheduleAutoPass } from "./auto-pass-scheduler";
import { emitNewLead } from "../socket";
import { isValidAppointmentValue } from "../utils/appointment-validation";
import { normalizePhone } from "../lib/phone-utils";

/**
 * One-shot historical backfill for tenants where leads were captured into a
 * Google Sheet but never made it into the `leads` table (e.g. tracker-only
 * tenants whose pulse.js missed real submits).
 *
 * Reads the sheet directly for a date range and inserts into `leads` +
 * `attribution_events` so the recovered leads look identical to a freshly
 * captured submission. Does NOT touch `google_sheet_configs.syncPaused` or
 * `tenants.leadIngestionMode` — this is a recovery import, not a mode change.
 */

export interface BackfillRow {
  /** Raw cells in the sheet, indexed by header. */
  cells: Record<string, string>;
  /** Parsed timestamp from the date column (used for createdAt and date filter). */
  rowDate: Date | null;
}

export interface BackfillOptions {
  tenantId: number;
  /** Sheet ID (or pre-loaded rows for tests). */
  spreadsheetId?: string;
  tabName?: string;
  /** Optional pre-loaded sheet contents for tests / dry-runs. */
  preloaded?: { headers: string[]; rawRows: string[][] };
  /** Header name that contains the lead's submission timestamp. */
  dateColumn: string;
  /** Inclusive date range. */
  dateFrom: Date;
  dateTo: Date;
  /** Mapping from sheet header -> semantic field (firstName, lastName, phone, email, source, ...). */
  columnMapping: Record<string, string>;
  /** UTM defaults to stamp on every recovered lead's attribution event. */
  utmDefaults?: {
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmContent?: string | null;
    utmTerm?: string | null;
  };
  /** Default funnel ID used when no per-row funnel is detectable. */
  defaultFunnelTypeId?: number | null;
  /** When true, do not write to the DB — just return the planned rows. */
  dryRun?: boolean;
  /** When true, skip round-robin assignment + socket emit (useful for tests). */
  skipAssignment?: boolean;
  /** Resolved lead source label (e.g. "Meta"); falls back to the sheet's source column. */
  resolvedSource?: string | null;
}

export interface BackfillResult {
  candidates: number;
  inserted: number;
  skippedDuplicate: number;
  skippedOutOfRange: number;
  skippedNoIdentity: number;
  insertedLeadIds: number[];
}

const DATE_FORMATS = [
  // Google Sheets common output formats. Order matters — try most-specific first.
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/, // ISO
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/, // 4/15/2026 9:32:11 AM
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, // 4/15/2026
];

export function parseSheetDate(raw: string): Date | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  const isoMatch = trimmed.match(DATE_FORMATS[0]);
  if (isoMatch) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }

  const usMatch = trimmed.match(DATE_FORMATS[1]);
  if (usMatch) {
    const [, mm, dd, yyyy, hh, mi, ss, ampm] = usMatch;
    let h = parseInt(hh, 10);
    if (ampm) {
      const upper = ampm.toUpperCase();
      if (upper === "PM" && h < 12) h += 12;
      if (upper === "AM" && h === 12) h = 0;
    }
    const d = new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), h, parseInt(mi, 10), ss ? parseInt(ss, 10) : 0);
    return isNaN(d.getTime()) ? null : d;
  }

  const dateOnlyMatch = trimmed.match(DATE_FORMATS[2]);
  if (dateOnlyMatch) {
    const [, mm, dd, yyyy] = dateOnlyMatch;
    const d = new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10));
    return isNaN(d.getTime()) ? null : d;
  }

  // Last-ditch parse.
  const fallback = new Date(trimmed);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function rowsFromSheet(headers: string[], rawRows: string[][], opts: BackfillOptions): BackfillRow[] {
  const result: BackfillRow[] = [];
  const dateIdx = headers.indexOf(opts.dateColumn);
  for (const raw of rawRows) {
    const cells: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      cells[headers[i]] = (raw[i] || "").trim();
    }
    const rowDate = dateIdx >= 0 ? parseSheetDate(raw[dateIdx] || "") : null;
    result.push({ cells, rowDate });
  }
  return result;
}

interface MappedLead {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  source: string;
  serviceType: string;
  notes: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  appointmentDate: string;
  appointmentTime: string;
  appointmentBooked: string;
}

function mapRow(row: BackfillRow, mapping: Record<string, string>): MappedLead {
  const out: Record<string, string> = {};
  const notesParts: string[] = [];
  let fullName = "";
  for (const [header, semantic] of Object.entries(mapping)) {
    const val = row.cells[header] || "";
    if (!val) continue;
    if (semantic === "fullName") {
      fullName = val;
    } else if (semantic === "notes") {
      notesParts.push(`${header}: ${val}`);
    } else if (semantic === "__skip__") {
      continue;
    } else {
      out[semantic] = val;
    }
  }
  if (fullName && !out.firstName) {
    const parts = fullName.split(/\s+/);
    out.firstName = parts[0] || "";
    out.lastName = parts.slice(1).join(" ") || "";
  }
  return {
    firstName: out.firstName || "",
    lastName: out.lastName || "",
    phone: out.phone || "",
    email: out.email || "",
    source: out.source || "",
    serviceType: out.serviceType || "",
    notes: notesParts.join("\n"),
    address: out.address || "",
    city: out.city || "",
    state: out.state || "",
    zip: out.zip || "",
    appointmentDate: out.appointmentDate || "",
    appointmentTime: out.appointmentTime || "",
    appointmentBooked: out.appointmentBooked || "",
  };
}

export async function backfillSheetLeads(opts: BackfillOptions): Promise<BackfillResult> {
  const { headers, rawRows } = opts.preloaded
    ?? (await readRawSheetData(opts.spreadsheetId!, opts.tabName!));

  const rows = rowsFromSheet(headers, rawRows, opts);

  const result: BackfillResult = {
    candidates: 0,
    inserted: 0,
    skippedDuplicate: 0,
    skippedOutOfRange: 0,
    skippedNoIdentity: 0,
    insertedLeadIds: [],
  };

  // Pre-load existing phones for dedup.
  const existing = await db.select({ phone: leadsTable.phone, email: leadsTable.email })
    .from(leadsTable).where(eq(leadsTable.tenantId, opts.tenantId));
  const existingPhones = new Set<string>();
  const existingEmails = new Set<string>();
  for (const l of existing) {
    if (l.phone) existingPhones.add(l.phone.replace(/[^0-9]/g, ""));
    if (l.email) existingEmails.add(l.email.toLowerCase().trim());
  }

  const fromMs = opts.dateFrom.getTime();
  const toMs = opts.dateTo.getTime();

  for (const row of rows) {
    if (!row.rowDate) {
      result.skippedOutOfRange++;
      continue;
    }
    const rowMs = row.rowDate.getTime();
    if (rowMs < fromMs || rowMs > toMs) {
      result.skippedOutOfRange++;
      continue;
    }

    result.candidates++;

    const mapped = mapRow(row, opts.columnMapping);
    if (!mapped.firstName && !mapped.phone && !mapped.email) {
      result.skippedNoIdentity++;
      continue;
    }
    const normPhone = mapped.phone.replace(/[^0-9]/g, "");
    const normEmail = mapped.email.toLowerCase().trim();
    if ((normPhone && existingPhones.has(normPhone)) || (normEmail && existingEmails.has(normEmail))) {
      result.skippedDuplicate++;
      continue;
    }
    if (normPhone) existingPhones.add(normPhone);
    if (normEmail) existingEmails.add(normEmail);

    if (opts.dryRun) {
      result.inserted++;
      continue;
    }

    const rawSource = opts.resolvedSource || mapped.source || "Unknown";
    const normalizedSource = await normalizeSource(opts.tenantId, rawSource);

    const utm = opts.utmDefaults || {};
    const hashedPhone = normPhone ? sha256(normalizePhone(normPhone)) : null;
    const hashedEmail = normEmail ? sha256(normEmail) : null;

    const matchLevel: "diamond" | "golden" | "silver" | "unmatched" =
      hashedPhone ? "golden" : hashedEmail ? "silver" : "unmatched";
    const matchConfidence = matchLevel === "golden" ? 0.9 : matchLevel === "silver" ? 0.8 : 0;

    const isPreBooked = mapped.appointmentBooked.toLowerCase() === "yes"
      || isValidAppointmentValue(mapped.appointmentDate)
      || isValidAppointmentValue(mapped.appointmentTime);

    let funnelName: string | null = null;
    if (opts.defaultFunnelTypeId) {
      const [f] = await db.select({ name: funnelTypesTable.name })
        .from(funnelTypesTable)
        .where(eq(funnelTypesTable.id, opts.defaultFunnelTypeId));
      funnelName = f?.name || null;
    }

    // Insert lead + paired attribution event atomically. If the event insert
    // fails, the lead insert is rolled back so we never produce orphan rows.
    let lead: typeof leadsTable.$inferSelect | undefined;
    try {
      lead = await db.transaction(async (tx) => {
        const [insertedLead] = await tx.insert(leadsTable).values({
          tenantId: opts.tenantId,
          firstName: mapped.firstName || "Unknown",
          lastName: mapped.lastName || "",
          phone: mapped.phone || null,
          email: mapped.email || null,
          source: normalizedSource,
          originalSource: normalizedSource,
          serviceType: mapped.serviceType || null,
          notes: mapped.notes || null,
          address: mapped.address || null,
          city: mapped.city || null,
          state: mapped.state || null,
          zip: mapped.zip || null,
          appointmentDate: mapped.appointmentDate || null,
          appointmentTime: mapped.appointmentTime || null,
          funnelId: opts.defaultFunnelTypeId || null,
          leadType: funnelName,
          hubStatus: isPreBooked ? "appt_booked" : "day_1",
          dayInSequence: 1,
          status: "new",
          preBooked: isPreBooked,
          contactPreferences: [],
          // Preserve the real submission timestamp from the sheet.
          createdAt: row.rowDate,
          updatedAt: row.rowDate,
          assignedAt: row.rowDate,
        }).returning();

        if (!insertedLead) throw new Error("Lead insert returned no row");

        await tx.insert(attributionEventsTable).values({
          tenantId: opts.tenantId,
          eventType: "form_fill",
          hashedPhone,
          hashedEmail,
          utmSource: utm.utmSource ?? null,
          utmMedium: utm.utmMedium ?? null,
          utmCampaign: utm.utmCampaign ?? null,
          utmTerm: utm.utmTerm ?? null,
          utmContent: utm.utmContent ?? null,
          formType: "sheet-backfill",
          formFields: { _backfillRow: row.cells },
          resolvedLeadSource: normalizedSource,
          submittedAt: row.rowDate,
          matchLevel,
          matchConfidence,
          createdLeadId: insertedLead.id,
        });

        return insertedLead;
      });
    } catch (err) {
      console.error(`[Backfill] Failed to insert lead+event for row (${mapped.firstName} ${mapped.lastName}):`, err);
      continue;
    }

    if (!lead) continue;

    if (!opts.skipAssignment) {
      try {
        const assigned = await assignLeadRoundRobin(opts.tenantId, lead.id, opts.defaultFunnelTypeId || null);
        if (assigned.assignedCsrId && assigned.passIntervalMinutes != null) {
          scheduleAutoPass(lead.id, assigned.passIntervalMinutes * 60 * 1000);
          await db.insert(callAttemptsTable).values({
            leadId: lead.id,
            userId: assigned.assignedCsrId,
            method: "system",
            outcome: "initial_assignment",
            platform: "native",
            actionType: "system",
            notes: `System: Backfilled lead initially assigned to ${assigned.csrName}`,
          });
        }
      } catch (err) {
        console.warn(`[Backfill] Assignment failed for lead ${lead.id}:`, err);
      }

      const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
      emitNewLead(opts.tenantId, (refreshed ?? lead) as unknown as Record<string, unknown>);
    }

    result.inserted++;
    result.insertedLeadIds.push(lead.id);
  }

  return result;
}
