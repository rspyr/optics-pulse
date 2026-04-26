import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Check } from "lucide-react";
import {
  MAP_TO_OPTIONS,
  normalizeFieldName,
  suggestMapTarget,
  type LearnedSuggestions,
  type MapToTarget,
} from "@/lib/field-mapping-heuristic";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export interface UnmatchedFieldsPanelEvent {
  tenantId: number;
  pageUrl: string | null;
  formId: string | null;
  formName: string | null;
  fieldNames?: string[] | null;
  unmatchedReason?: string | null;
}

export { MAP_TO_OPTIONS, type MapToTarget };

export function deriveMappingScope(
  evt: Pick<UnmatchedFieldsPanelEvent, "pageUrl" | "formId" | "formName">,
): { pageUrlPattern: string; formIdentifier: string } {
  let pageUrlPattern = "*";
  if (evt.pageUrl) {
    try { pageUrlPattern = new URL(evt.pageUrl).pathname || "*"; } catch { /* keep "*" */ }
  }
  const formIdentifier = (evt.formId && evt.formId.trim()) || (evt.formName && evt.formName.trim()) || "*";
  return { pageUrlPattern, formIdentifier };
}

// Module-level cache of confirmed field-name → mapsTo suggestions per tenant.
// Populated lazily the first time a panel for that tenant is expanded; updated
// whenever an operator saves a new mapping. Subscribers are notified so all
// panels for the same tenant re-render together. Exported for tests.
type LearnedMap = Map<string, MapToTarget>;
const learnedSuggestionsByTenant = new Map<number, LearnedMap>();
const learnedFetchInflight = new Map<number, Promise<LearnedMap>>();
const learnedSubscribers = new Map<number, Set<() => void>>();

export function __resetLearnedSuggestionsCacheForTests() {
  learnedSuggestionsByTenant.clear();
  learnedFetchInflight.clear();
  learnedSubscribers.clear();
}

function notifyLearnedSubscribers(tenantId: number) {
  const subs = learnedSubscribers.get(tenantId);
  if (!subs) return;
  for (const fn of subs) fn();
}

async function fetchLearnedSuggestions(tenantId: number): Promise<LearnedMap> {
  const cached = learnedSuggestionsByTenant.get(tenantId);
  if (cached) return cached;
  const inflight = learnedFetchInflight.get(tenantId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const res = await fetch(
        `${API_BASE}/api/field-mapping-rules/suggestions?tenantId=${tenantId}`,
        { credentials: "include" },
      );
      if (!res || !res.ok) {
        const empty = new Map<string, MapToTarget>();
        learnedSuggestionsByTenant.set(tenantId, empty);
        notifyLearnedSubscribers(tenantId);
        return empty;
      }
      const data = (await res.json().catch(() => ({}))) as {
        suggestions?: Record<string, string>;
      };
      const map = new Map<string, MapToTarget>();
      const suggestions = data.suggestions || {};
      for (const [k, v] of Object.entries(suggestions)) {
        map.set(k, v as MapToTarget);
      }
      learnedSuggestionsByTenant.set(tenantId, map);
      notifyLearnedSubscribers(tenantId);
      return map;
    } catch {
      const empty = new Map<string, MapToTarget>();
      learnedSuggestionsByTenant.set(tenantId, empty);
      notifyLearnedSubscribers(tenantId);
      return empty;
    } finally {
      learnedFetchInflight.delete(tenantId);
    }
  })();

  learnedFetchInflight.set(tenantId, promise);
  return promise;
}

function recordLearnedSuggestion(tenantId: number, fieldName: string, mapsTo: MapToTarget) {
  let map = learnedSuggestionsByTenant.get(tenantId);
  if (!map) {
    map = new Map();
    learnedSuggestionsByTenant.set(tenantId, map);
  }
  map.set(normalizeFieldName(fieldName), mapsTo);
  notifyLearnedSubscribers(tenantId);
}

function useTenantLearnedSuggestions(tenantId: number, enabled: boolean): LearnedSuggestions {
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let subs = learnedSubscribers.get(tenantId);
    if (!subs) {
      subs = new Set();
      learnedSubscribers.set(tenantId, subs);
    }
    const trigger = () => {
      if (!cancelled) setVersion((v) => v + 1);
    };
    subs.add(trigger);

    if (!learnedSuggestionsByTenant.has(tenantId)) {
      void fetchLearnedSuggestions(tenantId);
    }

    return () => {
      cancelled = true;
      subs?.delete(trigger);
    };
  }, [tenantId, enabled]);

  return learnedSuggestionsByTenant.get(tenantId) ?? new Map();
}

export function UnmatchedFieldsPanel({ evt }: { evt: UnmatchedFieldsPanelEvent }) {
  const [expanded, setExpanded] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [savedFields, setSavedFields] = useState<Map<string, MapToTarget>>(new Map());
  const [selectionOverrides, setSelectionOverrides] = useState<Map<string, MapToTarget | "">>(new Map());
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);
  // Only fetch learned suggestions once the operator opens the panel — there's
  // no value loading them while collapsed.
  const learnedSuggestions = useTenantLearnedSuggestions(evt.tenantId, expanded);

  const fieldNames = Array.isArray(evt.fieldNames) ? evt.fieldNames : [];
  const reason = evt.unmatchedReason || "Pulse could not link this fill to a known job, lead, or click.";

  const suggestions = useMemo(() => {
    const m = new Map<string, MapToTarget>();
    for (const n of fieldNames) {
      const s = suggestMapTarget(n, learnedSuggestions);
      if (s) m.set(n, s);
    }
    return m;
  }, [fieldNames.join("\u0000"), learnedSuggestions]);

  const getSelection = (name: string): MapToTarget | "" => {
    if (selectionOverrides.has(name)) return selectionOverrides.get(name)!;
    return suggestions.get(name) ?? "";
  };

  const handleSelect = (name: string, value: MapToTarget | "") => {
    setSelectionOverrides((prev) => {
      const next = new Map(prev);
      next.set(name, value);
      return next;
    });
    setTouchedFields((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      return next;
    });
  };

  const doSave = async (
    fieldName: string,
    mapsTo: MapToTarget,
  ): Promise<{ ok: boolean; errorMsg: string | null }> => {
    const { pageUrlPattern, formIdentifier } = deriveMappingScope(evt);
    try {
      const res = await fetch(`${API_BASE}/api/field-mapping-rules?tenantId=${evt.tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pageUrlPattern, formIdentifier, fieldName, mapsTo }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as { error?: string }));
        return { ok: false, errorMsg: d.error || `Failed to save mapping (HTTP ${res.status})` };
      }
      setSavedFields((prev) => {
        const next = new Map(prev);
        next.set(fieldName, mapsTo);
        return next;
      });
      recordLearnedSuggestion(evt.tenantId, fieldName, mapsTo);
      return { ok: true, errorMsg: null };
    } catch {
      return { ok: false, errorMsg: "Network error saving mapping rule." };
    }
  };

  const saveMapping = async (fieldName: string, mapsTo: MapToTarget) => {
    setSavingField(fieldName);
    const result = await doSave(fieldName, mapsTo);
    setSavingField(null);
    if (result.ok) {
      toast.success(`Mapped "${fieldName}" → ${mapsTo}. Applies to future fills of this form only.`);
    } else if (result.errorMsg) {
      toast.error(result.errorMsg);
    }
  };

  const bulkEligible = fieldNames.filter(
    (n) => suggestions.has(n) && !touchedFields.has(n) && !savedFields.has(n),
  );
  const bulkInProgress = bulkProgress !== null;

  const saveAllSuggested = async () => {
    const targets = bulkEligible.slice();
    if (targets.length === 0) return;
    const total = targets.length;
    let savedCount = 0;
    let failureCount = 0;
    setBulkProgress({ current: 0, total });
    for (let i = 0; i < targets.length; i++) {
      const name = targets[i];
      const sugg = suggestions.get(name);
      if (!sugg) continue;
      setBulkProgress({ current: i + 1, total });
      setSavingField(name);
      const result = await doSave(name, sugg);
      if (result.ok) {
        savedCount++;
      } else {
        failureCount++;
        if (result.errorMsg) {
          toast.error(`"${name}": ${result.errorMsg}`);
        }
      }
    }
    setSavingField(null);
    setBulkProgress(null);
    if (savedCount === total) {
      toast.success(`Saved ${savedCount} suggested mapping${savedCount === 1 ? "" : "s"}.`);
    } else if (savedCount > 0) {
      toast.success(
        `Saved ${savedCount} of ${total} suggested mapping${total === 1 ? "" : "s"}. ${failureCount} failed.`,
      );
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-white/10">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-amber-300 hover:text-amber-200 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span className="font-medium">Why unmatched?</span>
        <span className="text-[11px] text-muted-foreground">({fieldNames.length} field{fieldNames.length === 1 ? "" : "s"} captured)</span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-amber-200/85 bg-amber-500/[0.06] border border-amber-500/20 rounded-md px-2.5 py-1.5">
            {reason}
          </p>

          {fieldNames.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">
              No field names were captured for this submit. The form may not have been visible to pulse.js, or fields were sent without names.
            </p>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground">
                Map a captured field to a semantic target (e.g. <code className="text-white/70">field_3 → phone</code>).
                Mappings apply to <strong className="text-white/85">future fills of this form only</strong> — they do not re-match this event.
              </p>
              {(bulkEligible.length > 0 || bulkInProgress) && (
                <div className="flex items-center justify-between gap-2 bg-emerald-500/[0.06] border border-emerald-500/20 rounded-md px-2.5 py-1.5">
                  <span className="text-[11px] text-emerald-200/85">
                    {bulkInProgress
                      ? `Saving suggested mappings… (${bulkProgress!.current} of ${bulkProgress!.total})`
                      : `${bulkEligible.length} suggested mapping${bulkEligible.length === 1 ? "" : "s"} ready to confirm.`}
                  </span>
                  <button
                    type="button"
                    disabled={bulkInProgress || bulkEligible.length === 0}
                    onClick={saveAllSuggested}
                    className="text-[11px] px-2.5 py-1 rounded border border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                  >
                    {bulkInProgress
                      ? `Saving ${bulkProgress!.current}/${bulkProgress!.total}…`
                      : `Save all suggested (${bulkEligible.length})`}
                  </button>
                </div>
              )}
              <div className="space-y-1">
                {fieldNames.map((name) => (
                  <UnmatchedFieldRow
                    key={name}
                    name={name}
                    savedAs={savedFields.get(name)}
                    isSaving={savingField === name}
                    selected={getSelection(name)}
                    suggested={suggestions.get(name) ?? null}
                    isTouched={touchedFields.has(name)}
                    disabled={bulkInProgress}
                    onSelect={handleSelect}
                    onSave={saveMapping}
                    learnedSuggestions={learnedSuggestions}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function UnmatchedFieldRow({
  name,
  savedAs,
  isSaving,
  selected,
  suggested,
  isTouched,
  disabled,
  onSelect,
  onSave,
  learnedSuggestions,
}: {
  name: string;
  savedAs: MapToTarget | undefined;
  isSaving: boolean;
  selected: MapToTarget | "";
  suggested: MapToTarget | null;
  isTouched: boolean;
  disabled: boolean;
  onSelect: (name: string, value: MapToTarget | "") => void;
  onSave: (fieldName: string, target: MapToTarget) => void;
  learnedSuggestions: LearnedSuggestions;
}) {
  const isLearnedSuggestion = useMemo(
    () => suggested !== null && learnedSuggestions.get(normalizeFieldName(name)) === suggested,
    [learnedSuggestions, name, suggested],
  );
  const showSuggestedHint = !savedAs && suggested !== null && !isTouched && selected === suggested;
  const controlsDisabled = isSaving || disabled;

  if (savedAs) {
    return (
      <div className="flex items-center gap-2 bg-white/[0.02] border border-white/10 rounded-md px-2.5 py-1.5">
        <code className="text-[11px] text-white/80 truncate flex-1 min-w-0" title={name}>{name}</code>
        <span className="flex items-center gap-1 text-[11px] text-emerald-300">
          <Check className="w-3 h-3" />
          mapped → {savedAs}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 bg-white/[0.02] border border-white/10 rounded-md px-2.5 py-1.5">
      <code className="text-[11px] text-white/80 truncate flex-1 min-w-0" title={name}>{name}</code>
      <select
        aria-label={`Map ${name} to`}
        value={selected}
        disabled={controlsDisabled}
        onChange={(e) => onSelect(name, e.target.value as MapToTarget | "")}
        className="bg-black/40 border border-white/15 rounded text-[11px] text-amber-300 hover:text-amber-200 px-1.5 py-0.5 cursor-pointer disabled:opacity-50"
      >
        <option value="">Map to…</option>
        {MAP_TO_OPTIONS.map((opt) => (
          <option key={opt} value={opt} className="text-white">{opt}</option>
        ))}
      </select>
      {showSuggestedHint && (
        <span
          className="text-[10px] text-amber-300/70 italic"
          title={isLearnedSuggestion ? "Pre-selected from a previously confirmed mapping for this tenant" : "Pre-selected based on field name"}
        >
          {isLearnedSuggestion ? "learned" : "suggested"}
        </span>
      )}
      {selected && (
        <button
          type="button"
          disabled={controlsDisabled}
          onClick={() => onSave(name, selected as MapToTarget)}
          className="text-[11px] px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
      )}
    </div>
  );
}
