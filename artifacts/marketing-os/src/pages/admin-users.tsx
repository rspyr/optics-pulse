import { useState, useEffect } from "react";
import { useListTenants } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { Plus, Edit2, X, Check, UserCog, Trash2 } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: string;
  tenantId: number | null;
  isActive: boolean;
  createdAt: string;
}

const ROLES = ["super_admin", "agency_user", "client_admin", "client_user"] as const;
const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  agency_user: "Agency User",
  client_admin: "Client Admin",
  client_user: "Client User",
};

export default function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const { data: tenants } = useListTenants();

  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "client_user" as string, tenantId: "" as string });
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const fetchUsers = async () => {
    const res = await fetch(`${API_BASE}/api/admin/users`, { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      setUsers(data);
    }
    setLoading(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  const handleCreate = async () => {
    await fetch(`${API_BASE}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        tenantId: form.tenantId ? parseInt(form.tenantId) : null,
      }),
      credentials: "include",
    });
    setShowCreate(false);
    setForm({ name: "", email: "", password: "", role: "client_user", tenantId: "" });
    fetchUsers();
  };

  const handleUpdate = async (id: number) => {
    const body: Record<string, unknown> = {
      name: form.name,
      email: form.email,
      role: form.role,
      tenantId: form.tenantId ? parseInt(form.tenantId) : null,
    };
    if (form.password) body.password = form.password;

    await fetch(`${API_BASE}/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    setEditId(null);
    fetchUsers();
  };

  const toggleActive = async (user: AdminUser) => {
    await fetch(`${API_BASE}/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !user.isActive }),
      credentials: "include",
    });
    fetchUsers();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError("");
    const res = await fetch(`${API_BASE}/api/admin/users/${deleteTarget.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      setDeleteTarget(null);
      fetchUsers();
    } else {
      const data = await res.json();
      setDeleteError(data.error || "Failed to delete user");
    }
  };

  const startEdit = (user: AdminUser) => {
    setEditId(user.id);
    setForm({ name: user.name, email: user.email, password: "", role: user.role, tenantId: user.tenantId?.toString() || "" });
  };

  const getTenantName = (tenantId: number | null) => {
    if (!tenantId || !tenants) return "\u2014";
    const t = tenants.find(t => t.id === tenantId);
    return t?.name || `#${tenantId}`;
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">User Management</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">MANAGE TEAM & CLIENT ACCESS</p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setForm({ name: "", email: "", password: "", role: "client_user", tenantId: "" }); }}
          className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-white font-medium px-5 py-2 rounded-lg transition-all shadow-[0_0_15px_rgba(242,5,5,0.3)]"
        >
          <Plus className="w-4 h-4" />
          Add User
        </button>
      </header>

      {showCreate && (
        <PremiumCard className="p-6">
          <h3 className="font-display text-lg text-white mb-4">New User</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Full Name" className="bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            <input value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="Email" type="email" className="bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            <input value={form.password} onChange={(e) => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="Password" type="password" className="bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            <Select value={form.role} onValueChange={(v) => setForm(f => ({ ...f, role: v }))}>
              <SelectTrigger className="bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map(r => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={form.tenantId || "none"} onValueChange={(v) => setForm(f => ({ ...f, tenantId: v === "none" ? "" : v }))}>
              <SelectTrigger className="bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Tenant (Agency)</SelectItem>
                {tenants?.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={handleCreate} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm">
              <Check className="w-4 h-4" /> Create
            </button>
            <button onClick={() => setShowCreate(false)} className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-sm">
              <X className="w-4 h-4" /> Cancel
            </button>
          </div>
        </PremiumCard>
      )}

      <PremiumCard className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Loading users...</div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 bg-background/50">
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Email</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Role</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Tenant</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-white/[0.02] transition-colors">
                  {editId === user.id ? (
                    <>
                      <td className="p-4"><input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} className="bg-background/50 border border-white/10 rounded px-2 py-1 text-white text-sm w-full" /></td>
                      <td className="p-4"><input value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} className="bg-background/50 border border-white/10 rounded px-2 py-1 text-white text-sm w-full" /></td>
                      <td className="p-4">
                        <Select value={form.role} onValueChange={(v) => setForm(f => ({ ...f, role: v }))}>
                          <SelectTrigger className="bg-background/50 border border-white/10 rounded px-2 py-1 text-white text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map(r => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="p-4">
                        <Select value={form.tenantId || "none"} onValueChange={(v) => setForm(f => ({ ...f, tenantId: v === "none" ? "" : v }))}>
                          <SelectTrigger className="bg-background/50 border border-white/10 rounded px-2 py-1 text-white text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            {tenants?.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="p-4"><Badge variant={user.isActive ? "success" : "danger"}>{user.isActive ? "Active" : "Inactive"}</Badge></td>
                      <td className="p-4 text-right space-x-2">
                        <button onClick={() => handleUpdate(user.id)} className="text-emerald-400 hover:text-emerald-300"><Check className="w-4 h-4 inline" /></button>
                        <button onClick={() => setEditId(null)} className="text-muted-foreground hover:text-white"><X className="w-4 h-4 inline" /></button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="p-4 font-medium text-white flex items-center gap-2"><UserCog className="w-4 h-4 text-muted-foreground" />{user.name}</td>
                      <td className="p-4 text-sm text-muted-foreground">{user.email}</td>
                      <td className="p-4"><Badge variant={user.role.includes("admin") ? "default" : "neutral"}>{ROLE_LABELS[user.role] || user.role}</Badge></td>
                      <td className="p-4 text-sm text-muted-foreground">{getTenantName(user.tenantId)}</td>
                      <td className="p-4">
                        <button
                          onClick={() => toggleActive(user)}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${user.isActive ? "bg-emerald-600" : "bg-white/10"}`}
                          title={user.isActive ? "Click to deactivate" : "Click to activate"}
                        >
                          <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${user.isActive ? "translate-x-6" : "translate-x-1"}`} />
                        </button>
                      </td>
                      <td className="p-4 text-right space-x-2">
                        <button onClick={() => startEdit(user)} className="text-muted-foreground hover:text-white"><Edit2 className="w-4 h-4 inline" /></button>
                        <button onClick={() => { setDeleteTarget(user); setDeleteError(""); }} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-4 h-4 inline" /></button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PremiumCard>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-card border border-white/10 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="font-display text-lg text-white mb-2">Delete User</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Are you sure you want to permanently delete <span className="text-white font-medium">{deleteTarget.name}</span> ({deleteTarget.email})? This action cannot be undone.
            </p>
            {deleteError && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm mb-4">
                {deleteError}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteTarget(null)} className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-sm">
                Cancel
              </button>
              <button onClick={handleDelete} className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
