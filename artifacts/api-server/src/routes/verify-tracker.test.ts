import { describe, it, expect } from "vitest";
import { host, abs, findScriptSources, looksLikePulseScript, isPrivateIp, classifyScriptResponse } from "./verify-tracker";

describe("verify-tracker host()", () => {
  it("lowercases the hostname", () => {
    expect(host("https://Vance.Protect.Neighborhood-HVAC.com/landing")).toBe("vance.protect.neighborhood-hvac.com");
  });
  it("returns null for invalid URLs", () => {
    expect(host("not-a-url")).toBeNull();
  });
});

describe("verify-tracker abs()", () => {
  it("resolves protocol-relative URLs", () => {
    expect(abs("https://example.com/page", "//cdn.example.com/p.js")).toBe("https://cdn.example.com/p.js");
  });
  it("resolves root-relative URLs", () => {
    expect(abs("https://example.com/a/b", "/api/pulse.js")).toBe("https://example.com/api/pulse.js");
  });
  it("returns absolute URLs unchanged", () => {
    expect(abs("https://example.com", "https://other.com/p.js")).toBe("https://other.com/p.js");
  });
});

describe("verify-tracker findScriptSources()", () => {
  it("extracts every script src", () => {
    const html = `
      <html>
        <head>
          <script src="/api/pulse.js" data-tenant="3"></script>
          <script defer src='https://example.com/tracker.js'></script>
          <script>console.log('inline')</script>
        </head>
      </html>
    `;
    const srcs = findScriptSources(html);
    expect(srcs).toContain("/api/pulse.js");
    expect(srcs).toContain("https://example.com/tracker.js");
    expect(srcs).toHaveLength(2);
  });
  it("returns empty array for HTML with no scripts", () => {
    expect(findScriptSources("<html><body><p>hi</p></body></html>")).toEqual([]);
  });
});

describe("verify-tracker looksLikePulseScript()", () => {
  it("matches by URL when path mentions pulse.js", () => {
    expect(looksLikePulseScript("https://x.com/api/pulse.js", "")).toBe(true);
  });
  it("matches legacy tracker.js path even with HTML body (Vance failure mode)", () => {
    // We still want this to be flagged for inspection so the caller can detect
    // the content-type mismatch — looksLike==true here means "this URL is intended
    // to be the tracker", which is what the caller uses to compose the error.
    expect(looksLikePulseScript("https://x.com/tracker.js", "<html>")).toBe(true);
  });
  it("matches by IIFE fingerprint when URL is opaque", () => {
    const body = `(function(){var ATTR_COOKIE="_attr_data"; fetch("/api/collect/submit");})();`;
    expect(looksLikePulseScript("https://cdn.x.com/abc123.js", body)).toBe(true);
  });
  it("rejects non-pulse JS", () => {
    expect(looksLikePulseScript("https://cdn.x.com/abc123.js", "console.log('hello')")).toBe(false);
  });
});

describe("verify-tracker classifyScriptResponse() — Vance failure mode", () => {
  it("flags tracker.js URL returning text/html as ERROR (Vance regression)", () => {
    const v = classifyScriptResponse({
      src: "/tracker.js",
      ok: true, status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><body>404</body></html>",
    });
    expect(v.level).toBe("error");
    if (v.level === "error") expect(v.message).toMatch(/HTML instead of JavaScript/i);
  });
  it("flags tracker.js with HTML body and no content-type as ERROR", () => {
    const v = classifyScriptResponse({
      src: "/tracker.js",
      ok: true, status: 200, contentType: null,
      body: "<!DOCTYPE html><html>oops</html>",
    });
    expect(v.level).toBe("error");
  });
  it("returns ok for a real pulse.js response", () => {
    const v = classifyScriptResponse({
      src: "/api/pulse.js",
      ok: true, status: 200,
      contentType: "application/javascript",
      body: `(function(){var ATTR_COOKIE="_attr_data"; fetch("/api/collect/submit");})();`,
    });
    expect(v.level).toBe("ok");
  });
  it("warns when JS loads but lacks pulse fingerprint (and URL is opaque)", () => {
    const v = classifyScriptResponse({
      src: "https://cdn.x.com/abc123.js",
      ok: true, status: 200,
      contentType: "application/javascript",
      body: "console.log('hello')",
    });
    expect(v.level).toBe("warning");
  });
  it("errors on HTTP non-2xx", () => {
    const v = classifyScriptResponse({
      src: "/api/pulse.js", ok: false, status: 404, contentType: "text/plain", body: "Not Found",
    });
    expect(v.level).toBe("error");
    if (v.level === "error") expect(v.message).toMatch(/HTTP 404/);
  });
  it("errors on fetch failure", () => {
    const v = classifyScriptResponse({
      src: "/api/pulse.js", ok: false, status: 0, contentType: null, body: "", fetchError: "ETIMEDOUT",
    });
    expect(v.level).toBe("error");
    if (v.level === "error") expect(v.message).toMatch(/ETIMEDOUT/);
  });
});

describe("verify-tracker isPrivateIp() — SSRF guard", () => {
  it("blocks IPv4 loopback", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.99.0.1")).toBe(true);
  });
  it("blocks RFC1918 ranges", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });
  it("blocks AWS metadata link-local", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });
  it("blocks CGNAT", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("100.127.255.255")).toBe(true);
  });
  it("blocks IPv4 multicast and 0.0.0.0", () => {
    expect(isPrivateIp("224.0.0.1")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });
  it("blocks IPv6 loopback and link-local", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12::1")).toBe(true);
  });
  it("blocks IPv4-mapped IPv6 loopback", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
  });
  it("allows real public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateIp("100.128.0.1")).toBe(false); // just outside CGNAT
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });
  it("treats unknown formats as unsafe (fail-closed)", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });
});
