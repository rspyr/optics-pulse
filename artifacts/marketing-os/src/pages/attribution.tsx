import { useState, useEffect, useCallback, useRef } from "react";
import { useListAttributionEvents, useGetAttributionEvent, getListAttributionEventsQueryKey, getGetAttributionEventQueryKey } from "@workspace/api-client-react";
import type { AttributionEvent } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { PremiumCard, GradientHeading, Badge } from "@/components/ui-helpers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { UnmatchedFieldsPanel, usePrefetchScopedRules } from "./unmatched-fields-panel";
import { useOptionalLeadNotification } from "@/contexts/lead-notification-context";
import { toast as sonnerToast } from "sonner";
import { formatFieldValue } from "@/lib/format-field-value";
import { subscribeRederiveOnce } from "@/lib/rule-rederive-subscription";
import { formatLastAttempted } from "./unmatched-fields-panel";
import { CapturePathBadge } from "@/components/capture-path-badge";
import { PendingRederiveLeadsSheet } from "@/components/pending-rederive-leads-sheet";
import { format } from "date-fns";
import {
  Target, AlertTriangle, Globe, MousePointerClick, Phone, FileText, ExternalLink,
  Tag, Fingerprint, MapPin, Briefcase, User, Link2, Filter, Copy, Check,
  Zap, ArrowRight, ShieldCheck, Settings2, Brain, Edit3, Activity, Settings,
  Upload, Info, Clock, Lightbulb, Loader2, ChevronLeft, ChevronRight,
} from "lucide-react";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type IngestionMode = "sheets" | "both" | "tracker";

interface FunnelAliasGroup {
  funnelTypeId: number;
  funnelName: string;
  aliases: { id: number; alias: string }[];
}

export default function Attribution() {
  const { tenants, localTenantId, effectiveTenantId, setSelectedTenantId, isAgency, tenantsLoading } = useTenantFilter();
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterMatch, setFilterMatch] = useState<string>("all");
  const [filterSource, setFilterSource] = useState<string>("all");
  const [filterFunnel, setFilterFunnel] = useState<string>("all");
  const [filterDateRange, setFilterDateRange] = useState<string>("all");
  const [filterSubdomainRule, setFilterSubdomainRule] = useState<string>("all");
  const [searchText, setSearchText] = useState("");
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(50);
  const [page, setPage] = useState(1);
  const [activeTab, setActiveTab] = useState<"events" | "ingestion" | "funnel-aliases" | "subdomain-rules">("events");
  const [highlightSubdomainRule, setHighlightSubdomainRule] = useState<{ subdomain: string; nonce: number } | null>(null);

  const jumpToSubdomainRule = useCallback((subdomain: string) => {
    setSelectedEventId(null);
    setActiveTab("subdomain-rules");
    setHighlightSubdomainRule({ subdomain, nonce: Date.now() });
  }, []);

  // Mirrors extractSubdomain() on the server so we can show, inline on each
  // event row, which subdomain rule (if any) covers it.
  const extractSubdomain = useCallback((pageUrl: string | null | undefined): string | null => {
    if (!pageUrl) return null;
    try {
      let host = new URL(pageUrl).hostname.toLowerCase();
      if (host.startsWith("www.")) host = host.slice(4);
      const parts = host.split(".").filter(Boolean);
      if (parts.length < 3) return null;
      return parts.slice(0, parts.length - 2).join(".");
    } catch { return null; }
  }, []);

  const [subdomainRules, setSubdomainRules] = useState<Map<string, { id: number; subdomain: string; funnelName: string }>>(new Map());
  useEffect(() => {
    if (!effectiveTenantId) { setSubdomainRules(new Map()); return; }
    let cancelled = false;
    fetch(`${API_BASE}/api/subdomain-funnel-rules?tenantId=${effectiveTenantId}`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : { rules: [] }))
      .then(d => {
        if (cancelled) return;
        const map = new Map<string, { id: number; subdomain: string; funnelName: string }>();
        for (const r of (d.rules || []) as Array<{ id: number; subdomain: string; funnelName: string }>) {
          map.set(r.subdomain.toLowerCase(), r);
        }
        setSubdomainRules(map);
      })
      .catch(() => { if (!cancelled) setSubdomainRules(new Map()); });
    return () => { cancelled = true; };
  }, [effectiveTenantId]);

  const queryClient = useQueryClient();

  // Don't issue the cross-tenant "give me everything" fetch when the operator
  // hasn't picked a tenant — agency users get a "select a tenant" prompt
  // below instead.
  const listEventsParams = effectiveTenantId
    ? { tenantId: effectiveTenantId, limit: pageSize, offset: (page - 1) * pageSize }
    : { limit: pageSize, offset: (page - 1) * pageSize };
  const { data } = useListAttributionEvents(
    listEventsParams,
    {
      query: {
        enabled: !isAgency || effectiveTenantId != null,
        queryKey: getListAttributionEventsQueryKey(listEventsParams),
      },
    },
  );

  type SubdomainSuggestion = {
    subdomain: string;
    suggestedFunnelTypeId: number;
    suggestedFunnelName: string;
    eventCount: number;
    fellThroughCount: number;
    reason?: "observed" | "label-match";
    matchedAlias?: string;
  };
  const [suggestions, setSuggestions] = useState<SubdomainSuggestion[]>([]);
  const [hiddenSubdomains, setHiddenSubdomains] = useState<string[]>([]);
  const [acceptingSuggestion, setAcceptingSuggestion] = useState<string | null>(null);
  const [suggestionToast, setSuggestionToast] = useState<string | null>(null);
  const [showHiddenList, setShowHiddenList] = useState(false);

  const refetchSuggestions = useCallback(() => {
    if (!effectiveTenantId) {
      setSuggestions([]);
      setHiddenSubdomains([]);
      return;
    }
    fetch(`${API_BASE}/api/subdomain-funnel-rules/suggestions?tenantId=${effectiveTenantId}`, {
      credentials: "include",
    })
      .then(r => (r.ok ? r.json() : { suggestions: [], hiddenSubdomains: [] }))
      .then(d => {
        setSuggestions(d.suggestions || []);
        setHiddenSubdomains(d.hiddenSubdomains || []);
      })
      .catch(() => {
        setSuggestions([]);
        setHiddenSubdomains([]);
      });
  }, [effectiveTenantId]);

  useEffect(() => {
    refetchSuggestions();
  }, [refetchSuggestions]);

  const dismissSuggestion = useCallback(async (subdomain: string) => {
    if (!effectiveTenantId) return;
    // Optimistic: drop from visible list and add to hidden list immediately.
    setSuggestions(prev => prev.filter(s => s.subdomain !== subdomain));
    setHiddenSubdomains(prev => (prev.includes(subdomain) ? prev : [...prev, subdomain]));
    try {
      const res = await fetch(`${API_BASE}/api/subdomain-funnel-rules/suggestions/dismiss?tenantId=${effectiveTenantId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain }),
      });
      // Non-2xx (e.g. 400/403 from missing session/tenant context) means the
      // dismissal wasn't persisted; re-sync with the server so a refresh
      // doesn't surprise the user by bringing the suggestion back.
      if (!res.ok) refetchSuggestions();
    } catch {
      // Network error — fall back to a refetch so the UI matches server state.
      refetchSuggestions();
    }
  }, [effectiveTenantId, refetchSuggestions]);

  const undoAllDismissals = useCallback(async () => {
    if (!effectiveTenantId) return;
    try {
      await fetch(`${API_BASE}/api/subdomain-funnel-rules/suggestions/undo-dismiss?tenantId=${effectiveTenantId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } finally {
      refetchSuggestions();
    }
  }, [effectiveTenantId, refetchSuggestions]);

  const undoSingleDismissal = useCallback(async (subdomain: string) => {
    if (!effectiveTenantId) return;
    // Optimistic: remove from hidden list immediately.
    setHiddenSubdomains(prev => prev.filter(s => s !== subdomain));
    try {
      const res = await fetch(`${API_BASE}/api/subdomain-funnel-rules/suggestions/undo-dismiss?tenantId=${effectiveTenantId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain }),
      });
      if (!res.ok) refetchSuggestions();
      else refetchSuggestions();
    } catch {
      refetchSuggestions();
    }
  }, [effectiveTenantId, refetchSuggestions]);

  const acceptSuggestion = useCallback(async (s: SubdomainSuggestion) => {
    if (!effectiveTenantId) return;
    setAcceptingSuggestion(s.subdomain);
    try {
      const res = await fetch(`${API_BASE}/api/subdomain-funnel-rules?tenantId=${effectiveTenantId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain: s.subdomain, funnelTypeId: s.suggestedFunnelTypeId }),
      });
      const d = await res.json();
      if (!res.ok) {
        setSuggestionToast(d.error || "Failed to create rule");
      } else {
        setSuggestionToast(
          `Rule created: ${s.subdomain} → ${s.suggestedFunnelName}. Updated ${d.updatedEventCount ?? 0} past event${(d.updatedEventCount ?? 0) === 1 ? "" : "s"}.`,
        );
        refetchSuggestions();
        queryClient.invalidateQueries({ queryKey: getListAttributionEventsQueryKey() });
        // Cross-page signal so Pulse refetches the leads-hub queue and any
        // open lead's funnel updates within ~1-2s instead of waiting for the
        // 15s background refresh or a lead reopen.
        try {
          if (typeof BroadcastChannel !== "undefined") {
            const ch = new BroadcastChannel("pulse");
            ch.postMessage({ type: "leads-refresh", reason: "subdomain-rule-created" });
            ch.close();
          }
          window.dispatchEvent(new CustomEvent("pulse:leads-refresh", { detail: { reason: "subdomain-rule-created" } }));
        } catch {}
      }
    } catch {
      setSuggestionToast("Failed to create rule");
    } finally {
      setAcceptingSuggestion(null);
    }
  }, [effectiveTenantId, refetchSuggestions, queryClient]);

  const { data: detailData } = useGetAttributionEvent(selectedEventId!, {
    query: {
      queryKey: ["attribution-event", selectedEventId] as const,
      enabled: selectedEventId != null,
    },
  });

  const events: AttributionEvent[] = data?.events || [];
  const totalEvents: number = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalEvents / pageSize));

  // Reset to page 1 whenever filters, search, page size, or tenant changes —
  // otherwise users can land on an empty page when the result set shrinks.
  useEffect(() => {
    setPage(1);
  }, [
    pageSize,
    filterType,
    filterMatch,
    filterSource,
    filterFunnel,
    filterDateRange,
    filterSubdomainRule,
    searchText,
    effectiveTenantId,
  ]);

  // Clamp page back into range if total shrinks below the current page.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const uniqueSources = [...new Set(events.map(ev => ev.resolvedLeadSource || ev.utmSource || "").filter(Boolean))];
  const uniqueFunnels = [...new Set(events.map(ev => ev.resolvedFunnel || "").filter(Boolean))];

  const filteredEvents = events.filter(ev => {
    if (filterType !== "all" && ev.eventType !== filterType) return false;
    if (filterMatch !== "all" && ev.matchLevel !== filterMatch) return false;
    if (filterSource !== "all") {
      const evSource = ev.resolvedLeadSource || ev.utmSource || "";
      if (evSource !== filterSource) return false;
    }
    if (filterFunnel !== "all") {
      const evFunnel = ev.resolvedFunnel || "";
      if (evFunnel !== filterFunnel) return false;
    }
    if (filterDateRange !== "all") {
      const evDate = new Date(ev.createdAt);
      const now = new Date();
      const daysAgo = filterDateRange === "1d" ? 1 : filterDateRange === "7d" ? 7 : filterDateRange === "30d" ? 30 : 0;
      if (daysAgo > 0 && evDate < new Date(now.getTime() - daysAgo * 86400000)) return false;
    }
    if (filterSubdomainRule !== "all") {
      const evSubdomain = extractSubdomain(ev.pageUrl);
      const matchingRule = evSubdomain ? subdomainRules.get(evSubdomain) : undefined;
      if (filterSubdomainRule === "__none__") {
        if (matchingRule) return false;
      } else {
        if (!matchingRule || matchingRule.subdomain !== filterSubdomainRule) return false;
      }
    }
    if (searchText) {
      const s = searchText.toLowerCase();
      const searchable = [
        ev.utmSource, ev.utmCampaign, ev.gclid, ev.fbclid,
        ev.pageUrl, ev.landingPage, ev.formName,
        ev.resolvedLeadSource,
        ev.resolvedFunnel,
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

  // Opportunistically prefetch field-mapping rules for every visible unmatched
  // event so the first time the operator opens the per-event sheet and expands
  // the "Why unmatched?" panel, the rule list is already in cache. Deduped by
  // scope inside the hook; errors are swallowed.
  const prefetchTargets = effectiveTenantId
    ? filteredEvents
        .filter((ev) => ev.matchLevel === "unmatched")
        .map((ev) => ({
          tenantId: effectiveTenantId,
          pageUrl: ev.pageUrl ?? null,
          formId: ev.formId ?? null,
          formName: ev.formName ?? null,
        }))
    : [];
  usePrefetchScopedRules(prefetchTargets);

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
            <Select
              value={localTenantId != null ? String(localTenantId) : "all"}
              onValueChange={v => setSelectedTenantId(v === "all" ? null : parseInt(v))}
            >
              <SelectTrigger className="w-auto bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Tenants</SelectItem>
                {tenants.map(t => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {localTenantId == null && (
              <span className="text-[11px] text-white/40">
                Ingestion Mode &amp; Funnel Aliases tabs require a specific tenant.
              </span>
            )}
          </div>
        </PremiumCard>
      )}

      {isAgency && effectiveTenantId == null && tenantsLoading && (
        <PremiumCard className="p-6">
          <div className="animate-pulse space-y-3">
            <div className="h-4 w-1/3 bg-white/10 rounded" />
            <div className="h-3 w-1/2 bg-white/5 rounded" />
            <div className="h-3 w-2/5 bg-white/5 rounded" />
          </div>
        </PremiumCard>
      )}

      {isAgency && effectiveTenantId == null && !tenantsLoading && (
        <PremiumCard className="p-6">
          <p className="text-sm text-white/50">
            Select a tenant above (or in the header SCOPE chip) to view attribution events.
          </p>
        </PremiumCard>
      )}

      <div className="flex gap-2">
        <TabButton active={activeTab === "events"} onClick={() => setActiveTab("events")} icon={<Target className="w-4 h-4" />} label="Events" />
        <TabButton active={activeTab === "ingestion"} onClick={() => setActiveTab("ingestion")} icon={<Settings2 className="w-4 h-4" />} label="Ingestion Mode" />
        <TabButton active={activeTab === "funnel-aliases"} onClick={() => setActiveTab("funnel-aliases")} icon={<Brain className="w-4 h-4" />} label="Funnel Aliases" />
        <TabButton active={activeTab === "subdomain-rules"} onClick={() => setActiveTab("subdomain-rules")} icon={<Globe className="w-4 h-4" />} label="Subdomain Rules" />
      </div>

      {(activeTab === "events" || activeTab === "subdomain-rules") && (suggestions.length > 0 || hiddenSubdomains.length > 0) && (
        <PremiumCard className="p-4 border-amber-400/20 bg-amber-400/[0.03]">
          <div className="flex items-start gap-3">
            <Lightbulb className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-medium text-white">Suggested subdomain rules</h4>
                <span className="text-xs text-muted-foreground">
                  Based on the last 90 days of traffic and your funnel names.
                </span>
              </div>
              <div className="space-y-1.5">
                {suggestions.map(s => (
                    <div
                      key={s.subdomain}
                      className="flex items-start gap-3 bg-white/[0.02] border border-white/5 rounded-md px-3 py-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="font-mono text-sm text-white/80">{s.subdomain}</span>
                          <ArrowRight className="w-3 h-3 text-white/30 flex-shrink-0" />
                          <span className="text-sm text-emerald-400">{s.suggestedFunnelName}</span>
                          <span className="text-xs text-muted-foreground">
                            {s.eventCount} event{s.eventCount === 1 ? "" : "s"}
                            {s.fellThroughCount > 0 && (
                              <> · {s.fellThroughCount} would be re-tagged</>
                            )}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground/80 mt-1">
                          {s.reason === "label-match"
                            ? s.matchedAlias
                              ? `All ${s.eventCount} events fell through to the default funnel, but the subdomain name matches alias "${s.matchedAlias}" for funnel "${s.suggestedFunnelName}".`
                              : `All ${s.eventCount} events fell through to the default funnel, but the subdomain name matches "${s.suggestedFunnelName}".`
                            : `Every tagged event on this subdomain in the last 90 days resolved to "${s.suggestedFunnelName}".`}
                        </p>
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={acceptingSuggestion === s.subdomain}
                          onClick={() => acceptSuggestion(s)}
                        >
                          {acceptingSuggestion === s.subdomain ? "Creating…" : "Create rule"}
                        </Button>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-white/70 transition-colors px-1"
                          onClick={() => dismissSuggestion(s.subdomain)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
              {hiddenSubdomains.length > 0 && (
                <div className="text-xs text-muted-foreground space-y-1.5">
                  <p>
                    <button
                      type="button"
                      className="underline hover:text-white/70 transition-colors"
                      onClick={() => setShowHiddenList(v => !v)}
                    >
                      {hiddenSubdomains.length} hidden suggestion{hiddenSubdomains.length === 1 ? "" : "s"}
                    </button>
                    {" · "}
                    <button
                      type="button"
                      className="underline hover:text-white/70 transition-colors"
                      onClick={undoAllDismissals}
                    >
                      Show all
                    </button>
                  </p>
                  {showHiddenList && (
                    <ul className="space-y-1 pl-1">
                      {hiddenSubdomains.map(sub => (
                        <li
                          key={sub}
                          className="flex items-center gap-3 bg-white/[0.02] border border-white/5 rounded-md px-3 py-1.5"
                        >
                          <span className="font-mono text-xs text-white/70 flex-1 min-w-0 truncate">{sub}</span>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground hover:text-white/80 transition-colors px-1"
                            onClick={() => undoSingleDismissal(sub)}
                          >
                            Restore
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {suggestionToast && (
                <p className="text-xs text-emerald-300/80">{suggestionToast}</p>
              )}
            </div>
          </div>
        </PremiumCard>
      )}

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
              {uniqueSources.length > 0 && (
                <Select value={filterSource} onValueChange={setFilterSource}>
                  <SelectTrigger className="w-[140px] bg-white/5 border border-white/10 text-sm">
                    <SelectValue placeholder="Source" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sources</SelectItem>
                    {uniqueSources.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              {uniqueFunnels.length > 0 && (
                <Select value={filterFunnel} onValueChange={setFilterFunnel}>
                  <SelectTrigger className="w-[140px] bg-white/5 border border-white/10 text-sm">
                    <SelectValue placeholder="Funnel" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Funnels</SelectItem>
                    {uniqueFunnels.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <Select value={filterDateRange} onValueChange={setFilterDateRange}>
                <SelectTrigger className="w-[120px] bg-white/5 border border-white/10 text-sm">
                  <SelectValue placeholder="Date Range" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Time</SelectItem>
                  <SelectItem value="1d">Last 24h</SelectItem>
                  <SelectItem value="7d">Last 7 days</SelectItem>
                  <SelectItem value="30d">Last 30 days</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterSubdomainRule} onValueChange={setFilterSubdomainRule}>
                <SelectTrigger className="w-[180px] bg-white/5 border border-white/10 text-sm">
                  <SelectValue placeholder="Subdomain Rule" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All rules</SelectItem>
                  <SelectItem value="__none__">No matching rule</SelectItem>
                  {[...subdomainRules.values()]
                    .sort((a, b) => a.subdomain.localeCompare(b.subdomain))
                    .map(r => (
                      <SelectItem key={r.id} value={r.subdomain}>
                        {r.subdomain} → {r.funnelName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Search source, campaign, URL..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="max-w-[260px] bg-white/5 border-white/10 text-sm"
              />
              <div className="flex items-center gap-3 ml-auto">
                <span className="text-xs text-muted-foreground">
                  {(() => {
                    if (totalEvents === 0) return "0 events";
                    const start = (page - 1) * pageSize + 1;
                    const end = Math.min(page * pageSize, totalEvents);
                    const base = `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${totalEvents.toLocaleString()} event${totalEvents !== 1 ? "s" : ""}`;
                    // Filters are applied client-side to the current page, so
                    // when active, call out how many of the loaded rows match.
                    const filtersActive =
                      filterType !== "all" || filterMatch !== "all" || filterSource !== "all" ||
                      filterFunnel !== "all" || filterDateRange !== "all" || filterSubdomainRule !== "all" ||
                      searchText.trim() !== "";
                    if (!filtersActive) return base;
                    return `${base} · ${filteredEvents.length} match${filteredEvents.length === 1 ? "" : "es"} on this page`;
                  })()}
                </span>
                <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v) as 25 | 50 | 100)}>
                  <SelectTrigger className="w-[110px] bg-white/5 border border-white/10 text-sm">
                    <SelectValue placeholder="Page size" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="25">25 / page</SelectItem>
                    <SelectItem value="50">50 / page</SelectItem>
                    <SelectItem value="100">100 / page</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 bg-white/5 border border-white/10 disabled:opacity-40"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    data-testid="button-events-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-xs text-muted-foreground tabular-nums min-w-[72px] text-center">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 bg-white/5 border border-white/10 disabled:opacity-40"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    data-testid="button-events-next-page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </PremiumCard>

          <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
            <Info className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Matching considers attribution events from the last 90 days only. Older events will not be matched to jobs.</span>
          </div>

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
                      <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Page</th>
                      <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Match</th>
                      <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Lead</th>
                      <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredEvents.map((ev) => {
                      const resolvedSource = ev.resolvedLeadSource || ev.utmSource || ev.eventType;
                      const resolvedFunnel = ev.resolvedFunnel || null;
                      const detectedMappings = ev.detectedMappings ?? null;
                      const detectedCount = detectedMappings ? Object.keys(detectedMappings).length : 0;
                      const evSubdomain = extractSubdomain(ev.pageUrl);
                      const matchingRule = evSubdomain ? subdomainRules.get(evSubdomain) : undefined;

                      return (
                        <tr
                          key={ev.id}
                          className="group hover:bg-white/[0.02] transition-colors font-mono text-sm cursor-pointer"
                          onClick={() => setSelectedEventId(ev.id)}
                        >
                          <td className="p-4 text-muted-foreground">{format(new Date(ev.createdAt), 'MM/dd HH:mm:ss')}</td>
                          <td className="p-4 text-white uppercase">{ev.eventType.replace('_', ' ')}</td>
                          <td className="p-4 text-gray-400">{resolvedSource}</td>
                          <td className="p-4 text-gray-400">
                            <div className="flex flex-col gap-1">
                              <span>{resolvedFunnel || <span className="text-white/20">—</span>}</span>
                              {matchingRule && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); jumpToSubdomainRule(matchingRule.subdomain); }}
                                  className="self-start inline-flex items-center gap-1 text-[10px] font-sans text-blue-300/80 hover:text-blue-200 bg-blue-400/10 hover:bg-blue-400/15 border border-blue-400/20 rounded-full px-2 py-0.5 transition-colors"
                                  title={`Matches subdomain rule: ${matchingRule.subdomain} → ${matchingRule.funnelName}`}
                                >
                                  <Globe className="w-2.5 h-2.5" />
                                  <span>via {matchingRule.subdomain} rule</span>
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="p-4 text-muted-foreground truncate max-w-[120px]" title={ev.pageUrl || ""}>
                            {ev.pageUrl ? (() => { try { return new URL(ev.pageUrl).pathname; } catch { return ev.pageUrl; } })() : <span className="text-white/20">—</span>}
                          </td>
                          <td className="p-4">{getMatchBadge(ev.matchLevel)}</td>
                          <td className="p-4">
                            {ev.createdLeadId ? (
                              <span className="text-xs text-cyan-400 bg-cyan-400/10 border border-cyan-400/20 px-2 py-0.5 rounded-full">created</span>
                            ) : (
                              <span className="text-white/20">—</span>
                            )}
                          </td>
                          <td className="p-4">
                            {detectedCount > 0 ? (
                              <span className="text-xs text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 rounded-full">
                                {detectedCount} detected
                              </span>
                            ) : ev.gclid || ev.hashedPhone ? (
                              <span className="text-xs text-blue-400 bg-blue-400/10 border border-blue-400/20 px-2 py-0.5 rounded-full">
                                matched
                              </span>
                            ) : (
                              <span className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded-full">
                                unresolved
                              </span>
                            )}
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
        <FunnelAliasesPanel
          tenantId={effectiveTenantId}
          suggestions={suggestions}
          refetchSuggestions={refetchSuggestions}
        />
      )}

      {activeTab === "subdomain-rules" && effectiveTenantId && (
        <SubdomainRulesPanel
          tenantId={effectiveTenantId}
          onOpenEvent={(id) => {
            setActiveTab("events");
            setSelectedEventId(id);
          }}
          highlightRule={highlightSubdomainRule}
        />
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
                <div className="flex items-center gap-2 flex-wrap">
                  <SheetTitle className="text-white">Event #{selectedEvent.id}</SheetTitle>
                  <CapturePathBadge formType={selectedEvent.formType} />
                </div>
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

                {effectiveTenantId && (
                  <InlineIdentityCorrection
                    key={selectedEvent.id}
                    tenantId={effectiveTenantId}
                    event={selectedEvent}
                    matchedLead={matchedLead as ({ id: number; firstName?: string; lastName?: string; funnelOverriddenAt?: string | Date | null } | null | undefined)}
                    onJumpToSubdomainRule={jumpToSubdomainRule}
                  />
                )}

                {selectedEvent.detectedMappings && effectiveTenantId && (
                  <EditableAutoDetectedFields
                    key={`auto-${selectedEvent.id}`}
                    tenantId={effectiveTenantId}
                    event={selectedEvent}
                  />
                )}

                {effectiveTenantId && selectedEvent.matchLevel === "unmatched" && (
                  <DetailSection title="Why unmatched?" icon={<AlertTriangle className="w-4 h-4" />}>
                    <p className="text-xs text-muted-foreground mb-1">
                      Same panel as the Live Attribution Feed — backfill mapping rules from any past unmatched fill, not just live ones.
                    </p>
                    <UnmatchedFieldsPanel
                      key={`unmatched-${selectedEvent.id}`}
                      evt={{
                        tenantId: effectiveTenantId,
                        pageUrl: selectedEvent.pageUrl ?? null,
                        formId: selectedEvent.formId ?? null,
                        formName: selectedEvent.formName ?? null,
                        fieldNames: selectedEvent.fieldNames,
                        fieldValues: (selectedEvent.formFields ?? null) as Record<string, unknown> | null,
                        unmatchedReason: selectedEvent.unmatchedReason,
                        attributionEventId: selectedEvent.id,
                      }}
                    />
                  </DetailSection>
                )}

                {effectiveTenantId && selectedEvent.formFields && selectedEvent.matchLevel !== "unmatched" && (
                  <InlineFieldCorrection
                    key={`field-${selectedEvent.id}`}
                    tenantId={effectiveTenantId}
                    event={selectedEvent}
                  />
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

                {matchedJob && (
                  <DetailSection title="Outbound Push Status" icon={<Upload className="w-4 h-4" />}>
                    <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-2">
                      {[
                        { label: "Google OCI", value: matchedJob.ociUploadedAt },
                        { label: "Enhanced Conversions", value: matchedJob.enhancedConversionUploadedAt },
                        { label: "Meta CAPI", value: matchedJob.capiUploadedAt },
                      ].map(({ label, value: val }) => {
                        const uploaded = val != null;
                        return (
                          <div key={label} className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">{label}</span>
                            {uploaded ? (
                              <span className="text-xs text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                                <Check className="w-3 h-3" />
                                {format(new Date(val as string), 'MM/dd HH:mm')}
                              </span>
                            ) : (
                              <span className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                Pending
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </DetailSection>
                )}

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
                    <FormFieldsList formFields={selectedEvent.formFields as Record<string, unknown> | null | undefined} />
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

export function InlineIdentityCorrection({ tenantId, event, matchedLead, onJumpToSubdomainRule }: {
  tenantId: number;
  event: AttributionEvent;
  matchedLead?: { id: number; firstName?: string; lastName?: string; funnelOverriddenAt?: string | Date | null } | null;
  onJumpToSubdomainRule?: (subdomain: string) => void;
}) {
  const queryClient = useQueryClient();
  const resolvedSource = event.resolvedLeadSource ?? undefined;
  const resolvedFunnel = event.resolvedFunnel ?? undefined;
  const rawSource = event.utmSource || event.referrer || null;

  const detectedMappings = event.detectedMappings ?? null;
  const funnelFieldEntry = detectedMappings
    ? Object.entries(detectedMappings).find(([, v]) => v.mapsTo === "funnel")
    : null;
  const formFields = event.formFields as Record<string, unknown> | null;
  const rawFunnel = funnelFieldEntry && formFields
    ? (formFields[funnelFieldEntry[0]] as string) || resolvedFunnel || null
    : resolvedFunnel || null;

  const currentSourceDisplay = resolvedSource || rawSource || "";
  const currentFunnelDisplay = resolvedFunnel || rawFunnel || "";

  const [sourceAlias, setSourceAlias] = useState(currentSourceDisplay);
  const [customSourceMode, setCustomSourceMode] = useState(false);
  const [funnelTypeId, setFunnelTypeId] = useState("");
  const [funnelTypes, setFunnelTypes] = useState<{ id: number; name: string }[]>([]);
  const [knownSources, setKnownSources] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedSourceCount, setSavedSourceCount] = useState<{ events: number; leads: number } | null>(null);
  const [savedFunnelCount, setSavedFunnelCount] = useState<{ events: number; leads: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Task #549 (bug #3): default to per-lead scope so a Funnel dropdown save
  // doesn't silently retag every lead sharing the alias. Only show the
  // tenant-wide option when we actually have a lead to override (matchedLead).
  type FunnelScope = "lead" | "alias";
  // Default to "lead" when we have a matched lead, otherwise fall back to
  // "alias" — there's nothing to override without a lead, and forcing a
  // disabled scope toggle on screen just confuses operators.
  const initialFunnelScope: FunnelScope = "lead";
  const [funnelScope, setFunnelScope] = useState<FunnelScope>(initialFunnelScope);
  const [aliasPreview, setAliasPreview] = useState<{ events: number; leads: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pendingAliasConfirm, setPendingAliasConfirm] = useState(false);

  const funnelOverriddenAt = matchedLead?.funnelOverriddenAt
    ? (matchedLead.funnelOverriddenAt instanceof Date
        ? matchedLead.funnelOverriddenAt.toISOString()
        : matchedLead.funnelOverriddenAt)
    : null;
  const hasOverride = !!funnelOverriddenAt;

  useEffect(() => {
    fetch(`${API_BASE}/api/funnel-types?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        const types = d.funnelTypes || d || [];
        setFunnelTypes(types);
      })
      .catch(() => {});
    fetch(`${API_BASE}/api/lead-source-aliases?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        const aliases: { canonicalName: string }[] = d.aliases || [];
        const names = [...new Set(aliases.map(a => a.canonicalName))].sort();
        setKnownSources(names);
      })
      .catch(() => {});
  }, [tenantId]);

  // Task #549 (bug #2): re-sync the Funnel dropdown selection whenever the
  // event's resolved_funnel changes (after a save / refetch / event switch),
  // independent of when funnelTypes load. Previously the selection was only
  // seeded inside the funnelTypes fetch and never re-synced, so the dropdown
  // appeared stuck on the pre-save value after a successful retag. We only
  // overwrite the user's pick when the canonical value actually changed —
  // otherwise an in-progress edit (e.g. operator picked "Webinar" while the
  // event still says "Lead Magnet") would snap back to the resolved value.
  const lastSyncedFunnelRef = useRef<string | null>(null);
  useEffect(() => {
    if (funnelTypes.length === 0) return;
    if (lastSyncedFunnelRef.current === currentFunnelDisplay) return;
    lastSyncedFunnelRef.current = currentFunnelDisplay;
    if (!currentFunnelDisplay) return;
    const match = funnelTypes.find(ft => ft.name === currentFunnelDisplay);
    if (match) setFunnelTypeId(String(match.id));
  }, [currentFunnelDisplay, funnelTypes]);

  // Reset scope and any in-flight preview state when the operator switches
  // to a different attribution event. When the new event has no matched
  // lead, force alias scope so the operator isn't presented with a Save
  // button that has nothing to override.
  useEffect(() => {
    setFunnelScope(matchedLead?.id ? "lead" : "alias");
    setAliasPreview(null);
    setPendingAliasConfirm(false);
  }, [event.id, matchedLead?.id]);

  // Sync sourceAlias from known canonical names when they load.
  useEffect(() => {
    if (currentSourceDisplay && knownSources.includes(currentSourceDisplay)) {
      setSourceAlias(currentSourceDisplay);
    }
  }, [knownSources, currentSourceDisplay]);

  useEffect(() => {
    if (savedSourceCount !== null) {
      const t = setTimeout(() => setSavedSourceCount(null), 4000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [savedSourceCount]);

  useEffect(() => {
    if (savedFunnelCount !== null) {
      const t = setTimeout(() => setSavedFunnelCount(null), 4000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [savedFunnelCount]);

  const saveSourceAlias = async () => {
    if (!sourceAlias.trim()) return;
    const aliasKey = rawSource || sourceAlias.trim();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/lead-source-aliases?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ alias: aliasKey, canonicalName: sourceAlias.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to save source alias");
      } else {
        const d = await res.json().catch(() => ({}));
        const events = typeof d.updatedEventCount === "number" ? d.updatedEventCount : 0;
        const leads = typeof d.updatedLeadCount === "number" ? d.updatedLeadCount : 0;
        setSavedSourceCount({ events, leads });
        setCustomSourceMode(false);
        setKnownSources(prev => {
          const updated = [...new Set([...prev, sourceAlias.trim()])].sort();
          return updated;
        });
        // Refetch the events list and the open detail panel so the new
        // canonical source name shows up immediately without a manual reload.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListAttributionEventsQueryKey() as readonly unknown[], exact: false }),
          queryClient.invalidateQueries({ queryKey: getGetAttributionEventQueryKey(event.id) as readonly unknown[], exact: false }),
          queryClient.invalidateQueries({ queryKey: ["attribution-event", event.id] }),
        ]);
      }
    } catch { setError("Network error"); }
    setSaving(false);
  };

  const invalidateAttributionQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListAttributionEventsQueryKey() as readonly unknown[], exact: false }),
      queryClient.invalidateQueries({ queryKey: getGetAttributionEventQueryKey(event.id) as readonly unknown[], exact: false }),
      queryClient.invalidateQueries({ queryKey: ["attribution-event", event.id] }),
    ]);
  };

  const saveFunnelAlias = async () => {
    if (!funnelTypeId) return;
    const aliasKey = rawFunnel || funnelTypes.find(ft => ft.id === parseInt(funnelTypeId))?.name || "";
    if (!aliasKey) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/funnel-aliases?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ alias: aliasKey, funnelTypeId: parseInt(funnelTypeId) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to save funnel alias");
      } else {
        const d = await res.json().catch(() => ({}));
        const events = typeof d.updatedEventCount === "number" ? d.updatedEventCount : 0;
        const leads = typeof d.updatedLeadCount === "number" ? d.updatedLeadCount : 0;
        setSavedFunnelCount({ events, leads });
        setPendingAliasConfirm(false);
        setAliasPreview(null);
        await invalidateAttributionQueries();
      }
    } catch { setError("Network error"); }
    setSaving(false);
  };

  // Task #549 (bug #3): per-lead override save. Only flips this lead's
  // funnel and stamps funnel_overridden_at so a later tenant-wide alias
  // retag cannot stomp the operator's manual fix.
  const saveFunnelForLead = async () => {
    if (!funnelTypeId || !matchedLead?.id) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/leads/${matchedLead.id}/funnel-override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ funnelTypeId: parseInt(funnelTypeId), attributionEventId: event.id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to set funnel for this lead");
      } else {
        setSavedFunnelCount({ events: 1, leads: 1 });
        await invalidateAttributionQueries();
      }
    } catch { setError("Network error"); }
    setSaving(false);
  };

  // Task #549 (bug #3): clear a per-lead override and re-derive the lead's
  // funnel from its latest attribution event.
  const clearLeadOverride = async () => {
    if (!matchedLead?.id) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/leads/${matchedLead.id}/funnel-override?attributionEventId=${event.id}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to clear override");
      } else {
        await invalidateAttributionQueries();
      }
    } catch { setError("Network error"); }
    setSaving(false);
  };

  // Task #549 (bug #3): dry-run preview before tenant-wide retag, so the
  // operator sees exactly how many leads/events the alias save would touch.
  const fetchAliasPreview = async () => {
    if (!funnelTypeId) return;
    const aliasKey = rawFunnel || funnelTypes.find(ft => ft.id === parseInt(funnelTypeId))?.name || "";
    if (!aliasKey) return;
    setPreviewLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/funnel-aliases/preview?tenantId=${tenantId}&alias=${encodeURIComponent(aliasKey)}&funnelTypeId=${funnelTypeId}`,
        { credentials: "include" },
      );
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        setAliasPreview({ events: Number(d.events ?? 0), leads: Number(d.leads ?? 0) });
        setPendingAliasConfirm(true);
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to load preview");
      }
    } catch { setError("Network error"); }
    setPreviewLoading(false);
  };

  const sourceChanged = sourceAlias.trim() !== "" && sourceAlias !== currentSourceDisplay;
  const funnelChanged = funnelTypeId !== "" && (() => {
    const match = funnelTypes.find(ft => ft.name === currentFunnelDisplay);
    return !match || String(match.id) !== funnelTypeId;
  })();

  // --- Subdomain → funnel mapping (Task #436) ---
  const pageSubdomain = (() => {
    if (!event.pageUrl) return null;
    try {
      let host = new URL(event.pageUrl).hostname.toLowerCase();
      if (host.startsWith("www.")) host = host.slice(4);
      const parts = host.split(".").filter(Boolean);
      if (parts.length < 3) return null;
      return parts.slice(0, parts.length - 2).join(".");
    } catch { return null; }
  })();

  const [subdomainRule, setSubdomainRule] = useState<
    { id: number; subdomain: string; funnelTypeId: number; funnelName: string } | null
  >(null);
  const [subdomainRuleLoaded, setSubdomainRuleLoaded] = useState(false);
  const [subdomainFunnelTypeId, setSubdomainFunnelTypeId] = useState("");
  const [subdomainEditing, setSubdomainEditing] = useState(false);
  const [savedSubdomainCount, setSavedSubdomainCount] = useState<{ events: number; leads: number } | null>(null);

  useEffect(() => {
    if (!pageSubdomain) { setSubdomainRuleLoaded(true); return; }
    fetch(`${API_BASE}/api/subdomain-funnel-rules?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        const rules: Array<{ id: number; subdomain: string; funnelTypeId: number; funnelName: string }> = d.rules || [];
        const match = rules.find(r => r.subdomain === pageSubdomain) || null;
        setSubdomainRule(match);
        if (match) setSubdomainFunnelTypeId(String(match.funnelTypeId));
      })
      .catch(() => {})
      .finally(() => setSubdomainRuleLoaded(true));
  }, [tenantId, pageSubdomain]);

  useEffect(() => {
    if (savedSubdomainCount !== null) {
      const t = setTimeout(() => setSavedSubdomainCount(null), 4000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [savedSubdomainCount]);

  const saveSubdomainRule = async () => {
    if (!pageSubdomain || !subdomainFunnelTypeId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/subdomain-funnel-rules?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ subdomain: pageSubdomain, funnelTypeId: parseInt(subdomainFunnelTypeId) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to save subdomain rule");
      } else {
        const d = await res.json().catch(() => ({}));
        const events = typeof d.updatedEventCount === "number" ? d.updatedEventCount : 0;
        const leads = typeof d.updatedLeadCount === "number" ? d.updatedLeadCount : 0;
        setSavedSubdomainCount({ events, leads });
        if (d.rule) setSubdomainRule(d.rule);
        setSubdomainEditing(false);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListAttributionEventsQueryKey() as readonly unknown[], exact: false }),
          queryClient.invalidateQueries({ queryKey: getGetAttributionEventQueryKey(event.id) as readonly unknown[], exact: false }),
          queryClient.invalidateQueries({ queryKey: ["attribution-event", event.id] }),
        ]);
      }
    } catch { setError("Network error"); }
    setSaving(false);
  };

  const removeSubdomainRule = async () => {
    if (!subdomainRule) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/subdomain-funnel-rules/${subdomainRule.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to remove subdomain rule");
      } else {
        setSubdomainRule(null);
        setSubdomainFunnelTypeId("");
        setSubdomainEditing(false);
      }
    } catch { setError("Network error"); }
    setSaving(false);
  };

  return (
    <DetailSection title="Resolved Identity" icon={<Zap className="w-4 h-4" />}>
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Source</span>
          <div className="flex items-center gap-2">
            {!customSourceMode ? (
              <select
                value={sourceAlias}
                onChange={e => {
                  if (e.target.value === "__custom__") {
                    setCustomSourceMode(true);
                    setSourceAlias("");
                  } else {
                    setSourceAlias(e.target.value);
                  }
                }}
                className="flex-1 bg-black/40 border border-white/10 rounded text-xs text-white px-2 py-1.5 h-8"
              >
                <option value="">Select source...</option>
                {knownSources.map(s => <option key={s} value={s}>{s}</option>)}
                {currentSourceDisplay && !knownSources.includes(currentSourceDisplay) && (
                  <option value={currentSourceDisplay}>{currentSourceDisplay} (raw)</option>
                )}
                <option value="__custom__">+ New source...</option>
              </select>
            ) : (
              <div className="flex items-center gap-1 flex-1">
                <Input
                  value={sourceAlias}
                  onChange={e => setSourceAlias(e.target.value)}
                  placeholder="Enter source name"
                  className="h-8 text-xs flex-1 bg-black/40 border-white/10"
                  autoFocus
                />
                <button
                  onClick={() => { setCustomSourceMode(false); setSourceAlias(currentSourceDisplay); }}
                  className="text-[10px] text-muted-foreground hover:text-white whitespace-nowrap px-1"
                >
                  ← list
                </button>
              </div>
            )}
            {sourceChanged && (
              <Button size="sm" variant="ghost" disabled={saving} onClick={saveSourceAlias} className="text-xs h-8 px-2 shrink-0">
                Save
              </Button>
            )}
            {savedSourceCount !== null && <Check className="w-4 h-4 text-emerald-400 shrink-0" />}
          </div>
          {savedSourceCount !== null && (
            <p className="text-[10px] text-emerald-400 pl-0.5">
              {(() => {
                const { events, leads } = savedSourceCount;
                if (events === 0 && leads === 0) return "Saved · Nothing else needed updating";
                const parts: string[] = [];
                if (events > 0) parts.push(`${events} past event${events === 1 ? "" : "s"}`);
                if (leads > 0) parts.push(`${leads} lead${leads === 1 ? "" : "s"}`);
                return `Saved · Updated ${parts.join(" and ")}`;
              })()}
            </p>
          )}
          {rawSource && sourceAlias && sourceAlias !== rawSource && sourceAlias !== "__custom__" && !customSourceMode && (
            <p className="text-[10px] text-muted-foreground pl-0.5">Maps &quot;{rawSource}&quot; → {sourceAlias}</p>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Funnel</span>
            {hasOverride && (
              <button
                type="button"
                onClick={clearLeadOverride}
                disabled={saving}
                className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1 disabled:opacity-50"
                title={`Manually set${funnelOverriddenAt ? ` on ${new Date(funnelOverriddenAt).toLocaleString()}` : ""}. Click to undo and re-derive from latest event.`}
                data-testid="button-clear-funnel-override"
              >
                <ShieldCheck className="w-3 h-3" />
                Manually set — undo
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={funnelTypeId}
              onChange={e => {
                setFunnelTypeId(e.target.value);
                setPendingAliasConfirm(false);
                setAliasPreview(null);
              }}
              className="flex-1 bg-black/40 border border-white/10 rounded text-xs text-white px-2 py-1.5 h-8"
              data-testid="select-funnel-type"
            >
              <option value="">Select funnel...</option>
              {funnelTypes.map(ft => <option key={ft.id} value={ft.id}>{ft.name}</option>)}
            </select>
            {savedFunnelCount !== null && <Check className="w-4 h-4 text-emerald-400 shrink-0" />}
          </div>

          {funnelChanged && (
            <div className="mt-2 space-y-2 rounded border border-white/10 bg-black/20 px-2 py-2">
              {/* Task #549 (bug #3): scope toggle is only shown when there's
                  a matched lead to override. When the event has no linked
                  lead, the only meaningful action is the tenant-wide alias
                  retag — hide the toggle entirely instead of disabling the
                  per-lead branch. */}
              {matchedLead?.id && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { setFunnelScope("lead"); setPendingAliasConfirm(false); setAliasPreview(null); }}
                    className={`flex-1 text-[11px] h-7 rounded border px-2 transition-colors ${
                      funnelScope === "lead"
                        ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-200"
                        : "bg-black/40 border-white/10 text-white/60 hover:text-white"
                    }`}
                    title="Override only this lead's funnel"
                    data-testid="button-funnel-scope-lead"
                  >
                    Just this lead
                  </button>
                  <button
                    type="button"
                    onClick={() => { setFunnelScope("alias"); }}
                    className={`flex-1 text-[11px] h-7 rounded border px-2 transition-colors ${
                      funnelScope === "alias"
                        ? "bg-amber-500/20 border-amber-500/40 text-amber-200"
                        : "bg-black/40 border-white/10 text-white/60 hover:text-white"
                    }`}
                    title="Retag every lead in this tenant whose funnel matches this alias"
                    data-testid="button-funnel-scope-alias"
                  >
                    All leads with this funnel
                  </button>
                </div>
              )}

              {funnelScope === "lead" && matchedLead?.id && (
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-white/50">
                    Only this lead will change. Future alias edits won't touch it.
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={saveFunnelForLead}
                    className="text-xs h-7 px-2 shrink-0"
                    data-testid="button-save-funnel-lead"
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
              )}

              {funnelScope === "alias" && !pendingAliasConfirm && (
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-white/50">
                    Retags every lead in this tenant matching the same alias.
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving || previewLoading}
                    onClick={fetchAliasPreview}
                    className="text-xs h-7 px-2 shrink-0"
                    data-testid="button-preview-funnel-alias"
                  >
                    {previewLoading ? "Loading…" : "Preview"}
                  </Button>
                </div>
              )}

              {funnelScope === "alias" && pendingAliasConfirm && aliasPreview && (
                <div className="space-y-2">
                  <p className="text-[10px] text-amber-300" data-testid="text-alias-preview">
                    This will retag <strong>{aliasPreview.leads}</strong> lead{aliasPreview.leads === 1 ? "" : "s"}{" "}
                    and <strong>{aliasPreview.events}</strong> past event{aliasPreview.events === 1 ? "" : "s"} in this tenant.
                    {aliasPreview.leads === 0 && aliasPreview.events === 0 && " Nothing else matches — only this row will change."}
                  </p>
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => { setPendingAliasConfirm(false); setAliasPreview(null); }}
                      className="text-xs h-7 px-2"
                      data-testid="button-cancel-alias-save"
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={saveFunnelAlias}
                      className="text-xs h-7 px-2 bg-amber-500/10 border border-amber-500/30 text-amber-200 hover:bg-amber-500/20"
                      data-testid="button-confirm-alias-save"
                    >
                      {saving ? "Saving…" : "Confirm & save alias"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {savedFunnelCount !== null && (
            <p className="text-[10px] text-emerald-400 pl-0.5">
              {(() => {
                const { events, leads } = savedFunnelCount;
                if (events === 0 && leads === 0) return "Saved · Nothing else needed updating";
                const parts: string[] = [];
                if (events > 0) parts.push(`${events} past event${events === 1 ? "" : "s"}`);
                if (leads > 0) parts.push(`${leads} lead${leads === 1 ? "" : "s"}`);
                return `Saved · Updated ${parts.join(" and ")}`;
              })()}
            </p>
          )}
          {rawFunnel && funnelTypeId && (() => {
            const selected = funnelTypes.find(ft => String(ft.id) === funnelTypeId);
            return selected && selected.name !== rawFunnel ? (
              <p className="text-[10px] text-muted-foreground pl-0.5">Maps &quot;{rawFunnel}&quot; → {selected.name}</p>
            ) : null;
          })()}
        </div>

        {pageSubdomain && subdomainRuleLoaded && (
          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Subdomain</span>
            {subdomainRule && !subdomainEditing ? (
              <div className="flex items-center gap-2">
                {onJumpToSubdomainRule ? (
                  <button
                    type="button"
                    onClick={() => onJumpToSubdomainRule(subdomainRule.subdomain)}
                    className="flex-1 text-xs text-white/80 bg-black/40 border border-white/10 rounded px-2 py-1.5 h-8 flex items-center hover:bg-black/60 hover:border-white/20 transition-colors text-left"
                    title="Open in Subdomain Rules"
                  >
                    <span className="font-mono text-white/60">{subdomainRule.subdomain}</span>
                    <ArrowRight className="w-3 h-3 mx-1.5 text-white/30" />
                    <span>{subdomainRule.funnelName}</span>
                    <ExternalLink className="w-3 h-3 ml-auto text-white/30" />
                  </button>
                ) : (
                  <div className="flex-1 text-xs text-white/80 bg-black/40 border border-white/10 rounded px-2 py-1.5 h-8 flex items-center">
                    <span className="font-mono text-white/60">{subdomainRule.subdomain}</span>
                    <ArrowRight className="w-3 h-3 mx-1.5 text-white/30" />
                    <span>{subdomainRule.funnelName}</span>
                  </div>
                )}
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => setSubdomainEditing(true)} className="text-xs h-8 px-2 shrink-0">
                  Change
                </Button>
                <Button size="sm" variant="ghost" disabled={saving} onClick={removeSubdomainRule} className="text-xs h-8 px-2 shrink-0 text-white/50">
                  Undo
                </Button>
                {savedSubdomainCount !== null && <Check className="w-4 h-4 text-emerald-400 shrink-0" />}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-white/60 min-w-[80px] truncate" title={pageSubdomain}>{pageSubdomain}</span>
                <ArrowRight className="w-3 h-3 text-white/30 shrink-0" />
                <select
                  value={subdomainFunnelTypeId}
                  onChange={e => setSubdomainFunnelTypeId(e.target.value)}
                  className="flex-1 bg-black/40 border border-white/10 rounded text-xs text-white px-2 py-1.5 h-8"
                >
                  <option value="">Map to...</option>
                  {funnelTypes.map(ft => <option key={ft.id} value={ft.id}>{ft.name}</option>)}
                </select>
                {subdomainFunnelTypeId && (
                  <Button size="sm" variant="ghost" disabled={saving} onClick={saveSubdomainRule} className="text-xs h-8 px-2 shrink-0">
                    Save
                  </Button>
                )}
                {subdomainEditing && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      setSubdomainEditing(false);
                      setSubdomainFunnelTypeId(subdomainRule ? String(subdomainRule.funnelTypeId) : "");
                    }}
                    className="text-xs h-8 px-2 shrink-0 text-white/50"
                  >
                    Cancel
                  </Button>
                )}
                {savedSubdomainCount !== null && <Check className="w-4 h-4 text-emerald-400 shrink-0" />}
              </div>
            )}
            {savedSubdomainCount !== null && (
              <p className="text-[10px] text-emerald-400 pl-0.5">
                {(() => {
                  const { events, leads } = savedSubdomainCount;
                  if (events === 0 && leads === 0) return "Saved · Nothing else needed updating";
                  const parts: string[] = [];
                  if (events > 0) parts.push(`${events} past event${events === 1 ? "" : "s"}`);
                  if (leads > 0) parts.push(`${leads} lead${leads === 1 ? "" : "s"}`);
                  return `Saved · Updated ${parts.join(" and ")}`;
                })()}
              </p>
            )}
          </div>
        )}
      </div>
    </DetailSection>
  );
}

const FIELD_MAPPING_OPTIONS = ["firstName", "lastName", "fullName", "phone", "email", "address", "city", "state", "zip", "funnel", "appointmentDate", "appointmentTime"] as const;

function dispatchPulseRefresh(reason: string) {
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const ch = new BroadcastChannel("pulse");
      ch.postMessage({ type: "leads-refresh", reason });
      ch.close();
    }
    window.dispatchEvent(new CustomEvent("pulse:leads-refresh", { detail: { reason } }));
  } catch {}
}

export function EditableAutoDetectedFields({ tenantId, event }: { tenantId: number; event: AttributionEvent }) {
  const queryClient = useQueryClient();
  const notification = useOptionalLeadNotification();
  const onRuleRederiveComplete = notification?.onRuleRederiveComplete ?? null;
  const onRuleRederiveFailed = notification?.onRuleRederiveFailed ?? null;
  const detected = event.detectedMappings as Record<string, { mapsTo: string; method: string }> | null;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [rederiveHint, setRederiveHint] = useState<string | null>(null);
  const [refreshingHistorical, setRefreshingHistorical] = useState(false);
  const [rederiveError, setRederiveError] = useState<{
    reason: string;
    pendingLeads?: number;
    hitLimit?: boolean;
    maxLeads?: number;
    lastAttemptedAt?: string;
  } | null>(null);
  const lastSavedRef = useRef<{ fieldName: string; mapsTo: string; pagePath: string; formIdentifier: string } | null>(null);
  const [retryingRederive, setRetryingRederive] = useState(false);
  // Tracks whether the "View pending leads" sheet (opened from the re-derive
  // failure hint) is currently visible — lets operators drill into the actual
  // historical leads still pending an update after the back-fill failed.
  const [pendingLeadsSheetOpen, setPendingLeadsSheetOpen] = useState(false);

  if (!detected) return null;
  const entries = Object.entries(detected);
  if (entries.length === 0) return null;

  // Derived scope for the "View pending leads" sheet — same shape the save
  // path / retry use, computed straight from the event so we can open the
  // sheet even before the operator has made an in-session save.
  let pendingPagePath = "*";
  try { if (event.pageUrl) pendingPagePath = new URL(event.pageUrl).pathname || "*"; } catch {}
  const pendingFormIdentifier = event.formId || event.formName || "*";

  const subscribeForScope = (pagePath: string, formIdentifier: string) => {
    setRefreshingHistorical(true);
    return subscribeRederiveOnce(
      onRuleRederiveComplete,
      tenantId,
      pagePath,
      formIdentifier,
      (text) => {
        setRederiveHint(text);
        setRederiveError(null);
        sonnerToast.success(text);
        setTimeout(() => setRederiveHint(prev => (prev === text ? null : prev)), 6000);
      },
      () => setRefreshingHistorical(false),
      onRuleRederiveFailed,
      (data) => setRederiveError({
        reason: data.reason,
        pendingLeads: data.pendingLeads,
        hitLimit: data.hitLimit,
        maxLeads: data.maxLeads,
        lastAttemptedAt: data.lastAttemptedAt,
      }),
    );
  };

  const retryRederive = async () => {
    const last = lastSavedRef.current;
    if (!last) return;
    setRetryingRederive(true);
    setRederiveError(null);
    const unsubscribeRederive = subscribeForScope(last.pagePath, last.formIdentifier);
    try {
      const res = await fetch(`${API_BASE}/api/field-mapping-rules?tenantId=${tenantId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrlPattern: last.pagePath,
          formIdentifier: last.formIdentifier,
          fieldName: last.fieldName,
          mapsTo: last.mapsTo,
          attributionEventId: event.id,
        }),
      });
      if (!res.ok) {
        unsubscribeRederive();
        const d = await res.json().catch(() => ({}));
        setRederiveError({ reason: d.error || `Failed to retry (HTTP ${res.status})` });
      }
    } catch {
      unsubscribeRederive();
      setRederiveError({ reason: "Network error retrying re-derive." });
    } finally {
      setRetryingRederive(false);
    }
  };

  const save = async (fieldName: string, mapsTo: string) => {
    setSaving(true);
    setError(null);
    setRederiveError(null);
    let pagePath = "*";
    try { if (event.pageUrl) pagePath = new URL(event.pageUrl).pathname; } catch {}
    const formIdentifier = event.formId || event.formName || "*";
    lastSavedRef.current = { fieldName, mapsTo, pagePath, formIdentifier };
    const unsubscribeRederive = subscribeForScope(pagePath, formIdentifier);
    try {
      const res = await fetch(`${API_BASE}/api/field-mapping-rules?tenantId=${tenantId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrlPattern: pagePath,
          formIdentifier,
          fieldName,
          mapsTo,
          attributionEventId: event.id,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to save mapping");
        unsubscribeRederive();
        return;
      }
      const d = await res.json().catch(() => ({}));
      setEditing(null);
      setSavedFlash(fieldName);
      setTimeout(() => setSavedFlash(prev => (prev === fieldName ? null : prev)), 2000);
      queryClient.invalidateQueries({ queryKey: getListAttributionEventsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAttributionEventQueryKey(event.id) });
      queryClient.invalidateQueries({ queryKey: ["attribution-event", event.id] });
      if (d?.leadFunnelChanged) dispatchPulseRefresh("field-mapping-updated");
    } catch {
      setError("Network error");
      unsubscribeRederive();
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailSection title="Auto-Detected Fields" icon={<Brain className="w-4 h-4" />}>
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-2">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}
      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-2">
        {entries.map(([fieldName, info]) => {
          const isEditing = editing === fieldName;
          return (
            <div key={fieldName} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground font-mono text-xs">{fieldName}</span>
              {isEditing ? (
                <div className="flex items-center gap-2">
                  <select
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    className="bg-black/40 border border-white/10 rounded text-xs text-white px-2 py-1"
                  >
                    {FIELD_MAPPING_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                  <Button size="sm" variant="ghost" disabled={saving || !draft} onClick={() => save(fieldName, draft)} className="text-xs h-7 px-2">
                    {saving ? "..." : "Save"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)} className="text-xs h-7 px-2 text-muted-foreground">
                    Cancel
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { setEditing(fieldName); setDraft(info.mapsTo); setError(null); }}
                  className="flex items-center gap-2 hover:bg-white/[0.03] rounded px-1.5 py-0.5 transition-colors"
                  title="Click to edit this mapping"
                >
                  <ArrowRight className="w-3 h-3 text-white/20" />
                  <span className="text-white text-xs">{info.mapsTo}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                    info.method === "saved_rule" ? "bg-blue-400/10 text-blue-400" :
                    info.method === "value_pattern" ? "bg-emerald-400/10 text-emerald-400" :
                    "bg-amber-400/10 text-amber-400"
                  }`}>
                    {info.method.replace("_", " ")}
                  </span>
                  {savedFlash === fieldName ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Edit3 className="w-3 h-3 text-white/30" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground/70 mt-2">
        Click any mapping to override. Saving creates a field-mapping rule, re-runs detection, and refreshes the open lead.
      </p>
      {refreshingHistorical && !rederiveHint && (
        <p
          className="text-[10px] text-sky-300/85 italic mt-1 flex items-center gap-1.5"
          aria-live="polite"
          role="status"
          data-testid="refreshing-historical-hint"
        >
          <Loader2 className="w-3 h-3 animate-spin" />
          Refreshing historical leads…
        </p>
      )}
      {rederiveHint && (
        <p className="text-[10px] text-emerald-400/90 mt-1" aria-live="polite">
          {rederiveHint}
        </p>
      )}
      {rederiveError && (
        <div
          className="mt-1 flex items-center justify-between gap-2 bg-amber-500/[0.06] border border-amber-500/30 rounded-md px-2 py-1"
          role="status"
          aria-live="polite"
          data-testid="rederive-error-hint"
        >
          <span className="text-[10px] text-amber-200/90" title={rederiveError.reason}>
            Couldn't re-derive historical leads. Mapping is saved; only the back-fill failed.
            {typeof rederiveError.pendingLeads === "number" && (
              <>
                {" "}
                <span data-testid="rederive-pending-count">
                  {rederiveError.pendingLeads === 0
                    ? "No historical leads still need updating."
                    : `~${rederiveError.pendingLeads}${rederiveError.hitLimit ? "+" : ""} historical lead${rederiveError.pendingLeads === 1 ? "" : "s"} still need updating.`}
                </span>
              </>
            )}
            {rederiveError.lastAttemptedAt && (
              <>
                {" "}
                <span className="text-amber-200/60" data-testid="rederive-last-attempted">
                  Last tried {formatLastAttempted(rederiveError.lastAttemptedAt)}.
                </span>
              </>
            )}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {(rederiveError.pendingLeads ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => setPendingLeadsSheetOpen(true)}
                data-testid="rederive-view-pending-button"
                className="text-[10px] px-2 py-0.5 rounded border border-amber-400/50 text-amber-100 hover:bg-amber-500/15"
              >
                View pending leads
              </button>
            )}
            {lastSavedRef.current && (
              <button
                type="button"
                onClick={retryRederive}
                disabled={retryingRederive}
                data-testid="rederive-retry-button"
                className="text-[10px] px-2 py-0.5 rounded border border-amber-400/50 text-amber-100 hover:bg-amber-500/15 disabled:opacity-50"
              >
                {retryingRederive ? "Retrying…" : "Retry"}
              </button>
            )}
          </div>
        </div>
      )}
      <PendingRederiveLeadsSheet
        open={pendingLeadsSheetOpen}
        onOpenChange={setPendingLeadsSheetOpen}
        tenantId={tenantId}
        pageUrlPattern={pendingPagePath}
        formIdentifier={pendingFormIdentifier}
        excludeLeadId={event.createdLeadId ?? null}
      />
    </DetailSection>
  );
}

export function InlineFieldCorrection({ tenantId, event }: { tenantId: number; event: AttributionEvent }) {
  const notification = useOptionalLeadNotification();
  const onRuleRederiveComplete = notification?.onRuleRederiveComplete ?? null;
  const onRuleRederiveFailed = notification?.onRuleRederiveFailed ?? null;
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [selectedMapping, setSelectedMapping] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rederiveHint, setRederiveHint] = useState<string | null>(null);
  const [refreshingHistorical, setRefreshingHistorical] = useState(false);
  const [rederiveError, setRederiveError] = useState<{
    reason: string;
    pendingLeads?: number;
    hitLimit?: boolean;
    maxLeads?: number;
    lastAttemptedAt?: string;
  } | null>(null);
  const lastSavedRef = useRef<{ fieldName: string; mapsTo: string; pagePath: string; formIdentifier: string } | null>(null);
  const [retryingRederive, setRetryingRederive] = useState(false);
  // Tracks whether the "View pending leads" sheet (opened from the re-derive
  // failure hint) is currently visible — lets operators drill into the actual
  // historical leads still pending an update after the back-fill failed.
  const [pendingLeadsSheetOpen, setPendingLeadsSheetOpen] = useState(false);
  const FIELD_OPTIONS = ["firstName", "lastName", "fullName", "phone", "email", "address", "city", "state", "zip", "funnel", "appointmentDate", "appointmentTime"];

  const formFields = event.formFields as Record<string, unknown> | null;
  if (!formFields || typeof formFields !== "object") return null;

  const pageUrl = event.pageUrl || "";
  const formId = event.formId || "";
  const formName = event.formName || "";

  // Derived scope for the "View pending leads" sheet — matches the shape used
  // by `saveRule` / `retryRederive`, but computed straight from the event so
  // the sheet works even before any in-session save has happened.
  let pendingPagePath = "*";
  try { if (pageUrl) pendingPagePath = new URL(pageUrl).pathname || "*"; } catch {}
  const pendingFormIdentifier = formId || formName || "*";

  const subscribeForScope = (pagePath: string, formIdentifier: string) => {
    setRefreshingHistorical(true);
    return subscribeRederiveOnce(
      onRuleRederiveComplete,
      tenantId,
      pagePath,
      formIdentifier,
      (text) => {
        setRederiveHint(text);
        setRederiveError(null);
        sonnerToast.success(text);
        setTimeout(() => setRederiveHint(prev => (prev === text ? null : prev)), 6000);
      },
      () => setRefreshingHistorical(false),
      onRuleRederiveFailed,
      (data) => setRederiveError({
        reason: data.reason,
        pendingLeads: data.pendingLeads,
        hitLimit: data.hitLimit,
        maxLeads: data.maxLeads,
        lastAttemptedAt: data.lastAttemptedAt,
      }),
    );
  };

  const retryRederive = async () => {
    const last = lastSavedRef.current;
    if (!last) return;
    setRetryingRederive(true);
    setRederiveError(null);
    const unsubscribeRederive = subscribeForScope(last.pagePath, last.formIdentifier);
    try {
      const res = await fetch(`${API_BASE}/api/field-mapping-rules?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          pageUrlPattern: last.pagePath,
          formIdentifier: last.formIdentifier,
          fieldName: last.fieldName,
          mapsTo: last.mapsTo,
          attributionEventId: event.id,
        }),
      });
      if (!res.ok) {
        unsubscribeRederive();
        const d = await res.json().catch(() => ({}));
        setRederiveError({ reason: d.error || `Failed to retry (HTTP ${res.status})` });
      }
    } catch {
      unsubscribeRederive();
      setRederiveError({ reason: "Network error retrying re-derive." });
    } finally {
      setRetryingRederive(false);
    }
  };

  const saveRule = async (fieldName: string, mapsTo: string) => {
    setSaving(true);
    setError(null);
    setRederiveError(null);
    let pagePath = "*";
    try { pagePath = new URL(pageUrl).pathname; } catch {}
    const formIdentifier = formId || formName || "*";
    lastSavedRef.current = { fieldName, mapsTo, pagePath, formIdentifier };
    const unsubscribeRederive = subscribeForScope(pagePath, formIdentifier);
    try {
      const res = await fetch(`${API_BASE}/api/field-mapping-rules?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          pageUrlPattern: pagePath,
          formIdentifier,
          fieldName,
          mapsTo,
          attributionEventId: event.id,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to save rule");
        unsubscribeRederive();
        setSaving(false);
        return;
      }
      const d = await res.json().catch(() => ({}));
      setSaved(prev => [...prev, fieldName]);
      setCorrecting(null);
      // Signal Pulse to refresh the open lead so the helper text and funnel
      // dropdown reflect the new mapping immediately.
      try {
        if (d?.leadFunnelChanged) {
          if (typeof BroadcastChannel !== "undefined") {
            const ch = new BroadcastChannel("pulse");
            ch.postMessage({ type: "leads-refresh", reason: "field-mapping-updated" });
            ch.close();
          }
          window.dispatchEvent(new CustomEvent("pulse:leads-refresh", { detail: { reason: "field-mapping-updated" } }));
        }
      } catch {}
    } catch {
      setError("Network error");
      unsubscribeRederive();
    }
    setSaving(false);
  };

  const entries = Object.entries(formFields).filter(([k]) => !k.startsWith("_"));
  if (entries.length === 0) return null;

  return (
    <DetailSection
      title="Inline Field Correction"
      subtitle={`${entries.length} ${entries.length === 1 ? 'field' : 'fields'} captured`}
      icon={<Settings className="w-4 h-4" />}
    >
      <p className="text-xs text-muted-foreground mb-3">Click a field to create a mapping rule for this page + form scope.</p>
      {refreshingHistorical && !rederiveHint && (
        <p
          className="text-[10px] text-sky-300/85 italic mb-2 flex items-center gap-1.5"
          aria-live="polite"
          role="status"
          data-testid="refreshing-historical-hint"
        >
          <Loader2 className="w-3 h-3 animate-spin" />
          Refreshing historical leads…
        </p>
      )}
      {rederiveHint && (
        <p className="text-[10px] text-emerald-400/90 mb-2" aria-live="polite">
          {rederiveHint}
        </p>
      )}
      {rederiveError && (
        <div
          className="mb-2 flex items-center justify-between gap-2 bg-amber-500/[0.06] border border-amber-500/30 rounded-md px-2.5 py-1.5"
          role="status"
          aria-live="polite"
          data-testid="rederive-error-hint"
        >
          <span className="text-[11px] text-amber-200/90" title={rederiveError.reason}>
            Couldn't re-derive historical leads. Mapping is saved; only the back-fill failed.
            {typeof rederiveError.pendingLeads === "number" && (
              <>
                {" "}
                <span data-testid="rederive-pending-count">
                  {rederiveError.pendingLeads === 0
                    ? "No historical leads still need updating."
                    : `~${rederiveError.pendingLeads}${rederiveError.hitLimit ? "+" : ""} historical lead${rederiveError.pendingLeads === 1 ? "" : "s"} still need updating.`}
                </span>
              </>
            )}
            {rederiveError.lastAttemptedAt && (
              <>
                {" "}
                <span className="text-amber-200/60" data-testid="rederive-last-attempted">
                  Last tried {formatLastAttempted(rederiveError.lastAttemptedAt)}.
                </span>
              </>
            )}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {(rederiveError.pendingLeads ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => setPendingLeadsSheetOpen(true)}
                data-testid="rederive-view-pending-button"
                className="text-[11px] px-2 py-0.5 rounded border border-amber-400/50 text-amber-100 hover:bg-amber-500/15"
              >
                View pending leads
              </button>
            )}
            {lastSavedRef.current && (
              <button
                type="button"
                onClick={retryRederive}
                disabled={retryingRederive}
                data-testid="rederive-retry-button"
                className="text-[11px] px-2 py-0.5 rounded border border-amber-400/50 text-amber-100 hover:bg-amber-500/15 disabled:opacity-50"
              >
                {retryingRederive ? "Retrying…" : "Retry"}
              </button>
            )}
          </div>
        </div>
      )}
      <PendingRederiveLeadsSheet
        open={pendingLeadsSheetOpen}
        onOpenChange={setPendingLeadsSheetOpen}
        tenantId={tenantId}
        pageUrlPattern={pendingPagePath}
        formIdentifier={pendingFormIdentifier}
        excludeLeadId={event.createdLeadId ?? null}
      />
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}
      <div className="space-y-1.5">
        {entries.map(([fieldName, value]) => (
          <div key={fieldName} className="bg-white/[0.02] border border-white/5 rounded-lg p-2.5">
            {correcting === fieldName ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-muted-foreground min-w-[100px]">{fieldName}</span>
                <select
                  value={selectedMapping}
                  onChange={e => setSelectedMapping(e.target.value)}
                  className="flex-1 bg-black/40 border border-white/10 rounded text-xs text-white px-2 py-1"
                >
                  <option value="">Select mapping...</option>
                  {FIELD_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
                <Button size="sm" variant="ghost" disabled={!selectedMapping || saving} onClick={() => saveRule(fieldName, selectedMapping)} className="text-xs h-7 px-2">
                  {saving ? "..." : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCorrecting(null)} className="text-xs h-7 px-2 text-muted-foreground">
                  Cancel
                </Button>
              </div>
            ) : (
              <button
                onClick={() => { setCorrecting(fieldName); setSelectedMapping(""); }}
                disabled={saved.includes(fieldName)}
                className="w-full flex items-center justify-between gap-2 text-left hover:bg-white/[0.03] rounded transition-colors"
              >
                <span className="text-xs font-mono text-muted-foreground">{fieldName}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white/60 truncate max-w-[150px]" title={formatFieldValue(value)}>{formatFieldValue(value)}</span>
                  {saved.includes(fieldName) ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Edit3 className="w-3 h-3 text-white/30" />
                  )}
                </div>
              </button>
            )}
          </div>
        ))}
      </div>
    </DetailSection>
  );
}

function IngestionModePanel({ tenantId }: { tenantId: number }) {
  const [mode, setMode] = useState<IngestionMode>("sheets");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [snippetError, setSnippetError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<{
    trackerHealthy: boolean;
    lastHeartbeat: string | null;
    heartbeatDomain: string | null;
    recentEventCount: number;
    activeSheetCount: number;
    domains?: Array<{
      domain: string;
      status: "green" | "amber" | "red";
      reason: string;
      lastHeartbeat: string | null;
      firstPageUrl: string | null;
      lastEventAt: string | null;
      eventCount24h: number;
      eventCount7d: number;
    }>;
  } | null>(null);

  useEffect(() => {
    setLoading(true);
    setSnippet(null);
    setSnippetError(null);
    Promise.all([
      fetch(`${API_BASE}/api/ingestion-mode?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json()),
      fetch(`${API_BASE}/api/ingestion-mode/status?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json()),
      fetch(`${API_BASE}/api/ingestion-mode/gtm-snippet?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json().then(d => ({ ok: r.ok, data: d }))),
    ]).then(([modeData, statusData, snippetResult]) => {
      setMode(modeData.mode || "sheets");
      setStatus(statusData);
      if (snippetResult.ok) {
        setSnippet(snippetResult.data.snippet || null);
      } else {
        setSnippetError(snippetResult.data.error || "Failed to load snippet");
      }
    }).catch(() => {
      setSnippetError("Failed to load snippet");
    }).finally(() => setLoading(false));
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
    { key: "both" as const, label: "Dual Mode", desc: "Both sheet sync and tracker create leads. Phone + email dedup prevents doubles.", icon: <ShieldCheck className="w-5 h-5" /> },
    { key: "tracker" as const, label: "Tracker Only", desc: "Sheet sync is disabled. All leads come from the JavaScript tracker.", icon: <Zap className="w-5 h-5" /> },
  ];

  const canAdvanceToBoth = status && status.trackerHealthy && status.recentEventCount > 0;
  const canAdvanceToTracker = status && status.trackerHealthy && status.recentEventCount >= 10;

  return (
    <div className="space-y-6">
      {status && (
        <PremiumCard className="p-6">
          <h3 className="text-lg font-medium text-white mb-4">System Health</h3>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-2 h-2 rounded-full ${status.trackerHealthy ? "bg-emerald-400" : "bg-red-400"}`} />
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Tracker Heartbeat</span>
              </div>
              <p className="text-sm text-white font-medium">{status.trackerHealthy ? "Healthy" : "Not detected"}</p>
              {status.lastHeartbeat && (
                <p className="text-xs text-muted-foreground mt-1">Last seen: {new Date(status.lastHeartbeat).toLocaleString()}</p>
              )}
              {status.heartbeatDomain && (
                <p className="text-xs text-muted-foreground">Domain: {status.heartbeatDomain}</p>
              )}
            </div>
            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <Activity className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Tracker Events (7d)</span>
              </div>
              <p className="text-2xl text-white font-semibold">{status.recentEventCount}</p>
            </div>
            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Active Sheet Configs</span>
              </div>
              <p className="text-2xl text-white font-semibold">{status.activeSheetCount}</p>
            </div>
          </div>

          {status.domains && status.domains.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-medium text-white/80">Per-domain status</h4>
                <a
                  href={`${API_BASE}/verify-tracker`}
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  Verify a specific URL <ArrowRight className="w-3 h-3" />
                </a>
              </div>
              <div className="space-y-2">
                {status.domains.map((d) => {
                  const dot = d.status === "green" ? "bg-emerald-400" : d.status === "amber" ? "bg-amber-400" : "bg-red-400";
                  const ring = d.status === "green" ? "border-emerald-500/20" : d.status === "amber" ? "border-amber-500/30 bg-amber-500/[0.03]" : "border-red-500/30 bg-red-500/[0.03]";
                  return (
                    <div key={d.domain} className={`border ${ring} rounded-lg p-3 bg-white/[0.02]`}>
                      <div className="flex items-start gap-3">
                        <div className={`w-2 h-2 rounded-full mt-1.5 ${dot}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-medium text-white truncate">{d.domain}</p>
                            <div className="text-xs text-muted-foreground whitespace-nowrap">
                              {d.eventCount24h} ev / 24h · {d.eventCount7d} / 7d
                            </div>
                          </div>
                          <p className={`text-xs mt-1 ${d.status === "amber" ? "text-amber-300/80" : d.status === "red" ? "text-red-300/80" : "text-muted-foreground"}`}>
                            {d.reason}
                          </p>
                          <div className="text-[11px] text-muted-foreground mt-1 space-x-3">
                            {d.lastHeartbeat && <span>Heartbeat: {new Date(d.lastHeartbeat).toLocaleString()}</span>}
                            {d.lastEventAt && <span>Last event: {new Date(d.lastEventAt).toLocaleString()}</span>}
                          </div>
                          {d.firstPageUrl && (
                            <p className="text-[11px] text-muted-foreground mt-1 truncate">
                              First seen on: <span className="text-white/60">{d.firstPageUrl}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </PremiumCard>
      )}

      <PremiumCard className="p-6">
        <h3 className="text-lg font-medium text-white mb-1">Lead Ingestion Mode</h3>
        <p className="text-sm text-muted-foreground mb-6">Control how leads flow into the system. Progress through these stages as you verify tracker accuracy.</p>

        <div className="grid gap-4 md:grid-cols-3">
          {steps.map((step, i) => {
            const disabled = saving
              || (step.key === "both" && mode === "sheets" && !canAdvanceToBoth)
              || (step.key === "tracker" && mode !== "tracker" && !canAdvanceToTracker);
            return (
              <button
                key={step.key}
                disabled={disabled}
                onClick={() => updateMode(step.key)}
                className={`relative p-5 rounded-xl border text-left transition-all ${
                  mode === step.key
                    ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                    : disabled
                      ? "border-white/5 bg-white/[0.01] opacity-50 cursor-not-allowed"
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
                {disabled && step.key !== mode && (
                  <p className="text-[10px] text-amber-400/70 mt-2">
                    {step.key === "both" ? "Requires active tracker heartbeat + at least 1 event" : "Requires active tracker + at least 10 events"}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </PremiumCard>

      <PremiumCard className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-medium text-white mb-1">GTM Snippet</h3>
            <p className="text-sm text-muted-foreground">Copy this into your Google Tag Manager custom HTML tag.</p>
            <p className="text-xs text-amber-300/80 mt-2">
              Heads up: if the page also has a hardcoded <code className="text-white/80">&lt;script src="…/tracker.js"&gt;</code> tag,
              remove it — the legacy URL no longer serves JavaScript and will mask diagnostics. Use{" "}
              <a href={`${API_BASE}/verify-tracker`} className="text-primary hover:underline">Verify Tracker</a> to confirm a specific URL is healthy.
            </p>
          </div>
        </div>

        {snippetError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">
            <p className="text-xs text-red-400">{snippetError}</p>
          </div>
        )}
        {snippet ? (
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
        ) : !snippetError && (
          <p className="text-sm text-muted-foreground">Loading snippet...</p>
        )}
      </PremiumCard>
    </div>
  );
}

type AliasSuggestion = {
  subdomain: string;
  suggestedFunnelTypeId: number;
  suggestedFunnelName: string;
  eventCount: number;
  fellThroughCount: number;
  reason?: "observed" | "label-match";
  matchedAlias?: string;
};

function FunnelAliasesPanel({
  tenantId,
  suggestions,
  refetchSuggestions,
}: {
  tenantId: number;
  suggestions: AliasSuggestion[];
  refetchSuggestions: () => void;
}) {
  const [groups, setGroups] = useState<FunnelAliasGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [newAlias, setNewAlias] = useState("");
  const [selectedFunnelId, setSelectedFunnelId] = useState<string>("");
  const [funnelTypes, setFunnelTypes] = useState<{ id: number; name: string }[]>([]);
  const [hasSheetConfigs, setHasSheetConfigs] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  const suggestionsByAlias = new Map<string, AliasSuggestion[]>();
  for (const s of suggestions) {
    if (!s.matchedAlias) continue;
    const key = s.matchedAlias.toLowerCase();
    const arr = suggestionsByAlias.get(key) ?? [];
    arr.push(s);
    suggestionsByAlias.set(key, arr);
  }

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

  const checkSheetConfigs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/tenants/${tenantId}/sheet-configs`, { credentials: "include" });
      if (res.ok) {
        const configs = await res.json();
        const hasUsableConfigs = Array.isArray(configs) && configs.some((c: { columnMapping?: Record<string, string> | null; defaultFunnelTypeId?: number | null }) => {
          if (!c.columnMapping || !c.defaultFunnelTypeId) return false;
          return Object.values(c.columnMapping).some(field => field === "__funnel__" || field === "serviceType");
        });
        setHasSheetConfigs(hasUsableConfigs);
      } else {
        setHasSheetConfigs(false);
      }
    } catch {
      setHasSheetConfigs(false);
    }
  }, [tenantId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadAliases(), loadFunnelTypes(), checkSheetConfigs()]).finally(() => setLoading(false));
  }, [loadAliases, loadFunnelTypes, checkSheetConfigs]);

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
    refetchSuggestions();
  };

  const deleteAlias = async (id: number) => {
    await fetch(`${API_BASE}/api/funnel-aliases/${id}?tenantId=${tenantId}`, {
      method: "DELETE",
      credentials: "include",
    });
    setPendingDeleteId(null);
    await loadAliases();
    refetchSuggestions();
  };

  const loadDefaults = async () => {
    await fetch(`${API_BASE}/api/funnel-aliases/load-defaults?tenantId=${tenantId}`, {
      method: "POST",
      credentials: "include",
    });
    await loadAliases();
    refetchSuggestions();
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
          {hasSheetConfigs && (
            <Button variant="outline" size="sm" onClick={loadDefaults} className="gap-2">
              <Zap className="w-4 h-4" />
              Load from Spreadsheets
            </Button>
          )}
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
          <p className="text-sm text-muted-foreground">No funnel aliases configured yet.{hasSheetConfigs ? " Use 'Load from Spreadsheets' to import aliases from your connected sheets." : " Add aliases manually above."}</p>
        ) : (
          <div className="space-y-4">
            {groups.map(g => (
              <div key={g.funnelTypeId} className="bg-white/[0.02] border border-white/5 rounded-lg p-4">
                <h4 className="text-sm font-medium text-white mb-2">{g.funnelName}</h4>
                <div className="flex flex-col gap-2">
                  {g.aliases.map(a => {
                    const aliasSuggestions = suggestionsByAlias.get(a.alias.toLowerCase()) ?? [];
                    const isPending = pendingDeleteId === a.id;
                    return (
                      <div key={a.id} className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-white/70">
                            {a.alias}
                            <button
                              onClick={() => {
                                if (aliasSuggestions.length > 0 && !isPending) {
                                  setPendingDeleteId(a.id);
                                } else {
                                  deleteAlias(a.id);
                                }
                              }}
                              className="text-white/30 hover:text-red-400 transition-colors"
                              aria-label={`Remove alias ${a.alias}`}
                            >
                              ×
                            </button>
                          </span>
                          {aliasSuggestions.length > 0 && !isPending && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-amber-300/80">
                              <Lightbulb className="w-3 h-3" />
                              Unlocks {aliasSuggestions.length} pending subdomain suggestion{aliasSuggestions.length === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>
                        {aliasSuggestions.length > 0 && (
                          <ul className="ml-1 space-y-1">
                            {aliasSuggestions.map(s => (
                              <li
                                key={s.subdomain}
                                className={`flex items-center gap-2 text-[11px] px-2 py-1 rounded border ${
                                  isPending
                                    ? "border-red-400/30 bg-red-400/[0.04] text-red-200/80 line-through"
                                    : "border-white/5 bg-white/[0.02] text-muted-foreground"
                                }`}
                              >
                                <span className="font-mono text-white/70">{s.subdomain}</span>
                                <ArrowRight className="w-3 h-3 text-white/30" />
                                <span className="text-emerald-400/90">{s.suggestedFunnelName}</span>
                                <span>· {s.eventCount} event{s.eventCount === 1 ? "" : "s"}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {isPending && (
                          <div className="ml-1 flex items-center gap-2 text-[11px]">
                            <span className="text-amber-300/90">
                              Removing this alias will hide {aliasSuggestions.length} subdomain suggestion{aliasSuggestions.length === 1 ? "" : "s"}.
                            </span>
                            <button
                              type="button"
                              onClick={() => deleteAlias(a.id)}
                              className="px-2 py-0.5 rounded border border-red-400/30 text-red-300 hover:bg-red-400/10 transition-colors"
                            >
                              Remove anyway
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingDeleteId(null)}
                              className="px-2 py-0.5 rounded border border-white/10 text-white/60 hover:bg-white/5 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

interface SubdomainRule {
  id: number;
  subdomain: string;
  funnelTypeId: number;
  funnelName: string;
  createdAt?: string;
}

interface PreviewSampleEvent {
  id: number;
  pageUrl: string | null;
  resolvedFunnel: string | null;
  createdLeadId: number | null;
  createdAt: string | null;
}

interface PreviewCounts {
  updatedEventCount: number;
  updatedLeadCount: number;
  conflictingEventCount: number;
  matchedEventCount: number;
  eligibleSample: PreviewSampleEvent[];
  conflictingSample: PreviewSampleEvent[];
}

function PreviewSampleList({
  title,
  tone,
  events,
  totalCount,
  onOpenEvent,
}: {
  title: string;
  tone: "eligible" | "conflict";
  events: PreviewSampleEvent[];
  totalCount: number;
  onOpenEvent?: (eventId: number) => void;
}) {
  if (events.length === 0) return null;
  const headerColor = tone === "eligible" ? "text-emerald-300/90" : "text-amber-300/90";
  const more = Math.max(0, totalCount - events.length);
  return (
    <div className="mt-2 border-t border-white/5 pt-2 space-y-1">
      <div className={`text-[10px] uppercase tracking-wider ${headerColor}`}>
        {title} ({Math.min(events.length, totalCount).toLocaleString()}
        {more > 0 ? ` of ${totalCount.toLocaleString()}` : ""})
      </div>
      <ul className="space-y-0.5">
        {events.map(ev => {
          let path = ev.pageUrl || "—";
          try { if (ev.pageUrl) path = new URL(ev.pageUrl).pathname || "/"; } catch {}
          const clickable = !!onOpenEvent;
          return (
            <li key={ev.id}>
              <button
                type="button"
                onClick={clickable ? () => onOpenEvent!(ev.id) : undefined}
                disabled={!clickable}
                className={`w-full text-left flex items-center gap-2 font-mono text-[11px] py-0.5 px-1 rounded ${clickable ? "hover:bg-white/[0.04] cursor-pointer" : "cursor-default"}`}
                title={ev.pageUrl || ""}
              >
                <span className="text-white/70 truncate max-w-[260px]">{path}</span>
                <span className="text-white/30">·</span>
                <span className="text-white/50 truncate max-w-[140px]">
                  {ev.resolvedFunnel || <span className="text-white/30">unresolved</span>}
                </span>
                {ev.createdLeadId != null && (
                  <span className="ml-auto text-cyan-400/80 text-[10px]">lead #{ev.createdLeadId}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <div className="text-[10px] text-white/40">+ {more.toLocaleString()} more not shown</div>
      )}
    </div>
  );
}

function SubdomainRulesPanel({
  tenantId,
  onOpenEvent,
  highlightRule,
}: {
  tenantId: number;
  onOpenEvent?: (eventId: number) => void;
  highlightRule?: { subdomain: string; nonce: number } | null;
}) {
  const [rules, setRules] = useState<SubdomainRule[]>([]);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const [highlightedRuleId, setHighlightedRuleId] = useState<number | null>(null);

  useEffect(() => {
    if (!highlightRule) return;
    const match = rules.find(r => r.subdomain.toLowerCase() === highlightRule.subdomain.toLowerCase());
    if (!match) return;
    setHighlightedRuleId(match.id);
    const el = rowRefs.current.get(match.id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setHighlightedRuleId(null), 2500);
    return () => clearTimeout(t);
  }, [highlightRule, rules]);
  const [funnelTypes, setFunnelTypes] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newSubdomain, setNewSubdomain] = useState("");
  const [newFunnelId, setNewFunnelId] = useState("");
  const [adding, setAdding] = useState(false);
  const [addPreview, setAddPreview] = useState<PreviewCounts | null>(null);
  const [previewingAdd, setPreviewingAdd] = useState(false);
  const [addForceOverride, setAddForceOverride] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFunnelId, setEditFunnelId] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editPreview, setEditPreview] = useState<PreviewCounts | null>(null);
  const [previewingEdit, setPreviewingEdit] = useState(false);
  const [editForceOverride, setEditForceOverride] = useState(false);

  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [pendingDeleteRevert, setPendingDeleteRevert] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Two banner shapes share this slot: a "saved" message (subdomain rule
  // create/update, optionally with an undo affordance for force-override
  // saves) and a "reverted" message (rule delete with revert-past-events).
  // Discriminated by `kind` so the renderer can pick the right copy.
  const [savedMessage, setSavedMessage] = useState<
    | {
        kind?: "saved";
        subdomain: string;
        funnelName: string;
        events: number;
        leads: number;
        undo?: { batchId: string; expiresAt: number };
        reverted?: { events: number; leads: number };
      }
    | {
        kind: "reverted";
        subdomain: string;
        events: number;
        leads: number;
      }
    | null
  >(null);
  const [undoing, setUndoing] = useState(false);
  const [, setNowTick] = useState(0);

  useEffect(() => {
    if (savedMessage === null) return;
    // If we're offering an undo, keep the banner up until the window expires
    // (plus a brief grace period). If we've already reverted, fade after 4s.
    // Otherwise (incl. delete-revert banner) fall back to the 6s auto-hide.
    let timeout: number;
    if (savedMessage.kind === "reverted") {
      timeout = 6000;
    } else if (savedMessage.reverted) {
      timeout = 4000;
    } else if (savedMessage.undo) {
      timeout = Math.max(0, savedMessage.undo.expiresAt - Date.now()) + 500;
    } else {
      timeout = 6000;
    }
    const t = setTimeout(() => setSavedMessage(null), timeout);
    return () => clearTimeout(t);
  }, [savedMessage]);

  // Drive a 1s tick while an undo window is open so the countdown stays fresh.
  const activeUndo = savedMessage && savedMessage.kind !== "reverted" ? savedMessage.undo : undefined;
  useEffect(() => {
    if (!activeUndo) return;
    const i = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [activeUndo]);

  const loadAll = useCallback(async () => {
    try {
      const [rRes, fRes] = await Promise.all([
        fetch(`${API_BASE}/api/subdomain-funnel-rules?tenantId=${tenantId}`, { credentials: "include" }),
        fetch(`${API_BASE}/api/funnel-types?tenantId=${tenantId}`, { credentials: "include" }),
      ]);
      const rData = await rRes.json();
      const fData = await fRes.json();
      setRules(rData.rules || []);
      setFunnelTypes(fData.funnelTypes || fData || []);
    } catch {
      setError("Failed to load subdomain rules");
    }
  }, [tenantId]);

  useEffect(() => {
    setLoading(true);
    loadAll().finally(() => setLoading(false));
  }, [loadAll]);

  const previewAdd = async (force = false) => {
    const sub = newSubdomain.trim().toLowerCase().replace(/^www\./, "");
    if (!sub || !newFunnelId) return;
    setPreviewingAdd(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/subdomain-funnel-rules/preview?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ subdomain: sub, funnelTypeId: Number(newFunnelId), forceOverride: force }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.error || "Failed to preview rule");
      } else {
        setAddPreview({
          updatedEventCount: d.updatedEventCount ?? 0,
          updatedLeadCount: d.updatedLeadCount ?? 0,
          conflictingEventCount: d.conflictingEventCount ?? 0,
          matchedEventCount: d.matchedEventCount ?? 0,
          eligibleSample: d.eligibleSample ?? [],
          conflictingSample: d.conflictingSample ?? [],
        });
      }
    } catch {
      setError("Network error");
    }
    setPreviewingAdd(false);
  };

  const toggleAddForceOverride = async (checked: boolean) => {
    setAddForceOverride(checked);
    if (addPreview) {
      await previewAdd(checked);
    }
  };

  const cancelAddPreview = () => {
    setAddPreview(null);
    setAddForceOverride(false);
  };

  const addRule = async () => {
    const sub = newSubdomain.trim().toLowerCase().replace(/^www\./, "");
    if (!sub || !newFunnelId) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/subdomain-funnel-rules?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ subdomain: sub, funnelTypeId: Number(newFunnelId), forceOverride: addForceOverride }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to add rule");
      } else {
        const d = await res.json().catch(() => ({}));
        const funnelName = d.rule?.funnelName
          || funnelTypes.find(f => f.id === Number(newFunnelId))?.name
          || "";
        setSavedMessage({
          subdomain: sub,
          funnelName,
          events: d.updatedEventCount ?? 0,
          leads: d.updatedLeadCount ?? 0,
          undo: d.undoBatchId
            ? {
                batchId: d.undoBatchId,
                // Prefer the server-authoritative expiry; fall back to a 30s
                // local window only if the server didn't send one.
                expiresAt: typeof d.undoExpiresAt === "number" ? d.undoExpiresAt : Date.now() + 30_000,
              }
            : undefined,
        });
        setNewSubdomain("");
        setNewFunnelId("");
        setAddPreview(null);
        setAddForceOverride(false);
        await loadAll();
      }
    } catch {
      setError("Network error");
    }
    setAdding(false);
  };

  const startEdit = (rule: SubdomainRule) => {
    setEditingId(rule.id);
    setEditFunnelId(String(rule.funnelTypeId));
    setEditPreview(null);
    setEditForceOverride(false);
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditFunnelId("");
    setEditPreview(null);
    setEditForceOverride(false);
  };

  const previewEdit = async (rule: SubdomainRule, force = false) => {
    if (!editFunnelId || Number(editFunnelId) === rule.funnelTypeId) {
      cancelEdit();
      return;
    }
    setPreviewingEdit(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/subdomain-funnel-rules/preview?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ subdomain: rule.subdomain, funnelTypeId: Number(editFunnelId), forceOverride: force }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.error || "Failed to preview rule");
      } else {
        setEditPreview({
          updatedEventCount: d.updatedEventCount ?? 0,
          updatedLeadCount: d.updatedLeadCount ?? 0,
          conflictingEventCount: d.conflictingEventCount ?? 0,
          matchedEventCount: d.matchedEventCount ?? 0,
          eligibleSample: d.eligibleSample ?? [],
          conflictingSample: d.conflictingSample ?? [],
        });
      }
    } catch {
      setError("Network error");
    }
    setPreviewingEdit(false);
  };

  const toggleEditForceOverride = async (rule: SubdomainRule, checked: boolean) => {
    setEditForceOverride(checked);
    if (editPreview) {
      await previewEdit(rule, checked);
    }
  };

  const saveEdit = async (rule: SubdomainRule) => {
    if (!editFunnelId || Number(editFunnelId) === rule.funnelTypeId) {
      cancelEdit();
      return;
    }
    setSavingEdit(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/subdomain-funnel-rules?tenantId=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ subdomain: rule.subdomain, funnelTypeId: Number(editFunnelId), forceOverride: editForceOverride }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to update rule");
      } else {
        const d = await res.json().catch(() => ({}));
        const funnelName = d.rule?.funnelName
          || funnelTypes.find(f => f.id === Number(editFunnelId))?.name
          || "";
        setSavedMessage({
          subdomain: rule.subdomain,
          funnelName,
          events: d.updatedEventCount ?? 0,
          leads: d.updatedLeadCount ?? 0,
          undo: d.undoBatchId
            ? {
                batchId: d.undoBatchId,
                expiresAt: typeof d.undoExpiresAt === "number" ? d.undoExpiresAt : Date.now() + 30_000,
              }
            : undefined,
        });
        cancelEdit();
        await loadAll();
      }
    } catch {
      setError("Network error");
    }
    setSavingEdit(false);
  };

  const doUndo = async () => {
    if (!savedMessage || savedMessage.kind === "reverted" || !savedMessage.undo) return;
    const current = savedMessage;
    const undo = current.undo!;
    if (Date.now() > undo.expiresAt) {
      setSavedMessage(null);
      return;
    }
    setUndoing(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/subdomain-funnel-rules/undo/${encodeURIComponent(undo.batchId)}?tenantId=${tenantId}`,
        { method: "POST", credentials: "include" },
      );
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.error || "Failed to undo");
      } else {
        setSavedMessage({
          kind: "saved",
          subdomain: current.subdomain,
          funnelName: current.funnelName,
          events: current.events,
          leads: current.leads,
          reverted: {
            events: d.revertedEventCount ?? 0,
            leads: d.revertedLeadCount ?? 0,
          },
        });
        await loadAll();
      }
    } catch {
      setError("Network error");
    }
    setUndoing(false);
  };

  const confirmDelete = async (id: number) => {
    setDeleting(true);
    setError(null);
    try {
      const rule = rules.find(r => r.id === id);
      const wantsRevert = pendingDeleteRevert;
      const qs = new URLSearchParams();
      if (wantsRevert) qs.set("revertEvents", "true");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await fetch(`${API_BASE}/api/subdomain-funnel-rules/${id}${suffix}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "Failed to delete rule");
      } else {
        if (wantsRevert && rule) {
          const d = await res.json().catch(() => ({}));
          const events = typeof d.updatedEventCount === "number" ? d.updatedEventCount : 0;
          const leads = typeof d.updatedLeadCount === "number" ? d.updatedLeadCount : 0;
          setSavedMessage({
            kind: "reverted",
            subdomain: rule.subdomain,
            events,
            leads,
          });
        }
        setPendingDeleteId(null);
        setPendingDeleteRevert(false);
        await loadAll();
      }
    } catch {
      setError("Network error");
    }
    setDeleting(false);
  };

  if (loading) {
    return <PremiumCard className="p-8"><p className="text-muted-foreground text-sm">Loading...</p></PremiumCard>;
  }

  return (
    <div className="space-y-6">
      <PremiumCard className="p-6">
        <div className="mb-4">
          <h3 className="text-lg font-medium text-white mb-1">Subdomain → Funnel Rules</h3>
          <p className="text-sm text-muted-foreground">
            When form field and alias matching can't resolve a funnel, fall back to the page's subdomain.
            For example, <span className="font-mono text-white/70">repair</span> on{" "}
            <span className="font-mono text-white/70">repair.acme.com</span> routes to your Repair funnel.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-6">
          <Input
            placeholder="subdomain (e.g. repair)"
            value={newSubdomain}
            onChange={e => { setNewSubdomain(e.target.value); setAddPreview(null); setAddForceOverride(false); }}
            disabled={!!addPreview}
            className="max-w-[220px] bg-white/5 border-white/10 text-sm font-mono"
          />
          <ArrowRight className="w-4 h-4 text-white/30" />
          <Select
            value={newFunnelId}
            onValueChange={(v) => { setNewFunnelId(v); setAddPreview(null); setAddForceOverride(false); }}
            disabled={!!addPreview}
          >
            <SelectTrigger className="w-[200px] bg-white/5 border-white/10 text-sm">
              <SelectValue placeholder="Select funnel type" />
            </SelectTrigger>
            <SelectContent>
              {funnelTypes.map(ft => (
                <SelectItem key={ft.id} value={String(ft.id)}>{ft.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {addPreview ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={addRule}
                disabled={adding}
                className="border-emerald-500/30 text-emerald-300 hover:text-emerald-200 hover:bg-emerald-500/10"
              >
                {adding ? "Saving..." : "Confirm & Save"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelAddPreview}
                disabled={adding}
                className="text-white/50"
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => previewAdd(false)}
              disabled={previewingAdd || !newSubdomain.trim() || !newFunnelId}
            >
              {previewingAdd ? "Previewing..." : "Preview"}
            </Button>
          )}
        </div>

        {addPreview && (
          <div className="mb-4 text-xs bg-white/[0.03] border border-white/10 rounded-md px-3 py-2 space-y-1">
            <div className="text-white/80">
              This will re-tag{" "}
              <span className="text-emerald-300 font-medium">{addPreview.updatedEventCount.toLocaleString()}</span>{" "}
              past {addPreview.updatedEventCount === 1 ? "event" : "events"}
              {addPreview.updatedLeadCount > 0 && (
                <>
                  {" "}and{" "}
                  <span className="text-emerald-300 font-medium">{addPreview.updatedLeadCount.toLocaleString()}</span>{" "}
                  {addPreview.updatedLeadCount === 1 ? "lead" : "leads"}
                </>
              )}
              .
            </div>
            {addPreview.conflictingEventCount > 0 && !addForceOverride && (
              <div className="text-amber-300/90">
                ⚠ {addPreview.conflictingEventCount.toLocaleString()} matching{" "}
                {addPreview.conflictingEventCount === 1 ? "event is" : "events are"} already attributed to a different funnel and will be left alone.
              </div>
            )}
            {addPreview.conflictingEventCount > 0 && addForceOverride && (
              <div className="text-amber-300/90">
                Force-override on: those {addPreview.conflictingEventCount.toLocaleString()}{" "}
                {addPreview.conflictingEventCount === 1 ? "event" : "events"} will be re-tagged too.
              </div>
            )}
            {(addPreview.conflictingEventCount > 0 || addForceOverride) && (
              <label className="flex items-start gap-2 pt-1 cursor-pointer select-none">
                <Checkbox
                  checked={addForceOverride}
                  onCheckedChange={(c) => toggleAddForceOverride(c === true)}
                  disabled={previewingAdd}
                  className="mt-0.5 border-white/30 data-[state=checked]:bg-amber-500 data-[state=checked]:border-amber-500"
                />
                <span className="text-white/70">
                  Also re-tag the {addPreview.conflictingEventCount.toLocaleString()}{" "}
                  {addPreview.conflictingEventCount === 1 ? "event" : "events"} currently on a different funnel
                </span>
              </label>
            )}
            {addPreview.matchedEventCount === 0 && (
              <div className="text-white/40">
                No historical events match this subdomain yet — the rule will apply to new traffic only.
              </div>
            )}
            <PreviewSampleList
              title="Sample events that would be re-tagged"
              tone="eligible"
              events={addPreview.eligibleSample}
              totalCount={addPreview.updatedEventCount}
              onOpenEvent={onOpenEvent}
            />
            <PreviewSampleList
              title="Sample events left alone (conflicting funnel)"
              tone="conflict"
              events={addPreview.conflictingSample}
              totalCount={addPreview.conflictingEventCount}
              onOpenEvent={onOpenEvent}
            />
          </div>
        )}

        {savedMessage && savedMessage.kind === "reverted" && (
          <div className="mb-4 text-xs text-emerald-300 bg-emerald-500/[0.06] border border-emerald-500/20 rounded-md px-3 py-2">
            Removed rule <span className="font-mono">{savedMessage.subdomain}</span> and reverted{" "}
            {savedMessage.events.toLocaleString()} past {savedMessage.events === 1 ? "event" : "events"}
            {savedMessage.leads > 0 && <> ({savedMessage.leads.toLocaleString()} {savedMessage.leads === 1 ? "lead" : "leads"})</>}
            {" "}to the tenant default.
          </div>
        )}
        {savedMessage && savedMessage.kind !== "reverted" && (
          <div className="mb-4 text-xs text-emerald-300 bg-emerald-500/[0.06] border border-emerald-500/20 rounded-md px-3 py-2 flex items-center justify-between gap-3">
            {savedMessage.reverted ? (
              <span>
                Reverted <span className="font-mono">{savedMessage.subdomain}</span> →{" "}
                restored {savedMessage.reverted.events.toLocaleString()}{" "}
                {savedMessage.reverted.events === 1 ? "event" : "events"}
                {savedMessage.reverted.leads > 0 && (
                  <> and {savedMessage.reverted.leads.toLocaleString()} {savedMessage.reverted.leads === 1 ? "lead" : "leads"}</>
                )}{" "}to their previous funnel.
              </span>
            ) : (
              <span>
                Saved <span className="font-mono">{savedMessage.subdomain}</span> → {savedMessage.funnelName}.
                Updated {savedMessage.events.toLocaleString()} {savedMessage.events === 1 ? "event" : "events"}
                {savedMessage.leads > 0 && <> and {savedMessage.leads.toLocaleString()} {savedMessage.leads === 1 ? "lead" : "leads"}</>}.
              </span>
            )}
            {savedMessage.undo && !savedMessage.reverted && (() => {
              const secondsLeft = Math.max(0, Math.ceil((savedMessage.undo.expiresAt - Date.now()) / 1000));
              if (secondsLeft <= 0) return null;
              return (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={doUndo}
                  disabled={undoing}
                  className="h-7 px-2 text-xs text-emerald-200 hover:text-white hover:bg-emerald-500/20 shrink-0"
                >
                  {undoing ? "Undoing..." : `Undo (${secondsLeft}s)`}
                </Button>
              );
            })()}
          </div>
        )}

        {error && (
          <div className="mb-4 text-xs text-red-400 bg-red-400/5 border border-red-400/20 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subdomain rules configured yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="py-2 pr-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Subdomain</th>
                  <th className="py-2 pr-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Funnel</th>
                  <th className="py-2 pr-4 text-xs font-medium text-muted-foreground uppercase tracking-wider w-[1%]"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {rules.map(rule => {
                  const isEditing = editingId === rule.id;
                  const isPendingDelete = pendingDeleteId === rule.id;
                  const isHighlighted = highlightedRuleId === rule.id;
                  return (
                    <tr
                      key={rule.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(rule.id, el);
                        else rowRefs.current.delete(rule.id);
                      }}
                      className={`transition-colors ${isHighlighted ? "bg-emerald-400/10 ring-1 ring-emerald-400/40" : "hover:bg-white/[0.02]"}`}>
                      <td className="py-3 pr-4 font-mono text-sm text-white">{rule.subdomain}</td>
                      <td className="py-3 pr-4 text-sm">
                        {isEditing ? (
                          <div className="space-y-2">
                            <Select value={editFunnelId} onValueChange={(v) => { setEditFunnelId(v); setEditPreview(null); setEditForceOverride(false); }}>
                              <SelectTrigger className="w-[200px] bg-white/5 border-white/10 text-sm h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {funnelTypes.map(ft => (
                                  <SelectItem key={ft.id} value={String(ft.id)}>{ft.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {editPreview && (
                              <div className="text-xs bg-white/[0.03] border border-white/10 rounded-md px-2 py-1.5 space-y-0.5">
                                <div className="text-white/80">
                                  Re-tag{" "}
                                  <span className="text-emerald-300 font-medium">{editPreview.updatedEventCount.toLocaleString()}</span>{" "}
                                  {editPreview.updatedEventCount === 1 ? "event" : "events"}
                                  {editPreview.updatedLeadCount > 0 && (
                                    <> &middot; <span className="text-emerald-300 font-medium">{editPreview.updatedLeadCount.toLocaleString()}</span> {editPreview.updatedLeadCount === 1 ? "lead" : "leads"}</>
                                  )}
                                </div>
                                {editPreview.conflictingEventCount > 0 && !editForceOverride && (
                                  <div className="text-amber-300/90">
                                    ⚠ {editPreview.conflictingEventCount.toLocaleString()} {editPreview.conflictingEventCount === 1 ? "event" : "events"} already on a different funnel — left alone.
                                  </div>
                                )}
                                {editPreview.conflictingEventCount > 0 && editForceOverride && (
                                  <div className="text-amber-300/90">
                                    Force-override on: {editPreview.conflictingEventCount.toLocaleString()}{" "}
                                    {editPreview.conflictingEventCount === 1 ? "event" : "events"} on a different funnel will also be re-tagged.
                                  </div>
                                )}
                                {(editPreview.conflictingEventCount > 0 || editForceOverride) && (
                                  <label className="flex items-start gap-2 pt-1 cursor-pointer select-none">
                                    <Checkbox
                                      checked={editForceOverride}
                                      onCheckedChange={(c) => toggleEditForceOverride(rule, c === true)}
                                      disabled={previewingEdit}
                                      className="mt-0.5 border-white/30 data-[state=checked]:bg-amber-500 data-[state=checked]:border-amber-500"
                                    />
                                    <span className="text-white/70">
                                      Also re-tag the {editPreview.conflictingEventCount.toLocaleString()}{" "}
                                      {editPreview.conflictingEventCount === 1 ? "event" : "events"} currently on a different funnel
                                    </span>
                                  </label>
                                )}
                                <PreviewSampleList
                                  title="Sample events that would be re-tagged"
                                  tone="eligible"
                                  events={editPreview.eligibleSample}
                                  totalCount={editPreview.updatedEventCount}
                                  onOpenEvent={onOpenEvent}
                                />
                                <PreviewSampleList
                                  title="Sample events left alone (conflicting funnel)"
                                  tone="conflict"
                                  events={editPreview.conflictingSample}
                                  totalCount={editPreview.conflictingEventCount}
                                  onOpenEvent={onOpenEvent}
                                />
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-white/80">{rule.funnelName}</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap">
                        {isEditing ? (
                          <div className="flex gap-1 justify-end">
                            {editPreview ? (
                              <>
                                <Button size="sm" variant="ghost" disabled={savingEdit} onClick={() => saveEdit(rule)} className="h-7 px-2 text-xs text-emerald-300">
                                  {savingEdit ? "Saving..." : "Confirm"}
                                </Button>
                                <Button size="sm" variant="ghost" disabled={savingEdit} onClick={cancelEdit} className="h-7 px-2 text-xs text-white/50">
                                  Cancel
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button size="sm" variant="ghost" disabled={previewingEdit || !editFunnelId || Number(editFunnelId) === rule.funnelTypeId} onClick={() => previewEdit(rule)} className="h-7 px-2 text-xs">
                                  {previewingEdit ? "..." : "Preview"}
                                </Button>
                                <Button size="sm" variant="ghost" disabled={previewingEdit} onClick={cancelEdit} className="h-7 px-2 text-xs text-white/50">
                                  Cancel
                                </Button>
                              </>
                            )}
                          </div>
                        ) : isPendingDelete ? (
                          <div className="flex flex-col gap-1 items-end">
                            <label className="flex items-center gap-1.5 text-xs text-white/70 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={pendingDeleteRevert}
                                onChange={(e) => setPendingDeleteRevert(e.target.checked)}
                                disabled={deleting}
                                className="h-3 w-3 accent-amber-400"
                              />
                              Also revert past events tagged{" "}
                              <span className="font-mono text-white/80">{rule.funnelName}</span> on{" "}
                              <span className="font-mono text-white/80">{rule.subdomain}</span> back to the tenant default
                            </label>
                            <div className="flex gap-1 justify-end items-center">
                              <span className="text-xs text-amber-400/80 mr-1">Delete?</span>
                              <Button size="sm" variant="ghost" disabled={deleting} onClick={() => confirmDelete(rule.id)} className="h-7 px-2 text-xs text-red-400">
                                {deleting ? "Deleting..." : pendingDeleteRevert ? "Yes, delete & revert" : "Yes, delete"}
                              </Button>
                              <Button size="sm" variant="ghost" disabled={deleting} onClick={() => { setPendingDeleteId(null); setPendingDeleteRevert(false); }} className="h-7 px-2 text-xs text-white/50">
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-1 justify-end">
                            <Button size="sm" variant="ghost" onClick={() => startEdit(rule)} className="h-7 px-2 text-xs">
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { setPendingDeleteId(rule.id); setPendingDeleteRevert(false); }} className="h-7 px-2 text-xs text-white/50 hover:text-red-400">
                              Delete
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

export function FormFieldsList({ formFields }: { formFields: Record<string, unknown> | null | undefined }) {
  if (!formFields || typeof formFields !== "object") return null;
  const fieldEntries = Object.entries(formFields).filter(([key]) => !key.startsWith("_"));
  const count = fieldEntries.length;
  if (count === 0) return null;
  return (
    <div className="mt-3 space-y-1">
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
        Form Fields <span className="text-white/40 normal-case tracking-normal">· {count} {count === 1 ? "field" : "fields"} captured</span>
      </p>
      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-2">
        {fieldEntries.map(([key, value]) => (
          <div key={key} className="flex justify-between gap-4 text-sm">
            <span className="text-muted-foreground shrink-0">{key}</span>
            <span className="text-white text-right break-all">{formatFieldValue(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailSection({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-muted-foreground">{icon}</span>
        <h4 className="text-xs font-medium text-white/60 uppercase tracking-wider">
          {title}
          {subtitle && (
            <span className="ml-2 text-white/35 normal-case tracking-normal font-normal">· {subtitle}</span>
          )}
        </h4>
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
