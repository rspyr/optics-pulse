import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, funnelAliasesTable, funnelTypesTable, tenantFunnelTypesTable, googleSheetConfigsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { invalidateFunnelCache } from "../services/funnel-normalizer";

const router: IRouter = Router();

function requireManagerRole(req: Request, res: Response, next: NextFunction) {
  const role = (req.session as Record<string, unknown>)?.userRole as string | undefined;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied. Requires manager role." });
    return;
  }
  next();
}

function resolveTenantId(req: Request): number | null {
  const session = req.session as Record<string, unknown>;
  const role = session?.userRole as string | undefined;
  if (role === "super_admin" || role === "agency_user") {
    return req.query.tenantId ? Number(req.query.tenantId) : (session.tenantId as number | null) ?? null;
  }
  return (session?.tenantId as number | null) ?? null;
}

router.use("/funnel-aliases", requireManagerRole);

router.get("/funnel-aliases", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ aliases: [] });
    return;
  }

  const rows = await db
    .select({
      id: funnelAliasesTable.id,
      alias: funnelAliasesTable.alias,
      funnelTypeId: funnelAliasesTable.funnelTypeId,
      funnelName: funnelTypesTable.name,
      createdAt: funnelAliasesTable.createdAt,
    })
    .from(funnelAliasesTable)
    .innerJoin(funnelTypesTable, eq(funnelAliasesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(funnelAliasesTable.tenantId, tenantId))
    .orderBy(funnelTypesTable.name, funnelAliasesTable.alias);

  const grouped: Record<number, { funnelTypeId: number; funnelName: string; aliases: { id: number; alias: string }[] }> = {};
  for (const row of rows) {
    if (!grouped[row.funnelTypeId]) {
      grouped[row.funnelTypeId] = { funnelTypeId: row.funnelTypeId, funnelName: row.funnelName, aliases: [] };
    }
    grouped[row.funnelTypeId].aliases.push({ id: row.id, alias: row.alias });
  }

  res.json({ aliases: Object.values(grouped) });
});

router.post("/funnel-aliases", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { funnelTypeId, alias } = req.body;
  if (!funnelTypeId || !alias) {
    res.status(400).json({ error: "funnelTypeId and alias are required" });
    return;
  }

  const trimmedAlias = alias.trim().toLowerCase();

  const funnelId = Number(funnelTypeId);
  const [tenantAssoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, funnelId)));
  if (!tenantAssoc) {
    res.status(400).json({ error: "Funnel type is not enabled for this tenant" });
    return;
  }

  const existing = await db.select().from(funnelAliasesTable)
    .where(and(
      eq(funnelAliasesTable.tenantId, tenantId),
      eq(funnelAliasesTable.alias, trimmedAlias)
    ));

  if (existing.length > 0) {
    res.status(409).json({ error: `Alias "${trimmedAlias}" is already mapped` });
    return;
  }

  const [row] = await db.insert(funnelAliasesTable).values({
    tenantId,
    funnelTypeId: funnelId,
    alias: trimmedAlias,
  }).returning();

  invalidateFunnelCache(tenantId);
  res.json({ alias: row });
});

router.post("/funnel-aliases/bulk", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { funnelTypeId, aliases } = req.body;
  if (!funnelTypeId || !Array.isArray(aliases) || aliases.length === 0) {
    res.status(400).json({ error: "funnelTypeId and aliases array are required" });
    return;
  }

  const results: { alias: string; status: string }[] = [];

  for (const a of aliases) {
    const trimmedAlias = String(a).trim().toLowerCase();
    if (!trimmedAlias) continue;

    const existing = await db.select().from(funnelAliasesTable)
      .where(and(
        eq(funnelAliasesTable.tenantId, tenantId),
        eq(funnelAliasesTable.alias, trimmedAlias)
      ));

    if (existing.length > 0) {
      results.push({ alias: trimmedAlias, status: "already mapped" });
      continue;
    }

    await db.insert(funnelAliasesTable).values({
      tenantId,
      funnelTypeId: Number(funnelTypeId),
      alias: trimmedAlias,
    });
    results.push({ alias: trimmedAlias, status: "created" });
  }

  invalidateFunnelCache(tenantId);
  res.json({ results });
});

router.delete("/funnel-aliases/:id", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const id = Number(req.params.id);
  const [deleted] = await db.delete(funnelAliasesTable)
    .where(and(eq(funnelAliasesTable.id, id), eq(funnelAliasesTable.tenantId, tenantId)))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Alias not found" });
    return;
  }

  invalidateFunnelCache(tenantId);
  res.json({ success: true });
});

router.post("/funnel-aliases/load-defaults", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const sheetConfigs = await db.select().from(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.tenantId, tenantId));

  if (sheetConfigs.length === 0) {
    res.status(404).json({ error: "No Google Sheet configurations found for this tenant" });
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const config of sheetConfigs) {
    const funnelValueMap = config.funnelValueMap as Record<string, number> | null;
    if (!funnelValueMap) continue;

    for (const [rawValue, funnelTypeId] of Object.entries(funnelValueMap)) {
      const trimmedAlias = rawValue.toLowerCase().trim();
      if (!trimmedAlias) continue;

      const existing = await db.select().from(funnelAliasesTable)
        .where(and(
          eq(funnelAliasesTable.tenantId, tenantId),
          eq(funnelAliasesTable.alias, trimmedAlias)
        ));

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      await db.insert(funnelAliasesTable).values({
        tenantId,
        funnelTypeId,
        alias: trimmedAlias,
      });
      created++;
    }
  }

  invalidateFunnelCache(tenantId);
  res.json({ created, skipped });
});

export default router;
