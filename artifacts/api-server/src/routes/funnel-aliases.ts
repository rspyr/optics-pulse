import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, funnelAliasesTable, funnelTypesTable, tenantFunnelTypesTable, googleSheetConfigsTable, attributionEventsTable, leadsTable, leadAttributionCorrectionsTable } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { invalidateFunnelCache } from "../services/funnel-normalizer";
import { readRawSheetData } from "../services/integrations/google-sheets";
import { reRouteLeadsAfterAttributionChange } from "../services/lead-rerouting";
import { assertResourceTenantAccess } from "../lib/tenant-scope";

// Re-resolve historical attribution events when a new funnel alias is saved.
// Two cases must update:
//   1. Rows whose stored resolved_funnel already equals the raw alias key
//      (ingested before the alias existed and left as the raw form value).
//   2. Rows whose resolved_funnel is null/empty (no prior alias match) but
//      whose form_fields jsonb contains a value matching the alias key —
//      these were saved with no canonical funnel and should adopt the new
//      mapping just like normalizeFunnel() would on the next ingest.
// Returns the number of rows updated.
async function reResolveFunnelForAlias(
  tenantId: number,
  aliasKey: string,
  canonicalFunnelName: string,
): Promise<number> {
  const key = aliasKey.toLowerCase().trim();
  if (!key) return 0;
  const result = await db.update(attributionEventsTable)
    .set({ resolvedFunnel: canonicalFunnelName })
    .where(and(
      eq(attributionEventsTable.tenantId, tenantId),
      sql`COALESCE(${attributionEventsTable.resolvedFunnel}, '') <> ${canonicalFunnelName}`,
      sql`(
        LOWER(TRIM(COALESCE(${attributionEventsTable.resolvedFunnel}, ''))) = ${key}
        OR (
          (${attributionEventsTable.resolvedFunnel} IS NULL OR TRIM(${attributionEventsTable.resolvedFunnel}) = '')
          AND ${attributionEventsTable.formFields} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM jsonb_each_text(${attributionEventsTable.formFields}) AS kv
            WHERE LOWER(TRIM(kv.value)) = ${key}
          )
        )
      )`,
    ))
    .returning({ id: attributionEventsTable.id });
  return result.length;
}

// Propagate the new alias mapping to the denormalized lead_type / funnel_id
// columns on existing leads so the Pulse Lead Hub (web + mobile) reflects
// the corrected funnel immediately. Matches leads whose current lead_type
// equals the alias key (case-insensitive); funnel_id is also rewritten so
// downstream funnel filters stay consistent. Tenant-scoped.
async function reResolveFunnelForLeads(
  tenantId: number,
  aliasKey: string,
  funnelTypeId: number,
  canonicalFunnelName: string,
  changedByUserId: number | null,
  funnelAliasId: number | null,
): Promise<number[]> {
  const key = aliasKey.toLowerCase().trim();
  if (!key) return [];
  // Snapshot rows first so we can write per-lead audit entries with the
  // pre-change funnel name; otherwise we'd lose what was overwritten.
  // Match leads two ways:
  //   1. Direct match on the denormalized leads.lead_type column.
  //   2. Linkage through attribution_events.created_lead_id where the
  //      event's resolved_funnel matched the alias key, OR any value in
  //      the event's form_fields jsonb matched the alias key (mirrors
  //      the OR-branch in reResolveFunnelForAlias above). This catches
  //      leads whose lead_type was populated from a different raw form
  //      value at ingest, but whose attribution event would have matched
  //      the alias if it had existed at the time.
  const matched = await db.select({ id: leadsTable.id, oldLeadType: leadsTable.leadType })
    .from(leadsTable)
    .where(and(
      eq(leadsTable.tenantId, tenantId),
      // Task #549: never overwrite per-lead funnel overrides during a
      // tenant-wide alias retag. The operator explicitly pinned this lead
      // ("Just this lead") and that decision must survive a later alias edit.
      sql`${leadsTable.funnelOverriddenAt} IS NULL`,
      sql`(
        COALESCE(${leadsTable.leadType}, '') <> ${canonicalFunnelName}
        OR ${leadsTable.funnelId} IS DISTINCT FROM ${funnelTypeId}
      )`,
      sql`(
        LOWER(TRIM(COALESCE(${leadsTable.leadType}, ''))) = ${key}
        OR ${leadsTable.id} IN (
          SELECT ae.created_lead_id FROM attribution_events ae
          WHERE ae.tenant_id = ${tenantId}
            AND ae.created_lead_id IS NOT NULL
            AND (
              LOWER(TRIM(COALESCE(ae.resolved_funnel, ''))) = ${key}
              OR (
                ae.form_fields IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM jsonb_each_text(ae.form_fields) AS kv
                  WHERE LOWER(TRIM(kv.value)) = ${key}
                )
              )
            )
        )
      )`,
    ));
  if (matched.length === 0) return [];
  const ids = matched.map(r => r.id);
  // Wrap update + audit insert in one transaction so a failed audit
  // never leaves leads silently overwritten without a paper trail.
  await db.transaction(async (tx) => {
    await tx.update(leadsTable)
      .set({ leadType: canonicalFunnelName, funnelId: funnelTypeId, updatedAt: new Date() })
      .where(and(eq(leadsTable.tenantId, tenantId), inArray(leadsTable.id, ids)));
    await tx.insert(leadAttributionCorrectionsTable).values(matched.map(m => ({
      tenantId,
      leadId: m.id,
      field: "funnel",
      oldValue: m.oldLeadType,
      newValue: canonicalFunnelName,
      changedByUserId,
      funnelAliasId,
    })));
  });
  return ids;
}

const router: IRouter = Router();

function requireManagerRole(req: Request, res: Response, next: NextFunction) {
  const role = req.session.userRole;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied. Requires manager role." });
    return;
  }
  next();
}

function resolveTenantId(req: Request): number | null {
  const session = req.session;
  const role = session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    return req.query.tenantId ? Number(req.query.tenantId) : session.tenantId ?? null;
  }
  return session.tenantId ?? null;
}

router.use("/funnel-aliases", requireManagerRole);

// Task #549: dry-run preview of what saving a tenant-wide funnel alias would
// retag. Lets the operator confirm scope before flipping every matching lead
// when they only meant to fix one lead's funnel. Mirrors the matching logic
// used by reResolveFunnelForAlias / reResolveFunnelForLeads (alias key
// matches resolved_funnel OR any value in form_fields), and excludes leads
// that already carry a per-lead override.
router.get("/funnel-aliases/preview", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }
  const aliasRaw = (req.query.alias ?? "").toString();
  const funnelTypeIdRaw = (req.query.funnelTypeId ?? "").toString();
  const key = aliasRaw.toLowerCase().trim();
  const funnelTypeId = Number(funnelTypeIdRaw);
  if (!key || !Number.isFinite(funnelTypeId) || funnelTypeId <= 0) {
    res.status(400).json({ error: "alias and funnelTypeId are required" });
    return;
  }

  const [funnelType] = await db.select({ name: funnelTypesTable.name })
    .from(funnelTypesTable).where(eq(funnelTypesTable.id, funnelTypeId));
  const canonicalName = funnelType?.name ?? "";

  const eventRes = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM attribution_events ae
    WHERE ae.tenant_id = ${tenantId}
      AND COALESCE(ae.resolved_funnel, '') <> ${canonicalName}
      AND (
        LOWER(TRIM(COALESCE(ae.resolved_funnel, ''))) = ${key}
        OR (
          (ae.resolved_funnel IS NULL OR TRIM(ae.resolved_funnel) = '')
          AND ae.form_fields IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM jsonb_each_text(ae.form_fields) AS kv
            WHERE LOWER(TRIM(kv.value)) = ${key}
          )
        )
      )
  `);
  const events = Number((eventRes.rows as { cnt: number }[])[0]?.cnt ?? 0);

  const leadRes = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM leads l
    WHERE l.tenant_id = ${tenantId}
      AND l.funnel_overridden_at IS NULL
      AND (
        COALESCE(l.lead_type, '') <> ${canonicalName}
        OR l.funnel_id IS DISTINCT FROM ${funnelTypeId}
      )
      AND (
        LOWER(TRIM(COALESCE(l.lead_type, ''))) = ${key}
        OR l.id IN (
          SELECT ae.created_lead_id FROM attribution_events ae
          WHERE ae.tenant_id = ${tenantId}
            AND ae.created_lead_id IS NOT NULL
            AND (
              LOWER(TRIM(COALESCE(ae.resolved_funnel, ''))) = ${key}
              OR (
                ae.form_fields IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM jsonb_each_text(ae.form_fields) AS kv
                  WHERE LOWER(TRIM(kv.value)) = ${key}
                )
              )
            )
        )
      )
  `);
  const leads = Number((leadRes.rows as { cnt: number }[])[0]?.cnt ?? 0);

  res.json({ events, leads, alias: key, funnelTypeId, canonicalName });
});

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
    // Alias already maps to the same funnel type → 200 no-op so the
    // operator's Save button doesn't error when nothing actually changes.
    // Different funnel type → 409 so we don't silently overwrite.
    if (existing[0].funnelTypeId === funnelId) {
      res.json({ alias: existing[0], updatedEventCount: 0, updatedLeadCount: 0 });
      return;
    }
    res.status(409).json({ error: `Alias "${trimmedAlias}" is already mapped to a different funnel type` });
    return;
  }

  const [row] = await db.insert(funnelAliasesTable).values({
    tenantId,
    funnelTypeId: funnelId,
    alias: trimmedAlias,
  }).returning();

  invalidateFunnelCache(tenantId);

  const [funnelType] = await db.select({ name: funnelTypesTable.name })
    .from(funnelTypesTable)
    .where(eq(funnelTypesTable.id, funnelId));
  const updatedEventCount = funnelType
    ? await reResolveFunnelForAlias(tenantId, trimmedAlias, funnelType.name)
    : 0;
  const updatedLeadIds = funnelType
    ? await reResolveFunnelForLeads(tenantId, trimmedAlias, funnelId, funnelType.name, req.session.userId ?? null, row.id)
    : [];
  const reroute = await reRouteLeadsAfterAttributionChange(tenantId, updatedLeadIds);
  res.json({ alias: row, updatedEventCount, updatedLeadCount: updatedLeadIds.length, reroute });
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

  const numericFunnelTypeId = Number(funnelTypeId);
  const [tenantAssoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(
      eq(tenantFunnelTypesTable.tenantId, tenantId),
      eq(tenantFunnelTypesTable.funnelTypeId, numericFunnelTypeId),
    ));
  if (!tenantAssoc) {
    res.status(400).json({ error: "Funnel type is not enabled for this tenant" });
    return;
  }

  const results: { alias: string; status: string }[] = [];
  const newlyCreatedAliases: { alias: string; id: number }[] = [];

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

    const [inserted] = await db.insert(funnelAliasesTable).values({
      tenantId,
      funnelTypeId: numericFunnelTypeId,
      alias: trimmedAlias,
    }).returning({ id: funnelAliasesTable.id });
    results.push({ alias: trimmedAlias, status: "created" });
    newlyCreatedAliases.push({ alias: trimmedAlias, id: inserted.id });
  }

  invalidateFunnelCache(tenantId);

  let updatedEventCount = 0;
  const allUpdatedLeadIds: number[] = [];
  if (newlyCreatedAliases.length > 0) {
    const [funnelType] = await db.select({ name: funnelTypesTable.name })
      .from(funnelTypesTable)
      .where(eq(funnelTypesTable.id, numericFunnelTypeId));
    if (funnelType) {
      for (const a of newlyCreatedAliases) {
        updatedEventCount += await reResolveFunnelForAlias(tenantId, a.alias, funnelType.name);
        const ids = await reResolveFunnelForLeads(tenantId, a.alias, numericFunnelTypeId, funnelType.name, req.session.userId ?? null, a.id);
        allUpdatedLeadIds.push(...ids);
      }
    }
  }
  const reroute = await reRouteLeadsAfterAttributionChange(tenantId, allUpdatedLeadIds);
  res.json({ results, updatedEventCount, updatedLeadCount: allUpdatedLeadIds.length, reroute });
});

router.delete("/funnel-aliases/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db.select().from(funnelAliasesTable)
    .where(eq(funnelAliasesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Alias not found" }); return; }

  const access = assertResourceTenantAccess(req, res, existing.tenantId, {
    notFoundOnMismatch: true, notFoundMessage: "Alias not found",
  });
  if (!access.ok) return;

  await db.delete(funnelAliasesTable).where(eq(funnelAliasesTable.id, id));

  invalidateFunnelCache(existing.tenantId);
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
    const columnMapping = config.columnMapping as Record<string, string> | null;
    if (!columnMapping) continue;

    const funnelColumns: string[] = [];
    const serviceTypeColumns: string[] = [];
    for (const [header, field] of Object.entries(columnMapping)) {
      if (field === "__funnel__") funnelColumns.push(header);
      if (field === "serviceType") serviceTypeColumns.push(header);
    }

    const relevantColumns = [...funnelColumns, ...serviceTypeColumns];
    if (relevantColumns.length === 0) continue;

    const defaultFunnelTypeId = config.defaultFunnelTypeId;
    if (!defaultFunnelTypeId) continue;

    try {
      const { headers, rawRows } = await readRawSheetData(config.googleSheetId, config.googleSheetTab);
      if (headers.length === 0) continue;

      const columnIndices = relevantColumns
        .map(col => headers.indexOf(col))
        .filter(i => i >= 0);

      if (columnIndices.length === 0) continue;

      const distinctValues = new Set<string>();
      for (const row of rawRows) {
        for (const idx of columnIndices) {
          const val = (row[idx] || "").trim().toLowerCase();
          if (val) distinctValues.add(val);
        }
      }

      const funnelValueMap = config.funnelValueMap as Record<string, number> | null;

      for (const alias of distinctValues) {
        const funnelTypeId = funnelValueMap?.[alias] ?? defaultFunnelTypeId;

        const existing = await db.select().from(funnelAliasesTable)
          .where(and(
            eq(funnelAliasesTable.tenantId, tenantId),
            eq(funnelAliasesTable.alias, alias)
          ));

        if (existing.length > 0) {
          skipped++;
          continue;
        }

        await db.insert(funnelAliasesTable).values({
          tenantId,
          funnelTypeId,
          alias,
        });
        created++;
      }
    } catch (err) {
      console.error(`[FunnelAliases] Failed to read sheet ${config.googleSheetId}:`, err);
    }
  }

  invalidateFunnelCache(tenantId);
  res.json({ created, skipped });
});

export default router;
