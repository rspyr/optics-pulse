import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { logTrackerAttempt } from "../services/tracker-audit";

// Tracker limiters write a `rate_limited` audit row before responding so 429
// bursts remain visible in Verify Tracker.
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

// Diagnostics beacons: stack the hard IP-only ceiling first, then the
// composite IP+client_id fairness limiter. Hard limiter caps abuse
// regardless of body-supplied client_id rotation.
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
