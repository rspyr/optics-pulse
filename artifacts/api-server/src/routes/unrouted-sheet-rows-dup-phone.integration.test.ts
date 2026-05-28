/**
 * Real-Postgres integration tests for the cross-format duplicate-phone
 * detection on unrouted sheet rows.
 *
 * A previous fix taught the GET hint and the routeRowToFunnel duplicate
 * lookup to compare phones in their normalized (digits-only, leading "1"
 * stripped) form so an existing lead stored as "5551234567" matches an
 * unrouted row whose phone arrived as "(555) 123-4567". That fix lives
 * entirely in SQL — if a future refactor swaps the CASE/regexp_replace
 * expression for a naive `eq(leads.phone, row.phone)` the duplicate
 * detection would silently regress and the route would create a brand-
 * new lead instead of resubmitting the existing one.
 *
 * These tests lock that behavior in end-to-end:
 *   1. GET /tenants/:tenantId/unrouted-sheet-rows returns the row with
 *      existingLeadIdByPhone set to the existing lead's id even though
 *      the two phone strings are formatted differently.
 *   2. POST /unrouted-sheet-rows/:id/route-to-funnel for the same setup
 *      reports resubmitted: true and reuses the existing lead instead of
 *      creating a new one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

const dbModule = await import("@workspace/db");
const {
  db,
  tenantsTable,
  funnelTypesTable,
  tenantFunnelTypesTable,
  googleSheetConfigsTable,
  unroutedSheetRowsTable,
  leadsTable,
  callAttemptsTable,
} = dbModule;

// Silence socket / scheduler / round-robin side-effects so the test
// stays focused on the duplicate-detection contract.
vi.mock("../socket", () => ({
  emitNewLead: vi.fn(),
  emitLeadUpdated: vi.fn(),
  emitLeadResubmitted: vi.fn(),
  emitNewAttributionEvent: vi.fn(),
}));
vi.mock("../services/lead-notify-scheduler", () => ({
  scheduleOrEmitNewLead: vi.fn(),
}));
vi.mock("../services/auto-pass-scheduler", () => ({
  scheduleAutoPass: vi.fn(),
  cancelAutoPass: vi.fn(),
}));
vi.mock("../services/round-robin", () => ({
  assignLeadRoundRobin: vi.fn().mockResolvedValue({ assignedCsrId: null, reason: "no CSRs" }),
}));
vi.mock("../services/push-notification-jobs", () => ({
  enqueueSendPushToUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/lead-status-history", () => ({
  recordLeadStatusChange: vi.fn().mockResolvedValue(undefined),
}));

const unroutedMod = await import("./unrouted-sheet-rows");

interface Fx {
  tenantId: number;
  funnelTypeId: number;
  sheetConfigId: number;
  existingLeadId: number;
  unroutedRowId: number;
}

let fx: Fx;
let app: express.Express;

function makeApp(tenantId: number): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: 1,
      userRole: "super_admin",
      tenantId,
    };
    next();
  }, unroutedMod.default);
  return a;
}

function request(
  expressApp: express.Express,
  path: string,
  method: "GET" | "POST" = "GET",
  body: unknown = null,
): Promise<{ status: number; json: unknown }> {
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
          method,
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c.toString()));
          res.on("end", () => {
            server.close();
            let parsed: unknown = null;
            try { if (data) parsed = JSON.parse(data); }
            catch { parsed = { __raw: data.slice(0, 5000) }; }
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

const STORED_PHONE = "5551234567";       // existing lead — already normalized
const INCOMING_PHONE = "(555) 123-4567"; // unrouted row — different formatting

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const [tenant] = await db.insert(tenantsTable).values({
    name: `Unrouted Dup Phone Int ${stamp}`,
    clientSlug: `unrouted-dup-${stamp}`,
    leadIngestionMode: "sheets",
  }).returning();

  const [funnel] = await db.insert(funnelTypesTable).values({
    name: `Funnel-${stamp}`,
    slug: `funnel-${stamp}`,
  }).returning();
  await db.insert(tenantFunnelTypesTable).values({
    tenantId: tenant.id, funnelTypeId: funnel.id,
  });

  const [sheetConfig] = await db.insert(googleSheetConfigsTable).values({
    tenantId: tenant.id,
    name: `Sheet-${stamp}`,
    googleSheetId: `gsheet-${stamp}`,
    googleSheetTab: "Sheet1",
    columnMapping: {},
    mappingHeaders: [],
  }).returning();

  const [existing] = await db.insert(leadsTable).values({
    tenantId: tenant.id,
    firstName: "Existing",
    lastName: "Lead",
    phone: STORED_PHONE,
    source: "Manual",
    originalSource: "Manual",
    funnelId: funnel.id,
    hubStatus: "day_1",
    status: "new",
    dayInSequence: 1,
    contactPreferences: [],
  }).returning();

  const [unrouted] = await db.insert(unroutedSheetRowsTable).values({
    tenantId: tenant.id,
    sheetConfigId: sheetConfig.id,
    rowData: {
      firstName: "Dup",
      lastName: "Format",
      phone: INCOMING_PHONE,
      source: "Google Sheets",
    } as Record<string, string>,
    reason: "no_funnel_match",
    source: "sheet_sync",
  }).returning();

  fx = {
    tenantId: tenant.id,
    funnelTypeId: funnel.id,
    sheetConfigId: sheetConfig.id,
    existingLeadId: existing.id,
    unroutedRowId: unrouted.id,
  };
  app = makeApp(fx.tenantId);
});

afterAll(async () => {
  if (!fx) return;
  try {
    const leads = await db.select({ id: leadsTable.id })
      .from(leadsTable).where(eq(leadsTable.tenantId, fx.tenantId));
    const leadIds = leads.map(l => l.id);
    if (leadIds.length > 0) {
      await db.delete(callAttemptsTable).where(inArray(callAttemptsTable.leadId, leadIds));
    }
    await db.delete(unroutedSheetRowsTable).where(eq(unroutedSheetRowsTable.tenantId, fx.tenantId));
    await db.delete(leadsTable).where(eq(leadsTable.tenantId, fx.tenantId));
    await db.delete(googleSheetConfigsTable).where(eq(googleSheetConfigsTable.tenantId, fx.tenantId));
    await db.delete(tenantFunnelTypesTable).where(eq(tenantFunnelTypesTable.tenantId, fx.tenantId));
    await db.delete(funnelTypesTable).where(eq(funnelTypesTable.id, fx.funnelTypeId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("unrouted sheet rows — cross-format duplicate phone (real Postgres)", () => {
  it("GET hint surfaces existingLeadIdByPhone when formats differ", async () => {
    const res = await request(app, `/tenants/${fx.tenantId}/unrouted-sheet-rows`);
    expect(res.status).toBe(200);
    const rows = res.json as Array<{
      id: number;
      existingLeadIdByPhone: number | null;
      rowData: Record<string, string>;
    }>;
    const ours = rows.find(r => r.id === fx.unroutedRowId);
    expect(ours).toBeDefined();
    // Sanity: the row really does carry the differently-formatted phone.
    // If a future change normalizes incoming rowData on insert, this
    // assertion will catch it so the test can be updated intentionally
    // instead of silently no-op'ing the cross-format claim it makes.
    expect(ours!.rowData.phone).toBe(INCOMING_PHONE);
    expect(ours!.existingLeadIdByPhone).toBe(fx.existingLeadId);
  });

  it("POST /route-to-funnel resubmits the existing lead instead of creating a new one", async () => {
    const beforeCount = await db.select({ id: leadsTable.id })
      .from(leadsTable).where(eq(leadsTable.tenantId, fx.tenantId));

    const res = await request(
      app,
      `/unrouted-sheet-rows/${fx.unroutedRowId}/route-to-funnel`,
      "POST",
      { funnelId: fx.funnelTypeId },
    );
    expect(res.status).toBe(200);
    const body = res.json as {
      leadId: number | null;
      resubmitted?: boolean;
      unroutedRow: { resolvedLeadId: number | null; resolvedVia: string | null };
    };
    expect(body.resubmitted).toBe(true);
    expect(body.leadId).toBe(fx.existingLeadId);
    expect(body.unroutedRow.resolvedLeadId).toBe(fx.existingLeadId);
    expect(body.unroutedRow.resolvedVia).toBe("resubmission");

    // No new lead was inserted — the resubmission path reused the
    // existing record despite the phone-format mismatch.
    const afterCount = await db.select({ id: leadsTable.id })
      .from(leadsTable).where(eq(leadsTable.tenantId, fx.tenantId));
    expect(afterCount.length).toBe(beforeCount.length);
  });
});
