/**
 * Real-Postgres integration test for the route-funnel waterfall step.
 *
 * Mirrors `subdomain-funnel-rules.integration.test.ts`, but for the
 * route/page-path rule layer added in Task #836. It boots a live Postgres
 * connection (via the global-setup harness), seeds a tenant + funnel types,
 * creates a route rule through the live POST route, fires a real HTTP POST
 * against `/collect/submit`, and asserts the persisted
 * `attribution_events.resolved_funnel` came from the route rule.
 *
 * Scenarios:
 *   1. POST /collect/submit with a page_url whose pathname matches the
 *      seeded route rule → the inserted attribution_events row's
 *      resolved_funnel is the target funnel name, NOT the tenant default.
 *   2. Route rules take precedence over subdomain rules: with both a
 *      subdomain rule and a route rule that point at different funnels,
 *      the more-specific route rule wins.
 *   3. DELETE the route rule via the live route, then POST another submit
 *      with the same page_url → the cache is invalidated and the new event
 *      falls through (here, to the subdomain rule that remains).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, and, inArray, desc } from "drizzle-orm";
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
vi.mock("../services/lead-notify-scheduler", () => ({
  scheduleOrEmitNewLead: vi.fn(),
}));
vi.mock("../services/auto-pass-scheduler", () => ({
  scheduleAutoPass: vi.fn(),
}));
vi.mock("../services/round-robin", () => ({
  assignLeadRoundRobin: vi.fn().mockResolvedValue({ assignedCsrId: null, reason: "no CSRs" }),
}));
vi.mock("../middleware/rate-limit", () => ({
  trackerSubmitLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  trackerHeartbeatLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const trackerMod = await import("./tracker");
const routeRulesMod = await import("./route-funnel-rules");
const subdomainRulesMod = await import("./subdomain-funnel-rules");

interface Fx {
  tenantId: number;
  clientSlug: string;
  defaultFunnelId: number;
  defaultFunnelName: string;
  routeFunnelId: number;
  routeFunnelName: string;
  subdomainFunnelId: number;
  subdomainFunnelName: string;
  subdomain: string;
  routePath: string;
  pageUrl: string;
}

let fx: Fx;
let app: express.Express;

function makeApp(tenantId: number): express.Express {
  const a = express();
  a.use(express.json());
  a.use(trackerMod.default);
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

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  const stamp = `rfr`;
  const slug = `route-int-${stamp}`;
  const subdomain = `protect-${stamp}`;
  const routePath = `/repair-${stamp}`;

  const [tenant] = await db.insert(tenantsTable).values({
    name: `Route Funnel Int ${stamp}`,
    clientSlug: slug,
    leadIngestionMode: "sheets",
  }).returning();

  const [defaultFunnel] = await db.insert(funnelTypesTable).values({
    name: `Default-${stamp}`,
    slug: `default-${stamp}`,
  }).returning();
  const [routeFunnel] = await db.insert(funnelTypesTable).values({
    name: `Repair-${stamp}`,
    slug: `repair-${stamp}`,
  }).returning();
  const [subdomainFunnel] = await db.insert(funnelTypesTable).values({
    name: `Protect-${stamp}`,
    slug: `protect-${stamp}`,
  }).returning();

  await db.insert(tenantFunnelTypesTable).values({
    tenantId: tenant.id, funnelTypeId: defaultFunnel.id,
  });
  await db.insert(tenantFunnelTypesTable).values({
    tenantId: tenant.id, funnelTypeId: routeFunnel.id,
  });
  await db.insert(tenantFunnelTypesTable).values({
    tenantId: tenant.id, funnelTypeId: subdomainFunnel.id,
  });

  fx = {
    tenantId: tenant.id,
    clientSlug: slug,
    defaultFunnelId: defaultFunnel.id,
    defaultFunnelName: defaultFunnel.name,
    routeFunnelId: routeFunnel.id,
    routeFunnelName: routeFunnel.name,
    subdomainFunnelId: subdomainFunnel.id,
    subdomainFunnelName: subdomainFunnel.name,
    subdomain,
    routePath,
    pageUrl: `https://${subdomain}.example-int-test.com${routePath}`,
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
      inArray(funnelTypesTable.id, [fx.defaultFunnelId, fx.routeFunnelId, fx.subdomainFunnelId]),
    );
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

async function latestEventResolvedFunnel(tenantId: number): Promise<string | null> {
  const [row] = await db
    .select({
      id: attributionEventsTable.id,
      resolvedFunnel: attributionEventsTable.resolvedFunnel,
      pageUrl: attributionEventsTable.pageUrl,
    })
    .from(attributionEventsTable)
    .where(eq(attributionEventsTable.tenantId, tenantId))
    .orderBy(desc(attributionEventsTable.id))
    .limit(1);
  return row?.resolvedFunnel ?? null;
}

describe("route rule → /collect/submit (real Postgres)", () => {
  it("seeds a route rule and the next submit resolves the funnel from the path", async () => {
    const { resolveRouteFunnel } = await import("../services/route-funnel-resolver");
    const createRes = await postJson(app, "/route-funnel-rules", {
      routePath: fx.routePath,
      funnelTypeId: fx.routeFunnelId,
    });
    expect(createRes.status).toBe(200);
    expect(createRes.json.created).toBe(true);
    expect((createRes.json.rule as { funnelTypeId: number }).funnelTypeId).toBe(fx.routeFunnelId);

    const direct = await resolveRouteFunnel(fx.tenantId, fx.pageUrl);
    expect(direct?.funnelTypeId).toBe(fx.routeFunnelId);

    const submitRes = await postJson(app, "/collect/submit", {
      client_id: fx.clientSlug,
      attribution: {},
      fields: { email: `route-e2e@example.com` },
      page_url: fx.pageUrl,
    });
    expect(submitRes.status).toBe(200);
    expect(submitRes.json.success).toBe(true);

    const stored = await latestEventResolvedFunnel(fx.tenantId);
    expect(stored).toBe(fx.routeFunnelName);
    expect(stored).not.toBe(fx.defaultFunnelName);
  });

  it("route rule wins over a subdomain rule on the same page_url", async () => {
    // Seed a subdomain rule pointing at a DIFFERENT funnel. Route rules are
    // more specific and must take precedence in the ingestion waterfall.
    const createSub = await postJson(app, "/subdomain-funnel-rules", {
      subdomain: fx.subdomain,
      funnelTypeId: fx.subdomainFunnelId,
    });
    expect(createSub.status).toBe(200);

    const submitRes = await postJson(app, "/collect/submit", {
      client_id: fx.clientSlug,
      attribution: {},
      fields: { email: `route-wins@example.com` },
      page_url: fx.pageUrl,
    });
    expect(submitRes.status).toBe(200);

    const stored = await latestEventResolvedFunnel(fx.tenantId);
    expect(stored).toBe(fx.routeFunnelName);
    expect(stored).not.toBe(fx.subdomainFunnelName);
  });

  it("falls through to the subdomain rule after the route rule is deleted (cache invalidated)", async () => {
    const [rule] = await db
      .select({ id: routeFunnelRulesTable.id })
      .from(routeFunnelRulesTable)
      .where(and(
        eq(routeFunnelRulesTable.tenantId, fx.tenantId),
        eq(routeFunnelRulesTable.routePath, fx.routePath),
      ));
    expect(rule).toBeDefined();

    const delRes = await postJson(app, `/route-funnel-rules/${rule.id}`, null, "DELETE");
    expect(delRes.status).toBe(200);
    expect(delRes.json.success).toBe(true);

    const submitRes = await postJson(app, "/collect/submit", {
      client_id: fx.clientSlug,
      attribution: {},
      fields: { email: `route-after-delete@example.com` },
      page_url: fx.pageUrl,
    });
    expect(submitRes.status).toBe(200);

    // Route rule gone + cache invalidated → the subdomain rule (still
    // present) now resolves the funnel. If DELETE forgot to invalidate the
    // route resolver cache, the stale route map would still win and this
    // assertion would fail.
    const stored = await latestEventResolvedFunnel(fx.tenantId);
    expect(stored).toBe(fx.subdomainFunnelName);
    expect(stored).not.toBe(fx.routeFunnelName);
  });
});
