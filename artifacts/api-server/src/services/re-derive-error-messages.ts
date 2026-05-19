/**
 * Maps internal re-derive errors (thrown from `reDeriveLeadFunnel` and the
 * scope-fan-out helpers) to short, operator-friendly phrases that are safe
 * to surface in the pending-rederive-leads sheet.
 *
 * The raw error is *not* suitable for operator UI: it often includes
 * developer-oriented prefixes (`reDeriveLeadsForRuleScope: invalid ...`),
 * internal table/column names from Postgres errors, or stack-y JSON dumps.
 * Callers still log the full error server-side; this module only controls
 * what we show in the sheet.
 *
 * Anything we don't explicitly recognize collapses to a generic
 * "Re-derive failed" so we never leak internal schema details.
 */

const GENERIC_FAILURE = "Re-derive failed";

interface PgLikeError {
  code?: unknown;
}

function getPgCode(err: unknown): string | null {
  if (err && typeof err === "object") {
    const code = (err as PgLikeError).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return null;
}

/**
 * Map a thrown error from a re-derive operation to a short, operator-safe
 * phrase. The output is intended for direct display in the operator's UI.
 */
export function mapReDeriveErrorForOperator(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "NonRetryableReDeriveError") {
      const msg = err.message || "";
      if (msg.includes("invalid tenantId")) return "Invalid tenant";
      if (msg.includes("invalid pageUrlPattern")) return "Invalid page URL pattern";
      if (msg.includes("invalid formIdentifier")) return "Invalid form identifier";
      return "Invalid re-derive request";
    }

    const pgCode = getPgCode(err);
    if (pgCode) {
      // Connection / availability class — transient, operator should retry.
      if (pgCode.startsWith("08")) return "Database temporarily unavailable";
      // Insufficient resources (e.g. too many connections, disk full).
      if (pgCode.startsWith("53")) return "Database temporarily unavailable";
      // Operator intervention / shutdown.
      if (pgCode.startsWith("57")) return "Database temporarily unavailable";
      // Everything else (integrity, syntax, undefined column/table, ...)
      // would leak schema details if we passed the message through.
      return GENERIC_FAILURE;
    }

    const lower = (err.message || "").toLowerCase();
    if (
      lower.includes("etimedout") ||
      lower.includes("timeout") ||
      lower.includes("econnrefused") ||
      lower.includes("econnreset")
    ) {
      return "Connection timed out, please retry";
    }
  }

  return GENERIC_FAILURE;
}
