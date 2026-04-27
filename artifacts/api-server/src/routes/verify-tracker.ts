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
  return body.includes("_attr_data") && body.includes("/api/collect/submit");
}

/**
 * Per-script-tag classification:
 * - pulse-current: pulse.js URL OR body fingerprints (current build)
 * - pulse-legacy: pulse.js URL but missing current fingerprint literals
 * - optics-legacy: tracker.js URL or hvaclaunch-optics.replit.app host
 * - unknown-tracker: tracker-shaped URL but not Pulse
 * - none: page-level only when no candidate tag found
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

  // optics-legacy by host/path even if the file is dead
  if (/hvaclaunch-optics\.replit\.app|\btracker\.js\b/i.test(url)) {
    return "optics-legacy";
  }
  if (/\bpulse\.js\b/i.test(url)) {
    if (ok && isJs && body.includes("_attr_data") && body.includes("/api/collect/submit")) {
      return "pulse-current";
    }
    return "pulse-legacy";
  }
  // body-fingerprint match (handles CDN-served pulse.js)
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
  source: string | null;
  builder: string | null;
  host: string | null;
  // native-form input names (empty for iframes — capture-mode covers those)
  fieldNames: string[];
  // total count of visible (non-hidden, non-button/submit/reset/image) input,
  // select, and textarea elements inside this <form>. Always 0 for iframes —
  // the parent page can't introspect cross-origin form internals.
  visibleInputCount: number;
  // subset of visibleInputCount that lack a `name=` attribute. The Vance
  // failure mode (Task #295) was a React form whose visible inputs only had
  // `data-testid`, so `new FormData(form)` skipped them entirely.
  unnamedVisibleInputCount: number;
}

function classifyIframeBuilder(iframeHost: string | null): string {
  if (!iframeHost) return "unknown";
  for (const entry of KNOWN_FORM_BUILDERS) {
    if (entry.host.test(iframeHost)) return entry.builder;
  }
  return "unknown";
}

/**
 * Task #292 — known honeypot field-name decoys. MUST stay in sync with
 * the `HONEYPOT_NAMES` table in `public/pulse.js` so that a form built
 * around one of these names is recognised as a honeypot-only shell from
 * the static HTML scan AND from the runtime capture path.
 *
 * Conservative on purpose: real customer field names like `address` and
 * `homepage` (a plausible website-URL field) are NOT included — adding
 * them would silently misclassify legitimate forms as honeypot-only.
 */
const HONEYPOT_FIELD_NAMES = new Set<string>([
  "company_url", "honeypot", "bot_field",
  "leave_blank", "_gotcha", "form_honeypot", "winnie_the_pooh",
]);

function normalizeHoneypotName(name: string): string {
  return name.toLowerCase().replace(/[\s-]/g, "_");
}

/**
 * Given a `buildFormInventory()` result, return true if any native
 * `<form>` in the inventory has at least one named field AND every named
 * field is a honeypot decoy. This is the static-HTML signal for the
 * exact failure mode Task #292 fixes: GHL-hosted funnels expose only the
 * `company_url` honeypot inside the `<form>` shell, so a Verify Tracker
 * scan that hits the page can warn the operator before a customer
 * complains about missing leads.
 */
export function formInventoryHasHoneypotOnlyShape(items: FormInventoryItem[]): boolean {
  for (const item of items) {
    if (item.kind !== "form") continue;
    if (item.fieldNames.length === 0) continue;
    let allHoneypot = true;
    for (const n of item.fieldNames) {
      if (!HONEYPOT_FIELD_NAMES.has(normalizeHoneypotName(n))) { allHoneypot = false; break; }
    }
    if (allHoneypot) return true;
  }
  return false;
}

/**
 * Task #295 — broader sibling of `formInventoryHasHoneypotOnlyShape`.
 * Returns true if any native `<form>` in the inventory has at least 2
 * visible inputs (non-hidden, non-button) AND ≥50% of them lack a
 * `name=` attribute.
 *
 * The Vance Heating outage (Task #292) was triggered by a React form
 * whose visible inputs only carried `data-testid` — `new FormData(form)`
 * silently skipped them and Pulse received only the honeypot. The
 * honeypot-only check catches that exact page; this broader check
 * surfaces the underlying mistake on ANY scanned form, even ones
 * without a honeypot decoy, before customers complain about missing
 * leads.
 *
 * The 50% threshold is deliberate: a single forgotten `name=` on an
 * otherwise well-formed contact form is too noisy to flag, but a form
 * where half (or more) of the visible inputs are unnamed is almost
 * certainly built around a state-only React/Vue binding that bypasses
 * FormData entirely.
 */
export function formInventoryHasMissingNameShape(items: FormInventoryItem[]): boolean {
  for (const item of items) {
    if (item.kind !== "form") continue;
    if (item.visibleInputCount < 2) continue;
    // ≥50% unnamed → ratio test without floating point: unnamed * 2 >= total
    if (item.unnamedVisibleInputCount * 2 >= item.visibleInputCount) return true;
  }
  return false;
}

export function buildFormInventory(html: string, baseUrl: string): FormInventoryItem[] {
  const out: FormInventoryItem[] = [];

  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm: RegExpExecArray | null;
  let formCount = 0;
  while ((fm = formRe.exec(html)) !== null && formCount < 100) {
    formCount++;
    const attrs = fm[1] || "";
    const innerHtml = fm[2] || "";
    const actionMatch = /\baction\s*=\s*(['"])([^'"]*)\1/i.exec(attrs);
    const action = actionMatch ? actionMatch[2] : null;

    // Per-tag scan so we can also count visible-but-unnamed inputs.
    // Browsers' `new FormData(form)` only includes elements with a
    // `name=` attribute, so unnamed visible inputs are the diagnostic
    // signal Task #295 wants surfaced.
    const tagRe = /<(input|select|textarea)\b([^>]*?)\/?>/gi;
    const names = new Set<string>();
    let visibleInputCount = 0;
    let unnamedVisibleInputCount = 0;
    let scanned = 0;
    let tm: RegExpExecArray | null;
    while ((tm = tagRe.exec(innerHtml)) !== null && scanned < 200) {
      scanned++;
      const tagName = tm[1].toLowerCase();
      const tagAttrs = tm[2] || "";
      const typeMatch = /\btype\s*=\s*(?:(['"])([^'"]*)\1|([^\s>]+))/i.exec(tagAttrs);
      const type = (typeMatch ? (typeMatch[2] ?? typeMatch[3] ?? "") : "").toLowerCase();
      const nameMatch = /\bname\s*=\s*(['"])([^'"]+)\1/i.exec(tagAttrs);
      if (nameMatch && names.size < 50) names.add(nameMatch[2]);
      // <input> with non-data type (hidden / submit-style) is not a
      // visible data input. <select> and <textarea> have no equivalent
      // non-data type, so they always count as visible.
      if (tagName === "input") {
        if (type === "hidden" || type === "submit" || type === "button" || type === "reset" || type === "image") {
          continue;
        }
      }
      visibleInputCount++;
      if (!nameMatch) unnamedVisibleInputCount++;
    }
    out.push({
      kind: "form",
      source: action,
      builder: null,
      host: null,
      fieldNames: Array.from(names),
      visibleInputCount,
      unnamedVisibleInputCount,
    });
  }

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
      visibleInputCount: 0,
      unnamedVisibleInputCount: 0,
    });
  }

  return out;
}

export type ScriptVerdict =
  | { level: "ok"; }
  | { level: "warning"; message: string }
  | { level: "error"; message: string };

export type InstallVerdict =
  | "pulse-ok"
  | "wrong-tracker-installed"
  | "legacy-tag-dead"
  | "no-tracker-found"
  | "heartbeat-only-never-submitted"
  | "stale-install";

/**
 * Pure, testable mapping from (page script kind + per-script dead-resource flags +
 * heartbeat freshness + 7d submit-success count) to an install verdict.
 *
 * The crucial new rule lives here: an `optics-legacy` page is only flagged red as
 * `wrong-tracker-installed` when the legacy URL is actually still serving JavaScript.
 * When every legacy script tag is dead AND a fresh heartbeat exists in the last 24h
 * (proving pulse.js is running via GTM), we downgrade to amber `legacy-tag-dead`.
 */
export function computeInstallVerdict(args: {
  pageScriptKind: ScriptKind;
  scripts: Array<{ kind: ScriptKind; isDeadResource: boolean }>;
  hasFreshHeartbeat: boolean;
  hasAnyHeartbeat: boolean;
  submitOk7d: number;
}): InstallVerdict {
  const { pageScriptKind, scripts, hasFreshHeartbeat, hasAnyHeartbeat, submitOk7d } = args;
  if (pageScriptKind === "optics-legacy") {
    const opticsLegacyScripts = scripts.filter(s => s.kind === "optics-legacy");
    const allLegacyDead = opticsLegacyScripts.length > 0 && opticsLegacyScripts.every(s => s.isDeadResource);
    return (allLegacyDead && hasFreshHeartbeat) ? "legacy-tag-dead" : "wrong-tracker-installed";
  }
  if (pageScriptKind === "pulse-current" || pageScriptKind === "pulse-legacy") {
    if (submitOk7d === 0 && hasAnyHeartbeat) return "heartbeat-only-never-submitted";
    if (hasAnyHeartbeat && !hasFreshHeartbeat) return "stale-install";
    return "pulse-ok";
  }
  if (hasAnyHeartbeat) {
    return submitOk7d > 0 ? "pulse-ok" : "heartbeat-only-never-submitted";
  }
  return "no-tracker-found";
}

/**
 * Reports whether a fetched script response is "dead" from the browser's perspective:
 * fetch error, non-2xx HTTP, HTML body served as a script, or a non-JS content-type.
 * A live, executing JS file is the ONLY non-dead case.
 *
 * Used by the install-verdict logic to downgrade a legacy `tracker.js` `<script>` tag
 * to a `legacy-tag-dead` warning when the URL no longer serves JS but pulse.js is
 * known to be running via GTM (active heartbeats).
 */
export function isScriptResponseDead(args: {
  ok: boolean;
  contentType: string | null;
  body: string;
  fetchError?: string;
}): boolean {
  const { ok, contentType, body, fetchError } = args;
  if (fetchError) return true;
  if (!ok) return true;
  // An empty 200 response is dead from the browser's perspective — nothing
  // executes. Catches the case where a CDN serves an empty file at the
  // legacy URL.
  if (body.trim().length === 0) return true;
  const ctRaw = (contentType || "").toLowerCase();
  const isJs = ctRaw.includes("javascript") || ctRaw.includes("ecmascript");
  const isHtmlScript = ctRaw.includes("text/html") || (!ctRaw && /<!doctype html|<html[\s>]/i.test(body));
  if (isHtmlScript) return true;
  if (!isJs) return true;
  return false;
}

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
  // role gate: visibility scoped to caller's tenant (client_user) or all (agency/super_admin)
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
  const KNOWN_TRACKER_RE = /\bpulse\.js\b|\btracker\.js\b|hvaclaunch-optics\.replit\.app/i;
  // tracker-shaped scripts; classifyScriptKind tags as unknown-tracker unless body fingerprint matches
  const SHAPED_RE = /tracker|tracking|analytics|pixel|telemetry|beacon|gtm\.js|gtag/i;
  const knownSrcs = allSrcs.filter(s => KNOWN_TRACKER_RE.test(s));
  const shapedSrcs = allSrcs
    .filter(s => !KNOWN_TRACKER_RE.test(s) && SHAPED_RE.test(s))
    .slice(0, 5); // bound fetch cost
  const trackerSrcs = [...knownSrcs, ...shapedSrcs];

  const scripts: Array<{
    src: string;
    resolvedUrl: string | null;
    status: number;
    contentType: string | null;
    bytes: number;
    looksLikePulse: boolean;
    kind: ScriptKind;
    dataAttrs: Record<string, string> | null;
    isDeadResource: boolean;
    error?: string;
  }> = [];

  // Optics-legacy script + page-level findings are deferred until after the
  // heartbeat lookup, so we can downgrade them from red ("wrong tracker
  // installed") to amber ("legacy tag is dead — Pulse is running via GTM")
  // when the legacy URL is provably dead AND fresh heartbeats are present.
  const deferredOpticsLegacyScriptFindings: Array<{
    src: string;
    level: "warning" | "error";
    message: string;
    isDead: boolean;
  }> = [];
  let pageScriptKindIsOpticsLegacy = false;

  // page verdict = best of (pulse-current > pulse-legacy > optics-legacy > unknown-tracker > none)
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
      scripts.push({ src, resolvedUrl: null, status: 0, contentType: null, bytes: 0, looksLikePulse: false, kind, dataAttrs, isDeadResource: true, error: "Could not resolve URL" });
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
    const isDeadResource = isScriptResponseDead({
      ok: r.ok, contentType: r.contentType, body: r.body, fetchError: r.error,
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
      isDeadResource,
      error: r.error,
    });
    if (verdict.level !== "ok") {
      // Defer optics-legacy script findings: severity depends on whether the
      // legacy URL is dead AND pulse-current is running via GTM (heartbeats).
      if (kind === "optics-legacy") {
        deferredOpticsLegacyScriptFindings.push({
          src, level: verdict.level, message: verdict.message, isDead: isDeadResource,
        });
      } else {
        findings.push({ level: verdict.level, message: verdict.message });
      }
    }
    if (rankKind(kind) > rankKind(pageScriptKind)) pageScriptKind = kind;
  }

  // banner-ready: page is on the wrong tracker entirely
  // optics-legacy push is deferred until after the heartbeat lookup so we can
  // downgrade it to amber when the legacy tag is dead + pulse is alive via GTM.
  if (pageScriptKind === "optics-legacy") {
    pageScriptKindIsOpticsLegacy = true;
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

  // mismatch check only for client_user/client_admin (one bound tenant)
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

  // form/iframe inventory for the operator
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

  // Task #292 — proactively flag the honeypot-only failure mode: a
  // <form> whose only named inputs are anti-bot decoys (company_url etc).
  // The visible name/email/phone inputs almost certainly bind via
  // React state without a `name=` attribute (and so are invisible to
  // FormData), whether on a custom Replit booking widget or a
  // GoHighLevel-hosted funnel. Pulse.js's wide-scan rescue catches
  // these, but operators should know before customers complain about
  // missing leads.
  if (formInventoryHasHoneypotOnlyShape(formInventory)) {
    findings.push({
      level: "warning",
      message: `Honeypot-only form detected — the page has a <form> whose only named inputs are anti-bot decoys (e.g. company_url). Visible inputs are likely React-managed siblings without a name= attribute, so FormData captures only the honeypot. Pulse.js falls back to a wider scan and labels these submissions as honeypot-rescue; if heartbeats are healthy but submits arrive empty, this is the cause.`,
    });
  }

  // Task #295 — broader sibling check: catch the underlying mistake
  // (visible inputs without `name=`) on any scanned form, not just
  // pages that also happen to have a honeypot. This surfaces the
  // problem before any leads are lost. Find the worst offender so the
  // operator sees concrete numbers in the warning.
  if (formInventoryHasMissingNameShape(formInventory)) {
    let worst: FormInventoryItem | null = null;
    for (const item of formInventory) {
      if (item.kind !== "form") continue;
      if (item.visibleInputCount < 2) continue;
      if (item.unnamedVisibleInputCount * 2 < item.visibleInputCount) continue;
      if (!worst || item.unnamedVisibleInputCount > worst.unnamedVisibleInputCount) {
        worst = item;
      }
    }
    if (worst) {
      findings.push({
        level: "warning",
        message: `Form on this page has ${worst.unnamedVisibleInputCount} of ${worst.visibleInputCount} visible inputs missing a name= attribute. Browsers' new FormData(form) only includes inputs with name=, so React/Vue forms that bind via state or test-ids will silently submit empty. Add name="…" to each visible input (first_name, email, phone, etc.). Pulse.js's wide-scan rescue can recover some of these, but a proper name= is the only reliable fix. See https://developer.mozilla.org/en-US/docs/Web/API/FormData/FormData for the FormData contract.`,
      });
    }
  }

  // heartbeat lookup scoped to caller visibility
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

  // recent submit/heartbeat audit log (caller-visibility scoped)
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
      kind: trackerSubmitAttemptsTable.kind,
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

  // surface failed submits (excluding diagnostic beacons)
  const recentFailedSubmits = recentAttempts.filter(
    a => a.endpoint === "submit"
      && a.kind !== "diagnostic"
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

  // 24h/7d HTTP-status breakdowns for Tracker Health pills
  const visibleTenantIds = isAgency ? undefined : (sessionTenantId ? [sessionTenantId] : []);
  const [breakdown24h, breakdown7d] = await Promise.all([
    getDomainSubmitBreakdown({ domain: targetHost, windowHours: 24, tenantIds: visibleTenantIds }),
    getDomainSubmitBreakdown({ domain: targetHost, windowHours: 24 * 7, tenantIds: visibleTenantIds }),
  ]);

  // per-domain install verdict (script + heartbeat + submit history)
  const hasFreshHeartbeat = heartbeats.length > 0 && new Date(heartbeats[0].lastSeenAt) >= twentyFourHoursAgo;
  const installVerdict: InstallVerdict = computeInstallVerdict({
    pageScriptKind,
    scripts: scripts.map(s => ({ kind: s.kind, isDeadResource: s.isDeadResource })),
    hasFreshHeartbeat,
    hasAnyHeartbeat: heartbeats.length > 0,
    submitOk7d: breakdown7d.submitOk,
  });

  // Now that the install verdict is known, push the deferred optics-legacy
  // findings at the right severity. When `legacy-tag-dead` is in effect, the
  // operator does not need a red alarm — Pulse is running via GTM and the
  // legacy <script> tag is harmless until it can be removed.
  if (installVerdict === "legacy-tag-dead") {
    for (const f of deferredOpticsLegacyScriptFindings) {
      findings.push({
        level: "warning",
        message: f.isDead
          ? `Legacy <script src="${f.src}"> is dead (URL no longer serves JavaScript). Pulse is running via GTM — this tag is harmless. Remove it from the page HTML when convenient.`
          : f.message,
      });
    }
    if (pageScriptKindIsOpticsLegacy) {
      findings.push({
        level: "warning",
        message: `Legacy <script src=…tracker.js> tag still in this page's HTML, but the URL is dead (returns non-JS / 4xx / 5xx). Pulse.js is actively running via GTM (active heartbeat in the last 24h) — safe to remove the legacy tag at your convenience. No action required for tracking.`,
      });
    }
  } else {
    for (const f of deferredOpticsLegacyScriptFindings) {
      findings.push({ level: f.level, message: f.message });
    }
    if (pageScriptKindIsOpticsLegacy) {
      findings.push({
        level: "error",
        message: `This page loads the LEGACY Optics tracker (tracker.js / hvaclaunch-optics.replit.app), not the current Pulse build. Submits will go to the wrong deployment and a different tenant id — this is exactly how the Vance Heating outage happened. Replace the script tag with the per-tenant Pulse install snippet from Settings → Tracker Health.`,
      });
    }
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
      kind: a.kind,
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
