import { describe, it, expect } from "vitest";
import { hashValue, normalizePhone, extractPiiFromFields } from "./tracker";

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
