/**
 * Real-Postgres integration coverage for the `lead_status_history` audit
 * table. Application-level writes are wired into four code paths
 * (leads-hub, socket demo, lead-resubmission, sheet-sync); this test drives
 * each path end-to-end against a live database and asserts the resulting
 * row's fromStatus, toStatus, reason, and changedByUserId.
 *
 * It also exercises an un-book / re-book sequence and asserts
 * `getBookingStatsByIdsAndDate` (via aggregateDailyStats) reflects the
 * latest booking — i.e. multiple appt_set transitions on the same lead
 * still count exactly once when the lead is currently booked, and the
 * count drops to zero once the lead's final status falls out of
 * (booked, sold).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, and, inArray, asc } from "drizzle-orm";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

const dbModule = await import("@workspace/db");
const {
  db,
  tenantsTable,
  usersTable,
  leadsTable,
  callAttemptsTable,
  leadStatusHistoryTable,
  funnelTypesTable,
  googleSheetConfigsTable,
  coordinatorDailyStatsTable,
} = dbModule;

vi.mock("../services/integrations/google-sheets", () => ({
  readRawSheetData: vi.fn(),
}));
vi.mock("./integrations/google-sheets", () => ({
  readRawSheetData: vi.fn(),
}));

const leadsHubRouter = (await import("../routes/leads-hub")).default;
const { handleResubmission } = await import("./lead-resubmission");
const { createDemoLead } = await import("../socket");
const sheetSyncMod = await import("./sheet-sync");
const googleSheetsMod = await import("./integrations/google-sheets");
const { aggregateDailyStats } = await import("./coordinator-stats");

interface Fx {
  tenantId: number;
  csrId: number;
  funnelId: number;
  sheetConfigId: number;
  leadIds: number[];
  extraUserIds: number[];
}

let fx: Fx;
let app: express.Express;

function makeApp(tenantId: number, csrId: number, role = "client_admin"): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: csrId, userRole: role, tenantId,
    };
    next();
  });
  a.use(leadsHubRouter);
  // Surface route handler errors as JSON 500s so the test helper's
  // JSON.parse doesn't choke on Express's default HTML error page.
  a.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return a;
}

function httpReq(
  expressApp: express.Express,
  method: "GET" | "POST" | "PUT",
  reqPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body ? JSON.stringify(body) : "";
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: reqPath,
          method,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload).toString(),
          },
        },
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
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function historyFor(leadId: number) {
  return db.select().from(leadStatusHistoryTable)
    .where(eq(leadStatusHistoryTable.leadId, leadId))
    .orderBy(asc(leadStatusHistoryTable.changedAt), asc(leadStatusHistoryTable.id));
}

beforeAll(async () => {
  const slug = `lsh-int-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [tenant] = await db.insert(tenantsTable).values({
    name: `LSH Int ${slug}`,
    clientSlug: slug,
    isDemo: true,
  }).returning();
  const [csr] = await db.insert(usersTable).values({
    email: `${slug}-csr@example.com`,
    name: "CSR One",
    passwordHash: "x",
    role: "client_user",
    tenantId: tenant.id,
  }).returning();
  const [funnel] = await db.insert(funnelTypesTable).values({
    name: `Solar-${slug}`,
    slug: `solar-${slug}`,
  }).returning();

  // Sheet config for sheet-sync write-site coverage. Headers/mapping
  // mirror what readRawSheetData (mocked below) returns.
  const [sheetConfig] = await db.insert(googleSheetConfigsTable).values({
    tenantId: tenant.id,
    name: `Sheet ${slug}`,
    googleSheetId: "fake-sheet-id",
    googleSheetTab: "Sheet1",
    columnMapping: {
      "First Name": "firstName",
      "Last Name": "lastName",
      "Phone": "phone",
      "Appt Booked": "appointmentBooked",
    },
    mappingHeaders: ["First Name", "Last Name", "Phone", "Appt Booked"],
    syncRowWatermark: 0,
    syncPaused: false,
    defaultFunnelTypeId: funnel.id,
  }).returning();

  fx = {
    tenantId: tenant.id,
    csrId: csr.id,
    funnelId: funnel.id,
    sheetConfigId: sheetConfig.id,
    leadIds: [],
    extraUserIds: [],
  };
  app = makeApp(fx.tenantId, fx.csrId);
});

afterAll(async () => {
  if (!fx) return;
  try {
    if (fx.leadIds.length > 0) {
      await db.delete(callAttemptsTable).where(inArray(callAttemptsTable.leadId, fx.leadIds));
      await db.delete(leadStatusHistoryTable).where(inArray(leadStatusHistoryTable.leadId, fx.leadIds));
      await db.delete(leadsTable).where(inArray(leadsTable.id, fx.leadIds));
    }
    // Catch demo-created leads we didn't track explicitly (createDemoLead
    // picks a random tenant from all isDemo=true tenants, so we still scope
    // cleanup by our tenant).
    const stragglers = await db.select({ id: leadsTable.id }).from(leadsTable).where(eq(leadsTable.tenantId, fx.tenantId));
    const ids = stragglers.map(s => s.id);
    if (ids.length > 0) {
      await db.delete(callAttemptsTable).where(inArray(callAttemptsTable.leadId, ids));
      await db.delete(leadStatusHistoryTable).where(inArray(leadStatusHistoryTable.leadId, ids));
      await db.delete(leadsTable).where(inArray(leadsTable.id, ids));
    }
    await db.delete(coordinatorDailyStatsTable).where(eq(coordinatorDailyStatsTable.tenantId, fx.tenantId));
    await db.delete(googleSheetConfigsTable).where(eq(googleSheetConfigsTable.id, fx.sheetConfigId));
    if (fx.extraUserIds.length > 0) {
      await db.delete(coordinatorDailyStatsTable)
        .where(inArray(coordinatorDailyStatsTable.userId, fx.extraUserIds));
      await db.delete(usersTable).where(inArray(usersTable.id, fx.extraUserIds));
    }
    await db.delete(usersTable).where(eq(usersTable.id, fx.csrId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
    await db.delete(funnelTypesTable).where(eq(funnelTypesTable.id, fx.funnelId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("leads-hub write sites — POST /leads-hub/create + POST /leads-hub/action", () => {
  it("POST /leads-hub/create writes (null → day_1, reason='created') with the acting CSR", async () => {
    const res = await httpReq(app, "POST", "/leads-hub/create", {
      firstName: "Hub", lastName: "Create",
      source: "Meta",
      assignedCsrId: fx.csrId,
      funnelId: fx.funnelId,
    });
    expect(res.status).toBe(201);
    const leadId = (res.json as { id: number }).id;
    fx.leadIds.push(leadId);

    const rows = await historyFor(leadId);
    expect(rows.length).toBe(1);
    expect(rows[0].fromStatus).toBeNull();
    expect(rows[0].toStatus).toBe("day_1");
    expect(rows[0].reason).toBe("created");
    expect(rows[0].changedByUserId).toBe(fx.csrId);
    expect(rows[0].tenantId).toBe(fx.tenantId);
  });

  it("POST /leads-hub/action with appointmentSet writes (day_1 → appt_set, reason='action:call')", async () => {
    const createRes = await httpReq(app, "POST", "/leads-hub/create", {
      firstName: "Hub", lastName: "Action",
      source: "Meta",
      assignedCsrId: fx.csrId,
      funnelId: fx.funnelId,
    });
    const leadId = (createRes.json as { id: number }).id;
    fx.leadIds.push(leadId);

    const actionRes = await httpReq(app, "POST", "/leads-hub/action", {
      leadId,
      actionType: "call",
      callResult: "spoke_with_customer",
      appointmentSet: true,
      appointmentDate: "2026-06-01",
      appointmentTime: "10:00",
    });
    expect(actionRes.status).toBe(200);

    const rows = await historyFor(leadId);
    // [0]: create (null → day_1), [1]: action (day_1 → appt_set).
    expect(rows.length).toBe(2);
    expect(rows[1].fromStatus).toBe("day_1");
    expect(rows[1].toStatus).toBe("appt_set");
    expect(rows[1].reason).toBe("action:call");
    expect(rows[1].changedByUserId).toBe(fx.csrId);
  });
});

describe("socket demo write site — createDemoLead()", () => {
  it("createDemoLead writes (null → day_1, reason='demo_created') with no changedByUserId", async () => {
    // createDemoLead picks a random tenant out of ALL isDemo=true tenants, so
    // we can't filter by our tenant alone (the dev DB seeds other demo
    // tenants). Snapshot every lead id beforehand and identify the one new
    // row regardless of which tenant it landed in.
    const beforeRows = await db.select({ id: leadsTable.id }).from(leadsTable);
    const beforeIds = new Set(beforeRows.map(b => b.id));

    await createDemoLead();

    const afterRows = await db.select({ id: leadsTable.id, tenantId: leadsTable.tenantId }).from(leadsTable);
    const fresh = afterRows.filter(a => !beforeIds.has(a.id));
    expect(fresh.length).toBe(1);
    const leadId = fresh[0].id;
    // Only track for cleanup if it landed in our tenant (otherwise cleanup
    // by tenant scope in afterAll won't apply and we leave the other
    // tenant's demo lead alone, which is fine).
    if (fresh[0].tenantId === fx.tenantId) fx.leadIds.push(leadId);

    const rows = await historyFor(leadId);
    expect(rows.length).toBe(1);
    expect(rows[0].fromStatus).toBeNull();
    expect(rows[0].toStatus).toBe("day_1");
    expect(rows[0].reason).toBe("demo_created");
    expect(rows[0].changedByUserId).toBeNull();

    // Clean up the demo lead (and its history row) regardless of which
    // tenant it landed in to keep the dev DB tidy across reruns.
    await db.delete(leadStatusHistoryTable).where(eq(leadStatusHistoryTable.leadId, leadId));
    await db.delete(callAttemptsTable).where(eq(callAttemptsTable.leadId, leadId));
    await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
  });
});

describe("lead-resubmission write site — handleResubmission()", () => {
  it("re-activates a day_3 lead and writes (day_3 → day_1, reason='resubmission:<source>') with the assigned CSR", async () => {
    const [lead] = await db.insert(leadsTable).values({
      tenantId: fx.tenantId,
      firstName: "Resub", lastName: "Lead",
      source: "Meta", originalSource: "Meta",
      assignedCsrId: fx.csrId,
      hubStatus: "day_3",
      dayInSequence: 3,
      status: "contacted",
    }).returning();
    fx.leadIds.push(lead.id);

    const result = await handleResubmission(fx.tenantId, lead.id, "Meta");
    expect(result.resubmitted).toBe(true);
    expect(result.reactivated).toBe(true);

    const rows = await historyFor(lead.id);
    expect(rows.length).toBe(1);
    expect(rows[0].fromStatus).toBe("day_3");
    expect(rows[0].toStatus).toBe("day_1");
    expect(rows[0].reason).toBe("resubmission:Meta");
    expect(rows[0].changedByUserId).toBe(fx.csrId);
  });

  it("does NOT write a transition row when the lead is already in day_1 (no-op guard)", async () => {
    const [lead] = await db.insert(leadsTable).values({
      tenantId: fx.tenantId,
      firstName: "Resub", lastName: "Noop",
      source: "Meta", originalSource: "Meta",
      assignedCsrId: fx.csrId,
      hubStatus: "day_1",
      dayInSequence: 1,
      status: "new",
    }).returning();
    fx.leadIds.push(lead.id);

    await handleResubmission(fx.tenantId, lead.id, "Meta");

    const rows = await historyFor(lead.id);
    expect(rows.length).toBe(0);
  });

  it("does NOT write a transition row for a terminal (appt_set) lead", async () => {
    const [lead] = await db.insert(leadsTable).values({
      tenantId: fx.tenantId,
      firstName: "Resub", lastName: "Terminal",
      source: "Meta", originalSource: "Meta",
      assignedCsrId: fx.csrId,
      hubStatus: "appt_set",
      status: "booked",
    }).returning();
    fx.leadIds.push(lead.id);

    const result = await handleResubmission(fx.tenantId, lead.id, "Meta");
    expect(result.reactivated).toBe(false);

    const rows = await historyFor(lead.id);
    expect(rows.length).toBe(0);
  });
});

describe("sheet-sync write site — syncSingleSheet()", () => {
  it("imports a new sheet row and writes (null → day_1, reason='sheet_sync_create')", async () => {
    vi.mocked(googleSheetsMod.readRawSheetData).mockResolvedValueOnce({
      headers: ["First Name", "Last Name", "Phone", "Appt Booked"],
      rawRows: [["Sheet", "Imported", "5550001234", "no"]],
    });

    const [config] = await db.select().from(googleSheetConfigsTable)
      .where(eq(googleSheetConfigsTable.id, fx.sheetConfigId));

    const before = new Set((await db.select({ id: leadsTable.id }).from(leadsTable)
      .where(eq(leadsTable.tenantId, fx.tenantId))).map(r => r.id));

    await sheetSyncMod.syncSingleSheet(config);

    const after = await db.select({ id: leadsTable.id, hubStatus: leadsTable.hubStatus })
      .from(leadsTable).where(eq(leadsTable.tenantId, fx.tenantId));
    const fresh = after.filter(a => !before.has(a.id));
    expect(fresh.length).toBe(1);
    const leadId = fresh[0].id;
    fx.leadIds.push(leadId);

    const rows = await historyFor(leadId);
    expect(rows.length).toBe(1);
    expect(rows[0].fromStatus).toBeNull();
    expect(rows[0].toStatus).toBe("day_1");
    expect(rows[0].reason).toBe("sheet_sync_create");
    expect(rows[0].changedByUserId).toBeNull();
  });

  it("rescan that flips an existing lead to appt_booked writes (day_1 → appt_booked, reason='sheet_sync:<id>')", async () => {
    // Seed a baseline lead with a known phone, then drive the rescan path
    // by returning a row whose `Appt Booked` is "yes" within the watermark
    // window. The rescan branch only fires for rows already inside the
    // existing watermark, so bump it first.
    const phone = "5550009999";
    const [lead] = await db.insert(leadsTable).values({
      tenantId: fx.tenantId,
      firstName: "Rescan", lastName: "Target",
      phone,
      source: "Meta", originalSource: "Meta",
      hubStatus: "day_1",
      status: "new",
      preBooked: false,
      contactPreferences: [],
    }).returning();
    fx.leadIds.push(lead.id);

    // Push watermark forward so the next sync call treats the row as
    // "existing" and goes through rescanExistingRows.
    await db.update(googleSheetConfigsTable)
      .set({ syncRowWatermark: 5 })
      .where(eq(googleSheetConfigsTable.id, fx.sheetConfigId));

    vi.mocked(googleSheetsMod.readRawSheetData).mockResolvedValueOnce({
      headers: ["First Name", "Last Name", "Phone", "Appt Booked"],
      rawRows: [
        ["Rescan", "Target", phone, "yes"],
        ["X", "X", "0", "no"],
        ["X", "X", "0", "no"],
        ["X", "X", "0", "no"],
        ["X", "X", "0", "no"],
      ],
    });

    const [config] = await db.select().from(googleSheetConfigsTable)
      .where(eq(googleSheetConfigsTable.id, fx.sheetConfigId));
    await sheetSyncMod.syncSingleSheet(config);

    const rows = await historyFor(lead.id);
    // Exactly one row: the rescan-driven transition. (sheet_sync_create
    // does NOT fire here because the lead pre-existed.)
    expect(rows.length).toBe(1);
    expect(rows[0].fromStatus).toBe("day_1");
    expect(rows[0].toStatus).toBe("appt_booked");
    expect(rows[0].reason).toBe(`sheet_sync:${fx.sheetConfigId}`);
    expect(rows[0].changedByUserId).toBeNull();
  });
});

describe("un-book / re-book — getBookingStatsByIdsAndDate reflects the latest booking", () => {
  it("counts a same-day book → un-book → re-book sequence exactly once, and excludes a book → un-book (no re-book) lead", async () => {
    // Use a fresh CSR scoped to this test so the per-user booking aggregate
    // is not polluted by leads booked in earlier describe blocks (which
    // assert lead-level history, not CSR-level aggregates).
    const slug = `rebook-csr-${Date.now()}`;
    const [scopedCsr] = await db.insert(usersTable).values({
      email: `${slug}@example.com`,
      name: "Rebook CSR",
      passwordHash: "x",
      role: "client_user",
      tenantId: fx.tenantId,
    }).returning();
    fx.extraUserIds.push(scopedCsr.id);
    const scopedApp = makeApp(fx.tenantId, scopedCsr.id);
    // For leadA, the status_history rows recorded by the leads-hub write
    // site should be exactly:
    //   1) null         → day_1     (create)
    //   2) day_1        → appt_set  (book)
    //   3) appt_set     → dead      (un-book via deadReason)
    //   4) dead         → appt_set  (re-book)
    // distinctOn(leadId) inside getBookingStatsByIdsAndDate collapses the
    // two appt_set rows into a single contribution. The lead's *current*
    // status is booked + preBooked=false after the re-book, so it
    // satisfies the join filter — bookingsCount picks up the re-book
    // exactly once.
    const createRes = await httpReq(scopedApp, "POST", "/leads-hub/create", {
      firstName: "Rebook", lastName: "WinsLatest",
      source: "Meta",
      assignedCsrId: scopedCsr.id,
      funnelId: fx.funnelId,
    });
    expect(createRes.status).toBe(201);
    const leadA = (createRes.json as { id: number }).id;
    fx.leadIds.push(leadA);

    // Book.
    let r = await httpReq(scopedApp, "POST", "/leads-hub/action", {
      leadId: leadA,
      actionType: "call",
      callResult: "spoke_with_customer",
      appointmentSet: true,
      appointmentDate: "2026-06-02",
      appointmentTime: "10:00",
    });
    expect(r.status).toBe(200);

    // Un-book: spoke + deadReason → hubStatus=dead. The route now fully
    // resets the booking cache (status, disposition, bookedByCsrId,
    // bookedAt) so the lead leaves the {booked, sold} aggregate window.
    r = await httpReq(scopedApp, "POST", "/leads-hub/action", {
      leadId: leadA,
      actionType: "call",
      callResult: "spoke_with_customer",
      deadReason: "customer_cancelled",
    });
    expect(r.status).toBe(200);

    // Confirm the lead's booking cache is fully reset after un-book.
    const [afterUnbookA] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadA));
    expect(afterUnbookA.hubStatus).toBe("dead");
    expect(afterUnbookA.status).toBe("lost");
    expect(afterUnbookA.disposition).toBeNull();
    expect(afterUnbookA.bookedByCsrId).toBeNull();
    expect(afterUnbookA.bookedAt).toBeNull();

    // Re-book: spoke + appointmentSet → hubStatus=appt_set, status=booked.
    r = await httpReq(scopedApp, "POST", "/leads-hub/action", {
      leadId: leadA,
      actionType: "call",
      callResult: "spoke_with_customer",
      appointmentSet: true,
      appointmentDate: "2026-06-03",
      appointmentTime: "11:00",
    });
    expect(r.status).toBe(200);

    const historyA = await historyFor(leadA);
    expect(historyA.map(h => `${h.fromStatus ?? "null"}→${h.toStatus}`)).toEqual([
      "null→day_1",
      "day_1→appt_set",
      "appt_set→dead",
      "dead→appt_set",
    ]);
    // Two distinct appt_set transitions exist for the same lead on the same
    // day — proving the audit table captured the re-book (which a
    // mutable `booked_at` snapshot would have lost).
    expect(historyA.filter(h => h.toStatus === "appt_set").length).toBe(2);

    // leadB: booked then un-booked, never re-booked. Must NOT contribute to
    // bookingsCount — its booking cache should leave the {booked, sold}
    // join filter entirely.
    const createResB = await httpReq(scopedApp, "POST", "/leads-hub/create", {
      firstName: "Unbook", lastName: "OnlyOnce",
      source: "Meta",
      assignedCsrId: scopedCsr.id,
      funnelId: fx.funnelId,
    });
    expect(createResB.status).toBe(201);
    const leadB = (createResB.json as { id: number }).id;
    fx.leadIds.push(leadB);

    r = await httpReq(scopedApp, "POST", "/leads-hub/action", {
      leadId: leadB,
      actionType: "call",
      callResult: "spoke_with_customer",
      appointmentSet: true,
      appointmentDate: "2026-06-04",
      appointmentTime: "09:00",
    });
    expect(r.status).toBe(200);

    r = await httpReq(scopedApp, "POST", "/leads-hub/action", {
      leadId: leadB,
      actionType: "call",
      callResult: "spoke_with_customer",
      deadReason: "customer_cancelled",
    });
    expect(r.status).toBe(200);

    const [afterUnbookB] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadB));
    expect(afterUnbookB.hubStatus).toBe("dead");
    expect(afterUnbookB.status).toBe("lost");
    expect(afterUnbookB.disposition).toBeNull();
    expect(afterUnbookB.bookedByCsrId).toBeNull();
    expect(afterUnbookB.bookedAt).toBeNull();

    // Aggregate today and pull the persisted row for our CSR.
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const dayStr = `${y}-${m}-${d}`;

    await aggregateDailyStats(dayStr);

    const [statsRow] = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.userId, scopedCsr.id),
      eq(coordinatorDailyStatsTable.date, dayStr),
    ));
    expect(statsRow).toBeDefined();
    // Only leadA (currently re-booked) contributes — leadB has been fully
    // un-booked and is excluded from the aggregate window.
    expect(statsRow.bookingsCount).toBe(1);
  });
});

describe("PUT /leads-hub/action/:attemptId — editing a booked attempt into a deadReason rolls back the booking cache", () => {
  it("resets status/disposition/bookedByCsrId/bookedAt and drops the lead from the daily booking aggregate", async () => {
    // Fresh CSR so the per-user aggregate isn't polluted by prior describe
    // blocks that book leads against fx.csrId.
    const slug = `edit-unbook-csr-${Date.now()}`;
    const [scopedCsr] = await db.insert(usersTable).values({
      email: `${slug}@example.com`,
      name: "Edit Unbook CSR",
      passwordHash: "x",
      role: "client_user",
      tenantId: fx.tenantId,
    }).returning();
    fx.extraUserIds.push(scopedCsr.id);
    const scopedApp = makeApp(fx.tenantId, scopedCsr.id);

    const createRes = await httpReq(scopedApp, "POST", "/leads-hub/create", {
      firstName: "EditUnbook", lastName: "Lead",
      source: "Meta",
      assignedCsrId: scopedCsr.id,
      funnelId: fx.funnelId,
    });
    expect(createRes.status).toBe(201);
    const leadId = (createRes.json as { id: number }).id;
    fx.leadIds.push(leadId);

    // Book the lead via POST /leads-hub/action.
    const bookRes = await httpReq(scopedApp, "POST", "/leads-hub/action", {
      leadId,
      actionType: "call",
      callResult: "spoke_with_customer",
      appointmentSet: true,
      appointmentDate: "2026-06-10",
      appointmentTime: "14:00",
    });
    expect(bookRes.status).toBe(200);
    const attemptId = (bookRes.json as { attempt: { id: number } }).attempt.id;

    // Sanity: lead is in the booked aggregate window.
    const [beforeEdit] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    expect(beforeEdit.hubStatus).toBe("appt_set");
    expect(beforeEdit.status).toBe("booked");
    expect(beforeEdit.disposition).toBe("booked");
    expect(beforeEdit.bookedByCsrId).toBe(scopedCsr.id);
    expect(beforeEdit.bookedAt).not.toBeNull();

    // CSR edits the past attempt into a dead state via
    // PUT /leads-hub/action/:attemptId — effectively un-booking the lead.
    const editRes = await httpReq(scopedApp, "PUT", `/leads-hub/action/${attemptId}`, {
      callResult: "spoke_with_customer",
      spokeResult: "dead",
      deadReason: "customer_cancelled",
    });
    expect(editRes.status).toBe(200);

    // The booking cache must be fully reset, mirroring the POST un-book path.
    const [afterEdit] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    expect(afterEdit.hubStatus).toBe("dead");
    expect(afterEdit.status).toBe("lost");
    expect(afterEdit.disposition).toBeNull();
    expect(afterEdit.bookedByCsrId).toBeNull();
    expect(afterEdit.bookedAt).toBeNull();
    expect(afterEdit.deadReason).toBe("customer_cancelled");

    // The daily booking aggregate must exclude this lead — there's nothing
    // else booked for this CSR today, so bookingsCount should be 0.
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const dayStr = `${y}-${m}-${d}`;

    await aggregateDailyStats(dayStr);

    const [statsRow] = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.userId, scopedCsr.id),
      eq(coordinatorDailyStatsTable.date, dayStr),
    ));
    // The CSR may or may not have a row depending on whether other activity
    // was recorded; either way, bookingsCount for them must be 0.
    expect(statsRow?.bookingsCount ?? 0).toBe(0);
  });
});
