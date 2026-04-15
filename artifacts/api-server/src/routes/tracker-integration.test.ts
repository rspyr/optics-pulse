import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { normalizePhone } from "../lib/phone-utils";

const mockDb = {
  insertCalls: [] as Array<{ table: unknown; values: unknown }>,
  selectResults: [] as unknown[][],
  insertResults: [] as unknown[][],
  _selectIdx: 0,
  _insertIdx: 0,
  resetCounters() {
    this._selectIdx = 0;
    this._insertIdx = 0;
    this.insertCalls = [];
  },
};

interface ThenableIterable extends Record<string, unknown> {
  then: (resolve: Function, reject?: Function) => Promise<unknown>;
  [Symbol.iterator]: () => Generator<unknown>;
}

function makeThenable(result: unknown[]): ThenableIterable {
  const obj: ThenableIterable = {
    then: (resolve: Function, reject?: Function) => Promise.resolve(result).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
    [Symbol.iterator]: function* () { yield* result; },
  };
  return obj;
}

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const thenResult = () => makeThenable(results());
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.leftJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(Object.assign(thenResult(), {
    limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
    orderBy: vi.fn().mockReturnValue(Object.assign(thenResult(), { limit: vi.fn().mockImplementation(() => Promise.resolve(results())) })),
  }));
  chain.orderBy = vi.fn().mockReturnValue(Object.assign(thenResult(), { limit: vi.fn().mockImplementation(() => Promise.resolve(results())) }));
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.then = (resolve: Function, reject?: Function) => Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  return chain;
}

function makeInsertChain(results: () => unknown[], onValues?: (v: unknown) => void) {
  return {
    values: vi.fn().mockImplementation((vals: unknown) => {
      onValues?.(vals);
      return {
        returning: vi.fn().mockResolvedValue(results()),
        then: (resolve: Function, reject?: Function) => Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
      };
    }),
  };
}

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockImplementation((..._args: unknown[]) => {
      const idx = mockDb._selectIdx++;
      return makeSelectChain(() => mockDb.selectResults[idx] || []);
    }),
    insert: vi.fn().mockImplementation((...args: unknown[]) => {
      const idx = mockDb._insertIdx++;
      return makeInsertChain(
        () => mockDb.insertResults[idx] || [],
        (vals) => mockDb.insertCalls.push({ table: args[0], values: vals }),
      );
    }),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    })),
  },
  trackerHeartbeatsTable: Symbol("trackerHeartbeatsTable"),
  tenantsTable: Symbol("tenantsTable"),
  attributionEventsTable: Symbol("attributionEventsTable"),
  leadsTable: Symbol("leadsTable"),
  funnelTypesTable: Symbol("funnelTypesTable"),
  tenantFunnelTypesTable: Symbol("tenantFunnelTypesTable"),
  callAttemptsTable: Symbol("callAttemptsTable"),
  fieldMappingRulesTable: Symbol("fieldMappingRulesTable"),
  funnelAliasesTable: Symbol("funnelAliasesTable"),
}));

vi.mock("../socket", () => ({
  emitNewLead: vi.fn(),
}));

vi.mock("../services/round-robin", () => ({
  assignLeadRoundRobin: vi.fn().mockResolvedValue({ assignedCsrId: null, reason: "no CSRs" }),
}));

vi.mock("../services/auto-pass-scheduler", () => ({
  scheduleAutoPass: vi.fn(),
}));

vi.mock("../utils/appointment-validation", () => ({
  isValidAppointmentValue: vi.fn().mockReturnValue(false),
}));

vi.mock("../services/source-normalizer", () => ({
  normalizeSource: vi.fn().mockImplementation((_tid: number, src: string) => Promise.resolve(src)),
}));

vi.mock("../services/field-detection", () => ({
  detectFields: vi.fn().mockImplementation((_tid: number, fields: Record<string, unknown>) => {
    const firstName = (fields?.first_name as string) || null;
    const lastName = (fields?.last_name as string) || null;
    const email = (fields?.email as string) || null;
    const phone = (fields?.phone as string) || null;
    let nameFromFull = null as string | null;
    if (!firstName && fields?.name && typeof fields.name === "string") {
      nameFromFull = fields.name;
    }
    return Promise.resolve({
      pii: { firstName: firstName || nameFromFull?.split(" ")[0] || null, lastName: lastName || (nameFromFull ? nameFromFull.split(" ").slice(1).join(" ") : null), email, phone },
      source: null,
      funnel: null,
      serviceType: null,
      addressParts: { street: null, city: null, state: null, zip: null },
      formFields: fields || null,
      fields: [],
    });
  }),
}));

vi.mock("../services/funnel-normalizer", () => ({
  normalizeFunnel: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/reconciliation", () => ({
  normalizeAddress: vi.fn().mockImplementation((addr: string) => addr),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  gte: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
}));

import express from "express";

let app: express.Express;

async function setupApp() {
  vi.resetModules();
  const mod = await import("./tracker");
  app = express();
  app.use(express.json());
  app.use(mod.default);
}

function sendRequest(
  expressApp: express.Express,
  path: string,
  body: unknown,
  method = "POST",
): Promise<{ status: number; body: string; json: () => Record<string, unknown> }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = JSON.stringify(body);
      const options = {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };
      const req = http.request(options, (res: { statusCode: number; on: Function }) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          server.close();
          resolve({
            status: res.statusCode,
            body: data,
            json: () => JSON.parse(data),
          });
        });
      });
      req.write(payload);
      req.end();
    });
  });
}

function expectedHash(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

describe("POST /collect/submit", () => {
  beforeEach(async () => {
    mockDb.selectResults = [];
    mockDb.insertResults = [];
    mockDb.resetCounters();
    await setupApp();
  });

  it("returns 400 when client_id is missing", async () => {
    const res = await sendRequest(app, "/collect/submit", {});
    expect(res.status).toBe(400);
    expect(res.json().success).toBe(false);
    expect(res.json().message).toContain("client_id");
  });

  it("returns 400 when client_id is empty string", async () => {
    const res = await sendRequest(app, "/collect/submit", { client_id: "  " });
    expect(res.status).toBe(400);
    expect(res.json().message).toContain("client_id");
  });

  it("returns 404 for unknown client_id (no tenant found)", async () => {
    mockDb.selectResults = [[]];

    const res = await sendRequest(app, "/collect/submit", {
      client_id: "unknown-slug",
    });
    expect(res.status).toBe(404);
    expect(res.json().message).toContain("Unknown client_id");
  });

  it("sets diamond matchLevel when gclid is present", async () => {
    const tenant = { id: 1, name: "Test Tenant" };
    const fakeEvent = { id: 55, tenantId: 1 };
    const fakeLead = { id: 10, tenantId: 1 };
    mockDb.selectResults = [[tenant], [fakeLead]];
    mockDb.insertResults = [[fakeEvent], [fakeLead]];

    const res = await sendRequest(app, "/collect/submit", {
      client_id: "test-client",
      attribution: { gclid: "abc123", utm_source: "google" },
      fields: { first_name: "John", last_name: "Doe", email: "john@example.com" },
    });

    expect(res.status).toBe(200);
    expect(res.json().eventId).toBe(55);

    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.matchLevel).toBe("diamond");
    expect(eventInsert.matchConfidence).toBe(1.0);
    expect(eventInsert.gclid).toBe("abc123");
    expect(eventInsert.eventType).toBe("form_fill");
    expect(eventInsert.utmSource).toBe("google");
    expect(eventInsert.tenantId).toBe(1);
  });

  it("sets golden matchLevel when phone present but no gclid", async () => {
    const tenant = { id: 2, name: "Tenant" };
    const fakeEvent = { id: 77, tenantId: 2 };
    const fakeLead = { id: 20, tenantId: 2 };
    mockDb.selectResults = [[tenant], [fakeLead]];
    mockDb.insertResults = [[fakeEvent], [fakeLead]];

    const phone = "555-123-4567";
    const res = await sendRequest(app, "/collect/submit", {
      client_id: "test-client",
      fields: { phone, first_name: "Jane" },
    });

    expect(res.status).toBe(200);
    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.matchLevel).toBe("golden");
    expect(eventInsert.matchConfidence).toBe(0.9);
    expect(eventInsert.hashedPhone).toBe(expectedHash(normalizePhone(phone)));
    expect(eventInsert.gclid).toBeNull();
  });

  it("sets silver matchLevel when email present but no gclid or phone", async () => {
    const tenant = { id: 3, name: "Tenant" };
    const fakeEvent = { id: 88, tenantId: 3 };
    const fakeLead = { id: 30, tenantId: 3 };
    mockDb.selectResults = [[tenant], [fakeLead]];
    mockDb.insertResults = [[fakeEvent], [fakeLead]];

    const email = "silver@test.com";
    const res = await sendRequest(app, "/collect/submit", {
      client_id: "test-client",
      fields: { email, first_name: "Silver" },
    });

    expect(res.status).toBe(200);
    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.matchLevel).toBe("silver");
    expect(eventInsert.matchConfidence).toBe(0.8);
    expect(eventInsert.hashedEmail).toBe(expectedHash(email));
    expect(eventInsert.hashedPhone).toBeNull();
  });

  it("sets unmatched when no gclid, phone, or email", async () => {
    const tenant = { id: 4, name: "Tenant" };
    const fakeEvent = { id: 99, tenantId: 4 };
    mockDb.selectResults = [[tenant]];
    mockDb.insertResults = [[fakeEvent]];

    const res = await sendRequest(app, "/collect/submit", {
      client_id: "test-client",
      attribution: {},
      fields: { some_field: "value" },
    });

    expect(res.status).toBe(200);
    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.matchLevel).toBe("unmatched");
    expect(eventInsert.matchConfidence).toBe(0);
  });

  it("does not create lead for test submissions", async () => {
    const tenant = { id: 5, name: "Tenant", leadIngestionMode: "tracker" };
    const fakeEvent = { id: 100, tenantId: 5 };
    mockDb.selectResults = [[tenant]];
    mockDb.insertResults = [[fakeEvent]];

    await sendRequest(app, "/collect/submit", {
      client_id: "test-client",
      fields: { first_name: "Test", last_name: "User", email: "test@test.com" },
    });

    expect(mockDb.insertCalls.length).toBe(1);
  });

  it("creates lead with correct PII fields", async () => {
    const tenant = { id: 6, name: "Tenant", leadIngestionMode: "tracker" };
    const fakeEvent = { id: 200, tenantId: 6 };
    const fakeLead = { id: 40, tenantId: 6 };
    mockDb.selectResults = [[tenant], [fakeLead]];
    mockDb.insertResults = [[fakeEvent], [fakeLead], []];

    await sendRequest(app, "/collect/submit", {
      client_id: "lead-client",
      attribution: { gclid: "gclid999", utm_source: "google" },
      fields: {
        first_name: "Alice",
        last_name: "Smith",
        email: "alice@test.com",
        phone: "5559876543",
      },
    });

    expect(mockDb.insertCalls.length).toBeGreaterThanOrEqual(2);
    const leadInsert = mockDb.insertCalls[1]?.values as Record<string, unknown>;
    expect(leadInsert.firstName).toBe("Alice");
    expect(leadInsert.lastName).toBe("Smith");
    expect(leadInsert.phone).toBe("5559876543");
    expect(leadInsert.email).toBe("alice@test.com");
    expect(leadInsert.matchedGclid).toBe("gclid999");
    expect(leadInsert.status).toBe("new");
  });

  it("stores all attribution UTM params in event", async () => {
    const tenant = { id: 7, name: "Tenant" };
    const fakeEvent = { id: 300, tenantId: 7 };
    mockDb.selectResults = [[tenant]];
    mockDb.insertResults = [[fakeEvent]];

    await sendRequest(app, "/collect/submit", {
      client_id: "test-client",
      attribution: {
        gclid: "g1",
        fbclid: "fb1",
        wbraid: "wb1",
        msclkid: "ms1",
        ttclid: "tt1",
        li_fat_id: "li1",
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "summer",
        utm_term: "hvac",
        utm_content: "ad1",
      },
      fields: {},
      page_url: "https://example.com/landing",
      landing_page: "https://example.com",
      referrer: "https://google.com",
    });

    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.gclid).toBe("g1");
    expect(eventInsert.fbclid).toBe("fb1");
    expect(eventInsert.wbraid).toBe("wb1");
    expect(eventInsert.msclkid).toBe("ms1");
    expect(eventInsert.ttclid).toBe("tt1");
    expect(eventInsert.liFatId).toBe("li1");
    expect(eventInsert.utmSource).toBe("google");
    expect(eventInsert.utmMedium).toBe("cpc");
    expect(eventInsert.utmCampaign).toBe("summer");
    expect(eventInsert.utmTerm).toBe("hvac");
    expect(eventInsert.utmContent).toBe("ad1");
    expect(eventInsert.pageUrl).toBe("https://example.com/landing");
    expect(eventInsert.landingPage).toBe("https://example.com");
    expect(eventInsert.referrer).toBe("https://google.com");
  });

  it("extracts full name from 'name' field when first_name is absent", async () => {
    const tenant = { id: 8, name: "Tenant", leadIngestionMode: "tracker" };
    const fakeEvent = { id: 500, tenantId: 8 };
    const fakeLead = { id: 50, tenantId: 8 };
    mockDb.selectResults = [[tenant], [fakeLead]];
    mockDb.insertResults = [[fakeEvent], [fakeLead], []];

    await sendRequest(app, "/collect/submit", {
      client_id: "name-client",
      fields: { name: "Mary Jane Watson", email: "mary@test.com" },
    });

    const leadInsert = mockDb.insertCalls[1]?.values as Record<string, unknown>;
    expect(leadInsert.firstName).toBe("Mary");
    expect(leadInsert.lastName).toBe("Jane Watson");
  });

  it("stores form fields in attribution event", async () => {
    const tenant = { id: 9, name: "Tenant" };
    const fakeEvent = { id: 600, tenantId: 9 };
    mockDb.selectResults = [[tenant]];
    mockDb.insertResults = [[fakeEvent]];

    await sendRequest(app, "/collect/submit", {
      client_id: "test-client",
      fields: { service_type: "HVAC", notes: "urgent" },
      custom: { funnel: "hvac-install" },
    });

    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.formFields).toEqual({
      service_type: "HVAC",
      notes: "urgent",
      _custom: { funnel: "hvac-install" },
    });
  });
});
