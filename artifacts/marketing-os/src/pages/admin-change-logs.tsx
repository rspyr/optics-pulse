import { useState, useEffect } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Plus, Pencil, Trash2, X, Save } from "lucide-react";
import { useAuth } from "@/components/auth-context";

const API = import.meta.env.VITE_API_URL || "";

interface ChangeLog {
  id: number;
  tenantId: number;
  date: string;
  title: string;
  description: string;
  category: string;
  createdAt: string;
}

interface Tenant {
  id: number;
  name: string;
}

const CATEGORIES = ["general", "campaigns", "funnel", "tracking", "creative", "budget", "strategy"];

export default function AdminChangeLogs() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<ChangeLog[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [filterTenant, setFilterTenant] = useState<number | "">("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ tenantId: "", date: "", title: "", description: "", category: "general" });

  useEffect(() => {
    fetch(`${API}/api/tenants`, { credentials: "include" }).then(r => r.json()).then(setTenants).catch(() => {});
  }, []);

  useEffect(() => {
    const params = filterTenant ? `?tenantId=${filterTenant}` : "";
    fetch(`${API}/api/change-logs${params}`, { credentials: "include" }).then(r => r.json()).then(setLogs).catch(() => {});
  }, [filterTenant]);

  function openNew() {
    setForm({ tenantId: "", date: new Date().toISOString().split("T")[0], title: "", description: "", category: "general" });
    setEditingId(null);
    setShowForm(true);
  }

  function openEdit(log: ChangeLog) {
    setForm({ tenantId: String(log.tenantId), date: log.date, title: log.title, description: log.description, category: log.category });
    setEditingId(log.id);
    setShowForm(true);
  }

  async function handleSave() {
    const method = editingId ? "PUT" : "POST";
    const url = editingId ? `${API}/api/change-logs/${editingId}` : `${API}/api/change-logs`;
    const body = editingId
      ? { date: form.date, title: form.title, description: form.description, category: form.category }
      : { tenantId: Number(form.tenantId), date: form.date, title: form.title, description: form.description, category: form.category };

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setShowForm(false);
      const params = filterTenant ? `?tenantId=${filterTenant}` : "";
      const data = await fetch(`${API}/api/change-logs${params}`, { credentials: "include" }).then(r => r.json());
      setLogs(data);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this change log entry?")) return;
    await fetch(`${API}/api/change-logs/${id}`, { method: "DELETE", credentials: "include" });
    setLogs(logs.filter(l => l.id !== id));
  }

  const tenantMap = new Map(tenants.map(t => [t.id, t.name]));

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Marketing Change Log</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">MANAGE MARKETING CHANGES SHOWN ON CLIENT CHARTS</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={filterTenant}
            onChange={e => setFilterTenant(e.target.value ? Number(e.target.value) : "")}
            className="bg-card border border-white/10 text-white text-sm rounded-lg px-4 py-2"
          >
            <option value="">All Tenants</option>
            {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button onClick={openNew} className="bg-primary hover:bg-primary/90 text-white font-medium px-4 py-2 rounded-lg flex items-center gap-2 transition-all shadow-[0_0_15px_rgba(242,5,5,0.3)]">
            <Plus className="w-4 h-4" /> Add Entry
          </button>
        </div>
      </header>

      {showForm && (
        <PremiumCard className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-display text-lg text-white">{editingId ? "Edit" : "New"} Change Log Entry</h3>
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
              <label className="text-sm text-gray-300">Date</label>
              <input type="date" value={form.date} onChange={e => setForm({...form, date: e.target.value})} className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5" />
            </div>
            <div className="space-y-1">
              <label className="text-sm text-gray-300">Category</label>
              <select value={form.category} onChange={e => setForm({...form, category: e.target.value})} className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5">
                {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
              </select>
            </div>
            <div className="space-y-1 md:col-span-2">
              <label className="text-sm text-gray-300">Title</label>
              <input type="text" value={form.title} onChange={e => setForm({...form, title: e.target.value})} placeholder="e.g., Overhauled Meta Ad Set" className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5" />
            </div>
            <div className="space-y-1 md:col-span-2">
              <label className="text-sm text-gray-300">Description</label>
              <textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} rows={3} placeholder="Describe what changed and why..." className="w-full bg-background border border-white/10 text-white rounded-lg px-4 py-2.5 resize-none" />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button onClick={handleSave} className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-2.5 rounded-lg flex items-center gap-2 transition-all">
              <Save className="w-4 h-4" /> {editingId ? "Update" : "Create"}
            </button>
          </div>
        </PremiumCard>
      )}

      <PremiumCard>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/10 text-left">
                <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Tenant</th>
                <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Title</th>
                <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Category</th>
                <th className="py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr><td colSpan={5} className="py-12 text-center text-muted-foreground">No change log entries yet. Click "Add Entry" to create one.</td></tr>
              ) : logs.map(log => (
                <tr key={log.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                  <td className="py-3 px-4 text-sm text-white whitespace-nowrap">{log.date}</td>
                  <td className="py-3 px-4 text-sm text-muted-foreground">{tenantMap.get(log.tenantId) || log.tenantId}</td>
                  <td className="py-3 px-4 text-sm text-white">{log.title}</td>
                  <td className="py-3 px-4">
                    <span className="px-2 py-1 text-xs rounded-full bg-white/10 text-white">{log.category}</span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(log)} className="p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-white transition-all"><Pencil className="w-4 h-4" /></button>
                      <button onClick={() => handleDelete(log.id)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-all"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PremiumCard>
    </div>
  );
}
