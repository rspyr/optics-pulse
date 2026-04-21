/**
 * @vitest-environment jsdom
 *
 * Smoke + regression tests for `public/pulse.js` running in jsdom.
 * Covers the failure modes that caused Vance's 7 missing leads:
 *   - Document-level capture-phase listener wins over a form-level handler that calls stopPropagation.
 *   - Click-time fallback fires for submit-style buttons that are not inside a <form>.
 *   - GoHighLevel / LeadConnector postMessage handler is wired and triggers a send.
 *   - Heartbeat payload includes the page URL.
 *   - Identical re-submit within the dedup window does not produce duplicate sends.
 *
 * NOTE: pulse.js attaches document-level listeners that we cannot cleanly remove,
 * so we load it exactly once via beforeAll and reset transient state between tests.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const PULSE_JS = readFileSync(join(__dirname, "../../public/pulse.js"), "utf8");

interface CapturedRequest { url: string; body: unknown; }

const captured: CapturedRequest[] = [];
const xhrSent: string[] = [];

class MockXHR {
  readyState = 0;
  status = 200;
  onreadystatechange: (() => void) | null = null;
  open() { /* noop */ }
  setRequestHeader() { /* noop */ }
  send(body: string) {
    xhrSent.push(body);
    this.readyState = 4;
    this.onreadystatechange?.();
  }
}

beforeAll(() => {
  (window as unknown as { fetch: typeof fetch }).fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = init?.body; }
    captured.push({ url: String(url), body });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  (navigator as unknown as { sendBeacon: () => boolean }).sendBeacon = () => true;
  (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;
  (window as unknown as { __pulseConfig: unknown }).__pulseConfig = {
    clientId: "test-tenant",
    endpoint: "https://api.test/api/collect/submit",
    tenantId: 3,
  };
  // Execute pulse.js IIFE in the jsdom window (one time only).
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(PULSE_JS).call(window);
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  document.body.innerHTML = "";
  captured.length = 0;
  // Don't reset xhrSent — heartbeat fires once at IIFE load and we assert on it later.
});

async function tick(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("pulse.js capture surface", () => {
  it("heartbeat sent at load with pageUrl + tenant", () => {
    expect(xhrSent.length).toBeGreaterThan(0);
    const payload = JSON.parse(xhrSent[0]);
    expect(payload).toHaveProperty("pageUrl");
    expect(payload).toHaveProperty("domain");
    expect(payload.tenantId).toBe(3);
  });

  it("captures a form submit even when the form's own handler calls stopPropagation", async () => {
    const form = document.createElement("form");
    form.id = "lead-form";
    form.innerHTML = `
      <input name="email" value="a@b.com" />
      <input name="phone" value="555-1212" />
      <button type="submit">Submit</button>
    `;
    document.body.appendChild(form);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    });
    await tick();

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();

    const submits = captured.filter((c) => c.url.endsWith("/api/collect/submit"));
    expect(submits.length).toBeGreaterThan(0);
    const fields = (submits[0].body as { fields: Record<string, string> }).fields;
    expect(fields.email).toBe("a@b.com");
    expect(fields.phone).toBe("555-1212");
  });

  it("dedupes identical re-dispatched submits within the dedup window", async () => {
    const form = document.createElement("form");
    form.id = "dedupe-form";
    form.innerHTML = `<input name="email" value="dup@x.com" /><button type="submit">Go</button>`;
    document.body.appendChild(form);
    await tick();

    // Dispatch the same submit twice in quick succession; the second should be deduped.
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();

    const submits = captured.filter((c) => {
      if (!c.url.endsWith("/api/collect/submit")) return false;
      const body = c.body as { fields?: Record<string, string> };
      return body.fields?.email === "dup@x.com";
    });
    // Two dispatches should collapse to one captured send.
    expect(submits.length).toBe(1);
  });

  it("button-click fallback fires when the button is not inside a <form>", async () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <input name="email" value="x@y.com" />
      <input name="phone" value="(555) 999-9999" />
      <button id="cta-btn">Get Free Quote</button>
    `;
    document.body.appendChild(wrapper);
    await tick();

    document.getElementById("cta-btn")!.click();
    await tick();

    const submits = captured.filter((c) => {
      if (!c.url.endsWith("/api/collect/submit")) return false;
      const body = c.body as { form?: { type?: string } };
      return body.form?.type === "button-fallback";
    });
    expect(submits.length).toBeGreaterThan(0);
  });

  it("GoHighLevel / LeadConnector postMessage triggers a capture", async () => {
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "form_submission",
        payload: { formId: "ghl-123", fields: { email: "lead@ghl.com", name: "Lead Person" } },
      },
    }));
    await tick();

    const submits = captured.filter((c) => {
      if (!c.url.endsWith("/api/collect/submit")) return false;
      const body = c.body as { form?: { type?: string }, fields?: Record<string, string> };
      return body.form?.type === "leadconnector" && body.fields?.email === "lead@ghl.com";
    });
    expect(submits.length).toBeGreaterThan(0);
  });
});
