import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { trackerHeartbeatsTable, attributionEventsTable, tenantsTable, trackerSubmitAttemptsTable } from "@workspace/db";
import { and, eq, desc, gte } from "drizzle-orm";
import { getDomainSubmitBreakdown } from "../services/tracker-audit";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import { URL as NodeURL } from "node:url";

const router: IRouter = Router();

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 800_000;
const MAX_REDIRECTS = 4;

export function host(u: string): string | null {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

export function abs(base: string, src: string): string | null {
  try { return new URL(src, base).toString(); } catch { return null; }
}

/**
 * Reject IPs in private, loopback, link-local, multicast, broadcast, or cloud-metadata ranges.
 * Returns true if the IP is unsafe to fetch from a server.
 */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // 127.0.0.0/8 loopback
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 169 && b === 254) return true;         // 169.254.0.0/16 link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;// 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                       // multicast + reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fec0:")) return true;       // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;             // unique-local
    if (lower.startsWith("ff")) return true;                                       // multicast
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped — recurse on the v4 portion.
      const v4 = lower.slice("::ffff:".length);
      if (isIP(v4) === 4) return isPrivateIp(v4);
    }
    return false;
  }
  return true; // unknown → treat as unsafe
}

/**
 * Validates that a URL is shaped correctly and the hostname is not an obvious local
 * literal. The actual IP-level rejection happens inside `safeLookup` at connection
 * time, so a single DNS resolution is used for both the gate and the connect — no
 * TOCTOU/DNS-rebinding window.
 */
function assertSafeUrlShape(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, reason: "Invalid URL" }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Disallowed protocol: ${parsed.protocol}` };
  }
  const hostname = parsed.hostname;
  if (/^(localhost|ip6-localhost|ip6-loopback)$/i.test(hostname)) {
    return { ok: false, reason: "Refusing to fetch local hostname" };
  }
  if (isIP(hostname) && isPrivateIp(hostname)) {
    return { ok: false, reason: "Refusing to fetch private/loopback IP literal" };
  }
  return { ok: true };
}

/**
 * DNS lookup wrapper used by http(s).request. Fails closed on any private/internal
 * IP. Because http(s).request calls `lookup` itself at connect time and we connect
 * to whatever address it returns, a single resolution flows through gate + connect
 * — defeating DNS rebinding (no second resolution can occur between validation and
 * socket open).
 */
function safeLookup(
  hostname: string,
  options: { family?: number; hints?: number; all?: boolean } | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void),
  callback?: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
): void {
  const cb = (typeof options === "function" ? options : callback) as
    (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;
  const opts = typeof options === "function" ? {} : options;
  dnsLookup(hostname, opts, (err, address, family) => {
    if (err) return cb(err, "", undefined);
    if (Array.isArray(address)) {
      const safe = address.filter(a => !isPrivateIp(a.address));
      if (safe.length === 0) {
        return cb(Object.assign(new Error(`Refusing to connect: ${hostname} resolves only to private/internal addresses`), { code: "EBLOCKED_PRIVATE_IP" }), [], undefined);
      }
      return cb(null, safe);
    }
    if (typeof address === "string" && isPrivateIp(address)) {
      return cb(Object.assign(new Error(`Refusing to connect: ${hostname} → ${address} (private/internal)`), { code: "EBLOCKED_PRIVATE_IP" }), "", undefined);
    }
    return cb(null, address, family);
  });
}

interface FetchResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
  finalUrl: string;
  error?: string;
}

interface FetchOpts {
  headers?: Record<string, string>;
}

function singleRequest(targetUrl: string, opts: FetchOpts): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  truncated: boolean;
}> {
  return new Promise((resolve, reject) => {
    let parsed: NodeURL;
    try { parsed = new NodeURL(targetUrl); } catch (e) { return reject(e); }
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const reqOpts: http.RequestOptions = {
      method: "GET",
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: { "Accept": "*/*", ...(opts.headers || {}) },
      lookup: safeLookup as unknown as http.RequestOptions["lookup"],
      timeout: FETCH_TIMEOUT_MS,
    };
    const req = lib.request(reqOpts, (res) => {
      let body = "";
      let received = 0;
      let truncated = false;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        received += Buffer.byteLength(chunk);
        if (received > MAX_BODY_BYTES) {
          truncated = true;
          body += chunk.slice(0, Math.max(0, MAX_BODY_BYTES - (received - Buffer.byteLength(chunk))));
          res.destroy();
          return;
        }
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body, truncated }));
      res.on("error", reject);
      res.on("close", () => {
        if (truncated) resolve({ status: res.statusCode || 0, headers: res.headers, body, truncated });
      });
    });
    req.on("timeout", () => { req.destroy(new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`)); });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetches a URL with manual redirect handling so we can re-validate every redirect
 * target against the SSRF allowlist. Each hop independently passes through
 * `assertSafeUrlShape` (URL/protocol/local-literal gate) and `safeLookup` (per-connect
 * private-IP rejection — closes the DNS-rebinding TOCTOU window).
 */
async function fetchBounded(initialUrl: string, opts: FetchOpts = {}): Promise<FetchResult> {
  let url = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safety = assertSafeUrlShape(url);
    if (!safety.ok) {
      return { ok: false, status: 0, contentType: null, body: "", truncated: false, finalUrl: url, error: safety.reason };
    }
    try {
      const r = await singleRequest(url, opts);
      const contentType = (r.headers["content-type"] as string | undefined) ?? null;
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers["location"] as string | undefined;
        if (!loc) {
          return { ok: false, status: r.status, contentType, body: "", truncated: false, finalUrl: url, error: `HTTP ${r.status} without Location header` };
        }
        const next = abs(url, loc);
        if (!next) {
          return { ok: false, status: r.status, contentType, body: "", truncated: false, finalUrl: url, error: `Invalid redirect target: ${loc}` };
        }
        if (hop === MAX_REDIRECTS) {
          return { ok: false, status: r.status, contentType, body: "", truncated: false, finalUrl: url, error: `Too many redirects (>${MAX_REDIRECTS})` };
        }
        url = next;
        continue;
      }
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        contentType,
        body: r.body,
        truncated: r.truncated,
        finalUrl: url,
      };
    } catch (e: unknown) {
      return {
        ok: false, status: 0, contentType: null, body: "", truncated: false, finalUrl: url,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return { ok: false, status: 0, contentType: null, body: "", truncated: false, finalUrl: url, error: "Exceeded redirect budget" };
}

export function findScriptSources(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[2]);
  return out;
}

export function looksLikePulseScript(url: string, body: string): boolean {
  if (/pulse\.js|tracker\.js/i.test(url)) return true;
  // Fingerprint our IIFE: presence of these literal strings is highly specific to pulse.js.
  return body.includes("_attr_data") && body.includes("/api/collect/submit");
}

/**
 * Per-script-tag classification used by Verify Tracker. The five values match
 * the operator-facing taxonomy in the Tracker Health view:
 *
 * - `pulse-current`: a fetched <script src=…> that is the current Pulse build
 *   (the URL ends in pulse.js OR the body fingerprints pulse.js literals AND
 *   the response was JS not HTML). This is the "good" state.
 * - `pulse-legacy`: a `pulse.js` URL that returns JS but does NOT contain the
 *   current fingerprint literals (older build / partial deploy).
 * - `optics-legacy`: any URL containing "tracker.js" OR pointing at a
 *   hvaclaunch-optics.replit.app host. This is the EXACT failure mode that
 *   broke Vance Heating — the page loads the old Optics tracker which posts
 *   to a different deployment and a different tenant id.
 * - `unknown-tracker`: a `<script>` whose URL or body looks tracker-shaped
 *   (matches /tracker|analytics|pixel/) but isn't ours.
 * - `none`: returned at the *page* level when no candidate script tag is
 *   found at all. Per-script entries never use this value.
 */
export type ScriptKind = "pulse-current" | "pulse-legacy" | "optics-legacy" | "unknown-tracker" | "none";

export function classifyScriptKind(args: {
  src: string;
  resolvedUrl: string | null;
  ok: boolean;
  contentType: string | null;
  body: string;
}): ScriptKind {
  const { src, resolvedUrl, ok, contentType, body } = args;
  const url = (resolvedUrl || src).toLowerCase();
  const ctRaw = (contentType || "").toLowerCase();
  const isJs = ctRaw.includes("javascript") || ctRaw.includes("ecmascript");

  // Optics-legacy is determined by host/path even when the file is dead —
  // an HTML 200 from the Optics deployment URL is STILL the same install
  // mistake as a working Optics tracker.
  if (/hvaclaunch-optics\.replit\.app|\btracker\.js\b/i.test(url)) {
    return "optics-legacy";
  }
  if (/\bpulse\.js\b/i.test(url)) {
    if (ok && isJs && body.includes("_attr_data") && body.includes("/api/collect/submit")) {
      return "pulse-current";
    }
    // pulse.js URL but missing fingerprint → legacy / mis-built / proxy issue.
    return "pulse-legacy";
  }
  // Body-fingerprint match against arbitrary URLs (e.g. served via a CDN
  // path). Treated as current if the literals are present.
  if (ok && isJs && body.includes("_attr_data") && body.includes("/api/collect/submit")) {
    return "pulse-current";
  }
  return "unknown-tracker";
}

/**
 * Extract the data-* attributes from the original <script> tag in the page
 * HTML — used to compare data-tenant / data-client-id against the verifier's
 * session tenant. Returns null if the tag could not be located.
 */
export function extractScriptDataAttrs(html: string, scriptSrc: string): Record<string, string> | null {
  // Find <script ... src="<scriptSrc>" ...></script> (or <script ... src='...'>).
  const escaped = scriptSrc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*(['"])${escaped}\\1[^>]*>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  const tag = m[0];
  const attrs: Record<string, string> = {};
  const attrRe = /\bdata-([a-zA-Z0-9_-]+)\s*=\s*(['"])([^'"]*)\2/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(tag)) !== null) {
    attrs[am[1].toLowerCase()] = am[3];
  }
  return Object.keys(attrs).length > 0 ? attrs : {};
}

/**
 * Form / iframe inventory for a page. Used by Verify Tracker to surface
 * "the page has 3 forms — 1 native, 2 in GHL iframes; here's the breakdown".
 *
 * The list of recognised builders is intentionally hard-coded against the
 * domains the customer base actually uses — each entry is a pair of
 * (builder name, host pattern). New builders should be added here as they
 * come up in customer audits, not auto-detected.
 */
const KNOWN_FORM_BUILDERS: Array<{ builder: string; host: RegExp }> = [
  { builder: "leadconnector", host: /(^|\.)leadconnectorhq\.com$|(^|\.)msgsndr\.com$|(^|\.)ghl\.io$/i },
  { builder: "highlevel",     host: /(^|\.)gohighlevel\.com$|(^|\.)highlevel\.com$/i },
  { builder: "typeform",      host: /(^|\.)typeform\.com$/i },
  { builder: "hubspot",       host: /(^|\.)hsforms\.(com|net)$|(^|\.)hubspot\.com$/i },
  { builder: "framer",        host: /(^|\.)framer\.com$|(^|\.)framercanvas\.com$|(^|\.)framerusercontent\.com$/i },
  { builder: "servicetitan",  host: /servicetitan\.com$|(^|\.)bookingjs\./i },
  { builder: "clickfunnels",  host: /(^|\.)clickfunnels\.com$|(^|\.)myclickfunnels\.com$/i },
  { builder: "wufoo",         host: /(^|\.)wufoo\.com$/i },
  { builder: "calendly",      host: /(^|\.)calendly\.com$/i },
];

export interface FormInventoryItem {
  kind: "form" | "iframe";
  // For native <form>: the 'action' attribute (or null). For iframes: the
  // iframe src URL.
  source: string | null;
  // For iframes: best-guess builder ("leadconnector", "framer", etc) or
  // "unknown" if no host pattern matches.
  builder: string | null;
  // For iframes: the iframe's host. For native forms: null.
  host: string | null;
  // For native forms: best-effort field-name list extracted from <input
  // name="…">. Empty for iframes (we can't see across the iframe boundary
  // from the static fetch — that's exactly what pulse.js capture mode is
  // for).
  fieldNames: string[];
}

function classifyIframeBuilder(iframeHost: string | null): string {
  if (!iframeHost) return "unknown";
  for (const entry of KNOWN_FORM_BUILDERS) {
    if (entry.host.test(iframeHost)) return entry.builder;
  }
  return "unknown";
}

export function buildFormInventory(html: string, baseUrl: string): FormInventoryItem[] {
  const out: FormInventoryItem[] = [];

  // Native <form>...</form> blocks (greedy across newlines, capped to 100).
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm: RegExpExecArray | null;
  let formCount = 0;
  while ((fm = formRe.exec(html)) !== null && formCount < 100) {
    formCount++;
    const attrs = fm[1] || "";
    const innerHtml = fm[2] || "";
    const actionMatch = /\baction\s*=\s*(['"])([^'"]*)\1/i.exec(attrs);
    const action = actionMatch ? actionMatch[2] : null;
    const fieldNameRe = /<(?:input|select|textarea)\b[^>]*\bname\s*=\s*(['"])([^'"]+)\1/gi;
    const names = new Set<string>();
    let nm: RegExpExecArray | null;
    while ((nm = fieldNameRe.exec(innerHtml)) !== null) {
      names.add(nm[2]);
      if (names.size >= 50) break;
    }
    out.push({ kind: "form", source: action, builder: null, host: null, fieldNames: Array.from(names) });
  }

  // <iframe src="..."> — extract every one, classify by host.
  const iframeRe = /<iframe\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1[^>]*>/gi;
  let im: RegExpExecArray | null;
  let iframeCount = 0;
  while ((im = iframeRe.exec(html)) !== null && iframeCount < 100) {
    iframeCount++;
    const src = im[2];
    const resolved = abs(baseUrl, src);
    const iframeHost = resolved ? host(resolved) : null;
    const builder = classifyIframeBuilder(iframeHost);
    out.push({
      kind: "iframe",
      source: resolved || src,
      builder,
      host: iframeHost,
      fieldNames: [],
    });
  }

  return out;
}

export type ScriptVerdict =
  | { level: "ok"; }
  | { level: "warning"; message: string }
  | { level: "error"; message: string };

/**
 * Classifies a fetched script response into a verdict. Critically: an HTML response is
 * ALWAYS an error — even when the URL path looks like our tracker (Vance failure mode).
 */
export function classifyScriptResponse(args: {
  src: string;
  ok: boolean;
  status: number;
  contentType: string | null;
  body: string;
  fetchError?: string;
}): ScriptVerdict {
  const { src, ok, status, contentType, body, fetchError } = args;
  if (fetchError) return { level: "error", message: `Script ${src} could not be fetched: ${fetchError}` };
  if (!ok) return { level: "error", message: `Script ${src} returned HTTP ${status}.` };
  const ctRaw = (contentType || "").toLowerCase();
  const isJs = ctRaw.includes("javascript") || ctRaw.includes("ecmascript");
  const isHtmlScript = ctRaw.includes("text/html") || (!ctRaw && /<!doctype html|<html[\s>]/i.test(body));
  if (isHtmlScript) {
    return {
      level: "error",
      message: `Script ${src} returned HTML instead of JavaScript (content-type: ${contentType || "unknown"}). The script tag is dead — remove it or fix the src.`,
    };
  }
  if (!isJs) {
    return {
      level: "error",
      message: `Script ${src} returned non-JavaScript content-type "${contentType}". Browsers will refuse to execute it.`,
    };
  }
  if (!looksLikePulseScript(src, body)) {
    return { level: "warning", message: `Script ${src} loaded but does not look like a pulse.js build (no _attr_data or /api/collect/submit fingerprint).` };
  }
  return { level: "ok" };
}

router.post("/verify-tracker", async (req, res) => {
  // Role gate: this endpoint can fetch arbitrary URLs and reads heartbeats. Restrict to
  // agency/admin/super_admin and (for client_user) the user's own tenant. We never reveal
  // tenant names outside the caller's visibility.
  const userId = req.session?.userId;
  const role = req.session?.userRole;
  const sessionTenantId = req.session?.tenantId ? Number(req.session.tenantId) : null;
  if (!userId || !role) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const isAgency = role === "super_admin" || role === "agency_user";
  if (!isAgency && role !== "client_user" && role !== "client_admin") {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const targetUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    res.status(400).json({ error: "url (http/https) is required" });
    return;
  }

  const targetHost = host(targetUrl);
  if (!targetHost) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  const findings: Array<{ level: "info" | "warning" | "error"; message: string }> = [];

  const page = await fetchBounded(targetUrl, {
    headers: { "User-Agent": "PulseVerify/1.0 (+https://pulse)" },
  });

  if (page.error) {
    findings.push({ level: "error", message: `Could not load page: ${page.error}` });
  } else if (!page.ok) {
    findings.push({ level: "error", message: `Page returned HTTP ${page.status}.` });
  }

  const ctype = (page.contentType || "").toLowerCase();
  const isHtml = ctype.includes("text/html") || /<html[\s>]/i.test(page.body);
  if (page.body && !isHtml) {
    findings.push({ level: "warning", message: `Response was not HTML (content-type: ${page.contentType}). The script tag may be inside a JS-rendered SPA we cannot statically scan.` });
  }

  const allSrcs = findScriptSources(page.body);
  // Consider any tracker-shaped script tag — pulse.js, legacy tracker.js, OR
  // anything pointing at the legacy hvaclaunch-optics.replit.app deployment
  // (the EXACT pattern that broke Vance Heating: a tracker.js pointing at
  // the old Optics deploy with a wrong tenant id).
  const trackerSrcs = allSrcs.filter(s => /\bpulse\.js\b|\btracker\.js\b|hvaclaunch-optics\.replit\.app/i.test(s));

  const scripts: Array<{
    src: string;
    resolvedUrl: string | null;
    status: number;
    contentType: string | null;
    bytes: number;
    looksLikePulse: boolean;
    kind: ScriptKind;
    dataAttrs: Record<string, string> | null;
    error?: string;
  }> = [];

  // Page-level script verdict: the kind of the BEST script tag on the page.
  // Order of preference: pulse-current > pulse-legacy > optics-legacy > unknown-tracker > none
  let pageScriptKind: ScriptKind = "none";
  function rankKind(k: ScriptKind): number {
    return k === "pulse-current" ? 4 : k === "pulse-legacy" ? 3 : k === "optics-legacy" ? 2 : k === "unknown-tracker" ? 1 : 0;
  }

  if (trackerSrcs.length === 0) {
    findings.push({ level: "warning", message: "No <script src=…pulse.js> or legacy tracker.js found in the static HTML. If the page injects the tracker via GTM or a JS framework, that's expected — but a static <script> tag is the most reliable install path." });
  }

  for (const src of trackerSrcs) {
    const resolved = abs(targetUrl, src);
    const dataAttrs = extractScriptDataAttrs(page.body, src);
    if (!resolved) {
      const kind: ScriptKind = classifyScriptKind({ src, resolvedUrl: null, ok: false, contentType: null, body: "" });
      scripts.push({ src, resolvedUrl: null, status: 0, contentType: null, bytes: 0, looksLikePulse: false, kind, dataAttrs, error: "Could not resolve URL" });
      if (rankKind(kind) > rankKind(pageScriptKind)) pageScriptKind = kind;
      continue;
    }
    const r = await fetchBounded(resolved);
    const verdict = classifyScriptResponse({
      src, ok: r.ok, status: r.status, contentType: r.contentType, body: r.body, fetchError: r.error,
    });
    const kind: ScriptKind = classifyScriptKind({
      src, resolvedUrl: resolved, ok: r.ok, contentType: r.contentType, body: r.body,
    });
    scripts.push({
      src,
      resolvedUrl: resolved,
      status: r.status,
      contentType: r.contentType,
      bytes: r.body.length,
      looksLikePulse: looksLikePulseScript(resolved, r.body),
      kind,
      dataAttrs,
      error: r.error,
    });
    if (verdict.level !== "ok") {
      findings.push({ level: verdict.level, message: verdict.message });
    }
    if (rankKind(kind) > rankKind(pageScriptKind)) pageScriptKind = kind;
  }

  // Loud, banner-ready finding when the page is on the wrong tracker entirely.
  // This is the headline error operators need to see — everything else is
  // secondary diagnostics.
  if (pageScriptKind === "optics-legacy") {
    findings.push({
      level: "error",
      message: `This page loads the LEGACY Optics tracker (tracker.js / hvaclaunch-optics.replit.app), not the current Pulse build. Submits will go to the wrong deployment and a different tenant id — this is exactly how the Vance Heating outage happened. Replace the script tag with the per-tenant Pulse install snippet from Settings → Tracker Health.`,
    });
  } else if (pageScriptKind === "pulse-legacy") {
    findings.push({
      level: "warning",
      message: `Page references pulse.js but the served file does not contain the current build's fingerprint literals. Either it is an older deploy or it is being served through a stripping proxy.`,
    });
  } else if (pageScriptKind === "unknown-tracker") {
    findings.push({
      level: "warning",
      message: `Page has a tracker-shaped script tag that is not a recognised Pulse build.`,
    });
  }

  // data-tenant / data-client-id mismatch reporting against the verifying
  // user's session tenant. We can only check this for client_user / client_admin
  // (whose session is bound to one tenant); agency/super_admin can verify
  // any URL so a "mismatch" against THEIR session would be a false positive.
  if (!isAgency && sessionTenantId) {
    const [sessTenant] = await db.select({ id: tenantsTable.id, clientSlug: tenantsTable.clientSlug })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, sessionTenantId))
      .limit(1);
    if (sessTenant) {
      for (const s of scripts) {
        if (!s.dataAttrs) continue;
        const dataTenant = s.dataAttrs["tenant"] || null;
        const dataClientId = s.dataAttrs["client-id"] || null;
        if (dataTenant && Number(dataTenant) !== sessTenant.id) {
          findings.push({
            level: "error",
            message: `Script <${s.src}> has data-tenant="${dataTenant}" but your tenant is id=${sessTenant.id} (${sessTenant.clientSlug}). Submits from this page will be attributed to a different tenant.`,
          });
        }
        if (dataClientId && sessTenant.clientSlug && dataClientId !== sessTenant.clientSlug) {
          findings.push({
            level: "error",
            message: `Script <${s.src}> has data-client-id="${dataClientId}" but your client slug is "${sessTenant.clientSlug}". Submits from this page will be attributed to the wrong tenant.`,
          });
        }
      }
    }
  }

  // Form / iframe inventory — surfaces "the page has 3 forms, 2 in GHL
  // iframes; here's what's actually there" so an operator can see the
  // form surface without reverse-engineering the page.
  const formInventory = page.body ? buildFormInventory(page.body, targetUrl) : [];
  if (formInventory.length === 0 && page.body && isHtml) {
    findings.push({
      level: "info",
      message: `No <form> tags or recognised form-builder iframes found in the static HTML. If a form appears here it's likely injected by JS post-load — use the ?pulse_capture=1 diagnostic mode on this page to capture what pulse.js sees at runtime.`,
    });
  }
  const iframeBuilders = formInventory.filter(f => f.kind === "iframe").map(f => f.builder).filter((b): b is string => !!b && b !== "unknown");
  if (iframeBuilders.length > 0) {
    findings.push({
      level: "info",
      message: `Detected form-builder iframes: ${Array.from(new Set(iframeBuilders)).join(", ")}. Make sure pulse.js is installed in the parent page (not just inside the iframe) — Framer / GHL iframes need the script in the page <head>, not via GTM-only injection.`,
    });
  }

  // Heartbeat lookup: scoped to the caller's visibility.
  // - agency/super_admin: see all tenants with a heartbeat for this hostname.
  // - client_user/client_admin: only their own tenant's heartbeat (if any).
  const heartbeatWhere = isAgency
    ? eq(trackerHeartbeatsTable.domain, targetHost)
    : and(
        eq(trackerHeartbeatsTable.domain, targetHost),
        sessionTenantId ? eq(trackerHeartbeatsTable.tenantId, sessionTenantId) : eq(trackerHeartbeatsTable.tenantId, -1),
      );
  const heartbeats = await db
    .select({
      id: trackerHeartbeatsTable.id,
      tenantId: trackerHeartbeatsTable.tenantId,
      tenantName: tenantsTable.name,
      domain: trackerHeartbeatsTable.domain,
      lastSeenAt: trackerHeartbeatsTable.lastSeenAt,
      firstPageUrl: trackerHeartbeatsTable.firstPageUrl,
    })
    .from(trackerHeartbeatsTable)
    .leftJoin(tenantsTable, eq(tenantsTable.id, trackerHeartbeatsTable.tenantId))
    .where(heartbeatWhere)
    .orderBy(desc(trackerHeartbeatsTable.lastSeenAt));

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let recentEventCount = 0;
  if (heartbeats.length > 0) {
    const tenantIds = Array.from(new Set(heartbeats.map(h => h.tenantId)));
    for (const tid of tenantIds) {
      const events = await db
        .select({ pageUrl: attributionEventsTable.pageUrl, landingPage: attributionEventsTable.landingPage })
        .from(attributionEventsTable)
        .where(and(
          eq(attributionEventsTable.tenantId, tid),
          gte(attributionEventsTable.createdAt, twentyFourHoursAgo),
        ));
      for (const ev of events) {
        if (host(ev.pageUrl || "") === targetHost || host(ev.landingPage || "") === targetHost) {
          recentEventCount++;
        }
      }
    }
  }

  if (heartbeats.length === 0) {
    findings.push({ level: "warning", message: `No heartbeat from ${targetHost} on record. Either the tracker has never loaded here, or it's loaded but cannot reach /api/collect/heartbeat (CSP, ad blocker, network).` });
  } else {
    const newest = heartbeats[0];
    if (new Date(newest.lastSeenAt) < twentyFourHoursAgo) {
      findings.push({ level: "warning", message: `Heartbeat exists but is stale (last seen ${new Date(newest.lastSeenAt).toISOString()}).` });
    }
    if (recentEventCount === 0) {
      findings.push({ level: "warning", message: `Heartbeat present (tenant: ${newest.tenantName || newest.tenantId}) but zero form-fill events captured in the last 24h. Capture is silently failing.` });
    }
  }

  // Recent submit/heartbeat audit log — same visibility rules as heartbeats.
  // This is the trip-wire that surfaces silent 4xx/5xx rejections (the
  // problem this whole feature was built to catch).
  const auditWhere = isAgency
    ? eq(trackerSubmitAttemptsTable.domain, targetHost)
    : and(
        eq(trackerSubmitAttemptsTable.domain, targetHost),
        sessionTenantId ? eq(trackerSubmitAttemptsTable.tenantId, sessionTenantId) : eq(trackerSubmitAttemptsTable.tenantId, -1),
      );
  const recentAttempts = await db
    .select({
      id: trackerSubmitAttemptsTable.id,
      tenantId: trackerSubmitAttemptsTable.tenantId,
      tenantName: tenantsTable.name,
      clientId: trackerSubmitAttemptsTable.clientId,
      endpoint: trackerSubmitAttemptsTable.endpoint,
      pageUrl: trackerSubmitAttemptsTable.pageUrl,
      outcome: trackerSubmitAttemptsTable.outcome,
      httpStatus: trackerSubmitAttemptsTable.httpStatus,
      message: trackerSubmitAttemptsTable.message,
      pulseVersion: trackerSubmitAttemptsTable.pulseVersion,
      attributionEventId: trackerSubmitAttemptsTable.attributionEventId,
      createdAt: trackerSubmitAttemptsTable.createdAt,
    })
    .from(trackerSubmitAttemptsTable)
    .leftJoin(tenantsTable, eq(tenantsTable.id, trackerSubmitAttemptsTable.tenantId))
    .where(auditWhere)
    .orderBy(desc(trackerSubmitAttemptsTable.createdAt))
    .limit(20);

  // Surface failed submits as findings. A successful heartbeat with
  // failing submits is the EXACT pattern that broke Vance — call it out
  // even when other signals look healthy.
  // CRITICAL: filter on `kind` not `endpoint`. logTrackerDiagnostic writes
  // endpoint='submit' for back-compat but kind='diagnostic' with outcome
  // 'diagnostic_recorded' (HTTP 200). Without the kind guard those rows
  // would be surfaced as "submit failures" because their outcome is not in
  // the success set — flooding Verify Tracker with false red errors every
  // time a tenant has capture mode enabled.
  const recentFailedSubmits = recentAttempts.filter(
    a => a.endpoint === "submit"
      && (a as { kind?: string }).kind !== "diagnostic"
      && a.outcome !== "accepted"
      && a.outcome !== "duplicate"
      && a.outcome !== "resubmitted",
  );
  if (recentFailedSubmits.length > 0) {
    const sample = recentFailedSubmits[0];
    findings.push({
      level: "error",
      message: `${recentFailedSubmits.length} recent submit attempt(s) from ${targetHost} were rejected (most recent: HTTP ${sample.httpStatus} "${sample.outcome}" — ${sample.message || "no message"}). Heartbeat status alone will NOT catch this; check the audit log below.`,
    });
  }

  // 24h / 7d HTTP-status breakdowns for the hostname, scoped to the caller's
  // visible tenant set. These power the "Tracker Health" view's status pills.
  const visibleTenantIds = isAgency ? undefined : (sessionTenantId ? [sessionTenantId] : []);
  const [breakdown24h, breakdown7d] = await Promise.all([
    getDomainSubmitBreakdown({ domain: targetHost, windowHours: 24, tenantIds: visibleTenantIds }),
    getDomainSubmitBreakdown({ domain: targetHost, windowHours: 24 * 7, tenantIds: visibleTenantIds }),
  ]);

  // Per-domain install verdict: combines the tracker-script kind, heartbeat
  // freshness, and submit history into a single operator-facing label.
  let installVerdict: "pulse-ok" | "wrong-tracker-installed" | "no-tracker-found" | "heartbeat-only-never-submitted" | "stale-install" = "no-tracker-found";
  if (pageScriptKind === "optics-legacy" || pageScriptKind === "unknown-tracker") {
    installVerdict = "wrong-tracker-installed";
  } else if (pageScriptKind === "pulse-current" || pageScriptKind === "pulse-legacy") {
    if (breakdown7d.submitOk === 0 && heartbeats.length > 0) {
      installVerdict = "heartbeat-only-never-submitted";
    } else if (heartbeats.length > 0 && new Date(heartbeats[0].lastSeenAt) < twentyFourHoursAgo) {
      installVerdict = "stale-install";
    } else {
      installVerdict = "pulse-ok";
    }
  } else if (heartbeats.length > 0) {
    // No script tag found in static HTML but heartbeat exists — probably
    // injected via GTM. Borderline state.
    installVerdict = breakdown7d.submitOk > 0 ? "pulse-ok" : "heartbeat-only-never-submitted";
  }

  const overall: "green" | "amber" | "red" =
    findings.some(f => f.level === "error") ? "red"
    : findings.some(f => f.level === "warning") ? "amber"
    : "green";

  res.json({
    url: targetUrl,
    host: targetHost,
    overall,
    findings,
    scripts,
    pageScriptKind,
    installVerdict,
    formInventory,
    statusBreakdown: {
      last24h: breakdown24h,
      last7d: breakdown7d,
    },
    heartbeats: heartbeats.map(h => ({
      tenantId: h.tenantId,
      tenantName: h.tenantName,
      lastSeenAt: h.lastSeenAt,
      firstPageUrl: h.firstPageUrl,
    })),
    recentEventCount24h: recentEventCount,
    recentAttempts: recentAttempts.map(a => ({
      id: a.id,
      tenantId: a.tenantId,
      tenantName: a.tenantName,
      clientId: a.clientId,
      endpoint: a.endpoint,
      pageUrl: a.pageUrl,
      outcome: a.outcome,
      httpStatus: a.httpStatus,
      message: a.message,
      pulseVersion: a.pulseVersion,
      attributionEventId: a.attributionEventId,
      createdAt: a.createdAt,
    })),
    debugUrl: `${targetUrl}${targetUrl.includes("?") ? "&" : "?"}pulse_debug=1`,
    captureUrl: `${targetUrl}${targetUrl.includes("?") ? "&" : "?"}pulse_capture=1`,
  });
});

export default router;
