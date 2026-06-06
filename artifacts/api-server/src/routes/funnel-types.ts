import { Router, type IRouter } from "express";
import { db, funnelTypesTable, tenantFunnelTypesTable, tenantsTable, changeLogsTable, funnelRunsTable } from "@workspace/db";
import { eq, and, desc, inArray, sql, type SQL } from "drizzle-orm";

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

const RUN_STATUSES = new Set(["active", "ended", "archived"]);

function parseOptionalNumber(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseDateInput(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function parseRunStatus(raw: unknown): "active" | "ended" | "archived" | null {
  if (typeof raw !== "string" || !RUN_STATUSES.has(raw)) return null;
  return raw as "active" | "ended" | "archived";
}

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

router.get("/funnel-runs", async (req, res) => {
  const queryTenantId = parseOptionalNumber(req.query.tenantId);
  const queryFunnelTypeId = parseOptionalNumber(req.query.funnelTypeId);
  const queryStatus = typeof req.query.status === "string" ? req.query.status : null;

  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

  const conditions: SQL[] = [];
  if (tenantId) conditions.push(sql`fr.tenant_id = ${tenantId}`);
  if (queryFunnelTypeId) conditions.push(sql`fr.funnel_type_id = ${queryFunnelTypeId}`);
  if (queryStatus && queryStatus !== "all") {
    if (!RUN_STATUSES.has(queryStatus)) {
      res.status(400).json({ error: "Invalid run status" });
      return;
    }
    conditions.push(sql`fr.status = ${queryStatus}`);
  } else {
    conditions.push(sql`fr.status <> 'archived'`);
  }

  const whereClause = conditions.length > 0
    ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
    : sql``;

  const result = await db.execute(sql`
    WITH run_base AS (
      SELECT
        fr.id,
        fr.tenant_id,
        t.name AS tenant_name,
        fr.funnel_type_id,
        ft.name AS funnel_name,
        ft.slug AS funnel_slug,
        fr.name,
        fr.start_date,
        fr.end_date,
        COALESCE(fr.end_date, CURRENT_DATE) AS effective_end_date,
        fr.status,
        fr.notes,
        fr.created_at,
        fr.updated_at
      FROM funnel_runs fr
      JOIN tenants t ON t.id = fr.tenant_id
      JOIN funnel_types ft ON ft.id = fr.funnel_type_id
      ${whereClause}
    ),
    activity_days AS (
      SELECT rb.id AS run_id, l.created_at::date AS activity_day
      FROM run_base rb
      JOIN leads l
        ON l.tenant_id = rb.tenant_id
        AND (
          l.funnel_id = rb.funnel_type_id
          OR (
            l.funnel_id IS NULL
            AND l.lead_type IS NOT NULL
            AND LOWER(TRIM(l.lead_type)) = LOWER(TRIM(rb.funnel_name))
          )
        )
        AND l.created_at::date >= rb.start_date
        AND l.created_at::date <= rb.effective_end_date

      UNION

      SELECT rb.id AS run_id, mads.date AS activity_day
      FROM run_base rb
      JOIN campaigns c
        ON c.tenant_id = rb.tenant_id
        AND c.platform = 'meta'
      JOIN meta_ad_daily_stats mads
        ON mads.tenant_id = rb.tenant_id
        AND mads.campaign_external_id = c.external_id
        AND mads.date >= rb.start_date
        AND mads.date <= rb.effective_end_date
      LEFT JOIN campaign_funnel_mappings ad_cfm
        ON ad_cfm.tenant_id = rb.tenant_id
        AND ad_cfm.campaign_id = c.id
        AND ad_cfm.ad_set_external_id = mads.ad_set_external_id
      LEFT JOIN campaign_funnel_mappings campaign_cfm
        ON campaign_cfm.tenant_id = rb.tenant_id
        AND campaign_cfm.campaign_id = c.id
        AND campaign_cfm.ad_set_external_id IS NULL
      WHERE COALESCE(ad_cfm.funnel_type_id, campaign_cfm.funnel_type_id) = rb.funnel_type_id
        AND (
          COALESCE(mads.spend, 0) > 0
          OR COALESCE(mads.conversions, 0) > 0
        )
    ),
    active_days AS (
      SELECT run_id, COUNT(DISTINCT activity_day)::int AS active_days
      FROM activity_days
      GROUP BY run_id
    )
    SELECT
      rb.id,
      rb.tenant_id AS "tenantId",
      rb.tenant_name AS "tenantName",
      rb.funnel_type_id AS "funnelTypeId",
      rb.funnel_name AS "funnelName",
      rb.funnel_slug AS "funnelSlug",
      rb.name,
      rb.start_date AS "startDate",
      rb.end_date AS "endDate",
      rb.status,
      rb.notes,
      COALESCE(ad.active_days, 0)::int AS "activeDays",
      rb.created_at AS "createdAt",
      rb.updated_at AS "updatedAt"
    FROM run_base rb
    LEFT JOIN active_days ad ON ad.run_id = rb.id
    ORDER BY rb.start_date DESC, rb.id DESC
  `);

  res.json((result as unknown as { rows?: unknown[] }).rows ?? []);
});

router.post("/funnel-runs", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const tenantId = Number(req.body?.tenantId);
  const funnelTypeId = Number(req.body?.funnelTypeId);
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const startDate = parseDateInput(req.body?.startDate);
  const endDate = req.body?.endDate ? parseDateInput(req.body.endDate) : null;
  const status = parseRunStatus(req.body?.status) ?? "active";
  const notes = typeof req.body?.notes === "string" && req.body.notes.trim() ? req.body.notes.trim() : null;

  if (!Number.isFinite(tenantId) || !Number.isFinite(funnelTypeId) || !startDate) {
    res.status(400).json({ error: "tenantId, funnelTypeId, and startDate are required" });
    return;
  }
  if (endDate && endDate < startDate) {
    res.status(400).json({ error: "End date must be after the start date" });
    return;
  }

  const access = assertResourceTenantAccess(req, res, tenantId);
  if (!access.ok) return;

  const [tenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  const [funnel] = await db.select({ id: funnelTypesTable.id, name: funnelTypesTable.name })
    .from(funnelTypesTable)
    .where(eq(funnelTypesTable.id, funnelTypeId));
  if (!funnel) { res.status(404).json({ error: "Funnel type not found" }); return; }

  await db.insert(tenantFunnelTypesTable).values({ tenantId, funnelTypeId }).onConflictDoNothing();

  const [run] = await db.insert(funnelRunsTable).values({
    tenantId,
    funnelTypeId,
    name: name || `${funnel.name} run`,
    startDate,
    endDate,
    status,
    notes,
    createdByUserId: req.session.userId ?? null,
    updatedByUserId: req.session.userId ?? null,
  }).returning();
  res.status(201).json(run);
});

router.put("/funnel-runs/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid run id" }); return; }

  const [existing] = await db.select({
    tenantId: funnelRunsTable.tenantId,
    startDate: funnelRunsTable.startDate,
    endDate: funnelRunsTable.endDate,
  }).from(funnelRunsTable).where(eq(funnelRunsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Funnel run not found" }); return; }

  const access = assertResourceTenantAccess(req, res, existing.tenantId);
  if (!access.ok) return;

  const updates: Partial<typeof funnelRunsTable.$inferInsert> = {
    updatedAt: new Date(),
    updatedByUserId: req.session.userId ?? null,
  };

  if (req.body?.tenantId !== undefined || req.body?.funnelTypeId !== undefined) {
    res.status(400).json({ error: "Move a run by archiving it and creating a new one" });
    return;
  }
  if (req.body?.name !== undefined) {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) { res.status(400).json({ error: "Run name is required" }); return; }
    updates.name = name;
  }
  if (req.body?.startDate !== undefined) {
    const startDate = parseDateInput(req.body.startDate);
    if (!startDate) { res.status(400).json({ error: "Invalid start date" }); return; }
    updates.startDate = startDate;
  }
  if (req.body?.endDate !== undefined) {
    updates.endDate = req.body.endDate ? parseDateInput(req.body.endDate) : null;
    if (req.body.endDate && !updates.endDate) { res.status(400).json({ error: "Invalid end date" }); return; }
  }
  if (req.body?.status !== undefined) {
    const status = parseRunStatus(req.body.status);
    if (!status) { res.status(400).json({ error: "Invalid run status" }); return; }
    updates.status = status;
  }
  if (req.body?.notes !== undefined) {
    updates.notes = typeof req.body.notes === "string" && req.body.notes.trim() ? req.body.notes.trim() : null;
  }
  const nextStartDate = updates.startDate ?? existing.startDate;
  const nextEndDate = updates.endDate === undefined ? existing.endDate : updates.endDate;
  if (nextEndDate && nextEndDate < nextStartDate) {
    res.status(400).json({ error: "End date must be after the start date" });
    return;
  }

  const [run] = await db.update(funnelRunsTable).set(updates).where(eq(funnelRunsTable.id, id)).returning();
  res.json(run);
});

router.delete("/funnel-runs/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid run id" }); return; }

  const [existing] = await db.select({ tenantId: funnelRunsTable.tenantId }).from(funnelRunsTable).where(eq(funnelRunsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Funnel run not found" }); return; }

  const access = assertResourceTenantAccess(req, res, existing.tenantId);
  if (!access.ok) return;

  await db.update(funnelRunsTable)
    .set({ status: "archived", updatedAt: new Date(), updatedByUserId: req.session.userId ?? null })
    .where(eq(funnelRunsTable.id, id));
  res.json({ success: true });
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
