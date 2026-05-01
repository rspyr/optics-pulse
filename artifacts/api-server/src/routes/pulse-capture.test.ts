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
    form.addEventListener("submit", (ev: Event) => {
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

  /**
   * Task #292 — honeypot-rescue path.
   *
   * The Vance failure mode in one DOM, mirroring how the affected
   * Replit-built booking widget actually composes its DOM (see
   * `client/src/pages/Home.tsx`): a real `<form>` wraps ONLY the hidden
   * `company_url` honeypot, while the visible inputs (Name / Phone /
   * Email) are React-managed SIBLINGS of the `<form>` shell, bound via
   * useState and tagged with `data-testid="input-name"` etc. — no `name`
   * attribute, so `new FormData(form)` returns just the honeypot.
   * Pulse.js must notice the honeypot-only shape, re-scan the form's
   * ancestors to capture the visible inputs (stripping the `input-`
   * test-selector prefix so the server-side field detector can match),
   * and label the submission `honeypot-rescue` so operators can tell it
   * apart from a normal native submit in the live attribution feed.
   */
  it("rescues honeypot-only forms by scanning sibling inputs (data-testid) and labels them honeypot-rescue", async () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div class="booking-step-1">
        <input data-testid="input-name" placeholder="Your name" value="Jane Smith" />
        <input data-testid="input-phone" type="tel" placeholder="Phone" value="(555) 222-7777" />
        <input data-testid="input-email" type="email" placeholder="Email" value="jane@vance-test.com" />
        <form id="booking-step-form">
          <input name="company_url" type="text" value="" tabindex="-1" autocomplete="off" />
          <button type="submit" data-testid="button-reserve">Reserve My Spot</button>
        </form>
      </div>
    `;
    document.body.appendChild(wrapper);
    await tick();

    document.getElementById("booking-step-form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();

    const submits = captured.filter((c) => {
      if (!c.url.endsWith("/api/collect/submit")) return false;
      const body = c.body as { form?: { id?: string } };
      return body.form?.id === "booking-step-form";
    });
    expect(submits.length).toBeGreaterThan(0);

    const body = submits[submits.length - 1].body as {
      form: { type: string };
      fields: Record<string, string>;
    };

    // (a) wide-scan kicked in: visible inputs are present, with the
    //     `input-` test-selector prefix stripped so server-side field
    //     detection patterns (`name`, `phone`, `email`) match cleanly.
    expect(body.fields.name).toBe("Jane Smith");
    expect(body.fields.phone).toBe("(555) 222-7777");
    expect(body.fields.email).toBe("jane@vance-test.com");

    // (b) honeypot decoy was stripped from the final payload.
    expect(body.fields.company_url).toBeUndefined();

    // (c) submission is labelled honeypot-rescue (not native) so the
    //     live attribution feed can show operators which capture path
    //     matched.
    expect(body.form.type).toBe("honeypot-rescue");
  });

  it("does NOT trigger the wide scan when the form already has real, named user inputs (no double-capture)", async () => {
    // A normal form with real fields PLUS an opportunistic honeypot
    // alongside them. The wider scan must not fire — we'd otherwise
    // double-capture surrounding-page inputs from unrelated widgets.
    const form = document.createElement("form");
    form.id = "real-form-with-honeypot";
    form.innerHTML = `
      <input name="email" value="real@user.com" />
      <input name="phone" value="555-0000" />
      <input name="company_url" value="" tabindex="-1" />
      <button type="submit">Submit</button>
    `;
    document.body.appendChild(form);

    // Decoy "wide-scan victim" sitting in an ancestor to prove the rescue
    // didn't run: if pulse.js mistakenly re-scanned ancestors here, the
    // payload would also contain `bystander_field`.
    const sibling = document.createElement("input");
    sibling.name = "bystander_field";
    sibling.value = "should-not-be-captured";
    document.body.appendChild(sibling);
    await tick();

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();

    const submits = captured.filter((c) => {
      if (!c.url.endsWith("/api/collect/submit")) return false;
      const body = c.body as { form?: { id?: string } };
      return body.form?.id === "real-form-with-honeypot";
    });
    expect(submits.length).toBeGreaterThan(0);

    const body = submits[submits.length - 1].body as {
      form: { type: string };
      fields: Record<string, string>;
    };

    // wide scan did not fire → still labelled native, not ghl-hosted.
    expect(body.form.type).toBe("native");
    // real fields preserved.
    expect(body.fields.email).toBe("real@user.com");
    expect(body.fields.phone).toBe("555-0000");
    // honeypot stripped from non-rescue path too.
    expect(body.fields.company_url).toBeUndefined();
    // wide-scan victim was NOT pulled into the payload.
    expect(body.fields.bystander_field).toBeUndefined();
  });

  /**
   * Task #292 follow-up — guard against stripping a legitimate
   * customer-named `homepage` field. `homepage` is a plausible website
   * URL field on a contact form, NOT a honeypot, and must round-trip
   * through pulse.js untouched. (Earlier iterations of HONEYPOT_NAMES
   * included `homepage`; this test pins the safer behavior.)
   */
  it("preserves a legitimate `homepage` field — it is NOT a honeypot decoy", async () => {
    const form = document.createElement("form");
    form.id = "form-with-homepage";
    form.innerHTML = `
      <input name="email" value="biz@example.com" />
      <input name="homepage" type="url" value="https://example.com" />
      <input name="company_url" value="" tabindex="-1" />
      <button type="submit">Send</button>
    `;
    document.body.appendChild(form);
    await tick();

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();

    const submits = captured.filter((c) => {
      if (!c.url.endsWith("/api/collect/submit")) return false;
      const body = c.body as { form?: { id?: string } };
      return body.form?.id === "form-with-homepage";
    });
    expect(submits.length).toBeGreaterThan(0);

    const body = submits[submits.length - 1].body as {
      fields: Record<string, string>;
    };
    // The legit homepage URL must NOT be stripped.
    expect(body.fields.homepage).toBe("https://example.com");
    // The actual honeypot still IS stripped.
    expect(body.fields.company_url).toBeUndefined();
  });

  /**
   * Task #292 follow-up — guard against rescue scope creep. The
   * honeypot-rescue ancestor walk is depth-capped (3 levels) so that an
   * unrelated input deep in the page tree (a header search bar, a
   * sidebar newsletter signup, etc.) does NOT get vacuumed into the
   * payload of a honeypot-only booking form. This test deliberately
   * places a bystander input five wrappers above the form and asserts
   * it is never captured.
   */
  it("rescue scan stops at the depth cap and ignores far-ancestor bystander inputs", async () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <input name="header_search" value="should-not-be-captured" />
      <div><div><div><div><div>
        <form id="far-ancestor-honeypot-form">
          <input name="company_url" type="text" value="" tabindex="-1" />
          <button type="submit">Submit</button>
        </form>
      </div></div></div></div></div>
    `;
    document.body.appendChild(root);
    await tick();

    document.getElementById("far-ancestor-honeypot-form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();

    const submits = captured.filter((c) => {
      if (!c.url.endsWith("/api/collect/submit")) return false;
      const body = c.body as { form?: { id?: string } };
      return body.form?.id === "far-ancestor-honeypot-form";
    });
    expect(submits.length).toBeGreaterThan(0);

    const body = submits[submits.length - 1].body as {
      fields: Record<string, string>;
    };
    // The far-ancestor bystander must NOT be in the payload.
    expect(body.fields.header_search).toBeUndefined();
    // honeypot stripped, no other fields available → empty payload.
    expect(body.fields.company_url).toBeUndefined();
  });

  /**
   * Task #292 follow-up — guard against the `input-` prefix stripper
   * mutating real `name=` attributes. A customer who explicitly named
   * a field `input_referral_source` in their HTML must see that exact
   * key arrive at the server — only `data-testid="input-…"` keys
   * (a React test-selector convention) get the prefix stripped.
   */
  it("preserves real `name='input_*'` attributes — only data-testid keys get the input- prefix stripped", async () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div>
        <input data-testid="input-name" placeholder="Name" value="Jane Doe" />
        <input name="input_referral_source" value="word-of-mouth" />
        <form id="prefix-guard-form">
          <input name="company_url" type="text" value="" tabindex="-1" />
          <button type="submit">Submit</button>
        </form>
      </div>
    `;
    document.body.appendChild(wrapper);
    await tick();

    document.getElementById("prefix-guard-form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();

    const submits = captured.filter((c) => {
      if (!c.url.endsWith("/api/collect/submit")) return false;
      const body = c.body as { form?: { id?: string } };
      return body.form?.id === "prefix-guard-form";
    });
    expect(submits.length).toBeGreaterThan(0);

    const body = submits[submits.length - 1].body as {
      fields: Record<string, string>;
    };
    // data-testid="input-name" → key `name` (prefix stripped).
    expect(body.fields.name).toBe("Jane Doe");
    // name="input_referral_source" → key preserved verbatim.
    expect(body.fields.input_referral_source).toBe("word-of-mouth");
    // Just to be sure no rogue key showed up.
    expect(body.fields.referral_source).toBeUndefined();
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

