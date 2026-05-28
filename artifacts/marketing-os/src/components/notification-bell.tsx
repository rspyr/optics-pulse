import { useState, useEffect, useCallback, useRef } from "react";
import { Bell, X, Check, CheckCheck, AlertTriangle, AlertOctagon, Info, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface Notification {
  id: number;
  tenantId: number | null;
  type: string;
  severity: string;
  title: string;
  message: string;
  integration: string | null;
  actionUrl: string | null;
  actionLabel: string | null;
  isRead: boolean;
  isDismissed: boolean;
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
}

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasCriticalUnread, setHasCriticalUnread] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/notifications/unread-count`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(data.count);
        setHasCriticalUnread(data.hasCriticalUnread ?? false);
      }
    } catch {}
  }, []);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = showHistory
        ? `${API_BASE}/api/notifications/history?limit=50`
        : `${API_BASE}/api/notifications?includeRead=true&limit=20`;
      const res = await fetch(endpoint, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications);
      }
    } catch {}
    setLoading(false);
  }, [showHistory]);

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  useEffect(() => {
    if (isOpen) fetchNotifications();
  }, [isOpen, fetchNotifications]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const markAsRead = async (id: number) => {
    try {
      await fetch(`${API_BASE}/api/notifications/${id}/read`, { method: "PATCH", credentials: "include" });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch {}
  };

  const dismiss = async (id: number) => {
    try {
      await fetch(`${API_BASE}/api/notifications/${id}/dismiss`, { method: "PATCH", credentials: "include" });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, isDismissed: true, isRead: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch {}
  };

  const markAllRead = async () => {
    try {
      await fetch(`${API_BASE}/api/notifications/read-all`, { method: "POST", credentials: "include" });
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch {}
  };

  const dismissAll = async () => {
    try {
      await fetch(`${API_BASE}/api/notifications/dismiss-all`, { method: "POST", credentials: "include" });
      setNotifications(prev => prev.map(n => ({ ...n, isDismissed: true, isRead: true })));
      setUnreadCount(0);
    } catch {}
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case "critical": return <AlertOctagon className="w-4 h-4 text-red-400 shrink-0" />;
      case "warning": return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />;
      default: return <Info className="w-4 h-4 text-blue-400 shrink-0" />;
    }
  };

  const getSeverityBorder = (severity: string, isRead: boolean) => {
    if (isRead) return "border-white/5";
    switch (severity) {
      case "critical": return "border-red-500/30 bg-red-500/5";
      case "warning": return "border-amber-500/20 bg-amber-500/5";
      default: return "border-blue-500/20 bg-blue-500/5";
    }
  };

  const timeAgo = (dateStr: string) => {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const visibleNotifications = showHistory
    ? notifications
    : notifications.filter(n => !n.isDismissed);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 rounded-lg hover:bg-white/5 transition-colors"
      >
        <Bell className={cn("w-5 h-5", unreadCount > 0 ? "text-white" : "text-muted-foreground")} />
        {unreadCount > 0 && (
          <span className={cn(
            "absolute -top-0.5 -right-0.5 flex items-center justify-center text-[10px] font-bold text-white rounded-full min-w-[18px] h-[18px] px-1",
            hasCriticalUnread
              ? "bg-red-500 animate-pulse"
              : "bg-primary"
          )}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-96 bg-card border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
            <h3 className="font-display text-sm text-white tracking-wide">
              {showHistory ? "Notification History" : "Notifications"}
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-white transition-colors"
              >
                {showHistory ? "Active" : "History"}
              </button>
              {!showHistory && unreadCount > 0 && (
                <>
                  <span className="text-white/10">|</span>
                  <button
                    onClick={markAllRead}
                    className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-white transition-colors flex items-center gap-1"
                  >
                    <CheckCheck className="w-3 h-3" /> Read All
                  </button>
                  <span className="text-white/10">|</span>
                  <button
                    onClick={dismissAll}
                    className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-white transition-colors"
                  >
                    Clear All
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="max-h-[400px] overflow-y-auto">
            {loading ? (
              <div className="py-8 text-center text-muted-foreground text-sm">Loading...</div>
            ) : visibleNotifications.length === 0 ? (
              <div className="py-8 text-center">
                <Bell className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-muted-foreground text-sm">No notifications</p>
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {visibleNotifications.map((n) => (
                  <div
                    key={n.id}
                    className={cn(
                      "px-4 py-3 transition-colors hover:bg-white/[0.02] border-l-2",
                      getSeverityBorder(n.severity, n.isRead),
                    )}
                  >
                    <div className="flex items-start gap-3">
                      {getSeverityIcon(n.severity)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className={cn("text-sm font-medium truncate", n.isRead ? "text-muted-foreground" : "text-white")}>
                            {n.title}
                          </p>
                          <div className="flex items-center gap-1 shrink-0">
                            {!n.isRead && (
                              <button
                                onClick={() => markAsRead(n.id)}
                                className="p-1 hover:bg-white/10 rounded transition-colors"
                                title="Mark as read"
                              >
                                <Check className="w-3 h-3 text-muted-foreground" />
                              </button>
                            )}
                            {!n.isDismissed && (
                              <button
                                onClick={() => dismiss(n.id)}
                                className="p-1 hover:bg-white/10 rounded transition-colors"
                                title="Dismiss"
                              >
                                <X className="w-3 h-3 text-muted-foreground" />
                              </button>
                            )}
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>
                        {n.actionUrl && (
                          <a
                            href={`${API_BASE}${n.actionUrl}`}
                            onClick={() => { if (!n.isRead) markAsRead(n.id); setIsOpen(false); }}
                            className={cn(
                              "inline-flex items-center gap-1 mt-2 px-2 py-1 rounded text-[11px] font-medium transition-colors",
                              n.severity === "critical"
                                ? "bg-red-500/15 text-red-300 hover:bg-red-500/25"
                                : "bg-primary/15 text-primary hover:bg-primary/25",
                            )}
                          >
                            {n.actionLabel || "Open"}
                          </a>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5" />
                            {timeAgo(n.createdAt)}
                          </span>
                          {n.integration && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-white/5 rounded text-muted-foreground capitalize">
                              {n.integration.replace(/_/g, " ")}
                            </span>
                          )}
                          {n.severity === "critical" && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded font-medium">
                              CRITICAL
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
