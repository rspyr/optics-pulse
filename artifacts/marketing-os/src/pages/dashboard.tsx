import { useState, useMemo, useRef } from "react";
import { useGetDashboardOverview, useGetSpendRevenueChart } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, formatPercentage, PLATFORM_COLORS } from "@/lib/utils";
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

  const metrics = [
    { label: "Total Revenue", value: formatCurrency(overview.totalRevenue), icon: DollarSign, sub: overview.paidRevenue > 0 || overview.unpaidRevenue > 0 ? `${formatCurrency(overview.paidRevenue)} paid · ${formatCurrency(overview.unpaidRevenue)} unpaid` : undefined },
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
          <PremiumCard key={i} className="p-5 flex flex-col justify-between" transition={{ delay: i * 0.1 }}>
            <div className="flex items-start justify-between mb-4">
              <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center border border-white/5">
                <metric.icon className="w-5 h-5 text-muted-foreground" />
              </div>
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
                <Bar yAxisId="right" dataKey="revenue" name="ST Revenue" fill={PLATFORM_COLORS.revenue} radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}
