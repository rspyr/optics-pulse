import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ExternalLink, X } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useLeadNotification } from "@/contexts/lead-notification-context";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type PendingLead = {
  id: number;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  funnelId: number | null;
  leadType: string | null;
  serviceType: string | null;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: number;
  pageUrlPattern: string;
  formIdentifier: string;
  /**
   * Optional lead id to omit from the list — used by the inline-correction
   * surfaces in `attribution.tsx` so the lead the operator is already viewing
   * isn't echoed back as a "pending" hit.
   */
  excludeLeadId?: number | null;
};

type JobProgress = {
  processed: number;
  succeeded: number;
  failed: number;
  changed: number;
};

type BulkResult =
  | {
      mode: "sync";
      total: number;
      succeeded: number;
      failed: number;
      changed: number;
      failedLeadIds: number[];
      failedLeadErrors?: Record<number, string>;
    }
  | {
      mode: "queued";
      total: number;
      jobId: number | null;
      // Periodic per-chunk progress emitted by the handler so the sheet can
      // render a progress bar like "Re-derived 42/150 leads…" instead of an
      // opaque spinner. Filled in by `selected-leads-rederive-progress`
      // socket events (or by an on-mount/on-reconnect REST fetch).
      progress?: JobProgress;
      // The background job result is filled in once the
      // `selected-leads-rederive-complete` socket event arrives. Until then
      // the sheet shows a progress bar driven by `progress` above.
      jobResult?: {
        succeeded: number;
        failed: number;
        changed: number;
        failedLeadIds: number[];
        // Per-lead failure reason map, populated by
        // `selected-leads-rederive-complete` (or the REST reconnect-fetch).
        // Used to render a short reason next to each failed row.
        failedLeadErrors?: Record<number, string>;
      };
      // Set when a `selected-leads-rederive-failed` event arrives (or the
      // safety timeout elapses without any event). Surfaces a retry button.
      jobError?: string;
      // Set when an operator cancels the in-flight job via the Cancel
      // button (or the cancelled event/snapshot arrives via reconnect).
      // Holds the partial counts at the moment of cancellation so the
      // sheet can render "Cancelled at X/Y leads" with succeeded counts
      // preserved.
      jobCancelled?: {
        processed: number;
        succeeded: number;
        failed: number;
        changed: number;
        failedLeadIds: number[];
        // Leads that were queued but never reached before cancel. Drives
        // the "X leads skipped" line and the "Re-derive the rest" button so
        // the operator can re-queue just the unprocessed tail without
        // re-selecting rows from the list.
        skippedLeadIds: number[];
      };
    };

function fmtName(l: PendingLead) {
  const name = `${l.firstName ?? ""} ${l.lastName ?? ""}`.trim();
  return name || `Lead #${l.id}`;
}

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Sheet that lists the historical leads still pending a re-derive for the
 * given rule scope. Opened from the "View pending leads" link on a re-derive
 * failure hint so operators can drill into which specific leads still need
 * updating after the back-fill fan-out failed.
 *
 * The list is server-filtered to the same (pageUrlPattern, formIdentifier)
 * scope and lookback window the fan-out itself would use, so what the
 * operator sees here is exactly the population a successful retry would touch.
 *
 * Operators can also multi-select leads and re-derive just that subset via
 * the bulk endpoint, which short-circuits the full fan-out retry for cases
 * where they already know which specific leads are still wrong.
 */
export function PendingRederiveLeadsSheet({
  open,
  onOpenChange,
  tenantId,
  pageUrlPattern,
  formIdentifier,
  excludeLeadId,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leads, setLeads] = useState<PendingLead[]>([]);
  const [hitLimit, setHitLimit] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const {
    onSelectedLeadsRederiveComplete,
    onSelectedLeadsRederiveFailed,
    onSelectedLeadsRederiveProgress,
    onSelectedLeadsRederiveCancelled,
    onReconnect,
  } = useLeadNotification();
  // Safety timeout for the queued path — if no socket event arrives within
  // this window the sheet surfaces a retry button so the operator is never
  // stuck staring at a "running…" indicator forever.
  const QUEUED_TIMEOUT_MS = 5 * 60 * 1000;
  const queuedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    setBulkResult(null);
    setBulkError(null);
    const params = new URLSearchParams({
      tenantId: String(tenantId),
      pageUrlPattern,
      formIdentifier,
    });
    if (excludeLeadId != null) params.set("excludeLeadId", String(excludeLeadId));
    fetch(`${API_BASE}/api/field-mapping-rules/pending-rederive-leads?${params.toString()}`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((d: { leads: PendingLead[]; hitLimit: boolean }) => {
        if (cancelled) return;
        setLeads(Array.isArray(d.leads) ? d.leads : []);
        setHitLimit(Boolean(d.hitLimit));
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message || "Failed to load pending leads");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, tenantId, pageUrlPattern, formIdentifier, excludeLeadId]);

  // When the sheet closes, clear any bulk result/error and cancel the
  // queued-job safety timeout. Without this, a late socket event (or a
  // pending timer) firing after the sheet has been closed and reopened with
  // a *different* scope can briefly flash stale data on the new sheet.
  useEffect(() => {
    if (open) return;
    setBulkResult(null);
    setBulkError(null);
    if (queuedTimerRef.current) {
      clearTimeout(queuedTimerRef.current);
      queuedTimerRef.current = null;
    }
  }, [open]);

  const allSelected = leads.length > 0 && selected.size === leads.length;
  const someSelected = selected.size > 0 && selected.size < leads.length;

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(leads.map((l) => l.id)));
    }
  };

  const failedIds = useMemo(() => {
    if (bulkResult?.mode === "sync") return new Set(bulkResult.failedLeadIds);
    if (bulkResult?.mode === "queued" && bulkResult.jobResult) {
      return new Set(bulkResult.jobResult.failedLeadIds);
    }
    if (bulkResult?.mode === "queued" && bulkResult.jobCancelled) {
      return new Set(bulkResult.jobCancelled.failedLeadIds);
    }
    return new Set<number>();
  }, [bulkResult]);

  // Per-lead failure reason lookup so each highlighted row can show *why*
  // it failed. Falls back to an empty object on older server builds that
  // only emit `failedLeadIds`.
  const failedReasons = useMemo<Record<number, string>>(() => {
    if (bulkResult?.mode === "sync") return bulkResult.failedLeadErrors ?? {};
    if (bulkResult?.mode === "queued" && bulkResult.jobResult) {
      return bulkResult.jobResult.failedLeadErrors ?? {};
    }
    return {};
  }, [bulkResult]);

  const isJobRunning =
    bulkResult?.mode === "queued" &&
    !bulkResult.jobResult &&
    !bulkResult.jobError &&
    !bulkResult.jobCancelled;

  const bulkResultMode = bulkResult?.mode;
  const bulkResultJobId = bulkResult?.mode === "queued" ? bulkResult.jobId : null;

  // Subscribe to the background job's progress/completion/failure events so
  // the sheet can render a "Re-derived X/Y leads…" progress bar and fill in
  // the final success/failure/changed counts (or surface a retry hint on
  // failure / timeout). We filter on jobId so a concurrent bulk re-derive
  // started elsewhere in the tenant doesn't corrupt this sheet's display.
  //
  // Dependencies are intentionally narrowed to `(isJobRunning, mode, jobId,
  // total, tenantId, ...register callbacks)` — depending on the full
  // `bulkResult` would re-run the effect on every progress tick (which then
  // re-subscribes and re-fetches the snapshot needlessly).
  useEffect(() => {
    if (!isJobRunning) return;
    if (bulkResultMode !== "queued") return;
    const targetJobId = bulkResultJobId;

    const clearTimer = () => {
      if (queuedTimerRef.current) {
        clearTimeout(queuedTimerRef.current);
        queuedTimerRef.current = null;
      }
    };

    // Reset / extend the no-event safety timeout. Called whenever a progress
    // tick arrives so a long but healthy job doesn't trip the "timed out"
    // hint just because the whole batch takes longer than QUEUED_TIMEOUT_MS.
    const armSafetyTimer = () => {
      clearTimer();
      queuedTimerRef.current = setTimeout(() => {
        setBulkResult((prev) =>
          prev?.mode === "queued" && !prev.jobResult && !prev.jobError
            ? { ...prev, jobError: "Timed out waiting for background job to finish" }
            : prev,
        );
      }, QUEUED_TIMEOUT_MS);
    };

    const unsubProgress = onSelectedLeadsRederiveProgress((data) => {
      if (targetJobId != null && data.jobId !== targetJobId) return;
      armSafetyTimer();
      setBulkResult((prev) =>
        prev?.mode === "queued"
          ? {
              ...prev,
              progress: {
                processed: data.processed,
                succeeded: data.succeeded,
                failed: data.failed,
                changed: data.changed,
              },
            }
          : prev,
      );
    });
    const unsubCancelled = onSelectedLeadsRederiveCancelled((data) => {
      if (targetJobId != null && data.jobId !== targetJobId) return;
      clearTimer();
      setBulkResult((prev) =>
        prev?.mode === "queued" && !prev.jobResult && !prev.jobError
          ? {
              ...prev,
              jobCancelled: {
                processed: data.processed,
                succeeded: data.succeeded,
                failed: data.failed,
                changed: data.changed,
                failedLeadIds: data.failedLeadIds,
                skippedLeadIds: data.skippedLeadIds ?? [],
              },
            }
          : prev,
      );
    });
    const unsubComplete = onSelectedLeadsRederiveComplete((data) => {
      if (targetJobId != null && data.jobId !== targetJobId) return;
      clearTimer();
      setBulkResult((prev) =>
        prev?.mode === "queued"
          ? {
              ...prev,
              jobResult: {
                succeeded: data.succeeded,
                failed: data.failed,
                changed: data.changed,
                failedLeadIds: data.failedLeadIds,
                failedLeadErrors: data.failedLeadErrors,
              },
              jobError: undefined,
            }
          : prev,
      );
    });
    const unsubFailed = onSelectedLeadsRederiveFailed((data) => {
      if (targetJobId != null && data.jobId !== targetJobId) return;
      clearTimer();
      setBulkResult((prev) =>
        prev?.mode === "queued"
          ? { ...prev, jobError: data.reason || "Background job failed" }
          : prev,
      );
    });

    // On (re)connect, fetch the latest in-memory progress snapshot so the
    // bar resumes from the server's view of the world instead of staying
    // pegged at the last tick that arrived before the disconnect. Also fired
    // once on initial subscription so a sheet that opened after the job
    // already started doesn't sit at 0/total until the next chunk fires.
    const fetchProgressSnapshot = () => {
      if (targetJobId == null) return;
      const params = new URLSearchParams({
        tenantId: String(tenantId),
        jobId: String(targetJobId),
      });
      fetch(`${API_BASE}/api/field-mapping-rules/rederive-job-progress?${params.toString()}`, {
        credentials: "include",
      })
        .then(async (res) => {
          if (!res.ok) return null;
          return res.json();
        })
        .then((d: {
          status?: "running" | "complete" | "failed" | "cancelled";
          processed: number;
          succeeded: number;
          failed: number;
          changed: number;
          failedLeadIds?: number[];
          skippedLeadIds?: number[];
          failedLeadErrors?: Record<number, string>;
          reason?: string;
        } | null) => {
          if (!d) return;
          // Terminal snapshots resolve the bar even when the client missed
          // the live `selected-leads-rederive-{complete,failed}` socket
          // event during a disconnect — the server keeps terminal snapshots
          // for a short TTL precisely so this fetch can recover the outcome.
          if (d.status === "complete") {
            clearTimer();
            setBulkResult((prev) =>
              prev?.mode === "queued" && !prev.jobResult && !prev.jobError
                ? {
                    ...prev,
                    jobResult: {
                      succeeded: d.succeeded,
                      failed: d.failed,
                      changed: d.changed,
                      failedLeadIds: d.failedLeadIds ?? [],
                      failedLeadErrors: d.failedLeadErrors,
                    },
                  }
                : prev,
            );
            return;
          }
          if (d.status === "failed") {
            clearTimer();
            setBulkResult((prev) =>
              prev?.mode === "queued" && !prev.jobResult && !prev.jobError
                ? { ...prev, jobError: d.reason || "Background job failed" }
                : prev,
            );
            return;
          }
          if (d.status === "cancelled") {
            clearTimer();
            setBulkResult((prev) =>
              prev?.mode === "queued" && !prev.jobResult && !prev.jobError && !prev.jobCancelled
                ? {
                    ...prev,
                    jobCancelled: {
                      processed: d.processed,
                      succeeded: d.succeeded,
                      failed: d.failed,
                      changed: d.changed,
                      failedLeadIds: d.failedLeadIds ?? [],
                      skippedLeadIds: d.skippedLeadIds ?? [],
                    },
                  }
                : prev,
            );
            return;
          }
          setBulkResult((prev) =>
            prev?.mode === "queued" && !prev.jobResult && !prev.jobError
              ? {
                  ...prev,
                  progress: {
                    processed: d.processed,
                    succeeded: d.succeeded,
                    failed: d.failed,
                    changed: d.changed,
                  },
                }
              : prev,
          );
        })
        .catch(() => { /* best-effort; next socket tick will catch us up */ });
    };
    fetchProgressSnapshot();
    const unsubReconnect = onReconnect(fetchProgressSnapshot);

    armSafetyTimer();

    return () => {
      unsubProgress();
      unsubComplete();
      unsubFailed();
      unsubCancelled();
      unsubReconnect();
      clearTimer();
    };
  }, [isJobRunning, bulkResultMode, bulkResultJobId, tenantId, onSelectedLeadsRederiveProgress, onSelectedLeadsRederiveComplete, onSelectedLeadsRederiveFailed, onSelectedLeadsRederiveCancelled, onReconnect]);

  async function cancelRunningJob() {
    if (bulkResult?.mode !== "queued" || bulkResult.jobId == null) return;
    if (cancelling) return;
    setCancelling(true);
    try {
      const url = `${API_BASE}/api/field-mapping-rules/rederive-jobs/${bulkResult.jobId}/cancel?tenantId=${encodeURIComponent(String(tenantId))}`;
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        // 409 ("already terminal") is benign — the job finished between the
        // operator clicking Cancel and the request landing. The complete /
        // failed event handlers will resolve the bar; nothing to do here.
        if (res.status !== 409) {
          throw new Error(d.error || `HTTP ${res.status}`);
        }
      }
      // The terminal state is set by the `selected-leads-rederive-cancelled`
      // socket event (or REST snapshot) so a manager who cancels from a
      // different tab also sees the cancelled outcome. We don't optimistically
      // flip state here — that would diverge from the server's view if the
      // job had already completed by the time the cancel request landed.
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : "Failed to cancel job");
    } finally {
      setCancelling(false);
    }
  }

  async function submitRederive(leadIdsOverride?: number[]) {
    const leadIds = leadIdsOverride ?? Array.from(selected);
    if (leadIds.length === 0 || submitting) return;
    setSubmitting(true);
    setBulkError(null);
    setBulkResult(null);
    try {
      // tenantId is sent both as a query param (so `resolveTenantId` on the
      // server picks it up for super_admin / agency_user contexts that aren't
      // bound to a single tenant by session) and in the body so the request
      // is self-contained for logging/debugging.
      const url = `${API_BASE}/api/field-mapping-rules/rederive-leads?tenantId=${encodeURIComponent(String(tenantId))}`;
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId,
          leadIds,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      const result = d as BulkResult;
      setBulkResult(result);
      // After a sync re-derive, the succeeded leads are no longer "pending"
      // for this rule scope — drop them from the visible list so the sheet
      // reflects the new state. Failed ones stay (highlighted via
      // `failedIds`) so the operator can retry them, and the selection is
      // narrowed to just the failed rows so a retry click re-submits the
      // right subset.
      if (result.mode === "sync") {
        const submittedIds = Array.from(selected);
        const failedSet = new Set(result.failedLeadIds);
        setLeads((prev) =>
          prev.filter((l) => !submittedIds.includes(l.id) || failedSet.has(l.id)),
        );
        setSelected(new Set(submittedIds.filter((id) => failedSet.has(id))));
      }
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : "Failed to re-derive selected leads");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md overflow-y-auto"
        data-testid="pending-rederive-leads-sheet"
      >
        <SheetHeader>
          <SheetTitle>Pending historical leads</SheetTitle>
          <SheetDescription>
            Leads matching{" "}
            <code className="text-white/80">{pageUrlPattern}</code>
            {formIdentifier !== "*" && (
              <> · <code className="text-white/80">{formIdentifier}</code></>
            )}{" "}
            that still need re-deriving.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-2">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="pending-leads-loading">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading pending leads…
            </div>
          )}
          {error && !loading && (
            <p className="text-xs text-red-400" data-testid="pending-leads-error">{error}</p>
          )}
          {!loading && !error && leads.length === 0 && (
            <p className="text-xs text-muted-foreground italic" data-testid="pending-leads-empty">
              No historical leads still need updating.
            </p>
          )}
          {!loading && !error && leads.length > 0 && (
            <>
              <p className="text-[11px] text-muted-foreground">
                {leads.length}{hitLimit ? "+" : ""} lead{leads.length === 1 ? "" : "s"} pending re-derive.
                {hitLimit && " Showing capped set."}
              </p>

              <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
                <label className="flex items-center gap-2 text-[11px] text-white/80 cursor-pointer select-none">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={toggleAll}
                    data-testid="pending-leads-select-all"
                  />
                  <span>
                    {selected.size > 0
                      ? `${selected.size} selected`
                      : "Select all"}
                  </span>
                </label>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={selected.size === 0 || submitting}
                  onClick={() => submitRederive()}
                  data-testid="pending-leads-rederive-selected"
                  className="h-7 text-xs"
                >
                  {submitting && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                  Re-derive selected
                </Button>
              </div>

              {bulkError && (
                <p
                  className="text-xs text-red-400"
                  data-testid="pending-leads-bulk-error"
                >
                  {bulkError}
                </p>
              )}

              {bulkResult?.mode === "sync" && (
                <p
                  className="text-xs text-white/80"
                  data-testid="pending-leads-bulk-result"
                >
                  Re-derived {bulkResult.succeeded}/{bulkResult.total} leads
                  {bulkResult.changed > 0 && (
                    <> · {bulkResult.changed} updated</>
                  )}
                  {bulkResult.failed > 0 && (
                    <span className="text-red-400">
                      {" "}· {bulkResult.failed} failed
                    </span>
                  )}
                </p>
              )}
              {bulkResult?.mode === "queued" && !bulkResult.jobResult && !bulkResult.jobError && !bulkResult.jobCancelled && (
                <div
                  className="space-y-1.5"
                  data-testid="pending-leads-bulk-result"
                >
                  <div className="flex items-start gap-2">
                    <p className="text-xs text-white/80 flex items-center gap-2 flex-1 min-w-0">
                      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                      <span className="truncate">
                        {bulkResult.progress
                          ? `Re-derived ${bulkResult.progress.processed}/${bulkResult.total} leads…`
                          : `Re-deriving ${bulkResult.total} leads in the background…`}
                        {bulkResult.progress && bulkResult.progress.failed > 0 && (
                          <span className="text-red-400">
                            {" "}· {bulkResult.progress.failed} failed
                          </span>
                        )}
                      </span>
                    </p>
                    {bulkResult.jobId != null && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={cancelling}
                        onClick={cancelRunningJob}
                        data-testid="pending-leads-bulk-cancel"
                        className="h-6 text-[11px] px-2 text-white/70 hover:text-white"
                      >
                        {cancelling
                          ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
                          : <X className="w-3 h-3 mr-1" />}
                        Cancel
                      </Button>
                    )}
                  </div>
                  <Progress
                    value={
                      bulkResult.total > 0
                        ? Math.min(
                            100,
                            ((bulkResult.progress?.processed ?? 0) / bulkResult.total) * 100,
                          )
                        : 0
                    }
                    className="h-1.5"
                    data-testid="pending-leads-bulk-progress-bar"
                  />
                </div>
              )}
              {bulkResult?.mode === "queued" && bulkResult.jobResult && (
                <p
                  className="text-xs text-white/80"
                  data-testid="pending-leads-bulk-result"
                >
                  Re-derived {bulkResult.jobResult.succeeded}/{bulkResult.total} leads
                  {bulkResult.jobResult.changed > 0 && (
                    <> · {bulkResult.jobResult.changed} updated</>
                  )}
                  {bulkResult.jobResult.failed > 0 && (
                    <span className="text-red-400">
                      {" "}· {bulkResult.jobResult.failed} failed
                    </span>
                  )}
                </p>
              )}
              {bulkResult?.mode === "queued" && bulkResult.jobCancelled && (
                <div
                  className="space-y-1.5"
                  data-testid="pending-leads-bulk-cancelled"
                >
                  <p className="text-xs text-amber-300">
                    Cancelled at {bulkResult.jobCancelled.processed}/{bulkResult.total} leads
                    {" "}· {bulkResult.jobCancelled.succeeded} succeeded
                    {bulkResult.jobCancelled.changed > 0 && (
                      <> · {bulkResult.jobCancelled.changed} updated</>
                    )}
                    {bulkResult.jobCancelled.failed > 0 && (
                      <span className="text-red-400">
                        {" "}· {bulkResult.jobCancelled.failed} failed
                      </span>
                    )}
                    {bulkResult.jobCancelled.skippedLeadIds.length > 0 && (
                      <> · {bulkResult.jobCancelled.skippedLeadIds.length} skipped</>
                    )}
                  </p>
                  {bulkResult.jobCancelled.skippedLeadIds.length > 0 && (
                    <div className="flex items-start gap-2">
                      <p
                        className="text-[11px] text-white/60 flex-1 break-words"
                        data-testid="pending-leads-bulk-skipped-ids"
                        title={bulkResult.jobCancelled.skippedLeadIds.join(", ")}
                      >
                        Skipped lead IDs:{" "}
                        <span className="text-white/80">
                          {bulkResult.jobCancelled.skippedLeadIds.slice(0, 10).join(", ")}
                          {bulkResult.jobCancelled.skippedLeadIds.length > 10 && (
                            <> …+{bulkResult.jobCancelled.skippedLeadIds.length - 10} more</>
                          )}
                        </span>
                      </p>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={submitting}
                        onClick={() =>
                          bulkResult.jobCancelled &&
                          submitRederive(bulkResult.jobCancelled.skippedLeadIds)
                        }
                        data-testid="pending-leads-bulk-rederive-rest"
                        className="h-6 text-[11px] px-2 shrink-0"
                      >
                        {submitting && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                        Re-derive the rest
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {bulkResult?.mode === "queued" && bulkResult.jobError && (
                <div
                  className="flex items-start gap-2 text-xs text-red-400"
                  data-testid="pending-leads-bulk-job-error"
                >
                  <span className="flex-1">
                    Background re-derive failed: {bulkResult.jobError}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={submitting}
                    onClick={() => submitRederive(Array.from(selected))}
                    data-testid="pending-leads-bulk-retry"
                    className="h-6 text-[11px] px-2"
                  >
                    {submitting && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                    Retry
                  </Button>
                </div>
              )}

              <ul className="space-y-1.5" data-testid="pending-leads-list">
                {leads.map((l) => {
                  const isSelected = selected.has(l.id);
                  const isFailed = failedIds.has(l.id);
                  const failureReason = isFailed ? failedReasons[l.id] : undefined;
                  return (
                    <li
                      key={l.id}
                      className={`border rounded-md px-2.5 py-2 ${
                        isFailed
                          ? "border-red-500/40 bg-red-500/[0.04]"
                          : "border-white/10 bg-white/[0.02]"
                      }`}
                      data-testid={`pending-lead-row-${l.id}`}
                    >
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleOne(l.id)}
                          data-testid={`pending-lead-checkbox-${l.id}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-white/90 truncate">{fmtName(l)}</p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {l.phone || l.email || "—"}
                            {l.createdAt && (
                              <span className="text-white/40"> · created {fmtRelative(l.createdAt)}</span>
                            )}
                          </p>
                          {isFailed && failureReason && (
                            <p
                              className="text-[11px] text-red-400 mt-0.5 break-words"
                              title={failureReason}
                              data-testid={`pending-lead-failure-reason-${l.id}`}
                            >
                              Failed: {failureReason}
                            </p>
                          )}
                          {isFailed && !failureReason && (
                            <p
                              className="text-[11px] text-red-400 mt-0.5 italic"
                              data-testid={`pending-lead-failure-reason-${l.id}`}
                            >
                              Failed (no reason reported)
                            </p>
                          )}
                        </div>
                        <a
                          href={`${API_BASE}/?leadId=${l.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 shrink-0"
                          data-testid={`pending-lead-link-${l.id}`}
                        >
                          View <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
