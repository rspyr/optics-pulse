import { useListAttributionEvents } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { format } from "date-fns";

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

  const events: EventRow[] = (data?.events as EventRow[] | undefined) || [
    { id: 1, eventType: "click", utmSource: "google", matchLevel: "diamond", gclid: "CjwKCAjw7...", createdAt: new Date().toISOString() },
    { id: 2, eventType: "call", utmSource: "callrail", matchLevel: "golden", hashedPhone: "e3b0c44...", createdAt: new Date(Date.now() - 3600000).toISOString() },
    { id: 3, eventType: "form_fill", utmSource: "ghl", matchLevel: "silver", hashedEmail: "8a9b2c3...", createdAt: new Date(Date.now() - 7200000).toISOString() },
    { id: 4, eventType: "call", utmSource: "callrail", matchLevel: "bronze", billingAddress: "123 Main St...", createdAt: new Date(Date.now() - 86400000).toISOString() },
    { id: 5, eventType: "click", utmSource: "meta", matchLevel: "unmatched", fbclid: "IwAR2xyz...", createdAt: new Date(Date.now() - 172800000).toISOString() },
  ];

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
            <select
              value={localTenantId ?? ""}
              onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v)) setSelectedTenantId(v); }}
              className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              {tenants.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </PremiumCard>
      )}

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
    </div>
  );
}
