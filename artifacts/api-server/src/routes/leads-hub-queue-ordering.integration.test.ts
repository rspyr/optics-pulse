/**
 * Real-Postgres integration test for the queue/archive ordering contract
 * introduced in Task #420.
 *
 * Task #420 changed the booked-status leads (appt_set, appt_booked) to anchor
 * their queue position on `bookedAt` (with `updatedAt` as a fallback when
 * bookedAt is null), and added a "Recently Booked" tab. Before that fix a CSR
 * typing notes on a booked lead would re-sort the row to the top of the queue
 * because the route was ordering by `updatedAt`.
 *
 * This file exercises the live SQL inside Postgres so that a future refactor
 * (e.g. someone reverting an ORDER BY back to `updatedAt`) trips a test
 * instead of silently regressing the queue.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

const dbModule = await import("@workspace/db");
const { db, tenantsTable, usersTable, leadsTable, callAttemptsTable } = dbModule;
const routerMod = await import("./leads-hub");

interface Fx {
  tenantId: number;
  csrId: number;
  // Booked leads where bookedAt vs updatedAt disagree on ordering.
  // L1: most recently booked, but its updatedAt is the oldest of the three.
  // L2: older booking, but its updatedAt is more recent than L1's — would
  //     leapfrog L1 if the route anchored on updatedAt.
  // L3: appt_booked with bookedAt=null — must fall back to updatedAt.
  // L4: dead row (archive-only) with bookedAt=null — fallback for archive.
  L1: number;
  L2: number;
  L3: number;
  L4: number;
}

let fx: Fx;
let app: express.Express;

function makeApp(tenantId: number, csrId: number, role: string = "client_admin"): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: csrId, userRole: role, tenantId,
    };
    next();
  });
  a.use(routerMod.default);
  return a;
}

function getJson(expressApp: express.Express, reqPath: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        { hostname: "127.0.0.1", port, path: reqPath, method: "GET" },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c.toString()));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  });
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const slug = `queue-ord`;
  const [tenant] = await db.insert(tenantsTable).values({
    name: `Queue Ordering Int ${slug}`,
    clientSlug: slug,
  }).returning();
  const [csr] = await db.insert(usersTable).values({
    email: `${slug}-csr@example.com`,
    name: "CSR",
    passwordHash: "x",
    role: "client_user",
    tenantId: tenant.id,
  }).returning();

  const now = Date.now();
  const tMinus = (mins: number) => new Date(now - mins * 60 * 1000);

  // L1: most recently booked (bookedAt 1h ago) but oldest updatedAt (3h ago).
  const [l1] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Booked", lastName: "One",
    source: "Meta", originalSource: "Meta",
    hubStatus: "appt_set", status: "booked",
    bookedAt: tMinus(60), updatedAt: tMinus(180),
  }).returning();
  // L2: older booking (2h ago) but the most recently edited of the two
  // bookedAt-having leads (30m ago). If the route anchored on updatedAt, L2
  // would jump above L1 — exactly the bug Task #420 fixed.
  const [l2] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Booked", lastName: "Two",
    source: "Meta", originalSource: "Meta",
    hubStatus: "appt_set", status: "booked",
    bookedAt: tMinus(120), updatedAt: tMinus(30),
  }).returning();
  // L3: appt_booked with bookedAt = null. Must fall back to updatedAt.
  // updatedAt = 15m ago makes it the most recent rung of the recently_booked
  // list under the COALESCE fallback.
  const [l3] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Pending", lastName: "Three",
    source: "Meta", originalSource: "Meta",
    hubStatus: "appt_booked",
    bookedAt: null, updatedAt: tMinus(15),
  }).returning();
  // L4: dead with bookedAt=null. Archive-only; falls back to updatedAt.
  const [l4] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Dead", lastName: "Four",
    source: "Meta", originalSource: "Meta",
    hubStatus: "dead", status: "lost",
    bookedAt: null, updatedAt: tMinus(10),
  }).returning();

  fx = { tenantId: tenant.id, csrId: csr.id, L1: l1.id, L2: l2.id, L3: l3.id, L4: l4.id };
  app = makeApp(fx.tenantId, fx.csrId);
});

afterAll(async () => {
  if (!fx) return;
  const ids = [fx.L1, fx.L2, fx.L3, fx.L4];
  try {
    await db.delete(callAttemptsTable).where(inArray(callAttemptsTable.leadId, ids));
    await db.delete(leadsTable).where(inArray(leadsTable.id, ids));
    await db.delete(usersTable).where(eq(usersTable.id, fx.csrId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("GET /leads-hub/queue — booked-status ordering (real Postgres)", () => {
  it("orders booked leads by bookedAt desc, even when a more-recently-edited lead has an older bookedAt", async () => {
    // Hit the route via the recently_booked tab, which is the most direct
    // expression of the contract: every appt_set/appt_booked row, anchored
    // on bookedAt. L2 was updated 30m ago vs L1's 3h ago, so if the route
    // anchored on updatedAt, L2 would come back ahead of L1. With the fix,
    // bookedAt (L1=1h ago, L2=2h ago) drives the order and L1 ranks higher.
    const res = await getJson(app, "/leads-hub/queue?tab=recently_booked");
    expect(res.status).toBe(200);

    const rows = (res.json.recentlyBooked as Array<{ id: number }>) ?? [];
    const ours = rows.filter(r => r.id === fx.L1 || r.id === fx.L2 || r.id === fx.L3 || r.id === fx.L4);
    const order = ours.map(r => r.id);

    // L3's bookedAt is null, so it falls back to updatedAt (15m ago) which is
    // more recent than either real bookedAt, so it leads. Then L1 (bookedAt
    // 1h ago) and L2 (bookedAt 2h ago). L4 is dead — not in the tab at all.
    expect(order).toEqual([fx.L3, fx.L1, fx.L2]);

    // Editing-notes invariant, stated as an explicit ordering check: L1's
    // updatedAt is OLDER than L2's, but L1 still ranks ABOVE L2 because the
    // route anchors on bookedAt. Re-saving notes on L2 cannot leapfrog it
    // over L1.
    expect(order.indexOf(fx.L1)).toBeLessThan(order.indexOf(fx.L2));
  });

  it("tab=recently_booked returns only appt_set / appt_booked leads", async () => {
    const res = await getJson(app, "/leads-hub/queue?tab=recently_booked");
    expect(res.status).toBe(200);

    const rows = (res.json.recentlyBooked as Array<{ id: number; hubStatus: string }>) ?? [];
    const ours = rows.filter(r => [fx.L1, fx.L2, fx.L3, fx.L4].includes(r.id));

    // L4 is dead — must be excluded from the recently_booked surface even
    // though it shares the archive bucket with appt_set rows elsewhere.
    expect(ours.map(r => r.id).sort()).toEqual([fx.L1, fx.L2, fx.L3].sort());
    for (const row of ours) {
      expect(["appt_set", "appt_booked"]).toContain(row.hubStatus);
    }
  });

  it("falls back to updatedAt ordering when bookedAt is null", async () => {
    const res = await getJson(app, "/leads-hub/queue?tab=recently_booked");
    expect(res.status).toBe(200);

    const rows = (res.json.recentlyBooked as Array<{ id: number }>) ?? [];
    const ours = rows.filter(r => [fx.L1, fx.L2, fx.L3].includes(r.id));
    const order = ours.map(r => r.id);

    // L3 has bookedAt=null and updatedAt=15m-ago, which is more recent than
    // L1's bookedAt (1h ago) and L2's bookedAt (2h ago). Under the COALESCE
    // fallback, L3 must rank above both — the fallback is doing the work.
    expect(order[0]).toBe(fx.L3);
    expect(order.indexOf(fx.L3)).toBeLessThan(order.indexOf(fx.L1));
    expect(order.indexOf(fx.L3)).toBeLessThan(order.indexOf(fx.L2));
  });
});

describe("GET /leads-hub/archive — booked-status ordering (real Postgres)", () => {
  it("appt_set rows order by bookedAt and dead rows fall back to updatedAt", async () => {
    const res = await getJson(app, "/leads-hub/archive");
    expect(res.status).toBe(200);

    const rows = (res.json.leads as Array<{ id: number; hubStatus: string }>) ?? [];
    const ours = rows.filter(r => [fx.L1, fx.L2, fx.L4].includes(r.id));
    const order = ours.map(r => r.id);

    // Archive only includes appt_set + dead, so L3 (appt_booked) is absent.
    // Under COALESCE(bookedAt, updatedAt) DESC:
    //   L4 (dead, fallback to updatedAt = 10m ago)  — most recent
    //   L1 (appt_set, bookedAt = 1h ago)
    //   L2 (appt_set, bookedAt = 2h ago)
    expect(order).toEqual([fx.L4, fx.L1, fx.L2]);

    // The bookedAt vs updatedAt invariant for the appt_set rows: L2 has the
    // most-recently-edited updatedAt of the appt_set rows, but L1 still
    // ranks above it because bookedAt drives the order.
    expect(order.indexOf(fx.L1)).toBeLessThan(order.indexOf(fx.L2));
  });
});
