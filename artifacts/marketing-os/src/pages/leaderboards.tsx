import { useState } from "react";
import { useGetAdminLeaderboard } from "@workspace/api-client-react";
import type { LeaderboardEntry } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { formatCurrency } from "@/lib/utils";
import {
  Trophy, TrendingUp, TrendingDown, Minus, AlertTriangle, X,
  DollarSign, Target, BarChart3, Users, Eye, EyeOff, ShoppingBag, Crown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth-context";

type MetricKey = "closeRate" | "revenue" | "cpl" | "bookingRate";

const METRIC_TABS: { key: MetricKey; label: string; icon: typeof Trophy; format: (v: number) => string; unit: string }[] = [
  { key: "closeRate", label: "Close Rate", icon: Target, format: (v) => `${v.toFixed(1)}%`, unit: "%" },
  { key: "revenue", label: "Revenue", icon: DollarSign, format: (v) => formatCurrency(v), unit: "$" },
  { key: "cpl", label: "Cost per Lead", icon: BarChart3, format: (v) => formatCurrency(v), unit: "$" },
  { key: "bookingRate", label: "Booking Rate", icon: Users, format: (v) => `${v.toFixed(1)}%`, unit: "%" },
];

function TrendBadge({ trend, lowerIsBetter = false }: { trend: number; lowerIsBetter?: boolean }) {
  if (trend === 0) return <span className="inline-flex items-center gap-1 text-xs text-gray-400"><Minus className="w-3 h-3" />0%</span>;
  const isUp = trend > 0;
  const isPositive = lowerIsBetter ? !isUp : isUp;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", isPositive ? "text-emerald-400" : "text-red-400")}>
      {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {isUp ? "+" : ""}{trend.toFixed(1)}%
    </span>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center"><Crown className="w-4 h-4 text-amber-400" /></div>;
  if (rank === 2) return <div className="w-8 h-8 rounded-full bg-gray-400/20 flex items-center justify-center"><span className="text-sm font-display text-gray-300">2</span></div>;
  if (rank === 3) return <div className="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center"><span className="text-sm font-display text-orange-400">3</span></div>;
  return <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"><span className="text-sm font-display text-gray-500">{rank}</span></div>;
}

export default function Leaderboards() {
  const [activeMetric, setActiveMetric] = useState<MetricKey>("closeRate");
  const [anonymized, setAnonymized] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<LeaderboardEntry | null>(null);
  const { isAgency } = useAuth();

  const { data, isLoading, error, refetch } = useGetAdminLeaderboard({ metric: activeMetric });

  const tab = METRIC_TABS.find(t => t.key === activeMetric)!;

  const serverAnonymized = (data as Record<string, unknown> | undefined)?.forceAnonymized === true;
  const effectiveAnonymized = serverAnonymized || anonymized;

  const getDisplayName = (entry: LeaderboardEntry, index: number) => {
    if ((entry as Record<string, unknown>).isOwnTenant) return entry.tenantName;
    return effectiveAnonymized ? `Client ${String.fromCharCode(65 + index)}` : entry.tenantName;
  };

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-64 bg-white/10 rounded" />
        <div className="grid grid-cols-4 gap-4">{[1, 2, 3, 4].map(i => <div key={i} className="h-16 bg-white/5 rounded-xl" />)}</div>
        <div className="h-[400px] bg-white/5 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <GradientHeading className="text-3xl md:text-4xl mb-2">Leaderboards</GradientHeading>
        <PremiumCard className="p-8 text-center">
          <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
          <p className="text-white font-medium mb-2">Failed to load leaderboard data</p>
          <p className="text-sm text-muted-foreground mb-4">There was an error fetching the rankings. Please try again.</p>
          <button onClick={() => refetch()} className="px-4 py-2 bg-primary/20 hover:bg-primary/30 border border-primary/40 rounded-lg text-primary text-sm font-medium transition-colors">
            Retry
          </button>
        </PremiumCard>
      </div>
    );
  }

  const rankings = data?.rankings ?? [];
  const agencyAvg = data?.agencyAverage ?? 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Leaderboards</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">CROSS-CLIENT PERFORMANCE RANKINGS</p>
        </div>
        {isAgency && (
          <button
            onClick={() => setAnonymized(!anonymized)}
            className={cn(
              "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
              anonymized
                ? "bg-primary/20 border-primary/40 text-primary"
                : "bg-white/5 border-white/10 text-muted-foreground hover:text-white"
            )}
          >
            {anonymized ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            {anonymized ? "Anonymized" : "Named View"}
          </button>
        )}
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {METRIC_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveMetric(t.key)}
            className={cn(
              "p-4 rounded-xl border text-left transition-all",
              activeMetric === t.key
                ? "bg-primary/10 border-primary/40 shadow-[0_0_15px_rgba(242,5,5,0.15)]"
                : "bg-card border-white/5 hover:border-white/15"
            )}
          >
            <div className="flex items-center gap-2 mb-1">
              <t.icon className={cn("w-4 h-4", activeMetric === t.key ? "text-primary" : "text-muted-foreground")} />
              <span className={cn("text-xs uppercase tracking-wider font-medium", activeMetric === t.key ? "text-primary" : "text-muted-foreground")}>{t.label}</span>
            </div>
            {activeMetric === t.key && agencyAvg > 0 && (
              <p className="text-lg font-display text-white mt-1">Avg: {t.format(agencyAvg)}</p>
            )}
          </button>
        ))}
      </div>

      {agencyAvg > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <BarChart3 className="w-4 h-4 text-blue-400" />
          <span className="text-sm text-blue-300">
            Agency Average ({tab.label}): <span className="font-display text-white">{tab.format(agencyAvg)}</span>
          </span>
          <span className="text-xs text-muted-foreground ml-auto">
            {data?.period?.start} – {data?.period?.end}
          </span>
        </div>
      )}

      <PremiumCard className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 bg-background/50">
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider w-16">Rank</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Client</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">{tab.label}</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Trend</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">vs Avg</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Close Rate</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Revenue</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">CPL</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Leads</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rankings.map((entry, idx) => {
                const vsAvg = agencyAvg > 0 ? ((entry.metricValue - agencyAvg) / agencyAvg) * 100 : 0;
                const higherIsBetter = activeMetric !== "cpl";
                const isGood = higherIsBetter ? vsAvg > 0 : vsAvg < 0;
                const isOwn = (entry as Record<string, unknown>).isOwnTenant === true;

                return (
                  <tr
                    key={entry.tenantId}
                    onClick={() => setSelectedEntry(entry)}
                    className={cn(
                      "group hover:bg-white/[0.03] transition-colors cursor-pointer",
                      isOwn && "bg-primary/[0.06] ring-1 ring-inset ring-primary/30 shadow-[inset_0_0_20px_rgba(242,5,5,0.06)]",
                      !isOwn && entry.isOutlier && entry.outlierDirection === "underperforming" && "bg-red-500/[0.03]"
                    )}
                  >
                    <td className="p-4"><RankBadge rank={entry.rank} /></td>
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <span className="font-medium text-white">{getDisplayName(entry, idx)}</span>
                        {entry.isOutlier && (
                          <Badge variant={entry.outlierDirection === "underperforming" ? "danger" : "success"}>
                            <AlertTriangle className="w-3 h-3 mr-1" />
                            {entry.outlierDirection === "underperforming" ? "Needs Help" : "Star"}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="p-4 text-right">
                      <span className="font-display text-lg text-white">{tab.format(entry.metricValue)}</span>
                    </td>
                    <td className="p-4 text-right"><TrendBadge trend={entry.trend} lowerIsBetter={activeMetric === "cpl"} /></td>
                    <td className="p-4 text-right">
                      <span className={cn("text-sm font-medium", isGood ? "text-emerald-400" : "text-red-400")}>
                        {vsAvg > 0 ? "+" : ""}{vsAvg.toFixed(1)}%
                      </span>
                    </td>
                    <td className="p-4 text-right text-sm text-gray-300">{entry.closeRate.toFixed(1)}%</td>
                    <td className="p-4 text-right text-sm text-gray-300">{formatCurrency(entry.revenue)}</td>
                    <td className="p-4 text-right text-sm text-gray-300">{formatCurrency(entry.cpl)}</td>
                    <td className="p-4 text-right text-sm text-gray-300">{entry.totalLeads}</td>
                  </tr>
                );
              })}
              {rankings.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-muted-foreground">No data available for this period.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </PremiumCard>

      {selectedEntry && (
        <ClientDetailModal
          entry={selectedEntry}
          displayName={getDisplayName(selectedEntry, rankings.findIndex(r => r.tenantId === selectedEntry.tenantId))}
          agencyAverage={agencyAvg}
          metricTab={tab}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  );
}

function ClientDetailModal({
  entry,
  displayName,
  agencyAverage,
  metricTab,
  onClose,
}: {
  entry: LeaderboardEntry;
  displayName: string;
  agencyAverage: number;
  metricTab: typeof METRIC_TABS[number];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <PremiumCard className="p-6 border-white/10">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="font-display text-xl text-white">{displayName}</h3>
              <p className="text-sm text-muted-foreground">Rank #{entry.rank} · {metricTab.label}</p>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors">
              <X className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-6">
            <div className="p-3 bg-white/[0.03] rounded-lg">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Close Rate</p>
              <p className="text-lg font-display text-white">{entry.closeRate.toFixed(1)}%</p>
            </div>
            <div className="p-3 bg-white/[0.03] rounded-lg">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Booking Rate</p>
              <p className="text-lg font-display text-white">{entry.bookingRate.toFixed(1)}%</p>
            </div>
            <div className="p-3 bg-white/[0.03] rounded-lg">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Revenue</p>
              <p className="text-lg font-display text-white">{formatCurrency(entry.revenue)}</p>
            </div>
            <div className="p-3 bg-white/[0.03] rounded-lg">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">CPL</p>
              <p className="text-lg font-display text-white">{formatCurrency(entry.cpl)}</p>
            </div>
            <div className="p-3 bg-white/[0.03] rounded-lg">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">ROAS</p>
              <p className="text-lg font-display text-white">{entry.roas.toFixed(2)}x</p>
            </div>
            <div className="p-3 bg-white/[0.03] rounded-lg">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Leads</p>
              <p className="text-lg font-display text-white">{entry.totalLeads}</p>
            </div>
          </div>

          <div className="mb-4">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-muted-foreground">{metricTab.label} vs Agency Avg</span>
              <span className="text-white font-medium">{metricTab.format(entry.metricValue)} / {metricTab.format(agencyAverage)}</span>
            </div>
            <div className="w-full h-3 bg-white/5 rounded-full overflow-hidden relative">
              {agencyAverage > 0 && (
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-blue-400 z-10"
                  style={{ left: "50%" }}
                  title="Agency Average"
                />
              )}
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  entry.metricValue >= agencyAverage ? "bg-emerald-500" : "bg-red-500"
                )}
                style={{ width: `${agencyAverage > 0 ? Math.min((entry.metricValue / agencyAverage) * 50, 100) : 0}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 mb-3">
            <TrendBadge trend={entry.trend} />
            <span className="text-xs text-muted-foreground">vs. prior period</span>
          </div>

          <div className="border-t border-white/5 pt-4">
            <div className="flex items-center gap-2 mb-3">
              <ShoppingBag className="w-4 h-4 text-primary" />
              <h4 className="text-sm font-medium text-white">Agency Products & Services</h4>
            </div>
            {entry.products.length > 0 ? (
              <div className="space-y-2">
                {entry.products.map((p, i) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-white/[0.03] rounded-lg">
                    <div>
                      <p className="text-sm text-white font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.category}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-emerald-400 font-medium">{formatCurrency(p.pricePaid)}</p>
                      {p.purchasedAt && (
                        <p className="text-xs text-muted-foreground">{new Date(p.purchasedAt).toLocaleDateString()}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">No agency products purchased yet.</p>
            )}
          </div>
        </PremiumCard>
      </div>
    </div>
  );
}
