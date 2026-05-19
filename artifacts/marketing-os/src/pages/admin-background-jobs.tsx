import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { RefreshCw, RotateCcw, ChevronDown, ChevronRight, Ban } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

interface BackgroundJob {
  id: number;
  tenantId: number | null;
  type: string;
  payload: unknown;
  status: "pending" | "in_progress" | "completed" | "failed" | string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  lastError: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface ListResponse {
  jobs: BackgroundJob[];
  total: number;
  limit: number;
  offset: number;
  types: string[];
  statusCounts: Record<string, number>;
}

const STATUS_OPTIONS = ["pending", "in_progress", "completed", "failed", "cancelled"] as const;
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function statusVariant(status: string): "default" | "success" | "danger" | "neutral" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "in_progress") return "default";
  return "neutral";
}

function formatTs(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function compactJson(value: unknown, max = 120): string {
  if (value === null || value === undefined) return "—";
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (!s) return "—";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export default function AdminBackgroundJobs() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [retrying, setRetrying] = useState<Record<number, boolean>>({});
  const [cancelling, setCancelling] = useState<Record<number, boolean>>({});
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [bulkCancelling, setBulkCancelling] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string>("");
  const inFlightRef = useRef(false);

  const fetchJobs = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (!opts.silent) setError("");
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (typeFilter !== "all") params.set("type", typeFilter);
    params.set("limit", "200");
    try {
      const res = await fetch(`${API_BASE}/api/admin/background-jobs?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const body: ListResponse = await res.json();
      setData(body);
      if (opts.silent) setError("");
    } catch (err) {
      if (!opts.silent) {
        setError(err instanceof Error ? err.message : "Failed to load background jobs");
      }
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => {
    setLoading(true);
    fetchJobs();
  }, [fetchJobs]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        fetchJobs({ silent: true });
      }, 5000);
    };
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        fetchJobs({ silent: true });
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchJobs]);

  const handleRetry = async (id: number) => {
    setRetrying((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(`${API_BASE}/api/admin/background-jobs/${id}/retry`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      await fetchJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry job");
    } finally {
      setRetrying((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handleCancel = async (id: number) => {
    setCancelling((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(`${API_BASE}/api/admin/background-jobs/${id}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      await fetchJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel job");
    } finally {
      setCancelling((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const toggleExpand = (id: number) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const jobs = data?.jobs ?? [];
  const types = data?.types ?? [];
  const statusCounts = data?.statusCounts ?? {};

  // Selection is meaningful only for pending rows — only those can be cancelled.
  const pendingJobs = jobs.filter((j) => j.status === "pending");
  const selectedIds = pendingJobs.map((j) => j.id).filter((id) => selected[id]);
  const allPendingSelected = pendingJobs.length > 0 && selectedIds.length === pendingJobs.length;
  const somePendingSelected = selectedIds.length > 0 && !allPendingSelected;

  // Drop selections that no longer correspond to a visible pending row (e.g.
  // after a refresh moves them out of `pending`). Avoids stale ids leaking
  // into the bulk request.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(pendingJobs.map((j) => j.id));
      let changed = false;
      const next: Record<number, boolean> = {};
      for (const [k, v] of Object.entries(prev)) {
        const idNum = Number(k);
        if (v && visible.has(idNum)) {
          next[idNum] = true;
        } else if (v) {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // pendingJobs identity changes per render; key off the data snapshot.
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });

  const toggleSelectAll = () => {
    if (allPendingSelected) {
      setSelected({});
    } else {
      const next: Record<number, boolean> = {};
      for (const j of pendingJobs) next[j.id] = true;
      setSelected(next);
    }
  };

  const runBulkCancel = async (
    scope: { ids?: number[]; type?: string },
    confirmMessage: string,
  ) => {
    if (!window.confirm(confirmMessage)) return;
    setBulkCancelling(true);
    setBulkNotice("");
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/background-jobs/bulk-cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const n = typeof body.cancelledCount === "number" ? body.cancelledCount : 0;
      setBulkNotice(
        n === 0
          ? "No pending jobs matched — nothing was cancelled."
          : `Cancelled ${n} pending job${n === 1 ? "" : "s"}.`,
      );
      setSelected({});
      await fetchJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to bulk-cancel jobs");
    } finally {
      setBulkCancelling(false);
    }
  };

  const handleBulkCancelSelected = () => {
    if (selectedIds.length === 0) return;
    void runBulkCancel(
      { ids: selectedIds },
      `Cancel ${selectedIds.length} selected pending job${selectedIds.length === 1 ? "" : "s"}? This cannot be undone.`,
    );
  };

  const handleBulkCancelByType = () => {
    if (typeFilter === "all") return;
    void runBulkCancel(
      { type: typeFilter },
      `Cancel ALL pending jobs of type "${typeFilter}"? This cannot be undone.`,
    );
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Background Jobs</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">
            DURABLE WORKER QUEUE · STATUS & RETRIES
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); fetchJobs(); }}
          className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-sm transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {STATUS_OPTIONS.map((s) => (
          <PremiumCard key={s} className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{STATUS_LABELS[s]}</div>
            <div className="text-2xl font-display text-white mt-1">{statusCounts[s] ?? 0}</div>
          </PremiumCard>
        ))}
      </div>

      <PremiumCard className="p-4">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Status</span>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="bg-background/50 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm min-w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Type</span>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="bg-background/50 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm min-w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {types.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="md:ml-auto text-sm text-muted-foreground">
            {data ? `${jobs.length} of ${data.total} shown` : ""}
          </div>
        </div>
      </PremiumCard>

      {(selectedIds.length > 0 || (typeFilter !== "all" && (statusCounts.pending ?? 0) > 0)) && (
        <PremiumCard className="p-3 flex flex-col md:flex-row md:items-center gap-3">
          <div className="text-sm text-white">
            {selectedIds.length > 0
              ? `${selectedIds.length} pending job${selectedIds.length === 1 ? "" : "s"} selected`
              : `Bulk cancel by filter`}
          </div>
          <div className="flex flex-wrap gap-2 md:ml-auto">
            {selectedIds.length > 0 && (
              <button
                onClick={handleBulkCancelSelected}
                disabled={bulkCancelling}
                className="inline-flex items-center gap-1 bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50 text-red-100 px-3 py-1.5 rounded text-xs transition-colors"
              >
                <Ban className="w-3 h-3" />
                {bulkCancelling ? "Cancelling..." : `Cancel ${selectedIds.length} selected`}
              </button>
            )}
            {typeFilter !== "all" && (statusCounts.pending ?? 0) > 0 && (
              <button
                onClick={handleBulkCancelByType}
                disabled={bulkCancelling}
                className="inline-flex items-center gap-1 bg-red-500/10 hover:bg-red-500/20 disabled:opacity-50 text-red-100 px-3 py-1.5 rounded text-xs transition-colors border border-red-500/30"
                title={`Cancels every pending job of type "${typeFilter}", even rows not on this page`}
              >
                <Ban className="w-3 h-3" />
                {bulkCancelling ? "Cancelling..." : `Cancel all pending of "${typeFilter}"`}
              </button>
            )}
          </div>
        </PremiumCard>
      )}

      {bulkNotice && (
        <PremiumCard className="p-3 border border-emerald-500/30 bg-emerald-500/5 text-emerald-100 text-sm">
          {bulkNotice}
        </PremiumCard>
      )}

      {error && (
        <PremiumCard className="p-4 border border-red-500/30 bg-red-500/5 text-red-200 text-sm">
          {error}
        </PremiumCard>
      )}

      <PremiumCard className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Loading background jobs...</div>
        ) : jobs.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">No background jobs match the current filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5 bg-background/50">
                  <th className="p-3 w-8"></th>
                  <th className="p-3 w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all pending jobs"
                      checked={allPendingSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = somePendingSelected;
                      }}
                      onChange={toggleSelectAll}
                      disabled={pendingJobs.length === 0}
                      className="accent-red-400"
                    />
                  </th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">ID</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Attempts</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Run At</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Completed</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Last Error</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Result</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {jobs.map((job) => {
                  const isOpen = !!expanded[job.id];
                  return (
                    <Fragment key={job.id}>
                      <tr className="hover:bg-white/[0.02] transition-colors align-top">
                        <td className="p-3">
                          <button
                            onClick={() => toggleExpand(job.id)}
                            className="text-muted-foreground hover:text-white"
                            aria-label={isOpen ? "Collapse" : "Expand"}
                          >
                            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                        </td>
                        <td className="p-3">
                          {job.status === "pending" ? (
                            <input
                              type="checkbox"
                              aria-label={`Select job ${job.id}`}
                              checked={!!selected[job.id]}
                              onChange={() => toggleSelect(job.id)}
                              className="accent-red-400"
                            />
                          ) : null}
                        </td>
                        <td className="p-3 font-mono text-xs text-white">{job.id}</td>
                        <td className="p-3 text-sm text-white">{job.type}</td>
                        <td className="p-3">
                          <Badge variant={statusVariant(job.status)}>{STATUS_LABELS[job.status] || job.status}</Badge>
                        </td>
                        <td className="p-3 text-sm text-muted-foreground">{job.attempts} / {job.maxAttempts}</td>
                        <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">{formatTs(job.runAt)}</td>
                        <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">{formatTs(job.completedAt)}</td>
                        <td className="p-3 text-xs text-red-300/80 max-w-[260px] truncate" title={job.lastError ?? ""}>
                          {job.lastError ? job.lastError.split("\n")[0] : "—"}
                        </td>
                        <td className="p-3 text-xs text-muted-foreground max-w-[200px] truncate" title={compactJson(job.result, 5000)}>
                          {compactJson(job.result)}
                        </td>
                        <td className="p-3 text-right">
                          {job.status === "failed" ? (
                            <button
                              onClick={() => handleRetry(job.id)}
                              disabled={!!retrying[job.id]}
                              className="inline-flex items-center gap-1 bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 text-amber-100 px-3 py-1 rounded text-xs transition-colors"
                            >
                              <RotateCcw className="w-3 h-3" />
                              {retrying[job.id] ? "Retrying..." : "Retry"}
                            </button>
                          ) : job.status === "pending" ? (
                            <button
                              onClick={() => handleCancel(job.id)}
                              disabled={!!cancelling[job.id]}
                              className="inline-flex items-center gap-1 bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50 text-red-100 px-3 py-1 rounded text-xs transition-colors"
                            >
                              <Ban className="w-3 h-3" />
                              {cancelling[job.id] ? "Cancelling..." : "Cancel"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-background/40">
                          <td></td>
                          <td colSpan={10} className="p-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                              <div>
                                <div className="text-muted-foreground uppercase tracking-wider mb-1">Tenant ID</div>
                                <div className="text-white">{job.tenantId ?? "—"}</div>
                              </div>
                              <div>
                                <div className="text-muted-foreground uppercase tracking-wider mb-1">Locked By</div>
                                <div className="text-white">{job.lockedBy ?? "—"}</div>
                              </div>
                              <div>
                                <div className="text-muted-foreground uppercase tracking-wider mb-1">Created</div>
                                <div className="text-white">{formatTs(job.createdAt)}</div>
                              </div>
                              <div>
                                <div className="text-muted-foreground uppercase tracking-wider mb-1">Updated</div>
                                <div className="text-white">{formatTs(job.updatedAt)}</div>
                              </div>
                              <div className="md:col-span-2">
                                <div className="text-muted-foreground uppercase tracking-wider mb-1">Payload</div>
                                <pre className="bg-background/60 border border-white/10 rounded p-3 text-white whitespace-pre-wrap break-all max-h-48 overflow-auto">{JSON.stringify(job.payload ?? null, null, 2)}</pre>
                              </div>
                              <div className="md:col-span-2">
                                <div className="text-muted-foreground uppercase tracking-wider mb-1">Result</div>
                                <pre className="bg-background/60 border border-white/10 rounded p-3 text-white whitespace-pre-wrap break-all max-h-48 overflow-auto">{JSON.stringify(job.result ?? null, null, 2)}</pre>
                              </div>
                              {job.lastError && (
                                <div className="md:col-span-2">
                                  <div className="text-muted-foreground uppercase tracking-wider mb-1">Last Error</div>
                                  <pre className="bg-red-500/5 border border-red-500/20 rounded p-3 text-red-200 whitespace-pre-wrap break-all max-h-64 overflow-auto">{job.lastError}</pre>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}
