import { Router, type IRouter } from "express";
import { db, trackerHeartbeatsTable, tenantsTable, attributionEventsTable, leadsTable, funnelTypesTable, tenantFunnelTypesTable, callAttemptsTable } from "@workspace/db";
import { TrackerSubmitBody } from "@workspace/api-zod";
import { eq, and, gte } from "drizzle-orm";
import { z } from "zod";
import { emitNewAttributionEvent } from "../socket";
import { scheduleOrEmitNewLead } from "../services/lead-notify-scheduler";
import { assignLeadRoundRobin } from "../services/round-robin";
import { scheduleAutoPass } from "../services/auto-pass-scheduler";
import { isValidAppointmentValue } from "../utils/appointment-validation";
import { normalizeSource } from "../services/source-normalizer";
import { normalizeAddress } from "../services/reconciliation";
import { trackerSubmitLimiter, trackerHeartbeatLimiter } from "../middleware/rate-limit";
import { detectFields } from "../services/field-detection";
import { normalizeFunnel } from "../services/funnel-normalizer";
import { resolveSubdomainFunnel } from "../services/subdomain-funnel-resolver";
import { hashValue, normalizePhone, hashPhone } from "../lib/phone-utils";
import { handleResubmission } from "../services/lead-resubmission";
import { emitLeadUpdated } from "../socket";
import { logTrackerAttempt, updateTrackerAttempt } from "../services/tracker-audit";

// Pulse.js sends `submitted_at` as an ISO string. The generated Zod schema
// coerces to `Date` (and also accepts `null` since the OpenAPI spec was
// fixed to be nullable); we override here to keep the runtime value as a
// string + null for downstream callers that parse it themselves.
const TrackerSubmitPayload = TrackerSubmitBody.extend({
  submitted_at: z.string().nullish(),
});

const router: IRouter = Router();

async function resolveFunnelType(tenantId: number, funnelSlug: string | null | undefined): Promise<{ name: string; id: number } | null> {
  if (!funnelSlug) return null;
  const [ft] = await db.select().from(funnelTypesTable)
    .where(eq(funnelTypesTable.slug, funnelSlug));
  if (!ft) return null;
  const [assoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, ft.id)));
  if (!assoc) return null;
  return { name: ft.name, id: ft.id };
}

const PII_FIELD_PATTERNS: Record<string, string[]> = {
  firstName: ["first_name", "firstname", "fname", "first-name"],
  lastName: ["last_name", "lastname", "lname", "last-name"],
  email: ["email", "email_address", "emailaddress", "e-mail"],
  phone: ["phone", "phone_number", "phonenumber", "telephone", "tel", "mobile"],
  fullName: ["full_name", "fullname", "name", "your_name", "your-name"],
};

const ADDRESS_FIELD_PATTERNS: Record<string, string[]> = {
  street: ["address", "street", "street_address", "streetaddress", "address1", "address_1", "address_line_1", "addressline1"],
  city: ["city"],
  state: ["state", "province", "region"],
  zip: ["zip", "zipcode", "zip_code", "postal_code", "postalcode", "postal"],
};

function extractAddressFromFields(fields: Record<string, unknown>): string | null {
  const normalized = new Map<string, string>();
  for (const [key, val] of Object.entries(fields)) {
    if (typeof val === "string" && val.trim()) {
      normalized.set(key.toLowerCase().replace(/[\s-]/g, "_"), val.trim());
    }
  }

  const parts: Record<string, string | null> = { street: null, city: null, state: null, zip: null };
  for (const [partKey, patterns] of Object.entries(ADDRESS_FIELD_PATTERNS)) {
    for (const pattern of patterns) {
      const val = normalized.get(pattern);
      if (val) {
        parts[partKey] = val;
        break;
      }
    }
  }

  if (!parts.street && !parts.city) return null;

  const addressParts: string[] = [];
  if (parts.street) addressParts.push(parts.street);
  if (parts.city) addressParts.push(parts.city);
  if (parts.state && parts.zip) {
    addressParts.push(`${parts.state} ${parts.zip}`);
  } else if (parts.state) {
    addressParts.push(parts.state);
  } else if (parts.zip) {
    addressParts.push(parts.zip);
  }

  const raw = addressParts.join(", ");
  return normalizeAddress(raw);
}

// PII-safe field-name list for the Live Attribution Feed AND the historical
// attribution event detail panel. We expose the raw form field NAMES only
// (never values) so operators can map an unrecognised field name (e.g.
// `field_3`) to a semantic target (phone, email, …) without leaving the
// page. Capped to keep the payload bounded. Underscore-prefixed keys are
// internal (e.g. `_custom`) and are excluded.
export const FIELD_NAMES_CAP = 30;

// The `formFields` API contract reserves keys prefixed with `_` (e.g.
// `_custom`, `_consent`, `_source`) for internal bookkeeping. A customer
// form whose <input name> happens to start with `_` would otherwise
// silently overwrite our bookkeeping value when the submission is stored
// — and would also slip past extractFieldNamesForOperator /
// extractFieldEntriesForOperator (which already filter `_*` out), making
// the colliding field invisible to operators. Originally we just dropped
// such keys at ingest; that was lossy. Task #387: instead, namespace the
// offender so the lead keeps the value while still protecting reserved
// keys.
//
// For each underscore-prefixed key we try to RENAME it by stripping the
// leading underscores (`_consent` → `consent`). If the stripped name is
// empty, or already exists on the customer's submission (or has already
// been claimed by a previous rename in this same payload), we fall back
// to NESTING the value under its original key inside a returned bag —
// the caller merges that bag into `_custom` so the value lives at
// `_custom._consent` in the stored fields blob. Reserved internal keys
// still win on collision: the cleaned map never contains `_`-keys, and
// the caller layers the real `body.custom` ON TOP of the nested bag so
// internal bookkeeping always overwrites a customer's lookalike value.
export function stripReservedFieldKeys(
  fields: Record<string, unknown>,
): {
  cleaned: Record<string, unknown>;
  nested: Record<string, unknown>;
  renamed: Array<{ from: string; to: string }>;
} {
  const cleaned: Record<string, unknown> = {};
  const nested: Record<string, unknown> = {};
  const renamed: Array<{ from: string; to: string }> = [];

  // First pass: copy the customer's non-underscore keys verbatim. Doing
  // this up-front gives the second pass a complete view of which target
  // names are already taken so a rename can never silently overwrite a
  // real customer field.
  for (const [k, v] of Object.entries(fields)) {
    if (!k.startsWith("_")) cleaned[k] = v;
  }

  // Second pass: rename or nest each `_`-prefixed key.
  for (const [k, v] of Object.entries(fields)) {
    if (!k.startsWith("_")) continue;
    const target = k.replace(/^_+/, "");
    if (!target || target in cleaned) {
      nested[k] = v;
    } else {
      cleaned[target] = v;
      renamed.push({ from: k, to: target });
    }
  }

  return { cleaned, nested, renamed };
}

export function extractFieldNamesForOperator(fields: Record<string, unknown> | null | undefined): string[] {
  if (!fields || typeof fields !== "object") return [];
  return Object.keys(fields)
    .filter((k) => !k.startsWith("_"))
    .slice(0, FIELD_NAMES_CAP);
}

// Companion to extractFieldNamesForOperator that also returns the captured
// values, so the Live Attribution Feed can render the same name+value rows
// as the historical attribution side-peek (Task #287/#288). Same cap and
// same underscore-prefix exclusion as the names list, so the keys returned
// here are always a subset of the names returned by the names helper. We
// keep raw captured values (not hashed) — the panel formats/redacts as it
// sees fit. Returns null when there's nothing to send so the socket payload
// stays small for events with no fields.
export function extractFieldEntriesForOperator(
  fields: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!fields || typeof fields !== "object") return null;
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith("_")) continue;
    if (count >= FIELD_NAMES_CAP) break;
    out[k] = v;
    count++;
  }
  return count > 0 ? out : null;
}

// Build a one-line diagnosis for unmatched events explaining which signals
// were missing. Returns null when the event is not unmatched — matched
// events don't need a "why unmatched" hint. Shared between the live socket
// emit and the historical attribution event detail endpoint so both
// surfaces describe the same fill the same way.
export function computeUnmatchedReason(opts: {
  matchLevel: "diamond" | "golden" | "silver" | "bronze" | "unmatched";
  hasAnyClickId: boolean;
  hasPhoneSignal: boolean;
  hasEmailSignal: boolean;
}): string | null {
  if (opts.matchLevel !== "unmatched") return null;
  const { hasAnyClickId, hasPhoneSignal, hasEmailSignal } = opts;
  if (!hasAnyClickId && !hasPhoneSignal && !hasEmailSignal) {
    return "No phone or email field detected and no click ID present.";
  }
  if (hasAnyClickId && !hasPhoneSignal && !hasEmailSignal) {
    return "Click ID present but no phone or email field detected.";
  }
  if (!hasAnyClickId && (hasPhoneSignal || hasEmailSignal)) {
    return "Phone or email captured but the matcher did not produce a hashed value.";
  }
  return "Pulse could not link this fill to a known job, lead, or click.";
}

export function extractPiiFromFields(fields: Record<string, unknown>): { firstName: string | null; lastName: string | null; email: string | null; phone: string | null } {
  const result: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null } = {
    firstName: null, lastName: null, email: null, phone: null,
  };

  const normalized = new Map<string, string>();
  for (const [key, val] of Object.entries(fields)) {
    if (typeof val === "string" && val.trim()) {
      normalized.set(key.toLowerCase().replace(/[\s-]/g, "_"), val.trim());
    }
  }

  for (const [piiKey, patterns] of Object.entries(PII_FIELD_PATTERNS)) {
    if (piiKey === "fullName") continue;
    for (const pattern of patterns) {
      const val = normalized.get(pattern);
      if (val) {
        (result as Record<string, string | null>)[piiKey] = val;
        break;
      }
    }
  }

  if (!result.firstName) {
    for (const pattern of PII_FIELD_PATTERNS.fullName) {
      const val = normalized.get(pattern);
      if (val) {
        const parts = val.split(/\s+/);
        result.firstName = parts[0] || null;
        result.lastName = parts.slice(1).join(" ") || result.lastName;
        break;
      }
    }
  }

  return result;
}

router.post("/collect/submit", trackerSubmitLimiter, async (req, res) => {
  // Insert an audit row IMMEDIATELY — before any validation — so even
  // schema-rejected payloads show up in Verify Tracker. The id is patched
  // throughout the handler as the request is classified.
  const rawBody = req.body as Record<string, unknown> | undefined;
  const initialClientId = typeof rawBody?.client_id === "string" ? rawBody.client_id.trim() : null;
  const auditId = await logTrackerAttempt({
    endpoint: "submit",
    req,
    body: rawBody,
    clientId: initialClientId,
    outcome: "server_error", // overwritten at the right exit
    httpStatus: 0,
    message: "in-flight",
  });

  try {
    const parsed = TrackerSubmitPayload.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      console.warn("[Tracker Submit] invalid payload from", initialClientId || "(no client_id)", "—", errors);
      await updateTrackerAttempt(auditId, {
        outcome: "invalid_payload",
        httpStatus: 400,
        message: errors.slice(0, 1000),
      });
      res.status(400).json({ success: false, message: `Invalid payload: ${errors}` });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const clientId = parsed.data.client_id.trim();

    if (!clientId) {
      await updateTrackerAttempt(auditId, {
        outcome: "missing_client_id",
        httpStatus: 400,
        message: "client_id is empty after trim",
      });
      res.status(400).json({ success: false, message: "client_id is required" });
      return;
    }

    const [tenant] = await db.select({ id: tenantsTable.id, name: tenantsTable.name, leadIngestionMode: tenantsTable.leadIngestionMode })
      .from(tenantsTable)
      .where(eq(tenantsTable.clientSlug, clientId))
      .limit(1);

    if (!tenant) {
      await updateTrackerAttempt(auditId, {
        clientId,
        outcome: "unknown_client",
        httpStatus: 404,
        message: `No tenant matches client_id "${clientId}"`,
      });
      res.status(404).json({ success: false, message: "Unknown client_id" });
      return;
    }

    const tenantId = tenant.id;
    const attribution = (body.attribution || {}) as Record<string, unknown>;
    const form = (body.form || {}) as Record<string, unknown>;
    const rawFields = (body.fields || {}) as Record<string, unknown>;
    // Enforce the reserved-key promise from the formFields contract:
    // customer-provided field names that start with `_` would otherwise
    // clobber our internal bookkeeping (e.g. `_custom`) when stored, and
    // would also be invisible to operator-facing helpers that filter `_*`.
    // Strip them at ingest so the rest of the pipeline can trust the keys.
    const { cleaned: fields, nested: nestedReservedFields, renamed: renamedReservedKeys } =
      stripReservedFieldKeys(rawFields);
    const rawCustom = (body.custom || {}) as Record<string, unknown>;
    // Layer the customer's real `_custom` payload ON TOP of the nested
    // bag so reserved internal bookkeeping always wins on collision —
    // a customer-supplied `_custom: "x"` is preserved as
    // `_custom._custom`, but `body.custom` itself remains authoritative.
    const custom: Record<string, unknown> = Object.keys(nestedReservedFields).length > 0
      ? { ...nestedReservedFields, ...rawCustom }
      : rawCustom;
    const droppedReservedKeys = [
      ...renamedReservedKeys.map((r) => r.from),
      ...Object.keys(nestedReservedFields),
    ];
    if (droppedReservedKeys.length > 0) {
      const renameSummary = renamedReservedKeys.length > 0
        ? `renamed: ${renamedReservedKeys.map((r) => `${r.from}→${r.to}`).join(", ")}`
        : null;
      const nestSummary = Object.keys(nestedReservedFields).length > 0
        ? `nested under _custom: ${Object.keys(nestedReservedFields).join(", ")}`
        : null;
      console.info(
        "[Tracker Submit] preserved reserved underscore-prefixed field keys from",
        clientId,
        "—",
        [renameSummary, nestSummary].filter(Boolean).join("; "),
      );
      // Persist on the audit row so Verify Tracker can surface an
      // informational notice pointing the operator at the offending
      // <input name> (Task #377/#387). We piggy-back the form
      // id/name/type the keys came from so the notice is actionable:
      // "Form 'Contact (#contact-form)' is sending reserved keys: we
      // renamed _consent → consent so the data is preserved."
      const formObj = (body.form || {}) as Record<string, unknown>;
      await updateTrackerAttempt(auditId, {
        droppedReservedFieldKeys: {
          keys: droppedReservedKeys,
          formId: typeof formObj.id === "string" ? formObj.id : null,
          formName: typeof formObj.name === "string" ? formObj.name : null,
          formType: typeof formObj.type === "string" ? formObj.type : null,
        },
      });
    }

    const gclid = (attribution.gclid as string) || null;
    const fbclid = (attribution.fbclid as string) || null;
    const wbraid = (attribution.wbraid as string) || null;
    const msclkid = (attribution.msclkid as string) || null;
    const ttclid = (attribution.ttclid as string) || null;
    const liFatId = (attribution.li_fat_id as string) || null;
    const utmSource = (attribution.utm_source as string) || null;
    const utmMedium = (attribution.utm_medium as string) || null;
    const utmCampaign = (attribution.utm_campaign as string) || null;
    const utmTerm = (attribution.utm_term as string) || null;
    const utmContent = (attribution.utm_content as string) || null;

    const pageUrl = (body.page_url as string) || null;
    const landingPage = (body.landing_page as string) || null;
    const referrer = (body.referrer as string) || null;
    const submittedAtRaw = (body.submitted_at as string) || null;
    const submittedAt = submittedAtRaw ? new Date(submittedAtRaw) : new Date();

    const formType = (form.type as string) || null;
    const formId = (form.id as string) || null;
    const formName = (form.name as string) || null;

    const detection = await detectFields(tenantId, fields, pageUrl, formId, formName);
    const pii = detection.pii;
    const hashedPhone = pii.phone ? hashPhone(pii.phone) : null;
    const hashedEmail = pii.email ? hashValue(pii.email) : null;

    const addressStr = [
      detection.addressParts.street,
      detection.addressParts.city,
      [detection.addressParts.state, detection.addressParts.zip].filter(Boolean).join(" "),
    ].filter(Boolean).join(", ");
    const billingAddress = addressStr ? normalizeAddress(addressStr) : null;

    const resolvedSourceStr = await normalizeSource(tenantId, utmSource || "form");
    let resolvedFunnelStr: string | null = null;
    let resolvedFunnelId: number | null = null;

    const funnelSlug = (custom.funnel as string) || null;
    const funnelResolved = funnelSlug
      ? await resolveFunnelType(tenantId, funnelSlug)
      : null;

    if (funnelResolved) {
      resolvedFunnelStr = funnelResolved.name;
      resolvedFunnelId = funnelResolved.id;
    } else if (detection.funnelRawValue) {
      const aliasMatch = await normalizeFunnel(tenantId, detection.funnelRawValue);
      if (aliasMatch) {
        resolvedFunnelStr = aliasMatch.funnelName;
        resolvedFunnelId = aliasMatch.funnelTypeId;
      } else {
        resolvedFunnelStr = detection.funnelRawValue;
      }
    }

    if (!resolvedFunnelId && pageUrl) {
      try {
        const pagePath = new URL(pageUrl).pathname.toLowerCase();
        const urlAliasMatch = await normalizeFunnel(tenantId, pagePath);
        if (urlAliasMatch) {
          resolvedFunnelId = urlAliasMatch.funnelTypeId;
          resolvedFunnelStr = urlAliasMatch.funnelName;
        }
      } catch {}
    }

    if (!resolvedFunnelId && pageUrl) {
      const subdomainMatch = await resolveSubdomainFunnel(tenantId, pageUrl);
      if (subdomainMatch) {
        resolvedFunnelId = subdomainMatch.funnelTypeId;
        resolvedFunnelStr = subdomainMatch.funnelName;
      }
    }

    if (!resolvedFunnelId) {
      const [defaultAssoc] = await db
        .select({ funnelTypeId: tenantFunnelTypesTable.funnelTypeId, funnelName: funnelTypesTable.name })
        .from(tenantFunnelTypesTable)
        .innerJoin(funnelTypesTable, eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id))
        .where(eq(tenantFunnelTypesTable.tenantId, tenantId))
        .orderBy(tenantFunnelTypesTable.funnelTypeId)
        .limit(1);
      if (defaultAssoc) {
        resolvedFunnelId = defaultAssoc.funnelTypeId;
        resolvedFunnelStr = defaultAssoc.funnelName;
      }
    }

    const formFieldsToStore = Object.keys(fields).length > 0
      ? { ...fields, ...(Object.keys(custom).length > 0 ? { _custom: custom } : {}) }
      : null;

    const detectedMappings = detection.fields.length > 0
      ? Object.fromEntries(detection.fields.map(f => [f.fieldName, { mapsTo: f.mapsTo, method: f.method, confidence: f.confidence }]))
      : null;

    const matchLevel = gclid ? "diamond" as const
      : hashedPhone ? "golden" as const
      : hashedEmail ? "silver" as const
      : "unmatched" as const;
    const matchConfidence = gclid ? 1.0 : hashedPhone ? 0.9 : hashedEmail ? 0.8 : 0;

    const liveFieldNames = extractFieldNamesForOperator(fields);
    const liveFieldValues = extractFieldEntriesForOperator(fields);

    const unmatchedReason = computeUnmatchedReason({
      matchLevel,
      hasAnyClickId: !!(gclid || fbclid || wbraid || msclkid || ttclid || liFatId),
      hasPhoneSignal: !!pii.phone,
      hasEmailSignal: !!pii.email,
    });

    const [event] = await db.insert(attributionEventsTable).values({
      tenantId,
      eventType: "form_fill",
      gclid,
      wbraid,
      fbclid,
      msclkid,
      ttclid,
      liFatId,
      hashedPhone,
      hashedEmail,
      billingAddress,
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      landingPage,
      pageUrl,
      referrer,
      userAgent: req.headers["user-agent"] || null,
      formType,
      formId,
      formName,
      formFields: formFieldsToStore,
      detectedMappings,
      resolvedLeadSource: resolvedSourceStr,
      resolvedFunnel: resolvedFunnelStr,
      submittedAt,
      matchLevel,
      matchConfidence,
      // Persist the diagnosis so historical reads return the exact wording
      // the event was classified with at write time, even if the heuristic
      // is later reworded. Read-side falls back to recomputing when null
      // (legacy rows written before column 0042 existed).
      unmatchedReason,
    }).returning();

    emitNewAttributionEvent(tenantId, {
      id: event.id,
      matchLevel,
      matchConfidence,
      resolvedLeadSource: resolvedSourceStr,
      resolvedFunnel: resolvedFunnelStr,
      formType,
      formId,
      formName,
      pageUrl,
      landingPage,
      hasPhone: !!hashedPhone,
      hasEmail: !!hashedEmail,
      gclid,
      utmSource,
      utmMedium,
      utmCampaign,
      submittedAt: submittedAt instanceof Date ? submittedAt.toISOString() : submittedAt,
      receivedAt: new Date().toISOString(),
      fieldNames: liveFieldNames,
      fieldValues: liveFieldValues,
      unmatchedReason,
      // Task #386 — surface the same dropped-reserved-key warning the audit
      // row gets (Task #377) on the live attribution feed so the operator
      // can connect the amber finding to the exact submission that tripped
      // it. Empty array on the wire means "nothing was dropped".
      droppedReservedFieldKeys: droppedReservedKeys.length > 0 ? droppedReservedKeys : null,
    });

    const ingestionMode = tenant.leadIngestionMode || "sheets";
    const shouldCreateLead = ingestionMode === "tracker" || ingestionMode === "both";

    if (shouldCreateLead && (pii.firstName || pii.phone || pii.email)) {
      const nameFields = [pii.firstName, pii.lastName].filter(Boolean).join(" ").toLowerCase();
      const isTestLead = nameFields.includes("test");

      if (!isTestLead) {
        const resolvedLeadType = resolvedFunnelStr || (utmSource || "form");

        if (ingestionMode === "both") {
          const overlapWindow = new Date(Date.now() - 48 * 60 * 60 * 1000);
          let isDuplicate = false;
          if (pii.phone) {
            const normalizedPhone = normalizePhone(pii.phone);
            const recentLeads = await db.select({ id: leadsTable.id, phone: leadsTable.phone })
              .from(leadsTable)
              .where(and(
                eq(leadsTable.tenantId, tenantId),
                gte(leadsTable.createdAt, overlapWindow),
              ));
            isDuplicate = recentLeads.some(l =>
              l.phone && normalizePhone(l.phone) === normalizedPhone
            );
          }
          if (!isDuplicate && pii.email) {
            const emailLower = pii.email.toLowerCase().trim();
            const emailLeads = await db.select({ id: leadsTable.id })
              .from(leadsTable)
              .where(and(
                eq(leadsTable.tenantId, tenantId),
                eq(leadsTable.email, emailLower),
                gte(leadsTable.createdAt, overlapWindow),
              ))
              .limit(1);
            isDuplicate = emailLeads.length > 0;
          }
          if (isDuplicate) {
            // Resurface as resubmission instead of silently suppressing
            let dupLeadId: number | null = null;
            if (pii.phone) {
              const normalizedPhone = normalizePhone(pii.phone);
              const recentLeads = await db.select({ id: leadsTable.id, phone: leadsTable.phone })
                .from(leadsTable)
                .where(and(
                  eq(leadsTable.tenantId, tenantId),
                  gte(leadsTable.createdAt, overlapWindow),
                ));
              const dup = recentLeads.find(l => l.phone && normalizePhone(l.phone) === normalizedPhone);
              dupLeadId = dup?.id ?? null;
            }
            if (!dupLeadId && pii.email) {
              const emailLower = pii.email.toLowerCase().trim();
              const [emailDup] = await db.select({ id: leadsTable.id }).from(leadsTable)
                .where(and(
                  eq(leadsTable.tenantId, tenantId),
                  eq(leadsTable.email, emailLower),
                  gte(leadsTable.createdAt, overlapWindow),
                ))
                .limit(1);
              dupLeadId = emailDup?.id ?? null;
            }
            if (dupLeadId) {
              const result = await handleResubmission(tenantId, dupLeadId, "Universal Tracker");
              await db.update(attributionEventsTable)
                .set({ createdLeadId: dupLeadId })
                .where(eq(attributionEventsTable.id, event.id));
              const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, dupLeadId));
              if (refreshed) emitLeadUpdated(tenantId, refreshed as unknown as Record<string, unknown>);
              await updateTrackerAttempt(auditId, {
                tenantId,
                clientId,
                outcome: "resubmitted",
                httpStatus: 200,
                message: `Resurfaced as resubmission on lead #${dupLeadId}`,
                attributionEventId: event.id,
              });
              res.json({ success: true, eventId: event.id, deduplicated: true, resubmitted: true, reactivated: result.reactivated, duplicateLeadId: dupLeadId });
              return;
            }
            await updateTrackerAttempt(auditId, {
              tenantId,
              clientId,
              outcome: "duplicate",
              httpStatus: 200,
              message: "Duplicate of recent lead within 48h overlap window",
              attributionEventId: event.id,
            });
            res.json({ success: true, eventId: event.id, deduplicated: true });
            return;
          }
        }

        const rawApptDate = detection.fields.find(f => f.mapsTo === "appointmentDate")?.value || null;
        const rawApptTime = detection.fields.find(f => f.mapsTo === "appointmentTime")?.value || null;
        const hasApptDetails = isValidAppointmentValue(rawApptDate) || isValidAppointmentValue(rawApptTime);

        const [newLead] = await db.insert(leadsTable).values({
          tenantId,
          firstName: pii.firstName || "Unknown",
          lastName: pii.lastName || "",
          phone: pii.phone || null,
          email: pii.email || null,
          source: resolvedSourceStr,
          originalSource: resolvedSourceStr,
          matchedGclid: gclid || null,
          interestType: null,
          leadType: resolvedLeadType,
          funnelId: resolvedFunnelId,
          appointmentDate: rawApptDate,
          appointmentTime: rawApptTime,
          hubStatus: hasApptDetails ? "appt_booked" : "day_1",
          preBooked: hasApptDetails,
          dayInSequence: 1,
          status: "new",
          address: detection.addressParts.street || null,
          city: detection.addressParts.city || null,
          state: detection.addressParts.state || null,
          zip: detection.addressParts.zip || null,
        }).returning();

        if (newLead) {
          const { recordLeadStatusChange } = await import("../services/lead-status-history");
          await recordLeadStatusChange({
            leadId: newLead.id,
            tenantId,
            fromStatus: null,
            toStatus: newLead.hubStatus,
            changedAt: newLead.createdAt ?? undefined,
            reason: "tracker_create",
          });
          await db.update(attributionEventsTable)
            .set({ createdLeadId: newLead.id })
            .where(eq(attributionEventsTable.id, event.id));

          try {
            const result = await assignLeadRoundRobin(tenantId, newLead.id, resolvedFunnelId);
            if (result.assignedCsrId && result.passIntervalMinutes != null) {
              scheduleAutoPass(newLead.id, result.passIntervalMinutes * 60 * 1000);

              await db.insert(callAttemptsTable).values({
                leadId: newLead.id,
                userId: result.assignedCsrId,
                method: "system",
                outcome: "initial_assignment",
                platform: "native",
                actionType: "system",
                notes: `System: Lead initially assigned to ${result.csrName}`,
              });
            }
          } catch (err) {
            console.warn("[Tracker] Auto-assign round-robin failed for lead", newLead.id, err);
          }
          const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, newLead.id));
          const finalLead = refreshed ?? newLead;
          scheduleOrEmitNewLead(finalLead.id, (finalLead.visibleAfter as Date | null) ?? null);
        }
      }
    }

    await updateTrackerAttempt(auditId, {
      tenantId,
      clientId,
      outcome: "accepted",
      httpStatus: 200,
      message: null,
      attributionEventId: event.id,
    });
    res.json({ success: true, eventId: event.id });
  } catch (error) {
    console.error("[Tracker Submit] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to process submission";
    // Server errors should be 500, not 400 — a 400 wrongly tells the
    // browser the payload was bad, masking real bugs (this exact mistake
    // is what hid the April 2026 outage). Keep the same response shape.
    await updateTrackerAttempt(auditId, {
      outcome: "server_error",
      httpStatus: 500,
      message: message.slice(0, 1000),
    });
    res.status(500).json({ success: false, message });
  }
});

router.post("/collect/heartbeat", trackerHeartbeatLimiter, async (req, res) => {
  const rawBody = req.body as Record<string, unknown> | undefined;
  const initialClientId = typeof rawBody?.clientId === "string" ? rawBody.clientId.trim() : null;
  const auditId = await logTrackerAttempt({
    endpoint: "heartbeat",
    req,
    body: rawBody,
    clientId: initialClientId,
    outcome: "server_error",
    httpStatus: 0,
    message: "in-flight",
  });

  try {
    let tenantId = req.body.tenantId ? Number(req.body.tenantId) : null;
    const clientId = typeof req.body.clientId === "string" ? req.body.clientId.trim() : null;
    const domain = req.body.domain || req.headers.origin || null;
    const userAgent = req.headers["user-agent"] || null;
    // Capture the page URL the script was loaded on; falls back to Referer header.
    // Stored only for the first sighting on this (tenant, domain) — purely diagnostic.
    const referer = req.headers["referer"] || req.headers["referrer"] || null;
    const pageUrl = (typeof req.body.pageUrl === "string" && req.body.pageUrl) || (typeof referer === "string" ? referer : null);

    if (!tenantId && clientId) {
      const [tenant] = await db.select({ id: tenantsTable.id })
        .from(tenantsTable)
        .where(eq(tenantsTable.clientSlug, clientId))
        .limit(1);
      if (tenant) tenantId = tenant.id;
    }

    if (!tenantId) {
      await updateTrackerAttempt(auditId, {
        clientId,
        outcome: clientId ? "unknown_client" : "missing_client_id",
        httpStatus: 400,
        message: clientId ? `No tenant matches client_id "${clientId}"` : "tenantId or clientId is required",
      });
      res.status(400).json({ error: "tenantId or clientId is required" });
      return;
    }

    const existing = await db.select().from(trackerHeartbeatsTable)
      .where(and(
        eq(trackerHeartbeatsTable.tenantId, tenantId),
        ...(domain ? [eq(trackerHeartbeatsTable.domain, domain)] : []),
      ))
      .limit(1);

    if (existing.length > 0) {
      // Backfill firstPageUrl on existing rows that predate the column being recorded.
      const updateSet: Record<string, unknown> = { lastSeenAt: new Date(), userAgent };
      if (!existing[0].firstPageUrl && pageUrl) updateSet.firstPageUrl = pageUrl;
      await db.update(trackerHeartbeatsTable)
        .set(updateSet)
        .where(eq(trackerHeartbeatsTable.id, existing[0].id));
    } else {
      await db.insert(trackerHeartbeatsTable).values({
        tenantId,
        domain,
        userAgent,
        firstPageUrl: pageUrl,
      });
    }

    await updateTrackerAttempt(auditId, {
      tenantId,
      clientId,
      outcome: "accepted",
      httpStatus: 200,
      message: null,
    });
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to record heartbeat";
    console.error("[Tracker Heartbeat] Error:", error);
    await updateTrackerAttempt(auditId, {
      outcome: "server_error",
      httpStatus: 500,
      message: message.slice(0, 1000),
    });
    res.status(500).json({ error: "Failed to record heartbeat" });
  }
});

router.get("/collect/health", async (_req, res) => {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
  const heartbeats = await db.select().from(trackerHeartbeatsTable);

  const health = tenants.map(t => {
    const hb = heartbeats.filter(h => h.tenantId === t.id);
    const latest = hb.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())[0];
    const isHealthy = latest ? new Date(latest.lastSeenAt) > twentyFourHoursAgo : false;
    return {
      tenantId: t.id,
      tenantName: t.name,
      isHealthy,
      lastSeen: latest?.lastSeenAt || null,
      domain: latest?.domain || null,
    };
  });

  res.json(health);
});

export default router;
