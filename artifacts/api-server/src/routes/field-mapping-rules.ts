import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, fieldMappingRulesTable, attributionEventsTable, backgroundJobsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { invalidateRuleCache } from "../services/field-detection";
import { assertResourceTenantAccess } from "../lib/tenant-scope";
import { reDeriveLeadFunnel } from "../services/re-derive-lead-funnel";
import {
  enqueueReDeriveLeadsForRuleScope,
  enqueueReDeriveSelectedLeads,
  findLatestCancelledRederiveSnapshotFromDb,
  markCancelledRederiveSnapshotDismissedInDb,
  clearCancelledRederiveDismissedInDbForScope,
  REDERIVE_SELECTED_LEADS,
} from "../services/re-derive-jobs";
import { mapReDeriveErrorForOperator } from "../services/re-derive-error-messages";
import {
  emitRuleRederiveFailed,
  emitSelectedLeadsRederiveCancelled,
  findLatestCancelledSelectedLeadsRederiveSnapshotForScope,
  markCancelledSelectedLeadsRederiveSnapshotDismissed,
  clearCancelledSelectedLeadsRederiveDismissedForScope,
  getSelectedLeadsRederiveProgress,
} from "../socket";
import { countPendingRederiveLeadsForRuleScope, listPendingRederiveLeadsForRuleScope } from "../services/re-derive-lead-funnel";

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

// Return the list of historical leads still pending a re-derive for a given
// (pageUrlPattern, formIdentifier) scope. Powers the "View pending leads"
// sheet that the operator opens from the re-derive failure hint, so they can
// drill into which specific leads still need updating after a failed fan-out.
router.get("/field-mapping-rules/pending-rederive-leads", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "tenantId is required" });
    return;
  }
  const pageUrlPattern = typeof req.query.pageUrlPattern === "string" ? req.query.pageUrlPattern : "";
  const formIdentifier = typeof req.query.formIdentifier === "string" ? req.query.formIdentifier : "";
  if (!pageUrlPattern || !formIdentifier) {
    res.status(400).json({ error: "pageUrlPattern and formIdentifier are required" });
    return;
  }
  const excludeLeadIdRaw = req.query.excludeLeadId;
  const excludeLeadId = typeof excludeLeadIdRaw === "string" && excludeLeadIdRaw.trim() !== ""
    ? Number(excludeLeadIdRaw)
    : null;
  const result = await listPendingRederiveLeadsForRuleScope(tenantId, pageUrlPattern, formIdentifier, {
    excludeLeadId: Number.isFinite(excludeLeadId as number) ? excludeLeadId : null,
  });
  res.json(result);
});

// Threshold under which the bulk re-derive endpoint runs the per-lead
// re-derive inline (so the operator sees success/failure counts directly).
// Above this, we hand the work off to a durable background job so the
// request stays snappy and the work survives restarts/retries.
const BULK_REDERIVE_SYNC_THRESHOLD = 25;
// Hard cap on the number of leads accepted per request — both to protect the
// API and to keep the queued job's payload bounded.
const BULK_REDERIVE_MAX_LEADS = 500;

/**
 * Bulk re-derive a specific set of pending leads chosen by the operator in
 * the "View pending leads" sheet. Small selections run synchronously so the
 * sheet can surface success/failure counts immediately; larger selections
 * are handed off to the `rederive_selected_leads` background job.
 */
router.post("/field-mapping-rules/rederive-leads", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "tenantId is required" });
    return;
  }
  const body = (req.body ?? {}) as { leadIds?: unknown; pageUrlPattern?: unknown; formIdentifier?: unknown };
  const rawLeadIds = body.leadIds;
  // Optional rule scope passed through from the pending-leads sheet. We
  // thread it into the job payload so the terminal snapshot can be looked
  // up by scope on sheet re-open ("restore cancelled state" affordance).
  // Missing values are tolerated — the worst case is that re-opening the
  // sheet won't restore an in-flight/cancelled job that wasn't tagged.
  const pageUrlPattern = typeof body.pageUrlPattern === "string" ? body.pageUrlPattern : undefined;
  const formIdentifier = typeof body.formIdentifier === "string" ? body.formIdentifier : undefined;
  if (!Array.isArray(rawLeadIds) || rawLeadIds.length === 0) {
    res.status(400).json({ error: "leadIds must be a non-empty array" });
    return;
  }
  if (rawLeadIds.length > BULK_REDERIVE_MAX_LEADS) {
    res.status(400).json({
      error: `Too many leadIds (max ${BULK_REDERIVE_MAX_LEADS})`,
    });
    return;
  }
  const leadIds: number[] = [];
  const seen = new Set<number>();
  for (const v of rawLeadIds) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(400).json({ error: "leadIds must contain positive integers" });
      return;
    }
    if (!seen.has(n)) {
      seen.add(n);
      leadIds.push(n);
    }
  }

  if (leadIds.length > BULK_REDERIVE_SYNC_THRESHOLD) {
    try {
      const job = await enqueueReDeriveSelectedLeads({
        tenantId,
        leadIds,
        pageUrlPattern,
        formIdentifier,
      });
      // A fresh enqueue invalidates any prior dismissed cancelled banner
      // for the scope — if this new job is itself cancelled the operator
      // should see a fresh banner, not be silently suppressed by a stale
      // server-side dismissal. Clear both in-memory and DB markers.
      if (pageUrlPattern && formIdentifier) {
        try {
          clearCancelledSelectedLeadsRederiveDismissedForScope(tenantId, pageUrlPattern, formIdentifier);
          await clearCancelledRederiveDismissedInDbForScope(tenantId, pageUrlPattern, formIdentifier);
        } catch (clearErr) {
          console.error("[field-mapping-rules.rederive-leads] clear dismissed failed:", clearErr);
        }
      }
      res.json({ mode: "queued", total: leadIds.length, jobId: job?.id ?? null });
    } catch (err) {
      console.error("[field-mapping-rules.rederive-leads] enqueue failed:", err);
      res.status(500).json({ error: "Failed to enqueue re-derive job" });
    }
    return;
  }

  let succeeded = 0;
  let failed = 0;
  let changed = 0;
  const failedLeadIds: number[] = [];
  // Per-lead failure reason, surfaced to the pending-rederive-leads sheet
  // so operators can triage *which* lead failed and *why* without digging
  // into server logs. Keyed by leadId; value is the thrown Error's message.
  const failedLeadErrors: Record<number, string> = {};
  for (const leadId of leadIds) {
    try {
      const r = await reDeriveLeadFunnel(tenantId, leadId);
      succeeded++;
      if (r?.changed) changed++;
    } catch (err) {
      failed++;
      failedLeadIds.push(leadId);
      failedLeadErrors[leadId] = mapReDeriveErrorForOperator(err);
      console.error("[field-mapping-rules.rederive-leads] reDeriveLeadFunnel failed for lead", leadId, err);
    }
  }
  // Mirror the queued path: a successful submit for this scope invalidates
  // any prior dismissed cancelled banner so a future cancel surfaces fresh.
  if (pageUrlPattern && formIdentifier) {
    try {
      clearCancelledSelectedLeadsRederiveDismissedForScope(tenantId, pageUrlPattern, formIdentifier);
      await clearCancelledRederiveDismissedInDbForScope(tenantId, pageUrlPattern, formIdentifier);
    } catch (clearErr) {
      console.error("[field-mapping-rules.rederive-leads] clear dismissed (sync) failed:", clearErr);
    }
  }
  res.json({
    mode: "sync",
    total: leadIds.length,
    succeeded,
    failed,
    changed,
    failedLeadIds,
    failedLeadErrors,
  });
});

/**
 * Returns the latest in-memory progress snapshot for a queued bulk
 * re-derive job. Used by the pending-leads sheet on reconnect so the
 * progress bar can resume without waiting for the next periodic emit.
 * Returns 404 if no snapshot is known (job already finished or never
 * existed). The snapshot is tenant-scoped — operators can only read
 * progress for their own tenant.
 */
/**
 * Cancel an in-flight bulk re-derive job. Flips the `background_jobs` row
 * to `cancelled` so the handler's per-lead checkpoint short-circuits at its
 * next iteration. The handler then emits `selected-leads-rederive-cancelled`
 * with the partial counts so the sheet can render the terminal state.
 *
 * Unlike the admin cancel endpoint, this accepts both `pending` and
 * `in_progress` rows — operators clicking "Cancel" while the bar is moving
 * are explicitly asking to stop a running job, not just dequeue a waiting
 * one. Already-terminal jobs return 409 so the UI can refresh state.
 *
 * Tenant-scoped: the job's `tenant_id` must match the operator's tenant,
 * and the type must be `rederive_selected_leads` (we don't want this
 * endpoint flipping arbitrary jobs).
 */
router.post("/field-mapping-rules/rederive-jobs/:id/cancel", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "tenantId is required" });
    return;
  }
  const jobId = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }

  // Read the row first so we can tell whether it was `pending` or
  // `in_progress` before we flip it — that determines whether a handler will
  // ever emit a terminal event. We still rely on the conditional UPDATE
  // below to make the flip atomic; the read is just for branching after.
  const [existing] = await db
    .select()
    .from(backgroundJobsTable)
    .where(eq(backgroundJobsTable.id, jobId));
  if (!existing || existing.tenantId !== tenantId || existing.type !== REDERIVE_SELECTED_LEADS) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Atomic conditional update — only flip rows that are still pending or
  // in_progress. If 0 rows match, the row raced to a terminal state between
  // our read and our write; return 409 so the UI can refresh.
  //
  // We also pre-compute the "pending-cancel" terminal result snapshot here
  // (status=pending case) so the same UPDATE that flips the row persists
  // the cancellation context. Without this, a pending-cancel row would land
  // in the DB with `result=NULL` and the cross-session restore endpoint
  // would only see the payload — which works thanks to the helper's
  // "all leads skipped" inference, but explicitly writing the result also
  // future-proofs callers that may want to consume the row directly.
  const pendingPayload = (existing.payload ?? {}) as {
    leadIds?: unknown;
    pageUrlPattern?: unknown;
    formIdentifier?: unknown;
  };
  const pendingLeadIds = Array.isArray(pendingPayload.leadIds)
    ? (pendingPayload.leadIds.filter((id) => typeof id === "number") as number[])
    : [];
  const pendingCancelResult = existing.status === "pending"
    ? {
        total: pendingLeadIds.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
        changed: 0,
        failedLeadIds: [] as number[],
        skippedLeadIds: pendingLeadIds,
        cancelled: true,
      }
    : null;
  const updatedRows = await db
    .update(backgroundJobsTable)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      updatedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      ...(pendingCancelResult
        ? { result: pendingCancelResult as unknown as Record<string, unknown> }
        : {}),
    })
    .where(and(
      eq(backgroundJobsTable.id, jobId),
      eq(backgroundJobsTable.tenantId, tenantId),
      eq(backgroundJobsTable.type, REDERIVE_SELECTED_LEADS),
      inArray(backgroundJobsTable.status, ["pending", "in_progress"]),
    ))
    .returning();

  if (updatedRows.length === 0) {
    res.status(409).json({
      error: `Job already ${existing.status}; cannot cancel`,
      status: existing.status,
    });
    return;
  }

  // If the job was still `pending` when we flipped it, no handler will ever
  // run — and therefore no handler will ever emit the cancelled socket event
  // or write the terminal snapshot. Emit it from here so the sheet can
  // resolve to "Cancelled at 0/N leads" immediately instead of waiting on the
  // 5-minute safety timeout. For `in_progress` jobs the handler's per-lead
  // checkpoint emits the event itself with the real partial counts.
  const cancelledRow = updatedRows[0];
  const wasPending = existing.status === "pending";
  if (wasPending) {
    try {
      const payload = (cancelledRow.payload ?? {}) as {
        leadIds?: unknown;
        pageUrlPattern?: unknown;
        formIdentifier?: unknown;
      };
      const leadIds = Array.isArray(payload.leadIds)
        ? (payload.leadIds.filter((id) => typeof id === "number") as number[])
        : [];
      emitSelectedLeadsRederiveCancelled(tenantId, {
        jobId: cancelledRow.id,
        total: leadIds.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
        changed: 0,
        failedLeadIds: [],
        // Even though the handler never ran, surface the *full* leadIds list
        // as "skipped" so the sheet's "Re-derive the rest" affordance can
        // re-queue them on demand instead of leaving the operator to
        // re-select rows.
        skippedLeadIds: leadIds,
        // Forward the scope so the cancelled snapshot is discoverable by
        // the sheet on re-open. Both fields are optional on older job rows
        // that pre-date the scope-threading; the snapshot just won't be
        // restorable by scope in that case.
        pageUrlPattern: typeof payload.pageUrlPattern === "string" ? payload.pageUrlPattern : undefined,
        formIdentifier: typeof payload.formIdentifier === "string" ? payload.formIdentifier : undefined,
      });
    } catch (e) {
      console.error("[field-mapping-rules:cancel] emit pending-cancel event failed:", e);
    }
  }

  res.json({ job: cancelledRow });
});

/**
 * Returns the most recent terminal `cancelled` snapshot (within the in-memory
 * TTL) for the given rule scope. Lets the pending-leads sheet restore the
 * "Cancelled at X/Y leads" + "Re-derive the rest" state when the operator
 * re-opens the sheet after a cancel — without this, the skipped subset only
 * lived in component state and was lost on close. 404 once the snapshot
 * expires so the sheet falls back to its normal "no result yet" state.
 */
router.get("/field-mapping-rules/cancelled-rederive-snapshot", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "tenantId is required" });
    return;
  }
  const pageUrlPattern = typeof req.query.pageUrlPattern === "string" ? req.query.pageUrlPattern : "";
  const formIdentifier = typeof req.query.formIdentifier === "string" ? req.query.formIdentifier : "";
  if (!pageUrlPattern || !formIdentifier) {
    res.status(400).json({ error: "pageUrlPattern and formIdentifier are required" });
    return;
  }
  const memorySnapshot = findLatestCancelledSelectedLeadsRederiveSnapshotForScope(
    tenantId,
    pageUrlPattern,
    formIdentifier,
  );
  if (memorySnapshot) {
    // `findLatestCancelledSelectedLeadsRederiveSnapshotForScope` already
    // skips dismissed snapshots, but double-check defensively so an
    // operator who dismissed on one device can't see the banner
    // momentarily reappear here.
    if (memorySnapshot.dismissed) {
      res.status(404).json({ error: "Cancelled snapshot dismissed" });
      return;
    }
    res.json(memorySnapshot);
    return;
  }
  // Fall back to the persisted `background_jobs.result` row so a cancelled
  // snapshot survives the in-memory TTL (10 min) and process restarts —
  // operators who come back the next day can still resume "Re-derive the
  // rest" instead of losing the skipped subset.
  try {
    const dbSnapshot = await findLatestCancelledRederiveSnapshotFromDb(
      tenantId,
      pageUrlPattern,
      formIdentifier,
    );
    if (!dbSnapshot) {
      res.status(404).json({ error: "No cancelled snapshot for this scope" });
      return;
    }
    if (dbSnapshot.dismissed) {
      res.status(404).json({ error: "Cancelled snapshot dismissed" });
      return;
    }
    res.json(dbSnapshot);
  } catch (err) {
    console.error("[field-mapping-rules.cancelled-rederive-snapshot] DB fallback failed:", err);
    res.status(500).json({ error: "Failed to load cancelled snapshot" });
  }
});

/**
 * Mark the latest cancelled bulk re-derive snapshot for the given scope as
 * dismissed so the "Cancelled at X/Y leads" banner stops re-surfacing when
 * the operator re-opens the pending-leads sheet — including from a
 * different device or browser profile. The dismissal is persisted both in
 * the in-memory snapshot (so the live cancelled snapshot stops being
 * returned by the snapshot GET while it's still hot) and on the
 * `background_jobs.result` row (so the dismissal survives the in-memory
 * TTL and process restarts).
 *
 * A new enqueue for the same scope clears this dismissal (handled in the
 * rederive-leads POST), so a *fresh* cancellation still surfaces the
 * banner.
 *
 * Idempotent: dismissing twice succeeds with `dismissed: true`. Returns
 * 404 when no cancelled snapshot exists for the scope in either store.
 */
router.post("/field-mapping-rules/cancelled-rederive-snapshot/dismiss", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "tenantId is required" });
    return;
  }
  const body = (req.body ?? {}) as { pageUrlPattern?: unknown; formIdentifier?: unknown };
  const pageUrlPattern = typeof body.pageUrlPattern === "string" ? body.pageUrlPattern : "";
  const formIdentifier = typeof body.formIdentifier === "string" ? body.formIdentifier : "";
  if (!pageUrlPattern || !formIdentifier) {
    res.status(400).json({ error: "pageUrlPattern and formIdentifier are required" });
    return;
  }
  const memorySnapshot = markCancelledSelectedLeadsRederiveSnapshotDismissed(
    tenantId,
    pageUrlPattern,
    formIdentifier,
  );
  let dbJobId: number | null = null;
  try {
    dbJobId = await markCancelledRederiveSnapshotDismissedInDb(
      tenantId,
      pageUrlPattern,
      formIdentifier,
    );
  } catch (err) {
    console.error("[field-mapping-rules.cancelled-rederive-snapshot.dismiss] DB write failed:", err);
    res.status(500).json({ error: "Failed to persist dismissal" });
    return;
  }
  if (!memorySnapshot && dbJobId == null) {
    res.status(404).json({ error: "No cancelled snapshot for this scope" });
    return;
  }
  res.json({
    dismissed: true,
    jobId: memorySnapshot?.jobId ?? dbJobId,
  });
});

router.get("/field-mapping-rules/rederive-job-progress", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "tenantId is required" });
    return;
  }
  const jobIdRaw = req.query.jobId;
  const jobId = typeof jobIdRaw === "string" || typeof jobIdRaw === "number"
    ? Number(jobIdRaw)
    : NaN;
  if (!Number.isInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: "jobId must be a positive integer" });
    return;
  }
  const snapshot = getSelectedLeadsRederiveProgress(jobId);
  if (!snapshot || snapshot.tenantId !== tenantId) {
    res.status(404).json({ error: "No progress snapshot for this job" });
    return;
  }
  res.json(snapshot);
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

  const { pageUrlPattern, formIdentifier, fieldName, mapsTo, priority, attributionEventId, leadId } = req.body;
  if (!pageUrlPattern || !formIdentifier || !fieldName || !mapsTo) {
    res.status(400).json({ error: "pageUrlPattern, formIdentifier, fieldName, and mapsTo are required" });
    return;
  }

  // Mirror the guards in `reDeriveLeadsForRuleScope` so an obviously-bad shape
  // (zero/negative/non-integer tenantId, non-string or empty pageUrlPattern /
  // formIdentifier) is rejected at the request boundary before we insert the
  // rule or enqueue a re-derive job. Otherwise the job would be created,
  // throw `NonRetryableReDeriveError` in the handler, and burn a
  // `rule-rederive-failed` notification on a request that never had a chance
  // of succeeding.
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    res.status(400).json({ error: "Invalid tenantId" });
    return;
  }
  if (typeof pageUrlPattern !== "string" || pageUrlPattern.length === 0) {
    res.status(400).json({ error: "pageUrlPattern must be a non-empty string" });
    return;
  }
  if (typeof formIdentifier !== "string" || formIdentifier.length === 0) {
    res.status(400).json({ error: "formIdentifier must be a non-empty string" });
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

  let resultRule;
  let wasUpdate = false;
  if (existing.length > 0) {
    const [updated] = await db.update(fieldMappingRulesTable)
      .set({ mapsTo, priority: priority ?? 0, updatedAt: new Date() })
      .where(eq(fieldMappingRulesTable.id, existing[0].id))
      .returning();
    resultRule = updated;
    wasUpdate = true;
  } else {
    const [row] = await db.insert(fieldMappingRulesTable).values({
      tenantId,
      pageUrlPattern,
      formIdentifier,
      fieldName,
      mapsTo,
      priority: priority ?? 0,
    }).returning();
    resultRule = row;
  }

  invalidateRuleCache(tenantId, pageUrlPattern);

  // When the operator edits a mapping from a lead/event context, immediately
  // re-run field detection + funnel normalization for that lead so the open
  // Pulse drawer reflects the new funnel without waiting for the next ingest.
  let leadFunnelChanged = false;
  let resolvedLeadId: number | null = null;
  if (typeof leadId === "number" && Number.isFinite(leadId)) {
    resolvedLeadId = leadId;
  } else if (typeof attributionEventId === "number" && Number.isFinite(attributionEventId)) {
    const [ev] = await db.select({ createdLeadId: attributionEventsTable.createdLeadId, tenantId: attributionEventsTable.tenantId })
      .from(attributionEventsTable)
      .where(eq(attributionEventsTable.id, attributionEventId));
    if (ev && ev.tenantId === tenantId && ev.createdLeadId) resolvedLeadId = ev.createdLeadId;
  }
  if (resolvedLeadId) {
    try {
      const rederive = await reDeriveLeadFunnel(tenantId, resolvedLeadId, {
        attributionEventId: typeof attributionEventId === "number" && Number.isFinite(attributionEventId)
          ? attributionEventId
          : undefined,
      });
      if (rederive?.changed) leadFunnelChanged = true;
    } catch (err) {
      console.error("[field-mapping-rules.POST] reDeriveLeadFunnel failed:", err);
    }
  }

  // scope so older form submissions also pick up this mapping. We enqueue
  // this as a durable background job so the save stays snappy and the work
  // survives restarts, gets retried on failure, and is observable via the
  // `background_jobs` table. The job handler emits `rule-rederive-complete`
  // on the tenant socket room when it finishes so the operator's panel can
  // clear its "working…" state.
  try {
    await enqueueReDeriveLeadsForRuleScope({
      tenantId,
      pageUrlPattern: pageUrlPattern as string,
      formIdentifier: formIdentifier as string,
      excludeLeadId: resolvedLeadId,
    });
  } catch (err) {
    console.error("[field-mapping-rules.POST] failed to enqueue rederive job:", err);
    // Surface the enqueue failure to the operator's UI so they aren't left
    // staring at a "working…" indicator forever — the panel will replace it
    // with a "couldn't re-derive historical leads" hint and a retry button.
    // Best-effort pending-lead count so the panel can show
    // "~N historical leads still need updating" next to the retry button.
    let pendingCount: Awaited<ReturnType<typeof countPendingRederiveLeadsForRuleScope>> | null = null;
    try {
      pendingCount = await countPendingRederiveLeadsForRuleScope(
        tenantId,
        pageUrlPattern as string,
        formIdentifier as string,
        { excludeLeadId: resolvedLeadId },
      );
    } catch (countErr) {
      console.error("[field-mapping-rules.POST] countPendingRederiveLeadsForRuleScope failed:", countErr);
    }
    try {
      emitRuleRederiveFailed(tenantId, {
        pageUrlPattern: pageUrlPattern as string,
        formIdentifier: formIdentifier as string,
        reason: mapReDeriveErrorForOperator(err),
        pendingLeads: pendingCount?.pendingLeads,
        hitLimit: pendingCount?.hitLimit,
        maxLeads: pendingCount?.maxLeads,
        lastAttemptedAt: pendingCount?.lastAttemptedAt ?? new Date().toISOString(),
      });
    } catch (emitErr) {
      console.error("[field-mapping-rules.POST] emitRuleRederiveFailed failed:", emitErr);
    }
  }

  res.json({ rule: resultRule, updated: wasUpdate, leadFunnelChanged });
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
