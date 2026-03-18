import { useState } from "react";
import { useListTenants, useCreateTenant, useUpdateTenant, useDeleteTenant } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { Plus, Edit2, X, Check, Trash2 } from "lucide-react";

export default function AdminTenants() {
  const { data: tenants, isLoading, refetch } = useListTenants();
  const createTenant = useCreateTenant();
  const updateTenant = useUpdateTenant();
  const deleteTenant = useDeleteTenant();

  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", serviceTitanId: "", timezone: "America/New_York" });

  const handleCreate = async () => {
    await createTenant.mutateAsync({ data: { name: form.name, serviceTitanId: form.serviceTitanId || undefined, timezone: form.timezone } });
    setForm({ name: "", serviceTitanId: "", timezone: "America/New_York" });
    setShowCreate(false);
    refetch();
  };

  const handleUpdate = async (id: number) => {
    await updateTenant.mutateAsync({ tenantId: id, data: { name: form.name, serviceTitanId: form.serviceTitanId || undefined, timezone: form.timezone } });
    setEditId(null);
    refetch();
  };

  const handleDelete = async (id: number) => {
    await deleteTenant.mutateAsync({ tenantId: id });
    refetch();
  };

  const startEdit = (tenant: { id: number; name: string; serviceTitanId?: string | null; timezone: string }) => {
    setEditId(tenant.id);
    setForm({ name: tenant.name, serviceTitanId: tenant.serviceTitanId || "", timezone: tenant.timezone });
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Tenant Management</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">MANAGE HVAC CLIENT COMPANIES</p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setForm({ name: "", serviceTitanId: "", timezone: "America/New_York" }); }}
          className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-white font-medium px-5 py-2 rounded-lg transition-all shadow-[0_0_15px_rgba(242,5,5,0.3)]"
        >
          <Plus className="w-4 h-4" />
          Add Tenant
        </button>
      </header>

      {showCreate && (
        <PremiumCard className="p-6">
          <h3 className="font-display text-lg text-white mb-4">New Tenant</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input
              value={form.name}
              onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Company Name"
              className="bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <input
              value={form.serviceTitanId}
              onChange={(e) => setForm(f => ({ ...f, serviceTitanId: e.target.value }))}
              placeholder="ServiceTitan ID"
              className="bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <select
              value={form.timezone}
              onChange={(e) => setForm(f => ({ ...f, timezone: e.target.value }))}
              className="bg-background/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="America/New_York">Eastern</option>
              <option value="America/Chicago">Central</option>
              <option value="America/Denver">Mountain</option>
              <option value="America/Los_Angeles">Pacific</option>
            </select>
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
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {tenants?.map((tenant) => (
                <tr key={tenant.id} className="hover:bg-white/[0.02] transition-colors">
                  {editId === tenant.id ? (
                    <>
                      <td className="p-4 text-sm text-muted-foreground">{tenant.id}</td>
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
                      <td className="p-4"><Badge variant={tenant.isActive ? "success" : "danger"}>{tenant.isActive ? "Active" : "Inactive"}</Badge></td>
                      <td className="p-4 text-right space-x-2">
                        <button onClick={() => handleUpdate(tenant.id)} className="text-emerald-400 hover:text-emerald-300"><Check className="w-4 h-4 inline" /></button>
                        <button onClick={() => setEditId(null)} className="text-muted-foreground hover:text-white"><X className="w-4 h-4 inline" /></button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="p-4 text-sm text-muted-foreground">{tenant.id}</td>
                      <td className="p-4 font-medium text-white">{tenant.name}</td>
                      <td className="p-4 text-sm text-muted-foreground">{tenant.serviceTitanId || "—"}</td>
                      <td className="p-4 text-sm text-muted-foreground">{tenant.timezone}</td>
                      <td className="p-4"><Badge variant={tenant.isActive ? "success" : "danger"}>{tenant.isActive ? "Active" : "Inactive"}</Badge></td>
                      <td className="p-4 text-right space-x-2">
                        <button onClick={() => startEdit(tenant)} className="text-muted-foreground hover:text-white"><Edit2 className="w-4 h-4 inline" /></button>
                        <button onClick={() => handleDelete(tenant.id)} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-4 h-4 inline" /></button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PremiumCard>
    </div>
  );
}
