import { useState, useEffect } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Plus, Pencil, Trash2, X, Save, Copy, Check, Wifi, WifiOff } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

interface FunnelType {
  id: number;
  tenantId: number;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
}

interface Tenant {
  id: number;
  name: string;
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
  const [filterTenant, setFilterTenant] = useState<number | "">("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ tenantId: "", name: "", slug: "", description: "" });
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [tab, setTab] = useState<"funnels" | "scripts" | "health">("funnels");

  useEffect(() => {
    fetch(`${API}/api/tenants`, { credentials: "include" }).then(r => r.json()).then(setTenants).catch(() => {});
    fetch(`${API}/api/tracker/health`, { credentials: "include" }).then(r => r.json()).then(setHealth).catch(() => {});
  }, []);

  const [allFunnels, setAllFunnels] = useState<FunnelType[]>([]);

  useEffect(() => {
    fetch(`${API}/api/funnel-types`, { credentials: "include" }).then(r => r.json()).then(setAllFunnels).catch(() => {});
  }, []);

  useEffect(() => {
    const params = filterTenant ? `?tenantId=${filterTenant}` : "";
    fetch(`${API}/api/funnel-types${params}`, { credentials: "include" }).then(r => r.json()).then(setFunnels).catch(() => {});
  }, [filterTenant]);

  function openNew() {
    setForm({ tenantId: "", name: "", slug: "", description: "" });
    setEditingId(null);
    setShowForm(true);
  }

  function openEdit(ft: FunnelType) {
    setForm({ tenantId: String(ft.tenantId), name: ft.name, slug: ft.slug, description: ft.description || "" });
    setEditingId(ft.id);
    setShowForm(true);
  }

  async function handleSave() {
    const method = editingId ? "PUT" : "POST";
    const url = editingId ? `${API}/api/funnel-types/${editingId}` : `${API}/api/funnel-types`;
    const body = editingId
      ? { name: form.name, slug: form.slug, description: form.description }
      : { tenantId: Number(form.tenantId), name: form.name, slug: form.slug, description: form.description };

    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) });
    if (res.ok) {
      setShowForm(false);
      const params = filterTenant ? `?tenantId=${filterTenant}` : "";
      const data = await fetch(`${API}/api/funnel-types${params}`, { credentials: "include" }).then(r => r.json());
      setFunnels(data);
      fetch(`${API}/api/funnel-types`, { credentials: "include" }).then(r => r.json()).then(setAllFunnels).catch(() => {});
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this funnel type?")) return;
    await fetch(`${API}/api/funnel-types/${id}`, { method: "DELETE", credentials: "include" });
    setFunnels(funnels.filter(f => f.id !== id));
    setAllFunnels(allFunnels.filter(f => f.id !== id));
  }

  async function copyScript(tenantId: number) {
    try {
      const res = await fetch(`${API}/api/funnel-types/script/${tenantId}`, { credentials: "include" });
      const data = await res.json();
      await navigator.clipboard.writeText(data.script);
      setCopiedId(tenantId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {}
  }

  const tenantMap = new Map(tenants.map(t => [t.id, t.name]));

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Funnel & Script Management</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">MANAGE FUNNEL TYPES, TRACKING SCRIPTS & HEARTBEAT HEALTH</p>
        </div>
      </header>

      <div className="flex gap-2">
        {(["funnels", "scripts", "health"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t ? "bg-white/10 text-white" : "text-muted-foreground hover:text-white"}`}>
            {t === "funnels" ? "Funnel Types" : t === "scripts" ? "Script Tags" : "Tracker Health"}
          </button>
        ))}
      </div>

      {tab === "funnels" && (
        <>
          <div className="flex items-center gap-3">
            <select value={filterTenant} onChange={e => setFilterTenant(e.target.value ? Number(e.target.value) : "")} className="bg-card border border-white/10 text-white text-sm rounded-lg px-4 py-2">
              <option value="">All Tenants</option>
              {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
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
                {!editingId && (
                  <div className="space-y-1">
                    <label className="text-sm text-gray-300">Tenant</label>
                    <select value={form.tenantId} onChange={e => setForm({...form, tenantId: e.target.value})} className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5">
                      <option value="">Select tenant</option>
                      {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-sm text-gray-300">Name</label>
                  <input type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value, slug: e.target.value.toLowerCase().replace(/\s+/g, "-")})} placeholder="e.g., Fit Funnel" className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5" />
                </div>
                <div className="space-y-1">
                  <label className="text-sm text-gray-300">Slug</label>
                  <input type="text" value={form.slug} onChange={e => setForm({...form, slug: e.target.value})} placeholder="e.g., fit-funnel" className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5" />
                </div>
                <div className="space-y-1 md:col-span-2">
                  <label className="text-sm text-gray-300">Description</label>
                  <textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} rows={2} placeholder="Describe this funnel type..." className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5 resize-none" />
                </div>
              </div>
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
                    <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Tenant</th>
                    <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {funnels.length === 0 ? (
                    <tr><td colSpan={5} className="py-12 text-center text-muted-foreground">No funnel types yet.</td></tr>
                  ) : funnels.map(ft => (
                    <tr key={ft.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="py-3 px-4 text-sm text-white font-medium">{ft.name}</td>
                      <td className="py-3 px-4 text-sm text-muted-foreground font-mono">{ft.slug}</td>
                      <td className="py-3 px-4 text-sm text-muted-foreground">{tenantMap.get(ft.tenantId) || ft.tenantId}</td>
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

      {tab === "scripts" && (
        <div className="space-y-4">
          {tenants.map(t => {
            const tenantFunnels = allFunnels.filter(f => f.tenantId === t.id && f.isActive);
            return (
              <PremiumCard key={t.id} className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-display text-lg text-white">{t.name}</h3>
                  <button onClick={() => copyScript(t.id)} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm text-white transition-all">
                    {copiedId === t.id ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    {copiedId === t.id ? "Copied!" : "Copy Base Script"}
                  </button>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Base Script (no funnel)</p>
                    <div className="bg-background border border-white/10 rounded-lg p-4 font-mono text-sm text-emerald-400 overflow-x-auto">
                      {`<script src="${window.location.origin}/tracker.js" data-tenant="${t.id}"></script>`}
                    </div>
                  </div>
                  {tenantFunnels.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Per-Funnel Scripts</p>
                      <div className="space-y-2">
                        {tenantFunnels.map(ft => {
                          const scriptText = `<script src="${window.location.origin}/tracker.js" data-tenant="${t.id}" data-funnel="${ft.slug}"></script>`;
                          return (
                            <div key={ft.id} className="flex items-start gap-3">
                              <div className="flex-1 bg-background border border-white/10 rounded-lg p-3 font-mono text-xs text-cyan-400 overflow-x-auto">
                                <span className="text-muted-foreground text-[10px] block mb-1">{ft.name}</span>
                                {scriptText}
                              </div>
                              <button
                                onClick={() => { navigator.clipboard.writeText(scriptText); setCopiedId(ft.id); setTimeout(() => setCopiedId(null), 2000); }}
                                className="mt-1 p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-white"
                                title="Copy"
                              >
                                {copiedId === ft.id ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </PremiumCard>
            );
          })}
        </div>
      )}

      {tab === "health" && (
        <div className="space-y-4">
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
      )}
    </div>
  );
}
