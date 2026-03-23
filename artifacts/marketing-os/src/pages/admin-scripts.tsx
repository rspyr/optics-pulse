import { useState, useEffect, useCallback } from "react";
import { GradientHeading, PremiumCard } from "@/components/ui-helpers";
import { useAuth } from "@/components/auth-context";
import ScriptManagement from "@/components/script-management";

const API = import.meta.env.VITE_API_URL || "";

interface TenantOption {
  id: number;
  name: string;
}

export default function AdminScripts() {
  const { user, isAgency, setSelectedTenantId: setGlobalTenantId } = useAuth();
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [selectedTenantId, setSelectedTenantIdLocal] = useState<number | null>(user?.tenantId ?? null);

  const setSelectedTenantId = useCallback((id: number | null) => {
    setSelectedTenantIdLocal(id);
    setGlobalTenantId(id);
  }, [setGlobalTenantId]);

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

  const effectiveTenantId = isAgency ? selectedTenantId : user?.tenantId ?? null;

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <GradientHeading className="text-3xl md:text-4xl mb-2">Script Management</GradientHeading>
        <p className="font-sub text-muted-foreground text-sm tracking-wide">
          MANAGE CALL, TEXT, EMAIL &amp; VOICEMAIL SCRIPTS
        </p>
      </header>

      {isAgency && tenants.length > 0 && (
        <PremiumCard className="p-4">
          <div className="flex items-center gap-3">
            <label className="text-xs text-white/40 uppercase tracking-wider">Tenant</label>
            <select
              value={selectedTenantId ?? ""}
              onChange={e => setSelectedTenantId(parseInt(e.target.value))}
              className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              {tenants.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </PremiumCard>
      )}

      {effectiveTenantId ? (
        <ScriptManagement key={effectiveTenantId} tenantId={effectiveTenantId} />
      ) : (
        <PremiumCard className="p-8 text-center">
          <p className="text-white/40">Select a tenant to manage scripts</p>
        </PremiumCard>
      )}
    </div>
  );
}
