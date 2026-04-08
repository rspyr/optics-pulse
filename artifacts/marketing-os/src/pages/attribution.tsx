import { useListAttributionEvents } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { format } from "date-fns";
import { Target, AlertTriangle } from "lucide-react";

type EventRow = {
  id: number;
  eventType: string;
  matchLevel: string;
  utmSource?: string | null;
  gclid?: string | null;
  hashedPhone?: string | null;
  hashedEmail?: string | null;
  billingAddress?: string | null;
  fbclid?: string | null;
  createdAt: string;
};

export default function Attribution() {
  const { tenants, localTenantId, effectiveTenantId, setSelectedTenantId, isAgency } = useTenantFilter();

  const { data } = useListAttributionEvents({
    ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
  });

  const events: EventRow[] = (data?.events as EventRow[] | undefined) || [];

  const getMatchBadge = (level: string) => {
    switch(level) {
      case 'diamond': return <Badge variant="success" className="border-blue-400 text-blue-400 bg-blue-400/10">DIAMOND</Badge>;
      case 'golden': return <Badge variant="warning">GOLDEN</Badge>;
      case 'silver': return <Badge variant="neutral" className="text-gray-300">SILVER</Badge>;
      case 'bronze': return <Badge variant="danger" className="text-orange-400 border-orange-400/30 bg-orange-400/10">BRONZE</Badge>;
      default: return <Badge variant="neutral">UNMATCHED</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <GradientHeading className="text-3xl md:text-4xl mb-2">Attribution Log</GradientHeading>
        <p className="font-sub text-muted-foreground text-sm tracking-wide">RAW EVENT INGESTION & MATCHING WATERFALL</p>
      </header>

      {isAgency && tenants.length > 0 && (
        <PremiumCard className="p-4">
          <div className="flex items-center gap-3">
            <label className="text-xs text-white/40 uppercase tracking-wider">Tenant</label>
            <Select value={String(localTenantId ?? "")} onValueChange={v => { const n = parseInt(v); if (!isNaN(n)) setSelectedTenantId(n); }}>
              <SelectTrigger className="w-auto bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50">
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

      {events.length === 0 ? (
        <PremiumCard className="p-10">
          <div className="flex flex-col items-center justify-center text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-white/[0.03] border border-white/10 flex items-center justify-center">
              <Target className="w-7 h-7 text-muted-foreground" />
            </div>
            <div className="space-y-2 max-w-md">
              <h3 className="text-lg font-medium text-white">No attribution events yet</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Attribution events appear here once tracking is connected. Set up click tracking (GCLIDs, FBCLIDs),
                call tracking (CallRail), or form integrations (GHL webhooks) to start capturing lead sources.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/10 rounded-lg px-4 py-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>Without attribution events, all jobs will appear as "unmatched" in reporting.</span>
            </div>
          </div>
        </PremiumCard>
      ) : (
        <PremiumCard className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5 bg-background/50">
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Time</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Source</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Match Level</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Join Key snippet</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {events.map((ev) => (
                  <tr key={ev.id} className="group hover:bg-white/[0.02] transition-colors font-mono text-sm">
                    <td className="p-4 text-muted-foreground">{format(new Date(ev.createdAt), 'MM/dd HH:mm:ss')}</td>
                    <td className="p-4 text-white uppercase">{ev.eventType.replace('_', ' ')}</td>
                    <td className="p-4 text-gray-400">{ev.utmSource || ev.eventType}</td>
                    <td className="p-4">{getMatchBadge(ev.matchLevel)}</td>
                    <td className="p-4 text-muted-foreground truncate max-w-[200px]">
                      {ev.gclid || ev.hashedPhone || ev.hashedEmail || ev.billingAddress || ev.fbclid || 'N/A'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PremiumCard>
      )}
    </div>
  );
}
