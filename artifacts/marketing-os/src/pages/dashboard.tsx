import { useState, useMemo } from "react";
import { useGetDashboardOverview, useGetSpendRevenueChart } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { cn, formatCurrency, formatPercentage } from "@/lib/utils";
import { ArrowUpRight, ArrowDownRight, DollarSign, Users, Target, Activity, Link, Download, Loader2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

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
  const [dateRange, setDateRange] = useState<DateRange>("last30");
  const [exporting, setExporting] = useState(false);
  const { startDate, endDate } = useMemo(() => getDateRange(dateRange), [dateRange]);

  const { data: overview, isLoading: overviewLoading, isFetching: overviewFetching } = useGetDashboardOverview({ startDate, endDate }, { query: { placeholderData: (prev: unknown) => prev } });
  const { data: chartData, isLoading: chartLoading, isFetching: chartFetching } = useGetSpendRevenueChart({ startDate, endDate }, { query: { placeholderData: (prev: unknown) => prev } });

  const isInitialLoad = overviewLoading || chartLoading;
  const isRefetching = overviewFetching || chartFetching;

  if (isInitialLoad) {
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

    if (chartData && Array.isArray(chartData)) {
      rows.push([], ["Date", "Spend", "Revenue"]);
      for (const row of chartData) {
        const r = row as unknown as Record<string, unknown>;
        rows.push([String(r.date || ""), String(r.spend || 0), String(r.revenue || 0)]);
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

  const metrics = [
    { label: "Total Revenue", value: formatCurrency(overview.totalRevenue), icon: DollarSign },
    { label: "Ad Spend", value: formatCurrency(overview.totalSpend), icon: Activity },
    { label: "ROAS", value: `${overview.roas.toFixed(2)}x`, icon: Target },
    { label: "Total Leads", value: overview.totalLeads.toString(), icon: Users },
    { label: "Match Rate", value: `${overview.attributionMatchRate}%`, icon: Link },
  ];

  const displayChartData = chartData && Array.isArray(chartData) && chartData.length > 0
    ? chartData
    : [];

  return (
    <div className={cn("space-y-8 transition-opacity duration-200", isRefetching && "opacity-70")}>
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Command Center</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">SYSTEM OVERVIEW & ATTRIBUTION METRICS</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={dateRange}
            onChange={e => setDateRange(e.target.value as DateRange)}
            className="bg-card border border-white/10 text-white text-sm rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="last7">Last 7 Days</option>
            <option value="last30">Last 30 Days</option>
            <option value="thisMonth">This Month</option>
            <option value="lastMonth">Last Month</option>
          </select>
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
          <PremiumCard key={i} className="p-5 flex flex-col justify-between" transition={{ delay: i * 0.1 }}>
            <div className="flex items-start justify-between mb-4">
              <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center border border-white/5">
                <metric.icon className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
            <div>
              <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider mb-1">{metric.label}</p>
              <p className="text-3xl font-display text-white">{metric.value}</p>
            </div>
          </PremiumCard>
        ))}
      </div>

      <PremiumCard className="h-[450px] p-6 flex flex-col" transition={{ delay: 0.5 }}>
        <div className="mb-6">
          <h3 className="font-display text-xl text-white">Spend vs Revenue Attribution</h3>
          <p className="text-muted-foreground text-sm">Nightly reconciled ServiceTitan revenue mapped to Google/Meta ad spend.</p>
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
                <Bar yAxisId="left" dataKey="spend" name="Ad Spend" fill="#002D5E" radius={[4, 4, 0, 0]} maxBarSize={40} />
                <Bar yAxisId="right" dataKey="revenue" name="ST Revenue" fill="#F20505" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}
