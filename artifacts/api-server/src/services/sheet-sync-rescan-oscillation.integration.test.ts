/**
 * Real-Postgres regression coverage for the appointment-date OSCILLATION bug.
 *
 * The original bug lived in the live sync's rescan path (`rescanExistingRows`):
 * when one customer submits the same form several times, the sheet accumulates
 * multiple rows with the SAME phone but DIFFERENT appointment dates. If all of
 * those rows sit BELOW the sync watermark they are re-processed every cycle. The
 * buggy version compared each duplicate row against a stale in-memory snapshot
 * of the lead and wrote-on-any-difference, so the stored appointment date
 * flipped between two values on every ~60s sync.
 *
 * The parity tests (`resubmission-parity.integration.test.ts`) deliberately
 * drive the live path with watermark=0, which skips the rescan branch entirely.
 * This file fills that gap: it advances the watermark PAST several duplicate-
 * phone rows (so they sit below it), runs `syncSingleSheet` TWICE, and asserts
 * the stored appointment is byte-for-byte identical after both cycles — i.e. it
 * does not oscillate.
 *
 * It also covers the "locked appointment" guard in the rescan path: an
 * `appt_set` (CSR-confirmed) lead and a sold lead must keep their original
 * appointment untouched across cycles, even though the sheet has later rows with
 * different dates.
 *
 * readRawSheetData is mocked sheet-id-aware so only this file's config sees the
 * fixture rows; everything else gets empty rows.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

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

// Silence the socket / scheduler / round-robin / push side-effects so the test
// stays focused on the rescan write contract. lead-status-history is NOT mocked
// — we want real transition rows.
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

const SHEET_ID = "rescan-oscillation-sheet";

// Distinct phones so groups never collide with sibling test files.
const PHONE = {
  normal: "5558000001",
  set: "5558000002",
  sold: "5558000003",
};

// Repeat-phone rows that all sit below the watermark, with DIFFERING appointment
// dates and scrambled submission order (including one unparseable timestamp).
// For the normal lead the LATEST parseable submission (2026-06-15) must win and
// stay won; for the locked leads nothing must change.
const RAW_ROWS: string[][] = [
  // Normal lead: scrambled order; the no-timestamp row must NOT win.
  ["2026-05-01T09:00:00", "Nora", "Normal", PHONE.normal, "Meta", "2026-05-15", "09:00"],
  ["2026-06-01T09:00:00", "Nora", "Normal", PHONE.normal, "Meta", "2026-06-15", "10:00"],
  ["", "Nora", "Normal", PHONE.normal, "Meta", "2026-07-01", "11:00"],
  ["2026-05-10T09:00:00", "Nora", "Normal", PHONE.normal, "Meta", "2026-05-25", "13:00"],
  // appt_set lead: later rows with different dates must be ignored (locked).
  ["2026-06-02T09:00:00", "Lily", "Set", PHONE.set, "Google", "2026-09-09", "14:00"],
  ["2026-05-20T09:00:00", "Lily", "Set", PHONE.set, "Meta", "2026-08-08", "12:00"],
  // sold lead: later rows with different dates must be ignored (locked).
  ["2026-07-01T09:00:00", "Leo", "Sold", PHONE.sold, "Meta", "2026-12-12", "16:00"],
  ["2026-06-05T09:00:00", "Leo", "Sold", PHONE.sold, "Meta", "2026-11-11", "15:00"],
];

// Terminal appointment each lead must hold after BOTH cycles.
const EXPECT_NORMAL = { appointmentDate: "2026-06-15", appointmentTime: "10:00" };
const EXPECT_SET = { appointmentDate: "2026-05-05", appointmentTime: "08:00" };
const EXPECT_SOLD = { appointmentDate: "2026-04-04", appointmentTime: "07:00" };

interface Fx {
  tenantId: number;
  csrId: number;
  configId: number;
  leadIds: { normal: number; set: number; sold: number };
}
let fx: Fx;

async function insertLead(fields: Record<string, unknown>): Promise<number> {
  const [lead] = await db.insert(leadsTable).values({
    tenantId: fx.tenantId,
    firstName: "Re",
    lastName: "Scan",
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

async function runCycle() {
  const [config] = await db.select().from(googleSheetConfigsTable)
    .where(eq(googleSheetConfigsTable.id, fx.configId));
  await sheetSyncMod.syncSingleSheet(config);
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  const slug = "rescan-oscillation";
  const [tenant] = await db.insert(tenantsTable).values({
    name: `Rescan Oscillation ${slug}`,
    clientSlug: slug,
  }).returning();
  const [csr] = await db.insert(usersTable).values({
    email: `${slug}-csr@example.com`,
    name: "Rescan CSR",
    passwordHash: "x",
    role: "client_user",
    tenantId: tenant.id,
  }).returning();

  // Watermark sits AT the row count, so every fixture row is "existing" (below
  // the watermark) and is handled by the rescan path on every cycle — and the
  // watermark never advances, so cycle 2 re-scans exactly the same rows.
  const [config] = await db.insert(googleSheetConfigsTable).values({
    tenantId: tenant.id,
    name: `Rescan ${slug}`,
    googleSheetId: SHEET_ID,
    googleSheetTab: "Sheet1",
    columnMapping: COLUMN_MAPPING,
    mappingHeaders: HEADERS,
    syncRowWatermark: RAW_ROWS.length,
    syncPaused: false,
  }).returning();

  fx = {
    tenantId: tenant.id,
    csrId: csr.id,
    configId: config.id,
    leadIds: { normal: 0, set: 0, sold: 0 },
  };

  fx.leadIds.normal = await insertLead({
    firstName: "Nora", lastName: "Normal", phone: PHONE.normal,
    hubStatus: "day_1", status: "new",
  });
  fx.leadIds.set = await insertLead({
    firstName: "Lily", lastName: "Set", phone: PHONE.set,
    hubStatus: "appt_set", status: "booked",
    appointmentDate: "2026-05-05", appointmentTime: "08:00", preBooked: true,
  });
  fx.leadIds.sold = await insertLead({
    firstName: "Leo", lastName: "Sold", phone: PHONE.sold,
    hubStatus: "appt_booked", status: "booked", hasSoldEstimate: true,
    appointmentDate: "2026-04-04", appointmentTime: "07:00", preBooked: true,
  });

  vi.mocked(googleSheetsMod.readRawSheetData).mockImplementation(async (sheetId: string) =>
    sheetId === SHEET_ID
      ? { headers: HEADERS, rawRows: RAW_ROWS.map(r => [...r]) }
      : { headers: [], rawRows: [] },
  );
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

describe("rescan path appointment-date stability across consecutive sync cycles", () => {
  // Snapshots captured after each cycle so every assertion can prove the value
  // is identical cycle-over-cycle (the oscillation symptom).
  let afterCycle1: { normal: typeof leadsTable.$inferSelect; set: typeof leadsTable.$inferSelect; sold: typeof leadsTable.$inferSelect };
  let afterCycle2: typeof afterCycle1;

  beforeAll(async () => {
    await runCycle();
    afterCycle1 = {
      normal: await getLead(fx.leadIds.normal),
      set: await getLead(fx.leadIds.set),
      sold: await getLead(fx.leadIds.sold),
    };
    await runCycle();
    afterCycle2 = {
      normal: await getLead(fx.leadIds.normal),
      set: await getLead(fx.leadIds.set),
      sold: await getLead(fx.leadIds.sold),
    };
  });

  it("the watermark never advances, so the same rows are rescanned each cycle", async () => {
    const [config] = await db.select().from(googleSheetConfigsTable)
      .where(eq(googleSheetConfigsTable.id, fx.configId));
    expect(config.syncRowWatermark).toBe(RAW_ROWS.length);
  });

  it("normal lead adopts the LATEST submission and does NOT oscillate", () => {
    // Cycle 1 lands on the latest parseable booking.
    expect(afterCycle1.normal.appointmentDate).toBe(EXPECT_NORMAL.appointmentDate);
    expect(afterCycle1.normal.appointmentTime).toBe(EXPECT_NORMAL.appointmentTime);
    // Cycle 2 holds exactly the same value — the bug would have flipped it.
    expect(afterCycle2.normal.appointmentDate).toBe(afterCycle1.normal.appointmentDate);
    expect(afterCycle2.normal.appointmentTime).toBe(afterCycle1.normal.appointmentTime);
    expect(afterCycle2.normal.appointmentDate).toBe(EXPECT_NORMAL.appointmentDate);
    expect(afterCycle2.normal.appointmentTime).toBe(EXPECT_NORMAL.appointmentTime);
  });

  it("normal lead is a true no-op on cycle 2 (no churn once it has adopted the latest)", () => {
    // Once stable, the second cycle must not re-write the row at all.
    expect(afterCycle2.normal.updatedAt?.getTime()).toBe(afterCycle1.normal.updatedAt?.getTime());
    expect(afterCycle2.normal.hubStatus).toBe(afterCycle1.normal.hubStatus);
  });

  it("appt_set (CSR-confirmed) lead keeps its locked appointment across both cycles", () => {
    expect(afterCycle1.set.appointmentDate).toBe(EXPECT_SET.appointmentDate);
    expect(afterCycle1.set.appointmentTime).toBe(EXPECT_SET.appointmentTime);
    expect(afterCycle1.set.hubStatus).toBe("appt_set");
    // Locked appointment is never touched, so it cannot oscillate.
    expect(afterCycle2.set.appointmentDate).toBe(EXPECT_SET.appointmentDate);
    expect(afterCycle2.set.appointmentTime).toBe(EXPECT_SET.appointmentTime);
    expect(afterCycle2.set.hubStatus).toBe("appt_set");
  });

  it("sold lead keeps its locked appointment across both cycles", () => {
    expect(afterCycle1.sold.appointmentDate).toBe(EXPECT_SOLD.appointmentDate);
    expect(afterCycle1.sold.appointmentTime).toBe(EXPECT_SOLD.appointmentTime);
    expect(afterCycle2.sold.appointmentDate).toBe(EXPECT_SOLD.appointmentDate);
    expect(afterCycle2.sold.appointmentTime).toBe(EXPECT_SOLD.appointmentTime);
  });
});
