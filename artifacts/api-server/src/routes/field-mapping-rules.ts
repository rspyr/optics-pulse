import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, fieldMappingRulesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { invalidateRuleCache } from "../services/field-detection";

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

router.use("/field-mapping-rules", requireManagerRole);

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

  const VALID_MAPS_TO = [
    "firstName", "lastName", "fullName", "email", "phone",
    "address", "city", "state", "zip",
    "funnel", "appointmentDate", "appointmentTime",
  ];

  const { pageUrlPattern, formIdentifier, fieldName, mapsTo, priority } = req.body;
  if (!pageUrlPattern || !formIdentifier || !fieldName || !mapsTo) {
    res.status(400).json({ error: "pageUrlPattern, formIdentifier, fieldName, and mapsTo are required" });
    return;
  }

  if (!VALID_MAPS_TO.includes(mapsTo)) {
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
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const id = Number(req.params.id);
  const [deleted] = await db.delete(fieldMappingRulesTable)
    .where(and(eq(fieldMappingRulesTable.id, id), eq(fieldMappingRulesTable.tenantId, tenantId)))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  invalidateRuleCache(tenantId, deleted.pageUrlPattern);
  res.json({ success: true });
});

export default router;
