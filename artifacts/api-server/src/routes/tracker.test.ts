import { describe, it, expect } from "vitest";
import { hashValue, normalizePhone } from "../lib/phone-utils";
import {
  extractPiiFromFields,
  extractFieldNamesForOperator,
  computeUnmatchedReason,
  FIELD_NAMES_CAP,
} from "./tracker";

describe("tracker hashValue", () => {
  it("returns a sha256 hex digest", () => {
    const result = hashValue("test@example.com");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("trims and lowercases before hashing", () => {
    expect(hashValue("  Test@Example.COM  ")).toBe(hashValue("test@example.com"));
  });
});

describe("tracker normalizePhone", () => {
  it("strips formatting characters", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("5551234567");
  });

  it("removes leading country code 1", () => {
    expect(normalizePhone("15551234567")).toBe("5551234567");
  });
});

describe("extractPiiFromFields", () => {
  it("extracts first_name and last_name", () => {
    const result = extractPiiFromFields({
      first_name: "John",
      last_name: "Doe",
    });
    expect(result.firstName).toBe("John");
    expect(result.lastName).toBe("Doe");
  });

  it("extracts email", () => {
    const result = extractPiiFromFields({
      email: "john@example.com",
    });
    expect(result.email).toBe("john@example.com");
  });

  it("extracts phone", () => {
    const result = extractPiiFromFields({
      phone: "555-123-4567",
    });
    expect(result.phone).toBe("555-123-4567");
  });

  it("handles alternative field names (firstname, fname)", () => {
    expect(extractPiiFromFields({ firstname: "Alice" }).firstName).toBe("Alice");
    expect(extractPiiFromFields({ fname: "Bob" }).firstName).toBe("Bob");
  });

  it("handles alternative email field names", () => {
    expect(extractPiiFromFields({ email_address: "a@b.com" }).email).toBe("a@b.com");
    expect(extractPiiFromFields({ emailaddress: "c@d.com" }).email).toBe("c@d.com");
  });

  it("handles alternative phone field names", () => {
    expect(extractPiiFromFields({ telephone: "1234567890" }).phone).toBe("1234567890");
    expect(extractPiiFromFields({ tel: "0987654321" }).phone).toBe("0987654321");
    expect(extractPiiFromFields({ mobile: "5551112222" }).phone).toBe("5551112222");
  });

  it("extracts first and last name from full_name", () => {
    const result = extractPiiFromFields({
      full_name: "John Doe",
    });
    expect(result.firstName).toBe("John");
    expect(result.lastName).toBe("Doe");
  });

  it("extracts from 'name' field as fallback for full name", () => {
    const result = extractPiiFromFields({
      name: "Jane Smith",
    });
    expect(result.firstName).toBe("Jane");
    expect(result.lastName).toBe("Smith");
  });

  it("handles full name with multiple last name parts", () => {
    const result = extractPiiFromFields({
      name: "John Van Der Berg",
    });
    expect(result.firstName).toBe("John");
    expect(result.lastName).toBe("Van Der Berg");
  });

  it("prefers explicit first_name over full_name", () => {
    const result = extractPiiFromFields({
      first_name: "Explicit",
      name: "FromName LastName",
    });
    expect(result.firstName).toBe("Explicit");
  });

  it("returns null for all fields when no PII present", () => {
    const result = extractPiiFromFields({
      some_random_field: "value",
      another: "field",
    });
    expect(result.firstName).toBeNull();
    expect(result.lastName).toBeNull();
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
  });

  it("ignores non-string values", () => {
    const result = extractPiiFromFields({
      first_name: 12345,
      email: null,
      phone: undefined,
    });
    expect(result.firstName).toBeNull();
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
  });

  it("ignores empty string values", () => {
    const result = extractPiiFromFields({
      first_name: "",
      email: "   ",
    });
    expect(result.firstName).toBeNull();
    expect(result.email).toBeNull();
  });

  it("handles case-insensitive field names", () => {
    const result = extractPiiFromFields({
      First_Name: "Alice",
      EMAIL: "alice@test.com",
    });
    expect(result.firstName).toBe("Alice");
    expect(result.email).toBe("alice@test.com");
  });

  it("handles hyphenated field names", () => {
    const result = extractPiiFromFields({
      "first-name": "Bob",
      "last-name": "Jones",
    });
    expect(result.firstName).toBe("Bob");
    expect(result.lastName).toBe("Jones");
  });
});

// These helpers are shared by /collect/submit (live socket emit) and the
// /attribution/events/:id detail endpoint (Task #258 — backfill mapping
// rules from any past unmatched fill). Both surfaces must derive the
// field name list and unmatched reason identically.
describe("extractFieldNamesForOperator", () => {
  it("returns insertion-ordered keys", () => {
    expect(extractFieldNamesForOperator({ b: 1, a: 2, c: 3 })).toEqual(["b", "a", "c"]);
  });

  it("excludes underscore-prefixed internal keys (e.g. _custom)", () => {
    expect(extractFieldNamesForOperator({ phone: "x", _custom: { funnel: "y" }, _internal: 1 }))
      .toEqual(["phone"]);
  });

  it("caps at 30 keys", () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 50; i++) fields[`f${i}`] = "v";
    const out = extractFieldNamesForOperator(fields);
    expect(out.length).toBe(FIELD_NAMES_CAP);
    expect(FIELD_NAMES_CAP).toBe(30);
  });

  it("returns [] for null/undefined input", () => {
    expect(extractFieldNamesForOperator(null)).toEqual([]);
    expect(extractFieldNamesForOperator(undefined)).toEqual([]);
  });
});

describe("computeUnmatchedReason", () => {
  it("returns null on matched events (matchLevel !== unmatched)", () => {
    expect(computeUnmatchedReason({
      matchLevel: "diamond", hasAnyClickId: true, hasPhoneSignal: false, hasEmailSignal: false,
    })).toBeNull();
    expect(computeUnmatchedReason({
      matchLevel: "golden", hasAnyClickId: false, hasPhoneSignal: true, hasEmailSignal: false,
    })).toBeNull();
  });

  it("flags 'no signals at all' when nothing was captured", () => {
    expect(computeUnmatchedReason({
      matchLevel: "unmatched", hasAnyClickId: false, hasPhoneSignal: false, hasEmailSignal: false,
    })).toBe("No phone or email field detected and no click ID present.");
  });

  it("flags 'click id but no PII' when only a click ID came in", () => {
    expect(computeUnmatchedReason({
      matchLevel: "unmatched", hasAnyClickId: true, hasPhoneSignal: false, hasEmailSignal: false,
    })).toBe("Click ID present but no phone or email field detected.");
  });

  it("flags 'PII but no hash produced' when phone/email were captured but matcher failed", () => {
    expect(computeUnmatchedReason({
      matchLevel: "unmatched", hasAnyClickId: false, hasPhoneSignal: true, hasEmailSignal: false,
    })).toBe("Phone or email captured but the matcher did not produce a hashed value.");
  });

  it("falls back to a generic message when both click ID and PII are present", () => {
    expect(computeUnmatchedReason({
      matchLevel: "unmatched", hasAnyClickId: true, hasPhoneSignal: true, hasEmailSignal: true,
    })).toBe("Pulse could not link this fill to a known job, lead, or click.");
  });
});

// Parity guard for Task #258: the /attribution/events/:id detail endpoint
// must produce the *same* unmatchedReason string as the live socket emit
// from /collect/submit. The risky case is "operator captured phone/email
// but the matcher produced no hash" — live reads `!!pii.phone`, so the
// detail endpoint must NOT rely on `event.hashedPhone` alone (which would
// silently degrade to "no signals at all"). The detail endpoint re-runs
// extractPiiFromFields on the stored formFields to recover this signal.
describe("attribution detail / live emit parity for unmatchedReason", () => {
  it("PII captured but hash missing → both surfaces report the same reason", () => {
    // Live flow: pii.phone is "5551234567", hashing failed → event.hashedPhone null.
    const liveReason = computeUnmatchedReason({
      matchLevel: "unmatched",
      hasAnyClickId: false,
      hasPhoneSignal: true,
      hasEmailSignal: false,
    });

    // Detail flow on the same event: re-derive PII from stored fields,
    // then OR with hashed columns (both null here).
    const storedFormFields = { phone: "555-123-4567", first_name: "Jane" };
    const replayedPii = extractPiiFromFields(storedFormFields);
    const hashedPhoneOnRow: string | null = null;
    const hashedEmailOnRow: string | null = null;
    const detailReason = computeUnmatchedReason({
      matchLevel: "unmatched",
      hasAnyClickId: false,
      hasPhoneSignal: !!replayedPii.phone || !!hashedPhoneOnRow,
      hasEmailSignal: !!replayedPii.email || !!hashedEmailOnRow,
    });

    expect(detailReason).toBe(liveReason);
    expect(detailReason).toBe("Phone or email captured but the matcher did not produce a hashed value.");
  });

  it("regression: relying on hashed columns alone would misreport this case", () => {
    const storedFormFields = { phone: "555-123-4567" };
    const hashedPhoneOnRow: string | null = null;
    const hashedEmailOnRow: string | null = null;

    const wrongReason = computeUnmatchedReason({
      matchLevel: "unmatched",
      hasAnyClickId: false,
      hasPhoneSignal: !!hashedPhoneOnRow,
      hasEmailSignal: !!hashedEmailOnRow,
    });
    expect(wrongReason).toBe("No phone or email field detected and no click ID present.");

    const replayedPii = extractPiiFromFields(storedFormFields);
    const correctReason = computeUnmatchedReason({
      matchLevel: "unmatched",
      hasAnyClickId: false,
      hasPhoneSignal: !!replayedPii.phone || !!hashedPhoneOnRow,
      hasEmailSignal: !!replayedPii.email || !!hashedEmailOnRow,
    });
    expect(correctReason).not.toBe(wrongReason);
    expect(correctReason).toBe("Phone or email captured but the matcher did not produce a hashed value.");
  });

  it("when stored fields contain no PII and hashes are null, both surfaces report 'no signals at all'", () => {
    const storedFormFields = { custom_q1: "abc", custom_q2: "xyz" };
    const replayedPii = extractPiiFromFields(storedFormFields);
    const hashedPhoneOnRow: string | null = null;
    const hashedEmailOnRow: string | null = null;
    const reason = computeUnmatchedReason({
      matchLevel: "unmatched",
      hasAnyClickId: false,
      hasPhoneSignal: !!replayedPii.phone || !!hashedPhoneOnRow,
      hasEmailSignal: !!replayedPii.email || !!hashedEmailOnRow,
    });
    expect(reason).toBe("No phone or email field detected and no click ID present.");
  });
});
