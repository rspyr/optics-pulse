import { useGetTenantPerformance } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { formatCurrency, formatPercentage } from "@/lib/utils";

export default function Internal() {
  const { data, isLoading } = useGetTenantPerformance({});

  const mockRows = data || [
    { tenantId: 1, tenantName: "Apex HVAC", mtdSpend: 15400, mtdRevenue: 128000, cpl: 85, bookingRate: 65, closeRate: 45, roas: 8.3, leadCount: 181 },
    { tenantId: 2, tenantName: "Nordic Climate", mtdSpend: 8200, mtdRevenue: 41000, cpl: 120, bookingRate: 35, closeRate: 30, roas: 5.0, leadCount: 68 },
    { tenantId: 3, tenantName: "Texas Air Pros", mtdSpend: 22000, mtdRevenue: 65000, cpl: 155, bookingRate: 40, closeRate: 25, roas: 2.9, leadCount: 141 },
    { tenantId: 4, tenantName: "Chill Brothers", mtdSpend: 5500, mtdRevenue: 52000, cpl: 65, bookingRate: 75, closeRate: 55, roas: 9.4, leadCount: 84 },
  ];

  const getCellColor = (value: number, type: 'roas' | 'cpl' | 'booking') => {
    if (type === 'roas') {
      if (value >= 8) return 'text-emerald-400';
      if (value <= 3) return 'text-red-400 font-bold';
      return 'text-white';
    }
    if (type === 'cpl') {
      if (value >= 150) return 'text-red-400 font-bold';
      if (value <= 90) return 'text-emerald-400';
      return 'text-white';
    }
    if (type === 'booking') {
      if (value >= 60) return 'text-emerald-400';
      if (value <= 40) return 'text-red-400 font-bold';
      return 'text-white';
    }
    return 'text-white';
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Agency God View</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">CROSS-CLIENT BENCHMARKING</p>
        </div>
      </header>

      <PremiumCard className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 bg-background/50">
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Client Name</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">MTD Spend</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">MTD Revenue</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">CPL</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Booking %</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">ROAS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {mockRows.map((row) => (
                <tr key={row.tenantId} className="group hover:bg-white/[0.02] transition-colors cursor-pointer">
                  <td className="p-4 font-medium text-white">{row.tenantName}</td>
                  <td className="p-4 text-right text-sm text-gray-300">{formatCurrency(row.mtdSpend)}</td>
                  <td className="p-4 text-right text-sm text-gray-300">{formatCurrency(row.mtdRevenue)}</td>
                  <td className={`p-4 text-right text-sm ${getCellColor(row.cpl, 'cpl')}`}>{formatCurrency(row.cpl)}</td>
                  <td className={`p-4 text-right text-sm ${getCellColor(row.bookingRate, 'booking')}`}>{row.bookingRate}%</td>
                  <td className={`p-4 text-right font-display text-lg ${getCellColor(row.roas, 'roas')}`}>{row.roas.toFixed(1)}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PremiumCard>
    </div>
  );
}
