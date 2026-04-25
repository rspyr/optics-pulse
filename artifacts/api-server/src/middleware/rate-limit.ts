import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { logTrackerAttempt } from "../services/tracker-audit";

// Tracker limiters write a `rate_limited` audit row before responding so a
// burst of 429s is visible in Verify Tracker. Without this, traffic that
// exceeds the limit would leave NO audit trail (the request never reaches
// the route handler) and would be functionally indistinguishable from a
// silent outage — exactly the failure mode this whole feature is designed
// to surface.
export const trackerSubmitLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: async (req, res) => {
    const rawBody = req.body as Record<string, unknown> | undefined;
    const clientId = typeof rawBody?.client_id === "string" ? rawBody.client_id.trim() : null;
    await logTrackerAttempt({
      endpoint: "submit",
      req,
      body: rawBody,
      clientId,
      outcome: "rate_limited",
      httpStatus: 429,
      message: "Hit /collect/submit rate limit (60 req/min)",
    });
    res.status(429).json({
      success: false,
      message: "Too many submissions. Please try again later.",
    });
  },
});

// Diagnostics beacons get TWO stacked limiters (apply hard limiter first
// in the route chain, then the fairness limiter):
//
//   1. trackerDiagnosticsHardLimiter — IP-only ceiling (120/min). Hard
//      anti-abuse cap. Cannot be bypassed by manipulating body fields
//      because the key is purely IP-derived.
//
//   2. trackerDiagnosticsLimiter — composite IP + body client_id (30/min).
//      Provides per-tenant fairness so one noisy tenant on a shared NAT
//      can't burn another tenant's headroom. The body `client_id` is
//      attacker-controlled, so a malicious page COULD rotate it to mint
//      fresh fairness buckets — but the hard limiter above caps total
//      throughput per IP regardless of how many fairness buckets exist.
const diagnosticsClientId = (req: { body?: unknown }): string => {
  const rawBody = req.body as Record<string, unknown> | undefined;
  return typeof rawBody?.client_id === "string" ? rawBody.client_id.trim() : "";
};

export const trackerDiagnosticsHardLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: async (req, res) => {
    const rawBody = req.body as Record<string, unknown> | undefined;
    const clientId = diagnosticsClientId(req) || null;
    await logTrackerAttempt({
      endpoint: "submit",
      kind: "diagnostic",
      req,
      body: rawBody,
      clientId,
      outcome: "rate_limited",
      httpStatus: 429,
      message: "Hit /collect/diagnostics IP ceiling (120 envelopes/min)",
    });
    res.status(429).json({
      success: false,
      message: "Too many diagnostic beacons from this IP. Throttle and try again.",
    });
  },
});

export const trackerDiagnosticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ipKey = ipKeyGenerator(req.ip ?? "");
    const clientId = diagnosticsClientId(req);
    return `${ipKey}|${clientId || "anon"}`;
  },
  handler: async (req, res) => {
    const rawBody = req.body as Record<string, unknown> | undefined;
    const clientId = diagnosticsClientId(req) || null;
    await logTrackerAttempt({
      endpoint: "submit",
      kind: "diagnostic",
      req,
      body: rawBody,
      clientId,
      outcome: "rate_limited",
      httpStatus: 429,
      message: "Hit /collect/diagnostics per-tenant limit (30 envelopes/min)",
    });
    res.status(429).json({
      success: false,
      message: "Too many diagnostic beacons. Throttle and try again.",
    });
  },
});

export const trackerHeartbeatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: async (req, res) => {
    const rawBody = req.body as Record<string, unknown> | undefined;
    const clientId = typeof rawBody?.clientId === "string" ? rawBody.clientId.trim() : null;
    await logTrackerAttempt({
      endpoint: "heartbeat",
      req,
      body: rawBody,
      clientId,
      outcome: "rate_limited",
      httpStatus: 429,
      message: "Hit /collect/heartbeat rate limit (20 req/min)",
    });
    res.status(429).json({
      success: false,
      message: "Too many heartbeat requests. Please try again later.",
    });
  },
});

export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many webhook requests. Please try again later.",
    });
  },
});
