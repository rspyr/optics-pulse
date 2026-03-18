import { useState, useMemo } from "react";
import { useGetDashboardOverview, useGetSpendRevenueChart, useListChangeLogs, useListLeads } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { cn, formatCurrency, formatPercentage } from "@/lib/utils";
import { useAuth } from "@/components/auth-context";
import {
  ArrowUpRight, ArrowDownRight, Target, Flame, CheckCircle,
  TrendingUp, DollarSign, Calendar, Filter, Search,
  AlertTriangle, ChevronDown, X, Info, Zap,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
  FunnelChart, Funnel, LabelList, Cell,
} from "recharts";

type DateRange = "7" | "14" | "30" | "90";
type ComparisonMode = "none" | "previous" | "benchmark";

const AGENCY_FEE = 5000;

const BENCHMARK_DATA = {
  cpl: 95,
  bookingRate: 55,
  closeRate: 45,
  avgSaleValue: 7500,
  roas: 8.5,
};

function parseDateRange(days: DateRange) {
  const now = new Date();
  const start = new Date(now.getTime() - Number(days) * 86400000);
  return {
    startDate: start.toISOString().split("T")[0],
    endDate: now.toISOString().split("T")[0],
  };
}

function trendValue(current: number, previous: number | undefined | null): { text: string; isPositive: boolean; isNeutral: boolean } {
  if (previous === undefined || previous === null || previous === 0) return { text: "—", isPositive: true, isNeutral: true };
  const diff = current - previous;
  const pct = Math.round((diff / previous) * 100);
  return {
    text: `${pct >= 0 ? "+" : ""}${pct}%`,
    isPositive: pct >= 0,
    isNeutral: pct === 0,
  };
}

function trendValueInverse(current: number, previous: number | undefined | null): { text: string; isPositive: boolean; isNeutral: boolean } {
  const result = trendValue(current, previous);
  return { ...result, isPositive: result.isNeutral ? true : !result.isPositive };
}

interface NLFilterResult {
  source?: string;
  leadType?: string;
  assignedTo?: string;
}

function parseNaturalLanguageFilter(query: string): NLFilterResult {
  const q = query.toLowerCase();
  const result: NLFilterResult = {};

  if (q.includes("google")) result.source = "Google Ads";
  else if (q.includes("meta") || q.includes("facebook")) result.source = "Meta Leads";
  else if (q.includes("callrail") || q.includes("call")) result.source = "CallRail";
  else if (q.includes("organic")) result.source = "Organic Search";
  else if (q.includes("direct")) result.source = "Direct";
  else if (q.includes("referral")) result.source = "Referral";

  if (q.includes("fit funnel")) result.leadType = "paid";
  else if (q.includes("quiz")) result.leadType = "organic";

  return result;
}

export default function ClientPortal({ tenantIdOverride }: { tenantIdOverride?: number }) {
  const { user } = useAuth();
  const effectiveTenantId = tenantIdOverride ?? user?.tenantId ?? 1;

  const [dateRange, setDateRange] = useState<DateRange>("30");
  const [roiMode, setRoiMode] = useState<"roas" | "allcosts">("roas");
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("previous");
  const [showChangeLog, setShowChangeLog] = useState(false);
  const [nlQuery, setNlQuery] = useState("");
  const [activeNlFilter, setActiveNlFilter] = useState<NLFilterResult>({});
  const [filterSource, setFilterSource] = useState("");
  const [filterLeadType, setFilterLeadType] = useState("");
  const [filterSalesperson, setFilterSalesperson] = useState("");

  const { startDate, endDate } = parseDateRange(dateRange);

  const { data: overview, isLoading: overviewLoading } = useGetDashboardOverview({
    tenantId: effectiveTenantId,
    startDate,
    endDate,
  });

  const { data: chartData, isLoading: chartLoading } = useGetSpendRevenueChart({
    tenantId: effectiveTenantId,
    startDate,
    endDate,
  });

  const { data: changeLogs } = useListChangeLogs({
    tenantId: effectiveTenantId,
    startDate,
    endDate,
  });

  const { data: leadsData } = useListLeads({
    tenantId: effectiveTenantId,
    limit: 500,
  });

  const leads = leadsData?.leads || [];
  const effectiveSource = activeNlFilter.source || filterSource;
  const effectiveLeadType = activeNlFilter.leadType || filterLeadType;
  const effectiveSalesperson = activeNlFilter.assignedTo || filterSalesperson;

  const filteredLeads = useMemo(() => {
    return leads.filter(l => {
      if (effectiveSource && l.source !== effectiveSource) return false;
      if (effectiveLeadType && l.leadType !== effectiveLeadType) return false;
      if (effectiveSalesperson && l.assignedTo !== effectiveSalesperson) return false;
      return true;
    });
  }, [leads, effectiveSource, effectiveLeadType, effectiveSalesperson]);

  const hasActiveFilters = effectiveSource || effectiveLeadType || effectiveSalesperson;

  const filteredMetrics = useMemo(() => {
    if (!hasActiveFilters || filteredLeads.length === 0) return null;
    const total = filteredLeads.length;
    const booked = filteredLeads.filter(l => l.status === "booked" || l.status === "sold").length;
    const sold = filteredLeads.filter(l => l.status === "sold").length;
    return {
      totalLeads: total,
      bookedLeads: booked,
      soldLeads: sold,
      bookingRate: total > 0 ? Math.round((booked / total) * 100 * 10) / 10 : 0,
      closeRate: booked > 0 ? Math.round((sold / booked) * 100 * 10) / 10 : 0,
    };
  }, [filteredLeads, hasActiveFilters]);

  const uniqueSources = useMemo(() => [...new Set(leads.map(l => l.source))].sort(), [leads]);
  const uniqueLeadTypes = useMemo(() => [...new Set(leads.map(l => l.leadType).filter(Boolean))].sort(), [leads]);
  const uniqueSalespeople = useMemo(() => [...new Set(leads.map(l => l.assignedTo).filter(Boolean))].sort(), [leads]);

  const chartDataWithLogs = useMemo(() => {
    if (!chartData) return [];
    const logDates = new Set((changeLogs || []).map(l => l.date));
    return chartData.map(point => ({
      ...point,
      hasChangeLog: logDates.has(point.date),
    }));
  }, [chartData, changeLogs]);

  const handleNlSubmit = () => {
    if (!nlQuery.trim()) return;
    const parsed = parseNaturalLanguageFilter(nlQuery);
    setActiveNlFilter(parsed);
    if (parsed.source) setFilterSource("");
    if (parsed.leadType) setFilterLeadType("");
    if (parsed.assignedTo) setFilterSalesperson("");
  };

  const clearFilters = () => {
    setFilterSource("");
    setFilterLeadType("");
    setFilterSalesperson("");
    setNlQuery("");
    setActiveNlFilter({});
  };

  if (overviewLoading || chartLoading) {
    return (
      <div className="animate-pulse space-y-8">
        <div className="h-8 w-64 bg-white/10 rounded" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-36 bg-white/5 rounded-xl border border-white/5" />
          ))}
        </div>
        <div className="h-[400px] bg-white/5 rounded-xl border border-white/5" />
      </div>
    );
  }

  const d = overview || {
    totalSpend: 0, totalRevenue: 0, roas: 0, totalLeads: 0,
    bookedLeads: 0, soldLeads: 0, bookingRate: 0, closeRate: 0,
    avgSaleValue: 0, cpl: 0, attributionMatchRate: 0, previousPeriod: null,
  };

  const prev = d.previousPeriod;

  const allCostsSpend = d.totalSpend + AGENCY_FEE;
  const allCostsROI = allCostsSpend > 0 ? Math.round(((d.totalRevenue - allCostsSpend) / allCostsSpend) * 100) / 100 : 0;
  const displayROI = roiMode === "roas" ? d.roas : allCostsROI;
  const roiLabel = roiMode === "roas" ? "ROAS" : "True ROI";
  const roiSuffix = roiMode === "roas" ? "x" : "%";
  const roiValue = roiMode === "roas" ? `${displayROI.toFixed(1)}x` : `${(displayROI * 100).toFixed(0)}%`;

  const prevAllCostsROI = prev ? ((prev.totalRevenue || 0) - ((prev.totalSpend || 0) + AGENCY_FEE)) / (((prev.totalSpend || 0) + AGENCY_FEE) || 1) : null;
  const prevROI = roiMode === "roas" ? prev?.roas : prevAllCostsROI;

  const cplTrend = trendValueInverse(d.cpl, prev?.cpl);
  const bookingTrend = trendValue(d.bookingRate, prev?.bookingRate);
  const closeTrend = trendValue(d.closeRate, prev?.closeRate);
  const avgSaleTrend = trendValue(d.avgSaleValue, prev?.avgSaleValue);
  const roiTrend = trendValue(displayROI, prevROI);

  const compLabel = (current: number, benchmark: number, inverse?: boolean) => {
    if (comparisonMode !== "benchmark") return null;
    const diff = current - benchmark;
    const better = inverse ? diff < 0 : diff > 0;
    return { diff: Math.abs(diff).toFixed(1), better };
  };

  const metrics = [
    {
      label: "Cost Per Lead",
      value: formatCurrency(hasActiveFilters && filteredMetrics ? d.totalSpend / (filteredMetrics.totalLeads || 1) : d.cpl),
      trend: comparisonMode === "none" ? { text: "—", isPositive: true, isNeutral: true } : cplTrend,
      icon: Target,
      benchmark: compLabel(d.cpl, BENCHMARK_DATA.cpl, true),
    },
    {
      label: "Booking Rate",
      value: `${(hasActiveFilters && filteredMetrics ? filteredMetrics.bookingRate : d.bookingRate).toFixed(1)}%`,
      trend: comparisonMode === "none" ? { text: "—", isPositive: true, isNeutral: true } : bookingTrend,
      icon: Flame,
      benchmark: compLabel(d.bookingRate, BENCHMARK_DATA.bookingRate),
    },
    {
      label: "Close Rate",
      value: `${(hasActiveFilters && filteredMetrics ? filteredMetrics.closeRate : d.closeRate).toFixed(1)}%`,
      trend: comparisonMode === "none" ? { text: "—", isPositive: true, isNeutral: true } : closeTrend,
      icon: CheckCircle,
      benchmark: compLabel(d.closeRate, BENCHMARK_DATA.closeRate),
    },
    {
      label: "Avg Sale Value",
      value: formatCurrency(d.avgSaleValue),
      trend: comparisonMode === "none" ? { text: "—", isPositive: true, isNeutral: true } : avgSaleTrend,
      icon: DollarSign,
      benchmark: compLabel(d.avgSaleValue, BENCHMARK_DATA.avgSaleValue),
    },
    {
      label: roiLabel,
      value: roiValue,
      trend: comparisonMode === "none" ? { text: "—", isPositive: true, isNeutral: true } : roiTrend,
      icon: TrendingUp,
      benchmark: compLabel(displayROI, BENCHMARK_DATA.roas),
    },
  ];

  const funnelData = [
    {
      name: "Total Leads",
      value: hasActiveFilters && filteredMetrics ? filteredMetrics.totalLeads : d.totalLeads,
      fill: "#002D5E",
    },
    {
      name: "Booked",
      value: hasActiveFilters && filteredMetrics ? filteredMetrics.bookedLeads : d.bookedLeads,
      fill: "#F20505",
    },
    {
      name: "Sold",
      value: hasActiveFilters && filteredMetrics ? filteredMetrics.soldLeads : d.soldLeads,
      fill: "#10B981",
    },
  ];

  const bookingPct = d.totalLeads > 0 ? (d.bookedLeads / d.totalLeads) * 100 : 0;
  const closePct = d.bookedLeads > 0 ? (d.soldLeads / d.bookedLeads) * 100 : 0;

  type BottleneckItem = { label: string; pct: number; threshold: number; severity: "good" | "warning" | "critical"; tip: string };
  const bottlenecks: BottleneckItem[] = [
    {
      label: "Lead → Booked",
      pct: bookingPct,
      threshold: 40,
      severity: bookingPct >= 50 ? "good" : bookingPct >= 30 ? "warning" : "critical",
      tip: "Consider reviewing Lead Coordinator scripts and response time. Speed-to-lead is the #1 factor in booking rates.",
    },
    {
      label: "Booked → Sold",
      pct: closePct,
      threshold: 40,
      severity: closePct >= 50 ? "good" : closePct >= 30 ? "warning" : "critical",
      tip: "Review salesperson close techniques. The 'Advanced Closing Course' can help improve conversion from booked appointments.",
    },
  ];

  const worstBottleneck = bottlenecks.reduce((worst, b) =>
    b.pct < worst.pct ? b : worst
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Client Portal</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">THE SEARCHLIGHT KILLER — YOUR MARKETING ROI, TRANSPARENT</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 bg-card border border-white/10 rounded-lg p-1">
            {(["7", "14", "30", "90"] as DateRange[]).map(d => (
              <button
                key={d}
                onClick={() => setDateRange(d)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  dateRange === d
                    ? "bg-white/10 text-white shadow-sm"
                    : "text-muted-foreground hover:text-white"
                )}
              >
                {d}D
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 bg-card border border-white/10 rounded-lg p-1">
            <button
              onClick={() => setRoiMode("roas")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                roiMode === "roas" ? "bg-primary/20 text-primary shadow-sm" : "text-muted-foreground hover:text-white"
              )}
            >
              ROAS
            </button>
            <button
              onClick={() => setRoiMode("allcosts")}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                roiMode === "allcosts" ? "bg-primary/20 text-primary shadow-sm" : "text-muted-foreground hover:text-white"
              )}
            >
              TRUE ROI
            </button>
          </div>

          <select
            value={comparisonMode}
            onChange={e => setComparisonMode(e.target.value as ComparisonMode)}
            className="bg-card border border-white/10 text-white text-xs rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary/50"
          >
            <option value="none">No Comparison</option>
            <option value="previous">vs Previous Period</option>
            <option value="benchmark">vs Agency Benchmark</option>
          </select>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {metrics.map((metric, i) => (
          <PremiumCard key={i} className="p-5 relative overflow-hidden group" transition={{ delay: i * 0.05 }}>
            <div className="absolute top-0 right-0 w-20 h-20 bg-primary/5 rounded-bl-full -z-10 group-hover:bg-primary/10 transition-colors" />
            <div className="flex items-center justify-between mb-3">
              <div className="p-2 rounded-lg bg-white/5 border border-white/10">
                <metric.icon className="w-4 h-4 text-primary" />
              </div>
              {!metric.trend.isNeutral && (
                <div className={cn(
                  "flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full",
                  metric.trend.isPositive ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                )}>
                  {metric.trend.isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                  {metric.trend.text}
                </div>
              )}
              {metric.trend.isNeutral && (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </div>
            <p className="text-muted-foreground text-[10px] font-bold uppercase tracking-widest mb-1">{metric.label}</p>
            <p className="text-2xl font-display text-white">{metric.value}</p>
            {metric.benchmark && comparisonMode === "benchmark" && (
              <p className={cn("text-[10px] mt-1", metric.benchmark.better ? "text-emerald-400" : "text-amber-400")}>
                {metric.benchmark.better ? "▲" : "▼"} {metric.benchmark.diff} vs benchmark
              </p>
            )}
          </PremiumCard>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[280px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={nlQuery}
            onChange={e => setNlQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleNlSubmit()}
            placeholder='Try: "show me all meta campaigns" or "google leads only"'
            className="w-full bg-card border border-white/10 text-white text-sm rounded-lg pl-10 pr-4 py-2.5 focus:outline-none focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/50"
          />
        </div>
        <select
          value={filterSource}
          onChange={e => { setFilterSource(e.target.value); setActiveNlFilter(prev => ({ ...prev, source: undefined })); }}
          className="bg-card border border-white/10 text-white text-xs rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="">All Sources</option>
          {uniqueSources.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={filterLeadType}
          onChange={e => { setFilterLeadType(e.target.value); setActiveNlFilter(prev => ({ ...prev, leadType: undefined })); }}
          className="bg-card border border-white/10 text-white text-xs rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="">All Types</option>
          {uniqueLeadTypes.map(t => <option key={t} value={t!}>{t}</option>)}
        </select>
        <select
          value={filterSalesperson}
          onChange={e => { setFilterSalesperson(e.target.value); setActiveNlFilter(prev => ({ ...prev, assignedTo: undefined })); }}
          className="bg-card border border-white/10 text-white text-xs rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="">All Salespeople</option>
          {uniqueSalespeople.map(s => <option key={s} value={s!}>{s}</option>)}
        </select>
        {hasActiveFilters && (
          <button onClick={clearFilters} className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors">
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <PremiumCard className="lg:col-span-2 p-6 flex flex-col" transition={{ delay: 0.3 }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-display text-lg text-white">Spend vs Revenue</h3>
              <p className="text-muted-foreground text-xs">
                {roiMode === "allcosts" ? "Includes agency retainer in spend calculation" : "Ad spend only (ROAS view)"}
              </p>
            </div>
            <button
              onClick={() => setShowChangeLog(!showChangeLog)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all",
                showChangeLog
                  ? "bg-primary/10 border-primary/30 text-primary"
                  : "bg-white/5 border-white/10 text-muted-foreground hover:text-white"
              )}
            >
              <Calendar className="w-3.5 h-3.5" />
              Change Log
            </button>
          </div>
          <div className="flex-1 min-h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartDataWithLogs} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke="#879199"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  dy={10}
                  tickFormatter={v => {
                    const d = new Date(v + "T00:00:00");
                    return `${d.getMonth() + 1}/${d.getDate()}`;
                  }}
                />
                <YAxis
                  yAxisId="left"
                  stroke="#879199"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={v => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`}
                />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                  contentStyle={{ backgroundColor: "#0A0F1F", borderColor: "#1E293B", borderRadius: "8px", color: "#fff", fontSize: "12px" }}
                  labelFormatter={v => {
                    const d = new Date(v + "T00:00:00");
                    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  }}
                  formatter={(value: number, name: string) => [formatCurrency(value), name]}
                />
                <Legend wrapperStyle={{ paddingTop: "16px", fontSize: "12px" }} />
                <Bar yAxisId="left" dataKey="spend" name="Ad Spend" fill="#002D5E" radius={[3, 3, 0, 0]} maxBarSize={32} />
                <Bar yAxisId="left" dataKey="revenue" name="Revenue" fill="#F20505" radius={[3, 3, 0, 0]} maxBarSize={32} />
                {showChangeLog && changeLogs && changeLogs.map((log, i) => (
                  <ReferenceLine
                    key={i}
                    yAxisId="left"
                    x={log.date}
                    stroke="#F59E0B"
                    strokeDasharray="4 4"
                    strokeWidth={1.5}
                    label={{
                      value: "●",
                      position: "top",
                      fill: "#F59E0B",
                      fontSize: 14,
                    }}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          {showChangeLog && changeLogs && changeLogs.length > 0 && (
            <div className="mt-4 border-t border-white/5 pt-4">
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Marketing Changes</h4>
              <div className="space-y-2 max-h-[180px] overflow-y-auto pr-2">
                {changeLogs.map(log => (
                  <div key={log.id} className="flex gap-3 p-2.5 rounded-lg bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-colors">
                    <div className="w-2 h-2 rounded-full bg-amber-400 mt-1.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-medium text-white">{log.title}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(log.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground">{log.category}</span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">{log.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </PremiumCard>

        <PremiumCard className="p-6 flex flex-col" transition={{ delay: 0.4 }}>
          <h3 className="font-display text-lg text-white mb-1">Bottleneck Identifier</h3>
          <p className="text-muted-foreground text-xs mb-4">Funnel drop-off analysis</p>

          <div className="flex-1 min-h-[200px] mb-4">
            <ResponsiveContainer width="100%" height="100%">
              <FunnelChart>
                <Tooltip
                  contentStyle={{ backgroundColor: "#0A0F1F", borderColor: "#1E293B", borderRadius: "8px", color: "#fff", fontSize: "12px" }}
                />
                <Funnel dataKey="value" data={funnelData} isAnimationActive>
                  {funnelData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                  <LabelList position="center" fill="#fff" fontSize={12} formatter={(v: number) => `${v}`} />
                  <LabelList position="right" fill="#879199" fontSize={11} dataKey="name" />
                </Funnel>
              </FunnelChart>
            </ResponsiveContainer>
          </div>

          <div className="space-y-3">
            {bottlenecks.map((b, i) => (
              <div key={i}>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-gray-300 font-medium">{b.label}</span>
                  <span className={cn(
                    "font-medium",
                    b.severity === "good" ? "text-emerald-400" :
                    b.severity === "warning" ? "text-amber-400" : "text-red-400"
                  )}>
                    {b.pct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      b.severity === "good" ? "bg-emerald-500" :
                      b.severity === "warning" ? "bg-amber-500" : "bg-red-500"
                    )}
                    style={{ width: `${Math.min(b.pct, 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          {worstBottleneck.severity !== "good" && (
            <div className={cn(
              "mt-4 p-3 rounded-lg border text-xs leading-relaxed",
              worstBottleneck.severity === "critical"
                ? "bg-red-500/10 border-red-500/20 text-red-300"
                : "bg-amber-500/10 border-amber-500/20 text-amber-300"
            )}>
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium mb-1">
                    {worstBottleneck.label} is at {worstBottleneck.pct.toFixed(1)}%
                  </p>
                  <p className="text-muted-foreground">{worstBottleneck.tip}</p>
                </div>
              </div>
            </div>
          )}
        </PremiumCard>
      </div>

      <PremiumCard className="p-6" transition={{ delay: 0.5 }}>
        <div className="flex items-center gap-2 mb-6">
          <Zap className="w-5 h-5 text-primary" />
          <h3 className="font-display text-lg text-white">Financial Transparency</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">The Math</h4>

            <div className="space-y-3 bg-white/[0.02] rounded-lg p-4 border border-white/5 font-mono text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Total Revenue</span>
                <span className="text-emerald-400 font-medium">{formatCurrency(d.totalRevenue)}</span>
              </div>
              <div className="border-t border-white/5 pt-2 flex justify-between">
                <span className="text-gray-400">Ad Spend</span>
                <span className="text-red-400">- {formatCurrency(d.totalSpend)}</span>
              </div>
              {roiMode === "allcosts" && (
                <div className="flex justify-between">
                  <span className="text-gray-400">Agency Retainer</span>
                  <span className="text-red-400">- {formatCurrency(AGENCY_FEE)}</span>
                </div>
              )}
              <div className="border-t border-white/5 pt-2 flex justify-between">
                <span className="text-gray-400">Total Cost</span>
                <span className="text-white font-medium">
                  {formatCurrency(roiMode === "allcosts" ? allCostsSpend : d.totalSpend)}
                </span>
              </div>
              <div className="border-t border-white/10 border-double pt-3 flex justify-between text-base">
                <span className="text-white font-medium">Net Profit</span>
                <span className={cn("font-bold", d.totalRevenue - (roiMode === "allcosts" ? allCostsSpend : d.totalSpend) >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {formatCurrency(d.totalRevenue - (roiMode === "allcosts" ? allCostsSpend : d.totalSpend))}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">ROI Calculation</h4>

            <div className="bg-white/[0.02] rounded-lg p-4 border border-white/5">
              <div className="text-center mb-4">
                <p className="text-muted-foreground text-xs mb-1">
                  (Revenue - Total Cost) / Total Cost
                </p>
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <span>({formatCurrency(d.totalRevenue)} - {formatCurrency(roiMode === "allcosts" ? allCostsSpend : d.totalSpend)})</span>
                  <span>/</span>
                  <span>{formatCurrency(roiMode === "allcosts" ? allCostsSpend : d.totalSpend)}</span>
                </div>
              </div>
              <div className="text-center py-4 border-t border-white/5">
                <p className="text-xs text-muted-foreground mb-1">{roiLabel}</p>
                <p className="text-4xl font-display text-white">{roiValue}</p>
              </div>
              <div className="grid grid-cols-3 gap-3 pt-4 border-t border-white/5">
                <div className="text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Leads</p>
                  <p className="text-lg font-display text-white">{d.totalLeads}</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Booked</p>
                  <p className="text-lg font-display text-white">{d.bookedLeads}</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Sold</p>
                  <p className="text-lg font-display text-white">{d.soldLeads}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}
