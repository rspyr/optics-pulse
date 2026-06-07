import { type FocusEvent, type WheelEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { LayoutGroup, motion } from "framer-motion";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  Info,
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
const CHALLENGE_QUERY_CACHE_TTL_MS = 90_000;
const CHALLENGE_PREFETCH_DELAY_MS = 500;
const CHALLENGE_PREFETCH_LIMIT = 4;

type CompareMode = "client_funnels" | "funnel_clients";
type ReportMode = "funnel" | "impact";
type AttributionModel = "strict" | "weighted";
type RunRule = "newest" | "oldest" | "best" | "average";
type DayWindow = "days30" | "days60" | "days70" | "custom";

function formatDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getDefaultImpactStartDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return formatDateInput(date);
}

function getTodayDate(): string {
  return formatDateInput(new Date());
}

function getDayWindow(window: DayWindow, customStart: number, customEnd: number): { startDay: number; endDay: number; label: string } {
  if (window === "days60") return { startDay: 1, endDay: 60, label: "Days 1-60" };
  if (window === "days70") return { startDay: 1, endDay: 70, label: "Days 1-70" };
  if (window === "custom") {
    const startDay = Math.max(1, Math.floor(customStart || 1));
    const endDay = Math.max(startDay, Math.floor(customEnd || startDay));
    return { startDay, endDay, label: `Days ${startDay}-${endDay}` };
  }
  return { startDay: 1, endDay: 30, label: "Days 1-30" };
}

type ChallengeMetric = {
  funnel: string | null;
  rowKey?: string;
  rowLabel?: string;
  tenantId?: number;
  tenantName?: string;
  funnelTypeId?: number;
  funnelName?: string;
  runId?: number | null;
  runName?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  runCount?: number;
  selectedRunIds?: number[];
  activeDays: number;
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

type ChallengeRunSummary = {
  id: number;
  tenantId: number;
  tenantName: string;
  funnelTypeId: number;
  funnelName: string;
  name: string;
  startDate: string;
  endDate: string | null;
  status: string;
  activeDays: number;
};

type ChallengeResponse = {
  viewMode?: ReportMode;
  attributionModel?: AttributionModel;
  compareMode: CompareMode;
  dateRange?: { startDate: string; endDate: string };
  dayRange: { startDay: number; endDay: number; label: string };
  runRule: RunRule;
  bestBy: MetricKey;
  selectedTenantIds: number[];
  selectedFunnelTypeIds: number[];
  availableClients: Array<{ id: number; name: string; runCount: number }>;
  availableFunnels: Array<{ id: number; name: string; runCount: number }>;
  selectedRuns: ChallengeRunSummary[];
  impactTimeline?: ChallengeRunSummary[];
  summary: ChallengeMetric;
  byFunnel: ChallengeMetric[];
  rows: ChallengeMetric[];
  allocation: {
    method:
      | "meta_campaign_funnel_mapping"
      | "meta_campaign_adset_funnel_mapping"
      | "weighted_recency_funnel_attribution"
      | "meta_impact_outcome_window";
    note: string;
  };
};

type MetricKey =
  | "activeDays"
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
  explainer?: string;
}> = [
  {
    key: "activeDays",
    label: "Active Days",
    shortLabel: "Active Days",
    icon: CalendarCheck,
    tone: "text-sky-300",
    format: formatNumber,
    sub: (m) => m.runCount && m.runCount > 1 ? `${formatNumber(m.runCount)} runs represented` : "days with lead or spend activity",
  },
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
    explainer: "Cancelled downstream jobs divided by all downstream jobs from leads received in the selected run window. Jobs must originate within 90 days of the lead, with 1 day of timing grace.",
  },
  {
    key: "totalEstimateValue",
    label: "Total Estimate Value",
    shortLabel: "Est. Value",
    icon: DollarSign,
    tone: "text-amber-300",
    format: formatCurrency,
    explainer: "Potential pipeline from estimates tied to the selected lead cohort. Estimate/job origin must fall within 90 days of the lead; multiple options for one lead are averaged before summing.",
  },
  {
    key: "totalSoldClosedValue",
    label: "Total Sold/Closed Value",
    shortLabel: "Sold Value",
    icon: DollarSign,
    tone: "text-emerald-300",
    format: formatCurrency,
    explainer: "Sold estimate value from the selected lead cohort. The sale can close later, but the estimate or job must originate inside the downstream attribution window.",
  },
  {
    key: "roasPotential",
    label: "ROAS Potential",
    shortLabel: "ROAS Pot.",
    icon: TrendingUp,
    tone: "text-amber-300",
    format: formatMultiplier,
    explainer: "Estimate value divided by ad spend for the selected run window. Estimate value uses the downstream lead-cohort attribution rule.",
  },
  {
    key: "roasSold",
    label: "ROAS Sold",
    shortLabel: "ROAS Sold",
    icon: TrendingUp,
    tone: "text-emerald-300",
    format: formatMultiplier,
    explainer: "Sold value divided by ad spend for the selected run window. Sold value is credited only when the originating estimate/job belongs to the selected lead cohort.",
  },
  { key: "totalSpend", label: "Total Spend", shortLabel: "Spend", icon: DollarSign, tone: "text-sky-300", format: formatCurrency },
  {
    key: "averageCostPerInHomeAppointment",
    label: "Avg Cost Per In-Home Appointment",
    shortLabel: "Cost/In-Home",
    icon: CalendarCheck,
    tone: "text-violet-300",
    format: formatCurrency,
    sub: (m) => `${formatNumber(m.completedEstimateJobs)} completed estimate jobs`,
    explainer: "Ad spend divided by completed downstream jobs that have an estimate. Jobs must originate within the selected lead cohort's attribution window.",
  },
  {
    key: "costToAcquireCustomer",
    label: "Cost To Acquire Customer",
    shortLabel: "CAC",
    icon: Target,
    tone: "text-rose-300",
    format: formatCurrency,
    sub: (m) => `${formatNumber(m.soldJobs)} sold jobs`,
    explainer: "Ad spend divided by sold downstream estimates/jobs from the selected lead cohort. Repeat-customer sales outside the attribution window are excluded.",
  },
  {
    key: "averageClosedJobValue",
    label: "Average Closed Job Value",
    shortLabel: "Avg Closed",
    icon: DollarSign,
    tone: "text-emerald-300",
    format: formatCurrency,
    explainer: "Sold value divided by sold downstream jobs/estimates credited to the selected lead cohort.",
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
const PRESENTATION_ACTIVE_SURFACE = "text-[#C0D4E6]";
const PRESENTATION_HOVER_OVERLAY =
  "pointer-events-none absolute inset-0 z-0 rounded-lg border border-primary bg-primary shadow-[0_22px_60px_rgba(242,5,5,0.38)]";
const PRESENTATION_CARD_MOTION =
  "transform-gpu transition-[scale,transform,filter] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] will-change-[scale,transform]";
const PRESENTATION_CARD_SYNC =
  "transition-[background-color,border-color,box-shadow,color] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]";
const DEFAULT_METRIC_PREFERENCES: MetricPreferences = {
  order: METRIC_KEYS,
  visibility: DEFAULT_VISIBILITY,
};

type ChallengeQueryOptions = {
  reportMode: ReportMode;
  attributionModel: AttributionModel;
  compareMode: CompareMode;
  dayRange: { startDay: number; endDay: number };
  impactDateRange: { startDate: string; endDate: string };
  runRule: RunRule;
  bestBy: MetricKey;
  effectiveTenantId: number | null | undefined;
  selectedFunnelTypeIds: number[];
  selectedClientTenantIds: number[];
};

type ChallengeQueryDescriptor = {
  cacheKey: string;
  url: string;
};

const challengeResponseCache = new Map<string, { data: ChallengeResponse; fetchedAt: number }>();
const challengeResponseInflight = new Map<string, Promise<ChallengeResponse>>();

function sortedIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))].sort((a, b) => a - b);
}

function idsKey(ids: number[]): string {
  return sortedIds(ids).join(",");
}

function sameIds(a: number[], b: number[]): boolean {
  return idsKey(a) === idsKey(b);
}

function buildChallengeQueryDescriptor(options: ChallengeQueryOptions): ChallengeQueryDescriptor {
  const params = new URLSearchParams({
    viewMode: options.reportMode,
    attributionModel: options.attributionModel,
    mode: options.compareMode,
    dayStart: String(options.dayRange.startDay),
    dayEnd: String(options.dayRange.endDay),
    runRule: options.runRule,
    bestBy: options.bestBy,
  });
  if (options.reportMode === "impact") {
    params.set("startDate", options.impactDateRange.startDate);
    params.set("endDate", options.impactDateRange.endDate);
  }
  if (options.compareMode === "client_funnels" && options.effectiveTenantId != null) {
    params.set("tenantId", String(options.effectiveTenantId));
  }
  sortedIds(options.selectedFunnelTypeIds).forEach((id) => params.append("funnelTypeId", String(id)));
  sortedIds(options.selectedClientTenantIds).forEach((id) => params.append("clientTenantId", String(id)));

  const cacheKey = params.toString();
  return {
    cacheKey,
    url: `${API_BASE}/api/dashboard/challenge/runs?${cacheKey}`,
  };
}

function getCachedChallengeResponse(cacheKey: string): ChallengeResponse | null {
  const cached = challengeResponseCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > CHALLENGE_QUERY_CACHE_TTL_MS) {
    challengeResponseCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

function storeChallengeResponse(cacheKey: string, data: ChallengeResponse) {
  challengeResponseCache.set(cacheKey, { data, fetchedAt: Date.now() });
  if (challengeResponseCache.size > 40) {
    const oldestKey = [...challengeResponseCache.entries()]
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0]?.[0];
    if (oldestKey) challengeResponseCache.delete(oldestKey);
  }
}

function fetchChallengeResponse(descriptor: ChallengeQueryDescriptor): Promise<ChallengeResponse> {
  const cached = getCachedChallengeResponse(descriptor.cacheKey);
  if (cached) return Promise.resolve(cached);

  const existing = challengeResponseInflight.get(descriptor.cacheKey);
  if (existing) return existing;

  const request = fetch(descriptor.url, { credentials: "include" })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ChallengeResponse>;
    })
    .then((next) => {
      storeChallengeResponse(descriptor.cacheKey, next);
      return next;
    })
    .finally(() => {
      challengeResponseInflight.delete(descriptor.cacheKey);
    });

  challengeResponseInflight.set(descriptor.cacheKey, request);
  return request;
}

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
  const [reportMode, setReportMode] = useState<ReportMode>("funnel");
  const [attributionModel, setAttributionModel] = useState<AttributionModel>("strict");
  const [compareMode, setCompareMode] = useState<CompareMode>("client_funnels");
  const [dayWindow, setDayWindow] = useState<DayWindow>("days30");
  const [customStartDay, setCustomStartDay] = useState(1);
  const [customEndDay, setCustomEndDay] = useState(30);
  const [impactStartDate, setImpactStartDate] = useState(getDefaultImpactStartDate);
  const [impactEndDate, setImpactEndDate] = useState(getTodayDate);
  const [runRule, setRunRule] = useState<RunRule>("newest");
  const [bestBy, setBestBy] = useState<MetricKey>("roasSold");
  const [selectedFunnelTypeIds, setSelectedFunnelTypeIds] = useState<number[]>([]);
  const [selectedClientTenantIds, setSelectedClientTenantIds] = useState<number[]>([]);
  const [metricPreferences, setMetricPreferences] = useState<MetricPreferences>(readMetricPreferences);
  const [metricPreferencesLoaded, setMetricPreferencesLoaded] = useState(false);
  const [data, setData] = useState<ChallengeResponse | null>(null);
  const [dataCacheKey, setDataCacheKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [breakdownHover, setBreakdownHover] = useState<BreakdownHover>(null);

  const isAdmin = user?.role === "super_admin" || user?.role === "agency_user" || user?.role === "client_admin";
  const dayRange = useMemo(() => getDayWindow(dayWindow, customStartDay, customEndDay), [dayWindow, customStartDay, customEndDay]);
  const challengeQuery = useMemo(
    () => buildChallengeQueryDescriptor({
      reportMode,
      attributionModel,
      compareMode,
      dayRange,
      impactDateRange: { startDate: impactStartDate, endDate: impactEndDate },
      runRule,
      bestBy,
      effectiveTenantId,
      selectedFunnelTypeIds,
      selectedClientTenantIds,
    }),
    [
      reportMode,
      attributionModel,
      compareMode,
      dayRange.startDay,
      dayRange.endDay,
      impactStartDate,
      impactEndDate,
      runRule,
      bestBy,
      effectiveTenantId,
      idsKey(selectedFunnelTypeIds),
      idsKey(selectedClientTenantIds),
    ],
  );
  const orderedMetrics = useMemo(
    () => metricPreferences.order.map((key) => METRIC_BY_KEY[key]).filter(Boolean),
    [metricPreferences.order],
  );
  const visibleMetrics = useMemo(
    () => orderedMetrics.filter((metric) => metricPreferences.visibility[metric.key]),
    [orderedMetrics, metricPreferences.visibility],
  );
  const dataIsCurrent = Boolean(data && dataCacheKey === challengeQuery.cacheKey);
  const displayData = dataIsCurrent ? data : null;

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
    setError(null);

    const cached = getCachedChallengeResponse(challengeQuery.cacheKey);
    if (cached) {
      setData(cached);
      setDataCacheKey(challengeQuery.cacheKey);
      setLoading(false);
    } else {
      setLoading(true);
    }

    fetchChallengeResponse(challengeQuery)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setDataCacheKey(challengeQuery.cacheKey);
        const availableFunnelIds = new Set(next.availableFunnels.map((funnel) => funnel.id));
        const availableTenantIds = new Set(next.availableClients.map((client) => client.id));
        setSelectedFunnelTypeIds((current) => {
          const filtered = current.filter((id) => availableFunnelIds.has(id));
          if (compareMode === "funnel_clients" && filtered.length === 0 && next.availableFunnels[0]) {
            return [next.availableFunnels[0].id];
          }
          return filtered;
        });
        setSelectedClientTenantIds((current) => current.filter((id) => availableTenantIds.has(id)));
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
  }, [
    challengeQuery.cacheKey,
    challengeQuery.url,
    compareMode,
  ]);

  useEffect(() => {
    if (!displayData) return;
    if (reportMode === "impact") return;

    const timer = window.setTimeout(() => {
      const descriptors = new Map<string, ChallengeQueryDescriptor>();
      const baseOptions: ChallengeQueryOptions = {
        reportMode,
        attributionModel,
        compareMode,
        dayRange,
        impactDateRange: { startDate: impactStartDate, endDate: impactEndDate },
        runRule,
        bestBy,
        effectiveTenantId,
        selectedFunnelTypeIds,
        selectedClientTenantIds,
      };
      const enqueue = (options: ChallengeQueryOptions) => {
        if (descriptors.size >= CHALLENGE_PREFETCH_LIMIT) return;
        const descriptor = buildChallengeQueryDescriptor(options);
        if (descriptor.cacheKey === challengeQuery.cacheKey) return;
        if (getCachedChallengeResponse(descriptor.cacheKey)) return;
        descriptors.set(descriptor.cacheKey, descriptor);
      };

      (["newest", "oldest", "average"] as RunRule[]).forEach((nextRunRule) => {
        enqueue({ ...baseOptions, runRule: nextRunRule });
      });

      [
        { startDay: 1, endDay: 30 },
        { startDay: 1, endDay: 60 },
        { startDay: 1, endDay: 70 },
      ].forEach((nextDayRange) => {
        enqueue({ ...baseOptions, dayRange: nextDayRange });
      });

      if (compareMode === "client_funnels") {
        const firstFunnelId = selectedFunnelTypeIds[0] ?? displayData.availableFunnels[0]?.id;
        if (firstFunnelId) {
          enqueue({
            ...baseOptions,
            compareMode: "funnel_clients",
            selectedFunnelTypeIds: [firstFunnelId],
            selectedClientTenantIds: [],
            effectiveTenantId: null,
          });
        }
      }

      descriptors.forEach((descriptor) => {
        void fetchChallengeResponse(descriptor).catch(() => {
          // Prefetch is opportunistic; the active view still owns error display.
        });
      });
    }, CHALLENGE_PREFETCH_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    displayData,
    reportMode,
    attributionModel,
    challengeQuery.cacheKey,
    compareMode,
    dayRange.startDay,
    dayRange.endDay,
    impactStartDate,
    impactEndDate,
    runRule,
    bestBy,
    effectiveTenantId,
    idsKey(selectedFunnelTypeIds),
    idsKey(selectedClientTenantIds),
  ]);

  const availableFunnels = (displayData ?? data)?.availableFunnels ?? [];
  const availableClients = (displayData ?? data)?.availableClients ?? [];
  const selectedFunnelNames = selectedFunnelTypeIds
    .map((id) => availableFunnels.find((funnel) => funnel.id === id)?.name)
    .filter((name): name is string => !!name);
  const selectedClientNames = selectedClientTenantIds
    .map((id) => availableClients.find((client) => client.id === id)?.name)
    .filter((name): name is string => !!name);
  const funnelButtonLabel = selectedFunnelTypeIds.length === 0
    ? "All funnels"
    : selectedFunnelTypeIds.length === 1
      ? selectedFunnelNames[0] || "1 funnel"
      : `${selectedFunnelTypeIds.length} funnels`;
  const clientButtonLabel = selectedClientTenantIds.length === 0
    ? "All clients"
    : selectedClientTenantIds.length === 1
      ? selectedClientNames[0] || "1 client"
      : `${selectedClientTenantIds.length} clients`;
  const runRuleLabel = runRule === "oldest"
    ? "Oldest run"
    : runRule === "best"
      ? `Best by ${METRIC_BY_KEY[bestBy].shortLabel}`
      : runRule === "average"
        ? "Avg all runs"
        : "Newest run";
  const visibleRows = displayData?.rows ?? displayData?.byFunnel ?? [];
  const primaryColumnLabel = reportMode === "impact" ? "View" : compareMode === "funnel_clients" ? "Client" : "Funnel";
  const impactTimeline = displayData?.impactTimeline ?? displayData?.selectedRuns ?? [];
  const metricContext = { viewMode: reportMode, attributionModel };

  function toggleFunnelType(id: number) {
    setSelectedFunnelTypeIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : compareMode === "funnel_clients"
          ? [id]
          : [...current, id],
    );
  }

  function toggleClientTenant(id: number) {
    setSelectedClientTenantIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
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

  function handOffBreakdownScroll(event: WheelEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const atTop = el.scrollTop <= 0;
    const atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight;
    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
      event.preventDefault();
      window.scrollBy({ top: event.deltaY, left: 0, behavior: "auto" });
    }
  }

  return (
    <TooltipProvider delayDuration={120}>
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <GradientHeading className="mb-2 text-3xl md:text-4xl">The Challenge</GradientHeading>
          <p className="font-sub text-sm tracking-wide text-muted-foreground">
            {reportMode === "impact"
              ? `META IMPACT SINCE ${impactStartDate}`
              : `ADS PERFORMANCE BY FUNNEL DAY COHORT - ${dayRange.label.toUpperCase()}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-white/10 bg-card/60 p-1">
            {([
              ["funnel", "Funnel Mode"],
              ["impact", "Meta Impact"],
            ] as Array<[ReportMode, string]>).map(([mode, text]) => (
              <button
                key={mode}
                onClick={() => {
                  setReportMode(mode);
                  setBreakdownHover(null);
                  if (mode === "impact") {
                    setSelectedFunnelTypeIds([]);
                  }
                }}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-all",
                  reportMode === mode ? "bg-primary text-[#C0D4E6]" : "text-muted-foreground hover:text-white",
                )}
              >
                {text}
              </button>
            ))}
          </div>

          {reportMode === "funnel" ? (
          <>
          <div className="inline-flex rounded-lg border border-white/10 bg-card/60 p-1">
            {([
              ["client_funnels", "Client Funnels"],
              ["funnel_clients", "Funnel Across Clients"],
            ] as Array<[CompareMode, string]>).map(([mode, text]) => (
              <button
                key={mode}
                onClick={() => {
                  setCompareMode(mode);
                  setBreakdownHover(null);
                  if (mode === "client_funnels") {
                    setSelectedClientTenantIds([]);
                  } else {
                    setSelectedFunnelTypeIds((current) => {
                      if (current.length > 0) return [current[0]];
                      const firstAvailable = availableFunnels[0]?.id;
                      return firstAvailable ? [firstAvailable] : current;
                    });
                  }
                }}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-all",
                  compareMode === mode ? "bg-primary text-[#C0D4E6]" : "text-muted-foreground hover:text-white",
                )}
              >
                {text}
              </button>
            ))}
          </div>

          <div className="inline-flex rounded-lg border border-white/10 bg-card/60 p-1">
            {([
              ["strict", "Strict"],
              ["weighted", "Weighted"],
            ] as Array<[AttributionModel, string]>).map(([model, text]) => (
              <button
                key={model}
                onClick={() => {
                  setAttributionModel(model);
                  setBreakdownHover(null);
                }}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-all",
                  attributionModel === model ? "bg-primary text-[#C0D4E6]" : "text-muted-foreground hover:text-white",
                )}
              >
                {text}
              </button>
            ))}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="min-w-56 justify-between bg-card/60 text-white">
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Layers3 className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{funnelButtonLabel} · {runRuleLabel}</span>
                </span>
                <ChevronDown className="h-4 w-4 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel>Run selection</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={runRule} onValueChange={(value) => setRunRule(value as RunRule)}>
                <DropdownMenuRadioItem value="newest" onSelect={(event) => event.preventDefault()}>
                  Newest run
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="oldest" onSelect={(event) => event.preventDefault()}>
                  Oldest run
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="average" onSelect={(event) => event.preventDefault()}>
                  Avg all runs
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="best" onSelect={(event) => event.preventDefault()}>
                  Best run
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              {runRule === "best" && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="text-sm">
                    Best by <span className="ml-1 text-muted-foreground">{METRIC_BY_KEY[bestBy].shortLabel}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
                    <DropdownMenuRadioGroup value={bestBy} onValueChange={(value) => setBestBy(value as MetricKey)}>
                      {METRICS.map((metric) => (
                        <DropdownMenuRadioItem
                          key={metric.key}
                          value={metric.key}
                          onSelect={(event) => event.preventDefault()}
                        >
                          {metric.shortLabel}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{compareMode === "funnel_clients" ? "Compare this funnel" : "Funnels"}</DropdownMenuLabel>
              {compareMode === "client_funnels" && (
                <DropdownMenuItem onSelect={() => setSelectedFunnelTypeIds([])}>
                  All funnels
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {availableFunnels.length ? availableFunnels.map((funnel) => (
                <DropdownMenuCheckboxItem
                  key={funnel.id}
                  checked={selectedFunnelTypeIds.includes(funnel.id)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => toggleFunnelType(funnel.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{funnel.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{funnel.runCount}</span>
                </DropdownMenuCheckboxItem>
              )) : (
                <div className="px-2 py-3 text-sm text-muted-foreground">No funnel runs yet.</div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {compareMode === "funnel_clients" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="min-w-44 justify-between bg-card/60 text-white">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{clientButtonLabel}</span>
                  </span>
                  <ChevronDown className="h-4 w-4 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>Clients</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setSelectedClientTenantIds([])}>
                  All clients
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {availableClients.length ? availableClients.map((client) => (
                  <DropdownMenuCheckboxItem
                    key={client.id}
                    checked={selectedClientTenantIds.includes(client.id)}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={() => toggleClientTenant(client.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{client.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{client.runCount}</span>
                  </DropdownMenuCheckboxItem>
                )) : (
                  <div className="px-2 py-3 text-sm text-muted-foreground">No clients have runs yet.</div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Select value={dayWindow} onValueChange={(value) => setDayWindow(value as DayWindow)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="days30">Days 1-30</SelectItem>
              <SelectItem value="days60">Days 1-60</SelectItem>
              <SelectItem value="days70">Days 1-70</SelectItem>
              <SelectItem value="custom">Custom days</SelectItem>
            </SelectContent>
          </Select>

          {dayWindow === "custom" && (
            <div className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-card/60 px-2 py-1.5">
              <input
                type="number"
                min={1}
                value={customStartDay}
                onChange={event => setCustomStartDay(Number(event.target.value))}
                className="w-16 rounded-md border border-white/10 bg-background px-2 py-1 text-sm text-white"
                aria-label="Start day"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <input
                type="number"
                min={1}
                value={customEndDay}
                onChange={event => setCustomEndDay(Number(event.target.value))}
                className="w-16 rounded-md border border-white/10 bg-background px-2 py-1 text-sm text-white"
                aria-label="End day"
              />
            </div>
          )}
          </>
          ) : (
            <div className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-card/60 px-2 py-1.5">
              <span className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">Impact window</span>
              <input
                type="date"
                value={impactStartDate}
                max={impactEndDate}
                onChange={event => setImpactStartDate(event.target.value)}
                className="h-9 rounded-md border border-white/10 bg-background px-2 text-sm text-white"
                aria-label="Impact start date"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <input
                type="date"
                value={impactEndDate}
                min={impactStartDate}
                onChange={event => setImpactEndDate(event.target.value)}
                className="h-9 rounded-md border border-white/10 bg-background px-2 text-sm text-white"
                aria-label="Impact end date"
              />
            </div>
          )}

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

      {loading && !displayData ? (
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
      ) : displayData ? (
        <>
          {visibleMetrics.length === 0 ? (
            <PremiumCard className="p-8 text-center">
              <EyeOff className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">All metrics are hidden.</p>
            </PremiumCard>
          ) : (
            <section className="relative grid grid-cols-1 gap-4 overflow-visible sm:grid-cols-2 xl:grid-cols-4">
              {visibleMetrics.map((metric) => (
                <MetricCard key={metric.key} metric={metric} row={displayData.summary} context={metricContext} />
              ))}
            </section>
          )}

          {reportMode === "impact" && (
            <ImpactTimeline
              runs={impactTimeline}
              selectedStartDate={impactStartDate}
              onSelectStartDate={setImpactStartDate}
            />
          )}

          <PremiumCard className="overflow-hidden p-0">
            <div className="flex flex-col gap-2 border-b border-white/5 p-5 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="font-display text-xl text-white">Comparison Breakdown</h3>
                <p className="text-sm text-muted-foreground">
                  {compareMode === "funnel_clients"
                    ? reportMode === "impact"
                      ? `Rolling up Meta-tied outcomes from ${impactStartDate} through ${impactEndDate}.`
                      : `Comparing clients on the same funnel days for ${selectedFunnelNames[0] || "the selected funnel"}.`
                    : reportMode === "impact"
                      ? `Rolling up Meta-tied outcomes from ${impactStartDate} through ${impactEndDate}.`
                      : `Comparing funnel runs for the selected client scope using ${runRule === "average" ? "average run performance" : `${runRule} run performance`}.`}
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

            {visibleRows.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No funnel-run activity in this run-day window.</div>
            ) : (
              <LayoutGroup id="challenge-breakdown-hover">
                <div
                  className="max-h-[72vh] overflow-auto"
                  data-challenge-breakdown-grid
                  onMouseLeave={() => setBreakdownHover(null)}
                  onBlur={clearBreakdownHoverWhenFocusLeaves}
                  onWheel={handOffBreakdownScroll}
                >
                  <table className="w-full min-w-[980px] border-separate border-spacing-0 text-left">
                    <thead>
                    <tr className="bg-background/50">
                      <th className="sticky left-0 top-0 z-40 min-w-56 border-b border-white/5 bg-background p-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <span className="inline-flex min-h-14 w-full items-center px-3 py-2">
                          {primaryColumnLabel}
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
                                "relative z-10 isolate inline-flex min-h-14 w-full origin-top-right items-center justify-end overflow-visible px-3 py-2 text-muted-foreground",
                                PRESENTATION_HOVER_BASE,
                                isActive && `z-30 ${PRESENTATION_ACTIVE_SURFACE} font-semibold`,
                              )}
                              data-challenge-hover={isActive ? "active" : undefined}
                              onMouseEnter={() => updateBreakdownHover({ metricKey: metric.key })}
                            >
                              {isActive && <PresentationHoverOverlay layoutId="challenge-metric-label-hover" />}
                              <MetricExplainerLabel metric={metric} context={metricContext} />
                            </span>
                          </th>
                        );
                      })}
                    </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                    {visibleRows.map((row, rowIndex) => {
                      const rowKey = row.rowKey ?? `${row.funnel ?? "unassigned"}-${rowIndex}`;
                      const isRowActive = breakdownHover?.rowKey === rowKey;
                      const rowLabel = row.rowLabel || row.funnel || "Unassigned";
                      const runDetail = row.runName
                        ? `${row.runName}${row.runCount && row.runCount > 1 && runRule !== "average" ? ` of ${row.runCount}` : ""}`
                        : row.runCount && row.runCount > 1
                          ? `${row.runCount} runs`
                          : null;
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
                                "relative z-10 isolate flex min-h-16 w-full origin-left items-center overflow-visible px-3 py-3 text-white",
                                PRESENTATION_HOVER_BASE,
                                isRowActive && `z-30 ${PRESENTATION_ACTIVE_SURFACE} font-semibold`,
                              )}
                              data-challenge-hover={isRowActive ? "active" : undefined}
                              onMouseEnter={() => updateBreakdownHover({ rowKey })}
                            >
                              {isRowActive && <PresentationHoverOverlay layoutId="challenge-funnel-label-hover" />}
                              <span className="relative z-10 min-w-0">
                                <span className="block line-clamp-2">{rowLabel}</span>
                                {runDetail && <span className="mt-0.5 block truncate text-[10px] font-medium opacity-70">{runDetail}</span>}
                              </span>
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
                                  aria-label={`${rowLabel} ${metric.label}: ${metric.format(row[metric.key])}`}
                                  className={cn(
                                    "relative z-10 isolate flex min-h-16 w-full origin-center items-center justify-end overflow-visible whitespace-nowrap px-3 py-3 text-white outline-none focus-visible:ring-2 focus-visible:ring-primary/70",
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
            {displayData.allocation.note}
          </p>
        </>
      ) : null}
    </div>
    </TooltipProvider>
  );
}

function PresentationHoverOverlay({ layoutId }: { layoutId: string }) {
  return (
    <motion.span
      layoutId={layoutId}
      layout="position"
      className={PRESENTATION_HOVER_OVERLAY}
      transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.7 }}
      data-challenge-hover-overlay={layoutId}
    />
  );
}

type MetricExplainerContext = {
  viewMode: ReportMode;
  attributionModel: AttributionModel;
};

function getMetricExplainer(metric: (typeof METRICS)[number], context: MetricExplainerContext): string | undefined {
  if (context.viewMode === "impact") {
    const explainers: Partial<Record<MetricKey, string>> = {
      metaLeads: "Meta-sourced lead submissions received inside the selected impact window. Downstream outcomes may come from older Meta journeys.",
      uniquePulseLeads: "Unique Meta-sourced people received inside the selected impact window. Outcomes are not limited to only these new leads.",
      appointmentsBooked: "Meta leads in the selected impact window that show booked intent in Pulse. Long-tail jobs are counted separately by outcome date.",
      bookingRate: "Booked Meta leads divided by unique Meta leads received inside the selected impact window. Use downstream jobs for long-tail channel impact.",
      cancellationRate: "Canceled Meta-tied jobs with a cancellation date inside the impact window divided by Meta-tied jobs with booking, completion, or cancellation activity inside the same window.",
      totalEstimateValue: "Estimate value created inside the impact window when the customer has any prior Meta lead touch in the downstream attribution model.",
      totalSoldClosedValue: "Sold value closed inside the impact window when the customer has any prior Meta lead touch, even if the original Meta lead happened before the selected start date.",
      roasPotential: "Impact-window estimate value divided by Meta ad spend in the same date range.",
      roasSold: "Impact-window sold value divided by Meta ad spend in the same date range.",
      averageCostPerInHomeAppointment: "Meta spend divided by completed Meta-tied jobs with estimates inside the selected impact window.",
      costToAcquireCustomer: "Meta spend divided by sold Meta-tied jobs closed inside the selected impact window.",
      averageClosedJobValue: "Sold value closed inside the selected impact window divided by sold Meta-tied jobs in that same window.",
    };
    return explainers[metric.key] ?? metric.explainer;
  }

  if (context.attributionModel === "weighted") {
    const explainers: Partial<Record<MetricKey, string>> = {
      cancellationRate: "Canceled downstream job credit divided by downstream job credit. Credit is split across prior funnel entries for the same customer using recency weighting.",
      totalEstimateValue: "Estimate value split across prior funnel entries for the same customer using recency weighting, then summed without double-counting total pipeline.",
      totalSoldClosedValue: "Sold value split across prior funnel entries for the same customer using recency weighting. Newer funnel touches receive more credit.",
      roasPotential: "Weighted estimate value divided by ad spend for the selected run window.",
      roasSold: "Weighted sold value divided by ad spend for the selected run window.",
      averageCostPerInHomeAppointment: "Ad spend divided by weighted completed downstream jobs that have estimates.",
      costToAcquireCustomer: "Ad spend divided by weighted sold downstream jobs.",
      averageClosedJobValue: "Weighted sold value divided by weighted sold downstream jobs.",
    };
    return explainers[metric.key] ?? metric.explainer;
  }

  return metric.explainer;
}

function MetricExplainerLabel({
  metric,
  context,
}: {
  metric: (typeof METRICS)[number];
  context: MetricExplainerContext;
}) {
  const explainer = getMetricExplainer(metric, context);
  const label = (
    <span
      className={cn(
        "relative z-10 inline-flex items-center justify-end gap-1.5",
        explainer && "cursor-help",
      )}
      tabIndex={explainer ? 0 : undefined}
    >
      <span>{metric.shortLabel}</span>
      {explainer && <Info className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />}
    </span>
  );

  if (!explainer) return label;

  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-80 bg-card px-3 py-2 text-left text-xs leading-relaxed text-white shadow-xl">
        {explainer}
      </TooltipContent>
    </Tooltip>
  );
}

function MetricExplainerBadge({
  metric,
  context,
}: {
  metric: (typeof METRICS)[number];
  context: MetricExplainerContext;
}) {
  const explainer = getMetricExplainer(metric, context);
  const badge = (
    <span
      className={cn(
        "rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground",
        PRESENTATION_CARD_SYNC,
        "group-hover:border-secondary/25 group-hover:bg-secondary/10 group-hover:text-[#C0D4E6]",
        explainer && "inline-flex cursor-help items-center gap-1.5",
      )}
      tabIndex={explainer ? 0 : undefined}
    >
      {metric.shortLabel}
      {explainer && <Info className="h-3 w-3 opacity-70" aria-hidden="true" />}
    </span>
  );

  if (!explainer) return badge;

  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-80 bg-card px-3 py-2 text-left text-xs leading-relaxed text-white shadow-xl">
        {explainer}
      </TooltipContent>
    </Tooltip>
  );
}

function ImpactTimeline({
  runs,
  selectedStartDate,
  onSelectStartDate,
}: {
  runs: ChallengeRunSummary[];
  selectedStartDate: string;
  onSelectStartDate: (date: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, ChallengeRunSummary[]>();
    const sortedRuns = [...runs]
      .filter((run) => Boolean(run.startDate))
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.funnelName.localeCompare(b.funnelName));

    for (const run of sortedRuns) {
      if (!run.startDate) continue;
      const date = new Date(`${run.startDate}T00:00:00Z`);
      const key = date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
      const existing = groups.get(key) ?? [];
      existing.push(run);
      groups.set(key, existing);
    }
    return [...groups.entries()].map(([month, monthRuns]) => [
      month,
      [...monthRuns].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.funnelName.localeCompare(b.funnelName)),
    ] as const);
  }, [runs]);

  if (grouped.length === 0) return null;

  return (
    <section className="rounded-lg border border-white/10 bg-card/50 p-4">
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-display text-lg text-white">Campaign Start Timeline</h2>
          <p className="text-xs text-muted-foreground">Pick a campaign start as the impact-window floor.</p>
        </div>
        <div className="text-xs text-muted-foreground">Selected {selectedStartDate}</div>
      </div>
      <div className="flex flex-nowrap gap-3 overflow-x-auto overscroll-x-contain pb-2">
        {grouped.map(([month, monthRuns]) => (
          <div key={month} className="w-72 flex-none rounded-md border border-white/10 bg-background/40 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{month}</div>
            <div className="max-h-[17rem] space-y-2 overflow-y-auto overscroll-y-contain pr-1">
              {monthRuns.map((run) => {
                const isSelected = run.startDate === selectedStartDate;
                return (
                  <button
                    key={run.id}
                    onClick={() => onSelectStartDate(run.startDate)}
                    className={cn(
                      "block min-h-[4.75rem] w-full rounded-md border px-2 py-2 text-left transition-colors",
                      isSelected
                        ? "border-primary bg-primary text-[#C0D4E6]"
                        : "border-white/10 bg-white/[0.03] text-white hover:border-primary/50 hover:bg-white/[0.06]",
                    )}
                  >
                    <span className="block truncate text-xs font-semibold">{run.funnelName}</span>
                    <span className="mt-0.5 block truncate text-[11px] opacity-70">{run.startDate}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MetricCard({
  metric,
  row,
  context,
}: {
  metric: (typeof METRICS)[number];
  row: ChallengeMetric;
  context: MetricExplainerContext;
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
          "group-hover:border-primary group-hover:bg-primary group-hover:text-[#C0D4E6] group-hover:shadow-[0_28px_80px_rgba(242,5,5,0.38)]",
        )}
        data-challenge-card-surface={metric.key}
      >
        <div className="flex items-start justify-between gap-3">
          <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg border border-white/5 bg-white/[0.04]", PRESENTATION_CARD_SYNC, "group-hover:border-secondary/25 group-hover:bg-secondary/10")}>
            <Icon className={cn("h-5 w-5", PRESENTATION_CARD_SYNC, metric.tone, "group-hover:text-[#C0D4E6]")} />
          </div>
          <MetricExplainerBadge metric={metric} context={context} />
        </div>
        <div className="mt-5">
          <p className={cn("mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground", PRESENTATION_CARD_SYNC, "group-hover:text-[#C0D4E6]")}>{metric.label}</p>
          <p className={cn("font-display text-3xl text-white", PRESENTATION_CARD_SYNC, "group-hover:text-[#C0D4E6]")}>{metric.format(value)}</p>
          {metric.sub && <p className={cn("mt-1 text-[11px] text-muted-foreground", PRESENTATION_CARD_SYNC, "group-hover:text-[#C0D4E6]/80")}>{metric.sub(row)}</p>}
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
