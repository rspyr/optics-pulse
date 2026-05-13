import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, fieldMappingRulesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { invalidateRuleCache } from "../services/field-detection";
import { assertResourceTenantAccess } from "../lib/tenant-scope";

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

router.use("/field-mapping-rules", requireManagerRole);

const VALID_MAPS_TO = [
  "firstName", "lastName", "fullName", "email", "phone",
  "address", "city", "state", "zip",
  "funnel", "appointmentDate", "appointmentTime",
] as const;
const VALID_MAPS_TO_SET: ReadonlySet<string> = new Set(VALID_MAPS_TO);

function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[\s\-\.]/g, "_");
}

router.get("/field-mapping-rules/suggestions", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ suggestions: {} });
    return;
  }

  const rows = await db.select().from(fieldMappingRulesTable)
    .where(eq(fieldMappingRulesTable.tenantId, tenantId));

  // Aggregate per normalized field name: pick the most-frequently-used mapsTo,
  // tie-broken by the most recently created rule. Skip targets that aren't
  // valid (defensive against legacy/garbage rows).
  type Tally = { counts: Map<string, number>; latestAt: Map<string, number> };
  const byField = new Map<string, Tally>();

  for (const row of rows) {
    if (!VALID_MAPS_TO_SET.has(row.mapsTo)) continue;
    const key = normalizeFieldKey(row.fieldName);
    if (!key) continue;
    let tally = byField.get(key);
    if (!tally) {
      tally = { counts: new Map(), latestAt: new Map() };
      byField.set(key, tally);
    }
    tally.counts.set(row.mapsTo, (tally.counts.get(row.mapsTo) ?? 0) + 1);
    const at = row.createdAt instanceof Date ? row.createdAt.getTime() : 0;
    const prev = tally.latestAt.get(row.mapsTo) ?? 0;
    if (at > prev) tally.latestAt.set(row.mapsTo, at);
  }

  const suggestions: Record<string, string> = {};
  for (const [fieldName, tally] of byField.entries()) {
    let bestTarget: string | null = null;
    let bestCount = -1;
    let bestLatest = -1;
    for (const [target, count] of tally.counts.entries()) {
      const latest = tally.latestAt.get(target) ?? 0;
      if (count > bestCount || (count === bestCount && latest > bestLatest)) {
        bestTarget = target;
        bestCount = count;
        bestLatest = latest;
      }
    }
    if (bestTarget) suggestions[fieldName] = bestTarget;
  }

  res.json({ suggestions });
});

router.get("/field-mapping-rules", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ rules: [] });
    return;
  }

  const pageUrlPattern = req.query.pageUrlPattern as string | undefined;
  const formIdentifier = req.query.formIdentifier as string | undefined;

  let conditions = [eq(fieldMappingRulesTable.tenantId, tenantId)];
  if (pageUrlPattern) conditions.push(eq(fieldMappingRulesTable.pageUrlPattern, pageUrlPattern));
  if (formIdentifier) conditions.push(eq(fieldMappingRulesTable.formIdentifier, formIdentifier));

  const rows = await db.select().from(fieldMappingRulesTable)
    .where(and(...conditions))
    .orderBy(fieldMappingRulesTable.pageUrlPattern, fieldMappingRulesTable.formIdentifier, fieldMappingRulesTable.priority);

  res.json({ rules: rows });
});

router.post("/field-mapping-rules", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { pageUrlPattern, formIdentifier, fieldName, mapsTo, priority } = req.body;
  if (!pageUrlPattern || !formIdentifier || !fieldName || !mapsTo) {
    res.status(400).json({ error: "pageUrlPattern, formIdentifier, fieldName, and mapsTo are required" });
    return;
  }

  if (!VALID_MAPS_TO_SET.has(mapsTo)) {
    res.status(400).json({ error: `mapsTo must be one of: ${VALID_MAPS_TO.join(", ")}` });
    return;
  }

  const existing = await db.select().from(fieldMappingRulesTable)
    .where(and(
      eq(fieldMappingRulesTable.tenantId, tenantId),
      eq(fieldMappingRulesTable.pageUrlPattern, pageUrlPattern),
      eq(fieldMappingRulesTable.formIdentifier, formIdentifier),
      eq(fieldMappingRulesTable.fieldName, fieldName),
    ));

  if (existing.length > 0) {
    const [updated] = await db.update(fieldMappingRulesTable)
      .set({ mapsTo, priority: priority ?? 0 })
      .where(eq(fieldMappingRulesTable.id, existing[0].id))
      .returning();

    invalidateRuleCache(tenantId, pageUrlPattern);
    res.json({ rule: updated, updated: true });
    return;
  }

  const [row] = await db.insert(fieldMappingRulesTable).values({
    tenantId,
    pageUrlPattern,
    formIdentifier,
    fieldName,
    mapsTo,
    priority: priority ?? 0,
  }).returning();

  invalidateRuleCache(tenantId, pageUrlPattern);
  res.json({ rule: row });
});

router.delete("/field-mapping-rules/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db.select().from(fieldMappingRulesTable)
    .where(eq(fieldMappingRulesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Rule not found" }); return; }

  const access = assertResourceTenantAccess(req, res, existing.tenantId, {
    notFoundOnMismatch: true, notFoundMessage: "Rule not found",
  });
  if (!access.ok) return;

  await db.delete(fieldMappingRulesTable)
    .where(eq(fieldMappingRulesTable.id, id));

  invalidateRuleCache(existing.tenantId, existing.pageUrlPattern);
  res.json({ success: true });
});

export default router;
