import { Router, type IRouter } from "express";
import { db, attributionEventsTable, reconciliationRunsTable } from "@workspace/db";
import { eq, and, count, desc, SQL } from "drizzle-orm";
import { ListAttributionEventsQueryParams } from "@workspace/api-zod";
import { runReconciliation, getReconciliationStatus } from "../services/reconciliation";
import { requireRole, denyClientUser } from "../middleware/auth";

const router: IRouter = Router();

router.use("/attribution", denyClientUser);

router.get("/attribution/events", async (req, res) => {
  const query = ListAttributionEventsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  if (query.tenantId) conditions.push(eq(attributionEventsTable.tenantId, query.tenantId));
  if (query.matchLevel) {
    const level = query.matchLevel as "diamond" | "golden" | "silver" | "bronze" | "unmatched";
    conditions.push(eq(attributionEventsTable.matchLevel, level));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const [events, [totalResult]] = await Promise.all([
    db.select().from(attributionEventsTable).where(where).orderBy(desc(attributionEventsTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: count() }).from(attributionEventsTable).where(where),
  ]);

  res.json({ events, total: totalResult.count });
});

router.post("/attribution/reconcile", requireRole("super_admin", "agency_user"), async (req, res) => {
  try {
    const tenantId: number | null = req.body.tenantId ? Number(req.body.tenantId) : null;

    const result = await runReconciliation(tenantId, "manual");

    res.json({
      success: true,
      reconciled: result.jobsProcessed,
      breakdown: {
        diamond: result.diamond,
        golden: result.golden,
        silver: result.silver,
        bronze: result.bronze,
        unmatched: result.unmatched,
      },
      matchRate: result.matchRate,
      ociPayloadsGenerated: result.ociPayloads.length,
      message: `Reconciled ${result.jobsProcessed} jobs: ${result.diamond} diamond, ${result.golden} golden, ${result.silver} silver, ${result.bronze} bronze, ${result.unmatched} unmatched`,
    });
  } catch (error) {
    console.error("[Reconciliation] Error:", error);
    res.status(500).json({ error: "Reconciliation failed", details: error instanceof Error ? error.message : "Unknown error" });
  }
});

router.get("/attribution/reconciliation-status", async (req, res) => {
  try {
    const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
    const status = await getReconciliationStatus(tenantId);
    res.json(status);
  } catch (error) {
    console.error("[Reconciliation Status] Error:", error);
    res.status(500).json({ error: "Failed to get reconciliation status" });
  }
});

router.get("/attribution/oci-payloads", requireRole("super_admin", "agency_user"), async (req, res) => {
  try {
    const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
    const result = await runReconciliation(tenantId, "manual");
    res.json({
      payloads: result.ociPayloads,
      totalPayloads: result.ociPayloads.length,
      totalValue: result.ociPayloads.reduce((s, p) => s + p.conversionValue, 0),
    });
  } catch (error) {
    console.error("[OCI Payloads] Error:", error);
    res.status(500).json({ error: "Failed to generate OCI payloads" });
  }
});

export default router;
