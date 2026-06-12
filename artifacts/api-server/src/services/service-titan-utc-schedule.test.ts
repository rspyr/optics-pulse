import { describe, expect, it } from "vitest";
import {
  buildScheduledServiceTitanMetadata,
  getNextServiceTitanScheduledAt,
  getServiceTitanUtcScheduleLabels,
  getUtcMinuteSlot,
  normalizeServiceTitanUtcMinuteOffset,
  serviceTitanOffsetDueAt,
} from "./service-titan-utc-schedule";

describe("ServiceTitan UTC schedule helpers", () => {
  it("formats the default published quarter-hour jobs and revenue schedules", () => {
    expect(getServiceTitanUtcScheduleLabels(0)).toEqual([":00", ":15", ":30", ":45"]);
    expect(getServiceTitanUtcScheduleLabels(5)).toEqual([":05", ":20", ":35", ":50"]);
  });

  it("uses UTC minute math for next scheduled time", () => {
    const from = new Date("2026-06-12T14:04:59.900Z");
    expect(getNextServiceTitanScheduledAt(5, from).toISOString()).toBe("2026-06-12T14:05:00.000Z");
    expect(getNextServiceTitanScheduledAt(0, from).toISOString()).toBe("2026-06-12T14:15:00.000Z");
  });

  it("normalizes invalid offsets to the provided fallback", () => {
    expect(normalizeServiceTitanUtcMinuteOffset(14, 0)).toBe(14);
    expect(normalizeServiceTitanUtcMinuteOffset(15, 5)).toBe(5);
    expect(normalizeServiceTitanUtcMinuteOffset(-1, 5)).toBe(5);
    expect(normalizeServiceTitanUtcMinuteOffset("5", 0)).toBe(0);
  });

  it("matches due slots by UTC minute modulo 15", () => {
    const slot = new Date("2026-06-12T23:50:00.000Z");
    expect(serviceTitanOffsetDueAt(5, slot)).toBe(true);
    expect(serviceTitanOffsetDueAt(0, slot)).toBe(false);
  });

  it("rounds scheduled slots down to the current UTC minute", () => {
    expect(getUtcMinuteSlot(new Date("2026-06-12T23:50:42.123Z")).toISOString())
      .toBe("2026-06-12T23:50:00.000Z");
  });

  it("stamps scheduler metadata for audit rows", () => {
    const scheduledForUtc = new Date("2026-06-12T14:05:00.000Z");
    expect(buildScheduledServiceTitanMetadata("revenue", scheduledForUtc, 5, { tenantName: "Acme" }))
      .toMatchObject({
        scheduler: "service-titan-utc-v1",
        scheduleType: "revenue",
        intervalMinutes: 15,
        utcMinuteOffset: 5,
        scheduledForUtc: "2026-06-12T14:05:00.000Z",
        tenantName: "Acme",
      });
  });
});
