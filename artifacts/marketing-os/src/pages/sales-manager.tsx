import { useState, useEffect, useCallback } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth-context";
import {
  Users, Phone, MessageSquare, TrendingUp, TrendingDown,
  Loader2, Award, Clock, Zap, AlertTriangle, Lightbulb,
  CheckCircle2, PhoneCall, Mail, Settings as SettingsIcon,
  FileText, Activity, Brain, BarChart3, DollarSign, Target,
  ArrowUpRight, ArrowDownRight, Minus, RefreshCw,
} from "lucide-react";
import ScriptManagement from "@/components/script-management";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

type Tab = "team" | "scripts" | "activity" | "coaching" | "settings";

interface CoordinatorData {
  id: number;
  name: string;
  role: string;
  email: string;
  today: {
    callsMade: number;
    bookings: number;
    bookingRate: number;
    commission: number;
    speedToLead: number;
  };
  week: {
    avgBookingRate: number;
    totalCalls: number;
    totalBookings: number;
    daysActive: number;
  };
}

interface TeamTotals {
  callsMade: number;
  bookings: number;
  bookingRate: number;
  commission: number;
  activeCoordinators: number;
  totalCoordinators: number;
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

function useTeamData(tenantId: number | null) {
  const [data, setData] = useState<{ coordinators: CoordinatorData[]; teamTotals: TeamTotals | null }>({
    coordinators: [], teamTotals: null,
  });
  const [loading, setLoading] = useState(true);

  const fetchTeam = useCallback(async () => {
    try {
      const url = tenantId
        ? `${API_BASE}/sales-manager/team?tenantId=${tenantId}`
        : `${API_BASE}/sales-manager/team`;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) setData(await res.json());
    } catch {} finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => {
    fetchTeam();
    const interval = setInterval(fetchTeam, 15000);
    return () => clearInterval(interval);
  }, [fetchTeam]);

  return { ...data, loading, refetch: fetchTeam };
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

  useEffect(() => {
    if (!tenantId) { setLoading(false); setInsights([]); return; }
    setLoading(true);
    const url = `${API_BASE}/sales-manager/coaching-insights?tenantId=${tenantId}`;
    fetch(url, { credentials: "include" })
      .then(r => r.json())
      .then(d => { setInsights(d.insights || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [tenantId]);

  return { insights, loading };
}

interface ScriptChange {
  id: number;
  category: string;
  title: string;
  description: string;
  date: string;
}

function useRecentScriptChanges(tenantId: number | null) {
  const [changes, setChanges] = useState<ScriptChange[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) { setLoading(false); setChanges([]); return; }
    setLoading(true);
    fetch(`${API_BASE}/sales-manager/recent-script-changes?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => { setChanges(d.changes || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [tenantId]);

  return { changes, loading };
}

interface CommunicationConfig {
  callPlatform: string;
  textPlatform: string;
}

function useCommunicationConfig(tenantId: number | null) {
  const [config, setConfig] = useState<CommunicationConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchConfig = useCallback(async () => {
    if (!tenantId) { setLoading(false); return; }
    try {
      const res = await fetch(`${API_BASE}/tenants/${tenantId}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const cc = data.communicationConfig || {};
        setConfig({
          callPlatform: cc.callPlatform || "native",
          textPlatform: cc.textPlatform || "native",
        });
      }
    } catch {} finally { setLoading(false); }
  }, [tenantId]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const saveConfig = async (updates: Partial<CommunicationConfig>) => {
    if (!tenantId) return;
    try {
      const res = await fetch(`${API_BASE}/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ communicationConfig: updates }),
      });
      if (res.ok) {
        const data = await res.json();
        const cc = data.communicationConfig || {};
        setConfig({
          callPlatform: cc.callPlatform || "native",
          textPlatform: cc.textPlatform || "native",
        });
      }
    } catch {}
  };

  return { config, loading, saveConfig, refetch: fetchConfig };
}

interface TenantOption { id: number; name: string; }

function MetricCard({ label, value, icon: Icon, delta, format = "number", className }: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  delta?: number;
  format?: "number" | "percent" | "currency" | "time";
  className?: string;
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
    </PremiumCard>
  );
}

function formatSpeed(seconds: number) {
  if (seconds === 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function TeamOverviewTab({ coordinators, teamTotals, loading }: {
  coordinators: CoordinatorData[];
  teamTotals: TeamTotals | null;
  loading: boolean;
}) {
  const [sortBy, setSortBy] = useState<"bookings" | "calls" | "rate" | "commission">("bookings");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const sorted = [...coordinators].sort((a, b) => {
    switch (sortBy) {
      case "calls": return b.today.callsMade - a.today.callsMade;
      case "rate": return b.today.bookingRate - a.today.bookingRate;
      case "commission": return b.today.commission - a.today.commission;
      default: return b.today.bookings - a.today.bookings;
    }
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  const avgSpeed = coordinators.length > 0
    ? Math.round(coordinators.reduce((s, c) => s + c.today.speedToLead, 0) / Math.max(coordinators.filter(c => c.today.speedToLead > 0).length, 1))
    : 0;

  return (
    <div className="space-y-6">
      {teamTotals && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <MetricCard label="Team Calls Today" value={teamTotals.callsMade} icon={Phone} />
          <MetricCard label="Team Bookings" value={teamTotals.bookings} icon={Target} />
          <MetricCard label="Team Booking Rate" value={teamTotals.bookingRate} icon={TrendingUp} format="percent" />
          <MetricCard label="Team Commission" value={teamTotals.commission} icon={DollarSign} format="currency" />
          <MetricCard label="Avg Speed-to-Lead" value={avgSpeed} icon={Zap} format="time" />
        </div>
      )}

      <PremiumCard className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" />
            <span className="text-sm font-display text-white">
              Coordinators ({teamTotals?.activeCoordinators || 0} active / {teamTotals?.totalCoordinators || 0} total)
            </span>
          </div>
          <div className="flex items-center gap-1">
            {(["bookings", "calls", "rate", "commission"] as const).map(key => (
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

        {sorted.length === 0 ? (
          <div className="text-center py-12">
            <Users className="w-8 h-8 text-white/10 mx-auto mb-2" />
            <p className="text-xs text-white/30">No coordinators found</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((coord, idx) => (
              <div key={coord.id}>
                <button
                  onClick={() => setExpandedId(expandedId === coord.id ? null : coord.id)}
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
                    <p className="text-sm font-medium text-white truncate">{coord.name}</p>
                    <p className="text-[10px] text-white/30">
                      {coord.role === "client_admin" ? "Manager" : coord.role === "client_user" ? "Coordinator" : coord.role}
                    </p>
                  </div>

                  <div className="grid grid-cols-5 gap-3 text-center flex-shrink-0">
                    <div>
                      <p className="text-xs font-mono text-white">{coord.today.callsMade}</p>
                      <p className="text-[9px] text-white/20 uppercase">Calls</p>
                    </div>
                    <div>
                      <p className="text-xs font-mono text-emerald-400">{coord.today.bookings}</p>
                      <p className="text-[9px] text-white/20 uppercase">Booked</p>
                    </div>
                    <div>
                      <p className={cn(
                        "text-xs font-mono",
                        coord.today.bookingRate >= 30 ? "text-emerald-400" : coord.today.bookingRate >= 15 ? "text-amber-400" : "text-red-400"
                      )}>
                        {coord.today.bookingRate}%
                      </p>
                      <p className="text-[9px] text-white/20 uppercase">Rate</p>
                    </div>
                    <div>
                      <p className="text-xs font-mono text-white">${coord.today.commission}</p>
                      <p className="text-[9px] text-white/20 uppercase">Earned</p>
                    </div>
                    <div>
                      <p className={cn(
                        "text-xs font-mono",
                        coord.today.speedToLead > 0 && coord.today.speedToLead <= 300 ? "text-emerald-400"
                          : coord.today.speedToLead <= 900 ? "text-amber-400" : "text-white/40"
                      )}>
                        {formatSpeed(coord.today.speedToLead)}
                      </p>
                      <p className="text-[9px] text-white/20 uppercase">Speed</p>
                    </div>
                  </div>
                </button>

                {expandedId === coord.id && (
                  <div className="ml-11 mt-1 p-3 rounded-lg bg-white/[0.01] border border-white/5">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <p className="text-[9px] text-white/20 uppercase mb-0.5">Email</p>
                        <p className="text-xs text-white/60 truncate">{coord.email}</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-white/20 uppercase mb-0.5">7-Day Avg Rate</p>
                        <p className="text-xs font-mono text-white/60">{coord.week.avgBookingRate}%</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-white/20 uppercase mb-0.5">7-Day Calls</p>
                        <p className="text-xs font-mono text-white/60">{coord.week.totalCalls}</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-white/20 uppercase mb-0.5">7-Day Bookings</p>
                        <p className="text-xs font-mono text-white/60">{coord.week.totalBookings}</p>
                      </div>
                    </div>
                    <div className="mt-2 pt-2 border-t border-white/5">
                      <p className="text-[9px] text-white/20 uppercase mb-0.5">Days Active (last 7)</p>
                      <p className="text-xs font-mono text-white/60">{coord.week.daysActive} / 7</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </PremiumCard>
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

function CoachingInsightsTab({ insights, loading }: {
  insights: CoachingInsight[];
  loading: boolean;
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
    <div className="space-y-4">
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

function ScriptChangesPanel({ changes, loading }: { changes: ScriptChange[]; loading: boolean }) {
  if (loading) return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
  if (changes.length === 0) return null;

  return (
    <PremiumCard className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-primary" />
        <span className="text-xs font-display text-white">Recent Script Changes</span>
        <span className="text-[10px] text-white/20 font-mono">({changes.length})</span>
      </div>
      <div className="space-y-2">
        {changes.map(c => (
          <div key={c.id} className="flex items-start gap-2 text-xs border-b border-white/5 pb-2 last:border-0 last:pb-0">
            <span className="text-[9px] font-mono text-white/20 flex-shrink-0 mt-0.5">{new Date(c.date).toLocaleDateString()}</span>
            <div className="flex-1 min-w-0">
              <p className="text-white/70 font-medium">{c.title}</p>
              <p className="text-white/40 text-[10px] mt-0.5">{c.description}</p>
            </div>
          </div>
        ))}
      </div>
    </PremiumCard>
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
    const base = API_BASE.replace(/\/api$/, "");
    Promise.all([
      fetch(`${base}/api/sales-manager/spiff-config?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json()),
      fetch(`${base}/api/sales-manager/lead-types?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json()),
    ]).then(([configData, typesData]) => {
      if (configData?.spiffConfig) setConfig(configData.spiffConfig);
      if (typesData?.leadTypes) setLeadTypes(typesData.leadTypes);
    }).finally(() => setLoading(false));
  }, [tenantId]);

  const saveConfig = async (newConfig: SpiffConfig) => {
    const base = API_BASE.replace(/\/api$/, "");
    await fetch(`${base}/api/sales-manager/spiff-config?tenantId=${tenantId}`, {
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

  const addOverride = () => {
    if (!newLeadType) return;
    setOverrides(prev => ({ ...prev, [newLeadType]: defaultAmount }));
    setNewLeadType("");
  };

  const removeOverride = (lt: string) => {
    setOverrides(prev => {
      const next = { ...prev };
      delete next[lt];
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
          <p className="text-[10px] text-white/30 mb-3">Set custom spiff amounts for specific lead types. Types not listed here use the default amount.</p>

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
                    onClick={() => removeOverride(lt)}
                    className="text-white/30 hover:text-red-400 text-xs px-1"
                    title="Remove override"
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
                onClick={addOverride}
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

function SettingsTab({ tenantId }: { tenantId: number | null }) {
  const { config, loading, saveConfig } = useCommunicationConfig(tenantId);
  const [callPlatform, setCallPlatform] = useState("native");
  const [textPlatform, setTextPlatform] = useState("native");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (config) {
      setCallPlatform(config.callPlatform || "native");
      setTextPlatform(config.textPlatform || "native");
    }
  }, [config]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    await saveConfig({ callPlatform, textPlatform });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
      <SpiffConfigSection tenantId={tenantId} />

      <div className="border-t border-white/5 pt-6">
        <div className="flex items-center gap-2">
          <SettingsIcon className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">Communication Platform Settings</span>
        </div>
      </div>

      <PremiumCard className="p-6 space-y-4">
        <div>
          <label className="block text-xs text-white/40 uppercase tracking-wider mb-1.5">Call Platform</label>
          <select
            value={callPlatform}
            onChange={e => setCallPlatform(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
          >
            <option value="native">Native (Browser)</option>
            <option value="podium">Podium</option>
            <option value="callrail">CallRail</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-white/40 uppercase tracking-wider mb-1.5">Text Platform</label>
          <select
            value={textPlatform}
            onChange={e => setTextPlatform(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
          >
            <option value="native">Native (Browser)</option>
            <option value="podium">Podium</option>
          </select>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle2 className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          {saved ? "Saved!" : "Save Settings"}
        </button>
      </PremiumCard>

      <PremiumCard className="p-4">
        <p className="text-xs text-white/30">
          Configure your communication platform integration. This controls how outbound calls and texts
          are routed through your preferred provider (Podium, CallRail, or native browser dialing).
        </p>
      </PremiumCard>
    </div>
  );
}

export default function SalesManager() {
  const { user, isAgency } = useAuth();
  const [tab, setTab] = useState<Tab>("team");
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(user?.tenantId ?? null);

  useEffect(() => {
    if (!isAgency) return;
    fetch(`${API_BASE.replace(/\/api$/, "")}/api/tenants`, { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setTenants(data.map((t: { id: number; name: string }) => ({ id: t.id, name: t.name })));
          if (!selectedTenantId && data.length > 0) setSelectedTenantId(data[0].id);
        }
      })
      .catch(() => {});
  }, [isAgency]);

  const effectiveTenantId = isAgency ? selectedTenantId : (user?.tenantId ?? null);
  const isClientUser = !isAgency && user?.role === "client_user";

  const { coordinators, teamTotals, loading: teamLoading, refetch: refetchTeam } = useTeamData(effectiveTenantId);
  const { activities, loading: activityLoading, refetch: refetchActivity } = useActivityFeed(effectiveTenantId);
  const { insights, loading: insightsLoading } = useCoachingInsights(effectiveTenantId);
  const { changes: scriptChanges, loading: scriptChangesLoading } = useRecentScriptChanges(effectiveTenantId);

  const tabs: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }>; count?: number }[] = [
    { key: "team", label: "Team Overview", icon: Users, count: teamTotals?.activeCoordinators },
    { key: "scripts", label: "Scripts", icon: FileText },
    { key: "activity", label: "Activity Feed", icon: Activity, count: activities.length > 0 ? activities.length : undefined },
    { key: "coaching", label: "Coaching Insights", icon: Brain, count: insights.filter(i => i.type === "warning").length || undefined },
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
          <p className="text-sm text-white/40">Oversee team performance, manage scripts, and get coaching insights</p>
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

      <div className="flex items-center gap-1 border-b border-white/5 pb-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-[1px]",
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
        {tab === "team" && (
          <TeamOverviewTab
            coordinators={coordinators}
            teamTotals={teamTotals}
            loading={teamLoading}
          />
        )}
        {tab === "scripts" && (
          <div className="space-y-4">
            <ScriptChangesPanel changes={scriptChanges} loading={scriptChangesLoading} />
            <ScriptManagement key={effectiveTenantId} tenantId={effectiveTenantId} />
          </div>
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
          />
        )}
        {tab === "settings" && (
          <SettingsTab tenantId={effectiveTenantId} />
        )}
      </div>
    </div>
  );
}
