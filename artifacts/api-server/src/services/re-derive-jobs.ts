import { enqueueJob, registerJobHandler } from "./background-jobs";
import { reDeriveLeadsForRuleScope } from "./re-derive-lead-funnel";
import { emitRuleRederiveComplete } from "../socket";

export const REDERIVE_LEADS_FOR_RULE_SCOPE = "rederive_leads_for_rule_scope";

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
  registerJobHandler(REDERIVE_LEADS_FOR_RULE_SCOPE, async (payload) => {
    const args = parsePayload(payload);
    const result = await reDeriveLeadsForRuleScope(
      args.tenantId,
      args.pageUrlPattern,
      args.formIdentifier,
      { excludeLeadId: args.excludeLeadId },
    );
    // Notify the operator's UI so the panel that triggered the save can
    // surface a "N leads re-derived" indicator. Emit on every completion
    // (even zero) so the panel can clear its "working…" state instead of
    // waiting forever when nothing matched.
    try {
      emitRuleRederiveComplete(args.tenantId, {
        pageUrlPattern: args.pageUrlPattern,
        formIdentifier: args.formIdentifier,
        leadsChanged: result.leadsChanged,
        hitLimit: result.hitLimit,
        maxLeads: result.maxLeads,
      });
    } catch (err) {
      console.error("[re-derive-jobs] emitRuleRederiveComplete failed:", err);
    }
    return result;
  });
}

export async function enqueueReDeriveLeadsForRuleScope(args: ReDerivePayload) {
  return enqueueJob(
    REDERIVE_LEADS_FOR_RULE_SCOPE,
    args as unknown as Record<string, unknown>,
    { tenantId: args.tenantId },
  );
}
