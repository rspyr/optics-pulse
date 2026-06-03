/**
 * Real-Postgres parity coverage for the TWO code paths that turn repeat
 * form submissions into timeline history:
 *
 *   1. The live deferred-sync path — `syncSingleSheet` collects repeat rows
 *      for an existing phone, sorts them ascending by submission time, and
 *      calls `handleResubmission` once per row (latest booking wins).
 *   2. The one-time `backfillResubmissionTimeline` — groups historical sheet
 *      rows by phone, treats the earliest as the original, and records every
 *      later submission as a discrete `resubmission` call_attempt.
 *
 * They are SUPPOSED to behave identically for the rules that previously
 * caused the appointment-date oscillation bug:
 *   - latest-booking-wins ordering (including out-of-order rows and a row
 *     with no parseable timestamp),
 *   - a dead lead receives the booking fields but is NOT silently reopened,
 *   - a CSR-confirmed (appt_set) or sold lead keeps its appointment but still
 *     gets a history entry,
 *   - re-running the backfill is a true no-op.
 *
 * These tests feed BOTH paths the same scenarios (same booking values) and
 * assert the resulting terminal lead state is the same, so a future change to
 * one path that diverges from the other is caught.
 *
 * readRawSheetData is mocked per-describe and is sheet-id-aware: it returns
 * fixture rows only for the relevant sheet id and empty for everything else.
 * That keeps the global `backfillResubmissionTimeline` (which iterates EVERY
 * sheet config in the DB) from touching the live-path config or any config
 * created by a sibling test file running against the same throwaway DB.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, and, inArray, asc } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const {
  db,
  tenantsTable,
  usersTable,
  leadsTable,
  callAttemptsTable,
  leadStatusHistoryTable,
  googleSheetConfigsTable,
} = dbModule;

// Silence the socket / scheduler / round-robin / push side-effects so the
// tests stay focused on the resubmission-recording contract. lead-status-
// history is intentionally NOT mocked — we want real transition rows so the
// "dead lead is not reopened" claim is genuinely verified.
vi.mock("../socket", () => ({
  emitNewLead: vi.fn(),
  emitLeadUpdated: vi.fn(),
  emitLeadResubmitted: vi.fn(),
}));
vi.mock("./push-notification-jobs", () => ({
  enqueueSendPushToUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./lead-notify-scheduler", () => ({
  scheduleOrEmitNewLead: vi.fn(),
}));
vi.mock("./auto-pass-scheduler", () => ({
  scheduleAutoPass: vi.fn(),
  cancelAutoPass: vi.fn(),
}));
vi.mock("./round-robin", () => ({
  assignLeadRoundRobin: vi.fn().mockResolvedValue({ assignedCsrId: null, reason: "no CSRs" }),
}));
vi.mock("./integrations/google-sheets", () => ({
  readRawSheetData: vi.fn(),
}));

const sheetSyncMod = await import("./sheet-sync");
const googleSheetsMod = await import("./integrations/google-sheets");
const socketMod = await import("../socket");

const HEADERS = ["Submitted At", "First Name", "Last Name", "Phone", "Source", "Appt Date", "Appt Time"];
const COLUMN_MAPPING: Record<string, string> = {
  "Submitted At": "dateTime",
  "First Name": "firstName",
  "Last Name": "lastName",
  Phone: "phone",
  Source: "source",
  "Appt Date": "appointmentDate",
  "Appt Time": "appointmentTime",
};

const LIVE_SHEET_ID = "resub-parity-live-sheet";
const BACKFILL_SHEET_ID = "resub-parity-backfill-sheet";

// Distinct phone per scenario so groups never collide.
const PHONE = {
  liveDead: "5557000001",
  liveSet: "5557000002",
  liveSold: "5557000003",
  liveNormal: "5557000004",
  bfDead: "5557000011",
  bfSet: "5557000012",
  bfSold: "5557000013",
  bfNormal: "5557000014",
};

// Shared expected terminal state — the whole point: both paths must land here.
const EXPECT_DEAD = { appointmentDate: "2026-06-15", appointmentTime: "10:00", hubStatus: "dead", preBooked: true };
const EXPECT_SET = { appointmentDate: "2026-05-05", appointmentTime: "08:00", hubStatus: "appt_set" };
const EXPECT_SOLD = { appointmentDate: "2026-04-04", appointmentTime: "07:00", hubStatus: "appt_booked" };
const EXPECT_NORMAL = { appointmentDate: "2026-06-01", appointmentTime: "10:00", hubStatus: "appt_booked", preBooked: true };

interface Fx {
  tenantId: number;
  csrId: number;
  liveConfigId: number;
  backfillConfigId: number;
  leadIds: Record<string, number>;
}
let fx: Fx;

async function insertLead(fields: Record<string, unknown>): Promise<number> {
  const [lead] = await db.insert(leadsTable).values({
    tenantId: fx.tenantId,
    firstName: "Re",
    lastName: "Sub",
    source: "Meta",
    originalSource: "Meta",
    status: "new",
    dayInSequence: 1,
    contactPreferences: [],
    assignedCsrId: fx.csrId,
    ...fields,
  } as typeof leadsTable.$inferInsert).returning();
  return lead.id;
}

async function getLead(id: number) {
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, id));
  return lead;
}

async function resubAttempts(leadId: number) {
  return db.select().from(callAttemptsTable)
    .where(and(eq(callAttemptsTable.leadId, leadId), eq(callAttemptsTable.outcome, "resubmission")))
    .orderBy(asc(callAttemptsTable.attemptedAt), asc(callAttemptsTable.id));
}

function assertTerminalState(
  lead: typeof leadsTable.$inferSelect,
  expected: { appointmentDate: string; appointmentTime: string; hubStatus: string; preBooked?: boolean },
) {
  expect(lead.appointmentDate).toBe(expected.appointmentDate);
  expect(lead.appointmentTime).toBe(expected.appointmentTime);
  expect(lead.hubStatus).toBe(expected.hubStatus);
  if (expected.preBooked !== undefined) expect(lead.preBooked).toBe(expected.preBooked);
  // Every recorded submission stamps resubmittedAt on the lead.
  expect(lead.resubmittedAt).toBeInstanceOf(Date);
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  const slug = "resub-parity";
  const [tenant] = await db.insert(tenantsTable).values({
    name: `Resub Parity ${slug}`,
    clientSlug: slug,
  }).returning();
  const [csr] = await db.insert(usersTable).values({
    email: `${slug}-csr@example.com`,
    name: "Parity CSR",
    passwordHash: "x",
    role: "client_user",
    tenantId: tenant.id,
  }).returning();

  const [liveConfig] = await db.insert(googleSheetConfigsTable).values({
    tenantId: tenant.id,
    name: `Live ${slug}`,
    googleSheetId: LIVE_SHEET_ID,
    googleSheetTab: "Sheet1",
    columnMapping: COLUMN_MAPPING,
    mappingHeaders: HEADERS,
    syncRowWatermark: 0,
    syncPaused: false,
  }).returning();
  const [backfillConfig] = await db.insert(googleSheetConfigsTable).values({
    tenantId: tenant.id,
    name: `Backfill ${slug}`,
    googleSheetId: BACKFILL_SHEET_ID,
    googleSheetTab: "Sheet1",
    columnMapping: COLUMN_MAPPING,
    mappingHeaders: HEADERS,
    syncRowWatermark: 0,
    syncPaused: false,
  }).returning();

  fx = {
    tenantId: tenant.id,
    csrId: csr.id,
    liveConfigId: liveConfig.id,
    backfillConfigId: backfillConfig.id,
    leadIds: {},
  };
});

afterAll(async () => {
  if (!fx) return;
  try {
    const leads = await db.select({ id: leadsTable.id }).from(leadsTable)
      .where(eq(leadsTable.tenantId, fx.tenantId));
    const ids = leads.map(l => l.id);
    if (ids.length > 0) {
      await db.delete(callAttemptsTable).where(inArray(callAttemptsTable.leadId, ids));
      await db.delete(leadStatusHistoryTable).where(inArray(leadStatusHistoryTable.leadId, ids));
      await db.delete(leadsTable).where(inArray(leadsTable.id, ids));
    }
    await db.delete(googleSheetConfigsTable).where(eq(googleSheetConfigsTable.tenantId, fx.tenantId));
    await db.delete(usersTable).where(eq(usersTable.id, fx.csrId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Live deferred-sync path: syncSingleSheet -> handleResubmission
// ---------------------------------------------------------------------------
describe("live deferred-sync path (handleResubmission via syncSingleSheet)", () => {
  beforeAll(async () => {
    // Seed one pre-existing lead per scenario; in the live path the lead IS the
    // original submission, so every sheet row for its phone is a resubmission.
    fx.leadIds.liveDead = await insertLead({
      firstName: "Liam", lastName: "Dead", phone: PHONE.liveDead,
      hubStatus: "dead", status: "lost", deadReason: "no_answer",
    });
    fx.leadIds.liveSet = await insertLead({
      firstName: "Lily", lastName: "Set", phone: PHONE.liveSet,
      hubStatus: "appt_set", status: "booked",
      appointmentDate: "2026-05-05", appointmentTime: "08:00", preBooked: true,
    });
    fx.leadIds.liveSold = await insertLead({
      firstName: "Leo", lastName: "Sold", phone: PHONE.liveSold,
      hubStatus: "appt_booked", status: "booked", hasSoldEstimate: true,
      appointmentDate: "2026-04-04", appointmentTime: "07:00", preBooked: true,
    });
    fx.leadIds.liveNormal = await insertLead({
      firstName: "Nora", lastName: "Normal", phone: PHONE.liveNormal,
      hubStatus: "day_1", status: "new",
    });

    // Rows: out-of-order timestamps + one row with no parseable timestamp for
    // the normal lead. The latest parseable submission (2026-06-01) must win.
    const liveRows: string[][] = [
      ["2026-06-01T09:00:00", "Liam", "Dead", PHONE.liveDead, "Meta", "2026-06-15", "10:00"],
      ["2026-06-02T09:00:00", "Lily", "Set", PHONE.liveSet, "Google", "2026-09-09", "14:00"],
      ["2026-07-01T09:00:00", "Leo", "Sold", PHONE.liveSold, "Meta", "2026-12-12", "16:00"],
      // Normal: deliberately scrambled order; row 3 has no timestamp.
      ["2026-05-20T09:00:00", "Nora", "Normal", PHONE.liveNormal, "Meta", "2026-06-01", "10:00"],
      ["", "Nora", "Normal", PHONE.liveNormal, "Meta", "2026-07-01", "11:00"],
      ["2026-05-10T09:00:00", "Nora", "Normal", PHONE.liveNormal, "Meta", "2026-05-25", "13:00"],
      ["2026-05-01T09:00:00", "Nora", "Normal", PHONE.liveNormal, "Meta", "2026-05-15", "09:00"],
    ];

    vi.mocked(googleSheetsMod.readRawSheetData).mockImplementation(async (sheetId: string) =>
      sheetId === LIVE_SHEET_ID
        ? { headers: HEADERS, rawRows: liveRows }
        : { headers: [], rawRows: [] },
    );

    const [config] = await db.select().from(googleSheetConfigsTable)
      .where(eq(googleSheetConfigsTable.id, fx.liveConfigId));
    await sheetSyncMod.syncSingleSheet(config);
  });

  it("dead lead records the booking fields but stays dead (not reopened)", async () => {
    const lead = await getLead(fx.leadIds.liveDead);
    assertTerminalState(lead, EXPECT_DEAD);
    expect(await resubAttempts(fx.leadIds.liveDead)).toHaveLength(1);
    // No status transition row — a dead lead must not be silently reopened.
    const transitions = await db.select().from(leadStatusHistoryTable)
      .where(eq(leadStatusHistoryTable.leadId, fx.leadIds.liveDead));
    expect(transitions).toHaveLength(0);
  });

  it("CSR-confirmed (appt_set) lead keeps its appointment but still gets a history entry", async () => {
    const lead = await getLead(fx.leadIds.liveSet);
    assertTerminalState(lead, EXPECT_SET);
    expect(await resubAttempts(fx.leadIds.liveSet)).toHaveLength(1);
  });

  it("sold lead keeps its appointment but still gets a history entry", async () => {
    const lead = await getLead(fx.leadIds.liveSold);
    assertTerminalState(lead, EXPECT_SOLD);
    expect(await resubAttempts(fx.leadIds.liveSold)).toHaveLength(1);
  });

  it("normal lead with out-of-order + unparseable rows ends on the LATEST booking", async () => {
    const lead = await getLead(fx.leadIds.liveNormal);
    assertTerminalState(lead, EXPECT_NORMAL);
    // Live path records EVERY deferred row (the lead itself was the original).
    expect(await resubAttempts(fx.leadIds.liveNormal)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// One-time backfill path: backfillResubmissionTimeline
// ---------------------------------------------------------------------------
describe("backfill path (backfillResubmissionTimeline)", () => {
  beforeAll(async () => {
    fx.leadIds.bfDead = await insertLead({
      firstName: "Dana", lastName: "Dead", phone: PHONE.bfDead,
      hubStatus: "dead", status: "lost", deadReason: "no_answer",
    });
    fx.leadIds.bfSet = await insertLead({
      firstName: "Sam", lastName: "Set", phone: PHONE.bfSet,
      hubStatus: "appt_set", status: "booked",
      appointmentDate: "2026-05-05", appointmentTime: "08:00", preBooked: true,
    });
    fx.leadIds.bfSold = await insertLead({
      firstName: "Zoe", lastName: "Sold", phone: PHONE.bfSold,
      hubStatus: "appt_booked", status: "booked", hasSoldEstimate: true,
      appointmentDate: "2026-04-04", appointmentTime: "07:00", preBooked: true,
    });
    fx.leadIds.bfNormal = await insertLead({
      firstName: "Nina", lastName: "Normal", phone: PHONE.bfNormal,
      hubStatus: "day_1", status: "new",
    });

    // For backfill, each phone needs an "original" (earliest) row plus repeat
    // rows; the earliest is treated as the lead's creation and not recorded.
    const backfillRows: string[][] = [
      // Dead: original (no booking) + later booking.
      ["2026-05-01T09:00:00", "Dana", "Dead", PHONE.bfDead, "Meta", "", ""],
      ["2026-06-01T09:00:00", "Dana", "Dead", PHONE.bfDead, "Meta", "2026-06-15", "10:00"],
      // appt_set: original (matches lead) + later DIFFERENT booking.
      ["2026-05-02T09:00:00", "Sam", "Set", PHONE.bfSet, "Meta", "2026-05-05", "08:00"],
      ["2026-06-02T09:00:00", "Sam", "Set", PHONE.bfSet, "Google", "2026-09-09", "14:00"],
      // Sold: original (matches lead) + later DIFFERENT booking.
      ["2026-04-01T09:00:00", "Zoe", "Sold", PHONE.bfSold, "Meta", "2026-04-04", "07:00"],
      ["2026-07-01T09:00:00", "Zoe", "Sold", PHONE.bfSold, "Meta", "2026-12-12", "16:00"],
      // Normal: scrambled order; the no-timestamp row sorts earliest (becomes
      // the original). Latest parseable (2026-06-01) must win.
      ["2026-05-01T09:00:00", "Nina", "Normal", PHONE.bfNormal, "Meta", "2026-05-15", "09:00"],
      ["2026-05-20T09:00:00", "Nina", "Normal", PHONE.bfNormal, "Meta", "2026-06-01", "10:00"],
      ["", "Nina", "Normal", PHONE.bfNormal, "Meta", "2026-07-01", "11:00"],
      ["2026-05-10T09:00:00", "Nina", "Normal", PHONE.bfNormal, "Meta", "2026-05-25", "13:00"],
    ];

    vi.mocked(googleSheetsMod.readRawSheetData).mockImplementation(async (sheetId: string) =>
      sheetId === BACKFILL_SHEET_ID
        ? { headers: HEADERS, rawRows: backfillRows }
        : { headers: [], rawRows: [] },
    );

    await sheetSyncMod.backfillResubmissionTimeline();
  });

  it("dead lead records the booking fields but stays dead (not reopened)", async () => {
    const lead = await getLead(fx.leadIds.bfDead);
    assertTerminalState(lead, EXPECT_DEAD);
    expect(await resubAttempts(fx.leadIds.bfDead)).toHaveLength(1);
    const transitions = await db.select().from(leadStatusHistoryTable)
      .where(eq(leadStatusHistoryTable.leadId, fx.leadIds.bfDead));
    expect(transitions).toHaveLength(0);
  });

  it("CSR-confirmed (appt_set) lead keeps its appointment but still gets a history entry", async () => {
    const lead = await getLead(fx.leadIds.bfSet);
    assertTerminalState(lead, EXPECT_SET);
    expect(await resubAttempts(fx.leadIds.bfSet)).toHaveLength(1);
  });

  it("sold lead keeps its appointment but still gets a history entry", async () => {
    const lead = await getLead(fx.leadIds.bfSold);
    assertTerminalState(lead, EXPECT_SOLD);
    expect(await resubAttempts(fx.leadIds.bfSold)).toHaveLength(1);
  });

  it("normal lead with out-of-order + unparseable rows ends on the LATEST booking", async () => {
    const lead = await getLead(fx.leadIds.bfNormal);
    assertTerminalState(lead, EXPECT_NORMAL);
    // Backfill treats the earliest-sorted row (here the no-timestamp row) as
    // the original, so it records the other 3 as resubmissions.
    expect(await resubAttempts(fx.leadIds.bfNormal)).toHaveLength(3);
  });

  it("a second backfill run is a true no-op (0 entries, no lead mutation, no emits)", async () => {
    const before = await getLead(fx.leadIds.bfNormal);
    const beforeUpdatedAt = before.updatedAt?.getTime();
    const beforeResubmittedAt = before.resubmittedAt?.getTime();
    const beforeAttempts = await resubAttempts(fx.leadIds.bfNormal);

    vi.mocked(socketMod.emitLeadUpdated).mockClear();

    const result = await sheetSyncMod.backfillResubmissionTimeline();

    expect(result.entriesCreated).toBe(0);
    expect(result.leadsUpdated).toBe(0);
    // No socket emit on a no-op re-run.
    expect(vi.mocked(socketMod.emitLeadUpdated)).not.toHaveBeenCalled();

    const after = await getLead(fx.leadIds.bfNormal);
    expect(after.updatedAt?.getTime()).toBe(beforeUpdatedAt);
    expect(after.resubmittedAt?.getTime()).toBe(beforeResubmittedAt);
    // No new resubmission entries were created.
    expect(await resubAttempts(fx.leadIds.bfNormal)).toHaveLength(beforeAttempts.length);
  });
});
