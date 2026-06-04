/**
 * Real-Postgres integration test for the remaining funnel-rule actions that run
 * hand-written SQL (Task #837).
 *
 * Task #836 added real-DB coverage for the create and delete+revert actions
 * after the revert path was found to crash on a hand-written CTE that the
 * faked-database tests could not see (a mocked `db.execute` happily returns
 * whatever you tell it, so an aliased-column / param-mismatch bug in the raw
 * SQL never surfaces). The same blind spot still covered two actions:
 *
 *   1. Re-point — POST /{subdomain,route}-funnel-rules against an EXISTING rule
 *      with a different funnelTypeId. This drives the backfill's
 *      `priorFunnelName` branch, which reclaims events that previously matched
 *      the OLD rule's funnel and moves them to the new one (distinct from the
 *      plain create path, which only claims fell-through events).
 *   2. Accept-suggestion — GET /{...}-funnel-rules/suggestions (its own
 *      hand-written grouping CTE) to surface a suggested rule, then POST to
 *      accept it (create + backfill).
 *
 * Each test seeds a per-lead override ("Just this lead",
 * `leads.funnel_overridden_at`) plus a non-overridden control on the same
 * subdomain/route, drives the live route, and asserts the overridden lead/event
 * is left untouched while the control IS moved — proving the action actually
 * fired against the real database and the override guard is selective.
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
// (the tenant default). Used for control/overridden rows the backfill should
// claim (control) or skip (overridden).
async function seedFellThrough(
  tenantId: number,
  pageUrl: string,
  fellThroughFunnel: string,
  overridden: boolean,
): Promise<{ leadId: number; eventId: number }> {
  const [lead] = await db.insert(leadsTable).values({
    tenantId,
    firstName: overridden ? "Over" : "Control",
    lastName: "Ride",
    source: "test",
    funnelOverriddenAt: overridden ? new Date() : null,
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
// + resolved_funnel all set), as if a prior rule had resolved them.
async function seedTagged(
  tenantId: number,
  pageUrl: string,
  funnelName: string,
  funnelId: number,
  overridden: boolean,
): Promise<{ leadId: number; eventId: number }> {
  const [lead] = await db.insert(leadsTable).values({
    tenantId,
    firstName: overridden ? "Over" : "Control",
    lastName: "Ride",
    source: "test",
    funnelOverriddenAt: overridden ? new Date() : null,
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
  funnelOverriddenAt: Date | null;
} | null> {
  const [row] = await db
    .select({
      leadType: leadsTable.leadType,
      funnelId: leadsTable.funnelId,
      funnelOverriddenAt: leadsTable.funnelOverriddenAt,
    })
    .from(leadsTable)
    .where(eq(leadsTable.id, id))
    .limit(1);
  return row ?? null;
}

async function eventStatus(id: number): Promise<{
  matchLevel: string | null;
  matchConfidence: number | null;
  unmatchedReason: string | null;
  manualSource: string | null;
} | null> {
  const [row] = await db
    .select({
      matchLevel: attributionEventsTable.matchLevel,
      matchConfidence: attributionEventsTable.matchConfidence,
      unmatchedReason: attributionEventsTable.unmatchedReason,
      manualSource: attributionEventsTable.manualSource,
    })
    .from(attributionEventsTable)
    .where(eq(attributionEventsTable.id, id))
    .limit(1);
  return row ?? null;
}

async function seedTenant(kind: string): Promise<TenantFx> {
  const stamp = `rpa-${kind}`;
  const [tenant] = await db.insert(tenantsTable).values({
    name: `Repoint/Accept Int ${stamp}`,
    clientSlug: `repoint-accept-int-${stamp}`,
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
    clientSlug: `repoint-accept-int-${stamp}`,
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

describe("re-point an existing funnel rule (real Postgres)", () => {
  it("route create syncs already-route-resolved events onto leads and flips unmatched status", async () => {
    const routePath = `/already-route-resolved`;
    const pageUrl = `https://www.example-int-test.com${routePath}`;

    const [lead] = await db.insert(leadsTable).values({
      tenantId: routeFx.tenantId,
      firstName: "Already",
      lastName: "Resolved",
      source: "test",
      leadType: routeFx.defaultFunnelName,
      funnelId: routeFx.defaultFunnelId,
    }).returning();
    const [event] = await db.insert(attributionEventsTable).values({
      tenantId: routeFx.tenantId,
      eventType: "form_fill",
      pageUrl,
      resolvedFunnel: routeFx.funnelBName,
      createdLeadId: lead.id,
      matchLevel: "unmatched",
      matchConfidence: 0,
      unmatchedReason: "No match before route rule backfill",
    }).returning();

    const res = await request(routeApp, "/route-funnel-rules", {
      routePath,
      funnelTypeId: routeFx.funnelBId,
    });
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(true);
    expect(res.json.updatedEventCount).toBe(1);
    expect(res.json.updatedLeadCount).toBe(1);
    expect(res.json.manualMatchedEventCount).toBe(1);

    expect(await eventFunnel(event.id)).toBe(routeFx.funnelBName);
    const syncedLead = await leadRow(lead.id);
    expect(syncedLead?.leadType).toBe(routeFx.funnelBName);
    expect(syncedLead?.funnelId).toBe(routeFx.funnelBId);

    const status = await eventStatus(event.id);
    expect(status?.matchLevel).toBe("manual");
    expect(status?.matchConfidence).toBe(1);
    expect(status?.unmatchedReason).toBeNull();
    expect(status?.manualSource).toBe(`route_funnel_rule:${routePath}`);
  });

  it("route create fixes stale different-funnel events and leads without force override", async () => {
    const routePath = `/stale-route-funnel`;
    const pageUrl = `https://www.example-int-test.com${routePath}`;

    const stale = await seedTagged(routeFx.tenantId, pageUrl, routeFx.funnelAName, routeFx.funnelAId, false);

    const res = await request(routeApp, "/route-funnel-rules", {
      routePath,
      funnelTypeId: routeFx.funnelBId,
    });
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(true);
    expect(res.json.forceOverride).toBe(false);
    expect(res.json.updatedEventCount).toBe(1);
    expect(res.json.updatedLeadCount).toBe(1);

    expect(await eventFunnel(stale.eventId)).toBe(routeFx.funnelBName);
    const lead = await leadRow(stale.leadId);
    expect(lead?.leadType).toBe(routeFx.funnelBName);
    expect(lead?.funnelId).toBe(routeFx.funnelBId);
  });

  it("route reconcile fixes stale assignments for existing saved rules", async () => {
    const routePath = `/reconcile-route-funnel`;
    const pageUrl = `https://www.example-int-test.com${routePath}`;

    const stale = await seedTagged(routeFx.tenantId, pageUrl, routeFx.funnelAName, routeFx.funnelAId, false);
    await db.insert(routeFunnelRulesTable).values({
      tenantId: routeFx.tenantId,
      routePath,
      funnelTypeId: routeFx.funnelBId,
    });

    const res = await request(routeApp, "/route-funnel-rules/reconcile", {});
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.updatedEventCount).toBeGreaterThanOrEqual(1);
    expect(res.json.updatedLeadCount).toBeGreaterThanOrEqual(1);

    expect(await eventFunnel(stale.eventId)).toBe(routeFx.funnelBName);
    const lead = await leadRow(stale.leadId);
    expect(lead?.leadType).toBe(routeFx.funnelBName);
    expect(lead?.funnelId).toBe(routeFx.funnelBId);
  });

  it("route force-override undo restores prior event match fields", async () => {
    const routePath = `/force-undo-status-route`;
    const pageUrl = `https://www.example-int-test.com${routePath}`;
    const priorReason = "No match before route force override";
    const priorManualSource = "legacy-prior-source";

    const [lead] = await db.insert(leadsTable).values({
      tenantId: routeFx.tenantId,
      firstName: "Force",
      lastName: "Undo",
      source: "test",
      leadType: routeFx.funnelAName,
      funnelId: routeFx.funnelAId,
    }).returning();
    const [event] = await db.insert(attributionEventsTable).values({
      tenantId: routeFx.tenantId,
      eventType: "form_fill",
      pageUrl,
      resolvedFunnel: routeFx.funnelAName,
      createdLeadId: lead.id,
      matchLevel: "unmatched",
      matchConfidence: 0.37,
      unmatchedReason: priorReason,
      manualSource: priorManualSource,
    }).returning();

    const saveRes = await request(routeApp, "/route-funnel-rules", {
      routePath,
      funnelTypeId: routeFx.funnelBId,
      forceOverride: true,
    });
    expect(saveRes.status).toBe(200);
    expect(saveRes.json.updatedEventCount).toBe(1);
    expect(saveRes.json.manualMatchedEventCount).toBe(1);
    const batchId = saveRes.json.undoBatchId as string;
    expect(typeof batchId).toBe("string");
    expect(batchId.length).toBeGreaterThan(0);

    const movedStatus = await eventStatus(event.id);
    expect(await eventFunnel(event.id)).toBe(routeFx.funnelBName);
    expect(movedStatus?.matchLevel).toBe("manual");
    expect(movedStatus?.manualSource).toBe(`route_funnel_rule:${routePath}`);

    const undoRes = await request(
      routeApp,
      `/route-funnel-rules/undo/${encodeURIComponent(batchId)}`,
      null,
    );
    expect(undoRes.status).toBe(200);
    expect(undoRes.json.revertedEventCount).toBe(1);
    expect(undoRes.json.revertedLeadCount).toBe(1);

    expect(await eventFunnel(event.id)).toBe(routeFx.funnelAName);
    const restoredStatus = await eventStatus(event.id);
    expect(restoredStatus?.matchLevel).toBe("unmatched");
    expect(Number(restoredStatus?.matchConfidence)).toBeCloseTo(0.37, 5);
    expect(restoredStatus?.unmatchedReason).toBe(priorReason);
    expect(restoredStatus?.manualSource).toBe(priorManualSource);

    const restoredLead = await leadRow(lead.id);
    expect(restoredLead?.leadType).toBe(routeFx.funnelAName);
    expect(restoredLead?.funnelId).toBe(routeFx.funnelAId);
  });

  it("subdomain re-point moves the control off the prior funnel but leaves the override", async () => {
    const subdomain = `repoint-sub`;
    const pageUrl = `https://${subdomain}.example-int-test.com/r`;

    // Two leads+events already tagged to funnel A (the prior rule's funnel).
    const overridden = await seedTagged(subFx.tenantId, pageUrl, subFx.funnelAName, subFx.funnelAId, true);
    const control = await seedTagged(subFx.tenantId, pageUrl, subFx.funnelAName, subFx.funnelAId, false);

    // Existing rule points at funnel A; insert directly so no create-time
    // backfill runs — we only want to exercise the re-point branch.
    await db.insert(subdomainFunnelRulesTable).values({
      tenantId: subFx.tenantId,
      subdomain,
      funnelTypeId: subFx.funnelAId,
    });

    // Re-point the rule to funnel B.
    const res = await request(subApp, "/subdomain-funnel-rules", {
      subdomain,
      funnelTypeId: subFx.funnelBId,
    });
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(false);
    // Only the control event was eligible; the overridden one was skipped.
    expect(res.json.updatedEventCount).toBe(1);

    // Overridden lead/event stay pinned to funnel A.
    expect(await eventFunnel(overridden.eventId)).toBe(subFx.funnelAName);
    const oLead = await leadRow(overridden.leadId);
    expect(oLead?.leadType).toBe(subFx.funnelAName);
    expect(oLead?.funnelId).toBe(subFx.funnelAId);
    expect(oLead?.funnelOverriddenAt).not.toBeNull();

    // Control event/lead followed the rule from A → B (proves re-point fired).
    expect(await eventFunnel(control.eventId)).toBe(subFx.funnelBName);
    const cLead = await leadRow(control.leadId);
    expect(cLead?.leadType).toBe(subFx.funnelBName);
    expect(cLead?.funnelId).toBe(subFx.funnelBId);
  });

  it("route re-point moves the control off the prior funnel but leaves the override", async () => {
    const routePath = `/repoint-route`;
    const pageUrl = `https://www.example-int-test.com${routePath}`;

    const overridden = await seedTagged(routeFx.tenantId, pageUrl, routeFx.funnelAName, routeFx.funnelAId, true);
    const control = await seedTagged(routeFx.tenantId, pageUrl, routeFx.funnelAName, routeFx.funnelAId, false);

    await db.insert(routeFunnelRulesTable).values({
      tenantId: routeFx.tenantId,
      routePath,
      funnelTypeId: routeFx.funnelAId,
    });

    const res = await request(routeApp, "/route-funnel-rules", {
      routePath,
      funnelTypeId: routeFx.funnelBId,
    });
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(false);
    expect(res.json.updatedEventCount).toBe(1);

    expect(await eventFunnel(overridden.eventId)).toBe(routeFx.funnelAName);
    const oLead = await leadRow(overridden.leadId);
    expect(oLead?.leadType).toBe(routeFx.funnelAName);
    expect(oLead?.funnelId).toBe(routeFx.funnelAId);
    expect(oLead?.funnelOverriddenAt).not.toBeNull();

    expect(await eventFunnel(control.eventId)).toBe(routeFx.funnelBName);
    const cLead = await leadRow(control.leadId);
    expect(cLead?.leadType).toBe(routeFx.funnelBName);
    expect(cLead?.funnelId).toBe(routeFx.funnelBId);
  });
});

describe("accept a suggested funnel rule (real Postgres)", () => {
  it("subdomain suggestion is surfaced then accepted, claiming the control but not the override", async () => {
    const subdomain = `accept-sub`;
    const pageUrl = `https://${subdomain}.example-int-test.com/a`;

    // One non-default "signal" event makes the subdomain suggest funnel B
    // (reason: observed). Two fell-through rows give the accept-time backfill
    // something to claim: one control, one pinned override.
    const signal = await seedTagged(subFx.tenantId, pageUrl, subFx.funnelBName, subFx.funnelBId, false);
    const control = await seedFellThrough(subFx.tenantId, pageUrl, subFx.defaultFunnelName, false);
    const overridden = await seedFellThrough(subFx.tenantId, pageUrl, subFx.defaultFunnelName, true);

    // The suggestions endpoint runs its own hand-written grouping CTE.
    const sugRes = await request(subApp, "/subdomain-funnel-rules/suggestions", null, "GET");
    expect(sugRes.status).toBe(200);
    const suggestions = sugRes.json.suggestions as Array<{
      subdomain: string;
      suggestedFunnelTypeId: number;
      reason: string;
    }>;
    const suggestion = suggestions.find((s) => s.subdomain === subdomain);
    expect(suggestion).toBeDefined();
    expect(suggestion?.suggestedFunnelTypeId).toBe(subFx.funnelBId);
    expect(suggestion?.reason).toBe("observed");

    // Accept it via the existing create route.
    const res = await request(subApp, "/subdomain-funnel-rules", {
      subdomain,
      funnelTypeId: suggestion!.suggestedFunnelTypeId,
    });
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(true);
    expect(res.json.updatedEventCount).toBe(1);

    // Pinned override untouched.
    expect(await eventFunnel(overridden.eventId)).toBe(subFx.defaultFunnelName);
    const oLead = await leadRow(overridden.leadId);
    expect(oLead?.leadType).toBe(subFx.defaultFunnelName);
    expect(oLead?.funnelOverriddenAt).not.toBeNull();

    // Control fell-through row backfilled to the accepted funnel.
    expect(await eventFunnel(control.eventId)).toBe(subFx.funnelBName);
    const cLead = await leadRow(control.leadId);
    expect(cLead?.leadType).toBe(subFx.funnelBName);
    expect(cLead?.funnelId).toBe(subFx.funnelBId);

    // The signal event was already on funnel B and must be left as-is.
    expect(await eventFunnel(signal.eventId)).toBe(subFx.funnelBName);
  });

  it("route suggestion is surfaced then accepted, claiming the control but not the override", async () => {
    const routePath = `/accept-route`;
    const pageUrl = `https://www.example-int-test.com${routePath}`;

    const signal = await seedTagged(routeFx.tenantId, pageUrl, routeFx.funnelBName, routeFx.funnelBId, false);
    const control = await seedFellThrough(routeFx.tenantId, pageUrl, routeFx.defaultFunnelName, false);
    const overridden = await seedFellThrough(routeFx.tenantId, pageUrl, routeFx.defaultFunnelName, true);

    const sugRes = await request(routeApp, "/route-funnel-rules/suggestions", null, "GET");
    expect(sugRes.status).toBe(200);
    const suggestions = sugRes.json.suggestions as Array<{
      routePath: string;
      suggestedFunnelTypeId: number;
      reason: string;
    }>;
    const suggestion = suggestions.find((s) => s.routePath === routePath);
    expect(suggestion).toBeDefined();
    expect(suggestion?.suggestedFunnelTypeId).toBe(routeFx.funnelBId);
    expect(suggestion?.reason).toBe("observed");

    const res = await request(routeApp, "/route-funnel-rules", {
      routePath,
      funnelTypeId: suggestion!.suggestedFunnelTypeId,
    });
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(true);
    expect(res.json.updatedEventCount).toBe(1);

    expect(await eventFunnel(overridden.eventId)).toBe(routeFx.defaultFunnelName);
    const oLead = await leadRow(overridden.leadId);
    expect(oLead?.leadType).toBe(routeFx.defaultFunnelName);
    expect(oLead?.funnelOverriddenAt).not.toBeNull();

    expect(await eventFunnel(control.eventId)).toBe(routeFx.funnelBName);
    const cLead = await leadRow(control.leadId);
    expect(cLead?.leadType).toBe(routeFx.funnelBName);
    expect(cLead?.funnelId).toBe(routeFx.funnelBId);

    expect(await eventFunnel(signal.eventId)).toBe(routeFx.funnelBName);
  });
});
