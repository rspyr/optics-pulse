import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { io as socketIOClient } from "socket.io-client";
import { useAuth } from "@/components/auth-context";
import { toast, useToast } from "@/hooks/use-toast";
import { usePushNotifications } from "@/hooks/use-push-notifications";

const SW_BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const API = import.meta.env.VITE_API_URL || "";
const PUSH_BANNER_DISMISSED_KEY = "pulse_push_banner_dismissed";

export interface LeadNotificationData {
  id?: number;
  tenantId?: number;
  assignedCsrId?: number | null;
  firstName?: string;
  lastName?: string;
  source?: string;
  [key: string]: unknown;
}

const MAX_PENDING_NEW_LEADS = 16;
const LEAD_TOAST_REPEAT_MS = 2 * 60 * 1000;
const LEAD_RESUBMITTED_TOAST_TITLE = "Lead Resubmitted";

function getAssignedCsrId(lead: LeadNotificationData | undefined | null): number | null {
  if (!lead) return null;
  const fromCsr = lead.assignedCsrId;
  if (typeof fromCsr === "number") return fromCsr;
  const fromUser = (lead as { assignedUserId?: unknown }).assignedUserId;
  if (typeof fromUser === "number") return fromUser;
  return null;
}

export interface CallbackDueData {
  leadId: number;
  targetUserId: number;
  leadName: string;
  phone?: string;
  callbackAt?: string;
}

export interface PodiumNotificationData {
  id?: number;
  leadId?: number;
  tenantId?: number;
  direction?: string;
  body?: string;
  channelType?: string;
  senderName?: string;
  leadName?: string;
  eventType?: string;
}

type ReconnectCallback = () => void;

type PodiumMessageCallback = (msg: PodiumNotificationData) => void;

export interface RuleRederiveCompleteData {
  tenantId?: number;
  pageUrlPattern: string;
  formIdentifier: string;
  leadsChanged: number;
  hitLimit: boolean;
  maxLeads: number;
}

type RuleRederiveCompleteCallback = (data: RuleRederiveCompleteData) => void;

export interface RuleRederiveFailedData {
  tenantId?: number;
  pageUrlPattern: string;
  formIdentifier: string;
  reason: string;
  // Approximate count of historical leads in this rule's scope that still
  // need re-deriving (i.e. whose `updatedAt` predates the rule's
  // `createdAt`). Surfaced inline next to the failure hint so operators can
  // tell at a glance whether retrying now is cheap or expensive.
  pendingLeads?: number;
  hitLimit?: boolean;
  maxLeads?: number;
  // ISO timestamp the server attempted the fan-out / computed the pending
  // count. Used by the UI to render "last tried HH:MM" so a stale hint
  // doesn't look fresh.
  lastAttemptedAt?: string;
}

type RuleRederiveFailedCallback = (data: RuleRederiveFailedData) => void;

export interface SelectedLeadsRederiveCompleteData {
  tenantId?: number;
  jobId: number | null;
  total: number;
  succeeded: number;
  failed: number;
  changed: number;
  failedLeadIds: number[];
  // Per-lead failure reason map keyed by leadId. Server populates this on
  // partial failures so the pending-rederive-leads sheet can surface *why*
  // each specific lead failed without forcing operators into server logs.
  // Optional for backwards compatibility with older server builds emitting
  // only `failedLeadIds`.
  failedLeadErrors?: Record<number, string>;
}

type SelectedLeadsRederiveCompleteCallback = (data: SelectedLeadsRederiveCompleteData) => void;

export interface SelectedLeadsRederiveProgressData {
  tenantId?: number;
  jobId: number;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  changed: number;
  updatedAt?: string;
}

type SelectedLeadsRederiveProgressCallback = (data: SelectedLeadsRederiveProgressData) => void;

export interface SelectedLeadsRederiveFailedData {
  tenantId?: number;
  jobId: number | null;
  total: number;
  reason: string;
}

type SelectedLeadsRederiveFailedCallback = (data: SelectedLeadsRederiveFailedData) => void;

export interface SelectedLeadsRederiveCancelledData {
  tenantId?: number;
  jobId: number | null;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  changed: number;
  failedLeadIds: number[];
  // Leads that were queued but never reached before the operator cancelled.
  // Lets the pending-leads sheet offer a one-click "Re-derive the rest"
  // action without forcing the operator to re-select the same rows. Optional
  // for back-compat with older server builds that only emit the counts.
  skippedLeadIds?: number[];
}

type SelectedLeadsRederiveCancelledCallback = (data: SelectedLeadsRederiveCancelledData) => void;

interface LeadNotificationContextType {
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  pendingNewLeads: LeadNotificationData[];
  dismissNewLead: (leadId: number) => void;
  newLeadSignal: number;
  leadUpdatedSignal: number;
  onReconnect: (cb: ReconnectCallback) => () => void;
  latestPodiumNotification: PodiumNotificationData | null;
  clearPodiumNotification: () => void;
  onPodiumMessage: (cb: PodiumMessageCallback) => () => void;
  latestCallbackDue: CallbackDueData | null;
  clearCallbackDue: () => void;
  playCallbackSound: (leadName: string) => void;
  onRuleRederiveComplete: (cb: RuleRederiveCompleteCallback) => () => void;
  onRuleRederiveFailed: (cb: RuleRederiveFailedCallback) => () => void;
  onSelectedLeadsRederiveComplete: (cb: SelectedLeadsRederiveCompleteCallback) => () => void;
  onSelectedLeadsRederiveFailed: (cb: SelectedLeadsRederiveFailedCallback) => () => void;
  onSelectedLeadsRederiveProgress: (cb: SelectedLeadsRederiveProgressCallback) => () => void;
  onSelectedLeadsRederiveCancelled: (cb: SelectedLeadsRederiveCancelledCallback) => () => void;
}

const LeadNotificationContext = createContext<LeadNotificationContextType | null>(null);

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
type SoundType = "new-lead" | "text-message" | "inbound-call" | "callback";
const SOUND_URLS: Record<SoundType, string> = {
  "new-lead": `${BASE}/sounds/new-lead.mp3`,
  "text-message": `${BASE}/sounds/text-message.mp3`,
  "inbound-call": `${BASE}/sounds/inbound-call.mp3`,
  "callback": `${BASE}/sounds/callback.mp3`,
};

export function LeadNotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, effectiveTenantId, isAgency } = useAuth();
  const [soundEnabled, setSoundEnabledRaw] = useState(true);
  const [pendingNewLeads, setPendingNewLeads] = useState<LeadNotificationData[]>([]);
  const [newLeadSignal, setNewLeadSignal] = useState(0);
  const [leadUpdatedSignal, setLeadUpdatedSignal] = useState(0);
  const userIdRef = useRef<number | null>(null);
  useEffect(() => { userIdRef.current = user?.id ?? null; }, [user?.id]);
  useEffect(() => { setPendingNewLeads([]); }, [user?.id, effectiveTenantId]);
  const [latestPodiumNotification, setLatestPodiumNotification] = useState<PodiumNotificationData | null>(null);
  const [latestCallbackDue, setLatestCallbackDue] = useState<CallbackDueData | null>(null);
  const audioMapRef = useRef<Record<SoundType, HTMLAudioElement> | null>(null);
  const soundEnabledRef = useRef(soundEnabled);
  const tenantIdRef = useRef(effectiveTenantId);
  const audioUnlockedRef = useRef(false);
  const reconnectListenersRef = useRef<Set<ReconnectCallback>>(new Set());
  const podiumMessageListenersRef = useRef<Set<PodiumMessageCallback>>(new Set());
  const ruleRederiveListenersRef = useRef<Set<RuleRederiveCompleteCallback>>(new Set());
  const ruleRederiveFailedListenersRef = useRef<Set<RuleRederiveFailedCallback>>(new Set());
  const selectedLeadsRederiveListenersRef = useRef<Set<SelectedLeadsRederiveCompleteCallback>>(new Set());
  const selectedLeadsRederiveFailedListenersRef = useRef<Set<SelectedLeadsRederiveFailedCallback>>(new Set());
  const selectedLeadsRederiveProgressListenersRef = useRef<Set<SelectedLeadsRederiveProgressCallback>>(new Set());
  const selectedLeadsRederiveCancelledListenersRef = useRef<Set<SelectedLeadsRederiveCancelledCallback>>(new Set());

  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => { tenantIdRef.current = effectiveTenantId; }, [effectiveTenantId]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/api/users/me/preferences`, { credentials: "include" });
        if (!res.ok || cancelled) return;
        const prefs = await res.json();
        if (cancelled) return;
        if (typeof prefs.soundEnabled === "boolean") {
          setSoundEnabledRaw(prefs.soundEnabled);
        }
      } catch (err) {
        console.warn("[LeadNotification] Failed to load sound preference:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  const setSoundEnabled = useCallback((enabled: boolean) => {
    setSoundEnabledRaw(enabled);
    fetch(`${API}/api/users/me/preferences`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ soundEnabled: enabled }),
    }).catch((err) => {
      console.warn("[LeadNotification] Failed to save sound preference:", err);
    });
  }, []);

  useEffect(() => {
    const map = {} as Record<SoundType, HTMLAudioElement>;
    for (const [key, url] of Object.entries(SOUND_URLS)) {
      const audio = new Audio(url);
      audio.volume = 0.4;
      audio.load();
      map[key as SoundType] = audio;
    }
    audioMapRef.current = map;
    return () => {
      for (const audio of Object.values(map)) {
        audio.pause();
        audio.src = "";
      }
      audioMapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const unlock = () => {
      if (audioUnlockedRef.current) return;
      try {
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        ctx.close().catch((err) => console.warn("[Notification] AudioContext close error:", err));
      } catch (err) {
        console.warn("[Notification] WebAudio unlock failed:", err);
      }
      const firstAudio = audioMapRef.current?.["new-lead"];
      if (firstAudio) {
        firstAudio.muted = true;
        firstAudio.play().then(() => {
          firstAudio.pause();
          firstAudio.muted = false;
          firstAudio.currentTime = 0;
          audioUnlockedRef.current = true;
          console.log("[Notification] Audio context unlocked by user gesture");
        }).catch((err) => {
          firstAudio.muted = false;
          console.warn("[Notification] HTMLAudio unlock failed:", err);
        });
      }
    };
    document.addEventListener("click", unlock, { once: false, capture: true });
    document.addEventListener("keydown", unlock, { once: false, capture: true });
    document.addEventListener("touchstart", unlock, { once: false, capture: true });
    return () => {
      document.removeEventListener("click", unlock, true);
      document.removeEventListener("keydown", unlock, true);
      document.removeEventListener("touchstart", unlock, true);
    };
  }, []);

  const playSound = useCallback((type: SoundType, fallbackLabel?: string) => {
    if (!soundEnabledRef.current) return;
    const audio = audioMapRef.current?.[type];
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch((err) => {
      console.warn(`[Notification] ${type} audio playback failed:`, err);
      if (fallbackLabel) {
        toast({ title: type === "new-lead" ? "New Lead Arrived" : "Notification", description: fallbackLabel });
      }
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    (async () => {
      try {
        let reg = await navigator.serviceWorker.getRegistration(`${SW_BASE_URL}/sw.js`);
        if (!reg) {
          reg = await navigator.serviceWorker.register(`${SW_BASE_URL}/sw.js`, { scope: `${SW_BASE_URL}/` });
        }
        await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch(`${API}/api/web-push/subscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ subscription: sub.toJSON() }),
          }).catch(() => {});
        }
        console.log("[LeadNotification] Service worker registered on app load");
      } catch (err) {
        console.warn("[LeadNotification] SW registration on load failed:", err);
      }
    })();
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    const socket = socketIOClient({ path: "/api/socket.io", withCredentials: true, transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      console.log("[LeadNotification] Socket.IO connected:", socket.id);
      setTimeout(() => {
        reconnectListenersRef.current.forEach(cb => {
          try { cb(); } catch (e) { console.warn("[LeadNotification] Reconnect callback error:", e); }
        });
      }, 500);
    });
    socket.on("new-lead", (lead: LeadNotificationData) => {
      if (tenantIdRef.current && lead.tenantId && lead.tenantId !== tenantIdRef.current) return;
      if (lead.id == null) return;
      const normalized: LeadNotificationData = { ...lead, assignedCsrId: getAssignedCsrId(lead) };
      setPendingNewLeads(prev => {
        const filtered = prev.filter(l => l.id !== normalized.id);
        const next = [normalized, ...filtered];
        return next.slice(0, MAX_PENDING_NEW_LEADS);
      });
      setNewLeadSignal(s => s + 1);
      const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "New Lead";
      playSound("new-lead", `${name}${lead.source ? ` from ${lead.source}` : ""}`);
    });
    socket.on("lead-assigned", (lead: LeadNotificationData) => {
      if (tenantIdRef.current && lead.tenantId && lead.tenantId !== tenantIdRef.current) return;
      if (lead.id == null) return;
      const myUserId = userIdRef.current;
      if (myUserId == null) return;
      const assignedCsrId = getAssignedCsrId(lead);
      if (assignedCsrId !== myUserId) return;
      const normalized: LeadNotificationData = { ...lead, assignedCsrId };
      setPendingNewLeads(prev => {
        const filtered = prev.filter(l => l.id !== normalized.id);
        const next = [normalized, ...filtered];
        return next.slice(0, MAX_PENDING_NEW_LEADS);
      });
      setNewLeadSignal(s => s + 1);
      const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "New Lead";
      playSound("new-lead", `${name}${lead.source ? ` from ${lead.source}` : ""}`);
    });
    socket.on("podium-message", (msg: PodiumNotificationData) => {
      if (tenantIdRef.current && msg.tenantId && msg.tenantId !== tenantIdRef.current) return;
      podiumMessageListenersRef.current.forEach(cb => {
        try { cb(msg); } catch (e) { console.warn("[LeadNotification] Podium message callback error:", e); }
      });
      if (msg.direction === "inbound") {
        setLatestPodiumNotification(msg);
        const isCall = msg.channelType === "call" || msg.channelType === "phone_call" || msg.channelType === "car_wars";
        playSound(isCall ? "inbound-call" : "text-message");
      }
    });
    socket.on("rule-rederive-complete", (data: RuleRederiveCompleteData) => {
      if (tenantIdRef.current && data.tenantId && data.tenantId !== tenantIdRef.current) return;
      ruleRederiveListenersRef.current.forEach(cb => {
        try { cb(data); } catch (e) { console.warn("[LeadNotification] rule-rederive-complete callback error:", e); }
      });
    });
    socket.on("rule-rederive-failed", (data: RuleRederiveFailedData) => {
      if (tenantIdRef.current && data.tenantId && data.tenantId !== tenantIdRef.current) return;
      ruleRederiveFailedListenersRef.current.forEach(cb => {
        try { cb(data); } catch (e) { console.warn("[LeadNotification] rule-rederive-failed callback error:", e); }
      });
    });
    socket.on("selected-leads-rederive-complete", (data: SelectedLeadsRederiveCompleteData) => {
      if (tenantIdRef.current && data.tenantId && data.tenantId !== tenantIdRef.current) return;
      selectedLeadsRederiveListenersRef.current.forEach(cb => {
        try { cb(data); } catch (e) { console.warn("[LeadNotification] selected-leads-rederive-complete callback error:", e); }
      });
    });
    socket.on("selected-leads-rederive-failed", (data: SelectedLeadsRederiveFailedData) => {
      if (tenantIdRef.current && data.tenantId && data.tenantId !== tenantIdRef.current) return;
      selectedLeadsRederiveFailedListenersRef.current.forEach(cb => {
        try { cb(data); } catch (e) { console.warn("[LeadNotification] selected-leads-rederive-failed callback error:", e); }
      });
    });
    socket.on("selected-leads-rederive-progress", (data: SelectedLeadsRederiveProgressData) => {
      if (tenantIdRef.current && data.tenantId && data.tenantId !== tenantIdRef.current) return;
      selectedLeadsRederiveProgressListenersRef.current.forEach(cb => {
        try { cb(data); } catch (e) { console.warn("[LeadNotification] selected-leads-rederive-progress callback error:", e); }
      });
    });
    socket.on("selected-leads-rederive-cancelled", (data: SelectedLeadsRederiveCancelledData) => {
      if (tenantIdRef.current && data.tenantId && data.tenantId !== tenantIdRef.current) return;
      selectedLeadsRederiveCancelledListenersRef.current.forEach(cb => {
        try { cb(data); } catch (e) { console.warn("[LeadNotification] selected-leads-rederive-cancelled callback error:", e); }
      });
    });
    socket.on("callback-due", (data: CallbackDueData) => {
      if (!isAgency && user?.id && data.targetUserId !== user.id) return;
      setLatestCallbackDue(data);
      playSound("callback");
    });
    socket.on("lead-resubmitted", (data: { leadId: number; assignedCsrId: number | null; leadName: string; source?: string | null; reactivated: boolean; tenantId?: number }) => {
      if (!data || !data.leadId) return;
      if (tenantIdRef.current && data.tenantId && data.tenantId !== tenantIdRef.current) return;
      const isAssignedCsr = user?.id != null && data.assignedCsrId === user.id;
      const isManager = isAgency || user?.role === "client_admin";
      if (!isAssignedCsr && !isManager) return;
      const sourcePart = data.source ? ` from ${data.source}` : "";
      toast({
        title: LEAD_RESUBMITTED_TOAST_TITLE,
        description: `${data.leadName}${sourcePart} — reach out again`,
      });
      playSound("new-lead");
    });
    socket.on("lead-updated", (lead?: LeadNotificationData) => {
      setLeadUpdatedSignal(prev => prev + 1);
      if (!lead || lead.id == null) return;
      const myUserId = userIdRef.current;
      if (myUserId == null) return;
      setPendingNewLeads(prev => {
        const existing = prev.find(l => l.id === lead.id);
        if (!existing) return prev;
        const stillMine = getAssignedCsrId(lead) === myUserId;
        if (!stillMine) {
          return prev.filter(l => l.id !== lead.id);
        }
        return prev;
      });
    });
    socket.on("disconnect", () => console.log("[LeadNotification] Socket.IO disconnected"));
    return () => { socket.disconnect(); };
  }, [user?.id, effectiveTenantId, isAgency, playSound]);

  const { toasts } = useToast();
  const hasVisibleLeadResubmittedToast = toasts.some(
    (t) => t.open && t.title === LEAD_RESUBMITTED_TOAST_TITLE,
  );
  const hasVisibleLeadToast = pendingNewLeads.length > 0 || hasVisibleLeadResubmittedToast;
  const isClientAdmin = user?.role === "client_admin";
  const repeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (repeatTimerRef.current != null) {
        clearInterval(repeatTimerRef.current);
        repeatTimerRef.current = null;
      }
    };

    if (!user || isClientAdmin || !soundEnabled || !hasVisibleLeadToast) {
      clearTimer();
      return;
    }

    if (repeatTimerRef.current != null) return;

    repeatTimerRef.current = setInterval(() => {
      playSound("new-lead");
    }, LEAD_TOAST_REPEAT_MS);

    return clearTimer;
  }, [user?.id, effectiveTenantId, isClientAdmin, soundEnabled, hasVisibleLeadToast, playSound]);

  const dismissNewLead = useCallback((leadId: number) => {
    setPendingNewLeads(prev => prev.filter(l => l.id !== leadId));
  }, []);
  const clearPodiumNotification = useCallback(() => setLatestPodiumNotification(null), []);
  const clearCallbackDue = useCallback(() => setLatestCallbackDue(null), []);
  const playCallbackSound = useCallback((_leadName: string) => {
    playSound("callback");
  }, [playSound]);

  const registerOnReconnect = useCallback((cb: ReconnectCallback) => {
    reconnectListenersRef.current.add(cb);
    return () => { reconnectListenersRef.current.delete(cb); };
  }, []);

  const registerOnPodiumMessage = useCallback((cb: PodiumMessageCallback) => {
    podiumMessageListenersRef.current.add(cb);
    return () => { podiumMessageListenersRef.current.delete(cb); };
  }, []);

  const registerOnRuleRederiveComplete = useCallback((cb: RuleRederiveCompleteCallback) => {
    ruleRederiveListenersRef.current.add(cb);
    return () => { ruleRederiveListenersRef.current.delete(cb); };
  }, []);

  const registerOnRuleRederiveFailed = useCallback((cb: RuleRederiveFailedCallback) => {
    ruleRederiveFailedListenersRef.current.add(cb);
    return () => { ruleRederiveFailedListenersRef.current.delete(cb); };
  }, []);

  const registerOnSelectedLeadsRederiveComplete = useCallback((cb: SelectedLeadsRederiveCompleteCallback) => {
    selectedLeadsRederiveListenersRef.current.add(cb);
    return () => { selectedLeadsRederiveListenersRef.current.delete(cb); };
  }, []);

  const registerOnSelectedLeadsRederiveFailed = useCallback((cb: SelectedLeadsRederiveFailedCallback) => {
    selectedLeadsRederiveFailedListenersRef.current.add(cb);
    return () => { selectedLeadsRederiveFailedListenersRef.current.delete(cb); };
  }, []);

  const registerOnSelectedLeadsRederiveProgress = useCallback((cb: SelectedLeadsRederiveProgressCallback) => {
    selectedLeadsRederiveProgressListenersRef.current.add(cb);
    return () => { selectedLeadsRederiveProgressListenersRef.current.delete(cb); };
  }, []);

  const registerOnSelectedLeadsRederiveCancelled = useCallback((cb: SelectedLeadsRederiveCancelledCallback) => {
    selectedLeadsRederiveCancelledListenersRef.current.add(cb);
    return () => { selectedLeadsRederiveCancelledListenersRef.current.delete(cb); };
  }, []);

  return (
    <LeadNotificationContext.Provider value={{ soundEnabled, setSoundEnabled, pendingNewLeads, dismissNewLead, newLeadSignal, leadUpdatedSignal, onReconnect: registerOnReconnect, latestPodiumNotification, clearPodiumNotification, onPodiumMessage: registerOnPodiumMessage, latestCallbackDue, clearCallbackDue, playCallbackSound, onRuleRederiveComplete: registerOnRuleRederiveComplete, onRuleRederiveFailed: registerOnRuleRederiveFailed, onSelectedLeadsRederiveComplete: registerOnSelectedLeadsRederiveComplete, onSelectedLeadsRederiveFailed: registerOnSelectedLeadsRederiveFailed, onSelectedLeadsRederiveProgress: registerOnSelectedLeadsRederiveProgress, onSelectedLeadsRederiveCancelled: registerOnSelectedLeadsRederiveCancelled }}>
      {children}
      <PushPromptBanner />
    </LeadNotificationContext.Provider>
  );
}

function PushPromptBanner() {
  const { user } = useAuth();
  const { supported, permission, subscribed, subscribe } = usePushNotifications();
  const [visible, setVisible] = useState(false);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (!supported) return;
    if (permission !== "default") return;
    if (subscribed) return;
    try {
      if (localStorage.getItem(`${PUSH_BANNER_DISMISSED_KEY}_${user.id}`)) return;
    } catch {}
    const timer = setTimeout(() => setVisible(true), 3000);
    return () => clearTimeout(timer);
  }, [user?.id, supported, permission, subscribed]);

  const handleEnable = async () => {
    setActing(true);
    await subscribe();
    setActing(false);
    dismiss();
  };

  const dismiss = () => {
    setVisible(false);
    try { localStorage.setItem(`${PUSH_BANNER_DISMISSED_KEY}_${user?.id}`, "1"); } catch {}
  };

  if (!visible) return null;

  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 9999,
      maxWidth: 360, padding: "16px 20px",
      background: "linear-gradient(135deg, #0B1224 0%, #002D5E 100%)",
      border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12,
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      display: "flex", flexDirection: "column", gap: 12,
      animation: "slideUp 0.3s ease-out",
    }}>
      <style>{`@keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{ fontSize: 22, lineHeight: 1 }}>🔔</span>
        <div>
          <p style={{ color: "#fff", fontSize: 14, fontWeight: 600, margin: 0 }}>Enable push notifications?</p>
          <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, margin: "4px 0 0" }}>Get browser alerts when new leads come in, even if this tab isn't active.</p>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={dismiss}
          style={{
            background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
            color: "rgba(255,255,255,0.5)", borderRadius: 8, padding: "6px 14px",
            fontSize: 13, cursor: "pointer",
          }}
        >Not now</button>
        <button
          onClick={handleEnable}
          disabled={acting}
          style={{
            background: "#0ea5e9", border: "none", color: "#fff",
            borderRadius: 8, padding: "6px 14px", fontSize: 13,
            fontWeight: 600, cursor: acting ? "wait" : "pointer",
            opacity: acting ? 0.7 : 1,
          }}
        >{acting ? "Enabling..." : "Enable"}</button>
      </div>
    </div>
  );
}

export function useLeadNotification() {
  const ctx = useContext(LeadNotificationContext);
  if (!ctx) throw new Error("useLeadNotification must be used within LeadNotificationProvider");
  return ctx;
}

// Variant that returns null when no provider is mounted. Useful in tests and
// in components that are rendered both inside and outside the notification
// shell — they can degrade gracefully (e.g. skip the socket subscription)
// rather than throwing during render.
export function useOptionalLeadNotification(): LeadNotificationContextType | null {
  return useContext(LeadNotificationContext);
}
