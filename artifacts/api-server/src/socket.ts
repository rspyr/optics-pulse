import { Server as SocketIOServer, type Socket } from "socket.io";
import type { Server as HTTPServer } from "http";
import { db, leadsTable, tenantsTable, funnelTypesTable, tenantFunnelTypesTable, callAttemptsTable, userLoginSessionsTable, csrScheduleTable } from "@workspace/db";
import { eq, and, count, sql, avg, inArray, gte, ne, isNull } from "drizzle-orm";
import { parseSpiffConfig, computeSpiffCommission } from "./routes/sales-manager";
import { assignLeadRoundRobin } from "./services/round-robin";
import { scheduleAutoPass } from "./services/auto-pass-scheduler";

const DEMO_FIRST_NAMES = ["John", "Sarah", "Michael", "Emily", "David", "Jessica", "Robert", "Amanda", "William", "Jennifer", "James", "Lisa", "Daniel", "Maria", "Christopher"];
const DEMO_LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"];
const DEMO_SOURCES = ["Google Ads", "Meta Leads", "CallRail", "Organic Search"];
const DEMO_INTEREST_TYPES = ["Heat Pump", "AC Repair", "Full System", "Furnace", "Ductless Mini-Split", "Maintenance"];
const DEMO_LEAD_TYPES_FALLBACK = ["Fit Funnel", "Quiz", "Pop-up", "Direct"];

let cachedFunnelTypes: Record<number, { name: string; id: number }[]> = {};

const activeSocketsBySessionKey: Record<string, number> = {};
const activeSocketsByUserId: Record<number, number> = {};
const autoPauseTimers: Record<number, ReturnType<typeof setTimeout>> = {};
const AUTO_PAUSE_GRACE_MS = 30_000;

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fakePhone(): string {
  const area = Math.floor(Math.random() * 900) + 100;
  const mid = Math.floor(Math.random() * 900) + 100;
  const end = Math.floor(Math.random() * 9000) + 1000;
  return `(${area}) ${mid}-${end}`;
}

function fakeEmail(first: string, last: string): string {
  const domains = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com"];
  return `${first.toLowerCase()}.${last.toLowerCase()}@${randomFrom(domains)}`;
}

let io: SocketIOServer | null = null;
let demoTimer: ReturnType<typeof setTimeout> | null = null;

export function initSocketIO(httpServer: HTTPServer, sessionMiddleware: unknown): SocketIOServer {
  const allowedOrigins: string[] = [];
  if (process.env.REPLIT_DEV_DOMAIN) {
    allowedOrigins.push(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    const expoVariant = process.env.REPLIT_DEV_DOMAIN.replace(".worf.replit.dev", ".expo.worf.replit.dev");
    allowedOrigins.push(`https://${expoVariant}`);
  }
  if (process.env.REPLIT_DOMAINS) {
    process.env.REPLIT_DOMAINS.split(",").forEach(d => allowedOrigins.push(`https://${d}`));
  }
  if (process.env.REPLIT_EXPO_DEV_DOMAIN) {
    allowedOrigins.push(`https://${process.env.REPLIT_EXPO_DEV_DOMAIN}`);
  }
  if (allowedOrigins.length === 0) {
    allowedOrigins.push("http://localhost:5173");
  }

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    path: "/api/socket.io",
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  io.engine.use((req: any, res: any, next: any) => {
    const authHeader = req.headers?.authorization;
    if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token && (!req.headers.cookie || !req.headers.cookie.includes("mos.sid="))) {
        const cookieValue = "mos.sid=" + encodeURIComponent(token);
        req.headers.cookie = req.headers.cookie
          ? req.headers.cookie + "; " + cookieValue
          : cookieValue;
      }
    }
    (sessionMiddleware as any)(req, res, next);
  });

  io.on("connection", (socket: Socket) => {
    const req = socket.request as { session?: { userId?: number; userRole?: string; tenantId?: number }; sessionID?: string };
    const session = req.session;
    const sessionKey = req.sessionID;

    if (!session?.userId) {
      console.log(`[Socket.IO] Unauthenticated connection rejected: ${socket.id}`);
      socket.disconnect(true);
      return;
    }

    const role = session.userRole;
    console.log(`[Socket.IO] Client connected: ${socket.id} (user ${session.userId}, role ${role})`);

    if (role === "client_user" && sessionKey) {
      activeSocketsBySessionKey[sessionKey] = (activeSocketsBySessionKey[sessionKey] ?? 0) + 1;
      const uid = session.userId!;
      activeSocketsByUserId[uid] = (activeSocketsByUserId[uid] ?? 0) + 1;

      if (autoPauseTimers[uid]) {
        clearTimeout(autoPauseTimers[uid]);
        delete autoPauseTimers[uid];
        console.log(`[Socket.IO] Cancelled auto-pause timer for user ${uid}`);
      }

      if (session.tenantId) {
        db.select().from(csrScheduleTable)
          .where(and(eq(csrScheduleTable.tenantId, session.tenantId), eq(csrScheduleTable.userId, uid)))
          .limit(1)
          .then(async (rows) => {
            if (rows.length > 0 && rows[0].isPaused && (rows[0].pauseSource === "auto" || rows[0].pauseSource === "self")) {
              await db.update(csrScheduleTable)
                .set({ isPaused: false, pauseStart: null, pauseEnd: null, updatedAt: new Date() })
                .where(eq(csrScheduleTable.id, rows[0].id));
              console.log(`[Socket.IO] Auto-unpaused user ${uid} (was ${rows[0].pauseSource}-paused)`);
            }
          })
          .catch((err) => console.error("[Socket.IO] Failed to auto-unpause on connect:", err));
      }

      db.select({ id: userLoginSessionsTable.id })
        .from(userLoginSessionsTable)
        .where(and(
          eq(userLoginSessionsTable.sessionKey, sessionKey),
          isNull(userLoginSessionsTable.logoutAt),
        ))
        .limit(1)
        .then(async (rows) => {
          if (rows.length === 0) {
            await db.insert(userLoginSessionsTable).values({
              userId: uid,
              tenantId: session.tenantId ?? null,
              sessionKey,
              loginAt: new Date(),
            });
          }
        })
        .catch((err) => console.error("[Socket.IO] Failed to ensure login session on connect:", err));
    }

    if (role === "super_admin" || role === "agency_user") {
      db.select({ id: tenantsTable.id }).from(tenantsTable).then(tenants => {
        for (const t of tenants) {
          const room = `tenant-${t.id}`;
          if (!socket.rooms.has(room)) socket.join(room);
        }
        console.log(`[Socket.IO] ${socket.id} auto-joined ${tenants.length} tenant rooms (agency)`);
      }).catch(err => console.error("[Socket.IO] Error auto-joining tenant rooms:", err));
    } else if (session.tenantId) {
      socket.join(`tenant-${session.tenantId}`);
      console.log(`[Socket.IO] ${socket.id} joined tenant-${session.tenantId}`);
    }

    socket.on("join-tenant", (tenantId: number) => {
      if (typeof tenantId !== "number" || !Number.isInteger(tenantId) || tenantId <= 0) {
        socket.emit("error", { message: "Invalid tenant ID" });
        return;
      }

      const room = `tenant-${tenantId}`;
      if (socket.rooms.has(room)) return;

      if (role === "super_admin" || role === "agency_user") {
        socket.join(room);
      } else if (session.tenantId === tenantId) {
        socket.join(room);
      } else {
        socket.emit("error", { message: "Access denied to this tenant" });
        return;
      }
      console.log(`[Socket.IO] ${socket.id} joined ${room}`);
    });

    socket.on("disconnect", () => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
      if (session?.userId && role === "client_user" && sessionKey) {
        const uid = session.userId;
        activeSocketsBySessionKey[sessionKey] = Math.max(0, (activeSocketsBySessionKey[sessionKey] ?? 1) - 1);
        activeSocketsByUserId[uid] = Math.max(0, (activeSocketsByUserId[uid] ?? 1) - 1);

        if (activeSocketsBySessionKey[sessionKey] === 0) {
          delete activeSocketsBySessionKey[sessionKey];
          db.update(userLoginSessionsTable)
            .set({ logoutAt: new Date() })
            .where(and(
              eq(userLoginSessionsTable.sessionKey, sessionKey),
              isNull(userLoginSessionsTable.logoutAt),
            ))
            .then(() => {})
            .catch((err) => console.error("[Socket.IO] Failed to close login session on disconnect:", err));
        }

        if (activeSocketsByUserId[uid] === 0) {
          delete activeSocketsByUserId[uid];
          if (session.tenantId) {
            const tenantId = session.tenantId;
            console.log(`[Socket.IO] Starting ${AUTO_PAUSE_GRACE_MS}ms auto-pause timer for user ${uid}`);
            autoPauseTimers[uid] = setTimeout(() => {
              delete autoPauseTimers[uid];
              db.select().from(csrScheduleTable)
                .where(and(eq(csrScheduleTable.tenantId, tenantId), eq(csrScheduleTable.userId, uid)))
                .limit(1)
                .then(async (rows) => {
                  if (rows.length > 0) {
                    if (rows[0].pauseSource === "manager" && rows[0].isPaused) {
                      console.log(`[Socket.IO] User ${uid} already manager-paused, skipping auto-pause`);
                      return;
                    }
                    await db.update(csrScheduleTable)
                      .set({ isPaused: true, pauseSource: "auto", pauseStart: new Date(), pauseEnd: null, updatedAt: new Date() })
                      .where(eq(csrScheduleTable.id, rows[0].id));
                  } else {
                    await db.insert(csrScheduleTable).values({
                      tenantId,
                      userId: uid,
                      isPaused: true,
                      pauseSource: "auto",
                      pauseStart: new Date(),
                    });
                  }
                  console.log(`[Socket.IO] Auto-paused user ${uid} after grace period`);
                })
                .catch((err) => console.error("[Socket.IO] Failed to auto-pause on disconnect:", err));
            }, AUTO_PAUSE_GRACE_MS);
          }
        }
      }
    });
  });

  if (process.env.NODE_ENV !== "production") {
    startDemoMode();
  }

  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

export async function closeStaleLoginSessions(): Promise<void> {
  try {
    const result = await db.update(userLoginSessionsTable)
      .set({ logoutAt: new Date() })
      .where(isNull(userLoginSessionsTable.logoutAt))
      .returning({ id: userLoginSessionsTable.id });
    if (result.length > 0) {
      console.log(`[LoginSessions] Closed ${result.length} stale open session(s) on startup`);
    }
  } catch (err) {
    console.error("[LoginSessions] Failed to close stale sessions:", err);
  }
}

export function startLoginSessionExpiryJob(): void {
  setInterval(async () => {
    try {
      const openSessions = await db.select({
        id: userLoginSessionsTable.id,
        sessionKey: userLoginSessionsTable.sessionKey,
      })
        .from(userLoginSessionsTable)
        .where(and(
          isNull(userLoginSessionsTable.logoutAt),
          sql`${userLoginSessionsTable.sessionKey} IS NOT NULL`,
          sql`NOT EXISTS (SELECT 1 FROM session s WHERE s.sid = ${userLoginSessionsTable.sessionKey} AND s.expire > NOW())`,
        ));

      if (openSessions.length > 0) {
        const idsToClose = openSessions.map(s => s.id);
        await db.update(userLoginSessionsTable)
          .set({ logoutAt: new Date() })
          .where(inArray(userLoginSessionsTable.id, idsToClose));
        console.log(`[LoginSessions] Closed ${idsToClose.length} session(s) with expired/destroyed express sessions`);
      }
    } catch (err) {
      console.error("[LoginSessions] Session expiry reconciliation failed:", err);
    }
  }, 15 * 60 * 1000);
  console.log("[LoginSessions] Session expiry reconciliation started (every 15min, checks session store)");
}

export function emitNewLead(tenantId: number, lead: Record<string, unknown>) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("new-lead", lead);
    console.log(`[Socket.IO] Emitted new-lead for tenant-${tenantId} (lead ${lead.id})`);
  }
  const assignedCsrId = (lead.assignedCsrId ?? lead.assignedUserId) as number | undefined;
  if (assignedCsrId) {
    // Enqueue into the durable jobs runner so the push survives a server
    // restart. The enqueue itself is async (a DB insert), but emitNewLead is
    // called from sync contexts; once the row lands in `background_jobs` the
    // worker will deliver and retry it.
    import("./services/push-notification-jobs").then(({ enqueueSendPushToUser }) => {
      const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "New Lead";
      const source = (lead.source as string) || "";
      enqueueSendPushToUser({
        userId: assignedCsrId,
        title: "New Lead Assigned",
        body: `${name}${source ? ` from ${source}` : ""}`,
        data: { leadId: lead.id, type: "new-lead", intent: "open-lead" },
        tenantId,
        source: "socket-new-lead",
      }).catch(err => console.error("[Push] emitNewLead enqueue error:", err));
    }).catch(err => console.error("[Push] Failed to load push-notification-jobs module:", err));
  } else {
    console.log(`[Socket.IO] Lead ${lead.id} has no assignedCsrId, skipping push notification`);
  }
}

export function emitLeadUpdated(tenantId: number, lead: Record<string, unknown>) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("lead-updated", lead);
    console.log(`[Socket.IO] Emitted lead-updated for tenant-${tenantId} (lead ${lead.id})`);
  }
}

export function emitLeadAssigned(tenantId: number, lead: Record<string, unknown>) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("lead-assigned", { ...lead, tenantId });
    const assignedCsrId = (lead.assignedCsrId ?? lead.assignedUserId) as number | undefined;
    console.log(`[Socket.IO] Emitted lead-assigned for tenant-${tenantId} (lead ${lead.id} -> csr ${assignedCsrId ?? "none"})`);
  }
}

export function emitPodiumMessage(tenantId: number, message: Record<string, unknown>) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("podium-message", message);
  }
}

export function emitLeadResubmitted(
  tenantId: number,
  data: { leadId: number; assignedCsrId: number | null; leadName: string; source: string; reactivated: boolean },
) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("lead-resubmitted", { ...data, tenantId });
    console.log(`[Socket.IO] Emitted lead-resubmitted for tenant-${tenantId} (lead ${data.leadId} -> csr ${data.assignedCsrId ?? "none"})`);
  }
}

export function emitNewAttributionEvent(tenantId: number, data: Record<string, unknown>) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("new-attribution-event", { ...data, tenantId });
    console.log(`[Socket.IO] Emitted new-attribution-event for tenant-${tenantId} (event ${data.id})`);
  }
}

/**
 * Task #593: synchronous companion to `rule-rederive-complete`. The latter
 * is fired by the *background* historical re-derive job some time after the
 * POST handler has already flipped the targeted event to `manual` via
 * `markEventManuallyMatched`. That gap (slow job queue, retries) leaves an
 * open event sheet stale even after the row list has already flipped.
 *
 * `attribution-event-updated` is emitted *synchronously* from
 * `markEventManuallyMatched` so the open sheet refetches the freshly-flipped
 * `matchLevel` immediately, without waiting on the background job's emit.
 */
export function emitAttributionEventUpdated(
  tenantId: number,
  data: { eventId: number; matchLevel: string },
) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("attribution-event-updated", { ...data, tenantId });
    console.log(
      `[Socket.IO] Emitted attribution-event-updated for tenant-${tenantId} ` +
      `(event ${data.eventId} -> ${data.matchLevel})`,
    );
  }
}

export function emitRuleRederiveComplete(
  tenantId: number,
  data: {
    pageUrlPattern: string;
    formIdentifier: string;
    leadsChanged: number;
    hitLimit: boolean;
    maxLeads: number;
  },
) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("rule-rederive-complete", { ...data, tenantId });
    console.log(
      `[Socket.IO] Emitted rule-rederive-complete for tenant-${tenantId} (` +
      `scope=${data.pageUrlPattern}|${data.formIdentifier} changed=${data.leadsChanged} ` +
      `hitLimit=${data.hitLimit})`,
    );
  }
}

export function emitRuleRederiveFailed(
  tenantId: number,
  data: {
    pageUrlPattern: string;
    formIdentifier: string;
    reason: string;
    // Optional companion fields that let the operator UI surface
    // "~N historical leads still need updating" alongside the failure hint
    // and timestamp it. All optional because the count computation can
    // itself fail (DB hiccup etc.) and we still want to surface the failure.
    pendingLeads?: number;
    hitLimit?: boolean;
    maxLeads?: number;
    lastAttemptedAt?: string;
  },
) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("rule-rederive-failed", { ...data, tenantId });
    console.log(
      `[Socket.IO] Emitted rule-rederive-failed for tenant-${tenantId} (` +
      `scope=${data.pageUrlPattern}|${data.formIdentifier} reason=${data.reason} ` +
      `pending=${data.pendingLeads ?? "?"})`,
    );
  }
}

/**
 * Latest progress snapshot for each in-flight bulk re-derive job, keyed by
 * `jobId`. Lets a reconnecting client (or a sheet that mounted after the job
 * already started) fetch the current progress instead of waiting for the
 * next periodic event. Entries are cleared in `emitSelectedLeadsRederive{Complete,Failed}`
 * so the map doesn't grow unboundedly; an in-memory snapshot is acceptable
 * because the job itself is durable in `background_jobs` and the worst case
 * on a server restart is that the progress bar resets to "running…" until
 * the next chunk event fires.
 */
type SelectedLeadsRederiveSnapshot = {
  tenantId: number;
  jobId: number;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  changed: number;
  updatedAt: string;
  // Lifecycle status. `running` is the live job; `complete`/`failed` are
  // terminal states held for SELECTED_LEADS_REDERIVE_TERMINAL_TTL_MS so a
  // client that reconnected after the socket event fired can still observe
  // the final outcome via the REST endpoint.
  status: "running" | "complete" | "failed" | "cancelled";
  failedLeadIds?: number[];
  // Leads that were queued for re-derive but never processed because the
  // operator cancelled mid-run. Only populated on `cancelled` snapshots so
  // a reconnecting client can resolve the "X leads skipped" line and the
  // "Re-derive the rest" action without re-fetching the original payload.
  skippedLeadIds?: number[];
  // Per-lead failure reason map, populated on `complete` when one or more
  // leads failed. Mirrors the `failedLeadIds` array so the sheet can surface
  // *why* each specific lead failed without re-fetching server logs. Kept in
  // the snapshot (not just the live event) so a client that reconnects
  // inside the terminal TTL still recovers the reasons via the REST endpoint.
  failedLeadErrors?: Record<number, string>;
  reason?: string;
  // Rule scope the bulk re-derive was kicked off against. Populated when the
  // route forwards it through the job payload so the pending-leads sheet can
  // look up the most recent terminal snapshot by scope on re-open (e.g. to
  // restore the "Cancelled at X/Y leads" + "Re-derive the rest" state after
  // an operator closed the sheet and came back). Optional for back-compat
  // with older callers that didn't thread scope through.
  pageUrlPattern?: string;
  formIdentifier?: string;
  // Operator-acknowledged "I've seen this cancellation" flag. Set by the
  // dismiss endpoint so the banner stops surfacing for this exact snapshot
  // across the operator's devices (the in-memory and DB lookups both skip
  // dismissed snapshots, so the sheet falls back to its normal "no result
  // yet" state). Only relevant for `cancelled` snapshots; cleared
  // implicitly by enqueueing a new bulk job for the same scope.
  dismissed?: boolean;
};

const selectedLeadsRederiveProgressByJobId = new Map<number, SelectedLeadsRederiveSnapshot>();
const selectedLeadsRederiveTerminalTimers = new Map<number, ReturnType<typeof setTimeout>>();
// Keep terminal snapshots around for ~10 minutes so a client that was offline
// when the complete/failed socket event fired can still resolve its progress
// bar by hitting the REST snapshot endpoint on reconnect.
const SELECTED_LEADS_REDERIVE_TERMINAL_TTL_MS = 10 * 60 * 1000;

export function getSelectedLeadsRederiveProgress(jobId: number) {
  return selectedLeadsRederiveProgressByJobId.get(jobId) ?? null;
}

/**
 * Find the most recent terminal `cancelled` snapshot for the given rule
 * scope. Drives the pending-leads sheet's "restore on re-open" behavior:
 * when the operator cancels a bulk re-derive then closes the sheet, the
 * sheet looks up the snapshot by scope on re-open so the "Cancelled at X/Y
 * leads" state and the "Re-derive the rest" action are still available
 * until the snapshot's TTL expires. Returns null when no matching cancelled
 * snapshot is in memory.
 *
 * Scoped by tenant so an operator can only observe their own tenant's
 * cancelled state. Snapshots without a `pageUrlPattern` / `formIdentifier`
 * (older payloads that didn't thread scope through) are intentionally
 * skipped — they can't be safely matched and would otherwise leak across
 * scopes.
 */
export function findLatestCancelledSelectedLeadsRederiveSnapshotForScope(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
): SelectedLeadsRederiveSnapshot | null {
  let best: SelectedLeadsRederiveSnapshot | null = null;
  for (const snap of selectedLeadsRederiveProgressByJobId.values()) {
    if (snap.status !== "cancelled") continue;
    if (snap.dismissed) continue;
    if (snap.tenantId !== tenantId) continue;
    if (snap.pageUrlPattern !== pageUrlPattern) continue;
    if (snap.formIdentifier !== formIdentifier) continue;
    if (!best || Date.parse(snap.updatedAt) > Date.parse(best.updatedAt)) {
      best = snap;
    }
  }
  return best;
}

/**
 * Mark the most recent cancelled snapshot for the given scope as dismissed
 * so subsequent lookups by the same operator (on any device) skip it. Used
 * by the dismiss endpoint so the operator's acknowledgement of a cancelled
 * banner follows them across browsers. Returns the dismissed snapshot (now
 * mutated in place) or null when no matching cancelled snapshot exists.
 *
 * We only flip the in-memory snapshot here — durable persistence is layered
 * separately in `markCancelledRederiveSnapshotDismissedInDb` so the dismiss
 * survives in-memory TTL expiry and server restarts.
 */
export function markCancelledSelectedLeadsRederiveSnapshotDismissed(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
): SelectedLeadsRederiveSnapshot | null {
  // Don't filter by `dismissed` here — if it's already dismissed in memory,
  // flipping it again is a no-op and we still want to return it so callers
  // can decide what to do (the route layer treats the second call as
  // idempotent success).
  let best: SelectedLeadsRederiveSnapshot | null = null;
  for (const snap of selectedLeadsRederiveProgressByJobId.values()) {
    if (snap.status !== "cancelled") continue;
    if (snap.tenantId !== tenantId) continue;
    if (snap.pageUrlPattern !== pageUrlPattern) continue;
    if (snap.formIdentifier !== formIdentifier) continue;
    if (!best || Date.parse(snap.updatedAt) > Date.parse(best.updatedAt)) {
      best = snap;
    }
  }
  if (!best) return null;
  best.dismissed = true;
  return best;
}

/**
 * Clear the `dismissed` flag from any in-memory cancelled snapshots for the
 * given scope. Called when a new bulk re-derive is enqueued for the scope so
 * a stale dismissal on an older cancelled snapshot can't bleed into the new
 * lifecycle. (In practice the new job will create its own snapshot and the
 * older one will age out via TTL — but explicit clearing keeps behavior
 * symmetric with the DB-side clear in `clearCancelledRederiveDismissedInDb`.)
 */
export function clearCancelledSelectedLeadsRederiveDismissedForScope(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
): void {
  for (const snap of selectedLeadsRederiveProgressByJobId.values()) {
    if (snap.status !== "cancelled") continue;
    if (!snap.dismissed) continue;
    if (snap.tenantId !== tenantId) continue;
    if (snap.pageUrlPattern !== pageUrlPattern) continue;
    if (snap.formIdentifier !== formIdentifier) continue;
    snap.dismissed = false;
  }
}

export function emitSelectedLeadsRederiveProgress(
  tenantId: number,
  data: {
    jobId: number;
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
    changed: number;
    pageUrlPattern?: string;
    formIdentifier?: string;
  },
) {
  const snapshot: SelectedLeadsRederiveSnapshot = {
    tenantId,
    jobId: data.jobId,
    total: data.total,
    processed: data.processed,
    succeeded: data.succeeded,
    failed: data.failed,
    changed: data.changed,
    updatedAt: new Date().toISOString(),
    status: "running",
    pageUrlPattern: data.pageUrlPattern,
    formIdentifier: data.formIdentifier,
  };
  selectedLeadsRederiveProgressByJobId.set(data.jobId, snapshot);
  if (io) {
    io.to(`tenant-${tenantId}`).emit("selected-leads-rederive-progress", snapshot);
  }
}

function recordSelectedLeadsRederiveTerminal(
  jobId: number | null,
  patch:
    | { status: "complete"; tenantId: number; total: number; succeeded: number; failed: number; changed: number; failedLeadIds: number[]; failedLeadErrors: Record<number, string> }
    | { status: "failed"; tenantId: number; total: number; reason: string }
    | { status: "cancelled"; tenantId: number; total: number; processed: number; succeeded: number; failed: number; changed: number; failedLeadIds: number[]; skippedLeadIds: number[]; pageUrlPattern?: string; formIdentifier?: string },
) {
  if (jobId == null) return;
  const prev = selectedLeadsRederiveProgressByJobId.get(jobId);
  const base: SelectedLeadsRederiveSnapshot = prev ?? {
    tenantId: patch.tenantId,
    jobId,
    total: patch.total,
    processed: patch.status === "complete" ? patch.total : (prev as SelectedLeadsRederiveSnapshot | undefined)?.processed ?? 0,
    succeeded: 0,
    failed: 0,
    changed: 0,
    updatedAt: new Date().toISOString(),
    status: "running",
  };
  let next: SelectedLeadsRederiveSnapshot;
  if (patch.status === "complete") {
    next = {
      ...base,
      tenantId: patch.tenantId,
      total: patch.total,
      processed: patch.total,
      succeeded: patch.succeeded,
      failed: patch.failed,
      changed: patch.changed,
      failedLeadIds: patch.failedLeadIds,
      failedLeadErrors: patch.failedLeadErrors,
      updatedAt: new Date().toISOString(),
      status: "complete",
    };
  } else if (patch.status === "failed") {
    next = {
      ...base,
      tenantId: patch.tenantId,
      total: patch.total,
      reason: patch.reason,
      updatedAt: new Date().toISOString(),
      status: "failed",
    };
  } else {
    next = {
      ...base,
      tenantId: patch.tenantId,
      total: patch.total,
      processed: patch.processed,
      succeeded: patch.succeeded,
      failed: patch.failed,
      changed: patch.changed,
      failedLeadIds: patch.failedLeadIds,
      skippedLeadIds: patch.skippedLeadIds,
      updatedAt: new Date().toISOString(),
      status: "cancelled",
      // Prefer the scope from the cancel emit; fall back to whatever was
      // recorded by an earlier progress tick so a cancel that didn't carry
      // scope (e.g. older callers) still inherits it from the running
      // snapshot it overwrites.
      pageUrlPattern: patch.pageUrlPattern ?? base.pageUrlPattern,
      formIdentifier: patch.formIdentifier ?? base.formIdentifier,
    };
  }
  selectedLeadsRederiveProgressByJobId.set(jobId, next);
  const existingTimer = selectedLeadsRederiveTerminalTimers.get(jobId);
  if (existingTimer) clearTimeout(existingTimer);
  const t = setTimeout(() => {
    selectedLeadsRederiveProgressByJobId.delete(jobId);
    selectedLeadsRederiveTerminalTimers.delete(jobId);
  }, SELECTED_LEADS_REDERIVE_TERMINAL_TTL_MS);
  // Don't keep the process alive for the TTL alone (matters in tests).
  if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
    (t as unknown as { unref: () => void }).unref();
  }
  selectedLeadsRederiveTerminalTimers.set(jobId, t);
}

export function emitSelectedLeadsRederiveComplete(
  tenantId: number,
  data: {
    jobId: number | null;
    total: number;
    succeeded: number;
    failed: number;
    changed: number;
    failedLeadIds: number[];
    failedLeadErrors?: Record<number, string>;
  },
) {
  const failedLeadErrors = data.failedLeadErrors ?? {};
  recordSelectedLeadsRederiveTerminal(data.jobId, {
    status: "complete",
    tenantId,
    total: data.total,
    succeeded: data.succeeded,
    failed: data.failed,
    changed: data.changed,
    failedLeadIds: data.failedLeadIds,
    failedLeadErrors,
  });
  if (io) {
    io.to(`tenant-${tenantId}`).emit("selected-leads-rederive-complete", { ...data, failedLeadErrors, tenantId });
    console.log(
      `[Socket.IO] Emitted selected-leads-rederive-complete for tenant-${tenantId} (` +
      `job=${data.jobId ?? "?"} total=${data.total} succeeded=${data.succeeded} ` +
      `failed=${data.failed} changed=${data.changed})`,
    );
  }
}

/**
 * Emits the terminal `selected-leads-rederive-cancelled` event when an
 * operator cancels an in-flight bulk re-derive. Mirrors the complete/failed
 * shape so the pending-leads sheet can render a "Cancelled at X/Y leads"
 * state with the already-succeeded counts preserved, and so a reconnecting
 * client can resolve the bar via the REST snapshot endpoint.
 */
export function emitSelectedLeadsRederiveCancelled(
  tenantId: number,
  data: {
    jobId: number | null;
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
    changed: number;
    failedLeadIds: number[];
    // The leads that were queued but never reached before cancel — used by
    // the sheet to render "X leads skipped" and offer a one-click
    // "Re-derive the rest" without making the operator re-select rows.
    // Optional for back-compat with callers that haven't been updated yet.
    skippedLeadIds?: number[];
    // Rule scope the job was kicked off against. Threaded through so the
    // terminal snapshot can be looked up by scope on sheet re-open. Optional
    // for back-compat — older callers that don't set these just lose the
    // restore-on-reopen affordance for their cancelled jobs.
    pageUrlPattern?: string;
    formIdentifier?: string;
  },
) {
  const skippedLeadIds = data.skippedLeadIds ?? [];
  recordSelectedLeadsRederiveTerminal(data.jobId, {
    status: "cancelled",
    tenantId,
    total: data.total,
    processed: data.processed,
    succeeded: data.succeeded,
    failed: data.failed,
    changed: data.changed,
    failedLeadIds: data.failedLeadIds,
    skippedLeadIds,
    pageUrlPattern: data.pageUrlPattern,
    formIdentifier: data.formIdentifier,
  });
  if (io) {
    io.to(`tenant-${tenantId}`).emit("selected-leads-rederive-cancelled", { ...data, skippedLeadIds, tenantId });
    console.log(
      `[Socket.IO] Emitted selected-leads-rederive-cancelled for tenant-${tenantId} (` +
      `job=${data.jobId ?? "?"} processed=${data.processed}/${data.total} ` +
      `succeeded=${data.succeeded} failed=${data.failed} changed=${data.changed})`,
    );
  }
}

export function emitSelectedLeadsRederiveFailed(
  tenantId: number,
  data: {
    jobId: number | null;
    total: number;
    reason: string;
  },
) {
  recordSelectedLeadsRederiveTerminal(data.jobId, {
    status: "failed",
    tenantId,
    total: data.total,
    reason: data.reason,
  });
  if (io) {
    io.to(`tenant-${tenantId}`).emit("selected-leads-rederive-failed", { ...data, tenantId });
    console.log(
      `[Socket.IO] Emitted selected-leads-rederive-failed for tenant-${tenantId} (` +
      `job=${data.jobId ?? "?"} total=${data.total} reason=${data.reason})`,
    );
  }
}

export function emitCallbackDue(tenantId: number, data: { leadId: number; targetUserId: number; leadName: string; phone?: string; callbackAt?: string }) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("callback-due", data);
    console.log(`[Socket.IO] Emitted callback-due for tenant-${tenantId} lead ${data.leadId} -> user ${data.targetUserId}`);
  }
}

async function loadFunnelTypesCache(): Promise<void> {
  try {
    const rows = await db.select({
      tenantId: tenantFunnelTypesTable.tenantId,
      name: funnelTypesTable.name,
      id: funnelTypesTable.id,
    })
      .from(tenantFunnelTypesTable)
      .innerJoin(funnelTypesTable, eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id))
      .where(eq(funnelTypesTable.isActive, true));
    const grouped: Record<number, { name: string; id: number }[]> = {};
    for (const r of rows) {
      if (!grouped[r.tenantId]) grouped[r.tenantId] = [];
      grouped[r.tenantId].push({ name: r.name, id: r.id });
    }
    cachedFunnelTypes = grouped;
  } catch { /* ignore */ }
}

export async function createDemoLead(): Promise<void> {
  try {
    const firstName = randomFrom(DEMO_FIRST_NAMES);
    const lastName = randomFrom(DEMO_LAST_NAMES);
    const source = randomFrom(DEMO_SOURCES);
    const demoTenants = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.isDemo, true));
    if (demoTenants.length === 0) return;
    const tenantId = randomFrom(demoTenants).id;

    const tenantFunnels = cachedFunnelTypes[tenantId];
    const selectedFunnel = tenantFunnels && tenantFunnels.length > 0
      ? randomFrom(tenantFunnels)
      : null;
    const leadType = selectedFunnel?.name || randomFrom(DEMO_LEAD_TYPES_FALLBACK);
    const funnelId = selectedFunnel?.id || null;

    const [lead] = await db.insert(leadsTable).values({
      tenantId,
      firstName,
      lastName,
      phone: fakePhone(),
      email: fakeEmail(firstName, lastName),
      source,
      originalSource: source,
      leadType,
      funnelId,
      interestType: randomFrom(DEMO_INTEREST_TYPES),
      status: "new",
      isNewCustomer: Math.random() > 0.3,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    if (lead) {
      const { recordLeadStatusChange } = await import("./services/lead-status-history");
      await recordLeadStatusChange({
        leadId: lead.id,
        tenantId,
        fromStatus: null,
        toStatus: "day_1",
        reason: "demo_created",
      });
      try {
        const result = await assignLeadRoundRobin(tenantId, lead.id, funnelId);
        if (result.assignedCsrId && result.passIntervalMinutes != null) {
          scheduleAutoPass(lead.id, result.passIntervalMinutes * 60 * 1000);
        } else if (!result.assignedCsrId) {
          console.warn(`[Demo] Lead ${lead.id} not assigned: ${result.reason}`);
        }
      } catch (err) {
        console.warn("[Demo] Auto-assign failed for demo lead", lead.id, err);
      }
      if (io) {
        const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
        io.to(`tenant-${tenantId}`).emit("new-lead", refreshed ?? lead);
      }
      console.log(`[Demo] New lead: ${firstName} ${lastName} (tenant ${tenantId})`);
    }
  } catch (err) {
    console.error("[Demo] Error creating demo lead:", err);
  }
}

async function startDemoMode() {
  if (demoTimer) clearTimeout(demoTimer);

  await loadFunnelTypesCache();

  const scheduleNext = () => {
    const delay = 30000 + Math.random() * 30000;
    demoTimer = setTimeout(() => {
      createDemoLead();
      scheduleNext();
    }, delay);
  };

  setTimeout(() => {
    createDemoLead();
    scheduleNext();
  }, 10000);

  setInterval(() => loadFunnelTypesCache(), 5 * 60 * 1000);

  console.log("[Demo] Demo mode started — new leads every 30-60s");
}

export async function getHudStats(tenantId: number | null, csrId?: number | null, startDate?: Date | null, endDate?: Date | null) {
  const rangeStart = startDate ?? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  const rangeEnd = endDate ?? new Date();

  const baseConds: any[] = [sql`${leadsTable.createdAt} >= ${rangeStart}`, sql`${leadsTable.createdAt} <= ${rangeEnd}`];
  if (tenantId) baseConds.push(eq(leadsTable.tenantId, tenantId));
  if (csrId) baseConds.push(eq(leadsTable.assignedCsrId, csrId));

  const [allLeadsToday] = await db.select({ count: count() }).from(leadsTable).where(and(...baseConds));

  const apptConds: any[] = [inArray(leadsTable.hubStatus, ["appt_set", "appt_booked"]), eq(leadsTable.preBooked, false), sql`${leadsTable.updatedAt} >= ${rangeStart}`, sql`${leadsTable.updatedAt} <= ${rangeEnd}`];
  if (tenantId) apptConds.push(eq(leadsTable.tenantId, tenantId));
  if (csrId) apptConds.push(eq(leadsTable.bookedByCsrId, csrId));
  const [apptToday] = await db.select({ count: count() }).from(leadsTable).where(and(...apptConds));

  const callAttemptsConds: any[] = [
    gte(callAttemptsTable.attemptedAt, rangeStart),
    sql`${callAttemptsTable.attemptedAt} <= ${rangeEnd}`,
    sql`${callAttemptsTable.actionType} NOT IN ('transfer', 'system')`,
  ];
  if (tenantId) callAttemptsConds.push(sql`${callAttemptsTable.leadId} IN (SELECT id FROM leads WHERE tenant_id = ${tenantId})`);
  if (csrId) callAttemptsConds.push(eq(callAttemptsTable.userId, csrId));
  const [callAttemptsToday] = await db.select({ count: count() }).from(callAttemptsTable).where(and(...callAttemptsConds));

  const contactedConds: any[] = [sql`${leadsTable.hubStatus} NOT IN ('day_1')`, eq(leadsTable.preBooked, false), sql`${leadsTable.updatedAt} >= ${rangeStart}`, sql`${leadsTable.updatedAt} <= ${rangeEnd}`];
  if (tenantId) contactedConds.push(eq(leadsTable.tenantId, tenantId));
  if (csrId) contactedConds.push(eq(leadsTable.assignedCsrId, csrId));
  const [contactedExclPreBooked] = await db.select({ count: count() }).from(leadsTable).where(and(...contactedConds));

  const totalCalls = callAttemptsToday.count;
  const bookings = apptToday.count;
  const bookingRate = contactedExclPreBooked.count > 0 ? Math.round((bookings / contactedExclPreBooked.count) * 100) : 0;
  const newLeadsToday = allLeadsToday.count;

  let commission = bookings * 20;
  if (tenantId) {
    const [tenantRow] = await db.select({ spiffConfig: tenantsTable.spiffConfig })
      .from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    const spiffConfig = parseSpiffConfig(tenantRow?.spiffConfig);
    const spiffConds: any[] = [inArray(leadsTable.hubStatus, ["appt_set", "appt_booked"]), eq(leadsTable.preBooked, false), sql`${leadsTable.updatedAt} >= ${rangeStart}`, sql`${leadsTable.updatedAt} <= ${rangeEnd}`];
    if (tenantId) spiffConds.push(eq(leadsTable.tenantId, tenantId));
    if (csrId) spiffConds.push(eq(leadsTable.bookedByCsrId, csrId));
    const bookedLeads = await db.select({ status: leadsTable.status, funnelId: leadsTable.funnelId })
      .from(leadsTable).where(and(...spiffConds));
    const funnelIds = [...new Set(bookedLeads.map(l => l.funnelId).filter((id): id is number => id !== null))];
    let funnelNameLookup: Record<number, string> = {};
    if (funnelIds.length > 0) {
      const fRows = await db.select({ id: funnelTypesTable.id, name: funnelTypesTable.name })
        .from(funnelTypesTable).where(inArray(funnelTypesTable.id, funnelIds));
      funnelNameLookup = Object.fromEntries(fRows.map(f => [f.id, f.name]));
    }
    const bookedLeadsWithFunnel = bookedLeads.map(l => ({
      status: "booked" as const,
      funnelName: l.funnelId ? (funnelNameLookup[l.funnelId] || null) : null,
    }));
    commission = computeSpiffCommission(bookedLeadsWithFunnel, spiffConfig);
  }

  const speedConds: any[] = [
    sql`${callAttemptsTable.actionType} NOT IN ('transfer', 'system')`,
    gte(callAttemptsTable.attemptedAt, rangeStart),
    sql`${callAttemptsTable.attemptedAt} <= ${rangeEnd}`,
  ];
  if (tenantId) speedConds.push(eq(leadsTable.tenantId, tenantId));
  if (csrId) speedConds.push(eq(callAttemptsTable.userId, csrId));

  const firstTouchRows = await db.select({
    leadId: callAttemptsTable.leadId,
    userId: sql<number>`(ARRAY_AGG(${callAttemptsTable.userId} ORDER BY ${callAttemptsTable.attemptedAt} ASC))[1]`.as("first_touch_user"),
    firstTouchAt: sql<Date>`MIN(${callAttemptsTable.attemptedAt})`.as("first_touch_at"),
    assignedAt: leadsTable.assignedAt,
    wallClockSpeed: sql<number>`MIN(EXTRACT(EPOCH FROM (${callAttemptsTable.attemptedAt} - ${leadsTable.assignedAt})))`.as("wall_clock_speed"),
  })
    .from(callAttemptsTable)
    .innerJoin(leadsTable, eq(callAttemptsTable.leadId, leadsTable.id))
    .where(and(...speedConds))
    .groupBy(callAttemptsTable.leadId, leadsTable.assignedAt);

  let avgSpeedToLead = 0;
  if (firstTouchRows.length > 0) {
    const { computeLoginAwareSpeeds } = await import("./services/login-time-calculator");
    const windows = firstTouchRows
      .filter(r => r.userId && r.assignedAt && r.firstTouchAt && Number(r.wallClockSpeed) > 0)
      .map(r => ({
        leadId: r.leadId,
        userId: Number(r.userId),
        assignedAt: new Date(r.assignedAt!),
        firstTouchAt: new Date(r.firstTouchAt!),
        wallClockSpeed: Math.max(0, Number(r.wallClockSpeed)),
      }));
    try {
      const speedResults = await computeLoginAwareSpeeds(windows);
      if (speedResults.length > 0) {
        avgSpeedToLead = Math.round(speedResults.reduce((sum, s) => sum + s.speed, 0) / speedResults.length);
      }
    } catch (err) {
      console.error("[HUD] Login-aware speed computation failed, using wall-clock fallback:", err);
      const wallClockSpeeds = windows.filter(w => w.wallClockSpeed > 0).map(w => w.wallClockSpeed);
      if (wallClockSpeeds.length > 0) {
        avgSpeedToLead = Math.round(wallClockSpeeds.reduce((sum, s) => sum + s, 0) / wallClockSpeeds.length);
      }
    }
  }

  return {
    callsMadeToday: totalCalls,
    bookingsToday: bookings,
    bookingRate,
    commission,
    newLeadsToday,
    avgSpeedToLead,
    soldToday: 0,
    bonusTier: bookingRate >= 60 ? "gold" : bookingRate >= 45 ? "silver" : bookingRate >= 30 ? "bronze" : "none",
    bonusThreshold: bookingRate >= 60 ? 60 : bookingRate >= 45 ? 45 : 30,
    nextBonusAt: bookingRate >= 60 ? 75 : bookingRate >= 45 ? 60 : bookingRate >= 30 ? 45 : 30,
  };
}
