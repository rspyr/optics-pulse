import { describe, it, expect } from "vitest";
import { hashValue, normalizePhone } from "../lib/phone-utils";
import { normalizeAddress } from "./reconciliation";

describe("hashValue", () => {
  it("returns a sha256 hex digest", () => {
    const result = hashValue("test@example.com");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("trims and lowercases before hashing", () => {
    expect(hashValue("  Test@Example.COM  ")).toBe(hashValue("test@example.com"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashValue("alice@test.com")).not.toBe(hashValue("bob@test.com"));
  });

  it("is deterministic", () => {
    const a = hashValue("hello");
    const b = hashValue("hello");
    expect(a).toBe(b);
  });
});

describe("normalizePhone", () => {
  it("strips spaces, dashes, parens, and plus signs", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("5551234567");
  });

  it("removes leading country code 1", () => {
    expect(normalizePhone("15551234567")).toBe("5551234567");
  });

  it("handles already-clean numbers", () => {
    expect(normalizePhone("5551234567")).toBe("5551234567");
  });

  it("handles phone with only dashes", () => {
    expect(normalizePhone("555-123-4567")).toBe("5551234567");
  });

  it("handles international format with plus", () => {
    expect(normalizePhone("+15551234567")).toBe("5551234567");
  });

  it("preserves non-US numbers without leading 1", () => {
    expect(normalizePhone("4401234567")).toBe("4401234567");
  });
});

describe("normalizeAddress", () => {
  it("lowercases the address", () => {
    expect(normalizeAddress("123 MAIN ST")).toBe("123 main st");
  });

  it("replaces 'street' with 'st'", () => {
    expect(normalizeAddress("123 Main Street")).toBe("123 main st");
  });

  it("replaces 'avenue' with 'ave'", () => {
    expect(normalizeAddress("456 Oak Avenue")).toBe("456 oak ave");
  });

  it("replaces 'drive' with 'dr'", () => {
    expect(normalizeAddress("789 Pine Drive")).toBe("789 pine dr");
  });

  it("replaces 'road' with 'rd'", () => {
    expect(normalizeAddress("100 Cedar Road")).toBe("100 cedar rd");
  });

  it("replaces 'boulevard' with 'blvd'", () => {
    expect(normalizeAddress("200 Sunset Boulevard")).toBe("200 sunset blvd");
  });

  it("replaces 'lane' with 'ln'", () => {
    expect(normalizeAddress("300 Elm Lane")).toBe("300 elm ln");
  });

  it("replaces 'court' with 'ct'", () => {
    expect(normalizeAddress("400 Rose Court")).toBe("400 rose ct");
  });

  it("replaces 'apartment' with 'apt'", () => {
    expect(normalizeAddress("500 Maple Street Apartment 3")).toBe("500 maple st apt 3");
  });

  it("replaces 'suite' with 'ste'", () => {
    expect(normalizeAddress("600 Oak Avenue Suite 100")).toBe("600 oak ave ste 100");
  });

  it("removes periods, commas, and hash signs", () => {
    expect(normalizeAddress("123 Main St., #4")).toBe("123 main st 4");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeAddress("123   Main    Street")).toBe("123 main st");
  });

  it("trims whitespace", () => {
    expect(normalizeAddress("  123 Main Street  ")).toBe("123 main st");
  });

  it("normalizes a complex address to match", () => {
    const a = normalizeAddress("123 Main Street, Apartment 4B");
    const b = normalizeAddress("123 main st apt 4b");
    expect(a).toBe(b);
  });
});
