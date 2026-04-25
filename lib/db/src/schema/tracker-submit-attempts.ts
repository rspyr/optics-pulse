import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { attributionEventsTable } from "./attribution-events";

/**
 * Audit log of every inbound /api/collect/submit, /api/collect/heartbeat, and
 * /api/collect/diagnostics call.
 *
 * Written *before* schema validation so that even malformed payloads (e.g. the
 * silent-400 schema regression on Apr 2026 that hid Vance Heating's lead Jenna
 * Record) still appear in this table. This is the single source of truth used
 * by Verify Tracker's "submit attempts" panel and the Tracker Health view.
 *
 * Outcomes are written best-effort and never block the request lifecycle —
 * a failure to log must NEVER break ingestion.
 */
export const trackerSubmitAttemptsTable = pgTable("tracker_submit_attempts", {
  id: serial("id").primaryKey(),
  // Best-effort tenant resolution from the inbound payload. Null when the
  // client_id is missing or unknown — those rows are still useful diagnostics.
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  clientId: text("client_id"),
  // 'submit' | 'heartbeat' (legacy, preserved for back-compat queries).
  // New code prefers `kind`.
  endpoint: text("endpoint").notNull(),
  // 'submit' | 'heartbeat' | 'diagnostic'. Diagnostic rows come from the
  // /api/collect/diagnostics endpoint that pulse.js posts to when run in
  // ?pulse_capture=1 mode (form scans, postMessage observations, click events).
  kind: text("kind").notNull().default("submit"),
  // Hostname the request came from (Origin header or payload-provided domain).
  // Lowercased for cheap matching against tracker_heartbeats.domain.
  domain: text("domain"),
  // Raw Origin header from the request (e.g. "https://vance.example.com").
  // Distinct from `domain` because some calls have no Origin (server-to-server)
  // or a mismatching one (script proxied through a different origin).
  origin: text("origin"),
  pageUrl: text("page_url"),
  userAgent: text("user_agent"),
  // Content-Length header value in bytes. Useful for spotting payloads that
  // were truncated by an upstream proxy or that are pathologically large.
  contentLength: integer("content_length"),
  // Just the field NAMES the customer's form submitted, no values. Lets us
  // see "the form sends 'Email' but our extractor expects 'email_address'"
  // without storing PII.
  suppliedFieldNames: jsonb("supplied_field_names"),
  // Outcome of the request from the API server's perspective. Status text is
  // intentionally a free-form string so we can grow new outcomes without a
  // migration ('accepted', 'invalid_payload', 'unknown_client', 'duplicate',
  // 'resubmitted', 'rate_limited', 'server_error', 'diagnostic_recorded').
  outcome: text("outcome").notNull(),
  httpStatus: integer("http_status").notNull(),
  // Short human-readable explanation surfaced in the UI. For invalid_payload
  // we put the Zod error string here so a customer-success engineer can
  // diagnose without checking server logs.
  message: text("message"),
  // Pulse.js client version (set via `data-version` or window.__pulseVersion).
  // Helps us tie a regression in this table to a specific pulse.js rollout.
  pulseVersion: text("pulse_version"),
  // The created attribution_events.id, when one was successfully written.
  attributionEventId: integer("attribution_event_id").references(() => attributionEventsTable.id),
  // Truncated raw payload (≤4 KB) for diagnostics. Never includes raw PII
  // values — the API handler is responsible for redacting before insert.
  payloadSample: jsonb("payload_sample"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  byTenantCreated: index("tsa_tenant_created_idx").on(t.tenantId, t.createdAt),
  byDomainCreated: index("tsa_domain_created_idx").on(t.domain, t.createdAt),
  byOutcome: index("tsa_outcome_idx").on(t.outcome),
  byKindCreated: index("tsa_kind_created_idx").on(t.kind, t.createdAt),
}));

export type TrackerSubmitAttempt = typeof trackerSubmitAttemptsTable.$inferSelect;
export type NewTrackerSubmitAttempt = typeof trackerSubmitAttemptsTable.$inferInsert;
