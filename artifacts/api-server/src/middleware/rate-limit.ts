import rateLimit from "express-rate-limit";
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
