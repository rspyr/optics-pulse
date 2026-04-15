import { useState, useEffect } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Plus, Pencil, Trash2, X, Save, Copy, Check, Wifi, WifiOff, Link, Unlink } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

interface FunnelType {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
}

interface Tenant {
  id: number;
  name: string;
  clientSlug: string;
}

interface TrackerHealth {
  tenantId: number;
  tenantName: string;
  isHealthy: boolean;
  lastSeen: string | null;
  domain: string | null;
}

export default function AdminFunnels() {
  const [funnels, setFunnels] = useState<FunnelType[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [health, setHealth] = useState<TrackerHealth[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", slug: "", description: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [tab, setTab] = useState<"funnels" | "assignments" | "health" | "tracking">("funnels");

  useEffect(() => {
    fetch(`${API}/api/tenants`, { credentials: "include" }).then(r => r.json()).then(setTenants).catch(() => {});
    fetch(`${API}/api/collect/health`, { credentials: "include" }).then(r => r.json()).then(setHealth).catch(() => {});
  }, []);

  const loadFunnels = () => {
    fetch(`${API}/api/funnel-types`, { credentials: "include" }).then(r => r.json()).then(setFunnels).catch(() => {});
  };

  useEffect(() => { loadFunnels(); }, []);

  function openNew() {
    setForm({ name: "", slug: "", description: "" });
    setEditingId(null);
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(ft: FunnelType) {
    setForm({ name: ft.name, slug: ft.slug, description: ft.description || "" });
    setEditingId(ft.id);
    setFormError(null);
    setShowForm(true);
  }

  async function handleSave() {
    setFormError(null);
    const method = editingId ? "PUT" : "POST";
    const url = editingId ? `${API}/api/funnel-types/${editingId}` : `${API}/api/funnel-types`;
    const body = editingId
      ? { name: form.name, description: form.description }
      : { name: form.name, slug: form.slug, description: form.description };

    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) });
    if (res.ok) {
      setShowForm(false);
      loadFunnels();
    } else {
      const err = await res.json().catch(() => ({ error: "Save failed" }));
      setFormError(err.error || "Save failed");
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this funnel type? This will remove it from all tenant assignments.")) return;
    await fetch(`${API}/api/funnel-types/${id}`, { method: "DELETE", credentials: "include" });
    setFunnels(funnels.filter(f => f.id !== id));
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Funnel & Tracking Management</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">MANAGE FUNNEL TYPES, TENANT ASSIGNMENTS, TRACKING & HEALTH</p>
        </div>
      </header>

      <div className="flex gap-2">
        {(["funnels", "assignments", "health", "tracking"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t ? "bg-white/10 text-white" : "text-muted-foreground hover:text-white"}`}>
            {t === "funnels" ? "Funnel Types" : t === "assignments" ? "Tenant Assignments" : t === "health" ? "Tracker Health" : "GTM Tracking"}
          </button>
        ))}
      </div>

      {tab === "funnels" && (
        <>
          <div className="flex items-center gap-3">
            <button onClick={openNew} className="bg-primary hover:bg-primary/90 text-white font-medium px-4 py-2 rounded-lg flex items-center gap-2 transition-all shadow-[0_0_15px_rgba(242,5,5,0.3)]">
              <Plus className="w-4 h-4" /> Add Funnel Type
            </button>
          </div>

          {showForm && (
            <PremiumCard className="p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-display text-lg text-white">{editingId ? "Edit" : "New"} Funnel Type</h3>
                <button onClick={() => setShowForm(false)} className="text-muted-foreground hover:text-white"><X className="w-5 h-5" /></button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-sm text-gray-300">Name</label>
                  <input type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value, ...(!editingId ? { slug: e.target.value.toLowerCase().replace(/\s+/g, "-") } : {})})} placeholder="e.g., Fit Funnel" className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5" />
                </div>
                <div className="space-y-1">
                  <label className="text-sm text-gray-300">Slug {editingId && <span className="text-xs text-amber-400 ml-1">(locked)</span>}</label>
                  <input type="text" value={form.slug} onChange={e => setForm({...form, slug: e.target.value})} placeholder="e.g., fit-funnel" disabled={!!editingId} className={`w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5 ${editingId ? "opacity-50 cursor-not-allowed" : ""}`} />
                  {editingId && <p className="text-xs text-amber-400/70 mt-1">Slugs cannot be changed after creation to protect installed tracking tags</p>}
                </div>
                <div className="space-y-1 md:col-span-2">
                  <label className="text-sm text-gray-300">Description</label>
                  <textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} rows={2} placeholder="Describe this funnel type..." className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5 resize-none" />
                </div>
              </div>
              {formError && <p className="mt-3 text-sm text-red-400">{formError}</p>}
              <div className="mt-4 flex justify-end">
                <button onClick={handleSave} className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-2.5 rounded-lg flex items-center gap-2"><Save className="w-4 h-4" /> {editingId ? "Update" : "Create"}</button>
              </div>
            </PremiumCard>
          )}

          <PremiumCard>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10 text-left">
                    <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                    <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Slug</th>
                    <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {funnels.length === 0 ? (
                    <tr><td colSpan={4} className="py-12 text-center text-muted-foreground">No funnel types yet.</td></tr>
                  ) : funnels.map(ft => (
                    <tr key={ft.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="py-3 px-4 text-sm text-white font-medium">{ft.name}</td>
                      <td className="py-3 px-4 text-sm text-muted-foreground font-mono">{ft.slug}</td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-1 text-xs rounded-full ${ft.isActive ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                          {ft.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <button onClick={() => openEdit(ft)} className="p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-white"><Pencil className="w-4 h-4" /></button>
                          <button onClick={() => handleDelete(ft.id)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PremiumCard>
        </>
      )}

      {tab === "assignments" && (
        <TenantAssignmentsTab tenants={tenants} funnels={funnels} />
      )}

      {tab === "health" && (
        <TrackerHealthTab health={health} onRefresh={async () => {
          const r = await fetch(`${API}/api/collect/health`, { credentials: "include" });
          const data = await r.json();
          setHealth(data);
        }} />
      )}

      {tab === "tracking" && <AdminTrackingPanel tenants={tenants} />}
    </div>
  );
}

function TenantAssignmentsTab({ tenants, funnels }: { tenants: Tenant[]; funnels: FunnelType[] }) {
  const [assignments, setAssignments] = useState<Record<number, number[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetches = tenants.map(t =>
      fetch(`${API}/api/tenants/${t.id}/funnel-types`, { credentials: "include" })
        .then(r => r.ok ? r.json() : [])
        .then((types: FunnelType[]) => ({ tid: t.id, ids: types.map((ft: FunnelType) => ft.id) }))
        .catch(() => ({ tid: t.id, ids: [] as number[] }))
    );
    Promise.all(fetches).then(results => {
      const map: Record<number, number[]> = {};
      for (const r of results) map[r.tid] = r.ids;
      setAssignments(map);
    }).finally(() => setLoading(false));
  }, [tenants]);

  async function toggleAssignment(tenantId: number, funnelTypeId: number) {
    const current = assignments[tenantId] || [];
    const isAssigned = current.includes(funnelTypeId);

    if (isAssigned) {
      await fetch(`${API}/api/tenants/${tenantId}/funnel-types/${funnelTypeId}`, { method: "DELETE", credentials: "include" });
      setAssignments(prev => ({ ...prev, [tenantId]: prev[tenantId].filter(id => id !== funnelTypeId) }));
    } else {
      await fetch(`${API}/api/tenants/${tenantId}/funnel-types`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ funnelTypeId }),
      });
      setAssignments(prev => ({ ...prev, [tenantId]: [...(prev[tenantId] || []), funnelTypeId] }));
    }
  }

  if (loading) return <PremiumCard className="p-12 text-center"><p className="text-muted-foreground">Loading assignments...</p></PremiumCard>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Assign funnel types to tenants. Only assigned funnels will generate tracking scripts for that tenant.</p>
      {tenants.map(t => {
        const tenantFunnelIds = assignments[t.id] || [];
        return (
          <PremiumCard key={t.id} className="p-5">
            <h3 className="font-display text-lg text-white mb-3">{t.name}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {funnels.filter(f => f.isActive).map(ft => {
                const isAssigned = tenantFunnelIds.includes(ft.id);
                return (
                  <button
                    key={ft.id}
                    onClick={() => toggleAssignment(t.id, ft.id)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all border ${
                      isAssigned
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                        : "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    {isAssigned ? <Link className="w-4 h-4" /> : <Unlink className="w-4 h-4" />}
                    <span className="font-medium">{ft.name}</span>
                    <span className="text-xs opacity-60 font-mono ml-auto">{ft.slug}</span>
                  </button>
                );
              })}
            </div>
            {funnels.filter(f => f.isActive).length === 0 && (
              <p className="text-sm text-muted-foreground">No active funnel types available. Create some in the Funnel Types tab first.</p>
            )}
          </PremiumCard>
        );
      })}
    </div>
  );
}

function TrackerHealthTab({ health, onRefresh }: { health: TrackerHealth[]; onRefresh: () => Promise<void> }) {
  const [lastChecked, setLastChecked] = useState<Date>(new Date());
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
      setLastChecked(new Date());
    } catch {
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Last checked: {lastChecked.toLocaleTimeString()}</p>
        <button onClick={handleRefresh} disabled={refreshing} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-sm text-white transition-all disabled:opacity-50">
          <Wifi className="w-3.5 h-3.5" /> {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {health.map(h => (
        <PremiumCard key={h.tenantId} className="p-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {h.isHealthy ? <Wifi className="w-5 h-5 text-emerald-400" /> : <WifiOff className="w-5 h-5 text-red-400" />}
            <div>
              <p className="text-white font-medium">{h.tenantName}</p>
              <p className="text-sm text-muted-foreground">
                {h.domain ? `Domain: ${h.domain}` : "No domain detected"}
              </p>
            </div>
          </div>
          <div className="text-right">
            <span className={`px-3 py-1 text-xs rounded-full font-medium ${h.isHealthy ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
              {h.isHealthy ? "Healthy" : "Inactive"}
            </span>
            <p className="text-xs text-muted-foreground mt-1">
              {h.lastSeen ? `Last seen: ${new Date(h.lastSeen).toLocaleString()}` : "Never reported"}
            </p>
          </div>
        </PremiumCard>
      ))}
      {health.length === 0 && (
        <PremiumCard className="p-12 text-center">
          <p className="text-muted-foreground">No heartbeat data yet. Install the tracker script on client websites to begin monitoring.</p>
        </PremiumCard>
      )}
    </div>
  );
}

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

interface AliasGroup { funnelTypeId: number; funnelName: string; aliases: { id: number; alias: string }[] }

function AdminTrackingPanel({ tenants }: { tenants: Tenant[] }) {
  const [selectedTid, setSelectedTid] = useState<number | null>(tenants[0]?.id || null);
  const [mode, setMode] = useState("sheets");
  const [saving, setSaving] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [snippetErr, setSnippetErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [aliasGroups, setAliasGroups] = useState<AliasGroup[]>([]);
  const [tenantFunnels, setTenantFunnels] = useState<{ id: number; name: string }[]>([]);
  const [newAlias, setNewAlias] = useState("");
  const [newFunnelTypeId, setNewFunnelTypeId] = useState<number | "">("");

  const loadAliases = async (tid: number) => {
    const r = await fetch(`${API_BASE}/api/funnel-aliases?tenantId=${tid}`, { credentials: "include" });
    const d = await r.json();
    setAliasGroups(d.aliases || []);
  };

  useEffect(() => {
    if (!selectedTid) return;
    setSnippet(null);
    setSnippetErr(null);
    Promise.all([
      fetch(`${API_BASE}/api/ingestion-mode?tenantId=${selectedTid}`, { credentials: "include" }).then(r => r.json()),
      fetch(`${API_BASE}/api/ingestion-mode/gtm-snippet?tenantId=${selectedTid}`, { credentials: "include" }).then(r => r.json().then(d => ({ ok: r.ok, data: d }))),
    ]).then(([modeData, snippetResult]) => {
      setMode(modeData.mode || "sheets");
      if (snippetResult.ok) {
        setSnippet(snippetResult.data.snippet || null);
      } else {
        setSnippetErr(snippetResult.data.error || "Failed to load snippet");
      }
    }).catch(() => { setSnippetErr("Failed to load snippet"); });
    loadAliases(selectedTid);
    fetch(`${API}/api/tenants/${selectedTid}/funnel-types`, { credentials: "include" })
      .then(r => r.json()).then(d => setTenantFunnels(Array.isArray(d) ? d.map((f: Record<string, unknown>) => ({ id: Number(f.funnelTypeId || f.id), name: String(f.funnelName || f.name || "") })) : []))
      .catch(() => setTenantFunnels([]));
  }, [selectedTid]);

  const updateMode = async (m: string) => {
    if (!selectedTid) return;
    setSaving(true);
    const res = await fetch(`${API_BASE}/api/ingestion-mode?tenantId=${selectedTid}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ mode: m }),
    });
    if (res.ok) setMode(m);
    setSaving(false);
  };

  const addAlias = async () => {
    if (!selectedTid || !newAlias.trim() || !newFunnelTypeId) return;
    await fetch(`${API_BASE}/api/funnel-aliases?tenantId=${selectedTid}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ funnelTypeId: newFunnelTypeId, alias: newAlias.trim() }),
    });
    setNewAlias(""); setNewFunnelTypeId("");
    loadAliases(selectedTid);
  };

  const deleteAlias = async (id: number) => {
    if (!selectedTid) return;
    await fetch(`${API_BASE}/api/funnel-aliases/${id}?tenantId=${selectedTid}`, { method: "DELETE", credentials: "include" });
    if (selectedTid) loadAliases(selectedTid);
  };

  const modeSteps = [
    { key: "sheets", label: "Sheets Only" },
    { key: "both", label: "Dual Mode" },
    { key: "tracker", label: "Tracker Only" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={selectedTid ?? ""}
          onChange={e => setSelectedTid(Number(e.target.value))}
          className="bg-background border border-white/10 text-white rounded-lg px-4 py-2 text-sm"
        >
          {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      <PremiumCard>
        <div className="flex items-center gap-2 mb-3">
          <Wifi className="w-4 h-4 text-primary" />
          <h3 className="font-display text-lg text-white">Ingestion Mode</h3>
        </div>
        <div className="flex gap-2">
          {modeSteps.map(s => (
            <button key={s.key} disabled={saving} onClick={() => updateMode(s.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all border ${mode === s.key ? "border-primary bg-primary/5 text-white" : "border-white/10 text-muted-foreground hover:text-white hover:bg-white/[0.04]"}`}
            >{mode === s.key && <Check className="w-3 h-3 inline mr-1" />}{s.label}</button>
          ))}
        </div>
      </PremiumCard>

      <PremiumCard>
        <h3 className="font-display text-lg text-white mb-3">GTM Snippet</h3>
        <p className="text-xs text-muted-foreground mb-3">Copy this into your Google Tag Manager custom HTML tag.</p>
        {snippetErr && <p className="text-xs text-red-400 mb-2">{snippetErr}</p>}
        {snippet ? (
          <div className="relative">
            <button onClick={() => { navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="absolute top-2 right-2 p-1.5 rounded-md bg-white/10 hover:bg-white/20">
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-white/60" />}
            </button>
            <pre className="bg-black/40 border border-white/10 rounded-lg p-3 text-xs text-emerald-300/80 overflow-x-auto font-mono whitespace-pre-wrap">{snippet}</pre>
          </div>
        ) : !snippetErr && (
          <p className="text-sm text-muted-foreground">Loading snippet...</p>
        )}
      </PremiumCard>

      <PremiumCard>
        <h3 className="font-display text-lg text-white mb-3">Funnel Aliases</h3>
        <div className="flex gap-2 mb-3">
          <select value={newFunnelTypeId} onChange={e => setNewFunnelTypeId(e.target.value ? Number(e.target.value) : "")}
            className="bg-background border border-white/10 text-white rounded-lg px-3 py-2 text-sm min-w-[140px]">
            <option value="">Select funnel...</option>
            {tenantFunnels.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <input value={newAlias} onChange={e => setNewAlias(e.target.value)} placeholder="Alias (e.g. fb-funnel)"
            className="flex-1 bg-background border border-white/10 text-white rounded-lg px-3 py-2 text-sm" />
          <button onClick={addAlias} className="bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" />
          </button>
        </div>
        {aliasGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No funnel aliases configured.</p>
        ) : (
          <div className="space-y-3">
            {aliasGroups.map(g => (
              <div key={g.funnelTypeId}>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{g.funnelName}</p>
                <div className="space-y-1">
                  {g.aliases.map(a => (
                    <div key={a.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-white/[0.02] border border-white/5">
                      <span className="text-sm text-white">{a.alias}</span>
                      <button onClick={() => deleteAlias(a.id)} className="text-muted-foreground hover:text-red-400 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </PremiumCard>
    </div>
  );
}
