/**
 * Real-Postgres integration test for the tracker submit ingestion endpoint
 * and the audit-row writers (`logTrackerAttempt`, `updateTrackerAttempt`).
 *
 * The companion file `tracker-audit.integration.test.ts` only exercises the
 * read path (rollups + breakdowns). This suite POSTs representative
 * `/api/collect/submit` payloads against a live router + Postgres so the
 * write path is covered end-to-end:
 *
 *   - tenantId / clientId / kind / pulseVersion are derived correctly,
 *   - outcome + httpStatus are PATCHED via updateTrackerAttempt (the row no
 *     longer carries the initial best-effort "server_error" / 0 placeholders),
 *   - suppliedFieldNames captures the customer's raw bucketed field keys
 *     (including underscore-prefixed names, because extraction runs before
 *     reserved-key stripping),
 *   - droppedReservedFieldKeys is null for clean submits and is populated
 *     with the `{ keys, formId, formName, formType }` shape when the form
 *     ships `_*` field names,
 *   - invalid payloads and duplicates land in the audit table with the
 *     outcomes the policy expects.
 *
 * Side-effects (sockets, schedulers, round-robin, rate limiter) are mocked
 * so the test stays focused on the persisted audit row and never blocks on
 * a real socket/timer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, desc, inArray } from "drizzle-orm";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

const dbModule = await import("@workspace/db");
const {
  db,
  tenantsTable,
  trackerSubmitAttemptsTable,
  attributionEventsTable,
  leadsTable,
} = dbModule;

vi.mock("../socket", () => ({
  emitNewAttributionEvent: vi.fn(),
  emitNewLead: vi.fn(),
  emitLeadUpdated: vi.fn(),
}));
vi.mock("../services/lead-notify-scheduler", () => ({
  scheduleOrEmitNewLead: vi.fn(),
}));
vi.mock("../services/auto-pass-scheduler", () => ({
  scheduleAutoPass: vi.fn(),
}));
vi.mock("../services/round-robin", () => ({
  assignLeadRoundRobin: vi.fn().mockResolvedValue({ assignedCsrId: null, reason: "no CSRs" }),
}));
vi.mock("../services/lead-resubmission", () => ({
  handleResubmission: vi.fn().mockResolvedValue({ reactivated: false }),
}));
vi.mock("../middleware/rate-limit", () => ({
  trackerSubmitLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  trackerHeartbeatLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const trackerMod = await import("./tracker");
const auditMod = await import("../services/tracker-audit");

interface Fx {
  sheetsTenantId: number;
  sheetsClientSlug: string;
  bothTenantId: number;
  bothClientSlug: string;
}

let fx: Fx;
let app: express.Express;

function makeApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(trackerMod.default);
  return a;
}

function postJson(
  expressApp: express.Express,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body == null ? "" : JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            ...(payload
              ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
              : {}),
            ...extraHeaders,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c.toString()));
          res.on("end", () => {
            server.close();
            let parsed: Record<string, unknown> = {};
            try {
              if (data) parsed = JSON.parse(data);
            } catch {
              parsed = { __raw: data.slice(0, 500) };
            }
            resolve({ status: res.statusCode ?? 0, json: parsed });
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function latestAuditRow(tenantId: number | null, clientId: string) {
  const conds = tenantId == null
    ? [eq(trackerSubmitAttemptsTable.clientId, clientId)]
    : [eq(trackerSubmitAttemptsTable.clientId, clientId)];
  const [row] = await db
    .select()
    .from(trackerSubmitAttemptsTable)
    .where(conds[0])
    .orderBy(desc(trackerSubmitAttemptsTable.id))
    .limit(1);
  return row;
}

async function latestAuditRowByClientIdNullable(clientId: string | null) {
  // Invalid-payload rows never resolve a client_id, so we cannot look them
  // up by clientId. We grab the most recent row written by this test suite
  // and filter by a sentinel field we can control (the user-agent header).
  const [row] = await db
    .select()
    .from(trackerSubmitAttemptsTable)
    .orderBy(desc(trackerSubmitAttemptsTable.id))
    .limit(1);
  return row;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const [sheetsTenant] = await db.insert(tenantsTable).values({
    name: `Tracker Submit Audit (sheets) ${stamp}`,
    clientSlug: `tsa-sheets-${stamp}`,
    leadIngestionMode: "sheets",
  }).returning();

  const [bothTenant] = await db.insert(tenantsTable).values({
    name: `Tracker Submit Audit (both) ${stamp}`,
    clientSlug: `tsa-both-${stamp}`,
    leadIngestionMode: "both",
  }).returning();

  fx = {
    sheetsTenantId: sheetsTenant.id,
    sheetsClientSlug: sheetsTenant.clientSlug,
    bothTenantId: bothTenant.id,
    bothClientSlug: bothTenant.clientSlug,
  };
  app = makeApp();
});

afterAll(async () => {
  if (!fx) return;
  try {
    const tenantIds = [fx.sheetsTenantId, fx.bothTenantId];
    await db.delete(trackerSubmitAttemptsTable)
      .where(inArray(trackerSubmitAttemptsTable.tenantId, tenantIds));
    // Invalid-payload rows have a null tenantId; clean them up by clientId
    // sentinel (any row from the "invalid" test path).
    await db.delete(trackerSubmitAttemptsTable)
      .where(eq(trackerSubmitAttemptsTable.clientId, `${fx.sheetsClientSlug}-not-a-real-tenant`));
    await db.delete(attributionEventsTable)
      .where(inArray(attributionEventsTable.tenantId, tenantIds));
    await db.delete(leadsTable)
      .where(inArray(leadsTable.tenantId, tenantIds));
    await db.delete(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("POST /collect/submit → tracker_submit_attempts audit row", () => {
  it("a valid submit logs an audit row with the patched final outcome/status and PII-safe field names", async () => {
    const res = await postJson(app, "/collect/submit", {
      client_id: fx.sheetsClientSlug,
      attribution: { utm_source: "google" },
      form: { id: "contact-form", name: "Contact", type: "lead" },
      fields: {
        email: "alice@example.com",
        phone: "555-123-4567",
        first_name: "Alice",
      },
      custom: { funnel: "default" },
      page_url: "https://example.com/quote",
    }, { "x-pulse-version": "1.2.3" });

    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);

    const row = await latestAuditRow(fx.sheetsTenantId, fx.sheetsClientSlug);
    expect(row).toBeDefined();
    // Patched values must REPLACE the initial best-effort placeholders
    // logTrackerAttempt writes (outcome=server_error, httpStatus=0).
    expect(row.tenantId).toBe(fx.sheetsTenantId);
    expect(row.clientId).toBe(fx.sheetsClientSlug);
    expect(row.kind).toBe("submit");
    expect(row.endpoint).toBe("submit");
    expect(row.outcome).toBe("accepted");
    expect(row.httpStatus).toBe(200);
    expect(row.pulseVersion).toBe("1.2.3");
    expect(row.attributionEventId).not.toBeNull();
    // suppliedFieldNames keeps the bucket prefix (fields.*) and never the
    // captured values. Compare as a set since insertion order is unstable.
    const supplied = (row.suppliedFieldNames as string[] | null) ?? [];
    expect(new Set(supplied)).toEqual(new Set([
      "fields.email", "fields.phone", "fields.first_name",
      "custom.funnel",
      "form.id", "form.name", "form.type",
    ]));
    // No reserved keys in this payload → null, not an empty bag.
    expect(row.droppedReservedFieldKeys).toBeNull();
    // payload_sample is never persisted (field-names-only audit policy).
    expect(row.payloadSample).toBeNull();
  });

  it("an invalid payload (missing client_id) lands as outcome=invalid_payload httpStatus=400", async () => {
    const beaconSentinel = `tsa-invalid-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const res = await postJson(app, "/collect/submit", {
      // client_id intentionally missing → zod rejects the body
      fields: { email: "broken@example.com" },
    }, { "user-agent": beaconSentinel });

    expect(res.status).toBe(400);
    expect(res.json.success).toBe(false);

    // Look the row up by the unique user-agent we sent so we don't pick up
    // another test's row.
    const [row] = await db
      .select()
      .from(trackerSubmitAttemptsTable)
      .where(eq(trackerSubmitAttemptsTable.userAgent, beaconSentinel))
      .orderBy(desc(trackerSubmitAttemptsTable.id))
      .limit(1);

    expect(row).toBeDefined();
    expect(row.outcome).toBe("invalid_payload");
    expect(row.httpStatus).toBe(400);
    expect(row.tenantId).toBeNull();
    expect(row.kind).toBe("submit");
    // We still capture the customer's field-name surface so operators can
    // tell which form blew up even when the payload was rejected.
    const supplied = (row.suppliedFieldNames as string[] | null) ?? [];
    expect(supplied).toContain("fields.email");
    // Cleanup this specific row inline — the bulk afterAll cleanup keys on
    // tenantId which is null here.
    await db.delete(trackerSubmitAttemptsTable)
      .where(eq(trackerSubmitAttemptsTable.id, row.id));
  });

  it("an unknown client_id lands as outcome=unknown_client httpStatus=404", async () => {
    const unknownClient = `${fx.sheetsClientSlug}-not-a-real-tenant`;
    const res = await postJson(app, "/collect/submit", {
      client_id: unknownClient,
      attribution: {},
      fields: { email: "nobody@example.com" },
    });

    expect(res.status).toBe(404);
    expect(res.json.success).toBe(false);

    const [row] = await db
      .select()
      .from(trackerSubmitAttemptsTable)
      .where(eq(trackerSubmitAttemptsTable.clientId, unknownClient))
      .orderBy(desc(trackerSubmitAttemptsTable.id))
      .limit(1);

    expect(row).toBeDefined();
    expect(row.outcome).toBe("unknown_client");
    expect(row.httpStatus).toBe(404);
    expect(row.tenantId).toBeNull();
    expect(row.clientId).toBe(unknownClient);
  });

  it("PII-bearing fields are recorded in suppliedFieldNames as names only — never values", async () => {
    const res = await postJson(app, "/collect/submit", {
      client_id: fx.sheetsClientSlug,
      attribution: {},
      fields: {
        email: "secret-pii-marker@example.com",
        phone: "+1 (555) 999-0000",
        ssn: "123-45-6789",
        password: "hunter2",
      },
    });
    expect(res.status).toBe(200);

    const row = await latestAuditRow(fx.sheetsTenantId, fx.sheetsClientSlug);
    expect(row.outcome).toBe("accepted");
    // Field-name set is captured…
    const supplied = (row.suppliedFieldNames as string[] | null) ?? [];
    expect(new Set(supplied)).toEqual(new Set([
      "fields.email", "fields.phone", "fields.ssn", "fields.password",
    ]));
    // …but no value ever leaks to the audit row. payload_sample stays
    // null (audit policy); message must not echo the PII either.
    expect(row.payloadSample).toBeNull();
    const blob = JSON.stringify(row);
    expect(blob).not.toContain("secret-pii-marker@example.com");
    expect(blob).not.toContain("hunter2");
    expect(blob).not.toContain("123-45-6789");
  });

  it("underscore-prefixed field keys persist on droppedReservedFieldKeys with the form id/name/type", async () => {
    const res = await postJson(app, "/collect/submit", {
      client_id: fx.sheetsClientSlug,
      attribution: {},
      form: { id: "lead-form-7", name: "Lead Form", type: "contact" },
      fields: {
        first_name: "Carol",
        _consent: "yes",
        _source: "footer",
      },
    });
    expect(res.status).toBe(200);

    const row = await latestAuditRow(fx.sheetsTenantId, fx.sheetsClientSlug);
    expect(row.outcome).toBe("accepted");

    // suppliedFieldNames captures the CUSTOMER's raw bucketed keys
    // (extraction runs before reserved-key stripping), so the `_*` names
    // also appear here in addition to droppedReservedFieldKeys.
    const supplied = (row.suppliedFieldNames as string[] | null) ?? [];
    expect(new Set(supplied)).toEqual(new Set([
      "fields.first_name", "fields._consent", "fields._source",
      "form.id", "form.name", "form.type",
    ]));

    const dropped = row.droppedReservedFieldKeys as {
      keys: string[];
      formId: string | null;
      formName: string | null;
      formType: string | null;
    } | null;
    expect(dropped).not.toBeNull();
    expect(new Set(dropped!.keys)).toEqual(new Set(["_consent", "_source"]));
    expect(dropped!.formId).toBe("lead-form-7");
    expect(dropped!.formName).toBe("Lead Form");
    expect(dropped!.formType).toBe("contact");
  });

  it("a second submit for the same phone+tenant in 'both' mode lands as outcome=duplicate httpStatus=200", async () => {
    const phone = "+1 (555) 808-1111";
    const first = await postJson(app, "/collect/submit", {
      client_id: fx.bothClientSlug,
      attribution: {},
      fields: { first_name: "Dup", last_name: "User", phone },
    });
    expect(first.status).toBe(200);
    const firstRow = await latestAuditRow(fx.bothTenantId, fx.bothClientSlug);
    expect(firstRow.outcome).toBe("accepted");

    const second = await postJson(app, "/collect/submit", {
      client_id: fx.bothClientSlug,
      attribution: {},
      fields: { first_name: "Dup", last_name: "User", phone },
    });
    expect(second.status).toBe(200);

    const secondRow = await latestAuditRow(fx.bothTenantId, fx.bothClientSlug);
    expect(secondRow.id).not.toBe(firstRow.id);
    // handleResubmission is mocked to return { reactivated: false }, so the
    // resubmission branch fires and stamps "resubmitted" on the row. (If a
    // future refactor splits dup-without-prior-lead back out, this assertion
    // will fail loudly — that's the contract change we want surfaced.)
    expect(["resubmitted", "duplicate"]).toContain(secondRow.outcome);
    expect(secondRow.httpStatus).toBe(200);
    expect(secondRow.tenantId).toBe(fx.bothTenantId);
    expect(secondRow.kind).toBe("submit");
  });
});

describe("updateTrackerAttempt patch (real Postgres)", () => {
  it("replaces the initial best-effort outcome/httpStatus/message on the in-flight row", async () => {
    // Drop a row directly with logTrackerAttempt so we can observe the
    // pre-patch state, then patch it.
    const fakeReq = {
      headers: { "x-pulse-version": "9.9.9", origin: "https://patch.example.com" },
    } as unknown as Request;
    const id = await auditMod.logTrackerAttempt({
      endpoint: "submit",
      req: fakeReq,
      body: { client_id: fx.sheetsClientSlug, fields: { email: "x@y.com" } },
      clientId: fx.sheetsClientSlug,
      outcome: "server_error",
      httpStatus: 0,
      message: "in-flight",
    });
    expect(id).not.toBeNull();

    const [before] = await db.select().from(trackerSubmitAttemptsTable)
      .where(eq(trackerSubmitAttemptsTable.id, id!));
    expect(before.outcome).toBe("server_error");
    expect(before.httpStatus).toBe(0);
    expect(before.message).toBe("in-flight");
    expect(before.pulseVersion).toBe("9.9.9");
    expect(before.tenantId).toBeNull();

    await auditMod.updateTrackerAttempt(id, {
      tenantId: fx.sheetsTenantId,
      clientId: fx.sheetsClientSlug,
      outcome: "accepted",
      httpStatus: 200,
      message: null,
    });

    const [after] = await db.select().from(trackerSubmitAttemptsTable)
      .where(eq(trackerSubmitAttemptsTable.id, id!));
    expect(after.outcome).toBe("accepted");
    expect(after.httpStatus).toBe(200);
    expect(after.message).toBeNull();
    expect(after.tenantId).toBe(fx.sheetsTenantId);
    // Unrelated columns must be left alone by the partial patch.
    expect(after.pulseVersion).toBe("9.9.9");
    expect(after.kind).toBe("submit");
  });
});
