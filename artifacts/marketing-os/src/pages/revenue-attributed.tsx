import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { useAuth } from "@/components/auth-context";
import { toast } from "sonner";
import {
  DollarSign, Loader2, ChevronDown, ChevronRight, ChevronLeft, ExternalLink,
  Tag, User, Link2, Pencil, Check, X, Download,
} from "lucide-react";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const PULSE_PATH = `${API_BASE}/pulse`;

// UI page size for the attributed-revenue list. The endpoint defaults to 200,
// so we request this many per page and offset by page * PAGE_SIZE to let users
// browse the full list instead of silently stopping at the first 200 rows.
const PAGE_SIZE = 200;

type DateRange = "last30" | "thisMonth" | "lastMonth" | "last7";

const VALID_RANGES: DateRange[] = ["last30", "thisMonth", "lastMonth", "last7"];

function initialRangeFromUrl(): DateRange {
  if (typeof window === "undefined") return "last30";
  const r = new URLSearchParams(window.location.search).get("range");
  return r && (VALID_RANGES as string[]).includes(r) ? (r as DateRange) : "last30";
}

// Funnel/source filters are persisted as single query params; absent → "all".
function initialFilterFromUrl(key: string): string {
  if (typeof window === "undefined") return "all";
  return new URLSearchParams(window.location.search).get(key) || "all";
}

// Match-level filter is multi-select, persisted as repeated `matchLevel` params.
function initialMatchLevelsFromUrl(): string[] {
  if (typeof window === "undefined") return [];
  return new URLSearchParams(window.location.search).getAll("matchLevel");
}

// Column sort is persisted as `sort` (key) + `dir` (direction); absent → the
// default "biggest corrected invoice first" (revenue/desc).
function initialSortKeyFromUrl(): SortKey {
  if (typeof window === "undefined") return "revenue";
  const s = new URLSearchParams(window.location.search).get("sort");
  return s && (VALID_SORT_KEYS as string[]).includes(s) ? (s as SortKey) : "revenue";
}

function initialSortDirFromUrl(): SortDir {
  if (typeof window === "undefined") return "desc";
  const d = new URLSearchParams(window.location.search).get("dir");
  return d === "asc" || d === "desc" ? d : "desc";
}

// Page is persisted 1-based in the URL (human-friendly) but tracked 0-based in
// state. Absent / invalid → first page.
function initialPageFromUrl(): number {
  if (typeof window === "undefined") return 0;
  const p = new URLSearchParams(window.location.search).get("page");
  const n = p != null ? Number(p) : NaN;
  return Number.isInteger(n) && n >= 1 ? n - 1 : 0;
}

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

type RebateItem = { label: string; amount: number };

// Sort keys the list supports — must match the server's sortExprByKey in
// drilldown.ts so the order is applied across the whole (paged) result set.
type SortKey = "revenue" | "date" | "customer" | "funnel" | "source";
type SortDir = "asc" | "desc";

type MatchTierBreakdown = {
  tier: string;
  revenue: number;
  count: number;
};

const VALID_SORT_KEYS: SortKey[] = ["revenue", "date", "customer", "funnel", "source"];

type RevenueSummary = {
  revenue: number;
  rebates: number;
  attributed: number;
  count: number;
  byMatchLevel?: MatchTierBreakdown[];
};

type LeadSummary = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  source: string | null;
  originalSource: string | null;
  status: string | null;
  hubStatus: string | null;
  funnel?: string | null;
};

type LeadSearchResult = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  status: string | null;
  createdAt: string;
};

export type RevenueJob = {
  id: number;
  tenantId: number;
  stJobId: string | null;
  stInvoiceId: string | null;
  // Portal-findable ServiceTitan job number. ServiceTitan has no separate
  // invoice number, so this doubles as the invoice number shown to clients.
  stJobNumber: string | null;
  customerName: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  serviceAddress?: string | null;
  jobType: string;
  jobTypeName: string | null;
  status: string;
  revenue: number;
  invoiceTotal: number | null;
  invoiceRebateAmount: number | null;
  correctedRevenue: number;
  invoiceDate: string | null;
  completedAt: string | null;
  createdAt: string;
  matchLevel: string | null;
  matchedGclid: string | null;
  funnel?: string | null;
  source?: string | null;
  rebateBreakdown: RebateItem[];
  soldByName: string | null;
  lead: LeadSummary | null;
};

// Resolve the display name for a job's customer. ServiceTitan invoices often
// omit the customer name even when the job is matched, so fall back to the
// matched lead's name (Task #727) before showing a dash.
function leadFullName(lead: LeadSummary | null | undefined): string {
  if (!lead) return "";
  return [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim();
}

function formatLeadAddress(lead: LeadSummary | null | undefined): string {
  if (!lead) return "";
  return [lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(", ");
}

function displayMatchLevel(level: string | null | undefined): string {
  const normalized = (level || "unmatched").trim().toLowerCase();
  if (normalized === "lead_funnel") return "Lead funnel";
  if (normalized === "gclid") return "GCLID";
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveCustomerName(job: RevenueJob): string {
  if (job.customerName && job.customerName.trim()) return job.customerName.trim();
  return leadFullName(job.lead);
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// Column order for the exported CSV. Kept as a constant so tests can locate the
// "Rebate Amount", "Corrected Revenue", and "Match Tier" columns by name and
// reconcile their totals against the summary cards (Task #703).
export const REVENUE_ATTRIBUTED_CSV_HEADER = [
  "Date", "Customer", "Funnel", "Job Type", "ST Job", "Match Tier",
  "Rebate Amount", "Corrected Revenue", "Lead Source", "Sold By",
] as const;

// Pure CSV builder for the Revenue Attributed export. Extracted from the
// download handler so the exact bytes the user downloads can be asserted in
// tests: the Corrected Revenue / Rebate Amount columns must sum to the same
// totals the summary cards show, and Match Tier drives which rows count toward
// attributed revenue. Kept side-effect-free (no Blob/anchor) for testability.
export function buildRevenueAttributedCsv(exportJobs: RevenueJob[]): string {
  const rows = exportJobs.map((job) => {
    const dateRaw = job.invoiceDate || job.completedAt || job.createdAt;
    const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString() : "";
    return [
      dateStr,
      resolveCustomerName(job),
      job.funnel || "",
      job.jobTypeName || job.jobType || "",
      job.stJobNumber || `#${job.id}`,
      job.matchLevel || "unmatched",
      String(job.invoiceRebateAmount ?? 0),
      String(job.correctedRevenue),
      job.lead?.source || job.source || "",
      job.soldByName || "",
    ];
  });
  return [REVENUE_ATTRIBUTED_CSV_HEADER as readonly string[], ...rows]
    .map((r) => r.map(csvCell).join(","))
    .join("\n");
}

function isUnknownSource(src: string | null | undefined): boolean {
  if (!src) return true;
  const s = src.trim().toLowerCase();
  return s === "" || s === "unknown";
}

export default function RevenueAttributed() {
  const { effectiveTenantId, isAgency } = useTenantFilter();
  const { user } = useAuth();
  const isClientReadOnly = !isAgency;

  // Agency/super-admin users browse across tenants, but the revenue endpoints
  // reject cross-tenant requests (400) when no client is selected. Gate the
  // fetches and show a friendly prompt instead of firing a doomed request.
  const needsClientSelection = isAgency && effectiveTenantId == null;
  const [dateRange, setDateRange] = useState<DateRange>(initialRangeFromUrl);
  const { startDate, endDate, label } = useMemo(() => getDateRange(dateRange), [dateRange]);

  const [jobs, setJobs] = useState<RevenueJob[] | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [summary, setSummary] = useState<RevenueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(initialPageFromUrl);

  // Filters on the originating lead's funnel/source. "all" = no filter. Options
  // come from the facets endpoint (every value in the range), so the dropdowns
  // stay complete even though the list itself is paged.
  const [funnelFilter, setFunnelFilter] = useState<string>(() => initialFilterFromUrl("funnel"));
  const [sourceFilter, setSourceFilter] = useState<string>(() => initialFilterFromUrl("source"));
  // Multi-select match-tier filter. Empty = no filter (show all tiers), mirroring
  // the "all" sentinel the funnel/source single-selects use.
  const [matchLevelFilter, setMatchLevelFilter] = useState<string[]>(initialMatchLevelsFromUrl);
  const [facets, setFacets] = useState<{ funnels: string[]; sources: string[]; matchLevels: string[] }>({
    funnels: [],
    sources: [],
    matchLevels: [],
  });

  // Sort state for the list. Mirrors the server's sort keys; default matches the
  // historical "biggest corrected invoice first".
  const [sortKey, setSortKey] = useState<SortKey>(initialSortKeyFromUrl);
  const [sortDir, setSortDir] = useState<SortDir>(initialSortDirFromUrl);

  // Reset to the first page whenever the date range, tenant, active filters, or
  // sort change, so a user on page 3 doesn't land on an out-of-bounds page.
  // Skip the very first render so a page number restored from the URL isn't
  // immediately clobbered back to 0 before the user changes anything.
  const skipPageReset = useRef(true);
  useEffect(() => {
    if (skipPageReset.current) {
      skipPageReset.current = false;
      return;
    }
    setPage(0);
  }, [startDate, endDate, effectiveTenantId, funnelFilter, sourceFilter, matchLevelFilter, sortKey, sortDir]);

  const loadJobs = useCallback(() => {
    let cancelled = false;
    if (needsClientSelection) {
      setJobs([]);
      setTotalCount(null);
      setError(null);
      return () => { cancelled = true; };
    }
    setJobs(null);
    setError(null);
    const params = new URLSearchParams({
      startDate,
      endDate,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
      sort: sortKey,
      dir: sortDir,
    });
    if (effectiveTenantId != null) params.set("tenantId", String(effectiveTenantId));
    if (funnelFilter !== "all") params.set("funnel", funnelFilter);
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    matchLevelFilter.forEach((m) => params.append("matchLevel", m));
    fetch(`${API_BASE}/api/drilldown/revenue-attributed?${params.toString()}`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`));
        const header = r.headers.get("X-Total-Count");
        const parsed = header != null ? Number(header) : NaN;
        return r.json().then((data: RevenueJob[]) => ({ data, total: Number.isFinite(parsed) ? parsed : null }));
      })
      .then(({ data, total }) => {
        if (!cancelled) { setJobs(data); setTotalCount(total); setExpandedId(null); }
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [startDate, endDate, effectiveTenantId, page, funnelFilter, sourceFilter, matchLevelFilter, sortKey, sortDir, needsClientSelection]);

  useEffect(() => loadJobs(), [loadJobs]);

  // Summary cards reflect the ENTIRE date range, not just the current page.
  // Totals are computed server-side over the full range so they stay stable as
  // the user pages through the list (page intentionally not a dependency).
  const loadSummary = useCallback(() => {
    let cancelled = false;
    setSummary(null);
    if (needsClientSelection) return () => { cancelled = true; };
    const params = new URLSearchParams({ startDate, endDate });
    if (effectiveTenantId != null) params.set("tenantId", String(effectiveTenantId));
    if (funnelFilter !== "all") params.set("funnel", funnelFilter);
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    matchLevelFilter.forEach((m) => params.append("matchLevel", m));
    fetch(`${API_BASE}/api/drilldown/revenue-attributed/summary?${params.toString()}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: RevenueSummary) => { if (!cancelled) setSummary(data); })
      .catch(() => { if (!cancelled) setSummary(null); });
    return () => { cancelled = true; };
  }, [startDate, endDate, effectiveTenantId, funnelFilter, sourceFilter, matchLevelFilter, needsClientSelection]);

  // Filter facets (distinct funnels + sources in the range) for the dropdowns.
  // Scoped only by tenant/date — NOT by the active funnel/source filters — so the
  // user can always pivot to another value without losing options.
  useEffect(() => {
    let cancelled = false;
    if (needsClientSelection) {
      setFacets({ funnels: [], sources: [], matchLevels: [] });
      return () => { cancelled = true; };
    }
    const params = new URLSearchParams({ startDate, endDate });
    if (effectiveTenantId != null) params.set("tenantId", String(effectiveTenantId));
    fetch(`${API_BASE}/api/drilldown/revenue-attributed/facets?${params.toString()}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { funnels?: string[]; sources?: string[]; matchLevels?: string[] }) => {
        if (cancelled) return;
        setFacets({ funnels: data.funnels ?? [], sources: data.sources ?? [], matchLevels: data.matchLevels ?? [] });
      })
      .catch(() => { if (!cancelled) setFacets({ funnels: [], sources: [], matchLevels: [] }); });
    return () => { cancelled = true; };
  }, [startDate, endDate, effectiveTenantId, needsClientSelection]);

  // If an active filter value disappears from the facets (e.g. after switching
  // date range), drop it so the list isn't stuck showing nothing. Each facet
  // list is only pruned once it has loaded (non-empty), so a filter pre-selected
  // from the URL isn't wiped during the initial render before facets arrive.
  useEffect(() => {
    if (facets.funnels.length > 0 && funnelFilter !== "all" && !facets.funnels.includes(funnelFilter)) {
      setFunnelFilter("all");
    }
    if (facets.sources.length > 0 && sourceFilter !== "all" && !facets.sources.includes(sourceFilter)) {
      setSourceFilter("all");
    }
    if (facets.matchLevels.length > 0) {
      setMatchLevelFilter((prev) => {
        const next = prev.filter((m) => facets.matchLevels.includes(m));
        return next.length === prev.length ? prev : next;
      });
    }
  }, [facets, funnelFilter, sourceFilter]);

  // Mirror the active range + filters into the URL query string so a filtered
  // view is bookmarkable/shareable and survives a refresh. replaceState keeps it
  // out of the back-stack (toggling filters shouldn't spam browser history).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.delete("range");
    params.delete("funnel");
    params.delete("source");
    params.delete("matchLevel");
    params.delete("sort");
    params.delete("dir");
    params.delete("page");
    if (dateRange !== "last30") params.set("range", dateRange);
    if (funnelFilter !== "all") params.set("funnel", funnelFilter);
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    matchLevelFilter.forEach((m) => params.append("matchLevel", m));
    if (sortKey !== "revenue") params.set("sort", sortKey);
    if (sortDir !== "desc") params.set("dir", sortDir);
    // Stored 1-based for humans; page 0 (default) is left implicit.
    if (page > 0) params.set("page", String(page + 1));
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", next);
  }, [dateRange, funnelFilter, sourceFilter, matchLevelFilter, sortKey, sortDir, page]);

  // Make the browser Back/Forward buttons restore the previous view. The
  // URL-writer above only uses replaceState, so the page itself never re-reads
  // the query string after a history pop — wire up popstate to pull the range,
  // filters, sort, and page back out of the URL. React 19 batches these state
  // updates into a single render, so arming the page-reset guard once keeps the
  // restored page from being knocked back to 0 by the reset effect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      skipPageReset.current = true;
      setDateRange(initialRangeFromUrl());
      setFunnelFilter(initialFilterFromUrl("funnel"));
      setSourceFilter(initialFilterFromUrl("source"));
      setMatchLevelFilter(initialMatchLevelsFromUrl());
      setSortKey(initialSortKeyFromUrl());
      setSortDir(initialSortDirFromUrl());
      setPage(initialPageFromUrl());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Toggle sort: clicking the active column flips direction; a new column starts
  // descending (largest/Z-A first), matching the default revenue view.
  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prevKey;
      }
      setSortDir("desc");
      return key;
    });
  }, []);

  useEffect(() => loadSummary(), [loadSummary]);

  // Reload both the visible page and the full-range summary after an edit (e.g.
  // a manual match or rebate change) so the cards and list stay in sync.
  const reload = useCallback(() => {
    loadJobs();
    loadSummary();
  }, [loadJobs, loadSummary]);

  // The endpoint returns the full matching count in the X-Total-Count header,
  // so we can show a real "X of N" indicator and disable Next on the true last
  // page even when that page happens to be full. If the header is missing for
  // any reason, fall back to inferring "there's more" from a full page.
  const totalPages = totalCount != null ? Math.max(1, Math.ceil(totalCount / PAGE_SIZE)) : null;
  const hasNextPage =
    totalCount != null
      ? page + 1 < (totalPages ?? 1)
      : jobs != null && jobs.length === PAGE_SIZE;
  const hasPrevPage = page > 0;

  async function handleExportCSV() {
    if (exporting) return;
    setExporting(true);
    try {
      // Fetch the full result set for the selected range directly, so the CSV
      // always includes every attributed job regardless of any UI paging/limit.
      const params = new URLSearchParams({ startDate, endDate, limit: "all", sort: sortKey, dir: sortDir });
      if (effectiveTenantId != null) params.set("tenantId", String(effectiveTenantId));
      if (funnelFilter !== "all") params.set("funnel", funnelFilter);
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      matchLevelFilter.forEach((m) => params.append("matchLevel", m));
      const res = await fetch(
        `${API_BASE}/api/drilldown/revenue-attributed?${params.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const exportJobs: RevenueJob[] = await res.json();
      if (exportJobs.length === 0) {
        toast.error("No jobs to export for this range.");
        return;
      }
      buildAndDownloadCSV(exportJobs);
      toast.success(`Exported ${exportJobs.length} jobs`);
    } catch (e) {
      toast.error(e instanceof Error ? `Export failed: ${e.message}` : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  function buildAndDownloadCSV(exportJobs: RevenueJob[]) {
    const csv = buildRevenueAttributedCsv(exportJobs);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `revenue-attributed-${startDate}-${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Revenue Attributed</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">
            ATTRIBUTED REVENUE BY JOB · REBATE-CORRECTED · {label.toUpperCase()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="last7">Last 7 Days</SelectItem>
              <SelectItem value="last30">Last 30 Days</SelectItem>
              <SelectItem value="thisMonth">This Month</SelectItem>
              <SelectItem value="lastMonth">Last Month</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={handleExportCSV}
            disabled={!jobs || jobs.length === 0 || exporting}
            className="gap-2"
          >
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {exporting ? "Exporting…" : "Download CSV"}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="Corrected Revenue" value={summary ? formatCurrency(summary.revenue) : "—"} icon={<DollarSign className="w-4 h-4" />} />
        <SummaryCard label="Attributed Revenue" value={summary ? formatCurrency(summary.attributed) : "—"} icon={<Link2 className="w-4 h-4" />} />
        <SummaryCard label="Rebate Add-Backs" value={summary ? formatCurrency(summary.rebates) : "—"} icon={<Tag className="w-4 h-4" />} />
        <SummaryCard label="Jobs" value={summary ? String(summary.count) : "—"} icon={<User className="w-4 h-4" />} />
      </div>

      {!needsClientSelection && summary && (
        summary.byMatchLevel && summary.byMatchLevel.length > 0 ? (
          <MatchTierBreakdownCard breakdown={summary.byMatchLevel} attributed={summary.attributed} />
        ) : (
          <MatchTierEmptyCard />
        )
      )}

      <PremiumCard className="p-0 overflow-hidden">
        <div className="p-5 border-b border-white/5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h3 className="font-display text-lg text-white">Revenue by Job</h3>
            <p className="text-muted-foreground text-sm mt-0.5">
              Completed ServiceTitan jobs. Expand a row for the rebate breakdown, originating lead, and how it was matched.
              {isClientReadOnly && " View only."}
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Funnel</span>
              <Select value={funnelFilter} onValueChange={setFunnelFilter}>
                <SelectTrigger className="h-9 w-44"><SelectValue placeholder="All funnels" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All funnels</SelectItem>
                  {facets.funnels.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Source</span>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="h-9 w-44"><SelectValue placeholder="All sources" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  {facets.sources.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Match Level</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-9 w-44 justify-between font-normal"
                    disabled={facets.matchLevels.length === 0}
                  >
                    <span className="truncate">
                      {matchLevelFilter.length === 0
                        ? "All match levels"
                        : matchLevelFilter.length === 1
                          ? displayMatchLevel(matchLevelFilter[0])
                          : `${matchLevelFilter.length} selected`}
                    </span>
                    <ChevronDown className="w-4 h-4 opacity-60 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  {facets.matchLevels.map((m) => (
                    <DropdownMenuCheckboxItem
                      key={m}
                      checked={matchLevelFilter.includes(m)}
                      onCheckedChange={(checked) =>
                        setMatchLevelFilter((prev) =>
                          checked ? [...prev, m] : prev.filter((x) => x !== m),
                        )
                      }
                      onSelect={(e) => e.preventDefault()}
                    >
                      {displayMatchLevel(m)}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {(funnelFilter !== "all" || sourceFilter !== "all" || matchLevelFilter.length > 0) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 self-end text-muted-foreground hover:text-white"
                onClick={() => { setFunnelFilter("all"); setSourceFilter("all"); setMatchLevelFilter([]); }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </div>

        {needsClientSelection ? (
          <div className="text-center text-muted-foreground py-10">Select a client to view revenue.</div>
        ) : error ? (
          <div className="text-center text-red-400 py-10">Failed to load: {error}</div>
        ) : jobs === null ? (
          <div className="text-center text-muted-foreground py-10 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading jobs…
          </div>
        ) : jobs.length === 0 ? (
          <div className="text-center text-muted-foreground py-10">
            No completed jobs{funnelFilter !== "all" || sourceFilter !== "all" || matchLevelFilter.length > 0 ? " match these filters" : " in this range"}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="p-4 w-8" />
                  <SortableTh label="Date" sortKey="date" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Customer" sortKey="customer" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Funnel" sortKey="funnel" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortableTh label="Source" sortKey="source" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Job Type</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">ST Job</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Match</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Rebates</th>
                  <SortableTh label="Revenue" sortKey="revenue" activeKey={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {jobs.map((job) => {
                  const dateRaw = job.invoiceDate || job.completedAt || job.createdAt;
                  const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString() : "—";
                  const isExpanded = expandedId === job.id;
                  return (
                    <Fragment key={job.id}>
                      <tr
                        className="hover:bg-white/[0.02] cursor-pointer"
                        onClick={() => setExpandedId(isExpanded ? null : job.id)}
                      >
                        <td className="p-4 text-muted-foreground">
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </td>
                        <td className="p-4 text-sm text-muted-foreground whitespace-nowrap">{dateStr}</td>
                        <td className="p-4 text-sm text-white">{resolveCustomerName(job) || "—"}</td>
                        <td className="p-4 text-sm text-muted-foreground">{job.funnel || "—"}</td>
                        <td className="p-4 text-sm text-muted-foreground">{job.source || job.lead?.source || "—"}</td>
                        <td className="p-4 text-sm text-muted-foreground">{job.jobTypeName || job.jobType || "—"}</td>
                        <td className="p-4 text-sm text-muted-foreground font-mono">{job.stJobNumber || `#${job.id}`}</td>
                        <td className="p-4 text-sm">
                          {job.matchLevel ? (
                            <span className="text-xs text-ice/80">{displayMatchLevel(job.matchLevel)}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground/50">unmatched</span>
                          )}
                        </td>
                        <td className="p-4 text-sm text-right text-amber-300/90 font-display">
                          {job.invoiceRebateAmount ? formatCurrency(job.invoiceRebateAmount) : "—"}
                        </td>
                        <td className="p-4 text-sm text-emerald-400 text-right font-display">{formatCurrency(job.correctedRevenue)}</td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${job.id}-detail`} className="bg-white/[0.015]">
                          <td colSpan={10} className="p-5">
                            <JobDetail
                              job={job}
                              isClientReadOnly={isClientReadOnly}
                              currentUserRole={user?.role}
                              onChanged={reload}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {jobs != null && !error && (hasPrevPage || hasNextPage) && (
          <div className="flex items-center justify-between gap-4 p-4 border-t border-white/5">
            <span className="text-xs text-muted-foreground">
              {jobs.length > 0
                ? `Showing ${(page * PAGE_SIZE + 1).toLocaleString()}–${(page * PAGE_SIZE + jobs.length).toLocaleString()}${
                    totalCount != null ? ` of ${totalCount.toLocaleString()} jobs` : ""
                  }${totalPages != null ? ` · Page ${page + 1} of ${totalPages.toLocaleString()}` : ""}`
                : "No jobs on this page"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={!hasPrevPage}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="w-4 h-4" /> Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={!hasNextPage}
                onClick={() => setPage((p) => p + 1)}
              >
                Next <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

function SummaryCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <PremiumCard className="p-4">
      <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider mb-2">
        {icon}{label}
      </div>
      <div className="font-display text-2xl text-white">{value}</div>
    </PremiumCard>
  );
}

// Accent colours for the match-tier bars, strongest → weakest. "unmatched" is
// intentionally muted so it reads as "not attributed" at a glance.
const TIER_BAR_COLORS: Record<string, string> = {
  diamond: "bg-cyan-300",
  golden: "bg-amber-300",
  silver: "bg-slate-300",
  bronze: "bg-orange-400",
  gclid: "bg-cyan-300",
  manual: "bg-violet-300",
  lead_funnel: "bg-emerald-300",
  unmatched: "bg-white/15",
};

function tierLabel(tier: string): string {
  return displayMatchLevel(tier);
}

// "Revenue by match tier" breakdown: corrected revenue + job count per tier for
// the current range/filters. The non-"unmatched" rows sum to the Attributed
// Revenue card (the breakdown is computed from the same filtered set server-side),
// so the footnote can call that reconciliation out explicitly.
function MatchTierBreakdownCard({
  breakdown,
  attributed,
}: {
  breakdown: MatchTierBreakdown[];
  attributed: number;
}) {
  // Scale each bar against the largest tier's revenue so the longest bar fills
  // the track. Guard against an all-zero range (no division by zero).
  const maxRevenue = Math.max(0, ...breakdown.map((b) => b.revenue));
  return (
    <PremiumCard className="p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider">
          <Link2 className="w-4 h-4" /> Revenue by Match Tier
        </div>
        <span className="text-[11px] text-muted-foreground/70">Corrected revenue · job count</span>
      </div>
      <div className="space-y-2.5">
        {breakdown.map((b) => {
          const pct = maxRevenue > 0 ? Math.max(2, (b.revenue / maxRevenue) * 100) : 0;
          const color = TIER_BAR_COLORS[b.tier] ?? "bg-ice/40";
          return (
            <div key={b.tier} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-xs text-white/90">{tierLabel(b.tier)}</span>
              <div className="flex-1 h-2 rounded-full bg-white/[0.04] overflow-hidden">
                <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="w-28 shrink-0 text-right text-sm font-display text-white tabular-nums">
                {formatCurrency(b.revenue)}
              </span>
              <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {b.count} {b.count === 1 ? "job" : "jobs"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground/70 mt-4">
        Non-unmatched tiers sum to Attributed Revenue ({formatCurrency(attributed)}).
      </p>
    </PremiumCard>
  );
}

// Shown in place of the breakdown when the summary loaded but has no match-tier
// data for the selected range/filters. Keeps the same header so the section
// reads as intentionally empty rather than missing.
function MatchTierEmptyCard() {
  return (
    <PremiumCard className="p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider">
          <Link2 className="w-4 h-4" /> Revenue by Match Tier
        </div>
        <span className="text-[11px] text-muted-foreground/70">Corrected revenue · job count</span>
      </div>
      <p className="text-sm text-muted-foreground py-4 text-center">
        No attributed revenue in this range.
      </p>
    </PremiumCard>
  );
}

// Clickable column header that drives server-side sorting. Shows an arrow on the
// active column indicating direction; clicking the active column flips it.
function SortableTh({
  label, sortKey, activeKey, dir, onSort, align = "left",
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = activeKey === sortKey;
  return (
    <th className={`p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider ${align === "right" ? "text-right" : ""}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-white transition-colors ${active ? "text-white" : ""}`}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <span className={`text-[10px] ${active ? "opacity-100" : "opacity-30"}`}>
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

// Maps a stored match level to a plain-language explanation of HOW the job was
// matched to a marketing touchpoint, plus which ServiceTitan field bridged it.
const MATCH_EXPLANATIONS: Record<string, { title: string; detail: string }> = {
  diamond: { title: "Matched by Google Click ID (GCLID)", detail: "Highest confidence — the click that drove this job was tracked end-to-end." },
  golden: { title: "Matched by phone number", detail: "The ServiceTitan phone matched a Pulse lead phone. The lead source can still be Unknown." },
  silver: { title: "Matched by email address", detail: "The ServiceTitan email matched a Pulse lead email. The lead source can still be Unknown." },
  bronze: { title: "Matched by service address", detail: "The service address on the invoice matched a tracked lead's address." },
  manual: { title: "Manually matched", detail: "An operator linked this job to the lead by hand." },
  lead_funnel: { title: "Attributed by linked Pulse lead", detail: "The job is linked to a Pulse lead with a known marketing funnel, but no stronger click, phone, email, or address proof was available." },
  unmatched: { title: "Not matched", detail: "No marketing touchpoint could be linked to this job yet." },
};

// Legacy/alternate match-level values map onto the canonical tiers so the
// explanation text stays accurate for older rows (e.g. "gclid" === diamond).
const MATCH_LEVEL_ALIASES: Record<string, string> = {
  gclid: "diamond",
  phone: "golden",
  email: "silver",
  address: "bronze",
};

// "How this was matched" panel: spells out the match method in plain language
// and shows, side by side, what came from ServiceTitan (the invoice) vs. what
// came from Optics/Pulse (the tracked lead/attribution) so the link is auditable.
function MatchExplanation({ job }: { job: RevenueJob }) {
  const rawLevel = job.matchLevel ?? "unmatched";
  const level = MATCH_LEVEL_ALIASES[rawLevel] ?? rawLevel;
  const explanation = MATCH_EXPLANATIONS[level] ?? MATCH_EXPLANATIONS.unmatched;
  const lead = job.lead;
  const leadName = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(" ") || `Lead #${lead.id}` : null;
  const leadAddress = formatLeadAddress(lead);
  const comparedLeadPhone = lead?.phone || (lead ? job.customerPhone : undefined);
  const comparedLeadEmail = lead?.email || (lead ? job.customerEmail : undefined);
  const comparedLeadAddress = leadAddress || (lead ? job.serviceAddress : undefined);

  const stRows: [string, string | null | undefined][] = [
    ["Customer name", job.customerName],
    ["Phone", job.customerPhone],
    ["Email", job.customerEmail],
    ["Service address", job.serviceAddress],
    // ServiceTitan has no invoice number — the job number is the portal-findable
    // identifier and serves as the invoice number. The internal stInvoiceId is
    // an opaque API id (not searchable in the portal), so it is no longer shown.
    ["Job / Invoice #", job.stJobNumber],
  ];
  const opticsRows: [string, string | null | undefined][] = [
    ["Matched lead", leadName],
    ["Lead phone", comparedLeadPhone],
    ["Lead email", comparedLeadEmail],
    ["Lead address", comparedLeadAddress],
    ["Lead source", job.source ?? lead?.source],
    ["Funnel", job.funnel],
    ["Matched GCLID", job.matchedGclid],
  ];

  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.015] p-4">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
        <Link2 className="w-3.5 h-3.5" /> How This Was Matched
      </h4>
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-xs px-2 py-0.5 rounded-full border ${job.matchLevel ? "border-ice/30 text-ice/90" : "border-white/10 text-muted-foreground/60"}`}>
          {displayMatchLevel(level)}
        </span>
        <span className="text-sm text-white">{explanation.title}</span>
      </div>
      <p className="text-xs text-muted-foreground/80 mb-4">{explanation.detail}</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-2">From ServiceTitan (invoice)</div>
          <div className="space-y-1.5">
            {stRows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <span className="text-muted-foreground shrink-0">{k}</span>
                <span className="text-white/90 text-right break-all">{v && String(v).trim() ? v : "—"}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-2">From Optics / Pulse (tracked lead)</div>
          {lead || job.matchedGclid ? (
            <div className="space-y-1.5">
              {opticsRows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <span className="text-muted-foreground shrink-0">{k}</span>
                  <span className="text-white/90 text-right break-all">{v && String(v).trim() ? v : "—"}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground/60 text-xs">
              No tracked lead is linked, so there's nothing from Optics/Pulse to compare against yet.
            </p>
          )}
        </div>
      </div>
      {!job.customerName?.trim() && leadName && (
        <p className="text-[11px] text-muted-foreground/60 mt-3">
          ServiceTitan didn't include a customer name on this invoice, so the Customer column shows the matched lead's name ({leadName}).
        </p>
      )}
    </div>
  );
}

function JobDetail({
  job, isClientReadOnly, currentUserRole, onChanged,
}: {
  job: RevenueJob;
  isClientReadOnly: boolean;
  currentUserRole?: string;
  onChanged: () => void;
}) {
  const lead = job.lead;
  const leadName = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(" ") || `Lead #${lead.id}` : null;
  const reportedTotal = job.invoiceTotal ?? job.revenue;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Revenue + rebate breakdown */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
          <Tag className="w-3.5 h-3.5" /> Rebate Breakdown
        </h4>
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Reported total</span>
            <span className="text-white font-mono">{formatCurrency(reportedTotal)}</span>
          </div>
          {job.rebateBreakdown.length > 0 ? (
            job.rebateBreakdown.map((item, i) => (
              <div key={i} className="flex justify-between">
                <span className="text-muted-foreground pl-3">+ {item.label}</span>
                <span className="text-amber-300/90 font-mono">{formatCurrency(item.amount)}</span>
              </div>
            ))
          ) : (job.invoiceRebateAmount ?? 0) > 0 ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground pl-3">+ Rebate add-backs</span>
              <span className="text-amber-300/90 font-mono">{formatCurrency(job.invoiceRebateAmount ?? 0)}</span>
            </div>
          ) : (
            <div className="text-muted-foreground/60 text-xs pl-3">No rebate line items.</div>
          )}
          <div className="flex justify-between border-t border-white/10 pt-1.5 mt-1.5">
            <span className="text-white">Corrected revenue</span>
            <span className="text-emerald-400 font-display">{formatCurrency(job.correctedRevenue)}</span>
          </div>
        </div>
      </div>

      {/* Originating lead */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
          <User className="w-3.5 h-3.5" /> Originating Lead
        </h4>
        {lead ? (
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Lead</span><span className="text-white">{leadName}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Source</span><span className="text-white">{lead.source || "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Original source</span><span className="text-white/70">{lead.originalSource || "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Sold by</span><span className="text-white">{job.soldByName || "—"}</span></div>
            <a
              href={`${PULSE_PATH}?leadId=${lead.id}`}
              className="inline-flex items-center gap-1.5 text-ice/80 hover:text-ice text-xs mt-2"
            >
              Open lead trace in Pulse <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        ) : (
          <div className="text-muted-foreground/60 text-sm">
            No lead linked to this job.
            {isClientReadOnly ? "" : " Use the controls to manually match it."}
          </div>
        )}
      </div>

      {/* Agency-only audit / edit controls */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
          <Link2 className="w-3.5 h-3.5" /> Attribution Controls
        </h4>
        {isClientReadOnly ? (
          <p className="text-muted-foreground/60 text-sm">Attribution edits are managed by your agency.</p>
        ) : (
          <AgencyControls job={job} currentUserRole={currentUserRole} onChanged={onChanged} />
        )}
      </div>
      </div>

      <MatchExplanation job={job} />
    </div>
  );
}

function AgencyControls({
  job, currentUserRole, onChanged,
}: {
  job: RevenueJob;
  currentUserRole?: string;
  onChanged: () => void;
}) {
  const lead = job.lead;
  const [editingSource, setEditingSource] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [newSource, setNewSource] = useState("");
  const [savingSource, setSavingSource] = useState(false);

  const [matching, setMatching] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<LeadSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const canEditSource = lead != null && isUnknownSource(lead.originalSource);

  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      setSearchError(false);
      return;
    }
    setSearching(true);
    setSearchError(false);
    let cancelled = false;
    const handle = setTimeout(() => {
      const params = new URLSearchParams({ q, tenantId: String(job.tenantId) });
      fetch(`${API_BASE}/api/drilldown/leads/search?${params.toString()}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((data: LeadSearchResult[]) => {
          if (cancelled) return;
          setResults(data);
          setSearchError(false);
          setShowResults(true);
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setSearchError(true);
          setShowResults(true);
        })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [searchQuery, job.tenantId, retryNonce]);

  useEffect(() => {
    if (!editingSource) return;
    fetch(`${API_BASE}/api/leads-hub/canonical-sources`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { sources: [] }))
      .then((d) => setSources(d.sources || []))
      .catch(() => setSources([]));
  }, [editingSource]);

  const saveSource = async () => {
    if (!lead || !newSource.trim()) return;
    setSavingSource(true);
    try {
      const r = await fetch(`${API_BASE}/api/leads-hub/${lead.id}/source`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ source: newSource.trim() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      toast.success("Lead source updated");
      setEditingSource(false);
      setNewSource("");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update source");
    } finally {
      setSavingSource(false);
    }
  };

  const matchToLead = async (leadId: number) => {
    setMatching(true);
    try {
      const r = await fetch(`${API_BASE}/api/drilldown/jobs/${job.id}/lead`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ leadId }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      toast.success("Job matched to lead");
      setSearchQuery("");
      setResults([]);
      setShowResults(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to match job");
    } finally {
      setMatching(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {/* Source edit */}
      {lead && (
        <div>
          <div className="text-muted-foreground text-xs mb-1.5">Lead source</div>
          {editingSource ? (
            <div className="flex items-center gap-2">
              <Select value={newSource} onValueChange={setNewSource}>
                <SelectTrigger className="h-8 w-40"><SelectValue placeholder="Select source" /></SelectTrigger>
                <SelectContent>
                  {sources.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" className="h-8 px-2" disabled={savingSource || !newSource} onClick={saveSource}>
                {savingSource ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              </Button>
              <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => { setEditingSource(false); setNewSource(""); }}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-white">{lead.source || "—"}</span>
              {canEditSource && (
                <button onClick={() => setEditingSource(true)} className="text-ice/70 hover:text-ice" title="Edit source">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          {!canEditSource && (
            <p className="text-muted-foreground/50 text-xs mt-1">Source editable only when original source is Unknown.</p>
          )}
        </div>
      )}

      {/* Manual match */}
      <div>
        <div className="text-muted-foreground text-xs mb-1.5">{lead ? "Re-match to a different lead" : "Manually match to a lead"}</div>
        <div className="relative">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => { if (results.length > 0) setShowResults(true); }}
            placeholder="Search by name, phone, or email"
            className="h-8"
            disabled={matching}
          />
          {searching && (
            <Loader2 className="w-3.5 h-3.5 animate-spin absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          )}
          {showResults && searchQuery.trim().length >= 2 && (
            <div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-md border border-white/10 bg-[#0d1117] shadow-xl">
              {results.length === 0 ? (
                <div className={`px-3 py-2.5 text-xs ${searchError && !searching ? "text-red-400/80" : "text-muted-foreground/60"}`}>
                  {searching ? (
                    "Searching…"
                  ) : searchError ? (
                    <div className="flex items-center justify-between gap-2">
                      <span>Search failed. Please try again.</span>
                      <button
                        type="button"
                        onClick={() => setRetryNonce((n) => n + 1)}
                        className="text-ice/80 hover:text-ice underline underline-offset-2 shrink-0"
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    "No matching leads."
                  )}
                </div>
              ) : (
                results.map((r) => {
                  const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || `Lead #${r.id}`;
                  const contact = [r.phone, r.email].filter(Boolean).join(" · ");
                  return (
                    <button
                      key={r.id}
                      type="button"
                      disabled={matching}
                      onClick={() => matchToLead(r.id)}
                      className="w-full text-left px-3 py-2 hover:bg-white/[0.04] disabled:opacity-50 border-b border-white/5 last:border-b-0"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-white truncate">{name}</span>
                        <span className="text-[10px] text-muted-foreground/60 font-mono shrink-0">#{r.id}</span>
                      </div>
                      {contact && <div className="text-xs text-muted-foreground truncate">{contact}</div>}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
        <p className="text-muted-foreground/50 text-xs mt-1">
          {matching ? "Matching…" : "Search and pick a lead to set the job's attribution to manual."}
        </p>
      </div>
    </div>
  );
}
