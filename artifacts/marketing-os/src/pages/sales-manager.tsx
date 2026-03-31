import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth-context";
import {
  Users, Phone, MessageSquare, TrendingUp,
  Loader2, Award, Clock, Zap, AlertTriangle, Lightbulb,
  CheckCircle2, PhoneCall, Mail, Settings as SettingsIcon,
  FileText, Activity, Brain, BarChart3, DollarSign, Target,
  ArrowUpRight, ArrowDownRight, RefreshCw, ChevronDown, ChevronUp,
  Shuffle, Pause, Play, Calendar, Save, Table2, Link2,
  Mic, GripVertical, Eye, Wand2, ShieldCheck, AlertCircle,
} from "lucide-react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import ScriptManagement from "@/components/script-management";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

type Tab = "dashboard" | "team" | "scripts" | "activity" | "coaching" | "routing" | "settings";

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
}

interface StatsData {
  totalLeads: number;
  appointments: number;
  bookingRate: number;
  bySource: { source: string; total: number; appointments: number; bookingRate: number }[];
  byFunnel: { funnelId: number; total: number; appointments: number; bookingRate: number; calls: number; texts: number; vms: number }[];
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

interface TenantOption { id: number; name: string; timezone?: string; }

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
    if (!tenantId) { setLoading(false); return; }
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
    if (!tenantId) { setLoading(false); return; }
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
    if (!tenantId) { setLoading(false); return; }
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
    if (!tenantId) { setLoading(false); return; }
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
    try {
      const url = tenantId
        ? `${API_BASE}/sales-manager/activity-feed?tenantId=${tenantId}`
        : `${API_BASE}/sales-manager/activity-feed`;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setActivities(data.activities);
      }
    } catch {} finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => {
    fetchFeed();
    const interval = setInterval(fetchFeed, 10000);
    return () => clearInterval(interval);
  }, [fetchFeed]);

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

function MetricCard({ label, value, icon: Icon, delta, format = "number", className, subtitle }: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  delta?: number;
  format?: "number" | "percent" | "currency" | "time";
  className?: string;
  subtitle?: string;
}) {
  const formatted = format === "percent" ? `${value}%`
    : format === "currency" ? `$${value}`
    : format === "time" ? (value > 60 ? `${Math.floor(value / 60)}m ${value % 60}s` : `${value}s`)
    : `${value}`;

  return (
    <PremiumCard className={cn("p-4", className)}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-white/30 uppercase tracking-wider font-mono">{label}</span>
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

function DashboardTab({ tenantId, funnels, includePreBooked, setIncludePreBooked }: { tenantId: number | null; funnels: FunnelType[]; includePreBooked: boolean; setIncludePreBooked: (v: boolean) => void }) {
  const [datePreset, setDatePreset] = useState("today");
  const [funnelFilter, setFunnelFilter] = useState<number | null>(null);
  const [startDate, endDate] = useDateRange(datePreset);
  const { stats, loading } = useStats(tenantId, startDate, endDate, funnelFilter, includePreBooked);
  const { stats: allStats, loading: allStatsLoading } = useStats(tenantId, startDate, endDate, null, includePreBooked);

  const overallBookingRate = allStats?.bookingRate ?? 0;
  const selectedFunnelRate = funnelFilter
    ? (allStats?.byFunnel.find(f => f.funnelId === funnelFilter)?.bookingRate ?? 0)
    : null;

  if (loading || allStatsLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

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
        <select
          value={funnelFilter ?? ""}
          onChange={e => setFunnelFilter(e.target.value ? Number(e.target.value) : null)}
          className="bg-white/5 border border-white/10 rounded-md px-3 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="">All Funnels</option>
          {funnels.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
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
        <MetricCard label="Appointments" value={stats?.appointments || 0} icon={Target} />
        <MetricCard label={funnelFilter ? "Funnel Rate" : "Booking Rate"} value={stats?.bookingRate || 0} icon={TrendingUp} format="percent" subtitle={funnelFilter ? `Overall: ${overallBookingRate}%` : undefined} />
        <MetricCard label="Total Calls" value={stats?.byCsr.reduce((s, c) => s + c.calls, 0) || 0} icon={Phone} />
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
                <div key={s.source} className="flex items-center justify-between p-2 rounded bg-white/[0.02] border border-white/5">
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
                </div>
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
                  <div key={f.funnelId} className="flex items-center justify-between p-2 rounded bg-white/[0.02] border border-white/5">
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
      </div>

      <PremiumCard className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Phone className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">Total Calls with Funnel Breakdown</span>
        </div>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="p-3 rounded bg-white/[0.02] border border-white/5 text-center">
            <p className="text-2xl font-display text-white">{stats?.byCsr.reduce((s, c) => s + c.calls, 0) || 0}</p>
            <p className="text-[10px] text-white/30 uppercase">Total Calls</p>
          </div>
          <div className="p-3 rounded bg-white/[0.02] border border-white/5 text-center">
            <p className="text-2xl font-display text-blue-400">{stats?.byCsr.reduce((s, c) => s + c.texts, 0) || 0}</p>
            <p className="text-[10px] text-white/30 uppercase">Total Texts</p>
          </div>
          <div className="p-3 rounded bg-white/[0.02] border border-white/5 text-center">
            <p className="text-2xl font-display text-purple-400">{stats?.byCsr.reduce((s, c) => s + c.vms, 0) || 0}</p>
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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState<number | null>(null);
  const [scheduleEditId, setScheduleEditId] = useState<number | null>(null);
  const [schedPauseStart, setSchedPauseStart] = useState("");
  const [schedPauseEnd, setSchedPauseEnd] = useState("");
  const [schedError, setSchedError] = useState("");

  const loading = configsLoading || csrsLoading;

  useEffect(() => {
    const config = configs.find(c =>
      selectedFunnelId ? c.funnelTypeId === selectedFunnelId : c.funnelTypeId === null
    );
    if (config) {
      setCascadeOrder(config.cascadeOrder || []);
      const mins = config.passIntervalMinutes || 1440;
      setPassInterval(mins);
      setPassUnit(mins % 60 === 0 && mins >= 60 ? "hours" : "minutes");
      setAllowPassBack(config.allowPassBack || false);
      setStickyAfterCascade(config.stickyAfterCascade || false);
      setStickyCsrId(config.stickyCsrId || null);
    } else {
      setCascadeOrder([]);
      setPassInterval(1440);
      setPassUnit("hours");
      setAllowPassBack(false);
      setStickyAfterCascade(false);
      setStickyCsrId(null);
    }
  }, [selectedFunnelId, configs]);

  const handleSaveRouting = async () => {
    if (!tenantId) return;
    setSaving(true);
    setSaved(false);
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
        }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
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
        <select
          value={selectedFunnelId ?? ""}
          onChange={e => setSelectedFunnelId(e.target.value ? Number(e.target.value) : null)}
          className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="">Default (All Funnels)</option>
          {funnels.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>

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
                <select
                  value={passUnit}
                  onChange={e => {
                    const newUnit = e.target.value as "minutes" | "hours";
                    if (newUnit === "hours" && passUnit === "minutes") {
                      setPassInterval(Math.max(60, Math.round(passInterval / 60) * 60));
                    } else if (newUnit === "minutes" && passUnit === "hours") {
                      setPassInterval(passInterval);
                    }
                    setPassUnit(newUnit);
                  }}
                  className="bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                </select>
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
                  if (!next) { setStickyAfterCascade(false); setStickyCsrId(null); }
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
                      if (!next) setStickyCsrId(null);
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
                  <div>
                    <label className="text-[10px] text-white/30 uppercase tracking-wider">Assign To</label>
                    <select
                      value={stickyCsrId ?? ""}
                      onChange={e => setStickyCsrId(e.target.value ? Number(e.target.value) : null)}
                      className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                    >
                      <option value="">Select a CSR...</option>
                      {csrs.map(csr => (
                        <option key={csr.id} value={csr.id}>{csr.name}</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-white/20 mt-0.5">Lead will be assigned to this CSR after cycling through all cascade positions</p>
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            onClick={handleSaveRouting}
            disabled={saving}
            className="mt-4 flex items-center gap-2 bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50 w-full justify-center"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saved ? "Saved!" : "Save Routing Config"}
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
  byLeadType: Record<string, number>;
}

function useSpiffConfig(tenantId: number | null) {
  const [config, setConfig] = useState<SpiffConfig>({ default: 20, byLeadType: {} });
  const [leadTypes, setLeadTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) { setLoading(false); return; }
    Promise.all([
      fetch(`${API_BASE}/sales-manager/spiff-config?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json()),
      fetch(`${API_BASE}/sales-manager/lead-types?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json()),
    ]).then(([configData, typesData]) => {
      if (configData?.spiffConfig) setConfig(configData.spiffConfig);
      if (typesData?.leadTypes) setLeadTypes(typesData.leadTypes);
    }).finally(() => setLoading(false));
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

  return { config, leadTypes, loading, saveConfig };
}

function SpiffConfigSection({ tenantId }: { tenantId: number | null }) {
  const { config, leadTypes, loading, saveConfig } = useSpiffConfig(tenantId);
  const [defaultAmount, setDefaultAmount] = useState(20);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newLeadType, setNewLeadType] = useState("");

  useEffect(() => {
    setDefaultAmount(config.default);
    setOverrides({ ...config.byLeadType });
  }, [config]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    await saveConfig({ default: defaultAmount, byLeadType: overrides });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const availableTypes = leadTypes.filter(lt => !(lt in overrides));

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
          <p className="text-[10px] text-white/30 mb-2">Applied to all bookings unless a lead-type override is set below.</p>
          <div className="relative w-40">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 text-sm">$</span>
            <input
              type="number"
              min={0}
              step={1}
              value={defaultAmount}
              onChange={e => setDefaultAmount(Math.max(0, Number(e.target.value)))}
              className="w-full bg-white/5 border border-white/10 rounded-md pl-7 pr-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-white/40 uppercase tracking-wider mb-1.5">Lead Type Overrides</label>
          <p className="text-[10px] text-white/30 mb-3">Set custom spiff amounts for specific lead types.</p>

          {Object.keys(overrides).length > 0 && (
            <div className="space-y-2 mb-3">
              {Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)).map(([lt, amount]) => (
                <div key={lt} className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-white/70 truncate">{lt}</span>
                  <div className="relative w-28">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40 text-xs">$</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={amount}
                      onChange={e => setOverrides(prev => ({ ...prev, [lt]: Math.max(0, Number(e.target.value)) }))}
                      className="w-full bg-white/5 border border-white/10 rounded-md pl-6 pr-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                  </div>
                  <button
                    onClick={() => setOverrides(prev => { const next = { ...prev }; delete next[lt]; return next; })}
                    className="text-white/30 hover:text-red-400 text-xs px-1"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {availableTypes.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                value={newLeadType}
                onChange={e => setNewLeadType(e.target.value)}
                className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                <option value="">Add lead type override...</option>
                {availableTypes.map(lt => (
                  <option key={lt} value={lt}>{lt}</option>
                ))}
              </select>
              <button
                onClick={() => { if (newLeadType) { setOverrides(prev => ({ ...prev, [newLeadType]: defaultAmount })); setNewLeadType(""); } }}
                disabled={!newLeadType}
                className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-xs text-white hover:bg-white/10 disabled:opacity-30"
              >
                Add
              </button>
            </div>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle2 className="w-4 h-4" /> : <DollarSign className="w-4 h-4" />}
          {saved ? "Saved!" : "Save Spiff Settings"}
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
        if (data.funnelValueMap) setFunnelValueMap(data.funnelValueMap);
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
          loadColumnValues(data.funnelColumn);
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

  const loadColumnValues = async (colName: string) => {
    setLoadingValues(true);
    try {
      const res = await fetch(`${API_BASE}/sheet-configs/${configId}/column-values/${encodeURIComponent(colName)}`, { credentials: "include" });
      const data = await res.json();
      if (res.ok) setColumnValues(data.values || []);
    } catch {} finally { setLoadingValues(false); }
  };

  useEffect(() => {
    if (funnelColumn && config.columnMapping) {
      loadColumnValues(funnelColumn);
    }
  }, []);

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

                  <select
                    value={field}
                    onChange={e => setMapping(prev => ({ ...prev, [header]: e.target.value }))}
                    className={cn(
                      "bg-white/5 border rounded-md px-2 py-1.5 text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-primary/50",
                      field === "__skip__" ? "border-white/5 text-white/30" : "border-white/10"
                    )}
                  >
                    {analysis?.internalFields ? (
                      analysis.internalFields.map(f => (
                        <option key={f.field} value={f.field}>{f.label}</option>
                      ))
                    ) : (
                      <>
                        <option value="firstName">First Name</option>
                        <option value="lastName">Last Name</option>
                        <option value="fullName">Full Name</option>
                        <option value="phone">Phone</option>
                        <option value="email">Email</option>
                        <option value="source">Lead Source</option>
                        <option value="serviceType">Service Type</option>
                        <option value="__funnel__">Funnel</option>
                        <option value="status">Status</option>
                        <option value="notes">Notes</option>
                        <option value="address">Address</option>
                        <option value="city">City</option>
                        <option value="state">State</option>
                        <option value="zip">Zip Code</option>
                        <option value="dateTime">Date/Time</option>
                        <option value="appointmentBooked">Appointment Booked</option>
                        <option value="__skip__">Skip (Do Not Import)</option>
                      </>
                    )}
                  </select>
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
          <div className="flex items-center gap-2 mb-2">
            <Shuffle className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-[11px] font-medium text-white/70">Funnel Routing</span>
            <span className="text-[9px] text-white/20 font-mono">column: {funnelColumn}</span>
          </div>
          <p className="text-[10px] text-white/25 mb-3">Map each value in the "{funnelColumn}" column to the funnel it should route to.</p>

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
                <div key={val} className="flex items-center gap-2 px-3 py-1.5 rounded bg-white/[0.02] border border-white/5">
                  <span className="text-[11px] text-white/70 font-mono flex-1 truncate">{val}</span>
                  <ArrowUpRight className="w-3 h-3 text-white/20 rotate-90 flex-shrink-0" />
                  <select
                    value={funnelValueMap[val] ?? ""}
                    onChange={e => {
                      const v = e.target.value;
                      setFunnelValueMap(prev => {
                        if (!v) { const next = { ...prev }; delete next[val]; return next; }
                        return { ...prev, [val]: Number(v) };
                      });
                    }}
                    className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-primary/50 min-w-[140px]"
                  >
                    <option value="">-- Select Funnel --</option>
                    {funnels.map(f => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={handleSaveFunnelMap}
            disabled={savingFunnelMap || columnValues.length === 0}
            className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-500 disabled:opacity-50"
          >
            {savingFunnelMap ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Save Funnel Routing
          </button>
        </div>
      )}
    </div>
  );
}

function useSheetConfigs(tenantId: number | null) {
  const [configs, setConfigs] = useState<SheetConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConfigs = useCallback(async () => {
    if (!tenantId) { setLoading(false); return; }
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Table2 className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">Google Sheet Configurations</span>
        </div>
        {isAgency && (
          <button
            onClick={() => setCreating(!creating)}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-primary/20 text-primary text-xs font-medium hover:bg-primary/30"
          >
            {creating ? "Cancel" : "+ Add Sheet"}
          </button>
        )}
      </div>

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
            <select
              value={newDefaultFunnel}
              onChange={e => setNewDefaultFunnel(e.target.value ? Number(e.target.value) : "")}
              className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              <option value="">-- No default (require funnel routing) --</option>
              {funnels.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
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
                  <span className="text-[10px] text-emerald-400/70 font-mono truncate max-w-[200px]">{cfg.googleSheetId}</span>
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
                  <select
                    value={editDefaultFunnel}
                    onChange={e => setEditDefaultFunnel(e.target.value ? Number(e.target.value) : "")}
                    className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    <option value="">-- No default (require funnel routing) --</option>
                    {funnels.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
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
  );
}

function SettingsTab({ tenantId, funnels, onRefetchFunnels }: { tenantId: number | null; funnels: FunnelType[]; onRefetchFunnels: () => void }) {
  return (
    <div className="space-y-6">
      <SpiffConfigSection tenantId={tenantId} />

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

export default function SalesManager() {
  const { user, isAgency, setSelectedTenantId: setGlobalTenantId } = useAuth();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [includePreBooked, setIncludePreBooked] = useState(false);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [selectedTenantId, setSelectedTenantIdLocal] = useState<number | null>(user?.tenantId ?? null);

  const setSelectedTenantId = useCallback((id: number | null) => {
    setSelectedTenantIdLocal(id);
    setGlobalTenantId(id);
  }, [setGlobalTenantId]);

  useEffect(() => {
    fetch(`${API_BASE}/tenants`, { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setTenants(data.map((t: { id: number; name: string; timezone?: string }) => ({ id: t.id, name: t.name, timezone: t.timezone })));
          if (isAgency && !selectedTenantId && data.length > 0) setSelectedTenantId(data[0].id);
        }
      })
      .catch(() => {});
  }, [isAgency]);

  const effectiveTenantId = isAgency ? selectedTenantId : (user?.tenantId ?? null);
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
            <select
              value={selectedTenantId ?? ""}
              onChange={e => setSelectedTenantId(parseInt(e.target.value))}
              className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              {tenants.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </PremiumCard>
      )}

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
          <DashboardTab tenantId={effectiveTenantId} funnels={funnels} includePreBooked={includePreBooked} setIncludePreBooked={setIncludePreBooked} />
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
        {tab === "settings" && (
          <SettingsTab tenantId={effectiveTenantId} funnels={funnels} onRefetchFunnels={refetchFunnels} />
        )}
      </div>
    </div>
  );
}
