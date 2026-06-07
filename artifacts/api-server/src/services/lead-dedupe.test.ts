import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  leadsTable: {},
}));

const { buildLeadIdentityKeys, normalizeEmail, normalizeLeadIdentity } = await import("./lead-dedupe");

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
});
