import { type FocusEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { LayoutGroup, motion } from "framer-motion";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cn, formatCurrency } from "@/lib/utils";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { useAuth } from "@/components/auth-context";
import {
  Ban,
  CalendarCheck,
  ChevronDown,
  DollarSign,
  Eye,
  EyeOff,
  GripVertical,
  Layers3,
  RotateCcw,
  SlidersHorizontal,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const LEGACY_VISIBILITY_STORAGE_KEY = "challengeDashboard.visibleMetrics.v1";
const METRIC_PREFS_STORAGE_KEY = "challengeDashboard.metricPreferences.v2";
const USER_PREF_KEY = "challengeDashboardMetrics";

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
    method: "pulse_lead_share" | "meta_campaign_funnel_mapping";
    allUniquePulseLeads: number;
    mappedSpend: number;
    mappedMetaLeads: number;
    unmappedSpend: number;
    unmappedMetaLeads: number;
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

type MetricPreferences = {
  order: MetricKey[];
  visibility: Record<MetricKey, boolean>;
};

const METRIC_KEYS = METRICS.map((metric) => metric.key);
const METRIC_KEY_SET = new Set<MetricKey>(METRIC_KEYS);
const METRIC_BY_KEY = Object.fromEntries(METRICS.map((metric) => [metric.key, metric])) as Record<MetricKey, typeof METRICS[number]>;
const DEFAULT_VISIBILITY = Object.fromEntries(METRICS.map((metric) => [metric.key, true])) as Record<MetricKey, boolean>;
const PRESENTATION_HOVER_BASE =
  "transform-gpu transition-[scale,transform,background-color,color,border-color,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[scale,transform,background-color,color]";
const PRESENTATION_ACTIVE_SURFACE = "text-secondary";
const PRESENTATION_HOVER_OVERLAY =
  "pointer-events-none absolute inset-0 rounded-lg border border-primary bg-primary shadow-[0_22px_60px_rgba(242,5,5,0.38)]";
const PRESENTATION_CARD_MOTION =
  "transform-gpu transition-[scale,transform,filter] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] will-change-[scale,transform]";
const PRESENTATION_CARD_SYNC =
  "transition-[background-color,border-color,box-shadow,color] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]";
const DEFAULT_METRIC_PREFERENCES: MetricPreferences = {
  order: METRIC_KEYS,
  visibility: DEFAULT_VISIBILITY,
};

type BreakdownHoverTarget = {
  rowKey?: string;
  metricKey?: MetricKey;
};

type BreakdownHover = BreakdownHoverTarget | null;

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

function isMetricKey(value: string): value is MetricKey {
  return METRIC_KEY_SET.has(value as MetricKey);
}

function normalizeMetricPreferences(input: unknown): MetricPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      order: [...DEFAULT_METRIC_PREFERENCES.order],
      visibility: { ...DEFAULT_METRIC_PREFERENCES.visibility },
    };
  }

  const candidate = input as {
    order?: unknown;
    visibility?: unknown;
  };
  const seen = new Set<MetricKey>();
  const order = Array.isArray(candidate.order)
    ? candidate.order.filter((item): item is MetricKey => {
        if (typeof item !== "string" || !isMetricKey(item) || seen.has(item)) return false;
        seen.add(item);
        return true;
      })
    : [];

  for (const key of METRIC_KEYS) {
    if (!seen.has(key)) order.push(key);
  }

  const visibility = { ...DEFAULT_VISIBILITY };
  if (candidate.visibility && typeof candidate.visibility === "object" && !Array.isArray(candidate.visibility)) {
    for (const [key, value] of Object.entries(candidate.visibility)) {
      if (isMetricKey(key) && typeof value === "boolean") {
        visibility[key] = value;
      }
    }
  }

  return { order, visibility };
}

function readMetricPreferences(): MetricPreferences {
  if (typeof window === "undefined") return normalizeMetricPreferences(null);
  try {
    const raw = window.localStorage.getItem(METRIC_PREFS_STORAGE_KEY);
    if (raw) return normalizeMetricPreferences(JSON.parse(raw));

    const legacy = window.localStorage.getItem(LEGACY_VISIBILITY_STORAGE_KEY);
    if (legacy) {
      return normalizeMetricPreferences({ visibility: JSON.parse(legacy) });
    }
  } catch {
    // Ignore disabled or malformed storage.
  }
  return normalizeMetricPreferences(null);
}

function writeMetricPreferences(preferences: MetricPreferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(METRIC_PREFS_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore disabled storage.
  }
}

export default function Challenge() {
  const { effectiveTenantId } = useTenantFilter();
  const { user } = useAuth();
  const [dateRange, setDateRange] = useState<DateRange>("last30");
  const [selectedFunnels, setSelectedFunnels] = useState<string[]>([]);
  const [metricPreferences, setMetricPreferences] = useState<MetricPreferences>(readMetricPreferences);
  const [metricPreferencesLoaded, setMetricPreferencesLoaded] = useState(false);
  const [data, setData] = useState<ChallengeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [breakdownHover, setBreakdownHover] = useState<BreakdownHover>(null);

  const isAdmin = user?.role === "super_admin" || user?.role === "agency_user" || user?.role === "client_admin";
  const { startDate, endDate, label } = useMemo(() => getDateRange(dateRange), [dateRange]);
  const orderedMetrics = useMemo(
    () => metricPreferences.order.map((key) => METRIC_BY_KEY[key]).filter(Boolean),
    [metricPreferences.order],
  );
  const visibleMetrics = useMemo(
    () => orderedMetrics.filter((metric) => metricPreferences.visibility[metric.key]),
    [orderedMetrics, metricPreferences.visibility],
  );

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/users/me/preferences`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((prefs: unknown) => {
        if (cancelled) return;
        if (prefs && typeof prefs === "object" && USER_PREF_KEY in prefs) {
          setMetricPreferences(normalizeMetricPreferences((prefs as Record<string, unknown>)[USER_PREF_KEY]));
        }
      })
      .catch(() => {
        // Local storage still preserves the user's layout when the preference API is unavailable.
      })
      .finally(() => {
        if (!cancelled) setMetricPreferencesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    writeMetricPreferences(metricPreferences);
  }, [metricPreferences]);

  useEffect(() => {
    if (!user || !metricPreferencesLoaded) return;
    const timer = window.setTimeout(() => {
      fetch(`${API_BASE}/api/users/me/preferences`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [USER_PREF_KEY]: metricPreferences }),
      }).catch(() => {
        // Browser persistence remains the fallback if the server save fails.
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [metricPreferences, metricPreferencesLoaded, user?.id]);

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
    setMetricPreferences((current) => ({
      ...current,
      visibility: { ...current.visibility, [key]: !current.visibility[key] },
    }));
  }

  function showAllMetrics() {
    setMetricPreferences((current) => ({
      ...current,
      visibility: { ...DEFAULT_VISIBILITY },
    }));
  }

  function resetMetricPreferences() {
    setMetricPreferences(normalizeMetricPreferences(null));
  }

  function reorderMetrics(result: DropResult) {
    if (!result.destination || result.destination.index === result.source.index) return;
    setMetricPreferences((current) => {
      const nextOrder = [...current.order];
      const [moved] = nextOrder.splice(result.source.index, 1);
      if (!moved) return current;
      nextOrder.splice(result.destination!.index, 0, moved);
      return { ...current, order: nextOrder };
    });
  }

  function updateBreakdownHover(next: BreakdownHoverTarget) {
    setBreakdownHover((current) =>
      current?.rowKey === next.rowKey && current?.metricKey === next.metricKey ? current : next,
    );
  }

  function clearBreakdownHoverWhenFocusLeaves(event: FocusEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setBreakdownHover(null);
    }
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
            <MetricSettingsDropdown
              orderedMetrics={orderedMetrics}
              preferences={metricPreferences}
              visibleCount={visibleMetrics.length}
              onToggle={toggleMetric}
              onDragEnd={reorderMetrics}
              onShowAll={showAllMetrics}
              onReset={resetMetricPreferences}
              trigger="toolbar"
            />
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
            <section className="relative grid grid-cols-1 gap-4 overflow-visible sm:grid-cols-2 xl:grid-cols-4">
              {visibleMetrics.map((metric) => (
                <MetricCard key={metric.key} metric={metric} row={data.summary} />
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
              {isAdmin ? (
                <MetricSettingsDropdown
                  orderedMetrics={orderedMetrics}
                  preferences={metricPreferences}
                  visibleCount={visibleMetrics.length}
                  onToggle={toggleMetric}
                  onDragEnd={reorderMetrics}
                  onShowAll={showAllMetrics}
                  onReset={resetMetricPreferences}
                  trigger="visible"
                />
              ) : (
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-muted-foreground">
                  <Eye className="h-3.5 w-3.5" />
                  {visibleMetrics.length} visible
                </div>
              )}
            </div>

            {data.byFunnel.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No funnel activity in this range.</div>
            ) : (
              <LayoutGroup id="challenge-breakdown-hover">
                <div
                  className="max-h-[72vh] overflow-auto overscroll-contain"
                  data-challenge-breakdown-grid
                  onMouseLeave={() => setBreakdownHover(null)}
                  onBlur={clearBreakdownHoverWhenFocusLeaves}
                >
                  <table className="w-full min-w-[980px] border-separate border-spacing-0 text-left">
                    <thead>
                    <tr className="bg-background/50">
                      <th className="sticky left-0 top-0 z-40 min-w-56 border-b border-white/5 bg-background p-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <span className="inline-flex min-h-14 w-full items-center px-3 py-2">
                          Funnel
                        </span>
                      </th>
                      {visibleMetrics.map((metric) => {
                        const isActive = breakdownHover?.metricKey === metric.key;
                        return (
                          <th
                            key={metric.key}
                            className={cn(
                              "sticky top-0 min-w-28 border-b border-white/5 bg-background p-0 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground",
                              isActive ? "z-50" : "z-30",
                            )}
                          >
                            <span
                              className={cn(
                                "relative z-10 inline-flex min-h-14 w-full origin-top-right items-center justify-end overflow-hidden px-3 py-2 text-muted-foreground",
                                PRESENTATION_HOVER_BASE,
                                isActive && `z-30 ${PRESENTATION_ACTIVE_SURFACE} font-semibold`,
                              )}
                              data-challenge-hover={isActive ? "active" : undefined}
                              onMouseEnter={() => updateBreakdownHover({ metricKey: metric.key })}
                            >
                              {isActive && <PresentationHoverOverlay layoutId="challenge-metric-label-hover" />}
                              <span className="relative z-10">{metric.shortLabel}</span>
                            </span>
                          </th>
                        );
                      })}
                    </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                    {data.byFunnel.map((row, rowIndex) => {
                      const rowKey = `${row.funnel ?? "unassigned"}-${rowIndex}`;
                      const isRowActive = breakdownHover?.rowKey === rowKey;
                      return (
                        <tr key={rowKey} className="transition-colors duration-300 hover:bg-white/[0.015]">
                          <td
                            className={cn(
                              "sticky left-0 max-w-64 border-b border-white/5 bg-card p-0 text-sm font-medium text-white",
                              isRowActive ? "z-50" : "z-20",
                            )}
                          >
                            <span
                              className={cn(
                                "relative z-10 flex min-h-16 w-full origin-left items-center overflow-hidden px-3 py-3 text-white",
                                PRESENTATION_HOVER_BASE,
                                isRowActive && `z-30 ${PRESENTATION_ACTIVE_SURFACE} font-semibold`,
                              )}
                              data-challenge-hover={isRowActive ? "active" : undefined}
                              onMouseEnter={() => updateBreakdownHover({ rowKey })}
                            >
                              {isRowActive && <PresentationHoverOverlay layoutId="challenge-funnel-label-hover" />}
                              <span className="relative z-10 line-clamp-2">{row.funnel || "Unassigned"}</span>
                            </span>
                          </td>
                          {visibleMetrics.map((metric) => {
                            const isActive = breakdownHover?.rowKey === rowKey && breakdownHover.metricKey === metric.key;
                            return (
                              <td
                                key={metric.key}
                                className={cn(
                                  "border-b border-white/5 p-0 text-right text-sm text-white",
                                  isActive && "relative z-40",
                                )}
                              >
                                <div
                                  tabIndex={0}
                                  aria-label={`${row.funnel || "Unassigned"} ${metric.label}: ${metric.format(row[metric.key])}`}
                                  className={cn(
                                    "relative z-10 flex min-h-16 w-full origin-center items-center justify-end overflow-hidden whitespace-nowrap px-3 py-3 text-white outline-none focus-visible:ring-2 focus-visible:ring-primary/70",
                                    PRESENTATION_HOVER_BASE,
                                    isActive && `z-40 ${PRESENTATION_ACTIVE_SURFACE} font-semibold`,
                                  )}
                                  data-challenge-hover={isActive ? "active" : undefined}
                                  onMouseEnter={() => updateBreakdownHover({ rowKey, metricKey: metric.key })}
                                  onFocus={() => updateBreakdownHover({ rowKey, metricKey: metric.key })}
                                >
                                  {isActive && <PresentationHoverOverlay layoutId="challenge-metric-value-hover" />}
                                  <span className="relative z-10">{metric.format(row[metric.key])}</span>
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                    </tbody>
                  </table>
                </div>
              </LayoutGroup>
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

function PresentationHoverOverlay({ layoutId }: { layoutId: string }) {
  return (
    <motion.span
      layoutId={layoutId}
      className={PRESENTATION_HOVER_OVERLAY}
      transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.7 }}
      data-challenge-hover-overlay={layoutId}
    />
  );
}

function MetricCard({
  metric,
  row,
}: {
  metric: (typeof METRICS)[number];
  row: ChallengeMetric;
}) {
  const Icon = metric.icon;
  const value = row[metric.key];
  return (
    <div
      className={cn(
        "group relative z-0 origin-center",
        PRESENTATION_CARD_MOTION,
        "hover:z-30 hover:scale-[1.2]",
      )}
      data-challenge-card={metric.key}
    >
      <PremiumCard
        className={cn(
          "flex min-h-36 flex-col justify-between overflow-visible p-5 text-white",
          PRESENTATION_CARD_SYNC,
          "group-hover:border-primary group-hover:bg-primary group-hover:text-secondary group-hover:shadow-[0_28px_80px_rgba(242,5,5,0.38)]",
        )}
        data-challenge-card-surface={metric.key}
      >
        <div className="flex items-start justify-between gap-3">
          <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg border border-white/5 bg-white/[0.04]", PRESENTATION_CARD_SYNC, "group-hover:border-secondary/25 group-hover:bg-secondary/10")}>
            <Icon className={cn("h-5 w-5", PRESENTATION_CARD_SYNC, metric.tone, "group-hover:text-secondary")} />
          </div>
          <span className={cn("rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground", PRESENTATION_CARD_SYNC, "group-hover:border-secondary/25 group-hover:bg-secondary/10 group-hover:text-secondary")}>
            {metric.shortLabel}
          </span>
        </div>
        <div className="mt-5">
          <p className={cn("mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground", PRESENTATION_CARD_SYNC, "group-hover:text-secondary")}>{metric.label}</p>
          <p className={cn("font-display text-3xl text-white", PRESENTATION_CARD_SYNC, "group-hover:text-secondary")}>{metric.format(value)}</p>
          {metric.sub && <p className={cn("mt-1 text-[11px] text-muted-foreground", PRESENTATION_CARD_SYNC, "group-hover:text-secondary/80")}>{metric.sub(row)}</p>}
        </div>
      </PremiumCard>
    </div>
  );
}

function MetricSettingsDropdown({
  orderedMetrics,
  preferences,
  visibleCount,
  onToggle,
  onDragEnd,
  onShowAll,
  onReset,
  trigger,
}: {
  orderedMetrics: Array<typeof METRICS[number]>;
  preferences: MetricPreferences;
  visibleCount: number;
  onToggle: (key: MetricKey) => void;
  onDragEnd: (result: DropResult) => void;
  onShowAll: () => void;
  onReset: () => void;
  trigger: "toolbar" | "visible";
}) {
  const triggerButton = trigger === "toolbar" ? (
    <Button variant="outline" className="bg-card/60 text-white">
      <SlidersHorizontal className="h-4 w-4" />
      Metrics
    </Button>
  ) : (
    <Button
      variant="outline"
      size="sm"
      className="h-8 rounded-full border-white/10 bg-white/[0.03] px-3 text-xs text-muted-foreground hover:bg-white/[0.06] hover:text-white"
    >
      <Eye className="h-3.5 w-3.5" />
      {visibleCount} visible
    </Button>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[21.5rem]">
        <DropdownMenuLabel>Column metrics</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DragDropContext onDragEnd={onDragEnd}>
          <Droppable droppableId="challenge-metric-columns">
            {(provided) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
                className="max-h-[420px] space-y-1 overflow-y-auto px-1 py-1"
              >
                {orderedMetrics.map((metric, index) => {
                  const Icon = metric.icon;
                  const checked = preferences.visibility[metric.key];
                  return (
                    <Draggable key={metric.key} draggableId={metric.key} index={index}>
                      {(dragProvided, snapshot) => {
                        const row = (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            className={cn(
                              "flex items-center gap-2 rounded-md border border-transparent bg-transparent px-2 py-2 text-sm text-white outline-none transition-colors",
                              "hover:border-white/10 hover:bg-white/[0.04]",
                              snapshot.isDragging && "border-primary/40 bg-background shadow-xl",
                            )}
                          >
                            <span
                              {...dragProvided.dragHandleProps}
                              className="flex h-7 w-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-white/[0.04] hover:text-white active:cursor-grabbing"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <GripVertical className="h-4 w-4" />
                            </span>
                            <div
                              role="button"
                              tabIndex={0}
                              aria-pressed={checked}
                              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              onClick={() => onToggle(metric.key)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  onToggle(metric.key);
                                }
                              }}
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => onToggle(metric.key)}
                                onClick={(event) => event.stopPropagation()}
                                className="border-white/20 data-[state=checked]:border-primary"
                              />
                              <Icon className={cn("h-4 w-4 shrink-0", metric.tone)} />
                              <span className="truncate">{metric.label}</span>
                            </div>
                          </div>
                        );

                        if (snapshot.isDragging && typeof document !== "undefined") {
                          return createPortal(row, document.body);
                        }
                        return row;
                      }}
                    </Draggable>
                  );
                })}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onShowAll}>
          <Eye className="h-4 w-4" />
          Show all
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onReset}>
          <RotateCcw className="h-4 w-4" />
          Reset order
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
