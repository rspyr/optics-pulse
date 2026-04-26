import { Router, type IRouter } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { logTrackerDiagnostic } from "../services/tracker-audit";
import { trackerDiagnosticsHardLimiter, trackerDiagnosticsLimiter } from "../middleware/rate-limit";

/** Diagnostic beacon endpoint for pulse.js capture mode (?pulse_capture=1). */
const router: IRouter = Router();

const FormScan = z.object({
  formId: z.string().nullish(),
  formName: z.string().nullish(),
  formAction: z.string().nullish(),
  // Each field: just name + type, never values.
  fields: z.array(z.object({
    name: z.string(),
    type: z.string().nullish(),
    required: z.boolean().nullish(),
  })).max(100).optional(),
  // Source builder (best guess by pulse.js — "leadconnector", "ghl",
  // "framer", "hubspot", "typeform", "servicetitan", "clickfunnels",
  // "native"). Lets us correlate "all GHL forms across all tenants are
  // failing detection" patterns.
  builder: z.string().max(80).nullish(),
  iframe: z.boolean().nullish(),
  iframeOrigin: z.string().nullish(),
  // pulse.js sends `source` to indicate which scan path captured this
  // form ("initial" | "mutation" | etc). Allowed but capped to keep
  // payloads bounded.
  source: z.string().max(40).nullish(),
  // Task #292 — honeypot rescue diagnostics. `honeypotOnly` is set true
  // when every input on the form has a known honeypot name (e.g.
  // `company_url` on GoHighLevel-hosted funnels). `wideScanFired` is set
  // true when pulse.js had to rescan the form's ancestors after a submit
  // returned only honeypot decoys, swapping in the visible inputs that
  // were rendered OUTSIDE the form shell.
  honeypotOnly: z.boolean().nullish(),
  wideScanFired: z.boolean().nullish(),
}).strict();

const PostMessageObservation = z.object({
  origin: z.string().max(500),
  messageType: z.string().max(200).nullish(),
  // First 200 chars of the stringified payload — for debugging only,
  // pre-redacted by pulse.js.
  preview: z.string().max(200).nullish(),
}).strict();

const ClickObservation = z.object({
  // Best-guess CSS selector or text label for the button clicked, no PII.
  target: z.string().max(500),
  // Was the click on something inside a <form>? Outside? Inside an iframe?
  context: z.string().max(100).nullish(),
}).strict();

export const DiagnosticEnvelope = z.object({
  client_id: z.string().max(200).nullish(),
  page_url: z.string().max(2000).nullish(),
  domain: z.string().max(500).nullish(),
  pulseVersion: z.string().max(40).nullish(),
  diagnostics: z.object({
    formScans: z.array(FormScan).max(100).optional(),
    postMessages: z.array(PostMessageObservation).max(200).optional(),
    submitClicks: z.array(ClickObservation).max(100).optional(),
    sessionStartedAt: z.string().nullish(),
    flushedAt: z.string().nullish(),
    reason: z.enum(["interval", "unload", "pagehide", "beforeunload", "manual"]).optional(),
  }),
}).strict();

router.post("/collect/diagnostics", trackerDiagnosticsHardLimiter, trackerDiagnosticsLimiter, async (req, res) => {
  const rawBody = req.body as Record<string, unknown> | undefined;
  const initialClientId = typeof rawBody?.client_id === "string" ? rawBody.client_id.trim() : null;

  const parsed = DiagnosticEnvelope.safeParse(req.body);
  if (!parsed.success) {
    const errors = parsed.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join("; ");
    await logTrackerDiagnostic({
      req,
      body: rawBody,
      clientId: initialClientId,
      outcome: "invalid_payload",
      httpStatus: 400,
      message: errors.slice(0, 1000),
    });
    res.status(400).json({ success: false, message: `Invalid diagnostic envelope: ${errors}` });
    return;
  }

  let tenantId: number | null = null;
  if (initialClientId) {
    const [tenant] = await db.select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.clientSlug, initialClientId))
      .limit(1);
    if (tenant) tenantId = tenant.id;
  }

  const counts = parsed.data.diagnostics;
  const summary = `scans:${counts.formScans?.length ?? 0} msgs:${counts.postMessages?.length ?? 0} clicks:${counts.submitClicks?.length ?? 0} reason:${counts.reason ?? "n/a"}`;

  await logTrackerDiagnostic({
    req,
    body: parsed.data,
    tenantId,
    clientId: initialClientId,
    domain: parsed.data.domain ?? null,
    pageUrl: parsed.data.page_url ?? null,
    outcome: "diagnostic_recorded",
    httpStatus: 200,
    message: summary,
  });

  res.json({ success: true });
});

export default router;
