import { describe, it, expect } from "vitest";
import { isLikelyFunnelValue } from "./field-detection";

describe("isLikelyFunnelValue", () => {
  it("flags multi-word product/service strings as funnel-like", () => {
    expect(isLikelyFunnelValue("Heat Pump")).toBe(true);
    expect(isLikelyFunnelValue("AC Repair")).toBe(true);
    expect(isLikelyFunnelValue("Furnace Install")).toBe(true);
    expect(isLikelyFunnelValue("Ductless Mini-Split")).toBe(true);
    expect(isLikelyFunnelValue("Full System")).toBe(true);
    expect(isLikelyFunnelValue("Maintenance")).toBe(true);
    expect(isLikelyFunnelValue("Emergency Repair")).toBe(true);
  });

  it("does not flag ordinary person names", () => {
    expect(isLikelyFunnelValue("John Smith")).toBe(false);
    expect(isLikelyFunnelValue("Jane")).toBe(false);
    expect(isLikelyFunnelValue("Mary Jane Watson")).toBe(false);
    expect(isLikelyFunnelValue("Bob Brown")).toBe(false);
  });

  it("handles empty/whitespace input", () => {
    expect(isLikelyFunnelValue("")).toBe(false);
    expect(isLikelyFunnelValue("   ")).toBe(false);
  });
});
