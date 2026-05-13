import { Fragment, useState } from "react";
import { useGetMetaCampaignSummary, useGetMetaCampaignBreakdown } from "@workspace/api-client-react";
import { PremiumCard } from "@/components/ui-helpers";
import { ChevronRight, Loader2 } from "lucide-react";

type Props = {
  startDate: string;
  endDate: string;
};

function formatMoney(amount: number, currency: string | null | undefined): string {
  const code = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function MetaCampaignBreakdown({ startDate, endDate }: Props) {
  const { data: campaigns, isLoading } = useGetMetaCampaignSummary({ startDate, endDate });
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const toggle = (id: number) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  return (
    <PremiumCard className="p-6" transition={{ delay: 0.6 }}>
      <div className="mb-4">
        <h3 className="font-display text-xl text-white">Meta Campaign Performance</h3>
        <p className="text-muted-foreground text-sm">
          Click a campaign to expand its ad sets, then expand an ad set to see individual ads.
        </p>
      </div>

      {isLoading && !campaigns ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading Meta campaigns...
        </div>
      ) : !campaigns || campaigns.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground text-sm">
          No Meta campaigns found for this date range.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-white/10">
                <th className="py-2 pr-4 font-medium w-8"></th>
                <th className="py-2 pr-4 font-medium">Campaign</th>
                <th className="py-2 pr-4 font-medium text-right">Spend</th>
                <th className="py-2 pr-4 font-medium text-right">Clicks</th>
                <th className="py-2 pr-4 font-medium text-right">Conversions</th>
                <th className="py-2 pr-4 font-medium text-right">CPL</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map(c => (
                <CampaignRow
                  key={c.campaignId}
                  campaign={c}
                  expanded={!!expanded[c.campaignId]}
                  onToggle={() => toggle(c.campaignId)}
                  startDate={startDate}
                  endDate={endDate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PremiumCard>
  );
}

type CampaignRowProps = {
  campaign: {
    campaignId: number;
    name: string;
    status: string;
    currency?: string | null;
    spend: number;
    clicks: number;
    conversions: number;
    cpl: number;
  };
  expanded: boolean;
  onToggle: () => void;
  startDate: string;
  endDate: string;
};

function CampaignRow({ campaign, expanded, onToggle, startDate, endDate }: CampaignRowProps) {
  return (
    <>
      <tr
        className="border-b border-white/5 hover:bg-white/5 cursor-pointer"
        onClick={onToggle}
        data-testid={`campaign-row-${campaign.campaignId}`}
      >
        <td className="py-3 pr-4 align-middle">
          <ChevronRight
            className={`w-4 h-4 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </td>
        <td className="py-3 pr-4 text-white">
          <div>{campaign.name || campaign.campaignId}</div>
          <div className="text-[11px] text-muted-foreground uppercase tracking-wider">{campaign.status}</div>
        </td>
        <td className="py-3 pr-4 text-right text-white font-medium">{formatMoney(campaign.spend, campaign.currency)}</td>
        <td className="py-3 pr-4 text-right text-white">{formatInt(campaign.clicks)}</td>
        <td className="py-3 pr-4 text-right text-white">{formatInt(campaign.conversions)}</td>
        <td className="py-3 pr-4 text-right text-white">
          {campaign.conversions > 0 ? formatMoney(campaign.cpl, campaign.currency) : "—"}
        </td>
      </tr>
      {expanded && (
        <CampaignBreakdown campaignId={campaign.campaignId} startDate={startDate} endDate={endDate} />
      )}
    </>
  );
}

function CampaignBreakdown({ campaignId, startDate, endDate }: { campaignId: number; startDate: string; endDate: string }) {
  const { data, isLoading } = useGetMetaCampaignBreakdown(campaignId, { startDate, endDate });
  const [expandedSets, setExpandedSets] = useState<Record<string, boolean>>({});

  if (isLoading && !data) {
    return (
      <tr>
        <td colSpan={6} className="py-4 text-center text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading ad sets...
        </td>
      </tr>
    );
  }
  if (!data || data.adSets.length === 0) {
    return (
      <tr>
        <td colSpan={6} className="py-4 pl-12 text-muted-foreground italic text-xs">
          No ad sets with stats in this date range.
        </td>
      </tr>
    );
  }

  const currency = data.currency;
  const toggleSet = (id: string) => setExpandedSets(prev => ({ ...prev, [id]: !prev[id] }));

  return (
    <>
      {data.adSets.map(set => {
        const open = !!expandedSets[set.externalId];
        return (
          <Fragment key={set.externalId}>
            <tr
              key={`set-${set.externalId}`}
              className="border-b border-white/5 bg-white/[0.02] hover:bg-white/5 cursor-pointer"
              onClick={() => toggleSet(set.externalId)}
              data-testid={`adset-row-${set.externalId}`}
            >
              <td className="py-2 pr-4 pl-6 align-middle">
                <ChevronRight
                  className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                />
              </td>
              <td className="py-2 pr-4 text-white/80 pl-2">
                <div className="text-sm">{set.name || set.externalId}</div>
                {set.status && (
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{set.status}</div>
                )}
              </td>
              <td className="py-2 pr-4 text-right text-white/80">{formatMoney(set.spend, currency)}</td>
              <td className="py-2 pr-4 text-right text-white/80">{formatInt(set.clicks)}</td>
              <td className="py-2 pr-4 text-right text-white/80">{formatInt(set.conversions)}</td>
              <td className="py-2 pr-4 text-right text-white/80">
                {set.conversions > 0 ? formatMoney(set.cpl, currency) : "—"}
              </td>
            </tr>
            {open && set.ads.length === 0 && (
              <tr key={`set-${set.externalId}-empty`}>
                <td colSpan={6} className="py-2 pl-16 text-muted-foreground italic text-xs">
                  No ads with stats in this date range.
                </td>
              </tr>
            )}
            {open && set.ads.map(ad => (
              <tr
                key={`ad-${ad.externalId}`}
                className="border-b border-white/5 hover:bg-white/5"
                data-testid={`ad-row-${ad.externalId}`}
              >
                <td className="py-2 pr-4 pl-6"></td>
                <td className="py-2 pr-4 pl-10 text-white/70">
                  <div className="text-xs">{ad.name || ad.externalId}</div>
                  {ad.status && (
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{ad.status}</div>
                  )}
                </td>
                <td className="py-2 pr-4 text-right text-white/70 text-xs">{formatMoney(ad.spend, currency)}</td>
                <td className="py-2 pr-4 text-right text-white/70 text-xs">{formatInt(ad.clicks)}</td>
                <td className="py-2 pr-4 text-right text-white/70 text-xs">{formatInt(ad.conversions)}</td>
                <td className="py-2 pr-4 text-right text-white/70 text-xs">
                  {ad.conversions > 0 ? formatMoney(ad.cpl, currency) : "—"}
                </td>
              </tr>
            ))}
          </Fragment>
        );
      })}
    </>
  );
}
