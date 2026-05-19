import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Check, Undo2, X, Loader2 } from "lucide-react";
import { useOptionalLeadNotification, type RuleRederiveCompleteData } from "@/contexts/lead-notification-context";
import {
  MAP_TO_OPTIONS,
  normalizeFieldName,
  suggestMapTarget,
  type LearnedSuggestions,
  type MapToTarget,
} from "@/lib/field-mapping-heuristic";
import { formatFieldValue } from "@/lib/format-field-value";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type SavedEntry = { mapsTo: MapToTarget; ruleId: number | null };

export interface UnmatchedFieldsPanelEvent {
  tenantId: number;
  pageUrl: string | null;
  formId: string | null;
  formName: string | null;
  fieldNames?: string[] | null;
  /** Raw captured values keyed by field name. When present, the panel renders
   * the submitted value next to each field name so operators can see what
   * actually came in (e.g. "company_url: (empty)") before choosing a mapping
   * target. Optional — surfaces that don't have access to the raw form fields
   * (e.g. live SSE feed) can omit it and the panel renders names only. */
  fieldValues?: Record<string, unknown> | null;
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
//
// `fetchedAt` is the wall-clock timestamp of the most recent successful load
// for this tenant. The visibility-driven background refresh (see
// `refreshStaleLearnedSuggestions` below) uses it to decide whether a cached
// entry is still fresh enough to keep, or whether it should be revalidated
// against the server when the operator returns to the tab — without that, a
// teammate confirming or pruning learned suggestions in another session
// would leave this tab pre-selecting the stale "learned" target indefinitely.
type LearnedMap = Map<string, MapToTarget>;
type LearnedEntry = { map: LearnedMap; fetchedAt: number };
const learnedSuggestionsByTenant = new Map<number, LearnedEntry>();
const learnedFetchInflight = new Map<number, Promise<LearnedMap>>();
const learnedSubscribers = new Map<number, Set<() => void>>();

// How long a successfully loaded learned-suggestions cache entry is
// considered "fresh" before the visibility-change refresh will revalidate
// it. Mirrors SCOPED_RULES_FRESHNESS_WINDOW_MS so operators get a
// consistent freshness guarantee across both auto-suggestion sources.
// Exported for tests.
export const LEARNED_SUGGESTIONS_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

// Module-level cache of preloaded existing field-mapping rules per
// (tenantId, pageUrlPattern, formIdentifier) scope. Many unmatched events on
// the live attribution feed and past-unmatched view share the same scope, so
// without this cache every panel expand re-fetches the same rule list.
// Subscribers are notified whenever the cache is updated so panels for the
// same scope reflect new rules (e.g. after a sibling panel saves) without a
// manual refresh.
//
// `fetchedAt` is the wall-clock timestamp of the most recent successful load
// for this scope. The visibility-driven background refresh (see
// `refreshStaleScopedRules` below) uses it to decide whether a cached entry
// is still fresh enough to keep, or whether it should be revalidated against
// the server when the operator returns to the tab.
type ScopedRulesMap = Map<string, SavedEntry>;
type ScopedRulesEntry = {
  rules: ScopedRulesMap;
  status: "loading" | "loaded";
  fetchedAt: number;
};
// Metadata passed to scope-rules subscribers when a notification was caused by
// a background refresh that ACTUALLY changed the cached rules (vs. local
// writes via recordScopedRule / removeScopedRule, which leave it undefined).
// Subscribers use this to surface a non-blocking "rules updated from another
// session" hint so operators don't see "already mapped → X" badges silently
// flip on them after a teammate edited rules in another tab.
type ScopedRulesBackgroundChange = {
  changedFields: ReadonlySet<string>;
  at: number;
};
type ScopedRulesSubscriber = (change?: ScopedRulesBackgroundChange) => void;
const scopedRulesByKey = new Map<string, ScopedRulesEntry>();
const scopedRulesFetchInflight = new Map<string, Promise<ScopedRulesMap>>();
const scopedRulesSubscribers = new Map<string, Set<ScopedRulesSubscriber>>();

// How long a successfully loaded scoped-rules cache entry is considered
// "fresh" before the visibility-change refresh will revalidate it. Long
// enough that flicking between tabs doesn't hammer the server, short enough
// that a teammate editing a rule in another session won't go unnoticed for
// the rest of the day. Exported for tests.
export const SCOPED_RULES_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

function scopeKeyOf(tenantId: number, pageUrlPattern: string, formIdentifier: string): string {
  return `${tenantId}\u0000${pageUrlPattern}\u0000${formIdentifier}`;
}

function notifyScopedRulesSubscribers(
  key: string,
  change?: ScopedRulesBackgroundChange,
) {
  const subs = scopedRulesSubscribers.get(key);
  if (!subs) return;
  for (const fn of subs) fn(change);
}

// How long the "rules updated from another session" hint stays visible after
// a background refresh changed at least one rule for an expanded panel's
// scope. A few seconds — long enough for the operator to notice and connect
// it to the badge change, short enough to fade out on its own and not clutter
// the panel. Exported for tests so the value isn't duplicated.
export const RULES_UPDATED_HINT_DURATION_MS = 5000;

export function getCachedScopedRules(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
): ScopedRulesMap | null {
  const entry = scopedRulesByKey.get(scopeKeyOf(tenantId, pageUrlPattern, formIdentifier));
  if (entry && entry.status === "loaded") return entry.rules;
  return null;
}

export async function fetchScopedRules(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
  opts?: { force?: boolean },
): Promise<ScopedRulesMap> {
  const key = scopeKeyOf(tenantId, pageUrlPattern, formIdentifier);
  const cached = scopedRulesByKey.get(key);
  // `force` (used by the visibility-driven background refresh) bypasses the
  // cache hit so a stale entry can be revalidated against the server. An
  // already-in-flight fetch is still shared so we don't issue duplicate GETs.
  if (!opts?.force && cached && cached.status === "loaded") return cached.rules;
  const inflight = scopedRulesFetchInflight.get(key);
  if (inflight) return inflight;

  // Snapshot whatever rules the cache currently holds so we can detect (and
  // preserve) any local writes via recordScopedRule / removeScopedRule that
  // happen while this fetch is in flight. Without this, an in-flight fetch
  // returning a stale/empty rule set could clobber a freshly saved mapping.
  const snapshot = new Map<string, SavedEntry>(cached?.rules ?? new Map());
  // Preserve the previous fetchedAt during the loading window so a refetch
  // that fails / is slow doesn't reset our freshness tracking to "now" and
  // suppress further refresh attempts.
  scopedRulesByKey.set(key, {
    rules: new Map(snapshot),
    status: "loading",
    fetchedAt: cached?.fetchedAt ?? 0,
  });

  const promise = (async () => {
    const params = new URLSearchParams({
      tenantId: String(tenantId),
      pageUrlPattern,
      formIdentifier,
    });
    const result = new Map<string, SavedEntry>();
    try {
      const res = await fetch(
        `${API_BASE}/api/field-mapping-rules?${params.toString()}`,
        { credentials: "include" },
      );
      if (res && res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          rules?: Array<{ id?: number; fieldName?: string; mapsTo?: string }>;
        };
        for (const r of data.rules ?? []) {
          if (r && typeof r.fieldName === "string" && typeof r.mapsTo === "string") {
            result.set(r.fieldName, {
              mapsTo: r.mapsTo as MapToTarget,
              ruleId: typeof r.id === "number" ? r.id : null,
            });
          }
        }
      }
      // Non-OK (403/404/etc) is silently treated as "no rules" — operator can still attempt to map.
    } catch {
      // Network error: silently treat as "no rules" — operator can still attempt to map.
    } finally {
      scopedRulesFetchInflight.delete(key);
    }
    // Merge in any local writes that happened while we were in flight. The
    // current cache reflects intermediate writes from recordScopedRule /
    // removeScopedRule (each of which clones the rules map). Diff against
    // the snapshot to know which fields were locally added/changed (local
    // wins) vs locally removed (drop from merged result).
    const liveRules = scopedRulesByKey.get(key)?.rules ?? new Map<string, SavedEntry>();
    const merged = new Map(result);
    for (const [f, v] of liveRules) {
      const snap = snapshot.get(f);
      if (!snap || snap.mapsTo !== v.mapsTo || snap.ruleId !== v.ruleId) {
        merged.set(f, v);
      }
    }
    for (const f of snapshot.keys()) {
      if (!liveRules.has(f)) merged.delete(f);
    }
    scopedRulesByKey.set(key, { rules: merged, status: "loaded", fetchedAt: Date.now() });
    // For background refreshes (force === true) compute which fields actually
    // changed on the server vs. what we had cached pre-refresh. The diff is
    // `result` (raw server payload) vs. `snapshot` (the cache contents at the
    // moment the fetch began). We deliberately exclude local writes that
    // happened mid-fetch — those live in `merged` via the live-rules merge
    // above and aren't a "change from another session". When at least one
    // field differs, we notify subscribers with the change so expanded panels
    // can briefly surface a "rules updated from another session" hint.
    let backgroundChange: ScopedRulesBackgroundChange | undefined;
    if (opts?.force && cached && cached.status === "loaded") {
      const changed = new Set<string>();
      for (const [f, v] of result) {
        const prev = snapshot.get(f);
        if (!prev || prev.mapsTo !== v.mapsTo || prev.ruleId !== v.ruleId) {
          changed.add(f);
        }
      }
      for (const f of snapshot.keys()) {
        if (!result.has(f)) changed.add(f);
      }
      if (changed.size > 0) {
        backgroundChange = { changedFields: changed, at: Date.now() };
      }
    }
    notifyScopedRulesSubscribers(key, backgroundChange);
    return merged;
  })();

  scopedRulesFetchInflight.set(key, promise);
  return promise;
}

function recordScopedRule(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
  fieldName: string,
  mapsTo: MapToTarget,
  ruleId: number | null,
) {
  const key = scopeKeyOf(tenantId, pageUrlPattern, formIdentifier);
  const existing = scopedRulesByKey.get(key);
  // Clone to make change detection trivial for subscribers.
  const nextRules = new Map(existing?.rules ?? new Map<string, SavedEntry>());
  nextRules.set(fieldName, { mapsTo, ruleId });
  scopedRulesByKey.set(key, {
    rules: nextRules,
    status: existing?.status ?? "loaded",
    fetchedAt: existing?.fetchedAt ?? Date.now(),
  });
  notifyScopedRulesSubscribers(key);
}

function removeScopedRule(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
  fieldName: string,
) {
  const key = scopeKeyOf(tenantId, pageUrlPattern, formIdentifier);
  const existing = scopedRulesByKey.get(key);
  if (!existing || !existing.rules.has(fieldName)) return;
  const nextRules = new Map(existing.rules);
  nextRules.delete(fieldName);
  scopedRulesByKey.set(key, {
    rules: nextRules,
    status: existing.status,
    fetchedAt: existing.fetchedAt,
  });
  notifyScopedRulesSubscribers(key);
}

// Walk every loaded scoped-rules entry and kick off a background revalidation
// for any whose `fetchedAt` is older than the freshness window. Called when
// the page regains visibility — we don't want to silently keep showing stale
// "already mapped → X" badges if a teammate edited rules in another session
// while this tab sat idle. Errored or in-flight entries are skipped (they
// aren't "loaded" yet) and re-tried only on the next visibility event after
// they settle.
function refreshStaleScopedRules() {
  const now = Date.now();
  // Snapshot keys first so the iteration isn't affected by entries we mutate
  // (each fetchScopedRules call writes a "loading" entry back into the map).
  const keys = Array.from(scopedRulesByKey.keys());
  for (const key of keys) {
    const entry = scopedRulesByKey.get(key);
    if (!entry || entry.status !== "loaded") continue;
    if (now - entry.fetchedAt < SCOPED_RULES_FRESHNESS_WINDOW_MS) continue;
    const parts = key.split("\u0000");
    if (parts.length !== 3) continue;
    const tenantId = Number(parts[0]);
    if (!Number.isFinite(tenantId)) continue;
    void fetchScopedRules(tenantId, parts[1], parts[2], { force: true });
  }
}

let visibilityRefreshListenerInstalled = false;
function installVisibilityRefreshListener() {
  if (visibilityRefreshListenerInstalled) return;
  if (typeof document === "undefined") return;
  visibilityRefreshListenerInstalled = true;
  document.addEventListener("visibilitychange", () => {
    // Only refresh when the tab actually became visible — firing a refresh
    // when the operator switches AWAY would be wasted work and might race
    // with the browser unloading the page.
    if (document.visibilityState !== "visible") return;
    // Both caches go stale the same way (a teammate edits state in another
    // session while this tab sits idle), so they share the single listener.
    refreshStaleScopedRules();
    refreshStaleLearnedSuggestions();
  });
}
// Install at module load so tests and production both get the listener
// without each panel needing to opt in.
installVisibilityRefreshListener();

export function __resetScopedRulesCacheForTests() {
  scopedRulesByKey.clear();
  scopedRulesFetchInflight.clear();
  scopedRulesSubscribers.clear();
}

// Opportunistically warm the shared scoped-rules cache for a list of visible
// (or about-to-be-visible) unmatched events. Callers on the live attribution
// feed and the past-unmatched view pass the events they're rendering; this
// hook fans out a `fetchScopedRules` per unique (tenantId, pageUrlPattern,
// formIdentifier) scope so the FIRST expand for any given panel hits the
// cache instead of paying a round-trip.
//
// - Deduped: each scope key is only attempted once per hook instance, even
//   if the event list re-renders or contains many events sharing a scope.
// - `fetchScopedRules` itself also dedupes via its module-level cache and
//   in-flight map, so even cross-page mounts won't fan out duplicate GETs.
// - Errors are swallowed; if the prefetch fails, the panel still falls back
//   to "no rules" the first time the operator expands it.
export function usePrefetchScopedRules(
  events: ReadonlyArray<
    Pick<UnmatchedFieldsPanelEvent, "tenantId" | "pageUrl" | "formId" | "formName">
  >,
) {
  const attemptedRef = useRef<Set<string>>(new Set());
  // Fingerprint the relevant fields so the effect re-runs only when the set
  // of scopes actually changes (not on every parent re-render).
  const fingerprint = events
    .map(
      (e) =>
        `${e.tenantId}\u0001${e.pageUrl ?? ""}\u0001${e.formId ?? ""}\u0001${e.formName ?? ""}`,
    )
    .join("\u0002");
  useEffect(() => {
    for (const evt of events) {
      const { pageUrlPattern, formIdentifier } = deriveMappingScope(evt);
      const key = scopeKeyOf(evt.tenantId, pageUrlPattern, formIdentifier);
      if (attemptedRef.current.has(key)) continue;
      attemptedRef.current.add(key);
      // Swallow errors — fetchScopedRules already handles network/HTTP errors
      // internally, but guard against unexpected throws so a bad event in the
      // list never surfaces a toast or breaks the host page.
      void fetchScopedRules(evt.tenantId, pageUrlPattern, formIdentifier).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);
}

export function __resetLearnedSuggestionsCacheForTests() {
  learnedSuggestionsByTenant.clear();
  learnedFetchInflight.clear();
  learnedSubscribers.clear();
  __resetScopedRulesCacheForTests();
}

function notifyLearnedSubscribers(tenantId: number) {
  const subs = learnedSubscribers.get(tenantId);
  if (!subs) return;
  for (const fn of subs) fn();
}

async function fetchLearnedSuggestions(
  tenantId: number,
  opts?: { force?: boolean },
): Promise<LearnedMap> {
  const cached = learnedSuggestionsByTenant.get(tenantId);
  // `force` (used by the visibility-driven background refresh) bypasses the
  // cache hit so a stale entry can be revalidated against the server. An
  // already-in-flight fetch is still shared so we don't issue duplicate GETs.
  if (!opts?.force && cached) return cached.map;
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
        learnedSuggestionsByTenant.set(tenantId, { map: empty, fetchedAt: Date.now() });
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
      learnedSuggestionsByTenant.set(tenantId, { map, fetchedAt: Date.now() });
      notifyLearnedSubscribers(tenantId);
      return map;
    } catch {
      const empty = new Map<string, MapToTarget>();
      learnedSuggestionsByTenant.set(tenantId, { map: empty, fetchedAt: Date.now() });
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
  let entry = learnedSuggestionsByTenant.get(tenantId);
  if (!entry) {
    // Brand-new tenant entry from a local save. Stamp `fetchedAt` so the
    // visibility refresh treats it as fresh until the freshness window elapses
    // — we just learned this mapping locally, no need to immediately re-GET.
    entry = { map: new Map(), fetchedAt: Date.now() };
    learnedSuggestionsByTenant.set(tenantId, entry);
  }
  entry.map.set(normalizeFieldName(fieldName), mapsTo);
  notifyLearnedSubscribers(tenantId);
}

// Walk every loaded learned-suggestions entry and kick off a background
// revalidation for any whose `fetchedAt` is older than the freshness window.
// Called when the page regains visibility — without this, a teammate
// confirming or pruning learned suggestions in another session would leave
// this tab pre-selecting the stale "learned" target indefinitely.
function refreshStaleLearnedSuggestions() {
  const now = Date.now();
  // Snapshot keys first so the iteration isn't affected by entries we mutate.
  const tenantIds = Array.from(learnedSuggestionsByTenant.keys());
  for (const tenantId of tenantIds) {
    const entry = learnedSuggestionsByTenant.get(tenantId);
    if (!entry) continue;
    if (now - entry.fetchedAt < LEARNED_SUGGESTIONS_FRESHNESS_WINDOW_MS) continue;
    void fetchLearnedSuggestions(tenantId, { force: true });
  }
}

// After a rule is deleted the per-tenant aggregate suggestion may have changed
// (e.g. another rule for the same normalized field now wins, or there are no
// rules left at all). Drop the cache and refetch so all subscribed panels see
// the new authoritative answer.
function invalidateLearnedSuggestions(tenantId: number) {
  learnedSuggestionsByTenant.delete(tenantId);
  learnedFetchInflight.delete(tenantId);
  // Kick off a refetch and notify subscribers when it lands.
  void fetchLearnedSuggestions(tenantId);
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

  return learnedSuggestionsByTenant.get(tenantId)?.map ?? new Map();
}

export function UnmatchedFieldsPanel({ evt }: { evt: UnmatchedFieldsPanelEvent }) {
  const [expanded, setExpanded] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [undoingField, setUndoingField] = useState<string | null>(null);
  const [savedFields, setSavedFields] = useState<Map<string, SavedEntry>>(new Map());
  const [preloadedFields, setPreloadedFields] = useState<Set<string>>(new Set());
  const [editingFields, setEditingFields] = useState<Set<string>>(new Set());
  const [selectionOverrides, setSelectionOverrides] = useState<Map<string, MapToTarget | "">>(new Map());
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [rulesLoading, setRulesLoading] = useState(false);
  // Timestamp of the most recent background refresh that ACTUALLY changed a
  // rule for one of THIS panel's fields. Drives the brief "rules updated
  // from another session" hint and an auto-clear timer below. Null means
  // either nothing has changed yet or the hint window has elapsed.
  const [rulesUpdatedAt, setRulesUpdatedAt] = useState<number | null>(null);
  // Count of in-flight historical-leads re-derive subscriptions for saves
  // issued from THIS panel. While > 0, render a small inline "Refreshing
  // historical leads…" hint so the operator has a signal that something is
  // happening during the up-to-30s window between the save returning and the
  // rederive completion event arriving. Cleared automatically on completion,
  // timeout, or save failure (each call to `subscribeRederiveOnce` registers
  // an `onSettled` decrement). A counter (not a boolean) is used so the bulk
  // "Save all suggested" path — which fans out one subscription per field —
  // keeps the indicator visible until the LAST scope settles.
  const [refreshingHistoricalCount, setRefreshingHistoricalCount] = useState(0);

  // Only fetch learned suggestions once the operator opens the panel — there's
  // no value loading them while collapsed.
  const learnedSuggestions = useTenantLearnedSuggestions(evt.tenantId, expanded);

  const fieldNames = Array.isArray(evt.fieldNames) ? evt.fieldNames : [];
  const reason = evt.unmatchedReason || "Pulse could not link this fill to a known job, lead, or click.";

  // Track which fields THIS panel saved/changed in-session, so cross-panel
  // cache updates know whether to mark a field as "preloaded" (rule existed
  // when this panel opened, or another panel saved it) vs "newly mapped here".
  // Held in a ref so the cache-subscriber callback can read the latest value
  // without resubscribing on every save.
  const inSessionSavedFieldsRef = useRef<Set<string>>(new Set());
  const fieldNamesRef = useRef<string[]>(fieldNames);
  fieldNamesRef.current = fieldNames;

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

  // Hydrate local state from the shared scope-rules cache. Used both on first
  // expand (cache hit OR after fetch resolves) and from the cache subscriber
  // when sibling panels save/undo a rule for the same scope. Captures fields
  // already present in cache as "preloaded" unless THIS panel saved them
  // in-session (in which case they keep their "mapped → X" badge).
  const hydrateFromScopedCache = (cacheRules: ScopedRulesMap) => {
    const names = fieldNamesRef.current;
    const inSession = inSessionSavedFieldsRef.current;
    setSavedFields((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const name of names) {
        const entry = cacheRules.get(name);
        if (entry) {
          const existing = next.get(name);
          if (
            !existing ||
            existing.mapsTo !== entry.mapsTo ||
            existing.ruleId !== entry.ruleId
          ) {
            // Don't clobber an in-session save with a stale cache entry that
            // happens to differ — in-session writes always win.
            if (!existing || !inSession.has(name)) {
              next.set(name, entry);
              changed = true;
            }
          }
        } else if (next.has(name) && !inSession.has(name)) {
          // A preloaded rule was deleted by another panel — drop locally too.
          next.delete(name);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setPreloadedFields((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const name of names) {
        if (cacheRules.has(name) && !inSession.has(name)) {
          if (!next.has(name)) {
            next.add(name);
            changed = true;
          }
        } else if (!cacheRules.has(name) && next.has(name)) {
          next.delete(name);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  };

  const { pageUrlPattern, formIdentifier } = useMemo(
    () => deriveMappingScope(evt),
    [evt.pageUrl, evt.formId, evt.formName],
  );
  const scopeKey = scopeKeyOf(evt.tenantId, pageUrlPattern, formIdentifier);

  // Subscribe to the historical-leads re-derive fan-out result for the scope
  // of the save that's about to happen, so we can surface a follow-up toast
  // like "12 historical leads updated" once the server reports back.
  // Returns an unsubscribe so callers can drop the listener if the save
  // itself fails. Bounded by a timeout in case the event never arrives.
  // Degrades to a no-op when the notification context isn't mounted (e.g.
  // unit tests that render this panel in isolation) so the panel stays
  // usable outside of the Pulse shell.
  const notification = useOptionalLeadNotification();
  const subscribeRederiveOnce = (
    tenantId: number,
    pageUrl: string,
    formIdent: string,
  ): (() => void) => {
    if (!notification) return () => {};
    const { onRuleRederiveComplete } = notification;
    // Bump the in-flight counter so the panel shows the "Refreshing historical
    // leads…" hint until this subscription settles (success / timeout /
    // caller-driven cleanup on save failure). A counter (rather than a boolean)
    // is used so the indicator stays correct if additional save flows in the
    // future fan out multiple concurrent subscriptions. Today only single
    // saveMapping() subscribes — bulk "Save all suggested" writes directly via
    // doSave without subscribing, so it does not currently light the hint.
    setRefreshingHistoricalCount((n) => n + 1);
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      setRefreshingHistoricalCount((n) => Math.max(0, n - 1));
    };
    const unsubscribe = onRuleRederiveComplete((data: RuleRederiveCompleteData) => {
      if (done) return;
      if (data.tenantId && data.tenantId !== tenantId) return;
      if (data.pageUrlPattern !== pageUrl) return;
      if (data.formIdentifier !== formIdent) return;
      cleanup();
      if (data.leadsChanged > 0) {
        const cappedSuffix = data.hitLimit ? `+ (capped at ${data.maxLeads})` : "";
        const noun = data.leadsChanged === 1 ? "lead" : "leads";
        toast.success(`${data.leadsChanged}${cappedSuffix} historical ${noun} re-derived`);
      }
    });
    const timer = setTimeout(cleanup, 30_000);
    return cleanup;
  };

  // Subscribe to scoped-rules cache changes whenever the panel is expanded so
  // that saves / undos in sibling panels for the same scope are reflected
  // here without a manual refresh.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    let subs = scopedRulesSubscribers.get(scopeKey);
    if (!subs) {
      subs = new Set();
      scopedRulesSubscribers.set(scopeKey, subs);
    }
    const trigger = (change?: ScopedRulesBackgroundChange) => {
      if (cancelled) return;
      const entry = scopedRulesByKey.get(scopeKey);
      if (!entry) return;
      hydrateFromScopedCache(entry.rules);
      // Only surface the "rules updated from another session" hint when the
      // notification carries a background-change diff AND at least one of
      // the changed fields is actually displayed by THIS panel and wasn't
      // saved in this session. Local writes (via recordScopedRule /
      // removeScopedRule) come through with `change` undefined and are
      // intentionally silent. Cross-scope changes never fire here because
      // the subscriber set is per scope key.
      if (!change) return;
      const myFields = fieldNamesRef.current;
      const inSession = inSessionSavedFieldsRef.current;
      let relevant = false;
      for (const f of myFields) {
        if (change.changedFields.has(f) && !inSession.has(f)) {
          relevant = true;
          break;
        }
      }
      if (relevant) {
        setRulesUpdatedAt(change.at);
      }
    };
    subs.add(trigger);
    return () => {
      cancelled = true;
      subs?.delete(trigger);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, expanded]);

  // Auto-clear the "rules updated from another session" hint a few seconds
  // after it appears. Using `rulesUpdatedAt` (a timestamp, not a boolean) as
  // the dep means a SECOND background change while the hint is still
  // visible resets the timer cleanly — the operator gets the full window to
  // notice the latest update rather than the hint vanishing mid-glance.
  useEffect(() => {
    if (rulesUpdatedAt === null) return;
    const t = setTimeout(() => setRulesUpdatedAt(null), RULES_UPDATED_HINT_DURATION_MS);
    return () => clearTimeout(t);
  }, [rulesUpdatedAt]);

  // Collapsing the panel should drop the hint too — there's nothing for the
  // operator to glance at while collapsed, and we don't want a stale hint
  // re-appearing the next time they expand.
  useEffect(() => {
    if (!expanded && rulesUpdatedAt !== null) setRulesUpdatedAt(null);
  }, [expanded, rulesUpdatedAt]);

  // Preload rules already saved for this event's (pageUrlPattern, formIdentifier)
  // scope, so operators triaging a backlog can see at a glance which captured
  // fields already have a rule and skip them. Fired once on first expand —
  // subsequent panels for the same scope hit the shared module-level cache.
  const handleToggle = async () => {
    const willExpand = !expanded;
    setExpanded(willExpand);
    if (!willExpand) return;
    if (rulesLoaded || rulesLoading) return;
    if (fieldNames.length === 0) {
      setRulesLoaded(true);
      return;
    }
    const cached = getCachedScopedRules(evt.tenantId, pageUrlPattern, formIdentifier);
    if (cached) {
      hydrateFromScopedCache(cached);
      setRulesLoaded(true);
      return;
    }
    setRulesLoading(true);
    const result = await fetchScopedRules(evt.tenantId, pageUrlPattern, formIdentifier);
    hydrateFromScopedCache(result);
    setRulesLoading(false);
    setRulesLoaded(true);
  };

  const doSave = async (
    fieldName: string,
    mapsTo: MapToTarget,
  ): Promise<{ ok: boolean; errorMsg: string | null }> => {
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
      const data = (await res.json().catch(() => ({}))) as { rule?: { id?: number } };
      const ruleId = typeof data.rule?.id === "number" ? data.rule.id : null;
      // Mark as in-session BEFORE notifying cache subscribers so the hydrate
      // logic in this same panel knows not to flip it to "preloaded".
      inSessionSavedFieldsRef.current.add(fieldName);
      setSavedFields((prev) => {
        const next = new Map(prev);
        next.set(fieldName, { mapsTo, ruleId });
        return next;
      });
      // Note: preloadedFields is intentionally NOT cleared here — "preloaded"
      // describes the fact that the rule existed when the panel was opened, so
      // a re-save of an already-preloaded field still reads as "already mapped".
      // Brand-new in-session saves stay out of preloadedFields naturally.
      recordLearnedSuggestion(evt.tenantId, fieldName, mapsTo);
      // Update the shared scope cache so sibling panels for the same scope see
      // the new rule without an extra fetch (and treat it as "already mapped").
      recordScopedRule(evt.tenantId, pageUrlPattern, formIdentifier, fieldName, mapsTo, ruleId);
      return { ok: true, errorMsg: null };
    } catch {
      return { ok: false, errorMsg: "Network error saving mapping rule." };
    }
  };

  const saveMapping = async (fieldName: string, mapsTo: MapToTarget) => {
    setSavingField(fieldName);
    // Listen for the historical-leads re-derive fan-out result before issuing
    // the save, so we don't miss the socket event if the server responds fast.
    const unsubscribe = subscribeRederiveOnce(evt.tenantId, pageUrlPattern, formIdentifier);
    const result = await doSave(fieldName, mapsTo);
    setSavingField(null);
    if (result.ok) {
      // Exit re-mapping edit mode if applicable.
      setEditingFields((prev) => {
        if (!prev.has(fieldName)) return prev;
        const next = new Set(prev);
        next.delete(fieldName);
        return next;
      });
      toast.success(`Mapped "${fieldName}" → ${mapsTo}. Applies to future fills of this form only.`);
    } else {
      // Save failed — drop the rederive listener; the server never ran the
      // fan-out, so no follow-up toast will arrive.
      unsubscribe();
      if (result.errorMsg) toast.error(result.errorMsg);
    }
  };

  const undoMapping = async (fieldName: string) => {
    const entry = savedFields.get(fieldName);
    if (!entry) return;
    if (entry.ruleId == null) {
      toast.error("Can't undo this mapping — the rule ID was not returned when it was saved. Refresh and try again.");
      return;
    }
    setUndoingField(fieldName);
    try {
      const res = await fetch(
        `${API_BASE}/api/field-mapping-rules/${entry.ruleId}?tenantId=${evt.tenantId}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as { error?: string }));
        toast.error(d.error || `Failed to undo mapping (HTTP ${res.status})`);
        return;
      }
      // Drop the field from the local saved set so the row reverts to the
      // editable Map-to state, and refresh the per-tenant learned cache so
      // sibling panels stop pre-selecting the now-deleted target.
      setSavedFields((prev) => {
        const next = new Map(prev);
        next.delete(fieldName);
        return next;
      });
      setPreloadedFields((prev) => {
        if (!prev.has(fieldName)) return prev;
        const next = new Set(prev);
        next.delete(fieldName);
        return next;
      });
      setEditingFields((prev) => {
        if (!prev.has(fieldName)) return prev;
        const next = new Set(prev);
        next.delete(fieldName);
        return next;
      });
      inSessionSavedFieldsRef.current.delete(fieldName);
      // Drop the rule from the shared scope cache so other panels stop
      // showing it as "already mapped".
      removeScopedRule(evt.tenantId, pageUrlPattern, formIdentifier, fieldName);
      invalidateLearnedSuggestions(evt.tenantId);
      toast.success(`Removed mapping for "${fieldName}". The field is editable again.`);
    } catch {
      toast.error("Network error removing mapping rule.");
    } finally {
      setUndoingField(null);
    }
  };

  const startReMapping = (name: string) => {
    setEditingFields((prev) => {
      const next = new Set(prev);
      next.add(name);
      return next;
    });
    // Pre-fill the dropdown with the current saved target so the operator can
    // see what it is and either change it or cancel.
    const current = savedFields.get(name);
    if (current) {
      setSelectionOverrides((prev) => {
        const next = new Map(prev);
        next.set(name, current.mapsTo);
        return next;
      });
    }
  };

  const cancelReMapping = (name: string) => {
    setEditingFields((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    // Discard the in-progress override so the badge state restores cleanly.
    setSelectionOverrides((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
    setTouchedFields((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };

  // Bulk-save excludes fields that already have a rule (preloaded or
  // session-saved) so it only acts on the remaining "actually new" suggestions.
  const bulkEligible = fieldNames.filter(
    (n) => suggestions.has(n) && !touchedFields.has(n) && !savedFields.has(n),
  );
  const bulkInProgress = bulkProgress !== null;

  // Surface a quick "X of Y already mapped" hint in the collapsed toggle so
  // operators triaging a backlog can skim and skip events that are already
  // fully resolved without expanding each one. Only shown after the preload
  // fetch has completed (otherwise the count would be misleadingly zero).
  const mappedCount = useMemo(() => {
    if (!rulesLoaded) return null;
    if (fieldNames.length === 0) return null;
    let count = 0;
    for (const n of fieldNames) {
      if (savedFields.has(n)) count++;
    }
    return count;
  }, [rulesLoaded, fieldNames.join("\u0000"), savedFields]);
  const allMapped = mappedCount !== null && mappedCount === fieldNames.length;

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
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-xs text-amber-300 hover:text-amber-200 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span className="font-medium">Why unmatched?</span>
        <span className="text-[11px] text-muted-foreground">({fieldNames.length} field{fieldNames.length === 1 ? "" : "s"} captured)</span>
        {mappedCount !== null && mappedCount > 0 && (
          <span
            className={
              allMapped
                ? "text-[11px] text-emerald-300/80"
                : "text-[11px] text-muted-foreground"
            }
          >
            {allMapped
              ? `(all ${mappedCount} already mapped)`
              : `(${mappedCount} of ${fieldNames.length} already mapped)`}
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-amber-200/85 bg-amber-500/[0.06] border border-amber-500/20 rounded-md px-2.5 py-1.5">
            {reason}
          </p>
          {rulesUpdatedAt !== null && (
            <p
              role="status"
              data-testid="rules-updated-hint"
              className="text-[11px] text-sky-200/85 italic"
            >
              Rules updated from another session.
            </p>
          )}
          {refreshingHistoricalCount > 0 && (
            <p
              role="status"
              aria-live="polite"
              data-testid="refreshing-historical-hint"
              className="text-[11px] text-sky-300/85 italic flex items-center gap-1.5"
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              Refreshing historical leads…
            </p>
          )}

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
              {rulesLoading && (
                <p className="text-[11px] text-muted-foreground italic" role="status">
                  Loading existing rules…
                </p>
              )}
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
                {fieldNames.map((name) => {
                  const saved = savedFields.get(name);
                  const hasValueForName = evt.fieldValues != null && Object.prototype.hasOwnProperty.call(evt.fieldValues, name);
                  return (
                    <UnmatchedFieldRow
                      key={name}
                      name={name}
                      capturedValue={hasValueForName ? evt.fieldValues![name] : undefined}
                      hasCapturedValue={hasValueForName}
                      savedAs={saved?.mapsTo}
                      canUndo={saved?.ruleId != null}
                      isPreloaded={preloadedFields.has(name)}
                      isEditing={editingFields.has(name)}
                      isSaving={savingField === name}
                      isUndoing={undoingField === name}
                      selected={getSelection(name)}
                      suggested={suggestions.get(name) ?? null}
                      isTouched={touchedFields.has(name)}
                      disabled={bulkInProgress}
                      onSelect={handleSelect}
                      onSave={saveMapping}
                      onUndo={undoMapping}
                      onStartReMapping={startReMapping}
                      onCancelReMapping={cancelReMapping}
                      learnedSuggestions={learnedSuggestions}
                    />
                  );
                })}
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
  capturedValue,
  hasCapturedValue,
  savedAs,
  canUndo,
  isPreloaded,
  isEditing,
  isSaving,
  isUndoing,
  selected,
  suggested,
  isTouched,
  disabled,
  onSelect,
  onSave,
  onUndo,
  onStartReMapping,
  onCancelReMapping,
  learnedSuggestions,
}: {
  name: string;
  capturedValue: unknown;
  hasCapturedValue: boolean;
  savedAs: MapToTarget | undefined;
  canUndo: boolean;
  isPreloaded: boolean;
  isEditing: boolean;
  isSaving: boolean;
  isUndoing: boolean;
  selected: MapToTarget | "";
  suggested: MapToTarget | null;
  isTouched: boolean;
  disabled: boolean;
  onSelect: (name: string, value: MapToTarget | "") => void;
  onSave: (fieldName: string, target: MapToTarget) => void;
  onUndo: (fieldName: string) => void;
  onStartReMapping: (fieldName: string) => void;
  onCancelReMapping: (fieldName: string) => void;
  learnedSuggestions: LearnedSuggestions;
}) {
  const isLearnedSuggestion = useMemo(
    () => suggested !== null && learnedSuggestions.get(normalizeFieldName(name)) === suggested,
    [learnedSuggestions, name, suggested],
  );
  const showSuggestedHint = !savedAs && suggested !== null && !isTouched && selected === suggested;
  const controlsDisabled = isSaving || isUndoing || disabled;
  const formattedValue = hasCapturedValue ? formatFieldValue(capturedValue) : null;

  if (savedAs && !isEditing) {
    return (
      <SavedFieldRow
        name={name}
        capturedValue={capturedValue}
        hasCapturedValue={hasCapturedValue}
        savedAs={savedAs}
        isPreloaded={isPreloaded}
        canUndo={canUndo}
        isUndoing={isUndoing}
        disabled={disabled}
        isSaving={isSaving}
        onUndo={onUndo}
        onStartReMapping={onStartReMapping}
      />
    );
  }

  return (
    <div className="flex items-center gap-2 bg-white/[0.02] border border-white/10 rounded-md px-2.5 py-1.5">
      <div className="flex-1 min-w-0">
        <code className="block text-[11px] text-white/80 truncate" title={name}>{name}</code>
        {formattedValue !== null && (
          <span
            className="block text-[10px] text-white/45 truncate font-mono"
            title={formattedValue}
            data-testid={`captured-value-${name}`}
          >
            {formattedValue}
          </span>
        )}
      </div>
      <select
        aria-label={`Map ${name} to`}
        value={selected}
        disabled={controlsDisabled}
        onChange={(e) => onSelect(name, e.target.value as MapToTarget | "")}
        className="bg-black/40 border border-white/15 rounded text-[11px] text-amber-300 hover:text-amber-200 px-1.5 py-0.5 cursor-pointer disabled:opacity-50 shrink-0"
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
      {selected && selected !== savedAs && (
        <button
          type="button"
          disabled={controlsDisabled}
          onClick={() => onSave(name, selected as MapToTarget)}
          className="text-[11px] px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
      )}
      {isEditing && (
        <button
          type="button"
          disabled={controlsDisabled}
          onClick={() => onCancelReMapping(name)}
          className="text-[11px] px-2 py-0.5 rounded border border-white/15 text-white/60 hover:text-white/85 disabled:opacity-50"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

// How long an armed Undo confirmation stays "hot" before it auto-disarms
// itself. Long enough that an attentive operator can reach for the second
// click, short enough that walking away clears the red state before a stray
// click can fire the DELETE. Exported for tests so the value isn't duplicated.
export const UNDO_CONFIRMATION_TIMEOUT_MS = 6000;

function SavedFieldRow({
  name,
  capturedValue,
  hasCapturedValue,
  savedAs,
  isPreloaded,
  canUndo,
  isUndoing,
  isSaving,
  disabled,
  onUndo,
  onStartReMapping,
}: {
  name: string;
  capturedValue: unknown;
  hasCapturedValue: boolean;
  savedAs: MapToTarget;
  isPreloaded: boolean;
  canUndo: boolean;
  isUndoing: boolean;
  isSaving: boolean;
  disabled: boolean;
  onUndo: (fieldName: string) => void;
  onStartReMapping: (fieldName: string) => void;
}) {
  const formattedValue = hasCapturedValue ? formatFieldValue(capturedValue) : null;
  // Two-step inline confirmation. The first click on Undo arms `confirming`;
  // only a second click on the (now relabeled) Undo button actually triggers
  // the DELETE. Cancel disarms it. This protects against accidental clicks
  // when several Undo buttons sit next to each other (e.g. after
  // "Save all suggested" lands several mappings in adjacent rows).
  const [confirming, setConfirming] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

  // If the operator arms the confirmation but never follows through, auto-
  // disarm after a short idle window so a stray click later doesn't delete
  // the saved mapping. Collapsing the parent panel unmounts this row, which
  // also clears the armed state for free.
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => {
      setConfirming(false);
    }, UNDO_CONFIRMATION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  // Disarm when the operator clicks anywhere outside the row (a different
  // row, a tab elsewhere in the app, the global header, etc). Without this
  // the red confirmation stays armed until the idle timeout, leaving a wide
  // window where a stray click on the (still-relabeled) Undo button fires
  // the DELETE. Clicks inside this row — including on Cancel or the Undo
  // button itself — fall through to their own handlers untouched.
  useEffect(() => {
    if (!confirming) return;
    if (typeof document === "undefined") return;
    const handlePointerDown = (event: MouseEvent | PointerEvent) => {
      const row = rowRef.current;
      if (!row) return;
      const target = event.target as Node | null;
      if (target && row.contains(target)) return;
      setConfirming(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [confirming]);

  const handleUndoClick = () => {
    if (!canUndo || isUndoing || disabled) return;
    if (confirming) {
      setConfirming(false);
      onUndo(name);
    } else {
      setConfirming(true);
    }
  };

  const handleCancel = () => {
    setConfirming(false);
  };

  const undoLabel = isUndoing
    ? "Undoing…"
    : confirming
      ? "Click again to confirm"
      : "Undo";
  const undoTitle = !canUndo
    ? "Can't undo — rule ID unavailable"
    : confirming
      ? "Click again to permanently delete this saved mapping"
      : "Delete this saved mapping and edit it again";
  const undoClassName = confirming
    ? "flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-amber-400/60 text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
    : "flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-white/20 text-white/70 hover:text-white hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed";

  const badgeText = isPreloaded ? `already mapped → ${savedAs}` : `mapped → ${savedAs}`;
  const changeDisabled = isSaving || isUndoing || disabled || confirming;

  return (
    <div ref={rowRef} className="flex items-center gap-2 bg-white/[0.02] border border-white/10 rounded-md px-2.5 py-1.5">
      <div className="flex-1 min-w-0">
        <code className="block text-[11px] text-white/80 truncate" title={name}>{name}</code>
        {formattedValue !== null && (
          <span
            className="block text-[10px] text-white/45 truncate font-mono"
            title={formattedValue}
            data-testid={`captured-value-${name}`}
          >
            {formattedValue}
          </span>
        )}
      </div>
      <span className="flex items-center gap-1 text-[11px] text-emerald-300 shrink-0">
        <Check className="w-3 h-3" />
        {badgeText}
      </span>
      <button
        type="button"
        onClick={() => onStartReMapping(name)}
        disabled={changeDisabled}
        className="text-[11px] px-2 py-0.5 rounded border border-white/15 text-white/70 hover:text-white hover:bg-white/5 disabled:opacity-50"
        aria-label={`Change mapping for ${name}`}
      >
        Change
      </button>
      <button
        type="button"
        aria-label={`Undo mapping for ${name}`}
        aria-pressed={confirming}
        disabled={!canUndo || isUndoing || disabled}
        onClick={handleUndoClick}
        title={undoTitle}
        className={undoClassName}
      >
        <Undo2 className="w-3 h-3" />
        {undoLabel}
      </button>
      {confirming && !isUndoing && (
        <button
          type="button"
          aria-label={`Cancel undo for ${name}`}
          disabled={disabled}
          onClick={handleCancel}
          title="Keep this saved mapping"
          className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-white/20 text-white/70 hover:text-white hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <X className="w-3 h-3" />
          Cancel
        </button>
      )}
    </div>
  );
}
