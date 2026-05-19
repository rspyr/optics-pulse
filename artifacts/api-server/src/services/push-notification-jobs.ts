import { enqueueJob, registerJobHandler } from "./background-jobs";
import { sendPushToUser, sendPushToTenantUsers } from "./push-notifications";

export const SEND_PUSH_NOTIFICATION = "send_push_notification";

/**
 * Pushes older than this are dropped instead of fired. A push that has been
 * retrying for >5 minutes is almost always stale (e.g. "incoming call",
 * "new lead just arrived") and surfacing it late is worse than not at all.
 */
export const PUSH_MAX_AGE_MS = 5 * 60 * 1000;

type PushTarget =
  | { kind: "user"; userId: number }
  | { kind: "tenant"; tenantId: number; excludeUserId?: number };

interface SendPushPayload {
  target: PushTarget;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Epoch ms when this push was originally enqueued. Used for max-age check. */
  enqueuedAt: number;
  /** Short label used in logs to identify the call site. */
  source?: string;
}

function parsePayload(p: Record<string, unknown>): SendPushPayload {
  const target = p["target"] as PushTarget | undefined;
  const title = p["title"];
  const body = p["body"];
  const enqueuedAt = p["enqueuedAt"];
  if (
    !target ||
    typeof title !== "string" ||
    typeof body !== "string" ||
    typeof enqueuedAt !== "number"
  ) {
    throw new Error(
      `Invalid payload for ${SEND_PUSH_NOTIFICATION}: ${JSON.stringify(p)}`,
    );
  }
  if (target.kind === "user") {
    if (typeof target.userId !== "number") {
      throw new Error(`Invalid user target: ${JSON.stringify(target)}`);
    }
  } else if (target.kind === "tenant") {
    if (typeof target.tenantId !== "number") {
      throw new Error(`Invalid tenant target: ${JSON.stringify(target)}`);
    }
  } else {
    throw new Error(`Unknown push target kind: ${JSON.stringify(target)}`);
  }
  return {
    target,
    title,
    body,
    data: (p["data"] as Record<string, unknown> | undefined) ?? undefined,
    enqueuedAt,
    source: typeof p["source"] === "string" ? (p["source"] as string) : undefined,
  };
}

export function registerPushNotificationJobHandlers(): void {
  registerJobHandler(SEND_PUSH_NOTIFICATION, async (payload) => {
    const args = parsePayload(payload);
    const age = Date.now() - args.enqueuedAt;
    if (age > PUSH_MAX_AGE_MS) {
      console.warn(
        `[push-jobs] Dropping stale push (age=${age}ms > ${PUSH_MAX_AGE_MS}ms) ` +
          `source=${args.source ?? "unknown"} target=${JSON.stringify(args.target)}`,
      );
      return { skipped: true, reason: "stale", ageMs: age };
    }
    const report =
      args.target.kind === "user"
        ? await sendPushToUser(args.target.userId, args.title, args.body, args.data)
        : await sendPushToTenantUsers(
            args.target.tenantId,
            args.title,
            args.body,
            args.data,
            args.target.excludeUserId,
          );

    // Translate the delivery report into a thrown error when the runner
    // should retry. A top-level error (e.g. DB lookup failed) is always
    // retryable. Otherwise, retry only when nothing was delivered and at
    // least one device hit a transient failure — this avoids re-sending
    // to devices that already received the push.
    if (report.topLevelError) {
      throw report.topLevelError;
    }
    if (report.transientFailures > 0 && report.succeeded === 0) {
      throw new Error(
        `Push delivery failed transiently (attempted=${report.attempted}, ` +
          `transient=${report.transientFailures}, permanent=${report.permanentFailures}) ` +
          `for source=${args.source ?? "unknown"} target=${JSON.stringify(args.target)}`,
      );
    }
    return {
      target: args.target,
      attempted: report.attempted,
      succeeded: report.succeeded,
      permanentFailures: report.permanentFailures,
      transientFailures: report.transientFailures,
    };
  });
}

interface EnqueueUserPushArgs {
  userId: number;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  tenantId?: number;
  source?: string;
}

/**
 * Durable replacement for `sendPushToUser(...).catch(...)`. The push survives
 * an api-server restart and gets retried with backoff on transient failures.
 */
export async function enqueueSendPushToUser(args: EnqueueUserPushArgs) {
  return enqueueJob(
    SEND_PUSH_NOTIFICATION,
    {
      target: { kind: "user", userId: args.userId },
      title: args.title,
      body: args.body,
      data: args.data,
      enqueuedAt: Date.now(),
      source: args.source,
    },
    { tenantId: args.tenantId ?? null },
  );
}

interface EnqueueTenantPushArgs {
  tenantId: number;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  excludeUserId?: number;
  source?: string;
}

/**
 * Durable replacement for `sendPushToTenantUsers(...).catch(...)`.
 */
export async function enqueueSendPushToTenantUsers(args: EnqueueTenantPushArgs) {
  return enqueueJob(
    SEND_PUSH_NOTIFICATION,
    {
      target: {
        kind: "tenant",
        tenantId: args.tenantId,
        excludeUserId: args.excludeUserId,
      },
      title: args.title,
      body: args.body,
      data: args.data,
      enqueuedAt: Date.now(),
      source: args.source,
    },
    { tenantId: args.tenantId },
  );
}
