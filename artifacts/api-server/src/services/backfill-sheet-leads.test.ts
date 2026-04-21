import { describe, it, expect, vi, beforeEach } from "vitest";

interface ThenableIterable extends Record<string, unknown> {
  then: (resolve: Function, reject?: Function) => Promise<unknown>;
  [Symbol.iterator]: () => Generator<unknown>;
}

function makeThenable(result: unknown[]): ThenableIterable {
  return {
    then: (resolve: Function, reject?: Function) =>
      Promise.resolve(result).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
    [Symbol.iterator]: function* () { yield* result; },
  };
}

const mockDb = {
  insertCalls: [] as Array<{ table: unknown; values: unknown }>,
  selectResults: [] as unknown[][],
  insertResults: [] as unknown[][],
  _selectIdx: 0,
  _insertIdx: 0,
  reset() {
    this._selectIdx = 0;
    this._insertIdx = 0;
    this.insertCalls = [];
  },
};

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const thenResult = () => makeThenable(results());
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(thenResult());
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  return chain;
}

function makeInsertChain(results: () => unknown[], onValues?: (v: unknown) => void) {
  return {
    values: vi.fn().mockImplementation((vals: unknown) => {
      onValues?.(vals);
      return {
        returning: vi.fn().mockResolvedValue(results()),
        then: (resolve: Function, reject?: Function) =>
          Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
      };
    }),
  };
}

vi.mock("@workspace/db", () => {
  const dbObj: Record<string, unknown> = {
    select: vi.fn().mockImplementation(() => {
      const idx = mockDb._selectIdx++;
      return makeSelectChain(() => mockDb.selectResults[idx] || []);
    }),
    insert: vi.fn().mockImplementation((...args: unknown[]) => {
      const idx = mockDb._insertIdx++;
      return makeInsertChain(
        () => mockDb.insertResults[idx] || [],
        (vals) => mockDb.insertCalls.push({ table: args[0], values: vals }),
      );
    }),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
    transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb(dbObj)),
  };
  return {
    db: dbObj,
  leadsTable: Symbol("leadsTable"),
  attributionEventsTable: Symbol("attributionEventsTable"),
  tenantsTable: Symbol("tenantsTable"),
  funnelTypesTable: Symbol("funnelTypesTable"),
  callAttemptsTable: Symbol("callAttemptsTable"),
  };
});

vi.mock("./integrations/google-sheets", () => ({
  readRawSheetData: vi.fn().mockResolvedValue({ headers: [], rawRows: [] }),
}));

vi.mock("./source-normalizer", () => ({
  normalizeSource: vi.fn().mockImplementation((_t: number, s: string) => Promise.resolve(s || "Unknown")),
}));

vi.mock("./round-robin", () => ({
  assignLeadRoundRobin: vi.fn().mockResolvedValue({ assignedCsrId: null, csrName: null, reason: "no CSRs" }),
}));

vi.mock("./auto-pass-scheduler", () => ({
  scheduleAutoPass: vi.fn(),
}));

vi.mock("../socket", () => ({
  emitNewLead: vi.fn(),
}));

vi.mock("../utils/appointment-validation", () => ({
  isValidAppointmentValue: vi.fn().mockReturnValue(false),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
}));

import { backfillSheetLeads, parseSheetDate } from "./backfill-sheet-leads";

const VANCE_HEADERS = ["Submitted At", "First Name", "Last Name", "Phone", "Email", "Service"];

const VANCE_FIXTURE: string[][] = [
  // 7 in-window leads (4/14 - 4/19), one duplicate, one out-of-range, one missing identity
  ["4/14/2026 9:32:00 AM", "Alice", "Anderson", "5551110001", "alice@example.com", "AC Repair"],
  ["4/14/2026 11:05:00 AM", "Bob", "Brown", "5551110002", "bob@example.com", "Heat Pump"],
  ["4/15/2026 8:01:00 AM", "Carol", "Chen", "5551110003", "carol@example.com", "Furnace"],
  ["4/16/2026 4:44:00 PM", "Derek", "Davis", "5551110004", "derek@example.com", "Mini Split"],
  ["4/17/2026 2:11:00 PM", "Eve", "Evans", "5551110005", "eve@example.com", "AC Repair"],
  ["4/18/2026 10:55:00 AM", "Frank", "Foster", "5551110006", "frank@example.com", "Maintenance"],
  ["4/19/2026 6:18:00 PM", "Grace", "Garcia", "5551110007", "grace@example.com", "Full System"],
  // Out-of-range (4/20)
  ["4/20/2026 9:00:00 AM", "Out", "Range", "5551110008", "out@example.com", "AC Repair"],
  // Out-of-range (4/13)
  ["4/13/2026 9:00:00 AM", "Old", "Lead", "5551110009", "old@example.com", "AC Repair"],
  // Missing identity
  ["4/15/2026 9:00:00 AM", "", "", "", "", ""],
];

describe("parseSheetDate", () => {
  it("parses US datetime with AM/PM", () => {
    const d = parseSheetDate("4/15/2026 9:32:11 AM");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(3); // April
    expect(d!.getDate()).toBe(15);
    expect(d!.getHours()).toBe(9);
  });

  it("parses ISO datetime", () => {
    const d = parseSheetDate("2026-04-15T13:30:00");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
  });

  it("converts 12 PM correctly", () => {
    const d = parseSheetDate("4/15/2026 12:00:00 PM");
    expect(d!.getHours()).toBe(12);
  });

  it("converts 12 AM correctly", () => {
    const d = parseSheetDate("4/15/2026 12:00:00 AM");
    expect(d!.getHours()).toBe(0);
  });

  it("returns null for empty/invalid", () => {
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate("not a date")).toBeNull();
  });
});

describe("backfillSheetLeads (Vance fixture)", () => {
  beforeEach(() => {
    mockDb.selectResults = [];
    mockDb.insertResults = [];
    mockDb.reset();
  });

  function setupInsertResults(count: number) {
    mockDb.insertResults = [];
    for (let i = 0; i < count; i++) {
      mockDb.insertResults.push([{ id: 100 + i, tenantId: 3 }]); // lead insert
      mockDb.insertResults.push([{ id: 200 + i, tenantId: 3 }]); // attribution event insert
    }
  }

  it("inserts exactly 7 in-window leads from the Vance fixture", async () => {
    mockDb.selectResults = [[]]; // no existing leads
    setupInsertResults(7);

    const res = await backfillSheetLeads({
      tenantId: 3,
      preloaded: { headers: VANCE_HEADERS, rawRows: VANCE_FIXTURE },
      dateColumn: "Submitted At",
      dateFrom: new Date(2026, 3, 14, 0, 0, 0),
      dateTo: new Date(2026, 3, 19, 23, 59, 59),
      columnMapping: {
        "First Name": "firstName",
        "Last Name": "lastName",
        Phone: "phone",
        Email: "email",
        Service: "serviceType",
      },
      resolvedSource: "Meta",
      utmDefaults: { utmSource: "meta", utmMedium: "cpc", utmCampaign: "spring-2026" },
      skipAssignment: true,
    });

    expect(res.candidates).toBe(8); // 7 real + 1 empty-identity (all in window)
    expect(res.inserted).toBe(7);
    expect(res.skippedDuplicate).toBe(0);
    expect(res.skippedOutOfRange).toBe(2); // 4/20 + 4/13
    expect(res.skippedNoIdentity).toBe(1); // empty-identity in-window row
    expect(res.insertedLeadIds).toHaveLength(7);
  });

  it("preserves Meta UTM and original timestamp on each attribution event", async () => {
    mockDb.selectResults = [[]];
    setupInsertResults(7);

    await backfillSheetLeads({
      tenantId: 3,
      preloaded: { headers: VANCE_HEADERS, rawRows: VANCE_FIXTURE },
      dateColumn: "Submitted At",
      dateFrom: new Date(2026, 3, 14, 0, 0, 0),
      dateTo: new Date(2026, 3, 19, 23, 59, 59),
      columnMapping: {
        "First Name": "firstName",
        "Last Name": "lastName",
        Phone: "phone",
        Email: "email",
      },
      resolvedSource: "Meta",
      utmDefaults: { utmSource: "meta", utmMedium: "cpc", utmCampaign: "spring-2026" },
      skipAssignment: true,
    });

    // Insert pattern: lead, event, lead, event...
    const leadInsert = mockDb.insertCalls[0].values as Record<string, unknown>;
    const eventInsert = mockDb.insertCalls[1].values as Record<string, unknown>;

    expect(leadInsert.firstName).toBe("Alice");
    expect(leadInsert.source).toBe("Meta");
    expect(leadInsert.originalSource).toBe("Meta");
    expect(leadInsert.createdAt).toBeInstanceOf(Date);
    expect((leadInsert.createdAt as Date).getDate()).toBe(14);

    expect(eventInsert.utmSource).toBe("meta");
    expect(eventInsert.utmCampaign).toBe("spring-2026");
    expect(eventInsert.utmMedium).toBe("cpc");
    expect(eventInsert.matchLevel).toBe("golden"); // has phone
    expect(eventInsert.formType).toBe("sheet-backfill");
    expect(eventInsert.createdLeadId).toBe(100);
    expect(eventInsert.submittedAt).toBeInstanceOf(Date);
  });

  it("skips duplicates by email when phone differs", async () => {
    // Pre-existing lead with Bob's email but different phone
    mockDb.selectResults = [[{ phone: "9999999999", email: "BOB@EXAMPLE.COM" }]];
    setupInsertResults(6);

    const res = await backfillSheetLeads({
      tenantId: 3,
      preloaded: { headers: VANCE_HEADERS, rawRows: VANCE_FIXTURE },
      dateColumn: "Submitted At",
      dateFrom: new Date(2026, 3, 14, 0, 0, 0),
      dateTo: new Date(2026, 3, 19, 23, 59, 59),
      columnMapping: {
        "First Name": "firstName",
        "Last Name": "lastName",
        Phone: "phone",
        Email: "email",
      },
      resolvedSource: "Meta",
      skipAssignment: true,
    });

    expect(res.inserted).toBe(6);
    expect(res.skippedDuplicate).toBe(1);
  });

  it("preserves updatedAt and assignedAt to match the sheet timestamp", async () => {
    mockDb.selectResults = [[]];
    setupInsertResults(7);

    await backfillSheetLeads({
      tenantId: 3,
      preloaded: { headers: VANCE_HEADERS, rawRows: VANCE_FIXTURE },
      dateColumn: "Submitted At",
      dateFrom: new Date(2026, 3, 14, 0, 0, 0),
      dateTo: new Date(2026, 3, 19, 23, 59, 59),
      columnMapping: {
        "First Name": "firstName",
        "Last Name": "lastName",
        Phone: "phone",
        Email: "email",
      },
      resolvedSource: "Meta",
      skipAssignment: true,
    });

    const leadInsert = mockDb.insertCalls[0].values as Record<string, unknown>;
    const created = leadInsert.createdAt as Date;
    expect(leadInsert.updatedAt).toEqual(created);
    expect(leadInsert.assignedAt).toEqual(created);
  });

  it("skips duplicates by phone", async () => {
    // Pre-populate with Alice's phone digits
    mockDb.selectResults = [[{ phone: "555-111-0001", email: null }]];
    setupInsertResults(6);

    const res = await backfillSheetLeads({
      tenantId: 3,
      preloaded: { headers: VANCE_HEADERS, rawRows: VANCE_FIXTURE },
      dateColumn: "Submitted At",
      dateFrom: new Date(2026, 3, 14, 0, 0, 0),
      dateTo: new Date(2026, 3, 19, 23, 59, 59),
      columnMapping: {
        "First Name": "firstName",
        "Last Name": "lastName",
        Phone: "phone",
        Email: "email",
      },
      resolvedSource: "Meta",
      skipAssignment: true,
    });

    expect(res.inserted).toBe(6);
    expect(res.skippedDuplicate).toBe(1);
  });

  it("dry-run reports counts without writing", async () => {
    mockDb.selectResults = [[]];

    const res = await backfillSheetLeads({
      tenantId: 3,
      preloaded: { headers: VANCE_HEADERS, rawRows: VANCE_FIXTURE },
      dateColumn: "Submitted At",
      dateFrom: new Date(2026, 3, 14, 0, 0, 0),
      dateTo: new Date(2026, 3, 19, 23, 59, 59),
      columnMapping: {
        "First Name": "firstName",
        "Last Name": "lastName",
        Phone: "phone",
        Email: "email",
      },
      resolvedSource: "Meta",
      dryRun: true,
      skipAssignment: true,
    });

    expect(res.inserted).toBe(7);
    expect(mockDb.insertCalls.length).toBe(0);
  });
});
