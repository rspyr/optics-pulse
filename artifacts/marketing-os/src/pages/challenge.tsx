import { useEffect, useMemo, useState } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatCurrency } from "@/lib/utils";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { useAuth } from "@/components/auth-context";
import {
  Ban,
  CalendarCheck,
  ChevronDown,
  DollarSign,
  Eye,
  EyeOff,
  Layers3,
  Loader2,
  SlidersHorizontal,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const VISIBILITY_STORAGE_KEY = "challengeDashboard.visibleMetrics.v1";

type DateRange = "last7" | "last30" | "thisMonth" | "lastMonth";

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

type ChallengeMetric = {
  funnel: string | null;
  costPerLead: number;
  metaLeads: number;
  uniquePulseLeads: number;
  appointmentsBooked: number;
  bookingRate: number;
  cancellationRate: number;
  cancelledJobs: number;
  totalJobs: number;
  totalEstimateValue: number;
  totalSoldClosedValue: number;
  roasPotential: number;
  roasSold: number;
  totalSpend: number;
  completedEstimateJobs: number;
  averageCostPerInHomeAppointment: number;
  soldJobs: number;
  costToAcquireCustomer: number;
  averageClosedJobValue: number;
};

type ChallengeResponse = {
  dateRange: { startDate: string; endDate: string };
  selectedFunnels: string[];
  funnels: string[];
  summary: ChallengeMetric;
  byFunnel: ChallengeMetric[];
  allocation: {
    method: "pulse_lead_share";
    allUniquePulseLeads: number;
    note: string;
  };
};

type MetricKey =
  | "costPerLead"
  | "metaLeads"
  | "uniquePulseLeads"
  | "appointmentsBooked"
  | "bookingRate"
  | "cancellationRate"
  | "totalEstimateValue"
  | "totalSoldClosedValue"
  | "roasPotential"
  | "roasSold"
  | "totalSpend"
  | "averageCostPerInHomeAppointment"
  | "costToAcquireCustomer"
  | "averageClosedJobValue";

const METRICS: Array<{
  key: MetricKey;
  label: string;
  shortLabel: string;
  icon: typeof DollarSign;
  tone: string;
  format: (value: number) => string;
  sub?: (metric: ChallengeMetric) => string;
}> = [
  { key: "costPerLead", label: "Cost Per Lead", shortLabel: "CPL", icon: DollarSign, tone: "text-sky-300", format: formatCurrency },
  { key: "metaLeads", label: "Leads From Meta", shortLabel: "Meta Leads", icon: Target, tone: "text-blue-300", format: formatNumber },
  { key: "uniquePulseLeads", label: "Unique Pulse Leads", shortLabel: "Pulse Leads", icon: Users, tone: "text-ice", format: formatNumber },
  { key: "appointmentsBooked", label: "Appointments Booked", shortLabel: "Appts", icon: CalendarCheck, tone: "text-emerald-300", format: formatNumber },
  { key: "bookingRate", label: "Booking Rate", shortLabel: "Booking", icon: TrendingUp, tone: "text-emerald-300", format: formatPercent },
  {
    key: "cancellationRate",
    label: "Cancellation Rate",
    shortLabel: "Cancel",
    icon: Ban,
    tone: "text-red-300",
    format: formatPercent,
    sub: (m) => `${formatNumber(m.cancelledJobs)} cancelled / ${formatNumber(m.totalJobs)} jobs`,
  },
  { key: "totalEstimateValue", label: "Total Estimate Value", shortLabel: "Est. Value", icon: DollarSign, tone: "text-amber-300", format: formatCurrency },
  { key: "totalSoldClosedValue", label: "Total Sold/Closed Value", shortLabel: "Sold Value", icon: DollarSign, tone: "text-emerald-300", format: formatCurrency },
  { key: "roasPotential", label: "ROAS Potential", shortLabel: "ROAS Pot.", icon: TrendingUp, tone: "text-amber-300", format: formatMultiplier },
  { key: "roasSold", label: "ROAS Sold", shortLabel: "ROAS Sold", icon: TrendingUp, tone: "text-emerald-300", format: formatMultiplier },
  { key: "totalSpend", label: "Total Spend", shortLabel: "Spend", icon: DollarSign, tone: "text-sky-300", format: formatCurrency },
  {
    key: "averageCostPerInHomeAppointment",
    label: "Avg Cost Per In-Home Appointment",
    shortLabel: "Cost/In-Home",
    icon: CalendarCheck,
    tone: "text-violet-300",
    format: formatCurrency,
    sub: (m) => `${formatNumber(m.completedEstimateJobs)} completed estimate jobs`,
  },
  {
    key: "costToAcquireCustomer",
    label: "Cost To Acquire Customer",
    shortLabel: "CAC",
    icon: Target,
    tone: "text-rose-300",
    format: formatCurrency,
    sub: (m) => `${formatNumber(m.soldJobs)} sold jobs`,
  },
  {
    key: "averageClosedJobValue",
    label: "Average Closed Job Value",
    shortLabel: "Avg Closed",
    icon: DollarSign,
    tone: "text-emerald-300",
    format: formatCurrency,
  },
];

const DEFAULT_VISIBILITY = Object.fromEntries(METRICS.map((metric) => [metric.key, true])) as Record<MetricKey, boolean>;

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatMultiplier(value: number): string {
  return `${value.toFixed(2)}x`;
}

function readVisibility(): Record<MetricKey, boolean> {
  if (typeof window === "undefined") return DEFAULT_VISIBILITY;
  try {
    const raw = window.localStorage.getItem(VISIBILITY_STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBILITY;
    const parsed = JSON.parse(raw) as Partial<Record<MetricKey, boolean>>;
    return { ...DEFAULT_VISIBILITY, ...parsed };
  } catch {
    return DEFAULT_VISIBILITY;
  }
}

function writeVisibility(visibility: Record<MetricKey, boolean>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify(visibility));
  } catch {
    // Ignore disabled storage.
  }
}

export default function Challenge() {
  const { effectiveTenantId } = useTenantFilter();
  const { user } = useAuth();
  const [dateRange, setDateRange] = useState<DateRange>("last30");
  const [selectedFunnels, setSelectedFunnels] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<Record<MetricKey, boolean>>(readVisibility);
  const [data, setData] = useState<ChallengeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = user?.role === "super_admin" || user?.role === "agency_user" || user?.role === "client_admin";
  const { startDate, endDate, label } = useMemo(() => getDateRange(dateRange), [dateRange]);
  const visibleMetrics = useMemo(() => METRICS.filter((metric) => visibility[metric.key]), [visibility]);

  useEffect(() => {
    writeVisibility(visibility);
  }, [visibility]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ startDate, endDate });
    if (effectiveTenantId != null) params.set("tenantId", String(effectiveTenantId));
    selectedFunnels.forEach((funnel) => params.append("funnel", funnel));

    fetch(`${API_BASE}/api/dashboard/challenge?${params.toString()}`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ChallengeResponse>;
      })
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setSelectedFunnels((current) => current.filter((funnel) => next.funnels.includes(funnel)));
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || "Failed to load Challenge metrics");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [startDate, endDate, effectiveTenantId, selectedFunnels.join("\u0000")]);

  const funnelButtonLabel = selectedFunnels.length === 0
    ? "All funnels"
    : selectedFunnels.length === 1
      ? selectedFunnels[0]
      : `${selectedFunnels.length} funnels`;

  function toggleFunnel(funnel: string) {
    setSelectedFunnels((current) =>
      current.includes(funnel)
        ? current.filter((item) => item !== funnel)
        : [...current, funnel],
    );
  }

  function toggleMetric(key: MetricKey) {
    setVisibility((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <GradientHeading className="mb-2 text-3xl md:text-4xl">The Challenge</GradientHeading>
          <p className="font-sub text-sm tracking-wide text-muted-foreground">
            ADS PERFORMANCE BY LEAD COHORT - {label.toUpperCase()}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="min-w-44 justify-between bg-card/60 text-white">
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Layers3 className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{funnelButtonLabel}</span>
                </span>
                <ChevronDown className="h-4 w-4 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel>Funnels</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setSelectedFunnels([])}>
                All funnels
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {data?.funnels.length ? data.funnels.map((funnel) => (
                <DropdownMenuCheckboxItem
                  key={funnel}
                  checked={selectedFunnels.includes(funnel)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => toggleFunnel(funnel)}
                >
                  <span className="truncate">{funnel}</span>
                </DropdownMenuCheckboxItem>
              )) : (
                <div className="px-2 py-3 text-sm text-muted-foreground">No funnels in this range.</div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Select value={dateRange} onValueChange={(value) => setDateRange(value as DateRange)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="last7">Last 7 Days</SelectItem>
              <SelectItem value="last30">Last 30 Days</SelectItem>
              <SelectItem value="thisMonth">This Month</SelectItem>
              <SelectItem value="lastMonth">Last Month</SelectItem>
            </SelectContent>
          </Select>

          {isAdmin && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="bg-card/60 text-white">
                  <SlidersHorizontal className="h-4 w-4" />
                  Metrics
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel>Visible metrics</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {METRICS.map((metric) => (
                  <DropdownMenuCheckboxItem
                    key={metric.key}
                    checked={visibility[metric.key]}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={() => toggleMetric(metric.key)}
                  >
                    <span className="truncate">{metric.label}</span>
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setVisibility(DEFAULT_VISIBILITY)}>
                  Show all metrics
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {loading && !data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-36 animate-pulse rounded-xl border border-white/5 bg-white/5" />
          ))}
        </div>
      ) : error ? (
        <PremiumCard className="border-red-500/20 bg-red-500/5 p-6">
          <p className="text-sm font-medium text-red-300">The Challenge metrics could not load.</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </PremiumCard>
      ) : data ? (
        <>
          {visibleMetrics.length === 0 ? (
            <PremiumCard className="p-8 text-center">
              <EyeOff className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">All metrics are hidden.</p>
            </PremiumCard>
          ) : (
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {visibleMetrics.map((metric, index) => (
                <MetricCard key={metric.key} metric={metric} row={data.summary} index={index} />
              ))}
            </section>
          )}

          <PremiumCard className="overflow-hidden p-0">
            <div className="flex flex-col gap-2 border-b border-white/5 p-5 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="font-display text-xl text-white">Per-Funnel Breakdown</h3>
                <p className="text-sm text-muted-foreground">
                  {selectedFunnels.length > 0 ? "Top cards stack the selected funnels; this table shows each selected funnel." : "Showing every funnel in the lead window."}
                </p>
              </div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-muted-foreground">
                <Eye className="h-3.5 w-3.5" />
                {visibleMetrics.length} visible
              </div>
            </div>

            {data.byFunnel.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No funnel activity in this range.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-white/5 bg-background/50">
                      <th className="sticky left-0 z-10 bg-background/95 p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Funnel
                      </th>
                      {visibleMetrics.map((metric) => (
                        <th key={metric.key} className="p-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          {metric.shortLabel}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {data.byFunnel.map((row) => (
                      <tr key={row.funnel ?? "unknown"} className="hover:bg-white/[0.02]">
                        <td className="sticky left-0 z-10 max-w-64 bg-card/95 p-4 text-sm font-medium text-white">
                          <span className="line-clamp-2">{row.funnel || "Unassigned"}</span>
                        </td>
                        {visibleMetrics.map((metric) => (
                          <td key={metric.key} className="whitespace-nowrap p-4 text-right text-sm text-white">
                            {metric.format(row[metric.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </PremiumCard>

          <p className="text-xs leading-relaxed text-muted-foreground/70">
            {data.allocation.note}
          </p>
        </>
      ) : null}
    </div>
  );
}

function MetricCard({
  metric,
  row,
  index,
}: {
  metric: (typeof METRICS)[number];
  row: ChallengeMetric;
  index: number;
}) {
  const Icon = metric.icon;
  const value = row[metric.key];
  return (
    <PremiumCard className="flex min-h-36 flex-col justify-between p-5" transition={{ delay: Math.min(index * 0.03, 0.24) }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/5 bg-white/[0.04]">
          <Icon className={`h-5 w-5 ${metric.tone}`} />
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {metric.shortLabel}
        </span>
      </div>
      <div className="mt-5">
        <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{metric.label}</p>
        <p className="font-display text-3xl text-white">{metric.format(value)}</p>
        {metric.sub && <p className="mt-1 text-[11px] text-muted-foreground">{metric.sub(row)}</p>}
      </div>
    </PremiumCard>
  );
}
