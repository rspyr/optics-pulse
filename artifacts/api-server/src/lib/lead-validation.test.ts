import { describe, expect, it } from "vitest";
import { getLeadSpamReason, isValidName, isValidPhone } from "./lead-validation";

describe("lead validation spam filter", () => {
  it("blocks unknown leads without a valid phone number", () => {
    expect(getLeadSpamReason({ firstName: "Unknown", lastName: "", phone: "" })).toContain("Unknown");
    expect(getLeadSpamReason({ firstName: "Unknown", lastName: "", phone: "—" })).toContain("Unknown");
  });

  it("blocks known junk names", () => {
    expect(getLeadSpamReason({ firstName: "John", lastName: "Doe", phone: "5099016237" })).toContain("john doe");
    expect(getLeadSpamReason({ firstName: "fsgsfd", lastName: "gfds", phone: "7342342366" })).toContain("fsgsfd gfds");
  });

  it("keeps realistic first and last names with valid North American phones", () => {
    expect(isValidName("Katie Gentry")).toBe(true);
    expect(isValidPhone("5099704871")).toBe(true);
    expect(getLeadSpamReason({ firstName: "Katie", lastName: "Gentry", phone: "5099704871" })).toBeNull();
  });
});
