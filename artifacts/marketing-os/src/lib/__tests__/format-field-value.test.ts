import { describe, it, expect } from "vitest";
import { formatFieldValue } from "../format-field-value";

describe("formatFieldValue", () => {
  it("renders a non-empty string as-is", () => {
    expect(formatFieldValue("hello")).toBe("hello");
  });

  it("renders an empty string as the (empty) placeholder", () => {
    expect(formatFieldValue("")).toBe("(empty)");
  });

  it("renders null as the (no value) placeholder", () => {
    expect(formatFieldValue(null)).toBe("(no value)");
  });

  it("renders undefined as the (no value) placeholder", () => {
    expect(formatFieldValue(undefined)).toBe("(no value)");
  });

  it("renders numbers as their string form (including 0)", () => {
    expect(formatFieldValue(0)).toBe("0");
    expect(formatFieldValue(42)).toBe("42");
    expect(formatFieldValue(-1.5)).toBe("-1.5");
  });

  it("renders booleans as their string form (including false)", () => {
    expect(formatFieldValue(true)).toBe("true");
    expect(formatFieldValue(false)).toBe("false");
  });

  it("renders objects as compact JSON", () => {
    expect(formatFieldValue({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  it("renders arrays as compact JSON", () => {
    expect(formatFieldValue(["a", "b"])).toBe('["a","b"]');
  });

  it("renders unserialisable objects as a placeholder rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatFieldValue(cyclic)).toBe("(unserialisable)");
  });
});
