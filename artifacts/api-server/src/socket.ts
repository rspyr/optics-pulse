import { Server as SocketIOServer, type Socket } from "socket.io";
import type { Server as HTTPServer } from "http";
import { db, leadsTable } from "@workspace/db";
import { eq, and, count, sql } from "drizzle-orm";

const DEMO_FIRST_NAMES = ["John", "Sarah", "Michael", "Emily", "David", "Jessica", "Robert", "Amanda", "William", "Jennifer", "James", "Lisa", "Daniel", "Maria", "Christopher"];
const DEMO_LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"];
const DEMO_SOURCES = ["Google Ads", "Meta Leads", "CallRail", "Organic Search"];
const DEMO_INTEREST_TYPES = ["Heat Pump", "AC Repair", "Full System", "Furnace", "Ductless Mini-Split", "Maintenance"];
const DEMO_LEAD_TYPES = ["Fit Funnel", "Quiz", "Pop-up", "Direct"];

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

    console.log(`[Socket.IO] Client connected: ${socket.id} (user ${session.userId})`);

    socket.on("join-tenant", (tenantId: number) => {
      if (typeof tenantId !== "number" || !Number.isInteger(tenantId) || tenantId <= 0) {
        socket.emit("error", { message: "Invalid tenant ID" });
        return;
      }

      const role = session.userRole;
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

async function createDemoLead(): Promise<void> {
  try {
    const firstName = randomFrom(DEMO_FIRST_NAMES);
    const lastName = randomFrom(DEMO_LAST_NAMES);
    const source = randomFrom(DEMO_SOURCES);
    const tenantId = Math.random() > 0.5 ? 1 : 2;

    const [lead] = await db.insert(leadsTable).values({
      tenantId,
      firstName,
      lastName,
      phone: fakePhone(),
      email: fakeEmail(firstName, lastName),
      source,
      leadType: randomFrom(DEMO_LEAD_TYPES),
      interestType: randomFrom(DEMO_INTEREST_TYPES),
      status: "new",
      isNewCustomer: Math.random() > 0.3,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    if (lead && io) {
      io.to(`tenant-${tenantId}`).emit("new-lead", lead);
      console.log(`[Demo] New lead: ${firstName} ${lastName} (tenant ${tenantId})`);
    }
  } catch (err) {
    console.error("[Demo] Error creating demo lead:", err);
  }
}

function startDemoMode() {
  if (demoTimer) clearTimeout(demoTimer);

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

  console.log("[Demo] Demo mode started — new leads every 30-60s");
}

export async function getHudStats(tenantId: number | null) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayConditions = tenantId
    ? and(eq(leadsTable.tenantId, tenantId), sql`${leadsTable.createdAt} >= ${today}`)
    : sql`${leadsTable.createdAt} >= ${today}`;

  const [allLeadsToday] = await db.select({ count: count() }).from(leadsTable).where(todayConditions);

  const bookedTodayConditions = tenantId
    ? and(eq(leadsTable.tenantId, tenantId), eq(leadsTable.status, "booked"), sql`${leadsTable.updatedAt} >= ${today}`)
    : and(eq(leadsTable.status, "booked"), sql`${leadsTable.updatedAt} >= ${today}`);
  const [bookedToday] = await db.select({ count: count() }).from(leadsTable).where(bookedTodayConditions);

  const soldTodayConditions = tenantId
    ? and(eq(leadsTable.tenantId, tenantId), eq(leadsTable.status, "sold"), sql`${leadsTable.updatedAt} >= ${today}`)
    : and(eq(leadsTable.status, "sold"), sql`${leadsTable.updatedAt} >= ${today}`);
  const [soldToday] = await db.select({ count: count() }).from(leadsTable).where(soldTodayConditions);

  const contactedTodayConditions = tenantId
    ? and(eq(leadsTable.tenantId, tenantId), sql`${leadsTable.status} != 'new'`, sql`${leadsTable.updatedAt} >= ${today}`)
    : and(sql`${leadsTable.status} != 'new'`, sql`${leadsTable.updatedAt} >= ${today}`);
  const [contactedToday] = await db.select({ count: count() }).from(leadsTable).where(contactedTodayConditions);

  const totalCalls = contactedToday.count;
  const bookings = bookedToday.count + soldToday.count;
  const bookingRate = totalCalls > 0 ? Math.round((bookings / totalCalls) * 100) : 0;
  const commission = bookings * 20;
  const newLeadsToday = allLeadsToday.count;
  const avgSpeedToLead = Math.round(45 + Math.random() * 120);

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
