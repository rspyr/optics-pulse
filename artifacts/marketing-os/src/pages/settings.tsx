import { useState, useEffect } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { useAuth } from "@/components/auth-context";
import { Copy, Check, Save, Loader2, Phone, MessageSquare, Wifi, WifiOff, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

const API = import.meta.env.VITE_API_URL || "";
const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export default function Settings() {
  const { user } = useAuth();
  const tenantId = user?.tenantId;
  const isClientUser = user?.role === "client_user";
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [scriptTag, setScriptTag] = useState("");
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
  const [commConfig, setCommConfig] = useState({
    callPlatform: "native" as string,
    textPlatform: "native" as string,
  });
  const [commStatus, setCommStatus] = useState<{ callReady: boolean; textReady: boolean; callStatusMessage: string; textStatusMessage: string } | null>(null);
  const [commSaving, setCommSaving] = useState(false);
  const [commSaved, setCommSaved] = useState(false);
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
        setCommConfig({
          callPlatform: cc.callPlatform || "native",
          textPlatform: cc.textPlatform || "native",
        });
      })
      .catch(() => {});

    fetch(`${API}/api/leads/comm-config`, { credentials: "include" })
      .then(r => r.json())
      .then(data => setCommStatus({ callReady: data.callReady, textReady: data.textReady, callStatusMessage: data.callStatusMessage, textStatusMessage: data.textStatusMessage }))
      .catch(() => {});

    fetch(`${API}/api/funnel-types/script/${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => setScriptTag(data.script || ""))
      .catch(() => {
        setScriptTag(`<script src="${window.location.origin}/tracker.js" data-tenant="${tenantId}"></script>`);
      });
  }, [tenantId, isClientUser]);

  function trackField(field: string) {
    setDirtyFields(prev => new Set(prev).add(field));
  }

  async function handleSave() {
    if (!tenantId) return;
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
        setTimeout(() => setCommSaved(false), 2000);
        const statusRes = await fetch(`${API}/api/leads/comm-config`, { credentials: "include" });
        if (statusRes.ok) {
          const data = await statusRes.json();
          setCommStatus({ callReady: data.callReady, textReady: data.textReady, callStatusMessage: data.callStatusMessage, textStatusMessage: data.textStatusMessage });
        }
      }
    } catch {}
    setCommSaving(false);
  }

  async function handleCopyScript() {
    try {
      await navigator.clipboard.writeText(scriptTag);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

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

      {!isClientUser && <PremiumCard>
        <h3 className="text-xl font-display text-white mb-6">API Integrations</h3>
        <div className="space-y-5">
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
            <label className="text-sm font-medium text-gray-300">CallRail Tracking Number</label>
            <input
              type="text"
              value={form.callRailTrackingNumber}
              onChange={e => { trackField("callRailTrackingNumber"); setForm({ ...form, callRailTrackingNumber: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. +18005551234"
            />
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
            <label className="text-sm font-medium text-gray-300">Podium Location ID</label>
            <input
              type="text"
              value={form.podiumLocationId}
              onChange={e => { trackField("podiumLocationId"); setForm({ ...form, podiumLocationId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. loc_abc123"
            />
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all mt-4 flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saved ? "Saved!" : "Save Configuration"}
          </button>
        </div>
      </PremiumCard>}

      {!isClientUser && <PremiumCard>
        <h3 className="text-xl font-display text-white mb-2">Communication Platform</h3>
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
          disabled={commSaving}
          className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all mt-6 flex items-center gap-2 disabled:opacity-50"
        >
          {commSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : commSaved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {commSaved ? "Saved!" : "Save Platform Settings"}
        </button>
      </PremiumCard>}

      {!isClientUser && <PremiumCard>
        <h3 className="text-xl font-display text-white mb-2">Capture Script</h3>
        <p className="text-sm text-muted-foreground mb-6">Install this script in the &lt;head&gt; of your website to enable GCLID capture, cookie storage, and heartbeat monitoring.</p>

        <div className="bg-background border border-white/10 rounded-lg p-4 font-mono text-sm text-emerald-400 overflow-x-auto relative group">
          <pre>{scriptTag || "Loading..."}</pre>
          <button
            onClick={handleCopyScript}
            className="absolute top-2 right-2 bg-white/10 hover:bg-white/20 text-white px-3 py-1 rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </PremiumCard>}

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
