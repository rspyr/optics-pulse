import { useEffect, useState } from "react";
import { PremiumCard } from "@/components/ui-helpers";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

interface LegacyManualSourceBackfillStats {
  tenantId: number | null;
  migrationId: string;
  cutoffAt: string | null;
  computedAt: string;
  totalLegacyManualRows: number;
  stampedByFunnelOverride: number;
  stampedByFieldMappingRule: number;
  leftNullAmbiguous: number;
  skippedOverrideNoTemporalMatch: number;
  skippedRuleNoTemporalMatch: number;
}

interface Props {
  /** Active tenant scope. When null the card renders nothing so an unscoped
   *  agency view doesn't fetch a cross-tenant tally. */
  tenantId: number | null;
}

/**
 * Task #596 — surfaces the once-only `2026-05-20_backfill-attribution-event-
 * manual-source` migration's per-tenant tally so an operator can tell at a
 * glance whether the active tenant still has a hand-resolved ambiguous tail.
 * Hits the admin diagnostics endpoint which re-runs the heuristic read-only.
 */
export function LegacyManualSourceBackfillCard({ tenantId }: Props) {
  const [stats, setStats] = useState<LegacyManualSourceBackfillStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tenantId == null) { setStats(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/admin/legacy-manual-source-backfill?tenantId=${tenantId}`, {
      credentials: "include",
    })
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<LegacyManualSourceBackfillStats>;
      })
      .then(d => { if (!cancelled) setStats(d); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId]);

  if (tenantId == null) return null;
  if (loading && !stats) return null;
  if (error) {
    return (
      <PremiumCard className="p-3 text-xs text-amber-200/80 flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5" />
        <span>Couldn't load manual-attribution backfill stats: {error}</span>
      </PremiumCard>
    );
  }
  if (!stats || stats.totalLegacyManualRows === 0) return null;

  const stamped = stats.stampedByFunnelOverride + stats.stampedByFieldMappingRule;
  const allClean = stats.leftNullAmbiguous === 0;

  return (
    <PremiumCard className="p-4">
      <div className="flex items-start gap-3">
        {allClean ? (
          <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
        ) : (
          <Info className="w-4 h-4 mt-0.5 text-sky-300 shrink-0" />
        )}
        <div className="flex-1 space-y-1">
          <div className="text-sm font-medium text-white">
            Legacy manual-attribution backfill
          </div>
          <div className="text-xs text-muted-foreground">
            Of <span className="text-white">{stats.totalLegacyManualRows}</span> manual events
            from before the 2026-05-20 backfill,{" "}
            <span className="text-emerald-300">{stamped}</span> were auto-tagged
            (funnel override: <span className="text-white">{stats.stampedByFunnelOverride}</span>,
            field-mapping rule: <span className="text-white">{stats.stampedByFieldMappingRule}</span>)
            and{" "}
            <span className={allClean ? "text-emerald-300" : "text-amber-300"}>
              {stats.leftNullAmbiguous}
            </span>{" "}
            stayed ambiguous.
          </div>
          {!allClean && (
            <div className="text-[11px] text-muted-foreground">
              Of those ambiguous rows — override skipped on weak temporal evidence:{" "}
              <span className="text-white">{stats.skippedOverrideNoTemporalMatch}</span>;
              rule skipped on weak temporal evidence:{" "}
              <span className="text-white">{stats.skippedRuleNoTemporalMatch}</span>.
            </div>
          )}
        </div>
      </div>
    </PremiumCard>
  );
}
