import { useState, useMemo, useEffect, useCallback } from "react";
import { useAuth } from "@/components/auth-context";
import { useGetAdminDashboardStats, useListLeads, useGetReconciliationStatus, useRunReconciliation, useListTenants } from "@workspace/api-client-react";
import type { ReconciliationRun } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { formatCurrency } from "@/lib/utils";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { ArrowUpDown, TrendingUp, TrendingDown, AlertTriangle, X, Users, DollarSign, Target, BarChart3, Filter, RefreshCw, Clock, Zap, Diamond, Award, Plug, CheckCircle, XCircle, Loader2, ArrowUpRight, Upload } from "lucide-react";

type SortKey = "tenantName" | "mtdSpend" | "cpl" | "bookingRate" | "roas" | "totalLeads" | "mtdRevenue";
type SortDir = "asc" | "desc";

export default function Internal() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const startDate = monthStart.toISOString().split("T")[0];
  const endDate = now.toISOString().split("T")[0];

  // The tenant filter lives in AuthContext so the same selection scopes
  // /attribution, /admin/tenants, and any other admin surface — and survives
  // page reloads via shared localStorage. "All Tenants" is represented as
  // `null` and restores the agency-wide view everywhere.
  const { selectedTenantId: globalTenantId, setSelectedTenantId: setGlobalTenantId } = useAuth();

  const { data, isLoading } = useGetAdminDashboardStats({ startDate, endDate, tenantId: globalTenantId ?? undefined });
  const { data: reconStatus, refetch: refetchRecon } = useGetReconciliationStatus(globalTenantId ? { tenantId: globalTenantId } : undefined);
  const reconMutation = useRunReconciliation();
  // Unfiltered tenant list for the global selector — `data.tenants` collapses
  // to a single row when a tenant is selected, so we can't drive the dropdown
  // off of it.
  const { data: allTenants } = useListTenants();
  const tenantOptions = useMemo(() => {
    const all = allTenants ?? [];
    const active = all
      .filter((t) => t.isActive !== false)
      .map((t) => ({ id: t.id, name: t.name, inactive: false }));
    // If the persisted selection points at a tenant that's been deactivated,
    // surface it in the dropdown with an "(inactive)" tag so the admin can
    // see what's selected and switch away — otherwise the trigger renders
    // blank and the user has no easy escape hatch.
    if (globalTenantId && !active.some((t) => t.id === globalTenantId)) {
      const inactive = all.find((t) => t.id === globalTenantId);
      if (inactive) {
        active.push({ id: inactive.id, name: inactive.name, inactive: true });
      }
    }
    return active.sort((a, b) => a.name.localeCompare(b.name));
  }, [allTenants, globalTenantId]);
  const selectedTenantName = useMemo(() => {
    if (!globalTenantId) return null;
    return tenantOptions.find((t) => t.id === globalTenantId)?.name
      ?? data?.tenants?.[0]?.tenantName
      ?? null;
  }, [globalTenantId, tenantOptions, data?.tenants]);

  const [sortKey, setSortKey] = useState<SortKey>("roas");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [roasFilter, setRoasFilter] = useState<string>("");
  const [drilldownTenant, setDrilldownTenant] = useState<{ id: number; name: string } | null>(null);

  type IntegrationState = "running" | "paused" | "healthy" | "error" | "no_credentials" | "needs_reconnect" | "never";
  const OUTBOUND_SYNC_TYPES = ["oci_upload", "enhanced_conversions", "capi_upload"];
  interface SyncStatus {
    statusByIntegration: Record<string, { lastSync: string | null; lastStatus: string; lastRecords: number; errorCount: number; state?: IntegrationState; needsReconnect?: boolean; reconnectReason?: string | null; syncTypes?: Record<string, { lastRun: string | null; lastStatus: string; recordsProcessed: number }> }>;
    recentLogs: Array<{ id: number; integration: string; syncType: string; status: string; recordsProcessed: number; completedAt: string | null; tenantId: number }>;
    outboundPushStatus?: Record<string, { lastSuccess: string | null; lastStatus: string; recordsPushed: number; lastError: string | null; pendingCount: number }>;
    purgeStatus?: { lastRun: string | null; status: string; recordsProcessed: number } | null;
    backfillStatus?: Record<string, {
      status: string;
      recordsProcessed: number;
      progress: string | null;
      progressDetail?: {
        raw: string;
        kind: "chunk" | "partial" | "other";
        currentChunk: number | null;
        totalChunks: number | null;
        windowStart: string | null;
        windowEnd: string | null;
        percent: number | null;
        partialReason: string | null;
      } | null;
      errorDetail?: {
        raw: string;
        code: string;
        message: string;
        suggestedAction: string;
        partial: boolean;
      } | null;
      startedAt: string | null;
      completedAt: string | null;
    }>;
  }
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  // Alias for clarity in the sync/backfill code paths — the global tenant
  // filter at the top of the page drives every per-tenant action.
  const syncTenantId = globalTenantId;
  const [backfillDays, setBackfillDays] = useState<Record<string, string>>({});
  const [backfillBusy, setBackfillBusy] = useState<Record<string, boolean>>({});

  const BACKFILL_INTEGRATIONS: Record<string, { label: string; max: number; default: string }> = {
    meta: { label: "Meta", max: 1095, default: "365" },
    google_ads: { label: "Google Ads", max: 730, default: "365" },
    service_titan: { label: "ServiceTitan", max: 1095, default: "365" },
  };

  const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

  const fetchSyncStatus = useCallback(async () => {
    try {
      const params = syncTenantId ? `?tenantId=${syncTenantId}` : "";
      const res = await fetch(`${API_BASE}/api/integrations/sync-status${params}`, { credentials: "include" });
      if (res.ok) setSyncStatus(await res.json());
    } catch { /* ignore */ }
  }, [API_BASE, syncTenantId]);

  useEffect(() => { fetchSyncStatus(); }, [fetchSyncStatus]);

  // Poll the sync-status endpoint while a backfill is in flight so the
  // chunk-progress string and row count update live. We poll when EITHER
  // (a) the most recent status snapshot says 'running' for any integration,
  // OR (b) we just fired a POST and are waiting for the first row to
  // appear / for the long-running request to return. The route is
  // synchronous, so without the `backfillBusy` branch the operator who
  // kicked off the run would see no progress until the whole thing finished.
  const anyBackfillRunning = syncStatus?.backfillStatus
    ? Object.values(syncStatus.backfillStatus).some((b) => b?.status === "running")
    : false;
  const anyBackfillBusy = Object.values(backfillBusy).some(Boolean);
  useEffect(() => {
    if (!anyBackfillRunning && !anyBackfillBusy) return;
    const id = setInterval(() => { fetchSyncStatus(); }, 3000);
    return () => clearInterval(id);
  }, [anyBackfillRunning, anyBackfillBusy, fetchSyncStatus]);

  const triggerBackfill = (integ: string) => {
    const meta = BACKFILL_INTEGRATIONS[integ];
    if (!meta) return;
    if (!syncTenantId) {
      toast({ title: "Pick a tenant first", description: "Backfill runs against a single tenant — choose one from the selector above.", variant: "destructive" });
      return;
    }
    const days = Number(backfillDays[integ] ?? meta.default);
    if (!Number.isFinite(days) || days <= 30 || days > meta.max) {
      toast({ title: "Invalid days value", description: `Days must be a number between 31 and ${meta.max}.`, variant: "destructive" });
      return;
    }
    setBackfillBusy((b) => ({ ...b, [integ]: true }));
    toast({
      title: `${meta.label} backfill started`,
      description: `Pulling the last ${days} days in chunks. Progress will update live below.`,
    });

    // Fire-and-forget: the route runs synchronously to completion (can take
    // many minutes for long windows), so awaiting it would block all
    // progress updates. We instead let the polling effect refresh the
    // status row that the backfill writer creates immediately on entry,
    // and surface the final outcome from the POST resolution.
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/integrations/${integ}/backfill?tenantId=${syncTenantId}&days=${days}`, {
          method: "POST",
          credentials: "include",
        });
        let body: { success?: boolean; synced?: number; chunks?: number; error?: string } = {};
        try { body = await res.json(); } catch { /* non-JSON */ }
        if (!res.ok || body.success === false) {
          toast({
            title: `${meta.label} backfill failed`,
            description: body.error || `HTTP ${res.status}`,
            variant: "destructive",
          });
        } else {
          toast({
            title: `${meta.label} backfill complete`,
            description: `Synced ${body.synced ?? 0} rows across ${body.chunks ?? 0} chunks.`,
          });
        }
      } catch (err) {
        toast({
          title: `${meta.label} backfill failed`,
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setBackfillBusy((b) => ({ ...b, [integ]: false }));
        fetchSyncStatus();
      }
    })();

    // Kick the first poll right away so the just-created 'running' row
    // shows up without waiting a full poll interval.
    setTimeout(() => { fetchSyncStatus(); }, 500);
  };

  const triggerSync = async (integration: string) => {
    if (!syncTenantId) {
      toast({ title: "Pick a tenant first", description: "Manual sync runs against a single tenant — choose one from the tenant selector at the top of the page.", variant: "destructive" });
      return;
    }
    const targetTenantId = syncTenantId;
    setSyncLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/integrations/sync/${integration}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tenantId: targetTenantId }),
      });
      let body: { success?: boolean; synced?: number; error?: string } = {};
      try { body = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || body.success === false) {
        toast({
          title: `${integration} sync failed`,
          description: body.error || `HTTP ${res.status}`,
          variant: "destructive",
        });
      } else {
        toast({
          title: `${integration} sync complete`,
          description: `Synced ${body.synced ?? 0} record(s).`,
        });
      }
      await fetchSyncStatus();
    } catch (err) {
      toast({
        title: `${integration} sync failed`,
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
    setSyncLoading(false);
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortedTenants = useMemo(() => {
    if (!data?.tenants) return [];
    let filtered = [...data.tenants];

    if (roasFilter) {
      const threshold = parseFloat(roasFilter);
      if (!isNaN(threshold)) {
        filtered = filtered.filter(t => t.roas < threshold);
      }
    }

    filtered.sort((a, b) => {
      const aVal = a[sortKey] ?? 0;
      const bVal = b[sortKey] ?? 0;
      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDir === "asc" ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });

    return filtered;
  }, [data?.tenants, sortKey, sortDir, roasFilter]);

  const getCellColor = (value: number, type: "roas" | "cpl" | "booking") => {
    const avg = data?.agencyAverages;
    if (!avg) return "text-white";
    if (type === "roas") {
      if (value >= avg.roas * 1.2) return "text-emerald-400";
      if (value < avg.roas * 0.7) return "text-red-400 font-bold";
      return "text-white";
    }
    if (type === "cpl") {
      if (value > avg.cpl * 1.3) return "text-red-400 font-bold";
      if (value < avg.cpl * 0.8) return "text-emerald-400";
      return "text-white";
    }
    if (type === "booking") {
      if (value >= avg.bookingRate * 1.2) return "text-emerald-400";
      if (value < avg.bookingRate * 0.7) return "text-red-400 font-bold";
      return "text-white";
    }
    return "text-white";
  };

  const SortHeader = ({ label, field }: { label: string; field: SortKey }) => (
    <th
      className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-white transition-colors select-none text-right"
      onClick={() => toggleSort(field)}
    >
      <span className="inline-flex items-center gap-1 justify-end">
        {label}
        <ArrowUpDown className={`w-3 h-3 ${sortKey === field ? "text-primary" : ""}`} />
      </span>
    </th>
  );

  if (isLoading) {
    return <div className="animate-pulse space-y-6">
      <div className="h-8 w-64 bg-white/10 rounded" />
      <div className="grid grid-cols-4 gap-4">{[1,2,3,4].map(i => <div key={i} className="h-24 bg-white/5 rounded-xl" />)}</div>
      <div className="h-[300px] bg-white/5 rounded-xl" />
    </div>;
  }

  const avg = data?.agencyAverages;
  // When a tenant is selected, the four stat cards show that tenant's totals.
  // When unfiltered ("All Tenants") they show agency-wide aggregates. We always
  // keep `avg` as the unfiltered agency baseline so the Benchmarking section
  // below still has a stable comparison.
  const filteredTenantRow = globalTenantId ? data?.tenants?.[0] : null;
  const headlineStats = globalTenantId
    ? filteredTenantRow
      ? {
          totalSpend: filteredTenantRow.mtdSpend,
          totalRevenue: filteredTenantRow.mtdRevenue,
          roas: filteredTenantRow.roas,
          totalLeads: filteredTenantRow.totalLeads,
        }
      : { totalSpend: 0, totalRevenue: 0, roas: 0, totalLeads: 0 }
    : avg
    ? {
        totalSpend: avg.totalSpend,
        totalRevenue: avg.totalRevenue,
        roas: avg.roas,
        totalLeads: avg.totalLeads,
      }
    : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Agency God View</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">CROSS-CLIENT COMMAND CENTER</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 bg-card border border-white/10 rounded-lg px-3 py-1">
            <Users className="w-4 h-4 text-muted-foreground" />
            <Select
              value={globalTenantId != null ? String(globalTenantId) : "all"}
              onValueChange={(v) => setGlobalTenantId(v === "all" ? null : Number(v))}
            >
              <SelectTrigger className="bg-transparent border-0 text-white text-sm w-auto min-w-[160px] focus:outline-none focus:ring-0 px-0 py-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Tenants</SelectItem>
                {tenantOptions.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.inactive ? `${t.name} (inactive)` : t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 bg-card border border-white/10 rounded-lg px-3 py-2">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <input
              type="number"
              step="0.1"
              value={roasFilter}
              onChange={(e) => setRoasFilter(e.target.value)}
              placeholder="ROAS < threshold"
              className="bg-transparent text-white text-sm w-36 focus:outline-none"
            />
          </div>
        </div>
      </header>

      {headlineStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <PremiumCard className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">{selectedTenantName ? `${selectedTenantName} Spend` : "Agency Spend"}</span>
            </div>
            <p className="text-2xl font-display text-white">{formatCurrency(headlineStats.totalSpend)}</p>
          </PremiumCard>
          <PremiumCard className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">{selectedTenantName ? `${selectedTenantName} Revenue` : "Agency Revenue"}</span>
            </div>
            <p className="text-2xl font-display text-white">{formatCurrency(headlineStats.totalRevenue)}</p>
          </PremiumCard>
          <PremiumCard className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">{selectedTenantName ? "ROAS" : "Avg ROAS"}</span>
            </div>
            <p className="text-2xl font-display text-white">{headlineStats.roas.toFixed(2)}x</p>
          </PremiumCard>
          <PremiumCard className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Total Leads</span>
            </div>
            <p className="text-2xl font-display text-white">{headlineStats.totalLeads}</p>
          </PremiumCard>
        </div>
      )}

      <PremiumCard className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Zap className="w-5 h-5 text-primary" />
            <h3 className="font-display text-lg text-white">Attribution Reconciliation Engine</h3>
          </div>
          <div className="flex items-center gap-3">
            {reconStatus?.nextScheduledRun && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Next: {new Date(reconStatus.nextScheduledRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button
              onClick={() => {
                reconMutation.mutate({ data: globalTenantId ? { tenantId: globalTenantId } : {} }, {
                  onSuccess: () => refetchRecon(),
                });
              }}
              disabled={reconMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-primary/20 hover:bg-primary/30 border border-primary/40 rounded-lg text-primary text-sm font-medium transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${reconMutation.isPending ? "animate-spin" : ""}`} />
              {reconMutation.isPending ? "Running..." : "Run Now"}
            </button>
          </div>
        </div>

        {reconMutation.data && (
          <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
            <p className="text-emerald-400 text-sm">{reconMutation.data.message}</p>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span>Match Rate: {reconMutation.data.matchRate}%</span>
              <span>OCI Payloads: {reconMutation.data.ociPayloadsGenerated}</span>
              <span>Enhanced Conv: {(reconMutation.data as unknown as { enhancedConversionPayloads?: number }).enhancedConversionPayloads ?? 0}</span>
              <span>CAPI Events: {(reconMutation.data as unknown as { capiPayloads?: number }).capiPayloads ?? 0}</span>
            </div>
          </div>
        )}

        {reconStatus?.latestRun && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="p-3 bg-white/[0.03] rounded-lg text-center">
              <Diamond className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
              <p className="text-lg font-display text-cyan-400">{reconStatus.latestRun.diamondMatches}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Diamond</p>
            </div>
            <div className="p-3 bg-white/[0.03] rounded-lg text-center">
              <Award className="w-4 h-4 text-amber-400 mx-auto mb-1" />
              <p className="text-lg font-display text-amber-400">{reconStatus.latestRun.goldenMatches}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Golden</p>
            </div>
            <div className="p-3 bg-white/[0.03] rounded-lg text-center">
              <Award className="w-4 h-4 text-gray-300 mx-auto mb-1" />
              <p className="text-lg font-display text-gray-300">{reconStatus.latestRun.silverMatches}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Silver</p>
            </div>
            <div className="p-3 bg-white/[0.03] rounded-lg text-center">
              <Award className="w-4 h-4 text-orange-400 mx-auto mb-1" />
              <p className="text-lg font-display text-orange-400">{reconStatus.latestRun.bronzeMatches}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Bronze</p>
            </div>
            <div className="p-3 bg-white/[0.03] rounded-lg text-center">
              <p className="text-lg font-display text-white mt-5">{reconStatus.latestRun.matchRate}%</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Match Rate</p>
            </div>
          </div>
        )}

        {reconStatus?.recentRuns && reconStatus.recentRuns.length > 0 && (
          <div className="mt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Recent Runs</p>
            <div className="space-y-1">
              {reconStatus.recentRuns.slice(0, 5).map((run: ReconciliationRun) => (
                <div key={run.id} className="flex items-center justify-between text-xs py-1.5 px-2 rounded hover:bg-white/[0.02]">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${run.status === "completed" ? "bg-emerald-400" : "bg-red-400"}`} />
                    <span className="text-muted-foreground">{run.createdAt ? new Date(run.createdAt).toLocaleString() : "—"}</span>
                    <Badge variant={run.triggerType === "scheduled" ? "neutral" : "default"}>{run.triggerType}</Badge>
                  </div>
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <span>{run.jobsProcessed} jobs</span>
                    <span>{run.matchRate}% matched</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </PremiumCard>

      <PremiumCard className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Plug className="w-5 h-5 text-blue-400" />
            <h3 className="font-display text-lg text-white">Integration Sync Status</h3>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={fetchSyncStatus} className="text-xs text-muted-foreground hover:text-white flex items-center gap-1 transition-colors">
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(["service_titan", "google_ads", "meta"] as const).map((integ) => {
            const status = syncStatus?.statusByIntegration?.[integ];
            const label = integ === "service_titan" ? "ServiceTitan" : integ === "google_ads" ? "Google Ads" : "Meta";
            const color = integ === "service_titan" ? "text-blue-400" : integ === "google_ads" ? "text-yellow-400" : "text-purple-400";
            const backfillPartial = syncStatus?.backfillStatus?.[integ]?.errorDetail?.partial === true;
            return (
              <div key={integ} className="p-4 bg-white/[0.03] rounded-lg border border-white/5">
                <div className="flex items-center justify-between mb-2">
                  <span className={`font-medium text-sm ${color}`}>{label}</span>
                  {status?.state === "running" ? (
                    <span className="flex items-center gap-1 text-xs text-blue-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Syncing</span>
                  ) : status?.state === "paused" ? (
                    <span className="flex items-center gap-1 text-xs text-amber-400"><Clock className="w-3.5 h-3.5" /> Paused</span>
                  ) : status?.state === "healthy" && backfillPartial ? (
                    <span
                      className="flex items-center gap-1 text-xs text-amber-400"
                      title="Latest backfill finished with partial data — see Historical backfill below"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" /> Partial
                    </span>
                  ) : status?.state === "healthy" ? (
                    <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle className="w-3.5 h-3.5" /> Healthy</span>
                  ) : status?.state === "error" ? (
                    <span className="flex items-center gap-1 text-xs text-red-400"><XCircle className="w-3.5 h-3.5" /> Error</span>
                  ) : status?.state === "no_credentials" ? (
                    <span className="flex items-center gap-1 text-xs text-amber-400"><AlertTriangle className="w-3.5 h-3.5" /> No credentials</span>
                  ) : status?.state === "needs_reconnect" ? (
                    <span
                      className="flex items-center gap-1 text-xs text-red-400"
                      title={status.reconnectReason || "Upstream token expired or revoked — reconnect required"}
                    >
                      <AlertTriangle className="w-3.5 h-3.5" /> Reconnect required
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Never synced</span>
                  )}
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>Last successful: {status?.lastSync ? new Date(status.lastSync).toLocaleString() : "—"}</p>
                  {status?.syncTypes && Object.keys(status.syncTypes).length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-white/5 pt-2">
                      {Object.entries(status.syncTypes).map(([type, info]) => (
                        <div key={type} className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <span className={`w-1.5 h-1.5 rounded-full ${info.lastStatus === "completed" ? "bg-emerald-400" : info.lastStatus === "error" ? "bg-red-400" : "bg-amber-400"}`} />
                            <span className="text-muted-foreground capitalize">{type.replace(/_/g, " ")}</span>
                          </div>
                          <span className="text-right">
                            <span>{info.recordsProcessed.toLocaleString()} rec</span>
                            {info.lastRun && <span className="text-white/20 ml-1.5">{new Date(info.lastRun).toLocaleDateString()}</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!status?.syncTypes || Object.keys(status.syncTypes).length === 0 ? (
                    <p>Records: {status?.lastRecords ?? 0}</p>
                  ) : null}
                  {(status?.errorCount ?? 0) > 0 && (
                    <p className="text-red-400">{status!.errorCount} errors in recent history</p>
                  )}
                </div>
                {(() => {
                  const bf = syncStatus?.backfillStatus?.[integ];
                  // Meta, Google Ads, and ServiceTitan all expose a
                  // Run-backfill API endpoint that walks historical data in
                  // chunks. Other integrations only render the row if a log
                  // already exists.
                  const bfMeta = BACKFILL_INTEGRATIONS[integ];
                  const supportsManualBackfill = !!bfMeta;
                  const integBusy = backfillBusy[integ] === true;
                  if (!bf && !supportsManualBackfill) return null;
                  return (
                    <div className="mt-3 pt-3 border-t border-white/5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-white/80">Historical backfill</span>
                        {bf ? (
                          bf.status === "running" ? (
                            <span className="flex items-center gap-1 text-[11px] text-blue-400"><Loader2 className="w-3 h-3 animate-spin" /> Running</span>
                          ) : bf.errorDetail?.partial ? (
                            <span className="flex items-center gap-1 text-[11px] text-amber-400"><AlertTriangle className="w-3 h-3" /> Partial</span>
                          ) : bf.status === "completed" ? (
                            <span className="flex items-center gap-1 text-[11px] text-emerald-400"><CheckCircle className="w-3 h-3" /> Completed</span>
                          ) : bf.status === "error" ? (
                            <span className="flex items-center gap-1 text-[11px] text-red-400"><XCircle className="w-3 h-3" /> Error</span>
                          ) : (
                            <span className="text-[11px] text-muted-foreground capitalize">{bf.status}</span>
                          )
                        ) : (
                          <span className="text-[11px] text-muted-foreground">Never run</span>
                        )}
                      </div>
                      {bf && (
                        <div className="space-y-1.5 text-[11px] text-muted-foreground">
                          {bf.progressDetail && bf.progressDetail.kind === "chunk" && bf.status === "running" && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-white/80">
                                  Chunk {bf.progressDetail.currentChunk}/{bf.progressDetail.totalChunks}
                                </span>
                                <span className="text-white/50">
                                  {bf.progressDetail.windowStart} → {bf.progressDetail.windowEnd}
                                </span>
                              </div>
                              <div className="h-1.5 w-full bg-white/5 rounded overflow-hidden">
                                <div
                                  className="h-full bg-blue-400/70 transition-all"
                                  style={{ width: `${bf.progressDetail.percent ?? 0}%` }}
                                />
                              </div>
                            </div>
                          )}
                          {bf.errorDetail ? (
                            <div
                              className={
                                bf.errorDetail.partial
                                  ? "rounded border border-amber-400/30 bg-amber-500/[0.07] p-2 space-y-1"
                                  : "rounded border border-red-400/20 bg-red-500/[0.06] p-2 space-y-1"
                              }
                            >
                              <p className={`flex items-center gap-1.5 font-medium ${bf.errorDetail.partial ? "text-amber-300" : "text-red-300"}`}>
                                {bf.errorDetail.partial ? (
                                  <AlertTriangle className="w-3 h-3 shrink-0" />
                                ) : (
                                  <XCircle className="w-3 h-3 shrink-0" />
                                )}
                                <span>{bf.errorDetail.message}</span>
                              </p>
                              <p className="text-white/60">{bf.errorDetail.suggestedAction}</p>
                              {bf.errorDetail.raw && bf.errorDetail.raw !== bf.errorDetail.message && (
                                <details className="text-[10px] text-white/40">
                                  <summary className="cursor-pointer hover:text-white/60">Technical details</summary>
                                  <p className="font-mono break-all mt-1">{bf.errorDetail.raw}</p>
                                </details>
                              )}
                            </div>
                          ) : (
                            !bf.progressDetail && bf.progress && (
                              <p className="text-white/70 font-mono break-all">{bf.progress}</p>
                            )
                          )}
                          <p>{bf.recordsProcessed.toLocaleString()} rows</p>
                          <p>
                            Started: {bf.startedAt ? new Date(bf.startedAt).toLocaleString() : "—"}
                          </p>
                          <p>
                            Completed: {bf.completedAt ? new Date(bf.completedAt).toLocaleString() : "—"}
                          </p>
                        </div>
                      )}
                      {supportsManualBackfill && bfMeta && (
                        <div className="flex items-center gap-2 pt-1">
                          <input
                            type="number"
                            min={31}
                            max={bfMeta.max}
                            value={backfillDays[integ] ?? bfMeta.default}
                            onChange={(e) => setBackfillDays((d) => ({ ...d, [integ]: e.target.value }))}
                            className="w-20 bg-background/50 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/40"
                            placeholder={bfMeta.default}
                          />
                          <span className="text-[11px] text-muted-foreground">days (max {bfMeta.max})</span>
                          <button
                            onClick={() => triggerBackfill(integ)}
                            disabled={integBusy || !syncTenantId || bf?.status === "running"}
                            className="ml-auto text-xs py-1 px-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-white transition-colors disabled:opacity-50 flex items-center gap-1"
                            title={!syncTenantId ? "Pick a tenant from the selector above" : undefined}
                          >
                            {integBusy || bf?.status === "running"
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <RefreshCw className="w-3 h-3" />}
                            Run backfill
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}
                <button
                  onClick={() => triggerSync(integ)}
                  disabled={syncLoading || !syncTenantId}
                  title={!syncTenantId ? "Pick a tenant from the selector at the top of the page" : undefined}
                  className="mt-3 w-full text-xs py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-white transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  {syncLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Sync now
                </button>
              </div>
            );
          })}
        </div>
        {syncStatus?.purgeStatus && (
          <div className="mt-4 p-3 bg-white/[0.02] rounded-lg border border-white/5">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${syncStatus.purgeStatus.status === "completed" ? "bg-emerald-400" : "bg-amber-400"}`} />
                <span className="text-muted-foreground">Data Cleanup (PII purge)</span>
              </div>
              <span className="text-muted-foreground">
                {syncStatus.purgeStatus.lastRun ? new Date(syncStatus.purgeStatus.lastRun).toLocaleString() : "—"}
                {syncStatus.purgeStatus.recordsProcessed > 0 ? ` · ${syncStatus.purgeStatus.recordsProcessed} cleaned` : ""}
              </span>
            </div>
          </div>
        )}
        {syncStatus?.recentLogs && syncStatus.recentLogs.length > 0 && (
          <div className="mt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Recent Sync Activity</p>
            <div className="space-y-1">
              {syncStatus.recentLogs.slice(0, 12).map((log) => {
                const isOutbound = OUTBOUND_SYNC_TYPES.includes(log.syncType);
                return (
                  <div key={log.id} className={`flex items-center justify-between text-xs py-1.5 px-2 rounded hover:bg-white/[0.02] ${isOutbound ? "border-l-2 border-l-orange-400/50" : ""}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${log.status === "completed" ? "bg-emerald-400" : log.status === "error" ? "bg-red-400" : log.status === "partial" ? "bg-amber-400" : "bg-amber-400"}`} />
                      <span className="text-muted-foreground">{log.completedAt ? new Date(log.completedAt).toLocaleString() : "Running..."}</span>
                      {isOutbound && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-orange-400/10 border border-orange-400/20 rounded text-orange-400 text-[10px] font-medium uppercase">
                          <ArrowUpRight className="w-2.5 h-2.5" /> Out
                        </span>
                      )}
                      <Badge variant="neutral">{log.integration.replace(/_/g, " ")}</Badge>
                      <span className="text-white/30 capitalize">{log.syncType.replace(/_/g, " ")}</span>
                    </div>
                    <span className="text-muted-foreground">{log.recordsProcessed.toLocaleString()} records</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </PremiumCard>

      {syncStatus?.outboundPushStatus && (
        <PremiumCard className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Upload className="w-5 h-5 text-orange-400" />
              <h3 className="font-display text-lg text-white">Outbound Conversion Sync</h3>
            </div>
            <button onClick={fetchSyncStatus} className="text-xs text-muted-foreground hover:text-white flex items-center gap-1 transition-colors">
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {([
              { key: "oci_upload", label: "OCI Upload", color: "text-yellow-400", desc: "Google Ads Offline Click Import" },
              { key: "enhanced_conversions", label: "Enhanced Conversions", color: "text-blue-400", desc: "Google Ads non-GCLID conversions" },
              { key: "capi_upload", label: "CAPI Upload", color: "text-purple-400", desc: "Meta Conversions API" },
            ] as const).map(({ key, label, color, desc }) => {
              const push = syncStatus.outboundPushStatus?.[key];
              return (
                <div key={key} className="p-4 bg-white/[0.03] rounded-lg border border-white/5">
                  <div className="flex items-center justify-between mb-2">
                    <span className={`font-medium text-sm ${color}`}>{label}</span>
                    {push?.lastStatus === "completed" ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle className="w-3.5 h-3.5" /> Success</span>
                    ) : push?.lastStatus === "error" ? (
                      <span className="flex items-center gap-1 text-xs text-red-400"><XCircle className="w-3.5 h-3.5" /> Error</span>
                    ) : push?.lastStatus === "partial" ? (
                      <span className="flex items-center gap-1 text-xs text-amber-400"><AlertTriangle className="w-3.5 h-3.5" /> Partial</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Never pushed</span>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground mb-2">{desc}</p>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <p>Last success: {push?.lastSuccess ? new Date(push.lastSuccess).toLocaleString() : "—"}</p>
                    <p>Records pushed: {push?.recordsPushed?.toLocaleString() ?? 0}</p>
                    <div className="flex items-center gap-1">
                      <span>Pending:</span>
                      <span className={push?.pendingCount && push.pendingCount > 0 ? "text-amber-400 font-medium" : ""}>{push?.pendingCount ?? 0}</span>
                    </div>
                    {push?.lastError && (
                      <p className="text-red-400 text-[10px] mt-1 line-clamp-2" title={push.lastError}>
                        {push.lastError.length > 120 ? push.lastError.slice(0, 120) + "…" : push.lastError}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </PremiumCard>
      )}

      <PremiumCard className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 bg-background/50">
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-white" onClick={() => toggleSort("tenantName")}>
                  <span className="inline-flex items-center gap-1">Client Name <ArrowUpDown className={`w-3 h-3 ${sortKey === "tenantName" ? "text-primary" : ""}`} /></span>
                </th>
                <SortHeader label="MTD Spend" field="mtdSpend" />
                <SortHeader label="Revenue" field="mtdRevenue" />
                <SortHeader label="CPL" field="cpl" />
                <SortHeader label="Booking %" field="bookingRate" />
                <SortHeader label="ROAS" field="roas" />
                <SortHeader label="Leads" field="totalLeads" />
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Budget Pace</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {sortedTenants.map((row) => {
                const pacePercent = row.monthlyBudget > 0 ? (row.projectedSpend / row.monthlyBudget) * 100 : 0;
                const isOverBudget = pacePercent > 110;
                const isUnderBudget = pacePercent < 85;

                return (
                  <tr key={row.tenantId} className="group hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 font-medium text-white">{row.tenantName}</td>
                    <td className="p-4 text-right text-sm text-gray-300">{formatCurrency(row.mtdSpend)}</td>
                    <td className="p-4 text-right text-sm text-gray-300">{formatCurrency(row.mtdRevenue)}</td>
                    <td className={`p-4 text-right text-sm ${getCellColor(row.cpl, "cpl")}`}>{formatCurrency(row.cpl)}</td>
                    <td className={`p-4 text-right text-sm ${getCellColor(row.bookingRate, "booking")}`}>{row.bookingRate.toFixed(1)}%</td>
                    <td className={`p-4 text-right font-display text-lg ${getCellColor(row.roas, "roas")}`}>{row.roas.toFixed(2)}x</td>
                    <td className="p-4 text-right">
                      <button
                        onClick={() => setDrilldownTenant({ id: row.tenantId, name: row.tenantName })}
                        className="text-sm text-blue-400 hover:text-blue-300 underline underline-offset-2 cursor-pointer"
                      >
                        {row.totalLeads}
                      </button>
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-24 h-2 bg-white/10 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${isOverBudget ? "bg-red-500" : isUnderBudget ? "bg-amber-500" : "bg-emerald-500"}`}
                            style={{ width: `${Math.min(pacePercent, 100)}%` }}
                          />
                        </div>
                        <span className={`text-xs font-medium ${isOverBudget ? "text-red-400" : isUnderBudget ? "text-amber-400" : "text-emerald-400"}`}>
                          {pacePercent.toFixed(0)}%
                        </span>
                        {isOverBudget && <AlertTriangle className="w-3 h-3 text-red-400" />}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </PremiumCard>

      <BudgetControlsSection tenants={data?.tenants || []} apiBase={API_BASE} />

      {avg && (
        <div>
          <h3 className="font-display text-lg text-white mb-3">Benchmarking vs Agency Average</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedTenants.map((row) => {
              const cplDelta = avg.cpl > 0 ? ((row.cpl - avg.cpl) / avg.cpl) * 100 : 0;
              const roasDelta = avg.roas > 0 ? ((row.roas - avg.roas) / avg.roas) * 100 : 0;
              const bookingDelta = avg.bookingRate > 0 ? ((row.bookingRate - avg.bookingRate) / avg.bookingRate) * 100 : 0;
              const isOutlier = Math.abs(roasDelta) > 30 || Math.abs(cplDelta) > 30;

              return (
                <PremiumCard key={row.tenantId} className={`p-4 ${isOutlier ? "border-amber-500/30" : ""}`}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-medium text-white">{row.tenantName}</span>
                    {isOutlier && <Badge variant="warning">Outlier</Badge>}
                  </div>
                  <div className="space-y-2">
                    <MetricRow label="CPL" value={formatCurrency(row.cpl)} avg={formatCurrency(avg.cpl)} delta={-cplDelta} />
                    <MetricRow label="ROAS" value={`${row.roas.toFixed(2)}x`} avg={`${avg.roas.toFixed(2)}x`} delta={roasDelta} />
                    <MetricRow label="Booking" value={`${row.bookingRate.toFixed(1)}%`} avg={`${avg.bookingRate.toFixed(1)}%`} delta={bookingDelta} />
                  </div>
                </PremiumCard>
              );
            })}
          </div>
        </div>
      )}

      {drilldownTenant && (
        <LeadDrilldownModal
          tenantId={drilldownTenant.id}
          tenantName={drilldownTenant.name}
          startDate={startDate}
          endDate={endDate}
          onClose={() => setDrilldownTenant(null)}
        />
      )}
    </div>
  );
}

function BudgetControlsSection({ tenants, apiBase }: { tenants: Array<{ tenantId: number; tenantName: string }>; apiBase: string }) {
  const [selectedTenant, setSelectedTenant] = useState<number | "">("");
  const [platform, setPlatform] = useState<"google_ads" | "meta">("google_ads");
  const [campaignId, setCampaignId] = useState("");
  const [newBudget, setNewBudget] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [campaigns, setCampaigns] = useState<Array<{ id: number; name: string; externalId: string; platform: string }>>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);

  useEffect(() => {
    if (!selectedTenant) { setCampaigns([]); setCampaignId(""); return; }
    setCampaignsLoading(true);
    setCampaignId("");
    const platformParam = platform === "google_ads" ? "google" : "meta";
    fetch(`${apiBase}/api/campaigns?tenantId=${selectedTenant}&platform=${platformParam}`, { credentials: "include" })
      .then(r => r.json())
      .then((data: Array<{ id: number; name: string; externalId: string; platform: string }>) => setCampaigns(Array.isArray(data) ? data : []))
      .catch(() => setCampaigns([]))
      .finally(() => setCampaignsLoading(false));
  }, [selectedTenant, platform, apiBase]);

  const handleAdjust = async () => {
    if (!selectedTenant || !campaignId || !newBudget) return;
    setAdjusting(true);
    setResult(null);
    try {
      const res = await fetch(`${apiBase}/api/budget/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          tenantId: selectedTenant,
          campaignId,
          platform,
          newDailyBudget: parseFloat(newBudget),
        }),
      });
      const data = await res.json();
      setResult({ success: res.ok, message: data.message || data.error || "Done" });
    } catch (err) {
      setResult({ success: false, message: err instanceof Error ? err.message : "Request failed" });
    }
    setAdjusting(false);
  };

  return (
    <PremiumCard className="p-6">
      <div className="flex items-center gap-3 mb-4">
        <DollarSign className="w-5 h-5 text-emerald-400" />
        <h3 className="font-display text-lg text-white">Budget Controls</h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground uppercase tracking-wider">Client</label>
          <Select value={selectedTenant ? String(selectedTenant) : "none"} onValueChange={(v) => setSelectedTenant(v === "none" ? "" : Number(v))}>
            <SelectTrigger className="w-full bg-background/50 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-primary/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Select client</SelectItem>
              {tenants.map((t) => (
                <SelectItem key={t.tenantId} value={String(t.tenantId)}>{t.tenantName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground uppercase tracking-wider">Platform</label>
          <Select value={platform} onValueChange={(v) => setPlatform(v as "google_ads" | "meta")}>
            <SelectTrigger className="w-full bg-background/50 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-primary/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="google_ads">Google Ads</SelectItem>
              <SelectItem value="meta">Meta</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground uppercase tracking-wider">Campaign</label>
          <Select value={campaignId || "none"} onValueChange={(v) => setCampaignId(v === "none" ? "" : v)} disabled={!selectedTenant || campaignsLoading}>
            <SelectTrigger className="w-full bg-background/50 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50">
              <SelectValue placeholder={campaignsLoading ? "Loading..." : !selectedTenant ? "Select client first" : campaigns.length === 0 ? "No campaigns" : "Select campaign"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{campaignsLoading ? "Loading..." : !selectedTenant ? "Select client first" : campaigns.length === 0 ? "No campaigns" : "Select campaign"}</SelectItem>
              {campaigns.map((c) => (
                <SelectItem key={c.id} value={c.externalId}>{c.name} ({c.externalId})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground uppercase tracking-wider">New Daily Budget ($)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={newBudget}
            onChange={(e) => setNewBudget(e.target.value)}
            placeholder="e.g. 150.00"
            className="w-full bg-background/50 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={handleAdjust}
          disabled={adjusting || !selectedTenant || !campaignId || !newBudget}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {adjusting ? <Loader2 className="w-4 h-4 animate-spin" /> : <DollarSign className="w-4 h-4" />}
          {adjusting ? "Adjusting..." : "Adjust Budget"}
        </button>
        {result && (
          <span className={`text-sm ${result.success ? "text-emerald-400" : "text-red-400"}`}>
            {result.message}
          </span>
        )}
      </div>
    </PremiumCard>
  );
}

function MetricRow({ label, value, avg, delta }: { label: string; value: string; avg: string; delta: number }) {
  const isPositive = delta >= 0;
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-3">
        <span className="text-white font-medium">{value}</span>
        <span className="text-muted-foreground text-xs">avg {avg}</span>
        <span className={`flex items-center gap-0.5 text-xs ${isPositive ? "text-emerald-400" : "text-red-400"}`}>
          {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {Math.abs(delta).toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function getLeadStage(status: string): string {
  switch (status) {
    case "new": return "Prospect";
    case "contacted": return "Engaged";
    case "booked": return "Opportunity";
    case "sold": return "Closed-Won";
    case "lost": return "Closed-Lost";
    case "cancelled": return "Closed-Lost";
    default: return "Unknown";
  }
}

function LeadDrilldownModal({ tenantId, tenantName, startDate, endDate, onClose }: { tenantId: number; tenantName: string; startDate: string; endDate: string; onClose: () => void }) {
  const { data, isLoading } = useListLeads({ tenantId, limit: 200 });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-card border border-white/10 rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-6 border-b border-white/5">
          <div>
            <h3 className="font-display text-xl text-white">{tenantName} — Leads</h3>
            <p className="text-muted-foreground text-sm mt-1">Click-to-Conversion drill down</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="text-center text-muted-foreground py-8">Loading leads...</div>
          ) : (
            (() => {
              const startMs = new Date(startDate).getTime();
              const endMs = new Date(endDate).getTime() + 86400000;
              const filteredLeads = data?.leads?.filter((lead) => {
                const leadTime = new Date(lead.createdAt).getTime();
                return leadTime >= startMs && leadTime <= endMs;
              }) || [];
              return (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/5">
                      <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                      <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Source</th>
                      <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Interest</th>
                      <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Stage</th>
                      <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                      <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredLeads.map((lead) => (
                      <tr key={lead.id} className="hover:bg-white/[0.02]">
                        <td className="py-3 text-sm text-white">{lead.firstName} {lead.lastName}</td>
                        <td className="py-3 text-sm text-muted-foreground">{lead.source}</td>
                        <td className="py-3 text-sm text-muted-foreground">{lead.interestType || "—"}</td>
                        <td className="py-3">
                          <span className="text-xs font-medium text-ice/80">{getLeadStage(lead.status)}</span>
                        </td>
                        <td className="py-3">
                          <Badge variant={
                            lead.status === "sold" ? "success" :
                            lead.status === "booked" ? "default" :
                            lead.status === "lost" || lead.status === "cancelled" ? "danger" :
                            "neutral"
                          }>
                            {lead.status}
                          </Badge>
                        </td>
                        <td className="py-3 text-sm text-muted-foreground">
                          {new Date(lead.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                    {filteredLeads.length === 0 && (
                      <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">No leads found in date range</td></tr>
                    )}
                  </tbody>
                </table>
              );
            })()
          )}
        </div>
      </div>
    </div>
  );
}
