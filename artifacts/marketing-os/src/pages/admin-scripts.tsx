import { useEffect, useCallback } from "react";
import { GradientHeading, PremiumCard } from "@/components/ui-helpers";
import { useAuth } from "@/components/auth-context";
import { useTenants } from "@/hooks/use-tenants";
import ScriptManagement from "@/components/script-management";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

export default function AdminScripts() {
  const {
    user,
    isAgency,
    selectedTenantId: globalTenantId,
    setSelectedTenantId: setGlobalTenantId,
  } = useAuth();
  const { tenants, tenantsLoading } = useTenants();

  const setSelectedTenantId = useCallback((id: number | null) => {
    setGlobalTenantId(id);
  }, [setGlobalTenantId]);

  useEffect(() => {
    if (!isAgency) return;
    if (globalTenantId == null && tenants.length > 0) {
      setSelectedTenantId(tenants[0].id);
    }
  }, [isAgency, globalTenantId, tenants, setSelectedTenantId]);

  const selectedTenantId = isAgency ? globalTenantId : user?.tenantId ?? null;
  const effectiveTenantId = selectedTenantId;

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
            <Select value={selectedTenantId != null ? String(selectedTenantId) : ""} onValueChange={v => setSelectedTenantId(parseInt(v))}>
              <SelectTrigger className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50 w-auto min-w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tenants.map(t => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </PremiumCard>
      )}

      {isAgency && !effectiveTenantId && tenantsLoading && (
        <PremiumCard className="p-6">
          <div className="animate-pulse space-y-3">
            <div className="h-4 w-1/3 bg-white/10 rounded" />
            <div className="h-3 w-1/2 bg-white/5 rounded" />
            <div className="h-3 w-2/5 bg-white/5 rounded" />
          </div>
        </PremiumCard>
      )}

      {effectiveTenantId ? (
        <ScriptManagement key={effectiveTenantId} tenantId={effectiveTenantId} />
      ) : (
        !tenantsLoading && (
          <PremiumCard className="p-8 text-center">
            <p className="text-white/40">Select a tenant to manage scripts</p>
          </PremiumCard>
        )
      )}
    </div>
  );
}
