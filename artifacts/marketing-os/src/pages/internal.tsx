import { useState, useMemo } from "react";
import { useGetAdminDashboardStats, useListLeads, useGetReconciliationStatus, useRunReconciliation } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { formatCurrency } from "@/lib/utils";
import { ArrowUpDown, TrendingUp, TrendingDown, AlertTriangle, X, Users, DollarSign, Target, BarChart3, Filter, RefreshCw, Clock, Zap, Diamond, Award } from "lucide-react";

type SortKey = "tenantName" | "mtdSpend" | "cpl" | "bookingRate" | "roas" | "totalLeads" | "mtdRevenue";
type SortDir = "asc" | "desc";

export default function Internal() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const startDate = monthStart.toISOString().split("T")[0];
  const endDate = now.toISOString().split("T")[0];

  const { data, isLoading } = useGetAdminDashboardStats({ startDate, endDate });
  const { data: reconStatus, refetch: refetchRecon } = useGetReconciliationStatus();
  const reconMutation = useRunReconciliation();

  const [sortKey, setSortKey] = useState<SortKey>("roas");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [roasFilter, setRoasFilter] = useState<string>("");
  const [drilldownTenant, setDrilldownTenant] = useState<{ id: number; name: string } | null>(null);

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

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Agency God View</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">CROSS-CLIENT COMMAND CENTER</p>
        </div>
        <div className="flex items-center gap-3">
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

      {avg && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <PremiumCard className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Agency Spend</span>
            </div>
            <p className="text-2xl font-display text-white">{formatCurrency(avg.totalSpend)}</p>
          </PremiumCard>
          <PremiumCard className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Agency Revenue</span>
            </div>
            <p className="text-2xl font-display text-white">{formatCurrency(avg.totalRevenue)}</p>
          </PremiumCard>
          <PremiumCard className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Avg ROAS</span>
            </div>
            <p className="text-2xl font-display text-white">{avg.roas.toFixed(2)}x</p>
          </PremiumCard>
          <PremiumCard className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Total Leads</span>
            </div>
            <p className="text-2xl font-display text-white">{avg.totalLeads}</p>
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
                reconMutation.mutate({ data: {} }, {
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
              {reconStatus.recentRuns.slice(0, 5).map((run: any) => (
                <div key={run.id} className="flex items-center justify-between text-xs py-1.5 px-2 rounded hover:bg-white/[0.02]">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${run.status === "completed" ? "bg-emerald-400" : "bg-red-400"}`} />
                    <span className="text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</span>
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
