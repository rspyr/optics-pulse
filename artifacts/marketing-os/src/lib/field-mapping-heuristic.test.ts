import { describe, expect, it } from "vitest";
import { normalizeFieldName, suggestMapTarget, type MapToTarget } from "./field-mapping-heuristic";

describe("suggestMapTarget", () => {
  describe("positive matches", () => {
    it.each([
      ["phone_number", "phone"],
      ["Phone", "phone"],
      ["mobile_phone", "phone"],
      ["tel", "phone"],
      ["telephone", "phone"],
      ["contact_tel", "phone"],

      ["email", "email"],
      ["email_address", "email"],
      ["EmailAddress", "email"],
      ["user_mail", "email"],

      ["zip", "zip"],
      ["zip_code", "zip"],
      ["postal_code", "zip"],
      ["PostalCode", "zip"],

      ["first_name", "firstName"],
      ["FirstName", "firstName"],
      ["fname", "firstName"],
      ["firstname", "firstName"],

      ["last_name", "lastName"],
      ["LastName", "lastName"],
      ["lname", "lastName"],
      ["surname", "lastName"],

      ["full_name", "fullName"],
      ["fullname", "fullName"],
      ["FullName", "fullName"],

      ["address", "address"],
      ["street_address", "address"],
      ["street", "address"],
      ["address_line_1", "address"],

      ["city", "city"],
      ["City", "city"],
      ["billing_city", "city"],

      ["state", "state"],
      ["State", "state"],
      ["province", "state"],

      ["appt_date", "appointmentDate"],
      ["appointment_date", "appointmentDate"],
      ["AppointmentDate", "appointmentDate"],
      ["booking_date", "appointmentDate"],
      ["apptDate", "appointmentDate"],

      ["appt_time", "appointmentTime"],
      ["appointment_time", "appointmentTime"],
      ["AppointmentTime", "appointmentTime"],
      ["booking_time", "appointmentTime"],
      ["apptTime", "appointmentTime"],

      ["funnel", "funnel"],
      ["Funnel", "funnel"],
      ["funnel_name", "funnel"],
      ["funnelName", "funnel"],
    ])("maps %s -> %s", (input, expected) => {
      expect(suggestMapTarget(input)).toBe(expected);
    });

    it("prefers fullName over firstName/lastName when both could match", () => {
      expect(suggestMapTarget("full_name")).toBe("fullName");
      expect(suggestMapTarget("customer_full_name")).toBe("fullName");
    });
  });

  describe("learned suggestions from confirmed mappings", () => {
    it("prefers a learned suggestion over the static heuristic", () => {
      const learned = new Map<string, MapToTarget>([["phone", "fullName"]]);
      expect(suggestMapTarget("phone", learned)).toBe("fullName");
    });

    it("returns a learned suggestion for an opaque field name the static heuristic cannot match", () => {
      const learned = new Map<string, MapToTarget>([
        ["q1_first", "firstName"],
        ["signup_zipcode", "zip"],
      ]);
      expect(suggestMapTarget("q1_first", learned)).toBe("firstName");
      expect(suggestMapTarget("signup_zipcode", learned)).toBe("zip");
    });

    it("normalizes the lookup key (case + separators) before consulting learned suggestions", () => {
      const learned = new Map<string, MapToTarget>([["q1_first", "firstName"]]);
      expect(suggestMapTarget("Q1 First", learned)).toBe("firstName");
      expect(suggestMapTarget("Q1-First", learned)).toBe("firstName");
      expect(suggestMapTarget("Q1.First", learned)).toBe("firstName");
    });

    it("falls back to the static heuristic when there is no learned suggestion", () => {
      const learned = new Map<string, MapToTarget>([["q1_first", "firstName"]]);
      expect(suggestMapTarget("phone_number", learned)).toBe("phone");
    });

    it("falls back to the static heuristic when the learned map is empty", () => {
      expect(suggestMapTarget("phone_number", new Map())).toBe("phone");
    });

    it("works the same as before when no learned map is supplied (back-compat)", () => {
      expect(suggestMapTarget("phone_number")).toBe("phone");
      expect(suggestMapTarget("q1_first")).toBeNull();
    });

    it("ignores learned values that aren't valid MapToTarget options", () => {
      const learned = new Map<string, MapToTarget>([
        ["weird_field", "not_a_real_target" as unknown as MapToTarget],
      ]);
      expect(suggestMapTarget("weird_field", learned)).toBeNull();
    });
  });

  describe("normalizeFieldName", () => {
    it("lowercases and replaces separators with underscores", () => {
      expect(normalizeFieldName("First Name")).toBe("first_name");
      expect(normalizeFieldName("first-name")).toBe("first_name");
      expect(normalizeFieldName("first.name")).toBe("first_name");
      expect(normalizeFieldName("FirstName")).toBe("firstname");
    });
  });

  describe("negative matches (ambiguous names)", () => {
    it.each([
      "field_3",
      "question_1",
      "comment",
      "notes",
      "answer",
      "input_42",
      "custom_value",
      "",
      "date",
      "time",
      "birthday",
      "random_date",
      "timezone",
    ])("does not pre-select for %s", (input) => {
      expect(suggestMapTarget(input)).toBeNull();
    });
  });
});
