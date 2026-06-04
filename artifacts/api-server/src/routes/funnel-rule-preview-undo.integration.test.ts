/**
 * Real-Postgres integration test for the two remaining funnel-rule code paths
 * that run hand-written SQL but were covered only by faked-database tests
 * (Task #838).
 *
 * Tasks #836 and #837 added real-DB coverage for create / revert / re-point /
 * accept-suggestion after the revert path was found to crash on a hand-written
 * CTE that the mocked tests could not see (a stubbed `db.execute` returns
 * whatever you tell it, so an aliased-column / param-mismatch bug in the raw
 * SQL never surfaces). Two paths were still SQL-but-only-mocked:
 *
 *   1. Preview / dry-run — POST /{subdomain,route}-funnel-rules/preview runs a
 *      raw "candidates" CTE to count conflicts plus a dry-run backfill to count
 *      eligible events, all shown to the operator BEFORE they save. A dry-run
 *      must compute real counts without mutating any row.
 *   2. Force-override + undo — a force-override save mints an in-memory undo
 *      batch capturing each row's prior value, and POST /{...}/undo/:batchId
 *      restores the prior resolved_funnel / lead_type / funnel_id via UPDATEs
 *      grouped by prior value.
 *
 * Each test seeds a real dataset, drives the live route, and asserts both the
 * returned counts AND the actual database state — proving the raw SQL fired
 * correctly against Postgres and (for preview) left the data untouched.
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
  subdomainFunnelRulesTable,
  routeFunnelRulesTable,
  attributionEventsTable,
  leadsTable,
} = dbModule;

vi.mock("../socket", () => ({
  emitNewAttributionEvent: vi.fn(),
  emitNewLead: vi.fn(),
  emitLeadUpdated: vi.fn(),
}));

const routeRulesMod = await import("./route-funnel-rules");
const subdomainRulesMod = await import("./subdomain-funnel-rules");

interface TenantFx {
  tenantId: number;
  clientSlug: string;
  defaultFunnelId: number;
  defaultFunnelName: string;
  funnelAId: number;
  funnelAName: string;
  funnelBId: number;
  funnelBName: string;
}

let subFx: TenantFx;
let routeFx: TenantFx;
let subApp: express.Express;
let routeApp: express.Express;

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
  }, routeRulesMod.default, subdomainRulesMod.default);
  return a;
}

function request(
  expressApp: express.Express,
  path: string,
  body: unknown,
  method = "POST",
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

// Seed a lead + event whose resolved_funnel "fell through" to `fellThroughFunnel`
// (typically the tenant default) — eligible for a plain (non-force) backfill.
async function seedFellThrough(
  tenantId: number,
  pageUrl: string,
  fellThroughFunnel: string,
): Promise<{ leadId: number; eventId: number }> {
  const [lead] = await db.insert(leadsTable).values({
    tenantId,
    firstName: "FellThrough",
    lastName: "Ride",
    source: "test",
    leadType: fellThroughFunnel,
  }).returning();
  const [event] = await db.insert(attributionEventsTable).values({
    tenantId,
    eventType: "form_fill",
    pageUrl,
    resolvedFunnel: fellThroughFunnel,
    createdLeadId: lead.id,
  }).returning();
  return { leadId: lead.id, eventId: event.id };
}

// Seed a lead + event already TAGGED to a specific funnel (lead_type + funnel_id
// + resolved_funnel all set), as if a prior, unrelated correction had resolved
// them. A plain backfill leaves these alone; only force-override claims them.
async function seedTagged(
  tenantId: number,
  pageUrl: string,
  funnelName: string,
  funnelId: number,
): Promise<{ leadId: number; eventId: number }> {
  const [lead] = await db.insert(leadsTable).values({
    tenantId,
    firstName: "Tagged",
    lastName: "Ride",
    source: "test",
    leadType: funnelName,
    funnelId,
  }).returning();
  const [event] = await db.insert(attributionEventsTable).values({
    tenantId,
    eventType: "form_fill",
    pageUrl,
    resolvedFunnel: funnelName,
    createdLeadId: lead.id,
  }).returning();
  return { leadId: lead.id, eventId: event.id };
}

async function eventFunnel(id: number): Promise<string | null> {
  const [row] = await db
    .select({ resolvedFunnel: attributionEventsTable.resolvedFunnel })
    .from(attributionEventsTable)
    .where(eq(attributionEventsTable.id, id))
    .limit(1);
  return row?.resolvedFunnel ?? null;
}

async function leadRow(id: number): Promise<{
  leadType: string | null;
  funnelId: number | null;
} | null> {
  const [row] = await db
    .select({
      leadType: leadsTable.leadType,
      funnelId: leadsTable.funnelId,
    })
    .from(leadsTable)
    .where(eq(leadsTable.id, id))
    .limit(1);
  return row ?? null;
}

async function seedTenant(kind: string): Promise<TenantFx> {
  const stamp = `pu-${kind}`;
  const [tenant] = await db.insert(tenantsTable).values({
    name: `Preview/Undo Int ${stamp}`,
    clientSlug: `preview-undo-int-${stamp}`,
    leadIngestionMode: "sheets",
  }).returning();

  const [defaultFunnel] = await db.insert(funnelTypesTable).values({
    name: `Default-${stamp}`,
    slug: `default-${stamp}`,
  }).returning();
  const [funnelA] = await db.insert(funnelTypesTable).values({
    name: `Repair-${stamp}`,
    slug: `repair-${stamp}`,
  }).returning();
  const [funnelB] = await db.insert(funnelTypesTable).values({
    name: `Protect-${stamp}`,
    slug: `protect-${stamp}`,
  }).returning();

  // Insertion order defines the tenant default (lowest funnelTypeId first).
  await db.insert(tenantFunnelTypesTable).values({ tenantId: tenant.id, funnelTypeId: defaultFunnel.id });
  await db.insert(tenantFunnelTypesTable).values({ tenantId: tenant.id, funnelTypeId: funnelA.id });
  await db.insert(tenantFunnelTypesTable).values({ tenantId: tenant.id, funnelTypeId: funnelB.id });

  return {
    tenantId: tenant.id,
    clientSlug: `preview-undo-int-${stamp}`,
    defaultFunnelId: defaultFunnel.id,
    defaultFunnelName: defaultFunnel.name,
    funnelAId: funnelA.id,
    funnelAName: funnelA.name,
    funnelBId: funnelB.id,
    funnelBName: funnelB.name,
  };
}

async function cleanupTenant(fx: TenantFx | undefined): Promise<void> {
  if (!fx) return;
  try {
    await db.delete(attributionEventsTable).where(eq(attributionEventsTable.tenantId, fx.tenantId));
    await db.delete(leadsTable).where(eq(leadsTable.tenantId, fx.tenantId));
    await db.delete(routeFunnelRulesTable).where(eq(routeFunnelRulesTable.tenantId, fx.tenantId));
    await db.delete(subdomainFunnelRulesTable).where(eq(subdomainFunnelRulesTable.tenantId, fx.tenantId));
    await db.delete(tenantFunnelTypesTable).where(eq(tenantFunnelTypesTable.tenantId, fx.tenantId));
    await db.delete(funnelTypesTable).where(
      inArray(funnelTypesTable.id, [fx.defaultFunnelId, fx.funnelAId, fx.funnelBId]),
    );
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  subFx = await seedTenant("sub");
  routeFx = await seedTenant("route");
  subApp = makeApp(subFx.tenantId);
  routeApp = makeApp(routeFx.tenantId);
});

afterAll(async () => {
  await cleanupTenant(subFx);
  await cleanupTenant(routeFx);
  vi.restoreAllMocks();
});

describe("funnel-rule preview / dry-run (real Postgres)", () => {
  it("subdomain preview counts eligible + conflicting events without mutating any row", async () => {
    const subdomain = `preview-sub`;
    const pageUrl = `https://${subdomain}.example-int-test.com/p`;

    // One fell-through event (on the tenant default) — the plain dry-run
    // backfill should count this as eligible.
    const fell = await seedFellThrough(subFx.tenantId, pageUrl, subFx.defaultFunnelName);
    // One event already tagged to an UNRELATED funnel (B) — when previewing a
    // rule for funnel A this is a "conflict" the operator should be warned of,
    // and a non-force dry-run must NOT count it as eligible.
    const conflict = await seedTagged(subFx.tenantId, pageUrl, subFx.funnelBName, subFx.funnelBId);

    const res = await request(subApp, "/subdomain-funnel-rules/preview", {
      subdomain,
      funnelTypeId: subFx.funnelAId,
    });
    expect(res.status).toBe(200);
    expect(res.json.funnelName).toBe(subFx.funnelAName);
    // Eligible = the single fell-through event; conflict = the funnel-B event;
    // matched = both events on the subdomain.
    expect(res.json.updatedEventCount).toBe(1);
    expect(res.json.conflictingEventCount).toBe(1);
    expect(res.json.matchedEventCount).toBe(2);

    // Dry-run must NOT have touched a single row.
    expect(await eventFunnel(fell.eventId)).toBe(subFx.defaultFunnelName);
    expect(await eventFunnel(conflict.eventId)).toBe(subFx.funnelBName);
    const fellLead = await leadRow(fell.leadId);
    expect(fellLead?.leadType).toBe(subFx.defaultFunnelName);
    const conflictLead = await leadRow(conflict.leadId);
    expect(conflictLead?.leadType).toBe(subFx.funnelBName);
    expect(conflictLead?.funnelId).toBe(subFx.funnelBId);
  });

  it("subdomain force-override preview counts the conflict as eligible, still without mutating", async () => {
    const subdomain = `preview-force-sub`;
    const pageUrl = `https://${subdomain}.example-int-test.com/pf`;

    const fell = await seedFellThrough(subFx.tenantId, pageUrl, subFx.defaultFunnelName);
    const conflict = await seedTagged(subFx.tenantId, pageUrl, subFx.funnelBName, subFx.funnelBId);

    const res = await request(subApp, "/subdomain-funnel-rules/preview", {
      subdomain,
      funnelTypeId: subFx.funnelAId,
      forceOverride: true,
    });
    expect(res.status).toBe(200);
    expect(res.json.forceOverride).toBe(true);
    // With force-override the conflict becomes eligible too: both events.
    expect(res.json.updatedEventCount).toBe(2);
    expect(res.json.conflictingEventCount).toBe(1);
    expect(res.json.matchedEventCount).toBe(2);

    // Still a dry-run: nothing changed on disk.
    expect(await eventFunnel(fell.eventId)).toBe(subFx.defaultFunnelName);
    expect(await eventFunnel(conflict.eventId)).toBe(subFx.funnelBName);
    const conflictLead = await leadRow(conflict.leadId);
    expect(conflictLead?.leadType).toBe(subFx.funnelBName);
    expect(conflictLead?.funnelId).toBe(subFx.funnelBId);
  });

  it("route preview counts eligible + conflicting events without mutating any row", async () => {
    const routePath = `/preview-route`;
    const pageUrl = `https://www.example-int-test.com${routePath}`;

    const fell = await seedFellThrough(routeFx.tenantId, pageUrl, routeFx.defaultFunnelName);
    const conflict = await seedTagged(routeFx.tenantId, pageUrl, routeFx.funnelBName, routeFx.funnelBId);

    const res = await request(routeApp, "/route-funnel-rules/preview", {
      routePath,
      funnelTypeId: routeFx.funnelAId,
    });
    expect(res.status).toBe(200);
    expect(res.json.funnelName).toBe(routeFx.funnelAName);
    expect(res.json.updatedEventCount).toBe(2);
    expect(res.json.conflictingEventCount).toBe(1);
    expect(res.json.matchedEventCount).toBe(2);

    expect(await eventFunnel(fell.eventId)).toBe(routeFx.defaultFunnelName);
    expect(await eventFunnel(conflict.eventId)).toBe(routeFx.funnelBName);
    const conflictLead = await leadRow(conflict.leadId);
    expect(conflictLead?.leadType).toBe(routeFx.funnelBName);
    expect(conflictLead?.funnelId).toBe(routeFx.funnelBId);
  });
});

describe("funnel-rule force-override save + undo round trip (real Postgres)", () => {
  it("subdomain force-override moves an unrelated event, undo restores its exact prior values", async () => {
    const subdomain = `undo-sub`;
    const pageUrl = `https://${subdomain}.example-int-test.com/u`;

    // An event+lead already tagged to funnel B. A plain rule for funnel A would
    // leave it alone; force-override claims it.
    const moved = await seedTagged(subFx.tenantId, pageUrl, subFx.funnelBName, subFx.funnelBId);

    const saveRes = await request(subApp, "/subdomain-funnel-rules", {
      subdomain,
      funnelTypeId: subFx.funnelAId,
      forceOverride: true,
    });
    expect(saveRes.status).toBe(200);
    expect(saveRes.json.created).toBe(true);
    expect(saveRes.json.forceOverride).toBe(true);
    expect(saveRes.json.updatedEventCount).toBe(1);
    const batchId = saveRes.json.undoBatchId as string;
    expect(typeof batchId).toBe("string");
    expect(batchId.length).toBeGreaterThan(0);

    // The force-override moved the event off funnel B onto funnel A.
    expect(await eventFunnel(moved.eventId)).toBe(subFx.funnelAName);
    const movedLead = await leadRow(moved.leadId);
    expect(movedLead?.leadType).toBe(subFx.funnelAName);
    expect(movedLead?.funnelId).toBe(subFx.funnelAId);

    // Undo restores the EXACT prior resolved_funnel / lead_type / funnel_id.
    const undoRes = await request(
      subApp, `/subdomain-funnel-rules/undo/${batchId}`, null,
    );
    expect(undoRes.status).toBe(200);
    expect(undoRes.json.success).toBe(true);
    expect(undoRes.json.revertedEventCount).toBe(1);
    expect(undoRes.json.revertedLeadCount).toBe(1);

    expect(await eventFunnel(moved.eventId)).toBe(subFx.funnelBName);
    const restored = await leadRow(moved.leadId);
    expect(restored?.leadType).toBe(subFx.funnelBName);
    expect(restored?.funnelId).toBe(subFx.funnelBId);

    // The batch is single-use: a second undo must report the window passed.
    const undoAgain = await request(
      subApp, `/subdomain-funnel-rules/undo/${batchId}`, null,
    );
    expect(undoAgain.status).toBe(404);
  });

  it("route force-override moves an unrelated event, undo restores its exact prior values", async () => {
    const routePath = `/undo-route`;
    const pageUrl = `https://www.example-int-test.com${routePath}`;

    const moved = await seedTagged(routeFx.tenantId, pageUrl, routeFx.funnelBName, routeFx.funnelBId);

    const saveRes = await request(routeApp, "/route-funnel-rules", {
      routePath,
      funnelTypeId: routeFx.funnelAId,
      forceOverride: true,
    });
    expect(saveRes.status).toBe(200);
    expect(saveRes.json.created).toBe(true);
    expect(saveRes.json.forceOverride).toBe(true);
    expect(saveRes.json.updatedEventCount).toBe(1);
    const batchId = saveRes.json.undoBatchId as string;
    expect(typeof batchId).toBe("string");
    expect(batchId.length).toBeGreaterThan(0);

    expect(await eventFunnel(moved.eventId)).toBe(routeFx.funnelAName);
    const movedLead = await leadRow(moved.leadId);
    expect(movedLead?.leadType).toBe(routeFx.funnelAName);
    expect(movedLead?.funnelId).toBe(routeFx.funnelAId);

    const undoRes = await request(
      routeApp, `/route-funnel-rules/undo/${batchId}`, null,
    );
    expect(undoRes.status).toBe(200);
    expect(undoRes.json.success).toBe(true);
    expect(undoRes.json.revertedEventCount).toBe(1);
    expect(undoRes.json.revertedLeadCount).toBe(1);

    expect(await eventFunnel(moved.eventId)).toBe(routeFx.funnelBName);
    const restored = await leadRow(moved.leadId);
    expect(restored?.leadType).toBe(routeFx.funnelBName);
    expect(restored?.funnelId).toBe(routeFx.funnelBId);

    const undoAgain = await request(
      routeApp, `/route-funnel-rules/undo/${batchId}`, null,
    );
    expect(undoAgain.status).toBe(404);
  });
});
