/**
 * @vitest-environment jsdom
 *
 * Verifies the ?pulse_capture=1 / window.__pulseCapture diagnostic mode
 * added in Task #248. Loads pulse.js fresh in this jsdom realm with
 * capture mode enabled, then asserts that pagehide flushes a payload to
 * /api/collect/diagnostics. This must run in its own file because the
 * IIFE attaches lifecycle listeners exactly once at load time and the
 * existing pulse-capture.test.ts loads pulse.js with capture mode off.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const PULSE_JS = readFileSync(join(__dirname, "../../public/pulse.js"), "utf8");

interface BeaconCall { url: string; body: unknown }
const beacons: BeaconCall[] = [];

beforeAll(() => {
  // Capture mode flag must be set BEFORE the IIFE runs — that's when
  // pulse.js decides whether to register the pagehide flush listener.
  (window as unknown as { __pulseCapture?: boolean }).__pulseCapture = true;
  (window as unknown as { __pulseConfig: unknown }).__pulseConfig = {
    clientId: "test-tenant",
    endpoint: "https://api.test/api/collect/submit",
    tenantId: 7,
  };
  (window as unknown as { fetch: typeof fetch }).fetch = vi.fn(
    async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
  (navigator as unknown as { sendBeacon: (url: string, data: Blob) => boolean }).sendBeacon =
    (url: string, data: Blob) => {
      // jsdom Blob exposes .text() asynchronously; we record url synchronously
      // and parse the body on the resolved promise so the assertion can await it.
      const reader = (data as unknown as { text?: () => Promise<string> }).text;
      if (reader) {
        reader.call(data).then((t: string) => {
          try { beacons.push({ url, body: JSON.parse(t) }); }
          catch { beacons.push({ url, body: t }); }
        });
      } else {
        beacons.push({ url, body: null });
      }
      return true;
    };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(PULSE_JS).call(window);
});

describe("pulse.js capture mode (?pulse_capture=1)", () => {
  it("flushes buffered diagnostics to /api/collect/diagnostics on pagehide", async () => {
    // Push something into the postMessages buffer so the flush is non-empty.
    window.postMessage({ type: "lc.test.event", data: { foo: "bar" } }, "*");
    await new Promise((r) => setTimeout(r, 30));

    window.dispatchEvent(new Event("pagehide"));
    // Allow Blob.text() to resolve and the beacon recorder to push.
    await new Promise((r) => setTimeout(r, 50));

    const flush = beacons.find((b) => b.url.indexOf("/api/collect/diagnostics") !== -1);
    expect(flush).toBeDefined();
    if (flush && flush.body && typeof flush.body === "object") {
      const payload = flush.body as {
        client_id?: string;
        diagnostics?: { reason?: string; postMessages?: unknown[] };
      };
      expect(payload.client_id).toBe("test-tenant");
      expect(payload.diagnostics?.reason).toBe("pagehide");
    }
  });
});
