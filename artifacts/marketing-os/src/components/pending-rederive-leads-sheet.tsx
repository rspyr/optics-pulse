import { useEffect, useState } from "react";
import { Loader2, ExternalLink } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type PendingLead = {
  id: number;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  funnelId: number | null;
  leadType: string | null;
  serviceType: string | null;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: number;
  pageUrlPattern: string;
  formIdentifier: string;
  /**
   * Optional lead id to omit from the list — used by the inline-correction
   * surfaces in `attribution.tsx` so the lead the operator is already viewing
   * isn't echoed back as a "pending" hit.
   */
  excludeLeadId?: number | null;
};

function fmtName(l: PendingLead) {
  const name = `${l.firstName ?? ""} ${l.lastName ?? ""}`.trim();
  return name || `Lead #${l.id}`;
}

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Sheet that lists the historical leads still pending a re-derive for the
 * given rule scope. Opened from the "View pending leads" link on a re-derive
 * failure hint so operators can drill into which specific leads still need
 * updating after the back-fill fan-out failed.
 *
 * The list is server-filtered to the same (pageUrlPattern, formIdentifier)
 * scope and lookback window the fan-out itself would use, so what the
 * operator sees here is exactly the population a successful retry would touch.
 */
export function PendingRederiveLeadsSheet({
  open,
  onOpenChange,
  tenantId,
  pageUrlPattern,
  formIdentifier,
  excludeLeadId,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leads, setLeads] = useState<PendingLead[]>([]);
  const [hitLimit, setHitLimit] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      tenantId: String(tenantId),
      pageUrlPattern,
      formIdentifier,
    });
    if (excludeLeadId != null) params.set("excludeLeadId", String(excludeLeadId));
    fetch(`${API_BASE}/api/field-mapping-rules/pending-rederive-leads?${params.toString()}`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((d: { leads: PendingLead[]; hitLimit: boolean }) => {
        if (cancelled) return;
        setLeads(Array.isArray(d.leads) ? d.leads : []);
        setHitLimit(Boolean(d.hitLimit));
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message || "Failed to load pending leads");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, tenantId, pageUrlPattern, formIdentifier, excludeLeadId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md overflow-y-auto"
        data-testid="pending-rederive-leads-sheet"
      >
        <SheetHeader>
          <SheetTitle>Pending historical leads</SheetTitle>
          <SheetDescription>
            Leads matching{" "}
            <code className="text-white/80">{pageUrlPattern}</code>
            {formIdentifier !== "*" && (
              <> · <code className="text-white/80">{formIdentifier}</code></>
            )}{" "}
            that still need re-deriving.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-2">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="pending-leads-loading">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading pending leads…
            </div>
          )}
          {error && !loading && (
            <p className="text-xs text-red-400" data-testid="pending-leads-error">{error}</p>
          )}
          {!loading && !error && leads.length === 0 && (
            <p className="text-xs text-muted-foreground italic" data-testid="pending-leads-empty">
              No historical leads still need updating.
            </p>
          )}
          {!loading && !error && leads.length > 0 && (
            <>
              <p className="text-[11px] text-muted-foreground">
                {leads.length}{hitLimit ? "+" : ""} lead{leads.length === 1 ? "" : "s"} pending re-derive.
                {hitLimit && " Showing capped set."}
              </p>
              <ul className="space-y-1.5" data-testid="pending-leads-list">
                {leads.map((l) => (
                  <li
                    key={l.id}
                    className="border border-white/10 bg-white/[0.02] rounded-md px-2.5 py-2"
                    data-testid={`pending-lead-row-${l.id}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-white/90 truncate">{fmtName(l)}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {l.phone || l.email || "—"}
                          {l.createdAt && (
                            <span className="text-white/40"> · created {fmtRelative(l.createdAt)}</span>
                          )}
                        </p>
                      </div>
                      <a
                        href={`${API_BASE}/?leadId=${l.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 shrink-0"
                        data-testid={`pending-lead-link-${l.id}`}
                      >
                        View <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
