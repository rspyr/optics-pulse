import { describe, it, expect } from "vitest";
import {
  classifyScriptKind,
  extractScriptDataAttrs,
  buildFormInventory,
  isScriptResponseDead,
  computeInstallVerdict,
  formInventoryHasHoneypotOnlyShape,
  formInventoryHasMissingNameShape,
  collectReservedKeyWarnings,
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
    // All three are visible (text/tel + select), and all are named.
    expect(inv[0].visibleInputCount).toBe(3);
    expect(inv[0].unnamedVisibleInputCount).toBe(0);
  });

  it("counts unnamed visible inputs and ignores hidden / submit / button inputs", () => {
    const html = `
      <form>
        <input name="first_name" />
        <input data-testid="email-field" />
        <input type="hidden" name="csrf" value="abc" />
        <input type="submit" value="Send" />
        <button type="button">Cancel</button>
      </form>
    `;
    const inv = buildFormInventory(html, "https://example.com/");
    expect(inv).toHaveLength(1);
    // Only the two visible <input>s count: the named first_name and the
    // unnamed data-testid one. <input type=hidden|submit> and <button>
    // are excluded; <button> isn't even matched by the tag scanner.
    expect(inv[0].visibleInputCount).toBe(2);
    expect(inv[0].unnamedVisibleInputCount).toBe(1);
    // fieldNames still captures hidden inputs' names (existing contract).
    expect(inv[0].fieldNames.sort()).toEqual(["csrf", "first_name"]);
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
 * fixes: a <form> wrapping ONLY a hidden anti-bot honeypot (e.g.
 * `company_url`) while the visible inputs are React-managed siblings of
 * the form shell — so pulse.js's FormData call returned just the decoy
 * with empty PII. Affects both custom Replit-built React booking
 * widgets and GoHighLevel-hosted funnels. Verify Tracker should call
 * this out before a customer reports missing leads.
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
      `<form><input name="company_url" /><input name="bot_field" /></form>`,
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

  // Pinned consistency check: `homepage` is intentionally excluded from
  // the honeypot table in BOTH `public/pulse.js` and `verify-tracker.ts`
  // because it's a plausible legitimate website-URL field on a contact
  // form. If you re-add it to either side without the other, the
  // verifier and the runtime capture path will silently disagree about
  // what's real vs. decoy data.
  it("does NOT classify `homepage` as a honeypot — must mirror pulse.js HONEYPOT_NAMES", () => {
    const inv = buildFormInventory(
      `<form><input name="homepage" /></form>`,
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
 * Task #295 — broader missing-name-attribute detection. The exact
 * failure mode this catches: a React form whose visible inputs only
 * carry `data-testid`, so `new FormData(form)` returns an empty body
 * (or only a honeypot decoy). The honeypot-only check (Task #292) only
 * fires on pages that ALSO happen to have a honeypot decoy; this
 * broader check surfaces the same root cause on plain forms before any
 * leads are lost.
 *
 * Threshold rule: ≥2 visible inputs AND ≥50% of them lack a `name=`
 * attribute. The 50% gate keeps a single forgotten name on a
 * well-formed contact form from triggering noise.
 */
describe("formInventoryHasMissingNameShape", () => {
  it("flags a React-style form where every visible input has only data-testid (Vance failure mode)", () => {
    const inv = buildFormInventory(
      `<form>
         <input data-testid="first-name" />
         <input data-testid="email" type="email" />
         <input data-testid="phone" type="tel" />
         <input type="hidden" name="company_url" />
       </form>`,
      "https://example.com/book",
    );
    expect(formInventoryHasMissingNameShape(inv)).toBe(true);
  });

  it("flags a form at exactly the 50% threshold (2 visible, 1 unnamed)", () => {
    const inv = buildFormInventory(
      `<form><input name="email" /><input data-testid="phone" /></form>`,
      "https://example.com/",
    );
    expect(formInventoryHasMissingNameShape(inv)).toBe(true);
  });

  it("does NOT flag a form where only 1 of 3 visible inputs is unnamed (33%)", () => {
    const inv = buildFormInventory(
      `<form>
         <input name="first_name" />
         <input name="email" />
         <input data-testid="phone" />
       </form>`,
      "https://example.com/",
    );
    expect(formInventoryHasMissingNameShape(inv)).toBe(false);
  });

  it("does NOT flag a single visible unnamed input (need >=2 visible to fire)", () => {
    // A 1-input form with a missing name is too noisy to flag on its
    // own — a search box, a comment field, etc.
    const inv = buildFormInventory(
      `<form><input data-testid="search" /></form>`,
      "https://example.com/",
    );
    expect(formInventoryHasMissingNameShape(inv)).toBe(false);
  });

  it("does NOT flag a form whose every visible input is named", () => {
    const inv = buildFormInventory(
      `<form>
         <input name="first_name" />
         <input name="email" />
         <input name="phone" />
       </form>`,
      "https://example.com/",
    );
    expect(formInventoryHasMissingNameShape(inv)).toBe(false);
  });

  it("ignores hidden inputs when computing the visible-input ratio", () => {
    // Two visible (both named) + many hidden (no name). Ratio is 0/2,
    // not influenced by the hidden inputs.
    const inv = buildFormInventory(
      `<form>
         <input name="first_name" />
         <input name="email" />
         <input type="hidden" />
         <input type="hidden" />
         <input type="hidden" />
       </form>`,
      "https://example.com/",
    );
    expect(formInventoryHasMissingNameShape(inv)).toBe(false);
  });

  it("ignores submit/button/reset inputs when computing the visible-input ratio", () => {
    // Two visible inputs (both unnamed) plus a submit button. The
    // submit button must NOT count toward `visibleInputCount` —
    // otherwise 2/3 = 67% would still flag, masking that the ratio is
    // really 2/2 = 100%.
    const inv = buildFormInventory(
      `<form>
         <input data-testid="first-name" />
         <input data-testid="email" />
         <input type="submit" value="Send" />
       </form>`,
      "https://example.com/",
    );
    expect(formInventoryHasMissingNameShape(inv)).toBe(true);
  });

  it("counts <select> and <textarea> as visible inputs", () => {
    // 1 visible-named + 1 visible-unnamed (textarea) + 1 visible-unnamed (select)
    // = 3 visible / 2 unnamed = 67% → flagged.
    const inv = buildFormInventory(
      `<form>
         <input name="first_name" />
         <textarea data-testid="notes"></textarea>
         <select data-testid="service"><option>X</option></select>
       </form>`,
      "https://example.com/",
    );
    expect(formInventoryHasMissingNameShape(inv)).toBe(true);
  });

  it("ignores iframe entries (only native <form>s carry input children)", () => {
    const inv = buildFormInventory(
      `<iframe src="https://link.msgsndr.com/widget/abc"></iframe>`,
      "https://example.com/",
    );
    expect(formInventoryHasMissingNameShape(inv)).toBe(false);
  });

  it("returns true if ANY form in the inventory matches, even when other forms are well-formed", () => {
    const inv = buildFormInventory(
      `<form>
         <input name="first_name" />
         <input name="email" />
       </form>
       <form>
         <input data-testid="first-name" />
         <input data-testid="email" />
       </form>`,
      "https://example.com/",
    );
    expect(formInventoryHasMissingNameShape(inv)).toBe(true);
  });

  it("does NOT flag a form with zero visible inputs (e.g. an iframe-only or empty <form> shell)", () => {
    const inv = buildFormInventory(`<form></form>`, "https://example.com/");
    expect(formInventoryHasMissingNameShape(inv)).toBe(false);
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

// Task #377 — collapsing/normalising the dropped-reserved-key audit rows
// into operator-facing warnings. The submit handler stamps each offending
// audit row with `{ keys, formId, formName, formType }`; the verify-tracker
// route folds them down to one warning per (form + sorted key set) so a
// single misnamed input doesn't flood the findings list.
describe("collectReservedKeyWarnings", () => {
  it("returns no warnings when every audit row has no dropped keys", () => {
    expect(collectReservedKeyWarnings([
      { droppedReservedFieldKeys: null },
      { droppedReservedFieldKeys: undefined },
      { droppedReservedFieldKeys: { keys: [], formId: "x", formName: null, formType: null } },
    ])).toEqual([]);
  });

  it("collapses repeated submissions from the same form + same dropped keys into a single warning", () => {
    const rows = [
      { droppedReservedFieldKeys: { keys: ["_custom", "_consent"], formId: "contact", formName: "Contact", formType: "form" } },
      { droppedReservedFieldKeys: { keys: ["_consent", "_custom"], formId: "contact", formName: "Contact", formType: "form" } },
      { droppedReservedFieldKeys: { keys: ["_custom"], formId: "contact", formName: "Contact", formType: "form" } },
    ];
    const out = collectReservedKeyWarnings(rows);
    expect(out).toHaveLength(2);
    expect(out[0].keys).toEqual(["_consent", "_custom"]);
    expect(out[0].formName).toBe("Contact");
    expect(out[1].keys).toEqual(["_custom"]);
  });

  it("treats different forms as separate warnings", () => {
    const rows = [
      { droppedReservedFieldKeys: { keys: ["_custom"], formId: "contact", formName: "Contact", formType: "form" } },
      { droppedReservedFieldKeys: { keys: ["_custom"], formId: "quote", formName: "Quote", formType: "form" } },
    ];
    const out = collectReservedKeyWarnings(rows);
    expect(out).toHaveLength(2);
    expect(out.map(w => w.formId).sort()).toEqual(["contact", "quote"]);
  });

  it("ignores malformed audit values (wrong type, missing keys, non-string entries)", () => {
    expect(collectReservedKeyWarnings([
      { droppedReservedFieldKeys: "not-an-object" },
      { droppedReservedFieldKeys: ["wrong-shape"] },
      { droppedReservedFieldKeys: { keys: "not-an-array", formId: null, formName: null, formType: null } },
      { droppedReservedFieldKeys: { keys: [123, null, ""], formId: null, formName: null, formType: null } },
    ])).toEqual([]);
  });

  it("preserves the form fields verbatim so the UI can pick the most useful label", () => {
    const out = collectReservedKeyWarnings([
      { droppedReservedFieldKeys: { keys: ["_custom"], formId: null, formName: null, formType: "honeypot-rescue" } },
    ]);
    expect(out).toEqual([{ keys: ["_custom"], formId: null, formName: null, formType: "honeypot-rescue" }]);
  });
});
