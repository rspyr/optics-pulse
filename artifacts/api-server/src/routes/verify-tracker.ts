import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { trackerHeartbeatsTable, attributionEventsTable, tenantsTable } from "@workspace/db";
import { and, eq, desc, gte } from "drizzle-orm";
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
  // Only consider tracker-like script tags (pulse.js or legacy tracker.js).
  const trackerSrcs = allSrcs.filter(s => /\bpulse\.js\b|\btracker\.js\b/i.test(s));

  const scripts: Array<{
    src: string;
    resolvedUrl: string | null;
    status: number;
    contentType: string | null;
    bytes: number;
    looksLikePulse: boolean;
    error?: string;
  }> = [];

  if (trackerSrcs.length === 0) {
    findings.push({ level: "warning", message: "No <script src=…pulse.js> or legacy tracker.js found in the static HTML. If the page injects the tracker via GTM or a JS framework, that's expected — but a static <script> tag is the most reliable install path." });
  }

  for (const src of trackerSrcs) {
    const resolved = abs(targetUrl, src);
    if (!resolved) {
      scripts.push({ src, resolvedUrl: null, status: 0, contentType: null, bytes: 0, looksLikePulse: false, error: "Could not resolve URL" });
      continue;
    }
    const r = await fetchBounded(resolved);
    const verdict = classifyScriptResponse({
      src, ok: r.ok, status: r.status, contentType: r.contentType, body: r.body, fetchError: r.error,
    });
    scripts.push({
      src,
      resolvedUrl: resolved,
      status: r.status,
      contentType: r.contentType,
      bytes: r.body.length,
      looksLikePulse: looksLikePulseScript(resolved, r.body),
      error: r.error,
    });
    if (verdict.level !== "ok") {
      findings.push({ level: verdict.level, message: verdict.message });
    }
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
    heartbeats: heartbeats.map(h => ({
      tenantId: h.tenantId,
      tenantName: h.tenantName,
      lastSeenAt: h.lastSeenAt,
      firstPageUrl: h.firstPageUrl,
    })),
    recentEventCount24h: recentEventCount,
    debugUrl: `${targetUrl}${targetUrl.includes("?") ? "&" : "?"}pulse_debug=1`,
  });
});

export default router;
