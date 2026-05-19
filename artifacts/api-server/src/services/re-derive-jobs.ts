import { enqueueJob, registerJobHandler } from "./background-jobs";
import {
  reDeriveLeadsForRuleScope,
  countPendingRederiveLeadsForRuleScope,
  reDeriveLeadFunnel,
} from "./re-derive-lead-funnel";
import {
  emitRuleRederiveComplete,
  emitRuleRederiveFailed,
  emitSelectedLeadsRederiveComplete,
  emitSelectedLeadsRederiveFailed,
} from "../socket";

/**
 * Errors whose `name` we know mean "retrying will not help" — bad inputs,
 * missing tenant, fan-out validation failures. We match on `name` (not
 * `instanceof`) so a test that re-imports the funnel module under a fresh
 * registry still classifies its errors correctly.
 */
const NON_RETRYABLE_ERROR_NAMES = new Set<string>([
  "NonRetryableReDeriveError",
]);

function isNonRetryableReDeriveError(err: unknown): boolean {
  return (
    err instanceof Error && NON_RETRYABLE_ERROR_NAMES.has(err.name)
  );
}

export const REDERIVE_LEADS_FOR_RULE_SCOPE = "rederive_leads_for_rule_scope";

/**
 * Number of automatic in-handler retries on transient fan-out failures
 * before we surface `rule-rederive-failed` to the operator. Two retries
 * means up to three total attempts per job execution.
 *
 * We retry inside the handler (rather than letting background-jobs do it)
 * so the operator never sees a transient blip — background-jobs retries
 * are slow (10s+ exponential backoff) and the panel that triggered the
 * save would already have shown a "couldn't re-derive" error before the
 * next outer attempt ran. To avoid stacking retries on top of the
 * background-jobs retry policy, we enqueue with maxAttempts: 1.
 */
const HANDLER_MAX_RETRIES = 2;
const HANDLER_RETRY_BASE_MS = 250;

let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function __setSleepForTests(impl: (ms: number) => Promise<void>): void {
  sleepImpl = impl;
}

export function __resetSleepForTests(): void {
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

interface ReDerivePayload {
  tenantId: number;
  pageUrlPattern: string;
  formIdentifier: string;
  excludeLeadId: number | null;
}

function parsePayload(p: Record<string, unknown>): ReDerivePayload {
  const tenantId = p["tenantId"];
  const pageUrlPattern = p["pageUrlPattern"];
  const formIdentifier = p["formIdentifier"];
  const excludeLeadId = p["excludeLeadId"];
  if (
    typeof tenantId !== "number" ||
    typeof pageUrlPattern !== "string" ||
    typeof formIdentifier !== "string"
  ) {
    throw new Error(
      `Invalid payload for ${REDERIVE_LEADS_FOR_RULE_SCOPE}: ${JSON.stringify(p)}`,
    );
  }
  return {
    tenantId,
    pageUrlPattern,
    formIdentifier,
    excludeLeadId: typeof excludeLeadId === "number" ? excludeLeadId : null,
  };
}

export function registerReDeriveJobHandlers(): void {
  registerSelectedLeadsHandler();
  registerJobHandler(REDERIVE_LEADS_FOR_RULE_SCOPE, async (payload) => {
    const args = parsePayload(payload);
    let result;
    let lastErr: unknown;
    let succeeded = false;
    for (let attempt = 0; attempt <= HANDLER_MAX_RETRIES; attempt++) {
      try {
        result = await reDeriveLeadsForRuleScope(
          args.tenantId,
          args.pageUrlPattern,
          args.formIdentifier,
          { excludeLeadId: args.excludeLeadId },
        );
        succeeded = true;
        break;
      } catch (err) {
        lastErr = err;
        if (isNonRetryableReDeriveError(err)) {
          // Bad inputs / missing tenant / fan-out validation failure — no
          // amount of backoff will fix this. Skip remaining retries and let
          // the failure surface to the operator immediately so the panel can
          // show the retry hint without two pointless 250ms+ sleeps.
          console.warn(
            "[re-derive-jobs] non-retryable failure, skipping in-handler retries:",
            err,
          );
          break;
        }
        if (attempt < HANDLER_MAX_RETRIES) {
          const delayMs = HANDLER_RETRY_BASE_MS * Math.pow(2, attempt);
          console.warn(
            `[re-derive-jobs] transient failure on attempt ${attempt + 1}/${HANDLER_MAX_RETRIES + 1}, retrying in ${delayMs}ms:`,
            err,
          );
          await sleepImpl(delayMs);
        }
      }
    }

    if (!succeeded) {
      // All in-handler retries exhausted. Surface to the operator's UI so
      // the panel that triggered the save can show a "couldn't re-derive
      // historical leads" hint with a retry button. We still rethrow so
      // background-jobs marks the job failed (we enqueue with
      // maxAttempts: 1 to prevent double-retry on top of our own).
      // Best-effort: compute how many leads in this scope still need to be
      // re-derived so the operator UI can show "~N historical leads still
      // need updating" next to the retry button. A failure here is silent;
      // the failure hint itself is more important than the count.
      let pendingCount: Awaited<ReturnType<typeof countPendingRederiveLeadsForRuleScope>> | null = null;
      try {
        pendingCount = await countPendingRederiveLeadsForRuleScope(
          args.tenantId,
          args.pageUrlPattern,
          args.formIdentifier,
          { excludeLeadId: args.excludeLeadId },
        );
      } catch (countErr) {
        console.error("[re-derive-jobs] countPendingRederiveLeadsForRuleScope failed:", countErr);
      }
      try {
        emitRuleRederiveFailed(args.tenantId, {
          pageUrlPattern: args.pageUrlPattern,
          formIdentifier: args.formIdentifier,
          reason: lastErr instanceof Error ? lastErr.message : String(lastErr),
          pendingLeads: pendingCount?.pendingLeads,
          hitLimit: pendingCount?.hitLimit,
          maxLeads: pendingCount?.maxLeads,
          lastAttemptedAt: pendingCount?.lastAttemptedAt ?? new Date().toISOString(),
        });
      } catch (emitErr) {
        console.error("[re-derive-jobs] emitRuleRederiveFailed failed:", emitErr);
      }
      throw lastErr;
    }

    // Notify the operator's UI so the panel that triggered the save can
    // surface a "N leads re-derived" indicator. Emit on every completion
    // (even zero) so the panel can clear its "working…" state instead of
    // waiting forever when nothing matched.
    try {
      emitRuleRederiveComplete(args.tenantId, {
        pageUrlPattern: args.pageUrlPattern,
        formIdentifier: args.formIdentifier,
        leadsChanged: result!.leadsChanged,
        hitLimit: result!.hitLimit,
        maxLeads: result!.maxLeads,
      });
    } catch (err) {
      console.error("[re-derive-jobs] emitRuleRederiveComplete failed:", err);
    }
    return result;
  });
}

export const REDERIVE_SELECTED_LEADS = "rederive_selected_leads";

interface ReDeriveSelectedPayload {
  tenantId: number;
  leadIds: number[];
}

function parseSelectedPayload(p: Record<string, unknown>): ReDeriveSelectedPayload {
  const tenantId = p["tenantId"];
  const leadIds = p["leadIds"];
  if (
    typeof tenantId !== "number" ||
    !Array.isArray(leadIds) ||
    leadIds.some((id) => typeof id !== "number" || !Number.isFinite(id))
  ) {
    throw new Error(
      `Invalid payload for ${REDERIVE_SELECTED_LEADS}: ${JSON.stringify(p)}`,
    );
  }
  return { tenantId, leadIds: leadIds as number[] };
}

/**
 * Registers the selected-leads bulk re-derive handler. Used when the operator
 * picks a specific subset of pending leads in the "View pending leads" sheet
 * and the count is large enough that we want the work to run as a durable
 * background job (with retries + visibility) instead of holding the request
 * open synchronously.
 */
function registerSelectedLeadsHandler(): void {
  registerJobHandler(REDERIVE_SELECTED_LEADS, async (payload, ctx) => {
    const args = parseSelectedPayload(payload);
    const jobId = ctx?.job?.id ?? null;
    let succeeded = 0;
    let failed = 0;
    let changed = 0;
    const failedLeadIds: number[] = [];
    try {
      for (const leadId of args.leadIds) {
        try {
          const r = await reDeriveLeadFunnel(args.tenantId, leadId);
          succeeded++;
          if (r?.changed) changed++;
        } catch (err) {
          failed++;
          failedLeadIds.push(leadId);
          console.error("[re-derive-jobs:selected] reDeriveLeadFunnel failed for lead", leadId, err);
        }
      }
    } catch (err) {
      // Defensive: catastrophic loop failure (something other than a per-lead
      // throw, which we already catch above). Surface to the sheet so it can
      // clear its "working…" state and show a retry hint.
      try {
        emitSelectedLeadsRederiveFailed(args.tenantId, {
          jobId,
          total: args.leadIds.length,
          reason: err instanceof Error ? err.message : String(err),
        });
      } catch (emitErr) {
        console.error("[re-derive-jobs:selected] emitSelectedLeadsRederiveFailed failed:", emitErr);
      }
      throw err;
    }

    // Notify the sheet that the background job has finished. Emit even when
    // every lead failed so the sheet can show the failure counts and offer a
    // retry without waiting for a timeout.
    try {
      emitSelectedLeadsRederiveComplete(args.tenantId, {
        jobId,
        total: args.leadIds.length,
        succeeded,
        failed,
        changed,
        failedLeadIds,
      });
    } catch (emitErr) {
      console.error("[re-derive-jobs:selected] emitSelectedLeadsRederiveComplete failed:", emitErr);
    }
    return { total: args.leadIds.length, succeeded, failed, changed, failedLeadIds };
  });
}

export async function enqueueReDeriveSelectedLeads(args: ReDeriveSelectedPayload) {
  return enqueueJob(
    REDERIVE_SELECTED_LEADS,
    args as unknown as Record<string, unknown>,
    { tenantId: args.tenantId, maxAttempts: 1 },
  );
}

export async function enqueueReDeriveLeadsForRuleScope(args: ReDerivePayload) {
  return enqueueJob(
    REDERIVE_LEADS_FOR_RULE_SCOPE,
    args as unknown as Record<string, unknown>,
    {
      tenantId: args.tenantId,
      // The handler does its own in-handler retries with short exponential
      // backoff for transient blips; we don't want background-jobs to then
      // retry the whole job again on top of that (10s+ outer backoff would
      // already have shown the operator a failure event).
      maxAttempts: 1,
    },
  );
}
