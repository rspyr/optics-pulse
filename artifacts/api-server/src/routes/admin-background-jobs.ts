import { Router, type IRouter } from "express";
import { db, backgroundJobsTable } from "@workspace/db";
import { and, desc, eq, count, SQL } from "drizzle-orm";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

const agencyOnly = [requireRole("super_admin", "agency_user")];

const VALID_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;
type JobStatus = (typeof VALID_STATUSES)[number];

/**
 * List rows from the `background_jobs` table for the admin observability
 * panel. Supports optional status/type filters and simple pagination. The
 * `result` and `payload` fields can be large, so we return them as-is but
 * the UI is responsible for rendering a compact preview.
 */
router.get("/admin/background-jobs", ...agencyOnly, async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

    const conditions: SQL[] = [];
    if (status) {
      if (!VALID_STATUSES.includes(status as JobStatus)) {
        res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
        return;
      }
      conditions.push(eq(backgroundJobsTable.status, status));
    }
    if (type) {
      conditions.push(eq(backgroundJobsTable.type, type));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, [totalRow], typeRows, statusRows] = await Promise.all([
      db
        .select()
        .from(backgroundJobsTable)
        .where(where)
        .orderBy(desc(backgroundJobsTable.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(backgroundJobsTable).where(where),
      db
        .selectDistinct({ type: backgroundJobsTable.type })
        .from(backgroundJobsTable),
      db
        .select({ status: backgroundJobsTable.status, count: count() })
        .from(backgroundJobsTable)
        .groupBy(backgroundJobsTable.status),
    ]);

    res.json({
      jobs: rows,
      total: totalRow.count,
      limit,
      offset,
      types: typeRows.map((r) => r.type).sort(),
      statusCounts: Object.fromEntries(statusRows.map((r) => [r.status, r.count])),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to list background jobs";
    res.status(500).json({ error: msg });
  }
});

/**
 * Reset a failed job back to `pending` so the worker will pick it up again.
 * Clears `last_error` and `completed_at`, leaves `attempts` intact so retries
 * still count against `max_attempts`. Rejects jobs that aren't in `failed`
 * state to avoid stomping on in-flight or already-completed work.
 */
router.post("/admin/background-jobs/:id/retry", ...agencyOnly, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }

    const [existing] = await db
      .select()
      .from(backgroundJobsTable)
      .where(eq(backgroundJobsTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (existing.status !== "failed") {
      res.status(409).json({ error: `Only failed jobs can be retried (current status: ${existing.status})` });
      return;
    }

    const [updated] = await db
      .update(backgroundJobsTable)
      .set({
        status: "pending",
        lastError: null,
        completedAt: null,
        runAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(backgroundJobsTable.id, id))
      .returning();

    res.json({ job: updated });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to retry job";
    res.status(500).json({ error: msg });
  }
});

export default router;
