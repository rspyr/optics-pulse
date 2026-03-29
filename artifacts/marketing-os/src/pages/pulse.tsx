import { useState, useEffect, useRef, useCallback } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { motion, AnimatePresence } from "framer-motion";
import { io as socketIOClient } from "socket.io-client";
import {
  Phone, MessageSquare, Mic,
  Clock, Zap, X, Copy,
  ChevronDown, ChevronRight,
  Calendar, PhoneCall, Check,
  Volume2, DollarSign, Loader2, CheckCircle2, XCircle,
  History, UserPlus, Archive, RefreshCw,
  Filter, PhoneOff, Ban, Globe, AlertCircle, FileText
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

type QueueTab = "new" | "today" | "callbacks" | "reengagement" | "old" | "archive";

const QUEUE_TABS: { key: QueueTab; label: string; color: string }[] = [
  { key: "new", label: "New", color: "text-red-400" },
  { key: "today", label: "Today", color: "text-blue-400" },
  { key: "callbacks", label: "Callbacks", color: "text-amber-400" },
  { key: "reengagement", label: "Re-engage", color: "text-purple-400" },
  { key: "old", label: "Old Leads", color: "text-white/60" },
  { key: "archive", label: "Archive", color: "text-white/40" },
];

const DAY_BADGE_COLORS: Record<string, string> = {
  day_1: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  day_2: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  day_3: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  day_4: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  day_5_old: "bg-red-500/20 text-red-400 border-red-500/30",
  appt_set: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  call_back: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  dead: "bg-red-500/20 text-red-300 border-red-500/30",
};

const DAY_BADGE_LABELS: Record<string, string> = {
  day_1: "D1", day_2: "D2", day_3: "D3", day_4: "D4",
  day_5_old: "OLD", appt_set: "APPT", call_back: "CB", dead: "DEAD",
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
];

const TEXT_RESULTS = [
  { value: "yes", label: "Yes — Interested" },
  { value: "not_able_to", label: "Not Able To" },
  { value: "dead", label: "Dead Lead" },
  { value: "no_need", label: "No Need to Log" },
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
  deadReason?: string | null;
  disposition?: string | null;
  createdAt: string;
  updatedAt: string;
  tenantId?: number;
  funnelId?: number | null;
}

interface HistoryEntry {
  id: number;
  userId: number;
  actionType: string;
  callResult?: string | null;
  vmResult?: string | null;
  textResult?: string | null;
  deadReason?: string | null;
  notes?: string | null;
  attemptedAt: string;
  csrName: string;
  method: string;
  outcome: string;
}

interface CsrOption {
  id: number;
  name: string;
  email: string;
  role: string;
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
      const url = tenantId ? `${API_BASE}/leads/hud/stats?tenantId=${tenantId}` : `${API_BASE}/leads/hud/stats`;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) setStats(await res.json());
    } catch {}
  }, [tenantId, shouldFetch]);
  useEffect(() => {
    if (!shouldFetch) return;
    fetchStats();
    const i = setInterval(fetchStats, 10000);
    return () => clearInterval(i);
  }, [fetchStats, shouldFetch]);
  return { stats, refetch: fetchStats };
}

function useLeadsHubQueue(tenantId?: number | null, isAgency?: boolean) {
  const [data, setData] = useState<{
    newLeads: LeadData[]; today: LeadData[]; callbacks: LeadData[];
    reengagement: LeadData[]; oldLeads: LeadData[]; total: number;
    timezone?: string;
  }>({ newLeads: [], today: [], callbacks: [], reengagement: [], oldLeads: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const shouldFetch = !isAgency || tenantId !== null;

  const fetchQueue = useCallback(async () => {
    if (!shouldFetch) return;
    try {
      const url = tenantId ? `${API_BASE}/leads-hub/queue?tenantId=${tenantId}` : `${API_BASE}/leads-hub/queue`;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) setData(await res.json());
    } catch {} finally { setLoading(false); }
  }, [tenantId, shouldFetch]);

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

function useSocketIO(tenantId: number | null, isAgency: boolean) {
  const [latestLead, setLatestLead] = useState<LeadData | null>(null);
  const [leadUpdatedSignal, setLeadUpdatedSignal] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const tenantIdRef = useRef(tenantId);

  useEffect(() => { tenantIdRef.current = tenantId; }, [tenantId]);
  useEffect(() => {
    const audio = new Audio("data:audio/wav;base64,UklGRl9vT19teleVlfT0+AU5EIBAAAABkAAAAFAAMAeAAAAAA=");
    audio.volume = 0.3;
    audioRef.current = audio;
  }, []);

  useEffect(() => {
    const socket = socketIOClient({ path: "/api/socket.io", withCredentials: true, transports: ["websocket", "polling"] });
    socket.on("connect", () => console.log("[Pulse] Socket.IO connected:", socket.id));
    socket.on("new-lead", (lead: LeadData) => {
      if (tenantIdRef.current && lead.tenantId && lead.tenantId !== tenantIdRef.current) return;
      setLatestLead(lead);
      if (soundEnabled && audioRef.current) audioRef.current.play().catch(() => {});
    });
    socket.on("lead-updated", () => setLeadUpdatedSignal(prev => prev + 1));
    socket.on("disconnect", () => console.log("[Pulse] Socket.IO disconnected"));
    return () => { socket.disconnect(); };
  }, [tenantId, isAgency, soundEnabled]);

  return { latestLead, clearLatestLead: useCallback(() => setLatestLead(null), []), leadUpdatedSignal, soundEnabled, setSoundEnabled };
}

function timeSince(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
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

function SourceTag({ source }: { source: string }) {
  const color = source.includes("Google") ? "bg-blue-500/15 text-blue-400 border-blue-500/20"
    : source.includes("Meta") || source.includes("Facebook") || source.includes("Instagram") ? "bg-indigo-500/15 text-indigo-400 border-indigo-500/20"
    : source.includes("Direct Mail") ? "bg-amber-500/15 text-amber-400 border-amber-500/20"
    : source.includes("YouTube") || source.includes("TikTok") ? "bg-pink-500/15 text-pink-400 border-pink-500/20"
    : "bg-white/5 text-white/50 border-white/10";
  return <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-medium border", color)}>{source}</span>;
}

function LeadCard({ lead, onClick, funnelMap }: { lead: LeadData; onClick: () => void; funnelMap: Record<number, string> }) {
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
            <FunnelBadge funnelId={lead.funnelId} funnelMap={funnelMap} />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <SourceTag source={lead.source} />
            {lead.serviceType && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-white/5 text-white/50 border border-white/10">{lead.serviceType}</span>
            )}
            {lead.phone && <span className="text-[11px] text-white/40 font-mono">{lead.phone}</span>}
          </div>
          <ContactFlags preferences={lead.contactPreferences} />
          {lead.disposition && (
            <span className="text-[10px] text-white/30 mt-1">
              Last: <span className="text-white/45">{lead.disposition.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}</span>
            </span>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[10px] text-white/30 font-mono">{timeSince(lead.updatedAt)}</span>
          {lead.assignedTo && (
            <span className="text-[9px] text-white/25 truncate max-w-[80px]">{lead.assignedTo}</span>
          )}
          <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/50 transition-colors" />
        </div>
      </div>
    </motion.div>
  );
}

function ActionHistoryTimeline({ leadId, tenantId, timezone }: { leadId: number; tenantId: number; timezone: string }) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/leads-hub/${leadId}/history?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setHistory(d.history || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [leadId, tenantId]);

  if (loading) return <div className="py-4 text-center"><Loader2 className="w-4 h-4 text-white/30 animate-spin mx-auto" /></div>;
  if (history.length === 0) return <p className="text-xs text-white/20 py-3 text-center">No actions logged yet</p>;

  const displayed = expanded ? history : history.slice(0, 3);

  const getIcon = (entry: HistoryEntry) => {
    if (entry.actionType === "call" || entry.method === "call") return <Phone className="w-3 h-3" />;
    if (entry.actionType === "text" || entry.method === "text") return <MessageSquare className="w-3 h-3" />;
    if (entry.actionType === "voicemail_drop" || entry.method === "voicemail") return <Mic className="w-3 h-3" />;
    if (entry.method === "transfer") return <UserPlus className="w-3 h-3" />;
    return <Clock className="w-3 h-3" />;
  };

  const getOutcomeLabel = (entry: HistoryEntry) => {
    const result = entry.callResult || entry.textResult || entry.vmResult || entry.outcome;
    return (result || "").replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
  };

  return (
    <div className="space-y-0">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/60 mb-2 transition-colors">
        <History className="w-3 h-3" />
        Action History ({history.length})
        <ChevronDown className={cn("w-3 h-3 transition-transform", expanded && "rotate-180")} />
      </button>
      <div className="relative pl-4 border-l border-white/5 space-y-2">
        {displayed.map(entry => (
          <div key={entry.id} className="relative">
            <div className="absolute -left-[21px] top-1.5 w-3 h-3 rounded-full bg-card border border-white/10 flex items-center justify-center text-white/40">
              {getIcon(entry)}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-white/30 font-mono shrink-0">
                {formatDateTimeInTz(entry.attemptedAt, timezone)}
              </span>
              <span className="text-[10px] text-white/50">{entry.csrName}</span>
              <span className="text-[10px] text-white/60 font-medium">{getOutcomeLabel(entry)}</span>
            </div>
            {entry.notes && <p className="text-[10px] text-white/25 mt-0.5 italic">{entry.notes}</p>}
          </div>
        ))}
      </div>
      {history.length > 3 && !expanded && (
        <button onClick={() => setExpanded(true)} className="text-[10px] text-primary/60 hover:text-primary ml-4 mt-1">
          Show {history.length - 3} more...
        </button>
      )}
    </div>
  );
}

function LeadDetailView({ lead, tenantId, onBack, onUpdate, timezone = "America/New_York" }: {
  lead: LeadData; tenantId: number; onBack: () => void; onUpdate: () => void; timezone?: string;
}) {
  const [actionStep, setActionStep] = useState<null | "call_done" | "call_result" | "spoke_result" | "dead_reason" | "text_done" | "text_result" | "vm_done">(null);
  const [selectedCallResult, setSelectedCallResult] = useState<string | null>(null);
  const [deadFromFlow, setDeadFromFlow] = useState<"call" | "text">("call");
  const [actionLoading, setActionLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  const [csrs, setCsrs] = useState<CsrOption[]>([]);
  const [selectedCsr, setSelectedCsr] = useState<number | null>(null);
  const [showScripts, setShowScripts] = useState(false);
  const [showCallScripts, setShowCallScripts] = useState(false);
  const [showVmScripts, setShowVmScripts] = useState(false);
  const [callbackDate, setCallbackDate] = useState("");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

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
    if (lead.phone) window.open(`tel:${lead.phone.replace(/[^0-9+]/g, "")}`, "_self");
    setActionStep("call_done");
  };

  const handleText = () => {
    setActionStep("text_done");
  };

  const handleVmDrop = () => {
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
        <ChevronDown className="w-3 h-3 rotate-90" /> Back to queue
      </button>

      <PremiumCard className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h2 className="font-display text-xl text-white">{lead.firstName} {lead.lastName}</h2>
              <DayBadge hubStatus={lead.hubStatus} />
              <span className="text-xs text-white/30 font-mono">Day {lead.dayInSequence}</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <SourceTag source={lead.source} />
              {lead.serviceType && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-white/5 text-white/50 border border-white/10">{lead.serviceType}</span>
              )}
              {lead.phone && (
                blocksCall
                  ? <span className="text-sm text-white/40 font-mono">{lead.phone}</span>
                  : <a href={`tel:${lead.phone}`} className="text-sm text-blue-400 hover:text-blue-300 font-mono">{lead.phone}</a>
              )}
              {lead.email && (
                <a href={`mailto:${lead.email}`} className="text-sm text-purple-400 hover:text-purple-300">{lead.email}</a>
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
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowTransfer(!showTransfer)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-white/30 hover:text-white/50 hover:bg-white/5 transition-colors"
            >
              <UserPlus className="w-3 h-3" /> Transfer
            </button>
          </div>
        </div>

        {showTransfer && (
          <div className="mt-3 p-3 rounded-lg bg-white/5 border border-white/10 space-y-2">
            <p className="text-xs text-white/40">Transfer to another CSR:</p>
            <div className="flex items-center gap-2">
              <select
                value={selectedCsr || ""}
                onChange={e => setSelectedCsr(Number(e.target.value))}
                className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
              >
                <option value="">Select CSR...</option>
                {csrs.filter(c => c.id !== lead.assignedCsrId).map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
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

      {blocksCall && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-xs text-red-400">This lead has a "Text Only" or "Do Not Call" flag. Calling is blocked.</p>
        </div>
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
                        setActionStep("spoke_result");
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
                    onClick={() => logAction(
                      deadFromFlow === "call"
                        ? { actionType: "call", callResult: selectedCallResult, deadReason: r.value }
                        : { actionType: "text", textResult: "dead", deadReason: r.value }
                    )}
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

              {lead.phone && (
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

              <button
                onClick={confirmVmDrop}
                disabled={actionLoading}
                className="w-full px-3 py-2 rounded-lg bg-orange-500/20 text-orange-400 text-sm font-medium hover:bg-orange-500/30 disabled:opacity-50 transition-colors mb-2"
              >
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Log VM Drop"}
              </button>
              <button onClick={() => setActionStep(null)} className="mt-1 text-[10px] text-white/30 hover:text-white/50">Cancel</button>
            </PremiumCard>
          </motion.div>
        )}
      </AnimatePresence>

      <PremiumCard className="p-4">
        <ActionHistoryTimeline leadId={lead.id} tenantId={tenantId} timezone={timezone} />
      </PremiumCard>
    </div>
  );
}

function ArchiveView({ tenantId, timezone = "America/New_York" }: { tenantId: number; timezone?: string }) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const { data, loading } = useArchive(tenantId, filters);
  const [showFilters, setShowFilters] = useState(false);
  const [csrs, setCsrs] = useState<CsrOption[]>([]);

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
          <select
            value={filters.csrId || ""}
            onChange={e => updateFilter("csrId", e.target.value)}
            className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/70"
          >
            <option value="">All CSRs</option>
            {csrs.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
          </select>
          <select
            value={filters.status || ""}
            onChange={e => updateFilter("status", e.target.value)}
            className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/70"
          >
            <option value="">All statuses</option>
            <option value="appt_set">Appointment Set</option>
            <option value="dead">Dead</option>
          </select>
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
            <div key={lead.id} className="rounded-lg border border-white/5 p-3 bg-card/40">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white/70">{lead.firstName} {lead.lastName}</span>
                  <DayBadge hubStatus={lead.hubStatus} />
                  <SourceTag source={lead.source} />
                </div>
                <div className="flex items-center gap-2">
                  {lead.assignedTo && <span className="text-[10px] text-white/25">{lead.assignedTo}</span>}
                  <span className="text-[10px] text-white/20 font-mono">{formatInTz(lead.createdAt, timezone, { month: "short", day: "numeric" })}</span>
                </div>
              </div>
              {lead.phone && <p className="text-[11px] text-white/30 font-mono mt-1">{lead.phone}</p>}
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
  const { data: queueData, loading, refetch } = useLeadsHubQueue(effectiveTenantId, isAgency);
  const { stats, refetch: refetchStats } = useHudStats(effectiveTenantId, isAgency);
  const { latestLead, clearLatestLead, leadUpdatedSignal, soundEnabled, setSoundEnabled } = useSocketIO(effectiveTenantId, isAgency);
  const funnelMap = useFunnelTypes(effectiveTenantId);
  const [activeTab, setActiveTab] = useState<QueueTab>("new");
  const [selectedLead, setSelectedLead] = useState<LeadData | null>(null);
  const [notificationLead, setNotificationLead] = useState<LeadData | null>(null);
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (latestLead) {
      setNotificationLead(latestLead);
      if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = setTimeout(() => {
        setNotificationLead(null);
        clearLatestLead();
      }, 15000);
      refetch();
      refetchStats();
    }
  }, [latestLead, refetch, refetchStats, clearLatestLead]);

  useEffect(() => {
    if (leadUpdatedSignal > 0) { refetch(); refetchStats(); }
  }, [leadUpdatedSignal, refetch, refetchStats]);

  useEffect(() => {
    return () => { if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current); };
  }, []);

  const dismissNotification = useCallback(() => {
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
    setNotificationLead(null);
    clearLatestLead();
  }, [clearLatestLead]);

  const handleNotificationClick = useCallback(() => {
    if (!notificationLead) return;
    setActiveTab("new");
    setSelectedLead(notificationLead);
    dismissNotification();
  }, [notificationLead, dismissNotification]);

  const tabCounts: Record<QueueTab, number> = {
    new: queueData.newLeads.length,
    today: queueData.today.length,
    callbacks: queueData.callbacks.length,
    reengagement: queueData.reengagement.length,
    old: queueData.oldLeads.length,
    archive: 0,
  };

  const getTabLeads = (): LeadData[] => {
    switch (activeTab) {
      case "new": return queueData.newLeads;
      case "today": return queueData.today;
      case "callbacks": return queueData.callbacks;
      case "reengagement": return queueData.reengagement;
      case "old": return queueData.oldLeads;
      default: return [];
    }
  };

  const tabLeads = getTabLeads();

  return (
    <div className="relative min-h-screen">
      <AnimatePresence>
        {notificationLead && (
          <motion.div
            key={`notif-${notificationLead.id}`}
            initial={{ x: 400, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 400, opacity: 0 }}
            transition={{ type: "spring", damping: 20, stiffness: 300 }}
            className="fixed top-6 right-6 z-50 w-80"
          >
            <div
              onClick={handleNotificationClick}
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
                  <button onClick={e => { e.stopPropagation(); dismissNotification(); }} className="text-white/40 hover:text-white/80 p-0.5 rounded hover:bg-white/10">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-white font-display text-base">{notificationLead.firstName} {notificationLead.lastName}</p>
                <div className="flex items-center gap-2 text-xs text-gray-400 mt-1">
                  <SourceTag source={notificationLead.source} />
                  {notificationLead.phone && <span className="font-mono text-[11px] text-white/40">{notificationLead.phone}</span>}
                </div>
                <motion.div className="absolute bottom-0 left-0 h-0.5 bg-red-500/60" initial={{ width: "100%" }} animate={{ width: "0%" }} transition={{ duration: 15, ease: "linear" }} />
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
              {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </PremiumCard>
      )}

      <div className="flex gap-6">
        <div className="flex-1 min-w-0">
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

          {activeTab === "archive" ? (
            effectiveTenantId ? <ArchiveView tenantId={effectiveTenantId} timezone={queueData.timezone || tenants.find(t => t.id === effectiveTenantId)?.timezone || "America/New_York"} /> : <p className="text-sm text-white/30">Select a tenant</p>
          ) : selectedLead && effectiveTenantId ? (
            <LeadDetailView
              lead={selectedLead}
              tenantId={effectiveTenantId}
              onBack={() => setSelectedLead(null)}
              onUpdate={() => { refetch(); refetchStats(); }}
              timezone={queueData.timezone || tenants.find(t => t.id === effectiveTenantId)?.timezone || "America/New_York"}
            />
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
                 activeTab === "today" ? "No leads updated today." :
                 activeTab === "callbacks" ? "No pending callbacks." :
                 activeTab === "reengagement" ? "No re-engagement leads due." :
                 "No old leads in queue."}
              </p>
            </PremiumCard>
          ) : (
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {tabLeads.map(lead => (
                  <LeadCard key={lead.id} lead={lead} onClick={() => setSelectedLead(lead)} funnelMap={funnelMap} />
                ))}
              </AnimatePresence>
            </div>
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
                <span className="text-blue-400">Today</span>
                <span className="text-white/60 font-mono">{queueData.today.length}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-amber-400">Callbacks</span>
                <span className="text-white/60 font-mono">{queueData.callbacks.length}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-purple-400">Re-engage</span>
                <span className="text-white/60 font-mono">{queueData.reengagement.length}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-white/50">Old</span>
                <span className="text-white/60 font-mono">{queueData.oldLeads.length}</span>
              </div>
            </div>
          </PremiumCard>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <PhoneCall className="w-5 h-5 text-blue-400" />
              <span className="text-xs text-blue-400/60 uppercase tracking-wider">Calls</span>
            </div>
            <p className="text-3xl font-display text-white">{stats.callsMadeToday}</p>
            <p className="text-xs text-muted-foreground mt-1">calls made today</p>
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
            <p className="text-xs text-muted-foreground mt-1">{stats.bookingRate}% booking rate</p>
          </PremiumCard>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <Clock className="w-5 h-5 text-amber-400" />
              <span className="text-xs text-amber-400/60 uppercase tracking-wider">Speed</span>
            </div>
            <p className="text-3xl font-display text-white">{stats.avgSpeedToLead}<span className="text-lg text-white/50">s</span></p>
            <p className="text-xs text-muted-foreground mt-1">avg speed-to-lead</p>
          </PremiumCard>

          <PremiumCard className="p-4">
            <div className="flex items-center justify-between mb-3">
              <DollarSign className="w-5 h-5 text-emerald-400" />
              <span className="text-xs text-emerald-400/60 uppercase tracking-wider">Earned</span>
            </div>
            <p className="text-3xl font-display text-emerald-400">${stats.commission}</p>
            <p className="text-xs text-muted-foreground mt-1">{stats.bookingsToday} booking{stats.bookingsToday !== 1 ? "s" : ""} today</p>
          </PremiumCard>
        </aside>
      </div>

      <div className="lg:hidden grid grid-cols-2 gap-3 mt-6">
        <PremiumCard className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <PhoneCall className="w-4 h-4 text-blue-400" />
            <span className="text-xs text-blue-400/60 uppercase">Calls</span>
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
          <p className="text-xl font-display text-white">{stats.avgSpeedToLead}s</p>
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
  );
}
