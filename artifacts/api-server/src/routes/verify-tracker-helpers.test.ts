import { describe, it, expect } from "vitest";
import {
  classifyScriptKind,
  extractScriptDataAttrs,
  buildFormInventory,
  isScriptResponseDead,
  computeInstallVerdict,
  formInventoryHasHoneypotOnlyShape,
} from "./verify-tracker";

/**
 * Tests for the new tracker-classification + form-inventory helpers added
 * for Task #248. These pin down the operator-facing taxonomy: every value
 * the UI's install-verdict banner can switch on must be tested here so a
 * future refactor can't silently drop a state.
 */

describe("classifyScriptKind", () => {
  it("classifies the legacy Optics deployment URL as optics-legacy even when the response is HTML", () => {
    // The exact failure mode that broke Vance Heating: the page loads
    // tracker.js from hvaclaunch-optics.replit.app — the URL alone is a
    // smoking gun even if the file 404s.
    expect(classifyScriptKind({
      src: "https://hvaclaunch-optics.replit.app/api/pulse.js",
      resolvedUrl: "https://hvaclaunch-optics.replit.app/api/pulse.js",
      ok: false, contentType: "text/html", body: "<html>404</html>",
    })).toBe("optics-legacy");
  });

  it("classifies any tracker.js URL as optics-legacy", () => {
    expect(classifyScriptKind({
      src: "/tracker.js", resolvedUrl: "https://example.com/tracker.js",
      ok: true, contentType: "application/javascript", body: "console.log('hi')",
    })).toBe("optics-legacy");
  });

  it("classifies a pulse.js URL with the current fingerprint as pulse-current", () => {
    expect(classifyScriptKind({
      src: "/api/pulse.js", resolvedUrl: "https://example.com/api/pulse.js",
      ok: true, contentType: "application/javascript",
      body: "var x = '_attr_data'; fetch('/api/collect/submit')",
    })).toBe("pulse-current");
  });

  it("classifies a pulse.js URL missing fingerprint literals as pulse-legacy", () => {
    expect(classifyScriptKind({
      src: "/api/pulse.js", resolvedUrl: "https://example.com/api/pulse.js",
      ok: true, contentType: "application/javascript",
      body: "// older pulse build with different internals",
    })).toBe("pulse-legacy");
  });

  it("classifies an arbitrary CDN URL whose body matches the fingerprint as pulse-current", () => {
    expect(classifyScriptKind({
      src: "/cdn/p.js", resolvedUrl: "https://example.com/cdn/p.js",
      ok: true, contentType: "text/javascript",
      body: "var x='_attr_data';/api/collect/submit",
    })).toBe("pulse-current");
  });

  it("classifies an unknown tracker-shaped URL as unknown-tracker", () => {
    expect(classifyScriptKind({
      src: "/analytics.js", resolvedUrl: "https://example.com/analytics.js",
      ok: true, contentType: "application/javascript",
      body: "// some other vendor",
    })).toBe("unknown-tracker");
  });
});

describe("extractScriptDataAttrs", () => {
  it("extracts data-tenant and data-client-id from the matching script tag", () => {
    const html = `<head>
      <script src="/api/pulse.js" data-tenant="4" data-client-id="vance-heating" async></script>
      <script src="/other.js" data-tenant="999"></script>
    </head>`;
    expect(extractScriptDataAttrs(html, "/api/pulse.js")).toEqual({
      tenant: "4", "client-id": "vance-heating",
    });
  });

  it("returns null when the script tag is not found", () => {
    expect(extractScriptDataAttrs("<html></html>", "/missing.js")).toBeNull();
  });

  it("returns an empty object when the script tag has no data-* attributes", () => {
    const html = `<script src="/api/pulse.js"></script>`;
    expect(extractScriptDataAttrs(html, "/api/pulse.js")).toEqual({});
  });
});

describe("buildFormInventory", () => {
  it("captures native forms and their input field names", () => {
    const html = `
      <form action="/submit" method="post">
        <input name="first_name" />
        <input name="phone" type="tel" />
        <select name="service"><option>X</option></select>
      </form>
    `;
    const inv = buildFormInventory(html, "https://example.com/page");
    expect(inv).toHaveLength(1);
    expect(inv[0].kind).toBe("form");
    expect(inv[0].source).toBe("/submit");
    expect(inv[0].fieldNames.sort()).toEqual(["first_name", "phone", "service"]);
  });

  it("identifies leadconnector iframes by host", () => {
    const html = `<iframe src="https://link.msgsndr.com/widget/abc123"></iframe>`;
    const inv = buildFormInventory(html, "https://example.com/page");
    expect(inv).toHaveLength(1);
    expect(inv[0].kind).toBe("iframe");
    expect(inv[0].builder).toBe("leadconnector");
    expect(inv[0].host).toBe("link.msgsndr.com");
  });

  it("identifies framer iframes by host", () => {
    const html = `<iframe src="https://framer.com/embed/xyz"></iframe>`;
    const inv = buildFormInventory(html, "https://example.com/");
    expect(inv[0].builder).toBe("framer");
  });

  it("labels unrecognised iframes as 'unknown'", () => {
    const html = `<iframe src="https://random-vendor.example.io/widget"></iframe>`;
    const inv = buildFormInventory(html, "https://example.com/");
    expect(inv[0].builder).toBe("unknown");
  });

  it("returns an empty list for HTML with no forms or iframes", () => {
    expect(buildFormInventory("<p>Just text</p>", "https://example.com/")).toEqual([]);
  });
});

/**
 * Task #292 — honeypot-only form detection. The exact failure mode this
 * fixes: GHL-hosted funnels expose a <form> wrapping ONLY their hidden
 * `company_url` honeypot, and pulse.js's FormData call returned just the
 * decoy with empty PII. Verify Tracker should call this out before a
 * customer reports missing leads.
 */
describe("formInventoryHasHoneypotOnlyShape", () => {
  it("flags a form whose only named field is company_url (Vance failure mode)", () => {
    const inv = buildFormInventory(
      `<form><input name="company_url" type="text" tabindex="-1" autocomplete="off" /></form>`,
      "https://vance.protect.neighborhood-hvac.com/",
    );
    expect(formInventoryHasHoneypotOnlyShape(inv)).toBe(true);
  });

  it("flags a form whose only named fields are multiple known honeypots", () => {
    const inv = buildFormInventory(
      `<form><input name="company_url" /><input name="homepage" /></form>`,
      "https://example.com/",
    );
    expect(formInventoryHasHoneypotOnlyShape(inv)).toBe(true);
  });

  it("does NOT flag a form with at least one real named field alongside a honeypot", () => {
    const inv = buildFormInventory(
      `<form><input name="company_url" /><input name="email" /><input name="phone" /></form>`,
      "https://example.com/",
    );
    expect(formInventoryHasHoneypotOnlyShape(inv)).toBe(false);
  });

  it("does NOT flag a form with zero named fields (the inventory shows nothing to warn about)", () => {
    const inv = buildFormInventory(`<form></form>`, "https://example.com/");
    expect(formInventoryHasHoneypotOnlyShape(inv)).toBe(false);
  });

  it("does NOT classify `address` as a honeypot — real customer field", () => {
    const inv = buildFormInventory(
      `<form><input name="address" /></form>`,
      "https://example.com/",
    );
    expect(formInventoryHasHoneypotOnlyShape(inv)).toBe(false);
  });

  it("ignores iframe entries (only native <form>s carry honeypot inputs)", () => {
    const inv = buildFormInventory(
      `<iframe src="https://link.msgsndr.com/widget/abc"></iframe>`,
      "https://example.com/",
    );
    expect(formInventoryHasHoneypotOnlyShape(inv)).toBe(false);
  });

  it("returns true if ANY form in the inventory is honeypot-only, even when other forms are real", () => {
    const inv = buildFormInventory(
      `<form><input name="email" /></form>
       <form><input name="company_url" /></form>`,
      "https://example.com/",
    );
    expect(formInventoryHasHoneypotOnlyShape(inv)).toBe(true);
  });
});

/**
 * Tests for Task #253: Verify Tracker should stop screaming "Wrong tracker
 * installed" (red) when the legacy `tracker.js` URL is dead AND pulse.js is
 * actively running via GTM. Instead it emits a `legacy-tag-dead` amber.
 */
describe("isScriptResponseDead", () => {
  it("flags a fetch error as dead", () => {
    expect(isScriptResponseDead({ ok: false, contentType: null, body: "", fetchError: "ETIMEDOUT" })).toBe(true);
  });
  it("flags a 4xx HTTP response as dead", () => {
    expect(isScriptResponseDead({ ok: false, contentType: "text/plain", body: "Not Found" })).toBe(true);
  });
  it("flags an HTML body served as a script as dead (Vance failure mode)", () => {
    expect(isScriptResponseDead({ ok: true, contentType: "text/html; charset=utf-8", body: "<!doctype html><html>404</html>" })).toBe(true);
  });
  it("flags HTML detected by body sniff when content-type is missing", () => {
    expect(isScriptResponseDead({ ok: true, contentType: null, body: "<!DOCTYPE html><html>oops</html>" })).toBe(true);
  });
  it("flags non-JS content-types as dead", () => {
    expect(isScriptResponseDead({ ok: true, contentType: "text/plain", body: "var x = 1;" })).toBe(true);
  });
  it("flags an empty 200 body as dead even with a JS content-type", () => {
    // A CDN serving an empty file at the legacy URL — browser executes nothing.
    expect(isScriptResponseDead({ ok: true, contentType: "application/javascript", body: "" })).toBe(true);
    expect(isScriptResponseDead({ ok: true, contentType: "application/javascript", body: "   \n\t  " })).toBe(true);
  });
  it("treats a real JS response as alive", () => {
    expect(isScriptResponseDead({
      ok: true,
      contentType: "application/javascript",
      body: `(function(){var ATTR_COOKIE="_attr_data"; fetch("/api/collect/submit");})();`,
    })).toBe(false);
  });
  it("treats text/javascript responses as alive", () => {
    expect(isScriptResponseDead({ ok: true, contentType: "text/javascript", body: "console.log('hi')" })).toBe(false);
  });
});

describe("computeInstallVerdict — Task #253 legacy-tag-dead downgrade", () => {
  it("(a) downgrades dead legacy URL + active pulse heartbeats → legacy-tag-dead amber", () => {
    // Vance's exact failure mode: static HTML still has a <script src=tracker.js>
    // tag pointing at a sleeping Replit app that returns HTML, but pulse.js is
    // actively running via GTM so heartbeats are fresh.
    const verdict = computeInstallVerdict({
      pageScriptKind: "optics-legacy",
      scripts: [{ kind: "optics-legacy", isDeadResource: true }],
      hasFreshHeartbeat: true,
      hasAnyHeartbeat: true,
      submitOk7d: 12,
    });
    expect(verdict).toBe("legacy-tag-dead");
  });

  it("(b) regression guard — live legacy URL still serving JS → wrong-tracker-installed red", () => {
    // The legacy script actually executes — this is genuinely the wrong tracker
    // and submits will go to the wrong tenant. Must NOT downgrade.
    const verdict = computeInstallVerdict({
      pageScriptKind: "optics-legacy",
      scripts: [{ kind: "optics-legacy", isDeadResource: false }],
      hasFreshHeartbeat: true,
      hasAnyHeartbeat: true,
      submitOk7d: 12,
    });
    expect(verdict).toBe("wrong-tracker-installed");
  });

  it("(c) legacy tag with no heartbeats at all → wrong-tracker-installed red (no false-positive downgrade)", () => {
    // Legacy URL is dead but there's no evidence that the new pulse is running
    // anywhere. Cannot assume GTM is firing pulse.js — keep it red.
    const verdict = computeInstallVerdict({
      pageScriptKind: "optics-legacy",
      scripts: [{ kind: "optics-legacy", isDeadResource: true }],
      hasFreshHeartbeat: false,
      hasAnyHeartbeat: false,
      submitOk7d: 0,
    });
    expect(verdict).toBe("wrong-tracker-installed");
  });

  it("legacy tag dead but only stale heartbeats → wrong-tracker-installed red", () => {
    // A heartbeat from 3 days ago is not proof that pulse is running NOW.
    const verdict = computeInstallVerdict({
      pageScriptKind: "optics-legacy",
      scripts: [{ kind: "optics-legacy", isDeadResource: true }],
      hasFreshHeartbeat: false,
      hasAnyHeartbeat: true,
      submitOk7d: 0,
    });
    expect(verdict).toBe("wrong-tracker-installed");
  });

  it("mixed legacy scripts (one dead, one alive) → wrong-tracker-installed (any live legacy script is an error)", () => {
    const verdict = computeInstallVerdict({
      pageScriptKind: "optics-legacy",
      scripts: [
        { kind: "optics-legacy", isDeadResource: true },
        { kind: "optics-legacy", isDeadResource: false },
      ],
      hasFreshHeartbeat: true,
      hasAnyHeartbeat: true,
      submitOk7d: 12,
    });
    expect(verdict).toBe("wrong-tracker-installed");
  });

  it("pulse-current with fresh heartbeat and successful submits → pulse-ok", () => {
    expect(computeInstallVerdict({
      pageScriptKind: "pulse-current",
      scripts: [{ kind: "pulse-current", isDeadResource: false }],
      hasFreshHeartbeat: true,
      hasAnyHeartbeat: true,
      submitOk7d: 12,
    })).toBe("pulse-ok");
  });

  it("pulse-current with stale heartbeat and successful submits → stale-install", () => {
    expect(computeInstallVerdict({
      pageScriptKind: "pulse-current",
      scripts: [{ kind: "pulse-current", isDeadResource: false }],
      hasFreshHeartbeat: false,
      hasAnyHeartbeat: true,
      submitOk7d: 12,
    })).toBe("stale-install");
  });

  it("pulse-current with heartbeat but no submits → heartbeat-only-never-submitted", () => {
    expect(computeInstallVerdict({
      pageScriptKind: "pulse-current",
      scripts: [{ kind: "pulse-current", isDeadResource: false }],
      hasFreshHeartbeat: true,
      hasAnyHeartbeat: true,
      submitOk7d: 0,
    })).toBe("heartbeat-only-never-submitted");
  });

  it("no script tag in HTML but heartbeat with submits (GTM-only install) → pulse-ok", () => {
    expect(computeInstallVerdict({
      pageScriptKind: "none",
      scripts: [],
      hasFreshHeartbeat: true,
      hasAnyHeartbeat: true,
      submitOk7d: 12,
    })).toBe("pulse-ok");
  });

  it("no script tag and no heartbeat → no-tracker-found", () => {
    expect(computeInstallVerdict({
      pageScriptKind: "none",
      scripts: [],
      hasFreshHeartbeat: false,
      hasAnyHeartbeat: false,
      submitOk7d: 0,
    })).toBe("no-tracker-found");
  });
});
