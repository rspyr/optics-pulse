import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useGetMetaCampaignSummary, useGetMetaCampaignBreakdown } from "@workspace/api-client-react";
import { PremiumCard } from "@/components/ui-helpers";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ChevronRight, ImageOff, Loader2, ArrowUp, ArrowDown, ExternalLink } from "lucide-react";

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

type SortKey = "spend" | "clicks" | "conversions" | "cpl";
type SortDir = "asc" | "desc";

function isActiveStatus(status: string | null | undefined): boolean {
  if (!status) return true;
  const s = status.toUpperCase();
  return s !== "PAUSED" && s !== "INACTIVE" && s !== "ARCHIVED" && s !== "DELETED";
}

export function MetaCampaignBreakdown({ startDate, endDate }: Props) {
  const { data: campaigns, isLoading } = useGetMetaCampaignSummary({ startDate, endDate });
  const [expanded, setExpanded] = useState<Record<number, boolean>>(() => loadExpandedCampaigns());
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [hideInactive, setHideInactive] = useState(false);
  const [search, setSearch] = useState("");

  // Date-range change resets sort/filter, search, and expansion state for
  // ALL campaigns, even ones that aren't currently expanded. We clear
  // localStorage at the parent level so collapsed campaigns don't restore
  // stale prefs/expansions the next time they're opened. Skip the very
  // first run so freshly-loaded expansion state isn't wiped on initial
  // mount.
  const isFirstRangeEffect = useRef(true);
  useEffect(() => {
    if (isFirstRangeEffect.current) {
      isFirstRangeEffect.current = false;
      return;
    }
    setSortKey("spend");
    setSortDir("desc");
    setHideInactive(false);
    setSearch("");
    setExpanded({});
    clearAllCampaignPrefs();
    clearAllCampaignExpansions();
  }, [startDate, endDate]);

  // Persist expanded-campaign set so it survives reloads.
  useEffect(() => {
    saveExpandedCampaigns(expanded);
  }, [expanded]);

  const toggle = (id: number) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(prev => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortedCampaigns = useMemo(() => {
    if (!campaigns) return [];
    let filtered = hideInactive ? campaigns.filter(c => isActiveStatus(c.status)) : campaigns;
    const q = search.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter(c => (c.name || "").toLowerCase().includes(q));
    }
    const sign = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = (a[sortKey] as number) ?? 0;
      const bv = (b[sortKey] as number) ?? 0;
      return (av - bv) * sign;
    });
  }, [campaigns, sortKey, sortDir, hideInactive, search]);

  return (
    <PremiumCard className="p-6" transition={{ delay: 0.6 }}>
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-display text-xl text-white">Meta Campaign Performance</h3>
          <p className="text-muted-foreground text-sm">
            Click a campaign to expand its ad sets, then expand an ad set to see individual ads.
          </p>
        </div>
        {campaigns && campaigns.length > 0 && (
          <div className="flex items-center gap-4 flex-wrap">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search campaigns..."
              data-testid="search-campaigns"
              className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-muted-foreground focus:outline-none focus:border-white/30 w-48"
            />
            <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={hideInactive}
                onChange={(e) => setHideInactive(e.target.checked)}
                data-testid="hide-inactive-campaigns"
                className="accent-white"
              />
              <span>Hide paused/inactive</span>
            </label>
          </div>
        )}
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
                <th className="py-2 pr-4 font-medium text-right">
                  <SortHeader label="Spend" columnKey="spend" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} testIdPrefix="sort-campaign" />
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  <SortHeader label="Clicks" columnKey="clicks" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} testIdPrefix="sort-campaign" />
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  <SortHeader label="Conversions" columnKey="conversions" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} testIdPrefix="sort-campaign" />
                </th>
                <th className="py-2 pr-4 font-medium text-right">
                  <SortHeader label="CPL" columnKey="cpl" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} testIdPrefix="sort-campaign" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedCampaigns.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-muted-foreground italic text-xs">
                    No campaigns match the current filter.
                  </td>
                </tr>
              ) : sortedCampaigns.map(c => (
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

type SortHeaderProps = {
  label: string;
  columnKey: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  testIdPrefix?: string;
};

function SortHeader({ label, columnKey, sortKey, sortDir, onSort, testIdPrefix = "sort" }: SortHeaderProps) {
  const active = columnKey === sortKey;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onSort(columnKey); }}
      className={`inline-flex items-center gap-1 hover:text-white ${active ? "text-white" : ""}`}
      data-testid={`${testIdPrefix}-${columnKey}`}
    >
      <span>{label}</span>
      {active && (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
    </button>
  );
}

type CampaignViewPrefs = {
  sortKey: SortKey;
  sortDir: SortDir;
  hideInactive: boolean;
};

const DEFAULT_PREFS: CampaignViewPrefs = {
  sortKey: "spend",
  sortDir: "desc",
  hideInactive: false,
};

const PREFS_STORAGE_PREFIX = "marketing-os:meta-campaign-prefs:v1:";
const EXPANDED_CAMPAIGNS_STORAGE_KEY = "marketing-os:meta-campaign-expanded:v1";
const EXPANDED_SETS_STORAGE_PREFIX = "marketing-os:meta-campaign-expanded-sets:v1:";

function prefsStorageKey(campaignId: number): string {
  return `${PREFS_STORAGE_PREFIX}${campaignId}`;
}

function expandedSetsStorageKey(campaignId: number): string {
  return `${EXPANDED_SETS_STORAGE_PREFIX}${campaignId}`;
}

function loadExpandedCampaigns(): Record<number, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(EXPANDED_CAMPAIGNS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const out: Record<number, boolean> = {};
    for (const id of parsed) {
      if (typeof id === "number" && Number.isFinite(id)) out[id] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function saveExpandedCampaigns(expanded: Record<number, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    const ids = Object.entries(expanded)
      .filter(([, v]) => v)
      .map(([k]) => Number(k))
      .filter(n => Number.isFinite(n));
    if (ids.length === 0) {
      window.localStorage.removeItem(EXPANDED_CAMPAIGNS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(EXPANDED_CAMPAIGNS_STORAGE_KEY, JSON.stringify(ids));
    }
  } catch {
    // ignore
  }
}

function loadExpandedSets(campaignId: number): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(expandedSetsStorageKey(campaignId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const id of parsed) {
      if (typeof id === "string") out[id] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function saveExpandedSets(campaignId: number, expandedSets: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    const ids = Object.entries(expandedSets).filter(([, v]) => v).map(([k]) => k);
    if (ids.length === 0) {
      window.localStorage.removeItem(expandedSetsStorageKey(campaignId));
    } else {
      window.localStorage.setItem(expandedSetsStorageKey(campaignId), JSON.stringify(ids));
    }
  } catch {
    // ignore
  }
}

function clearAllCampaignExpansions(): void {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    storage.removeItem(EXPANDED_CAMPAIGNS_STORAGE_KEY);
    const toRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(EXPANDED_SETS_STORAGE_PREFIX)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      storage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

function isSortKey(v: unknown): v is SortKey {
  return v === "spend" || v === "clicks" || v === "conversions" || v === "cpl";
}

function isSortDir(v: unknown): v is SortDir {
  return v === "asc" || v === "desc";
}

function loadCampaignPrefs(campaignId: number): CampaignViewPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(prefsStorageKey(campaignId));
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<CampaignViewPrefs>;
    return {
      sortKey: isSortKey(parsed.sortKey) ? parsed.sortKey : DEFAULT_PREFS.sortKey,
      sortDir: isSortDir(parsed.sortDir) ? parsed.sortDir : DEFAULT_PREFS.sortDir,
      hideInactive: typeof parsed.hideInactive === "boolean" ? parsed.hideInactive : DEFAULT_PREFS.hideInactive,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function saveCampaignPrefs(campaignId: number, prefs: CampaignViewPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(prefsStorageKey(campaignId), JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode, quota, etc.) — silently ignore.
  }
}

function clearAllCampaignPrefs(): void {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    const toRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(PREFS_STORAGE_PREFIX)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      storage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

function CampaignBreakdown({ campaignId, startDate, endDate }: { campaignId: number; startDate: string; endDate: string }) {
  const { data, isLoading } = useGetMetaCampaignBreakdown(campaignId, { startDate, endDate });
  const [expandedSets, setExpandedSets] = useState<Record<string, boolean>>(() => loadExpandedSets(campaignId));
  const initialPrefs = useMemo(() => loadCampaignPrefs(campaignId), [campaignId]);
  const [sortKey, setSortKey] = useState<SortKey>(initialPrefs.sortKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialPrefs.sortDir);
  const [hideInactive, setHideInactive] = useState(initialPrefs.hideInactive);

  // Reset in-memory sort/filter state when the date range changes
  // (per-campaign). The parent component clears the persisted prefs across
  // all campaigns at the same time, so collapsed campaigns also start fresh
  // for the new range. Skip the first run so we don't wipe freshly-loaded
  // prefs on initial mount.
  const isFirstRangeEffect = useRef(true);
  useEffect(() => {
    if (isFirstRangeEffect.current) {
      isFirstRangeEffect.current = false;
      return;
    }
    setSortKey(DEFAULT_PREFS.sortKey);
    setSortDir(DEFAULT_PREFS.sortDir);
    setHideInactive(DEFAULT_PREFS.hideInactive);
    setExpandedSets({});
  }, [startDate, endDate, campaignId]);

  // Persist user choices so they survive collapsing/re-expanding and reloads.
  useEffect(() => {
    saveCampaignPrefs(campaignId, { sortKey, sortDir, hideInactive });
  }, [campaignId, sortKey, sortDir, hideInactive]);

  // Persist expanded ad-set IDs per campaign.
  useEffect(() => {
    saveExpandedSets(campaignId, expandedSets);
  }, [campaignId, expandedSets]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(prev => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortedSets = useMemo(() => {
    if (!data) return [];
    const filtered = hideInactive ? data.adSets.filter(s => isActiveStatus(s.status)) : data.adSets;
    const sign = sortDir === "asc" ? 1 : -1;
    const sorted = [...filtered].sort((a, b) => {
      const av = (a[sortKey] as number) ?? 0;
      const bv = (b[sortKey] as number) ?? 0;
      return (av - bv) * sign;
    });
    const adAccountId = data.adAccountId ?? null;
    return sorted.map(set => {
      const ads = (hideInactive ? set.ads.filter(ad => isActiveStatus(ad.status)) : set.ads).map(ad => ({ ...ad, adAccountId }));
      const sortedAds = [...ads].sort((a, b) => {
        const av = (a[sortKey] as number) ?? 0;
        const bv = (b[sortKey] as number) ?? 0;
        return (av - bv) * sign;
      });
      return { ...set, ads: sortedAds };
    });
  }, [data, sortKey, sortDir, hideInactive]);

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
      <tr className="bg-white/[0.02] border-b border-white/5">
        <td colSpan={6} className="py-2 pl-12 pr-4">
          <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="uppercase tracking-wider">Sort:</span>
              <SortHeader label="Spend" columnKey="spend" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Clicks" columnKey="clicks" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Conversions" columnKey="conversions" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="CPL" columnKey="cpl" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideInactive}
                onChange={(e) => setHideInactive(e.target.checked)}
                data-testid={`hide-inactive-${campaignId}`}
                className="accent-white"
              />
              <span>Hide paused/inactive</span>
            </label>
          </div>
        </td>
      </tr>
      {sortedSets.length === 0 ? (
        <tr>
          <td colSpan={6} className="py-4 pl-12 text-muted-foreground italic text-xs">
            No ad sets match the current filter.
          </td>
        </tr>
      ) : sortedSets.map(set => {
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
                  {hideInactive ? "No active ads with stats in this date range." : "No ads with stats in this date range."}
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
                  <div className="flex items-start gap-3">
                    <CreativeThumbnail ad={ad} />
                    <div className="min-w-0">
                      <div className="text-xs truncate">{ad.name || ad.externalId}</div>
                      {ad.status && (
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{ad.status}</div>
                      )}
                    </div>
                  </div>
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

type AdCreativeFields = {
  externalId: string;
  name?: string | null;
  creativeThumbnailUrl?: string | null;
  creativeTitle?: string | null;
  creativeBody?: string | null;
  adAccountId?: string | null;
};

function buildAdsManagerUrl(adAccountId: string, adExternalId: string): string {
  const act = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
  return `https://business.facebook.com/adsmanager/manage/ads?act=${encodeURIComponent(act)}&selected_ad_ids=${encodeURIComponent(adExternalId)}`;
}

function CreativeThumbnail({ ad }: { ad: AdCreativeFields }) {
  const [errored, setErrored] = useState(false);
  const hasThumb = !!ad.creativeThumbnailUrl && !errored;
  const hasDetails = !!(ad.creativeTitle || ad.creativeBody);

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="shrink-0 w-10 h-10 rounded-md overflow-hidden bg-white/5 border border-white/10 flex items-center justify-center cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/40"
          aria-label={`Preview creative for ${ad.name || ad.externalId}`}
          data-testid={`ad-creative-thumb-${ad.externalId}`}
          onClick={(e) => e.stopPropagation()}
        >
          {hasThumb ? (
            <img
              src={ad.creativeThumbnailUrl as string}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
              onError={() => setErrored(true)}
            />
          ) : (
            <ImageOff className="w-4 h-4 text-muted-foreground" aria-hidden />
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        className="w-72 bg-neutral-900 border-white/10 text-white"
        data-testid={`ad-creative-popover-${ad.externalId}`}
      >
        {hasThumb && (
          <img
            src={ad.creativeThumbnailUrl as string}
            alt=""
            className="w-full h-32 object-cover rounded mb-3"
          />
        )}
        {ad.creativeTitle && (
          <div className="text-sm font-semibold leading-snug mb-1">{ad.creativeTitle}</div>
        )}
        {ad.creativeBody ? (
          <div className="text-xs text-white/70 whitespace-pre-line line-clamp-6">{ad.creativeBody}</div>
        ) : !hasDetails ? (
          <div className="text-xs text-muted-foreground italic">No creative details available yet. They’ll appear after the next Meta sync.</div>
        ) : null}
        {ad.adAccountId && (
          <a
            href={buildAdsManagerUrl(ad.adAccountId, ad.externalId)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs text-white/80 hover:text-white underline-offset-2 hover:underline"
            data-testid={`ad-creative-open-ads-manager-${ad.externalId}`}
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="w-3 h-3" aria-hidden />
            Open in Ads Manager
          </a>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
