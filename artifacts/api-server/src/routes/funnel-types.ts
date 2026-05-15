import { Router, type IRouter } from "express";
import { db, funnelTypesTable, tenantFunnelTypesTable, tenantsTable, changeLogsTable } from "@workspace/db";
import { eq, and, desc, inArray, sql } from "drizzle-orm";

import { requireRole } from "../middleware/auth";
import { resolveListTenantScope, assertResourceTenantAccess } from "../lib/tenant-scope";
import { parseSpiffConfig } from "./sales-manager";

export async function flagStaleSpiffMappingsForRename(oldName: string, newName: string): Promise<number> {
  if (!oldName || oldName === newName) return 0;
  const affected = await db.select({ id: tenantsTable.id, spiffConfig: tenantsTable.spiffConfig })
    .from(tenantsTable)
    .where(sql`${tenantsTable.spiffConfig}->'byFunnel' ? ${oldName}`);
  if (affected.length === 0) return 0;
  const today = new Date().toISOString().split("T")[0];
  const rows = affected
    .filter(t => oldName in parseSpiffConfig(t.spiffConfig).byFunnel)
    .map(t => ({
      tenantId: t.id,
      date: today,
      title: `Stale spiff override: "${oldName}"`,
      description: `Funnel "${oldName}" was renamed to "${newName}". The spiff override for "${oldName}" no longer matches a live funnel and is paying the default amount until you rename or remove it in Sales Manager → Settings → Spiff Configuration.`,
      category: "spiff-stale",
    }));
  if (rows.length === 0) return 0;
  await db.insert(changeLogsTable).values(rows);
  return rows.length;
}

const router: IRouter = Router();

router.get("/funnel-types", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

  if (tenantId) {
    const associations = await db.select({ funnelTypeId: tenantFunnelTypesTable.funnelTypeId })
      .from(tenantFunnelTypesTable)
      .where(eq(tenantFunnelTypesTable.tenantId, tenantId));
    const ids = associations.map(a => a.funnelTypeId);
    if (ids.length === 0) { res.json([]); return; }
    const types = await db.select().from(funnelTypesTable)
      .where(inArray(funnelTypesTable.id, ids))
      .orderBy(desc(funnelTypesTable.createdAt));
    res.json(types);
  } else {
    const types = await db.select().from(funnelTypesTable).orderBy(desc(funnelTypesTable.createdAt));
    res.json(types);
  }
});

router.post("/funnel-types", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const { name, slug, description } = req.body;
  if (!name || !slug) {
    res.status(400).json({ error: "name and slug are required" });
    return;
  }
  const normalizedSlug = slug.toLowerCase().replace(/\s+/g, "-");
  const [existing] = await db.select({ id: funnelTypesTable.id }).from(funnelTypesTable)
    .where(eq(funnelTypesTable.slug, normalizedSlug));
  if (existing) {
    res.status(409).json({ error: `A funnel type with slug "${normalizedSlug}" already exists` });
    return;
  }
  const [ft] = await db.insert(funnelTypesTable).values({
    name,
    slug: normalizedSlug,
    description: description || null,
  }).returning();
  res.status(201).json(ft);
});

router.put("/funnel-types/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  const { name, description, isActive } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (isActive !== undefined) updates.isActive = isActive;

  let oldName: string | null = null;
  if (name !== undefined) {
    const [existing] = await db.select({ name: funnelTypesTable.name })
      .from(funnelTypesTable).where(eq(funnelTypesTable.id, id));
    oldName = existing?.name ?? null;
  }

  const [ft] = await db.update(funnelTypesTable).set(updates).where(eq(funnelTypesTable.id, id)).returning();
  if (!ft) { res.status(404).json({ error: "Funnel type not found" }); return; }

  if (oldName && name && oldName !== name) {
    try {
      await flagStaleSpiffMappingsForRename(oldName, name);
    } catch (err) {
      console.error("[funnel-types] Failed to flag stale spiff mappings:", err);
    }
  }

  res.json(ft);
});

router.delete("/funnel-types/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  const [ft] = await db.delete(funnelTypesTable).where(eq(funnelTypesTable.id, id)).returning();
  if (!ft) { res.status(404).json({ error: "Funnel type not found" }); return; }
  res.json({ success: true });
});

router.post("/tenants/:id/funnel-types", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.id));
  const { funnelTypeId } = req.body;
  if (!funnelTypeId) { res.status(400).json({ error: "funnelTypeId is required" }); return; }

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  const [ft] = await db.select().from(funnelTypesTable).where(eq(funnelTypesTable.id, funnelTypeId));
  if (!ft) { res.status(404).json({ error: "Funnel type not found" }); return; }

  await db.insert(tenantFunnelTypesTable).values({
    tenantId,
    funnelTypeId,
  }).onConflictDoNothing();
  res.status(201).json({ tenantId, funnelTypeId });
});

router.delete("/tenants/:id/funnel-types/:funnelTypeId", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.id));
  const funnelTypeId = parseInt(String(req.params.funnelTypeId));

  await db.delete(tenantFunnelTypesTable)
    .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId)));
  res.json({ success: true });
});

router.get("/tenants/:id/funnel-types", async (req, res) => {
  const tenantId = parseInt(String(req.params.id));
  if (Number.isNaN(tenantId)) {
    res.status(400).json({ error: "Invalid tenant id" });
    return;
  }
  // Path-resolved resource: tenant-scoped roles may only read their
  // own tenant's funnel-type associations. enforceTenantScope does
  // not guard the `:id` param here.
  const access = assertResourceTenantAccess(req, res, tenantId);
  if (!access.ok) return;
  const associations = await db.select({
    funnelTypeId: tenantFunnelTypesTable.funnelTypeId,
  })
    .from(tenantFunnelTypesTable)
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId));
  const ids = associations.map(a => a.funnelTypeId);
  if (ids.length === 0) { res.json([]); return; }
  const types = await db.select().from(funnelTypesTable)
    .where(inArray(funnelTypesTable.id, ids))
    .orderBy(funnelTypesTable.name);
  res.json(types);
});

export default router;
