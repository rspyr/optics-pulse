import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, formatCurrency } from "@/lib/utils";
import {
  CheckCircle2,
  Layers3,
  Loader2,
  Megaphone,
  Plus,
  Search,
  Sparkles,
  Tags,
  Trash2,
  XCircle,
} from "lucide-react";

type DateRange = "last7" | "last30" | "thisMonth" | "lastMonth";
type MappingLevel = "campaign" | "ad_set";
type StatusFilter = "all" | "active" | "paused";

function getDateRange(range: DateRange): { startDate: string; endDate: string; label: string } {
  const now = new Date();
  const end = now.toISOString().split("T")[0];
  switch (range) {
    case "last7": {
      const s = new Date(now.getTime() - 7 * 86400000);
      return { startDate: s.toISOString().split("T")[0], endDate: end, label: "Last 7 Days" };
    }
    case "thisMonth": {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { startDate: s.toISOString().split("T")[0], endDate: end, label: "This Month" };
    }
    case "lastMonth": {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return { startDate: s.toISOString().split("T")[0], endDate: e.toISOString().split("T")[0], label: "Last Month" };
    }
    default: {
      const s = new Date(now.getTime() - 30 * 86400000);
      return { startDate: s.toISOString().split("T")[0], endDate: end, label: "Last 30 Days" };
    }
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value);
}

function statusMatches(status: string | null, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  return (status ?? "").toLowerCase().includes(filter);
}

type FunnelMatchCode = {
  id: number;
  code: string;
};

type CampaignFunnelOption = {
  id: number;
  name: string;
  slug: string;
  matchCodes: FunnelMatchCode[];
};

type CampaignMapping = {
  campaignId: number;
  externalId: string;
  name: string;
  status: string | null;
  currency: string | null;
  adAccountId: string | null;
  spend: number;
  conversions: number;
  cpl: number;
  funnelTypeId: number | null;
  funnelName: string | null;
  mappingSource: string | null;
  suggestedFunnelTypeId: number | null;
  suggestedFunnelName: string | null;
  suggestedMatchCode: string | null;
};

type AdSetMapping = {
  campaignId: number;
  campaignExternalId: string;
  campaignName: string;
  adSetExternalId: string;
  name: string;
  status: string | null;
  adAccountId: string | null;
  spend: number;
  conversions: number;
  cpl: number;
  funnelTypeId: number | null;
  funnelName: string | null;
  mappingSource: string | null;
  campaignFunnelTypeId: number | null;
  campaignFunnelName: string | null;
  effectiveFunnelTypeId: number | null;
  effectiveFunnelName: string | null;
  effectiveMappingLevel: MappingLevel | null;
  suggestedFunnelTypeId: number | null;
  suggestedFunnelName: string | null;
  suggestedMatchCode: string | null;
};

type CampaignFunnelMappingResponse = {
  dateRange: { startDate: string | null; endDate: string | null };
  funnels: CampaignFunnelOption[];
  campaigns: CampaignMapping[];
  adSets: AdSetMapping[];
  unmappedSpend: number;
  unmappedConversions: number;
};

function rowKey(level: MappingLevel, campaignId: number, adSetExternalId?: string | null) {
  return `${level}:${campaignId}:${adSetExternalId ?? "campaign"}`;
}

export function MetaCampaignFunnelMapping({
  tenantId,
  apiBase,
  tenantName,
}: {
  tenantId: number;
  apiBase: string;
  tenantName?: string;
}) {
  const [dateRange, setDateRange] = useState<DateRange>("last30");
  const [mappingLevel, setMappingLevel] = useState<MappingLevel>("ad_set");
  const [refreshToken, setRefreshToken] = useState(0);
  const [data, setData] = useState<CampaignFunnelMappingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showOnlyUnmapped, setShowOnlyUnmapped] = useState(false);
  const [codeFunnelId, setCodeFunnelId] = useState<string>("");
  const [newCode, setNewCode] = useState("");
  const [savingCode, setSavingCode] = useState(false);
  const [deletingCodeId, setDeletingCodeId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const { startDate, endDate, label } = useMemo(() => getDateRange(dateRange), [dateRange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      tenantId: String(tenantId),
      startDate,
      endDate,
    });

    fetch(`${apiBase}/api/campaigns/meta-funnel-mappings?${params.toString()}`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          const payload = await res.json().catch(() => null) as { error?: string } | null;
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
        return res.json() as Promise<CampaignFunnelMappingResponse>;
      })
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setCodeFunnelId((current) => current || (next.funnels[0] ? String(next.funnels[0].id) : ""));
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || "Could not load Meta funnel mappings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, tenantId, startDate, endDate, refreshToken]);

  const statusFilteredCampaigns = useMemo(() => {
    const campaigns = data?.campaigns ?? [];
    return campaigns.filter((campaign) => statusMatches(campaign.status, statusFilter));
  }, [data?.campaigns, statusFilter]);

  const statusFilteredAdSets = useMemo(() => {
    const adSets = data?.adSets ?? [];
    return adSets.filter((adSet) => statusMatches(adSet.status, statusFilter));
  }, [data?.adSets, statusFilter]);

  const filteredCampaigns = useMemo(() => {
    const q = search.trim().toLowerCase();
    return statusFilteredCampaigns.filter((campaign) => {
      if (showOnlyUnmapped && campaign.funnelTypeId != null) return false;
      if (!q) return true;
      return [
        campaign.name,
        campaign.externalId,
        campaign.funnelName ?? "",
        campaign.suggestedFunnelName ?? "",
        campaign.suggestedMatchCode ?? "",
      ].some((value) => value.toLowerCase().includes(q));
    });
  }, [statusFilteredCampaigns, search, showOnlyUnmapped]);

  const filteredAdSets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return statusFilteredAdSets.filter((adSet) => {
      if (showOnlyUnmapped && adSet.effectiveFunnelTypeId != null) return false;
      if (!q) return true;
      return [
        adSet.name,
        adSet.adSetExternalId,
        adSet.campaignName,
        adSet.campaignExternalId,
        adSet.effectiveFunnelName ?? "",
        adSet.suggestedFunnelName ?? "",
        adSet.suggestedMatchCode ?? "",
      ].some((value) => value.toLowerCase().includes(q));
    });
  }, [statusFilteredAdSets, search, showOnlyUnmapped]);

  const funnelOptions = data?.funnels ?? [];
  const allRows = mappingLevel === "campaign" ? statusFilteredCampaigns : statusFilteredAdSets;
  const mappedCount = mappingLevel === "campaign"
    ? statusFilteredCampaigns.filter((campaign) => campaign.funnelTypeId != null).length
    : statusFilteredAdSets.filter((adSet) => adSet.effectiveFunnelTypeId != null).length;
  const unmappedCount = Math.max(0, allRows.length - mappedCount);

  async function saveMapping(level: MappingLevel, campaignId: number, funnelTypeId: number | null, adSetExternalId?: string | null) {
    const key = rowKey(level, campaignId, adSetExternalId);
    setSavingKey(key);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/campaigns/${campaignId}/funnel-mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          funnelTypeId,
          mappingLevel: level,
          ...(level === "ad_set" ? { adSetExternalId } : {}),
        }),
      });
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
      setRefreshToken((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save mapping");
    } finally {
      setSavingKey(null);
    }
  }

  async function addCode() {
    if (!codeFunnelId || !newCode.trim()) return;
    setSavingCode(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/campaigns/meta-funnel-match-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tenantId, funnelTypeId: Number(codeFunnelId), code: newCode.trim() }),
      });
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
      setNewCode("");
      setRefreshToken((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add match code");
    } finally {
      setSavingCode(false);
    }
  }

  async function deleteCode(id: number) {
    setDeletingCodeId(id);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/campaigns/meta-funnel-match-codes/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
      setRefreshToken((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove match code");
    } finally {
      setDeletingCodeId(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-background/30">
      <div className="flex flex-col gap-4 border-b border-white/5 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/5 bg-white/[0.04]">
            <Megaphone className="h-5 w-5 text-sky-300" />
          </div>
          <div>
            <h3 className="font-display text-xl text-white">Meta Funnel Map</h3>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Match Meta campaigns or ad sets{tenantName ? ` for ${tenantName}` : ""} to funnels for Challenge spend, Meta leads, CPL, ROAS, CAC, and appointment cost.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="border-emerald-400/20 bg-emerald-400/5 text-emerald-200">
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
            {mappedCount} mapped
          </Badge>
          <Badge variant="outline" className={cn(
            "border-white/10 text-muted-foreground",
            unmappedCount > 0 && "border-amber-400/25 bg-amber-400/5 text-amber-200",
          )}>
            <XCircle className="mr-1 h-3.5 w-3.5" />
            {unmappedCount} unmapped
          </Badge>
        </div>
      </div>

      {data && data.unmappedSpend > 0 && (
        <div className="border-b border-amber-400/15 bg-amber-400/[0.06] px-5 py-3 text-sm text-amber-100">
          {formatCurrency(data.unmappedSpend)} in Meta spend and {formatNumber(data.unmappedConversions)} Meta leads are unmapped in {label.toLowerCase()} and excluded from funnel dashboards.
        </div>
      )}

      <div className="border-b border-white/5 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
          <Tags className="h-4 w-4 text-sky-300" />
          Global funnel codes and names
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <Select value={codeFunnelId} onValueChange={setCodeFunnelId}>
            <SelectTrigger className="w-full lg:w-60">
              <SelectValue placeholder="Select funnel" />
            </SelectTrigger>
            <SelectContent>
              {funnelOptions.map((funnel) => (
                <SelectItem key={funnel.id} value={String(funnel.id)}>{funnel.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={newCode}
            onChange={(event) => setNewCode(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && addCode()}
            placeholder="Shared code or name"
            className="lg:max-w-xs"
          />
          <Button type="button" variant="outline" size="sm" onClick={addCode} disabled={!codeFunnelId || !newCode.trim() || savingCode}>
            {savingCode ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {funnelOptions.flatMap((funnel) => funnel.matchCodes.map((code) => (
            <span key={code.id} className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-white/80">
              <span className="text-white/45">{funnel.name}</span>
              {code.code}
              <button
                type="button"
                onClick={() => deleteCode(code.id)}
                disabled={deletingCodeId === code.id}
                className="text-white/35 transition-colors hover:text-red-300 disabled:opacity-50"
                aria-label={`Remove ${code.code}`}
              >
                {deletingCodeId === code.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              </button>
            </span>
          )))}
          {funnelOptions.every((funnel) => funnel.matchCodes.length === 0) && (
            <span className="text-xs text-muted-foreground">No codes yet.</span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 border-b border-white/5 p-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-1 flex-col gap-3 md:flex-row md:items-center">
          <Tabs value={mappingLevel} onValueChange={(value) => setMappingLevel(value as MappingLevel)}>
            <TabsList className="grid w-full grid-cols-2 bg-white/[0.04] md:w-[22rem]">
              <TabsTrigger value="ad_set" className="gap-2">
                <Layers3 className="h-4 w-4" />
                Ad Sets
              </TabsTrigger>
              <TabsTrigger value="campaign" className="gap-2">
                <Megaphone className="h-4 w-4" />
                Campaigns
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative w-full md:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={mappingLevel === "ad_set" ? "Search ad sets" : "Search campaigns"}
              className="pl-9"
            />
          </div>
          <Select value={dateRange} onValueChange={(value) => setDateRange(value as DateRange)}>
            <SelectTrigger className="w-full md:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="last7">Last 7 Days</SelectItem>
              <SelectItem value="last30">Last 30 Days</SelectItem>
              <SelectItem value="thisMonth">This Month</SelectItem>
              <SelectItem value="lastMonth">Last Month</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
            <SelectTrigger className="w-full md:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("w-full md:w-auto", showOnlyUnmapped && "border-amber-400/30 bg-amber-400/10 text-amber-100")}
          onClick={() => setShowOnlyUnmapped((current) => !current)}
        >
          {showOnlyUnmapped ? "Showing unmapped" : "Show unmapped"}
        </Button>
      </div>

      {error && (
        <div className="border-b border-red-500/20 bg-red-500/5 px-5 py-3 text-sm text-red-200">{error}</div>
      )}

      {loading && !data ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin" />
          Loading Meta mappings...
        </div>
      ) : mappingLevel === "campaign" ? (
        <CampaignTable
          campaigns={filteredCampaigns}
          funnelOptions={funnelOptions}
          savingKey={savingKey}
          onSave={(campaign, funnelTypeId) => saveMapping("campaign", campaign.campaignId, funnelTypeId)}
        />
      ) : (
        <AdSetTable
          adSets={filteredAdSets}
          funnelOptions={funnelOptions}
          savingKey={savingKey}
          onSave={(adSet, funnelTypeId) => saveMapping("ad_set", adSet.campaignId, funnelTypeId, adSet.adSetExternalId)}
        />
      )}
    </div>
  );
}

function CampaignTable({
  campaigns,
  funnelOptions,
  savingKey,
  onSave,
}: {
  campaigns: CampaignMapping[];
  funnelOptions: CampaignFunnelOption[];
  savingKey: string | null;
  onSave: (campaign: CampaignMapping, funnelTypeId: number | null) => void;
}) {
  if (campaigns.length === 0) {
    return <div className="p-8 text-center text-sm text-muted-foreground">No campaigns match this view.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] border-collapse text-left">
        <thead>
          <tr className="border-b border-white/5 bg-background/50">
            <th className="p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">Campaign</th>
            <th className="p-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Spend</th>
            <th className="p-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Meta Leads</th>
            <th className="p-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">CPL</th>
            <th className="p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">Funnel</th>
            <th className="p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">Suggestion</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {campaigns.map((campaign) => {
            const saving = savingKey === rowKey("campaign", campaign.campaignId);
            return (
              <tr key={campaign.campaignId} className="hover:bg-white/[0.02]">
                <td className="max-w-[28rem] p-4">
                  <p className="truncate text-sm font-medium text-white">{campaign.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{campaign.status || "unknown"} · {campaign.externalId}</p>
                </td>
                <td className="whitespace-nowrap p-4 text-right text-sm text-white">{formatCurrency(campaign.spend)}</td>
                <td className="whitespace-nowrap p-4 text-right text-sm text-white">{formatNumber(campaign.conversions)}</td>
                <td className="whitespace-nowrap p-4 text-right text-sm text-white">{campaign.conversions > 0 ? formatCurrency(campaign.cpl) : "$0"}</td>
                <td className="w-72 p-4">
                  <Select
                    value={campaign.funnelTypeId == null ? "unmapped" : String(campaign.funnelTypeId)}
                    onValueChange={(value) => onSave(campaign, value === "unmapped" ? null : Number(value))}
                    disabled={saving}
                  >
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unmapped">Unmapped</SelectItem>
                      {funnelOptions.map((funnel) => (
                        <SelectItem key={funnel.id} value={String(funnel.id)}>{funnel.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="w-64 p-4">
                  <SuggestionCell
                    saving={saving}
                    mapped={campaign.funnelTypeId != null}
                    suggestedFunnelName={campaign.suggestedFunnelName}
                    suggestedFunnelTypeId={campaign.suggestedFunnelTypeId}
                    suggestedMatchCode={campaign.suggestedMatchCode}
                    onUse={(id) => onSave(campaign, id)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AdSetTable({
  adSets,
  funnelOptions,
  savingKey,
  onSave,
}: {
  adSets: AdSetMapping[];
  funnelOptions: CampaignFunnelOption[];
  savingKey: string | null;
  onSave: (adSet: AdSetMapping, funnelTypeId: number | null) => void;
}) {
  if (adSets.length === 0) {
    return <div className="p-8 text-center text-sm text-muted-foreground">No ad sets match this view.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1120px] border-collapse text-left">
        <thead>
          <tr className="border-b border-white/5 bg-background/50">
            <th className="p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">Campaign</th>
            <th className="p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">Ad Set</th>
            <th className="p-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Spend</th>
            <th className="p-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Meta Leads</th>
            <th className="p-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">CPL</th>
            <th className="p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">Funnel</th>
            <th className="p-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">Suggestion</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {adSets.map((adSet) => {
            const saving = savingKey === rowKey("ad_set", adSet.campaignId, adSet.adSetExternalId);
            return (
              <tr key={`${adSet.campaignId}:${adSet.adSetExternalId}`} className="hover:bg-white/[0.02]">
                <td className="max-w-[18rem] p-4">
                  <p className="truncate text-sm font-medium text-white">{adSet.campaignName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{adSet.campaignExternalId}</p>
                </td>
                <td className="max-w-[22rem] p-4">
                  <p className="truncate text-sm font-medium text-white">{adSet.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{adSet.status || "unknown"} · {adSet.adSetExternalId}</p>
                </td>
                <td className="whitespace-nowrap p-4 text-right text-sm text-white">{formatCurrency(adSet.spend)}</td>
                <td className="whitespace-nowrap p-4 text-right text-sm text-white">{formatNumber(adSet.conversions)}</td>
                <td className="whitespace-nowrap p-4 text-right text-sm text-white">{adSet.conversions > 0 ? formatCurrency(adSet.cpl) : "$0"}</td>
                <td className="w-72 p-4">
                  <Select
                    value={adSet.funnelTypeId == null ? "inherit" : String(adSet.funnelTypeId)}
                    onValueChange={(value) => onSave(adSet, value === "inherit" ? null : Number(value))}
                    disabled={saving}
                  >
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">{adSet.campaignFunnelName ? "Use campaign mapping" : "No ad-set match"}</SelectItem>
                      {funnelOptions.map((funnel) => (
                        <SelectItem key={funnel.id} value={String(funnel.id)}>{funnel.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {adSet.funnelTypeId == null && adSet.campaignFunnelName && (
                    <p className="mt-1 text-xs text-muted-foreground">Using campaign: {adSet.campaignFunnelName}</p>
                  )}
                </td>
                <td className="w-64 p-4">
                  <SuggestionCell
                    saving={saving}
                    mapped={adSet.effectiveFunnelTypeId != null}
                    suggestedFunnelName={adSet.suggestedFunnelName}
                    suggestedFunnelTypeId={adSet.suggestedFunnelTypeId}
                    suggestedMatchCode={adSet.suggestedMatchCode}
                    onUse={(id) => onSave(adSet, id)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SuggestionCell({
  saving,
  mapped,
  suggestedFunnelName,
  suggestedFunnelTypeId,
  suggestedMatchCode,
  onUse,
}: {
  saving: boolean;
  mapped: boolean;
  suggestedFunnelName: string | null;
  suggestedFunnelTypeId: number | null;
  suggestedMatchCode: string | null;
  onUse: (funnelTypeId: number) => void;
}) {
  if (saving) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Saving
      </span>
    );
  }

  if (suggestedFunnelTypeId) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-sky-400/20 bg-sky-400/5 text-sky-100 hover:bg-sky-400/10"
          onClick={() => onUse(suggestedFunnelTypeId)}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Use {suggestedFunnelName}
        </Button>
        {suggestedMatchCode && (
          <span className="text-xs text-muted-foreground">Matched {suggestedMatchCode}</span>
        )}
      </div>
    );
  }

  if (mapped) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-emerald-200">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Mapped
      </span>
    );
  }

  return <span className="text-xs text-muted-foreground">No match suggested</span>;
}
