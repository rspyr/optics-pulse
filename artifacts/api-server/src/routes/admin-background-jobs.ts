import { Router, type IRouter } from "express";
import { db, backgroundJobsTable, tenantsTable } from "@workspace/db";
import { and, desc, eq, count, inArray, isNull, SQL } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import {
  REDERIVE_SELECTED_LEADS,
  cleanupOldCancelledSelectedLeadsRederives,
} from "../services/re-derive-jobs";

const router: IRouter = Router();

const agencyOnly = [requireRole("super_admin", "agency_user")];

const VALID_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"] as const;
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
        // Append the unique primary key as a deterministic tiebreaker so paging
        // is stable under LIMIT/OFFSET: createdAt ties leave rows the ORDER BY
        // can't distinguish, and Postgres gives no guaranteed order among them,
        // so without a unique secondary key adjacent pages can overlap or skip.
        .orderBy(desc(backgroundJobsTable.createdAt), desc(backgroundJobsTable.id))
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

    // Atomic conditional update so we can't race with a concurrent status
    // change (e.g. an admin clicking retry twice, or a worker flipping the
    // row). If no row matches the (id, status='failed') predicate, we fall
    // back to a separate read to decide between 404 and 409.
    const updatedRows = await db
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
      .where(and(eq(backgroundJobsTable.id, id), eq(backgroundJobsTable.status, "failed")))
      .returning();

    if (updatedRows.length === 0) {
      const [existing] = await db
        .select()
        .from(backgroundJobsTable)
        .where(eq(backgroundJobsTable.id, id));
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
      } else {
        res.status(409).json({ error: `Only failed jobs can be retried (current status: ${existing.status})` });
      }
      return;
    }

    res.json({ job: updatedRows[0] });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to retry job";
    res.status(500).json({ error: msg });
  }
});

/**
 * Mark a pending job as `cancelled` so the worker skips it. Only jobs that
 * are still `pending` can be cancelled — once a job is `in_progress` the
 * worker already holds the row and stopping mid-run isn't safe; completed,
 * failed, and already-cancelled jobs are terminal. Cancellation sets
 * `completed_at` so the row sorts with other terminal results.
 */
router.post("/admin/background-jobs/:id/cancel", ...agencyOnly, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }

    // Atomic conditional update guards against the worker racing in
    // between a read and a write: we only flip rows that are still
    // `pending`, so an in_progress job can never be silently cancelled.
    const updatedRows = await db
      .update(backgroundJobsTable)
      .set({
        status: "cancelled",
        completedAt: new Date(),
        updatedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
      })
      .where(and(eq(backgroundJobsTable.id, id), eq(backgroundJobsTable.status, "pending")))
      .returning();

    if (updatedRows.length === 0) {
      const [existing] = await db
        .select()
        .from(backgroundJobsTable)
        .where(eq(backgroundJobsTable.id, id));
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
      } else {
        res.status(409).json({ error: `Only pending jobs can be cancelled (current status: ${existing.status})` });
      }
      return;
    }

    res.json({ job: updatedRows[0] });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to cancel job";
    res.status(500).json({ error: msg });
  }
});

/**
 * Bulk-cancel many pending jobs in one call. Cancels any rows whose status is
 * still `pending` and that match the provided scope. Scope can be a list of
 * ids, a job type, and/or a tenant id (use `null` to match jobs with no
 * tenant). At least one of `ids`, `type`, or `tenantId` (including `null`)
 * must be supplied — refusing an empty body avoids accidentally cancelling
 * the entire pending queue. In-progress, completed, failed, and
 * already-cancelled jobs are left untouched by the conditional update.
 */
router.post("/admin/background-jobs/bulk-cancel", ...agencyOnly, async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      ids?: unknown;
      type?: unknown;
      tenantId?: unknown;
    };

    let ids: number[] | undefined;
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids)) {
        res.status(400).json({ error: "ids must be an array of integers" });
        return;
      }
      ids = [];
      for (const raw of body.ids) {
        const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
        if (!Number.isInteger(n) || n <= 0) {
          res.status(400).json({ error: "ids must contain positive integers" });
          return;
        }
        ids.push(n);
      }
      // De-dup; cap at a sane batch size to bound the UPDATE.
      ids = Array.from(new Set(ids));
      if (ids.length === 0) {
        res.status(400).json({ error: "ids must not be empty" });
        return;
      }
      if (ids.length > 1000) {
        res.status(400).json({ error: "ids may contain at most 1000 entries per call" });
        return;
      }
    }

    let type: string | undefined;
    if (body.type !== undefined && body.type !== null && body.type !== "") {
      if (typeof body.type !== "string") {
        res.status(400).json({ error: "type must be a string" });
        return;
      }
      type = body.type;
    }

    // tenantId is tri-state: omitted (no filter), null (match untenanted
    // jobs), or a positive integer.
    let tenantFilter: { kind: "none" } | { kind: "null" } | { kind: "id"; id: number } = { kind: "none" };
    if (Object.prototype.hasOwnProperty.call(body, "tenantId")) {
      if (body.tenantId === null) {
        tenantFilter = { kind: "null" };
      } else {
        const n = typeof body.tenantId === "number" ? body.tenantId : parseInt(String(body.tenantId), 10);
        if (!Number.isInteger(n) || n <= 0) {
          res.status(400).json({ error: "tenantId must be a positive integer or null" });
          return;
        }
        tenantFilter = { kind: "id", id: n };
      }
    }

    if (!ids && !type && tenantFilter.kind === "none") {
      res.status(400).json({ error: "Provide at least one of ids, type, or tenantId" });
      return;
    }

    const conditions: SQL[] = [eq(backgroundJobsTable.status, "pending")];
    if (ids) conditions.push(inArray(backgroundJobsTable.id, ids));
    if (type) conditions.push(eq(backgroundJobsTable.type, type));
    if (tenantFilter.kind === "null") {
      conditions.push(isNull(backgroundJobsTable.tenantId));
    } else if (tenantFilter.kind === "id") {
      conditions.push(eq(backgroundJobsTable.tenantId, tenantFilter.id));
    }

    const now = new Date();
    const updatedRows = await db
      .update(backgroundJobsTable)
      .set({
        status: "cancelled",
        completedAt: now,
        updatedAt: now,
        lockedAt: null,
        lockedBy: null,
      })
      .where(and(...conditions))
      .returning({ id: backgroundJobsTable.id });

    res.json({
      cancelledCount: updatedRows.length,
      cancelledIds: updatedRows.map((r) => r.id),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to bulk-cancel jobs";
    res.status(500).json({ error: msg });
  }
});

/**
 * List recent cancelled bulk re-derive jobs (`rederive_selected_leads`)
 * for the cleanup observability panel. Returns scope (tenant, page pattern,
 * form identifier), partial counts (processed/total), and age info so the
 * operator can spot stale snapshots before triggering a manual prune. Joins
 * to `tenants` so the UI can show tenant name without a second round-trip.
 */
router.get("/admin/rederive-jobs/cancelled", ...agencyOnly, async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1),
      500,
    );

    const rows = await db
      .select({
        id: backgroundJobsTable.id,
        tenantId: backgroundJobsTable.tenantId,
        tenantName: tenantsTable.name,
        payload: backgroundJobsTable.payload,
        result: backgroundJobsTable.result,
        createdAt: backgroundJobsTable.createdAt,
        completedAt: backgroundJobsTable.completedAt,
        updatedAt: backgroundJobsTable.updatedAt,
      })
      .from(backgroundJobsTable)
      .leftJoin(tenantsTable, eq(backgroundJobsTable.tenantId, tenantsTable.id))
      .where(
        and(
          eq(backgroundJobsTable.type, REDERIVE_SELECTED_LEADS),
          eq(backgroundJobsTable.status, "cancelled"),
        ),
      )
      .orderBy(desc(backgroundJobsTable.completedAt))
      .limit(limit);

    const [{ count: total } = { count: 0 }] = await db
      .select({ count: count() })
      .from(backgroundJobsTable)
      .where(
        and(
          eq(backgroundJobsTable.type, REDERIVE_SELECTED_LEADS),
          eq(backgroundJobsTable.status, "cancelled"),
        ),
      );

    // Pull scope + partial counts out of jsonb so the UI doesn't need to
    // know the snapshot shape. `result` is empty for pending-cancel rows
    // (cancel before the handler ran) — fall back to "total = leadIds
    // length, processed = 0" so the row still renders sensibly.
    const jobs = rows.map((r) => {
      const payload = (r.payload ?? {}) as {
        leadIds?: unknown;
        pageUrlPattern?: unknown;
        formIdentifier?: unknown;
      };
      const result = (r.result ?? {}) as {
        total?: unknown;
        processed?: unknown;
        succeeded?: unknown;
        failed?: unknown;
        changed?: unknown;
      };
      const asNum = (v: unknown, fallback: number) =>
        typeof v === "number" && Number.isFinite(v) ? v : fallback;
      const leadIdsLen = Array.isArray(payload.leadIds) ? payload.leadIds.length : 0;
      return {
        id: r.id,
        tenantId: r.tenantId,
        tenantName: r.tenantName ?? null,
        pageUrlPattern:
          typeof payload.pageUrlPattern === "string" ? payload.pageUrlPattern : null,
        formIdentifier:
          typeof payload.formIdentifier === "string" ? payload.formIdentifier : null,
        total: asNum(result.total, leadIdsLen),
        processed: asNum(result.processed, 0),
        succeeded: asNum(result.succeeded, 0),
        failed: asNum(result.failed, 0),
        changed: asNum(result.changed, 0),
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        updatedAt: r.updatedAt,
      };
    });

    res.json({ jobs, total, limit });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to list cancelled re-derive jobs";
    res.status(500).json({ error: msg });
  }
});

/**
 * Force-run the cancelled bulk re-derive cleanup sweep. The same sweep
 * runs daily on a timer (see `startCancelledRederiveCleanupScheduler`),
 * but an operator may want to prune now — e.g. before debugging a
 * runaway job, or after manually cancelling a backlog of snapshots.
 * Returns the number of rows deleted so the UI can show a confirmation.
 *
 * `retentionDays` defaults to 30 to match the scheduled sweep; callers
 * can override it (e.g. for a stricter manual purge), but values <= 0 or
 * non-finite are rejected to prevent accidental "delete everything".
 */
router.post("/admin/rederive-jobs/cleanup", ...agencyOnly, async (req, res) => {
  try {
    const body = (req.body ?? {}) as { retentionDays?: unknown };
    let retentionDays = 30;
    if (body.retentionDays !== undefined && body.retentionDays !== null) {
      const n =
        typeof body.retentionDays === "number"
          ? body.retentionDays
          : parseInt(String(body.retentionDays), 10);
      if (!Number.isFinite(n) || n <= 0) {
        res.status(400).json({ error: "retentionDays must be a positive number" });
        return;
      }
      retentionDays = n;
    }

    const deletedCount = await cleanupOldCancelledSelectedLeadsRederives(retentionDays);
    res.json({ deletedCount, retentionDays });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to run cleanup sweep";
    res.status(500).json({ error: msg });
  }
});

export default router;
