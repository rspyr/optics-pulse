import { Router, type IRouter } from "express";
import { db, leadsTable, googleSheetConfigsTable, funnelTypesTable, callAttemptsTable } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { readSheetRows, readRawSheetData } from "../services/integrations/google-sheets";
import { requireRole } from "../middleware/auth";
import { scheduleOrEmitNewLead } from "../services/lead-notify-scheduler";
import { ai } from "@workspace/integrations-gemini-ai";
import { assignLeadRoundRobin } from "../services/round-robin";
import { scheduleAutoPass } from "../services/auto-pass-scheduler";
import { isValidAppointmentValue } from "../utils/appointment-validation";
import { normalizeSource } from "../services/source-normalizer";
import { handleResubmission } from "../services/lead-resubmission";
import { emitLeadUpdated } from "../socket";

const router: IRouter = Router();

const INTERNAL_FIELDS = [
  { field: "firstName", label: "First Name", description: "Lead's first name" },
  { field: "lastName", label: "Last Name", description: "Lead's last name" },
  { field: "fullName", label: "Full Name", description: "Lead's full name (will be split into first/last)" },
  { field: "phone", label: "Phone", description: "Phone number" },
  { field: "email", label: "Email", description: "Email address" },
  { field: "source", label: "Lead Source", description: "Where the lead came from (e.g., Google, Facebook, referral)" },
  { field: "serviceType", label: "Service Type", description: "Type of HVAC service needed (e.g., Heat Pump, A/C, Furnace)" },
  { field: "__funnel__", label: "Funnel", description: "Routes leads to different funnels based on column values — use when a single sheet contains leads for multiple funnel types" },
  { field: "status", label: "Status", description: "Lead status (e.g., new, contacted, booked)" },
  { field: "notes", label: "Notes", description: "Additional notes or comments about the lead" },
  { field: "appointmentBooked", label: "Appointment Booked", description: "Whether lead has a pre-booked appointment (yes/no)" },
  { field: "address", label: "Address", description: "Street address" },
  { field: "city", label: "City", description: "City" },
  { field: "state", label: "State", description: "State/province" },
  { field: "zip", label: "Zip Code", description: "Zip/postal code" },
  { field: "dateTime", label: "Date/Time", description: "Date/time timestamp (ISO 8601, e.g. 2026-02-11T20:57:57) — used as the lead's created date" },
  { field: "appointmentDate", label: "Appointment Date", description: "Date of the scheduled appointment (e.g., 2026-04-15)" },
  { field: "appointmentTime", label: "Appointment Time", description: "Time of the scheduled appointment (e.g., 10:00 AM)" },
  { field: "addOns", label: "Add-Ons", description: "Additional services or add-ons requested by the lead" },
  { field: "__skip__", label: "Skip (Do Not Import)", description: "Ignore this column" },
];

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
    const value = (row[funnelColumn] || row["__funnel__"] || "").trim();
    if (value && funnelValueMap[value] !== undefined) {
      return funnelValueMap[value];
    }
  }
  return defaultFunnelTypeId;
}

router.post("/sheet-configs/:configId/analyze-mapping", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const configId = parseInt(String(req.params.configId));

  const [config] = await db.select().from(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.id, configId));

  if (!config) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  try {
    const { headers, rawRows } = await readRawSheetData(config.googleSheetId, config.googleSheetTab);
    if (headers.length === 0) {
      res.status(400).json({ error: "No headers found in sheet" });
      return;
    }

    const sampleData = rawRows.slice(0, 5).map(row => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ""; });
      return obj;
    });

    const fieldsForPrompt = INTERNAL_FIELDS.filter(f => f.field !== "__funnel__");

    const prompt = `You are analyzing a Google Sheet from an HVAC marketing agency's client. The sheet contains lead data that needs to be mapped to internal fields.

SHEET HEADERS: ${JSON.stringify(headers)}

SAMPLE DATA (first ${sampleData.length} rows):
${JSON.stringify(sampleData, null, 2)}

INTERNAL FIELDS AVAILABLE:
${fieldsForPrompt.map(f => `- "${f.field}": ${f.label} — ${f.description}`).join("\n")}

IMPORTANT: There is also a special "__funnel__" field (label: "Funnel") which is used when a column contains values that differentiate which marketing funnel each lead belongs to. If you see a column that appears to categorize leads into different campaign types, funnel types, or lead categories (NOT service types like Heat Pump, A/C, etc.), map it to "__funnel__".

TASK: For each sheet header, determine which internal field it maps to. Return a JSON object where:
- Keys are the exact sheet header names (matching case)
- Values are objects with: "field" (internal field name), "confidence" (number 0-1)

Rules:
- Map columns that clearly correspond to internal fields
- Use "fullName" if a single column contains both first and last names
- Use "__skip__" for columns that don't map to any internal field (e.g., timestamps, IDs, internal notes)
- Use "__funnel__" only if the column categorizes leads into different marketing funnels/campaigns (not service types)
- Confidence: 1.0 = exact/obvious match, 0.7-0.9 = likely match, 0.5-0.69 = uncertain, <0.5 = guess
- If a column header is ambiguous, look at the sample data to determine the best mapping
- Each internal field should only be mapped once (except __skip__ and "source")
- IMPORTANT: Multiple columns CAN map to "source". If you see utm_source, utm_medium, utm_campaign, or similar UTM tracking columns, map ALL of them to "source". The system will use the first non-empty value as the lead source. This is critical for capturing source data when some UTM fields are empty.

Respond with ONLY valid JSON. Example:
{"First Name": {"field": "firstName", "confidence": 1.0}, "Ph #": {"field": "phone", "confidence": 0.9}}`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
    });

    const rawText = response.text?.trim() || "{}";
    let parsed: Record<string, { field: string; confidence: number }> = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      try {
        const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1].trim());
        } else {
          const braceMatch = rawText.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
          if (braceMatch) parsed = JSON.parse(braceMatch[0]);
        }
      } catch (innerErr) {
        console.error("[GoogleSheets Mapping] Failed to parse LLM JSON. Raw:", rawText.substring(0, 500));
        parsed = {};
      }
    }

    const validFieldSet = new Set(INTERNAL_FIELDS.map(f => f.field));
    const mapping: Record<string, string> = {};
    const confidences: Record<string, number> = {};

    for (const h of headers) {
      const val = parsed[h];
      if (val && typeof val === "object" && typeof val.field === "string" && validFieldSet.has(val.field)) {
        mapping[h] = val.field;
        confidences[h] = typeof val.confidence === "number" ? Math.max(0, Math.min(1, val.confidence)) : 0.5;
      } else {
        mapping[h] = "__skip__";
        confidences[h] = val && typeof val === "object" && typeof val.confidence === "number"
          ? Math.max(0, Math.min(1, val.confidence)) : 0;
      }
    }

    res.json({
      headers,
      sampleData,
      proposedMapping: mapping,
      confidences,
      internalFields: INTERNAL_FIELDS,
      totalRows: rawRows.length,
    });
  } catch (err) {
    console.error("[GoogleSheets Mapping] LLM analysis error:", err);
    const message = err instanceof Error ? err.message : "Failed to analyze sheet";
    res.status(500).json({ error: message });
  }
});

router.post("/sheet-configs/:configId/save-mapping", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const configId = parseInt(String(req.params.configId));
  const { mapping, headers } = req.body as { mapping: Record<string, string>; headers: string[] };

  if (mapping === null && headers === null) {
    const clearResult = await db.update(googleSheetConfigsTable)
      .set({ columnMapping: null, mappingHeaders: null, syncRowWatermark: null, funnelColumn: null, funnelValueMap: null, updatedAt: new Date() })
      .where(eq(googleSheetConfigsTable.id, configId));
    if (!clearResult.rowCount || clearResult.rowCount === 0) {
      res.status(404).json({ error: "Sheet config not found" });
      return;
    }
    res.json({ success: true, cleared: true });
    return;
  }

  if (!mapping || !headers || !Array.isArray(headers)) {
    res.status(400).json({ error: "mapping and headers are required" });
    return;
  }

  const allowedFields = new Set(INTERNAL_FIELDS.map(f => f.field));
  for (const [header, field] of Object.entries(mapping)) {
    if (typeof field !== "string" || !allowedFields.has(field)) {
      res.status(400).json({ error: `Invalid mapping: "${header}" maps to unknown field "${field}"` });
      return;
    }
  }

  const mappingKeys = Object.keys(mapping).sort();
  const headerKeys = [...headers].sort();
  if (mappingKeys.length !== headerKeys.length || !mappingKeys.every((k, i) => k === headerKeys[i])) {
    res.status(400).json({ error: "Mapping keys must match the provided headers exactly" });
    return;
  }

  const multiAllowed = new Set(["source"]);
  const fieldAssignments = Object.values(mapping).filter(f => f !== "__skip__" && f !== "notes" && f !== "__funnel__");
  const duplicates = fieldAssignments.filter((f, i) => fieldAssignments.indexOf(f) !== i && !multiAllowed.has(f));
  if (duplicates.length > 0) {
    res.status(400).json({ error: `Duplicate field assignment: "${[...new Set(duplicates)].join(", ")}" is mapped to multiple columns` });
    return;
  }

  const [config] = await db.select().from(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.id, configId));

  if (!config) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  let watermark: number | null = null;
  try {
    const { rawRows } = await readRawSheetData(config.googleSheetId, config.googleSheetTab);
    watermark = rawRows.length;
  } catch (err) {
    console.error("[GoogleSheets Mapping] Failed to read sheet for watermark:", err);
    res.status(503).json({ error: "Unable to read sheet to initialize auto-sync. Please try again." });
    return;
  }

  let funnelColumn: string | null = null;
  for (const [header, field] of Object.entries(mapping)) {
    if (field === "__funnel__") {
      funnelColumn = header;
      break;
    }
  }

  const result = await db.update(googleSheetConfigsTable)
    .set({
      columnMapping: mapping,
      mappingHeaders: headers,
      syncRowWatermark: watermark,
      syncPaused: true,
      funnelColumn,
      funnelValueMap: funnelColumn ? (config.funnelValueMap || null) : null,
      updatedAt: new Date(),
    })
    .where(eq(googleSheetConfigsTable.id, configId));

  if (!result.rowCount || result.rowCount === 0) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  res.json({ success: true, funnelColumn });
});

router.get("/sheet-configs/:configId/mapping-status", requireRole("super_admin", "agency_user", "client_admin"), async (req, res): Promise<void> => {
  const configId = parseInt(String(req.params.configId));

  const [config] = await db.select().from(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.id, configId));

  if (!config) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  const role = (req.session as unknown as Record<string, unknown>).userRole as string;
  if (role === "client_admin") {
    const sessionTenantId = (req.session as unknown as Record<string, unknown>).tenantId as number | undefined;
    if (sessionTenantId !== config.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  const hasMapping = !!config.columnMapping && !!config.mappingHeaders;
  let headersChanged = false;
  let verificationError = false;

  if (hasMapping) {
    try {
      const { headers: currentHeaders } = await readRawSheetData(config.googleSheetId, config.googleSheetTab);
      headersChanged = !headersMatch(currentHeaders, config.mappingHeaders as string[]);
    } catch {
      verificationError = true;
    }
  }

  res.json({
    hasMapping,
    headersChanged,
    verificationError,
    columnMapping: config.columnMapping,
    mappingHeaders: config.mappingHeaders,
    funnelColumn: config.funnelColumn,
    funnelValueMap: config.funnelValueMap,
  });
});

router.post("/sheet-configs/:configId/ingest", requireRole("super_admin", "agency_user", "client_admin"), async (req, res): Promise<void> => {
  const configId = parseInt(String(req.params.configId));

  const [config] = await db.select().from(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.id, configId));

  if (!config) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  const role = (req.session as unknown as Record<string, unknown>).userRole as string;
  if (role === "client_admin" || role === "client_user") {
    const sessionTenantId = (req.session as unknown as Record<string, unknown>).tenantId as number | undefined;
    if (sessionTenantId !== config.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  if (!config.columnMapping || !config.mappingHeaders) {
    res.status(400).json({
      error: "Column mapping has not been approved yet. Please analyze and approve the column mapping before importing.",
      mappingRequired: true,
    });
    return;
  }

  try {
    const { headers: currentHeaders } = await readRawSheetData(config.googleSheetId, config.googleSheetTab);
    if (!headersMatch(currentHeaders, config.mappingHeaders as string[])) {
      res.status(409).json({
        error: "Sheet headers have changed since mapping was approved. Please re-analyze and approve the mapping.",
        headersChanged: true,
      });
      return;
    }
  } catch (headerErr) {
    console.error("[GoogleSheets Ingest] Failed to verify headers:", headerErr);
    res.status(503).json({
      error: "Unable to verify sheet headers against approved mapping. Please try again.",
    });
    return;
  }

  const funnelColumn = config.funnelColumn;
  const funnelValueMap = config.funnelValueMap as Record<string, number> | null;
  const defaultFunnelTypeId = config.defaultFunnelTypeId;

  let allFunnels: Record<number, { name: string }> = {};
  const funnelIds = new Set<number>();
  if (defaultFunnelTypeId) funnelIds.add(defaultFunnelTypeId);
  if (funnelValueMap) Object.values(funnelValueMap).forEach(id => funnelIds.add(id));

  if (funnelIds.size > 0) {
    const funnels = await db.select().from(funnelTypesTable)
      .where(inArray(funnelTypesTable.id, [...funnelIds]));
    for (const f of funnels) {
      allFunnels[f.id] = { name: f.name };
    }
  }

  try {
    const customMapping = config.columnMapping as Record<string, string>;
    const { rows } = await readSheetRows(config.googleSheetId, config.googleSheetTab, customMapping);

    if (rows.length === 0) {
      res.json({ imported: 0, skipped: 0, message: "No rows found in sheet" });
      return;
    }

    const existingPhoneToLeadId = new Map<string, number>();
    const existingLeads = await db.select({ id: leadsTable.id, phone: leadsTable.phone })
      .from(leadsTable)
      .where(eq(leadsTable.tenantId, config.tenantId));
    for (const l of existingLeads) {
      if (l.phone) existingPhoneToLeadId.set(l.phone.replace(/[^0-9]/g, ""), l.id);
    }

    let imported = 0;
    let skipped = 0;
    let resubmitted = 0;
    let noFunnelSkipped = 0;
    const newLeads: (typeof leadsTable.$inferSelect)[] = [];
    const resubmittedLeadIds: number[] = [];

    for (const row of rows) {
      const normalizedPhone = row.phone.replace(/[^0-9]/g, "");
      if (normalizedPhone && existingPhoneToLeadId.has(normalizedPhone)) {
        const dupLeadId = existingPhoneToLeadId.get(normalizedPhone)!;
        try {
          await handleResubmission(config.tenantId, dupLeadId, "Google Sheets");
          resubmittedLeadIds.push(dupLeadId);
          resubmitted++;
        } catch (err) {
          console.warn("[SheetsIngest] Resubmission failed for lead", dupLeadId, err);
          skipped++;
        }
        continue;
      }

      if (!row.firstName && !row.lastName) {
        skipped++;
        continue;
      }

      const nameFields = [row.firstName, row.lastName, row.fullName].filter(Boolean).join(" ").toLowerCase();
      if (nameFields.includes("test")) {
        skipped++;
        continue;
      }

      const resolvedFunnelId = resolveFunnelForRow(row, funnelColumn, funnelValueMap, defaultFunnelTypeId);
      if (!resolvedFunnelId) {
        noFunnelSkipped++;
        skipped++;
        continue;
      }

      if (normalizedPhone) existingPhoneToLeadId.set(normalizedPhone, 0);

      const isPreBooked = (row.appointmentBooked || "").toLowerCase().trim() === "yes";
      const hasApptDetails = isValidAppointmentValue(row.appointmentDate) || isValidAppointmentValue(row.appointmentTime);
      const effectivePreBooked = isPreBooked || hasApptDetails;
      const funnelName = allFunnels[resolvedFunnelId]?.name;

      const customMappingValues = Object.values(customMapping);
      const hasApptFieldsMapped = customMappingValues.some(f => f === "appointmentDate" || f === "appointmentTime" || f === "addOns");
      const visibleAfter = hasApptFieldsMapped && !effectivePreBooked
        ? new Date(Date.now() + 3 * 60 * 1000)
        : null;

      const normalizedIntakeSource = await normalizeSource(config.tenantId, row.source || "Unknown");
      const [lead] = await db.insert(leadsTable).values({
        tenantId: config.tenantId,
        firstName: row.firstName || "Unknown",
        lastName: row.lastName || "",
        phone: row.phone || null,
        email: row.email || null,
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
                notes: `System: Lead visibility delayed 3 minutes (auto-book window)`,
              });
            }
          } else if (!result.assignedCsrId) {
            console.warn(`[SheetsIngest] Lead ${lead.id} not assigned: ${result.reason}`);
          }
        } catch (err) {
          console.warn("[SheetsIngest] Auto-assign failed for lead", lead.id, err);
        }
      }
      newLeads.push(lead);
      imported++;
    }

    for (const lead of newLeads) {
      scheduleOrEmitNewLead(lead.id, (lead.visibleAfter as Date | null) ?? null);
    }

    for (const leadId of resubmittedLeadIds) {
      const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
      if (refreshed) emitLeadUpdated(config.tenantId, refreshed as unknown as Record<string, unknown>);
    }

    res.json({
      imported,
      skipped,
      resubmitted,
      noFunnelSkipped,
      total: rows.length,
      message: `Imported ${imported} leads, skipped ${skipped} duplicates${noFunnelSkipped > 0 ? ` (${noFunnelSkipped} had no matching funnel)` : ""}`,
    });
  } catch (err) {
    console.error("[GoogleSheets Ingest] Error:", err);
    const message = err instanceof Error ? err.message : "Failed to read Google Sheet";
    res.status(500).json({ error: message });
  }
});

router.get("/sheet-configs/:configId/preview", requireRole("super_admin", "agency_user", "client_admin"), async (req, res): Promise<void> => {
  const configId = parseInt(String(req.params.configId));

  const [config] = await db.select().from(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.id, configId));

  if (!config) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  const role = (req.session as unknown as Record<string, unknown>).userRole as string;
  if (role === "client_admin" || role === "client_user") {
    const sessionTenantId = (req.session as unknown as Record<string, unknown>).tenantId as number | undefined;
    if (sessionTenantId !== config.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  try {
    const { headers: rawHeaders, rawRows } = await readRawSheetData(config.googleSheetId, config.googleSheetTab);

    const sampleRows = rawRows.slice(0, 5).map(row => {
      const obj: Record<string, string> = {};
      rawHeaders.forEach((h, i) => { obj[h] = row[i] || ""; });
      return obj;
    });

    let headersChanged = false;
    if (config.mappingHeaders) {
      headersChanged = !headersMatch(rawHeaders, config.mappingHeaders as string[]);
    }

    res.json({
      headers: rawHeaders,
      sampleRows,
      totalRows: rawRows.length,
      hasMapping: !!config.columnMapping,
      headersChanged,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read Google Sheet";
    res.status(500).json({ error: message });
  }
});

const LEAD_DB_FIELDS = new Set([
  "firstName", "lastName", "fullName", "phone", "email",
  "source", "serviceType", "status", "dateTime", "appointmentBooked",
  "address", "city", "state", "zip", "appointmentDate", "appointmentTime", "addOns",
  "__skip__", "__funnel__",
]);

router.post("/sheet-configs/:configId/backfill-notes", requireRole("super_admin", "agency_user", "client_admin"), async (req, res) => {
  const configId = parseInt(String(req.params.configId));

  const [config] = await db.select().from(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.id, configId));

  if (!config?.columnMapping || !config?.mappingHeaders) {
    res.status(400).json({ error: "No sheet mapping configured" }); return;
  }

  const role = (req.session as unknown as Record<string, unknown>).userRole as string;
  if (role === "client_admin") {
    const sessionTenantId = (req.session as unknown as Record<string, unknown>).tenantId as number | undefined;
    if (sessionTenantId !== config.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  try {
    const { headers, rawRows } = await readRawSheetData(config.googleSheetId, config.googleSheetTab);
    const mapping = config.columnMapping as Record<string, string>;

    const existingLeads = await db.select({
      id: leadsTable.id,
      phone: leadsTable.phone,
    }).from(leadsTable)
      .where(eq(leadsTable.tenantId, config.tenantId));

    const leadByPhone = new Map<string, number>();
    for (const l of existingLeads) {
      if (l.phone) leadByPhone.set(l.phone.replace(/[^0-9]/g, ""), l.id);
    }

    let updated = 0;
    for (const row of rawRows) {
      const notesParts: string[] = [];
      let rowPhone = "";
      for (let j = 0; j < headers.length; j++) {
        const headerKey = headers[j];
        const normalized = mapping[headerKey] || headerKey;
        const val = (row[j] || "").trim();
        if (normalized === "phone" && val) {
          rowPhone = val.replace(/[^0-9]/g, "");
        }
        if (!val || normalized === "__skip__" || normalized === "__funnel__") continue;
        if (normalized === "notes" || !LEAD_DB_FIELDS.has(normalized)) {
          notesParts.push(`${headerKey}: ${val}`);
        }
      }

      if (notesParts.length === 0 || !rowPhone) continue;

      const leadId = leadByPhone.get(rowPhone);
      if (!leadId) continue;

      await db.update(leadsTable)
        .set({ notes: notesParts.join("\n") })
        .where(eq(leadsTable.id, leadId));
      updated++;
    }

    res.json({ updated, total: existingLeads.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backfill failed";
    res.status(500).json({ error: message });
  }
});

router.post("/sheet-configs/:configId/toggle-sync-pause", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const configId = parseInt(String(req.params.configId));

  const [updated] = await db.update(googleSheetConfigsTable)
    .set({ syncPaused: sql`NOT ${googleSheetConfigsTable.syncPaused}`, updatedAt: new Date() })
    .where(eq(googleSheetConfigsTable.id, configId))
    .returning({ syncPaused: googleSheetConfigsTable.syncPaused });

  if (!updated) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  res.json({ syncPaused: updated.syncPaused });
});

export default router;
