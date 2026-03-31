import { Router, type IRouter } from "express";
import { db, googleSheetConfigsTable, funnelTypesTable, tenantFunnelTypesTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { readRawSheetData } from "../services/integrations/google-sheets";

const router: IRouter = Router();

router.get("/tenants/:tenantId/sheet-configs", requireRole("super_admin", "agency_user", "client_admin"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.tenantId));

  const role = (req.session as unknown as Record<string, unknown>).userRole as string;
  if (role === "client_admin") {
    const sessionTenantId = (req.session as unknown as Record<string, unknown>).tenantId as number | undefined;
    if (sessionTenantId !== tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  const configs = await db.select().from(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.tenantId, tenantId))
    .orderBy(googleSheetConfigsTable.createdAt);

  const funnelIds = configs
    .map(c => c.defaultFunnelTypeId)
    .filter((id): id is number => id !== null);

  let funnelMap: Record<number, { id: number; name: string; slug: string }> = {};
  if (funnelIds.length > 0) {
    const funnels = await db.select({
      id: funnelTypesTable.id,
      name: funnelTypesTable.name,
      slug: funnelTypesTable.slug,
    }).from(funnelTypesTable).where(inArray(funnelTypesTable.id, funnelIds));
    for (const f of funnels) {
      funnelMap[f.id] = f;
    }
  }

  const enriched = configs.map(c => ({
    ...c,
    defaultFunnel: c.defaultFunnelTypeId ? funnelMap[c.defaultFunnelTypeId] || null : null,
  }));

  res.json(enriched);
});

router.post("/tenants/:tenantId/sheet-configs", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.tenantId));
  const { name, googleSheetId, googleSheetTab, defaultFunnelTypeId } = req.body;

  if (!name || !googleSheetId || !googleSheetTab) {
    res.status(400).json({ error: "name, googleSheetId, and googleSheetTab are required" });
    return;
  }

  if (defaultFunnelTypeId) {
    const [assoc] = await db.select().from(tenantFunnelTypesTable)
      .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, defaultFunnelTypeId)));
    if (!assoc) {
      res.status(400).json({ error: "Default funnel type is not associated with this tenant" });
      return;
    }
  }

  const [config] = await db.insert(googleSheetConfigsTable).values({
    tenantId,
    name,
    googleSheetId,
    googleSheetTab,
    defaultFunnelTypeId: defaultFunnelTypeId || null,
  }).returning();

  res.status(201).json(config);
});

router.put("/sheet-configs/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  const { name, googleSheetId, googleSheetTab, defaultFunnelTypeId } = req.body;

  const [existing] = await db.select().from(googleSheetConfigsTable).where(eq(googleSheetConfigsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  if (defaultFunnelTypeId) {
    const [assoc] = await db.select().from(tenantFunnelTypesTable)
      .where(and(eq(tenantFunnelTypesTable.tenantId, existing.tenantId), eq(tenantFunnelTypesTable.funnelTypeId, defaultFunnelTypeId)));
    if (!assoc) {
      res.status(400).json({ error: "Default funnel type is not associated with this tenant" });
      return;
    }
  }

  const newSheetId = googleSheetId !== undefined ? googleSheetId : existing.googleSheetId;
  const newSheetTab = googleSheetTab !== undefined ? googleSheetTab : existing.googleSheetTab;
  const sheetChanged = newSheetId !== existing.googleSheetId || newSheetTab !== existing.googleSheetTab;

  const updates: Partial<typeof googleSheetConfigsTable.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (name !== undefined) updates.name = name;
  if (googleSheetId !== undefined) updates.googleSheetId = googleSheetId;
  if (googleSheetTab !== undefined) updates.googleSheetTab = googleSheetTab;
  if (defaultFunnelTypeId !== undefined) updates.defaultFunnelTypeId = defaultFunnelTypeId || null;

  if (sheetChanged) {
    updates.columnMapping = null;
    updates.mappingHeaders = null;
    updates.syncRowWatermark = null;
    updates.funnelColumn = null;
    updates.funnelValueMap = null;
  }

  const [updated] = await db.update(googleSheetConfigsTable)
    .set(updates)
    .where(eq(googleSheetConfigsTable.id, id))
    .returning();

  res.json(updated);
});

router.delete("/sheet-configs/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  const [deleted] = await db.delete(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.id, id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  res.json({ success: true });
});

router.post("/sheet-configs/:configId/funnel-value-map", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const configId = parseInt(String(req.params.configId));
  const { funnelColumn, funnelValueMap } = req.body as {
    funnelColumn: string;
    funnelValueMap: Record<string, number>;
  };

  if (!funnelColumn || !funnelValueMap || typeof funnelValueMap !== "object") {
    res.status(400).json({ error: "funnelColumn and funnelValueMap are required" });
    return;
  }

  const [config] = await db.select().from(googleSheetConfigsTable).where(eq(googleSheetConfigsTable.id, configId));
  if (!config) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  const funnelTypeIds = [...new Set(Object.values(funnelValueMap))];
  if (funnelTypeIds.length > 0) {
    const tenantAssocs = await db.select({ funnelTypeId: tenantFunnelTypesTable.funnelTypeId })
      .from(tenantFunnelTypesTable)
      .where(and(
        eq(tenantFunnelTypesTable.tenantId, config.tenantId),
        inArray(tenantFunnelTypesTable.funnelTypeId, funnelTypeIds),
      ));
    const validIds = new Set(tenantAssocs.map(a => a.funnelTypeId));
    for (const [value, ftId] of Object.entries(funnelValueMap)) {
      if (!validIds.has(ftId)) {
        res.status(400).json({ error: `Funnel type ID ${ftId} (for value "${value}") is not associated with this tenant` });
        return;
      }
    }
  }

  const [updated] = await db.update(googleSheetConfigsTable)
    .set({ funnelColumn, funnelValueMap, updatedAt: new Date() })
    .where(eq(googleSheetConfigsTable.id, configId))
    .returning();

  res.json(updated);
});

router.get("/sheet-configs/:configId/column-values/:headerName", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const configId = parseInt(String(req.params.configId));
  const headerName = req.params.headerName;

  const [config] = await db.select().from(googleSheetConfigsTable).where(eq(googleSheetConfigsTable.id, configId));
  if (!config) {
    res.status(404).json({ error: "Sheet config not found" });
    return;
  }

  try {
    const { headers, rawRows } = await readRawSheetData(config.googleSheetId, config.googleSheetTab);
    const headerIndex = headers.indexOf(headerName);
    if (headerIndex === -1) {
      res.status(400).json({ error: `Header "${headerName}" not found in sheet` });
      return;
    }

    const uniqueValues = new Set<string>();
    for (const row of rawRows) {
      const val = (row[headerIndex] || "").trim();
      if (val) uniqueValues.add(val);
    }

    res.json({ values: [...uniqueValues].sort(), totalRows: rawRows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read sheet";
    res.status(500).json({ error: message });
  }
});

export default router;
