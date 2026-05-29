/**
 * Helpers that translate the free-form strings written into
 * `integration_sync_logs.errorMessage` by the historical-backfill writers
 * (`backfillGoogleAdsCampaigns`, `backfillServiceTitanJobs`,
 * `backfillMetaCampaigns`) into structured shapes the Settings panel can
 * render without a wall of stack-trace-y text.
 *
 * Two distinct kinds of strings live in `errorMessage`:
 *
 *   1. While running, the writer stashes a chunk-progress string like
 *      `chunk 2/13: 2025-04-01 → 2025-04-30`. We parse that into
 *      {currentChunk, totalChunks, windowStart, windowEnd, percent} so the
 *      UI can render a real progress bar.
 *   2. On failure, the writer either stores a raw upstream error message
 *      (e.g. `Google Ads API quota exceeded`, `ServiceTitan API error
 *      (401): unauthorized`) or a `partial: <inner message>` string when a
 *      later chunk threw mid-run. We classify the message into a
 *      stable error code with a friendly summary and a concrete next-step
 *      hint so a non-technical operator knows what to do.
 *
 * Both shapes carry the original raw string in `raw` so the panel can still
 * surface it in a "details" affordance for engineers who need it.
 */

export type BackfillProgressKind = "chunk" | "partial" | "other";

export interface BackfillProgressDetail {
  raw: string;
  kind: BackfillProgressKind;
  /** 1-based chunk index when kind === "chunk". */
  currentChunk: number | null;
  /** Total chunks when kind === "chunk". */
  totalChunks: number | null;
  /** Inclusive window start (YYYY-MM-DD) when kind === "chunk". */
  windowStart: string | null;
  /** Inclusive window end (YYYY-MM-DD) when kind === "chunk". */
  windowEnd: string | null;
  /** 0-100 integer percent when kind === "chunk", else null. */
  percent: number | null;
  /** Inner message when kind === "partial". */
  partialReason: string | null;
  /** Human-readable phase of the in-flight chunk ("generating report",
   *  "downloading results", "saving results") for backfills that report one
   *  (currently the Meta async backfill). Null when the writer doesn't stamp a
   *  phase (legacy rows, the synchronous Google Ads backfill). */
  phase: string | null;
}

export type BackfillErrorCode =
  | "rate_limit"
  | "expired_credentials"
  | "permission_denied"
  | "not_configured"
  | "paused"
  | "already_running"
  | "tenant_not_found"
  | "upstream_server_error"
  | "network"
  | "timeout"
  | "unknown";

export interface BackfillErrorDetail {
  raw: string;
  code: BackfillErrorCode;
  /** One-sentence human-readable summary suitable for the Settings panel. */
  message: string;
  /** Concrete next step the operator can take. */
  suggestedAction: string;
  /** True if this error came out of the inner `partial: …` writer, meaning
   *  some rows were already persisted before the chunk failed. */
  partial: boolean;
}

const CHUNK_PROGRESS_RE = /^\s*chunk\s+(\d+)\s*\/\s*(\d+)\s*:\s*(\d{4}-\d{2}-\d{2})\s*(?:→|->|—)\s*(\d{4}-\d{2}-\d{2})\s*$/i;

/**
 * Parse a backfill progress / errorMessage string into a structured shape.
 * Returns null if the input is null/undefined/empty.
 */
export function parseBackfillProgress(raw: string | null | undefined): BackfillProgressDetail | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const partialMatch = /^partial\s*:\s*(.*)$/is.exec(trimmed);
  if (partialMatch) {
    return {
      raw: trimmed,
      kind: "partial",
      currentChunk: null,
      totalChunks: null,
      windowStart: null,
      windowEnd: null,
      percent: null,
      partialReason: partialMatch[1].trim() || null,
      phase: null,
    };
  }

  const m = CHUNK_PROGRESS_RE.exec(trimmed);
  if (m) {
    const current = Number(m[1]);
    const total = Number(m[2]);
    const percent = total > 0
      ? Math.max(0, Math.min(100, Math.round(((current - 1) / total) * 100)))
      : null;
    return {
      raw: trimmed,
      kind: "chunk",
      currentChunk: Number.isFinite(current) ? current : null,
      totalChunks: Number.isFinite(total) ? total : null,
      windowStart: m[3],
      windowEnd: m[4],
      percent,
      partialReason: null,
      phase: null,
    };
  }

  return {
    raw: trimmed,
    kind: "other",
    currentChunk: null,
    totalChunks: null,
    windowStart: null,
    windowEnd: null,
    percent: null,
    partialReason: null,
    phase: null,
  };
}

interface Rule {
  code: BackfillErrorCode;
  test: RegExp;
  message: string;
  suggestedAction: string;
}

// Order matters: more-specific rules first. The first matching rule wins.
const RULES: Rule[] = [
  {
    code: "tenant_not_found",
    test: /\btenant not found\b/i,
    message: "Tenant not found.",
    suggestedAction: "Pick a different tenant from the selector and retry.",
  },
  {
    code: "already_running",
    test: /already running\b/i,
    message: "Another sync is already running for this tenant.",
    suggestedAction: "Wait for the in-flight sync to finish, then retry.",
  },
  {
    code: "paused",
    test: /\bpaused\b/i,
    message: "Sync is paused for this tenant.",
    suggestedAction: "Resume the integration in the tenant settings before backfilling.",
  },
  {
    code: "not_configured",
    test: /\bnot configured\b/i,
    message: "Integration credentials are missing.",
    suggestedAction: "Add the missing credentials in the tenant's integration settings, then retry.",
  },
  {
    code: "rate_limit",
    // Includes Meta Graph rate-limit phrasing — codes 4, 17, 32, 613 come
    // back with `type: "OAuthException"` and messages like "User request
    // limit reached" / "Application request limit reached" / "(#17) …".
    test: /\b(rate ?limit(?:ed|ing)?|quota (?:exceeded|exhausted)|too many requests|429|RESOURCE_EXHAUSTED|(?:user|application|api call) request limit reached|request limit reached|calls? to this api have exceeded|\(#(?:4|17|32|613)\))\b/i,
    message: "The upstream API rate-limited or exceeded its quota.",
    suggestedAction: "Wait a few minutes and retry. If it keeps failing, run the backfill in a smaller day range.",
  },
  {
    code: "expired_credentials",
    test: /\b(invalid_grant|expired|token expired|unauthorized|needs reconnect|re-?authent|401|ServiceTitan auth failed)\b/i,
    message: "Upstream credentials expired or were revoked.",
    suggestedAction: "Reconnect the integration in the tenant settings, then retry the backfill.",
  },
  {
    // ServiceTitan returns 404 "Unable to match incoming request to an
    // operation" when the tenant ID, API base, or app key is wrong — NOT
    // when a single record is missing. Treat as configuration error.
    code: "not_configured",
    test: /\b(404|not found|Unable to match incoming request)\b/i,
    message: "Upstream API rejected the request as 404 — usually a tenant ID, app key, or API scope misconfiguration.",
    suggestedAction: "Verify the ServiceTitan tenant ID, app key, and that the connected app has JPM + CRM scopes, then retry.",
  },
  {
    code: "permission_denied",
    test: /\b400\b|\bbad request\b/i,
    message: "Upstream API rejected the request as malformed (400).",
    suggestedAction: "Usually indicates an unsupported filter (date range too wide, invalid status). Try a smaller backfill window.",
  },
  {
    code: "permission_denied",
    test: /\b(permission[_ ]denied|forbidden|insufficient (?:permissions|scope)|access denied|403)\b/i,
    message: "The connected account doesn't have permission for this data.",
    suggestedAction: "Check the upstream account's role/scopes (e.g. report access on the ad account), then retry.",
  },
  {
    code: "timeout",
    test: /\b(ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out|request timeout|deadline exceeded|504)\b/i,
    message: "The upstream API timed out.",
    suggestedAction: "Retry with a smaller day range so each chunk finishes faster.",
  },
  {
    code: "network",
    test: /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up)\b/i,
    message: "Network error talking to the upstream API.",
    suggestedAction: "Retry in a moment. Persistent failures usually clear within a few minutes.",
  },
  {
    code: "upstream_server_error",
    test: /\b(API (?:error )?\(?5\d{2}\)?|5\d{2}\b|internal server error|service unavailable|bad gateway)\b/i,
    message: "The upstream API returned a server error.",
    suggestedAction: "This is on the upstream provider. Wait a few minutes and retry.",
  },
];

/**
 * Classify a raw upstream/backfill error message into a stable code with a
 * friendly summary + suggested next action.
 *
 * `null` / empty input returns null. A `partial: …` prefix is unwrapped
 * before classification, and the resulting detail's `partial` flag is set
 * so the UI can communicate that some rows did land before the failure.
 */
export function classifyBackfillError(raw: string | null | undefined): BackfillErrorDetail | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  let inner = trimmed;
  let partial = false;
  const partialMatch = /^partial\s*:\s*(.*)$/is.exec(trimmed);
  if (partialMatch) {
    partial = true;
    inner = partialMatch[1].trim() || trimmed;
  }

  for (const rule of RULES) {
    if (rule.test.test(inner)) {
      return {
        raw: trimmed,
        code: rule.code,
        message: partial ? `Partial backfill: ${rule.message}` : rule.message,
        suggestedAction: rule.suggestedAction,
        partial,
      };
    }
  }

  return {
    raw: trimmed,
    code: "unknown",
    message: partial
      ? "Partial backfill: the upstream API returned an unexpected error."
      : "The upstream API returned an unexpected error.",
    suggestedAction: "Retry the backfill. If it fails again, check the recent sync activity for the raw error.",
    partial,
  };
}
