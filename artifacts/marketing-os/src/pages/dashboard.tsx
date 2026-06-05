import { useState, useMemo, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useGetDashboardOverview, useGetSpendRevenueChart, useGetAdminDashboardStats, getGetAdminDashboardStatsQueryKey } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, formatPercentage, round2, PLATFORM_COLORS } from "@/lib/utils";
import { ArrowUpRight, ArrowDownRight, DollarSign, Users, Target, Activity, Link, Download, Loader2, X, ExternalLink, AlertTriangle } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { MetaCampaignBreakdown } from "@/components/MetaCampaignBreakdown";
import { useAuth } from "@/components/auth-context";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

type DrilldownJob = {
  id: number;
  stJobId: string | null;
  stInvoiceId: string | null;
  customerName: string | null;
  jobType: string;
  jobTypeName: string | null;
  status: string;
  revenue: number;
  invoiceTotal: number | null;
  invoiceRebateAmount: number | null;
  invoiceDate: string | null;
  completedAt: string | null;
  createdAt: string;
  matchLevel: string | null;
  matchedGclid: string | null;
};

type DateRange = "last30" | "thisMonth" | "lastMonth" | "last7";

function getDateRange(range: DateRange): { startDate: string; endDate: string; label: string } {
  const now = new Date();
  const end = now.toISOString().split("T")[0];
  switch (range) {
    case "last7": {
      const s = new Date(now.getTime() - 7 * 86400000);
      return { startDate: s.toISOString().split("T")[0], endDate: end, label: "Last 7 Days" };
    }
    case "thisMonth": {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { startDate: s.toISOString().split("T")[0], endDate: end, label: "This Month" };
    }
    case "lastMonth": {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return { startDate: s.toISOString().split("T")[0], endDate: e.toISOString().split("T")[0], label: "Last Month" };
    }
    default: {
      const s = new Date(now.getTime() - 30 * 86400000);
      return { startDate: s.toISOString().split("T")[0], endDate: end, label: "Last 30 Days" };
    }
  }
}

function safeNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export default function Dashboard() {
  const [, navigate] = useLocation();
  const [dateRange, setDateRange] = useState<DateRange>("last30");
  const [exporting, setExporting] = useState(false);
  // When set, opens the JobRevenueDrilldown modal scoped to this date range.
  // For a chart bar click, start === end. For the Total Revenue card, it's the
  // full active filter window.
  const [drilldown, setDrilldown] = useState<{ startDate: string; endDate: string; title: string } | null>(null);
  const { startDate, endDate } = useMemo(() => getDateRange(dateRange), [dateRange]);

  const { data: rawOverview } = useGetDashboardOverview({ startDate, endDate });
  const { data: rawChartData } = useGetSpendRevenueChart({ startDate, endDate });

  const overviewRef = useRef(rawOverview);
  const chartDataRef = useRef(rawChartData);
  if (rawOverview !== undefined) overviewRef.current = rawOverview;
  if (rawChartData !== undefined) chartDataRef.current = rawChartData;

  const overview = rawOverview ?? overviewRef.current;
  const chartData = rawChartData ?? chartDataRef.current;
  if (!overview && !overviewRef.current) {
    return <div className="animate-pulse space-y-8">
      <div className="h-8 w-64 bg-white/10 rounded"></div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
        {[1,2,3,4,5].map(i => <div key={i} className="h-32 bg-white/5 rounded-xl border border-white/5"></div>)}
      </div>
      <div className="h-[400px] bg-white/5 rounded-xl border border-white/5"></div>
    </div>;
  }

  if (!overview) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-center">
        <Activity className="w-16 h-16 text-muted-foreground mb-4" />
        <h2 className="font-display text-2xl text-white mb-2">No Data Available</h2>
        <p className="text-muted-foreground max-w-md">Dashboard metrics will appear once campaigns are syncing and leads are being tracked. Check Integration settings to connect your ad platforms.</p>
      </div>
    );
  }

  const overviewTotals = {
    totalRevenue: safeNumber(overview.totalRevenue),
    totalSpend: safeNumber(overview.totalSpend),
    roas: safeNumber(overview.roas),
    totalLeads: safeNumber(overview.totalLeads),
    bookedLeads: safeNumber(overview.bookedLeads),
    soldLeads: safeNumber(overview.soldLeads),
    bookingRate: safeNumber(overview.bookingRate),
    closeRate: safeNumber(overview.closeRate),
    cpl: safeNumber(overview.cpl),
    avgSaleValue: safeNumber(overview.avgSaleValue),
    attributionMatchRate: safeNumber(overview.attributionMatchRate),
    paidRevenue: safeNumber(overview.paidRevenue),
    unpaidRevenue: safeNumber(overview.unpaidRevenue),
    invoicedJobCount: safeNumber(overview.invoicedJobCount),
  };

  function handleExportCSV() {
    if (!overview) return;
    setExporting(true);
    const rows = [
      ["Metric", "Value"],
      ["Total Revenue", String(overviewTotals.totalRevenue)],
      ["Ad Spend", String(overviewTotals.totalSpend)],
      ["ROAS", String(overviewTotals.roas)],
      ["Total Leads", String(overviewTotals.totalLeads)],
      ["Booked Leads", String(overviewTotals.bookedLeads)],
      ["Sold Leads", String(overviewTotals.soldLeads)],
      ["Booking Rate %", String(overviewTotals.bookingRate)],
      ["Close Rate %", String(overviewTotals.closeRate)],
      ["CPL", String(overviewTotals.cpl)],
      ["Avg Sale Value", String(overviewTotals.avgSaleValue)],
      ["Match Rate %", String(overviewTotals.attributionMatchRate)],
      ["Period", `${startDate} to ${endDate}`],
    ];

    if (chartDaily.length > 0) {
      rows.push([], ["Date", "Spend", "Revenue"]);
      for (const row of chartDaily) {
        rows.push([String(row.date || ""), String(row.spend || 0), String(row.revenue || 0)]);
      }
      if (historicalRevenue > 0) {
        rows.push([], ["Historical Revenue (before date range)", String(historicalRevenue), `${historicalJobCount} jobs`]);
      }
    }

    const csv = rows.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `optics-report-${startDate}-${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExporting(false);
  }

  // Total Revenue drills into the dedicated Revenue Attributed page (same
  // date-range preset) so the figures reconcile with that page's job list.
  const openRevenueDrilldown = () => navigate(`/revenue-attributed?range=${dateRange}`);
  const metrics: Array<{ label: string; value: string; icon: typeof DollarSign; sub?: string; onClick?: () => void }> = [
    {
      label: "Total Revenue",
      value: formatCurrency(overviewTotals.totalRevenue),
      icon: DollarSign,
      sub: overviewTotals.paidRevenue > 0 || overviewTotals.unpaidRevenue > 0
        ? `${formatCurrency(overviewTotals.paidRevenue)} paid · ${formatCurrency(overviewTotals.unpaidRevenue)} unpaid`
        : undefined,
      onClick: openRevenueDrilldown,
    },
    { label: "Ad Spend", value: formatCurrency(overviewTotals.totalSpend), icon: Activity },
    { label: "ROAS", value: `${overviewTotals.roas.toFixed(2)}x`, icon: Target },
    { label: "Total Leads", value: overviewTotals.totalLeads.toString(), icon: Users },
    { label: "Booking Rate", value: `${overviewTotals.bookingRate}%`, icon: Users, sub: `Leads -> Appointments · ${overviewTotals.bookedLeads} booked / ${overviewTotals.totalLeads} leads` },
    { label: "Close Rate", value: `${overviewTotals.closeRate}%`, icon: Target, sub: `Appointments -> Invoiced Jobs · ${overviewTotals.invoicedJobCount} invoiced / ${overviewTotals.bookedLeads} booked` },
  ];

  const chartDaily = chartData?.daily ?? [];
  const historicalRevenue = chartData?.historicalRevenue ?? 0;
  const historicalJobCount = chartData?.historicalJobCount ?? 0;
  const displayChartData = chartDaily.length > 0 ? chartDaily : [];
  // Distinguish loading from loaded-but-empty so the chart card shows a neutral
  // "Loading…" while the request is in flight, then a friendly empty-state once
  // it resolves with no data — mirroring the Budget Pace / Match Tier cards.
  // `chartData` only stays undefined until the very first response lands (the
  // ref keeps prior data across re-fetches), so this is the initial-load case.
  const chartLoading = chartData === undefined;

  return (
    <div className="space-y-8">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Command Center</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">SYSTEM OVERVIEW & ATTRIBUTION METRICS</p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={dateRange} onValueChange={v => setDateRange(v as DateRange)}>
            <SelectTrigger className="w-auto bg-card border border-white/10 text-white text-sm rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="last7">Last 7 Days</SelectItem>
              <SelectItem value="last30">Last 30 Days</SelectItem>
              <SelectItem value="thisMonth">This Month</SelectItem>
              <SelectItem value="lastMonth">Last Month</SelectItem>
            </SelectContent>
          </Select>
          <button
            onClick={handleExportCSV}
            disabled={exporting}
            className="bg-primary hover:bg-primary/90 text-white font-medium px-5 py-2 rounded-lg transition-all shadow-[0_0_15px_rgba(242,5,5,0.3)] hover:shadow-[0_0_25px_rgba(242,5,5,0.5)] flex items-center gap-2 disabled:opacity-50"
          >
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Export Report
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6">
        {metrics.map((metric, i) => (
          <PremiumCard
            key={i}
            className={`p-5 flex flex-col justify-between ${metric.onClick ? "cursor-pointer hover:border-primary/40 transition-colors" : ""}`}
            transition={{ delay: i * 0.1 }}
            onClick={metric.onClick}
          >
            <div className="flex items-start justify-between mb-4">
              <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center border border-white/5">
                <metric.icon className="w-5 h-5 text-muted-foreground" />
              </div>
              {metric.onClick && <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/60" />}
            </div>
            <div>
              <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider mb-1">{metric.label}</p>
              <p className="text-3xl font-display text-white">{metric.value}</p>
              {"sub" in metric && metric.sub && <p className="text-muted-foreground text-[11px] mt-1">{metric.sub}</p>}
            </div>
          </PremiumCard>
        ))}
      </div>

      <AgencyBudgetPace />

      <PremiumCard className="h-[450px] p-6 flex flex-col" transition={{ delay: 0.5 }}>
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-display text-xl text-white">Spend vs Revenue Attribution</h3>
              <p className="text-muted-foreground text-sm">Nightly reconciled ServiceTitan revenue mapped to Google/Meta ad spend.</p>
            </div>
            {/*
              Hidden by design when there's no pre-range revenue. Unlike the
              budget/revenue sections that vanished and read as "missing", this
              is a small contextual adornment on the chart card (which itself
              never disappears), so a "$0 · 0 jobs before range" badge would add
              noise without conveying anything. The chart stays put either way,
              so there's no "is this section missing?" confusion to fix here.
            */}
            {historicalRevenue > 0 && (
              <div className="text-right bg-white/5 border border-white/10 rounded-lg px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Historical Revenue</p>
                <p className="text-sm font-display text-amber-400">{formatCurrency(historicalRevenue)}</p>
                <p className="text-[10px] text-muted-foreground">{historicalJobCount} jobs before range</p>
              </div>
            )}
          </div>
        </div>
        {chartLoading ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <p className="text-sm">Loading…</p>
          </div>
        ) : displayChartData.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <p className="text-sm text-center">No spend or revenue to show for this date range yet.</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={displayChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} />
                <XAxis dataKey="date" stroke="#879199" fontSize={12} tickLine={false} axisLine={false} dy={10} />
                <YAxis yAxisId="left" stroke="#879199" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v/1000}k`} />
                <YAxis yAxisId="right" orientation="right" stroke="#879199" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v/1000}k`} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                  contentStyle={{ backgroundColor: '#0A0F1F', borderColor: '#1E293B', borderRadius: '8px', color: '#fff' }}
                  itemStyle={{ color: '#fff' }}
                />
                <Legend wrapperStyle={{ paddingTop: '20px' }} />
                <Bar yAxisId="left" dataKey="spend" name="Ad Spend" fill={PLATFORM_COLORS.totalCost} radius={[4, 4, 0, 0]} maxBarSize={40} />
                <Bar
                  yAxisId="right"
                  dataKey="revenue"
                  name="ST Revenue"
                  fill={PLATFORM_COLORS.revenue}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={40}
                  cursor="pointer"
                  onClick={(data: unknown) => {
                    // Recharts Bar.onClick passes a synthetic event whose shape
                    // varies by version: in some, the row data is spread on the
                    // top-level arg (`{ date, revenue, ... }`); in others it's
                    // nested under `.payload`. Handle both.
                    const d = data as { date?: string; revenue?: number; payload?: { date?: string; revenue?: number } } | undefined;
                    const row = d?.payload ?? d;
                    if (!row?.date || !row.revenue) return;
                    setDrilldown({ startDate: row.date, endDate: row.date, title: `Revenue on ${row.date}` });
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </PremiumCard>

      <MetaCampaignBreakdown startDate={startDate} endDate={endDate} />

      {drilldown && (
        <JobRevenueDrilldown
          startDate={drilldown.startDate}
          endDate={drilldown.endDate}
          title={drilldown.title}
          onClose={() => setDrilldown(null)}
        />
      )}
    </div>
  );
}

function JobRevenueDrilldown({
  startDate,
  endDate,
  title,
  onClose,
}: {
  startDate: string;
  endDate: string;
  title: string;
  onClose: () => void;
}) {
  const [jobs, setJobs] = useState<DrilldownJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setJobs(null);
    setError(null);
    const params = new URLSearchParams({
      startDate,
      endDate,
      useJobDate: "true",
      sort: "revenue",
      // Match the chart/overview revenue math, which sums only completed jobs.
      // Without this, the modal can list pending/cancelled jobs that didn't
      // actually contribute to the bar/card total.
      status: "completed",
      limit: "200",
    });
    fetch(`${API_BASE}/drilldown/jobs?${params}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<DrilldownJob[]>;
      })
      .then((data) => { if (!cancelled) setJobs(data); })
      .catch((e) => { if (!cancelled) setError(String(e.message || e)); });
    return () => { cancelled = true; };
  }, [startDate, endDate]);

  const totalRevenue = useMemo(() => {
    if (!jobs) return 0;
    return round2(jobs.reduce((sum, j) => sum + (j.invoiceTotal != null ? j.invoiceTotal + (j.invoiceRebateAmount ?? 0) : j.revenue), 0));
  }, [jobs]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-card border border-white/10 rounded-xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-6 border-b border-white/5">
          <div>
            <h3 className="font-display text-xl text-white">{title}</h3>
            <p className="text-muted-foreground text-sm mt-1">
              ServiceTitan jobs that contributed, biggest invoices first.
              {jobs && ` ${jobs.length} job${jobs.length === 1 ? "" : "s"} · ${formatCurrency(totalRevenue)}`}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {error ? (
            <div className="text-center text-red-400 py-8">Failed to load: {error}</div>
          ) : jobs === null ? (
            <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading jobs…
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">No jobs found in this range.</div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                  <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Job Type</th>
                  <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">ST Job</th>
                  <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Invoice</th>
                  <th className="pb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {jobs.map((job) => {
                  const revenue = round2(job.invoiceTotal != null ? job.invoiceTotal + (job.invoiceRebateAmount ?? 0) : job.revenue);
                  const dateRaw = job.invoiceDate || job.completedAt || job.createdAt;
                  const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString() : "—";
                  return (
                    <tr key={job.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 text-sm text-muted-foreground whitespace-nowrap">{dateStr}</td>
                      <td className="py-3 text-sm text-white">{job.customerName || "—"}</td>
                      <td className="py-3 text-sm text-muted-foreground">{job.jobTypeName || job.jobType || "—"}</td>
                      <td className="py-3 text-sm text-muted-foreground font-mono">{job.stJobId || `#${job.id}`}</td>
                      <td className="py-3 text-sm text-emerald-400 text-right font-display">{formatCurrency(revenue)}</td>
                      <td className="py-3 text-sm">
                        {job.matchLevel ? (
                          <span className="text-xs text-ice/80">{job.matchLevel}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground/50">unmatched</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="p-4 border-t border-white/5 text-xs text-muted-foreground">
          To see the full attribution trace (ad click, GCLID, UTM, form fields) for a matched job, open the Attribution Log and filter to this date range.
        </div>
      </div>
    </div>
  );
}

// Per-client budget-pace overview for the agency Command Center. Pace flags
// (overPace / underPace / overBudget) come straight from /admin/dashboard-stats
// (AdminTenantStats) — no client-side recomputation. Badge styling mirrors the
// Agency God View's cross-tenant table for consistency. The pace projection is
// month-to-date, so we always request the current calendar month regardless of
// the Command Center's chart date filter.
function AgencyBudgetPace() {
  const { isAgency } = useAuth();
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const endDate = now.toISOString().split("T")[0];
  // Admin stats are agency-only; gate the request so client users never fire it.
  const { data } = useGetAdminDashboardStats(
    { startDate, endDate },
    { query: { enabled: isAgency, queryKey: getGetAdminDashboardStatsQueryKey({ startDate, endDate }) } },
  );

  // Surface the worst-pacing clients first so problems are obvious at a glance.
  const tenants = useMemo(
    () => [...(data?.tenants ?? [])].sort((a, b) => b.pacePercent - a.pacePercent),
    [data],
  );

  // Stays hidden for non-agency/client users.
  if (!isAgency) return null;
  // Distinguish loading from loaded-but-empty: while the admin stats are still
  // in flight `data` is undefined, so render nothing rather than flashing the
  // empty-state. Only once the stats have resolved do we choose between the
  // populated table and the friendly empty-state below.
  if (data === undefined) return null;

  if (tenants.length === 0) {
    return (
      <PremiumCard className="p-0 overflow-hidden" transition={{ delay: 0.4 }}>
        <div className="p-6 border-b border-white/5">
          <h3 className="font-display text-xl text-white">Budget Pace by Client</h3>
          <p className="text-muted-foreground text-sm">Month-to-date projected spend vs monthly budget. Flags clients pacing over or under target.</p>
        </div>
        <p className="text-sm text-muted-foreground py-8 text-center">
          No client budgets to show yet.
        </p>
      </PremiumCard>
    );
  }

  return (
    <PremiumCard className="p-0 overflow-hidden" transition={{ delay: 0.4 }}>
      <div className="p-6 border-b border-white/5">
        <h3 className="font-display text-xl text-white">Budget Pace by Client</h3>
        <p className="text-muted-foreground text-sm">Month-to-date projected spend vs monthly budget. Flags clients pacing over or under target.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/5 bg-background/50">
              <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Client</th>
              <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Budget Pace</th>
              <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {tenants.map((row) => {
              const isOverBudget = row.overPace;
              const isUnderBudget = row.underPace;
              const paceTitle = `Projected ${formatCurrency(row.projectedSpend)} of ${formatCurrency(row.monthlyBudget)} budget · ${row.pacePercent.toFixed(1)}% pace`;
              return (
                <tr key={row.tenantId} className="hover:bg-white/[0.02] transition-colors">
                  <td className="p-4 font-medium text-white">
                    <div className="flex items-center gap-2">
                      <span>{row.tenantName}</span>
                      {row.overBudget && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-400 ring-1 ring-inset ring-red-500/30"
                          title={`Projected spend ${formatCurrency(row.projectedSpend)} exceeds budget ${formatCurrency(row.monthlyBudget)}`}
                        >
                          <AlertTriangle className="w-3 h-3" />
                          Over Budget
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex items-center justify-end gap-2" title={paceTitle}>
                      <div className="w-24 h-2 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${isOverBudget ? "bg-red-500" : isUnderBudget ? "bg-amber-500" : "bg-emerald-500"}`}
                          style={{ width: `${Math.min(row.pacePercent, 100)}%` }}
                        />
                      </div>
                      <span className={`text-xs font-medium ${isOverBudget ? "text-red-400" : isUnderBudget ? "text-amber-400" : "text-emerald-400"}`}>
                        {row.pacePercent.toFixed(0)}%
                      </span>
                      {isOverBudget && <AlertTriangle className="w-3 h-3 text-red-400" />}
                    </div>
                  </td>
                  <td className="p-4 text-right">
                    <span
                      title={paceTitle}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${
                        isOverBudget
                          ? "bg-red-500/15 text-red-400 ring-red-500/30"
                          : isUnderBudget
                            ? "bg-amber-500/15 text-amber-400 ring-amber-500/30"
                            : "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30"
                      }`}
                    >
                      {isOverBudget ? "Over Pace" : isUnderBudget ? "Under Pace" : "On Pace"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </PremiumCard>
  );
}
