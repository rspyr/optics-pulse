import { randomUUID } from "crypto";
import { db, backgroundJobsTable, pool } from "@workspace/db";
import type { BackgroundJob } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Durable background-job runner backed by Postgres.
 *
 * Jobs are rows in the `background_jobs` table. A worker loop polls for due
 * pending rows using `SELECT ... FOR UPDATE SKIP LOCKED` so that multiple
 * api-server replicas can run in parallel without double-processing a job.
 *
 * Each job type registers a handler; on failure the worker schedules a
 * retry with exponential backoff up to `max_attempts`, after which the job
 * is marked `failed`. In-progress jobs left behind by a crashed process are
 * recovered on startup by sweeping rows whose `locked_at` is stale.
 *
 * This replaces the prior in-process `void (async () => {...})` fire-and-
 * forget pattern, which lost work on restart and had no retries/visibility.
 */

export interface JobHandlerContext {
  job: BackgroundJob;
  attempt: number;
}

export type JobHandler = (
  payload: Record<string, unknown>,
  ctx: JobHandlerContext,
) => Promise<unknown> | unknown;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler): void {
  if (handlers.has(type)) {
    console.warn(`[background-jobs] Handler for "${type}" was re-registered`);
  }
  handlers.set(type, handler);
}

export interface EnqueueOptions {
  tenantId?: number | null;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueueJob(
  type: string,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<BackgroundJob> {
  const [row] = await db
    .insert(backgroundJobsTable)
    .values({
      type,
      payload: payload as unknown as Record<string, unknown>,
      tenantId: options.tenantId ?? null,
      runAt: options.runAt ?? new Date(),
      maxAttempts: options.maxAttempts ?? 5,
    })
    .returning();
  return row;
}

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = 2_000;
const STALE_LOCK_MS = 5 * 60 * 1000;
const BATCH_SIZE = 5;

export function backoffMs(attempts: number): number {
  // 10s, 30s, 90s, 4.5m, 13.5m ...
  const base = 10_000 * Math.pow(3, Math.max(0, attempts - 1));
  return Math.min(base, 30 * 60 * 1000);
}

/**
 * Pure decision for what should happen to a job that just threw. Extracted
 * so it can be unit-tested without a real database. `attempts` reflects the
 * post-increment value already stored on the row (we increment at claim).
 */
export function decideRetryOrFail(
  attempts: number,
  maxAttempts: number,
  now: number = Date.now(),
): { outcome: "failed" } | { outcome: "retry"; nextRunAt: Date } {
  if (attempts >= maxAttempts) return { outcome: "failed" };
  return { outcome: "retry", nextRunAt: new Date(now + backoffMs(attempts)) };
}

let workerTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let running = false;
let lastStaleSweepAt = 0;
const STALE_SWEEP_INTERVAL_MS = 60 * 1000;

const RETURNING_COLUMNS = `
  id,
  tenant_id        AS "tenantId",
  type,
  payload,
  status,
  attempts,
  max_attempts     AS "maxAttempts",
  run_at           AS "runAt",
  locked_at        AS "lockedAt",
  locked_by        AS "lockedBy",
  last_error       AS "lastError",
  result,
  created_at       AS "createdAt",
  updated_at       AS "updatedAt",
  completed_at     AS "completedAt"
`;

async function claimOne(): Promise<BackgroundJob | null> {
  // SELECT FOR UPDATE SKIP LOCKED so concurrent workers don't fight for the
  // same row. We do this in a short transaction and immediately UPDATE the
  // row to mark it in_progress before releasing the lock.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sel = await client.query<{ id: number }>(
      `SELECT id FROM background_jobs
        WHERE status = 'pending' AND run_at <= now()
        ORDER BY run_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    const row = sel.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const upd = await client.query<BackgroundJob>(
      `UPDATE background_jobs
          SET status = 'in_progress',
              attempts = attempts + 1,
              locked_at = now(),
              locked_by = $2,
              updated_at = now()
        WHERE id = $1
        RETURNING ${RETURNING_COLUMNS}`,
      [row.id, WORKER_ID],
    );
    await client.query("COMMIT");
    return upd.rows[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function markCompleted(jobId: number, result: unknown): Promise<void> {
  // Only flip status when the row is still `in_progress`. If the cancel
  // endpoint flipped it to `cancelled` mid-run, we want to preserve that
  // terminal state — but we still record the partial `result` so the
  // operator UI can see "succeeded X out of Y before cancel". Doing this
  // as two statements (status flip vs. result/completedAt update) lets the
  // happy path stay a single UPDATE while the cancel path silently no-ops
  // the status flip without clobbering the cancelled row.
  const flipped = await db
    .update(backgroundJobsTable)
    .set({
      status: "completed",
      completedAt: new Date(),
      updatedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      result: (result ?? null) as unknown as Record<string, unknown>,
    })
    .where(and(eq(backgroundJobsTable.id, jobId), eq(backgroundJobsTable.status, "in_progress")))
    .returning({ id: backgroundJobsTable.id });
  if (flipped.length === 0) {
    // Row is already terminal (almost always: cancelled mid-run). Keep the
    // partial result around without changing status.
    await db
      .update(backgroundJobsTable)
      .set({
        result: (result ?? null) as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(backgroundJobsTable.id, jobId));
  }
}

/**
 * Returns `true` when the `background_jobs` row for `jobId` is currently in
 * a terminal `cancelled` state. Used by long-running handlers (e.g. the
 * selected-leads bulk re-derive) as a per-lead cancellation checkpoint so
 * an operator clicking "Cancel" mid-run can short-circuit the loop instead
 * of waiting for the whole batch to finish.
 */
export async function isJobCancelled(jobId: number): Promise<boolean> {
  const [row] = await db
    .select({ status: backgroundJobsTable.status })
    .from(backgroundJobsTable)
    .where(eq(backgroundJobsTable.id, jobId));
  return row?.status === "cancelled";
}

export async function markRetryOrFailed(
  job: BackgroundJob,
  err: unknown,
): Promise<"retry" | "failed"> {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  const truncated = message.length > 4000 ? message.slice(0, 4000) + "…" : message;

  const decision = decideRetryOrFail(job.attempts, job.maxAttempts);
  if (decision.outcome === "failed") {
    // Same protection as `markCompleted`: don't stomp on a row already
    // flipped to `cancelled` (or any other terminal state) by an out-of-band
    // status change while the handler was running.
    await db
      .update(backgroundJobsTable)
      .set({
        status: "failed",
        lastError: truncated,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
        completedAt: new Date(),
      })
      .where(and(eq(backgroundJobsTable.id, job.id), eq(backgroundJobsTable.status, "in_progress")));
    return "failed";
  }

  await db
    .update(backgroundJobsTable)
    .set({
      status: "pending",
      lastError: truncated,
      runAt: decision.nextRunAt,
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(and(eq(backgroundJobsTable.id, job.id), eq(backgroundJobsTable.status, "in_progress")));
  return "retry";
}

async function runOne(job: BackgroundJob): Promise<void> {
  const handler = handlers.get(job.type);
  if (!handler) {
    console.error(`[background-jobs] No handler registered for type "${job.type}" (job ${job.id}); marking failed`);
    await db
      .update(backgroundJobsTable)
      .set({
        status: "failed",
        lastError: `No handler registered for type "${job.type}"`,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(backgroundJobsTable.id, job.id));
    return;
  }

  const startedAt = Date.now();
  try {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const result = await handler(payload, { job, attempt: job.attempts });
    await markCompleted(job.id, result);
    const durationMs = Date.now() - startedAt;
    console.log(
      `[background-jobs] completed type=${job.type} id=${job.id} attempt=${job.attempts} durationMs=${durationMs}`,
    );
  } catch (err) {
    const outcome = await markRetryOrFailed(job, err);
    console.error(
      `[background-jobs] handler error type=${job.type} id=${job.id} attempt=${job.attempts} outcome=${outcome}:`,
      err,
    );
  }
}

async function recoverStaleLocks(): Promise<void> {
  // Any job stuck in_progress past STALE_LOCK_MS was being run by a process
  // that died before it could mark the job done. Flip it back to pending so
  // a healthy worker picks it up; attempts already incremented at claim, so
  // it still counts against max_attempts.
  const res = await db.execute(sql`
    UPDATE background_jobs
       SET status = 'pending',
           locked_at = NULL,
           locked_by = NULL,
           run_at = now(),
           updated_at = now(),
           last_error = COALESCE(last_error, '') || E'\n[recovery] worker lock expired'
     WHERE status = 'in_progress'
       AND locked_at IS NOT NULL
       AND locked_at < now() - (${STALE_LOCK_MS} || ' milliseconds')::interval
     RETURNING id
  `);
  const rows = (res as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  if (rows.length > 0) {
    console.log(`[background-jobs] recovered ${rows.length} stale in_progress job(s)`);
  }
}

async function tick(): Promise<void> {
  if (running || stopped) return;
  running = true;
  try {
    // Periodically reclaim jobs whose worker crashed mid-run. Running this
    // every tick would be wasteful; running it only at startup would strand
    // jobs if the process restarts faster than STALE_LOCK_MS, so we sweep
    // on a steady interval inside the worker loop.
    if (Date.now() - lastStaleSweepAt >= STALE_SWEEP_INTERVAL_MS) {
      lastStaleSweepAt = Date.now();
      try {
        await recoverStaleLocks();
      } catch (err) {
        console.error("[background-jobs] recoverStaleLocks failed:", err);
      }
    }

    for (let i = 0; i < BATCH_SIZE; i++) {
      if (stopped) break;
      const job = await claimOne();
      if (!job) break;
      await runOne(job);
    }
  } catch (err) {
    console.error("[background-jobs] tick error:", err);
  } finally {
    running = false;
    if (!stopped) {
      workerTimer = setTimeout(tick, POLL_INTERVAL_MS);
      workerTimer.unref?.();
    }
  }
}

export async function startBackgroundJobWorker(): Promise<void> {
  stopped = false;
  try {
    await recoverStaleLocks();
    lastStaleSweepAt = Date.now();
  } catch (err) {
    console.error("[background-jobs] recoverStaleLocks failed:", err);
  }
  console.log(`[background-jobs] worker started (id=${WORKER_ID})`);
  workerTimer = setTimeout(tick, POLL_INTERVAL_MS);
  workerTimer.unref?.();
}

export function stopBackgroundJobWorker(): void {
  stopped = true;
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
}
