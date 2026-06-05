import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
  CheckCircle2,
  ChevronDown,
  DollarSign,
  Eye,
  EyeOff,
  GripVertical,
  Layers3,
  Loader2,
  Megaphone,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  XCircle,
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

type CampaignFunnelOption = {
  id: number;
  name: string;
};

type CampaignMapping = {
  campaignId: number;
  externalId: string;
  name: string;
  status: string | null;
  currency: string | null;
  adAccountId: string | null;
  spend: number;
  conversions: number;
  cpl: number;
  funnelTypeId: number | null;
  funnelName: string | null;
  mappingSource: string | null;
  suggestedFunnelTypeId: number | null;
  suggestedFunnelName: string | null;
};

type CampaignFunnelMappingResponse = {
  dateRange: { startDate: string | null; endDate: string | null };
  funnels: CampaignFunnelOption[];
  campaigns: CampaignMapping[];
  unmappedSpend: number;
  unmappedConversions: number;
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
const DEFAULT_METRIC_PREFERENCES: MetricPreferences = {
  order: METRIC_KEYS,
  visibility: DEFAULT_VISIBILITY,
};

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
  const [refreshToken, setRefreshToken] = useState(0);

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
  }, [startDate, endDate, effectiveTenantId, selectedFunnels.join("\u0000"), refreshToken]);

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
          {isAdmin && (
            <MetaCampaignFunnelMappingPanel
              tenantId={effectiveTenantId}
              startDate={startDate}
              endDate={endDate}
              refreshToken={refreshToken}
              onMappingChanged={() => setRefreshToken((current) => current + 1)}
            />
          )}

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

function MetaCampaignFunnelMappingPanel({
  tenantId,
  startDate,
  endDate,
  refreshToken,
  onMappingChanged,
}: {
  tenantId: number | null;
  startDate: string;
  endDate: string;
  refreshToken: number;
  onMappingChanged: () => void;
}) {
  const [data, setData] = useState<CampaignFunnelMappingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingCampaignId, setSavingCampaignId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [showOnlyUnmapped, setShowOnlyUnmapped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (tenantId == null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      tenantId: String(tenantId),
      startDate,
      endDate,
    });

    fetch(`${API_BASE}/api/campaigns/meta-funnel-mappings?${params.toString()}`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          const payload = await res.json().catch(() => null) as { error?: string } | null;
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
        return res.json() as Promise<CampaignFunnelMappingResponse>;
      })
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || "Could not load Meta campaign mappings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tenantId, startDate, endDate, refreshToken]);

  const filteredCampaigns = useMemo(() => {
    const campaigns = data?.campaigns ?? [];
    const q = search.trim().toLowerCase();
    return campaigns.filter((campaign) => {
      if (showOnlyUnmapped && campaign.funnelTypeId != null) return false;
      if (!q) return true;
      return [
        campaign.name,
        campaign.externalId,
        campaign.funnelName ?? "",
        campaign.suggestedFunnelName ?? "",
      ].some((value) => value.toLowerCase().includes(q));
    });
  }, [data?.campaigns, search, showOnlyUnmapped]);

  const funnelOptions = data?.funnels ?? [];
  const mappedCount = data?.campaigns.filter((campaign) => campaign.funnelTypeId != null).length ?? 0;
  const unmappedCount = (data?.campaigns.length ?? 0) - mappedCount;

  async function saveMapping(campaignId: number, funnelTypeId: number | null) {
    setSavingCampaignId(campaignId);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/campaigns/${campaignId}/funnel-mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ funnelTypeId }),
      });
      const payload = await res.json().catch(() => null) as { error?: string; funnelName?: string | null } | null;
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);

      setData((current) => {
        if (!current) return current;
        const selectedFunnel = funnelTypeId == null
          ? null
          : current.funnels.find((funnel) => funnel.id === funnelTypeId) ?? null;
        return {
          ...current,
          campaigns: current.campaigns.map((campaign) => campaign.campaignId === campaignId
            ? {
                ...campaign,
                funnelTypeId,
                funnelName: payload?.funnelName ?? selectedFunnel?.name ?? null,
                mappingSource: funnelTypeId == null ? null : "manual",
                suggestedFunnelTypeId: null,
                suggestedFunnelName: null,
              }
            : campaign),
        };
      });
      onMappingChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save campaign mapping");
    } finally {
      setSavingCampaignId(null);
    }
  }

  if (tenantId == null) {
    return (
      <PremiumCard className="p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/5 bg-white/[0.04]">
              <Megaphone className="h-5 w-5 text-sky-300" />
            </div>
            <div>
              <h3 className="font-display text-lg text-white">Meta Campaign Funnel Map</h3>
              <p className="text-sm text-muted-foreground">Select one client in the global client picker to assign Meta campaigns to funnels.</p>
            </div>
          </div>
          <Badge variant="outline" className="w-fit border-white/10 text-muted-foreground">Client required</Badge>
        </div>
      </PremiumCard>
    );
  }

  return (
    <PremiumCard className="overflow-hidden p-0">
      <div className="flex flex-col gap-4 border-b border-white/5 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/5 bg-white/[0.04]">
            <Megaphone className="h-5 w-5 text-sky-300" />
          </div>
          <div>
            <h3 className="font-display text-xl text-white">Meta Campaign Funnel Map</h3>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Assign each Meta campaign to one funnel so spend, Meta leads, CPL, ROAS, CAC, and appointment cost land in the correct funnel row.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="border-emerald-400/20 bg-emerald-400/5 text-emerald-200">
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
            {mappedCount} mapped
          </Badge>
          <Badge variant="outline" className={cn(
            "border-white/10 text-muted-foreground",
            unmappedCount > 0 && "border-amber-400/25 bg-amber-400/5 text-amber-200",
          )}>
            <XCircle className="mr-1 h-3.5 w-3.5" />
            {unmappedCount} unmapped
          </Badge>
        </div>
      </div>

      {data && data.unmappedSpend > 0 && (
        <div className="border-b border-amber-400/15 bg-amber-400/[0.06] px-5 py-3 text-sm text-amber-100">
          {formatCurrency(data.unmappedSpend)} in Meta spend and {formatNumber(data.unmappedConversions)} Meta leads are not assigned to a funnel yet.
        </div>
      )}

      <div className="flex flex-col gap-3 border-b border-white/5 p-4 md:flex-row md:items-center md:justify-between">
        <div className="relative w-full md:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search campaigns"
            className="pl-9"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("w-full md:w-auto", showOnlyUnmapped && "border-amber-400/30 bg-amber-400/10 text-amber-100")}
          onClick={() => setShowOnlyUnmapped((current) => !current)}
        >
          {showOnlyUnmapped ? "Showing unmapped" : "Show unmapped"}
        </Button>
      </div>

      {error && (
        <div className="border-b border-red-500/20 bg-red-500/5 px-5 py-3 text-sm text-red-200">{error}</div>
      )}

      {loading && !data ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin" />
          Loading Meta campaigns...
        </div>
      ) : data?.campaigns.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No Meta campaigns were found for this client.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-left">
            <thead>
              <tr className="border-b border-white/5 bg-background/50">
                <th className="p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">Campaign</th>
                <th className="p-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Spend</th>
                <th className="p-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Meta Leads</th>
                <th className="p-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">CPL</th>
                <th className="p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">Funnel</th>
                <th className="p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">Suggestion</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filteredCampaigns.map((campaign) => {
                const saving = savingCampaignId === campaign.campaignId;
                return (
                  <tr key={campaign.campaignId} className="hover:bg-white/[0.02]">
                    <td className="max-w-[28rem] p-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">{campaign.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {campaign.status || "unknown"} · {campaign.externalId}
                        </p>
                      </div>
                    </td>
                    <td className="whitespace-nowrap p-4 text-right text-sm text-white">{formatCurrency(campaign.spend)}</td>
                    <td className="whitespace-nowrap p-4 text-right text-sm text-white">{formatNumber(campaign.conversions)}</td>
                    <td className="whitespace-nowrap p-4 text-right text-sm text-white">{campaign.conversions > 0 ? formatCurrency(campaign.cpl) : "$0"}</td>
                    <td className="w-72 p-4">
                      <Select
                        value={campaign.funnelTypeId == null ? "unmapped" : String(campaign.funnelTypeId)}
                        onValueChange={(value) => saveMapping(campaign.campaignId, value === "unmapped" ? null : Number(value))}
                        disabled={saving}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unmapped">Unmapped</SelectItem>
                          {funnelOptions.map((funnel) => (
                            <SelectItem key={funnel.id} value={String(funnel.id)}>{funnel.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="w-64 p-4">
                      {saving ? (
                        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Saving
                        </span>
                      ) : campaign.suggestedFunnelTypeId ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 border-sky-400/20 bg-sky-400/5 text-sky-100 hover:bg-sky-400/10"
                          onClick={() => saveMapping(campaign.campaignId, campaign.suggestedFunnelTypeId)}
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          Use {campaign.suggestedFunnelName}
                        </Button>
                      ) : campaign.funnelTypeId ? (
                        <span className="inline-flex items-center gap-2 text-xs text-emerald-200">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Mapped
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">No match suggested</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredCampaigns.length === 0 && (
            <div className="border-t border-white/5 p-8 text-center text-sm text-muted-foreground">No campaigns match this view.</div>
          )}
        </div>
      )}
    </PremiumCard>
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
