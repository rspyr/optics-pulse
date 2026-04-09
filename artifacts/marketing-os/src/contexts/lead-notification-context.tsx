import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { io as socketIOClient } from "socket.io-client";
import { useAuth } from "@/components/auth-context";
import { toast } from "@/hooks/use-toast";

const SW_BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const API = import.meta.env.VITE_API_URL || "";

export interface LeadNotificationData {
  id?: number;
  tenantId?: number;
  firstName?: string;
  lastName?: string;
  source?: string;
  [key: string]: unknown;
}

type ReconnectCallback = () => void;

interface LeadNotificationContextType {
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  latestLead: LeadNotificationData | null;
  clearLatestLead: () => void;
  leadUpdatedSignal: number;
  onReconnect: (cb: ReconnectCallback) => () => void;
}

const LeadNotificationContext = createContext<LeadNotificationContextType | null>(null);

const CHIME_URL = `${(import.meta.env.BASE_URL || "/").replace(/\/$/, "")}/sounds/lead-chime.wav`;

export function LeadNotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, effectiveTenantId, isAgency } = useAuth();
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [latestLead, setLatestLead] = useState<LeadNotificationData | null>(null);
  const [leadUpdatedSignal, setLeadUpdatedSignal] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const soundEnabledRef = useRef(soundEnabled);
  const tenantIdRef = useRef(effectiveTenantId);
  const audioUnlockedRef = useRef(false);
  const reconnectListenersRef = useRef<Set<ReconnectCallback>>(new Set());

  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => { tenantIdRef.current = effectiveTenantId; }, [effectiveTenantId]);

  useEffect(() => {
    const audio = new Audio(CHIME_URL);
    audio.volume = 0.4;
    audio.load();
    audioRef.current = audio;
    return () => {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
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
      const audio = audioRef.current;
      if (audio) {
        audio.muted = true;
        audio.play().then(() => {
          audio.pause();
          audio.muted = false;
          audio.currentTime = 0;
          audioUnlockedRef.current = true;
          console.log("[Notification] Audio context unlocked by user gesture");
        }).catch((err) => {
          audio.muted = false;
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

  const playNotification = useCallback((lead: LeadNotificationData) => {
    if (!soundEnabledRef.current) return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch((err) => {
      console.warn("[Notification] Audio playback failed:", err);
      const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "New Lead";
      toast({
        title: "New Lead Arrived",
        description: `${name}${lead.source ? ` from ${lead.source}` : ""}`,
      });
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
      setLatestLead(lead);
      playNotification(lead);
    });
    socket.on("lead-updated", () => setLeadUpdatedSignal(prev => prev + 1));
    socket.on("disconnect", () => console.log("[LeadNotification] Socket.IO disconnected"));
    return () => { socket.disconnect(); };
  }, [user?.id, effectiveTenantId, isAgency, playNotification]);

  const clearLatestLead = useCallback(() => setLatestLead(null), []);

  const registerOnReconnect = useCallback((cb: ReconnectCallback) => {
    reconnectListenersRef.current.add(cb);
    return () => { reconnectListenersRef.current.delete(cb); };
  }, []);

  return (
    <LeadNotificationContext.Provider value={{ soundEnabled, setSoundEnabled, latestLead, clearLatestLead, leadUpdatedSignal, onReconnect: registerOnReconnect }}>
      {children}
    </LeadNotificationContext.Provider>
  );
}

export function useLeadNotification() {
  const ctx = useContext(LeadNotificationContext);
  if (!ctx) throw new Error("useLeadNotification must be used within LeadNotificationProvider");
  return ctx;
}
