import { useState } from "react";
import { useListAttributionEvents, useGetAttributionEvent } from "@workspace/api-client-react";
import type { AttributionEvent } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { format } from "date-fns";
import { Target, AlertTriangle, Globe, MousePointerClick, Phone, FileText, ExternalLink, Tag, Fingerprint, MapPin, Briefcase, User, Link2 } from "lucide-react";

export default function Attribution() {
  const { tenants, localTenantId, effectiveTenantId, setSelectedTenantId, isAgency } = useTenantFilter();
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);

  const { data } = useListAttributionEvents({
    ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
  });

  const { data: detailData } = useGetAttributionEvent(selectedEventId!, {
    query: { enabled: selectedEventId != null },
  });

  const events: AttributionEvent[] = data?.events || [];

  const getMatchBadge = (level: string | null | undefined) => {
    switch(level) {
      case 'diamond': return <Badge variant="success" className="border-blue-400 text-blue-400 bg-blue-400/10">DIAMOND</Badge>;
      case 'golden': return <Badge variant="warning">GOLDEN</Badge>;
      case 'silver': return <Badge variant="neutral" className="text-gray-300">SILVER</Badge>;
      case 'bronze': return <Badge variant="danger" className="text-orange-400 border-orange-400/30 bg-orange-400/10">BRONZE</Badge>;
      default: return <Badge variant="neutral">UNMATCHED</Badge>;
    }
  };

  const getEventIcon = (type: string) => {
    switch(type) {
      case 'click': return <MousePointerClick className="w-4 h-4" />;
      case 'call': return <Phone className="w-4 h-4" />;
      case 'form_fill': return <FileText className="w-4 h-4" />;
      default: return <Target className="w-4 h-4" />;
    }
  };

  const selectedEvent = detailData?.event;
  const matchedJob = detailData?.matchedJob;
  const matchedLead = detailData?.matchedLead;

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
                  <tr
                    key={ev.id}
                    className="group hover:bg-white/[0.02] transition-colors font-mono text-sm cursor-pointer"
                    onClick={() => setSelectedEventId(ev.id)}
                  >
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

      <Sheet open={selectedEventId != null} onOpenChange={(open) => { if (!open) setSelectedEventId(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto bg-background border-white/10">
          {selectedEvent && (
            <>
              <SheetHeader className="pb-4 border-b border-white/5">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  {getEventIcon(selectedEvent.eventType)}
                  <span className="text-xs uppercase tracking-wider">{selectedEvent.eventType.replace('_', ' ')} event</span>
                </div>
                <SheetTitle className="text-white">Event #{selectedEvent.id}</SheetTitle>
                <SheetDescription>
                  {format(new Date(selectedEvent.createdAt), 'PPpp')}
                  {selectedEvent.submittedAt && (
                    <span className="ml-2 text-xs text-white/30">
                      (submitted {format(new Date(selectedEvent.submittedAt), 'PPpp')})
                    </span>
                  )}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-6 pt-4">
                <DetailSection title="Match Status" icon={<Target className="w-4 h-4" />}>
                  <div className="flex items-center gap-3 mb-3">
                    {getMatchBadge(selectedEvent.matchLevel)}
                    {selectedEvent.matchConfidence != null && (
                      <span className="text-xs text-muted-foreground">
                        {(selectedEvent.matchConfidence * 100).toFixed(0)}% confidence
                      </span>
                    )}
                  </div>
                  {selectedEvent.gclid && (
                    <DetailRow label="Event GCLID" value={selectedEvent.gclid} mono />
                  )}
                  {matchedJob?.matchedGclid && matchedJob.matchedGclid !== selectedEvent.gclid && (
                    <DetailRow label="Matched GCLID" value={matchedJob.matchedGclid} mono />
                  )}
                  {selectedEvent.externalId && (
                    <DetailRow label="External ID" value={selectedEvent.externalId} />
                  )}
                </DetailSection>

                <DetailSection title="Linked Records" icon={<Link2 className="w-4 h-4" />}>
                  {matchedJob ? (
                    <div className="space-y-3">
                      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Briefcase className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground uppercase tracking-wider">Matched Job</span>
                        </div>
                        <DetailRow label="Job ID" value={`#${matchedJob.id}`} />
                        {matchedJob.stJobId && (
                          <DetailRow label="ST Job ID" value={matchedJob.stJobId} />
                        )}
                        {matchedJob.customerName && (
                          <DetailRow label="Customer" value={matchedJob.customerName} />
                        )}
                        {matchedJob.matchedGclid && (
                          <DetailRow label="Matched GCLID" value={matchedJob.matchedGclid} mono />
                        )}
                        <DetailRow label="Revenue" value={`$${matchedJob.revenue.toLocaleString()}`} />
                      </div>
                      {matchedLead && (
                        <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-2">
                          <div className="flex items-center gap-2 mb-1">
                            <User className="w-3.5 h-3.5 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground uppercase tracking-wider">Linked Lead</span>
                          </div>
                          <DetailRow label="Name" value={`${matchedLead.firstName} ${matchedLead.lastName}`} />
                          <div className="pt-1">
                            <a
                              href={`/pulse?leadId=${matchedLead.id}`}
                              className="text-xs text-blue-400 hover:text-blue-300 transition-colors inline-flex items-center gap-1"
                            >
                              <ExternalLink className="w-3 h-3" />
                              View in Pulse
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No matched job or lead found for this event.</p>
                  )}
                </DetailSection>

                <DetailSection title="Attribution (UTM)" icon={<Tag className="w-4 h-4" />}>
                  <DetailRow label="Source" value={selectedEvent.utmSource} />
                  <DetailRow label="Medium" value={selectedEvent.utmMedium} />
                  <DetailRow label="Campaign" value={selectedEvent.utmCampaign} />
                  <DetailRow label="Term" value={selectedEvent.utmTerm} />
                  <DetailRow label="Content" value={selectedEvent.utmContent} />
                </DetailSection>

                <DetailSection title="Click IDs" icon={<Fingerprint className="w-4 h-4" />}>
                  <DetailRow label="GCLID" value={selectedEvent.gclid} mono />
                  <DetailRow label="FBCLID" value={selectedEvent.fbclid} mono />
                  <DetailRow label="MSCLKID" value={selectedEvent.msclkid} mono />
                  <DetailRow label="TTCLID" value={selectedEvent.ttclid} mono />
                  <DetailRow label="WBRAID" value={selectedEvent.wbraid} mono />
                  <DetailRow label="LI FAT ID" value={selectedEvent.liFatId} mono />
                </DetailSection>

                <DetailSection title="Identity" icon={<MapPin className="w-4 h-4" />}>
                  <DetailRow label="Hashed Phone" value={selectedEvent.hashedPhone} mono />
                  <DetailRow label="Hashed Email" value={selectedEvent.hashedEmail} mono />
                  <DetailRow label="Billing Address" value={selectedEvent.billingAddress} />
                </DetailSection>

                <DetailSection title="Page Context" icon={<Globe className="w-4 h-4" />}>
                  <DetailRow label="Page URL" value={selectedEvent.pageUrl} link />
                  <DetailRow label="Landing Page" value={selectedEvent.landingPage} link />
                  <DetailRow label="Referrer" value={selectedEvent.referrer} link />
                </DetailSection>

                {(selectedEvent.formType || selectedEvent.formId || selectedEvent.formName || selectedEvent.formFields) && (
                  <DetailSection title="Form Data" icon={<FileText className="w-4 h-4" />}>
                    <DetailRow label="Form Type" value={selectedEvent.formType} />
                    <DetailRow label="Form ID" value={selectedEvent.formId} />
                    <DetailRow label="Form Name" value={selectedEvent.formName} />
                    {selectedEvent.formFields && typeof selectedEvent.formFields === 'object' && (
                      <div className="mt-3 space-y-1">
                        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Form Fields</p>
                        <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-2">
                          {Object.entries(selectedEvent.formFields as Record<string, unknown>).map(([key, value]) => (
                            <div key={key} className="flex justify-between gap-4 text-sm">
                              <span className="text-muted-foreground shrink-0">{key}</span>
                              <span className="text-white text-right break-all">{String(value ?? '')}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </DetailSection>
                )}

                {selectedEvent.userAgent && (
                  <DetailSection title="Metadata" icon={<ExternalLink className="w-4 h-4" />}>
                    <div className="text-xs text-muted-foreground break-all bg-white/[0.02] border border-white/5 rounded-lg p-3">
                      {selectedEvent.userAgent}
                    </div>
                  </DetailSection>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DetailSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-muted-foreground">{icon}</span>
        <h4 className="text-xs font-medium text-white/60 uppercase tracking-wider">{title}</h4>
      </div>
      <div className="space-y-1 pl-6">{children}</div>
    </div>
  );
}

function DetailRow({ label, value, mono, link }: { label: string; value?: string | null; mono?: boolean; link?: boolean }) {
  if (!value) return null;

  return (
    <div className="flex justify-between gap-4 text-sm py-0.5">
      <span className="text-muted-foreground shrink-0">{label}</span>
      {link ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 text-right break-all transition-colors"
        >
          {value}
        </a>
      ) : (
        <span className={`text-white text-right break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
      )}
    </div>
  );
}
