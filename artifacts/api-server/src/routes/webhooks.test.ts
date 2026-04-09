import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

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

function makeThenable(result: unknown[]) {
  const obj: Record<string, unknown> = {};
  obj.then = (resolve: Function, reject?: Function) => Promise.resolve(result).then(resolve as any, reject as any);
  obj[Symbol.iterator] = function* () { yield* result; };
  return obj;
}

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const thenable = () => makeThenable(results());
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(Object.assign(thenable(), { limit: vi.fn().mockImplementation(() => Promise.resolve(results())) }));
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.then = (resolve: Function, reject?: Function) => Promise.resolve(results()).then(resolve as any, reject as any);
  return chain;
}

function makeInsertChain(results: () => unknown[], onValues?: (v: unknown) => void) {
  return {
    values: vi.fn().mockImplementation((vals: unknown) => {
      onValues?.(vals);
      return {
        returning: vi.fn().mockResolvedValue(results()),
        then: (resolve: Function, reject?: Function) => Promise.resolve(results()).then(resolve as any, reject as any),
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

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\+]/g, "").replace(/^1/, "");
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

  it("returns paused message for callrail source", async () => {
    const res = await sendRequest(app, "/webhooks/ingest", {
      source: "callrail",
      tenantId: 1,
      data: { phone: "5551234567" },
    });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain("paused");
  });

  it("returns paused message for ghl source", async () => {
    const res = await sendRequest(app, "/webhooks/ingest", {
      source: "ghl",
      tenantId: 1,
      data: { phone: "5551234567" },
    });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain("paused");
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
    const res = await sendRequest(app, "/webhooks/ingest", {
      source: "callrail",
      tenantId: 1,
      data: { phone: "5551234567", externalId: "CR12345" },
    });

    expect(res.json().message).toContain("paused");
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

  it("returns paused message", async () => {
    const res = await sendRequest(app, "/webhooks/ghl", {});
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain("paused");
  });
});
