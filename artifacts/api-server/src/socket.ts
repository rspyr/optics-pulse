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
    import("./services/push-notifications").then(({ sendPushToUser }) => {
      const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "New Lead";
      const source = (lead.source as string) || "";
      sendPushToUser(
        assignedCsrId,
        "New Lead Assigned",
        `${name}${source ? ` from ${source}` : ""}`,
        { leadId: lead.id, type: "new-lead", intent: "open-lead" },
      ).catch(err => console.error("[Push] emitNewLead push error:", err));
    }).catch(err => console.error("[Push] Failed to load push-notifications module:", err));
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

export function emitPodiumMessage(tenantId: number, message: Record<string, unknown>) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("podium-message", message);
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

async function createDemoLead(): Promise<void> {
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
      leadType,
      funnelId,
      interestType: randomFrom(DEMO_INTEREST_TYPES),
      status: "new",
      isNewCustomer: Math.random() > 0.3,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    if (lead) {
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
