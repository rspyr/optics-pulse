import { db, trackerSubmitAttemptsTable, tenantsTable } from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Request } from "express";

/**
 * Audit log of every /api/collect/submit + /heartbeat + /diagnostics call.
 * Inserts run BEFORE schema validation so malformed payloads still appear,
 * and are best-effort — a logging failure must never break ingestion.
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
  | "server_error"
  | "diagnostic_recorded";

export type TrackerKind = "submit" | "heartbeat" | "diagnostic";

export interface TrackerAuditInput {
  // legacy field; mirrored from `kind` for back-compat
  endpoint: "submit" | "heartbeat";
  kind?: TrackerKind;
  req: Request;
  body: unknown;
  // best-effort; updateAttempt fills it in later if not yet known
  tenantId?: number | null;
  clientId?: string | null;
  domain?: string | null;
  pageUrl?: string | null;
  outcome: TrackerOutcome;
  httpStatus: number;
  message?: string | null;
  attributionEventId?: number | null;
}

export interface TrackerDiagnosticInput {
  req: Request;
  body: unknown;
  tenantId?: number | null;
  clientId?: string | null;
  domain?: string | null;
  pageUrl?: string | null;
  httpStatus: number;
  outcome: TrackerOutcome;
  message?: string | null;
}

/** Redact PII from payload sample: field-name match + value-pattern scrub. */
const PII_FIELD_NAME_PATTERN = /(email|e[-_ ]?mail|\bemail_?address\b|phone|\bphn\b|\btel\b|mobile|cell|fax|first.?name|last.?name|full.?name|\bfname\b|\blname\b|\bfn\b|\bln\b|\bname\b|address|addr|\baddr1\b|\baddr2\b|street|\bcity\b|\bstate\b|zip|postal|country|ssn|tax.?id|dob|birth|gender|age|\bdl\b|driver|passport|account.?number|card.?number|\bcvv\b|credit|password|secret|token)/i;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// loose phone regex: 10–15 digits with optional separators
const PHONE_PATTERN = /(?:\+?\d[\s.\-()]*){10,15}/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

function scrubValuePatterns(s: string): string {
  return s
    .replace(EMAIL_PATTERN, "<redacted-email>")
    .replace(SSN_PATTERN, "<redacted-ssn>")
    .replace(PHONE_PATTERN, (m) => {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 10) return m;
      const trailingWs = m.match(/\s+$/)?.[0] ?? "";
      return "<redacted-phone>" + trailingWs;
    });
}

function redactPii(value: unknown, depth = 0): unknown {
  if (depth > 4) return "<truncated>";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
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

function parseContentLength(req: Request): number | null {
  const raw = pickHeader(req, "content-length");
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Extract field NAMES (not values) from body: top-level keys of fields/
 * custom/form plus form-scan field names from diagnostics.formScans[].
 */
function extractSuppliedFieldNames(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const out = new Set<string>();
  const b = body as Record<string, unknown>;
  for (const bucket of ["fields", "custom", "form"]) {
    const v = b[bucket];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        if (out.size >= 100) break;
        out.add(`${bucket}.${k}`);
      }
    }
  }
  const diag = b.diagnostics;
  if (diag && typeof diag === "object") {
    const scans = (diag as Record<string, unknown>).formScans;
    if (Array.isArray(scans)) {
      for (const scan of scans.slice(0, 20)) {
        if (scan && typeof scan === "object") {
          const fields = (scan as Record<string, unknown>).fields;
          if (Array.isArray(fields)) {
            for (const f of fields.slice(0, 50)) {
              if (out.size >= 100) break;
              if (f && typeof f === "object") {
                const name = (f as Record<string, unknown>).name;
                if (typeof name === "string" && name) out.add(`scan.${name}`);
              }
            }
          }
        }
      }
    }
  }
  if (out.size === 0) return null;
  return Array.from(out);
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

/** Insert an audit row. Best-effort — never throws. */
export async function logTrackerAttempt(input: TrackerAuditInput): Promise<number | null> {
  try {
    const kind: TrackerKind = input.kind ?? input.endpoint;
    const [row] = await db.insert(trackerSubmitAttemptsTable).values({
      tenantId: input.tenantId ?? null,
      clientId: input.clientId ?? null,
      endpoint: input.endpoint,
      kind,
      domain: deriveDomain(input.req, input.body, input.domain),
      origin: pickHeader(input.req, "origin"),
      pageUrl: derivePageUrl(input.req, input.body, input.pageUrl),
      userAgent: pickHeader(input.req, "user-agent"),
      contentLength: parseContentLength(input.req),
      suppliedFieldNames: extractSuppliedFieldNames(input.body),
      outcome: input.outcome,
      httpStatus: input.httpStatus,
      message: input.message ?? null,
      pulseVersion: pickHeader(input.req, "x-pulse-version"),
      attributionEventId: input.attributionEventId ?? null,
      // payload_sample never persisted (field-names-only audit policy)
      payloadSample: null,
    }).returning({ id: trackerSubmitAttemptsTable.id });
    return row?.id ?? null;
  } catch (err) {
    console.warn("[tracker-audit] failed to write audit row", err);
    return null;
  }
}

/** Audit row from /api/collect/diagnostics (capture mode). kind='diagnostic'. */
export async function logTrackerDiagnostic(input: TrackerDiagnosticInput): Promise<number | null> {
  try {
    const [row] = await db.insert(trackerSubmitAttemptsTable).values({
      tenantId: input.tenantId ?? null,
      clientId: input.clientId ?? null,
      endpoint: "submit",
      kind: "diagnostic",
      domain: deriveDomain(input.req, input.body, input.domain),
      origin: pickHeader(input.req, "origin"),
      pageUrl: derivePageUrl(input.req, input.body, input.pageUrl),
      userAgent: pickHeader(input.req, "user-agent"),
      contentLength: parseContentLength(input.req),
      suppliedFieldNames: extractSuppliedFieldNames(input.body),
      outcome: input.outcome,
      httpStatus: input.httpStatus,
      message: input.message ?? null,
      pulseVersion: pickHeader(input.req, "x-pulse-version"),
      payloadSample: null,
    }).returning({ id: trackerSubmitAttemptsTable.id });
    return row?.id ?? null;
  } catch (err) {
    console.warn("[tracker-audit] failed to write diagnostic row", err);
    return null;
  }
}

// Read helpers used by Verify Tracker / Tracker Health views.

export interface DomainStatusBreakdown {
  // Counts of submit-kind rows in the window, bucketed by HTTP status range.
  submitOk: number;        // 2xx
  submitClientError: number; // 4xx (non-429)
  submitRateLimited: number; // 429
  submitServerError: number; // 5xx
  total: number;
}

/** Per-HTTP-status breakdown of /collect/submit attempts for a domain. */
export async function getDomainSubmitBreakdown(args: {
  domain: string;
  windowHours: number;
  tenantIds?: number[]; // visibility filter — empty array means no rows visible
}): Promise<DomainStatusBreakdown> {
  const { domain, windowHours, tenantIds } = args;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const empty: DomainStatusBreakdown = {
    submitOk: 0, submitClientError: 0, submitRateLimited: 0, submitServerError: 0, total: 0,
  };
  if (tenantIds && tenantIds.length === 0) return empty;
  try {
    const conds = [
      eq(trackerSubmitAttemptsTable.domain, domain.toLowerCase()),
      eq(trackerSubmitAttemptsTable.kind, "submit"),
      gte(trackerSubmitAttemptsTable.createdAt, since),
    ];
    if (tenantIds && tenantIds.length > 0) {
      conds.push(sql`${trackerSubmitAttemptsTable.tenantId} = ANY(${tenantIds})`);
    }
    const rows = await db
      .select({ httpStatus: trackerSubmitAttemptsTable.httpStatus })
      .from(trackerSubmitAttemptsTable)
      .where(and(...conds));
    const out = { ...empty };
    for (const r of rows) {
      out.total++;
      const s = r.httpStatus;
      if (s >= 200 && s < 300) out.submitOk++;
      else if (s === 429) out.submitRateLimited++;
      else if (s >= 400 && s < 500) out.submitClientError++;
      else if (s >= 500) out.submitServerError++;
    }
    return out;
  } catch (err) {
    console.warn("[tracker-audit] getDomainSubmitBreakdown failed", err);
    return empty;
  }
}

/**
 * Per-tenant rollup: one row per (tenant, domain) over the last 30 days
 * with last submit, last heartbeat, status buckets, and recent attempts.
 */
export interface DomainHealthRow {
  domain: string;
  tenantId: number | null;
  tenantName: string | null;
  lastSubmitAt: Date | null;
  lastSubmitStatus: number | null;
  lastSubmitOutcome: string | null;
  submitCount24h: number;
  submitCount7d: number;
  // pulse=heartbeat+version, unknown=heartbeat+no-version, no-tracker=no heartbeat
  scriptSource: "pulse" | "unknown" | "no-tracker";
  lastPulseVersion: string | null;
  lastHeartbeatAt: Date | null;
  statusBuckets24h: { s200: number; s400: number; s404: number; s429: number; s500: number; other: number };
  statusBuckets7d: { s200: number; s400: number; s404: number; s429: number; s500: number; other: number };
  recentAttempts: Array<{
    createdAt: string;
    kind: string;
    endpoint: string;
    httpStatus: number;
    outcome: string;
    message: string | null;
    origin: string | null;
    contentLength: number | null;
  }>;
}

export async function getDomainHealthRollup(args: {
  tenantIds?: number[];
  limit?: number;
}): Promise<DomainHealthRow[]> {
  const limit = args.limit ?? 100;
  if (args.tenantIds && args.tenantIds.length === 0) return [];
  try {
    const tenantFilter = args.tenantIds && args.tenantIds.length > 0
      ? sql`AND tsa.tenant_id = ANY(${args.tenantIds}::int[])`
      : sql``;
    const result = await db.execute(sql`
      WITH recent AS (
        SELECT DISTINCT tsa.tenant_id, tsa.domain
        FROM tracker_submit_attempts tsa
        WHERE tsa.created_at > NOW() - INTERVAL '30 days'
          AND tsa.domain IS NOT NULL
          ${tenantFilter}
      ),
      last_submit AS (
        SELECT DISTINCT ON (tsa.tenant_id, tsa.domain)
          tsa.tenant_id, tsa.domain, tsa.created_at, tsa.http_status, tsa.outcome
        FROM tracker_submit_attempts tsa
        WHERE tsa.kind = 'submit'
          AND tsa.created_at > NOW() - INTERVAL '30 days'
          ${tenantFilter}
        ORDER BY tsa.tenant_id, tsa.domain, tsa.created_at DESC
      ),
      last_heartbeat AS (
        SELECT DISTINCT ON (tsa.tenant_id, tsa.domain)
          tsa.tenant_id, tsa.domain, tsa.created_at AS hb_at, tsa.pulse_version
        FROM tracker_submit_attempts tsa
        WHERE tsa.kind = 'heartbeat'
          AND tsa.created_at > NOW() - INTERVAL '30 days'
          ${tenantFilter}
        ORDER BY tsa.tenant_id, tsa.domain, tsa.created_at DESC
      )
      SELECT
        r.domain,
        r.tenant_id,
        t.name AS tenant_name,
        ls.created_at AS last_submit_at,
        ls.http_status AS last_submit_status,
        ls.outcome AS last_submit_outcome,
        lh.hb_at AS last_heartbeat_at,
        lh.pulse_version AS last_pulse_version,
        (SELECT COUNT(*) FROM tracker_submit_attempts a
          WHERE a.kind = 'submit' AND a.domain = r.domain
            AND (a.tenant_id = r.tenant_id OR (a.tenant_id IS NULL AND r.tenant_id IS NULL))
            AND a.created_at > NOW() - INTERVAL '24 hours') AS submit_count_24h,
        (SELECT COUNT(*) FROM tracker_submit_attempts a
          WHERE a.kind = 'submit' AND a.domain = r.domain
            AND (a.tenant_id = r.tenant_id OR (a.tenant_id IS NULL AND r.tenant_id IS NULL))
            AND a.created_at > NOW() - INTERVAL '7 days') AS submit_count_7d,
        (SELECT json_build_object(
            's200', COUNT(*) FILTER (WHERE a.http_status = 200),
            's400', COUNT(*) FILTER (WHERE a.http_status = 400),
            's404', COUNT(*) FILTER (WHERE a.http_status = 404),
            's429', COUNT(*) FILTER (WHERE a.http_status = 429),
            's500', COUNT(*) FILTER (WHERE a.http_status >= 500),
            'other', COUNT(*) FILTER (WHERE a.http_status NOT IN (200,400,404,429) AND a.http_status < 500)
          )
          FROM tracker_submit_attempts a
          WHERE a.kind = 'submit' AND a.domain = r.domain
            AND (a.tenant_id = r.tenant_id OR (a.tenant_id IS NULL AND r.tenant_id IS NULL))
            AND a.created_at > NOW() - INTERVAL '24 hours') AS status_buckets_24h,
        (SELECT json_build_object(
            's200', COUNT(*) FILTER (WHERE a.http_status = 200),
            's400', COUNT(*) FILTER (WHERE a.http_status = 400),
            's404', COUNT(*) FILTER (WHERE a.http_status = 404),
            's429', COUNT(*) FILTER (WHERE a.http_status = 429),
            's500', COUNT(*) FILTER (WHERE a.http_status >= 500),
            'other', COUNT(*) FILTER (WHERE a.http_status NOT IN (200,400,404,429) AND a.http_status < 500)
          )
          FROM tracker_submit_attempts a
          WHERE a.kind = 'submit' AND a.domain = r.domain
            AND (a.tenant_id = r.tenant_id OR (a.tenant_id IS NULL AND r.tenant_id IS NULL))
            AND a.created_at > NOW() - INTERVAL '7 days') AS status_buckets_7d,
        (SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (
            SELECT a.created_at, a.kind, a.endpoint, a.http_status,
                   a.outcome, a.message, a.origin, a.content_length
            FROM tracker_submit_attempts a
            WHERE a.domain = r.domain
              AND (a.tenant_id = r.tenant_id OR (a.tenant_id IS NULL AND r.tenant_id IS NULL))
              AND a.created_at > NOW() - INTERVAL '7 days'
            ORDER BY a.created_at DESC LIMIT 5
          ) x) AS recent_attempts
      FROM recent r
      LEFT JOIN tenants t ON t.id = r.tenant_id
      LEFT JOIN last_submit ls
        ON ls.domain = r.domain
       AND (ls.tenant_id = r.tenant_id OR (ls.tenant_id IS NULL AND r.tenant_id IS NULL))
      LEFT JOIN last_heartbeat lh
        ON lh.domain = r.domain
       AND (lh.tenant_id = r.tenant_id OR (lh.tenant_id IS NULL AND r.tenant_id IS NULL))
      ORDER BY ls.created_at DESC NULLS LAST
      LIMIT ${limit}
    `);
    const rows = (result as unknown as { rows: Array<{
      domain: string;
      tenant_id: number | null;
      tenant_name: string | null;
      last_submit_at: Date | null;
      last_submit_status: number | null;
      last_submit_outcome: string | null;
      last_heartbeat_at: Date | null;
      last_pulse_version: string | null;
      submit_count_24h: string | number;
      submit_count_7d: string | number;
      status_buckets_24h: Record<string, number> | null;
      status_buckets_7d: Record<string, number> | null;
      recent_attempts: Array<{
        created_at: string;
        kind: string;
        endpoint: string;
        http_status: number;
        outcome: string;
        message: string | null;
        origin: string | null;
        content_length: number | null;
      }> | null;
    }> }).rows ?? [];
    const toBuckets = (b: Record<string, number> | null) => ({
      s200: Number(b?.s200) || 0,
      s400: Number(b?.s400) || 0,
      s404: Number(b?.s404) || 0,
      s429: Number(b?.s429) || 0,
      s500: Number(b?.s500) || 0,
      other: Number(b?.other) || 0,
    });
    const deriveScriptSource = (hbAt: Date | null, pv: string | null): "pulse" | "unknown" | "no-tracker" => {
      if (!hbAt) return "no-tracker";
      return pv ? "pulse" : "unknown";
    };
    return rows.map(r => ({
      domain: r.domain,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      lastSubmitAt: r.last_submit_at,
      lastSubmitStatus: r.last_submit_status,
      lastSubmitOutcome: r.last_submit_outcome,
      lastHeartbeatAt: r.last_heartbeat_at,
      lastPulseVersion: r.last_pulse_version,
      scriptSource: deriveScriptSource(r.last_heartbeat_at, r.last_pulse_version),
      submitCount24h: Number(r.submit_count_24h) || 0,
      submitCount7d: Number(r.submit_count_7d) || 0,
      statusBuckets24h: toBuckets(r.status_buckets_24h),
      statusBuckets7d: toBuckets(r.status_buckets_7d),
      recentAttempts: (r.recent_attempts ?? []).map(a => ({
        createdAt: a.created_at,
        kind: a.kind,
        endpoint: a.endpoint,
        httpStatus: a.http_status,
        outcome: a.outcome,
        message: a.message,
        origin: a.origin,
        contentLength: a.content_length,
      })),
    }));
  } catch (err) {
    console.warn("[tracker-audit] getDomainHealthRollup failed", err);
    return [];
  }
}

/**
 * Daily retention sweep. Deletes rows older than `retentionDays` (default
 * 30). Returns the number of rows pruned. Best-effort; never throws.
 *
 * Why 30 days: this table is purely diagnostic — anything older than a
 * month is essentially never read. At a baseline 10k rows/day across all
 * tenants the table would otherwise grow ~14 GB/year.
 */
export async function pruneOldTrackerAttempts(retentionDays = 30): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await db.delete(trackerSubmitAttemptsTable)
      .where(sql`${trackerSubmitAttemptsTable.createdAt} < ${cutoff}`)
      .returning({ id: trackerSubmitAttemptsTable.id });
    return result.length;
  } catch (err) {
    console.warn("[tracker-audit] pruneOldTrackerAttempts failed", err);
    return 0;
  }
}

// `tenantsTable` is re-exported for the verify-tracker route to JOIN against.
void tenantsTable;

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
