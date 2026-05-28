import { Router, type IRouter } from "express";
import { db, unroutedSheetRowsTable, googleSheetConfigsTable } from "@workspace/db";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { assertResourceTenantAccess } from "../lib/tenant-scope";

const router: IRouter = Router();

router.get(
  "/tenants/:tenantId/unrouted-sheet-rows",
  requireRole("super_admin", "agency_user", "client_admin"),
  async (req, res): Promise<void> => {
    const tenantId = parseInt(String(req.params.tenantId));
    if (Number.isNaN(tenantId)) {
      res.status(400).json({ error: "Invalid tenantId" });
      return;
    }

    const access = assertResourceTenantAccess(req, res, tenantId, {
      notFoundOnMismatch: true, notFoundMessage: "Tenant not found",
    });
    if (!access.ok) return;

    const includeResolved = String(req.query.includeResolved || "") === "true";
    const sheetConfigIdParam = req.query.sheetConfigId
      ? parseInt(String(req.query.sheetConfigId))
      : null;

    const conditions = [eq(unroutedSheetRowsTable.tenantId, tenantId)];
    if (!includeResolved) conditions.push(isNull(unroutedSheetRowsTable.resolvedAt));
    if (sheetConfigIdParam) conditions.push(eq(unroutedSheetRowsTable.sheetConfigId, sheetConfigIdParam));

    const rows = await db
      .select()
      .from(unroutedSheetRowsTable)
      .where(and(...conditions))
      .orderBy(desc(unroutedSheetRowsTable.createdAt))
      .limit(500);

    res.json(rows);
  },
);

router.get(
  "/tenants/:tenantId/unrouted-sheet-rows/counts",
  requireRole("super_admin", "agency_user", "client_admin"),
  async (req, res): Promise<void> => {
    const tenantId = parseInt(String(req.params.tenantId));
    if (Number.isNaN(tenantId)) {
      res.status(400).json({ error: "Invalid tenantId" });
      return;
    }

    const access = assertResourceTenantAccess(req, res, tenantId, {
      notFoundOnMismatch: true, notFoundMessage: "Tenant not found",
    });
    if (!access.ok) return;

    const counts = await db
      .select({
        sheetConfigId: unroutedSheetRowsTable.sheetConfigId,
        count: sql<number>`count(*)::int`,
      })
      .from(unroutedSheetRowsTable)
      .where(and(
        eq(unroutedSheetRowsTable.tenantId, tenantId),
        isNull(unroutedSheetRowsTable.resolvedAt),
      ))
      .groupBy(unroutedSheetRowsTable.sheetConfigId);

    const total = counts.reduce((sum, c) => sum + (c.count || 0), 0);
    res.json({ total, perSheet: counts });
  },
);

router.post(
  "/unrouted-sheet-rows/:id/resolve",
  requireRole("super_admin", "agency_user"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [row] = await db
      .select()
      .from(unroutedSheetRowsTable)
      .where(eq(unroutedSheetRowsTable.id, id));

    if (!row) {
      res.status(404).json({ error: "Unrouted row not found" });
      return;
    }

    const access = assertResourceTenantAccess(req, res, row.tenantId, {
      notFoundOnMismatch: true, notFoundMessage: "Unrouted row not found",
    });
    if (!access.ok) return;

    const userId = (req.session as unknown as Record<string, unknown>).userId as number | undefined;

    const [updated] = await db
      .update(unroutedSheetRowsTable)
      .set({ resolvedAt: new Date(), resolvedByUserId: userId ?? null })
      .where(eq(unroutedSheetRowsTable.id, id))
      .returning();

    res.json(updated);
  },
);

router.delete(
  "/unrouted-sheet-rows/:id",
  requireRole("super_admin", "agency_user"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id));
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [row] = await db
      .select({ tenantId: unroutedSheetRowsTable.tenantId })
      .from(unroutedSheetRowsTable)
      .where(eq(unroutedSheetRowsTable.id, id));

    if (!row) {
      res.status(404).json({ error: "Unrouted row not found" });
      return;
    }

    const access = assertResourceTenantAccess(req, res, row.tenantId, {
      notFoundOnMismatch: true, notFoundMessage: "Unrouted row not found",
    });
    if (!access.ok) return;

    await db.delete(unroutedSheetRowsTable).where(eq(unroutedSheetRowsTable.id, id));
    res.json({ success: true });
  },
);

export default router;
