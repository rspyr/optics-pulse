import { describe, it, expect } from "vitest";
import { isPreBookedCellValue } from "./pre-booked-trigger";

describe("isPreBookedCellValue", () => {
  it("returns true for 'yes' (any casing / whitespace)", () => {
    expect(isPreBookedCellValue("yes")).toBe(true);
    expect(isPreBookedCellValue("YES")).toBe(true);
    expect(isPreBookedCellValue(" Yes ")).toBe(true);
  });

  it("returns true for 'booked' (any casing / whitespace)", () => {
    expect(isPreBookedCellValue("booked")).toBe(true);
    expect(isPreBookedCellValue("Booked")).toBe(true);
    expect(isPreBookedCellValue("BOOKED")).toBe(true);
    expect(isPreBookedCellValue(" booked ")).toBe(true);
  });

  it("returns false for other values and blanks", () => {
    expect(isPreBookedCellValue("")).toBe(false);
    expect(isPreBookedCellValue("   ")).toBe(false);
    expect(isPreBookedCellValue(null)).toBe(false);
    expect(isPreBookedCellValue(undefined)).toBe(false);
    expect(isPreBookedCellValue("y")).toBe(false);
    expect(isPreBookedCellValue("true")).toBe(false);
    expect(isPreBookedCellValue("1")).toBe(false);
    expect(isPreBookedCellValue("no")).toBe(false);
    expect(isPreBookedCellValue("book")).toBe(false);
  });
});
