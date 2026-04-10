import { useState, useEffect, useCallback } from "react";
import { useListAttributionEvents, useGetAttributionEvent } from "@workspace/api-client-react";
import type { AttributionEvent } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { format } from "date-fns";
import {
  Target, AlertTriangle, Globe, MousePointerClick, Phone, FileText, ExternalLink,
  Tag, Fingerprint, MapPin, Briefcase, User, Link2, Filter, Copy, Check,
  Zap, ArrowRight, ShieldCheck, Code, Settings2, Brain,
} from "lucide-react";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type IngestionMode = "sheets" | "both" | "tracker";

interface FunnelAliasGroup {
  funnelTypeId: number;
  funnelName: string;
  aliases: { id: number; alias: string }[];
}

export default function Attribution() {
  const { tenants, localTenantId, effectiveTenantId, setSelectedTenantId, isAgency } = useTenantFilter();
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterMatch, setFilterMatch] = useState<string>("all");
  const [searchText, setSearchText] = useState("");
  const [activeTab, setActiveTab] = useState<"events" | "ingestion" | "funnel-aliases">("events");

  const { data } = useListAttributionEvents({
    ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
  });

  const { data: detailData } = useGetAttributionEvent(selectedEventId!, {
    query: { enabled: selectedEventId != null },
  });

  const events: AttributionEvent[] = data?.events || [];

  const filteredEvents = events.filter(ev => {
    if (filterType !== "all" && ev.eventType !== filterType) return false;
    if (filterMatch !== "all" && ev.matchLevel !== filterMatch) return false;
    if (searchText) {
      const s = searchText.toLowerCase();
      const searchable = [
        ev.utmSource, ev.utmCampaign, ev.gclid, ev.fbclid,
        ev.pageUrl, ev.landingPage, ev.formName,
        (ev as Record<string, unknown>).resolvedLeadSource as string,
        (ev as Record<string, unknown>).resolvedFunnel as string,
      ].filter(Boolean).join(" ").toLowerCase();
      if (!searchable.includes(s)) return false;
    }
    return true;
  });

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

      <div className="flex gap-2">
        <TabButton active={activeTab === "events"} onClick={() => setActiveTab("events")} icon={<Target className="w-4 h-4" />} label="Events" />
        <TabButton active={activeTab === "ingestion"} onClick={() => setActiveTab("ingestion")} icon={<Settings2 className="w-4 h-4" />} label="Ingestion Mode" />
        <TabButton active={activeTab === "funnel-aliases"} onClick={() => setActiveTab("funnel-aliases")} icon={<Brain className="w-4 h-4" />} label="Funnel Aliases" />
      </div>

      {activeTab === "events" && (
        <>
          <PremiumCard className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="w-[140px] bg-white/5 border border-white/10 text-sm">
                  <SelectValue placeholder="Event Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="click">Click</SelectItem>
                  <SelectItem value="call">Call</SelectItem>
                  <SelectItem value="form_fill">Form Fill</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterMatch} onValueChange={setFilterMatch}>
                <SelectTrigger className="w-[140px] bg-white/5 border border-white/10 text-sm">
                  <SelectValue placeholder="Match Level" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Matches</SelectItem>
                  <SelectItem value="diamond">Diamond</SelectItem>
                  <SelectItem value="golden">Golden</SelectItem>
                  <SelectItem value="silver">Silver</SelectItem>
                  <SelectItem value="bronze">Bronze</SelectItem>
                  <SelectItem value="unmatched">Unmatched</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Search source, campaign, URL..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="max-w-[260px] bg-white/5 border-white/10 text-sm"
              />
              <span className="text-xs text-muted-foreground ml-auto">{filteredEvents.length} event{filteredEvents.length !== 1 ? "s" : ""}</span>
            </div>
          </PremiumCard>

          {filteredEvents.length === 0 ? (
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
                      <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Funnel</th>
                      <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Match Level</th>
                      <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Detection</th>
                      <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Join Key</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredEvents.map((ev) => {
                      const extended = ev as Record<string, unknown>;
                      const resolvedSource = (extended.resolvedLeadSource as string) || ev.utmSource || ev.eventType;
                      const resolvedFunnel = (extended.resolvedFunnel as string) || null;
                      const detectedMappings = extended.detectedMappings as Record<string, unknown> | null;
                      const detectedCount = detectedMappings ? Object.keys(detectedMappings).length : 0;

                      return (
                        <tr
                          key={ev.id}
                          className="group hover:bg-white/[0.02] transition-colors font-mono text-sm cursor-pointer"
                          onClick={() => setSelectedEventId(ev.id)}
                        >
                          <td className="p-4 text-muted-foreground">{format(new Date(ev.createdAt), 'MM/dd HH:mm:ss')}</td>
                          <td className="p-4 text-white uppercase">{ev.eventType.replace('_', ' ')}</td>
                          <td className="p-4 text-gray-400">{resolvedSource}</td>
                          <td className="p-4 text-gray-400">{resolvedFunnel || <span className="text-white/20">—</span>}</td>
                          <td className="p-4">{getMatchBadge(ev.matchLevel)}</td>
                          <td className="p-4">
                            {detectedCount > 0 ? (
                              <span className="text-xs text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 rounded-full">
                                {detectedCount} field{detectedCount !== 1 ? "s" : ""}
                              </span>
                            ) : (
                              <span className="text-white/20">—</span>
                            )}
                          </td>
                          <td className="p-4 text-muted-foreground truncate max-w-[160px]">
                            {ev.gclid || ev.hashedPhone || ev.hashedEmail || ev.billingAddress || ev.fbclid || 'N/A'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </PremiumCard>
          )}
        </>
      )}

      {activeTab === "ingestion" && effectiveTenantId && (
        <IngestionModePanel tenantId={effectiveTenantId} />
      )}

      {activeTab === "funnel-aliases" && effectiveTenantId && (
        <FunnelAliasesPanel tenantId={effectiveTenantId} />
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

                {((selectedEvent as Record<string, unknown>).resolvedLeadSource || (selectedEvent as Record<string, unknown>).resolvedFunnel) && (
                  <DetailSection title="Resolved Identity" icon={<Zap className="w-4 h-4" />}>
                    <DetailRow label="Resolved Source" value={(selectedEvent as Record<string, unknown>).resolvedLeadSource as string} />
                    <DetailRow label="Resolved Funnel" value={(selectedEvent as Record<string, unknown>).resolvedFunnel as string} />
                  </DetailSection>
                )}

                {(selectedEvent as Record<string, unknown>).detectedMappings && (
                  <DetailSection title="Auto-Detected Fields" icon={<Brain className="w-4 h-4" />}>
                    <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-2">
                      {Object.entries((selectedEvent as Record<string, unknown>).detectedMappings as Record<string, { mapsTo: string; method: string; confidence: number }>).map(([fieldName, info]) => (
                        <div key={fieldName} className="flex items-center justify-between gap-2 text-sm">
                          <span className="text-muted-foreground font-mono text-xs">{fieldName}</span>
                          <div className="flex items-center gap-2">
                            <ArrowRight className="w-3 h-3 text-white/20" />
                            <span className="text-white text-xs">{info.mapsTo}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                              info.method === "saved_rule" ? "bg-blue-400/10 text-blue-400" :
                              info.method === "value_pattern" ? "bg-emerald-400/10 text-emerald-400" :
                              "bg-amber-400/10 text-amber-400"
                            }`}>
                              {info.method.replace("_", " ")}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </DetailSection>
                )}

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

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
        active
          ? "bg-white/10 text-white border border-white/10"
          : "text-muted-foreground hover:text-white hover:bg-white/5 border border-transparent"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function IngestionModePanel({ tenantId }: { tenantId: number }) {
  const [mode, setMode] = useState<IngestionMode>("sheets");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/ingestion-mode?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setMode(d.mode || "sheets"))
      .finally(() => setLoading(false));
  }, [tenantId]);

  const updateMode = async (newMode: IngestionMode) => {
    setSaving(true);
    await fetch(`${API_BASE}/api/ingestion-mode?tenantId=${tenantId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: newMode }),
    });
    setMode(newMode);
    setSaving(false);
  };

  const loadSnippet = async () => {
    const res = await fetch(`${API_BASE}/api/ingestion-mode/gtm-snippet?tenantId=${tenantId}`, { credentials: "include" });
    const d = await res.json();
    setSnippet(d.snippet);
  };

  const copySnippet = () => {
    if (snippet) {
      navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading) {
    return <PremiumCard className="p-8"><p className="text-muted-foreground text-sm">Loading...</p></PremiumCard>;
  }

  const steps = [
    { key: "sheets" as const, label: "Google Sheets Only", desc: "Leads come from sheet sync. Tracker records attribution events only — safe for testing.", icon: <FileText className="w-5 h-5" /> },
    { key: "both" as const, label: "Dual Mode", desc: "Both sheet sync and tracker create leads. Phone deduplication prevents doubles.", icon: <ShieldCheck className="w-5 h-5" /> },
    { key: "tracker" as const, label: "Tracker Only", desc: "Sheet sync is disabled. All leads come from the JavaScript tracker.", icon: <Zap className="w-5 h-5" /> },
  ];

  return (
    <div className="space-y-6">
      <PremiumCard className="p-6">
        <h3 className="text-lg font-medium text-white mb-1">Lead Ingestion Mode</h3>
        <p className="text-sm text-muted-foreground mb-6">Control how leads flow into the system. Progress through these stages as you verify tracker accuracy.</p>

        <div className="grid gap-4 md:grid-cols-3">
          {steps.map((step, i) => (
            <button
              key={step.key}
              disabled={saving}
              onClick={() => updateMode(step.key)}
              className={`relative p-5 rounded-xl border text-left transition-all ${
                mode === step.key
                  ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                  : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/20"
              }`}
            >
              {mode === step.key && (
                <div className="absolute top-3 right-3">
                  <Check className="w-4 h-4 text-primary" />
                </div>
              )}
              <div className={`mb-3 ${mode === step.key ? "text-primary" : "text-muted-foreground"}`}>
                {step.icon}
              </div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-muted-foreground">Step {i + 1}</span>
              </div>
              <h4 className={`font-medium text-sm mb-1 ${mode === step.key ? "text-white" : "text-white/70"}`}>{step.label}</h4>
              <p className="text-xs text-muted-foreground leading-relaxed">{step.desc}</p>
            </button>
          ))}
        </div>
      </PremiumCard>

      <PremiumCard className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-medium text-white mb-1">GTM Snippet</h3>
            <p className="text-sm text-muted-foreground">Copy this into your Google Tag Manager custom HTML tag.</p>
          </div>
          <Button variant="outline" size="sm" onClick={loadSnippet} className="gap-2">
            <Code className="w-4 h-4" />
            Generate Snippet
          </Button>
        </div>

        {snippet && (
          <div className="relative">
            <button
              onClick={copySnippet}
              className="absolute top-3 right-3 p-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-white/60" />}
            </button>
            <pre className="bg-black/40 border border-white/10 rounded-lg p-4 text-xs text-emerald-300/80 overflow-x-auto max-h-[400px] overflow-y-auto font-mono whitespace-pre-wrap">
              {snippet}
            </pre>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

function FunnelAliasesPanel({ tenantId }: { tenantId: number }) {
  const [groups, setGroups] = useState<FunnelAliasGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [newAlias, setNewAlias] = useState("");
  const [selectedFunnelId, setSelectedFunnelId] = useState<string>("");
  const [funnelTypes, setFunnelTypes] = useState<{ id: number; name: string }[]>([]);

  const loadAliases = useCallback(async () => {
    const res = await fetch(`${API_BASE}/api/funnel-aliases?tenantId=${tenantId}`, { credentials: "include" });
    const d = await res.json();
    setGroups(d.aliases || []);
  }, [tenantId]);

  const loadFunnelTypes = useCallback(async () => {
    const res = await fetch(`${API_BASE}/api/funnel-types?tenantId=${tenantId}`, { credentials: "include" });
    const d = await res.json();
    setFunnelTypes(d.funnelTypes || d || []);
  }, [tenantId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadAliases(), loadFunnelTypes()]).finally(() => setLoading(false));
  }, [loadAliases, loadFunnelTypes]);

  const addAlias = async () => {
    if (!newAlias.trim() || !selectedFunnelId) return;
    await fetch(`${API_BASE}/api/funnel-aliases?tenantId=${tenantId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ funnelTypeId: Number(selectedFunnelId), alias: newAlias.trim() }),
    });
    setNewAlias("");
    await loadAliases();
  };

  const deleteAlias = async (id: number) => {
    await fetch(`${API_BASE}/api/funnel-aliases/${id}?tenantId=${tenantId}`, {
      method: "DELETE",
      credentials: "include",
    });
    await loadAliases();
  };

  const loadDefaults = async () => {
    await fetch(`${API_BASE}/api/funnel-aliases/load-defaults?tenantId=${tenantId}`, {
      method: "POST",
      credentials: "include",
    });
    await loadAliases();
  };

  if (loading) {
    return <PremiumCard className="p-8"><p className="text-muted-foreground text-sm">Loading...</p></PremiumCard>;
  }

  return (
    <div className="space-y-6">
      <PremiumCard className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-medium text-white mb-1">Funnel Aliases</h3>
            <p className="text-sm text-muted-foreground">Map raw form values to canonical funnel types. When a form submission says "ac repair", the system maps it to your "Repair" funnel.</p>
          </div>
          <Button variant="outline" size="sm" onClick={loadDefaults} className="gap-2">
            <Zap className="w-4 h-4" />
            Load HVAC Defaults
          </Button>
        </div>

        <div className="flex gap-2 mb-6">
          <Select value={selectedFunnelId} onValueChange={setSelectedFunnelId}>
            <SelectTrigger className="w-[200px] bg-white/5 border-white/10 text-sm">
              <SelectValue placeholder="Select funnel type" />
            </SelectTrigger>
            <SelectContent>
              {funnelTypes.map(ft => (
                <SelectItem key={ft.id} value={String(ft.id)}>{ft.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Type an alias..."
            value={newAlias}
            onChange={e => setNewAlias(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addAlias()}
            className="max-w-[200px] bg-white/5 border-white/10 text-sm"
          />
          <Button variant="outline" size="sm" onClick={addAlias} disabled={!newAlias.trim() || !selectedFunnelId}>Add</Button>
        </div>

        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No funnel aliases configured yet. Load defaults to get started.</p>
        ) : (
          <div className="space-y-4">
            {groups.map(g => (
              <div key={g.funnelTypeId} className="bg-white/[0.02] border border-white/5 rounded-lg p-4">
                <h4 className="text-sm font-medium text-white mb-2">{g.funnelName}</h4>
                <div className="flex flex-wrap gap-2">
                  {g.aliases.map(a => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-white/70"
                    >
                      {a.alias}
                      <button
                        onClick={() => deleteAlias(a.id)}
                        className="text-white/30 hover:text-red-400 transition-colors"
                      >
                        ×
                      </button>
                    </span>
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
