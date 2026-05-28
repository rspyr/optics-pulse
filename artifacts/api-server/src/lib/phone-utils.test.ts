import { describe, it, expect } from "vitest";
import { normalizePhone, normalizedPhoneSql, phoneMatchesSql } from "./phone-utils";
import { leadsTable } from "@workspace/db";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();
function render(frag: ReturnType<typeof normalizedPhoneSql>): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(frag);
  return { sql: q.sql, params: q.params };
}

describe("normalizePhone", () => {
  it("strips formatting from a US 10-digit number", () => {
    expect(normalizePhone("(415) 555-1212")).toBe("4155551212");
  });
  it("strips leading 1 from an 11-digit US number", () => {
    expect(normalizePhone("1-415-555-1212")).toBe("4155551212");
    expect(normalizePhone("+1 415 555 1212")).toBe("4155551212");
  });
  it("returns digits unchanged for other lengths", () => {
    expect(normalizePhone("44 20 7946 0958")).toBe("442079460958");
    expect(normalizePhone("")).toBe("");
  });
});

describe("normalizedPhoneSql / phoneMatchesSql", () => {
  it("normalizedPhoneSql renders a regexp_replace CASE over the column", () => {
    const { sql } = render(normalizedPhoneSql(leadsTable.phone));
    expect(sql).toMatch(/regexp_replace/);
    expect(sql).toMatch(/CASE/);
  });
  it("phoneMatchesSql passes the digits-only input as a bound param", () => {
    const { params } = render(phoneMatchesSql(leadsTable.phone, "(415) 555-1212"));
    expect(params).toContain("4155551212");
  });
  it("phoneMatchesSql strips a leading 1 from the input param", () => {
    const { params } = render(phoneMatchesSql(leadsTable.phone, "+1-415-555-1212"));
    expect(params).toContain("4155551212");
    expect(params).not.toContain("14155551212");
  });
});
