import { describe, expect, it } from "vitest";
import { suggestMapTarget } from "./field-mapping-heuristic";

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
