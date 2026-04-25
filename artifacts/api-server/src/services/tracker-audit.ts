import { db, trackerSubmitAttemptsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Request } from "express";

/**
 * Centralised "did this tracker submit ever even *try*" audit log.
 *
 * Why this exists: in April 2026 a schema change silently 400'd every
 * /api/collect/submit call for ~3 weeks before anyone noticed (Vance
 * Heating's missing Jenna Record lead). The heartbeat endpoint was fine,
 * so System Health stayed green and we had no signal that submits were
 * dying. This module is the trip-wire that catches the next one
 * within seconds instead of weeks.
 *
 * Every call to /api/collect/submit and /api/collect/heartbeat MUST
 * write a row here, written *before* schema validation so even malformed
 * payloads still appear. All inserts are best-effort: failure to log
 * MUST NEVER break the request.
 */

const PAYLOAD_SAMPLE_MAX_BYTES = 4 * 1024;

export type TrackerOutcome =
  | "accepted"
  | "duplicate"
  | "resubmitted"
  | "invalid_payload"
  | "unknown_client"
  | "missing_client_id"
  | "rate_limited"
  | "server_error";

export interface TrackerAuditInput {
  endpoint: "submit" | "heartbeat";
  req: Request;
  body: unknown;
  // Best-effort tenant resolution at the time of logging. Fill in later
  // via `updateAttempt` once the tenant has been resolved from client_id.
  tenantId?: number | null;
  clientId?: string | null;
  domain?: string | null;
  pageUrl?: string | null;
  outcome: TrackerOutcome;
  httpStatus: number;
  message?: string | null;
  attributionEventId?: number | null;
}

/**
 * Strip values that look like raw PII from the payload sample so we never
 * persist contact details into a diagnostic table. Two layers of defence:
 *
 * 1. Field-name match: anything with a likely-PII key has its value
 *    replaced with "<redacted>". Covers full-word + common short aliases
 *    (fname/lname/fn/ln/addr1/addr2/phn/em) and common "your_*" prefixes.
 * 2. Value-pattern scrub: even for non-PII keys, free-text values are
 *    scanned for embedded emails / phone-like / SSN-like sequences and
 *    those substrings are masked. This catches PII leaking through
 *    "comments", "notes", "message", or unknown custom fields.
 */
const PII_FIELD_NAME_PATTERN = /(email|e[-_ ]?mail|\bemail_?address\b|phone|\bphn\b|\btel\b|mobile|cell|fax|first.?name|last.?name|full.?name|\bfname\b|\blname\b|\bfn\b|\bln\b|\bname\b|address|addr|\baddr1\b|\baddr2\b|street|\bcity\b|\bstate\b|zip|postal|country|ssn|tax.?id|dob|birth|gender|age|\bdl\b|driver|passport|account.?number|card.?number|\bcvv\b|credit|password|secret|token)/i;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 10–15 digits with optional separators. Not a strict E.164 — intentionally
// loose to catch "(555) 123-4567", "555.123.4567", "+1 555 123 4567" etc.
const PHONE_PATTERN = /(?:\+?\d[\s.\-()]*){10,15}/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

function scrubValuePatterns(s: string): string {
  return s
    .replace(EMAIL_PATTERN, "<redacted-email>")
    .replace(SSN_PATTERN, "<redacted-ssn>")
    .replace(PHONE_PATTERN, (m) => {
      // Don't mask short digit runs that happen to match (e.g. order numbers
      // of 10+ digits with no separators are usually IDs not phone numbers,
      // but we mask anyway since the cost of a false-mask in a diagnostic
      // sample is ~zero compared to leaking a real phone number).
      const digits = m.replace(/\D/g, "");
      if (digits.length < 10) return m;
      // Preserve any trailing whitespace the greedy match swallowed so the
      // surrounding text remains readable in diagnostic output.
      const trailingWs = m.match(/\s+$/)?.[0] ?? "";
      return "<redacted-phone>" + trailingWs;
    });
}

function redactPii(value: unknown, depth = 0): unknown {
  if (depth > 4) return "<truncated>";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Cap individual string length so a single ginormous field can't blow the limit.
    const capped = value.length > 500 ? value.slice(0, 500) + "…" : value;
    return scrubValuePatterns(capped);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redactPii(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ > 50) { out["…"] = "<truncated>"; break; }
      if (PII_FIELD_NAME_PATTERN.test(k)) {
        out[k] = v === null || v === undefined || v === "" ? v : "<redacted>";
      } else {
        out[k] = redactPii(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function buildPayloadSample(body: unknown): unknown {
  try {
    const redacted = redactPii(body);
    const json = JSON.stringify(redacted);
    if (!json) return null;
    if (json.length <= PAYLOAD_SAMPLE_MAX_BYTES) return redacted;
    return { _truncated: true, _bytes: json.length, sample: json.slice(0, PAYLOAD_SAMPLE_MAX_BYTES) };
  } catch {
    return { _error: "could not serialize payload" };
  }
}

function pickHeader(req: Request, name: string): string | null {
  const h = req.headers[name.toLowerCase()];
  if (Array.isArray(h)) return h[0] || null;
  return typeof h === "string" ? h : null;
}

function deriveDomain(req: Request, body: unknown, explicit: string | null | undefined): string | null {
  if (explicit) return explicit.toLowerCase();
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const fromBody = typeof b.domain === "string" ? b.domain : null;
  if (fromBody) return fromBody.toLowerCase();
  const origin = pickHeader(req, "origin") || pickHeader(req, "referer");
  if (!origin) return null;
  try { return new URL(origin).hostname.toLowerCase(); } catch { return null; }
}

function derivePageUrl(req: Request, body: unknown, explicit: string | null | undefined): string | null {
  if (explicit) return explicit;
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const fromBody = typeof b.pageUrl === "string" ? b.pageUrl
    : typeof b.page_url === "string" ? b.page_url
    : null;
  if (fromBody) return fromBody;
  return pickHeader(req, "referer") || pickHeader(req, "referrer");
}

/**
 * Insert an audit row. Returns the new row id, or null on insert failure
 * (failure is logged to console but never thrown — ingestion must not
 * regress because of an audit miss).
 */
export async function logTrackerAttempt(input: TrackerAuditInput): Promise<number | null> {
  try {
    const [row] = await db.insert(trackerSubmitAttemptsTable).values({
      tenantId: input.tenantId ?? null,
      clientId: input.clientId ?? null,
      endpoint: input.endpoint,
      domain: deriveDomain(input.req, input.body, input.domain),
      pageUrl: derivePageUrl(input.req, input.body, input.pageUrl),
      userAgent: pickHeader(input.req, "user-agent"),
      outcome: input.outcome,
      httpStatus: input.httpStatus,
      message: input.message ?? null,
      pulseVersion: pickHeader(input.req, "x-pulse-version"),
      attributionEventId: input.attributionEventId ?? null,
      payloadSample: buildPayloadSample(input.body),
    }).returning({ id: trackerSubmitAttemptsTable.id });
    return row?.id ?? null;
  } catch (err) {
    console.warn("[tracker-audit] failed to write audit row", err);
    return null;
  }
}

/**
 * Patch a previously-logged audit row once the request resolves to a
 * better outcome (e.g. payload validated, tenant resolved, lead inserted).
 * Best-effort; never throws.
 */
export async function updateTrackerAttempt(
  id: number | null,
  patch: Partial<{
    tenantId: number | null;
    clientId: string | null;
    outcome: TrackerOutcome;
    httpStatus: number;
    message: string | null;
    attributionEventId: number | null;
  }>,
): Promise<void> {
  if (!id) return;
  try {
    await db.update(trackerSubmitAttemptsTable)
      .set(patch)
      .where(eq(trackerSubmitAttemptsTable.id, id));
  } catch (err) {
    console.warn("[tracker-audit] failed to update audit row", id, err);
  }
}
