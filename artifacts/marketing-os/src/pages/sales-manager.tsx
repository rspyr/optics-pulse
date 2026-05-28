import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip as UiTooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/components/auth-context";
import { useTenants } from "@/hooks/use-tenants";
import {
  Users, Phone, MessageSquare, TrendingUp,
  Loader2, Award, Clock, Zap, AlertTriangle, Lightbulb,
  CheckCircle2, PhoneCall, Mail, Settings as SettingsIcon,
  FileText, Activity, Brain, BarChart3, DollarSign, Target,
  ArrowUpRight, ArrowDownRight, RefreshCw, ChevronDown, ChevronUp,
  Shuffle, Pause, Play, Calendar, Save, Table2, Link2,
  Mic, GripVertical, Eye, Wand2, ShieldCheck, AlertCircle, Info,
  X, ExternalLink,
} from "lucide-react";
import { useLocation } from "wouter";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import ScriptManagement from "@/components/script-management";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

type Tab = "dashboard" | "team" | "scripts" | "activity" | "coaching" | "routing" | "settings" | "spiffs";

interface FunnelType {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
}

interface SheetConfig {
  id: number;
  tenantId: number;
  name: string;
  googleSheetId: string;
  googleSheetTab: string;
  columnMapping?: Record<string, string> | null;
  mappingHeaders?: string[] | null;
  syncPaused: boolean;
  defaultFunnelTypeId: number | null;
  funnelColumn: string | null;
  funnelValueMap: Record<string, number> | null;
  defaultFunnel?: { id: number; name: string; slug: string } | null;
  unroutedCount?: number;
}

interface UnroutedSheetRow {
  id: number;
  tenantId: number;
  sheetConfigId: number;
  funnelColumn: string | null;
  unmatchedValue: string | null;
  rowData: Record<string, string>;
  reason: string;
  source: string;
  createdAt: string;
  resolvedAt: string | null;
}

interface StatsData {
  totalLeads: number;
  appointments: number;
  bookingRate: number;
  bookedInWindow: number;
  spiffEarned: number;
  activityBookingRate: number;
  totalTouchpoints?: number;
  totalCalls?: number;
  totalTexts?: number;
  totalVms?: number;
  bySource: { source: string; total: number; appointments: number; bookingRate: number }[];
  byFunnel: { funnelId: number; total: number; appointments: number; bookingRate: number; calls: number; texts: number; vms: number; nonPBTotal: number; nonPBCalls: number; nonPBTexts: number; nonPBVms: number }[];
  byCsr: { csrId: number; total: number; appointments: number; bookingRate: number; calls: number; texts: number; vms: number }[];
  byCsrByFunnel: { csrId: number; funnelId: number; total: number; appointments: number; bookingRate: number }[];
}

interface CsrData {
  id: number;
  name: string;
  email: string;
  role: string;
  isPaused: boolean;
  pauseStart: string | null;
  pauseEnd: string | null;
}

interface RoutingConfig {
  id: number;
  tenantId: number;
  funnelTypeId: number | null;
  cascadeOrder: number[];
  passIntervalMinutes: number;
  allowPassBack: boolean;
  stickyAfterCascade: boolean;
  stickyCsrId: number | null;
  backupStickyCsrId: number | null;
  isActive: boolean;
}

interface ActivityItem {
  id: number;
  coordinatorName: string;
  coordinatorId: number;
  leadName: string;
  leadSource: string;
  leadStatus: string;
  method: string;
  outcome: string;
  platform: string;
  attemptedAt: string;
  notes: string | null;
}

interface CoachingInsight {
  type: "positive" | "warning" | "suggestion";
  title: string;
  detail: string;
  coordinatorId?: number;
  coordinatorName?: string;
  metric?: string;
  value?: number;
}


function formatInTz(dateStr: string | Date, tz: string, opts?: Intl.DateTimeFormatOptions): string {
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  return d.toLocaleString("en-US", { timeZone: tz, ...opts });
}

function formatDateTimeInTz(dateStr: string | Date, tz: string): string {
  return formatInTz(dateStr, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function useFunnelTypes(tenantId: number | null) {
  const [funnels, setFunnels] = useState<FunnelType[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFunnels = useCallback(async () => {
    if (!tenantId) { setFunnels([]); setLoading(false); return; }
    try {
      const res = await fetch(`${API_BASE}/tenants/${tenantId}/funnel-types`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setFunnels(data);
      }
    } catch {} finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => { fetchFunnels(); }, [fetchFunnels]);

  return { funnels, loading, refetch: fetchFunnels };
}

function useStats(tenantId: number | null, startDate: string, endDate: string, funnelId: number | null, includePreBooked: boolean = false) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    if (!tenantId) { setStats(null); setLoading(false); return; }
    try {
      const params = new URLSearchParams({ tenantId: String(tenantId), startDate, endDate });
      if (funnelId) params.set("funnelId", String(funnelId));
      if (includePreBooked) params.set("includePreBooked", "true");
      const res = await fetch(`${API_BASE}/leads-hub/stats?${params}`, { credentials: "include" });
      if (res.ok) setStats(await res.json());
    } catch {} finally { setLoading(false); }
  }, [tenantId, startDate, endDate, funnelId, includePreBooked]);

  useEffect(() => { setLoading(true); fetchStats(); }, [fetchStats]);

  return { stats, loading, refetch: fetchStats };
}

function useCsrs(tenantId: number | null) {
  const [csrs, setCsrs] = useState<CsrData[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCsrs = useCallback(async () => {
    if (!tenantId) { setCsrs([]); setLoading(false); return; }
    try {
      const res = await fetch(`${API_BASE}/leads-hub/csrs?tenantId=${tenantId}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setCsrs(data.csrs || []);
      }
    } catch {} finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => { fetchCsrs(); }, [fetchCsrs]);

  return { csrs, loading, refetch: fetchCsrs };
}

function useRoutingConfigs(tenantId: number | null) {
  const [configs, setConfigs] = useState<RoutingConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConfigs = useCallback(async () => {
    if (!tenantId) { setConfigs([]); setLoading(false); return; }
    try {
      const res = await fetch(`${API_BASE}/leads-hub/routing-config?tenantId=${tenantId}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setConfigs(data.configs || []);
      }
    } catch {} finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  return { configs, loading, refetch: fetchConfigs };
}

function useActivityFeed(tenantId: number | null) {
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFeed = useCallback(async () => {
    // Don't fetch the activity feed without a tenant in scope — the
    // unscoped variant would return agency-wide data, which contradicts
    // the "operator must pick a tenant explicitly" policy.
    if (!tenantId) { setActivities([]); setLoading(false); return; }
    try {
      const res = await fetch(`${API_BASE}/sales-manager/activity-feed?tenantId=${tenantId}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setActivities(data.activities);
      }
    } catch {} finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => {
    fetchFeed();
    if (!tenantId) return;
    const interval = setInterval(fetchFeed, 10000);
    return () => clearInterval(interval);
  }, [fetchFeed, tenantId]);

  return { activities, loading, refetch: fetchFeed };
}

function useCoachingInsights(tenantId: number | null) {
  const [insights, setInsights] = useState<CoachingInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (!tenantId) { setLoading(false); setInsights([]); return; }
    setFetching(true);
    fetch(`${API_BASE}/sales-manager/coaching-insights?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => { setInsights(d.insights || []); })
      .catch(() => {})
      .finally(() => { setLoading(false); setFetching(false); });
  }, [tenantId]);

  return { insights, loading, fetching };
}

function MetricCard({ label, value, icon: Icon, delta, format = "number", className, subtitle, tooltip }: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  delta?: number;
  format?: "number" | "percent" | "currency" | "time";
  className?: string;
  subtitle?: string;
  tooltip?: string;
}) {
  const formatted = format === "percent" ? `${value}%`
    : format === "currency" ? `$${value}`
    : format === "time" ? (value > 60 ? `${Math.floor(value / 60)}m ${value % 60}s` : `${value}s`)
    : `${value}`;

  return (
    <PremiumCard className={cn("p-4", className)}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-white/30 uppercase tracking-wider font-mono flex items-center gap-1">
          {label}
          {tooltip && (
            <UiTooltip>
              <TooltipTrigger asChild>
                <button type="button" className="text-white/30 hover:text-white/60 transition-colors" aria-label={`About ${label}`}>
                  <Info className="w-3 h-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-xs">
                {tooltip}
              </TooltipContent>
            </UiTooltip>
          )}
        </span>
        <Icon className="w-4 h-4 text-white/20" />
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-display text-white">{formatted}</span>
        {delta !== undefined && delta !== 0 && (
          <span className={cn(
            "text-[10px] font-mono flex items-center gap-0.5 mb-1",
            delta > 0 ? "text-emerald-400" : "text-red-400"
          )}>
            {delta > 0 ? <ArrowUpRight className="w-2.5 h-2.5" /> : <ArrowDownRight className="w-2.5 h-2.5" />}
            {Math.abs(delta)}%
          </span>
        )}
      </div>
      {subtitle && (
        <p className="text-[9px] text-white/20 mt-1 font-mono">{subtitle}</p>
      )}
    </PremiumCard>
  );
}

function getDateRange(preset: string): [string, string] {
  const now = new Date();
  const end = now.toISOString();
  const start = new Date();
  switch (preset) {
    case "today": start.setHours(0, 0, 0, 0); break;
    case "7d": start.setDate(start.getDate() - 7); break;
    case "30d": start.setDate(start.getDate() - 30); break;
    case "90d": start.setDate(start.getDate() - 90); break;
    default: start.setHours(0, 0, 0, 0);
  }
  return [start.toISOString(), end];
}

function useDateRange(preset: string): [string, string] {
  const [range, setRange] = useState<[string, string]>(() => getDateRange(preset));
  useEffect(() => { setRange(getDateRange(preset)); }, [preset]);
  return range;
}

const HUB_STATUS_LABELS: Record<string, string> = {
  day_1: "Day 1", day_2: "Day 2", day_3: "Day 3", day_4: "Day 4",
  day_5_old: "Old", appt_set: "Appt Set", appt_booked: "Booked",
  call_back: "Callback", dead: "Dead",
};

const HUB_STATUS_COLORS: Record<string, string> = {
  day_1: "text-emerald-400", day_2: "text-blue-400", day_3: "text-amber-400",
  day_4: "text-orange-400", day_5_old: "text-red-400",
  appt_set: "text-emerald-400", appt_booked: "text-purple-400",
  call_back: "text-amber-400", dead: "text-red-300",
};

interface DrilldownLead {
  id: number;
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  source: string;
  hubStatus: string;
  createdAt: string;
  funnelId?: number | null;
}

interface DrilldownFilter {
  type: "source" | "funnel";
  source?: string;
  funnelId?: number;
  label: string;
}

interface TimeseriesPoint {
  date: string;
  leads: number;
  appointments: number;
  bookingRate: number;
  touchpoints: number;
}

function DrilldownChart({ tenantId, filter, startDate, endDate, includePreBooked }: {
  tenantId: number | null;
  filter: DrilldownFilter;
  startDate: string;
  endDate: string;
  includePreBooked: boolean;
}) {
  const [series, setSeries] = useState<TimeseriesPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) return;
    setLoading(true);
    let cancelled = false;
    const params = new URLSearchParams({ tenantId: String(tenantId), startDate, endDate });
    if (filter.source) params.set("source", filter.source);
    if (filter.funnelId) params.set("funnelId", String(filter.funnelId));
    if (includePreBooked) params.set("includePreBooked", "true");

    fetch(`${API_BASE}/leads-hub/stats/timeseries?${params}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : { series: [] })
      .then(data => { if (!cancelled) setSeries(data.series || []); })
      .catch(() => { if (!cancelled) setSeries([]); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [tenantId, filter, startDate, endDate, includePreBooked]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-5 h-5 text-primary animate-spin" />
      </div>
    );
  }

  if (series.length === 0) {
    return <p className="text-xs text-white/30 text-center py-10">No data for this period</p>;
  }

  const formatted = series.map(p => ({
    ...p,
    label: new Date(p.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  }));

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-[10px] text-white/40 uppercase tracking-wider mb-3">Leads & Appointments</h4>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={formatted} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: "rgba(255,255,255,0.3)" }} axisLine={{ stroke: "rgba(255,255,255,0.1)" }} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: "rgba(255,255,255,0.3)" }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip contentStyle={{ backgroundColor: "#0a0a0f", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11 }} labelStyle={{ color: "rgba(255,255,255,0.5)" }} />
            <Line type="monotone" dataKey="leads" stroke="#ffffff" strokeWidth={2} dot={false} name="Leads" />
            <Line type="monotone" dataKey="appointments" stroke="#34d399" strokeWidth={2} dot={false} name="Appointments" />
            <Legend wrapperStyle={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div>
        <h4 className="text-[10px] text-white/40 uppercase tracking-wider mb-3">Booking Rate %</h4>
        <ResponsiveContainer width="100%" height={120}>
          <LineChart data={formatted} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: "rgba(255,255,255,0.3)" }} axisLine={{ stroke: "rgba(255,255,255,0.1)" }} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: "rgba(255,255,255,0.3)" }} axisLine={false} tickLine={false} unit="%" />
            <Tooltip contentStyle={{ backgroundColor: "#0a0a0f", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11 }} labelStyle={{ color: "rgba(255,255,255,0.5)" }} formatter={(v: number) => `${v}%`} />
            <Line type="monotone" dataKey="bookingRate" stroke="#fbbf24" strokeWidth={2} dot={false} name="Rate" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div>
        <h4 className="text-[10px] text-white/40 uppercase tracking-wider mb-3">Touchpoints</h4>
        <ResponsiveContainer width="100%" height={120}>
          <LineChart data={formatted} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: "rgba(255,255,255,0.3)" }} axisLine={{ stroke: "rgba(255,255,255,0.1)" }} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: "rgba(255,255,255,0.3)" }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip contentStyle={{ backgroundColor: "#0a0a0f", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11 }} labelStyle={{ color: "rgba(255,255,255,0.5)" }} />
            <Line type="monotone" dataKey="touchpoints" stroke="#60a5fa" strokeWidth={2} dot={false} name="Touchpoints" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function LeadsDrilldownPopout({
  tenantId,
  filter,
  startDate,
  endDate,
  includePreBooked,
  onClose,
  funnels,
}: {
  tenantId: number | null;
  filter: DrilldownFilter;
  startDate: string;
  endDate: string;
  includePreBooked: boolean;
  onClose: () => void;
  funnels: FunnelType[];
}) {
  const [leads, setLeads] = useState<DrilldownLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!tenantId) return;
    setLoading(true);
    let cancelled = false;

    async function fetchAll() {
      const allLeads: DrilldownLead[] = [];
      const batchSize = 200;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          tenantId: String(tenantId!),
          startDate,
          endDate,
          limit: String(batchSize),
          offset: String(offset),
        });
        if (filter.source) params.set("source", filter.source);
        if (filter.funnelId) params.set("funnelId", String(filter.funnelId));

        const res = await fetch(`${API_BASE}/leads?${params}`, { credentials: "include" });
        if (!res.ok || cancelled) break;
        const data = await res.json();
        const batch = data.leads || [];
        allLeads.push(...batch);
        offset += batchSize;
        hasMore = batch.length === batchSize;
      }

      if (!cancelled) {
        const filtered = includePreBooked
          ? allLeads
          : allLeads.filter((l: DrilldownLead & { preBooked?: boolean }) => !l.preBooked);
        setLeads(filtered);
      }
    }

    fetchAll().catch(() => { if (!cancelled) setLeads([]); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId, filter, startDate, endDate, includePreBooked]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-4xl h-full bg-[#0a0a0f] border-l border-white/10 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div>
            <h3 className="text-sm font-display text-white">{filter.label}</h3>
            <p className="text-[10px] text-white/30 mt-0.5">
              {leads.length} lead{leads.length !== 1 ? "s" : ""} found
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10 transition-colors">
            <X className="w-4 h-4 text-white/50" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-1/2 border-r border-white/10 overflow-y-auto p-4">
            <DrilldownChart
              tenantId={tenantId}
              filter={filter}
              startDate={startDate}
              endDate={endDate}
              includePreBooked={includePreBooked}
            />
          </div>

          <div className="w-1/2 overflow-y-auto p-3 space-y-1.5">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-5 h-5 text-primary animate-spin" />
              </div>
            ) : leads.length === 0 ? (
              <p className="text-xs text-white/30 text-center py-10">No leads found</p>
            ) : (
              leads.map(lead => {
                const funnelName = lead.funnelId
                  ? funnels.find(f => f.id === lead.funnelId)?.name || null
                  : null;
                return (
                  <button
                    key={lead.id}
                    onClick={() => navigate(`/pulse?leadId=${lead.id}`)}
                    className="w-full text-left p-3 rounded-lg bg-white/[0.03] border border-white/5 hover:bg-white/[0.07] hover:border-white/10 transition-all group"
                  >
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-white truncate">
                          {lead.firstName} {lead.lastName}
                        </p>
                        {lead.phone && (
                          <p className="text-[10px] text-white/40 font-mono mt-0.5">{lead.phone}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                        <span className={cn(
                          "text-[10px] font-mono px-1.5 py-0.5 rounded",
                          HUB_STATUS_COLORS[lead.hubStatus] || "text-white/40"
                        )}>
                          {HUB_STATUS_LABELS[lead.hubStatus] || lead.hubStatus}
                        </span>
                        <ExternalLink className="w-3 h-3 text-white/20 group-hover:text-white/50 transition-colors" />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] text-white/25">{lead.source}</span>
                      {funnelName && (
                        <>
                          <span className="text-[10px] text-white/15">·</span>
                          <span className="text-[10px] text-white/25">{funnelName}</span>
                        </>
                      )}
                      <span className="text-[10px] text-white/15">·</span>
                      <span className="text-[10px] text-white/25">
                        {new Date(lead.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function DashboardTab({ tenantId, funnels, includePreBooked, setIncludePreBooked, onNavigateToSettings }: { tenantId: number | null; funnels: FunnelType[]; includePreBooked: boolean; setIncludePreBooked: (v: boolean) => void; onNavigateToSettings: () => void }) {
  const [datePreset, setDatePreset] = useState("today");
  const [funnelFilter, setFunnelFilter] = useState<number | null>(null);
  const [startDate, endDate] = useDateRange(datePreset);
  const { stats, loading } = useStats(tenantId, startDate, endDate, funnelFilter, includePreBooked);
  const { stats: allStats, loading: allStatsLoading } = useStats(tenantId, startDate, endDate, null, includePreBooked);
  const [drilldownFilter, setDrilldownFilter] = useState<DrilldownFilter | null>(null);

  const [spiffByFunnel, setSpiffByFunnel] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!tenantId) { setSpiffByFunnel({}); return; }
    let cancelled = false;
    fetch(`${API_BASE}/sales-manager/spiff-config?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => { if (!cancelled && data?.spiffConfig?.byFunnel) setSpiffByFunnel(data.spiffConfig.byFunnel); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [tenantId]);
  const funnelNameSet = useMemo(() => new Set((funnels || []).map(f => f.name)), [funnels]);
  const staleSpiffKeys = useMemo(
    () => Object.keys(spiffByFunnel).filter(k => !funnelNameSet.has(k)),
    [spiffByFunnel, funnelNameSet]
  );
  const hasStaleSpiffs = staleSpiffKeys.length > 0;

  const isToday = datePreset === "today";
  const overallBookingRate = (isToday ? allStats?.activityBookingRate : allStats?.bookingRate) ?? 0;
  const selectedFunnelRate = funnelFilter
    ? (allStats?.byFunnel.find(f => f.funnelId === funnelFilter)?.bookingRate ?? 0)
    : null;
  const headlineBookingRate = (isToday ? stats?.activityBookingRate : stats?.bookingRate) ?? 0;
  const bookedTodayCount = stats?.bookedInWindow ?? 0;
  const spiffEarned = stats?.spiffEarned ?? 0;

  if (loading || allStatsLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {hasStaleSpiffs && (
        <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-amber-200 font-medium">
              {staleSpiffKeys.length === 1
                ? `Spiff override "${staleSpiffKeys[0]}" no longer matches a live funnel`
                : `${staleSpiffKeys.length} spiff overrides no longer match a live funnel`}
            </p>
            <p className="text-[11px] text-amber-200/70 leading-relaxed mt-0.5">
              {staleSpiffKeys.length === 1
                ? "It's paying the default amount until you rename or remove it."
                : `Stale keys: ${staleSpiffKeys.map(k => `"${k}"`).join(", ")}. They're paying the default amount until you rename or remove them.`}
            </p>
          </div>
          <button
            onClick={onNavigateToSettings}
            className="flex items-center gap-1 text-xs text-amber-200 hover:text-amber-100 underline whitespace-nowrap"
          >
            Fix in Settings
            <ArrowUpRight className="w-3 h-3" />
          </button>
        </div>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          {(["today", "7d", "30d", "90d"] as const).map(p => (
            <button
              key={p}
              onClick={() => setDatePreset(p)}
              className={cn(
                "px-3 py-1 rounded text-xs font-mono uppercase",
                datePreset === p
                  ? "bg-primary/20 text-primary border border-primary/30"
                  : "text-white/30 hover:text-white/50"
              )}
            >
              {p}
            </button>
          ))}
        </div>
        <Select
          value={funnelFilter != null ? String(funnelFilter) : "__all__"}
          onValueChange={v => setFunnelFilter(v === "__all__" ? null : Number(v))}
        >
          <SelectTrigger className="bg-white/5 border border-white/10 rounded-md px-3 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto w-auto min-w-[120px]">
            <SelectValue placeholder="All Funnels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Funnels</SelectItem>
            {funnels.map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-white/40 cursor-pointer select-none ml-2">
          <input
            type="checkbox"
            checked={includePreBooked}
            onChange={e => setIncludePreBooked(e.target.checked)}
            className="rounded border-white/20 bg-white/5 text-primary focus:ring-primary/30 w-3.5 h-3.5"
          />
          Include Pre-Booked
        </label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Total Leads" value={stats?.totalLeads || 0} icon={Users} />
        {isToday ? (
          <MetricCard
            label="Booked Today"
            value={bookedTodayCount}
            icon={Target}
            subtitle={`$${spiffEarned} earned (spiffs)`}
          />
        ) : (
          <MetricCard
            label="Appointments"
            value={stats?.appointments || 0}
            icon={Target}
            tooltip="Leads CREATED in this window that became appointments — not bookings that happened in the window. Switch to TODAY for activity-based bookings (matches Pulse)."
          />
        )}
        <MetricCard
          label={funnelFilter ? "Funnel Rate" : "Booking Rate"}
          value={headlineBookingRate}
          icon={TrendingUp}
          format="percent"
          subtitle={funnelFilter ? `Overall: ${overallBookingRate}%` : undefined}
        />
        <MetricCard label="Total Touchpoints" value={(stats?.totalTouchpoints ?? stats?.byCsr.reduce((s, c) => s + c.calls + c.texts + c.vms, 0)) || 0} icon={Phone} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PremiumCard className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="w-4 h-4 text-primary" />
            <span className="text-sm font-display text-white">By Source</span>
          </div>
          {(stats?.bySource || []).length === 0 ? (
            <p className="text-xs text-white/30 text-center py-4">No source data</p>
          ) : (
            <div className="space-y-2">
              {stats!.bySource.map(s => (
                <button
                  key={s.source}
                  onClick={() => setDrilldownFilter({ type: "source", source: s.source, funnelId: funnelFilter ?? undefined, label: `Leads from ${s.source}` })}
                  className="w-full flex items-center justify-between p-2 rounded bg-white/[0.02] border border-white/5 hover:bg-white/[0.06] hover:border-white/10 transition-all cursor-pointer text-left"
                >
                  <span className="text-xs text-white/70">{s.source}</span>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="text-xs font-mono text-white">{s.total}</p>
                      <p className="text-[9px] text-white/20 uppercase">leads</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-mono text-emerald-400">{s.appointments}</p>
                      <p className="text-[9px] text-white/20 uppercase">appts</p>
                    </div>
                    <div className="text-right min-w-[40px]">
                      <p className={cn(
                        "text-xs font-mono",
                        s.bookingRate >= 30 ? "text-emerald-400" : s.bookingRate >= 15 ? "text-amber-400" : "text-red-400"
                      )}>{s.bookingRate}%</p>
                      <p className="text-[9px] text-white/20 uppercase">rate</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </PremiumCard>

        <PremiumCard className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Shuffle className="w-4 h-4 text-primary" />
            <span className="text-sm font-display text-white">By Funnel</span>
          </div>
          {(stats?.byFunnel || []).length === 0 ? (
            <p className="text-xs text-white/30 text-center py-4">No funnel data</p>
          ) : (
            <div className="space-y-2">
              {stats!.byFunnel.map(f => {
                const funnelName = funnels.find(ft => ft.id === f.funnelId)?.name || `Funnel #${f.funnelId}`;
                return (
                  <button
                    key={f.funnelId}
                    onClick={() => setDrilldownFilter({ type: "funnel", funnelId: f.funnelId, label: `Leads from ${funnelName}` })}
                    className="w-full flex items-center justify-between p-2 rounded bg-white/[0.02] border border-white/5 hover:bg-white/[0.06] hover:border-white/10 transition-all cursor-pointer text-left"
                  >
                    <span className="text-xs text-white/70">{funnelName}</span>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="text-xs font-mono text-white">{f.total}</p>
                        <p className="text-[9px] text-white/20 uppercase">leads</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-mono text-emerald-400">{f.appointments}</p>
                        <p className="text-[9px] text-white/20 uppercase">appts</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-mono text-blue-400">{f.nonPBTotal > 0 ? ((f.nonPBCalls + f.nonPBTexts + f.nonPBVms) / f.nonPBTotal).toFixed(1) : "0"}</p>
                        <p className="text-[9px] text-white/20 uppercase">tp/lead</p>
                      </div>
                      <div className="text-right min-w-[40px]">
                        <p className={cn(
                          "text-xs font-mono",
                          f.bookingRate >= 30 ? "text-emerald-400" : f.bookingRate >= 15 ? "text-amber-400" : "text-red-400"
                        )}>{f.bookingRate}%</p>
                        <p className="text-[9px] text-white/20 uppercase">rate</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </PremiumCard>
      </div>

      <PremiumCard className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Phone className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">Total Touchpoints with Funnel Breakdown</span>
        </div>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="p-3 rounded bg-white/[0.02] border border-white/5 text-center">
            <p className="text-2xl font-display text-white">{stats?.totalCalls ?? stats?.byCsr.reduce((s, c) => s + c.calls, 0) ?? 0}</p>
            <p className="text-[10px] text-white/30 uppercase">Total Calls</p>
          </div>
          <div className="p-3 rounded bg-white/[0.02] border border-white/5 text-center">
            <p className="text-2xl font-display text-blue-400">{stats?.totalTexts ?? stats?.byCsr.reduce((s, c) => s + c.texts, 0) ?? 0}</p>
            <p className="text-[10px] text-white/30 uppercase">Total Texts</p>
          </div>
          <div className="p-3 rounded bg-white/[0.02] border border-white/5 text-center">
            <p className="text-2xl font-display text-purple-400">{stats?.totalVms ?? stats?.byCsr.reduce((s, c) => s + c.vms, 0) ?? 0}</p>
            <p className="text-[10px] text-white/30 uppercase">Total VMs</p>
          </div>
        </div>
        {(stats?.byFunnel || []).length === 0 ? (
          <p className="text-xs text-white/30 text-center py-4">No funnel data</p>
        ) : (
          <div className="space-y-2">
            {stats!.byFunnel.map(f => {
              const funnelName = funnels.find(ft => ft.id === f.funnelId)?.name || `Funnel #${f.funnelId}`;
              return (
                <div key={f.funnelId} className="flex items-center gap-3 p-2 rounded bg-white/[0.02] border border-white/5">
                  <span className="text-xs text-white/70 truncate min-w-0 flex-1">{funnelName}</span>
                  <div className="flex items-center gap-4 flex-shrink-0">
                    <div className="text-right">
                      <p className="text-xs font-mono text-white">{f.calls}</p>
                      <p className="text-[9px] text-white/20 uppercase">calls</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-mono text-blue-400">{f.texts}</p>
                      <p className="text-[9px] text-white/20 uppercase">texts</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-mono text-white">{f.total}</p>
                      <p className="text-[9px] text-white/20 uppercase">leads</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-mono text-emerald-400">{f.appointments}</p>
                      <p className="text-[9px] text-white/20 uppercase">appts</p>
                    </div>
                    <div className="text-right min-w-[40px]">
                      <p className={cn(
                        "text-xs font-mono",
                        f.bookingRate >= 30 ? "text-emerald-400" : f.bookingRate >= 15 ? "text-amber-400" : "text-red-400"
                      )}>{f.bookingRate}%</p>
                      <p className="text-[9px] text-white/20 uppercase">rate</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PremiumCard>

      {drilldownFilter && (
        <LeadsDrilldownPopout
          tenantId={tenantId}
          filter={drilldownFilter}
          startDate={startDate}
          endDate={endDate}
          includePreBooked={includePreBooked}
          onClose={() => setDrilldownFilter(null)}
          funnels={funnels}
        />
      )}
    </div>
  );
}

function TeamTab({ tenantId, funnels, timezone = "America/New_York", includePreBooked, setIncludePreBooked }: { tenantId: number | null; funnels: FunnelType[]; timezone?: string; includePreBooked: boolean; setIncludePreBooked: (v: boolean) => void }) {
  const [datePreset, setDatePreset] = useState("today");
  const [startDate, endDate] = useDateRange(datePreset);
  const { stats, loading: statsLoading } = useStats(tenantId, startDate, endDate, null, includePreBooked);
  const { csrs, loading: csrsLoading } = useCsrs(tenantId);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<"appts" | "calls" | "rate">("appts");

  const [batchSourceId, setBatchSourceId] = useState<number | null>(null);
  const [batchTargetId, setBatchTargetId] = useState<number | null>(null);
  const [batchPreviewCount, setBatchPreviewCount] = useState<number | null>(null);
  const [batchPreviewLoading, setBatchPreviewLoading] = useState(false);
  const [batchTransferring, setBatchTransferring] = useState(false);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchResult, setBatchResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    if (!batchSourceId || !tenantId) { setBatchPreviewCount(null); return; }
    let cancelled = false;
    setBatchPreviewLoading(true);
    fetch(`${API_BASE}/leads-hub/batch-transfer/preview?tenantId=${tenantId}&sourceCsrId=${batchSourceId}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => { if (!cancelled) setBatchPreviewCount(data.count ?? 0); })
      .catch(() => { if (!cancelled) setBatchPreviewCount(null); })
      .finally(() => { if (!cancelled) setBatchPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [batchSourceId, tenantId]);

  const executeBatchTransfer = async () => {
    if (!batchSourceId || !batchTargetId || !tenantId) return;
    setBatchTransferring(true);
    setBatchResult(null);
    try {
      const res = await fetch(`${API_BASE}/leads-hub/batch-transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sourceCsrId: batchSourceId, targetCsrId: batchTargetId, tenantId }),
      });
      const data = await res.json();
      if (res.ok) {
        setBatchResult({ type: "success", message: data.message || `${data.transferred} leads transferred` });
        setBatchSourceId(null);
        setBatchTargetId(null);
        setBatchPreviewCount(null);
      } else {
        setBatchResult({ type: "error", message: data.error || "Transfer failed" });
      }
    } catch {
      setBatchResult({ type: "error", message: "Network error" });
    } finally {
      setBatchTransferring(false);
      setBatchConfirmOpen(false);
    }
  };

  const loading = statsLoading || csrsLoading;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  const csrStats = (stats?.byCsr || []).map(s => {
    const csr = csrs.find(c => c.id === s.csrId);
    return { ...s, name: csr?.name || `CSR #${s.csrId}`, email: csr?.email || "", isPaused: csr?.isPaused || false };
  });

  const sorted = [...csrStats].sort((a, b) => {
    switch (sortBy) {
      case "calls": return b.calls - a.calls;
      case "rate": return b.bookingRate - a.bookingRate;
      default: return b.appointments - a.appointments;
    }
  });

  const totalTeamCalls = csrStats.reduce((s, c) => s + c.calls, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          {(["today", "7d", "30d", "90d"] as const).map(p => (
            <button
              key={p}
              onClick={() => setDatePreset(p)}
              className={cn(
                "px-3 py-1 rounded text-xs font-mono uppercase",
                datePreset === p
                  ? "bg-primary/20 text-primary border border-primary/30"
                  : "text-white/30 hover:text-white/50"
              )}
            >
              {p}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[10px] text-white/40 cursor-pointer select-none">
          <input type="checkbox" checked={includePreBooked} onChange={e => setIncludePreBooked(e.target.checked)} className="accent-primary w-3 h-3" />
          Include Pre-Booked
        </label>
        <div className="flex items-center gap-1 ml-auto">
          {(["appts", "calls", "rate"] as const).map(key => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] font-mono uppercase",
                sortBy === key
                  ? "bg-primary/20 text-primary border border-primary/30"
                  : "text-white/30 hover:text-white/50"
              )}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      <PremiumCard className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Users className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">
            CSR Performance ({sorted.length} reps)
          </span>
        </div>

        {sorted.length === 0 ? (
          <div className="text-center py-12">
            <Users className="w-8 h-8 text-white/10 mx-auto mb-2" />
            <p className="text-xs text-white/30">No CSR activity data in this period</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((csr, idx) => (
              <div key={csr.csrId}>
                <button
                  onClick={() => setExpandedId(expandedId === csr.csrId ? null : csr.csrId)}
                  className="w-full flex items-center gap-4 p-3 rounded-lg bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-colors text-left"
                >
                  <div className="w-7 h-7 rounded-full bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                    {idx < 3 ? (
                      <Award className={cn(
                        "w-3.5 h-3.5",
                        idx === 0 ? "text-amber-400" : idx === 1 ? "text-gray-400" : "text-orange-400"
                      )} />
                    ) : (
                      <span className="text-[10px] text-white/30 font-mono">{idx + 1}</span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-white truncate">{csr.name}</p>
                      {csr.isPaused && (
                        <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded">paused</span>
                      )}
                    </div>
                    <p className="text-[10px] text-white/30">{csr.email}</p>
                  </div>

                  <div className="grid grid-cols-6 gap-3 text-center flex-shrink-0">
                    <div>
                      <p className="text-xs font-mono text-white">{csr.calls}</p>
                      <p className="text-[9px] text-white/20 uppercase">Calls</p>
                    </div>
                    <div>
                      <p className="text-xs font-mono text-purple-400">{csr.vms}</p>
                      <p className="text-[9px] text-white/20 uppercase">VMs</p>
                    </div>
                    <div>
                      <p className="text-xs font-mono text-blue-400">{csr.texts}</p>
                      <p className="text-[9px] text-white/20 uppercase">Texts</p>
                    </div>
                    <div>
                      <p className="text-xs font-mono text-emerald-400">{csr.appointments}</p>
                      <p className="text-[9px] text-white/20 uppercase">Appts</p>
                    </div>
                    <div>
                      <p className={cn(
                        "text-xs font-mono",
                        csr.bookingRate >= 30 ? "text-emerald-400" : csr.bookingRate >= 15 ? "text-amber-400" : "text-red-400"
                      )}>
                        {csr.bookingRate}%
                      </p>
                      <p className="text-[9px] text-white/20 uppercase">Rate</p>
                    </div>
                    <div>
                      <p className="text-xs font-mono text-white">{csr.total}</p>
                      <p className="text-[9px] text-white/20 uppercase">Leads</p>
                    </div>
                  </div>

                  {expandedId === csr.csrId ? (
                    <ChevronUp className="w-4 h-4 text-white/20 flex-shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-white/20 flex-shrink-0" />
                  )}
                </button>

                {expandedId === csr.csrId && (() => {
                  const csrFunnels = (stats?.byCsrByFunnel || []).filter(cf => cf.csrId === csr.csrId);
                  return (
                  <div className="ml-11 mt-1 p-3 rounded-lg bg-white/[0.01] border border-white/5">
                    <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Activity Breakdown</p>
                    <div className="grid grid-cols-3 gap-3 mb-3">
                      <div className="p-2 rounded bg-white/[0.02]">
                        <p className="text-[10px] text-white/30 uppercase">Contact Rate</p>
                        <p className="text-sm font-mono text-white">{csr.calls > 0 ? Math.round((csr.appointments / csr.calls) * 100) : 0}%</p>
                        <p className="text-[9px] text-white/20">{csr.appointments} appts / {csr.calls} calls</p>
                      </div>
                      <div className="p-2 rounded bg-white/[0.02]">
                        <p className="text-[10px] text-white/30 uppercase">Leads Handled</p>
                        <p className="text-sm font-mono text-white">{csr.total}</p>
                        <p className="text-[9px] text-white/20">{totalTeamCalls > 0 ? Math.round((csr.calls / totalTeamCalls) * 100) : 0}% of team calls</p>
                      </div>
                      <div className="p-2 rounded bg-white/[0.02]">
                        <p className="text-[10px] text-white/30 uppercase">Outreach Mix</p>
                        <p className="text-sm font-mono text-white">{csr.calls + csr.texts + csr.vms}</p>
                        <p className="text-[9px] text-white/20">{csr.calls}c / {csr.texts}t / {csr.vms}vm</p>
                      </div>
                    </div>
                    {csrFunnels.length > 0 && (
                      <>
                        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Booking Rate by Funnel</p>
                        <div className="space-y-1">
                          {csrFunnels.map(cf => {
                            const fName = funnels.find(ft => ft.id === cf.funnelId)?.name || `Funnel #${cf.funnelId}`;
                            return (
                              <div key={cf.funnelId} className="flex items-center justify-between text-xs">
                                <span className="text-white/50">{fName}</span>
                                <div className="flex items-center gap-4">
                                  <span className="font-mono text-white/40">{cf.total} leads</span>
                                  <span className="font-mono text-emerald-400/70">{cf.appointments} appts</span>
                                  <span className={cn(
                                    "font-mono",
                                    cf.bookingRate >= 30 ? "text-emerald-400/70" : cf.bookingRate >= 15 ? "text-amber-400/70" : "text-red-400/70"
                                  )}>{cf.bookingRate}%</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                  );
                })()}
              </div>
            ))}
          </div>
        )}
      </PremiumCard>

      <PremiumCard className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Shuffle className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">Batch Lead Transfer</span>
        </div>
        <p className="text-[11px] text-white/40 mb-4">Transfer all active leads from one CSR to another. Transferred leads will be removed from round robin sequences.</p>

        {batchResult && (
          <div className={cn(
            "mb-4 p-3 rounded-lg border text-xs",
            batchResult.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
              : "bg-red-500/10 border-red-500/20 text-red-400"
          )}>
            <div className="flex items-center gap-2">
              {batchResult.type === "success" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
              {batchResult.message}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-[10px] text-white/30 uppercase tracking-wider mb-1.5 block">Source CSR</label>
            <Select
              value={batchSourceId != null ? String(batchSourceId) : "__none__"}
              onValueChange={v => {
                const val = v === "__none__" ? null : Number(v);
                setBatchSourceId(val);
                setBatchResult(null);
                if (val === batchTargetId) setBatchTargetId(null);
              }}
            >
              <SelectTrigger className="w-full bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-primary/50 h-auto">
                <SelectValue placeholder="Select source CSR..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select source CSR...</SelectItem>
                {csrs.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[10px] text-white/30 uppercase tracking-wider mb-1.5 block">Target CSR</label>
            <Select
              value={batchTargetId != null ? String(batchTargetId) : "__none__"}
              onValueChange={v => {
                setBatchTargetId(v === "__none__" ? null : Number(v));
                setBatchResult(null);
              }}
            >
              <SelectTrigger className="w-full bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-primary/50 h-auto">
                <SelectValue placeholder="Select target CSR..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select target CSR...</SelectItem>
                {csrs.filter(c => c.id !== batchSourceId).map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {batchSourceId && (
          <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/5 mb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs text-white/60">Active leads to transfer:</span>
            </div>
            {batchPreviewLoading ? (
              <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
            ) : (
              <span className="text-sm font-mono text-white">{batchPreviewCount ?? "—"}</span>
            )}
          </div>
        )}

        <button
          disabled={!batchSourceId || !batchTargetId || batchPreviewCount === 0 || batchPreviewCount === null || batchTransferring}
          onClick={() => setBatchConfirmOpen(true)}
          className={cn(
            "w-full py-2.5 rounded-lg text-xs font-medium transition-colors",
            batchSourceId && batchTargetId && batchPreviewCount && batchPreviewCount > 0
              ? "bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30"
              : "bg-white/[0.03] text-white/20 border border-white/5 cursor-not-allowed"
          )}
        >
          {batchTransferring ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Transferring...
            </span>
          ) : "Transfer All Leads"}
        </button>
      </PremiumCard>

      {batchConfirmOpen && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#1a1a2e] border border-white/10 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              <h3 className="text-sm font-display text-white">Confirm Batch Transfer</h3>
            </div>
            <p className="text-xs text-white/60 mb-2">
              You are about to transfer <span className="text-white font-mono">{batchPreviewCount}</span> active lead{batchPreviewCount !== 1 ? "s" : ""} from <span className="text-white font-medium">{csrs.find(c => c.id === batchSourceId)?.name}</span> to <span className="text-white font-medium">{csrs.find(c => c.id === batchTargetId)?.name}</span>.
            </p>
            <p className="text-xs text-white/40 mb-6">
              All lead data, touchpoint history, statuses, and notes will be preserved. Transferred leads will be removed from round robin sequences. This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setBatchConfirmOpen(false)}
                className="flex-1 py-2 rounded-lg text-xs bg-white/[0.05] text-white/60 border border-white/10 hover:bg-white/[0.08] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeBatchTransfer}
                disabled={batchTransferring}
                className="flex-1 py-2 rounded-lg text-xs bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 transition-colors"
              >
                {batchTransferring ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Transferring...
                  </span>
                ) : "Confirm Transfer"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function RoutingTab({ tenantId, funnels, timezone = "America/New_York" }: { tenantId: number | null; funnels: FunnelType[]; timezone?: string }) {
  const { configs, loading: configsLoading, refetch: refetchConfigs } = useRoutingConfigs(tenantId);
  const { csrs, loading: csrsLoading, refetch: refetchCsrs } = useCsrs(tenantId);
  const [selectedFunnelId, setSelectedFunnelId] = useState<number | null>(null);
  const [cascadeOrder, setCascadeOrder] = useState<number[]>([]);
  const [passInterval, setPassInterval] = useState(1440);
  const [passUnit, setPassUnit] = useState<"minutes" | "hours">("hours");
  const [allowPassBack, setAllowPassBack] = useState(false);
  const [stickyAfterCascade, setStickyAfterCascade] = useState(false);
  const [stickyCsrId, setStickyCsrId] = useState<number | null>(null);
  const [backupStickyCsrId, setBackupStickyCsrId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState<number | null>(null);
  const [scheduleEditId, setScheduleEditId] = useState<number | null>(null);
  const [schedPauseStart, setSchedPauseStart] = useState("");
  const [schedPauseEnd, setSchedPauseEnd] = useState("");
  const [schedError, setSchedError] = useState("");
  const [isInherited, setIsInherited] = useState(false);

  interface SavedState {
    cascadeOrder: number[];
    passInterval: number;
    allowPassBack: boolean;
    stickyAfterCascade: boolean;
    stickyCsrId: number | null;
    backupStickyCsrId: number | null;
  }
  const [lastSavedState, setLastSavedState] = useState<SavedState | null>(null);

  const loading = configsLoading || csrsLoading;

  const currentState: SavedState = {
    cascadeOrder,
    passInterval,
    allowPassBack,
    stickyAfterCascade,
    stickyCsrId,
    backupStickyCsrId,
  };
  const isDirty = lastSavedState !== null && JSON.stringify(currentState) !== JSON.stringify(lastSavedState);

  const pausedStickyConfigs = useMemo(() => {
    return configs.flatMap(c => {
      if (!c.stickyAfterCascade || !c.stickyCsrId) return [];
      const csr = csrs.find(u => u.id === c.stickyCsrId);
      if (!csr || !csr.isPaused) return [];
      const backupCsr = c.backupStickyCsrId ? csrs.find(u => u.id === c.backupStickyCsrId) : null;
      const backupActive = !!(backupCsr && !backupCsr.isPaused);
      const funnelName = c.funnelTypeId
        ? (funnels.find(f => f.id === c.funnelTypeId)?.name ?? `Funnel #${c.funnelTypeId}`)
        : "Default (All Funnels)";
      return [{
        configId: c.id,
        funnelTypeId: c.funnelTypeId,
        funnelName,
        csrId: csr.id,
        csrName: csr.name,
        backupCsrName: backupActive ? backupCsr!.name : null,
      }];
    });
  }, [configs, csrs, funnels]);

  const currentStickyCsrPaused = useMemo(() => {
    if (!stickyAfterCascade || !stickyCsrId) return null;
    const csr = csrs.find(u => u.id === stickyCsrId);
    return csr && csr.isPaused ? csr : null;
  }, [stickyAfterCascade, stickyCsrId, csrs]);

  const currentBackupStickyCsr = useMemo(() => {
    if (!stickyAfterCascade || !backupStickyCsrId) return null;
    return csrs.find(u => u.id === backupStickyCsrId) ?? null;
  }, [stickyAfterCascade, backupStickyCsrId, csrs]);

  useEffect(() => {
    const specificConfig = configs.find(c =>
      selectedFunnelId ? c.funnelTypeId === selectedFunnelId : c.funnelTypeId === null
    );
    const defaultConfig = configs.find(c => c.funnelTypeId === null);
    const config = specificConfig || (selectedFunnelId ? defaultConfig : null);
    const inherited = !specificConfig && !!selectedFunnelId && !!defaultConfig;
    setIsInherited(inherited);
    if (config) {
      const co = config.cascadeOrder || [];
      const mins = config.passIntervalMinutes || 1440;
      const unit = mins % 60 === 0 && mins >= 60 ? "hours" as const : "minutes" as const;
      const apb = config.allowPassBack || false;
      const sac = config.stickyAfterCascade || false;
      const sci = config.stickyCsrId || null;
      const bsci = config.backupStickyCsrId || null;
      setCascadeOrder(co);
      setPassInterval(mins);
      setPassUnit(unit);
      setAllowPassBack(apb);
      setStickyAfterCascade(sac);
      setStickyCsrId(sci);
      setBackupStickyCsrId(bsci);
      setLastSavedState({ cascadeOrder: co, passInterval: mins, allowPassBack: apb, stickyAfterCascade: sac, stickyCsrId: sci, backupStickyCsrId: bsci });
    } else {
      setCascadeOrder([]);
      setPassInterval(1440);
      setPassUnit("hours");
      setAllowPassBack(false);
      setStickyAfterCascade(false);
      setStickyCsrId(null);
      setBackupStickyCsrId(null);
      setLastSavedState({ cascadeOrder: [], passInterval: 1440, allowPassBack: false, stickyAfterCascade: false, stickyCsrId: null, backupStickyCsrId: null });
    }
  }, [selectedFunnelId, configs]);

  const handleSaveRouting = async () => {
    if (!tenantId) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/leads-hub/routing-config?tenantId=${tenantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          funnelTypeId: selectedFunnelId || null,
          cascadeOrder,
          passIntervalMinutes: passInterval,
          allowPassBack,
          stickyAfterCascade,
          stickyCsrId,
          backupStickyCsrId: stickyAfterCascade ? backupStickyCsrId : null,
        }),
      });
      if (res.ok) {
        setLastSavedState({ cascadeOrder, passInterval, allowPassBack, stickyAfterCascade, stickyCsrId, backupStickyCsrId: stickyAfterCascade ? backupStickyCsrId : null });
        setIsInherited(false);
        refetchConfigs();
      } else {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        alert(err.error || "Failed to save routing config");
      }
    } catch {
      alert("Connection error saving routing config");
    } finally { setSaving(false); }
  };

  const toggleCsrPause = async (userId: number, isPaused: boolean, pauseEnd?: string, pauseStart?: string) => {
    if (!tenantId) return;
    setScheduleSaving(userId);
    try {
      await fetch(`${API_BASE}/leads-hub/csr-schedule/${userId}?tenantId=${tenantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          isPaused,
          pauseStart: isPaused ? (pauseStart || new Date().toISOString()) : null,
          pauseEnd: pauseEnd || null,
        }),
      });
      refetchCsrs();
    } catch {} finally { setScheduleSaving(null); }
  };

  const addToCascade = (csrId: number) => {
    if (!cascadeOrder.includes(csrId)) {
      setCascadeOrder([...cascadeOrder, csrId]);
    }
  };

  const removeFromCascade = (csrId: number) => {
    setCascadeOrder(cascadeOrder.filter(id => id !== csrId));
  };

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const newOrder = [...cascadeOrder];
    const [moved] = newOrder.splice(result.source.index, 1);
    newOrder.splice(result.destination.index, 0, moved);
    setCascadeOrder(newOrder);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Select
          value={selectedFunnelId != null ? String(selectedFunnelId) : "__all__"}
          onValueChange={v => setSelectedFunnelId(v === "__all__" ? null : Number(v))}
        >
          <SelectTrigger className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto w-auto min-w-[180px]">
            <SelectValue placeholder="Default (All Funnels)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Default (All Funnels)</SelectItem>
            {funnels.map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {isInherited && (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md px-2 py-1">
            <Info className="w-3 h-3" />
            Using default routing — save to override for this funnel
          </span>
        )}
      </div>

      {pausedStickyConfigs.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1">
              <p className="text-xs font-medium text-amber-300">
                {pausedStickyConfigs.length === 1 ? "Sticky CSR paused" : "Sticky CSRs paused"}
              </p>
              <ul className="space-y-0.5">
                {pausedStickyConfigs.map(p => (
                  <li key={p.configId} className="text-[11px] text-amber-200/80">
                    <span className="font-medium">{p.funnelName}:</span> Sticky CSR{" "}
                    <span className="font-medium">{p.csrName}</span> is currently paused —{" "}
                    {p.backupCsrName
                      ? <>backup CSR <span className="font-medium">{p.backupCsrName}</span> is taking the sticky overflow until they resume.</>
                      : <>sticky redirect is disabled until they resume.</>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PremiumCard className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Shuffle className="w-4 h-4 text-primary" />
            <span className="text-sm font-display text-white">Round-Robin Cascade Order</span>
          </div>

          {cascadeOrder.length === 0 ? (
            <p className="text-xs text-white/30 mb-3">No CSRs in rotation. Add CSRs below.</p>
          ) : (
            <DragDropContext onDragEnd={onDragEnd}>
              <Droppable droppableId="cascade-order">
                {(provided) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="space-y-1 mb-3"
                  >
                    {cascadeOrder.map((csrId, idx) => {
                      const csr = csrs.find(c => c.id === csrId);
                      return (
                        <Draggable key={csrId} draggableId={String(csrId)} index={idx}>
                          {(dragProvided, snapshot) => {
                            const row = (
                              <div
                                ref={dragProvided.innerRef}
                                {...dragProvided.draggableProps}
                                {...dragProvided.dragHandleProps}
                                className={cn(
                                  "flex items-center gap-2 p-2 rounded bg-white/[0.02] border border-white/5 cursor-grab active:cursor-grabbing",
                                  snapshot.isDragging && "bg-white/[0.06] border-primary/30 shadow-lg"
                                )}
                              >
                                <GripVertical className="w-3 h-3 text-white/30 hover:text-white/50 flex-shrink-0" />
                                <span className="text-[10px] font-mono text-white/30 w-5">{idx + 1}.</span>
                                <span className="text-xs text-white flex-1 truncate">{csr?.name || `User #${csrId}`}</span>
                                {csr?.isPaused && (
                                  <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1 py-0.5 rounded">paused</span>
                                )}
                                <button
                                  onClick={() => removeFromCascade(csrId)}
                                  className="p-0.5 rounded text-white/20 hover:text-red-400"
                                >
                                  ×
                                </button>
                              </div>
                            );
                            if (snapshot.isDragging) return createPortal(row, document.body);
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
          )}

          {csrs.filter(c => !cascadeOrder.includes(c.id)).length > 0 && (
            <div className="border-t border-white/5 pt-3 mt-3 space-y-1">
              <p className="text-[10px] text-white/20 uppercase tracking-wider mb-1">Available CSRs</p>
              {csrs.filter(c => !cascadeOrder.includes(c.id)).map(csr => (
                <button
                  key={csr.id}
                  onClick={() => addToCascade(csr.id)}
                  className="w-full flex items-center gap-2 p-2 rounded bg-white/[0.01] border border-white/5 hover:bg-white/[0.04] text-left"
                >
                  <span className="text-xs text-white/50 flex-1 truncate">{csr.name}</span>
                  <span className="text-[9px] text-primary">+ Add</span>
                </button>
              ))}
            </div>
          )}

          <div className="border-t border-white/5 pt-4 mt-4 space-y-3">
            <div>
              <label className="text-[10px] text-white/30 uppercase tracking-wider">Pass Interval</label>
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="number"
                  min={1}
                  max={passUnit === "hours" ? 168 : 10080}
                  value={passUnit === "hours" ? Math.round(passInterval / 60) : passInterval}
                  onChange={e => {
                    const val = Math.max(1, Number(e.target.value));
                    setPassInterval(passUnit === "hours" ? val * 60 : val);
                  }}
                  className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
                <Select
                  value={passUnit}
                  onValueChange={v => {
                    const newUnit = v as "minutes" | "hours";
                    if (newUnit === "hours" && passUnit === "minutes") {
                      setPassInterval(Math.max(60, Math.round(passInterval / 60) * 60));
                    } else if (newUnit === "minutes" && passUnit === "hours") {
                      setPassInterval(passInterval);
                    }
                    setPassUnit(newUnit);
                  }}
                >
                  <SelectTrigger className="bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto w-auto min-w-[100px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">Minutes</SelectItem>
                    <SelectItem value="hours">Hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-[10px] text-white/20 mt-0.5">Auto-pass lead to next CSR after this period of inactivity</p>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-white/60">Allow Pass-Back</p>
                <p className="text-[10px] text-white/20">Leads can cycle back to previously assigned CSRs</p>
              </div>
              <button
                onClick={() => {
                  const next = !allowPassBack;
                  setAllowPassBack(next);
                  if (!next) { setStickyAfterCascade(false); setStickyCsrId(null); setBackupStickyCsrId(null); }
                }}
                className={cn(
                  "w-10 h-5 rounded-full transition-colors relative",
                  allowPassBack ? "bg-primary" : "bg-white/10"
                )}
              >
                <div className={cn(
                  "w-4 h-4 rounded-full bg-white absolute top-0.5 transition-all",
                  allowPassBack ? "left-5.5" : "left-0.5"
                )} style={{ left: allowPassBack ? "22px" : "2px" }} />
              </button>
            </div>

            {allowPassBack && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-white/60">Sticky After Cascade</p>
                    <p className="text-[10px] text-white/20">Assign lead to a specific CSR after one full cycle completes</p>
                  </div>
                  <button
                    onClick={() => {
                      const next = !stickyAfterCascade;
                      setStickyAfterCascade(next);
                      if (!next) { setStickyCsrId(null); setBackupStickyCsrId(null); }
                    }}
                    className={cn(
                      "w-10 h-5 rounded-full transition-colors relative",
                      stickyAfterCascade ? "bg-primary" : "bg-white/10"
                    )}
                  >
                    <div className={cn(
                      "w-4 h-4 rounded-full bg-white absolute top-0.5 transition-all",
                      stickyAfterCascade ? "left-5.5" : "left-0.5"
                    )} style={{ left: stickyAfterCascade ? "22px" : "2px" }} />
                  </button>
                </div>
                {stickyAfterCascade && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-[10px] text-white/30 uppercase tracking-wider">Assign To</label>
                      <Select
                        value={stickyCsrId != null ? String(stickyCsrId) : "__none__"}
                        onValueChange={v => setStickyCsrId(v === "__none__" ? null : Number(v))}
                      >
                        <SelectTrigger className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto">
                          <SelectValue placeholder="Select a CSR..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Select a CSR...</SelectItem>
                          {csrs.map(csr => (
                            <SelectItem key={csr.id} value={String(csr.id)}>{csr.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-white/20 mt-0.5">Lead will be assigned to this CSR after cycling through all cascade positions</p>
                      {currentStickyCsrPaused && (
                        <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                          <p className="text-[11px] text-amber-200/90 leading-snug">
                            Sticky CSR <span className="font-medium text-amber-100">{currentStickyCsrPaused.name}</span> is currently paused —{" "}
                            {currentBackupStickyCsr && !currentBackupStickyCsr.isPaused
                              ? <>backup CSR <span className="font-medium text-amber-100">{currentBackupStickyCsr.name}</span> is taking the sticky overflow until they resume.</>
                              : <>sticky redirect is disabled until they resume.</>}
                          </p>
                        </div>
                      )}
                    </div>
                    <div>
                      <label className="text-[10px] text-white/30 uppercase tracking-wider">Backup CSR (when primary is paused)</label>
                      <Select
                        value={backupStickyCsrId != null ? String(backupStickyCsrId) : "__none__"}
                        onValueChange={v => setBackupStickyCsrId(v === "__none__" ? null : Number(v))}
                      >
                        <SelectTrigger className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto">
                          <SelectValue placeholder="None — fall back to cascade" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None — fall back to cascade</SelectItem>
                          {csrs
                            .filter(csr => csr.id !== stickyCsrId)
                            .map(csr => (
                              <SelectItem key={csr.id} value={String(csr.id)}>{csr.name}</SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[10px] text-white/20 mt-0.5">Optional — picks up the sticky overflow only while the primary sticky CSR is paused.</p>
                      {currentBackupStickyCsr?.isPaused && (
                        <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                          <p className="text-[11px] text-amber-200/90 leading-snug">
                            Backup CSR <span className="font-medium text-amber-100">{currentBackupStickyCsr.name}</span> is also paused — sticky overflow will fall back to the open cascade.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            onClick={handleSaveRouting}
            disabled={saving || !isDirty}
            className={cn(
              "mt-4 flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium w-full justify-center transition-all",
              isDirty
                ? "bg-primary hover:bg-primary/90 text-white"
                : "bg-white/5 text-white/40 cursor-default",
              saving && "opacity-50"
            )}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : !isDirty ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saving ? "Saving..." : !isDirty ? "Saved" : (isInherited ? "Save as Override" : "Save Routing Config")}
          </button>
        </PremiumCard>

        <PremiumCard className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Calendar className="w-4 h-4 text-primary" />
            <span className="text-sm font-display text-white">CSR Schedule & Status</span>
          </div>

          {csrs.length === 0 ? (
            <div className="text-center py-12">
              <Users className="w-8 h-8 text-white/10 mx-auto mb-2" />
              <p className="text-xs text-white/30">No CSRs found</p>
            </div>
          ) : (
            <div className="space-y-2">
              {csrs.map(csr => (
                <div key={csr.id} className="p-3 rounded-lg bg-white/[0.02] border border-white/5">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium truncate">{csr.name}</p>
                      <p className="text-[10px] text-white/30 truncate">{csr.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "text-[9px] px-1.5 py-0.5 rounded font-mono uppercase",
                        csr.isPaused ? "bg-amber-500/20 text-amber-400" : "bg-emerald-500/20 text-emerald-400"
                      )}>
                        {csr.isPaused ? "paused" : "active"}
                      </span>
                      <button
                        onClick={() => {
                          if (scheduleEditId === csr.id) {
                            setScheduleEditId(null);
                          } else {
                            setScheduleEditId(csr.id);
                            setSchedPauseStart(csr.pauseStart ? new Date(csr.pauseStart).toISOString().slice(0, 16) : "");
                            setSchedPauseEnd(csr.pauseEnd ? new Date(csr.pauseEnd).toISOString().slice(0, 16) : "");
                            setSchedError("");
                          }
                        }}
                        className="p-1.5 rounded text-white/30 hover:text-white/60 hover:bg-white/5"
                        title="Schedule"
                      >
                        <Calendar className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => toggleCsrPause(csr.id, !csr.isPaused)}
                        disabled={scheduleSaving === csr.id}
                        className={cn(
                          "p-1.5 rounded transition-colors",
                          csr.isPaused
                            ? "text-emerald-400 hover:bg-emerald-500/10"
                            : "text-amber-400 hover:bg-amber-500/10"
                        )}
                      >
                        {scheduleSaving === csr.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : csr.isPaused ? (
                          <Play className="w-3.5 h-3.5" />
                        ) : (
                          <Pause className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                  {csr.isPaused && csr.pauseEnd && scheduleEditId !== csr.id && (
                    <p className="text-[10px] text-amber-400/60 mt-1">
                      Paused until {formatDateTimeInTz(csr.pauseEnd, timezone)}
                    </p>
                  )}
                  {scheduleEditId === csr.id && (
                    <div className="mt-3 pt-3 border-t border-white/5 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] text-white/30 uppercase tracking-wider">Pause Start</label>
                          <input
                            type="datetime-local"
                            value={schedPauseStart}
                            onChange={e => {
                              setSchedPauseStart(e.target.value);
                              if (schedPauseEnd && e.target.value && new Date(e.target.value) >= new Date(schedPauseEnd)) {
                                setSchedError("Start must be before end");
                              } else {
                                setSchedError("");
                              }
                            }}
                            className={cn(
                              "w-full mt-1 bg-white/5 border rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50",
                              schedError ? "border-red-500/50" : "border-white/10"
                            )}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-white/30 uppercase tracking-wider">Pause End</label>
                          <input
                            type="datetime-local"
                            value={schedPauseEnd}
                            onChange={e => {
                              setSchedPauseEnd(e.target.value);
                              if (schedPauseStart && e.target.value && new Date(schedPauseStart) >= new Date(e.target.value)) {
                                setSchedError("Start must be before end");
                              } else {
                                setSchedError("");
                              }
                            }}
                            className={cn(
                              "w-full mt-1 bg-white/5 border rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50",
                              schedError ? "border-red-500/50" : "border-white/10"
                            )}
                          />
                        </div>
                      </div>
                      {schedError && (
                        <p className="text-[10px] text-red-400 flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" /> {schedError}
                        </p>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={async () => {
                            if (schedPauseStart && schedPauseEnd && new Date(schedPauseStart) >= new Date(schedPauseEnd)) {
                              setSchedError("Start must be before end");
                              return;
                            }
                            await toggleCsrPause(
                              csr.id,
                              true,
                              schedPauseEnd ? new Date(schedPauseEnd).toISOString() : undefined,
                              schedPauseStart ? new Date(schedPauseStart).toISOString() : undefined
                            );
                            setScheduleEditId(null);
                          }}
                          disabled={scheduleSaving === csr.id || !!schedError}
                          className="flex items-center gap-1 px-3 py-1.5 rounded bg-amber-500/20 text-amber-400 text-xs font-medium hover:bg-amber-500/30 disabled:opacity-50"
                        >
                          {scheduleSaving === csr.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />}
                          Schedule Pause
                        </button>
                        {csr.isPaused && (
                          <button
                            onClick={async () => {
                              await toggleCsrPause(csr.id, false);
                              setScheduleEditId(null);
                            }}
                            disabled={scheduleSaving === csr.id}
                            className="flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-500/20 text-emerald-400 text-xs font-medium hover:bg-emerald-500/30 disabled:opacity-50"
                          >
                            <Play className="w-3 h-3" /> Resume Now
                          </button>
                        )}
                        <button
                          onClick={() => setScheduleEditId(null)}
                          className="px-2 py-1.5 text-xs text-white/40 hover:text-white/60"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </PremiumCard>
      </div>
    </div>
  );
}

function ActivityFeedTab({ activities, loading, refetch }: {
  activities: ActivityItem[];
  loading: boolean;
  refetch: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  const methodIcon = (method: string) => {
    switch (method) {
      case "call": return <Phone className="w-3.5 h-3.5" />;
      case "text": return <MessageSquare className="w-3.5 h-3.5" />;
      case "email": return <Mail className="w-3.5 h-3.5" />;
      default: return <PhoneCall className="w-3.5 h-3.5" />;
    }
  };

  const outcomeColor = (outcome: string) => {
    if (outcome === "answered" || outcome === "booked") return "text-emerald-400 bg-emerald-500/10";
    if (outcome === "no_answer") return "text-amber-400 bg-amber-500/10";
    if (outcome === "busy" || outcome === "declined") return "text-red-400 bg-red-500/10";
    return "text-white/40 bg-white/5";
  };

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">Live Activity Feed</span>
          <span className="text-[10px] text-white/20 font-mono">({activities.length} recent)</span>
        </div>
        <button
          onClick={refetch}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-white/40 hover:text-white/60 hover:bg-white/5"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {activities.length === 0 ? (
        <PremiumCard className="p-8 text-center">
          <Activity className="w-8 h-8 text-white/10 mx-auto mb-2" />
          <p className="text-xs text-white/30">No recent activity</p>
          <p className="text-[10px] text-white/20 mt-1">Call attempts will appear here in real time</p>
        </PremiumCard>
      ) : (
        <div className="space-y-1.5">
          {activities.map(a => (
            <PremiumCard key={a.id} className="p-3">
              <div className="flex items-center gap-3">
                <div className={cn("w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0", outcomeColor(a.outcome))}>
                  {methodIcon(a.method)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-white">{a.coordinatorName}</span>
                    <span className="text-[10px] text-white/20">→</span>
                    <span className="text-xs text-white/70">{a.leadName}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-mono uppercase", outcomeColor(a.outcome))}>
                      {a.outcome.replace(/_/g, " ")}
                    </span>
                    {a.leadSource && (
                      <span className="text-[9px] text-white/20">{a.leadSource}</span>
                    )}
                    {a.notes && (
                      <span className="text-[9px] text-white/15 truncate max-w-[200px]">{a.notes}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[10px] text-white/20 font-mono">{a.method}</span>
                  <span className="text-[10px] text-white/15">{timeAgo(a.attemptedAt)}</span>
                </div>
              </div>
            </PremiumCard>
          ))}
        </div>
      )}
    </div>
  );
}

function CoachingInsightsTab({ insights, loading, fetching }: {
  insights: CoachingInsight[];
  loading: boolean;
  fetching?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  const typeConfig = {
    positive: { icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20", label: "Strength" },
    warning: { icon: AlertTriangle, color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20", label: "Attention" },
    suggestion: { icon: Lightbulb, color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/20", label: "Insight" },
  };

  return (
    <div className={cn("space-y-4 transition-opacity duration-200", fetching && "opacity-70")}>
      <div className="flex items-center gap-2">
        <Brain className="w-4 h-4 text-primary" />
        <span className="text-sm font-display text-white">AI Coaching Insights</span>
        <span className="text-[10px] text-white/20 font-mono">({insights.length} observations)</span>
      </div>

      {insights.length === 0 ? (
        <PremiumCard className="p-8 text-center">
          <Brain className="w-8 h-8 text-white/10 mx-auto mb-2" />
          <p className="text-xs text-white/30">No coaching insights yet</p>
          <p className="text-[10px] text-white/20 mt-1">Insights are generated from coordinator activity data over time</p>
        </PremiumCard>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {insights.map((insight, idx) => {
            const config = typeConfig[insight.type];
            const Icon = config.icon;
            return (
              <PremiumCard key={idx} className={cn("p-4 border", config.border)}>
                <div className="flex items-start gap-3">
                  <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0", config.bg)}>
                    <Icon className={cn("w-4 h-4", config.color)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={cn("text-[9px] uppercase font-mono tracking-wider", config.color)}>{config.label}</span>
                      {insight.coordinatorName && (
                        <span className="text-[9px] text-white/20">· {insight.coordinatorName}</span>
                      )}
                    </div>
                    <p className="text-sm font-medium text-white mb-1">{insight.title}</p>
                    <p className="text-xs text-white/50 leading-relaxed">{insight.detail}</p>
                  </div>
                </div>
              </PremiumCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface SpiffConfig {
  default: number;
  byFunnel: Record<string, number>;
}

function useSpiffConfig(tenantId: number | null) {
  const [config, setConfig] = useState<SpiffConfig>({ default: 20, byFunnel: {} });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) { setConfig({ default: 20, byFunnel: {} }); setLoading(false); return; }
    fetch(`${API_BASE}/sales-manager/spiff-config?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => { if (data?.spiffConfig) setConfig(data.spiffConfig); })
      .finally(() => setLoading(false));
  }, [tenantId]);

  const saveConfig = async (newConfig: SpiffConfig) => {
    await fetch(`${API_BASE}/sales-manager/spiff-config?tenantId=${tenantId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ spiffConfig: newConfig }),
    });
    setConfig(newConfig);
  };

  return { config, loading, saveConfig };
}

function SpiffConfigSection({ tenantId, funnels }: { tenantId: number | null; funnels: FunnelType[] }) {
  const { config, loading, saveConfig } = useSpiffConfig(tenantId);
  const [defaultAmount, setDefaultAmount] = useState(20);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [newFunnel, setNewFunnel] = useState("");

  interface SpiffSavedState {
    defaultAmount: number;
    overrides: Record<string, number>;
  }
  const [lastSavedSpiff, setLastSavedSpiff] = useState<SpiffSavedState | null>(null);

  const isSpiffDirty = lastSavedSpiff !== null && (
    defaultAmount !== lastSavedSpiff.defaultAmount ||
    JSON.stringify(overrides) !== JSON.stringify(lastSavedSpiff.overrides)
  );

  useEffect(() => {
    setDefaultAmount(config.default);
    setOverrides({ ...config.byFunnel });
    setLastSavedSpiff({ defaultAmount: config.default, overrides: { ...config.byFunnel } });
  }, [config]);

  const handleSave = async () => {
    setSaving(true);
    await saveConfig({ default: defaultAmount, byFunnel: overrides });
    setLastSavedSpiff({ defaultAmount, overrides: { ...overrides } });
    setSaving(false);
  };

  const funnelNameSet = useMemo(() => new Set((funnels || []).map(f => f.name)), [funnels]);
  const availableFunnels = (funnels || []).map(f => f.name).filter(name => !(name in overrides));
  const staleKeys = Object.keys(overrides).filter(k => !funnelNameSet.has(k));

  const renameOverride = (oldKey: string, newKey: string) => {
    if (!newKey || newKey === oldKey || newKey in overrides) return;
    setOverrides(prev => {
      const next: Record<string, number> = {};
      for (const [k, v] of Object.entries(prev)) {
        next[k === oldKey ? newKey : k] = v;
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <DollarSign className="w-4 h-4 text-primary" />
        <span className="text-sm font-display text-white">Spiff Configuration</span>
      </div>

      <PremiumCard className="p-6 space-y-5">
        <div>
          <label className="block text-xs text-white/40 uppercase tracking-wider mb-1.5">Default Spiff Amount</label>
          <p className="text-[10px] text-white/30 mb-2">Applied to all bookings unless a funnel override is set below.</p>
          <div className="relative w-40">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 text-sm">$</span>
            <input
              type="text"
              inputMode="numeric"
              value={defaultAmount === 0 ? "" : String(defaultAmount)}
              onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ""); setDefaultAmount(v === "" ? 0 : Number(v)); }}
              onBlur={() => { if (defaultAmount < 0) setDefaultAmount(0); }}
              placeholder="0"
              className="w-full bg-white/5 border border-white/10 rounded-md pl-7 pr-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-white/40 uppercase tracking-wider mb-1.5">Funnel Overrides</label>
          <p className="text-[10px] text-white/30 mb-3">Set custom spiff amounts for specific funnels.</p>

          {staleKeys.length > 0 && (
            <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-200/90 leading-relaxed">
                {staleKeys.length === 1 ? "1 override points" : `${staleKeys.length} overrides point`} at a funnel that no longer exists. These commissions fall back to the default payout until you rename or remove them below.
              </p>
            </div>
          )}

          {Object.keys(overrides).length > 0 && (
            <div className="space-y-2 mb-3">
              {Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)).map(([fn, amount]) => {
                const isStale = !funnelNameSet.has(fn);
                const renameTargets = (funnels || []).map(f => f.name).filter(n => !(n in overrides));
                return (
                  <div key={fn} className={cn("flex items-center gap-2 flex-wrap", isStale && "rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5")}>
                    <div className="flex-1 min-w-0 flex items-center gap-1.5">
                      {isStale && <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />}
                      <span className={cn("text-sm truncate", isStale ? "text-amber-200" : "text-white/70")}>{fn}</span>
                      {isStale && (
                        <span className="text-[9px] uppercase tracking-wider font-mono text-amber-400/80 flex-shrink-0">Stale</span>
                      )}
                    </div>
                    {isStale && renameTargets.length > 0 && (
                      <Select
                        value="__none__"
                        onValueChange={v => { if (v !== "__none__") renameOverride(fn, v); }}
                      >
                        <SelectTrigger className="w-36 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white h-auto">
                          <SelectValue placeholder="Rename to..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Rename to...</SelectItem>
                          {renameTargets.map(n => (
                            <SelectItem key={n} value={n}>{n}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <div className="relative w-28">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40 text-xs">$</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={amount === 0 ? "" : String(amount)}
                        onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ""); setOverrides(prev => ({ ...prev, [fn]: v === "" ? 0 : Number(v) })); }}
                        placeholder="0"
                        className="w-full bg-white/5 border border-white/10 rounded-md pl-6 pr-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                      />
                    </div>
                    <button
                      onClick={() => setOverrides(prev => { const next = { ...prev }; delete next[fn]; return next; })}
                      className="text-white/30 hover:text-red-400 text-xs px-1"
                      title="Remove override"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {availableFunnels.length > 0 && (
            <div className="flex items-center gap-2">
              <Select
                value={newFunnel || "__none__"}
                onValueChange={v => setNewFunnel(v === "__none__" ? "" : v)}
              >
                <SelectTrigger className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto">
                  <SelectValue placeholder="Add funnel override..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Add funnel override...</SelectItem>
                  {availableFunnels.map(fn => (
                    <SelectItem key={fn} value={fn}>{fn}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                onClick={() => { if (newFunnel) { setOverrides(prev => ({ ...prev, [newFunnel]: defaultAmount })); setNewFunnel(""); } }}
                disabled={!newFunnel}
                className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white hover:bg-white/10 disabled:opacity-30"
              >
                Add
              </button>
            </div>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={saving || !isSpiffDirty}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all",
            isSpiffDirty
              ? "bg-primary hover:bg-primary/90 text-white"
              : "bg-white/5 text-white/40 cursor-default",
            saving && "opacity-50"
          )}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : !isSpiffDirty ? <CheckCircle2 className="w-4 h-4" /> : <DollarSign className="w-4 h-4" />}
          {saving ? "Saving..." : !isSpiffDirty ? "Saved" : "Save Spiff Settings"}
        </button>
      </PremiumCard>
    </div>
  );
}

interface MappingField {
  field: string;
  label: string;
  description: string;
}

interface AnalysisResult {
  headers: string[];
  sampleData: Record<string, string>[];
  proposedMapping: Record<string, string>;
  confidences: Record<string, number>;
  internalFields: MappingField[];
  totalRows: number;
}

function ColumnMappingReview({ configId, config, isAgency, onMappingSaved, funnels }: {
  configId: number;
  config: SheetConfig;
  isAgency: boolean;
  onMappingSaved: () => void;
  funnels: FunnelType[];
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [savedMapping, setSavedMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [headersChanged, setHeadersChanged] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [funnelColumn, setFunnelColumn] = useState<string | null>(config.funnelColumn || null);
  const [funnelValueMap, setFunnelValueMap] = useState<Record<string, number>>(config.funnelValueMap || {});
  const [savedFunnelValueMap, setSavedFunnelValueMap] = useState<Record<string, number>>(config.funnelValueMap || {});
  const [funnelRoutingExpanded, setFunnelRoutingExpanded] = useState(false);
  const [columnValues, setColumnValues] = useState<string[]>([]);
  const [loadingValues, setLoadingValues] = useState(false);
  const [savingFunnelMap, setSavingFunnelMap] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/sheet-configs/${configId}/mapping-status`, { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        if (data.headersChanged) setHeadersChanged(true);
        if (data.hasMapping && data.columnMapping) {
          setMapping(data.columnMapping);
          setSavedMapping(data.columnMapping);
        }
        if (data.funnelColumn) setFunnelColumn(data.funnelColumn);
        if (data.funnelValueMap) {
          setFunnelValueMap(data.funnelValueMap);
          setSavedFunnelValueMap(data.funnelValueMap);
        }
      })
      .catch(() => {});
  }, [configId]);

  const handleAnalyzeRef = useRef<() => void>(() => {});

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}/analyze-mapping`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Analysis failed"); return; }
      setAnalysis(data);
      setMapping(data.proposedMapping);
      setExpanded(true);
      setHeadersChanged(false);
    } catch {
      setError("Connection error during analysis");
    } finally { setAnalyzing(false); }
  }, [configId]);

  handleAnalyzeRef.current = handleAnalyze;

  useEffect(() => {
    const el = document.querySelector(`[data-mapping-config="${configId}"]`);
    if (!el) return;
    const listener = () => { handleAnalyzeRef.current(); };
    el.addEventListener("trigger-analyze", listener);
    return () => { el.removeEventListener("trigger-analyze", listener); };
  }, [configId]);

  const handleSave = async () => {
    if (!analysis) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}/save-mapping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mapping, headers: analysis.headers }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess(true);
        setHeadersChanged(false);
        setSavedMapping(mapping);
        if (data.funnelColumn) {
          setFunnelColumn(data.funnelColumn);
        } else {
          setFunnelColumn(null);
        }
        setTimeout(() => setSuccess(false), 3000);
        onMappingSaved();
      } else {
        setError(data.error || "Failed to save mapping");
      }
    } catch {
      setError("Connection error saving mapping");
    } finally { setSaving(false); }
  };

  const columnValuesReqIdRef = useRef(0);
  const loadColumnValues = useCallback(async (colName: string) => {
    const reqId = ++columnValuesReqIdRef.current;
    setLoadingValues(true);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}/column-values/${encodeURIComponent(colName)}`, { credentials: "include" });
      const data = await res.json();
      if (reqId !== columnValuesReqIdRef.current) return;
      if (res.ok) setColumnValues(data.values || []);
    } catch {
      // ignore
    } finally {
      if (reqId === columnValuesReqIdRef.current) setLoadingValues(false);
    }
  }, [configId]);

  useEffect(() => {
    if (funnelColumn) {
      loadColumnValues(funnelColumn);
    } else {
      columnValuesReqIdRef.current++;
      setColumnValues([]);
      setLoadingValues(false);
    }
  }, [funnelColumn, loadColumnValues]);

  const handleSaveFunnelMap = async () => {
    if (!funnelColumn) return;
    setSavingFunnelMap(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}/funnel-value-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ funnelColumn, funnelValueMap }),
      });
      if (res.ok) {
        setSavedFunnelValueMap({ ...funnelValueMap });
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
        onMappingSaved();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to save funnel mapping");
      }
    } catch {
      setError("Connection error saving funnel mapping");
    } finally { setSavingFunnelMap(false); }
  };

  const handleUpdateMapping = async () => {
    setSaving(true);
    setError(null);
    try {
      const headers = Object.keys(mapping);
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}/save-mapping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mapping, headers }),
      });
      if (res.ok) {
        const data = await res.json();
        setSavedMapping(mapping);
        if (data.funnelColumn) {
          setFunnelColumn(data.funnelColumn);
        }
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
        onMappingSaved();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to update mapping");
      }
    } catch {
      setError("Connection error updating mapping");
    } finally { setSaving(false); }
  };

  const handleDiscard = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}/save-mapping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mapping: null, headers: null }),
      });
      if (res.ok) {
        setAnalysis(null);
        setMapping({});
        setFunnelColumn(null);
        setFunnelValueMap({});
        setColumnValues([]);
        setExpanded(false);
        onMappingSaved();
      }
    } catch {} finally { setSaving(false); }
  };

  if (!isAgency) return null;

  const hasExistingMapping = !!config.columnMapping;
  const mappingModified = hasExistingMapping && !analysis && JSON.stringify(mapping) !== JSON.stringify(savedMapping);
  const hasExistingFunnelRouting = Object.keys(savedFunnelValueMap).length > 0;
  const funnelRoutingModified = JSON.stringify(funnelValueMap) !== JSON.stringify(savedFunnelValueMap);

  return (
    <div className="mt-3 pt-3 border-t border-white/5" data-mapping-config={configId}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wand2 className="w-3.5 h-3.5 text-violet-400" />
          <span className="text-[11px] font-medium text-white/70">Column Mapping</span>
          {hasExistingMapping && !headersChanged && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400">
              <ShieldCheck className="w-3 h-3" /> Approved
            </span>
          )}
          {headersChanged && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">
              <AlertCircle className="w-3 h-3" /> Headers Changed
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(hasExistingMapping || Object.keys(mapping).length > 0) && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-[10px] text-white/30 hover:text-white/50"
            >
              {expanded ? "Hide" : "View"} Mapping
            </button>
          )}
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className={cn(
              "flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-medium",
              headersChanged
                ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
                : "bg-violet-500/20 text-violet-400 hover:bg-violet-500/30",
              "disabled:opacity-50"
            )}
          >
            {analyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
            {hasExistingMapping ? "Re-analyze" : "Analyze with AI"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-2 px-3 py-1.5 rounded text-[10px] bg-red-500/10 text-red-400">{error}</div>
      )}

      {success && (
        <div className="mt-2 px-3 py-1.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" /> Mapping approved and saved
        </div>
      )}

      {expanded && Object.keys(mapping).length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="grid gap-1.5">
            {Object.entries(mapping).map(([header, field]) => {
              const confidence = analysis?.confidences?.[header];
              const isLowConfidence = confidence !== undefined && confidence < 0.7;
              const sampleValues = analysis?.sampleData
                ?.map(row => row[header])
                .filter(Boolean)
                .slice(0, 3) || [];
              const sourceColumnCount = Object.values(mapping).filter(f => f === "source").length;
              const isMultiSource = field === "source" && sourceColumnCount > 1;

              return (
                <div key={header} className={cn(
                  "grid grid-cols-[1fr_auto_1fr] gap-2 items-center px-3 py-2 rounded-md",
                  isLowConfidence ? "bg-amber-500/5 border border-amber-500/20" : "bg-white/[0.02] border border-white/5"
                )}>
                  <div className="min-w-0">
                    <p className="text-[11px] text-white/80 font-mono truncate">{header}</p>
                    {sampleValues.length > 0 && (
                      <p className="text-[9px] text-white/25 truncate mt-0.5">
                        e.g. {sampleValues.join(", ")}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    <ArrowUpRight className="w-3 h-3 text-white/20 rotate-90" />
                    {confidence !== undefined && (
                      <span className={cn(
                        "text-[9px] font-mono px-1.5 py-0.5 rounded",
                        confidence >= 0.9 ? "bg-emerald-500/10 text-emerald-400" :
                        confidence >= 0.7 ? "bg-blue-500/10 text-blue-400" :
                        "bg-amber-500/10 text-amber-400"
                      )}>
                        {Math.round(confidence * 100)}%
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Select
                      value={field}
                      onValueChange={v => setMapping(prev => ({ ...prev, [header]: v }))}
                    >
                      <SelectTrigger className={cn(
                        "bg-white/5 border rounded-md px-2 py-1.5 text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto w-auto min-w-[140px]",
                        field === "__skip__" ? "border-white/5 text-white/30" : "border-white/10"
                      )}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {analysis?.internalFields ? (
                          analysis.internalFields.map(f => (
                            <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>
                          ))
                        ) : (
                          <>
                            <SelectItem value="firstName">First Name</SelectItem>
                            <SelectItem value="lastName">Last Name</SelectItem>
                            <SelectItem value="fullName">Full Name</SelectItem>
                            <SelectItem value="phone">Phone</SelectItem>
                            <SelectItem value="email">Email</SelectItem>
                            <SelectItem value="source">Lead Source</SelectItem>
                            <SelectItem value="serviceType">Service Type</SelectItem>
                            <SelectItem value="__funnel__">Funnel</SelectItem>
                            <SelectItem value="status">Status</SelectItem>
                            <SelectItem value="notes">Notes</SelectItem>
                            <SelectItem value="address">Address</SelectItem>
                            <SelectItem value="city">City</SelectItem>
                            <SelectItem value="state">State</SelectItem>
                            <SelectItem value="zip">Zip Code</SelectItem>
                            <SelectItem value="dateTime">Date/Time</SelectItem>
                            <SelectItem value="appointmentBooked">Appointment Booked</SelectItem>
                            <SelectItem value="appointmentDate">Appointment Date</SelectItem>
                            <SelectItem value="appointmentTime">Appointment Time</SelectItem>
                            <SelectItem value="addOns">Add-Ons</SelectItem>
                            <SelectItem value="__skip__">Skip (Do Not Import)</SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                    {isMultiSource && (
                      <span className="text-[8px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded whitespace-nowrap">
                        multi-source
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {analysis && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-[10px] text-white/25">
                {analysis.totalRows} rows in sheet
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setAnalysis(null); setMapping({}); setExpanded(false); }}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] text-white/40 hover:text-white/60 hover:bg-white/5"
                >
                  Discard
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 text-white text-[11px] font-medium hover:bg-emerald-500 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                  Approve Mapping
                </button>
              </div>
            </div>
          )}

          {hasExistingMapping && !analysis && expanded && (
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={handleDiscard}
                disabled={saving}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[10px] text-red-400/70 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              >
                Remove Approved Mapping
              </button>
              {mappingModified && (
                <button
                  onClick={handleUpdateMapping}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 text-white text-[11px] font-medium hover:bg-emerald-500 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                  Update Mapping
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {funnelColumn && hasExistingMapping && (
        <div className="mt-3 pt-3 border-t border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shuffle className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-[11px] font-medium text-white/70">Funnel Routing</span>
              <span className="text-[9px] text-white/20 font-mono">column: {funnelColumn}</span>
            </div>
            <button
              onClick={() => setFunnelRoutingExpanded(!funnelRoutingExpanded)}
              className="text-[10px] text-white/30 hover:text-white/50"
            >
              {funnelRoutingExpanded ? "Hide" : "View"} Routing
            </button>
          </div>

          {funnelRoutingExpanded && (
            <div className="mt-3">
              <p className="text-[10px] text-white/25 mb-3">Map each value in the &quot;{funnelColumn}&quot; column to the funnel it should route to.</p>

              {loadingValues ? (
                <div className="flex items-center gap-2 py-2">
                  <Loader2 className="w-3 h-3 animate-spin text-white/30" />
                  <span className="text-[10px] text-white/30">Loading column values...</span>
                </div>
              ) : columnValues.length === 0 ? (
                <p className="text-[10px] text-white/20 py-2">No values found in the funnel column</p>
              ) : (
                <div className="space-y-1.5">
                  {columnValues.map(val => (
                    <div key={val} className="grid grid-cols-[minmax(0,1fr)_auto_180px] items-center gap-2 px-3 py-1.5 rounded bg-white/[0.02] border border-white/5">
                      <span className="text-[11px] text-white/70 font-mono truncate">{val}</span>
                      <ArrowUpRight className="w-3 h-3 text-white/20 rotate-90 flex-shrink-0" />
                      <Select
                        value={funnelValueMap[val] != null ? String(funnelValueMap[val]) : "__none__"}
                        onValueChange={v => {
                          setFunnelValueMap(prev => {
                            if (v === "__none__") { const next = { ...prev }; delete next[val]; return next; }
                            return { ...prev, [val]: Number(v) };
                          });
                        }}
                      >
                        <SelectTrigger className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto [&>span]:truncate">
                          <SelectValue placeholder="-- Select Funnel --" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">-- Select Funnel --</SelectItem>
                          {funnels.map(f => (
                            <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              )}

              {!hasExistingFunnelRouting && (
                <button
                  onClick={handleSaveFunnelMap}
                  disabled={savingFunnelMap || columnValues.length === 0}
                  className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-500 disabled:opacity-50"
                >
                  {savingFunnelMap ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save Funnel Routing
                </button>
              )}

              {hasExistingFunnelRouting && funnelRoutingModified && (
                <button
                  onClick={handleSaveFunnelMap}
                  disabled={savingFunnelMap || columnValues.length === 0}
                  className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 text-white text-[11px] font-medium hover:bg-emerald-500 disabled:opacity-50"
                >
                  {savingFunnelMap ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                  Update Funnel Routing
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function useSheetConfigs(tenantId: number | null) {
  const [configs, setConfigs] = useState<SheetConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConfigs = useCallback(async () => {
    if (!tenantId) { setConfigs([]); setLoading(false); return; }
    try {
      const res = await fetch(`${API_BASE}/tenants/${tenantId}/sheet-configs`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setConfigs(data);
      }
    } catch {} finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  return { configs, loading, refetch: fetchConfigs };
}

function GoogleSheetConfigSection({ tenantId, funnels, onRefetch }: { tenantId: number | null; funnels: FunnelType[]; onRefetch: () => void }) {
  const { isAgency } = useAuth();
  const { configs, loading: configsLoading, refetch: refetchConfigs } = useSheetConfigs(tenantId);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSheetId, setNewSheetId] = useState("");
  const [newSheetTab, setNewSheetTab] = useState("Sheet1");
  const [newDefaultFunnel, setNewDefaultFunnel] = useState<number | "">("");
  const [editSheetId, setEditSheetId] = useState("");
  const [editSheetTab, setEditSheetTab] = useState("");
  const [editName, setEditName] = useState("");
  const [editDefaultFunnel, setEditDefaultFunnel] = useState<number | "">("");
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [ingesting, setIngesting] = useState<number | null>(null);
  const [backfilling, setBackfilling] = useState<number | null>(null);
  const [ingestResult, setIngestResult] = useState<{ configId: number; msg: string; type: "success" | "error" } | null>(null);
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [previewData, setPreviewData] = useState<{ configId: number; rows: Record<string, string>[]; columns: string[] } | null>(null);
  const [togglingPause, setTogglingPause] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [sectionExpanded, setSectionExpanded] = useState(false);
  const [unroutedOpenId, setUnroutedOpenId] = useState<number | null>(null);
  const [unroutedRows, setUnroutedRows] = useState<UnroutedSheetRow[] | null>(null);
  const [unroutedLoading, setUnroutedLoading] = useState(false);
  const [resolvingUnroutedId, setResolvingUnroutedId] = useState<number | null>(null);
  const [routingUnroutedId, setRoutingUnroutedId] = useState<number | null>(null);
  const [unroutedFunnelChoice, setUnroutedFunnelChoice] = useState<Record<number, number | "">>({});
  const [unroutedAddToMap, setUnroutedAddToMap] = useState<Record<number, boolean>>({});
  const [unroutedError, setUnroutedError] = useState<{ rowId: number; msg: string } | null>(null);

  const loadUnroutedRows = useCallback(async (configId: number) => {
    if (!tenantId) return;
    setUnroutedLoading(true);
    setUnroutedRows(null);
    try {
      const res = await fetch(
        `${API_BASE}/tenants/${tenantId}/unrouted-sheet-rows?sheetConfigId=${configId}`,
        { credentials: "include" },
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setUnroutedRows(data);
      }
    } catch {} finally { setUnroutedLoading(false); }
  }, [tenantId]);

  const handleToggleUnrouted = (configId: number) => {
    if (unroutedOpenId === configId) {
      setUnroutedOpenId(null);
      setUnroutedRows(null);
    } else {
      setUnroutedOpenId(configId);
      loadUnroutedRows(configId);
    }
  };

  const handleResolveUnrouted = async (rowId: number, configId: number) => {
    setResolvingUnroutedId(rowId);
    try {
      const res = await fetch(`${API_BASE}/unrouted-sheet-rows/${rowId}/resolve`, {
        method: "POST", credentials: "include",
      });
      if (res.ok) {
        await loadUnroutedRows(configId);
        handleRefetch();
      }
    } catch {} finally { setResolvingUnroutedId(null); }
  };

  const handleRouteUnroutedToFunnel = async (rowId: number, configId: number) => {
    const funnelId = unroutedFunnelChoice[rowId];
    if (!funnelId) {
      setUnroutedError({ rowId, msg: "Pick a funnel first" });
      return;
    }
    setRoutingUnroutedId(rowId);
    setUnroutedError(null);
    try {
      const res = await fetch(`${API_BASE}/unrouted-sheet-rows/${rowId}/route-to-funnel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          funnelId,
          addToValueMap: !!unroutedAddToMap[rowId],
        }),
      });
      if (res.ok) {
        await loadUnroutedRows(configId);
        handleRefetch();
      } else {
        const data = await res.json().catch(() => ({ error: "Failed to send to funnel" }));
        setUnroutedError({ rowId, msg: data.error || "Failed to send to funnel" });
      }
    } catch {
      setUnroutedError({ rowId, msg: "Connection error" });
    } finally { setRoutingUnroutedId(null); }
  };

  const handleRefetch = () => { refetchConfigs(); onRefetch(); };

  const startEdit = (cfg: SheetConfig) => {
    setEditingId(cfg.id);
    setEditSheetId(cfg.googleSheetId);
    setEditSheetTab(cfg.googleSheetTab);
    setEditName(cfg.name);
    setEditDefaultFunnel(cfg.defaultFunnelTypeId || "");
  };

  const handleCreate = async () => {
    if (!tenantId || !newName || !newSheetId) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/tenants/${tenantId}/sheet-configs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: newName,
          googleSheetId: newSheetId,
          googleSheetTab: newSheetTab || "Sheet1",
          defaultFunnelTypeId: newDefaultFunnel || null,
        }),
      });
      if (res.ok) {
        setCreating(false);
        setNewName("");
        setNewSheetId("");
        setNewSheetTab("Sheet1");
        setNewDefaultFunnel("");
        handleRefetch();
      } else {
        const err = await res.json().catch(() => ({ error: "Create failed" }));
        alert(err.error || "Failed to create sheet config");
      }
    } catch {
      alert("Connection error creating sheet config");
    } finally { setSaving(false); }
  };

  const handleSaveEdit = async (configId: number) => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: editName,
          googleSheetId: editSheetId,
          googleSheetTab: editSheetTab,
          defaultFunnelTypeId: editDefaultFunnel || null,
        }),
      });
      if (res.ok) {
        setSavedId(configId);
        setTimeout(() => setSavedId(null), 2000);
        setEditingId(null);
        handleRefetch();
      } else {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        alert(err.error || "Failed to save sheet config");
      }
    } catch {
      alert("Connection error saving sheet config");
    } finally { setSaving(false); }
  };

  const handleDelete = async (configId: number) => {
    if (!confirm("Delete this sheet configuration? This cannot be undone.")) return;
    setDeleting(configId);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) handleRefetch();
      else alert("Failed to delete sheet config");
    } catch {
      alert("Connection error");
    } finally { setDeleting(null); }
  };

  const handleIngest = async (configId: number) => {
    setIngesting(configId);
    setIngestResult(null);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}/ingest`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok) {
        setIngestResult({ configId, msg: `Imported ${data.imported} leads, ${data.skipped} skipped${data.noFunnelSkipped ? ` (${data.noFunnelSkipped} no funnel match)` : ""}`, type: "success" });
      } else if (res.status === 409 && data.headersChanged) {
        setIngestResult({ configId, msg: "Sheet headers have changed — re-analyze column mapping.", type: "error" });
        if (isAgency) triggerAnalysis(configId);
      } else if (data.mappingRequired) {
        setIngestResult({ configId, msg: "Column mapping must be analyzed and approved before importing.", type: "error" });
        if (isAgency) triggerAnalysis(configId);
      } else {
        setIngestResult({ configId, msg: data.error || "Ingest failed", type: "error" });
      }
    } catch {
      setIngestResult({ configId, msg: "Connection error", type: "error" });
    } finally { setIngesting(null); }
  };

  const handlePreview = async (configId: number) => {
    setPreviewing(configId);
    setPreviewData(null);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}/preview`, {
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok) {
        setPreviewData({ configId, rows: data.sampleRows || [], columns: data.headers || [] });
        if (isAgency && (!data.hasMapping || data.headersChanged)) {
          triggerAnalysis(configId);
        }
      } else {
        setIngestResult({ configId, msg: data.error || "Preview failed", type: "error" });
      }
    } catch {
      setIngestResult({ configId, msg: "Connection error during preview", type: "error" });
    } finally { setPreviewing(null); }
  };

  const handleTogglePause = async (configId: number) => {
    setTogglingPause(configId);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}/toggle-sync-pause`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        handleRefetch();
      } else {
        const data = await res.json().catch(() => ({ error: "Toggle failed" }));
        alert(data.error || "Failed to toggle sync pause");
      }
    } catch {
      alert("Connection error");
    } finally { setTogglingPause(null); }
  };

  const triggerAnalysis = (configId: number) => {
    const mappingRef = document.querySelector(`[data-mapping-config="${configId}"]`);
    if (mappingRef) {
      mappingRef.dispatchEvent(new CustomEvent("trigger-analyze"));
    }
  };

  if (configsLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-0">
      <div
        className="flex items-center justify-between cursor-pointer rounded-lg px-4 py-3 bg-white/[0.02] border border-white/10 hover:bg-white/[0.04] transition-colors"
        onClick={() => setSectionExpanded(prev => !prev)}
      >
        <div className="flex items-center gap-2">
          {sectionExpanded ? (
            <ChevronUp className="w-4 h-4 text-white/40" />
          ) : (
            <ChevronDown className="w-4 h-4 text-white/40" />
          )}
          <Table2 className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">Google Sheet Configurations</span>
          <span className="text-[10px] text-white/30 bg-white/5 px-1.5 py-0.5 rounded">
            {configs.length} sheet{configs.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {sectionExpanded && (
      <div className="space-y-4 pt-4">
      {isAgency && (
        <div className="flex justify-end">
          <button
            onClick={() => setCreating(!creating)}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-primary/20 text-primary text-xs font-medium hover:bg-primary/30"
          >
            {creating ? "Cancel" : "+ Add Sheet"}
          </button>
        </div>
      )}

      {creating && (
        <PremiumCard className="p-4 space-y-3">
          <div>
            <label className="text-[10px] text-white/30 uppercase tracking-wider">Config Name</label>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. Main Lead Sheet"
              className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-xs text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-white/30 uppercase tracking-wider">Google Sheet URL or ID</label>
              <input
                value={newSheetId}
                onChange={e => {
                  const val = e.target.value.trim();
                  const urlMatch = val.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
                  setNewSheetId(urlMatch ? urlMatch[1] : val);
                }}
                placeholder="Paste a Google Sheets URL or sheet ID"
                className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-xs text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] text-white/30 uppercase tracking-wider">Tab Name</label>
              <input
                value={newSheetTab}
                onChange={e => setNewSheetTab(e.target.value)}
                placeholder="e.g. Sheet1"
                className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-xs text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-white/30 uppercase tracking-wider">Default Funnel (fallback)</label>
            <Select
              value={newDefaultFunnel ? String(newDefaultFunnel) : "__none__"}
              onValueChange={v => setNewDefaultFunnel(v === "__none__" ? "" : Number(v))}
            >
              <SelectTrigger className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto">
                <SelectValue placeholder="-- No default (require funnel routing) --" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">-- No default (require funnel routing) --</SelectItem>
                {funnels.map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <button
            onClick={handleCreate}
            disabled={saving || !newName || !newSheetId}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-primary text-white text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Create Sheet Config
          </button>
        </PremiumCard>
      )}

      {configs.length === 0 && !creating && (
        <PremiumCard className="p-4">
          <p className="text-xs text-white/30">No sheet configurations yet. Click "+ Add Sheet" to connect a Google Sheet.</p>
        </PremiumCard>
      )}

      <div className="space-y-2">
        {configs.map(cfg => (
          <PremiumCard key={cfg.id} className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-medium">{cfg.name}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <Link2 className="w-3 h-3 text-emerald-400" />
                  <a href={`https://docs.google.com/spreadsheets/d/${cfg.googleSheetId}`} target="_blank" rel="noopener noreferrer" className="text-[10px] text-emerald-400/70 font-mono truncate max-w-[200px] hover:text-emerald-400 hover:underline transition-colors">{cfg.googleSheetId}</a>
                  <span className="text-[10px] text-white/30">tab: {cfg.googleSheetTab}</span>
                  {cfg.defaultFunnel && (
                    <span className="text-[10px] text-blue-400/70 bg-blue-500/10 px-1.5 py-0.5 rounded">
                      Default: {cfg.defaultFunnel.name}
                    </span>
                  )}
                  {cfg.funnelColumn && (
                    <span className="text-[10px] text-violet-400/70 bg-violet-500/10 px-1.5 py-0.5 rounded">
                      Routes by: {cfg.funnelColumn}
                    </span>
                  )}
                  {(cfg.unroutedCount || 0) > 0 && (
                    <button
                      onClick={() => handleToggleUnrouted(cfg.id)}
                      className="text-[10px] text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 px-1.5 py-0.5 rounded border border-amber-500/30"
                      title="Rows that arrived without a matching funnel and were not imported"
                    >
                      ⚠ {cfg.unroutedCount} unrouted lead{cfg.unroutedCount === 1 ? "" : "s"}
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={() => handlePreview(cfg.id)}
                  disabled={previewing === cfg.id}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50"
                >
                  {previewing === cfg.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                  Preview
                </button>
                <button
                  onClick={() => handleIngest(cfg.id)}
                  disabled={ingesting === cfg.id}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-blue-400 hover:bg-blue-500/10 disabled:opacity-50"
                >
                  {ingesting === cfg.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Import
                </button>
                <button
                  onClick={async () => {
                    setBackfilling(cfg.id);
                    try {
                      const r = await fetch(`${API_BASE}/sheet-configs/${cfg.id}/backfill-notes`, {
                        method: "POST", credentials: "include",
                      });
                      const data = await r.json();
                      if (r.ok) {
                        setIngestResult({ configId: cfg.id, msg: `Updated notes for ${data.updated} lead(s)`, type: "success" });
                      } else {
                        setIngestResult({ configId: cfg.id, msg: data.error || "Backfill failed", type: "error" });
                      }
                    } catch {
                      setIngestResult({ configId: cfg.id, msg: "Connection error", type: "error" });
                    } finally { setBackfilling(null); }
                  }}
                  disabled={backfilling === cfg.id}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-purple-400 hover:bg-purple-500/10 disabled:opacity-50"
                >
                  {backfilling === cfg.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
                  Notes
                </button>
                <button
                  onClick={() => handleTogglePause(cfg.id)}
                  disabled={togglingPause === cfg.id}
                  className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded text-[10px] disabled:opacity-50",
                    cfg.syncPaused
                      ? "text-yellow-400 hover:bg-yellow-500/10"
                      : "text-emerald-400 hover:bg-emerald-500/10"
                  )}
                  title={cfg.syncPaused ? "Auto-sync is paused — click to resume" : "Auto-sync is active — click to pause"}
                >
                  {togglingPause === cfg.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : cfg.syncPaused ? (
                    <Play className="w-3 h-3" />
                  ) : (
                    <Pause className="w-3 h-3" />
                  )}
                  {cfg.syncPaused ? "Paused" : "Syncing"}
                </button>
                {isAgency && (
                  <>
                    <button
                      onClick={() => editingId === cfg.id ? setEditingId(null) : startEdit(cfg)}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-white/40 hover:text-white/60 hover:bg-white/5"
                    >
                      {savedId === cfg.id ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <SettingsIcon className="w-3 h-3" />}
                      {savedId === cfg.id ? "Saved" : "Edit"}
                    </button>
                    <button
                      onClick={() => handleDelete(cfg.id)}
                      disabled={deleting === cfg.id}
                      className="px-2 py-1 rounded text-[10px] text-red-400/50 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {deleting === cfg.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Del"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {ingestResult?.configId === cfg.id && (
              <div className={cn(
                "mt-2 px-3 py-1.5 rounded text-[10px]",
                ingestResult.type === "success" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
              )}>
                {ingestResult.msg}
              </div>
            )}

            {previewData?.configId === cfg.id && (
              <div className="mt-3 pt-3 border-t border-white/5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider">Sheet Preview ({previewData.rows.length} rows)</p>
                  <button onClick={() => setPreviewData(null)} className="text-[10px] text-white/30 hover:text-white/50">Close</button>
                </div>
                {previewData.rows.length === 0 ? (
                  <p className="text-xs text-white/20 py-2">No data rows found</p>
                ) : (
                  <div className="overflow-x-auto max-h-40">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="border-b border-white/5">
                          {previewData.columns.map(col => (
                            <th key={col} className="text-left py-1 px-2 text-white/30 font-mono">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewData.rows.slice(0, 5).map((row, i) => (
                          <tr key={i} className="border-b border-white/[0.03]">
                            {previewData.columns.map(col => (
                              <td key={col} className="py-1 px-2 text-white/50 truncate max-w-[150px]">{row[col] || ""}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {unroutedOpenId === cfg.id && (
              <div className="mt-3 pt-3 border-t border-white/5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] text-amber-300 uppercase tracking-wider">
                    Unrouted Leads {unroutedRows ? `(${unroutedRows.length})` : ""}
                  </p>
                  <button
                    onClick={() => handleToggleUnrouted(cfg.id)}
                    className="text-[10px] text-white/30 hover:text-white/50"
                  >
                    Close
                  </button>
                </div>
                <p className="text-[10px] text-white/40 mb-2">
                  These rows arrived without a value matching the funnel routing map and have no default funnel configured, so they were NOT imported as leads. Map the unmatched value (Settings → Funnel Routing) or set a default funnel, then re-import; dismiss rows you've handled.
                </p>
                {unroutedLoading ? (
                  <div className="flex items-center gap-2 py-3 text-[10px] text-white/40">
                    <Loader2 className="w-3 h-3 animate-spin" /> Loading unrouted rows…
                  </div>
                ) : !unroutedRows || unroutedRows.length === 0 ? (
                  <p className="text-xs text-white/30 py-2">No unrouted rows.</p>
                ) : (
                  <div className="overflow-x-auto max-h-60 border border-amber-500/20 rounded">
                    <table className="w-full text-[10px]">
                      <thead className="bg-amber-500/5">
                        <tr className="border-b border-amber-500/20">
                          <th className="text-left py-1 px-2 text-amber-300/70">Received</th>
                          <th className="text-left py-1 px-2 text-amber-300/70">Unmatched value</th>
                          <th className="text-left py-1 px-2 text-amber-300/70">Row data</th>
                          <th className="text-right py-1 px-2 text-amber-300/70">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unroutedRows.map(r => (
                          <tr key={r.id} className="border-b border-white/[0.03] align-top">
                            <td className="py-1 px-2 text-white/50 whitespace-nowrap">
                              {new Date(r.createdAt).toLocaleString()}
                            </td>
                            <td className="py-1 px-2 text-amber-300/90 font-mono">
                              {r.unmatchedValue || <span className="text-white/30 italic">(empty)</span>}
                              {r.funnelColumn && (
                                <span className="ml-1 text-white/30">in “{r.funnelColumn}”</span>
                              )}
                            </td>
                            <td className="py-1 px-2 text-white/50 font-mono max-w-[400px]">
                              <pre className="whitespace-pre-wrap break-words text-[10px]">
                                {Object.entries(r.rowData)
                                  .filter(([, v]) => v && String(v).trim())
                                  .map(([k, v]) => `${k}: ${v}`)
                                  .join("\n")}
                              </pre>
                            </td>
                            <td className="py-1 px-2 text-right align-top">
                              {isAgency && (
                                <div className="flex flex-col items-end gap-1 min-w-[180px]">
                                  <Select
                                    value={unroutedFunnelChoice[r.id] ? String(unroutedFunnelChoice[r.id]) : "__none__"}
                                    onValueChange={v => {
                                      const next = v === "__none__" ? "" : Number(v);
                                      setUnroutedFunnelChoice(prev => ({ ...prev, [r.id]: next }));
                                      setUnroutedError(prev => prev?.rowId === r.id ? null : prev);
                                    }}
                                  >
                                    <SelectTrigger className="h-7 w-full bg-white/5 border border-white/10 rounded px-2 text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-primary/50">
                                      <SelectValue placeholder="Send to funnel…" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__none__">Send to funnel…</SelectItem>
                                      {funnels.filter(f => f.isActive).map(f => (
                                        <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {r.funnelColumn && r.unmatchedValue && (
                                    <label className="flex items-center gap-1 text-[10px] text-white/50 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={!!unroutedAddToMap[r.id]}
                                        onChange={e => setUnroutedAddToMap(prev => ({ ...prev, [r.id]: e.target.checked }))}
                                        className="h-3 w-3 accent-primary"
                                      />
                                      Also map “{r.unmatchedValue}” → funnel
                                    </label>
                                  )}
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => handleRouteUnroutedToFunnel(r.id, cfg.id)}
                                      disabled={routingUnroutedId === r.id || !unroutedFunnelChoice[r.id]}
                                      className="text-[10px] text-emerald-400 hover:text-emerald-300 disabled:opacity-40 disabled:hover:text-emerald-400"
                                    >
                                      {routingUnroutedId === r.id ? "Sending…" : "Send →"}
                                    </button>
                                    <span className="text-white/20">·</span>
                                    <button
                                      onClick={() => handleResolveUnrouted(r.id, cfg.id)}
                                      disabled={resolvingUnroutedId === r.id || routingUnroutedId === r.id}
                                      className="text-[10px] text-white/40 hover:text-white/60 disabled:opacity-50"
                                    >
                                      {resolvingUnroutedId === r.id ? "…" : "Dismiss"}
                                    </button>
                                  </div>
                                  {unroutedError?.rowId === r.id && (
                                    <span className="text-[10px] text-red-400 max-w-[200px] text-right">{unroutedError.msg}</span>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {editingId === cfg.id && (
              <div className="mt-3 pt-3 border-t border-white/5 space-y-3">
                <div>
                  <label className="text-[10px] text-white/30 uppercase tracking-wider">Config Name</label>
                  <input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-xs text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-white/30 uppercase tracking-wider">Google Sheet URL or ID</label>
                    <input
                      value={editSheetId}
                      onChange={e => {
                        const val = e.target.value.trim();
                        const urlMatch = val.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
                        setEditSheetId(urlMatch ? urlMatch[1] : val);
                      }}
                      placeholder="Paste a Google Sheets URL or sheet ID"
                      className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-xs text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-white/30 uppercase tracking-wider">Tab Name</label>
                    <input
                      value={editSheetTab}
                      onChange={e => setEditSheetTab(e.target.value)}
                      placeholder="e.g. Sheet1"
                      className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-xs text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-white/30 uppercase tracking-wider">Default Funnel (fallback)</label>
                  <Select
                    value={editDefaultFunnel ? String(editDefaultFunnel) : "__none__"}
                    onValueChange={v => setEditDefaultFunnel(v === "__none__" ? "" : Number(v))}
                  >
                    <SelectTrigger className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto">
                      <SelectValue placeholder="-- No default (require funnel routing) --" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">-- No default (require funnel routing) --</SelectItem>
                      {funnels.map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleSaveEdit(cfg.id)}
                    disabled={saving}
                    className="flex items-center gap-1 px-3 py-1.5 rounded bg-primary text-white text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                    Save
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="px-3 py-1.5 rounded text-xs text-white/40 hover:text-white/60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <ColumnMappingReview
              configId={cfg.id}
              config={cfg}
              isAgency={!!isAgency}
              onMappingSaved={handleRefetch}
              funnels={funnels}
            />
          </PremiumCard>
        ))}
      </div>
      </div>
      )}
    </div>
  );
}

interface AliasGroup {
  canonicalName: string;
  aliases: { id: number; alias: string }[];
}

function OldLeadThresholdSection({ tenantId }: { tenantId: number | null }) {
  const [value, setValue] = useState<number>(5);
  const [savedValue, setSavedValue] = useState<number>(5);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) { setLoading(false); setError(null); return; }
    let cancelled = false;
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/sales-manager/old-lead-threshold?tenantId=${tenantId}`, { credentials: "include" });
        if (!res.ok) {
          if (cancelled) return;
          if (res.status === 401) {
            setError("Your session expired. Please sign in again.");
          } else if (res.status === 403) {
            setError("You don't have permission to view this setting.");
          } else {
            setError("Couldn't load the current threshold. Showing default (5).");
          }
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        const v = typeof data?.oldLeadThreshold === "number" ? data.oldLeadThreshold : 5;
        setValue(v);
        setSavedValue(v);
      } catch {
        if (!cancelled) setError("Couldn't load the current threshold. Showing default (5).");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  const isDirty = value !== savedValue;
  const isValid = Number.isInteger(value) && value >= 1 && value <= 50;

  const handleSave = async () => {
    if (!tenantId || !isValid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/sales-manager/old-lead-threshold?tenantId=${tenantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ oldLeadThreshold: value }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          setError("Your session expired. Please sign in again.");
        } else if (res.status === 403) {
          setError("You don't have permission to change this setting.");
        } else {
          const data = await res.json().catch(() => ({}));
          setError(data?.error || "Failed to save");
        }
      } else {
        const data = await res.json();
        const v = typeof data?.oldLeadThreshold === "number" ? data.oldLeadThreshold : value;
        setValue(v);
        setSavedValue(v);
      }
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 text-primary animate-spin" />
      </div>
    );
  }

  if (!tenantId) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">Old Lead Threshold</span>
        </div>
        <PremiumCard className="p-6">
          <p className="text-xs text-white/40">Select a tenant to view this setting.</p>
        </PremiumCard>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-primary" />
        <span className="text-sm font-display text-white">Old Lead Threshold</span>
      </div>

      <PremiumCard className="p-6 space-y-5">
        <div>
          <label className="block text-xs text-white/40 uppercase tracking-wider mb-1.5">Touchpoints Before Old</label>
          <p className="text-[10px] text-white/30 mb-2">
            Number of unresponsive touchpoints before a lead moves into the "old" list. Defaults to 5. Applies to newly logged touchpoints only.
          </p>
          <div className="w-40">
            <input
              type="text"
              inputMode="numeric"
              value={value === 0 ? "" : String(value)}
              onChange={e => {
                const v = e.target.value.replace(/[^0-9]/g, "");
                setValue(v === "" ? 0 : Number(v));
              }}
              placeholder="5"
              className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          {!isValid && (
            <p className="text-[10px] text-red-400 mt-1.5">Enter a whole number between 1 and 50.</p>
          )}
          {error && (
            <p className="text-[10px] text-red-400 mt-1.5">{error}</p>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={saving || !isDirty || !isValid}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all",
            isDirty && isValid
              ? "bg-primary hover:bg-primary/90 text-white"
              : "bg-white/5 text-white/40 cursor-default",
            saving && "opacity-50"
          )}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : !isDirty ? <CheckCircle2 className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
          {saving ? "Saving..." : !isDirty ? "Saved" : "Save Threshold"}
        </button>
      </PremiumCard>
    </div>
  );
}

function LeadSourceAliasSection({ tenantId }: { tenantId: number | null }) {
  const [groups, setGroups] = useState<AliasGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [newCanonical, setNewCanonical] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [addAliasText, setAddAliasText] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [editingAlias, setEditingAlias] = useState<{ id: number; value: string } | null>(null);
  const [editingCanonical, setEditingCanonical] = useState<{ oldName: string; value: string } | null>(null);
  const [sectionExpanded, setSectionExpanded] = useState(false);

  const fetchAliases = useCallback(async () => {
    if (!tenantId) { setGroups([]); setLoading(false); return; }
    try {
      const url = `${API_BASE}/lead-source-aliases?tenantId=${tenantId}`;
      const res = await fetch(url, { credentials: "include" });
      const data = await res.json();
      setGroups(data.aliases || []);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { fetchAliases(); }, [fetchAliases]);

  const toggleGroup = (name: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleAddCanonical = async () => {
    if (!tenantId || !newCanonical.trim() || !newAlias.trim()) return;
    setSaving(true);
    try {
      await fetch(`${API_BASE}/lead-source-aliases?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ canonicalName: newCanonical.trim(), alias: newAlias.trim() }),
      });
      setNewCanonical("");
      setNewAlias("");
      await fetchAliases();
    } catch {
    } finally {
      setSaving(false);
    }
  };

  const handleAddAlias = async (canonicalName: string) => {
    if (!tenantId || !addAliasText.trim()) return;
    setSaving(true);
    try {
      await fetch(`${API_BASE}/lead-source-aliases?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ canonicalName, alias: addAliasText.trim() }),
      });
      setAddAliasText("");
      setAddingTo(null);
      await fetchAliases();
    } catch {
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAlias = async (id: number) => {
    if (!tenantId) return;
    try {
      await fetch(`${API_BASE}/lead-source-aliases/${id}?tenantId=${tenantId}`, {
        method: "DELETE",
        credentials: "include",
      });
      await fetchAliases();
    } catch {
    }
  };

  const handleDeleteCanonical = async (canonicalName: string) => {
    if (!tenantId) return;
    try {
      await fetch(`${API_BASE}/lead-source-aliases/canonical/${encodeURIComponent(canonicalName)}?tenantId=${tenantId}`, {
        method: "DELETE",
        credentials: "include",
      });
      await fetchAliases();
    } catch {
    }
  };

  const handleEditAlias = async (id: number, newAlias: string) => {
    if (!tenantId || !newAlias.trim()) return;
    setSaving(true);
    try {
      await fetch(`${API_BASE}/lead-source-aliases/${id}?tenantId=${tenantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ alias: newAlias.trim() }),
      });
      setEditingAlias(null);
      await fetchAliases();
    } catch {
    } finally {
      setSaving(false);
    }
  };

  const handleEditCanonical = async (oldName: string, newName: string) => {
    if (!tenantId || !newName.trim() || newName.trim() === oldName) {
      setEditingCanonical(null);
      return;
    }
    setSaving(true);
    try {
      const group = groups.find(g => g.canonicalName === oldName);
      if (group) {
        for (const a of group.aliases) {
          await fetch(`${API_BASE}/lead-source-aliases/${a.id}?tenantId=${tenantId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ canonicalName: newName.trim() }),
          });
        }
      }
      setEditingCanonical(null);
      await fetchAliases();
    } catch {
    } finally {
      setSaving(false);
    }
  };

  const handleLoadDefaults = async () => {
    if (!tenantId) return;
    setLoadingDefaults(true);
    try {
      const res = await fetch(`${API_BASE}/lead-source-aliases/load-defaults?tenantId=${tenantId}`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (data.created > 0) await fetchAliases();
    } catch {
    } finally {
      setLoadingDefaults(false);
    }
  };

  const handleBackfill = async () => {
    if (!tenantId) return;
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const res = await fetch(`${API_BASE}/lead-source-aliases/backfill?tenantId=${tenantId}`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      setBackfillResult(`Updated ${data.updated} of ${data.totalLeads} leads`);
      setTimeout(() => setBackfillResult(null), 5000);
    } catch {
    } finally {
      setBackfilling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-0">
      <div
        className="flex items-center justify-between cursor-pointer rounded-lg px-4 py-3 bg-white/[0.02] border border-white/10 hover:bg-white/[0.04] transition-colors"
        onClick={() => setSectionExpanded(prev => !prev)}
      >
        <div className="flex items-center gap-2">
          {sectionExpanded ? (
            <ChevronUp className="w-4 h-4 text-white/40" />
          ) : (
            <ChevronDown className="w-4 h-4 text-white/40" />
          )}
          <Shuffle className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">Lead Source Aliases</span>
          <span className="text-[10px] text-white/30 bg-white/5 px-1.5 py-0.5 rounded">
            {groups.length} source{groups.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {sectionExpanded && (
      <div className="space-y-4 pt-4">
      <div className="flex items-center justify-end gap-2">
          <button
            onClick={handleBackfill}
            disabled={backfilling || groups.length === 0}
            className="flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 disabled:opacity-30"
          >
            {backfilling ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Apply to Existing Leads
          </button>
          <button
            onClick={handleLoadDefaults}
            disabled={loadingDefaults}
            className="flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 disabled:opacity-30"
          >
            {loadingDefaults ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
            Load Defaults
          </button>
        </div>

      {backfillResult && (
        <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-xs text-emerald-300">{backfillResult}</span>
        </div>
      )}

      <PremiumCard className="p-5 space-y-4">
        <p className="text-[10px] text-white/30">
          Map variations of lead source names to a single canonical name. All new leads will be normalized automatically.
        </p>

        {groups.length > 0 && (
          <div className="space-y-2">
            {groups.map(group => (
              <div key={group.canonicalName} className="bg-white/5 rounded-lg border border-white/10 overflow-hidden">
                <div
                  className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-white/5"
                  onClick={() => toggleGroup(group.canonicalName)}
                >
                  <div className="flex items-center gap-2">
                    {expandedGroups.has(group.canonicalName) ? (
                      <ChevronUp className="w-3.5 h-3.5 text-white/40" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-white/40" />
                    )}
                    {editingCanonical?.oldName === group.canonicalName ? (
                      <input
                        type="text"
                        value={editingCanonical.value}
                        onChange={e => setEditingCanonical({ ...editingCanonical, value: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === "Enter") handleEditCanonical(group.canonicalName, editingCanonical.value);
                          if (e.key === "Escape") setEditingCanonical(null);
                        }}
                        onBlur={() => handleEditCanonical(group.canonicalName, editingCanonical.value)}
                        onClick={e => e.stopPropagation()}
                        className="bg-white/5 border border-primary/50 rounded px-2 py-0.5 text-sm font-medium text-white focus:outline-none focus:ring-1 focus:ring-primary/50 w-32"
                        autoFocus
                      />
                    ) : (
                      <span
                        className="text-sm font-medium text-white cursor-text hover:text-primary/80"
                        onDoubleClick={e => { e.stopPropagation(); setEditingCanonical({ oldName: group.canonicalName, value: group.canonicalName }); }}
                        title="Double-click to edit"
                      >
                        {group.canonicalName}
                      </span>
                    )}
                    <span className="text-[10px] text-white/30 bg-white/5 px-1.5 py-0.5 rounded">
                      {group.aliases.length} alias{group.aliases.length !== 1 ? "es" : ""}
                    </span>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handleDeleteCanonical(group.canonicalName); }}
                    className="text-white/20 hover:text-red-400 text-xs px-1"
                    title="Delete all aliases for this source"
                  >
                    ✕
                  </button>
                </div>

                {expandedGroups.has(group.canonicalName) && (
                  <div className="border-t border-white/5 px-4 py-3 space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      {group.aliases.map(a => (
                        editingAlias?.id === a.id ? (
                          <input
                            key={a.id}
                            type="text"
                            value={editingAlias.value}
                            onChange={e => setEditingAlias({ ...editingAlias, value: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === "Enter") handleEditAlias(a.id, editingAlias.value);
                              if (e.key === "Escape") setEditingAlias(null);
                            }}
                            onBlur={() => handleEditAlias(a.id, editingAlias.value)}
                            className="bg-white/5 border border-primary/50 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 w-24"
                            autoFocus
                          />
                        ) : (
                          <span
                            key={a.id}
                            className="inline-flex items-center gap-1 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white/60 cursor-text hover:border-white/20"
                            onDoubleClick={() => setEditingAlias({ id: a.id, value: a.alias })}
                            title="Double-click to edit"
                          >
                            {a.alias}
                            <button
                              onClick={() => handleDeleteAlias(a.id)}
                              className="text-white/20 hover:text-red-400 ml-0.5"
                            >
                              ✕
                            </button>
                          </span>
                        )
                      ))}
                    </div>

                    {addingTo === group.canonicalName ? (
                      <div className="flex items-center gap-2 mt-2">
                        <input
                          type="text"
                          value={addAliasText}
                          onChange={e => setAddAliasText(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") handleAddAlias(group.canonicalName); }}
                          placeholder="New alias..."
                          className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                          autoFocus
                        />
                        <button
                          onClick={() => handleAddAlias(group.canonicalName)}
                          disabled={saving || !addAliasText.trim()}
                          className="bg-primary/20 text-primary rounded-md px-3 py-1.5 text-xs hover:bg-primary/30 disabled:opacity-30"
                        >
                          Add
                        </button>
                        <button
                          onClick={() => { setAddingTo(null); setAddAliasText(""); }}
                          className="text-white/30 hover:text-white/60 text-xs px-1"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setAddingTo(group.canonicalName); setAddAliasText(""); }}
                        className="text-xs text-primary/70 hover:text-primary mt-1"
                      >
                        + Add alias
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {groups.length === 0 && (
          <div className="text-center py-6">
            <p className="text-xs text-white/30 mb-3">No lead source aliases configured yet.</p>
            <button
              onClick={handleLoadDefaults}
              disabled={loadingDefaults}
              className="bg-primary/20 text-primary rounded-md px-4 py-2 text-xs hover:bg-primary/30 disabled:opacity-30"
            >
              {loadingDefaults ? "Loading..." : "Load Default Aliases"}
            </button>
          </div>
        )}

        <div className="border-t border-white/5 pt-4">
          <label className="block text-xs text-white/40 uppercase tracking-wider mb-2">Add New Source</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newCanonical}
              onChange={e => setNewCanonical(e.target.value)}
              placeholder="Canonical name (e.g. Meta)"
              className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <input
              type="text"
              value={newAlias}
              onChange={e => setNewAlias(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleAddCanonical(); }}
              placeholder="First alias (e.g. fb)"
              className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <button
              onClick={handleAddCanonical}
              disabled={saving || !newCanonical.trim() || !newAlias.trim()}
              className="flex items-center gap-1.5 bg-primary hover:bg-primary/90 text-white px-3 py-1.5 rounded-md text-xs font-medium disabled:opacity-30"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Add
            </button>
          </div>
        </div>
      </PremiumCard>
      </div>
      )}
    </div>
  );
}

function SettingsTab({ tenantId, funnels, onRefetchFunnels }: { tenantId: number | null; funnels: FunnelType[]; onRefetchFunnels: () => void }) {
  return (
    <div className="space-y-6">
      <SpiffConfigSection tenantId={tenantId} funnels={funnels} />

      <div className="border-t border-white/5 pt-6">
        <OldLeadThresholdSection tenantId={tenantId} />
      </div>

      <div className="border-t border-white/5 pt-6">
        <LeadSourceAliasSection tenantId={tenantId} />
      </div>

      <div className="border-t border-white/5 pt-6">
        <GoogleSheetConfigSection tenantId={tenantId} funnels={funnels} onRefetch={onRefetchFunnels} />
      </div>

      <div className="border-t border-white/5 pt-6">
        <PremiumCard className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <SettingsIcon className="w-4 h-4 text-primary" />
            <span className="text-sm font-display text-white">Communication Platform</span>
          </div>
          <p className="text-xs text-white/40">
            All calls and texts use the native browser-based platform.
          </p>
        </PremiumCard>
      </div>
    </div>
  );
}

interface SpiffLead {
  id: number;
  leadName: string;
  csrName: string;
  csrId: number | null;
  funnelName: string;
  funnelId: number | null;
  status: string;
  spiffAmount: number;
  date: string;
}

function SpiffsAuditTab({ tenantId, funnels, timezone }: { tenantId: number | null; funnels: FunnelType[]; timezone: string }) {
  const [leads, setLeads] = useState<SpiffLead[]>([]);
  const [totalSpiff, setTotalSpiff] = useState(0);
  const [loading, setLoading] = useState(true);
  const [csrs, setCsrs] = useState<{ id: number; name: string }[]>([]);
  const [filterCsrId, setFilterCsrId] = useState<string>("");
  const [filterFunnelId, setFilterFunnelId] = useState<string>("");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");

  useEffect(() => {
    if (!tenantId) { setCsrs([]); return; }
    fetch(`${API_BASE}/sales-manager/team?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        if (d.coordinators) setCsrs(d.coordinators.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name })));
      })
      .catch(() => {});
  }, [tenantId]);

  const fetchAudit = useCallback(async () => {
    if (!tenantId) { setLeads([]); setTotalSpiff(0); setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("tenantId", String(tenantId));
      if (filterCsrId) params.set("csrId", filterCsrId);
      if (filterFunnelId) params.set("funnelId", filterFunnelId);
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      const res = await fetch(`${API_BASE}/sales-manager/spiffs-audit?${params.toString()}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setLeads(data.leads || []);
        setTotalSpiff(data.totalSpiff || 0);
      }
    } catch {} finally { setLoading(false); }
  }, [tenantId, filterCsrId, filterFunnelId, startDate, endDate]);

  useEffect(() => { fetchAudit(); }, [fetchAudit]);

  return (
    <div className="space-y-4">
      <PremiumCard className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">CSR</label>
            <Select
              value={filterCsrId || "__all__"}
              onValueChange={v => setFilterCsrId(v === "__all__" ? "" : v)}
            >
              <SelectTrigger className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 min-w-[140px] h-auto w-auto">
                <SelectValue placeholder="All CSRs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All CSRs</SelectItem>
                {csrs.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">Funnel</label>
            <Select
              value={filterFunnelId || "__all__"}
              onValueChange={v => setFilterFunnelId(v === "__all__" ? "" : v)}
            >
              <SelectTrigger className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50 min-w-[140px] h-auto w-auto">
                <SelectValue placeholder="All Funnels" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Funnels</SelectItem>
                {funnels.map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <div>
            <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <button
            onClick={() => { setFilterCsrId(""); setFilterFunnelId(""); setStartDate(""); setEndDate(""); }}
            className="px-3 py-1.5 text-xs text-white/40 hover:text-white/70 border border-white/10 rounded transition-colors"
          >
            Clear
          </button>
        </div>
      </PremiumCard>

      <PremiumCard className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-emerald-400" />
            <span className="text-sm font-display text-white/60">Total Spiff Amount</span>
          </div>
          <span className="text-2xl font-display text-emerald-400">${totalSpiff.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-4 mt-2 text-xs text-white/40">
          <span>{leads.length} qualifying lead{leads.length !== 1 ? "s" : ""}</span>
          {filterCsrId && <span>Filtered by CSR</span>}
          {filterFunnelId && <span>Filtered by Funnel</span>}
          {(startDate || endDate) && <span>Date range applied</span>}
        </div>
      </PremiumCard>

      <PremiumCard className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
          </div>
        ) : leads.length === 0 ? (
          <div className="py-16 text-center">
            <DollarSign className="w-10 h-10 text-white/10 mx-auto mb-3" />
            <p className="text-sm text-white/40">No spiff-qualifying leads found for the current filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left py-3 px-4 text-[10px] text-white/40 uppercase tracking-wider font-medium">Lead</th>
                  <th className="text-left py-3 px-4 text-[10px] text-white/40 uppercase tracking-wider font-medium">CSR</th>
                  <th className="text-left py-3 px-4 text-[10px] text-white/40 uppercase tracking-wider font-medium">Funnel</th>
                  <th className="text-left py-3 px-4 text-[10px] text-white/40 uppercase tracking-wider font-medium">Status</th>
                  <th className="text-right py-3 px-4 text-[10px] text-white/40 uppercase tracking-wider font-medium">Spiff</th>
                  <th className="text-left py-3 px-4 text-[10px] text-white/40 uppercase tracking-wider font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {leads.map(lead => (
                  <tr key={lead.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                    <td className="py-2.5 px-4 text-white font-medium">{lead.leadName}</td>
                    <td className="py-2.5 px-4 text-white/70">{lead.csrName}</td>
                    <td className="py-2.5 px-4">
                      <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px]">
                        {lead.funnelName}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={cn(
                        "px-2 py-0.5 rounded-full text-[10px] capitalize",
                        lead.status === "sold" ? "bg-emerald-500/10 text-emerald-400" : "bg-blue-500/10 text-blue-400"
                      )}>
                        {lead.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right text-emerald-400 font-mono">${lead.spiffAmount}</td>
                    <td className="py-2.5 px-4 text-white/50">
                      {formatInTz(lead.date, timezone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

export default function SalesManager() {
  const { user, isAgency, selectedTenantId: globalTenantId, setSelectedTenantId } = useAuth();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [includePreBooked, setIncludePreBooked] = useState(false);
  const { tenants, tenantsLoading } = useTenants();

  // The Tenant <Select> on this page mirrors the global SCOPE chip in the
  // header. We deliberately don't auto-pick a tenant here — that was making
  // the chip "jump" on navigation. Operator must pick one explicitly.
  const selectedTenantId = isAgency ? globalTenantId : (user?.tenantId ?? null);
  const effectiveTenantId = selectedTenantId;
  const isClientUser = !isAgency && user?.role === "client_user";

  const tenantTz = tenants.find(t => t.id === effectiveTenantId)?.timezone || "America/New_York";

  const { funnels, refetch: refetchFunnels } = useFunnelTypes(effectiveTenantId);
  const { activities, loading: activityLoading, refetch: refetchActivity } = useActivityFeed(effectiveTenantId);
  const { insights, loading: insightsLoading, fetching: insightsFetching } = useCoachingInsights(effectiveTenantId);

  const tabs: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }>; count?: number }[] = [
    { key: "dashboard", label: "Dashboard", icon: BarChart3 },
    { key: "team", label: "Team", icon: Users },
    { key: "scripts", label: "Scripts", icon: FileText },
    { key: "routing", label: "Routing", icon: Shuffle },
    { key: "activity", label: "Activity", icon: Activity, count: activities.length > 0 ? activities.length : undefined },
    { key: "coaching", label: "Coaching", icon: Brain, count: insights.filter(i => i.type === "warning").length || undefined },
    { key: "spiffs", label: "Spiffs Audit", icon: DollarSign },
    { key: "settings", label: "Settings", icon: SettingsIcon },
  ];

  if (isClientUser) {
    return (
      <div className="max-w-7xl mx-auto space-y-6">
        <GradientHeading className="text-3xl mb-1">Access Denied</GradientHeading>
        <p className="text-sm text-white/40">The Sales Manager Hub is only available to admins and managers.</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <GradientHeading className="text-3xl mb-1">Sales Manager Hub</GradientHeading>
          <p className="text-sm text-white/40">Dashboard, team performance, routing configuration, and scripts</p>
        </div>
      </div>

      {isAgency && tenants.length > 0 && (
        <PremiumCard className="p-4">
          <div className="flex items-center gap-3">
            <label className="text-xs text-white/40 uppercase tracking-wider">Tenant</label>
            <Select
              value={selectedTenantId != null ? String(selectedTenantId) : undefined}
              onValueChange={v => setSelectedTenantId(parseInt(v))}
            >
              <SelectTrigger className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50 h-auto w-auto min-w-[140px]">
                <SelectValue placeholder="Select tenant..." />
              </SelectTrigger>
              <SelectContent>
                {tenants.map(t => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </PremiumCard>
      )}

      {isAgency && !selectedTenantId && tenantsLoading && (
        <PremiumCard className="p-6">
          <div className="animate-pulse space-y-3">
            <div className="h-4 w-1/3 bg-white/10 rounded" />
            <div className="h-3 w-1/2 bg-white/5 rounded" />
            <div className="h-3 w-2/5 bg-white/5 rounded" />
          </div>
        </PremiumCard>
      )}

      {isAgency && !selectedTenantId && !tenantsLoading && (
        <PremiumCard className="p-6 text-center">
          <p className="text-sm text-white/60">
            Select a tenant above (or in the header SCOPE chip) to view the Sales Manager Hub.
          </p>
        </PremiumCard>
      )}

      {(!isAgency || selectedTenantId) && (
      <>
      <div className="flex items-center gap-1 border-b border-white/5 pb-0 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-[1px] whitespace-nowrap",
              tab === t.key
                ? "text-white border-primary"
                : "text-white/30 border-transparent hover:text-white/50 hover:border-white/10"
            )}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {t.count !== undefined && (
              <span className={cn(
                "text-[10px] font-mono px-1.5 py-0.5 rounded-full",
                tab === t.key ? "bg-primary/20 text-primary" : "bg-white/5 text-white/30"
              )}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div>
        {tab === "dashboard" && (
          <DashboardTab tenantId={effectiveTenantId} funnels={funnels} includePreBooked={includePreBooked} setIncludePreBooked={setIncludePreBooked} onNavigateToSettings={() => setTab("settings")} />
        )}
        {tab === "team" && (
          <TeamTab tenantId={effectiveTenantId} funnels={funnels} timezone={tenantTz} includePreBooked={includePreBooked} setIncludePreBooked={setIncludePreBooked} />
        )}
        {tab === "scripts" && (
          <ScriptManagement key={effectiveTenantId} tenantId={effectiveTenantId} />
        )}
        {tab === "routing" && (
          <RoutingTab tenantId={effectiveTenantId} funnels={funnels} timezone={tenantTz} />
        )}
        {tab === "activity" && (
          <ActivityFeedTab
            activities={activities}
            loading={activityLoading}
            refetch={refetchActivity}
          />
        )}
        {tab === "coaching" && (
          <CoachingInsightsTab
            insights={insights}
            loading={insightsLoading}
            fetching={insightsFetching}
          />
        )}
        {tab === "spiffs" && (
          <SpiffsAuditTab tenantId={effectiveTenantId} funnels={funnels} timezone={tenantTz} />
        )}
        {tab === "settings" && (
          <SettingsTab tenantId={effectiveTenantId} funnels={funnels} onRefetchFunnels={refetchFunnels} />
        )}
      </div>
      </>
      )}
    </div>
  );
}
