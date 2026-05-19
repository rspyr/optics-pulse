import type { RuleRederiveCompleteData } from "@/contexts/lead-notification-context";

export type SubscribeRuleRederiveComplete = (
  cb: (data: RuleRederiveCompleteData) => void,
) => () => void;

// Scope identifier used to filter `rule-rederive-complete` events down to the
// (tenantId, pageUrlPattern, formIdentifier) tuple a caller cares about. The
// same shape is used by both the one-shot and bulk subscription helpers so
// that any future change to the matching rules (e.g. adding a job-id
// correlation field) only has to be made in one place.
export type RederiveScope = {
  tenantId: number;
  pageUrlPattern: string;
  formIdentifier: string;
};

// Predicate shared by every `rule-rederive-complete` subscription helper.
// Centralized so a future server-side change to the event payload (e.g.
// adding a per-job correlation id) can be reflected by both the one-shot and
// bulk listeners without touching their respective call sites.
export function matchesRederiveScope(
  data: Pick<RuleRederiveCompleteData, "tenantId" | "pageUrlPattern" | "formIdentifier">,
  scope: RederiveScope,
): boolean {
  if (data.tenantId && data.tenantId !== scope.tenantId) return false;
  if (data.pageUrlPattern !== scope.pageUrlPattern) return false;
  if (data.formIdentifier !== scope.formIdentifier) return false;
  return true;
}

// Format the operator-facing message for a `rule-rederive-complete` event.
// Returns null when no message should be surfaced (zero leads changed) so
// callers can decide whether to surface a toast / inline hint at all.
export function formatRederiveMessage(
  data: Pick<RuleRederiveCompleteData, "leadsChanged" | "hitLimit" | "maxLeads">,
): string | null {
  if (!data.leadsChanged || data.leadsChanged <= 0) return null;
  const cappedSuffix = data.hitLimit ? `+ (capped at ${data.maxLeads})` : "";
  const noun = data.leadsChanged === 1 ? "lead" : "leads";
  return `${data.leadsChanged}${cappedSuffix} historical ${noun} re-derived`;
}

// Default safety timeout for a scope subscription. Exported so tests and
// callers that need to reason about the upper bound can reference it.
export const REDERIVE_SUBSCRIPTION_TIMEOUT_MS = 30_000;

export type RederiveScopeSubscription = {
  // Tear down the subscription: unsubscribes the underlying listener, cancels
  // the safety timer (if armed) and invokes `onCleanup` exactly once.
  cleanup: () => void;
  // Arm the 30s safety timeout. Idempotent — calling more than once is a
  // no-op so callers can defer arming (e.g. the bulk path arms only after
  // every save has been issued).
  armTimeout: () => void;
};

// Internal building block shared by `subscribeRederiveOnce` (one-shot) and
// the bulk subscription helper used by the unmatched-fields panel. Handles
// the bits both variants need:
//
//  - subscribing to `rule-rederive-complete` and filtering by scope via
//    `matchesRederiveScope`,
//  - guarding `onCleanup` so it runs exactly once even if the caller invokes
//    `cleanup()` multiple times or the safety timeout fires after a
//    caller-driven cleanup,
//  - exposing `armTimeout()` so callers control WHEN the 30s budget starts
//    (the one-shot variant arms immediately; the bulk variant defers until
//    every save in the batch has been issued so a long fan-out can't clear
//    the hint mid-batch).
//
// The variants diverge on what to do with a matching event (one-shot cleans
// up and surfaces a toast; bulk increments a received counter), so that's
// passed in as `onMatch` rather than baked in here.
export function createRederiveScopeSubscription(
  onRuleRederiveComplete: SubscribeRuleRederiveComplete,
  scope: RederiveScope,
  onMatch: (data: RuleRederiveCompleteData) => void,
  opts?: { onCleanup?: () => void; timeoutMs?: number },
): RederiveScopeSubscription {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutMs = opts?.timeoutMs ?? REDERIVE_SUBSCRIPTION_TIMEOUT_MS;
  const cleanup = () => {
    if (done) return;
    done = true;
    unsubscribe();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (opts?.onCleanup) opts.onCleanup();
  };
  const unsubscribe = onRuleRederiveComplete((data: RuleRederiveCompleteData) => {
    if (done) return;
    if (!matchesRederiveScope(data, scope)) return;
    onMatch(data);
  });
  return {
    cleanup,
    armTimeout: () => {
      if (done || timer !== null) return;
      timer = setTimeout(cleanup, timeoutMs);
    },
  };
}

// Subscribe (one-shot, time-bounded) to the historical-leads re-derive
// fan-out completion for a specific (tenantId, pageUrlPattern, formIdentifier)
// scope. When the server reports back, the formatted message (e.g.
// "12 historical leads re-derived") is passed to `onMessage`. Falls silent on
// zero leads changed. Returns an unsubscribe so the caller can drop the
// listener if the save itself failed and no event will arrive. Bounded by a
// 30s safety timeout in case the event never arrives. When
// `onRuleRederiveComplete` is null (e.g. component rendered in a unit test
// without the notification shell) `onSettled` is invoked synchronously so
// callers can immediately clear any "refreshing" indicator, and the returned
// unsubscribe is a no-op.
export function subscribeRederiveOnce(
  onRuleRederiveComplete: SubscribeRuleRederiveComplete | null,
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
  onMessage: (text: string) => void,
  onSettled?: () => void,
): () => void {
  if (!onRuleRederiveComplete) {
    if (onSettled) onSettled();
    return () => {};
  }
  const sub: RederiveScopeSubscription = createRederiveScopeSubscription(
    onRuleRederiveComplete,
    { tenantId, pageUrlPattern, formIdentifier },
    (data) => {
      sub.cleanup();
      const text = formatRederiveMessage(data);
      if (text) onMessage(text);
    },
    { onCleanup: onSettled },
  );
  sub.armTimeout();
  return sub.cleanup;
}

export type BulkRederiveSubscription = {
  // Report that one save in the batch succeeded — the server WILL emit a
  // matching `rule-rederive-complete` event for it (possibly already
  // received). Bumps the "expected" count.
  onSaveSucceeded: () => void;
  // Report that one save in the batch failed — NO event will arrive, so
  // nothing needs to be tracked. Still gives the helper a chance to finish
  // if every other save has already completed.
  onSaveFailed: () => void;
  // Signal that every save in the batch has been issued. Arms the 30s safety
  // timeout for the "waiting for re-derive events" tail window and finishes
  // immediately when no events are outstanding (e.g. every save failed).
  finalize: () => void;
};

// Subscribe (aggregate, time-bounded) to the historical-leads re-derive
// fan-out completion for a bulk save of MANY rules within the same
// (tenantId, pageUrlPattern, formIdentifier) scope. The backend emits one
// `rule-rederive-complete` event per saved rule, but all of them carry the
// same scope (no per-job correlation id), so a naive per-field one-shot
// listener would have every listener fire on the FIRST event and clean up
// at once. Instead this helper registers a SINGLE listener and counts events
// against the number of saves the caller reports as succeeded.
//
// Lifecycle is driven by the returned handle:
//   - `onSaveSucceeded()` / `onSaveFailed()` per individual save,
//   - `finalize()` once every save has been issued (arms the 30s timeout),
//   - `onSettled` fires exactly once when the last expected event arrives,
//     every save failed, or the safety timeout elapses.
//
// Per-event toasts are intentionally NOT surfaced from this helper — the
// caller emits its own aggregate "Saved X of Y…" toast and N per-event
// "X historical leads re-derived" toasts would be noisy.
//
// As with `subscribeRederiveOnce`, when `onRuleRederiveComplete` is null the
// helper degrades to a no-op (and `onSettled` is invoked synchronously so
// callers can immediately clear any "refreshing" indicator).
export function subscribeBulkRederive(
  onRuleRederiveComplete: SubscribeRuleRederiveComplete | null,
  scope: RederiveScope,
  onSettled?: () => void,
): BulkRederiveSubscription {
  if (!onRuleRederiveComplete) {
    if (onSettled) onSettled();
    return {
      onSaveSucceeded: () => {},
      onSaveFailed: () => {},
      finalize: () => {},
    };
  }
  let allSavesIssued = false;
  let expected = 0;
  let received = 0;
  let finished = false;
  // Tracked separately from the underlying subscription's `done` flag so
  // `maybeFinish` can stop running once we've decided to clean up but
  // BEFORE armTimeout/cleanup actually executes — avoids any chance of a
  // double-cleanup race if events arrive during finalize().
  const maybeFinish = () => {
    if (finished) return;
    if (!allSavesIssued) return;
    if (received >= expected) {
      finished = true;
      sub.cleanup();
    }
  };
  const sub = createRederiveScopeSubscription(
    onRuleRederiveComplete,
    scope,
    () => {
      received += 1;
      maybeFinish();
    },
    { onCleanup: onSettled },
  );
  return {
    onSaveSucceeded: () => {
      if (finished) return;
      expected += 1;
      // `received` may already exceed `expected` if an earlier event arrived
      // first; maybeFinish checks both totals against allSavesIssued.
      maybeFinish();
    },
    onSaveFailed: () => {
      // No event will arrive for this save; nothing to track. Still call
      // maybeFinish in case this was the last outstanding save and every
      // other completion has already landed.
      maybeFinish();
    },
    finalize: () => {
      if (finished) return;
      allSavesIssued = true;
      // Edge case: every save failed (expected === 0) — finish immediately.
      if (received >= expected) {
        finished = true;
        sub.cleanup();
        return;
      }
      // Otherwise wait for remaining events; arm the 30s safety timeout now
      // so the hint can't get stuck if the server never replies. The timeout
      // is deliberately anchored here (not at subscription creation) because
      // a large bulk save can take longer than 30s just to issue all of its
      // POSTs, and anchoring earlier would clear the hint mid-batch.
      sub.armTimeout();
    },
  };
}
