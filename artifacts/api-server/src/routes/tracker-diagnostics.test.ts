import { describe, it, expect } from "vitest";
import { DiagnosticEnvelope } from "./tracker-diagnostics";

describe("tracker-diagnostics envelope schema", () => {
  it("accepts the exact payload shape pulse.js sends in capture mode", () => {
    const payload = {
      client_id: "vance-heating",
      page_url: "https://vanceheating.com/free-quote",
      domain: "vanceheating.com",
      pulseVersion: "2026.04.25",
      diagnostics: {
        reason: "interval" as const,
        sessionStartedAt: "2026-04-25T20:00:00.000Z",
        flushedAt: "2026-04-25T20:00:30.000Z",
        formScans: [
          {
            formId: "lead-form",
            formName: null,
            formAction: "/api/lead",
            fields: [
              { name: "email", type: "email", required: true },
              { name: "phone", type: "tel", required: true },
            ],
            builder: "native",
            iframe: false,
            iframeOrigin: null,
            source: "initial",
          },
        ],
        postMessages: [
          {
            origin: "https://leadconnectorhq.com",
            messageType: "form_submission",
            preview: "{\"formId\":\"abc\"}",
          },
        ],
        submitClicks: [
          { target: "button[type=submit]", context: "outside-form" },
        ],
      },
    };

    const result = DiagnosticEnvelope.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("rejects payloads with unknown top-level keys (strict)", () => {
    const result = DiagnosticEnvelope.safeParse({
      client_id: "x",
      domain: "x.com",
      pulseVersion: "2026.04.25",
      pulse_version: "2026.04.25",
      diagnostics: { reason: "interval" as const },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a formScans entry tagged with the Task #292 honeypotOnly + wideScanFired flags", () => {
    const result = DiagnosticEnvelope.safeParse({
      client_id: "vance-heating",
      page_url: "https://vance.protect.neighborhood-hvac.com/quote",
      domain: "vance.protect.neighborhood-hvac.com",
      pulseVersion: "2026.04.26",
      diagnostics: {
        reason: "pagehide" as const,
        sessionStartedAt: "2026-04-26T12:00:00.000Z",
        flushedAt: "2026-04-26T12:00:30.000Z",
        formScans: [
          {
            formId: "ghl-form-abc",
            formName: null,
            formAction: null,
            fields: [{ name: "company_url", type: "text", required: false }],
            builder: "native",
            iframe: false,
            iframeOrigin: null,
            source: "initial",
            honeypotOnly: true,
            wideScanFired: true,
          },
        ],
        postMessages: [],
        submitClicks: [],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts the minimum payload pulse.js sends on first interval flush", () => {
    const result = DiagnosticEnvelope.safeParse({
      client_id: "tenant-slug",
      page_url: "https://example.com/",
      domain: "example.com",
      pulseVersion: "2026.04.25",
      diagnostics: {
        reason: "pagehide" as const,
        sessionStartedAt: "2026-04-25T20:00:00.000Z",
        flushedAt: "2026-04-25T20:00:30.000Z",
        formScans: [],
        postMessages: [],
        submitClicks: [],
      },
    });
    expect(result.success).toBe(true);
  });
});
