import { useGetDashboardOverview } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { formatCurrency, formatPercentage } from "@/lib/utils";
import { ArrowUpRight, Target, Flame, CheckCircle, TrendingUp, DollarSign } from "lucide-react";

export default function Clients() {
  const { data: overview, isLoading } = useGetDashboardOverview({ tenantId: 1 });

  const mockData = overview || {
    cpl: 85.50,
    bookingRate: 62.4,
    closeRate: 51.2,
    avgSaleValue: 8450,
    roas: 12.4
  };

  const metrics = [
    { label: "Cost Per Lead (CPL)", value: formatCurrency(mockData.cpl), trend: "-12%", isPositive: true, icon: Target },
    { label: "Booking Rate", value: `${mockData.bookingRate}%`, trend: "+5%", isPositive: true, icon: Flame },
    { label: "Close Rate", value: `${mockData.closeRate}%`, trend: "+2%", isPositive: true, icon: CheckCircle },
    { label: "Avg Sale Value", value: formatCurrency(mockData.avgSaleValue), trend: "+$450", isPositive: true, icon: DollarSign },
    { label: "True ROI", value: `${mockData.roas}x`, trend: "+1.5x", isPositive: true, icon: TrendingUp },
  ];

  return (
    <div className="space-y-8">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Client Portal</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">THE SEARCHLIGHT KILLER</p>
        </div>
        <div className="flex items-center gap-3">
          <select className="bg-card border border-white/10 text-white text-sm rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50 min-w-[200px]">
            <option>Apex HVAC Services</option>
            <option>Nordic Climate Control</option>
          </select>
          <div className="flex items-center gap-2 bg-card border border-white/10 rounded-lg p-1">
            <button className="px-3 py-1.5 text-xs font-medium rounded-md bg-white/10 text-white">ROAS</button>
            <button className="px-3 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-white">TRUE ROI</button>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
        {metrics.map((metric, i) => (
          <PremiumCard key={i} className="p-6 relative overflow-hidden group">
            <div className="absolute top-0 right-0 w-24 h-24 bg-primary/5 rounded-bl-full -z-10 group-hover:bg-primary/10 transition-colors" />
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-white/5 border border-white/10">
                <metric.icon className="w-5 h-5 text-primary" />
              </div>
              <div className="flex items-center gap-1 text-xs font-medium text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded-full">
                <ArrowUpRight className="w-3 h-3" />
                {metric.trend}
              </div>
            </div>
            <p className="text-muted-foreground text-xs font-bold uppercase tracking-widest mb-1">{metric.label}</p>
            <p className="text-3xl font-display text-white">{metric.value}</p>
          </PremiumCard>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <PremiumCard className="lg:col-span-2 min-h-[400px] flex items-center justify-center">
          <div className="text-center text-muted-foreground">
            <p className="font-display text-xl mb-2 text-white">Revenue Timeline</p>
            <p className="text-sm">Spend vs Revenue chart component goes here.</p>
          </div>
        </PremiumCard>
        <PremiumCard className="flex flex-col">
          <h3 className="font-display text-xl text-white mb-6">Funnel Bottlenecks</h3>
          <div className="space-y-6 flex-1">
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-300">Traffic to Lead</span>
                <span className="text-emerald-400 font-medium">Excellent (12%)</span>
              </div>
              <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 w-[85%] rounded-full" />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-300">Lead to Booked</span>
                <span className="text-red-400 font-medium">Warning (28%)</span>
              </div>
              <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-red-500 w-[30%] rounded-full shadow-[0_0_10px_rgba(242,5,5,0.5)]" />
              </div>
              <p className="text-xs text-muted-foreground mt-2 bg-red-500/10 border border-red-500/20 p-3 rounded-lg">
                Your booking rate has dropped below the 40% threshold. Consider reviewing the Lead Coordinator scripts.
              </p>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-300">Booked to Sold</span>
                <span className="text-white font-medium">Average (45%)</span>
              </div>
              <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-white/40 w-[60%] rounded-full" />
              </div>
            </div>
          </div>
        </PremiumCard>
      </div>
    </div>
  );
}
