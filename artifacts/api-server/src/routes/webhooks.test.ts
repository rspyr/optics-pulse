import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { normalizePhone } from "../lib/phone-utils";
import { leadsTable } from "@workspace/db";

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
  const thenable = () => makeThenable(results());
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(Object.assign(thenable(), { limit: vi.fn().mockImplementation(() => Promise.resolve(results())) }));
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.then = (resolve: Function, reject?: Function) => Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  return chain;
}

function makeInsertChain(results: () => unknown[], onValues?: (v: unknown) => void) {
  return {
    values: vi.fn().mockImplementation((vals: unknown) => {
      onValues?.(vals);
      const lazyResult = () => results();
      return {
        returning: vi.fn().mockImplementation(() => Promise.resolve(lazyResult())),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => Promise.resolve(lazyResult())),
        }),
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => Promise.resolve(lazyResult())),
        }),
        then: (resolve: Function, reject?: Function) => Promise.resolve(lazyResult()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
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
  attributionEventsTable: Symbol("attributionEventsTable"),
  leadsTable: Symbol("leadsTable"),
  funnelTypesTable: Symbol("funnelTypesTable"),
  tenantFunnelTypesTable: Symbol("tenantFunnelTypesTable"),
  tenantsTable: Symbol("tenantsTable"),
  usersTable: Symbol("usersTable"),
  callAttemptsTable: Symbol("callAttemptsTable"),
  podiumMessagesTable: Symbol("podiumMessagesTable"),
  callrailWebhookStatusTable: Symbol("callrailWebhookStatusTable"),
  leadStatusHistoryTable: Symbol("leadStatusHistoryTable"),
}));

vi.mock("@workspace/api-zod", () => ({
  IngestWebhookBody: {
    parse: (body: Record<string, unknown>) => {
      if (!body.source || body.tenantId == null || !body.data) {
        throw new Error("Validation failed");
      }
      const validSources = ["callrail", "ghl", "form", "manual"];
      if (!validSources.includes(body.source as string)) {
        throw new Error("Invalid source");
      }
      return body;
    },
  },
}));

vi.mock("../socket", () => ({
  emitNewLead: vi.fn(),
  emitPodiumMessage: vi.fn(),
}));

vi.mock("../services/lead-notify-scheduler", () => ({
  scheduleOrEmitNewLead: vi.fn(),
}));

const mockDecryptConfig = vi.fn();
vi.mock("../lib/encryption", () => ({
  decryptConfig: (s: string) => mockDecryptConfig(s),
  encryptConfig: (o: unknown) => JSON.stringify(o),
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

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  or: vi.fn((...args: unknown[]) => args),
  sql: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  gt: vi.fn((...args: unknown[]) => args),
}));

import express from "express";

let app: express.Express;

const captureRawBody = (req: unknown, _res: unknown, buf: Buffer) => {
  (req as Record<string, unknown>).rawBody = buf;
};

async function setupApp() {
  vi.resetModules();
  const mod = await import("./webhooks");
  app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
  app.use("/webhooks", express.raw({ type: "*/*", verify: captureRawBody }));
  app.use(mod.default);
}

function sendRequest(
  expressApp: express.Express,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
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
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
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

describe("POST /webhooks/ingest", () => {
  beforeEach(async () => {
    delete process.env.WEBHOOK_SECRET;
    mockDb.selectResults = [];
    mockDb.insertResults = [];
    mockDb.resetCounters();
    await setupApp();
  });

  it("returns 400 for invalid payload (missing source)", async () => {
    const res = await sendRequest(app, "/webhooks/ingest", { tenantId: 1, data: {} });
    expect(res.status).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it("returns 400 for missing data field", async () => {
    const res = await sendRequest(app, "/webhooks/ingest", { source: "callrail", tenantId: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects invalid source value", async () => {
    const res = await sendRequest(app, "/webhooks/ingest", {
      source: "invalid_source",
      tenantId: 1,
      data: { phone: "5551234567" },
    });
    expect(res.status).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it("processes callrail source successfully", async () => {
    const fakeEvent = { id: 50, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    const res = await sendRequest(app, "/webhooks/ingest", {
      source: "callrail",
      tenantId: 1,
      data: { phone: "5551234567" },
    });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.eventId).toBe(50);
  });

  it("processes ghl source successfully", async () => {
    const fakeEvent = { id: 51, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    const res = await sendRequest(app, "/webhooks/ingest", {
      source: "ghl",
      tenantId: 1,
      data: { phone: "5551234567" },
    });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.eventId).toBe(51);
  });

  it("rejects invalid signature when WEBHOOK_SECRET is set", async () => {
    process.env.WEBHOOK_SECRET = "test-secret";

    const res = await sendRequest(app, "/webhooks/ingest", {
      source: "form",
      tenantId: 1,
      data: { email: "test@example.com" },
    }, { "x-mos-signature": "invalid-sig-that-is-64-chars-long-to-match-length-of-hex-sha256" });

    expect(res.status).toBe(401);
    expect(res.json().message).toContain("Invalid webhook signature");
  });

  it("rejects missing signature when WEBHOOK_SECRET is set", async () => {
    process.env.WEBHOOK_SECRET = "test-secret";

    const res = await sendRequest(app, "/webhooks/ingest", {
      source: "form",
      tenantId: 1,
      data: { email: "test@example.com" },
    });

    expect(res.status).toBe(401);
  });

  it("accepts valid signature when WEBHOOK_SECRET is set", async () => {
    const secret = "test-secret";
    process.env.WEBHOOK_SECRET = secret;

    const payload = { source: "form", tenantId: 1, data: { email: "test@example.com" } };
    const payloadStr = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", secret).update(payloadStr).digest("hex");

    const fakeEvent = { id: 42, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    const res = await sendRequest(app, "/webhooks/ingest", payload, {
      "x-mos-signature": signature,
    });

    expect(res.status).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().eventId).toBe(42);
  });

  it("sets eventType to call for callrail source and form_fill for form source", async () => {
    const fakeEvent = { id: 50, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    const res = await sendRequest(app, "/webhooks/ingest", {
      source: "form",
      tenantId: 1,
      data: { gclid: "g1" },
    });

    expect(res.status).toBe(200);
    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.eventType).toBe("form_fill");
  });

  it("sets eventType to click for manual source", async () => {
    const fakeEvent = { id: 51, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    const res = await sendRequest(app, "/webhooks/ingest", {
      source: "manual",
      tenantId: 1,
      data: { gclid: "g2" },
    });

    expect(res.status).toBe(200);
    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.eventType).toBe("click");
  });

  it("sets diamond matchLevel when gclid is present", async () => {
    const fakeEvent = { id: 60, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    await sendRequest(app, "/webhooks/ingest", {
      source: "form",
      tenantId: 1,
      data: { gclid: "abc123", email: "test@example.com", phone: "5551234567" },
    });

    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.matchLevel).toBe("diamond");
    expect(eventInsert.matchConfidence).toBe(1.0);
    expect(eventInsert.gclid).toBe("abc123");
  });

  it("sets golden matchLevel when phone present but no gclid", async () => {
    const fakeEvent = { id: 61, tenantId: 1 };
    const fakeLead = { id: 11, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent], [fakeLead]];
    mockDb.selectResults = [[fakeLead]];

    const phone = "555-123-4567";
    await sendRequest(app, "/webhooks/ingest", {
      source: "form",
      tenantId: 1,
      data: { phone, firstName: "Jane" },
    });

    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.matchLevel).toBe("golden");
    expect(eventInsert.matchConfidence).toBe(0.9);
    expect(eventInsert.hashedPhone).toBe(expectedHash(normalizePhone(phone)));
  });

  it("sets silver matchLevel when email present but no gclid or phone", async () => {
    const fakeEvent = { id: 62, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    const email = "silver@test.com";
    await sendRequest(app, "/webhooks/ingest", {
      source: "form",
      tenantId: 1,
      data: { email },
    });

    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.matchLevel).toBe("silver");
    expect(eventInsert.matchConfidence).toBe(0.8);
    expect(eventInsert.hashedEmail).toBe(expectedHash(email));
  });

  it("sets unmatched matchLevel when no PII identifiers", async () => {
    const fakeEvent = { id: 63, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    await sendRequest(app, "/webhooks/ingest", {
      source: "form",
      tenantId: 1,
      data: { utmSource: "direct" },
    });

    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.matchLevel).toBe("unmatched");
    expect(eventInsert.matchConfidence).toBe(0);
  });

  it("creates lead with correct fields from webhook PII", async () => {
    const fakeEvent = { id: 70, tenantId: 1 };
    const fakeLead = { id: 15, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent], [fakeLead], []];
    mockDb.selectResults = [[fakeLead]];

    await sendRequest(app, "/webhooks/ingest", {
      source: "form",
      tenantId: 1,
      data: {
        firstName: "Alice",
        lastName: "Smith",
        phone: "5551234567",
        email: "alice@test.com",
        gclid: "gclid123",
        utmSource: "google",
      },
    });

    expect(mockDb.insertCalls.length).toBeGreaterThanOrEqual(2);
    const leadInsert = mockDb.insertCalls[1]?.values as Record<string, unknown>;
    expect(leadInsert.firstName).toBe("Alice");
    expect(leadInsert.lastName).toBe("Smith");
    expect(leadInsert.phone).toBe("5551234567");
    expect(leadInsert.email).toBe("alice@test.com");
    expect(leadInsert.matchedGclid).toBe("gclid123");
    expect(leadInsert.status).toBe("new");
  });

  it("skips lead creation for test names", async () => {
    const fakeEvent = { id: 80, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    await sendRequest(app, "/webhooks/ingest", {
      source: "form",
      tenantId: 1,
      data: {
        firstName: "Test",
        lastName: "User",
        email: "test@test.com",
      },
    });

    expect(mockDb.insertCalls.length).toBe(1);
  });

  it("stores externalId with callrail prefix for callrail source", async () => {
    const fakeEvent = { id: 60, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    await sendRequest(app, "/webhooks/ingest", {
      source: "callrail",
      tenantId: 1,
      data: { phone: "5551234567", externalId: "CR12345" },
    });

    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.externalId).toBe("callrail:CR12345");
  });

  it("stores UTM and landing page data in event", async () => {
    const fakeEvent = { id: 90, tenantId: 1 };
    mockDb.insertResults = [[fakeEvent]];

    await sendRequest(app, "/webhooks/ingest", {
      source: "form",
      tenantId: 1,
      data: {
        utmSource: "facebook",
        utmCampaign: "winter-sale",
        utmMedium: "social",
        landingPage: "https://example.com/offer",
      },
    });

    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.utmSource).toBe("facebook");
    expect(eventInsert.utmCampaign).toBe("winter-sale");
    expect(eventInsert.utmMedium).toBe("social");
    expect(eventInsert.landingPage).toBe("https://example.com/offer");
  });
});

describe("POST /webhooks/ghl", () => {
  beforeEach(async () => {
    mockDb.selectResults = [];
    mockDb.insertResults = [];
    mockDb.resetCounters();
    await setupApp();
  });

  it("rejects requests with invalid signature when WEBHOOK_SECRET is set", async () => {
    process.env.WEBHOOK_SECRET = "test-secret";

    const res = await sendRequest(app, "/webhooks/ghl", {});
    expect(res.status).toBe(401);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain("Invalid webhook signature");

    delete process.env.WEBHOOK_SECRET;
  });
});

describe("POST /webhooks/callrail/:tenantId", () => {
  const SIGNING_KEY = "test-signing-key";

  beforeEach(async () => {
    delete process.env.WEBHOOK_SECRET;
    mockDb.selectResults = [];
    mockDb.insertResults = [];
    mockDb.resetCounters();
    mockDecryptConfig.mockReset();
    mockDecryptConfig.mockReturnValue({ callRailSigningKey: SIGNING_KEY });
    await setupApp();
  });

  function signCallRail(payload: string): string {
    return crypto.createHmac("sha1", SIGNING_KEY).update(payload).digest("base64");
  }

  it("rejects with 401 when signature is missing", async () => {
    mockDb.selectResults = [[{ id: 1, apiConfig: "encrypted" }]];

    const res = await sendRequest(app, "/webhooks/callrail/1", {
      id: "CAL123",
      customer_phone_number: "+15551234567",
      customer_name: "Jane Doe",
    });

    expect(res.status).toBe(401);
    expect(res.json().message).toContain("Invalid webhook signature");
  });

  it("rejects with 401 when signature is wrong", async () => {
    mockDb.selectResults = [[{ id: 1, apiConfig: "encrypted" }]];

    const res = await sendRequest(app, "/webhooks/callrail/1", {
      id: "CAL123",
      customer_phone_number: "+15551234567",
    }, { signature: "deadbeef" });

    expect(res.status).toBe(401);
  });

  it("returns 404 when tenant does not exist", async () => {
    mockDb.selectResults = [[]];

    const payload = { id: "CAL999" };
    const sig = signCallRail(JSON.stringify(payload));

    const res = await sendRequest(app, "/webhooks/callrail/999", payload, { signature: sig });
    expect(res.status).toBe(404);
  });

  it("returns 400 when tenantId in URL is invalid", async () => {
    const res = await sendRequest(app, "/webhooks/callrail/abc", { id: "CAL1" });
    expect(res.status).toBe(400);
  });

  it("accepts a valid CallRail Post-Call payload, maps fields, and creates event + lead", async () => {
    const fakeEvent = { id: 700, tenantId: 1 };
    const fakeLead = { id: 70, tenantId: 1 };
    // selects in order: tenant lookup, recent-leads dedupe lookup, refreshed lead lookup
    mockDb.selectResults = [
      [{ id: 1, apiConfig: "encrypted" }],
      [],
      [fakeLead],
    ];
    // inserts in order: attribution event (upsert), lead
    mockDb.insertResults = [[fakeEvent], [fakeLead]];

    const payload = {
      id: "CAL_abc123",
      customer_phone_number: "+15551234567",
      customer_name: "Jane Doe",
      gclid: "GCLID_xyz",
      source: "Google Ads",
      medium: "ppc",
      campaign: "Spring Sale",
      landing_page_url: "https://example.com/landing",
      customer_city: "Denver",
      customer_state: "CO",
    };
    const payloadStr = JSON.stringify(payload);
    const sig = signCallRail(payloadStr);

    const res = await sendRequest(app, "/webhooks/callrail/1", payload, { signature: sig });

    expect(res.status).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().eventId).toBe(700);

    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.eventType).toBe("call");
    expect(eventInsert.externalId).toBe("callrail:CAL_abc123");
    expect(eventInsert.gclid).toBe("GCLID_xyz");
    expect(eventInsert.utmSource).toBe("Google Ads");
    expect(eventInsert.utmCampaign).toBe("Spring Sale");
    expect(eventInsert.utmMedium).toBe("ppc");
    expect(eventInsert.landingPage).toBe("https://example.com/landing");
    expect(eventInsert.matchLevel).toBe("diamond");
    expect(eventInsert.matchConfidence).toBe(1.0);

    const leadInsert = mockDb.insertCalls[1]?.values as Record<string, unknown>;
    expect(leadInsert.firstName).toBe("Jane");
    expect(leadInsert.lastName).toBe("Doe");
    expect(leadInsert.phone).toBe(normalizePhone("+15551234567"));
    expect(leadInsert.matchedGclid).toBe("GCLID_xyz");
    expect(leadInsert.leadType).toBe("CallRail");
  });

  it("de-duplicates a repeat post of the same call id via ON CONFLICT DO NOTHING", async () => {
    const existingEvent = { id: 555 };
    // selects: tenant lookup, then existing-event lookup after upsert returned no row
    mockDb.selectResults = [
      [{ id: 1, apiConfig: "encrypted" }],
      [existingEvent],
    ];
    // The upsert returns [] indicating a conflict (the unique index already has the row)
    mockDb.insertResults = [[]];

    const payload = { id: "CAL_dup", customer_phone_number: "+15551234567" };
    const sig = signCallRail(JSON.stringify(payload));

    const res = await sendRequest(app, "/webhooks/callrail/1", payload, { signature: sig });

    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.duplicate).toBe(true);
    expect(body.eventId).toBe(555);
    // No lead insert happened — only the event upsert (plus the
    // webhook-status audit insert recordCallRailStatus writes on every path).
    expect(mockDb.insertCalls.filter(c => c.table === leadsTable).length).toBe(0);
    expect(mockDb.insertCalls[0].table).toBe(
      (await import("@workspace/db")).attributionEventsTable,
    );
  });

  it("accepts a CallRail payload missing the call id and still creates an event + lead", async () => {
    const fakeEvent = { id: 701, tenantId: 1 };
    const fakeLead = { id: 71, tenantId: 1 };
    // selects: tenant, recent-leads dedupe (empty), refreshed lead
    mockDb.selectResults = [
      [{ id: 1, apiConfig: "encrypted" }],
      [],
      [fakeLead],
    ];
    mockDb.insertResults = [[fakeEvent], [fakeLead]];

    const payload = { customer_phone_number: "+15551234567", customer_name: "No Id Caller" };
    const sig = signCallRail(JSON.stringify(payload));

    const res = await sendRequest(app, "/webhooks/callrail/1", payload, { signature: sig });
    expect(res.status).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().eventId).toBe(701);
    const eventInsert = mockDb.insertCalls[0]?.values as Record<string, unknown>;
    expect(eventInsert.externalId).toBeNull();
  });

  it("suppresses a duplicate lead when the same phone arrived within the dedupe window (with call id)", async () => {
    const fakeEvent = { id: 702, tenantId: 1 };
    const recentLead = { id: 90, phone: "+1 (555) 123-4567" };
    // selects: tenant, recent-leads dedupe (existing lead within window)
    mockDb.selectResults = [
      [{ id: 1, apiConfig: "encrypted" }],
      [recentLead],
    ];
    mockDb.insertResults = [[fakeEvent]];

    const payload = {
      id: "CAL_dedupe_window",
      customer_phone_number: "+15551234567",
      customer_name: "Window Caller",
    };
    const sig = signCallRail(JSON.stringify(payload));

    const res = await sendRequest(app, "/webhooks/callrail/1", payload, { signature: sig });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.duplicate).toBe(true);
    expect(body.duplicateLeadId).toBe(90);
    // Lead insert was suppressed (same phone within the dedupe window).
    expect(mockDb.insertCalls.filter(c => c.table === leadsTable).length).toBe(0);
  });

  it("suppresses a duplicate lead within the dedupe window even when the call id is missing", async () => {
    const fakeEvent = { id: 703, tenantId: 1 };
    const recentLead = { id: 91, phone: "5551234567" };
    mockDb.selectResults = [
      [{ id: 1, apiConfig: "encrypted" }],
      [recentLead],
    ];
    mockDb.insertResults = [[fakeEvent]];

    const payload = {
      customer_phone_number: "+15551234567",
      customer_name: "No Id Window Caller",
    };
    const sig = signCallRail(JSON.stringify(payload));

    const res = await sendRequest(app, "/webhooks/callrail/1", payload, { signature: sig });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.duplicate).toBe(true);
    expect(body.duplicateLeadId).toBe(91);
    // Lead insert was suppressed (same phone within the dedupe window).
    expect(mockDb.insertCalls.filter(c => c.table === leadsTable).length).toBe(0);
  });

  it("creates a second lead when no recent lead exists for that phone (outside the dedupe window)", async () => {
    const fakeEvent = { id: 704, tenantId: 1 };
    const fakeLead = { id: 92, tenantId: 1 };
    // selects: tenant, recent-leads dedupe (empty -> nothing recent), refreshed lead
    mockDb.selectResults = [
      [{ id: 1, apiConfig: "encrypted" }],
      [],
      [fakeLead],
    ];
    mockDb.insertResults = [[fakeEvent], [fakeLead]];

    const payload = {
      id: "CAL_outside_window",
      customer_phone_number: "+15551234567",
      customer_name: "Outside Window",
    };
    const sig = signCallRail(JSON.stringify(payload));

    const res = await sendRequest(app, "/webhooks/callrail/1", payload, { signature: sig });
    expect(res.status).toBe(200);
    expect(res.json().duplicate).toBeUndefined();
    // A new lead was inserted (no recent lead within the dedupe window).
    expect(mockDb.insertCalls.filter(c => c.table === leadsTable).length).toBe(1);
  });

  it("respects per-tenant CALLRAIL_DEDUPE_WINDOW_MINUTES override of 0 (disabled)", async () => {
    mockDecryptConfig.mockReturnValue({ callRailSigningKey: SIGNING_KEY, callRailDedupeWindowMinutes: 0 });
    const fakeEvent = { id: 705, tenantId: 1 };
    const fakeLead = { id: 93, tenantId: 1 };
    // selects: tenant, refreshed lead (no dedupe select since window=0)
    mockDb.selectResults = [
      [{ id: 1, apiConfig: "encrypted" }],
      [fakeLead],
    ];
    mockDb.insertResults = [[fakeEvent], [fakeLead]];

    const payload = {
      id: "CAL_disabled_window",
      customer_phone_number: "+15551234567",
      customer_name: "Disabled Window",
    };
    const sig = signCallRail(JSON.stringify(payload));

    const res = await sendRequest(app, "/webhooks/callrail/1", payload, { signature: sig });
    expect(res.status).toBe(200);
    expect(res.json().duplicate).toBeUndefined();
    // A new lead was inserted (dedupe disabled by per-tenant window=0).
    expect(mockDb.insertCalls.filter(c => c.table === leadsTable).length).toBe(1);
  });

  it("skips lead creation for test-named callers", async () => {
    const fakeEvent = { id: 800 };
    mockDb.selectResults = [[{ id: 1, apiConfig: "encrypted" }]];
    mockDb.insertResults = [[fakeEvent]];

    const payload = {
      id: "CAL_test",
      customer_phone_number: "+15551234567",
      customer_name: "Test User",
    };
    const sig = signCallRail(JSON.stringify(payload));

    const res = await sendRequest(app, "/webhooks/callrail/1", payload, { signature: sig });
    expect(res.status).toBe(200);
    // No lead insert — test-named callers are skipped.
    expect(mockDb.insertCalls.filter(c => c.table === leadsTable).length).toBe(0);
  });

  it("creates exactly one event and one lead when the same call is delivered concurrently", async () => {
    // Simulate the database-side guarantee from the unique index on
    // (tenant_id, external_id): only the first insert produces a row, and
    // subsequent concurrent upserts return [] (ON CONFLICT DO NOTHING).
    const dbModule = await import("@workspace/db") as unknown as {
      db: {
        select: ReturnType<typeof vi.fn>;
        insert: ReturnType<typeof vi.fn>;
      };
      attributionEventsTable: symbol;
      leadsTable: symbol;
      tenantsTable: symbol;
      callAttemptsTable: symbol;
    };

    const tenantRow = { id: 1, apiConfig: "encrypted" };
    const eventsByExternalId = new Map<string, { id: number; tenantId: number; externalId: string }>();
    const insertedLeads: Array<{ id: number; tenantId: number }> = [];
    const insertCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    let nextEventId = 9000;
    let nextLeadId = 8000;

    dbModule.db.select = vi.fn().mockImplementation(() => {
      let fromTable: unknown = null;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockImplementation((tbl: unknown) => {
        fromTable = tbl;
        return chain;
      });
      const resolveResult = (): unknown[] => {
        if (fromTable === dbModule.tenantsTable) return [tenantRow];
        if (fromTable === dbModule.attributionEventsTable) {
          const first = eventsByExternalId.values().next();
          return first.done ? [] : [first.value];
        }
        if (fromTable === dbModule.leadsTable) {
          return insertedLeads.length ? [insertedLeads[0]] : [];
        }
        return [];
      };
      chain.where = vi.fn().mockImplementation(() => {
        const whereChain: Record<string, unknown> = {
          limit: vi.fn().mockImplementation(() => Promise.resolve(resolveResult())),
          then: (resolve: Function, reject?: Function) =>
            Promise.resolve(resolveResult()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
          [Symbol.iterator]: function* () { yield* resolveResult(); },
        };
        return whereChain;
      });
      chain.then = (resolve: Function, reject?: Function) =>
        Promise.resolve(resolveResult()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
      return chain;
    });

    dbModule.db.insert = vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        insertCalls.push({ table, values: vals });

        const upsertEvent = () => {
          const ext = String(vals.externalId);
          if (eventsByExternalId.has(ext)) return [];
          const event = { id: nextEventId++, tenantId: Number(vals.tenantId), externalId: ext };
          eventsByExternalId.set(ext, event);
          return [event];
        };
        const insertLead = () => {
          const lead = { id: nextLeadId++, tenantId: Number(vals.tenantId) };
          insertedLeads.push(lead);
          return [lead];
        };
        const insertOther = () => [];

        const buildResult = (): unknown[] => {
          if (table === dbModule.attributionEventsTable) return upsertEvent();
          if (table === dbModule.leadsTable) return insertLead();
          return insertOther();
        };

        return {
          returning: vi.fn().mockImplementation(() => Promise.resolve(buildResult())),
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockImplementation(() => Promise.resolve(buildResult())),
          }),
          then: (resolve: Function, reject?: Function) =>
            Promise.resolve(buildResult()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
        };
      }),
    }));

    const payload = {
      id: "CAL_concurrent_xyz",
      customer_phone_number: "+15551234567",
      customer_name: "Concurrent Caller",
    };
    const sig = signCallRail(JSON.stringify(payload));

    const [r1, r2] = await Promise.all([
      sendRequest(app, "/webhooks/callrail/1", payload, { signature: sig }),
      sendRequest(app, "/webhooks/callrail/1", payload, { signature: sig }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Exactly one attribution event survived the race.
    expect(eventsByExternalId.size).toBe(1);

    // Exactly one lead was created.
    expect(insertedLeads.length).toBe(1);
    const leadInserts = insertCalls.filter((c) => c.table === dbModule.leadsTable);
    expect(leadInserts.length).toBe(1);

    // Both requests targeted the upsert; one of them came back as duplicate.
    const eventInserts = insertCalls.filter((c) => c.table === dbModule.attributionEventsTable);
    expect(eventInserts.length).toBe(2);

    const bodies = [r1.json(), r2.json()];
    const duplicates = bodies.filter((b) => b.duplicate === true);
    expect(duplicates.length).toBe(1);
    const winners = bodies.filter((b) => b.duplicate !== true);
    expect(winners.length).toBe(1);

    // Both responses point at the same surviving event id.
    const survivingId = Array.from(eventsByExternalId.values())[0].id;
    expect(bodies.every((b) => b.eventId === survivingId)).toBe(true);
  });
});

describe("verifyCallRailSignature (HMAC-SHA1)", () => {
  it("accepts a valid base64 SHA1 signature", async () => {
    const { verifyCallRailSignature } = await import("../services/integrations/callrail");
    const key = "secret";
    const payload = '{"id":"CAL1"}';
    const sig = crypto.createHmac("sha1", key).update(payload).digest("base64");
    expect(verifyCallRailSignature(payload, sig, key)).toBe(true);
  });

  it("accepts a valid hex SHA1 signature", async () => {
    const { verifyCallRailSignature } = await import("../services/integrations/callrail");
    const key = "secret";
    const payload = '{"id":"CAL2"}';
    const sig = crypto.createHmac("sha1", key).update(payload).digest("hex");
    expect(verifyCallRailSignature(payload, sig, key)).toBe(true);
  });

  it("rejects an invalid signature", async () => {
    const { verifyCallRailSignature } = await import("../services/integrations/callrail");
    expect(verifyCallRailSignature('{"id":"CAL3"}', "not-a-real-sig", "secret")).toBe(false);
  });

  it("rejects when no signature is sent", async () => {
    const { verifyCallRailSignature } = await import("../services/integrations/callrail");
    expect(verifyCallRailSignature('{"id":"CAL4"}', undefined, "secret")).toBe(false);
  });

  it("fails closed when signing key is missing (does NOT bypass in any environment)", async () => {
    const { verifyCallRailSignature } = await import("../services/integrations/callrail");
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(verifyCallRailSignature('{"id":"CAL5"}', "any-sig", undefined)).toBe(false);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
