import { useState, useMemo, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useGetDashboardOverview, useGetSpendRevenueChart } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, formatPercentage, PLATFORM_COLORS } from "@/lib/utils";
import { ArrowUpRight, ArrowDownRight, DollarSign, Users, Target, Activity, Link, Download, Loader2, X, ExternalLink } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { MetaCampaignBreakdown } from "@/components/MetaCampaignBreakdown";

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

  function handleExportCSV() {
    if (!overview) return;
    setExporting(true);
    const rows = [
      ["Metric", "Value"],
      ["Total Revenue", String(overview.totalRevenue)],
      ["Ad Spend", String(overview.totalSpend)],
      ["ROAS", String(overview.roas)],
      ["Total Leads", String(overview.totalLeads)],
      ["Booked Leads", String(overview.bookedLeads)],
      ["Sold Leads", String(overview.soldLeads)],
      ["Booking Rate %", String(overview.bookingRate)],
      ["Close Rate %", String(overview.closeRate)],
      ["CPL", String(overview.cpl)],
      ["Avg Sale Value", String(overview.avgSaleValue)],
      ["Match Rate %", String(overview.attributionMatchRate)],
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
    { label: "Total Revenue", value: formatCurrency(overview.totalRevenue), icon: DollarSign, sub: overview.paidRevenue > 0 || overview.unpaidRevenue > 0 ? `${formatCurrency(overview.paidRevenue)} paid · ${formatCurrency(overview.unpaidRevenue)} unpaid` : undefined, onClick: openRevenueDrilldown },
    { label: "Ad Spend", value: formatCurrency(overview.totalSpend), icon: Activity },
    { label: "ROAS", value: `${overview.roas.toFixed(2)}x`, icon: Target },
    { label: "Total Leads", value: overview.totalLeads.toString(), icon: Users },
    { label: "Booking Rate", value: `${overview.bookingRate}%`, icon: Users, sub: `Leads → Appointments · ${overview.bookedLeads} booked / ${overview.totalLeads} leads` },
    { label: "Close Rate", value: `${overview.closeRate}%`, icon: Target, sub: `Appointments → Invoiced Jobs · ${overview.invoicedJobCount} invoiced / ${overview.bookedLeads} booked` },
  ];

  const chartDaily = chartData?.daily ?? [];
  const historicalRevenue = chartData?.historicalRevenue ?? 0;
  const historicalJobCount = chartData?.historicalJobCount ?? 0;
  const displayChartData = chartDaily.length > 0 ? chartDaily : [];

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

      <PremiumCard className="h-[450px] p-6 flex flex-col" transition={{ delay: 0.5 }}>
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-display text-xl text-white">Spend vs Revenue Attribution</h3>
              <p className="text-muted-foreground text-sm">Nightly reconciled ServiceTitan revenue mapped to Google/Meta ad spend.</p>
            </div>
            {historicalRevenue > 0 && (
              <div className="text-right bg-white/5 border border-white/10 rounded-lg px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Historical Revenue</p>
                <p className="text-sm font-display text-amber-400">{formatCurrency(historicalRevenue)}</p>
                <p className="text-[10px] text-muted-foreground">{historicalJobCount} jobs before range</p>
              </div>
            )}
          </div>
        </div>
        {displayChartData.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <p>No chart data available for this date range.</p>
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
    return jobs.reduce((sum, j) => sum + (j.invoiceTotal != null ? j.invoiceTotal + (j.invoiceRebateAmount ?? 0) : j.revenue), 0);
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
                  const revenue = job.invoiceTotal != null ? job.invoiceTotal + (job.invoiceRebateAmount ?? 0) : job.revenue;
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
