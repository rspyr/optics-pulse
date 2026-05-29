import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useCreateTenant, useUpdateTenant, useDeleteTenant } from "@workspace/api-client-react";
import { useAuth } from "@/components/auth-context";
import { useTenants, type TenantOption } from "@/hooks/use-tenants";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { Plus, Edit2, X, Check, Trash2, Key, ChevronDown, ChevronUp, Shield, Activity, CheckCircle, XCircle, Bell, Mail, Loader2, Copy, Code, Settings, Trophy, Pause, Play, Info } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

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
  callRailAccountId: string;
  callRailCompanyId: string;
  callRailTrackingNumber: string;
  serviceTitanClientId: string;
  serviceTitanClientSecret: string;
  serviceTitanAppKey: string;
  metaAccessToken: string;
  metaAdAccountId: string;
  metaPixelId: string;
  googleAdsCustomerId: string;
  googleAdsLoginCustomerId: string;
  googleAdsDeveloperToken: string;
  podiumApiToken: string;
  podiumLocationId: string;
  monthlyBudget: string;
  isDemo: boolean;
}

// Subset of TenantForm fields that are guaranteed to be strings (everything
// except `isDemo`). Used by integration/secret helpers below so that
// `form[field]` narrows to `string` instead of `string | boolean`.
type SecretField = Exclude<keyof TenantForm, "isDemo">;

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
  callRailAccountId: "",
  callRailCompanyId: "",
  callRailTrackingNumber: "",
  serviceTitanClientId: "",
  serviceTitanClientSecret: "",
  serviceTitanAppKey: "",
  metaAccessToken: "",
  metaAdAccountId: "",
  metaPixelId: "",
  googleAdsCustomerId: "",
  googleAdsLoginCustomerId: "",
  googleAdsDeveloperToken: "",
  podiumApiToken: "",
  podiumLocationId: "",
  monthlyBudget: "",
  isDemo: false,
};

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type EditTab = "integrations" | "alerts" | "scripts" | "leaderboard" | "maintenance";

function SetupGuide({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border border-white/10 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
      >
        <Info className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">{title}</span>
        <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="px-4 pb-3 text-xs text-muted-foreground leading-relaxed space-y-2 border-t border-white/10 pt-3">
          {children}
        </div>
      )}
    </div>
  );
}

function CopyableUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 bg-white/5 rounded px-2 py-0.5 font-mono text-[11px] text-white/80 break-all">
      {url}
      <button
        type="button"
        onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        className="shrink-0 hover:text-white transition-colors"
        title="Copy to clipboard"
      >
        {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
      </button>
    </span>
  );
}

export default function AdminTenants() {
  const { tenants: allTenants, tenantsLoading: isLoading, refetchTenants } = useTenants<TenantOption & Record<string, unknown>>();
  const refetch = refetchTenants;
  const createTenant = useCreateTenant();
  const updateTenant = useUpdateTenant();
  const deleteTenant = useDeleteTenant();

  // Honor the agency-wide tenant scope. When the operator has picked a
  // specific tenant from /internal (or anywhere else), narrow the list here to
  // that one row so the page acts like a per-tenant detail view. "All Tenants"
  // (null) restores the full list.
  const { selectedTenantId: globalTenantId, setSelectedTenantId } = useAuth();
  const tenants = useMemo(() => {
    if (!allTenants) return allTenants;
    if (globalTenantId == null) return allTenants;
    return allTenants.filter((t) => (t as unknown as { id: number }).id === globalTenantId);
  }, [allTenants, globalTenantId]);
  const scopedTenantName = useMemo(() => {
    if (globalTenantId == null) return null;
    const match = allTenants?.find((t) => (t as unknown as { id: number }).id === globalTenantId);
    return (match as unknown as { name?: string } | undefined)?.name ?? `Tenant #${globalTenantId}`;
  }, [allTenants, globalTenantId]);

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
  const [googleAdsSyncing, setGoogleAdsSyncing] = useState(false);
  const [googleAdsSyncMessage, setGoogleAdsSyncMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [metaConnecting, setMetaConnecting] = useState(false);
  const [metaOAuthMessage, setMetaOAuthMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [loadedConfig, setLoadedConfig] = useState<Record<string, string>>({});
  const [togglingStSync, setTogglingStSync] = useState<number | null>(null);

  const handleToggleStSync = async (tenantId: number, currentlyPaused: boolean) => {
    setTogglingStSync(tenantId);
    try {
      await fetch(`${API_BASE}/api/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stSyncPaused: !currentlyPaused }),
      });
      refetch();
    } catch { /* ignore */ }
    setTogglingStSync(null);
  };

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

    const metaResult = params.get("metaOAuth");
    if (metaResult === "success") {
      setMetaOAuthMessage({ type: "success", text: "Meta connected successfully! Access token saved." });
      refetch();
      const url = new URL(window.location.href);
      url.searchParams.delete("metaOAuth");
      url.searchParams.delete("tenantId");
      window.history.replaceState({}, "", url.pathname + url.search);
    } else if (metaResult === "error") {
      const message = params.get("message") || "Unknown error";
      const readable: Record<string, string> = {
        token_exchange_failed: "Failed to exchange authorization code for access token.",
        server_missing_app_credentials: "The server is missing META_APP_ID / META_APP_SECRET. Contact the administrator.",
        token_verification_failed: "Meta returned an invalid access token. Please retry.",
        invalid_state: "Security validation failed. Please try again.",
      };
      setMetaOAuthMessage({ type: "error", text: readable[message] || `OAuth error: ${message}` });
      const url = new URL(window.location.href);
      url.searchParams.delete("metaOAuth");
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

  const handleGoogleAdsSyncNow = async (tenantId: number) => {
    setGoogleAdsSyncing(true);
    setGoogleAdsSyncMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/integrations/sync/google_ads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tenantId }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        setGoogleAdsSyncMessage({ type: "error", text: json.error || `HTTP ${res.status}` });
      } else {
        setGoogleAdsSyncMessage({ type: "success", text: `Synced ${json.synced ?? json.records ?? 0} campaign-day rows` });
        refetch();
      }
    } catch (e) {
      setGoogleAdsSyncMessage({ type: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setGoogleAdsSyncing(false);
    }
  };

  const handleConnectMeta = async (tenantId: number) => {
    setMetaConnecting(true);
    setMetaOAuthMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/oauth/meta/authorize?tenantId=${tenantId}`, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json();
        setMetaOAuthMessage({ type: "error", text: data.error || "Failed to start OAuth flow" });
        return;
      }
      const { authUrl } = await res.json();
      window.open(authUrl, "_blank");
    } catch {
      setMetaOAuthMessage({ type: "error", text: "Network error starting OAuth flow" });
    } finally {
      setMetaConnecting(false);
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
    const integrationKeys: SecretField[] = [
      "googleAdsApiKey", "googleAdsCustomerId", "googleAdsLoginCustomerId", "googleAdsDeveloperToken",
      "googleAdsRefreshToken", "googleAdsClientId", "googleAdsClientSecret",
      "callRailApiKey", "callRailSigningKey", "callRailAccountId", "callRailCompanyId", "callRailTrackingNumber",
      "serviceTitanClientId", "serviceTitanClientSecret", "serviceTitanAppKey",
      "metaAccessToken", "metaAdAccountId", "metaPixelId",
      "podiumApiToken", "podiumLocationId",
    ];
    for (const key of integrationKeys) {
      if (clearedFields.has(key)) {
        config[key] = "__CLEAR__";
        continue;
      }
      const val = form[key];
      if (!val || typeof val !== "string") continue;
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
      isDemo: form.isDemo,
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
      isDemo: form.isDemo,
    };
    // Whole dollars; blank clears the override (null → falls back to default).
    const trimmedBudget = form.monthlyBudget.trim();
    if (trimmedBudget === "") {
      body.monthlyBudget = null;
    } else {
      const parsed = Math.round(Number(trimmedBudget));
      if (Number.isFinite(parsed) && parsed >= 0) body.monthlyBudget = parsed;
    }
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
      callRailAccountId: lc.callRailAccountId || "",
      callRailCompanyId: lc.callRailCompanyId || "",
      callRailTrackingNumber: lc.callRailTrackingNumber || "",
      serviceTitanClientId: lc.serviceTitanClientId || "",
      serviceTitanClientSecret: lc.serviceTitanClientSecret || "",
      serviceTitanAppKey: lc.serviceTitanAppKey || "",
      metaAccessToken: lc.metaAccessToken || "",
      metaAdAccountId: lc.metaAdAccountId || "",
      metaPixelId: lc.metaPixelId || "",
      podiumApiToken: lc.podiumApiToken || "",
      podiumLocationId: lc.podiumLocationId || "",
      monthlyBudget: t.monthlyBudget != null ? String(t.monthlyBudget) : "",
      isDemo: Boolean(t.isDemo),
    });
    setDirtyFields(new Set());
    setClearedFields(new Set());
    setShowIntegrationConfig(false);
    setEditTab("integrations");
    setLoadedConfig(lc as Record<string, string>);
  };

  // Server-truth: was this field non-empty when the tenant was loaded?
  // loadableConfig returns "••••XXXX" for masked secrets and the raw value otherwise — both truthy.
  const isSaved = (field: string): boolean => {
    const v = loadedConfig[field];
    return typeof v === "string" && v.length > 0;
  };
  const hasUserEntered = (field: SecretField): boolean => {
    const v = form[field];
    if (typeof v !== "string" || v.length === 0) return false;
    if (clearedFields.has(field)) return false;
    return !v.startsWith("••••") && !v.startsWith("****");
  };
  const fieldReady = (field: SecretField): boolean =>
    hasUserEntered(field) || (isSaved(field) && !clearedFields.has(field));

  const inputClass = "bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  const secretInputType = (field: string) => dirtyFields.has(field) ? "password" : "text";

  const handleSecretFocus = (field: SecretField) => {
    if (!dirtyFields.has(field) && form[field]?.startsWith("••••")) {
      trackFieldChange(field);
      setForm(f => ({ ...f, [field]: "" }));
    }
  };

  const [clearedFields, setClearedFields] = useState<Set<string>>(new Set());

  const handleClearSecret = (field: SecretField) => {
    trackFieldChange(field);
    setForm(f => ({ ...f, [field]: "" }));
    setClearedFields(prev => new Set(prev).add(field));
  };

  const SecretInput = ({ field, label, placeholder = "Enter to update" }: { field: SecretField; label: string; placeholder?: string }) => {
    const hasValue = form[field] && (form[field].startsWith("••••") || form[field].startsWith("****"));
    const isCleared = clearedFields.has(field);
    const saved = isSaved(field);
    const entered = hasUserEntered(field);
    return (
      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
          <span>{label}</span>
          {entered && !isCleared ? (
            <span className="text-[10px] font-normal normal-case text-blue-300/80 bg-blue-500/10 px-1.5 rounded">new</span>
          ) : isCleared ? (
            <span className="text-[10px] font-normal normal-case text-red-300/80 bg-red-500/10 px-1.5 rounded">cleared</span>
          ) : saved ? (
            <span className="text-[10px] font-normal normal-case text-emerald-300/80 bg-emerald-500/10 px-1.5 rounded">saved</span>
          ) : (
            <span className="text-[10px] font-normal normal-case text-muted-foreground/60">not set</span>
          )}
        </label>
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
              <SecretInput field="serviceTitanAppKey" label="App Key" />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-medium text-yellow-400 uppercase tracking-wider">Google Ads</h4>
              {editId && (() => {
                const gaReady = fieldReady("googleAdsClientId") && fieldReady("googleAdsClientSecret");
                const gaConnected = isSaved("googleAdsRefreshToken");
                const gaCustomerIdReady = fieldReady("googleAdsCustomerId");
                const gaDevTokenReady = fieldReady("googleAdsDeveloperToken");
                const missing: string[] = [];
                if (!fieldReady("googleAdsClientId")) missing.push("OAuth Client ID");
                if (!fieldReady("googleAdsClientSecret")) missing.push("OAuth Client Secret");
                const syncTitle = !gaConnected
                  ? "Connect Google Ads first"
                  : !gaCustomerIdReady
                    ? "Save a Customer ID first"
                    : !gaDevTokenReady
                      ? "Save a Developer Token first"
                      : "Run a one-off Google Ads sync now (also runs hourly)";
                return (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleGoogleAdsSyncNow(editId)}
                      disabled={googleAdsSyncing || googleAdsConnecting || !gaConnected || !gaCustomerIdReady || !gaDevTokenReady}
                      title={syncTitle}
                      className="text-[11px] text-emerald-400 hover:text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {googleAdsSyncing ? "Syncing…" : "Sync now"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConnectGoogleAds(editId)}
                      disabled={googleAdsConnecting || !gaReady}
                      title={gaReady ? "" : `Save ${missing.join(" and ")} first, then click to authorize`}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
                    >
                      {googleAdsConnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Key className="w-3 h-3" />}
                      {gaConnected ? "Reconnect Google Ads" : "Connect Google Ads"}
                    </button>
                  </div>
                );
              })()}
            </div>
            {googleAdsOAuthMessage && (
              <div className={`mb-3 p-3 rounded-lg text-xs ${googleAdsOAuthMessage.type === "success" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"}`}>
                {googleAdsOAuthMessage.type === "success" ? <CheckCircle className="w-3.5 h-3.5 inline mr-1.5" /> : <XCircle className="w-3.5 h-3.5 inline mr-1.5" />}
                {googleAdsOAuthMessage.text}
              </div>
            )}
            {googleAdsSyncMessage && (
              <div className={`mb-3 text-xs ${googleAdsSyncMessage.type === "success" ? "text-emerald-400" : "text-red-400"}`}>
                {googleAdsSyncMessage.text}
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
              <SecretInput field="googleAdsClientId" label="OAuth Client ID" />
              <SecretInput field="googleAdsClientSecret" label="OAuth Client Secret" />
              <SecretInput field="googleAdsRefreshToken" label="Refresh Token (auto-filled on connect)" />
              <SecretInput field="googleAdsApiKey" label="Access Token (auto-filled on connect)" />
            </div>
            <p className="text-xs text-muted-foreground mt-2">Save Client ID and Client Secret first, then click "Connect Google Ads" to authorize. Tokens are obtained and refreshed automatically.</p>
          </div>
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-medium text-purple-400 uppercase tracking-wider">Meta (Facebook/Instagram)</h4>
              {editId && (() => {
                const metaConnected = isSaved("metaAccessToken");
                return (
                  <button
                    type="button"
                    onClick={() => handleConnectMeta(editId)}
                    disabled={metaConnecting}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border border-purple-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
                  >
                    {metaConnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Key className="w-3 h-3" />}
                    {metaConnected ? "Reconnect Meta" : "Connect Meta"}
                  </button>
                );
              })()}
            </div>
            {metaOAuthMessage && (
              <div className={`mb-3 p-3 rounded-lg text-xs ${metaOAuthMessage.type === "success" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"}`}>
                {metaOAuthMessage.type === "success" ? <CheckCircle className="w-3.5 h-3.5 inline mr-1.5" /> : <XCircle className="w-3.5 h-3.5 inline mr-1.5" />}
                {metaOAuthMessage.text}
              </div>
            )}
            {editId && <MetaAdAccountPicker tenantId={editId} apiBase={API_BASE} currentAdAccountId={form.metaAdAccountId} onChange={(id) => { setForm(f => ({ ...f, metaAdAccountId: id })); refetch(); }} />}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
              <SecretInput field="metaAccessToken" label="Access Token (auto-filled on connect)" />
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Pixel ID (optional, for CAPI)</label>
                <input type="text" value={form.metaPixelId} onChange={(e) => { trackFieldChange("metaPixelId"); setForm(f => ({ ...f, metaPixelId: e.target.value })); }} placeholder="For CAPI events" className={inputClass + " w-full"} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">Click "Connect Meta" to authorize. We exchange for a long-lived token (~60 days), then auto-discover the ad accounts your login can access. Pick the one to sync from the dropdown above. If the token expires, this section shows a "Reconnect required" badge and the nightly sync skips this tenant until you reconnect.</p>
          </div>
          <div>
            <h4 className="text-xs font-medium text-green-400 uppercase tracking-wider mb-3">CallRail</h4>
            {editId && <CallRailWebhookStatus tenantId={editId} apiBase={API_BASE} />}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <SecretInput field="callRailApiKey" label="API Key" />
              <SecretInput field="callRailSigningKey" label="Webhook Signing Key" placeholder="HMAC verification key" />
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Account ID</label>
                <input type="text" value={form.callRailAccountId} onChange={(e) => { trackFieldChange("callRailAccountId"); setForm(f => ({ ...f, callRailAccountId: e.target.value })); }} placeholder="e.g. 123456789" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Company ID</label>
                <input type="text" value={form.callRailCompanyId} onChange={(e) => { trackFieldChange("callRailCompanyId"); setForm(f => ({ ...f, callRailCompanyId: e.target.value })); }} placeholder="e.g. COM123456" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Tracking Number (optional)</label>
                <input type="text" value={form.callRailTrackingNumber} onChange={(e) => { trackFieldChange("callRailTrackingNumber"); setForm(f => ({ ...f, callRailTrackingNumber: e.target.value })); }} placeholder="e.g. +18005551234" className={inputClass + " w-full"} />
                <p className="text-[11px] text-muted-foreground mt-1">Reference field for the tracking number assigned to this tenant. Outbound SMS via CallRail is not yet wired up.</p>
              </div>
            </div>
            <SetupGuide title="CallRail Setup Instructions">
              <p className="font-medium text-white/90">1. Generate an API Key</p>
              <p>In CallRail, go to <span className="text-white/80">Settings → API Access</span>. Click <span className="text-white/80">"Create API V3 Key"</span>. Copy the key and paste it into the <span className="text-white/80">API Key</span> field above. (Optional today — webhooks below are the only intake path; the API key is reserved for future backfill/reconciliation tooling.)</p>
              <p className="font-medium text-white/90 pt-1">2. Find your Account ID &amp; Company ID</p>
              <p>Your <span className="text-white/80">Account ID</span> is in the URL when logged into CallRail (e.g. <span className="font-mono text-[11px]">app.callrail.com/a/<strong>123456789</strong>/…</span>). The <span className="text-white/80">Company ID</span> can be found under <span className="text-white/80">Settings → Companies</span> — click a company and note the ID from the URL.</p>
              <p className="font-medium text-white/90 pt-1">3. Add the Webhook URL</p>
              <p>In CallRail, go to <span className="text-white/80">Account → Integrations → Webhooks</span>. Find the <span className="text-white/80">Post-Call</span> event and click <span className="text-white/80">+ Add Another URL</span>. Paste this tenant-scoped URL:</p>
              <CopyableUrl url={`${window.location.origin}/api/webhooks/callrail/${editId || "<TENANT_ID>"}`} />
              <p className="text-white/60 italic">CallRail sends its own fixed JSON payload — you do not need to configure body fields, a <span className="font-mono text-[11px]">source</span> value, or a <span className="font-mono text-[11px]">tenantId</span> field. The tenant is identified by the URL above. The CallRail call <span className="font-mono text-[11px]">id</span> in the payload is used to de-duplicate retries.</p>
              <p className="font-medium text-white/90 pt-1">4. Copy the Webhook Signing Key</p>
              <p>On the same Webhooks page, expand <span className="text-white/80">Advanced settings</span> at the bottom. Copy the value of <span className="text-white/80">Webhook signature Secret Token</span> and paste it into the <span className="text-white/80">Webhook Signing Key</span> field above. This signs every webhook with HMAC-SHA1 so we can verify it's authentic — webhooks without a valid signature are rejected.</p>
              <p className="font-medium text-white/90 pt-1">5. Activate the integration</p>
              <p>Back at the top of the Webhooks page, the <span className="text-white/80">Webhooks integration</span> badge must show <span className="text-white/80">Active</span>. If it says <span className="text-white/80">Inactive</span>, click into it and enable it — webhooks will not fire otherwise.</p>
              <p className="font-medium text-white/90 pt-1">6. Other event types (optional)</p>
              <p>Only the <span className="text-white/80">Post-Call</span> event is wired up today. Pre-Call, Call Routing Complete, Call Modified, Outbound, and Text Message events are not consumed yet — adding URLs to those will not break anything but will be ignored.</p>
            </SetupGuide>
          </div>
          <div>
            <h4 className="text-xs font-medium text-cyan-400 uppercase tracking-wider mb-2">Podium</h4>
            <p className="text-xs text-muted-foreground">Podium is connected per user. Each CSR and admin manages their own Podium connection from their Settings page.</p>
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

      {scopedTenantName && (
        <PremiumCard className="p-3 border-primary/30 bg-primary/[0.04]">
          <div className="flex items-center gap-3 flex-wrap text-sm">
            <span className="text-xs text-white/40 uppercase tracking-wider">Scoped to</span>
            <span className="font-medium text-white">{scopedTenantName}</span>
            <span className="text-xs text-white/40">
              — only this tenant is shown. The Agency God View tenant filter is driving this scope.
            </span>
            <button
              type="button"
              onClick={() => setSelectedTenantId(null)}
              className="ml-auto text-xs text-primary hover:text-primary/80 underline decoration-dotted"
            >
              Show all tenants
            </button>
          </div>
        </PremiumCard>
      )}

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
            <Select value={form.timezone} onValueChange={(v) => setForm(f => ({ ...f, timezone: v }))}>
              <SelectTrigger className={inputClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="America/New_York">Eastern</SelectItem>
                <SelectItem value="America/Chicago">Central</SelectItem>
                <SelectItem value="America/Denver">Mountain</SelectItem>
                <SelectItem value="America/Los_Angeles">Pacific</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <IntegrationFields />
          <div className="mt-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.isDemo}
                onChange={(e) => setForm(f => ({ ...f, isDemo: e.target.checked }))}
                className="rounded border-white/20 bg-white/5"
              />
              <span className="text-sm text-muted-foreground">Demo tenant (receives simulated leads and data)</span>
            </label>
          </div>
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
          <div className="p-6">
            <div className="animate-pulse space-y-3">
              <div className="h-4 w-1/3 bg-white/10 rounded" />
              <div className="h-3 w-1/2 bg-white/5 rounded" />
              <div className="h-3 w-2/5 bg-white/5 rounded" />
            </div>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 bg-background/50">
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">ID</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">ServiceTitan Tenant ID</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Timezone</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Monthly Budget</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Integrations</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">ST Sync</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Mode</th>
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
                          <Select value={form.timezone} onValueChange={(v) => setForm(f => ({ ...f, timezone: v }))}>
                            <SelectTrigger className="bg-background/50 border border-white/10 rounded px-2 py-1 text-white text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="America/New_York">Eastern</SelectItem>
                              <SelectItem value="America/Chicago">Central</SelectItem>
                              <SelectItem value="America/Denver">Mountain</SelectItem>
                              <SelectItem value="America/Los_Angeles">Pacific</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="p-4">
                          <div className="relative">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={form.monthlyBudget}
                              onChange={(e) => setForm(f => ({ ...f, monthlyBudget: e.target.value }))}
                              placeholder="Default"
                              className="bg-background/50 border border-white/10 rounded pl-5 pr-2 py-1 text-white text-sm w-28"
                            />
                          </div>
                        </td>
                        <td className="p-4">
                          <Badge variant={t.hasIntegrationConfig ? "success" : "neutral"}>
                            {t.hasIntegrationConfig ? "Configured" : "None"}
                          </Badge>
                        </td>
                        <td className="p-4">
                          <Badge variant={(t.stSyncPaused as boolean) ? "danger" : "success"}>
                            {(t.stSyncPaused as boolean) ? "Paused" : "Active"}
                          </Badge>
                        </td>
                        <td className="p-4"><Badge variant={(t.isActive as boolean) ? "success" : "danger"}>{(t.isActive as boolean) ? "Active" : "Inactive"}</Badge></td>
                        <td className="p-4">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={form.isDemo || false}
                              onChange={(e) => setForm({ ...form, isDemo: e.target.checked })}
                              className="rounded border-white/20 bg-white/5"
                            />
                            <span className="text-xs text-muted-foreground">Demo</span>
                          </label>
                        </td>
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
                        <td className="p-4 text-sm">
                          {t.monthlyBudget != null ? (
                            <span className="text-white">${Number(t.monthlyBudget).toLocaleString()}</span>
                          ) : (
                            <span className="text-muted-foreground italic">Default</span>
                          )}
                        </td>
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
                        <td className="p-4">
                          <button
                            onClick={() => handleToggleStSync(tid, t.stSyncPaused as boolean)}
                            disabled={togglingStSync === tid}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                              (t.stSyncPaused as boolean)
                                ? "bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20"
                                : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20"
                            } disabled:opacity-50`}
                            title={(t.stSyncPaused as boolean) ? "Click to resume ServiceTitan sync" : "Click to pause ServiceTitan sync"}
                          >
                            {togglingStSync === tid ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (t.stSyncPaused as boolean) ? (
                              <Pause className="w-3 h-3" />
                            ) : (
                              <Play className="w-3 h-3" />
                            )}
                            {(t.stSyncPaused as boolean) ? "Paused" : "Active"}
                          </button>
                        </td>
                        <td className="p-4"><Badge variant={(t.isActive as boolean) ? "success" : "danger"}>{(t.isActive as boolean) ? "Active" : "Inactive"}</Badge></td>
                        <td className="p-4"><Badge variant={(t.isDemo as boolean) ? "warning" : "neutral"}>{(t.isDemo as boolean) ? "Demo" : "Production"}</Badge></td>
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
                      <td colSpan={10} className="px-6 py-4">
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
              <button onClick={() => setEditTab("maintenance")} className={tabClass("maintenance")}>
                <Settings className="w-3.5 h-3.5 inline mr-1.5" />Maintenance
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
            {editTab === "maintenance" && (
              <TenantMaintenance tenantId={editId} apiBase={API_BASE} />
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

interface CallRailStatus {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  lastCallId: string | null;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

interface MetaAdAccountRow {
  accountId: string;
  name: string;
  currency: string;
  isSelected: boolean;
}
interface MetaAdAccountResponse {
  selectedAdAccountId: string | null;
  needsReconnect: boolean;
  accounts: MetaAdAccountRow[];
}

function MetaAdAccountPicker({ tenantId, apiBase, currentAdAccountId, onChange }: {
  tenantId: number;
  apiBase: string;
  currentAdAccountId: string;
  onChange: (id: string) => void;
}) {
  const [data, setData] = useState<MetaAdAccountResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inputClass = "bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = `${apiBase}/api/integrations/meta/ad-accounts?tenantId=${tenantId}${refresh ? "&refresh=1" : ""}`;
      const res = await fetch(url, { credentials: "include" });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || `HTTP ${res.status}`);
        if (json) setData((prev) => prev ?? { selectedAdAccountId: null, needsReconnect: !!json.needsReconnect, accounts: [] });
        return;
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(false); }, [tenantId]);

  const handleSelect = async (accountId: string) => {
    if (!accountId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/integrations/meta/ad-accounts/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tenantId, accountId }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json?.error || `HTTP ${res.status}`); return; }
      onChange(json.selectedAdAccountId || `act_${accountId}`);
      await load(false);
    } finally {
      setBusy(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch(`${apiBase}/api/integrations/sync/meta`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tenantId }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        setSyncMessage({ type: "error", text: json.error || `HTTP ${res.status}` });
      } else {
        setSyncMessage({ type: "success", text: `Synced ${json.synced} ad-day rows` });
        await load(false);
      }
    } catch (e) {
      setSyncMessage({ type: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSyncing(false);
    }
  };

  const accounts = data?.accounts || [];
  const selectedNoPrefix = (data?.selectedAdAccountId || currentAdAccountId || "").replace(/^act_/, "");

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground uppercase tracking-wider">Ad Account</label>
        <div className="flex items-center gap-2">
          {data?.needsReconnect && (
            <span
              className="px-2 py-0.5 rounded-md bg-red-500/15 text-red-400 text-[10px] font-medium border border-red-500/30"
              title="Meta access token has expired or been revoked. Click Reconnect Meta above. Nightly sync skips this tenant until you reconnect."
            >
              Reconnect required
            </span>
          )}
          <button
            type="button"
            onClick={() => load(true)}
            disabled={loading || busy || syncing}
            className="text-[11px] text-purple-400 hover:text-purple-300 disabled:opacity-50"
          >
            {loading ? "Refreshing…" : "Refresh from Meta"}
          </button>
          <button
            type="button"
            onClick={handleSyncNow}
            disabled={syncing || loading || busy || data?.needsReconnect || !selectedNoPrefix}
            title={data?.needsReconnect ? "Reconnect Meta first" : !selectedNoPrefix ? "Pick an ad account first" : "Run a one-off Meta sync now (also runs nightly at 1 AM ET)"}
            className="text-[11px] text-emerald-400 hover:text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>
      {syncMessage && (
        <div className={`text-xs ${syncMessage.type === "success" ? "text-emerald-400" : "text-red-400"}`}>{syncMessage.text}</div>
      )}
      {accounts.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          {loading ? "Loading…" : "No ad accounts discovered yet. Connect Meta, then click \"Refresh from Meta\"."}
        </div>
      ) : (
        <select
          value={selectedNoPrefix}
          onChange={(e) => handleSelect(e.target.value)}
          disabled={busy}
          className={inputClass + " w-full"}
        >
          <option value="">-- Select an ad account --</option>
          {accounts.map((a) => (
            <option key={a.accountId} value={a.accountId}>
              {a.name || "(unnamed)"} — act_{a.accountId} ({a.currency}){a.isSelected ? " ✓" : ""}
            </option>
          ))}
        </select>
      )}
      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}

function CallRailWebhookStatus({ tenantId, apiBase }: { tenantId: number; apiBase: string }) {
  const [status, setStatus] = useState<CallRailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/tenants/${tenantId}/callrail-status`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CallRailStatus;
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status");
    } finally {
      setLoading(false);
    }
  }, [tenantId, apiBase]);

  useEffect(() => { load(); }, [load]);

  const lastSuccess = status?.lastSuccessAt ? new Date(status.lastSuccessAt).getTime() : 0;
  const lastFailure = status?.lastFailureAt ? new Date(status.lastFailureAt).getTime() : 0;
  const isHealthy = lastSuccess > 0 && lastSuccess >= lastFailure;
  const isFailing = lastFailure > 0 && lastFailure > lastSuccess;
  const hasNeverFired = !lastSuccess && !lastFailure;

  return (
    <div className="mb-3 p-3 rounded-lg border border-white/10 bg-white/[0.02]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`shrink-0 w-2.5 h-2.5 rounded-full ${
              isHealthy ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]"
                : isFailing ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.7)]"
                : "bg-white/30"
            }`}
            aria-hidden
          />
          <div className="text-xs min-w-0">
            {loading && <span className="text-muted-foreground">Checking webhook status…</span>}
            {!loading && error && <span className="text-red-400">Failed to load status: {error}</span>}
            {!loading && !error && hasNeverFired && (
              <span className="text-muted-foreground">No CallRail webhooks received yet. Trigger a test call from CallRail to verify the URL and signing key.</span>
            )}
            {!loading && !error && isHealthy && (
              <span className="text-emerald-300">
                Last successful webhook {formatRelativeTime(status?.lastSuccessAt ?? null)}
                {status?.lastCallId ? <span className="text-muted-foreground"> · call {status.lastCallId}</span> : null}
              </span>
            )}
            {!loading && !error && isFailing && (
              <span className="text-red-300 break-words">
                Last webhook rejected {formatRelativeTime(status?.lastFailureAt ?? null)}
                {status?.lastFailureReason ? <span className="text-red-200/80"> — {status.lastFailureReason}</span> : null}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="shrink-0 text-[11px] text-muted-foreground hover:text-white px-2 py-1 rounded border border-white/10 hover:bg-white/5 disabled:opacity-50"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}

interface BackfillDefaultFunnelResult {
  tenantId: number;
  defaultFunnelName: string | null;
  candidateEvents: number;
  clearedEvents: number;
  clearedLeads: number;
  leadsSkippedDueToOverride: number;
  leadsSkippedDueToLaterMatch: number;
  dryRun: boolean;
}

export function TenantMaintenance({ tenantId, apiBase }: { tenantId: number; apiBase: string }) {
  const [running, setRunning] = useState<"idle" | "dryRun" | "writing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<BackfillDefaultFunnelResult | null>(null);
  const [writeResult, setWriteResult] = useState<BackfillDefaultFunnelResult | null>(null);

  const runBackfill = async (dryRun: boolean): Promise<BackfillDefaultFunnelResult | null> => {
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/admin/backfill-default-funnel/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ dryRun }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError((data as { error?: string }).error ?? `Request failed (${res.status})`);
        return null;
      }
      return data as BackfillDefaultFunnelResult;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
      return null;
    }
  };

  const handleDryRun = async () => {
    setRunning("dryRun");
    setWriteResult(null);
    const result = await runBackfill(true);
    if (result) setDryRunResult(result);
    setRunning("idle");
  };

  const handleConfirm = async () => {
    if (!dryRunResult) return;
    const ok = window.confirm(
      `This will clear resolved_funnel on ${dryRunResult.candidateEvents} event(s) and reset lead funnel on up to ${dryRunResult.clearedLeads} lead(s). Continue?`,
    );
    if (!ok) return;
    setRunning("writing");
    const result = await runBackfill(false);
    if (result) {
      setWriteResult(result);
      setDryRunResult(null);
    }
    setRunning("idle");
  };

  const handleReset = () => {
    setDryRunResult(null);
    setWriteResult(null);
    setError(null);
  };

  const summary = writeResult ?? dryRunResult;
  const noCandidates = summary !== null && summary.candidateEvents === 0;
  const showConfirm = dryRunResult !== null && !writeResult && dryRunResult.candidateEvents > 0;

  return (
    <div className="space-y-6">
      <div className="border border-white/10 rounded-lg p-4 bg-background/30 space-y-4">
        <div>
          <h4 className="text-xs font-medium text-amber-400 uppercase tracking-wider flex items-center gap-2">
            <Settings className="w-3.5 h-3.5" /> Backfill default-funnel events
          </h4>
          <p className="text-sm text-muted-foreground mt-2">
            One-shot cleanup for events whose <span className="font-mono text-[11px] text-white/80">resolved_funnel</span> was stamped purely by the old "first active funnel" fallback. Re-runs the live resolver and clears values that no longer match any rule. Idempotent — once cleared, future runs find 0 candidates.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleDryRun}
            disabled={running !== "idle"}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
          >
            {running === "dryRun" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
            {dryRunResult || writeResult ? "Re-run dry run" : "Run dry run"}
          </button>
          {showConfirm && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={running !== "idle"}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
            >
              {running === "writing" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Confirm &amp; clear {dryRunResult.candidateEvents} event(s)
            </button>
          )}
          {noCandidates && !writeResult && (
            <button
              type="button"
              disabled
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 text-muted-foreground border border-white/10 cursor-not-allowed flex items-center gap-1.5"
              title="Nothing to clean up"
            >
              <CheckCircle className="w-3 h-3" /> 0 candidates
            </button>
          )}
          {(dryRunResult || writeResult || error) && (
            <button
              type="button"
              onClick={handleReset}
              className="text-[11px] text-muted-foreground hover:text-white px-2 py-1 rounded border border-white/10 hover:bg-white/5"
            >
              Reset
            </button>
          )}
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 text-red-300 border border-red-500/20 text-xs flex items-start gap-2">
            <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {summary && (
          <div className={`rounded-lg border p-3 ${writeResult ? "bg-emerald-500/5 border-emerald-500/20" : "bg-blue-500/5 border-blue-500/20"}`}>
            <div className="flex items-center gap-2 mb-3 text-xs font-medium">
              {writeResult ? (
                <>
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-300">Cleanup complete</span>
                </>
              ) : (
                <>
                  <Info className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-blue-300">Dry run — no changes written</span>
                </>
              )}
              {summary.defaultFunnelName ? (
                <span className="text-muted-foreground">
                  · default funnel: <span className="text-white/80 font-mono text-[11px]">{summary.defaultFunnelName}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">· no default funnel found</span>
              )}
            </div>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <SummaryRow label="Candidate events" value={summary.candidateEvents} />
              <SummaryRow label={writeResult ? "Events cleared" : "Events that would clear"} value={summary.clearedEvents} />
              <SummaryRow label={writeResult ? "Leads reset" : "Leads that would reset"} value={summary.clearedLeads} />
              <SummaryRow label="Leads skipped (override)" value={summary.leadsSkippedDueToOverride} muted />
              <SummaryRow label="Leads skipped (later match)" value={summary.leadsSkippedDueToLaterMatch} muted />
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 pb-1.5">
      <dt className={muted ? "text-muted-foreground" : "text-white/70"}>{label}</dt>
      <dd className={`font-mono ${muted ? "text-muted-foreground" : "text-white"}`}>{value}</dd>
    </div>
  );
}
