import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn, formatCurrency } from "@/lib/utils";
import {
  CheckCircle2,
  Loader2,
  Megaphone,
  Search,
  Sparkles,
  XCircle,
} from "lucide-react";

type DateRange = "last7" | "last30" | "thisMonth" | "lastMonth";

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

type CampaignFunnelOption = {
  id: number;
  name: string;
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
};

type CampaignFunnelMappingResponse = {
  dateRange: { startDate: string | null; endDate: string | null };
  funnels: CampaignFunnelOption[];
  campaigns: CampaignMapping[];
  unmappedSpend: number;
  unmappedConversions: number;
};

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
  const [refreshToken, setRefreshToken] = useState(0);
  const [data, setData] = useState<CampaignFunnelMappingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingCampaignId, setSavingCampaignId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [showOnlyUnmapped, setShowOnlyUnmapped] = useState(false);

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
        if (!cancelled) setData(next);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || "Could not load Meta campaign mappings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, tenantId, startDate, endDate, refreshToken]);

  const filteredCampaigns = useMemo(() => {
    const campaigns = data?.campaigns ?? [];
    const q = search.trim().toLowerCase();
    return campaigns.filter((campaign) => {
      if (showOnlyUnmapped && campaign.funnelTypeId != null) return false;
      if (!q) return true;
      return [
        campaign.name,
        campaign.externalId,
        campaign.funnelName ?? "",
        campaign.suggestedFunnelName ?? "",
      ].some((value) => value.toLowerCase().includes(q));
    });
  }, [data?.campaigns, search, showOnlyUnmapped]);

  const funnelOptions = data?.funnels ?? [];
  const mappedCount = data?.campaigns.filter((campaign) => campaign.funnelTypeId != null).length ?? 0;
  const unmappedCount = (data?.campaigns.length ?? 0) - mappedCount;

  async function saveMapping(campaignId: number, funnelTypeId: number | null) {
    setSavingCampaignId(campaignId);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/campaigns/${campaignId}/funnel-mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ funnelTypeId }),
      });
      const payload = await res.json().catch(() => null) as { error?: string; funnelName?: string | null } | null;
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);

      setData((current) => {
        if (!current) return current;
        const selectedFunnel = funnelTypeId == null
          ? null
          : current.funnels.find((funnel) => funnel.id === funnelTypeId) ?? null;
        return {
          ...current,
          campaigns: current.campaigns.map((campaign) => campaign.campaignId === campaignId
            ? {
                ...campaign,
                funnelTypeId,
                funnelName: payload?.funnelName ?? selectedFunnel?.name ?? null,
                mappingSource: funnelTypeId == null ? null : "manual",
                suggestedFunnelTypeId: null,
                suggestedFunnelName: null,
              }
            : campaign),
        };
      });
      setRefreshToken((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save campaign mapping");
    } finally {
      setSavingCampaignId(null);
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
            <h3 className="font-display text-xl text-white">Meta Campaign Funnel Map</h3>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Assign each Meta campaign{tenantName ? ` for ${tenantName}` : ""} to one funnel so Challenge spend, Meta leads, CPL, ROAS, CAC, and appointment cost land in the correct funnel row.
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
          {formatCurrency(data.unmappedSpend)} in Meta spend and {formatNumber(data.unmappedConversions)} Meta leads are not assigned to a funnel in {label.toLowerCase()}.
        </div>
      )}

      <div className="flex flex-col gap-3 border-b border-white/5 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-3 md:flex-row md:items-center">
          <div className="relative w-full md:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search campaigns"
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
          Loading Meta campaigns...
        </div>
      ) : data?.campaigns.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No Meta campaigns were found for this tenant.</div>
      ) : (
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
              {filteredCampaigns.map((campaign) => {
                const saving = savingCampaignId === campaign.campaignId;
                return (
                  <tr key={campaign.campaignId} className="hover:bg-white/[0.02]">
                    <td className="max-w-[28rem] p-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">{campaign.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {campaign.status || "unknown"} · {campaign.externalId}
                        </p>
                      </div>
                    </td>
                    <td className="whitespace-nowrap p-4 text-right text-sm text-white">{formatCurrency(campaign.spend)}</td>
                    <td className="whitespace-nowrap p-4 text-right text-sm text-white">{formatNumber(campaign.conversions)}</td>
                    <td className="whitespace-nowrap p-4 text-right text-sm text-white">{campaign.conversions > 0 ? formatCurrency(campaign.cpl) : "$0"}</td>
                    <td className="w-72 p-4">
                      <Select
                        value={campaign.funnelTypeId == null ? "unmapped" : String(campaign.funnelTypeId)}
                        onValueChange={(value) => saveMapping(campaign.campaignId, value === "unmapped" ? null : Number(value))}
                        disabled={saving}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unmapped">Unmapped</SelectItem>
                          {funnelOptions.map((funnel) => (
                            <SelectItem key={funnel.id} value={String(funnel.id)}>{funnel.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="w-64 p-4">
                      {saving ? (
                        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Saving
                        </span>
                      ) : campaign.suggestedFunnelTypeId ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 border-sky-400/20 bg-sky-400/5 text-sky-100 hover:bg-sky-400/10"
                          onClick={() => saveMapping(campaign.campaignId, campaign.suggestedFunnelTypeId)}
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          Use {campaign.suggestedFunnelName}
                        </Button>
                      ) : campaign.funnelTypeId ? (
                        <span className="inline-flex items-center gap-2 text-xs text-emerald-200">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Mapped
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">No match suggested</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredCampaigns.length === 0 && (
            <div className="border-t border-white/5 p-8 text-center text-sm text-muted-foreground">No campaigns match this view.</div>
          )}
        </div>
      )}
    </div>
  );
}
