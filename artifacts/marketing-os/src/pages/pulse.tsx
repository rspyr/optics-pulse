import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { useAuth } from "@/components/auth-context";
import { motion, AnimatePresence } from "framer-motion";
import { io as socketIOClient } from "socket.io-client";
import { useLeadNotification } from "@/contexts/lead-notification-context";
import {
  Phone, MessageSquare, Mic,
  Clock, Zap, X, Copy,
  ChevronDown, ChevronRight,
  Calendar, PhoneCall, Check,
  Volume2, DollarSign, Loader2, CheckCircle2, XCircle,
  History, UserPlus, Archive, RefreshCw,
  Filter, PhoneOff, Ban, Globe, AlertCircle, FileText, Users,
  Pencil, Timer, Send, ArrowDown, ExternalLink, Search,
  Pause, Play, GitBranch, ArrowRight
} from "lucide-react";
import { isUnknownSource } from "@workspace/api-zod";
import { useGetPodiumTimeline, useGetPodiumConversation, useSendPodiumMessage, type TimelineEntry, type PodiumMessage } from "@workspace/api-client-react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function formatPhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 11 && digits[0] === "1") {
    return `${digits[0]}-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => {
        e.stopPropagation();
        e.preventDefault();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="p-0.5 rounded hover:bg-white/10 transition-colors"
      title="Copy"
    >
      <AnimatePresence mode="wait">
        {copied ? (
          <motion.span key="check" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: 0.15 }}>
            <Check className="w-3 h-3 text-emerald-400" />
          </motion.span>
        ) : (
          <motion.span key="copy" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: 0.15 }}>
            <Copy className="w-3 h-3 text-white/30 hover:text-white/60" />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

type QueueTab = "new" | "callbacks" | "reengagement" | "old" | "recently_booked" | "archive";

const QUEUE_TABS: { key: QueueTab; label: string; color: string }[] = [
  { key: "new", label: "New", color: "text-red-400" },
  { key: "reengagement", label: "Re-engage", color: "text-purple-400" },
  { key: "callbacks", label: "Callbacks", color: "text-amber-400" },
  { key: "old", label: "Old Leads", color: "text-white/60" },
  { key: "recently_booked", label: "Recently Booked", color: "text-emerald-400" },
  { key: "archive", label: "Archive", color: "text-white/40" },
];

const DAY_BADGE_COLORS: Record<string, string> = {
  day_1: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  day_2: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  day_3: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  day_4: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  day_5_old: "bg-red-500/20 text-red-400 border-red-500/30",
  appt_set: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  appt_booked: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  call_back: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  dead: "bg-red-500/20 text-red-300 border-red-500/30",
};

const DAY_BADGE_LABELS: Record<string, string> = {
  day_1: "D1", day_2: "D2", day_3: "D3", day_4: "D4",
  day_5_old: "OLD", appt_set: "APPT", appt_booked: "APPT BOOKED", call_back: "CB", dead: "DEAD",
};

const CONTACT_FLAG_CONFIG: Record<string, { label: string; color: string; icon: typeof Phone; blocksCall?: boolean; blocksText?: boolean }> = {
  text_only: { label: "Text Only", color: "bg-blue-500/20 text-blue-400 border-blue-500/30", icon: MessageSquare, blocksCall: true },
  spanish_speaking: { label: "Spanish", color: "bg-purple-500/20 text-purple-400 border-purple-500/30", icon: Globe },
  do_not_call: { label: "DNC", color: "bg-red-500/20 text-red-400 border-red-500/30", icon: PhoneOff, blocksCall: true },
};

const CALL_RESULTS = [
  { value: "no_answer", label: "No Answer" },
  { value: "left_voicemail", label: "Left Voicemail" },
  { value: "vm_full", label: "VM Full" },
  { value: "vm_not_setup", label: "VM Not Setup" },
  { value: "hung_up", label: "Hung Up" },
  { value: "spoke_with_customer", label: "Spoke with Customer" },
];

const SPOKE_RESULTS = [
  { value: "appointment_set", label: "Appointment Set", color: "text-emerald-400" },
  { value: "call_back", label: "Callback Requested", color: "text-amber-400" },
  { value: "dead", label: "Dead Lead", color: "text-red-400" },
];

const DEAD_REASONS = [
  { value: "out_of_service_area", label: "Out of Service Area" },
  { value: "do_not_call", label: "Do Not Call" },
  { value: "not_interested", label: "Not Interested" },
  { value: "too_expensive", label: "Too Expensive" },
  { value: "no_response", label: "No Response" },
  { value: "other", label: "Other" },
  { value: "custom", label: "Custom Note" },
];

const TEXT_RESULTS = [
  { value: "yes", label: "Yes — Interested" },
  { value: "reached_out", label: "Reached Out" },
  { value: "not_able_to", label: "Not Able To" },
  { value: "dead", label: "Dead Lead" },
  { value: "no_need", label: "No Need to Log" },
];

const VM_RESULTS = [
  { value: "yes", label: "VM Dropped" },
  { value: "no", label: "No — Did Not Leave VM" },
  { value: "bad_number", label: "Bad Number" },
  { value: "vm_full", label: "VM Full" },
  { value: "vm_not_setup", label: "VM Not Setup" },
  { value: "spoke_with_customer", label: "Spoke with Customer" },
];

const SMART_FIELD_SCRIPTS = {
  text: [
    { name: "Initial Outreach", content: "Hi {{lead_name}}! This is {{csr_name}}. We received your inquiry about {{service_type}} from {{funnel}}. Would you like to schedule a free estimate? Reply YES!" },
    { name: "Follow-Up", content: "Hi {{lead_name}}, {{csr_name}} here from {{funnel}}. Just following up on your {{service_type}} inquiry. Still interested? Reply YES and I'll get you on the calendar!" },
    { name: "Re-Engagement", content: "Hi {{lead_name}}! It's {{csr_name}}. We helped you with {{service_type}} a while back. We're running a special this month — interested? Reply YES!" },
  ],
  call: [
    { name: "Opening", content: "Hi, may I speak with {{lead_name}}? This is {{csr_name}} calling about your {{service_type}} inquiry from {{funnel}}." },
    { name: "Value Pitch", content: "We'd love to get a technician out to take a look at your {{service_type}} needs. We offer free estimates and our team has years of experience." },
    { name: "Close for Appointment", content: "I have availability this week — would a morning or afternoon appointment work better for you?" },
  ],
  voicemail: [
    { name: "Voicemail Script", content: "Hi {{lead_name}}, this is {{csr_name}} calling about your {{service_type}} inquiry from {{funnel}}. We'd love to help you out — please give us a call back at your earliest convenience. Thanks!" },
  ],
};

function formatInTz(dateStr: string | Date, tz: string, opts?: Intl.DateTimeFormatOptions): string {
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  return d.toLocaleString("en-US", { timeZone: tz, ...opts });
}

function formatTimeInTz(dateStr: string | Date, tz: string): string {
  return formatInTz(dateStr, tz, { hour: "numeric", minute: "2-digit" });
}

function formatDateTimeInTz(dateStr: string | Date, tz: string): string {
  return formatInTz(dateStr, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function tzOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(instant);
  const g = (t: string) => parseInt(parts.find(p => p.type === t)?.value || "0");
  const wallUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") === 24 ? 0 : g("hour"), g("minute"), g("second"));
  return wallUtc - instant.getTime();
}

function localInputToUtcIso(datetimeLocal: string, tz: string): string {
  const asUtc = new Date(datetimeLocal + "Z");
  return new Date(asUtc.getTime() - tzOffsetMs(asUtc, tz)).toISOString();
}

interface LeadData {
  id: number;
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  source: string;
  originalSource?: string | null;
  leadType?: string | null;
  serviceType?: string | null;
  interestType?: string | null;
  status: string;
  hubStatus: string;
  dayInSequence: number;
  contactPreferences?: string[] | null;
  assignedTo?: string | null;
  assignedCsrId?: number | null;
  callbackAt?: string | null;
  bookedAt?: string | null;
  deadReason?: string | null;
  disposition?: string | null;
  notes?: string | null;
  preBooked?: boolean;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  appointmentDate?: string | null;
  appointmentTime?: string | null;
  addOns?: string | null;
  createdAt: string;
  updatedAt: string;
  tenantId?: number;
  funnelId?: number | null;
  nextPassAt?: string | null;
  passIntervalMinutes?: number | null;
  assignedAt?: string | null;
  lastAttemptAt?: string | null;
  attemptCount?: number;
  hasSoldEstimate?: boolean;
  resubmittedAt?: string | null;
  resubmissionCount?: number | null;
}

interface CsrOption {
  id: number;
  name: string;
  email: string;
  role: string;
}

function formatSpeed(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0s";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
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

type HudTimeframe = "today" | "7d" | "30d" | "90d";

const HUD_TIMEFRAME_KEY = "hud-stats-timeframe";

function getTimeframeLabel(tf: HudTimeframe): string {
  switch (tf) {
    case "today": return "today";
    case "7d": return "past 7 days";
    case "30d": return "past 30 days";
    case "90d": return "past 90 days";
  }
}

function getTimeframeDates(tf: HudTimeframe): { startDate: string; endDate: string } | null {
  if (tf === "today") return null;
  const now = new Date();
  const end = now.toISOString();
  const start = new Date();
  if (tf === "7d") start.setDate(start.getDate() - 7);
  else if (tf === "30d") start.setDate(start.getDate() - 30);
  else if (tf === "90d") start.setDate(start.getDate() - 90);
  start.setHours(0, 0, 0, 0);
  return { startDate: start.toISOString(), endDate: end };
}

function useHudStats(tenantId?: number | null, isAgency?: boolean, csrId?: number | null, timeframe?: HudTimeframe) {
  const [stats, setStats] = useState<HudStats>({
    callsMadeToday: 0, bookingsToday: 0, bookingRate: 0, commission: 0,
    newLeadsToday: 0, avgSpeedToLead: 0, soldToday: 0,
    bonusTier: "none", bonusThreshold: 30, nextBonusAt: 30,
  });
  const shouldFetch = !isAgency || tenantId !== null;
  const tf = timeframe ?? "today";
  const fetchStats = useCallback(async () => {
    if (!shouldFetch) return;
    try {
      const params = new URLSearchParams();
      if (tenantId) params.set("tenantId", String(tenantId));
      if (csrId) params.set("csrId", String(csrId));
      const dates = getTimeframeDates(tf);
      if (dates) {
        params.set("startDate", dates.startDate);
        params.set("endDate", dates.endDate);
      }
      const qs = params.toString();
      const url = `${API_BASE}/leads/hud/stats${qs ? `?${qs}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) setStats(await res.json());
    } catch {}
  }, [tenantId, shouldFetch, csrId, tf]);
  useEffect(() => {
    if (!shouldFetch) return;
    fetchStats();
    const i = setInterval(fetchStats, 10000);
    return () => clearInterval(i);
  }, [fetchStats, shouldFetch]);
  return { stats, refetch: fetchStats };
}

function useLeadsHubQueue(tenantId?: number | null, isAgency?: boolean, csrId?: number | null) {
  const [data, setData] = useState<{
    newLeads: LeadData[]; callbacks: LeadData[];
    reengagement: LeadData[]; oldLeads: LeadData[];
    recentlyBooked: LeadData[]; total: number;
    timezone?: string;
  }>({ newLeads: [], callbacks: [], reengagement: [], oldLeads: [], recentlyBooked: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const shouldFetch = !isAgency || tenantId !== null;

  const fetchQueue = useCallback(async () => {
    if (!shouldFetch) return;
    try {
      const params = new URLSearchParams();
      if (tenantId) params.set("tenantId", String(tenantId));
      if (csrId) params.set("csrId", String(csrId));
      const qs = params.toString();
      const url = `${API_BASE}/leads-hub/queue${qs ? `?${qs}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) setData(await res.json());
    } catch {} finally { setLoading(false); }
  }, [tenantId, shouldFetch, csrId]);

  useEffect(() => {
    if (!shouldFetch) return;
    fetchQueue();
    const i = setInterval(fetchQueue, 15000);
    return () => clearInterval(i);
  }, [fetchQueue, shouldFetch]);

  return { data, loading, refetch: fetchQueue };
}

function useArchive(tenantId?: number | null, filters?: Record<string, string>) {
  const [data, setData] = useState<{ leads: LeadData[]; total: number }>({ leads: [], total: 0 });
  const [loading, setLoading] = useState(false);

  const fetchArchive = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ tenantId: String(tenantId) });
      if (filters) Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
      const res = await fetch(`${API_BASE}/leads-hub/archive?${params}`, { credentials: "include" });
      if (res.ok) setData(await res.json());
    } catch {} finally { setLoading(false); }
  }, [tenantId, filters]);

  useEffect(() => { fetchArchive(); }, [fetchArchive]);
  return { data, loading, refetch: fetchArchive };
}

function usePulseSocketIO(onReconnectCb?: () => void) {
  const { pendingNewLeads, dismissNewLead, newLeadSignal, leadUpdatedSignal, soundEnabled, setSoundEnabled, onReconnect, latestPodiumNotification, clearPodiumNotification, onPodiumMessage, latestCallbackDue, clearCallbackDue, playCallbackSound } = useLeadNotification();
  const onReconnectCbRef = useRef(onReconnectCb);
  useEffect(() => { onReconnectCbRef.current = onReconnectCb; }, [onReconnectCb]);

  useEffect(() => {
    return onReconnect(() => {
      if (onReconnectCbRef.current) onReconnectCbRef.current();
    });
  }, [onReconnect]);

  return { pendingNewLeads, dismissNewLead, newLeadSignal, leadUpdatedSignal, soundEnabled, setSoundEnabled, latestPodiumNotification, clearPodiumNotification, onPodiumMessage, latestCallbackDue, clearCallbackDue, playCallbackSound };
}

function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (secs < 60) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${days}d ${hrs % 24}h`;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0s";
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (secs < 60) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${hrs}h ${mins % 60}m`;
}

function useTickingTimer(deps: readonly (string | number | null | undefined)[]): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(t => t + 1);
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, deps);
  return tick;
}

function formatTimeSince(dateStr: string): { text: string; mins: number } {
  const ts = new Date(dateStr).getTime();
  if (!Number.isFinite(ts)) return { text: "just now", mins: 0 };
  const diff = Date.now() - ts;
  if (diff < 0) return { text: "just now", mins: 0 };
  const secs = Math.floor(diff / 1000);
  const mins = Math.floor(diff / 60000);
  if (secs < 60) return { text: `${secs}s ago`, mins: 0 };
  if (mins < 60) return { text: `${mins}m ${Math.floor(secs % 60)}s ago`, mins };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { text: `${hrs}h ${mins % 60}m ago`, mins };
  const days = Math.floor(hrs / 24);
  return { text: `${days}d ago`, mins };
}

function TimeSinceBadge({ dateStr }: { dateStr: string }) {
  useTickingTimer([dateStr]);
  const { text, mins } = formatTimeSince(dateStr);
  const colorClass = mins < 10
    ? "bg-emerald-500/20 text-emerald-400"
    : mins < 60
      ? "bg-amber-500/20 text-amber-400"
      : "text-white/40";

  return (
    <span className={cn("text-xs font-mono font-semibold px-1.5 py-0.5 rounded", colorClass)}>
      <Clock className="w-3 h-3 inline-block mr-0.5 -mt-0.5" />
      {text}
    </span>
  );
}

function LeadTimerBadge({ createdAt, nextPassAt, passIntervalMinutes }: { createdAt: string; nextPassAt?: string | null; passIntervalMinutes?: number | null }) {
  useTickingTimer([createdAt, nextPassAt]);

  const now = Date.now();

  if (!nextPassAt) {
    return <TimeSinceBadge dateStr={createdAt} />;
  }

  const targetMs = new Date(nextPassAt).getTime();
  const remainingMs = targetMs - now;

  if (remainingMs <= 0) {
    return <TimeSinceBadge dateStr={createdAt} />;
  }

  const totalIntervalMs = (passIntervalMinutes ?? 1440) * 60 * 1000;
  const fraction = totalIntervalMs > 0 ? Math.max(0, remainingMs / totalIntervalMs) : 0;

  const countdownColor = remainingMs <= 60000
    ? "text-red-400"
    : fraction > 0.5
      ? "text-emerald-400"
      : fraction > 0.2
        ? "text-amber-400"
        : "text-red-400";

  const countdownBg = remainingMs <= 60000
    ? "bg-red-500/15"
    : fraction > 0.5
      ? "bg-emerald-500/15"
      : fraction > 0.2
        ? "bg-amber-500/15"
        : "bg-red-500/15";

  const totalMs = now - new Date(createdAt).getTime();
  const totalText = formatElapsed(totalMs);

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className={cn("text-xs font-mono font-semibold px-1.5 py-0.5 rounded flex items-center gap-1", countdownBg, countdownColor)}>
        <Timer className="w-3 h-3" />
        {formatCountdown(remainingMs)}
      </span>
      <span className="text-[9px] font-mono text-white/30 flex items-center gap-0.5">
        <Clock className="w-2.5 h-2.5" />
        {totalText}
      </span>
    </div>
  );
}

function ContactFlags({ preferences }: { preferences?: string[] | null }) {
  if (!preferences || preferences.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {preferences.map(pref => {
        const cfg = CONTACT_FLAG_CONFIG[pref];
        if (!cfg) return null;
        const Icon = cfg.icon;
        return (
          <span key={pref} className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium border", cfg.color)}>
            <Icon className="w-2.5 h-2.5" /> {cfg.label}
          </span>
        );
      })}
    </div>
  );
}

function useFunnelTypes(tenantId?: number | null) {
  const [funnelMap, setFunnelMap] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!tenantId) return;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/funnel-types?tenantId=${tenantId}`, { credentials: "include" });
        if (res.ok) {
          const types = await res.json();
          const map: Record<number, string> = {};
          for (const t of types) map[t.id] = t.name;
          setFunnelMap(map);
        }
      } catch {}
    })();
  }, [tenantId]);
  return funnelMap;
}

type DateTypeFilter = "created" | "lastTouchpoint";

interface SearchFilters {
  q: string;
  funnelId: number | null;
  dateType: DateTypeFilter;
  startDate: string;
  endDate: string;
}

function useLeadSearch(tenantId?: number | null) {
  const [filters, setFilters] = useState<SearchFilters>({ q: "", funnelId: null, dateType: "created", startDate: "", endDate: "" });
  const [results, setResults] = useState<{ leads: LeadData[]; total: number }>({ leads: [], total: 0 });
  const [searching, setSearching] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (f: SearchFilters) => {
    if (!tenantId) return;
    const hasQuery = f.q.trim().length > 0;
    const hasDate = f.startDate || f.endDate;
    const hasFunnel = f.funnelId !== null;
    if (!hasQuery && !hasDate && !hasFunnel) {
      setResults({ leads: [], total: 0 });
      setSearchActive(false);
      return;
    }
    setSearching(true);
    setSearchActive(true);
    try {
      const params = new URLSearchParams({ tenantId: String(tenantId) });
      if (f.q.trim()) params.set("q", f.q.trim());
      if (f.funnelId) params.set("funnelId", String(f.funnelId));
      if (f.startDate) params.set("startDate", new Date(f.startDate).toISOString());
      if (f.endDate) {
        const ed = new Date(f.endDate);
        ed.setHours(23, 59, 59, 999);
        params.set("endDate", ed.toISOString());
      }
      if (f.dateType === "lastTouchpoint") params.set("dateType", "lastTouchpoint");
      const res = await fetch(`${API_BASE}/leads/search?${params}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setResults(data);
      } else {
        console.error("[LeadSearch] API error:", res.status, await res.text().catch(() => ""));
      }
    } catch (err) { console.error("[LeadSearch] fetch error:", err); } finally { setSearching(false); }
  }, [tenantId]);

  const updateFilters = useCallback((partial: Partial<SearchFilters>) => {
    setFilters(prev => {
      const next = { ...prev, ...partial };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (partial.q !== undefined) {
        debounceRef.current = setTimeout(() => doSearch(next), 300);
      } else {
        doSearch(next);
      }
      return next;
    });
  }, [doSearch]);

  const clearSearch = useCallback(() => {
    setFilters({ q: "", funnelId: null, dateType: "created", startDate: "", endDate: "" });
    setResults({ leads: [], total: 0 });
    setSearchActive(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  return { filters, updateFilters, results, searching, searchActive, clearSearch };
}

function FunnelBadge({ funnelId, funnelMap }: { funnelId?: number | null; funnelMap: Record<number, string> }) {
  if (!funnelId || !funnelMap[funnelId]) return null;
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/15 text-violet-400 border border-violet-500/20 whitespace-nowrap">
      {funnelMap[funnelId]}
    </span>
  );
}

function DayBadge({ hubStatus }: { hubStatus: string }) {
  return (
    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border", DAY_BADGE_COLORS[hubStatus] || "bg-white/5 text-white/40 border-white/10")}>
      {DAY_BADGE_LABELS[hubStatus] || hubStatus.toUpperCase()}
    </span>
  );
}

function ClosedBadge() {
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border bg-amber-500/20 text-amber-400 border-amber-500/30">
      CLOSED
    </span>
  );
}

function ResubBadge({ count }: { count?: number | null }) {
  const n = count && count > 0 ? count : null;
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border bg-cyan-500/15 text-cyan-400 border-cyan-500/30"
      title={n ? `Resubmitted ${n} time${n === 1 ? "" : "s"}` : "Resubmitted"}
    >
      RESUB{n ? ` ×${n}` : ""}
    </span>
  );
}

function formatTimeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ReengageBadge({ lastAttemptAt, attemptCount }: { lastAttemptAt?: string | null; attemptCount?: number }) {
  if (!lastAttemptAt && !attemptCount) return null;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border bg-purple-500/15 text-purple-400 border-purple-500/25">
      {lastAttemptAt && formatTimeAgo(lastAttemptAt)}
      {lastAttemptAt && attemptCount ? " · " : ""}
      {attemptCount ? `${attemptCount} attempt${attemptCount !== 1 ? "s" : ""}` : ""}
    </span>
  );
}

function getSourceColor(source: string): string {
  if (source.includes("Google")) return "bg-blue-500/15 text-blue-400 border-blue-500/20";
  if (source.includes("Meta") || source.includes("Facebook") || source.includes("Instagram")) return "bg-indigo-500/15 text-indigo-400 border-indigo-500/20";
  if (source.includes("Direct Mail")) return "bg-amber-500/15 text-amber-400 border-amber-500/20";
  if (source.includes("YouTube") || source.includes("TikTok")) return "bg-pink-500/15 text-pink-400 border-pink-500/20";
  if (source === "Unknown") return "bg-orange-500/15 text-orange-400 border-orange-500/20";
  return "bg-white/5 text-white/50 border-white/10";
}

function SourceTag({ source }: { source: string }) {
  return <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-medium border", getSourceColor(source))}>{source}</span>;
}

function EditableSourceTag({ leadId, source, originalSource, userRole, onSourceChanged, tenantId }: { leadId: number; source: string; originalSource?: string | null; userRole?: string; onSourceChanged: (newSource: string) => void; tenantId?: number }) {
  const [canonicalSources, setCanonicalSources] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const qs = tenantId ? `?tenantId=${tenantId}` : "";
    fetch(`${API_BASE}/leads-hub/canonical-sources${qs}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => setCanonicalSources(data.sources || []))
      .catch(() => {});
  }, [tenantId]);

  const handleSelect = async (newSource: string) => {
    if (newSource === source) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/leads-hub/${leadId}/source`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ source: newSource, tenantId }),
      });
      if (res.ok) {
        const data = await res.json();
        onSourceChanged(data.source);
      }
    } catch {}
    setSaving(false);
  };

  const isClientRole = userRole === "client_user" || userRole === "client_admin";
  const canEdit = !isClientRole || isUnknownSource(originalSource);

  if (!canEdit || canonicalSources.length === 0) {
    return <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-medium border", getSourceColor(source))}>{source}</span>;
  }

  const allOptions = canonicalSources.includes(source) ? canonicalSources : [source, ...canonicalSources];

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Select value={source} onValueChange={handleSelect}>
        <SelectTrigger className={cn("w-auto h-auto px-1.5 py-0.5 rounded text-[9px] font-medium border cursor-pointer hover:ring-1 hover:ring-white/20 transition-all gap-1 [&>svg]:hidden", getSourceColor(source))}>
          {saving ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <SelectValue />}
          <Pencil className="w-2.5 h-2.5 opacity-50" />
        </SelectTrigger>
        <SelectContent>
          {allOptions.map(s => (
            <SelectItem key={s} value={s}>{s}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

function CommissionTicker({ amount, onDone }: { amount: number; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2500);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <motion.div
      initial={{ scale: 0.3, opacity: 0, y: 40 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.5, opacity: 0, y: -30 }}
      transition={{ type: "spring", damping: 12, stiffness: 200 }}
      className="fixed top-20 right-8 z-[100] pointer-events-none"
    >
      <div className="bg-gradient-to-br from-emerald-500/90 to-green-600/90 backdrop-blur-md rounded-2xl px-8 py-5 shadow-2xl shadow-emerald-500/30 border border-emerald-400/40">
        <div className="text-3xl font-black text-white tracking-tight text-center">
          +${amount} 💰
        </div>
      </div>
    </motion.div>
  );
}

function LeadCard({ lead, onClick, funnelMap, timezone = "America/New_York", showReengageBadge = false }: { lead: LeadData; onClick: () => void; funnelMap: Record<number, string>; timezone?: string; showReengageBadge?: boolean }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      onClick={onClick}
      className="relative rounded-xl border p-4 bg-card/60 border-white/5 hover:border-white/15 cursor-pointer transition-all group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="font-display text-base text-white truncate group-hover:text-primary transition-colors">
              {lead.firstName} {lead.lastName}
            </h3>
            <DayBadge hubStatus={lead.hubStatus} />
            {lead.hasSoldEstimate && <ClosedBadge />}
              {lead.resubmittedAt && <ResubBadge count={lead.resubmissionCount} />}
            <FunnelBadge funnelId={lead.funnelId} funnelMap={funnelMap} />
            {showReengageBadge && <ReengageBadge lastAttemptAt={lead.lastAttemptAt} attemptCount={lead.attemptCount} />}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <SourceTag source={lead.source} />
            {lead.serviceType && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-white/5 text-white/50 border border-white/10">{lead.serviceType}</span>
            )}
            {lead.phone && (
              <span className="inline-flex items-center gap-0.5">
                <span className="text-[11px] text-white/40 font-mono">{formatPhone(lead.phone)}</span>
                <CopyBtn text={lead.phone.replace(/[^0-9+]/g, "")} />
              </span>
            )}
            {(lead.appointmentDate || lead.appointmentTime) && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                <Calendar className="w-2.5 h-2.5" />
                {lead.appointmentDate}{lead.appointmentTime ? ` ${lead.appointmentTime}` : ""}
              </span>
            )}
            {lead.callbackAt && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
                <Phone className="w-2.5 h-2.5" />
                CB: {formatDateTimeInTz(lead.callbackAt, timezone)}
              </span>
            )}
            {(lead.hubStatus === "appt_set" || lead.hubStatus === "appt_booked" || lead.hasSoldEstimate) && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                <Calendar className="w-2.5 h-2.5" />
                Booked: {lead.bookedAt ? formatDateTimeInTz(lead.bookedAt, timezone) : "—"}
              </span>
            )}
          </div>
          <ContactFlags preferences={lead.contactPreferences} />
          {lead.disposition && (
            <span className="text-[10px] text-white/30 mt-1">
              Last: <span className="text-white/45">{lead.disposition.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}</span>
            </span>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <LeadTimerBadge createdAt={lead.createdAt} nextPassAt={lead.nextPassAt} passIntervalMinutes={lead.passIntervalMinutes} />
          {lead.assignedTo && (
            <span className="text-[9px] text-white/25 truncate max-w-[80px]">{lead.assignedTo}</span>
          )}
          <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/50 transition-colors" />
        </div>
      </div>
    </motion.div>
  );
}

function ActionHistoryTimeline({ leadId, tenantId, timezone, canEdit = false, currentUserId, isAdminRole = false, leadHubStatus, leadBookedAt }: { leadId: number; tenantId: number; timezone: string; canEdit?: boolean; currentUserId?: number; isAdminRole?: boolean; leadHubStatus?: string; leadBookedAt?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<{ actionType: string; notes: string; callResult: string; textResult: string; vmResult: string; deadReason: string; apptBookedOutcome: string; spokeResult: string; callbackAt: string; appointmentDate: string; appointmentTime: string }>({ actionType: "", notes: "", callResult: "", textResult: "", vmResult: "", deadReason: "", apptBookedOutcome: "", spokeResult: "", callbackAt: "", appointmentDate: "", appointmentTime: "" });
  const [editCustomDeadNote, setEditCustomDeadNote] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [expandedCallIds, setExpandedCallIds] = useState<Set<number>>(new Set());

  const toggleCallExpand = (id: number) => {
    setExpandedCallIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const { data: timelineData, isLoading: loading, refetch: refetchTimeline } = useGetPodiumTimeline(leadId, { tenantId });
  const unifiedTimeline = useMemo(() => {
    const base = (timelineData?.timeline ?? []) as TimelineEntry[];
    if (!leadBookedAt) return base;
    const bookedTs = new Date(leadBookedAt).getTime();
    if (!Number.isFinite(bookedTs)) return base;
    const synthetic: TimelineEntry = {
      type: "pulse_action",
      source: "pulse",
      timestamp: leadBookedAt,
      id: -1,
      outcome: "lead_booked",
      actionType: "booked",
    } as TimelineEntry;
    const merged = [...base, synthetic];
    merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return merged;
  }, [timelineData, leadBookedAt]);
  const fetchHistory = useCallback(() => { refetchTimeline(); }, [refetchTimeline]);

  const { onPodiumMessage } = useLeadNotification();
  useEffect(() => {
    return onPodiumMessage((msg) => {
      if (msg.leadId === leadId) {
        fetchHistory();
      }
    });
  }, [leadId, fetchHistory, onPodiumMessage]);

  const startEdit = (entry: TimelineEntry) => {
    setEditingId(entry.id);
    const dr = entry.deadReason || "";
    const isExistingCustom = dr && !DEAD_REASONS.some(d => d.value === dr && d.value !== "custom");
    setEditCustomDeadNote(isExistingCustom ? dr : "");
    const existingApptOutcome = entry.outcome?.startsWith("appt_") ? entry.outcome.replace("appt_", "") : "";
    const defaultCb = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
    const defaultApptDate = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    setEditForm({
      actionType: entry.actionType || entry.method || "",
      notes: entry.notes || "",
      callResult: entry.callResult || "",
      textResult: entry.textResult || "",
      vmResult: entry.vmResult || "",
      deadReason: isExistingCustom ? "custom" : dr,
      apptBookedOutcome: existingApptOutcome,
      spokeResult: entry.spokeResult || "",
      callbackAt: entry.callbackAt
        ? new Date(entry.callbackAt).toISOString().slice(0, 16)
        : defaultCb,
      appointmentDate: entry.appointmentDate || defaultApptDate,
      appointmentTime: entry.appointmentTime || "09:00",
    });
  };

  const saveEdit = async (entry: TimelineEntry) => {
    setEditSaving(true);
    try {
      const resolvedDeadReason = (() => {
        if (!editForm.deadReason) return null;
        const isCustomDead = editForm.deadReason === "custom" || !DEAD_REASONS.some(d => d.value === editForm.deadReason && d.value !== "custom");
        if (isCustomDead) return editCustomDeadNote.trim() || (editForm.deadReason !== "custom" ? editForm.deadReason : null);
        return editForm.deadReason;
      })();
      if ((editForm.callResult === "spoke_with_customer" || editForm.textResult === "dead") && editForm.deadReason && !resolvedDeadReason) {
        alert("Please enter a custom dead reason.");
        setEditSaving(false);
        return;
      }
      const body: Record<string, unknown> = { notes: editForm.notes, actionType: editForm.actionType, deadReason: resolvedDeadReason };
      const method = editForm.actionType || entry.actionType || entry.method;
      if (method === "call") body.callResult = editForm.callResult || null;
      if (method === "text") body.textResult = editForm.textResult || null;
      if (method === "voicemail" || method === "voicemail_drop") body.vmResult = editForm.vmResult || null;
      if (leadHubStatus === "appt_booked") {
        const hasContact = editForm.callResult === "spoke_with_customer" || editForm.textResult === "yes" || editForm.vmResult === "spoke_with_customer";
        if (hasContact && !editForm.apptBookedOutcome) {
          alert("Please select an appointment status (Confirmed, Rescheduled, or Canceled).");
          setEditSaving(false);
          return;
        }
        if (editForm.apptBookedOutcome) body.apptBookedOutcome = editForm.apptBookedOutcome;
      }
      if (editForm.callResult === "spoke_with_customer" && leadHubStatus !== "appt_booked") {
        if (!editForm.spokeResult) {
          alert("Please select a spoke result (Appointment Set, Callback Requested, or Dead Lead).");
          setEditSaving(false);
          return;
        }
        body.spokeResult = editForm.spokeResult;
        body.callbackAt = null;
        body.appointmentSet = null;
        if (editForm.spokeResult === "call_back") {
          if (new Date(editForm.callbackAt).getTime() <= Date.now()) {
            alert("Please select a future callback date/time.");
            setEditSaving(false);
            return;
          }
          body.callbackAt = new Date(editForm.callbackAt).toISOString();
        } else if (editForm.spokeResult === "appointment_set") {
          body.appointmentSet = true;
          body.appointmentDate = editForm.appointmentDate;
          body.appointmentTime = editForm.appointmentTime;
        } else if (editForm.spokeResult === "dead") {
          if (!resolvedDeadReason) {
            alert("Please select a dead reason.");
            setEditSaving(false);
            return;
          }
        }
      }

      const res = await fetch(`${API_BASE}/leads-hub/action/${entry.id}?tenantId=${tenantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setEditingId(null);
        fetchHistory();
      } else {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        alert(err.error || "Save failed");
      }
    } catch { alert("Network error — could not save"); } finally { setEditSaving(false); }
  };

  if (loading) return <div className="py-4 text-center"><Loader2 className="w-4 h-4 text-white/30 animate-spin mx-auto" /></div>;
  if (unifiedTimeline.length === 0) return <p className="text-xs text-white/20 py-3 text-center">No actions logged yet</p>;

  const displayed = expanded ? unifiedTimeline : unifiedTimeline.slice(0, 5);

  const getIcon = (entry: TimelineEntry) => {
    if (entry.type === "podium_text") return <MessageSquare className="w-3 h-3 text-blue-400" />;
    if (entry.type === "podium_call") return <Phone className="w-3 h-3 text-cyan-400" />;
    if (entry.type === "status_change") return <GitBranch className="w-3 h-3 text-purple-400" />;
    if (entry.outcome === "resubmission") return <RefreshCw className="w-3 h-3 text-cyan-400" />;
    if (entry.actionType === "call" || entry.method === "call") return <Phone className="w-3 h-3" />;
    if (entry.actionType === "text" || entry.method === "text") return <MessageSquare className="w-3 h-3" />;
    if (entry.actionType === "voicemail_drop" || entry.method === "voicemail") return <Mic className="w-3 h-3" />;
    if (entry.method === "transfer") return <UserPlus className="w-3 h-3" />;
    return <Clock className="w-3 h-3" />;
  };

  const getNodeColor = (entry: TimelineEntry) => {
    if (entry.source === "podium") return "bg-blue-500/20 border-blue-500/30";
    return "bg-card border-white/10";
  };

  const getOutcomeLabel = (entry: TimelineEntry) => {
    const result = entry.callResult || entry.textResult || entry.vmResult || entry.outcome;
    return ((result as string) || "").replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
  };

  const renderPulseAction = (entry: TimelineEntry) => {
    if (editingId === entry.id) {
      return (
        <div className="space-y-2 py-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/30 font-mono shrink-0">
              {formatDateTimeInTz(entry.timestamp, timezone)}
            </span>
            <span className="text-[10px] text-amber-400 font-medium">Editing</span>
          </div>
          <Select value={editForm.actionType} onValueChange={v => setEditForm(f => ({ ...f, actionType: v, callResult: "", textResult: "", vmResult: "", apptBookedOutcome: "", spokeResult: "", deadReason: "" }))}>
            <SelectTrigger className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white h-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="call">Call</SelectItem>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="voicemail_drop">VM Drop</SelectItem>
            </SelectContent>
          </Select>
          {(() => {
            const m = editForm.actionType;
            const opts = m === "call" ? CALL_RESULTS : m === "text" ? TEXT_RESULTS : (m === "voicemail" || m === "voicemail_drop") ? VM_RESULTS : [];
            const val = m === "call" ? editForm.callResult : m === "text" ? editForm.textResult : editForm.vmResult;
            if (opts.length === 0) return null;
            return (
              <Select value={val || "__none__"} onValueChange={v => {
                const actualVal = v === "__none__" ? "" : v;
                const isContact = (m === "call" && actualVal === "spoke_with_customer") || (m === "text" && actualVal === "yes") || ((m === "voicemail" || m === "voicemail_drop") && actualVal === "spoke_with_customer");
                const clearSpoke = m === "call" && actualVal !== "spoke_with_customer";
                if (m === "call") setEditForm(f => ({ ...f, callResult: actualVal, apptBookedOutcome: isContact ? f.apptBookedOutcome : "", spokeResult: clearSpoke ? "" : f.spokeResult, deadReason: clearSpoke ? "" : f.deadReason }));
                else if (m === "text") setEditForm(f => ({ ...f, textResult: actualVal, apptBookedOutcome: isContact ? f.apptBookedOutcome : "" }));
                else setEditForm(f => ({ ...f, vmResult: actualVal, apptBookedOutcome: isContact ? f.apptBookedOutcome : "" }));
              }}>
                <SelectTrigger className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white h-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select outcome...</SelectItem>
                  {opts.map(r => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          })()}
          {leadHubStatus === "appt_booked" && (editForm.callResult === "spoke_with_customer" || editForm.textResult === "yes" || editForm.vmResult === "spoke_with_customer") && (
            <Select value={editForm.apptBookedOutcome || "__none__"} onValueChange={v => setEditForm(f => ({ ...f, apptBookedOutcome: v === "__none__" ? "" : v }))}>
              <SelectTrigger className="w-full bg-purple-500/10 border border-purple-500/20 rounded px-2 py-1 text-[11px] text-purple-300 h-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select appointment status...</SelectItem>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="rescheduled">Rescheduled</SelectItem>
                <SelectItem value="canceled">Canceled</SelectItem>
              </SelectContent>
            </Select>
          )}
          {editForm.callResult === "spoke_with_customer" && leadHubStatus !== "appt_booked" && (
            <Select value={editForm.spokeResult || "__none__"} onValueChange={v => setEditForm(f => ({ ...f, spokeResult: v === "__none__" ? "" : v, deadReason: v !== "dead" ? "" : f.deadReason }))}>
              <SelectTrigger className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white h-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select spoke result...</SelectItem>
                {SPOKE_RESULTS.map(r => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {editForm.callResult === "spoke_with_customer" && editForm.spokeResult === "call_back" && leadHubStatus !== "appt_booked" && (
            <input
              type="datetime-local"
              value={editForm.callbackAt}
              onChange={e => setEditForm(f => ({ ...f, callbackAt: e.target.value }))}
              min={new Date().toISOString().slice(0, 16)}
              className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white h-auto"
            />
          )}
          {editForm.callResult === "spoke_with_customer" && editForm.spokeResult === "appointment_set" && leadHubStatus !== "appt_booked" && (
            <div className="flex gap-1.5">
              <input
                type="date"
                value={editForm.appointmentDate}
                onChange={e => setEditForm(f => ({ ...f, appointmentDate: e.target.value }))}
                min={new Date().toISOString().split("T")[0]}
                className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white h-auto"
              />
              <input
                type="time"
                value={editForm.appointmentTime}
                onChange={e => setEditForm(f => ({ ...f, appointmentTime: e.target.value }))}
                className="w-24 bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white h-auto"
              />
            </div>
          )}
          {((editForm.callResult === "spoke_with_customer" && editForm.spokeResult === "dead") || editForm.textResult === "dead") && leadHubStatus !== "appt_booked" && (
            <>
              <Select value={editForm.deadReason || "__none__"} onValueChange={v => { setEditForm(f => ({ ...f, deadReason: v === "__none__" ? "" : v })); if (v === "custom") setEditCustomDeadNote(""); }}>
                <SelectTrigger className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white h-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select dead reason...</SelectItem>
                  {DEAD_REASONS.map(r => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(editForm.deadReason === "custom" || (editForm.deadReason && !DEAD_REASONS.some(d => d.value === editForm.deadReason && d.value !== "custom"))) && (
                <input
                  type="text"
                  value={editCustomDeadNote || (editForm.deadReason !== "custom" ? editForm.deadReason : "")}
                  onChange={e => setEditCustomDeadNote(e.target.value)}
                  placeholder="Type custom reason..."
                  className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white placeholder:text-white/20 mt-1"
                />
              )}
            </>
          )}
          <input
            type="text"
            value={editForm.notes}
            onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="Notes..."
            className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white placeholder:text-white/20"
          />
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => saveEdit(entry)}
              disabled={editSaving}
              className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[10px] font-medium hover:bg-amber-500/30 disabled:opacity-50 transition-colors"
            >
              {editSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
            </button>
            <button
              onClick={() => setEditingId(null)}
              className="px-2 py-0.5 rounded bg-white/5 text-white/40 text-[10px] hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }
    return (
      <>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/30 font-mono shrink-0">
            {formatDateTimeInTz(entry.timestamp, timezone)}
          </span>
          <span className="text-[10px] text-white/50">{entry.csrName as string}</span>
          <span className="text-[10px] text-white/60 font-medium">{getOutcomeLabel(entry)}</span>
          {entry.spokeResult === "call_back" && entry.callbackAt && (
            <span className="text-[10px] text-amber-400/70">· CB {formatDateTimeInTz(entry.callbackAt, timezone)}</span>
          )}
          {entry.spokeResult === "appointment_set" && (entry.appointmentDate || entry.appointmentTime) && (
            <span className="text-[10px] text-emerald-400/70">· Appt {entry.appointmentDate || ""}{entry.appointmentTime ? ` ${entry.appointmentTime}` : ""}</span>
          )}
          {entry.id >= 0 && canEdit && (isAdminRole || entry.userId === currentUserId) && (
            <button
              onClick={e => { e.stopPropagation(); startEdit(entry); }}
              className="p-0.5 rounded hover:bg-white/10 text-white/20 hover:text-amber-400 transition-colors"
              title="Edit action"
            >
              <Pencil className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
        {entry.deadReason && <p className="text-[10px] text-red-400/60 mt-0.5">Reason: {(entry.deadReason || "").replace(/_/g, " ")}</p>}
        {entry.notes && <p className="text-[10px] text-white/25 mt-0.5 italic">{entry.notes}</p>}
      </>
    );
  };

  const renderPodiumText = (entry: TimelineEntry) => (
    <div className={cn("flex gap-2 py-1", entry.direction === "outbound" ? "flex-row-reverse" : "")}>
      <div className={cn(
        "max-w-[85%] rounded-lg px-2.5 py-1.5",
        entry.direction === "outbound"
          ? "bg-blue-500/10 border border-blue-500/15"
          : "bg-white/5 border border-white/10"
      )}>
        <p className="text-[11px] text-white/60 leading-relaxed">{(entry.body as string) || ""}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[9px] text-white/20 font-mono">
            {formatDateTimeInTz(entry.timestamp, timezone)}
          </span>
          <span className="text-[8px] px-1 rounded bg-blue-500/10 text-blue-400/60">{entry.channelType === "form" ? "Podium Form" : "Podium SMS"}</span>
          {entry.channelType === "form" ? (
            <span className="text-[8px] italic text-amber-400/50">Only visible in Podium</span>
          ) : (
            <span className={cn(
              "text-[8px]",
              entry.direction === "outbound" ? "text-blue-400/40" : "text-emerald-400/40"
            )}>
              {entry.direction === "outbound" ? "Sent" : "Received"}
            </span>
          )}
          {entry.deliveryStatus === "failed" && (
            <span className="text-[8px] text-red-400">Failed</span>
          )}
          {entry.podiumDeepLink && (
            <a
              href={entry.podiumDeepLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="inline-flex items-center gap-0.5 text-[8px] text-blue-400/50 hover:text-blue-400 transition-colors"
            >
              <ExternalLink className="w-2.5 h-2.5" />
              Podium
            </a>
          )}
        </div>
      </div>
    </div>
  );

  const renderPodiumCall = (entry: TimelineEntry) => {
    const isExpanded = expandedCallIds.has(entry.id);
    return (
      <div className="py-1">
        <button
          onClick={() => toggleCallExpand(entry.id)}
          className="w-full text-left rounded-lg px-2.5 py-1.5 bg-cyan-500/5 border border-cyan-500/15 hover:bg-cyan-500/10 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Phone className="w-3 h-3 text-cyan-400 shrink-0" />
            <span className="text-[11px] text-cyan-300 font-medium">
              {entry.direction === "inbound" ? "Incoming Call" : "Outgoing Call"}
            </span>
            {entry.senderName && <span className="text-[10px] text-white/40">— {entry.senderName as string}</span>}
            <ChevronDown className={cn("w-3 h-3 text-cyan-400/50 ml-auto transition-transform", isExpanded && "rotate-180")} />
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[9px] text-white/20 font-mono">
              {formatDateTimeInTz(entry.timestamp, timezone)}
            </span>
            <span className="text-[8px] px-1 rounded bg-cyan-500/10 text-cyan-400/60">Podium Call</span>
            {entry.deliveryStatus === "failed" && (
              <span className="text-[8px] text-red-400">Failed</span>
            )}
            {entry.podiumDeepLink && (
              <a
                href={entry.podiumDeepLink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="inline-flex items-center gap-0.5 text-[8px] text-cyan-400/50 hover:text-cyan-400 transition-colors"
              >
                <ExternalLink className="w-2.5 h-2.5" />
                Podium
              </a>
            )}
          </div>
        </button>
        {isExpanded && ((entry.body as string) || (entry.messageItems as unknown[] | undefined)?.length) && (
          <div className="mt-1 ml-3 pl-3 border-l border-cyan-500/10 py-1.5">
            {(entry.body as string) && (
              <>
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Transcript / Notes</p>
                <p className="text-[11px] text-white/50 leading-relaxed whitespace-pre-wrap">{entry.body as string}</p>
              </>
            )}
            {(entry.messageItems as unknown[] | undefined)?.length ? (
              <div className={entry.body ? "mt-2" : ""}>
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Message Details</p>
                {(entry.messageItems as Array<Record<string, unknown>>).map((item, idx) => (
                  <div key={idx} className="text-[10px] text-white/40 mb-0.5">
                    {item.type === "text" && <span>{String(item.text || item.body || "")}</span>}
                    {item.type === "image" && <span className="italic">[Image: {String(item.url || item.src || "attachment")}]</span>}
                    {item.type !== "text" && item.type !== "image" && <span>{String(item.type || "item")}: {String(item.text || item.body || JSON.stringify(item))}</span>}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  const renderPodiumEntry = (entry: TimelineEntry) => {
    if (entry.type === "podium_call") return renderPodiumCall(entry);
    return renderPodiumText(entry);
  };

  const renderStatusChange = (entry: TimelineEntry) => (
    <div className="flex items-center gap-2 flex-wrap py-1">
      <span className="text-[10px] text-white/30 font-mono shrink-0">
        {formatDateTimeInTz(entry.timestamp, timezone)}
      </span>
      <span className="text-[10px] text-white/50">{(entry.csrName as string) || "System"}</span>
      <div className="flex items-center gap-1">
        {entry.fromStatus ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/60 border border-white/10 font-medium uppercase tracking-wide">
            {entry.fromStatus.replace(/_/g, " ")}
          </span>
        ) : (
          <span className="text-[10px] text-white/40 italic">new</span>
        )}
        <ArrowRight className="w-3 h-3 text-purple-400/70" />
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/20 font-semibold uppercase tracking-wide">
          {(entry.toStatus || "").replace(/_/g, " ")}
        </span>
      </div>
      {entry.reason && (
        <span className="text-[10px] text-white/40 italic">— {entry.reason.replace(/_/g, " ")}</span>
      )}
    </div>
  );

  const pulseCount = unifiedTimeline.filter(e => e.source === "pulse" && e.type !== "status_change").length;
  const podiumCount = unifiedTimeline.filter(e => e.source === "podium").length;
  const statusChangeCount = unifiedTimeline.filter(e => e.type === "status_change").length;

  return (
    <div className="space-y-0">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/60 mb-2 transition-colors">
        <History className="w-3 h-3" />
        Interaction Timeline ({unifiedTimeline.length})
        {podiumCount > 0 && <span className="text-[9px] text-blue-400/50 ml-1">{podiumCount} Podium</span>}
        {pulseCount > 0 && <span className="text-[9px] text-white/30 ml-1">{pulseCount} Pulse</span>}
        {statusChangeCount > 0 && <span className="text-[9px] text-purple-400/60 ml-1">{statusChangeCount} Status</span>}
        <ChevronDown className={cn("w-3 h-3 transition-transform", expanded && "rotate-180")} />
      </button>
      <div className="relative pl-4 border-l border-white/5 space-y-2">
        {displayed.map(entry => (
          <div key={`${entry.type}-${entry.id}`} className="relative">
            <div className={cn("absolute -left-[21px] top-1.5 w-3 h-3 rounded-full flex items-center justify-center border", getNodeColor(entry))}>
              {getIcon(entry)}
            </div>
            {entry.type === "status_change"
              ? renderStatusChange(entry)
              : entry.source === "podium"
                ? renderPodiumEntry(entry)
                : renderPulseAction(entry)}
          </div>
        ))}
      </div>
      {unifiedTimeline.length > 5 && !expanded && (
        <button onClick={() => setExpanded(true)} className="text-[10px] text-primary/60 hover:text-primary ml-4 mt-1">
          Show {unifiedTimeline.length - 5} more...
        </button>
      )}
    </div>
  );
}

type PodiumMsg = PodiumMessage;

function PodiumChatPanel({ leadId, tenantId, timezone }: { leadId: number; tenantId: number; timezone: string }) {
  const [messages, setMessages] = useState<PodiumMsg[]>([]);
  const [messageText, setMessageText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [conversationUid, setConversationUid] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lineHeight = 20;
    const paddingY = 16;
    const maxHeight = lineHeight * 5 + paddingY;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
    ta.style.overflowY = ta.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [messageText]);

  const { data: conversationData, isLoading: loading, refetch: refetchConversation } = useGetPodiumConversation(leadId, { tenantId });

  useEffect(() => {
    if (!conversationData) return;
    const msgs = [...(conversationData.messages ?? [])];
    msgs.sort((a, b) => new Date(a.podiumCreatedAt || a.createdAt).getTime() - new Date(b.podiumCreatedAt || b.createdAt).getTime());
    setMessages(msgs);
    if (conversationData.conversationUid) setConversationUid(conversationData.conversationUid);
  }, [conversationData]);

  const fetchMessages = useCallback(() => { refetchConversation(); }, [refetchConversation]);

  useEffect(() => {
    const socket = socketIOClient({ path: "/api/socket.io", withCredentials: true, transports: ["websocket", "polling"] });
    const CALL_TYPES = ["call", "phone_call", "car_wars"];
    socket.on("podium-message", (msg: PodiumMsg & { leadId?: number }) => {
      if (msg.leadId === leadId && !CALL_TYPES.includes(msg.channelType || "")) {
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      }
    });
    return () => { socket.disconnect(); };
  }, [leadId]);

  useEffect(() => {
    if (expanded) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, expanded]);

  const sendMessageMutation = useSendPodiumMessage();
  const sending = sendMessageMutation.isPending;
  const sendError = sendMessageMutation.error;
  const sendErrorMessage = useMemo(() => {
    if (!sendError) return null;
    const data = (sendError as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const errField = (data as Record<string, unknown>).error;
      if (typeof errField === "string" && errField.trim()) return errField;
    }
    return sendError.message || "Failed to send message";
  }, [sendError]);

  const handleSend = async () => {
    if (!messageText.trim() || sending) return;
    try {
      await sendMessageMutation.mutateAsync({
        data: { leadId, body: messageText.trim() },
        params: { tenantId },
      });
      setMessageText("");
      fetchMessages();
    } catch {}
  };

  return (
    <PremiumCard className="p-0 overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-medium text-blue-400">SMS Conversation</span>
          <span className="text-[9px] text-white/20 px-1.5 py-0.5 rounded bg-white/5">via Podium</span>
          {!expanded && messages.length > 0 && (
            <span className="text-[9px] text-white/30 px-1.5 py-0.5 rounded bg-white/5">{messages.length} messages</span>
          )}
        </div>
        <ChevronDown className={cn("w-4 h-4 text-white/30 transition-transform", expanded && "rotate-180")} />
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-white/5">
          <div className="max-h-64 overflow-y-auto space-y-2 mb-3 pr-1 mt-3">
            {loading && <div className="py-4 text-center"><Loader2 className="w-4 h-4 text-white/30 animate-spin mx-auto" /></div>}
            {!loading && messages.length === 0 && (
              <p className="text-xs text-white/20 text-center py-4">No messages yet. Send the first text!</p>
            )}
            {messages.map(msg => (
              <div key={msg.id} className={cn("flex", msg.direction === "outbound" ? "justify-end" : "justify-start")}>
                <div className={cn(
                  "max-w-[80%] rounded-xl px-3 py-2",
                  msg.direction === "outbound"
                    ? "bg-blue-500/20 border border-blue-500/20 text-white/80"
                    : "bg-white/5 border border-white/10 text-white/70"
                )}>
                  <p className="text-xs leading-relaxed">{msg.body || ""}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-[9px] text-white/25">
                      {msg.podiumCreatedAt ? formatDateTimeInTz(msg.podiumCreatedAt, timezone) : ""}
                    </span>
                    {msg.channelType === "form" && (
                      <span className="text-[8px] italic text-amber-400/50">Only visible in Podium</span>
                    )}
                    {msg.deliveryStatus && msg.direction === "outbound" && (
                      <span className={cn(
                        "text-[8px] px-1 py-0.5 rounded",
                        msg.deliveryStatus === "failed" ? "text-red-400 bg-red-500/10" : "text-white/20"
                      )}>
                        {msg.deliveryStatus}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              rows={1}
              value={messageText}
              onChange={e => setMessageText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Type a message..."
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none"
              style={{ overflowY: "hidden" }}
            />
            <button
              onClick={handleSend}
              disabled={!messageText.trim() || sending}
              className="px-3 py-2 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-50 transition-colors"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
          {sendErrorMessage && (
            <p className="mt-2 text-xs text-red-400" role="alert">{sendErrorMessage}</p>
          )}
        </div>
      )}
    </PremiumCard>
  );
}

function LeadDetailView({ lead, tenantId, onBack, onUpdate, onSpiffEarned, timezone = "America/New_York", funnelMap = {}, canEditActions = false, currentUserId, isAdminRole = false, isArchived = false, userRole, onOpenLeadById }: {
  lead: LeadData; tenantId: number; onBack: () => void; onUpdate: () => void; onSpiffEarned?: (amount: number) => void; timezone?: string; funnelMap?: Record<number, string>; canEditActions?: boolean; currentUserId?: number; isAdminRole?: boolean; isArchived?: boolean; userRole?: string; onOpenLeadById?: (leadId: number) => void;
}) {
  const [actionStep, setActionStep] = useState<null | "call_done" | "call_result" | "spoke_result" | "dead_reason" | "dead_reason_custom" | "text_done" | "text_result" | "vm_done" | "appt_booked_spoke" | "appt_cancel_reason">(null);
  const [customDeadNote, setCustomDeadNote] = useState("");
  const [selectedCallResult, setSelectedCallResult] = useState<string | null>(null);
  const [deadFromFlow, setDeadFromFlow] = useState<"call" | "text">("call");
  const [apptBookedChannel, setApptBookedChannel] = useState<"call" | "text" | "voicemail_drop">("call");
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  const [csrs, setCsrs] = useState<CsrOption[]>([]);
  const [selectedCsr, setSelectedCsr] = useState<number | null>(null);
  const [showScripts, setShowScripts] = useState(false);
  const [commConfig, setCommConfig] = useState<{ callPlatform: string; textPlatform: string }>({ callPlatform: "native", textPlatform: "native" });
  useEffect(() => {
    fetch(`${API_BASE}/leads/comm-config?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setCommConfig({ callPlatform: d.callPlatform || "native", textPlatform: d.textPlatform || "native" }))
      .catch(() => {});
  }, [tenantId]);
  const [showCallScripts, setShowCallScripts] = useState(false);
  const [showVmScripts, setShowVmScripts] = useState(false);
  const [callbackDate, setCallbackDate] = useState("");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const contactPrefs = (lead.contactPreferences || []) as string[];
  const blocksCall = contactPrefs.some(p => CONTACT_FLAG_CONFIG[p]?.blocksCall);

  useEffect(() => {
    fetch(`${API_BASE}/leads-hub/csrs?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setCsrs(d.csrs || []))
      .catch(() => {});
  }, [tenantId]);

  const showFeedback = (type: "success" | "error", msg: string) => {
    setFeedback({ type, msg });
    setTimeout(() => setFeedback(null), 3000);
  };

  const logAction = async (body: Record<string, unknown>) => {
    setActionLoading(true);
    try {
      let commissionBefore: number | null = null;
      if (body.appointmentSet && onSpiffEarned) {
        try {
          const statsRes = await fetch(`${API_BASE}/leads/hud/stats?tenantId=${tenantId}`, { credentials: "include" });
          if (statsRes.ok) {
            const s = await statsRes.json();
            commissionBefore = s.commission ?? null;
          }
        } catch {}
      }

      const res = await fetch(`${API_BASE}/leads-hub/action?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ leadId: lead.id, ...body }),
      });
      if (res.ok) {
        const data = await res.json();
        showFeedback("success", `Action logged — ${data.lead?.hubStatus || "updated"}`);
        setActionStep(null);
        setSelectedCallResult(null);
        setCallbackDate("");
        onUpdate();

        if (body.appointmentSet && onSpiffEarned && commissionBefore !== null) {
          try {
            const statsRes = await fetch(`${API_BASE}/leads/hud/stats?tenantId=${tenantId}`, { credentials: "include" });
            if (statsRes.ok) {
              const s = await statsRes.json();
              const delta = (s.commission ?? 0) - commissionBefore;
              if (delta > 0) onSpiffEarned(delta);
            }
          } catch {}
        }
      } else {
        const err = await res.json();
        showFeedback("error", err.error || "Failed");
      }
    } catch {
      showFeedback("error", "Connection error");
    } finally {
      setActionLoading(false);
    }
  };

  const handleCall = () => {
    if (blocksCall) {
      showFeedback("error", "This lead has a contact restriction that prevents calls");
      return;
    }
    if (lead.phone && commConfig.callPlatform !== "none") window.open(`tel:${lead.phone.replace(/[^0-9+]/g, "")}`, "_self");
    if (lead.hubStatus === "appt_booked") {
      setApptBookedChannel("call");
    }
    setActionStep("call_done");
  };

  const handleText = () => {
    if (commConfig.textPlatform !== "none" && commConfig.textPlatform !== "podium" && lead.phone) {
      window.open(`sms:${lead.phone.replace(/[^0-9+]/g, "")}`, "_self");
    }
    if (lead.hubStatus === "appt_booked") {
      setApptBookedChannel("text");
    }
    setActionStep("text_done");
  };

  const handleVmDrop = () => {
    if (lead.hubStatus === "appt_booked") {
      setApptBookedChannel("voicemail_drop");
    }
    setActionStep("vm_done");
  };

  const confirmVmDrop = () => {
    logAction({ actionType: "voicemail_drop" });
  };

  const handleTransfer = async () => {
    if (!selectedCsr) return;
    setActionLoading(true);
    try {
      const res = await fetch(`${API_BASE}/leads-hub/${lead.id}/transfer?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ targetCsrId: selectedCsr }),
      });
      if (res.ok) {
        showFeedback("success", "Lead transferred");
        setShowTransfer(false);
        onUpdate();
      } else {
        const err = await res.json();
        showFeedback("error", err.error || "Transfer failed");
      }
    } catch {
      showFeedback("error", "Connection error");
    } finally {
      setActionLoading(false);
    }
  };

  const substituteSmartFields = (content: string) => {
    return content
      .replace(/\{\{lead_name\}\}/g, lead.firstName)
      .replace(/\{\{csr_name\}\}/g, lead.assignedTo || "your CSR")
      .replace(/\{\{service_type\}\}/g, lead.serviceType || lead.interestType || "HVAC service")
      .replace(/\{\{funnel\}\}/g, lead.leadType || lead.source);
  };

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/60 transition-colors mb-2">
        <ChevronDown className="w-3 h-3 rotate-90" /> {isArchived ? "Back to archive" : "Back to queue"}
      </button>

      <PremiumCard className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h2 className="font-display text-xl text-white">{lead.firstName} {lead.lastName}</h2>
              <DayBadge hubStatus={lead.hubStatus} />
              {lead.hasSoldEstimate && <ClosedBadge />}
              {lead.resubmittedAt && <ResubBadge count={lead.resubmissionCount} />}
              <FunnelBadge funnelId={lead.funnelId} funnelMap={funnelMap} />
              <span className="text-xs text-white/30 font-mono">Day {lead.dayInSequence}</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <EditableSourceTag leadId={lead.id} source={lead.source} originalSource={lead.originalSource} userRole={userRole} onSourceChanged={() => onUpdate()} tenantId={tenantId} />
              {lead.serviceType && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-white/5 text-white/50 border border-white/10">{lead.serviceType}</span>
              )}
              {lead.phone && (
                <span className="inline-flex items-center gap-0.5">
                  {blocksCall
                    ? <span className="text-sm text-white/40 font-mono">{formatPhone(lead.phone)}</span>
                    : <a href={`tel:${lead.phone}`} className="text-sm text-blue-400 hover:text-blue-300 font-mono">{formatPhone(lead.phone)}</a>
                  }
                  <CopyBtn text={lead.phone.replace(/[^0-9+]/g, "")} />
                </span>
              )}
              {lead.email && (
                <span className="inline-flex items-center gap-0.5">
                  <a href={`mailto:${lead.email}`} className="text-sm text-purple-400 hover:text-purple-300">{lead.email}</a>
                  <CopyBtn text={lead.email} />
                </span>
              )}
            </div>
            <ContactFlags preferences={lead.contactPreferences} />
            {lead.assignedTo && (
              <p className="text-xs text-white/30 mt-1">Assigned to: <span className="text-white/50">{lead.assignedTo}</span></p>
            )}
            {lead.callbackAt && (
              <p className="text-xs text-amber-400/70 mt-1 flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Callback: {formatDateTimeInTz(lead.callbackAt, timezone)}
              </p>
            )}
            {(lead.hubStatus === "appt_set" || lead.hubStatus === "appt_booked" || lead.hasSoldEstimate) && (
              <p className="text-xs text-emerald-400/80 mt-1 flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Booked: {lead.bookedAt ? `${formatDateTimeInTz(lead.bookedAt, timezone)} · ${formatTimeSince(lead.bookedAt).text}` : "—"}
              </p>
            )}
            {lead.deadReason && (
              <p className="text-[10px] text-red-400/60 mt-1">Reason: {lead.deadReason.replace(/_/g, " ")}</p>
            )}
          </div>
          {!isArchived && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowTransfer(!showTransfer)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-white/30 hover:text-white/50 hover:bg-white/5 transition-colors"
              >
                <UserPlus className="w-3 h-3" /> Transfer
              </button>
            </div>
          )}
        </div>

        {!isArchived && showTransfer && (
          <div className="mt-3 p-3 rounded-lg bg-white/5 border border-white/10 space-y-2">
            <p className="text-xs text-white/40">Transfer to another CSR:</p>
            <div className="flex items-center gap-2">
              <Select value={selectedCsr ? String(selectedCsr) : ""} onValueChange={v => setSelectedCsr(Number(v))}>
                <SelectTrigger className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white">
                  <SelectValue placeholder="Select CSR..." />
                </SelectTrigger>
                <SelectContent>
                  {csrs.filter(c => c.id !== lead.assignedCsrId).map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                onClick={handleTransfer}
                disabled={!selectedCsr || actionLoading}
                className="px-3 py-1.5 rounded bg-primary/20 text-primary text-xs font-medium hover:bg-primary/30 disabled:opacity-50 transition-colors"
              >
                {actionLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Transfer"}
              </button>
            </div>
          </div>
        )}
      </PremiumCard>

      {lead.hubStatus === "appt_booked" && actionStep === "appt_booked_spoke" && (
        <PremiumCard className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-5 h-5 text-purple-400" />
            <span className="text-sm font-medium text-purple-400">PRE-BOOKED APPOINTMENT</span>
          </div>
          <p className="text-sm text-white/60 mb-4">Spoke with customer — confirm the appointment status:</p>
          <div className="space-y-2">
            <button
              onClick={() => logAction({
                actionType: apptBookedChannel,
                apptBookedOutcome: "confirmed",
                ...(apptBookedChannel === "call" ? { callResult: "spoke_with_customer" } : {}),
                ...(apptBookedChannel === "text" ? { textResult: "yes" } : {}),
                ...(apptBookedChannel === "voicemail_drop" ? { vmResult: "spoke_with_customer" } : {}),
              })}
              disabled={actionLoading}
              className="w-full px-4 py-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-sm font-medium hover:bg-emerald-500/25 disabled:opacity-50 transition-colors text-left flex items-center gap-2"
            >
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Confirmed
            </button>
            <button
              onClick={() => logAction({
                actionType: apptBookedChannel,
                apptBookedOutcome: "rescheduled",
                ...(apptBookedChannel === "call" ? { callResult: "spoke_with_customer" } : {}),
                ...(apptBookedChannel === "text" ? { textResult: "yes" } : {}),
                ...(apptBookedChannel === "voicemail_drop" ? { vmResult: "spoke_with_customer" } : {}),
              })}
              disabled={actionLoading}
              className="w-full px-4 py-2.5 rounded-lg bg-amber-500/15 border border-amber-500/25 text-amber-400 text-sm font-medium hover:bg-amber-500/25 disabled:opacity-50 transition-colors text-left flex items-center gap-2"
            >
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calendar className="w-4 h-4" />}
              Rescheduled
            </button>
            <button
              onClick={() => { setCancelReason(""); setActionStep("appt_cancel_reason"); }}
              disabled={actionLoading}
              className="w-full px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm font-medium hover:bg-red-500/20 disabled:opacity-50 transition-colors text-left flex items-center gap-2"
            >
              <XCircle className="w-4 h-4" />
              Canceled
            </button>
          </div>
          <button onClick={() => setActionStep(apptBookedChannel === "call" ? "call_done" : apptBookedChannel === "text" ? "text_done" : "vm_done")} className="mt-2 text-[10px] text-white/30 hover:text-white/50">Back</button>
        </PremiumCard>
      )}

      {actionStep === "appt_cancel_reason" && (
        <PremiumCard className="p-4">
          <p className="text-sm text-white/60 mb-3">Why was the appointment canceled?</p>
          <textarea
            value={cancelReason}
            onChange={e => setCancelReason(e.target.value)}
            placeholder="Enter reason for cancellation..."
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white mb-3 min-h-[80px] resize-none placeholder-white/20"
          />
          <button
            onClick={() => logAction({
              actionType: apptBookedChannel,
              apptBookedOutcome: "canceled",
              cancelReason: cancelReason || "appointment_canceled",
              ...(apptBookedChannel === "call" ? { callResult: "spoke_with_customer" } : {}),
              ...(apptBookedChannel === "text" ? { textResult: "yes" } : {}),
              ...(apptBookedChannel === "voicemail_drop" ? { vmResult: "spoke_with_customer" } : {}),
            })}
            disabled={actionLoading}
            className="w-full px-3 py-2 rounded-lg bg-red-500/20 text-red-400 text-sm font-medium hover:bg-red-500/30 disabled:opacity-50 transition-colors"
          >
            {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Confirm Cancellation"}
          </button>
          <button onClick={() => setActionStep("appt_booked_spoke")} className="mt-2 text-[10px] text-white/30 hover:text-white/50">Back</button>
        </PremiumCard>
      )}

      {!isArchived && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleCall}
            disabled={!lead.phone || actionStep !== null}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all",
              blocksCall
                ? "bg-red-500/10 border border-red-500/20 text-red-400 cursor-not-allowed"
                : "bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/25",
              (!lead.phone || actionStep !== null) && "opacity-50 cursor-not-allowed"
            )}
          >
            {blocksCall ? <Ban className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
            CALL
          </button>
          <button
            onClick={handleText}
            disabled={!lead.phone || actionStep !== null}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-500/15 border border-blue-500/25 text-blue-400 text-sm font-medium hover:bg-blue-500/25 transition-all",
              (!lead.phone || actionStep !== null) && "opacity-50 cursor-not-allowed"
            )}
          >
            <MessageSquare className="w-4 h-4" /> TEXT
          </button>
          <button
            onClick={handleVmDrop}
            disabled={actionStep !== null || actionLoading || blocksCall}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all",
              blocksCall
                ? "bg-red-500/10 border border-red-500/20 text-red-400 cursor-not-allowed"
                : "bg-orange-500/15 border border-orange-500/25 text-orange-400 hover:bg-orange-500/25",
              (actionStep !== null || actionLoading || blocksCall) && "opacity-50 cursor-not-allowed"
            )}
          >
            {blocksCall ? <Ban className="w-4 h-4" /> : <Mic className="w-4 h-4" />} VM DROP
          </button>
        </div>
      )}

      {!isArchived && blocksCall && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-xs text-red-400">This lead has a "Text Only" or "Do Not Call" flag. Calling is blocked.</p>
        </div>
      )}

      {commConfig.textPlatform === "podium" && lead.phone && (
        <PodiumChatPanel
          leadId={lead.id}
          tenantId={tenantId}
          timezone={timezone}
        />
      )}

      <AnimatePresence mode="wait">
        {feedback && (
          <motion.div
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm",
              feedback.type === "success" ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400" : "bg-red-500/10 border border-red-500/20 text-red-400"
            )}
          >
            {feedback.type === "success" ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            {feedback.msg}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {actionStep === "call_done" && (
          <motion.div
            key="call-done"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <PremiumCard className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <span className="text-sm font-medium text-emerald-400">CALLED</span>
                <span className="text-[10px] text-white/30 font-mono">{formatTimeInTz(new Date(), timezone)}</span>
              </div>

              <button
                onClick={() => setShowCallScripts(!showCallScripts)}
                className="flex items-center gap-1.5 text-xs text-primary/60 hover:text-primary mb-3 transition-colors"
              >
                <FileText className="w-3 h-3" /> {showCallScripts ? "Hide" : "Show"} Call Scripts
              </button>

              {showCallScripts && (
                <div className="space-y-2 mb-3">
                  {SMART_FIELD_SCRIPTS.call.map((s, i) => {
                    const filled = substituteSmartFields(s.content);
                    return (
                      <div key={i} className="p-2.5 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                        <span className="text-[10px] text-emerald-400/60 font-medium block mb-1">{s.name}</span>
                        <p className="text-xs text-white/60 leading-relaxed">{filled}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              <p className="text-sm text-white/60 mb-3">How'd it go?</p>
              <div className="grid grid-cols-2 gap-2">
                {CALL_RESULTS.map(r => (
                  <button
                    key={r.value}
                    onClick={() => {
                      if (r.value === "spoke_with_customer") {
                        setSelectedCallResult(r.value);
                        if (lead.hubStatus === "appt_booked") {
                          setActionStep("appt_booked_spoke");
                        } else {
                          setActionStep("spoke_result");
                        }
                      } else {
                        logAction({ actionType: "call", callResult: r.value });
                      }
                    }}
                    disabled={actionLoading}
                    className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white/70 hover:bg-white/10 hover:text-white transition-colors text-left"
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <button onClick={() => setActionStep(null)} className="mt-2 text-[10px] text-white/30 hover:text-white/50">Cancel</button>
            </PremiumCard>
          </motion.div>
        )}

        {actionStep === "spoke_result" && (
          <motion.div
            key="spoke-result"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <PremiumCard className="p-4">
              <p className="text-sm text-white/60 mb-3">Spoke with customer — what happened?</p>
              <div className="space-y-2">
                {SPOKE_RESULTS.map(r => (
                  <button
                    key={r.value}
                    onClick={() => {
                      if (r.value === "appointment_set") {
                        logAction({ actionType: "call", callResult: "spoke_with_customer", appointmentSet: true });
                      } else if (r.value === "call_back") {
                        setSelectedCallResult("spoke_with_customer");
                        setActionStep("call_result");
                      } else if (r.value === "dead") {
                        setSelectedCallResult("spoke_with_customer");
                        setDeadFromFlow("call");
                        setActionStep("dead_reason");
                      }
                    }}
                    disabled={actionLoading}
                    className={cn("w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm font-medium hover:bg-white/10 transition-colors text-left", r.color)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <button onClick={() => setActionStep("call_done")} className="mt-2 text-[10px] text-white/30 hover:text-white/50">Back</button>
            </PremiumCard>
          </motion.div>
        )}

        {actionStep === "call_result" && (
          <motion.div
            key="callback"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <PremiumCard className="p-4">
              <p className="text-sm text-white/60 mb-3">When should we call back?</p>
              <input
                type="datetime-local"
                value={callbackDate}
                onChange={e => setCallbackDate(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white mb-3 [color-scheme:dark]"
              />
              <button
                onClick={() => logAction({ actionType: "call", callResult: selectedCallResult, callbackAt: localInputToUtcIso(callbackDate, timezone) })}
                disabled={actionLoading || !callbackDate}
                className="w-full px-3 py-2 rounded-lg bg-amber-500/20 text-amber-400 text-sm font-medium hover:bg-amber-500/30 disabled:opacity-50 transition-colors"
              >
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Log Callback"}
              </button>
              <button onClick={() => setActionStep("spoke_result")} className="mt-2 text-[10px] text-white/30 hover:text-white/50">Back</button>
            </PremiumCard>
          </motion.div>
        )}

        {actionStep === "dead_reason" && (
          <motion.div
            key="dead-reason"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <PremiumCard className="p-4">
              <p className="text-sm text-white/60 mb-3">Why is this lead dead?</p>
              <div className="grid grid-cols-2 gap-2">
                {DEAD_REASONS.map(r => (
                  <button
                    key={r.value}
                    onClick={() => {
                      if (r.value === "custom") {
                        setCustomDeadNote("");
                        setActionStep("dead_reason_custom");
                        return;
                      }
                      logAction(
                        deadFromFlow === "call"
                          ? { actionType: "call", callResult: selectedCallResult, deadReason: r.value }
                          : { actionType: "text", textResult: "dead", deadReason: r.value }
                      );
                    }}
                    disabled={actionLoading}
                    className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300 hover:bg-red-500/20 transition-colors text-left"
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <button onClick={() => setActionStep(deadFromFlow === "call" ? "spoke_result" : "text_done")} className="mt-2 text-[10px] text-white/30 hover:text-white/50">Back</button>
            </PremiumCard>
          </motion.div>
        )}

        {actionStep === "dead_reason_custom" && (
          <motion.div
            key="dead-reason-custom"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <PremiumCard className="p-4">
              <p className="text-sm text-white/60 mb-3">Enter custom dead reason:</p>
              <input
                type="text"
                value={customDeadNote}
                onChange={e => setCustomDeadNote(e.target.value)}
                placeholder="Type your reason..."
                autoFocus
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-white/20 mb-2"
              />
              <button
                onClick={() => {
                  if (!customDeadNote.trim()) return;
                  logAction(
                    deadFromFlow === "call"
                      ? { actionType: "call", callResult: selectedCallResult, deadReason: customDeadNote.trim() }
                      : { actionType: "text", textResult: "dead", deadReason: customDeadNote.trim() }
                  );
                }}
                disabled={actionLoading || !customDeadNote.trim()}
                className="w-full px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                Submit
              </button>
              <button onClick={() => setActionStep("dead_reason")} className="mt-2 text-[10px] text-white/30 hover:text-white/50">Back</button>
            </PremiumCard>
          </motion.div>
        )}

        {actionStep === "text_done" && (
          <motion.div
            key="text-done"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <PremiumCard className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 className="w-5 h-5 text-blue-400" />
                <span className="text-sm font-medium text-blue-400">TEXTED</span>
                <span className="text-[10px] text-white/30 font-mono">{formatTimeInTz(new Date(), timezone)}</span>
              </div>

              <button
                onClick={() => setShowScripts(!showScripts)}
                className="flex items-center gap-1.5 text-xs text-primary/60 hover:text-primary mb-3 transition-colors"
              >
                <Copy className="w-3 h-3" /> {showScripts ? "Hide" : "Show"} Pre-written Scripts
              </button>

              {showScripts && (
                <div className="space-y-2 mb-3">
                  {SMART_FIELD_SCRIPTS.text.map((s, i) => {
                    const filled = substituteSmartFields(s.content);
                    const isCopied = copiedIndex === i;
                    return (
                      <div
                        key={i}
                        onClick={() => {
                          navigator.clipboard.writeText(filled);
                          setCopiedIndex(i);
                          setTimeout(() => setCopiedIndex(prev => prev === i ? null : prev), 10000);
                        }}
                        className="p-2.5 rounded-lg bg-blue-500/5 border border-blue-500/10 cursor-pointer hover:bg-blue-500/10 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-blue-400/60 font-medium">{s.name}</span>
                          <span className={cn(
                            "flex items-center gap-1 text-[9px] transition-colors",
                            isCopied ? "text-emerald-400" : "text-blue-400/50"
                          )}>
                            {isCopied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
                            {isCopied ? "Copied" : "Copy"}
                          </span>
                        </div>
                        <p className="text-xs text-white/60 leading-relaxed">{filled}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              {lead.phone && commConfig.textPlatform !== "none" && commConfig.textPlatform !== "podium" && (
                <a
                  href={`sms:${lead.phone.replace(/[^0-9+]/g, "")}?body=${encodeURIComponent(substituteSmartFields(SMART_FIELD_SCRIPTS.text[0].content))}`}
                  className="flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-lg bg-blue-500/15 text-blue-400 text-xs font-medium hover:bg-blue-500/25 mb-3 transition-colors"
                >
                  <MessageSquare className="w-3.5 h-3.5" /> Open SMS App
                </a>
              )}

              <p className="text-sm text-white/60 mb-2">How'd it go?</p>
              <div className="grid grid-cols-2 gap-2">
                {TEXT_RESULTS.map(r => (
                  <button
                    key={r.value}
                    onClick={() => {
                      if (r.value === "dead") {
                        setDeadFromFlow("text");
                        setActionStep("dead_reason");
                      } else if (r.value === "no_need") {
                        setActionStep(null);
                      } else if (r.value === "yes" && lead.hubStatus === "appt_booked") {
                        setApptBookedChannel("text");
                        setActionStep("appt_booked_spoke");
                      } else {
                        logAction({ actionType: "text", textResult: r.value });
                      }
                    }}
                    disabled={actionLoading}
                    className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white/70 hover:bg-white/10 hover:text-white transition-colors text-left"
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <button onClick={() => setActionStep(null)} className="mt-2 text-[10px] text-white/30 hover:text-white/50">Cancel</button>
            </PremiumCard>
          </motion.div>
        )}

        {actionStep === "vm_done" && (
          <motion.div
            key="vm-done"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <PremiumCard className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Mic className="w-5 h-5 text-orange-400" />
                <span className="text-sm font-medium text-orange-400">VM DROP</span>
                <span className="text-[10px] text-white/30 font-mono">{formatTimeInTz(new Date(), timezone)}</span>
              </div>

              <button
                onClick={() => setShowVmScripts(!showVmScripts)}
                className="flex items-center gap-1.5 text-xs text-primary/60 hover:text-primary mb-3 transition-colors"
              >
                <FileText className="w-3 h-3" /> {showVmScripts ? "Hide" : "Show"} Voicemail Scripts
              </button>

              {showVmScripts && (
                <div className="space-y-2 mb-3">
                  {SMART_FIELD_SCRIPTS.voicemail.map((s, i) => {
                    const filled = substituteSmartFields(s.content);
                    return (
                      <div key={i} className="p-2.5 rounded-lg bg-orange-500/5 border border-orange-500/10">
                        <span className="text-[10px] text-orange-400/60 font-medium block mb-1">{s.name}</span>
                        <p className="text-xs text-white/60 leading-relaxed">{filled}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              {lead.hubStatus === "appt_booked" ? (
                <>
                  <p className="text-sm text-white/60 mb-2">What happened?</p>
                  <div className="grid grid-cols-2 gap-2">
                    {VM_RESULTS.map(r => (
                      <button
                        key={r.value}
                        onClick={() => {
                          if (r.value === "spoke_with_customer") {
                            setApptBookedChannel("voicemail_drop");
                            setActionStep("appt_booked_spoke");
                          } else {
                            logAction({ actionType: "voicemail_drop", vmResult: r.value });
                          }
                        }}
                        disabled={actionLoading}
                        className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-white/70 hover:bg-white/10 hover:text-white transition-colors text-left"
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <button
                  onClick={confirmVmDrop}
                  disabled={actionLoading}
                  className="w-full px-3 py-2 rounded-lg bg-orange-500/20 text-orange-400 text-sm font-medium hover:bg-orange-500/30 disabled:opacity-50 transition-colors mb-2"
                >
                  {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Log VM Drop"}
                </button>
              )}
              <button onClick={() => setActionStep(null)} className="mt-1 text-[10px] text-white/30 hover:text-white/50">Cancel</button>
            </PremiumCard>
          </motion.div>
        )}
      </AnimatePresence>

      {(lead.appointmentDate || lead.appointmentTime || lead.addOns || lead.address || lead.city || lead.state || lead.zip) && (
        <PremiumCard className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-3.5 h-3.5 text-white/40" />
            <span className="text-xs font-medium text-white/50 uppercase tracking-wider">Details</span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            {lead.appointmentDate && (
              <div>
                <span className="text-[10px] text-white/30 uppercase block">Appt Date</span>
                <span className="text-sm text-white/80">{lead.appointmentDate}</span>
              </div>
            )}
            {lead.appointmentTime && (
              <div>
                <span className="text-[10px] text-white/30 uppercase block">Appt Time</span>
                <span className="text-sm text-white/80">{lead.appointmentTime}</span>
              </div>
            )}
            {lead.addOns && (
              <div className="col-span-2">
                <span className="text-[10px] text-white/30 uppercase block">Add-Ons</span>
                <span className="text-sm text-white/80">{lead.addOns}</span>
              </div>
            )}
            {(lead.address || lead.city || lead.state || lead.zip) && (
              <div className="col-span-2">
                <span className="text-[10px] text-white/30 uppercase block">Address</span>
                <span className="text-sm text-white/80">
                  {[lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(", ")}
                </span>
              </div>
            )}
          </div>
        </PremiumCard>
      )}

      {lead.notes && (
        <PremiumCard className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-3.5 h-3.5 text-white/40" />
            <span className="text-xs font-medium text-white/50 uppercase tracking-wider">Notes</span>
          </div>
          <p className="text-sm text-white/70 whitespace-pre-wrap leading-relaxed">{lead.notes}</p>
        </PremiumCard>
      )}

      {lead.hasSoldEstimate && (
        <ContractDetailsSection leadId={lead.id} tenantId={tenantId} timezone={timezone} />
      )}

      <LeadMergeHistory leadId={lead.id} timezone={timezone} onOpenLeadById={onOpenLeadById} />

      <LeadCorrectionHistory leadId={lead.id} tenantId={tenantId} timezone={timezone} />

      <PremiumCard className="p-4">
        <ActionHistoryTimeline leadId={lead.id} tenantId={tenantId} timezone={timezone} canEdit={canEditActions} currentUserId={currentUserId} isAdminRole={isAdminRole} leadHubStatus={lead.hubStatus} leadBookedAt={lead.bookedAt} />
      </PremiumCard>
    </div>
  );
}

type CorrectionRecord = {
  id: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
  changedByUserId: number | null;
  changedByName: string | null;
};
function LeadCorrectionHistory({ leadId, tenantId, timezone }: { leadId: number; tenantId: number; timezone: string }) {
  const [corrections, setCorrections] = useState<CorrectionRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = tenantId ? `?tenantId=${tenantId}` : "";
    fetch(`${API_BASE}/leads-hub/${leadId}/corrections${qs}`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : { corrections: [] }))
      .then(d => { if (!cancelled) setCorrections(d.corrections || []); })
      .catch(() => { if (!cancelled) setCorrections([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
  }, [leadId, tenantId]);

  if (loading || corrections.length === 0) return null;

  return (
    <PremiumCard className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <History className="w-3.5 h-3.5 text-white/40" />
        <span className="text-xs font-medium text-white/50 uppercase tracking-wider">Correction history</span>
      </div>
      <ul className="space-y-1.5">
        {corrections.map(c => (
          <li key={c.id} className="text-xs text-white/70 flex items-center gap-2 flex-wrap">
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-white/5 text-white/60 border border-white/10 uppercase">{c.field}</span>
            <span className="font-mono text-white/40 line-through">{c.oldValue || "—"}</span>
            <span className="text-white/30">→</span>
            <span className="font-mono text-white/80">{c.newValue || "—"}</span>
            <span className="text-white/30">·</span>
            <span className="text-white/40">{formatDateTimeInTz(c.changedAt, timezone)}</span>
            {c.changedByName && (
              <>
                <span className="text-white/30">·</span>
                <span className="text-white/40">by {c.changedByName}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </PremiumCard>
  );
}

type LeadMergeRecord = { duplicateLeadId: number; canonicalLeadId?: number; mergedAt: string; source: string; runId: string | null };
function LeadMergeHistory({ leadId, timezone, onOpenLeadById }: { leadId: number; timezone: string; onOpenLeadById?: (leadId: number) => void }) {
  const [data, setData] = useState<{ duplicates: LeadMergeRecord[]; mergedInto: LeadMergeRecord | null } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/leads/${leadId}/merges`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [leadId]);

  if (loading || !data) return null;
  if (data.duplicates.length === 0 && !data.mergedInto) return null;

  const renderLeadIdLink = (id: number) => (
    onOpenLeadById ? (
      <button
        type="button"
        onClick={() => onOpenLeadById(id)}
        className="text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline font-mono"
      >
        #{id}
      </button>
    ) : (
      <span className="font-mono text-white/50">#{id}</span>
    )
  );

  return (
    <PremiumCard className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <FileText className="w-3.5 h-3.5 text-white/40" />
        <span className="text-xs font-medium text-white/50 uppercase tracking-wider">Merge history</span>
      </div>
      {data.mergedInto && (
        <p className="text-xs text-amber-300/80 mb-2">
          This lead id was merged into lead {renderLeadIdLink(data.mergedInto.canonicalLeadId!)} on {formatDateTimeInTz(data.mergedInto.mergedAt, timezone)} by <span className="font-mono">{data.mergedInto.source}</span>
          {data.mergedInto.runId ? <> (run <span className="font-mono text-white/40">{data.mergedInto.runId}</span>)</> : null}.
        </p>
      )}
      {data.duplicates.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-white/40 uppercase tracking-wider">Absorbed duplicates</p>
          <ul className="space-y-1">
            {data.duplicates.map(d => (
              <li key={d.duplicateLeadId} className="text-xs text-white/70 flex items-center gap-2 font-mono">
                {renderLeadIdLink(d.duplicateLeadId)}
                <span className="text-white/30">→</span>
                <span className="text-white/40">{formatDateTimeInTz(d.mergedAt, timezone)}</span>
                <span className="text-white/30">·</span>
                <span className="text-white/40">{d.source}</span>
                {d.runId ? <span className="text-white/30 truncate" title={d.runId}>· {d.runId}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </PremiumCard>
  );
}

interface ContractEstimate {
  id: number;
  soldByName: string | null;
  soldOn: string | null;
  subtotal: number;
  rebateAmount: number;
  totalAmount: number;
  stEstimateId: string;
}

function ContractDetailsSection({ leadId, tenantId, timezone }: { leadId: number; tenantId: number | null; timezone: string }) {
  const [estimates, setEstimates] = useState<ContractEstimate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const qs = tenantId ? `?tenantId=${tenantId}` : "";
    fetch(`${API_BASE}/leads-hub/${leadId}/contract${qs}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setEstimates(d.estimates || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [leadId, tenantId]);

  if (loading) return null;
  if (estimates.length === 0) return null;

  return (
    <PremiumCard className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <DollarSign className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-xs font-medium text-amber-400 uppercase tracking-wider">Signed Contract</span>
      </div>
      <div className="space-y-3">
        {estimates.map(est => (
          <div key={est.id} className="rounded-lg bg-amber-500/5 border border-amber-500/15 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-base font-bold text-amber-400">
                ${(est.totalAmount || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {est.soldOn && (
                <span className="text-[10px] text-white/30 font-mono">
                  {formatInTz(est.soldOn, timezone, { month: "short", day: "numeric", year: "numeric" })}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {est.soldByName && (
                <div>
                  <span className="text-white/30 block text-[10px] uppercase">Salesperson</span>
                  <span className="text-white/70">{est.soldByName}</span>
                </div>
              )}
              {est.subtotal > 0 && est.subtotal !== est.totalAmount && (
                <div>
                  <span className="text-white/30 block text-[10px] uppercase">Subtotal</span>
                  <span className="text-white/70">${est.subtotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              )}
              {est.rebateAmount > 0 && (
                <div>
                  <span className="text-white/30 block text-[10px] uppercase">Rebate</span>
                  <span className="text-emerald-400">${est.rebateAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </PremiumCard>
  );
}

function ArchiveView({ tenantId, timezone = "America/New_York" }: { tenantId: number; timezone?: string }) {
  const { user } = useAuth();
  const isArchiveClientUser = user?.role === "client_user";
  const [filters, setFilters] = useState<Record<string, string>>({});
  const { data, loading, refetch } = useArchive(tenantId, filters);
  const [showFilters, setShowFilters] = useState(false);
  const [csrs, setCsrs] = useState<CsrOption[]>([]);
  const [selectedLead, setSelectedLead] = useState<LeadData | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/leads-hub/csrs?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setCsrs(d.csrs || []))
      .catch(() => {});
  }, [tenantId]);

  const updateFilter = (key: string, value: string) => {
    setFilters(prev => {
      const next = { ...prev };
      if (value) next[key] = value; else delete next[key];
      return next;
    });
  };

  useEffect(() => {
    if (!selectedLead) return;
    const updated = data.leads.find(l => l.id === selectedLead.id);
    if (updated && (updated.source !== selectedLead.source || updated.hubStatus !== selectedLead.hubStatus || updated.assignedTo !== selectedLead.assignedTo)) {
      setSelectedLead(updated);
    }
  }, [data.leads]);

  const isAdmin = !!user && ["super_admin", "agency_user", "client_admin"].includes(user.role || "");

  if (selectedLead) {
    return (
      <LeadDetailView
        lead={selectedLead}
        tenantId={tenantId}
        onBack={() => setSelectedLead(null)}
        onUpdate={() => { refetch(); }}
        timezone={timezone}
        canEditActions={!!user && ["super_admin", "agency_user", "client_admin", "client_user"].includes(user.role || "")}
        currentUserId={user?.id}
        isAdminRole={isAdmin}
        userRole={user?.role}
        isArchived
        onOpenLeadById={async (id) => {
          try {
            const r = await fetch(`${API_BASE}/leads/${id}?tenantId=${tenantId}`, { credentials: "include" });
            if (r.ok) setSelectedLead(await r.json() as LeadData);
          } catch {}
        }}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/30">{data.total} archived leads</span>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors",
            showFilters ? "bg-primary/20 text-primary" : "text-white/30 hover:text-white/50"
          )}
        >
          <Filter className="w-3 h-3" /> Filters
        </button>
      </div>

      {showFilters && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <input
            type="month"
            value={filters.month || ""}
            onChange={e => updateFilter("month", e.target.value)}
            className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/70 [color-scheme:dark]"
            placeholder="Month"
          />
          <input
            type="text"
            value={filters.source || ""}
            onChange={e => updateFilter("source", e.target.value)}
            className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/70 placeholder-white/20"
            placeholder="Source..."
          />
          <input
            type="text"
            value={filters.serviceType || ""}
            onChange={e => updateFilter("serviceType", e.target.value)}
            className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/70 placeholder-white/20"
            placeholder="Service type..."
          />
          {!isArchiveClientUser && (
            <Select value={filters.csrId || "__all__"} onValueChange={v => updateFilter("csrId", v === "__all__" ? "" : v)}>
              <SelectTrigger className="w-auto bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/70 h-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All CSRs</SelectItem>
                {csrs.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Select value={filters.status || "__all__"} onValueChange={v => updateFilter("status", v === "__all__" ? "" : v)}>
            <SelectTrigger className="w-auto bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/70 h-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              <SelectItem value="appt_set">Appointment Set</SelectItem>
              <SelectItem value="dead">Dead</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center"><Loader2 className="w-5 h-5 text-white/30 animate-spin mx-auto" /></div>
      ) : data.leads.length === 0 ? (
        <div className="py-12 text-center">
          <Archive className="w-8 h-8 text-white/10 mx-auto mb-2" />
          <p className="text-sm text-white/30">No archived leads</p>
        </div>
      ) : (
        <div className="space-y-2">
          {data.leads.map(lead => (
            <div key={lead.id} onClick={() => setSelectedLead(lead)} className="rounded-lg border border-white/5 p-3 bg-card/40 cursor-pointer hover:bg-card/60 hover:border-white/10 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white/70">{lead.firstName} {lead.lastName}</span>
                  <DayBadge hubStatus={lead.hubStatus} />
                  {lead.hasSoldEstimate && <ClosedBadge />}
              {lead.resubmittedAt && <ResubBadge count={lead.resubmissionCount} />}
                  <EditableSourceTag leadId={lead.id} source={lead.source} originalSource={lead.originalSource} userRole={user?.role} onSourceChanged={() => refetch()} tenantId={tenantId} />
                </div>
                <div className="flex items-center gap-2">
                  {lead.assignedTo && <span className="text-[10px] text-white/25">{lead.assignedTo}</span>}
                  <span className="text-[10px] text-white/20 font-mono">{formatInTz(lead.createdAt, timezone, { month: "short", day: "numeric" })}</span>
                </div>
              </div>
              {lead.phone && (
                <p className="text-[11px] text-white/30 font-mono mt-1 inline-flex items-center gap-0.5">
                  {formatPhone(lead.phone)}
                  <CopyBtn text={lead.phone.replace(/[^0-9+]/g, "")} />
                </p>
              )}
              {lead.deadReason && <p className="text-[10px] text-red-400/60 mt-1">Reason: {lead.deadReason.replace(/_/g, " ")}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Leads() {
  const { tenants, localTenantId, effectiveTenantId, setSelectedTenantId, isAgency } = useTenantFilter();
  const { user } = useAuth();
  const isAdmin = user?.role === "client_admin" || user?.role === "super_admin" || user?.role === "agency_user";
  const isClientUser = user?.role === "client_user";
  const [selectedCsrId, setSelectedCsrId] = useState<number | null>(null);
  const [csrList, setCsrList] = useState<CsrOption[]>([]);

  useEffect(() => {
    if (!isAdmin || !effectiveTenantId) { setCsrList([]); return; }
    fetch(`${API_BASE}/leads-hub/csrs?tenantId=${effectiveTenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setCsrList(d.csrs || []))
      .catch(() => {});
  }, [isAdmin, effectiveTenantId]);

  useEffect(() => {
    if (isClientUser && user?.id) {
      setSelectedCsrId(user.id);
    } else {
      setSelectedCsrId(null);
    }
  }, [effectiveTenantId, isClientUser, user?.id]);

  const [hudTimeframe, setHudTimeframe] = useState<HudTimeframe>(() => {
    const saved = localStorage.getItem(HUD_TIMEFRAME_KEY);
    if (saved === "7d" || saved === "30d" || saved === "90d") return saved;
    return "today";
  });
  const handleTimeframeChange = useCallback((tf: HudTimeframe) => {
    setHudTimeframe(tf);
    localStorage.setItem(HUD_TIMEFRAME_KEY, tf);
  }, []);
  const tfLabel = getTimeframeLabel(hudTimeframe);

  const [myPauseState, setMyPauseState] = useState<{ isPaused: boolean; pauseSource: string }>({ isPaused: false, pauseSource: "manager" });
  const [pauseToggling, setPauseToggling] = useState(false);

  const fetchMyPause = useCallback(() => {
    if (!effectiveTenantId || !isClientUser) return;
    fetch(`${API_BASE}/leads-hub/my-pause?tenantId=${effectiveTenantId}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setMyPauseState(d); })
      .catch(() => {});
  }, [effectiveTenantId, isClientUser]);

  useEffect(() => { fetchMyPause(); }, [fetchMyPause]);

  const toggleMyPause = useCallback(async () => {
    if (pauseToggling) return;
    setPauseToggling(true);
    try {
      const res = await fetch(`${API_BASE}/leads-hub/my-pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isPaused: !myPauseState.isPaused }),
      });
      const data = await res.json();
      if (res.ok) {
        setMyPauseState(data);
      }
    } catch (e) {
      console.error("[Pulse] Failed to toggle pause:", e);
    } finally {
      setPauseToggling(false);
    }
  }, [myPauseState.isPaused, pauseToggling]);

  const { data: queueData, loading, refetch } = useLeadsHubQueue(effectiveTenantId, isAgency, selectedCsrId);
  const { stats, refetch: refetchStats } = useHudStats(effectiveTenantId, isAgency, selectedCsrId, hudTimeframe);
  const { pendingNewLeads, dismissNewLead, newLeadSignal, leadUpdatedSignal, soundEnabled, setSoundEnabled, latestPodiumNotification, clearPodiumNotification, latestCallbackDue, clearCallbackDue, playCallbackSound } = usePulseSocketIO(fetchMyPause);
  const funnelMap = useFunnelTypes(effectiveTenantId);
  const { filters: searchFilters, updateFilters: updateSearchFilters, results: searchResults, searching, searchActive, clearSearch } = useLeadSearch(effectiveTenantId);
  const [showSearchFilters, setShowSearchFilters] = useState(false);
  const prevTenantRef = useRef(effectiveTenantId);
  useEffect(() => {
    if (prevTenantRef.current !== effectiveTenantId) {
      clearSearch();
      setShowSearchFilters(false);
      prevTenantRef.current = effectiveTenantId;
    }
  }, [effectiveTenantId, clearSearch]);

  const [activeTab, setActiveTab] = useState<QueueTab>("new");
  const [selectedLead, setSelectedLead] = useState<LeadData | null>(null);
  const deepLinkHandled = useRef(false);

  useEffect(() => {
    if (deepLinkHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const leadIdParam = params.get("leadId");
    if (leadIdParam && effectiveTenantId) {
      deepLinkHandled.current = true;
      fetch(`${API_BASE}/leads/${leadIdParam}`, { credentials: "include" })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) setSelectedLead(data);
        })
        .catch(() => {});
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [effectiveTenantId]);

  const [podiumNotif, setPodiumNotif] = useState<{ id?: number; leadId?: number; body?: string; channelType?: string; senderName?: string; leadName?: string } | null>(null);
  const podiumNotifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [spiffEvent, setSpiffEvent] = useState<{ id: number; amount: number } | null>(null);
  const spiffIdRef = useRef(0);
  const [callbackNotification, setCallbackNotification] = useState<LeadData | null>(null);
  const notifiedCallbackKeysRef = useRef<Set<string>>(new Set());
  const callbackNotifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSpiffEarned = useCallback((amount: number) => {
    spiffIdRef.current += 1;
    setSpiffEvent({ id: spiffIdRef.current, amount });
  }, []);

  useEffect(() => {
    if (newLeadSignal > 0) {
      refetch();
      refetchStats();
    }
  }, [newLeadSignal, refetch, refetchStats]);

  useEffect(() => {
    if (latestPodiumNotification) {
      setPodiumNotif(latestPodiumNotification);
      if (podiumNotifTimerRef.current) clearTimeout(podiumNotifTimerRef.current);
      podiumNotifTimerRef.current = setTimeout(() => {
        setPodiumNotif(null);
        clearPodiumNotification();
      }, 15000);
    }
  }, [latestPodiumNotification, clearPodiumNotification]);

  useEffect(() => {
    if (leadUpdatedSignal > 0) { refetch(); refetchStats(); }
  }, [leadUpdatedSignal, refetch, refetchStats]);

  useEffect(() => {
    if (callbackNotification) return;
    const dueCallbacks = queueData.callbacks.filter(l => {
      if (!l.callbackAt) return false;
      const key = `${effectiveTenantId}:${l.id}:${l.callbackAt}`;
      if (notifiedCallbackKeysRef.current.has(key)) return false;
      return new Date(l.callbackAt).getTime() <= Date.now();
    });
    if (dueCallbacks.length > 0) {
      const lead = dueCallbacks[0];
      notifiedCallbackKeysRef.current.add(`${effectiveTenantId}:${lead.id}:${lead.callbackAt}`);
      setCallbackNotification(lead);
      const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unknown";
      playCallbackSound(name);
      if (callbackNotifTimerRef.current) clearTimeout(callbackNotifTimerRef.current);
      callbackNotifTimerRef.current = setTimeout(() => {
        setCallbackNotification(null);
      }, 30000);
    }
  }, [queueData.callbacks, callbackNotification, playCallbackSound]);

  useEffect(() => {
    if (!latestCallbackDue) return;
    const allLeads = [...queueData.newLeads, ...queueData.callbacks, ...queueData.reengagement, ...queueData.oldLeads];
    const existingLead = allLeads.find((l: LeadData) => l.id === latestCallbackDue.leadId);
    const cbLead: LeadData = existingLead || {
      id: latestCallbackDue.leadId,
      firstName: latestCallbackDue.leadName.split(" ")[0] || "",
      lastName: latestCallbackDue.leadName.split(" ").slice(1).join(" ") || "",
      phone: latestCallbackDue.phone || "",
      callbackAt: latestCallbackDue.callbackAt || null,
    } as LeadData;
    const key = `${effectiveTenantId}:${cbLead.id}:${cbLead.callbackAt}`;
    if (!notifiedCallbackKeysRef.current.has(key)) {
      notifiedCallbackKeysRef.current.add(key);
      setCallbackNotification(cbLead);
      if (callbackNotifTimerRef.current) clearTimeout(callbackNotifTimerRef.current);
      callbackNotifTimerRef.current = setTimeout(() => {
        setCallbackNotification(null);
      }, 30000);
    }
    clearCallbackDue();
    refetch();
  }, [latestCallbackDue, clearCallbackDue, queueData, effectiveTenantId, refetch]);

  const dismissCallbackNotification = useCallback(() => {
    if (callbackNotifTimerRef.current) clearTimeout(callbackNotifTimerRef.current);
    setCallbackNotification(null);
  }, []);

  const handleCallbackNotificationClick = useCallback(() => {
    if (!callbackNotification) return;
    setActiveTab("callbacks");
    setSelectedLead(callbackNotification);
    dismissCallbackNotification();
  }, [callbackNotification, dismissCallbackNotification]);

  const selectedLeadIdRef = useRef<number | null>(null);
  useEffect(() => { selectedLeadIdRef.current = selectedLead?.id ?? null; }, [selectedLead]);
  useEffect(() => {
    if (!selectedLeadIdRef.current) return;
    const allLeads = [...queueData.newLeads, ...queueData.callbacks, ...queueData.reengagement, ...queueData.oldLeads];
    const updated = allLeads.find((l: LeadData) => l.id === selectedLeadIdRef.current);
    if (updated) setSelectedLead(updated);
  }, [queueData]);

  useEffect(() => {
    return () => {
      if (podiumNotifTimerRef.current) clearTimeout(podiumNotifTimerRef.current);
      if (callbackNotifTimerRef.current) clearTimeout(callbackNotifTimerRef.current);
    };
  }, []);

  const handleNewLeadClick = useCallback((lead: LeadData) => {
    setActiveTab("new");
    setSelectedLead(lead);
    if (lead.id != null) dismissNewLead(lead.id);
  }, [dismissNewLead]);

  const dismissPodiumNotif = useCallback(() => {
    if (podiumNotifTimerRef.current) clearTimeout(podiumNotifTimerRef.current);
    setPodiumNotif(null);
    clearPodiumNotification();
  }, [clearPodiumNotification]);

  const handlePodiumNotifClick = useCallback(async () => {
    if (!podiumNotif?.leadId) { dismissPodiumNotif(); return; }
    const allLeads = [...queueData.newLeads, ...queueData.callbacks, ...queueData.reengagement, ...queueData.oldLeads];
    const lead = allLeads.find((l: LeadData) => l.id === podiumNotif.leadId);
    if (lead) {
      setSelectedLead(lead);
    } else {
      try {
        const res = await fetch(`${API_BASE}/leads/${podiumNotif.leadId}?tenantId=${effectiveTenantId}`, { credentials: "include" });
        if (res.ok) {
          const fetchedLead = await res.json();
          if (fetchedLead?.id) setSelectedLead(fetchedLead as LeadData);
        }
      } catch {}
    }
    dismissPodiumNotif();
  }, [podiumNotif, queueData, dismissPodiumNotif, effectiveTenantId]);

  const tabCounts: Record<QueueTab, number> = {
    new: queueData.newLeads.length,
    callbacks: queueData.callbacks.length,
    reengagement: queueData.reengagement.length,
    old: queueData.oldLeads.length,
    recently_booked: (queueData.recentlyBooked ?? []).length,
    archive: 0,
  };

  const getTabLeads = (): LeadData[] => {
    switch (activeTab) {
      case "new": return queueData.newLeads;
      case "callbacks": return queueData.callbacks;
      case "reengagement": return queueData.reengagement;
      case "old": return queueData.oldLeads;
      case "recently_booked": return queueData.recentlyBooked ?? [];
      default: return [];
    }
  };

  const tabLeads = getTabLeads();

  return (
    <div className="relative min-h-screen">
      <AnimatePresence>
        {spiffEvent && (
          <CommissionTicker
            key={`spiff-${spiffEvent.id}`}
            amount={spiffEvent.amount}
            onDone={() => setSpiffEvent(null)}
          />
        )}
      </AnimatePresence>
      <div className="fixed top-6 right-6 z-50 w-80 flex flex-col gap-3 pointer-events-none">
        <AnimatePresence>
          {pendingNewLeads.map((lead) => {
            const leadData = lead as unknown as LeadData;
            return (
              <motion.div
                key={`notif-${lead.id}`}
                layout
                initial={{ x: 400, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 400, opacity: 0 }}
                transition={{ type: "spring", damping: 20, stiffness: 300 }}
                className="pointer-events-auto"
              >
                <div
                  onClick={() => handleNewLeadClick(leadData)}
                  className="relative overflow-hidden rounded-xl border border-red-500/40 bg-gradient-to-br from-red-950/90 via-card/95 to-card/95 shadow-[0_0_40px_rgba(242,5,5,0.25)] backdrop-blur-xl cursor-pointer hover:border-red-500/60 transition-colors"
                >
                  <div className="relative p-4">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="relative flex h-5 w-5">
                          <motion.span className="absolute inline-flex h-full w-full rounded-full bg-red-500" animate={{ scale: [1, 1.8, 1], opacity: [0.75, 0, 0.75] }} transition={{ duration: 1.2, repeat: Infinity }} />
                          <span className="relative inline-flex rounded-full h-5 w-5 bg-red-500 items-center justify-center">
                            <Zap className="w-3 h-3 text-white" />
                          </span>
                        </span>
                        <span className="text-sm font-display font-bold text-red-400">New Lead!</span>
                      </div>
                      <button onClick={e => { e.stopPropagation(); if (lead.id != null) dismissNewLead(lead.id); }} className="text-white/40 hover:text-white/80 p-0.5 rounded hover:bg-white/10">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <p className="text-white font-display text-base">{leadData.firstName} {leadData.lastName}</p>
                    <div className="flex items-center gap-2 text-xs text-gray-400 mt-1">
                      <SourceTag source={leadData.source} />
                      {leadData.phone && <span className="font-mono text-[11px] text-white/40">{formatPhone(leadData.phone)}</span>}
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {callbackNotification && (
          <motion.div
            key={`cb-notif-${callbackNotification.id}`}
            initial={{ x: 400, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 400, opacity: 0 }}
            transition={{ type: "spring", damping: 20, stiffness: 300 }}
            style={{ top: pendingNewLeads.length > 0 ? 24 + pendingNewLeads.length * 124 : 24 }}
            className="fixed right-6 z-50 w-80"
          >
            <div
              onClick={handleCallbackNotificationClick}
              className="relative overflow-hidden rounded-xl border border-amber-500/40 bg-gradient-to-br from-amber-950/90 via-card/95 to-card/95 shadow-[0_0_40px_rgba(245,158,11,0.25)] backdrop-blur-xl cursor-pointer hover:border-amber-500/60 transition-colors"
            >
              <div className="relative p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-5 w-5">
                      <motion.span className="absolute inline-flex h-full w-full rounded-full bg-amber-500" animate={{ scale: [1, 1.8, 1], opacity: [0.75, 0, 0.75] }} transition={{ duration: 1.2, repeat: Infinity }} />
                      <span className="relative inline-flex rounded-full h-5 w-5 bg-amber-500 items-center justify-center">
                        <Phone className="w-3 h-3 text-white" />
                      </span>
                    </span>
                    <span className="text-sm font-display font-bold text-amber-400">Callback Due!</span>
                  </div>
                  <button onClick={e => { e.stopPropagation(); dismissCallbackNotification(); }} className="text-white/40 hover:text-white/80 p-0.5 rounded hover:bg-white/10">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-white font-display text-base">{callbackNotification.firstName} {callbackNotification.lastName}</p>
                <div className="flex items-center gap-2 text-xs text-gray-400 mt-1">
                  {callbackNotification.callbackAt && (
                    <span className="text-amber-400/70 text-[11px]">
                      <Calendar className="w-3 h-3 inline mr-1" />
                      {formatDateTimeInTz(callbackNotification.callbackAt, queueData.timezone || "America/New_York")}
                    </span>
                  )}
                  {callbackNotification.phone && <span className="font-mono text-[11px] text-white/40">{formatPhone(callbackNotification.phone)}</span>}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {podiumNotif && (
          <motion.div
            key={`podium-notif-${podiumNotif.id}`}
            initial={{ x: 400, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 400, opacity: 0 }}
            transition={{ type: "spring", damping: 20, stiffness: 300 }}
            style={{ top: 24 + pendingNewLeads.length * 124 + (callbackNotification ? 124 : 0) }}
            className="fixed right-6 z-50 w-80"
          >
            <div
              onClick={handlePodiumNotifClick}
              className="relative overflow-hidden rounded-xl border border-blue-500/40 bg-gradient-to-br from-blue-950/90 via-card/95 to-card/95 shadow-[0_0_40px_rgba(59,130,246,0.25)] backdrop-blur-xl cursor-pointer hover:border-blue-500/60 transition-colors"
            >
              <div className="relative p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-5 w-5">
                      <motion.span className="absolute inline-flex h-full w-full rounded-full bg-blue-500" animate={{ scale: [1, 1.8, 1], opacity: [0.75, 0, 0.75] }} transition={{ duration: 1.2, repeat: Infinity }} />
                      <span className="relative inline-flex rounded-full h-5 w-5 bg-blue-500 items-center justify-center">
                        {podiumNotif.channelType === "call" || podiumNotif.channelType === "phone_call" || podiumNotif.channelType === "car_wars"
                          ? <Phone className="w-3 h-3 text-white" />
                          : <MessageSquare className="w-3 h-3 text-white" />}
                      </span>
                    </span>
                    <span className="text-sm font-display font-bold text-blue-400">
                      {podiumNotif.channelType === "call" || podiumNotif.channelType === "phone_call" || podiumNotif.channelType === "car_wars"
                        ? "Incoming Call"
                        : "Inbound Text"}
                    </span>
                    <span className="text-[9px] text-white/20 px-1.5 py-0.5 rounded bg-white/5">Podium</span>
                  </div>
                  <button onClick={e => { e.stopPropagation(); dismissPodiumNotif(); }} className="text-white/40 hover:text-white/80 p-0.5 rounded hover:bg-white/10">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-white font-display text-base">{podiumNotif.leadName || podiumNotif.senderName || "Unknown Contact"}</p>
                {podiumNotif.body && (
                  <p className="text-xs text-white/50 mt-1 line-clamp-2">{podiumNotif.body}</p>
                )}
                <motion.div className="absolute bottom-0 left-0 h-0.5 bg-blue-500/60" initial={{ width: "100%" }} animate={{ width: "0%" }} transition={{ duration: 15, ease: "linear" }} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-1 flex items-center gap-3">
            <Zap className="w-7 h-7 text-primary" />
            Leads Hub
          </GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-[0.2em] uppercase">
            CSR Outreach Command Center
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isClientUser && (
            <button
              onClick={toggleMyPause}
              disabled={pauseToggling || (myPauseState.isPaused && myPauseState.pauseSource === "manager")}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg border font-semibold text-sm transition-all duration-200",
                myPauseState.isPaused
                  ? "bg-amber-500/15 border-amber-500/30 text-amber-400 hover:bg-amber-500/25"
                  : "bg-emerald-500/15 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25",
                (pauseToggling || (myPauseState.isPaused && myPauseState.pauseSource === "manager")) && "opacity-50 cursor-not-allowed"
              )}
              title={myPauseState.isPaused ? (myPauseState.pauseSource === "manager" ? "Paused by manager" : "Click to resume leads") : "Click to pause leads"}
            >
              {myPauseState.isPaused ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              {myPauseState.isPaused ? "PAUSED" : "ACTIVE"}
            </button>
          )}
          <button
            onClick={() => { refetch(); refetchStats(); }}
            className="p-2 rounded-lg border border-white/10 text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={cn(
              "p-2 rounded-lg border transition-colors",
              soundEnabled ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-white/5 border-white/10 text-white/40"
            )}
            title={soundEnabled ? "Sound ON" : "Sound OFF"}
          >
            <Volume2 className="w-4 h-4" />
          </button>
        </div>
      </header>

      {isAgency && tenants.length > 0 && (
        <PremiumCard className="p-4 mb-6">
          <div className="flex items-center gap-3">
            <label className="text-xs text-white/40 uppercase tracking-wider">Tenant</label>
            <Select value={String(localTenantId ?? "")} onValueChange={v => { const n = parseInt(v); if (!isNaN(n)) setSelectedTenantId(n); }}>
              <SelectTrigger className="w-auto bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tenants.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </PremiumCard>
      )}

      {isAdmin && !isClientUser && csrList.length > 0 && (
        <PremiumCard className="p-4 mb-6">
          <div className="flex items-center gap-3">
            <Users className="w-4 h-4 text-white/40" />
            <label className="text-xs text-white/40 uppercase tracking-wider">CSR View</label>
            <Select value={selectedCsrId ? String(selectedCsrId) : "__all__"} onValueChange={v => { setSelectedCsrId(v === "__all__" ? null : parseInt(v)); }}>
              <SelectTrigger className="w-auto bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All CSRs</SelectItem>
                {csrList.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {selectedCsrId && (
              <span className="text-xs text-primary/70 italic">
                Viewing as {csrList.find(c => c.id === selectedCsrId)?.name}
              </span>
            )}
          </div>
        </PremiumCard>
      )}

      <div className="mb-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
            <input
              type="text"
              value={searchFilters.q}
              onChange={e => updateSearchFilters({ q: e.target.value })}
              placeholder="Search leads by name, phone, email..."
              className="w-full bg-card/60 border border-white/10 rounded-xl pl-10 pr-10 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/30 transition-all"
            />
            {(searchFilters.q || searchActive) && (
              <button onClick={clearSearch} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowSearchFilters(!showSearchFilters)}
            className={cn(
              "p-2.5 rounded-xl border transition-all shrink-0",
              showSearchFilters || searchFilters.funnelId || searchFilters.startDate || searchFilters.endDate
                ? "bg-primary/10 border-primary/30 text-primary"
                : "bg-card/60 border-white/10 text-white/30 hover:text-white/60"
            )}
            title="Filters"
          >
            <Filter className="w-4 h-4" />
          </button>
        </div>

        <AnimatePresence>
          {showSearchFilters && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap items-end gap-3 mt-3 p-3 rounded-xl bg-card/40 border border-white/5">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-white/40 uppercase tracking-wider">Funnel</label>
                  <Select
                    value={searchFilters.funnelId ? String(searchFilters.funnelId) : "__all__"}
                    onValueChange={v => updateSearchFilters({ funnelId: v === "__all__" ? null : parseInt(v) })}
                  >
                    <SelectTrigger className="w-[160px] bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white">
                      <SelectValue placeholder="All Funnels" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All Funnels</SelectItem>
                      {Object.entries(funnelMap).map(([id, name]) => (
                        <SelectItem key={id} value={id}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-white/40 uppercase tracking-wider">Date Type</label>
                  <Select value={searchFilters.dateType} onValueChange={v => updateSearchFilters({ dateType: v as DateTypeFilter })}>
                    <SelectTrigger className="w-[160px] bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="created">Date Entered</SelectItem>
                      <SelectItem value="lastTouchpoint">Last Touchpoint</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-white/40 uppercase tracking-wider">From</label>
                  <input
                    type="date"
                    value={searchFilters.startDate}
                    onChange={e => updateSearchFilters({ startDate: e.target.value })}
                    className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white [color-scheme:dark]"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-white/40 uppercase tracking-wider">To</label>
                  <input
                    type="date"
                    value={searchFilters.endDate}
                    onChange={e => updateSearchFilters({ endDate: e.target.value })}
                    className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white [color-scheme:dark]"
                  />
                </div>

                {(searchFilters.funnelId || searchFilters.startDate || searchFilters.endDate) && (
                  <button
                    onClick={() => updateSearchFilters({ funnelId: null, startDate: "", endDate: "" })}
                    className="text-xs text-white/40 hover:text-white/70 transition-colors px-2 py-1.5"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex gap-6">
        <div className="flex-1 min-w-0">
          {selectedLead && effectiveTenantId ? (
            <LeadDetailView
              lead={selectedLead}
              tenantId={effectiveTenantId}
              onBack={() => setSelectedLead(null)}
              onUpdate={() => { refetch(); refetchStats(); }}
              onSpiffEarned={handleSpiffEarned}
              timezone={queueData.timezone || tenants.find(t => t.id === effectiveTenantId)?.timezone || "America/New_York"}
              funnelMap={funnelMap}
              canEditActions={!!user && ["super_admin", "agency_user", "client_admin", "client_user"].includes(user.role || "")}
              currentUserId={user?.id}
              isAdminRole={isAdmin}
              userRole={user?.role}
              onOpenLeadById={async (id) => {
                try {
                  const r = await fetch(`${API_BASE}/leads/${id}?tenantId=${effectiveTenantId}`, { credentials: "include" });
                  if (r.ok) setSelectedLead(await r.json() as LeadData);
                } catch {}
              }}
            />
          ) : (
          <>
          {!searchActive && (
          <div className="flex items-center gap-1 mb-4 overflow-x-auto pb-1">
            {QUEUE_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setSelectedLead(null); }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs uppercase tracking-wider font-medium whitespace-nowrap transition-all",
                  activeTab === tab.key
                    ? "bg-white/10 text-white border border-white/15"
                    : "text-white/40 hover:text-white/60 hover:bg-white/5"
                )}
              >
                <span className={cn(activeTab === tab.key && tab.color)}>{tab.label}</span>
                {tab.key !== "archive" && tabCounts[tab.key] > 0 && (
                  <span className={cn(
                    "px-1.5 py-0.5 rounded-full text-[9px] font-mono",
                    activeTab === tab.key ? "bg-white/15 text-white" : "bg-white/5 text-white/30"
                  )}>
                    {tabCounts[tab.key]}
                  </span>
                )}
              </button>
            ))}
          </div>
          )}

          {searchActive ? (
            searching ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
            ) : searchResults.leads.length === 0 ? (
              <PremiumCard className="py-16 text-center">
                <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mx-auto mb-4">
                  <Search className="w-6 h-6 text-white/30" />
                </div>
                <h3 className="font-display text-xl text-white mb-2">No Results</h3>
                <p className="text-muted-foreground text-sm max-w-md mx-auto">
                  No leads match your search. Try a different name, phone number, or adjust filters.
                </p>
              </PremiumCard>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-white/40">{searchResults.total} result{searchResults.total !== 1 ? "s" : ""}</span>
                  <button onClick={clearSearch} className="text-xs text-white/40 hover:text-white/70 transition-colors flex items-center gap-1">
                    <X className="w-3 h-3" /> Back to queue
                  </button>
                </div>
                <div className="space-y-2">
                  <AnimatePresence mode="popLayout">
                    {searchResults.leads.map((lead: LeadData) => (
                      <LeadCard key={lead.id} lead={lead} onClick={() => setSelectedLead(lead)} funnelMap={funnelMap} timezone={queueData.timezone || "America/New_York"} />
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )
          ) : activeTab === "archive" ? (
            effectiveTenantId ? <ArchiveView tenantId={effectiveTenantId} timezone={queueData.timezone || tenants.find(t => t.id === effectiveTenantId)?.timezone || "America/New_York"} /> : <p className="text-sm text-white/30">Select a tenant</p>
          ) : loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
          ) : tabLeads.length === 0 ? (
            <PremiumCard className="py-16 text-center">
              <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mx-auto mb-4">
                <Check className="w-6 h-6 text-emerald-400" />
              </div>
              <h3 className="font-display text-xl text-white mb-2">Queue Clear</h3>
              <p className="text-muted-foreground text-sm max-w-md mx-auto">
                {activeTab === "new" ? "No new untouched leads right now." :
                 activeTab === "callbacks" ? "No pending callbacks." :
                 activeTab === "reengagement" ? "No leads needing follow-up right now." :
                 "No old leads in queue."}
              </p>
            </PremiumCard>
          ) : (
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {tabLeads.map(lead => (
                  <LeadCard key={lead.id} lead={lead} onClick={() => setSelectedLead(lead)} funnelMap={funnelMap} timezone={queueData.timezone || "America/New_York"} showReengageBadge={activeTab === "reengagement"} />
                ))}
              </AnimatePresence>
            </div>
          )}
          </>
          )}
        </div>

        <aside className="hidden lg:flex flex-col gap-3 w-64 shrink-0 sticky top-4 self-start">
          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-white/40 uppercase tracking-wider">Queue</span>
              <span className="text-xl font-display text-white">{queueData.total}</span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-red-400">New</span>
                <span className="text-white/60 font-mono">{queueData.newLeads.length}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-purple-400">Re-engage</span>
                <span className="text-white/60 font-mono">{queueData.reengagement.length}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-amber-400">Callbacks</span>
                <span className="text-white/60 font-mono">{queueData.callbacks.length}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-white/50">Old</span>
                <span className="text-white/60 font-mono">{queueData.oldLeads.length}</span>
              </div>
            </div>
          </PremiumCard>

          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
            {(["today", "7d", "30d", "90d"] as HudTimeframe[]).map(tf => (
              <button
                key={tf}
                onClick={() => handleTimeframeChange(tf)}
                className={`flex-1 text-[11px] font-medium py-1 rounded-md transition-all ${hudTimeframe === tf ? "bg-white/10 text-white shadow-sm" : "text-white/40 hover:text-white/60"}`}
              >
                {tf === "today" ? "Today" : tf.toUpperCase()}
              </button>
            ))}
          </div>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <PhoneCall className="w-5 h-5 text-blue-400" />
              <span className="text-xs text-blue-400/60 uppercase tracking-wider">Touchpoints</span>
            </div>
            <p className="text-3xl font-display text-white">{stats.callsMadeToday}</p>
            <p className="text-xs text-muted-foreground mt-1">touchpoints made {tfLabel}</p>
          </PremiumCard>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <span className="text-xs text-emerald-400/60 uppercase tracking-wider">Booked</span>
            </div>
            <p className="text-3xl font-display text-white">{stats.bookingsToday}</p>
            <div className="mt-2 w-full bg-white/5 rounded-full h-1.5">
              <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${Math.min(stats.bookingRate, 100)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground mt-1">{stats.bookingRate}% booking rate {tfLabel}</p>
          </PremiumCard>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <Clock className="w-5 h-5 text-amber-400" />
              <span className="text-xs text-amber-400/60 uppercase tracking-wider">Speed</span>
            </div>
            <p className="text-3xl font-display text-white">{formatSpeed(stats.avgSpeedToLead)}</p>
            <p className="text-xs text-muted-foreground mt-1">avg speed-to-lead {tfLabel}</p>
          </PremiumCard>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <DollarSign className="w-5 h-5 text-emerald-400" />
              <span className="text-xs text-emerald-400/60 uppercase tracking-wider">Earned</span>
            </div>
            <p className="text-3xl font-display text-emerald-400">${stats.commission}</p>
            <p className="text-xs text-muted-foreground mt-1">{stats.bookingsToday} booking{stats.bookingsToday !== 1 ? "s" : ""} {tfLabel}</p>
          </PremiumCard>
        </aside>
      </div>

      <div className="lg:hidden mt-6 space-y-3">
        <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
          {(["today", "7d", "30d", "90d"] as HudTimeframe[]).map(tf => (
            <button
              key={tf}
              onClick={() => handleTimeframeChange(tf)}
              className={`flex-1 text-[11px] font-medium py-1 rounded-md transition-all ${hudTimeframe === tf ? "bg-white/10 text-white shadow-sm" : "text-white/40 hover:text-white/60"}`}
            >
              {tf === "today" ? "Today" : tf.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <PremiumCard className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <PhoneCall className="w-4 h-4 text-blue-400" />
              <span className="text-xs text-blue-400/60 uppercase">Touchpoints</span>
            </div>
            <p className="text-xl font-display text-white">{stats.callsMadeToday}</p>
          </PremiumCard>
          <PremiumCard className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span className="text-xs text-emerald-400/60 uppercase">Booked</span>
            </div>
            <p className="text-xl font-display text-white">{stats.bookingsToday} <span className="text-sm text-white/40">({stats.bookingRate}%)</span></p>
          </PremiumCard>
          <PremiumCard className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-4 h-4 text-amber-400" />
              <span className="text-xs text-amber-400/60 uppercase">Speed</span>
            </div>
            <p className="text-xl font-display text-white">{formatSpeed(stats.avgSpeedToLead)}</p>
          </PremiumCard>
          <PremiumCard className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-4 h-4 text-emerald-400" />
              <span className="text-xs text-emerald-400/60 uppercase">Earned</span>
            </div>
            <p className="text-xl font-display text-emerald-400">${stats.commission}</p>
          </PremiumCard>
        </div>
      </div>
    </div>
  );
}
