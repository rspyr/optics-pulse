import type { RuleRederiveCompleteData } from "@/contexts/lead-notification-context";

export type SubscribeRuleRederiveComplete = (
  cb: (data: RuleRederiveCompleteData) => void,
) => () => void;

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
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(timer);
    if (onSettled) onSettled();
  };
  const unsubscribe = onRuleRederiveComplete((data: RuleRederiveCompleteData) => {
    if (done) return;
    if (data.tenantId && data.tenantId !== tenantId) return;
    if (data.pageUrlPattern !== pageUrlPattern) return;
    if (data.formIdentifier !== formIdentifier) return;
    cleanup();
    const text = formatRederiveMessage(data);
    if (text) onMessage(text);
  });
  const timer = setTimeout(cleanup, 30_000);
  return cleanup;
}
