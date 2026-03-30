import { Router, type IRouter } from "express";
import { db, leadsTable, tenantFunnelTypesTable, funnelTypesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { readSheetRows, readRawSheetData } from "../services/integrations/google-sheets";
import { requireRole } from "../middleware/auth";
import { emitNewLead } from "../socket";
import { ai } from "@workspace/integrations-gemini-ai";

const router: IRouter = Router();

const INTERNAL_FIELDS = [
  { field: "firstName", label: "First Name", description: "Lead's first name" },
  { field: "lastName", label: "Last Name", description: "Lead's last name" },
  { field: "fullName", label: "Full Name", description: "Lead's full name (will be split into first/last)" },
  { field: "phone", label: "Phone", description: "Phone number" },
  { field: "email", label: "Email", description: "Email address" },
  { field: "source", label: "Lead Source", description: "Where the lead came from (e.g., Google, Facebook, referral)" },
  { field: "serviceType", label: "Service Type", description: "Type of HVAC service needed (e.g., Heat Pump, A/C, Furnace)" },
  { field: "status", label: "Status", description: "Lead status (e.g., new, contacted, booked)" },
  { field: "notes", label: "Notes", description: "Additional notes or comments about the lead" },
  { field: "appointmentBooked", label: "Appointment Booked", description: "Whether lead has a pre-booked appointment (yes/no)" },
  { field: "address", label: "Address", description: "Street address" },
  { field: "city", label: "City", description: "City" },
  { field: "state", label: "State", description: "State/province" },
  { field: "zip", label: "Zip Code", description: "Zip/postal code" },
  { field: "dateTime", label: "Date/Time", description: "Date/time timestamp (ISO 8601, e.g. 2026-02-11T20:57:57) — used as the lead's created date" },
  { field: "__skip__", label: "Skip (Do Not Import)", description: "Ignore this column" },
];

function headersMatch(current: string[], saved: string[]): boolean {
  if (current.length !== saved.length) return false;
  const currentSet = new Set(current);
  return saved.every(h => currentSet.has(h));
}

router.post("/google-sheets/analyze-mapping/:tenantId/:funnelTypeId", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.tenantId));
  const funnelTypeId = parseInt(String(req.params.funnelTypeId));

  const [assoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId)));

  if (!assoc?.googleSheetId || !assoc?.googleSheetTab) {
    res.status(400).json({ error: "Google Sheet not configured for this funnel" });
    return;
  }

  try {
    const { headers, rawRows } = await readRawSheetData(assoc.googleSheetId, assoc.googleSheetTab);
    if (headers.length === 0) {
      res.status(400).json({ error: "No headers found in sheet" });
      return;
    }

    const sampleData = rawRows.slice(0, 5).map(row => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ""; });
      return obj;
    });

    const prompt = `You are analyzing a Google Sheet from an HVAC marketing agency's client. The sheet contains lead data that needs to be mapped to internal fields.

SHEET HEADERS: ${JSON.stringify(headers)}

SAMPLE DATA (first ${sampleData.length} rows):
${JSON.stringify(sampleData, null, 2)}

INTERNAL FIELDS AVAILABLE:
${INTERNAL_FIELDS.map(f => `- "${f.field}": ${f.label} — ${f.description}`).join("\n")}

TASK: For each sheet header, determine which internal field it maps to. Return a JSON object where:
- Keys are the exact sheet header names (matching case)
- Values are objects with: "field" (internal field name), "confidence" (number 0-1)

Rules:
- Map columns that clearly correspond to internal fields
- Use "fullName" if a single column contains both first and last names
- Use "__skip__" for columns that don't map to any internal field (e.g., timestamps, IDs, internal notes)
- Confidence: 1.0 = exact/obvious match, 0.7-0.9 = likely match, 0.5-0.69 = uncertain, <0.5 = guess
- If a column header is ambiguous, look at the sample data to determine the best mapping
- Each internal field should only be mapped once (except __skip__)

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

router.post("/google-sheets/save-mapping/:tenantId/:funnelTypeId", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.tenantId));
  const funnelTypeId = parseInt(String(req.params.funnelTypeId));
  const { mapping, headers } = req.body as { mapping: Record<string, string>; headers: string[] };

  if (mapping === null && headers === null) {
    const clearResult = await db.update(tenantFunnelTypesTable)
      .set({ columnMapping: null, mappingHeaders: null, syncRowWatermark: null })
      .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId)));
    if (!clearResult.rowCount || clearResult.rowCount === 0) {
      res.status(404).json({ error: "Funnel type not associated with tenant" });
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

  const fieldAssignments = Object.values(mapping).filter(f => f !== "__skip__" && f !== "notes");
  const duplicates = fieldAssignments.filter((f, i) => fieldAssignments.indexOf(f) !== i);
  if (duplicates.length > 0) {
    res.status(400).json({ error: `Duplicate field assignment: "${[...new Set(duplicates)].join(", ")}" is mapped to multiple columns` });
    return;
  }

  const [assoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId)));

  if (!assoc) {
    res.status(404).json({ error: "Funnel type not associated with tenant" });
    return;
  }

  let watermark: number | null = null;
  if (assoc.googleSheetId && assoc.googleSheetTab) {
    try {
      const { rawRows } = await readRawSheetData(assoc.googleSheetId, assoc.googleSheetTab);
      watermark = rawRows.length;
    } catch (err) {
      console.error("[GoogleSheets Mapping] Failed to read sheet for watermark:", err);
      res.status(503).json({ error: "Unable to read sheet to initialize auto-sync. Please try again." });
      return;
    }
  }

  const result = await db.update(tenantFunnelTypesTable)
    .set({ columnMapping: mapping, mappingHeaders: headers, syncRowWatermark: watermark })
    .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId)));

  if (!result.rowCount || result.rowCount === 0) {
    res.status(404).json({ error: "Funnel type not associated with tenant" });
    return;
  }

  res.json({ success: true });
});

router.get("/google-sheets/mapping-status/:tenantId/:funnelTypeId", requireRole("super_admin", "agency_user", "client_admin"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.tenantId));
  const funnelTypeId = parseInt(String(req.params.funnelTypeId));

  const role = (req.session as unknown as Record<string, unknown>).userRole as string;
  if (role === "client_admin") {
    const sessionTenantId = (req.session as unknown as Record<string, unknown>).tenantId as number | undefined;
    if (sessionTenantId !== tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  const [assoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId)));

  if (!assoc) {
    res.status(404).json({ error: "Association not found" });
    return;
  }

  const hasMapping = !!assoc.columnMapping && !!assoc.mappingHeaders;
  let headersChanged = false;

  let verificationError = false;
  if (hasMapping && assoc.googleSheetId && assoc.googleSheetTab) {
    try {
      const { headers: currentHeaders } = await readRawSheetData(assoc.googleSheetId, assoc.googleSheetTab);
      headersChanged = !headersMatch(currentHeaders, assoc.mappingHeaders as string[]);
    } catch {
      verificationError = true;
    }
  }

  res.json({
    hasMapping,
    headersChanged,
    verificationError,
    columnMapping: assoc.columnMapping,
    mappingHeaders: assoc.mappingHeaders,
  });
});

router.post("/google-sheets/ingest/:tenantId/:funnelTypeId", requireRole("super_admin", "agency_user", "client_admin"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.tenantId));
  const funnelTypeId = parseInt(String(req.params.funnelTypeId));

  const role = (req.session as unknown as Record<string, unknown>).userRole as string;
  if (role === "client_admin" || role === "client_user") {
    const sessionTenantId = (req.session as unknown as Record<string, unknown>).tenantId as number | undefined;
    if (sessionTenantId !== tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  const [assoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(
      eq(tenantFunnelTypesTable.tenantId, tenantId),
      eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId),
    ));

  if (!assoc) {
    res.status(404).json({ error: "Funnel type not associated with tenant" });
    return;
  }

  if (!assoc.googleSheetId || !assoc.googleSheetTab) {
    res.status(400).json({ error: "Google Sheet ID or tab name not configured for this funnel" });
    return;
  }

  if (!assoc.columnMapping || !assoc.mappingHeaders) {
    res.status(400).json({
      error: "Column mapping has not been approved yet. Please analyze and approve the column mapping in Settings before importing.",
      mappingRequired: true,
    });
    return;
  }

  if (assoc.columnMapping && assoc.mappingHeaders) {
    try {
      const { headers: currentHeaders } = await readRawSheetData(assoc.googleSheetId, assoc.googleSheetTab);
      if (!headersMatch(currentHeaders, assoc.mappingHeaders as string[])) {
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
  }

  const [funnel] = await db.select().from(funnelTypesTable).where(eq(funnelTypesTable.id, funnelTypeId));

  try {
    const customMapping = assoc.columnMapping as Record<string, string> | null;
    const { rows } = await readSheetRows(assoc.googleSheetId, assoc.googleSheetTab, customMapping);

    if (rows.length === 0) {
      res.json({ imported: 0, skipped: 0, message: "No rows found in sheet" });
      return;
    }

    const existingPhones = new Set<string>();
    const existingLeads = await db.select({ phone: leadsTable.phone })
      .from(leadsTable)
      .where(eq(leadsTable.tenantId, tenantId));
    for (const l of existingLeads) {
      if (l.phone) existingPhones.add(l.phone.replace(/[^0-9]/g, ""));
    }

    let imported = 0;
    let skipped = 0;
    const newLeads: (typeof leadsTable.$inferSelect)[] = [];

    for (const row of rows) {
      const normalizedPhone = row.phone.replace(/[^0-9]/g, "");
      if (normalizedPhone && existingPhones.has(normalizedPhone)) {
        skipped++;
        continue;
      }

      if (!row.firstName && !row.lastName) {
        skipped++;
        continue;
      }

      if (normalizedPhone) existingPhones.add(normalizedPhone);

      let parsedCreatedAt: Date | undefined;
      if (row.dateTime) {
        const d = new Date(row.dateTime);
        if (!isNaN(d.getTime())) parsedCreatedAt = d;
      }

      const isPreBooked = (row.appointmentBooked || "").toLowerCase().trim() === "yes";

      const [lead] = await db.insert(leadsTable).values({
        tenantId,
        firstName: row.firstName || "Unknown",
        lastName: row.lastName || "",
        phone: row.phone || null,
        email: row.email || null,
        source: row.source || funnel?.name || "Google Sheet",
        serviceType: row.serviceType || null,
        notes: row.notes || null,
        funnelId: funnelTypeId,
        hubStatus: isPreBooked ? "appt_booked" : "day_1",
        dayInSequence: 1,
        status: isPreBooked ? "contacted" : "new",
        preBooked: isPreBooked,
        contactPreferences: [],
        ...(parsedCreatedAt ? { createdAt: parsedCreatedAt } : {}),
      }).returning();

      newLeads.push(lead);
      imported++;
    }

    for (const lead of newLeads) {
      emitNewLead(tenantId, lead as unknown as Record<string, unknown>);
    }

    res.json({
      imported,
      skipped,
      total: rows.length,
      message: `Imported ${imported} leads, skipped ${skipped} duplicates`,
    });
  } catch (err) {
    console.error("[GoogleSheets Ingest] Error:", err);
    const message = err instanceof Error ? err.message : "Failed to read Google Sheet";
    res.status(500).json({ error: message });
  }
});

router.get("/google-sheets/preview/:tenantId/:funnelTypeId", requireRole("super_admin", "agency_user", "client_admin"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.tenantId));
  const funnelTypeId = parseInt(String(req.params.funnelTypeId));

  const role = (req.session as unknown as Record<string, unknown>).userRole as string;
  if (role === "client_admin" || role === "client_user") {
    const sessionTenantId = (req.session as unknown as Record<string, unknown>).tenantId as number | undefined;
    if (sessionTenantId !== tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  const [assoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(
      eq(tenantFunnelTypesTable.tenantId, tenantId),
      eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId),
    ));

  if (!assoc?.googleSheetId || !assoc?.googleSheetTab) {
    res.status(400).json({ error: "Google Sheet not configured for this funnel" });
    return;
  }

  try {
    const { headers: rawHeaders, rawRows } = await readRawSheetData(assoc.googleSheetId, assoc.googleSheetTab);

    const sampleRows = rawRows.slice(0, 5).map(row => {
      const obj: Record<string, string> = {};
      rawHeaders.forEach((h, i) => { obj[h] = row[i] || ""; });
      return obj;
    });

    let headersChanged = false;
    if (assoc.mappingHeaders) {
      headersChanged = !headersMatch(rawHeaders, assoc.mappingHeaders as string[]);
    }

    res.json({
      headers: rawHeaders,
      sampleRows,
      totalRows: rawRows.length,
      hasMapping: !!assoc.columnMapping,
      headersChanged,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read Google Sheet";
    res.status(500).json({ error: message });
  }
});

const LEAD_DB_FIELDS = new Set([
  "firstName", "lastName", "fullName", "phone", "email",
  "source", "serviceType", "status", "dateTime", "appointmentBooked", "__skip__",
]);

router.post("/google-sheets/backfill-notes", requireRole("super_admin", "agency_user", "client_admin"), async (req, res) => {
  const tenantId = Number(req.query.tenantId);
  const funnelTypeId = Number(req.query.funnelTypeId);
  if (!tenantId || !funnelTypeId) { res.status(400).json({ error: "tenantId and funnelTypeId required" }); return; }

  const [assoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(
      eq(tenantFunnelTypesTable.tenantId, tenantId),
      eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId),
    ));

  if (!assoc?.googleSheetId || !assoc?.columnMapping || !assoc?.mappingHeaders) {
    res.status(400).json({ error: "No sheet mapping configured for this funnel" }); return;
  }

  try {
    const { headers, rawRows } = await readRawSheetData(assoc.googleSheetId, assoc.googleSheetTab || "Sheet1");
    const mapping = assoc.columnMapping as Record<string, string>;

    const existingLeads = await db.select({
      id: leadsTable.id,
      phone: leadsTable.phone,
    }).from(leadsTable)
      .where(and(eq(leadsTable.tenantId, tenantId), eq(leadsTable.funnelId, funnelTypeId)));

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
        if (!val || normalized === "__skip__") continue;
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

export default router;
