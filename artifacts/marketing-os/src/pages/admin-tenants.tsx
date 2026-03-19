import React, { useState, useEffect, useCallback } from "react";
import { useListTenants, useCreateTenant, useUpdateTenant, useDeleteTenant } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { Plus, Edit2, X, Check, Trash2, Key, ChevronDown, ChevronUp, Shield, Activity, CheckCircle, XCircle, Bell, Mail, Loader2, Copy, Code } from "lucide-react";

interface TenantForm {
  name: string;
  serviceTitanId: string;
  timezone: string;
  googleAdsApiKey: string;
  callRailApiKey: string;
  callRailSigningKey: string;
  serviceTitanClientId: string;
  serviceTitanClientSecret: string;
  metaAccessToken: string;
  metaAdAccountId: string;
  metaPixelId: string;
  googleAdsCustomerId: string;
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
  callRailApiKey: "",
  callRailSigningKey: "",
  serviceTitanClientId: "",
  serviceTitanClientSecret: "",
  metaAccessToken: "",
  metaAdAccountId: "",
  metaPixelId: "",
  googleAdsCustomerId: "",
  googleAdsDeveloperToken: "",
  podiumApiToken: "",
  podiumLocationId: "",
};

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export default function AdminTenants() {
  const { data: tenants, isLoading, refetch } = useListTenants();
  const createTenant = useCreateTenant();
  const updateTenant = useUpdateTenant();
  const deleteTenant = useDeleteTenant();

  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<TenantForm>(emptyForm);
  const [showIntegrationConfig, setShowIntegrationConfig] = useState(false);
  const [expandedSyncTenant, setExpandedSyncTenant] = useState<number | null>(null);
  const [tenantSyncStatuses, setTenantSyncStatuses] = useState<Record<number, { statusByIntegration: Record<string, { lastSync: string | null; lastStatus: string; lastRecords: number; errorCount: number }> }>>({});

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

  const buildIntegrationConfig = () => {
    const config: Record<string, string> = {};
    if (form.googleAdsApiKey) config.googleAdsApiKey = form.googleAdsApiKey;
    if (form.googleAdsCustomerId) config.googleAdsCustomerId = form.googleAdsCustomerId;
    if (form.googleAdsDeveloperToken) config.googleAdsDeveloperToken = form.googleAdsDeveloperToken;
    if (form.callRailApiKey) config.callRailApiKey = form.callRailApiKey;
    if (form.callRailSigningKey) config.callRailSigningKey = form.callRailSigningKey;
    if (form.serviceTitanClientId) config.serviceTitanClientId = form.serviceTitanClientId;
    if (form.serviceTitanClientSecret) config.serviceTitanClientSecret = form.serviceTitanClientSecret;
    if (form.metaAccessToken) config.metaAccessToken = form.metaAccessToken;
    if (form.metaAdAccountId) config.metaAdAccountId = form.metaAdAccountId;
    if (form.metaPixelId) config.metaPixelId = form.metaPixelId;
    if (form.podiumApiToken) config.podiumApiToken = form.podiumApiToken;
    if (form.podiumLocationId) config.podiumLocationId = form.podiumLocationId;
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

  const startEdit = (tenant: unknown) => {
    const t = tenant as Record<string, unknown>;
    setEditId(t.id as number);
    setForm({
      name: (t.name as string) || "",
      serviceTitanId: (t.serviceTitanId as string) || "",
      timezone: (t.timezone as string) || "America/New_York",
      googleAdsApiKey: "",
      googleAdsCustomerId: "",
      googleAdsDeveloperToken: "",
      callRailApiKey: "",
      callRailSigningKey: "",
      serviceTitanClientId: "",
      serviceTitanClientSecret: "",
      metaAccessToken: "",
      metaAdAccountId: "",
      metaPixelId: "",
      podiumApiToken: "",
      podiumLocationId: "",
    });
    setShowIntegrationConfig(false);
  };

  const inputClass = "bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

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
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Client ID</label>
                <input type="password" value={form.serviceTitanClientId} onChange={(e) => setForm(f => ({ ...f, serviceTitanClientId: e.target.value }))} placeholder="Enter to update" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Client Secret</label>
                <input type="password" value={form.serviceTitanClientSecret} onChange={(e) => setForm(f => ({ ...f, serviceTitanClientSecret: e.target.value }))} placeholder="Enter to update" className={inputClass + " w-full"} />
              </div>
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-yellow-400 uppercase tracking-wider mb-3">Google Ads</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Access Token / API Key</label>
                <input type="password" value={form.googleAdsApiKey} onChange={(e) => setForm(f => ({ ...f, googleAdsApiKey: e.target.value }))} placeholder="Enter to update" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Customer ID</label>
                <input type="password" value={form.googleAdsCustomerId} onChange={(e) => setForm(f => ({ ...f, googleAdsCustomerId: e.target.value }))} placeholder="123-456-7890" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Developer Token</label>
                <input type="password" value={form.googleAdsDeveloperToken} onChange={(e) => setForm(f => ({ ...f, googleAdsDeveloperToken: e.target.value }))} placeholder="Enter to update" className={inputClass + " w-full"} />
              </div>
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-purple-400 uppercase tracking-wider mb-3">Meta (Facebook/Instagram)</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Access Token</label>
                <input type="password" value={form.metaAccessToken} onChange={(e) => setForm(f => ({ ...f, metaAccessToken: e.target.value }))} placeholder="Enter to update" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Ad Account ID</label>
                <input type="password" value={form.metaAdAccountId} onChange={(e) => setForm(f => ({ ...f, metaAdAccountId: e.target.value }))} placeholder="act_123456789" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Pixel ID</label>
                <input type="password" value={form.metaPixelId} onChange={(e) => setForm(f => ({ ...f, metaPixelId: e.target.value }))} placeholder="For CAPI events" className={inputClass + " w-full"} />
              </div>
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-green-400 uppercase tracking-wider mb-3">CallRail</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">API Key</label>
                <input type="password" value={form.callRailApiKey} onChange={(e) => setForm(f => ({ ...f, callRailApiKey: e.target.value }))} placeholder="Enter to update" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Webhook Signing Key</label>
                <input type="password" value={form.callRailSigningKey} onChange={(e) => setForm(f => ({ ...f, callRailSigningKey: e.target.value }))} placeholder="HMAC verification key" className={inputClass + " w-full"} />
              </div>
            </div>
          </div>
          <div>
            <h4 className="text-xs font-medium text-cyan-400 uppercase tracking-wider mb-3">Podium</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">API Token</label>
                <input type="password" value={form.podiumApiToken} onChange={(e) => setForm(f => ({ ...f, podiumApiToken: e.target.value }))} placeholder="Enter to update" className={inputClass + " w-full"} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Location ID</label>
                <input type="text" value={form.podiumLocationId} onChange={(e) => setForm(f => ({ ...f, podiumLocationId: e.target.value }))} placeholder="e.g. loc_abc123" className={inputClass + " w-full"} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

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
              placeholder="ServiceTitan ID"
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
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">ServiceTitan ID</th>
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
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    {editId === (t.id as number) ? (
                      <>
                        <td className="p-4 text-sm text-muted-foreground">{t.id as number}</td>
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
                          <button onClick={() => handleUpdate(t.id as number)} className="text-emerald-400 hover:text-emerald-300"><Check className="w-4 h-4 inline" /></button>
                          <button onClick={() => { setEditId(null); setShowIntegrationConfig(false); }} className="text-muted-foreground hover:text-white"><X className="w-4 h-4 inline" /></button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="p-4 text-sm text-muted-foreground">{t.id as number}</td>
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
                          <button onClick={() => startEdit(t)} className="text-muted-foreground hover:text-white"><Edit2 className="w-4 h-4 inline" /></button>
                          <button onClick={() => handleDelete(t.id as number)} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-4 h-4 inline" /></button>
                        </td>
                      </>
                    )}
                  </tr>
                  {expandedSyncTenant === (t.id as number) && (
                    <tr className="bg-white/[0.01]">
                      <td colSpan={7} className="px-6 py-4">
                        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Integration Sync Status</div>
                        {tenantSyncStatuses[t.id as number] ? (
                          <div className="grid grid-cols-3 gap-4">
                            {Object.entries(tenantSyncStatuses[t.id as number].statusByIntegration).map(([key, status]) => (
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
        <PremiumCard className="p-6">
          <h3 className="font-display text-lg text-white mb-2">Update Integration Config</h3>
          <p className="text-sm text-muted-foreground mb-4">Fill in only the fields you want to update. Leave blank to keep existing values.</p>
          <IntegrationFields />
          <div className="flex gap-2 mt-4">
            <button onClick={() => handleUpdate(editId)} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm">
              <Check className="w-4 h-4" /> Save Changes
            </button>
          </div>
        </PremiumCard>
      )}

      <AlertConfigSection tenants={tenants || []} apiBase={API_BASE} />
      <CaptureScriptSection tenants={tenants || []} apiBase={API_BASE} />
    </div>
  );
}

function AlertConfigSection({ tenants, apiBase }: { tenants: unknown[]; apiBase: string }) {
  const [selectedTenantId, setSelectedTenantId] = useState<number | "">("");
  const [config, setConfig] = useState<AlertConfig>({ ...defaultAlertConfig });
  const [newEmail, setNewEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!selectedTenantId) return;
    setLoading(true);
    fetch(`${apiBase}/api/tenants/${selectedTenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then((data: Record<string, unknown>) => {
        const ac = data.alertConfig as AlertConfig | null;
        setConfig(ac ? { ...defaultAlertConfig, ...ac } : { ...defaultAlertConfig });
      })
      .catch(() => setConfig({ ...defaultAlertConfig }))
      .finally(() => setLoading(false));
  }, [selectedTenantId, apiBase]);

  const handleSave = async () => {
    if (!selectedTenantId) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/tenants/${selectedTenantId}`, {
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

  return (
    <PremiumCard className="p-6">
      <div className="flex items-center gap-3 mb-4">
        <Bell className="w-5 h-5 text-amber-400" />
        <h3 className="font-display text-lg text-white">Client Alert Configuration</h3>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Select Tenant</label>
            <select
              value={selectedTenantId}
              onChange={(e) => setSelectedTenantId(e.target.value ? Number(e.target.value) : "")}
              className={inputClass + " w-full"}
            >
              <option value="">Choose tenant...</option>
              {tenants.map((t) => {
                const tenant = t as Record<string, unknown>;
                return <option key={tenant.id as number} value={tenant.id as number}>{tenant.name as string}</option>;
              })}
            </select>
          </div>
          <div className="flex items-end">
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
        </div>

        {selectedTenantId && !loading && (
          <>
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
          </>
        )}
        {loading && <div className="text-sm text-muted-foreground">Loading alert config...</div>}
      </div>
    </PremiumCard>
  );
}

function CaptureScriptSection({ tenants, apiBase }: { tenants: unknown[]; apiBase: string }) {
  const [selectedTenantId, setSelectedTenantId] = useState<number | "">("");
  const [scriptTag, setScriptTag] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!selectedTenantId) { setScriptTag(""); return; }
    setLoading(true);
    fetch(`${apiBase}/api/funnel-types/script/${selectedTenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => setScriptTag(data.script || ""))
      .catch(() => setScriptTag(`<script src="${window.location.origin}/tracker.js" data-tenant="${selectedTenantId}"></script>`))
      .finally(() => setLoading(false));
  }, [selectedTenantId, apiBase]);

  const handleCopy = async () => {
    if (!scriptTag) return;
    try {
      await navigator.clipboard.writeText(scriptTag);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const inputClass = "bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";

  return (
    <PremiumCard className="p-6">
      <div className="flex items-center gap-3 mb-4">
        <Code className="w-5 h-5 text-emerald-400" />
        <h3 className="font-display text-lg text-white">Capture Scripts</h3>
      </div>

      <div className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground uppercase tracking-wider">Select Tenant</label>
          <select
            value={selectedTenantId}
            onChange={(e) => setSelectedTenantId(e.target.value ? Number(e.target.value) : "")}
            className={inputClass + " w-full md:w-1/2"}
          >
            <option value="">Choose tenant...</option>
            {tenants.map((t) => {
              const tenant = t as Record<string, unknown>;
              return <option key={tenant.id as number} value={tenant.id as number}>{tenant.name as string}</option>;
            })}
          </select>
        </div>

        {selectedTenantId && !loading && scriptTag && (
          <div className="border border-white/10 rounded-lg p-4 bg-background/30">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-muted-foreground">Install this script in the &lt;head&gt; of the client's website to enable GCLID capture and heartbeat monitoring.</p>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm text-white transition-all shrink-0 ml-4"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="bg-background border border-white/10 rounded-lg p-4 font-mono text-sm text-emerald-400 overflow-x-auto">
              <pre>{scriptTag}</pre>
            </div>
          </div>
        )}
        {loading && <div className="text-sm text-muted-foreground">Loading script...</div>}
        {!selectedTenantId && <p className="text-sm text-muted-foreground">Select a tenant to view their capture script tag.</p>}
      </div>
    </PremiumCard>
  );
}
