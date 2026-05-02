import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, leadSourceAliasesTable, attributionEventsTable, leadAttributionCorrectionsTable } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { invalidateSourceCache, DEFAULT_SOURCE_ALIASES, normalizeSource } from "../services/source-normalizer";
import { leadsTable } from "@workspace/db";

// Re-resolve historical attribution events when a new source alias is saved.
// Matches the same lower/trim rules normalizeSource() uses at ingest, so any
// existing row whose raw utm_source / referrer or already-resolved value
// matches the new alias key gets its resolved_lead_source flipped to the new
// canonical name. Returns the number of rows updated.
async function reResolveSourceForAlias(
  tenantId: number,
  aliasKey: string,
  canonicalName: string,
): Promise<number> {
  const key = aliasKey.toLowerCase().trim();
  if (!key) return 0;
  const result = await db.update(attributionEventsTable)
    .set({ resolvedLeadSource: canonicalName })
    .where(and(
      eq(attributionEventsTable.tenantId, tenantId),
      sql`(
        LOWER(TRIM(COALESCE(${attributionEventsTable.utmSource}, ''))) = ${key}
        OR LOWER(TRIM(COALESCE(${attributionEventsTable.referrer}, ''))) = ${key}
        OR LOWER(TRIM(COALESCE(${attributionEventsTable.resolvedLeadSource}, ''))) = ${key}
      )`,
      sql`COALESCE(${attributionEventsTable.resolvedLeadSource}, '') <> ${canonicalName}`,
    ))
    .returning({ id: attributionEventsTable.id });
  return result.length;
}

// Propagate the new alias mapping to the denormalized `leads.source`
// column so the Pulse Lead Hub (web + mobile) reflects the corrected
// canonical name immediately, without waiting for the manual
// /lead-source-aliases/backfill endpoint.
async function reResolveSourceForLeads(
  tenantId: number,
  aliasKey: string,
  canonicalName: string,
  changedByUserId: number | null,
  sourceAliasId: number | null,
): Promise<number> {
  const key = aliasKey.toLowerCase().trim();
  if (!key) return 0;
  // Snapshot the matching leads (with their pre-change source value) so
  // we can both update them and write per-lead audit rows that capture
  // the actual prior value, not just the alias key.
  const matched = await db.select({ id: leadsTable.id, oldSource: leadsTable.source })
    .from(leadsTable)
    .where(and(
      eq(leadsTable.tenantId, tenantId),
      sql`LOWER(TRIM(COALESCE(${leadsTable.source}, ''))) = ${key}`,
      sql`COALESCE(${leadsTable.source}, '') <> ${canonicalName}`,
    ));
  if (matched.length === 0) return 0;
  const ids = matched.map(r => r.id);
  // Wrap update + audit insert in one transaction so a failed audit
  // never leaves leads silently overwritten without a paper trail.
  await db.transaction(async (tx) => {
    await tx.update(leadsTable)
      .set({ source: canonicalName, updatedAt: new Date() })
      .where(and(eq(leadsTable.tenantId, tenantId), inArray(leadsTable.id, ids)));
    await tx.insert(leadAttributionCorrectionsTable).values(matched.map(m => ({
      tenantId,
      leadId: m.id,
      field: "source",
      oldValue: m.oldSource,
      newValue: canonicalName,
      changedByUserId,
      sourceAliasId,
    })));
  });
  return matched.length;
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

router.use("/lead-source-aliases", requireManagerRole);

router.get("/lead-source-aliases", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ aliases: [] });
    return;
  }

  const rows = await db.select().from(leadSourceAliasesTable)
    .where(eq(leadSourceAliasesTable.tenantId, tenantId))
    .orderBy(leadSourceAliasesTable.canonicalName, leadSourceAliasesTable.alias);

  const grouped: Record<string, { id: number; canonicalName: string; aliases: { id: number; alias: string }[] }> = {};
  for (const row of rows) {
    if (!grouped[row.canonicalName]) {
      grouped[row.canonicalName] = { id: row.id, canonicalName: row.canonicalName, aliases: [] };
    }
    grouped[row.canonicalName].aliases.push({ id: row.id, alias: row.alias });
  }

  res.json({ aliases: Object.values(grouped) });
});

router.post("/lead-source-aliases", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { canonicalName, alias } = req.body;
  if (!canonicalName || !alias) {
    res.status(400).json({ error: "canonicalName and alias are required" });
    return;
  }

  const trimmedAlias = alias.trim();
  const trimmedCanonical = canonicalName.trim();

  const existing = await db.select().from(leadSourceAliasesTable)
    .where(and(
      eq(leadSourceAliasesTable.tenantId, tenantId),
      eq(leadSourceAliasesTable.alias, trimmedAlias.toLowerCase())
    ));

  if (existing.length > 0) {
    if (existing[0].canonicalName === trimmedCanonical) {
      res.json({ alias: existing[0], updatedEventCount: 0, updatedLeadCount: 0 });
      return;
    }
    res.status(409).json({ error: `Alias "${trimmedAlias}" is already mapped to "${existing[0].canonicalName}" — did you mean "${existing[0].canonicalName}"?` });
    return;
  }

  const [row] = await db.insert(leadSourceAliasesTable).values({
    tenantId,
    canonicalName: trimmedCanonical,
    alias: trimmedAlias.toLowerCase(),
  }).returning();

  invalidateSourceCache(tenantId);
  const updatedEventCount = await reResolveSourceForAlias(tenantId, trimmedAlias, trimmedCanonical);
  const updatedLeadCount = await reResolveSourceForLeads(tenantId, trimmedAlias, trimmedCanonical, req.session.userId ?? null, row.id);
  res.json({ alias: row, updatedEventCount, updatedLeadCount });
});

router.post("/lead-source-aliases/bulk", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { canonicalName, aliases } = req.body;
  if (!canonicalName || !Array.isArray(aliases) || aliases.length === 0) {
    res.status(400).json({ error: "canonicalName and aliases array are required" });
    return;
  }

  const trimmedCanonical = canonicalName.trim();
  const results: { alias: string; status: string }[] = [];
  const newlyCreatedAliases: { alias: string; id: number }[] = [];

  for (const a of aliases) {
    const trimmedAlias = String(a).trim();
    if (!trimmedAlias) continue;

    const existing = await db.select().from(leadSourceAliasesTable)
      .where(and(
        eq(leadSourceAliasesTable.tenantId, tenantId),
        eq(leadSourceAliasesTable.alias, trimmedAlias.toLowerCase())
      ));

    if (existing.length > 0) {
      results.push({ alias: trimmedAlias, status: `already mapped to "${existing[0].canonicalName}"` });
      continue;
    }

    const [inserted] = await db.insert(leadSourceAliasesTable).values({
      tenantId,
      canonicalName: trimmedCanonical,
      alias: trimmedAlias.toLowerCase(),
    }).returning({ id: leadSourceAliasesTable.id });
    results.push({ alias: trimmedAlias, status: "created" });
    newlyCreatedAliases.push({ alias: trimmedAlias, id: inserted.id });
  }

  invalidateSourceCache(tenantId);
  let updatedEventCount = 0;
  let updatedLeadCount = 0;
  for (const a of newlyCreatedAliases) {
    updatedEventCount += await reResolveSourceForAlias(tenantId, a.alias, trimmedCanonical);
    updatedLeadCount += await reResolveSourceForLeads(tenantId, a.alias, trimmedCanonical, req.session.userId ?? null, a.id);
  }
  res.json({ results, updatedEventCount, updatedLeadCount });
});

router.put("/lead-source-aliases/:id", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const id = Number(req.params.id);
  const { canonicalName, alias } = req.body;

  const updates: Record<string, string> = {};
  if (canonicalName) updates.canonicalName = canonicalName.trim();
  if (alias) updates.alias = alias.trim();

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  if (updates.alias) {
    updates.alias = updates.alias.toLowerCase();
    const existing = await db.select().from(leadSourceAliasesTable)
      .where(and(
        eq(leadSourceAliasesTable.tenantId, tenantId),
        eq(leadSourceAliasesTable.alias, updates.alias),
        sql`${leadSourceAliasesTable.id} != ${id}`
      ));

    if (existing.length > 0) {
      res.status(409).json({ error: `Alias "${updates.alias}" is already mapped to "${existing[0].canonicalName}"` });
      return;
    }
  }

  const [updated] = await db.update(leadSourceAliasesTable)
    .set(updates)
    .where(and(eq(leadSourceAliasesTable.id, id), eq(leadSourceAliasesTable.tenantId, tenantId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Alias not found" });
    return;
  }

  invalidateSourceCache(tenantId);
  res.json({ alias: updated });
});

router.delete("/lead-source-aliases/:id", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const id = Number(req.params.id);
  const [deleted] = await db.delete(leadSourceAliasesTable)
    .where(and(eq(leadSourceAliasesTable.id, id), eq(leadSourceAliasesTable.tenantId, tenantId)))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Alias not found" });
    return;
  }

  invalidateSourceCache(tenantId);
  res.json({ success: true });
});

router.delete("/lead-source-aliases/canonical/:name", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const canonicalName = decodeURIComponent(req.params.name);
  const deleted = await db.delete(leadSourceAliasesTable)
    .where(and(
      eq(leadSourceAliasesTable.tenantId, tenantId),
      eq(leadSourceAliasesTable.canonicalName, canonicalName)
    ))
    .returning();

  invalidateSourceCache(tenantId);
  res.json({ success: true, deletedCount: deleted.length });
});

router.post("/lead-source-aliases/load-defaults", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const group of DEFAULT_SOURCE_ALIASES) {
    for (const alias of group.aliases) {
      const existing = await db.select().from(leadSourceAliasesTable)
        .where(and(
          eq(leadSourceAliasesTable.tenantId, tenantId),
          eq(leadSourceAliasesTable.alias, alias.toLowerCase())
        ));

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      await db.insert(leadSourceAliasesTable).values({
        tenantId,
        canonicalName: group.canonicalName,
        alias: alias.toLowerCase(),
      });
      created++;
    }
  }

  invalidateSourceCache(tenantId);
  res.json({ created, skipped });
});

router.post("/lead-source-aliases/backfill", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const leads = await db.select({ id: leadsTable.id, source: leadsTable.source })
    .from(leadsTable)
    .where(eq(leadsTable.tenantId, tenantId));

  let updated = 0;
  for (const lead of leads) {
    const normalized = await normalizeSource(tenantId, lead.source);
    if (normalized !== lead.source) {
      await db.update(leadsTable)
        .set({ source: normalized, updatedAt: new Date() })
        .where(eq(leadsTable.id, lead.id));
      updated++;
    }
  }

  res.json({ totalLeads: leads.length, updated });
});

router.post("/lead-source-aliases/ensure-unknown", async (req, res) => {
  const role = req.session.userRole;
  if (role !== "super_admin") {
    res.status(403).json({ error: "Access denied. Requires super_admin role." });
    return;
  }

  const { tenantsTable } = await import("@workspace/db");
  const allTenantRows = await db.select({ id: tenantsTable.id }).from(tenantsTable);

  let created = 0;
  let skipped = 0;

  for (const row of allTenantRows) {
    for (const alias of ["unknown", ""]) {
      const existing = await db.select().from(leadSourceAliasesTable)
        .where(and(
          eq(leadSourceAliasesTable.tenantId, row.id),
          eq(leadSourceAliasesTable.alias, alias)
        ));

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      await db.insert(leadSourceAliasesTable).values({
        tenantId: row.id,
        canonicalName: "Unknown",
        alias,
      });
      created++;
    }
    invalidateSourceCache(row.id);
  }

  res.json({ tenants: allTenantRows.length, created, skipped });
});

export default router;
