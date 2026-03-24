import React, { useState, useEffect, useCallback } from "react";
import { useListTenants, useCreateTenant, useUpdateTenant, useDeleteTenant } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { Plus, Edit2, X, Check, Trash2, Key, ChevronDown, ChevronUp, Shield, Activity, CheckCircle, XCircle, Bell, Mail, Loader2, Copy, Code, Settings, Trophy } from "lucide-react";

interface TenantForm {
  name: string;
  serviceTitanId: string;
  timezone: string;
  googleAdsApiKey: string;
  googleAdsRefreshToken: string;
  googleAdsClientId: string;
  googleAdsClientSecret: string;
  callRailApiKey: string;
  callRailSigningKey: string;
  serviceTitanClientId: string;
  serviceTitanClientSecret: string;
  metaAccessToken: string;
  metaAdAccountId: string;
  metaPixelId: string;
  googleAdsCustomerId: string;
  googleAdsLoginCustomerId: string;
  googleAdsDeveloperToken: string;
  podiumApiToken: string;
  podiumLocationId: string;
}

interface AlertConfig {
  enabled: boolean;
  recipients: string[];
  agencySenderEmail: string;
  leadDropEnabled: boolean;
  leadDropThreshold: number;
  bookingRateEnabled: boolean;
  bookingRateThreshold: number;
  roasEnabled: boolean;
  roasThreshold: number;
  spendSpikeEnabled: boolean;
  spendSpikeThreshold: number;
}

const defaultAlertConfig: AlertConfig = {
  enabled: true,
  recipients: [],
  agencySenderEmail: "",
  leadDropEnabled: true,
  leadDropThreshold: 30,
  bookingRateEnabled: true,
  bookingRateThreshold: 30,
  roasEnabled: true,
  roasThreshold: 3,
  spendSpikeEnabled: true,
  spendSpikeThreshold: 50,
};

const emptyForm: TenantForm = {
  name: "",
  serviceTitanId: "",
  timezone: "America/New_York",
  googleAdsApiKey: "",
  googleAdsRefreshToken: "",
  googleAdsClientId: "",
  googleAdsClientSecret: "",
  callRailApiKey: "",
  callRailSigningKey: "",
  serviceTitanClientId: "",
  serviceTitanClientSecret: "",
  metaAccessToken: "",
  metaAdAccountId: "",
  metaPixelId: "",
  googleAdsCustomerId: "",
  googleAdsLoginCustomerId: "",
  googleAdsDeveloperToken: "",
  podiumApiToken: "",
  podiumLocationId: "",
};

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type EditTab = "integrations" | "alerts" | "scripts" | "leaderboard";

export default function AdminTenants() {
  const { data: tenants, isLoading, refetch } = useListTenants();
  const createTenant = useCreateTenant();
  const updateTenant = useUpdateTenant();
  const deleteTenant = useDeleteTenant();

  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editTenantName, setEditTenantName] = useState("");
  const [form, setForm] = useState<TenantForm>(emptyForm);
  const [showIntegrationConfig, setShowIntegrationConfig] = useState(false);
  const [expandedSyncTenant, setExpandedSyncTenant] = useState<number | null>(null);
  const [tenantSyncStatuses, setTenantSyncStatuses] = useState<Record<number, { statusByIntegration: Record<string, { lastSync: string | null; lastStatus: string; lastRecords: number; errorCount: number }> }>>({});
  const [editTab, setEditTab] = useState<EditTab>("integrations");
  const [googleAdsConnecting, setGoogleAdsConnecting] = useState(false);
  const [googleAdsOAuthMessage, setGoogleAdsOAuthMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get("googleAdsOAuth");
    if (oauthResult === "success") {
      setGoogleAdsOAuthMessage({ type: "success", text: "Google Ads connected successfully! Tokens saved." });
      refetch();
      const url = new URL(window.location.href);
      url.searchParams.delete("googleAdsOAuth");
      url.searchParams.delete("tenantId");
      window.history.replaceState({}, "", url.pathname + url.search);
    } else if (oauthResult === "error") {
      const message = params.get("message") || "Unknown error";
      const readable: Record<string, string> = {
        no_refresh_token: "Google didn't return a refresh token. Try revoking app access at myaccount.google.com/permissions then reconnect.",
        token_exchange_failed: "Failed to exchange authorization code for tokens.",
        missing_client_credentials: "Client ID and Client Secret must be saved before connecting.",
        invalid_state: "Security validation failed. Please try again.",
      };
      setGoogleAdsOAuthMessage({ type: "error", text: readable[message] || `OAuth error: ${message}` });
      const url = new URL(window.location.href);
      url.searchParams.delete("googleAdsOAuth");
      url.searchParams.delete("message");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  }, [refetch]);

  const handleConnectGoogleAds = async (tenantId: number) => {
    setGoogleAdsConnecting(true);
    setGoogleAdsOAuthMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/oauth/google-ads/authorize?tenantId=${tenantId}`, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json();
        setGoogleAdsOAuthMessage({ type: "error", text: data.error || "Failed to start OAuth flow" });
        return;
      }
      const { authUrl } = await res.json();
      window.open(authUrl, "_blank");
    } catch {
      setGoogleAdsOAuthMessage({ type: "error", text: "Network error starting OAuth flow" });
    } finally {
      setGoogleAdsConnecting(false);
    }
  };

  const fetchTenantSyncStatus = useCallback(async (tenantId: number) => {
    try {
      const res = await fetch(`${API_BASE}/api/integrations/sync-status?tenantId=${tenantId}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setTenantSyncStatuses((prev) => ({ ...prev, [tenantId]: data }));
      }
    } catch { /* ignore */ }
  }, [API_BASE]);

  useEffect(() => {
    if (expandedSyncTenant && !tenantSyncStatuses[expandedSyncTenant]) {
      fetchTenantSyncStatus(expandedSyncTenant);
    }
  }, [expandedSyncTenant, tenantSyncStatuses, fetchTenantSyncStatus]);

  const trackFieldChange = (field: string) => {
    setDirtyFields(prev => new Set(prev).add(field));
  };

  const buildIntegrationConfig = () => {
    const config: Record<string, string> = {};
    const integrationKeys: (keyof TenantForm)[] = [
      "googleAdsApiKey", "googleAdsCustomerId", "googleAdsLoginCustomerId", "googleAdsDeveloperToken",
      "googleAdsRefreshToken", "googleAdsClientId", "googleAdsClientSecret",
      "callRailApiKey", "callRailSigningKey",
      "serviceTitanClientId", "serviceTitanClientSecret",
      "metaAccessToken", "metaAdAccountId", "metaPixelId",
      "podiumApiToken", "podiumLocationId",
    ];
    for (const key of integrationKeys) {
      if (clearedFields.has(key)) {
        config[key] = "__CLEAR__";
        continue;
      }
      const val = form[key];
      if (!val) continue;
      if (!dirtyFields.has(key) && (val.startsWith("••••") || val.startsWith("****"))) continue;
      config[key] = val;
    }
    return Object.keys(config).length > 0 ? config : undefined;
  };

  const handleCreate = async () => {
    const integrationConfig = buildIntegrationConfig();
    const body: Record<string, unknown> = {
      name: form.name,
      serviceTitanId: form.serviceTitanId || undefined,
      timezone: form.timezone,
    };
    if (integrationConfig) body.integrationConfig = integrationConfig;

    await fetch(`${API_BASE}/api/tenants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    setForm(emptyForm);
    setShowCreate(false);
    setShowIntegrationConfig(false);
    refetch();
  };

  const handleUpdate = async (id: number) => {
    const integrationConfig = buildIntegrationConfig();
    const body: Record<string, unknown> = {
      name: form.name,
      serviceTitanId: form.serviceTitanId || undefined,
      timezone: form.timezone,
    };
    if (integrationConfig) body.integrationConfig = integrationConfig;

    await fetch(`${API_BASE}/api/tenants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    setEditId(null);
    setShowIntegrationConfig(false);
    refetch();
  };

  const handleDelete = async (id: number) => {
    await deleteTenant.mutateAsync({ tenantId: id });
    refetch();
  };

  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());

  const startEdit = (tenant: unknown) => {
    const t = tenant as Record<string, unknown>;
    const lc = (t.loadableConfig || {}) as Record<string, string>;
    setEditId(t.id as number);
    setEditTenantName(t.name as string);
    setForm({
      name: (t.name as string) || "",
      serviceTitanId: (t.serviceTitanId as string) || "",
      timezone: (t.timezone as string) || "America/New_York",
      googleAdsApiKey: lc.googleAdsApiKey || "",
      googleAdsRefreshToken: lc.googleAdsRefreshToken || "",
      googleAdsClientId: lc.googleAdsClientId || "",
      googleAdsClientSecret: lc.googleAdsClientSecret || "",
      googleAdsCustomerId: lc.googleAdsCustomerId || "",
      googleAdsLoginCustomerId: lc.googleAdsLoginCustomerId || "",
      googleAdsDeveloperToken: lc.googleAdsDeveloperToken || "",
      callRailApiKey: lc.callRailApiKey || "",
      callRailSigningKey: lc.callRailSigningKey || "",
      serviceTitanClientId: lc.serviceTitanClientId || "",
      serviceTitanClientSecret: lc.serviceTitanClientSecret || "",
      metaAccessToken: lc.metaAccessToken || "",
      metaAdAccountId: lc.metaAdAccountId || "",
      metaPixelId: lc.metaPixelId || "",
      podiumApiToken: lc.podiumApiToken || "",
      podiumLocationId: lc.podiumLocationId || "",
    });
    setDirtyFields(new Set());
    setClearedFields(new Set());
    setShowIntegrationConfig(false);
    setEditTab("integrations");
  };

  const inputClass = "bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  const secretInputType = (field: string) => dirtyFields.has(field) ? "password" : "text";

  const handleSecretFocus = (field: keyof TenantForm) => {
    if (!dirtyFields.has(field) && form[field]?.startsWith("••••")) {
      trackFieldChange(field);
      setForm(f => ({ ...f, [field]: "" }));
    }
  };

  const [clearedFields, setClearedFields] = useState<Set<string>>(new Set());

  const handleClearSecret = (field: keyof TenantForm) => {
    trackFieldChange(field);
    setForm(f => ({ ...f, [field]: "" }));
    setClearedFields(prev => new Set(prev).add(field));
  };

  const SecretInput = ({ field, label, placeholder = "Enter to update" }: { field: keyof TenantForm; label: string; placeholder?: string }) => {
    const hasValue = form[field] && (form[field].startsWith("••••") || form[field].startsWith("****"));
    const isCleared = clearedFields.has(field);
    return (
      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">{label}</label>
        <div className="relative">
          <input type={secretInputType(field)} value={form[field] || ""} onFocus={() => handleSecretFocus(field)} onChange={(e) => { trackFieldChange(field); setClearedFields(prev => { const s = new Set(prev); s.delete(field); return s; }); setForm(f => ({ ...f, [field]: e.target.value })); }} placeholder={isCleared ? "Cleared — save to apply" : placeholder} className={inputClass + " w-full" + (isCleared ? " border-red-500/50" : "")} />
          {(hasValue || isCleared) && !isCleared && (
            <button type="button" onClick={() => handleClearSecret(field)} className="absolute right-2 top-1/2 -translate-y-1/2 text-red-400 hover:text-red-300 transition-colors" title="Clear this field">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {isCleared && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-red-400">cleared</span>}
        </div>
      </div>
    );
  };

  const IntegrationFields = () => (
    <div className="mt-4 border border-white/10 rounded-lg p-4 bg-background/30">
      <button
        type="button"
        onClick={() => setShowIntegrationConfig(!showIntegrationConfig)}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors w-full"
      >
        <Key className="w-4 h-4" />
        <span className="font-medium">Integration Configuration</span>
        <Shield className="w-3 h-3 text-emerald-400 ml-1" />
        <span className="text-xs text-emerald-400">encrypted at rest</span>
        {showIntegrationConfig ? <ChevronUp className="w-4 h-4 ml-auto" /> : <ChevronDown className="w-4 h-4 ml-auto" />}
      </button>
      {showIntegrationConfig && (
        <div className="space-y-6 mt-4">
          <div>
            <h4 className="text-xs font-medium text-blue-400 uppercase tracking-wider mb-3">ServiceTitan</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <SecretInput field="serviceTitanClientId" label="Client ID" />
              <SecretInput field="serviceTitanClientSecret" label="Client Secret" />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-medium text-yellow-400 uppercase tracking-wider">Google Ads</h4>
              {editId && (
                <button
                  type="button"
                  onClick={() => handleConnectGoogleAds(editId)}
                  disabled={googleAdsConnecting || !form.googleAdsClientId}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
                >
                  {googleAdsConnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Key className="w-3 h-3" />}
                  {form.googleAdsRefreshToken && !form.googleAdsRefreshToken.startsWith("••••") ? "Reconnect" : form.googleAdsRefreshToken ? "Reconnect" : "Connect Google Ads"}
                </button>
              )}
            </div>
            {googleAdsOAuthMessage && (
              <div className={`mb-3 p-3 rounded-lg text-xs ${googleAdsOAuthMessage.type === "success" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"}`}>
                {googleAdsOAuthMessage.type === "success" ? <CheckCircle className="w-3.5 h-3.5 inline mr-1.5" /> : <XCircle className="w-3.5 h-3.5 inline mr-1.5" />}
                {googleAdsOAuthMessage.text}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Customer ID</label>
                <input type="text" value={form.googleAdsCustomerId} onChange={(e) => { trackFieldChange("googleAdsCustomerId"); setForm(f => ({ ...f, googleAdsCustomerId: e.target.value })); }} placeholder="123-456-7890" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Manager Account ID (MCC)</label>
                <input type="text" value={form.googleAdsLoginCustomerId} onChange={(e) => { trackFieldChange("googleAdsLoginCustomerId"); setForm(f => ({ ...f, googleAdsLoginCustomerId: e.target.value })); }} placeholder="123-456-7890 (if using MCC login)" className={inputClass + " w-full"} />
              </div>
              <SecretInput field="googleAdsDeveloperToken" label="Developer Token" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
              <SecretInput field="googleAdsClientSecret" label="OAuth Client Secret" />
              <SecretInput field="googleAdsRefreshToken" label="Refresh Token (auto-filled on connect)" />
              <SecretInput field="googleAdsApiKey" label="Access Token (auto-filled on connect)" />
            </div>
            <p className="text-xs text-muted-foreground mt-2">Save Client ID and Client Secret first, then click "Connect Google Ads" to authorize. Tokens are obtained and refreshed automatically.</p>
          </div>
          <div>
            <h4 className="text-xs font-medium text-purple-400 uppercase tracking-wider mb-3">Meta (Facebook/Instagram)</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <SecretInput field="metaAccessToken" label="Access Token" />
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Ad Account ID</label>
                <input type="text" value={form.metaAdAccountId} onChange={(e) => { trackFieldChange("metaAdAccountId"); setForm(f => ({ ...f, metaAdAccountId: e.target.value })); }} placeholder="act_123456789" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Pixel ID</label>
                <input type="text" value={form.metaPixelId} onChange={(e) => { trackFieldChange("metaPixelId"); setForm(f => ({ ...f, metaPixelId: e.target.value })); }} placeholder="For CAPI events" className={inputClass + " w-full"} />
              </div>
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-green-400 uppercase tracking-wider mb-3">CallRail</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <SecretInput field="callRailApiKey" label="API Key" />
              <SecretInput field="callRailSigningKey" label="Webhook Signing Key" placeholder="HMAC verification key" />
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-cyan-400 uppercase tracking-wider mb-3">Podium</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <SecretInput field="podiumApiToken" label="API Token" />
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Location ID</label>
                <input type="text" value={form.podiumLocationId} onChange={(e) => { trackFieldChange("podiumLocationId"); setForm(f => ({ ...f, podiumLocationId: e.target.value })); }} placeholder="e.g. loc_abc123" className={inputClass + " w-full"} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const tabClass = (tab: EditTab) =>
    `px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${editTab === tab ? "bg-white/10 text-white border-b-2 border-primary" : "text-muted-foreground hover:text-white hover:bg-white/5"}`;

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Tenant Management</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">MANAGE HVAC CLIENT COMPANIES</p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setForm(emptyForm); setShowIntegrationConfig(false); }}
          className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-white font-medium px-5 py-2 rounded-lg transition-all shadow-[0_0_15px_rgba(242,5,5,0.3)]"
        >
          <Plus className="w-4 h-4" />
          Add Tenant
        </button>
      </header>

      {showCreate && (
        <PremiumCard className="p-6">
          <h3 className="font-display text-lg text-white mb-4">New Tenant — Onboarding</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input
              value={form.name}
              onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Company Name"
              className={inputClass}
            />
            <input
              value={form.serviceTitanId}
              onChange={(e) => setForm(f => ({ ...f, serviceTitanId: e.target.value }))}
              placeholder="ServiceTitan Tenant ID"
              className={inputClass}
            />
            <select
              value={form.timezone}
              onChange={(e) => setForm(f => ({ ...f, timezone: e.target.value }))}
              className={inputClass}
            >
              <option value="America/New_York">Eastern</option>
              <option value="America/Chicago">Central</option>
              <option value="America/Denver">Mountain</option>
              <option value="America/Los_Angeles">Pacific</option>
            </select>
          </div>
          <IntegrationFields />
          <div className="flex gap-2 mt-4">
            <button onClick={handleCreate} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm">
              <Check className="w-4 h-4" /> Create
            </button>
            <button onClick={() => { setShowCreate(false); setShowIntegrationConfig(false); }} className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-sm">
              <X className="w-4 h-4" /> Cancel
            </button>
          </div>
        </PremiumCard>
      )}

      <PremiumCard className="p-0 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">Loading tenants...</div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 bg-background/50">
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">ID</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">ServiceTitan Tenant ID</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Timezone</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Integrations</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {tenants?.map((tenant) => {
                const t = tenant as unknown as Record<string, unknown>;
                const tid = t.id as number;
                return (
                  <React.Fragment key={tid}>
                  <tr className={`hover:bg-white/[0.02] transition-colors ${editId === tid ? "bg-white/[0.03]" : ""}`}>
                    {editId === tid ? (
                      <>
                        <td className="p-4 text-sm text-muted-foreground">{tid}</td>
                        <td className="p-4">
                          <input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                            className="bg-background/50 border border-white/10 rounded px-2 py-1 text-white text-sm w-full" />
                        </td>
                        <td className="p-4">
                          <input value={form.serviceTitanId} onChange={(e) => setForm(f => ({ ...f, serviceTitanId: e.target.value }))}
                            className="bg-background/50 border border-white/10 rounded px-2 py-1 text-white text-sm w-full" />
                        </td>
                        <td className="p-4">
                          <select value={form.timezone} onChange={(e) => setForm(f => ({ ...f, timezone: e.target.value }))}
                            className="bg-background/50 border border-white/10 rounded px-2 py-1 text-white text-sm">
                            <option value="America/New_York">Eastern</option>
                            <option value="America/Chicago">Central</option>
                            <option value="America/Denver">Mountain</option>
                            <option value="America/Los_Angeles">Pacific</option>
                          </select>
                        </td>
                        <td className="p-4">
                          <Badge variant={t.hasIntegrationConfig ? "success" : "neutral"}>
                            {t.hasIntegrationConfig ? "Configured" : "None"}
                          </Badge>
                        </td>
                        <td className="p-4"><Badge variant={(t.isActive as boolean) ? "success" : "danger"}>{(t.isActive as boolean) ? "Active" : "Inactive"}</Badge></td>
                        <td className="p-4 text-right space-x-2">
                          <button onClick={() => handleUpdate(tid)} className="text-emerald-400 hover:text-emerald-300"><Check className="w-4 h-4 inline" /></button>
                          <button onClick={() => { setEditId(null); setShowIntegrationConfig(false); }} className="text-muted-foreground hover:text-white"><X className="w-4 h-4 inline" /></button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="p-4 text-sm text-muted-foreground">{tid}</td>
                        <td className="p-4 font-medium text-white">{t.name as string}</td>
                        <td className="p-4 text-sm text-muted-foreground">{(t.serviceTitanId as string) || "—"}</td>
                        <td className="p-4 text-sm text-muted-foreground">{t.timezone as string}</td>
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            <Badge variant={t.hasIntegrationConfig ? "success" : "neutral"}>
                              <Key className="w-3 h-3 inline mr-1" />
                              {t.hasIntegrationConfig ? "Configured" : "None"}
                            </Badge>
                            {Boolean(t.hasIntegrationConfig) && (
                              <button
                                onClick={() => setExpandedSyncTenant(expandedSyncTenant === tid ? null : tid)}
                                className="text-muted-foreground hover:text-white"
                                title="Sync Status"
                              >
                                <Activity className="w-4 h-4 inline" />
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="p-4"><Badge variant={(t.isActive as boolean) ? "success" : "danger"}>{(t.isActive as boolean) ? "Active" : "Inactive"}</Badge></td>
                        <td className="p-4 text-right space-x-2">
                          <button onClick={() => startEdit(t)} className="text-muted-foreground hover:text-white" title="Edit tenant">
                            <Settings className="w-4 h-4 inline" />
                          </button>
                          <button onClick={() => handleDelete(tid)} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-4 h-4 inline" /></button>
                        </td>
                      </>
                    )}
                  </tr>
                  {expandedSyncTenant === tid && !editId && (
                    <tr className="bg-white/[0.01]">
                      <td colSpan={7} className="px-6 py-4">
                        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Integration Sync Status</div>
                        {tenantSyncStatuses[tid] ? (
                          <div className="grid grid-cols-3 gap-4">
                            {Object.entries(tenantSyncStatuses[tid].statusByIntegration).map(([key, status]) => (
                              <div key={key} className="bg-background/50 border border-white/5 rounded-lg p-3">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-sm font-medium text-white capitalize">{key.replace(/_/g, " ")}</span>
                                  {status.lastStatus === "completed" ? (
                                    <CheckCircle className="w-4 h-4 text-emerald-400" />
                                  ) : status.lastStatus === "error" ? (
                                    <XCircle className="w-4 h-4 text-red-400" />
                                  ) : (
                                    <Activity className="w-4 h-4 text-muted-foreground" />
                                  )}
                                </div>
                                <div className="text-xs text-muted-foreground space-y-1">
                                  <div>Last Success: {status.lastSync ? new Date(status.lastSync).toLocaleString() : "Never"}</div>
                                  <div>Latest Run: <span className={status.lastStatus === "completed" ? "text-emerald-400" : status.lastStatus === "error" ? "text-red-400" : "text-muted-foreground"}>{status.lastStatus}</span></div>
                                  <div>Records: {status.lastRecords}</div>
                                  {status.errorCount > 0 && <div className="text-red-400">Errors (recent): {status.errorCount}</div>}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-sm text-muted-foreground">Loading sync status...</div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </PremiumCard>

      {editId && (
        <PremiumCard className="p-0 overflow-hidden">
          <div className="px-6 pt-5 pb-0">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg text-white">
                Editing: <span className="text-primary">{editTenantName}</span>
              </h3>
              <button
                onClick={() => { setEditId(null); setShowIntegrationConfig(false); }}
                className="text-muted-foreground hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex gap-1 border-b border-white/10">
              <button onClick={() => setEditTab("integrations")} className={tabClass("integrations")}>
                <Key className="w-3.5 h-3.5 inline mr-1.5" />Integrations
              </button>
              <button onClick={() => setEditTab("alerts")} className={tabClass("alerts")}>
                <Bell className="w-3.5 h-3.5 inline mr-1.5" />Client Alerts
              </button>
              <button onClick={() => setEditTab("scripts")} className={tabClass("scripts")}>
                <Code className="w-3.5 h-3.5 inline mr-1.5" />Capture Scripts
              </button>
              <button onClick={() => setEditTab("leaderboard")} className={tabClass("leaderboard")}>
                <Trophy className="w-3.5 h-3.5 inline mr-1.5" />Leaderboard
              </button>
            </div>
          </div>
          <div className="p-6">
            {editTab === "integrations" && (
              <div>
                <p className="text-sm text-muted-foreground mb-4">Fill in only the fields you want to update. Leave blank to keep existing values.</p>
                <IntegrationFields />
                <div className="flex gap-2 mt-4">
                  <button onClick={() => handleUpdate(editId)} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm">
                    <Check className="w-4 h-4" /> Save Changes
                  </button>
                </div>
              </div>
            )}
            {editTab === "alerts" && (
              <TenantAlertConfig tenantId={editId} apiBase={API_BASE} />
            )}
            {editTab === "scripts" && (
              <TenantCaptureScripts tenantId={editId} tenantName={editTenantName} apiBase={API_BASE} />
            )}
            {editTab === "leaderboard" && (
              <TenantLeaderboardConfig tenantId={editId} apiBase={API_BASE} />
            )}
          </div>
        </PremiumCard>
      )}
    </div>
  );
}

function TenantAlertConfig({ tenantId, apiBase }: { tenantId: number; apiBase: string }) {
  const [config, setConfig] = useState<AlertConfig>({ ...defaultAlertConfig });
  const [newEmail, setNewEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`${apiBase}/api/tenants/${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then((data: Record<string, unknown>) => {
        const ac = data.alertConfig as AlertConfig | null;
        setConfig(ac ? { ...defaultAlertConfig, ...ac } : { ...defaultAlertConfig });
      })
      .catch(() => setConfig({ ...defaultAlertConfig }))
      .finally(() => setLoading(false));
  }, [tenantId, apiBase]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ alertConfig: config }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { /* ignore */ }
    setSaving(false);
  };

  const addRecipient = () => {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@") || config.recipients.includes(email)) return;
    setConfig(c => ({ ...c, recipients: [...c.recipients, email] }));
    setNewEmail("");
  };

  const removeRecipient = (email: string) => {
    setConfig(c => ({ ...c, recipients: c.recipients.filter(e => e !== email) }));
  };

  const inputClass = "bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  if (loading) return <div className="text-sm text-muted-foreground">Loading alert config...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig(c => ({ ...c, enabled: e.target.checked }))}
            className="w-4 h-4 rounded border-white/20 accent-primary"
          />
          <span className="text-sm text-white">Alerts Enabled</span>
        </label>
      </div>

      <div className="border border-white/10 rounded-lg p-4 bg-background/30 space-y-4">
        <h4 className="text-xs font-medium text-amber-400 uppercase tracking-wider flex items-center gap-2">
          <Mail className="w-3.5 h-3.5" /> Email Recipients
        </h4>
        <div className="flex gap-2">
          <input
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addRecipient()}
            placeholder="Add email address"
            className={inputClass + " flex-1"}
          />
          <button onClick={addRecipient} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm">
            <Plus className="w-4 h-4" />
          </button>
        </div>
        {config.recipients.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {config.recipients.map((email) => (
              <span key={email} className="inline-flex items-center gap-1 px-3 py-1 bg-white/5 border border-white/10 rounded-full text-sm text-white">
                {email}
                <button onClick={() => removeRecipient(email)} className="text-muted-foreground hover:text-red-400">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No recipients — alerts will be sent to tenant client_admin users by default.</p>
        )}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground uppercase tracking-wider">Agency Sender Email</label>
          <input
            value={config.agencySenderEmail}
            onChange={(e) => setConfig(c => ({ ...c, agencySenderEmail: e.target.value }))}
            placeholder="e.g. alerts@hvaclaunch.com (defaults to SMTP_FROM)"
            className={inputClass + " w-full"}
          />
        </div>
      </div>

      <div className="border border-white/10 rounded-lg p-4 bg-background/30">
        <h4 className="text-xs font-medium text-amber-400 uppercase tracking-wider mb-3">Alert Thresholds</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className={`space-y-1 p-3 rounded-lg border ${config.leadDropEnabled ? "border-white/10 bg-white/[0.02]" : "border-white/5 bg-white/[0.01] opacity-50"}`}>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-muted-foreground">Lead Drop %</label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={config.leadDropEnabled} onChange={(e) => setConfig(c => ({ ...c, leadDropEnabled: e.target.checked }))} className="w-3.5 h-3.5 rounded border-white/20 accent-amber-400" />
                <span className="text-[10px] text-muted-foreground uppercase">{config.leadDropEnabled ? "On" : "Off"}</span>
              </label>
            </div>
            <input type="number" min="0" max="100" value={config.leadDropThreshold} onChange={(e) => setConfig(c => ({ ...c, leadDropThreshold: Number(e.target.value) }))} disabled={!config.leadDropEnabled} className={inputClass + " w-full disabled:opacity-40 disabled:cursor-not-allowed"} />
          </div>
          <div className={`space-y-1 p-3 rounded-lg border ${config.bookingRateEnabled ? "border-white/10 bg-white/[0.02]" : "border-white/5 bg-white/[0.01] opacity-50"}`}>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-muted-foreground">Min Booking Rate %</label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={config.bookingRateEnabled} onChange={(e) => setConfig(c => ({ ...c, bookingRateEnabled: e.target.checked }))} className="w-3.5 h-3.5 rounded border-white/20 accent-amber-400" />
                <span className="text-[10px] text-muted-foreground uppercase">{config.bookingRateEnabled ? "On" : "Off"}</span>
              </label>
            </div>
            <input type="number" min="0" max="100" value={config.bookingRateThreshold} onChange={(e) => setConfig(c => ({ ...c, bookingRateThreshold: Number(e.target.value) }))} disabled={!config.bookingRateEnabled} className={inputClass + " w-full disabled:opacity-40 disabled:cursor-not-allowed"} />
          </div>
          <div className={`space-y-1 p-3 rounded-lg border ${config.roasEnabled ? "border-white/10 bg-white/[0.02]" : "border-white/5 bg-white/[0.01] opacity-50"}`}>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-muted-foreground">Min ROAS (x)</label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={config.roasEnabled} onChange={(e) => setConfig(c => ({ ...c, roasEnabled: e.target.checked }))} className="w-3.5 h-3.5 rounded border-white/20 accent-amber-400" />
                <span className="text-[10px] text-muted-foreground uppercase">{config.roasEnabled ? "On" : "Off"}</span>
              </label>
            </div>
            <input type="number" min="0" step="0.1" value={config.roasThreshold} onChange={(e) => setConfig(c => ({ ...c, roasThreshold: Number(e.target.value) }))} disabled={!config.roasEnabled} className={inputClass + " w-full disabled:opacity-40 disabled:cursor-not-allowed"} />
          </div>
          <div className={`space-y-1 p-3 rounded-lg border ${config.spendSpikeEnabled ? "border-white/10 bg-white/[0.02]" : "border-white/5 bg-white/[0.01] opacity-50"}`}>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-muted-foreground">Spend Spike %</label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={config.spendSpikeEnabled} onChange={(e) => setConfig(c => ({ ...c, spendSpikeEnabled: e.target.checked }))} className="w-3.5 h-3.5 rounded border-white/20 accent-amber-400" />
                <span className="text-[10px] text-muted-foreground uppercase">{config.spendSpikeEnabled ? "On" : "Off"}</span>
              </label>
            </div>
            <input type="number" min="0" max="500" value={config.spendSpikeThreshold} onChange={(e) => setConfig(c => ({ ...c, spendSpikeThreshold: Number(e.target.value) }))} disabled={!config.spendSpikeEnabled} className={inputClass + " w-full disabled:opacity-40 disabled:cursor-not-allowed"} />
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm disabled:opacity-50"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
        {saved ? "Saved!" : "Save Alert Config"}
      </button>
    </div>
  );
}

interface FunnelScript {
  id: number;
  name: string;
  slug: string;
  script: string;
}

function TenantCaptureScripts({ tenantId, tenantName, apiBase }: { tenantId: number; tenantName: string; apiBase: string }) {
  const [scriptData, setScriptData] = useState<{ script: string; funnelScripts: FunnelScript[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${apiBase}/api/funnel-types/script/${tenantId}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) setScriptData({ script: data.script, funnelScripts: data.funnelScripts || [] });
        else setScriptData(null);
      })
      .catch(() => setScriptData(null))
      .finally(() => setLoading(false));
  }, [tenantId, apiBase]);

  const handleCopy = async (text: string, id: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {}
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading capture scripts...</div>;
  if (!scriptData) return <p className="text-sm text-muted-foreground">No script data available for this tenant.</p>;

  return (
    <div className="space-y-4">
      <div className="border border-white/10 rounded-lg p-4 bg-background/30">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Base Script (no funnel)</p>
          <button
            onClick={() => handleCopy(scriptData.script, `base-${tenantId}`)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm text-white transition-all shrink-0 ml-4"
          >
            {copiedId === `base-${tenantId}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedId === `base-${tenantId}` ? "Copied!" : "Copy"}
          </button>
        </div>
        <div className="bg-background border border-white/10 rounded-lg p-4 font-mono text-sm text-emerald-400 overflow-x-auto">
          <pre>{scriptData.script}</pre>
        </div>
      </div>

      {scriptData.funnelScripts.length > 0 && (
        <div className="border border-white/10 rounded-lg p-4 bg-background/30">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Per-Funnel Scripts ({scriptData.funnelScripts.length})</p>
          <div className="space-y-2">
            {scriptData.funnelScripts.map(fs => (
              <div key={fs.id} className="flex items-start gap-3">
                <div className="flex-1 bg-background border border-white/10 rounded-lg p-3 font-mono text-xs text-cyan-400 overflow-x-auto">
                  <span className="text-muted-foreground text-[10px] block mb-1">{fs.name}</span>
                  {fs.script}
                </div>
                <button
                  onClick={() => handleCopy(fs.script, `funnel-${tenantId}-${fs.id}`)}
                  className="mt-1 p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-white"
                  title="Copy"
                >
                  {copiedId === `funnel-${tenantId}-${fs.id}` ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {scriptData.funnelScripts.length === 0 && (
        <p className="text-sm text-muted-foreground">No funnels assigned to this tenant. Assign funnels on the Funnels page.</p>
      )}
    </div>
  );
}

interface LeaderboardConfigData {
  visible: boolean;
  displayMode: "named" | "anonymized";
}

function TenantLeaderboardConfig({ tenantId, apiBase }: { tenantId: number; apiBase: string }) {
  const [config, setConfig] = useState<LeaderboardConfigData>({ visible: false, displayMode: "anonymized" });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`${apiBase}/api/tenants/${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then((data: Record<string, unknown>) => {
        const lc = data.leaderboardConfig as LeaderboardConfigData | null;
        if (lc) {
          setConfig({ visible: Boolean(lc.visible), displayMode: lc.displayMode === "named" ? "named" : "anonymized" });
        } else {
          setConfig({ visible: false, displayMode: "anonymized" });
        }
      })
      .catch(() => setConfig({ visible: false, displayMode: "anonymized" }))
      .finally(() => setLoading(false));
  }, [tenantId, apiBase]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ leaderboardConfig: config }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {}
    setSaving(false);
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading leaderboard config...</div>;

  return (
    <div className="space-y-6">
      <div className="border border-white/10 rounded-lg p-4 bg-background/30 space-y-4">
        <h4 className="text-xs font-medium text-amber-400 uppercase tracking-wider flex items-center gap-2">
          <Trophy className="w-3.5 h-3.5" /> Client Portal Visibility
        </h4>
        <p className="text-sm text-muted-foreground">
          Control whether this client can see the cross-client performance leaderboard in their portal.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={config.visible}
            onChange={(e) => setConfig(c => ({ ...c, visible: e.target.checked }))}
            className="w-4 h-4 rounded border-white/20 accent-primary"
          />
          <span className="text-sm text-white">Show Leaderboard in Client Portal</span>
        </label>
      </div>

      {config.visible && (
        <div className="border border-white/10 rounded-lg p-4 bg-background/30 space-y-4">
          <h4 className="text-xs font-medium text-amber-400 uppercase tracking-wider">Display Mode</h4>
          <p className="text-sm text-muted-foreground">
            Choose whether this client sees real company names or anonymized labels on the leaderboard.
          </p>
          <div className="flex gap-3">
            <label
              className={`flex-1 flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                config.displayMode === "named"
                  ? "border-primary/40 bg-primary/10"
                  : "border-white/10 bg-white/[0.02] hover:border-white/20"
              }`}
            >
              <input
                type="radio"
                name="displayMode"
                value="named"
                checked={config.displayMode === "named"}
                onChange={() => setConfig(c => ({ ...c, displayMode: "named" }))}
                className="accent-primary"
              />
              <div>
                <p className="text-sm text-white font-medium">Named</p>
                <p className="text-xs text-muted-foreground">Real company names visible</p>
              </div>
            </label>
            <label
              className={`flex-1 flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                config.displayMode === "anonymized"
                  ? "border-primary/40 bg-primary/10"
                  : "border-white/10 bg-white/[0.02] hover:border-white/20"
              }`}
            >
              <input
                type="radio"
                name="displayMode"
                value="anonymized"
                checked={config.displayMode === "anonymized"}
                onChange={() => setConfig(c => ({ ...c, displayMode: "anonymized" }))}
                className="accent-primary"
              />
              <div>
                <p className="text-sm text-white font-medium">Anonymized</p>
                <p className="text-xs text-muted-foreground">Names replaced with "Client A", "Client B", etc.</p>
              </div>
            </label>
          </div>
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm disabled:opacity-50"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Trophy className="w-4 h-4" />}
        {saved ? "Saved!" : "Save Leaderboard Settings"}
      </button>
    </div>
  );
}
