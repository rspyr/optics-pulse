/**
 * Real-Postgres integration test for the per-lead override guard (Task #836).
 *
 * The bug: a per-lead funnel override ("Just this lead", recorded as
 * `leads.funnel_overridden_at`) could be silently clobbered when an operator
 * later created or re-pointed a coarser subdomain rule whose backfill swept up
 * the overridden lead's attribution events. The fix guards both the subdomain
 * AND the new route backfill/revert paths to skip any event whose
 * `created_lead_id` belongs to a lead with `funnel_overridden_at` set.
 *
 * This test seeds an overridden lead + a fell-through attribution event on a
 * matching page_url, then drives the live rule-create routes and asserts the
 * overridden lead's event resolved_funnel is left untouched, while a
 * NON-overridden control event on the same subdomain/path IS backfilled.
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

interface Fx {
  tenantId: number;
  clientSlug: string;
  defaultFunnelId: number;
  defaultFunnelName: string;
  targetFunnelId: number;
  targetFunnelName: string;
  subdomain: string;
  routePath: string;
  pageUrl: string;
  overriddenLeadId: number;
  overriddenEventId: number;
  controlLeadId: number;
  controlEventId: number;
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
  }, routeRulesMod.default, subdomainRulesMod.default);
  return a;
}

function postJson(
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

async function seedLeadAndEvent(
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
    // A per-lead override pins the lead's funnel; the guard keys off this column.
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
// + resolved_funnel all set), used for revert coverage where the revert path
// reclaims rows that currently carry the (deleted) rule's funnel name.
async function seedTaggedLeadAndEvent(
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

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  const stamp = `ovr`;
  const slug = `override-int-${stamp}`;
  const subdomain = `protect-${stamp}`;
  const routePath = `/repair-${stamp}`;

  const [tenant] = await db.insert(tenantsTable).values({
    name: `Override Guard Int ${stamp}`,
    clientSlug: slug,
    leadIngestionMode: "sheets",
  }).returning();

  const [defaultFunnel] = await db.insert(funnelTypesTable).values({
    name: `Default-${stamp}`,
    slug: `default-${stamp}`,
  }).returning();
  const [targetFunnel] = await db.insert(funnelTypesTable).values({
    name: `Protect-${stamp}`,
    slug: `protect-${stamp}`,
  }).returning();

  await db.insert(tenantFunnelTypesTable).values({
    tenantId: tenant.id, funnelTypeId: defaultFunnel.id,
  });
  await db.insert(tenantFunnelTypesTable).values({
    tenantId: tenant.id, funnelTypeId: targetFunnel.id,
  });

  const pageUrl = `https://${subdomain}.example-int-test.com${routePath}`;

  const overridden = await seedLeadAndEvent(tenant.id, pageUrl, defaultFunnel.name, true);
  const control = await seedLeadAndEvent(tenant.id, pageUrl, defaultFunnel.name, false);

  fx = {
    tenantId: tenant.id,
    clientSlug: slug,
    defaultFunnelId: defaultFunnel.id,
    defaultFunnelName: defaultFunnel.name,
    targetFunnelId: targetFunnel.id,
    targetFunnelName: targetFunnel.name,
    subdomain,
    routePath,
    pageUrl,
    overriddenLeadId: overridden.leadId,
    overriddenEventId: overridden.eventId,
    controlLeadId: control.leadId,
    controlEventId: control.eventId,
  };
  app = makeApp(fx.tenantId);
});

afterAll(async () => {
  if (!fx) return;
  try {
    await db.delete(attributionEventsTable).where(eq(attributionEventsTable.tenantId, fx.tenantId));
    await db.delete(leadsTable).where(eq(leadsTable.tenantId, fx.tenantId));
    await db.delete(routeFunnelRulesTable).where(eq(routeFunnelRulesTable.tenantId, fx.tenantId));
    await db.delete(subdomainFunnelRulesTable).where(eq(subdomainFunnelRulesTable.tenantId, fx.tenantId));
    await db.delete(tenantFunnelTypesTable).where(eq(tenantFunnelTypesTable.tenantId, fx.tenantId));
    await db.delete(funnelTypesTable).where(
      inArray(funnelTypesTable.id, [fx.defaultFunnelId, fx.targetFunnelId]),
    );
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("per-lead override survives rule backfill (real Postgres)", () => {
  it("subdomain rule create skips the overridden lead's event but claims the control", async () => {
    const createRes = await postJson(app, "/subdomain-funnel-rules", {
      subdomain: fx.subdomain,
      funnelTypeId: fx.targetFunnelId,
    });
    expect(createRes.status).toBe(200);
    expect(createRes.json.created).toBe(true);

    // The pinned lead's event must NOT have moved to the rule's funnel.
    const overridden = await eventFunnel(fx.overriddenEventId);
    expect(overridden).toBe(fx.defaultFunnelName);
    expect(overridden).not.toBe(fx.targetFunnelName);

    // The non-overridden control event SHOULD have been backfilled — this
    // proves the rule fired and the guard is selective, not a no-op.
    const control = await eventFunnel(fx.controlEventId);
    expect(control).toBe(fx.targetFunnelName);

    // The pinned lead row itself must keep its fall-through lead_type and its
    // override marker — the guard protects the lead, not just the event.
    const lead = await leadRow(fx.overriddenLeadId);
    expect(lead?.leadType).toBe(fx.defaultFunnelName);
    expect(lead?.funnelOverriddenAt).not.toBeNull();
  });

  it("route rule create also skips the overridden lead's event", async () => {
    // Reset the control event back to the fall-through funnel so the route
    // rule has something to claim and we re-prove the guard independently.
    await db
      .update(attributionEventsTable)
      .set({ resolvedFunnel: fx.defaultFunnelName })
      .where(eq(attributionEventsTable.id, fx.controlEventId));

    const createRes = await postJson(app, "/route-funnel-rules", {
      routePath: fx.routePath,
      funnelTypeId: fx.targetFunnelId,
    });
    expect(createRes.status).toBe(200);
    expect(createRes.json.created).toBe(true);

    const overridden = await eventFunnel(fx.overriddenEventId);
    expect(overridden).toBe(fx.defaultFunnelName);
    expect(overridden).not.toBe(fx.targetFunnelName);

    const control = await eventFunnel(fx.controlEventId);
    expect(control).toBe(fx.targetFunnelName);
  });
});

describe("per-lead override survives rule delete+revert (real Postgres)", () => {
  it("subdomain revert leaves the overridden lead/event but reverts the control", async () => {
    // Seed two leads+events already TAGGED to the target funnel (as if a
    // subdomain rule had previously resolved them). One is pinned with a
    // per-lead override, the other is a plain control.
    const overridden = await seedTaggedLeadAndEvent(
      fx.tenantId, fx.pageUrl, fx.targetFunnelName, fx.targetFunnelId, true,
    );
    const control = await seedTaggedLeadAndEvent(
      fx.tenantId, fx.pageUrl, fx.targetFunnelName, fx.targetFunnelId, false,
    );

    // Insert the rule directly so the create-time backfill doesn't interfere;
    // we only care about the delete+revert path here. Clear any rule left by
    // the earlier create-block tests first (same subdomain → unique conflict).
    await db.delete(subdomainFunnelRulesTable)
      .where(eq(subdomainFunnelRulesTable.tenantId, fx.tenantId));
    const [rule] = await db.insert(subdomainFunnelRulesTable).values({
      tenantId: fx.tenantId,
      subdomain: fx.subdomain,
      funnelTypeId: fx.targetFunnelId,
    }).returning();

    const delRes = await postJson(
      app, `/subdomain-funnel-rules/${rule.id}?revertEvents=true`, null, "DELETE",
    );
    expect(delRes.status).toBe(200);
    expect(delRes.json.reverted).toBe(true);

    // Overridden event + lead are left exactly as pinned.
    expect(await eventFunnel(overridden.eventId)).toBe(fx.targetFunnelName);
    const oLead = await leadRow(overridden.leadId);
    expect(oLead?.leadType).toBe(fx.targetFunnelName);
    expect(oLead?.funnelId).toBe(fx.targetFunnelId);
    expect(oLead?.funnelOverriddenAt).not.toBeNull();

    // Control event + lead are reverted to the tenant default — proving the
    // revert actually fired and the guard is selective, not a blanket skip.
    expect(await eventFunnel(control.eventId)).toBe(fx.defaultFunnelName);
    const cLead = await leadRow(control.leadId);
    expect(cLead?.leadType).toBe(fx.defaultFunnelName);
    expect(cLead?.funnelId).toBe(fx.defaultFunnelId);
  });

  it("route revert leaves the overridden lead/event but reverts the control", async () => {
    const overridden = await seedTaggedLeadAndEvent(
      fx.tenantId, fx.pageUrl, fx.targetFunnelName, fx.targetFunnelId, true,
    );
    const control = await seedTaggedLeadAndEvent(
      fx.tenantId, fx.pageUrl, fx.targetFunnelName, fx.targetFunnelId, false,
    );

    await db.delete(routeFunnelRulesTable)
      .where(eq(routeFunnelRulesTable.tenantId, fx.tenantId));
    const [rule] = await db.insert(routeFunnelRulesTable).values({
      tenantId: fx.tenantId,
      routePath: fx.routePath,
      funnelTypeId: fx.targetFunnelId,
    }).returning();

    const delRes = await postJson(
      app, `/route-funnel-rules/${rule.id}?revertEvents=true`, null, "DELETE",
    );
    expect(delRes.status).toBe(200);
    expect(delRes.json.reverted).toBe(true);

    expect(await eventFunnel(overridden.eventId)).toBe(fx.targetFunnelName);
    const oLead = await leadRow(overridden.leadId);
    expect(oLead?.leadType).toBe(fx.targetFunnelName);
    expect(oLead?.funnelId).toBe(fx.targetFunnelId);
    expect(oLead?.funnelOverriddenAt).not.toBeNull();

    expect(await eventFunnel(control.eventId)).toBe(fx.defaultFunnelName);
    const cLead = await leadRow(control.leadId);
    expect(cLead?.leadType).toBe(fx.defaultFunnelName);
    expect(cLead?.funnelId).toBe(fx.defaultFunnelId);
  });
});
