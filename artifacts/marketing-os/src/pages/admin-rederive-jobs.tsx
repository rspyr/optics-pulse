import { useState, useEffect, useCallback, useRef } from "react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { RefreshCw, Trash2 } from "lucide-react";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

interface CancelledRederiveJob {
  id: number;
  tenantId: number | null;
  tenantName: string | null;
  pageUrlPattern: string | null;
  formIdentifier: string | null;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  changed: number;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
}

interface ListResponse {
  jobs: CancelledRederiveJob[];
  total: number;
  limit: number;
}

function formatTs(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function formatAge(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export default function AdminRederiveJobs() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [pruning, setPruning] = useState(false);
  const [pruneNotice, setPruneNotice] = useState<string>("");
  const inFlightRef = useRef(false);

  const fetchJobs = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (!opts.silent) setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/rederive-jobs/cancelled?limit=200`, {
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
        setError(err instanceof Error ? err.message : "Failed to load cancelled re-derive jobs");
      }
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchJobs();
  }, [fetchJobs]);

  const handlePruneNow = async () => {
    if (
      !window.confirm(
        "Prune cancelled re-derive snapshots older than 30 days? This deletes the matching background_jobs rows.",
      )
    ) {
      return;
    }
    setPruning(true);
    setPruneNotice("");
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/rederive-jobs/cleanup`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const n = typeof body.deletedCount === "number" ? body.deletedCount : 0;
      const days = typeof body.retentionDays === "number" ? body.retentionDays : 30;
      setPruneNotice(
        n === 0
          ? `No cancelled snapshots older than ${days} days — nothing was deleted.`
          : `Deleted ${n} cancelled snapshot${n === 1 ? "" : "s"} older than ${days} days.`,
      );
      await fetchJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run cleanup sweep");
    } finally {
      setPruning(false);
    }
  };

  const jobs = data?.jobs ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">
            Re-derive Snapshots
          </GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">
            CANCELLED BULK RE-DERIVE JOBS · CLEANUP
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setLoading(true); fetchJobs(); }}
            className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-sm transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          <button
            onClick={handlePruneNow}
            disabled={pruning}
            className="flex items-center gap-2 bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50 text-red-100 px-4 py-2 rounded-lg text-sm transition-colors border border-red-500/30"
            title="Delete cancelled rederive_selected_leads rows older than 30 days"
          >
            <Trash2 className="w-4 h-4" />
            {pruning ? "Pruning..." : "Prune now"}
          </button>
        </div>
      </header>

      <PremiumCard className="p-4">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="text-sm text-muted-foreground">
            Cancelled snapshots live on the <code className="text-white">background_jobs</code> table
            so an operator can resume "Re-derive the rest" after a restart. A daily sweep prunes
            anything older than 30 days; this page exposes that sweep on-demand.
          </div>
          <div className="md:ml-auto text-sm text-white whitespace-nowrap">
            {data ? `${jobs.length} of ${data.total} shown` : ""}
          </div>
        </div>
      </PremiumCard>

      {pruneNotice && (
        <PremiumCard className="p-3 border border-emerald-500/30 bg-emerald-500/5 text-emerald-100 text-sm">
          {pruneNotice}
        </PremiumCard>
      )}

      {error && (
        <PremiumCard className="p-4 border border-red-500/30 bg-red-500/5 text-red-200 text-sm">
          {error}
        </PremiumCard>
      )}

      <PremiumCard className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Loading cancelled re-derive jobs...</div>
        ) : jobs.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            No cancelled bulk re-derive snapshots.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5 bg-background/50">
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Job ID</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Tenant</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Scope</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Progress</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Outcome</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Cancelled</th>
                  <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {jobs.map((job) => {
                  const ageRef = job.completedAt ?? job.updatedAt;
                  return (
                    <tr key={job.id} className="hover:bg-white/[0.02] transition-colors align-top">
                      <td className="p-3 font-mono text-xs text-white">{job.id}</td>
                      <td className="p-3 text-sm">
                        <div className="text-white">{job.tenantName ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {job.tenantId != null ? `#${job.tenantId}` : "no tenant"}
                        </div>
                      </td>
                      <td className="p-3 text-xs">
                        <div className="text-white break-all max-w-[320px]" title={job.pageUrlPattern ?? ""}>
                          {job.pageUrlPattern ?? <span className="text-muted-foreground">—</span>}
                        </div>
                        <div className="text-muted-foreground break-all max-w-[320px]" title={job.formIdentifier ?? ""}>
                          {job.formIdentifier ?? "—"}
                        </div>
                      </td>
                      <td className="p-3 text-sm text-white whitespace-nowrap">
                        {job.processed} / {job.total}
                      </td>
                      <td className="p-3 text-xs whitespace-nowrap">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="success">✓ {job.succeeded}</Badge>
                          {job.failed > 0 && <Badge variant="danger">✗ {job.failed}</Badge>}
                          <Badge variant="neutral">Δ {job.changed}</Badge>
                        </div>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                        {formatTs(job.completedAt ?? job.updatedAt)}
                      </td>
                      <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                        {formatAge(ageRef)}
                      </td>
                    </tr>
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
