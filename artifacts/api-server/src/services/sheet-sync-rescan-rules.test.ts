/**
 * Pure-function safety net for the rescan WRITE rules in `rescanExistingRows`.
 *
 * The latest-wins picker (`buildLatestRowByPhone`) decides WHICH sheet row a
 * lead is compared against each cycle; `computeRescanUpdates` decides what (if
 * anything) that chosen row is allowed to write back onto the lead. The slow
 * real-Postgres test (`sheet-sync-rescan-oscillation.integration.test.ts`)
 * proves the end-to-end behavior, but it would keep passing if someone quietly
 * loosened one of the guard branches in a way the fixture happened not to trip.
 * This file locks the decision branches themselves, with no database:
 *
 *   - "locked appointment" guard: a CSR-confirmed (`appt_set`) lead and a sold
 *     lead (`hasSoldEstimate`) must NEVER have their appointment date/time/booked
 *     flag overwritten, even by a later row carrying a different date.
 *   - write-only-on-real-change: a row that already matches the stored lead
 *     produces an empty update (a true no-op — no churn).
 *   - dead-lead guard: a dead lead is never promoted back to `appt_booked`.
 *
 * @workspace/db is mocked so this stays a pure unit test (no Postgres); the real
 * appointment/pre-booked validators are used on purpose — they are part of the
 * write-rule contract under test.
 */
import { describe, it, expect, vi } from "vitest";

// Only the DB needs stubbing; a Proxy hands back a unique symbol for every table
// import so we never have to enumerate them.
vi.mock("@workspace/db", () => {
  const tableCache = new Map<string, symbol>();
  const stub = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "db") return {};
        if (prop === "__esModule") return true;
        if (!tableCache.has(prop)) tableCache.set(prop, Symbol(prop));
        return tableCache.get(prop);
      },
    },
  );
  return stub as Record<string, unknown>;
});

const { computeRescanUpdates } = await import("./sheet-sync");
type RescanLeadState = Parameters<typeof computeRescanUpdates>[0];
type Row = Parameters<typeof computeRescanUpdates>[1];

function mkRow(fields: Partial<Row> = {}): Row {
  return {
    firstName: "",
    lastName: "",
    phone: "5550000000",
    email: "",
    source: "",
    serviceType: "",
    dateTime: "",
    appointmentDate: "",
    appointmentTime: "",
    ...fields,
  } as Row;
}

function mkLead(fields: Partial<RescanLeadState> = {}): RescanLeadState {
  return {
    appointmentDate: null,
    appointmentTime: null,
    appointmentBooked: null,
    addOns: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    hubStatus: "day_1",
    hasSoldEstimate: null,
    ...fields,
  };
}

describe("computeRescanUpdates — locked-appointment guard", () => {
  it("never overwrites an appt_set lead's appointment, even with a later differing date", () => {
    const lead = mkLead({
      hubStatus: "appt_set",
      appointmentDate: "2026-05-05",
      appointmentTime: "08:00",
      appointmentBooked: true,
    });
    const row = mkRow({ appointmentDate: "2026-09-09", appointmentTime: "14:00" });

    const updates = computeRescanUpdates(lead, row);

    expect(updates.appointmentDate).toBeUndefined();
    expect(updates.appointmentTime).toBeUndefined();
    expect(updates.preBooked).toBeUndefined();
    expect(updates.hubStatus).toBeUndefined();
  });

  it("never overwrites a sold lead's appointment, even with a later differing date", () => {
    const lead = mkLead({
      hubStatus: "appt_booked",
      hasSoldEstimate: true,
      appointmentDate: "2026-04-04",
      appointmentTime: "07:00",
      appointmentBooked: true,
    });
    const row = mkRow({ appointmentDate: "2026-12-12", appointmentTime: "16:00" });

    const updates = computeRescanUpdates(lead, row);

    expect(updates.appointmentDate).toBeUndefined();
    expect(updates.appointmentTime).toBeUndefined();
    expect(updates.preBooked).toBeUndefined();
    expect(updates.hubStatus).toBeUndefined();
  });

  it("a sold lead that is not yet pre-booked is still not promoted by a sheet appointment", () => {
    const lead = mkLead({ hasSoldEstimate: true, appointmentBooked: null });
    const row = mkRow({ appointmentDate: "2026-12-12", appointmentTime: "16:00" });

    const updates = computeRescanUpdates(lead, row);

    expect(updates).toEqual({});
  });

  it("still updates NON-appointment fields (address) on a locked lead", () => {
    const lead = mkLead({
      hubStatus: "appt_set",
      appointmentDate: "2026-05-05",
      address: "old st",
    });
    const row = mkRow({ appointmentDate: "2026-09-09", address: "new ave" });

    const updates = computeRescanUpdates(lead, row);

    // Appointment is protected...
    expect(updates.appointmentDate).toBeUndefined();
    // ...but the address still flows through.
    expect(updates.address).toBe("new ave");
  });
});

describe("computeRescanUpdates — write-only-on-real-change (no churn)", () => {
  it("returns an empty update when the chosen row already matches the lead", () => {
    const lead = mkLead({
      appointmentDate: "2026-06-15",
      appointmentTime: "10:00",
      appointmentBooked: true,
      address: "1 main",
      city: "town",
      state: "CA",
      zip: "90000",
    });
    const row = mkRow({
      appointmentDate: "2026-06-15",
      appointmentTime: "10:00",
      address: "1 main",
      city: "town",
      state: "CA",
      zip: "90000",
    });

    expect(computeRescanUpdates(lead, row)).toEqual({});
  });

  it("an empty row never clears existing lead values", () => {
    const lead = mkLead({
      appointmentDate: "2026-06-15",
      appointmentTime: "10:00",
      appointmentBooked: true,
    });
    const row = mkRow({ appointmentDate: "", appointmentTime: "" });

    expect(computeRescanUpdates(lead, row)).toEqual({});
  });

  it("writes only the field that actually changed", () => {
    const lead = mkLead({
      appointmentDate: "2026-06-15",
      appointmentTime: "10:00",
      appointmentBooked: true,
    });
    const row = mkRow({ appointmentDate: "2026-06-20", appointmentTime: "10:00" });

    const updates = computeRescanUpdates(lead, row);

    expect(updates.appointmentDate).toBe("2026-06-20");
    expect(updates.appointmentTime).toBeUndefined();
  });
});

describe("computeRescanUpdates — first-time booking promotion", () => {
  it("promotes an un-booked, unlocked lead to appt_booked and marks it pre-booked", () => {
    const lead = mkLead({ hubStatus: "day_1", appointmentBooked: null });
    const row = mkRow({ appointmentDate: "2026-06-15", appointmentTime: "10:00" });

    const updates = computeRescanUpdates(lead, row);

    expect(updates.appointmentDate).toBe("2026-06-15");
    expect(updates.appointmentTime).toBe("10:00");
    expect(updates.preBooked).toBe(true);
    expect(updates.hubStatus).toBe("appt_booked");
    expect(updates.visibleAfter).toBeNull();
  });

  it("does not re-flag a lead that is already pre-booked", () => {
    const lead = mkLead({ hubStatus: "appt_booked", appointmentBooked: true, appointmentDate: "2026-06-01" });
    const row = mkRow({ appointmentDate: "2026-06-15", appointmentTime: "10:00" });

    const updates = computeRescanUpdates(lead, row);

    // The new date still flows (unlocked), but no re-promotion churn.
    expect(updates.appointmentDate).toBe("2026-06-15");
    expect(updates.preBooked).toBeUndefined();
    expect(updates.hubStatus).toBeUndefined();
    expect(updates.visibleAfter).toBeUndefined();
  });
});

describe("computeRescanUpdates — dead-lead guard", () => {
  it("never promotes a dead lead back to appt_booked", () => {
    const lead = mkLead({ hubStatus: "dead", appointmentBooked: null });
    const row = mkRow({ appointmentDate: "2026-06-15", appointmentTime: "10:00" });

    const updates = computeRescanUpdates(lead, row);

    // The appointment fields still update (the lead is not appt-locked)...
    expect(updates.appointmentDate).toBe("2026-06-15");
    expect(updates.preBooked).toBe(true);
    // ...but the status must NOT be resurrected to appt_booked.
    expect(updates.hubStatus).toBeUndefined();
  });
});
