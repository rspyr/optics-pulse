import { useState, useMemo, useEffect, useCallback, Fragment } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { useTenantFilter } from "@/hooks/use-tenant-filter";
import { useAuth } from "@/components/auth-context";
import { toast } from "sonner";
import {
  DollarSign, Loader2, ChevronDown, ChevronRight, ExternalLink,
  Tag, User, Link2, Pencil, Check, X, Download,
} from "lucide-react";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const PULSE_PATH = `${API_BASE}/pulse`;

type DateRange = "last30" | "thisMonth" | "lastMonth" | "last7";

const VALID_RANGES: DateRange[] = ["last30", "thisMonth", "lastMonth", "last7"];

function initialRangeFromUrl(): DateRange {
  if (typeof window === "undefined") return "last30";
  const r = new URLSearchParams(window.location.search).get("range");
  return r && (VALID_RANGES as string[]).includes(r) ? (r as DateRange) : "last30";
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

type LeadSummary = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  source: string | null;
  originalSource: string | null;
  status: string | null;
  hubStatus: string | null;
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

type RevenueJob = {
  id: number;
  tenantId: number;
  stJobId: string | null;
  stInvoiceId: string | null;
  customerName: string | null;
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
  rebateBreakdown: RebateItem[];
  soldByName: string | null;
  lead: LeadSummary | null;
};

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
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
  const [dateRange, setDateRange] = useState<DateRange>(initialRangeFromUrl);
  const { startDate, endDate, label } = useMemo(() => getDateRange(dateRange), [dateRange]);

  const [jobs, setJobs] = useState<RevenueJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadJobs = useCallback(() => {
    let cancelled = false;
    setJobs(null);
    setError(null);
    const params = new URLSearchParams({ startDate, endDate });
    if (effectiveTenantId != null) params.set("tenantId", String(effectiveTenantId));
    fetch(`${API_BASE}/api/drilldown/revenue-attributed?${params.toString()}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: RevenueJob[]) => { if (!cancelled) setJobs(data); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [startDate, endDate, effectiveTenantId]);

  useEffect(() => loadJobs(), [loadJobs]);

  const totals = useMemo(() => {
    if (!jobs) return { revenue: 0, rebates: 0, attributed: 0, count: 0 };
    let revenue = 0, rebates = 0, attributed = 0;
    for (const j of jobs) {
      revenue += j.correctedRevenue;
      rebates += j.invoiceRebateAmount ?? 0;
      if (j.matchLevel) attributed += j.correctedRevenue;
    }
    return { revenue, rebates, attributed, count: jobs.length };
  }, [jobs]);

  function handleExportCSV() {
    if (!jobs || jobs.length === 0) return;
    const header = [
      "Date", "Customer", "Job Type", "ST Job", "Match Tier",
      "Rebate Amount", "Corrected Revenue", "Lead Source", "Sold By",
    ];
    const rows = jobs.map((job) => {
      const dateRaw = job.invoiceDate || job.completedAt || job.createdAt;
      const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString() : "";
      return [
        dateStr,
        job.customerName || "",
        job.jobTypeName || job.jobType || "",
        job.stJobId || `#${job.id}`,
        job.matchLevel || "unmatched",
        String(job.invoiceRebateAmount ?? 0),
        String(job.correctedRevenue),
        job.lead?.source || "",
        job.soldByName || "",
      ];
    });
    const csv = [header, ...rows]
      .map((r) => r.map(csvCell).join(","))
      .join("\n");
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
            disabled={!jobs || jobs.length === 0}
            className="gap-2"
          >
            <Download className="w-4 h-4" /> Download CSV
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="Corrected Revenue" value={formatCurrency(totals.revenue)} icon={<DollarSign className="w-4 h-4" />} />
        <SummaryCard label="Attributed Revenue" value={formatCurrency(totals.attributed)} icon={<Link2 className="w-4 h-4" />} />
        <SummaryCard label="Rebate Add-Backs" value={formatCurrency(totals.rebates)} icon={<Tag className="w-4 h-4" />} />
        <SummaryCard label="Jobs" value={String(totals.count)} icon={<User className="w-4 h-4" />} />
      </div>

      <PremiumCard className="p-0 overflow-hidden">
        <div className="p-5 border-b border-white/5">
          <h3 className="font-display text-lg text-white">Revenue by Job</h3>
          <p className="text-muted-foreground text-sm mt-0.5">
            Completed ServiceTitan jobs, biggest corrected invoice first. Expand a row for the rebate breakdown and originating lead.
            {isClientReadOnly && " View only."}
          </p>
        </div>

        {error ? (
          <div className="text-center text-red-400 py-10">Failed to load: {error}</div>
        ) : jobs === null ? (
          <div className="text-center text-muted-foreground py-10 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading jobs…
          </div>
        ) : jobs.length === 0 ? (
          <div className="text-center text-muted-foreground py-10">No completed jobs in this range.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="p-4 w-8" />
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Job Type</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">ST Job</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Match</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Rebates</th>
                  <th className="p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Revenue</th>
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
                        <td className="p-4 text-sm text-white">{job.customerName || "—"}</td>
                        <td className="p-4 text-sm text-muted-foreground">{job.jobTypeName || job.jobType || "—"}</td>
                        <td className="p-4 text-sm text-muted-foreground font-mono">{job.stJobId || `#${job.id}`}</td>
                        <td className="p-4 text-sm">
                          {job.matchLevel ? (
                            <span className="text-xs text-ice/80 capitalize">{job.matchLevel}</span>
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
                          <td colSpan={8} className="p-5">
                            <JobDetail
                              job={job}
                              isClientReadOnly={isClientReadOnly}
                              currentUserRole={user?.role}
                              onChanged={loadJobs}
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

  const canEditSource = lead != null && isUnknownSource(lead.originalSource);

  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const handle = setTimeout(() => {
      const params = new URLSearchParams({ q, tenantId: String(job.tenantId) });
      fetch(`${API_BASE}/api/drilldown/leads/search?${params.toString()}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((data: LeadSearchResult[]) => {
          if (cancelled) return;
          setResults(data);
          setShowResults(true);
        })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [searchQuery, job.tenantId]);

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
                <div className="px-3 py-2.5 text-xs text-muted-foreground/60">
                  {searching ? "Searching…" : "No matching leads."}
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
