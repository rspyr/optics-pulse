import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  leadsTable: {},
}));

const { buildLeadIdentityKeys, leadMatchesDedupeScope, normalizeEmail, normalizeLeadIdentity } = await import("./lead-dedupe");

describe("lead dedupe identity normalization", () => {
  it("normalizes emails by trimming and lowercasing", () => {
    expect(normalizeEmail("  Customer@Example.COM  ")).toBe("customer@example.com");
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });

  it("normalizes phone and email into one contact identity", () => {
    expect(normalizeLeadIdentity({
      phone: "+1 (555) 123-4567",
      email: "  Mixed@Example.COM ",
    })).toEqual({
      phone: "5551234567",
      email: "mixed@example.com",
    });
  });

  it("builds deterministic identity lock keys", () => {
    expect(buildLeadIdentityKeys({
      phone: "5551234567",
      email: "mixed@example.com",
    })).toEqual([
      "email:mixed@example.com",
      "phone:5551234567",
    ]);
  });

  it("does not dedupe a contact outside the inquiry window", () => {
    expect(leadMatchesDedupeScope({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      funnelId: 10,
      hubStatus: "day_1",
    }, {
      createdAfter: new Date("2026-06-01T00:00:00.000Z"),
      funnelId: 10,
      requireSameFunnelWhenKnown: true,
      skipDeadLeads: true,
    })).toBe(false);
  });

  it("does not dedupe a different known funnel", () => {
    expect(leadMatchesDedupeScope({
      createdAt: new Date("2026-06-07T00:00:00.000Z"),
      funnelId: 10,
      hubStatus: "day_1",
    }, {
      createdAfter: new Date("2026-06-06T00:00:00.000Z"),
      funnelId: 20,
      requireSameFunnelWhenKnown: true,
      skipDeadLeads: true,
    })).toBe(false);
  });

  it("allows dedupe when one side does not have a known funnel", () => {
    expect(leadMatchesDedupeScope({
      createdAt: new Date("2026-06-07T00:00:00.000Z"),
      funnelId: null,
      hubStatus: "day_1",
    }, {
      createdAfter: new Date("2026-06-06T00:00:00.000Z"),
      funnelId: 20,
      requireSameFunnelWhenKnown: true,
      skipDeadLeads: true,
    })).toBe(true);
  });

  it("does not dedupe into a dead lead", () => {
    expect(leadMatchesDedupeScope({
      createdAt: new Date("2026-06-07T00:00:00.000Z"),
      funnelId: 10,
      hubStatus: "dead",
    }, {
      createdAfter: new Date("2026-06-06T00:00:00.000Z"),
      funnelId: 10,
      requireSameFunnelWhenKnown: true,
      skipDeadLeads: true,
    })).toBe(false);
  });
});
