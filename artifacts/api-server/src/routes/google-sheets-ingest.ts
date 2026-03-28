import { Router, type IRouter } from "express";
import { db, leadsTable, tenantFunnelTypesTable, funnelTypesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { readSheetRows } from "../services/integrations/google-sheets";
import { requireRole } from "../middleware/auth";
import { emitNewLead } from "../socket";

const router: IRouter = Router();

router.post("/google-sheets/ingest/:tenantId/:funnelTypeId", requireRole("super_admin", "agency_user", "client_admin"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.tenantId));
  const funnelTypeId = parseInt(String(req.params.funnelTypeId));

  const [assoc] = await db.select({
    googleSheetId: tenantFunnelTypesTable.googleSheetId,
    googleSheetTab: tenantFunnelTypesTable.googleSheetTab,
  }).from(tenantFunnelTypesTable)
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

  const [funnel] = await db.select().from(funnelTypesTable).where(eq(funnelTypesTable.id, funnelTypeId));

  try {
    const { rows } = await readSheetRows(assoc.googleSheetId, assoc.googleSheetTab);

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
    const newLeads: any[] = [];

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

      const [lead] = await db.insert(leadsTable).values({
        tenantId,
        firstName: row.firstName || "Unknown",
        lastName: row.lastName || "",
        phone: row.phone || null,
        email: row.email || null,
        source: row.source || funnel?.name || "Google Sheet",
        serviceType: row.serviceType || null,
        funnelId: funnelTypeId,
        hubStatus: "day_1",
        dayInSequence: 1,
        status: "new",
        contactPreferences: [],
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

  const [assoc] = await db.select({
    googleSheetId: tenantFunnelTypesTable.googleSheetId,
    googleSheetTab: tenantFunnelTypesTable.googleSheetTab,
  }).from(tenantFunnelTypesTable)
    .where(and(
      eq(tenantFunnelTypesTable.tenantId, tenantId),
      eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId),
    ));

  if (!assoc?.googleSheetId || !assoc?.googleSheetTab) {
    res.status(400).json({ error: "Google Sheet not configured for this funnel" });
    return;
  }

  try {
    const { headers, rows } = await readSheetRows(assoc.googleSheetId, assoc.googleSheetTab);
    res.json({
      headers,
      sampleRows: rows.slice(0, 5),
      totalRows: rows.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read Google Sheet";
    res.status(500).json({ error: message });
  }
});

export default router;
