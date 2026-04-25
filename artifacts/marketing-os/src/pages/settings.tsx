import { useState, useEffect, useCallback } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { useAuth } from "@/components/auth-context";
import { Copy, Check, Save, Loader2, Phone, MessageSquare, Wifi, WifiOff, Lock, ChevronDown, CheckCircle, XCircle, Key, Unplug, Users, Link2, Unlink, Bell, BellOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { usePushNotifications } from "@/hooks/use-push-notifications";

const API = import.meta.env.VITE_API_URL || "";
const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

interface TenantOption { id: number; name: string; }

interface PodiumUserEntry {
  uid: string;
  name?: string;
  email?: string;
  internalUserId: number | null;
  internalUserName: string | null;
}

interface TeamMemberEntry {
  id: number;
  name: string | null;
  email: string | null;
  podiumUserUid: string | null;
}

function PushNotificationCard() {
  const { permission, subscribed, loading, supported, subscribe, unsubscribe } = usePushNotifications();

  if (!supported) return null;

  const handleToggle = async () => {
    if (subscribed) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  };

  return (
    <PremiumCard>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bell className="w-5 h-5 text-cyan-400" />
          <div>
            <h3 className="text-xl font-display text-white">Push Notifications</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {permission === "denied"
                ? "Notifications are blocked in your browser settings."
                : subscribed
                  ? "You'll receive browser notifications for new leads."
                  : "Enable browser notifications to get alerted for new leads."}
            </p>
          </div>
        </div>
        <button
          onClick={handleToggle}
          disabled={loading || permission === "denied"}
          className={cn(
            "relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50",
            subscribed ? "bg-cyan-500" : "bg-white/10"
          )}
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin text-white mx-auto" />
          ) : (
            <span className={cn(
              "inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform duration-200",
              subscribed ? "translate-x-6" : "translate-x-1"
            )} />
          )}
        </button>
      </div>
      {permission === "denied" && (
        <p className="text-xs text-amber-400/70 mt-3 flex items-center gap-1.5">
          <BellOff className="w-3.5 h-3.5" />
          To enable notifications, update your browser's notification permissions for this site.
        </p>
      )}
    </PremiumCard>
  );
}

function PodiumUserLinking({ tenantId }: { tenantId: number }) {
  const [podiumUsers, setPodiumUsers] = useState<PodiumUserEntry[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMemberEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [linkingId, setLinkingId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchData = useCallback(() => {
    setLoading(true);
    fetch(`${API}/api/podium/users?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        setPodiumUsers(d.podiumUsers || []);
        setTeamMembers(d.teamMembers || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tenantId]);

  useEffect(() => { if (expanded) fetchData(); }, [expanded, fetchData]);

  const handleLink = async (internalUserId: number, podiumUserUid: string | null) => {
    setLinkingId(internalUserId);
    try {
      const res = await fetch(`${API}/api/podium/users/link?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ internalUserId, podiumUserUid }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setFeedback({ type: "success", msg: podiumUserUid ? "Linked successfully" : "Unlinked" });
        fetchData();
      } else {
        setFeedback({ type: "error", msg: data.error || "Failed to link" });
      }
    } catch {
      setFeedback({ type: "error", msg: "Connection error" });
    } finally {
      setLinkingId(null);
      setTimeout(() => setFeedback(null), 3000);
    }
  };

  const linkedUids = new Set(teamMembers.filter(m => m.podiumUserUid).map(m => m.podiumUserUid));

  return (
    <PremiumCard>
      <button
        onClick={() => setExpanded(o => !o)}
        className="w-full flex items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-cyan-400" />
          <h3 className="text-xl font-display text-white">Podium User Mapping</h3>
        </div>
        <ChevronDown className={cn("w-5 h-5 text-gray-400 transition-transform duration-200", expanded && "rotate-180")} />
      </button>

      {expanded && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Link your team members to their Podium accounts to enable conversation assignment.
          </p>

          {feedback && (
            <div className={cn(
              "px-3 py-2 rounded-lg text-sm flex items-center gap-2",
              feedback.type === "success" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
            )}>
              {feedback.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
              {feedback.msg}
            </div>
          )}

          {loading ? (
            <div className="py-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
          ) : (
            <div className="space-y-2">
              {teamMembers.length === 0 && (
                <p className="text-sm text-white/30 text-center py-4">No team members found for this tenant.</p>
              )}
              {teamMembers.map(member => {
                const linkedPodiumUser = podiumUsers.find(pu => pu.uid === member.podiumUserUid);
                const isLinking = linkingId === member.id;
                return (
                  <div key={member.id} className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-lg px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{member.name || member.email || `User #${member.id}`}</p>
                      {member.email && member.name && (
                        <p className="text-xs text-white/30 truncate">{member.email}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {member.podiumUserUid ? (
                        <>
                          <div className="flex items-center gap-1.5 px-2 py-1 bg-emerald-500/10 rounded text-emerald-400">
                            <Link2 className="w-3 h-3" />
                            <span className="text-xs">{linkedPodiumUser?.name || linkedPodiumUser?.email || member.podiumUserUid}</span>
                          </div>
                          <button
                            onClick={() => handleLink(member.id, null)}
                            disabled={isLinking}
                            className="p-1.5 rounded hover:bg-red-500/10 text-white/30 hover:text-red-400 transition-colors disabled:opacity-50"
                            title="Unlink"
                          >
                            {isLinking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unlink className="w-3.5 h-3.5" />}
                          </button>
                        </>
                      ) : (
                        <select
                          onChange={e => { if (e.target.value) handleLink(member.id, e.target.value); }}
                          disabled={isLinking}
                          className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white focus:outline-none focus:border-cyan-500/30 disabled:opacity-50 max-w-[180px]"
                          defaultValue=""
                        >
                          <option value="" className="bg-gray-900">Link to Podium user...</option>
                          {podiumUsers.filter(pu => !linkedUids.has(pu.uid)).map(pu => (
                            <option key={pu.uid} value={pu.uid} className="bg-gray-900">
                              {pu.name || pu.email || pu.uid}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                );
              })}
              {podiumUsers.length === 0 && teamMembers.length > 0 && (
                <p className="text-xs text-amber-400/60 mt-2">
                  No Podium users found. A user within this tenant needs to connect their Podium account in their own Settings first, or reconnect with the "read_users" scope above.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </PremiumCard>
  );
}

export default function Settings() {
  const { user, isAgency, selectedTenantId, setSelectedTenantId, effectiveTenantId } = useAuth();
  const isClientUser = user?.role === "client_user";
  const tenantId = effectiveTenantId;
  const [tenants, setTenants] = useState<TenantOption[]>([]);

  useEffect(() => {
    if (!isAgency) return;
    fetch(`${API}/api/tenants`, { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setTenants(data.map((t: { id: number; name: string }) => ({ id: t.id, name: t.name })));
          if (!selectedTenantId && data.length > 0) setSelectedTenantId(data[0].id);
        }
      })
      .catch(() => {});
  }, [isAgency]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
  const [commConfig, setCommConfig] = useState({
    callPlatform: "native" as string,
    textPlatform: "native" as string,
  });
  const [commStatus, setCommStatus] = useState<{ callReady: boolean; textReady: boolean; callStatusMessage: string; textStatusMessage: string } | null>(null);
  const [commSaving, setCommSaving] = useState(false);
  const [commSaved, setCommSaved] = useState(false);
  const [commInitial, setCommInitial] = useState({ callPlatform: "native", textPlatform: "native" });
  const commDirty = commConfig.callPlatform !== commInitial.callPlatform || commConfig.textPlatform !== commInitial.textPlatform;
  const [form, setForm] = useState({
    serviceTitanId: "",
    googleAdsCustomerId: "",
    metaAdAccountId: "",
    callRailAccountId: "",
    callRailApiKey: "",
    callRailCompanyId: "",
    callRailTrackingNumber: "",
    ghlApiKey: "",
    podiumApiToken: "",
    podiumLocationId: "",
  });

  useEffect(() => {
    if (!tenantId || isClientUser) return;
    fetch(`${API}/api/tenants/${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        const lc = data.loadableConfig || {};
        setForm(f => ({
          ...f,
          serviceTitanId: data.serviceTitanId || "",
          googleAdsCustomerId: lc.googleAdsCustomerId || "",
          metaAdAccountId: lc.metaAdAccountId || "",
          callRailAccountId: lc.callRailAccountId || "",
          callRailApiKey: lc.callRailApiKey || "",
          callRailCompanyId: lc.callRailCompanyId || "",
          callRailTrackingNumber: lc.callRailTrackingNumber || "",
          ghlApiKey: lc.ghlApiKey || "",
          podiumApiToken: lc.podiumApiToken || "",
          podiumLocationId: lc.podiumLocationId || "",
        }));
        setDirtyFields(new Set());
        const cc = data.communicationConfig || {};
        const loadedComm = {
          callPlatform: cc.callPlatform || "native",
          textPlatform: cc.textPlatform || "native",
        };
        setCommConfig(loadedComm);
        setCommInitial(loadedComm);
      })
      .catch(() => {});

    const commConfigUrl = `${API}/api/leads/comm-config${tenantId ? `?tenantId=${tenantId}` : ""}`;
    fetch(commConfigUrl, { credentials: "include" })
      .then(r => r.json())
      .then(data => setCommStatus({ callReady: data.callReady, textReady: data.textReady, callStatusMessage: data.callStatusMessage, textStatusMessage: data.textStatusMessage }))
      .catch(() => {});

  }, [tenantId, isClientUser]);

  function trackField(field: string) {
    setDirtyFields(prev => new Set(prev).add(field));
  }

  async function handleSave() {
    if (!tenantId) return;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isMasked = (v: string) => v.startsWith("••••") || v.startsWith("****");
    if (form.podiumLocationId && !isMasked(form.podiumLocationId) && !uuidRe.test(form.podiumLocationId)) {
      return;
    }
    setSaving(true);
    try {
      const integrationConfig: Record<string, string | null> = {};
      const configKeys = ["googleAdsCustomerId", "metaAdAccountId", "ghlApiKey", "callRailAccountId", "callRailApiKey", "callRailCompanyId", "callRailTrackingNumber", "podiumApiToken", "podiumLocationId"] as const;
      for (const key of configKeys) {
        const val = form[key];
        if (!val) continue;
        if (!dirtyFields.has(key) && (val.startsWith("••••") || val.startsWith("****"))) continue;
        integrationConfig[key] = val;
      }

      const res = await fetch(`${API}/api/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ...(form.serviceTitanId ? { serviceTitanId: form.serviceTitanId } : {}),
          ...(Object.keys(integrationConfig).length > 0 ? { integrationConfig } : {}),
        }),
      });
      if (res.ok) {
        setSaved(true);
        setDirtyFields(new Set());
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {}
    setSaving(false);
  }

  async function handleCommSave() {
    if (!tenantId) return;
    setCommSaving(true);
    try {
      const res = await fetch(`${API}/api/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ communicationConfig: commConfig }),
      });
      if (res.ok) {
        setCommSaved(true);
        setCommInitial({ ...commConfig });
        setTimeout(() => setCommSaved(false), 2000);
        const statusRes = await fetch(`${API}/api/leads/comm-config${tenantId ? `?tenantId=${tenantId}` : ""}`, { credentials: "include" });
        if (statusRes.ok) {
          const data = await statusRes.json();
          setCommStatus({ callReady: data.callReady, textReady: data.textReady, callStatusMessage: data.callStatusMessage, textStatusMessage: data.textStatusMessage });
        }
      }
    } catch {}
    setCommSaving(false);
  }


  const [apiIntegrationsOpen, setApiIntegrationsOpen] = useState(false);
  const [commPlatformOpen, setCommPlatformOpen] = useState(false);
  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [podiumStatus, setPodiumStatus] = useState<{ connected: boolean; locationName?: string | null } | null>(null);
  const [podiumConnecting, setPodiumConnecting] = useState(false);
  const [podiumMessage, setPodiumMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetch(`${API}/api/oauth/podium/status`, { credentials: "include" })
      .then(r => r.json())
      .then(data => setPodiumStatus({ connected: data.connected, locationName: data.locationName }))
      .catch(() => setPodiumStatus(null));

    const params = new URLSearchParams(window.location.search);
    const podiumResult = params.get("podiumOAuth");
    if (podiumResult === "success") {
      setPodiumMessage({ type: "success", text: "Podium connected successfully!" });
      fetch(`${API}/api/oauth/podium/status`, { credentials: "include" })
        .then(r => r.json())
        .then(data => setPodiumStatus({ connected: data.connected, locationName: data.locationName }))
        .catch(() => {});
      const url = new URL(window.location.href);
      url.searchParams.delete("podiumOAuth");
      window.history.replaceState({}, "", url.pathname + url.search);
    } else if (podiumResult === "error") {
      const message = params.get("message") || "Unknown error";
      const readable: Record<string, string> = {
        token_exchange_failed: "Failed to exchange authorization code for tokens.",
        missing_podium_env_credentials: "Podium integration is not configured. Contact your administrator.",
        no_refresh_token: "Podium didn't return a refresh token. Please try again.",
        invalid_state: "Security validation failed. Please try again.",
      };
      setPodiumMessage({ type: "error", text: readable[message] || `OAuth error: ${message}` });
      const url = new URL(window.location.href);
      url.searchParams.delete("podiumOAuth");
      url.searchParams.delete("message");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  }, []);

  async function handleConnectPodium() {
    setPodiumConnecting(true);
    setPodiumMessage(null);
    try {
      const res = await fetch(`${API}/api/oauth/podium/authorize`, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json();
        setPodiumMessage({ type: "error", text: data.error || "Failed to start OAuth flow" });
        return;
      }
      const { authUrl } = await res.json();
      window.location.href = authUrl;
    } catch {
      setPodiumMessage({ type: "error", text: "Network error starting OAuth flow" });
    } finally {
      setPodiumConnecting(false);
    }
  }

  async function handleDisconnectPodium() {
    try {
      const res = await fetch(`${API}/api/oauth/podium/disconnect`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        setPodiumStatus({ connected: false });
        setPodiumMessage({ type: "success", text: "Podium disconnected." });
      }
    } catch {
      setPodiumMessage({ type: "error", text: "Failed to disconnect Podium" });
    }
  }

  async function handleChangePassword() {
    setPwMessage(null);
    if (!pwForm.currentPassword || !pwForm.newPassword) {
      setPwMessage({ type: "error", text: "All fields are required" });
      return;
    }
    if (pwForm.newPassword.length < 6) {
      setPwMessage({ type: "error", text: "New password must be at least 6 characters" });
      return;
    }
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      setPwMessage({ type: "error", text: "New passwords do not match" });
      return;
    }
    setPwSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword }),
      });
      if (res.ok) {
        setPwMessage({ type: "success", text: "Password changed successfully" });
        setPwForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      } else {
        const data = await res.json();
        setPwMessage({ type: "error", text: data.error || "Failed to change password" });
      }
    } catch {
      setPwMessage({ type: "error", text: "Failed to change password" });
    }
    setPwSaving(false);
  }

  const inputClass = "w-full bg-background border border-white/10 text-white rounded-lg px-4 py-3 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all";

  return (
    <div className="space-y-6 max-w-4xl">
      <header>
        <GradientHeading className="text-3xl md:text-4xl mb-2">Settings</GradientHeading>
        <p className="font-sub text-muted-foreground text-sm tracking-wide">YOUR ACCOUNT CONFIGURATION</p>
      </header>

      {isAgency && tenants.length > 0 && (
        <PremiumCard className="p-4">
          <div className="flex items-center gap-3">
            <label className="text-xs text-white/40 uppercase tracking-wider">Tenant</label>
            <Select value={selectedTenantId != null ? String(selectedTenantId) : ""} onValueChange={v => setSelectedTenantId(parseInt(v))}>
              <SelectTrigger className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50 w-auto min-w-[160px]">
                <SelectValue />
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

      {isAgency && !tenantId && (
        <PremiumCard>
          <p className="text-center text-muted-foreground py-8">Select a tenant above to manage settings.</p>
        </PremiumCard>
      )}

      <PremiumCard>
        <div className="flex items-center gap-2 mb-6">
          <Lock className="w-5 h-5 text-primary" />
          <h3 className="text-xl font-display text-white">Change Password</h3>
        </div>
        {pwMessage && (
          <div className={cn(
            "px-4 py-3 rounded-lg text-sm mb-4 border",
            pwMessage.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
              : "bg-red-500/10 border-red-500/20 text-red-400"
          )}>
            {pwMessage.text}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Current Password</label>
            <input
              type="password"
              value={pwForm.currentPassword}
              onChange={e => setPwForm(f => ({ ...f, currentPassword: e.target.value }))}
              className={inputClass}
              placeholder="Enter current password"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">New Password</label>
            <input
              type="password"
              value={pwForm.newPassword}
              onChange={e => setPwForm(f => ({ ...f, newPassword: e.target.value }))}
              className={inputClass}
              placeholder="Enter new password"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Confirm New Password</label>
            <input
              type="password"
              value={pwForm.confirmPassword}
              onChange={e => setPwForm(f => ({ ...f, confirmPassword: e.target.value }))}
              className={inputClass}
              placeholder="Confirm new password"
            />
          </div>
        </div>
        <button
          onClick={handleChangePassword}
          disabled={pwSaving}
          className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all mt-4 flex items-center gap-2 disabled:opacity-50"
        >
          {pwSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
          {pwSaving ? "Changing..." : "Change Password"}
        </button>
      </PremiumCard>

      <PushNotificationCard />

      <PremiumCard>
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="w-5 h-5 text-cyan-400" />
          <h3 className="text-xl font-display text-white">Podium Integration</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Connect your Podium account to send and receive texts through Pulse. Each user connects their own account so conversations are properly attributed.
        </p>

        {podiumMessage && (
          <div className={cn(
            "px-4 py-3 rounded-lg text-sm mb-4 border flex items-center gap-2",
            podiumMessage.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
              : "bg-red-500/10 border-red-500/20 text-red-400"
          )}>
            {podiumMessage.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            {podiumMessage.text}
          </div>
        )}

        {podiumStatus?.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
              <CheckCircle className="w-4 h-4" />
              Connected{podiumStatus.locationName ? ` — ${podiumStatus.locationName}` : ""}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleConnectPodium}
                disabled={podiumConnecting}
                className="bg-white/10 hover:bg-white/20 text-white font-medium px-4 py-2 rounded-lg transition-all text-sm flex items-center gap-2 disabled:opacity-50"
              >
                {podiumConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                Reconnect
              </button>
              <button
                onClick={handleDisconnectPodium}
                className="bg-red-500/10 hover:bg-red-500/20 text-red-400 font-medium px-4 py-2 rounded-lg transition-all text-sm flex items-center gap-2 border border-red-500/20"
              >
                <Unplug className="w-4 h-4" />
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={handleConnectPodium}
            disabled={podiumConnecting}
            className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {podiumConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
            Connect Podium
          </button>
        )}
      </PremiumCard>

      {!isClientUser && tenantId && podiumStatus?.connected && (
        <PodiumUserLinking tenantId={tenantId} />
      )}

      {!isClientUser && tenantId && <PremiumCard>
        <button
          onClick={() => setApiIntegrationsOpen(o => !o)}
          className="w-full flex items-center justify-between"
        >
          <h3 className="text-xl font-display text-white">API Integrations</h3>
          <ChevronDown className={cn("w-5 h-5 text-gray-400 transition-transform duration-200", apiIntegrationsOpen && "rotate-180")} />
        </button>
        {apiIntegrationsOpen ? <div className="space-y-5 mt-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">ServiceTitan Tenant ID</label>
            <input
              type="text"
              value={form.serviceTitanId}
              onChange={e => { trackField("serviceTitanId"); setForm({ ...form, serviceTitanId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. 123456"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Google Ads Customer ID</label>
            <input
              type="text"
              value={form.googleAdsCustomerId}
              onChange={e => { trackField("googleAdsCustomerId"); setForm({ ...form, googleAdsCustomerId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. 123-456-7890"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Meta Ad Account ID</label>
            <input
              type="text"
              value={form.metaAdAccountId}
              onChange={e => { trackField("metaAdAccountId"); setForm({ ...form, metaAdAccountId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. act_123456789"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">CallRail Account ID</label>
            <input
              type="text"
              value={form.callRailAccountId}
              onChange={e => { trackField("callRailAccountId"); setForm({ ...form, callRailAccountId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. 123456789"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">CallRail API Key</label>
            <input
              type={dirtyFields.has("callRailApiKey") ? "password" : "text"}
              value={form.callRailApiKey}
              onFocus={() => { if (!dirtyFields.has("callRailApiKey") && form.callRailApiKey.startsWith("••••")) { setForm({ ...form, callRailApiKey: "" }); trackField("callRailApiKey"); } }}
              onChange={e => { trackField("callRailApiKey"); setForm({ ...form, callRailApiKey: e.target.value }); }}
              className={inputClass}
              placeholder="Enter to update"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">CallRail Company ID</label>
            <input
              type="text"
              value={form.callRailCompanyId}
              onChange={e => { trackField("callRailCompanyId"); setForm({ ...form, callRailCompanyId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. COM123456"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">CallRail Tracking Number (optional)</label>
            <input
              type="text"
              value={form.callRailTrackingNumber}
              onChange={e => { trackField("callRailTrackingNumber"); setForm({ ...form, callRailTrackingNumber: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. +18005551234"
            />
            <p className="text-xs text-gray-500">Reference field — outbound SMS via CallRail is not yet wired up.</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">GoHighLevel API Key</label>
            <input
              type={dirtyFields.has("ghlApiKey") ? "password" : "text"}
              value={form.ghlApiKey}
              onFocus={() => { if (!dirtyFields.has("ghlApiKey") && form.ghlApiKey.startsWith("••••")) { setForm({ ...form, ghlApiKey: "" }); trackField("ghlApiKey"); } }}
              onChange={e => { trackField("ghlApiKey"); setForm({ ...form, ghlApiKey: e.target.value }); }}
              className={inputClass}
              placeholder="Enter to update"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Podium API Token</label>
            <input
              type={dirtyFields.has("podiumApiToken") ? "password" : "text"}
              value={form.podiumApiToken}
              onFocus={() => { if (!dirtyFields.has("podiumApiToken") && form.podiumApiToken.startsWith("••••")) { setForm({ ...form, podiumApiToken: "" }); trackField("podiumApiToken"); } }}
              onChange={e => { trackField("podiumApiToken"); setForm({ ...form, podiumApiToken: e.target.value }); }}
              className={inputClass}
              placeholder="Enter to update"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Podium Location UID</label>
            <input
              type="text"
              value={form.podiumLocationId}
              onChange={e => { trackField("podiumLocationId"); setForm({ ...form, podiumLocationId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. 12345678-abcd-1234-abcd-123456789012"
            />
            {form.podiumLocationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(form.podiumLocationId) && !form.podiumLocationId.startsWith("••••") && !form.podiumLocationId.startsWith("****") && (
              <p className="text-xs text-red-400">Must be a valid UUID format</p>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={saving || (dirtyFields.size === 0 && !saved)}
            className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all mt-4 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saved ? "Saved!" : "Save Configuration"}
          </button>
        </div> : null}
      </PremiumCard>}

      {!isClientUser && tenantId && <PremiumCard>
        <button
          onClick={() => setCommPlatformOpen(o => !o)}
          className="w-full flex items-center justify-between"
        >
          <h3 className="text-xl font-display text-white">Communication Platform</h3>
          <ChevronDown className={cn("w-5 h-5 text-gray-400 transition-transform duration-200", commPlatformOpen && "rotate-180")} />
        </button>
        {commPlatformOpen ? <div className="mt-4">
        <p className="text-sm text-muted-foreground mb-6">
          Choose how Pulse routes calls and texts. Configure API credentials above, then select your preferred platforms here.
        </p>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-2">
              <Phone className="w-4 h-4 text-emerald-400" />
              <label className="text-sm font-medium text-gray-300">Call Platform</label>
            </div>
            <div className="space-y-2">
              {[
                { value: "none", label: "None", desc: "No communication trigger — action is logged only" },
                { value: "native", label: "Native Phone Dialer", desc: "Opens system phone app" },
                { value: "callrail", label: "CallRail", desc: "Click-to-call via CallRail API" },
                { value: "podium", label: "Podium", desc: "Call routing via Podium API" },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setCommConfig(c => ({ ...c, callPlatform: opt.value }))}
                  className={cn(
                    "w-full text-left px-4 py-3 rounded-lg border transition-all",
                    commConfig.callPlatform === opt.value
                      ? "bg-emerald-500/10 border-emerald-500/30 text-white"
                      : "bg-white/5 border-white/10 text-gray-400 hover:border-white/20"
                  )}
                >
                  <span className="text-sm font-medium">{opt.label}</span>
                  <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                </button>
              ))}
            </div>
            {commStatus && (
              <div className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-xs",
                commStatus.callReady ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400" : "bg-red-500/10 border border-red-500/20 text-red-400"
              )}>
                {commStatus.callReady ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                {commStatus.callStatusMessage}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare className="w-4 h-4 text-blue-400" />
              <label className="text-sm font-medium text-gray-300">Text Platform</label>
            </div>
            <div className="space-y-2">
              {[
                { value: "none", label: "None", desc: "No communication trigger — action is logged only" },
                { value: "native", label: "Native SMS App", desc: "Opens system messaging app" },
                { value: "callrail", label: "CallRail", desc: "Send texts via CallRail API" },
                { value: "podium", label: "Podium", desc: "Send texts via Podium API" },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setCommConfig(c => ({ ...c, textPlatform: opt.value }))}
                  className={cn(
                    "w-full text-left px-4 py-3 rounded-lg border transition-all",
                    commConfig.textPlatform === opt.value
                      ? "bg-blue-500/10 border-blue-500/30 text-white"
                      : "bg-white/5 border-white/10 text-gray-400 hover:border-white/20"
                  )}
                >
                  <span className="text-sm font-medium">{opt.label}</span>
                  <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                </button>
              ))}
            </div>
            {commStatus && (
              <div className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-xs",
                commStatus.textReady ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400" : "bg-red-500/10 border border-red-500/20 text-red-400"
              )}>
                {commStatus.textReady ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                {commStatus.textStatusMessage}
              </div>
            )}
          </div>
        </div>

        <button
          onClick={handleCommSave}
          disabled={commSaving || (!commDirty && !commSaved)}
          className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all mt-6 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {commSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : commSaved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {commSaved ? "Saved!" : "Save Platform Settings"}
        </button>
        </div> : null}
      </PremiumCard>}

      {!isClientUser && tenantId && (
        <IngestionModeSettings tenantId={tenantId} />
      )}

      {tenantId && (
        <TrackerHealthSettings tenantId={tenantId} />
      )}

      {isClientUser && (
        <PremiumCard>
          <h3 className="text-xl font-display text-white mb-4">Account Information</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-white/10">
              <span className="text-sm text-gray-400">Name</span>
              <span className="text-sm text-white">{user?.name || "—"}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-white/10">
              <span className="text-sm text-gray-400">Email</span>
              <span className="text-sm text-white">{user?.email || "—"}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-gray-400">Organization</span>
              <span className="text-sm text-white">{user?.tenantName || "—"}</span>
            </div>
          </div>
        </PremiumCard>
      )}
    </div>
  );
}

interface AliasGroup { funnelTypeId: number; funnelName: string; aliases: { id: number; alias: string }[] }

function IngestionModeSettings({ tenantId }: { tenantId: number }) {
  const [mode, setMode] = useState("sheets");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [snippetError, setSnippetError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [aliasGroups, setAliasGroups] = useState<AliasGroup[]>([]);
  const [tenantFunnels, setTenantFunnels] = useState<{ id: number; name: string }[]>([]);
  const [newAlias, setNewAlias] = useState("");
  const [newFunnelTypeId, setNewFunnelTypeId] = useState<number | "">("");

  const loadAliases = async () => {
    const r = await fetch(`${API_BASE}/api/funnel-aliases?tenantId=${tenantId}`, { credentials: "include" });
    const d = await r.json();
    setAliasGroups(d.aliases || []);
  };

  useEffect(() => {
    setLoading(true);
    setSnippet(null);
    setSnippetError(null);
    Promise.all([
      fetch(`${API_BASE}/api/ingestion-mode?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json()),
      fetch(`${API_BASE}/api/ingestion-mode/gtm-snippet?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json().then(d => ({ ok: r.ok, data: d }))),
    ]).then(([modeData, snippetResult]) => {
      setMode(modeData.mode || "sheets");
      if (snippetResult.ok) {
        setSnippet(snippetResult.data.snippet || null);
      } else {
        setSnippetError(snippetResult.data.error || "Failed to load snippet");
      }
    }).catch(() => { setSnippetError("Failed to load snippet"); }).finally(() => setLoading(false));
    loadAliases();
    fetch(`${API}/api/tenants/${tenantId}/funnel-types`, { credentials: "include" })
      .then(r => r.json()).then(d => setTenantFunnels(Array.isArray(d) ? d.map((f: Record<string, unknown>) => ({ id: Number(f.funnelTypeId || f.id), name: String(f.funnelName || f.name || "") })) : []))
      .catch(() => setTenantFunnels([]));
  }, [tenantId]);

  const addAlias = async () => {
    if (!newAlias.trim() || !newFunnelTypeId) return;
    await fetch(`${API_BASE}/api/funnel-aliases?tenantId=${tenantId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ funnelTypeId: newFunnelTypeId, alias: newAlias.trim() }),
    });
    setNewAlias(""); setNewFunnelTypeId("");
    loadAliases();
  };

  const deleteAlias = async (id: number) => {
    await fetch(`${API_BASE}/api/funnel-aliases/${id}?tenantId=${tenantId}`, { method: "DELETE", credentials: "include" });
    loadAliases();
  };

  const updateMode = async (newMode: string) => {
    setSaving(true);
    const res = await fetch(`${API_BASE}/api/ingestion-mode?tenantId=${tenantId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: newMode }),
    });
    if (res.ok) setMode(newMode);
    setSaving(false);
  };

  if (loading) return null;

  const steps = [
    { key: "sheets", label: "Sheets Only", desc: "Leads from sheet sync only" },
    { key: "both", label: "Dual Mode", desc: "Both sheet sync and tracker" },
    { key: "tracker", label: "Tracker Only", desc: "All leads from tracker" },
  ];

  return (
    <>
      <PremiumCard>
        <div className="flex items-center gap-2 mb-4">
          <Wifi className="w-5 h-5 text-primary" />
          <h3 className="text-xl font-display text-white">Lead Ingestion Mode</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Control how leads enter the system for this tenant.</p>
        <div className="grid gap-3 md:grid-cols-3">
          {steps.map(step => (
            <button
              key={step.key}
              disabled={saving}
              onClick={() => updateMode(step.key)}
              className={cn(
                "p-4 rounded-xl border text-left transition-all",
                mode === step.key
                  ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                  : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
              )}
            >
              {mode === step.key && <Check className="w-4 h-4 text-primary float-right" />}
              <h4 className="font-medium text-sm text-white mb-1">{step.label}</h4>
              <p className="text-xs text-muted-foreground">{step.desc}</p>
            </button>
          ))}
        </div>
      </PremiumCard>

      <PremiumCard>
        <div className="flex items-center gap-2 mb-4">
          <Key className="w-5 h-5 text-primary" />
          <h3 className="text-xl font-display text-white">GTM Tracking Snippet</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Copy this into your Google Tag Manager custom HTML tag.</p>
        {snippetError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">
            <p className="text-xs text-red-400">{snippetError}</p>
          </div>
        )}
        {snippet ? (
          <div className="relative">
            <button
              onClick={() => { navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="absolute top-3 right-3 p-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-white/60" />}
            </button>
            <pre className="bg-black/40 border border-white/10 rounded-lg p-4 text-xs text-emerald-300/80 overflow-x-auto font-mono whitespace-pre-wrap">
              {snippet}
            </pre>
          </div>
        ) : !snippetError && (
          <p className="text-sm text-muted-foreground">Loading snippet...</p>
        )}
      </PremiumCard>

      <PremiumCard>
        <div className="flex items-center gap-2 mb-4">
          <Link2 className="w-5 h-5 text-primary" />
          <h3 className="text-xl font-display text-white">Funnel Aliases</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Map alternate funnel names to their canonical funnel types.</p>
        <div className="flex gap-2 mb-4">
          <select value={newFunnelTypeId} onChange={e => setNewFunnelTypeId(e.target.value ? Number(e.target.value) : "")}
            className="bg-background border border-white/10 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all min-w-[160px]">
            <option value="">Select funnel...</option>
            {tenantFunnels.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <input value={newAlias} onChange={e => setNewAlias(e.target.value)} placeholder="Alias (e.g. fb-funnel)"
            className="flex-1 bg-background border border-white/10 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all" />
          <button onClick={addAlias} className="bg-primary hover:bg-primary/90 text-white px-4 py-3 rounded-lg text-sm font-medium transition-all shadow-[0_0_15px_rgba(242,5,5,0.3)]">
            Add
          </button>
        </div>
        {aliasGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No funnel aliases configured for this tenant.</p>
        ) : (
          <div className="space-y-3">
            {aliasGroups.map(g => (
              <div key={g.funnelTypeId}>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{g.funnelName}</p>
                <div className="space-y-1">
                  {g.aliases.map(a => (
                    <div key={a.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-white/[0.02] border border-white/5">
                      <span className="text-sm text-white font-medium">{a.alias}</span>
                      <button onClick={() => deleteAlias(a.id)} className="text-muted-foreground hover:text-red-400 p-1 transition-colors">
                        <XCircle className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </PremiumCard>
    </>
  );
}

interface InstallSnippetVariant {
  label: string;
  description: string;
  placement: string;
  snippet: string;
}
interface InstallSnippetResponse {
  tenantId: number;
  tenantName: string;
  clientSlug: string;
  scriptUrl: string;
  suggestedFunnels: string[];
  funnelNote: string | null;
  variants: InstallSnippetVariant[];
  builderGuidance: { builder: string; instructions: string }[];
}

interface DomainHealthRow {
  domain: string;
  lastSubmitAt: string | null;
  lastSubmitStatus: number | null;
  lastSubmitOutcome: string | null;
  submitCount24h: number;
  submitCount7d: number;
}

function TrackerHealthSettings({ tenantId }: { tenantId: number }) {
  const [data, setData] = useState<InstallSnippetResponse | null>(null);
  const [domains, setDomains] = useState<DomainHealthRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setDomains(null);
    Promise.all([
      fetch(`${API_BASE}/api/tracker/install-snippet?tenantId=${tenantId}`, { credentials: "include" })
        .then(async r => {
          if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
          return r.json() as Promise<InstallSnippetResponse>;
        }),
      fetch(`${API_BASE}/api/tracker/health-rollup?tenantId=${tenantId}`, { credentials: "include" })
        .then(async r => {
          if (!r.ok) return { domains: [] as DomainHealthRow[] };
          return r.json() as Promise<{ domains: DomainHealthRow[] }>;
        })
        .catch(() => ({ domains: [] as DomainHealthRow[] })),
    ])
      .then(([snippetData, rollupData]) => {
        setData(snippetData);
        setDomains(rollupData.domains || []);
      })
      .catch(e => setError(e.message || "Failed to load install snippet"))
      .finally(() => setLoading(false));
  }, [tenantId]);

  const copy = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 2000);
    } catch {
      /* ignore */
    }
  };

  if (loading) return null;

  return (
    <PremiumCard>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-xl font-display text-white">Tracker Health — Pulse install</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Per-tenant install snippet for pulse.js. Paste into the &lt;head&gt; of every landing page that should attribute leads to{" "}
            <span className="text-white">{data?.tenantName || "this tenant"}</span>.
          </p>
        </div>
        <a
          href={`${API_BASE}/verify-tracker`}
          className="text-xs px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/5 text-white/80 shrink-0"
        >
          Open Verify Tracker
        </a>
      </div>

      {error && (
        <div className="border border-red-500/30 bg-red-500/[0.05] text-red-300 text-sm rounded-md px-3 py-2 mb-3">{error}</div>
      )}

      {data?.funnelNote && (
        <div className="border border-amber-500/30 bg-amber-500/[0.05] text-amber-200 text-sm rounded-md px-3 py-2 mb-4">
          {data.funnelNote}
          {data.suggestedFunnels.length > 0 && (
            <div className="mt-1 text-xs text-amber-200/80">
              Suggested funnel slugs: {data.suggestedFunnels.map(f => <code key={f} className="text-white/80 mr-2">{f}</code>)}
            </div>
          )}
        </div>
      )}

      {data && (
        <div className="space-y-4">
          {data.variants.map((v, idx) => (
            <div key={v.label} className="border border-white/10 bg-white/[0.02] rounded-lg p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <div className="text-sm font-medium text-white">{v.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{v.description}</div>
                </div>
                <button
                  onClick={() => copy(v.snippet, idx)}
                  className="text-xs px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/10 text-white/80 shrink-0"
                >
                  {copiedIdx === idx ? "Copied!" : "Copy"}
                </button>
              </div>
              <pre className="text-xs bg-black/40 border border-white/5 rounded px-3 py-2 overflow-x-auto text-white/85 whitespace-pre">
                <code>{v.snippet}</code>
              </pre>
              <p className="text-[11px] text-muted-foreground mt-2">{v.placement}</p>
            </div>
          ))}

          <div className="border border-white/10 bg-white/[0.02] rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium text-white">Per-domain health (last 30 days)</div>
              <div className="text-[11px] text-muted-foreground">Each landing page that has talked to pulse.js, with most recent submit + 24h/7d submit volume.</div>
            </div>
            {domains && domains.length === 0 && (
              <div className="text-xs text-muted-foreground italic">
                No tracker traffic yet for this tenant in the last 30 days. Once the snippet above is installed and a page loads, that domain will appear here.
              </div>
            )}
            {domains && domains.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[11px] uppercase tracking-wider text-white/50">
                    <tr className="border-b border-white/10">
                      <th className="text-left py-2 pr-3 font-medium">Domain</th>
                      <th className="text-left py-2 pr-3 font-medium">Last submit</th>
                      <th className="text-left py-2 pr-3 font-medium">Outcome</th>
                      <th className="text-right py-2 pr-3 font-medium">24h</th>
                      <th className="text-right py-2 font-medium">7d</th>
                    </tr>
                  </thead>
                  <tbody>
                    {domains.map(d => {
                      const ok = d.lastSubmitOutcome === "accepted" || d.lastSubmitOutcome === "duplicate" || d.lastSubmitOutcome === "resubmitted";
                      const outcomeClass = !d.lastSubmitOutcome
                        ? "text-white/40"
                        : ok
                          ? "text-emerald-300"
                          : "text-red-300";
                      const ts = d.lastSubmitAt ? new Date(d.lastSubmitAt).toLocaleString() : "—";
                      return (
                        <tr key={d.domain} className="border-b border-white/5">
                          <td className="py-2 pr-3 text-white/85 font-mono">{d.domain}</td>
                          <td className="py-2 pr-3 text-muted-foreground">{ts}</td>
                          <td className={`py-2 pr-3 ${outcomeClass}`}>
                            {d.lastSubmitOutcome || "—"}
                            {d.lastSubmitStatus ? <span className="text-white/40 ml-1">({d.lastSubmitStatus})</span> : null}
                          </td>
                          <td className="py-2 pr-3 text-right text-white/80">{d.submitCount24h.toLocaleString()}</td>
                          <td className="py-2 text-right text-white/80">{d.submitCount7d.toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="border border-white/10 bg-white/[0.02] rounded-lg p-4">
            <div className="text-sm font-medium text-white mb-2">Builder-specific install notes</div>
            <ul className="space-y-2 text-xs">
              {data.builderGuidance.map(g => (
                <li key={g.builder} className="border-l-2 border-white/20 pl-3 py-1">
                  <div className="text-white/80 font-medium">{g.builder}</div>
                  <div className="text-muted-foreground mt-0.5 leading-relaxed">{g.instructions}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </PremiumCard>
  );
}
