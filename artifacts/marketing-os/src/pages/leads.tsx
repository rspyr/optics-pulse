import { useState, useEffect, useRef, useCallback } from "react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { motion, AnimatePresence } from "framer-motion";
import { io as socketIOClient, type Socket as IOSocket } from "socket.io-client";
import {
  Phone, Mail, MessageSquare, Mic,
  Clock, Zap, X,
  ChevronDown, AlertTriangle, Target,
  Calendar, PhoneCall,
  Star, Volume2, DollarSign, Loader2, CheckCircle2, XCircle,
  Brain, TrendingUp, TrendingDown, PhoneForwarded, Info,
  BarChart3, ArrowUpRight, ArrowDownRight, Minus, History
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, BarChart, Bar
} from "recharts";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const DISPOSITIONS = [
  { value: "booked", label: "Booked", color: "emerald" },
  { value: "never_answered", label: "Never Answered", color: "amber" },
  { value: "out_of_area", label: "Out of Service Area", color: "red" },
  { value: "looking_for_job", label: "Looking for Job", color: "gray" },
  { value: "already_had_estimate", label: "Already Had Estimate", color: "blue" },
  { value: "dont_remember", label: "Don't Remember Form", color: "gray" },
  { value: "not_interested", label: "Not Interested", color: "red" },
  { value: "callback_requested", label: "Callback Requested", color: "amber" },
];

const FALLBACK_SCRIPTS: Record<string, string> = {
  "Google Ads": "Hi [NAME], this is [REP] from [COMPANY]. I see you were looking into [INTEREST] — we have availability this week. Would you like to schedule a free estimate?",
  "Meta Leads": "Hi [NAME], this is [REP] from [COMPANY]. I noticed you were interested in [INTEREST] through our ad. We're running a special this month — would you like a free estimate?",
  "CallRail": "Hi [NAME], this is [REP] returning your call from [COMPANY]. I'd love to help you with [INTEREST]. Do you have a few minutes to discuss your needs?",
  "Organic Search": "Hi [NAME], this is [REP] from [COMPANY]. Thanks for finding us! I'd love to help with your [INTEREST] needs. When would be a good time for a free estimate?",
  "Referral": "Hi [NAME], this is [REP] from [COMPANY]. I understand you were referred to us for [INTEREST]. We'd love to take care of you — when's a good time for an estimate?",
  "Direct": "Hi [NAME], thank you for reaching out! I'd love to help you with [INTEREST]. Let me find the best time for an estimate.",
};

const FALLBACK_TEXT = "Hi [NAME]! This is [REP] from [COMPANY]. Just following up on your [INTEREST] inquiry. Would you like to schedule a free estimate? Reply YES and I'll get you on the calendar!";

const FALLBACK_VM: Record<string, string> = {
  "Google Ads": "Hi [NAME], this is [REP] with [COMPANY]. I'm calling about your [INTEREST] inquiry from our Google listing. We'd love to schedule a free estimate at your convenience. Please call us back at your earliest convenience. Thanks!",
  "Meta Leads": "Hi [NAME], this is [REP] from [COMPANY] following up on your interest in [INTEREST]. We have openings this week for a free estimate. Give us a call back when you can!",
  default: "Hi [NAME], this is [REP] with [COMPANY] calling about your [INTEREST] inquiry. We'd love to schedule a free estimate at your convenience. Please call us back when you get this. Thank you!",
};

interface ScriptRecord {
  id: number;
  type: string;
  name: string;
  sourceFilter: string | null;
  stageFilter: string | null;
  content: string;
  isActive: boolean;
}

function useScripts(tenantId?: number | null) {
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  useEffect(() => {
    const url = tenantId
      ? `${API_BASE}/scripts?tenantId=${tenantId}`
      : `${API_BASE}/scripts`;
    fetch(url, { credentials: "include" })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setScripts(data); })
      .catch(() => {});
  }, [tenantId]);
  return scripts;
}

function findScript(scripts: ScriptRecord[], type: string, source: string, stage?: string): string | null {
  if (!scripts || !Array.isArray(scripts)) return null;
  const active = scripts.filter(s => s.type === type && s.isActive);
  const bySourceAndStage = active.find(s => s.sourceFilter === source && s.stageFilter === (stage || null));
  if (bySourceAndStage) return bySourceAndStage.content;
  const bySource = active.find(s => s.sourceFilter === source && !s.stageFilter);
  if (bySource) return bySource.content;
  const byStage = active.find(s => !s.sourceFilter && s.stageFilter === (stage || null));
  if (byStage) return byStage.content;
  const generic = active.find(s => !s.sourceFilter && !s.stageFilter);
  if (generic) return generic.content;
  return null;
}


interface LeadSuggestion {
  bestTimeWindow: string | null;
  reason: string;
  doubleDial: boolean;
  inOptimalWindow: boolean;
  priorityScore: number;
  priorityReason: string;
  confidenceScore: number;
  totalAttempts: number;
  lastAttemptAt: string | null;
  failedAttempts: number;
}

interface LeadData {
  id: number;
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  source: string;
  leadType?: string | null;
  interestType?: string | null;
  status: string;
  disposition?: string | null;
  isNewCustomer?: boolean;
  createdAt: string;
  updatedAt: string;
  tenantId?: number;
  _suggestion?: LeadSuggestion;
}

interface HudStats {
  callsMadeToday: number;
  bookingsToday: number;
  bookingRate: number;
  commission: number;
  newLeadsToday: number;
  avgSpeedToLead: number;
  soldToday: number;
  bonusTier: string;
  bonusThreshold: number;
  nextBonusAt: number;
}

interface CommConfig {
  callPlatform: string;
  textPlatform: string;
  callReady: boolean;
  textReady: boolean;
  callStatusMessage: string;
  textStatusMessage: string;
}

function useCommConfig() {
  const [config, setConfig] = useState<CommConfig>({
    callPlatform: "native",
    textPlatform: "native",
    callReady: true,
    textReady: true,
    callStatusMessage: "Using native phone dialer",
    textStatusMessage: "Using native SMS app",
  });

  useEffect(() => {
    fetch(`${API_BASE}/leads/comm-config`, { credentials: "include" })
      .then(r => r.json())
      .then(data => setConfig(data))
      .catch(() => {});
  }, []);

  return config;
}

function useHudQueue(tenantId?: number | null, isAgency?: boolean) {
  const [queue, setQueue] = useState<{ newLeads: LeadData[]; followUps: LeadData[]; background: LeadData[] }>({ newLeads: [], followUps: [], background: [] });
  const shouldFetch = !isAgency || tenantId !== null;
  const [loading, setLoading] = useState(shouldFetch);

  const fetchQueue = useCallback(async () => {
    if (!shouldFetch) return;
    try {
      const url = tenantId
        ? `${API_BASE}/leads/hud/queue?tenantId=${tenantId}`
        : `${API_BASE}/leads/hud/queue`;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setQueue(data);
      }
    } catch (e) {
      console.error("Failed to fetch Pulse queue:", e);
    } finally {
      setLoading(false);
    }
  }, [tenantId, shouldFetch]);

  useEffect(() => {
    if (!shouldFetch) return;
    fetchQueue();
    const interval = setInterval(fetchQueue, 15000);
    return () => clearInterval(interval);
  }, [fetchQueue, shouldFetch]);

  return { queue, loading, refetch: fetchQueue };
}

function useHudStats(tenantId?: number | null, isAgency?: boolean) {
  const [stats, setStats] = useState<HudStats>({
    callsMadeToday: 0, bookingsToday: 0, bookingRate: 0, commission: 0,
    newLeadsToday: 0, avgSpeedToLead: 0, soldToday: 0,
    bonusTier: "none", bonusThreshold: 30, nextBonusAt: 30,
  });

  const shouldFetch = !isAgency || tenantId !== null;

  const fetchStats = useCallback(async () => {
    if (!shouldFetch) return;
    try {
      const url = tenantId
        ? `${API_BASE}/leads/hud/stats?tenantId=${tenantId}`
        : `${API_BASE}/leads/hud/stats`;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (e) {
      console.error("Failed to fetch Pulse stats:", e);
    }
  }, [tenantId, shouldFetch]);

  useEffect(() => {
    if (!shouldFetch) return;
    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, [fetchStats, shouldFetch]);

  return { stats, refetch: fetchStats };
}

type ComparisonBaseline = "yesterday" | "last_week" | "monthly_avg" | "all_time_best";

interface StatDelta {
  value: number;
  baseline: number;
  delta: number;
  percentChange: number;
  direction: "up" | "down" | "flat";
}

interface ComparisonData {
  baseline: ComparisonBaseline;
  today: { callsMade: number; bookingsCount: number; bookingRate: number; commission: number; avgSpeedToLead: number };
  deltas: {
    callsMade: StatDelta;
    bookingsCount: StatDelta;
    bookingRate: StatDelta;
    commission: StatDelta;
    avgSpeedToLead: StatDelta;
  };
}

interface HistoricalDay {
  date: string;
  callsMade: number;
  bookingsCount: number;
  bookingRate: number;
  commission: number;
  avgSpeedToLead: number;
}

interface HistoricalData {
  dailyStats: HistoricalDay[];
  personalBests: Record<string, { value: number; date: string | null }>;
  totalDays: number;
}

function useComparisonStats(baseline: ComparisonBaseline, tenantId?: number | null, isAgency?: boolean) {
  const [data, setData] = useState<ComparisonData | null>(null);

  const shouldFetch = !isAgency || tenantId !== null;

  const fetchComparison = useCallback(async () => {
    if (!shouldFetch) return;
    try {
      let url = `${API_BASE}/leads/hud/comparison?baseline=${baseline}`;
      if (tenantId) url += `&tenantId=${tenantId}`;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) setData(await res.json());
    } catch {}
  }, [baseline, tenantId, shouldFetch]);

  useEffect(() => {
    if (!shouldFetch) return;
    fetchComparison();
    const interval = setInterval(fetchComparison, 30000);
    return () => clearInterval(interval);
  }, [fetchComparison, shouldFetch]);

  return { data, refetch: fetchComparison };
}

function useHistoricalStats(range: number, startDate?: string, endDate?: string, tenantId?: number | null) {
  const [data, setData] = useState<HistoricalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    setFetching(true);
    let url = `${API_BASE}/leads/hud/historical?range=${range}`;
    if (startDate && endDate) {
      url = `${API_BASE}/leads/hud/historical?startDate=${startDate}&endDate=${endDate}`;
    }
    if (tenantId) url += `&tenantId=${tenantId}`;
    fetch(url, { credentials: "include" })
      .then(r => r.json())
      .then(d => { setData(d); })
      .catch(() => {})
      .finally(() => { setLoading(false); setFetching(false); });
  }, [range, startDate, endDate, tenantId]);

  return { data, loading, fetching };
}

const BASELINE_LABELS: Record<ComparisonBaseline, string> = {
  yesterday: "vs Yesterday",
  last_week: "vs Last Week",
  monthly_avg: "vs 30-Day Avg",
  all_time_best: "vs Best Day",
};

function DeltaIndicator({ delta, invertColor = false, compact = false }: {
  delta: StatDelta | undefined;
  invertColor?: boolean;
  compact?: boolean;
}) {
  if (!delta || (delta.baseline === 0 && delta.value === 0)) return null;

  const isPositive = delta.direction === "up";
  const isNegative = delta.direction === "down";

  const goodDirection = invertColor ? isNegative : isPositive;
  const badDirection = invertColor ? isPositive : isNegative;

  const colorClass = goodDirection
    ? "text-emerald-400"
    : badDirection
    ? "text-red-400"
    : "text-white/40";

  const Icon = isPositive ? ArrowUpRight : isNegative ? ArrowDownRight : Minus;

  if (compact) {
    return (
      <span className={cn("inline-flex items-center gap-0.5 text-[10px] font-mono", colorClass)}>
        <Icon className="w-2.5 h-2.5" />
        {Math.abs(delta.percentChange)}%
      </span>
    );
  }

  return (
    <div className={cn("flex items-center gap-1 mt-1", colorClass)}>
      <Icon className="w-3 h-3" />
      <span className="text-[11px] font-mono">
        {delta.delta > 0 ? "+" : ""}{delta.delta}
      </span>
      <span className="text-[10px] opacity-60">
        ({Math.abs(delta.percentChange)}%)
      </span>
    </div>
  );
}

function HistoricalView({ tenantId }: { tenantId?: number | null }) {
  const [rangeMode, setRangeMode] = useState<"preset" | "custom">("preset");
  const [range, setRange] = useState(30);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [metric, setMetric] = useState<"callsMade" | "bookingsCount" | "bookingRate" | "commission" | "avgSpeedToLead">("callsMade");

  const startDate = rangeMode === "custom" && customStart ? customStart : undefined;
  const endDate = rangeMode === "custom" && customEnd ? customEnd : undefined;
  const { data, loading, fetching } = useHistoricalStats(range, startDate, endDate, tenantId);

  const metricConfig = {
    callsMade: { label: "Calls", color: "#60a5fa", format: (v: number) => `${v}` },
    bookingsCount: { label: "Bookings", color: "#34d399", format: (v: number) => `${v}` },
    bookingRate: { label: "Rate", color: "#fbbf24", format: (v: number) => `${v}%` },
    commission: { label: "Earned", color: "#34d399", format: (v: number) => `$${v}` },
    avgSpeedToLead: { label: "Speed", color: "#f59e0b", format: (v: number) => `${v}s` },
  };

  const config = metricConfig[metric];

  const chartData = (data?.dailyStats || []).map(d => ({
    date: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    value: d[metric],
    fullDate: d.date,
  }));

  const handlePreset = (r: number) => {
    setRangeMode("preset");
    setRange(r);
  };

  if (loading) {
    return (
      <PremiumCard className="p-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
        </div>
      </PremiumCard>
    );
  }

  return (
    <PremiumCard className={cn("p-5 transition-opacity duration-200", fetching && "opacity-70")}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary" />
          <span className="text-sm font-display text-white">Performance History</span>
        </div>
        <div className="flex items-center gap-1.5">
          {[7, 30, 90].map(r => (
            <button
              key={r}
              onClick={() => handlePreset(r)}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] font-mono uppercase transition-colors",
                rangeMode === "preset" && range === r
                  ? "bg-primary/20 text-primary border border-primary/30"
                  : "text-white/30 hover:text-white/50"
              )}
            >
              {r}d
            </button>
          ))}
          <button
            onClick={() => setRangeMode(rangeMode === "custom" ? "preset" : "custom")}
            className={cn(
              "px-2 py-0.5 rounded text-[10px] font-mono uppercase transition-colors",
              rangeMode === "custom"
                ? "bg-primary/20 text-primary border border-primary/30"
                : "text-white/30 hover:text-white/50"
            )}
          >
            Custom
          </button>
        </div>
      </div>

      {rangeMode === "custom" && (
        <div className="flex items-center gap-2 mb-3">
          <input
            type="date"
            value={customStart}
            onChange={e => setCustomStart(e.target.value)}
            className="bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white/70 font-mono [color-scheme:dark]"
          />
          <span className="text-white/20 text-[10px]">to</span>
          <input
            type="date"
            value={customEnd}
            onChange={e => setCustomEnd(e.target.value)}
            className="bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white/70 font-mono [color-scheme:dark]"
          />
        </div>
      )}

      <div className="flex gap-1 mb-4">
        {(Object.keys(metricConfig) as Array<keyof typeof metricConfig>).map(key => (
          <button
            key={key}
            onClick={() => setMetric(key)}
            data-metric={key}
            className={cn(
              "px-2.5 py-1 rounded-md text-[10px] uppercase tracking-wider transition-colors",
              metric === key
                ? "bg-white/10 text-white border border-white/10"
                : "text-white/30 hover:text-white/50"
            )}
          >
            {metricConfig[key].label}
          </button>
        ))}
      </div>

      {chartData.length === 0 ? (
        <div className="text-center py-12">
          <History className="w-8 h-8 text-white/10 mx-auto mb-2" />
          <p className="text-xs text-white/30">No historical data yet</p>
          <p className="text-[10px] text-white/20 mt-1">Stats are recorded daily — check back tomorrow</p>
        </div>
      ) : (
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id={`gradient-${metric}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={config.color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={config.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="date"
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 9 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 9 }}
                tickLine={false}
                axisLine={false}
                width={35}
                tickFormatter={config.format}
              />
              <RechartsTooltip
                contentStyle={{
                  backgroundColor: "rgba(15,15,25,0.95)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "8px",
                  fontSize: "11px",
                  color: "#fff",
                }}
                formatter={(value: number) => [config.format(value), config.label]}
                labelFormatter={(label: string) => label}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={config.color}
                strokeWidth={2}
                fill={`url(#gradient-${metric})`}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {data && data.personalBests && (
        <div className="grid grid-cols-5 gap-1.5 mt-4 pt-3 border-t border-white/5">
          {([
            ["callsMade", "Best Calls", ""],
            ["bookingsCount", "Best Booked", ""],
            ["bookingRate", "Best Rate", "%"],
            ["commission", "Best $", "$"],
            ["avgSpeedToLead", "Best Speed", "s"],
          ] as const).map(([key, label, suffix]) => {
            const best = data.personalBests[key];
            const dateStr = best?.date ? new Date(best.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
            return (
              <div key={key} className="text-center">
                <p className="text-[9px] text-white/30 uppercase leading-tight">{label}</p>
                <p className="text-xs font-mono text-white/70 mt-0.5">
                  {suffix === "$" ? "$" : ""}{best?.value ?? 0}{suffix !== "$" ? suffix : ""}
                </p>
                {dateStr && <p className="text-[8px] text-white/20">{dateStr}</p>}
              </div>
            );
          })}
        </div>
      )}
    </PremiumCard>
  );
}

function useSocketIO(tenantId: number | null, isAgency: boolean) {
  const [latestLead, setLatestLead] = useState<LeadData | null>(null);
  const [leadUpdatedSignal, setLeadUpdatedSignal] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const socketRef = useRef<IOSocket | null>(null);
  const tenantIdRef = useRef(tenantId);

  useEffect(() => {
    tenantIdRef.current = tenantId;
  }, [tenantId]);

  useEffect(() => {
    const audio = new Audio("data:audio/wav;base64,UklGRl9vT19teleVlfT0+AU5EIBAAAABkAAAAFAAMAeAAAAAA=");
    audio.volume = 0.3;
    audioRef.current = audio;
  }, []);

  useEffect(() => {
    const socket = socketIOClient({
      path: "/api/socket.io",
      withCredentials: true,
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[Pulse] Socket.IO connected:", socket.id);
    });

    socket.on("new-lead", (lead: LeadData) => {
      const viewingTenant = tenantIdRef.current;
      if (viewingTenant && lead.tenantId && lead.tenantId !== viewingTenant) {
        return;
      }
      setLatestLead(lead);
      if (soundEnabled && audioRef.current) {
        audioRef.current.play().catch(() => {});
      }
    });

    socket.on("lead-updated", () => {
      setLeadUpdatedSignal(prev => prev + 1);
    });

    socket.on("disconnect", () => {
      console.log("[Pulse] Socket.IO disconnected");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [tenantId, isAgency, soundEnabled]);

  const clearLatestLead = useCallback(() => {
    setLatestLead(null);
  }, []);

  return { latestLead, clearLatestLead, leadUpdatedSignal, soundEnabled, setSoundEnabled };
}

function LeadTimer({ createdAt }: { createdAt: string }) {
  const [elapsed, setElapsed] = useState("");
  const [urgency, setUrgency] = useState<"green" | "amber" | "red">("green");

  useEffect(() => {
    const update = () => {
      const diff = Date.now() - new Date(createdAt).getTime();
      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);

      if (hours > 0) {
        setElapsed(`${hours}h ${minutes % 60}m`);
      } else if (minutes > 0) {
        setElapsed(`${minutes}m ${seconds % 60}s`);
      } else {
        setElapsed(`${seconds}s`);
      }

      if (minutes >= 5) setUrgency("red");
      else if (minutes >= 2) setUrgency("amber");
      else setUrgency("green");
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [createdAt]);

  const colors = {
    green: "text-emerald-400",
    amber: "text-amber-400 animate-pulse",
    red: "text-red-400 animate-pulse",
  };

  return (
    <span className={cn("font-mono text-sm font-bold tabular-nums", colors[urgency])}>
      <Clock className="w-3.5 h-3.5 inline mr-1" />
      {elapsed}
    </span>
  );
}

function CommissionTicker({ amount, show }: { amount: number; show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.5 }}
          animate={{ opacity: 1, y: -30, scale: 1.2 }}
          exit={{ opacity: 0, y: -60, scale: 0.8 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="fixed top-20 right-10 z-50 pointer-events-none"
        >
          <div className="flex items-center gap-2">
            <span className="text-4xl font-display text-emerald-400 drop-shadow-[0_0_20px_rgba(52,211,153,0.8)]">
              +${amount}
            </span>
            <span className="text-2xl">💰</span>
          </div>
          <div className="text-center text-emerald-300 text-sm font-bold mt-1 animate-pulse">
            BING!
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  if (platform === "native") return null;
  const colors = platform === "callrail"
    ? "bg-green-500/10 border-green-500/20 text-green-400"
    : "bg-blue-500/10 border-blue-500/20 text-blue-400";
  const label = platform === "callrail" ? "CallRail" : "Podium";
  return (
    <span className={cn("text-[9px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wider", colors)}>
      {label}
    </span>
  );
}

function ActionFeedback({ status, message }: { status: "success" | "error" | null; message: string }) {
  if (!status) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className={cn(
        "mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs",
        status === "success" ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400" : "bg-red-500/10 border border-red-500/20 text-red-400"
      )}
    >
      {status === "success" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
      {message}
    </motion.div>
  );
}

function LeadCard({
  lead,
  isNew,
  onDisposition,
  isProcessing,
  commConfig,
  scripts,
}: {
  lead: LeadData;
  isNew: boolean;
  onDisposition: (leadId: number, disposition: string, status: string) => void;
  isProcessing: boolean;
  commConfig: CommConfig;
  scripts: ScriptRecord[];
}) {
  const [showDisposition, setShowDisposition] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [showVoicemail, setShowVoicemail] = useState(false);
  const [callLoading, setCallLoading] = useState(false);
  const [textLoading, setTextLoading] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ status: "success" | "error"; message: string } | null>(null);
  const [showWhyOrder, setShowWhyOrder] = useState(false);
  const suggestion = lead._suggestion;
  const script = findScript(scripts, "call", lead.source, lead.status) || FALLBACK_SCRIPTS[lead.source] || FALLBACK_SCRIPTS["Direct"];
  const vmScript = findScript(scripts, "voicemail", lead.source, lead.status) || FALLBACK_VM[lead.source] || FALLBACK_VM["default"];
  const personalizedVm = vmScript
    .replace("[NAME]", lead.firstName)
    .replace("[INTEREST]", lead.interestType || "HVAC service")
    .replace("[REP]", "your name")
    .replace("[COMPANY]", "our company");
  const personalizedScript = script
    .replace("[NAME]", lead.firstName)
    .replace("[INTEREST]", lead.interestType || "HVAC service")
    .replace("[REP]", "your name")
    .replace("[COMPANY]", "our company");

  const showFeedback = (status: "success" | "error", message: string) => {
    setActionFeedback({ status, message });
    setTimeout(() => setActionFeedback(null), 3000);
  };

  const handleCall = async () => {
    if (!lead.phone) return;

    if (commConfig.callPlatform === "native") {
      window.open(`tel:${lead.phone.replace(/[^0-9+]/g, "")}`, "_self");
      return;
    }

    setCallLoading(true);
    try {
      const res = await fetch(`${API_BASE}/leads/${lead.id}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success) {
        showFeedback("success", data.message);
      } else {
        showFeedback("error", data.message || "Call failed");
        window.open(`tel:${lead.phone.replace(/[^0-9+]/g, "")}`, "_self");
      }
    } catch {
      showFeedback("error", "Connection error — falling back to native dialer");
      window.open(`tel:${lead.phone.replace(/[^0-9+]/g, "")}`, "_self");
    } finally {
      setCallLoading(false);
    }
  };

  const handleText = async () => {
    if (!lead.phone) return;
    const textTemplate = findScript(scripts, "text", lead.source, lead.status) || FALLBACK_TEXT;
    const msg = textTemplate
      .replace("[NAME]", lead.firstName)
      .replace("[INTEREST]", lead.interestType || "HVAC")
      .replace("[REP]", "your name")
      .replace("[COMPANY]", "our company");

    if (commConfig.textPlatform === "native") {
      window.open(`sms:${lead.phone.replace(/[^0-9+]/g, "")}?body=${encodeURIComponent(msg)}`);
      return;
    }

    setTextLoading(true);
    try {
      const res = await fetch(`${API_BASE}/leads/${lead.id}/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      if (data.success) {
        showFeedback("success", data.message);
      } else {
        showFeedback("error", data.message || "Text failed");
        window.open(`sms:${lead.phone.replace(/[^0-9+]/g, "")}?body=${encodeURIComponent(msg)}`);
      }
    } catch {
      showFeedback("error", "Connection error — falling back to native SMS");
      window.open(`sms:${lead.phone.replace(/[^0-9+]/g, "")}?body=${encodeURIComponent(msg)}`);
    } finally {
      setTextLoading(false);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -20, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 20, scale: 0.95 }}
      className={cn(
        "relative rounded-xl border p-4 transition-all duration-300",
        isNew
          ? "bg-gradient-to-r from-red-500/10 via-card/80 to-card/80 border-red-500/30 shadow-[0_0_30px_rgba(242,5,5,0.15)]"
          : "bg-card/60 border-white/5 hover:border-white/10"
      )}
    >
      {isNew && (
        <div className="absolute -top-2 -right-2">
          <span className="relative flex h-5 w-5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-5 w-5 bg-red-500 items-center justify-center">
              <Zap className="w-3 h-3 text-white" />
            </span>
          </span>
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <h3 className="font-display text-lg text-white truncate">
              {lead.firstName} {lead.lastName}
            </h3>
            <Badge variant={isNew ? "danger" : lead.status === "contacted" ? "warning" : "neutral"}>
              {isNew ? "NEW" : lead.status.toUpperCase()}
            </Badge>
            {lead.isNewCustomer && (
              <Badge variant="success" className="text-[10px]">NEW CUSTOMER</Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className={cn(
                "w-2 h-2 rounded-full",
                lead.source.includes("Google") ? "bg-blue-400" :
                lead.source.includes("Meta") ? "bg-indigo-400" :
                lead.source.includes("Call") ? "bg-green-400" : "bg-gray-400"
              )} />
              {lead.source}
            </span>
            {lead.interestType && (
              <span className="text-white/70">{lead.interestType}</span>
            )}
            {lead.leadType && (
              <span className="text-white/50 text-xs">{lead.leadType}</span>
            )}
            {lead.phone && (
              <span className="text-white/60 font-mono text-xs">{lead.phone}</span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <LeadTimer createdAt={lead.createdAt} />
        </div>
      </div>

      {suggestion && (
        <div className="mt-3 space-y-1.5">
          <div
            onClick={() => setShowWhyOrder(!showWhyOrder)}
            className={cn(
              "flex items-center gap-2 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors",
              suggestion.inOptimalWindow
                ? "bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/15"
                : suggestion.doubleDial
                  ? "bg-orange-500/10 border-orange-500/20 hover:bg-orange-500/15"
                  : "bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15"
          )}>
            <Brain className={cn(
              "w-4 h-4 shrink-0",
              suggestion.inOptimalWindow ? "text-emerald-400" : suggestion.doubleDial ? "text-orange-400" : "text-amber-400"
            )} />
            <div className="flex-1 min-w-0">
              <p className={cn(
                "text-xs font-medium",
                suggestion.inOptimalWindow ? "text-emerald-300" : suggestion.doubleDial ? "text-orange-300" : "text-amber-300"
              )}>
                {suggestion.reason}
              </p>
              <div className="flex items-center gap-3 mt-1">
                {suggestion.bestTimeWindow && (
                  <span className="flex items-center gap-1 text-[10px] text-white/50">
                    <Calendar className="w-3 h-3" /> {suggestion.bestTimeWindow}
                  </span>
                )}
                {suggestion.doubleDial && (
                  <span className="flex items-center gap-1 text-[10px] text-orange-400/80">
                    <PhoneForwarded className="w-3 h-3" /> Double-dial recommended
                  </span>
                )}
                {suggestion.totalAttempts > 0 && (
                  <span className="text-[10px] text-white/40">
                    {suggestion.totalAttempts} attempt{suggestion.totalAttempts !== 1 ? "s" : ""}
                    {suggestion.failedAttempts > 0 && ` · ${suggestion.failedAttempts} missed`}
                  </span>
                )}
              </div>
            </div>
            <Info className={cn(
              "w-3.5 h-3.5 shrink-0 transition-colors",
              showWhyOrder ? "text-white/60" : "text-white/30"
            )} />
          </div>
          <AnimatePresence>
            {showWhyOrder && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/5 border border-white/5">
                  <TrendingUp className="w-3.5 h-3.5 text-white/40 shrink-0" />
                  <span className="text-[10px] text-white/40">
                    Priority: {suggestion.priorityScore}/100 — {suggestion.priorityReason}
                    {suggestion.confidenceScore > 0 && ` · Confidence: ${suggestion.confidenceScore}%`}
                  </span>
                  {suggestion.inOptimalWindow && (
                    <span className="ml-auto text-[10px] text-emerald-400/70 flex items-center gap-1">
                      <Zap className="w-3 h-3" /> Optimal window
                    </span>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <button
          onClick={handleCall}
          disabled={!lead.phone || callLoading}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20 transition-colors",
            (!lead.phone || callLoading) && "opacity-50 cursor-not-allowed"
          )}
        >
          {callLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
          Call
          <PlatformBadge platform={commConfig.callPlatform} />
        </button>
        <button
          onClick={handleText}
          disabled={!lead.phone || textLoading}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-medium hover:bg-blue-500/20 transition-colors",
            (!lead.phone || textLoading) && "opacity-50 cursor-not-allowed"
          )}
        >
          {textLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
          Text
          <PlatformBadge platform={commConfig.textPlatform} />
        </button>
        <a
          href={lead.email ? `mailto:${lead.email}?subject=Your HVAC Inquiry&body=${encodeURIComponent(`Hi ${lead.firstName},\n\nThank you for your interest in ${lead.interestType || 'our HVAC services'}. I'd love to schedule a time to discuss your needs.\n\nBest regards`)}` : "#"}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 text-xs font-medium hover:bg-purple-500/20 transition-colors"
        >
          <Mail className="w-3.5 h-3.5" /> Email
        </a>
        <button
          onClick={() => { setShowScript(!showScript); if (showVoicemail) setShowVoicemail(false); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 text-xs font-medium hover:bg-white/10 transition-colors"
        >
          <Mic className="w-3.5 h-3.5" /> {showScript ? "Hide" : "Script"}
        </button>
        <button
          onClick={() => { setShowVoicemail(!showVoicemail); if (showScript) setShowScript(false); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-400 text-xs font-medium hover:bg-orange-500/20 transition-colors"
        >
          <Volume2 className="w-3.5 h-3.5" /> {showVoicemail ? "Hide VM" : "VM Drop"}
        </button>

        <div className="ml-auto relative">
          <button
            onClick={() => setShowDisposition(!showDisposition)}
            disabled={isProcessing}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              "bg-white/5 border border-white/10 text-white/60 hover:bg-white/10",
              isProcessing && "opacity-50 cursor-not-allowed"
            )}
          >
            <Target className="w-3.5 h-3.5" />
            {isProcessing ? "Saving..." : "Log Outcome"}
            <ChevronDown className="w-3 h-3" />
          </button>
          {showDisposition && !isProcessing && (
            <div className="absolute right-0 mt-1 w-52 bg-card border border-white/10 rounded-lg shadow-2xl z-20 overflow-hidden">
              {DISPOSITIONS.map(d => (
                <button
                  key={d.value}
                  onClick={() => {
                    const newStatus = d.value === "booked" ? "booked" : "contacted";
                    onDisposition(lead.id, d.value, newStatus);
                    setShowDisposition(false);
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition-colors flex items-center gap-2"
                >
                  <span className={cn(
                    "w-2 h-2 rounded-full",
                    d.color === "emerald" ? "bg-emerald-400" :
                    d.color === "amber" ? "bg-amber-400" :
                    d.color === "red" ? "bg-red-400" :
                    d.color === "blue" ? "bg-blue-400" : "bg-gray-400"
                  )} />
                  {d.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {actionFeedback && <ActionFeedback status={actionFeedback.status} message={actionFeedback.message} />}
      </AnimatePresence>

      <AnimatePresence>
        {showScript && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3 p-3 rounded-lg bg-white/5 border border-white/5">
              <p className="text-xs text-white/50 uppercase tracking-wider mb-1.5 font-medium">Call Script — {lead.source}</p>
              <p className="text-sm text-gray-300 leading-relaxed">{personalizedScript}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showVoicemail && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3 p-3 rounded-lg bg-orange-500/5 border border-orange-500/10">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs text-orange-400/70 uppercase tracking-wider font-medium">Voicemail Drop Script</p>
                <button
                  onClick={() => navigator.clipboard.writeText(personalizedVm)}
                  className="text-[10px] text-orange-400/60 hover:text-orange-400 transition-colors"
                >
                  Copy
                </button>
              </div>
              <p className="text-sm text-gray-300 leading-relaxed">{personalizedVm}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function Leads() {
  const { tenants, localTenantId, effectiveTenantId, setSelectedTenantId, isAgency } = useTenantFilter();

  const { queue, loading, refetch } = useHudQueue(effectiveTenantId, isAgency);
  const { stats, refetch: refetchStats } = useHudStats(effectiveTenantId, isAgency);
  const commConfig = useCommConfig();
  const scripts = useScripts(effectiveTenantId);
  const { latestLead, clearLatestLead, leadUpdatedSignal, soundEnabled, setSoundEnabled } = useSocketIO(effectiveTenantId, isAgency);
  const [notificationLead, setNotificationLead] = useState<LeadData | null>(null);
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedLeadId, setHighlightedLeadId] = useState<number | null>(null);
  const leadRefsMap = useRef<Map<number, HTMLDivElement>>(new Map());
  const [processingLeads, setProcessingLeads] = useState<Set<number>>(new Set());
  const [showCommission, setShowCommission] = useState(false);
  const [lastSpiffAmount, setLastSpiffAmount] = useState(20);
  const [baseline, setBaseline] = useState<ComparisonBaseline>("yesterday");
  const [showHistory, setShowHistory] = useState(false);
  const { data: comparison, refetch: refetchComparison } = useComparisonStats(baseline, effectiveTenantId, isAgency);

  useEffect(() => {
    if (latestLead) {
      setNotificationLead(latestLead);
      if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = setTimeout(() => {
        setNotificationLead(null);
        clearLatestLead();
      }, 20000);
      refetch();
      refetchStats();
      refetchComparison();
    }
  }, [latestLead, refetch, refetchStats, refetchComparison, clearLatestLead]);

  const dismissNotification = useCallback(() => {
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
    setNotificationLead(null);
    clearLatestLead();
  }, [clearLatestLead]);

  const handleNotificationClick = useCallback(() => {
    if (!notificationLead) return;
    const leadId = notificationLead.id;
    dismissNotification();
    let attempts = 0;
    const tryScroll = () => {
      const el = leadRefsMap.current.get(leadId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightedLeadId(leadId);
        setTimeout(() => setHighlightedLeadId(null), 1500);
      } else if (attempts < 10) {
        attempts++;
        setTimeout(tryScroll, 200);
      }
    };
    setTimeout(tryScroll, 100);
  }, [notificationLead, dismissNotification]);

  useEffect(() => {
    return () => {
      if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (leadUpdatedSignal > 0) {
      refetch();
      refetchStats();
      refetchComparison();
    }
  }, [leadUpdatedSignal, refetch, refetchStats, refetchComparison]);

  const handleDisposition = async (leadId: number, disposition: string, status: string) => {
    setProcessingLeads(prev => new Set(prev).add(leadId));
    const prevCommission = stats.commission;
    try {
      const res = await fetch(`${API_BASE}/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ disposition, status }),
      });
      if (res.ok) {
        const [, freshStats] = await Promise.all([
          refetch(),
          fetch(
            effectiveTenantId
              ? `${API_BASE}/leads/hud/stats?tenantId=${effectiveTenantId}`
              : `${API_BASE}/leads/hud/stats`,
            { credentials: "include" }
          ).then(r => r.ok ? r.json() : null),
          refetchStats(),
          refetchComparison(),
        ]);
        if (disposition === "booked") {
          const newCommission = freshStats?.commission ?? stats.commission;
          const earned = newCommission - prevCommission;
          if (earned > 0) {
            setLastSpiffAmount(earned);
            setShowCommission(true);
            setTimeout(() => setShowCommission(false), 2000);
          }
        }
      }
    } catch (e) {
      console.error("Failed to update disposition:", e);
    } finally {
      setProcessingLeads(prev => {
        const next = new Set(prev);
        next.delete(leadId);
        return next;
      });
    }
  };

  const unifiedQueue = [
    ...queue.newLeads.map(l => ({ ...l, _priority: "new" as const })),
    ...queue.followUps.map(l => ({ ...l, _priority: "followup" as const })),
    ...queue.background.map(l => ({ ...l, _priority: "background" as const })),
  ];

  return (
    <div className="relative min-h-screen">
      <AnimatePresence>
        {notificationLead && (
          <motion.div
            key={`notif-${notificationLead.id}`}
            initial={{ x: 400, opacity: 0, scale: 0.9 }}
            animate={{ x: 0, opacity: 1, scale: 1 }}
            exit={{ x: 400, opacity: 0, scale: 0.95 }}
            transition={{ type: "spring", damping: 20, stiffness: 300 }}
            className="fixed top-6 right-6 z-50 w-80"
          >
            <div
              onClick={handleNotificationClick}
              className="relative overflow-hidden rounded-xl border border-red-500/40 bg-gradient-to-br from-red-950/90 via-card/95 to-card/95 shadow-[0_0_40px_rgba(242,5,5,0.25),0_0_80px_rgba(242,5,5,0.1)] backdrop-blur-xl cursor-pointer hover:border-red-500/60 transition-colors"
            >
              <motion.div
                className="absolute inset-0 bg-red-500/20 pointer-events-none"
                animate={{ opacity: [0.3, 0, 0.2, 0, 0.15, 0] }}
                transition={{ duration: 2, repeat: 2, ease: "easeInOut" }}
              />
              <motion.div
                className="absolute inset-0 rounded-xl pointer-events-none"
                animate={{
                  boxShadow: [
                    "inset 0 0 20px rgba(242,5,5,0.3)",
                    "inset 0 0 5px rgba(242,5,5,0.05)",
                    "inset 0 0 15px rgba(242,5,5,0.2)",
                    "inset 0 0 5px rgba(242,5,5,0.05)",
                  ],
                }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
              />
              <div className="relative p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-6 w-6">
                      <motion.span
                        className="absolute inline-flex h-full w-full rounded-full bg-red-500"
                        animate={{ scale: [1, 1.8, 1], opacity: [0.75, 0, 0.75] }}
                        transition={{ duration: 1.2, repeat: Infinity }}
                      />
                      <span className="relative inline-flex rounded-full h-6 w-6 bg-red-500 items-center justify-center">
                        <Zap className="w-3.5 h-3.5 text-white" />
                      </span>
                    </span>
                    <motion.span
                      className="text-sm font-display font-bold tracking-wide uppercase text-red-400"
                      animate={{ opacity: [1, 0.6, 1] }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                    >
                      New Lead!
                    </motion.span>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); dismissNotification(); }}
                    className="text-white/40 hover:text-white/80 transition-colors p-0.5 rounded hover:bg-white/10"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="space-y-1.5">
                  <p className="text-white font-display text-base">
                    {notificationLead.firstName} {notificationLead.lastName}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <span className={cn(
                      "w-1.5 h-1.5 rounded-full",
                      notificationLead.source.includes("Google") ? "bg-blue-400" :
                      notificationLead.source.includes("Meta") ? "bg-indigo-400" :
                      notificationLead.source.includes("Call") ? "bg-green-400" : "bg-gray-400"
                    )} />
                    <span>{notificationLead.source}</span>
                    {notificationLead.interestType && (
                      <>
                        <span className="text-white/20">·</span>
                        <span>{notificationLead.interestType}</span>
                      </>
                    )}
                  </div>
                  {notificationLead.phone && (
                    <p className="text-xs text-gray-500 font-mono">{notificationLead.phone}</p>
                  )}
                </div>
                <motion.div
                  className="absolute bottom-0 left-0 h-0.5 bg-red-500/60"
                  initial={{ width: "100%" }}
                  animate={{ width: "0%" }}
                  transition={{ duration: 20, ease: "linear" }}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <CommissionTicker amount={lastSpiffAmount} show={showCommission} />

      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-1 flex items-center gap-3">
            <img src="/pulse-logo.png" alt="Pulse" className="w-8 h-8" />
            Pulse
          </GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-[0.2em] uppercase">
            Speed-to-Lead Command Center
          </p>
        </div>
        <div className="flex items-center gap-3">
          {commConfig.callPlatform !== "native" && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-card/60 border border-white/5">
              <span className={cn(
                "w-2 h-2 rounded-full",
                commConfig.callReady ? "bg-emerald-400" : "bg-red-400"
              )} />
              <span className="text-[10px] text-white/50 uppercase">{commConfig.callPlatform}</span>
            </div>
          )}
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={cn(
              "p-2 rounded-lg border transition-colors",
              soundEnabled
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                : "bg-white/5 border-white/10 text-white/40"
            )}
            title={soundEnabled ? "Sound ON" : "Sound OFF"}
          >
            <Volume2 className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card/60 border border-white/5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
            </span>
            <span className="text-xs text-emerald-400 font-medium">LIVE</span>
          </div>
        </div>
      </header>

      {isAgency && tenants.length > 0 && (
        <PremiumCard className="p-4 mb-6">
          <div className="flex items-center gap-3">
            <label className="text-xs text-white/40 uppercase tracking-wider">Tenant</label>
            <select
              value={localTenantId ?? ""}
              onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v)) setSelectedTenantId(v); }}
              className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              {tenants.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </PremiumCard>
      )}

      <div className="flex gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-1.5">
              {queue.newLeads.length > 0 && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                </span>
              )}
              <span className="text-xs text-white/50 uppercase tracking-wider font-medium">Focus Queue</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-white/30">
              <span className="text-red-400 font-mono">{queue.newLeads.length} new</span>
              <span>·</span>
              <span className="text-amber-400 font-mono">{queue.followUps.length} follow-up</span>
              <span>·</span>
              <span className="text-white/30 font-mono">{queue.background.length} background</span>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="text-center">
                <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center mx-auto mb-4 animate-pulse">
                  <Zap className="w-6 h-6 text-primary" />
                </div>
                <p className="text-muted-foreground text-sm">Loading focus queue...</p>
              </div>
            </div>
          ) : unifiedQueue.length === 0 ? (
            <PremiumCard className="py-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 flex items-center justify-center mx-auto mb-4">
                <Star className="w-8 h-8 text-emerald-400" />
              </div>
              <h3 className="font-display text-xl text-white mb-2">Queue Clear</h3>
              <p className="text-muted-foreground text-sm max-w-md mx-auto">
                Waiting for new leads to arrive. You'll get a notification when one comes in.
              </p>
            </PremiumCard>
          ) : (
            <div className="space-y-3">
              <AnimatePresence mode="popLayout">
                {unifiedQueue.map((lead, idx) => {
                  const isFirstFollowUp = lead._priority === "followup" && (idx === 0 || unifiedQueue[idx - 1]._priority === "new");
                  const isFirstBackground = lead._priority === "background" && (idx === 0 || unifiedQueue[idx - 1]._priority !== "background");
                  return (
                    <div
                      key={lead.id}
                      ref={(el) => {
                        if (el) leadRefsMap.current.set(lead.id, el);
                        else leadRefsMap.current.delete(lead.id);
                      }}
                    >
                      {isFirstFollowUp && (
                        <div className="flex items-center gap-2 mb-2 mt-4">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                          <span className="text-xs text-amber-400 uppercase tracking-wider font-medium">Follow Up</span>
                          <div className="flex-1 h-px bg-amber-500/20" />
                        </div>
                      )}
                      {isFirstBackground && (
                        <div className="flex items-center gap-2 mb-2 mt-4">
                          <span className="text-xs text-white/30 uppercase tracking-wider font-medium">Background</span>
                          <div className="flex-1 h-px bg-white/5" />
                        </div>
                      )}
                      <div className={cn(
                        lead._priority === "background" && "opacity-50",
                        highlightedLeadId === lead.id && "animate-pulse rounded-xl ring-2 ring-red-500 shadow-[0_0_30px_rgba(242,5,5,0.4)]"
                      )}>
                        <LeadCard
                          lead={lead}
                          isNew={lead._priority === "new"}
                          onDisposition={handleDisposition}
                          isProcessing={processingLeads.has(lead.id)}
                          commConfig={commConfig}
                          scripts={scripts}
                        />
                      </div>
                    </div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>

        <aside className="hidden lg:flex flex-col gap-3 w-72 shrink-0 sticky top-4 self-start">
          <div className="flex items-center justify-between mb-1">
            <select
              value={baseline}
              onChange={(e) => setBaseline(e.target.value as ComparisonBaseline)}
              className="bg-transparent text-[10px] text-white/40 uppercase tracking-wider border-none outline-none cursor-pointer font-mono"
            >
              {(Object.keys(BASELINE_LABELS) as ComparisonBaseline[]).map(b => (
                <option key={b} value={b} className="bg-[#0f0f19]">{BASELINE_LABELS[b]}</option>
              ))}
            </select>
            <button
              onClick={() => setShowHistory(!showHistory)}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                showHistory ? "bg-primary/20 text-primary" : "text-white/30 hover:text-white/50"
              )}
              title="Performance History"
            >
              <BarChart3 className="w-3.5 h-3.5" />
            </button>
          </div>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <PhoneCall className="w-5 h-5 text-blue-400" />
              <span className="text-xs text-blue-400/60 uppercase tracking-wider">Calls</span>
            </div>
            <div className="flex items-baseline gap-2">
              <p className="text-3xl font-display text-white">{comparison?.today.callsMade ?? stats.callsMadeToday}</p>
              <DeltaIndicator delta={comparison?.deltas.callsMade} compact />
            </div>
            <p className="text-xs text-muted-foreground mt-1">calls made today</p>
            <DeltaIndicator delta={comparison?.deltas.callsMade} />
          </PremiumCard>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <Target className="w-5 h-5 text-emerald-400" />
              <span className="text-xs text-emerald-400/60 uppercase tracking-wider">Booked</span>
            </div>
            <div className="flex items-baseline gap-2">
              <p className="text-3xl font-display text-white">{comparison?.today.bookingsCount ?? stats.bookingsToday}</p>
              <DeltaIndicator delta={comparison?.deltas.bookingsCount} compact />
            </div>
            <div className="mt-2 w-full bg-white/5 rounded-full h-1.5">
              <div
                className="h-full rounded-full bg-emerald-400 transition-all"
                style={{ width: `${Math.min(comparison?.today.bookingRate ?? stats.bookingRate, 100)}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">{comparison?.today.bookingRate ?? stats.bookingRate}% booking rate</p>
            <DeltaIndicator delta={comparison?.deltas.bookingRate} />
          </PremiumCard>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <Clock className="w-5 h-5 text-amber-400" />
              <span className="text-xs text-amber-400/60 uppercase tracking-wider">Speed</span>
            </div>
            <div className="flex items-baseline gap-2">
              <p className="text-3xl font-display text-white">{comparison?.today.avgSpeedToLead ?? stats.avgSpeedToLead}<span className="text-lg text-white/50">s</span></p>
              <DeltaIndicator delta={comparison?.deltas.avgSpeedToLead} invertColor compact />
            </div>
            <p className="text-xs text-muted-foreground mt-1">avg speed-to-lead</p>
            <DeltaIndicator delta={comparison?.deltas.avgSpeedToLead} invertColor />
          </PremiumCard>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <DollarSign className="w-5 h-5 text-emerald-400" />
              <span className="text-xs text-emerald-400/60 uppercase tracking-wider">Earned</span>
            </div>
            <div className="flex items-baseline gap-2">
              <p className="text-3xl font-display text-emerald-400">${comparison?.today.commission ?? stats.commission}</p>
              <DeltaIndicator delta={comparison?.deltas.commission} compact />
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              <span className="text-emerald-400/70">
                <DollarSign className="w-3 h-3 inline mr-0.5" />
                {stats.bookingsToday} booking{stats.bookingsToday !== 1 ? "s" : ""} today
              </span>
            </p>
            <DeltaIndicator delta={comparison?.deltas.commission} />
          </PremiumCard>

          <AnimatePresence>
            {showHistory && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
              >
                <HistoricalView tenantId={effectiveTenantId} />
              </motion.div>
            )}
          </AnimatePresence>
        </aside>
      </div>

      <div className="lg:hidden grid grid-cols-2 gap-3 mt-6">
        <PremiumCard className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <PhoneCall className="w-4 h-4 text-blue-400" />
            <span className="text-xs text-blue-400/60 uppercase">Calls</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <p className="text-xl font-display text-white">{comparison?.today.callsMade ?? stats.callsMadeToday}</p>
            <DeltaIndicator delta={comparison?.deltas.callsMade} compact />
          </div>
        </PremiumCard>
        <PremiumCard className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <Target className="w-4 h-4 text-emerald-400" />
            <span className="text-xs text-emerald-400/60 uppercase">Booked</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <p className="text-xl font-display text-white">{comparison?.today.bookingsCount ?? stats.bookingsToday} <span className="text-sm text-white/40">({comparison?.today.bookingRate ?? stats.bookingRate}%)</span></p>
            <DeltaIndicator delta={comparison?.deltas.bookingsCount} compact />
          </div>
        </PremiumCard>
        <PremiumCard className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-4 h-4 text-amber-400" />
            <span className="text-xs text-amber-400/60 uppercase">Speed</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <p className="text-xl font-display text-white">{comparison?.today.avgSpeedToLead ?? stats.avgSpeedToLead}s</p>
            <DeltaIndicator delta={comparison?.deltas.avgSpeedToLead} invertColor compact />
          </div>
        </PremiumCard>
        <PremiumCard className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="w-4 h-4 text-emerald-400" />
            <span className="text-xs text-emerald-400/60 uppercase">Earned</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <p className="text-xl font-display text-emerald-400">${comparison?.today.commission ?? stats.commission}</p>
            <DeltaIndicator delta={comparison?.deltas.commission} compact />
          </div>
        </PremiumCard>
      </div>
    </div>
  );
}
