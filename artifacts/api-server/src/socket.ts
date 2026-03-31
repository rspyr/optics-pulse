import { Server as SocketIOServer, type Socket } from "socket.io";
import type { Server as HTTPServer } from "http";
import { db, leadsTable, tenantsTable, funnelTypesTable, tenantFunnelTypesTable, callAttemptsTable } from "@workspace/db";
import { eq, and, count, sql, avg, inArray, gte, ne } from "drizzle-orm";
import { parseSpiffConfig, computeSpiffCommission } from "./routes/sales-manager";
import { assignLeadRoundRobin } from "./services/round-robin";

const DEMO_FIRST_NAMES = ["John", "Sarah", "Michael", "Emily", "David", "Jessica", "Robert", "Amanda", "William", "Jennifer", "James", "Lisa", "Daniel", "Maria", "Christopher"];
const DEMO_LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"];
const DEMO_SOURCES = ["Google Ads", "Meta Leads", "CallRail", "Organic Search"];
const DEMO_INTEREST_TYPES = ["Heat Pump", "AC Repair", "Full System", "Furnace", "Ductless Mini-Split", "Maintenance"];
const DEMO_LEAD_TYPES_FALLBACK = ["Fit Funnel", "Quiz", "Pop-up", "Direct"];

let cachedFunnelTypes: Record<number, { name: string; id: number }[]> = {};

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
  }
  if (process.env.REPLIT_DOMAINS) {
    process.env.REPLIT_DOMAINS.split(",").forEach(d => allowedOrigins.push(`https://${d}`));
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
  });

  io.engine.use(sessionMiddleware);

  io.on("connection", (socket: Socket) => {
    const req = socket.request as { session?: { userId?: number; userRole?: string; tenantId?: number } };
    const session = req.session;

    if (!session?.userId) {
      console.log(`[Socket.IO] Unauthenticated connection rejected: ${socket.id}`);
      socket.disconnect(true);
      return;
    }

    const role = session.userRole;
    console.log(`[Socket.IO] Client connected: ${socket.id} (user ${session.userId}, role ${role})`);

    if (role === "super_admin" || role === "agency_user") {
      db.select({ id: tenantsTable.id }).from(tenantsTable).then(tenants => {
        for (const t of tenants) {
          socket.join(`tenant-${t.id}`);
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

      if (role === "super_admin" || role === "agency_user") {
        socket.join(`tenant-${tenantId}`);
      } else if (session.tenantId === tenantId) {
        socket.join(`tenant-${tenantId}`);
      } else {
        socket.emit("error", { message: "Access denied to this tenant" });
        return;
      }
      console.log(`[Socket.IO] ${socket.id} joined tenant-${tenantId}`);
    });

    socket.on("disconnect", () => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
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

export function emitNewLead(tenantId: number, lead: Record<string, unknown>) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("new-lead", lead);
  }
}

export function emitLeadUpdated(tenantId: number, lead: Record<string, unknown>) {
  if (io) {
    io.to(`tenant-${tenantId}`).emit("lead-updated", lead);
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
        if (!result.assignedCsrId) {
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

  const bookedConds: any[] = [eq(leadsTable.status, "booked"), eq(leadsTable.preBooked, false), sql`${leadsTable.updatedAt} >= ${rangeStart}`, sql`${leadsTable.updatedAt} <= ${rangeEnd}`];
  if (tenantId) bookedConds.push(eq(leadsTable.tenantId, tenantId));
  if (csrId) bookedConds.push(eq(leadsTable.assignedCsrId, csrId));
  const [bookedToday] = await db.select({ count: count() }).from(leadsTable).where(and(...bookedConds));

  const soldConds: any[] = [eq(leadsTable.status, "sold"), eq(leadsTable.preBooked, false), sql`${leadsTable.updatedAt} >= ${rangeStart}`, sql`${leadsTable.updatedAt} <= ${rangeEnd}`];
  if (tenantId) soldConds.push(eq(leadsTable.tenantId, tenantId));
  if (csrId) soldConds.push(eq(leadsTable.assignedCsrId, csrId));
  const [soldToday] = await db.select({ count: count() }).from(leadsTable).where(and(...soldConds));

  const callAttemptsConds: any[] = [
    gte(callAttemptsTable.attemptedAt, rangeStart),
    sql`${callAttemptsTable.attemptedAt} <= ${rangeEnd}`,
    sql`${callAttemptsTable.actionType} != 'transfer'`,
  ];
  if (tenantId) callAttemptsConds.push(sql`${callAttemptsTable.leadId} IN (SELECT id FROM leads WHERE tenant_id = ${tenantId})`);
  if (csrId) callAttemptsConds.push(eq(callAttemptsTable.userId, csrId));
  const [callAttemptsToday] = await db.select({ count: count() }).from(callAttemptsTable).where(and(...callAttemptsConds));

  const contactedConds: any[] = [sql`${leadsTable.status} != 'new'`, eq(leadsTable.preBooked, false), sql`${leadsTable.updatedAt} >= ${rangeStart}`, sql`${leadsTable.updatedAt} <= ${rangeEnd}`];
  if (tenantId) contactedConds.push(eq(leadsTable.tenantId, tenantId));
  if (csrId) contactedConds.push(eq(leadsTable.assignedCsrId, csrId));
  const [contactedExclPreBooked] = await db.select({ count: count() }).from(leadsTable).where(and(...contactedConds));

  const totalCalls = callAttemptsToday.count;
  const bookings = bookedToday.count + soldToday.count;
  const bookingRate = contactedExclPreBooked.count > 0 ? Math.round((bookings / contactedExclPreBooked.count) * 100) : 0;
  const newLeadsToday = allLeadsToday.count;

  let commission = bookings * 20;
  if (tenantId) {
    const [tenantRow] = await db.select({ spiffConfig: tenantsTable.spiffConfig })
      .from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    const spiffConfig = parseSpiffConfig(tenantRow?.spiffConfig);
    const spiffConds: any[] = [inArray(leadsTable.status, ["booked", "sold"]), eq(leadsTable.preBooked, false), sql`${leadsTable.updatedAt} >= ${rangeStart}`, sql`${leadsTable.updatedAt} <= ${rangeEnd}`];
    if (tenantId) spiffConds.push(eq(leadsTable.tenantId, tenantId));
    if (csrId) spiffConds.push(eq(leadsTable.assignedCsrId, csrId));
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
      status: l.status,
      funnelName: l.funnelId ? (funnelNameLookup[l.funnelId] || null) : null,
    }));
    commission = computeSpiffCommission(bookedLeadsWithFunnel, spiffConfig);
  }

  const speedConds: any[] = [
    ne(callAttemptsTable.actionType, "transfer"),
    gte(callAttemptsTable.attemptedAt, rangeStart),
    sql`${callAttemptsTable.attemptedAt} <= ${rangeEnd}`,
  ];
  if (tenantId) speedConds.push(eq(leadsTable.tenantId, tenantId));
  if (csrId) speedConds.push(eq(callAttemptsTable.userId, csrId));

  const firstTouches = db.select({
    leadId: callAttemptsTable.leadId,
    first_touch_speed: sql<number>`MIN(EXTRACT(EPOCH FROM (${callAttemptsTable.attemptedAt} - ${leadsTable.assignedAt})))`.as("first_touch_speed"),
  })
    .from(callAttemptsTable)
    .innerJoin(leadsTable, eq(callAttemptsTable.leadId, leadsTable.id))
    .where(and(...speedConds))
    .groupBy(callAttemptsTable.leadId)
    .as("first_touches");

  const [speedResult] = await db.select({
    avgSpeed: sql<number>`COALESCE(AVG(first_touch_speed), 0)`,
  }).from(firstTouches);
  const avgSpeedToLead = Math.round(Number(speedResult?.avgSpeed ?? 0));

  return {
    callsMadeToday: totalCalls,
    bookingsToday: bookings,
    bookingRate,
    commission,
    newLeadsToday,
    avgSpeedToLead,
    soldToday: soldToday.count,
    bonusTier: bookingRate >= 60 ? "gold" : bookingRate >= 45 ? "silver" : bookingRate >= 30 ? "bronze" : "none",
    bonusThreshold: bookingRate >= 60 ? 60 : bookingRate >= 45 ? 45 : 30,
    nextBonusAt: bookingRate >= 60 ? 75 : bookingRate >= 45 ? 60 : bookingRate >= 30 ? 45 : 30,
  };
}
