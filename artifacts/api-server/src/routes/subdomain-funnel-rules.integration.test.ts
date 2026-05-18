/**
 * Real-Postgres integration test for the subdomain-funnel waterfall step.
 *
 * The unit suite in `tracker-funnel-waterfall.test.ts` covers each step of
 * the resolver waterfall in isolation with mocked database calls. This
 * file boots a live Postgres connection (via the existing global-setup
 * harness), seeds a tenant + funnel types + subdomain rule, fires a real
 * HTTP POST against `/collect/submit`, and asserts the persisted
 * `attribution_events.resolved_funnel` came from the subdomain rule.
 *
 * Why end-to-end: the unit tests can't exercise the regex SQL backfill,
 * the in-process resolver cache, or the real Drizzle query plan against
 * Postgres semantics (e.g. lower()/regexp_replace on page_url). A bug in
 * any of those would slip past the mocked suite — exactly the regression
 * this file is built to catch.
 *
 * Scenarios:
 *   1. POST /collect/submit with a page_url whose subdomain matches the
 *      seeded rule → the inserted attribution_events row's resolved_funnel
 *      is the target funnel name, NOT the tenant default.
 *   2. DELETE the rule via the live route, then POST another submit with
 *      the same page_url → the cache is invalidated and the new event
 *      falls through to the tenant default funnel.
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
  attributionEventsTable,
  leadsTable,
} = dbModule;

// Silence the socket/notify side-effects of the tracker so the test
// doesn't try to open sockets or schedule timers.
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
// Bypass the 60 req/min limiter so the test never flakes when run in a
// crowded suite — it would otherwise tie the rate-limit budget to wall-
// clock state shared across files.
vi.mock("../middleware/rate-limit", () => ({
  trackerSubmitLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  trackerHeartbeatLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const trackerMod = await import("./tracker");
const rulesMod = await import("./subdomain-funnel-rules");

interface Fx {
  tenantId: number;
  clientSlug: string;
  defaultFunnelId: number;
  defaultFunnelName: string;
  targetFunnelId: number;
  targetFunnelName: string;
  subdomain: string;
  pageUrl: string;
}

let fx: Fx;
let app: express.Express;

function makeApp(tenantId: number): express.Express {
  const a = express();
  a.use(express.json());
  // Mount the tracker router (public, no auth) and the rules router with
  // an injected super_admin session so the DELETE handler — which gates
  // on manager role + tenant scope — is exercisable from the test.
  a.use(trackerMod.default);
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: 1,
      userRole: "super_admin",
      tenantId,
    };
    next();
  }, rulesMod.default);
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
              // Non-JSON response (e.g. express HTML 500 page) — surface
              // a trimmed copy so a failing assertion has something
              // actionable to print instead of "Unexpected token <".
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

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const slug = `sub-int-${stamp}`;
  const subdomain = `protect-${stamp}`;

  const [tenant] = await db.insert(tenantsTable).values({
    name: `Subdomain Funnel Int ${stamp}`,
    clientSlug: slug,
    // `tracker` mode would try to create a lead — keep that path off so
    // the test stays focused on the attribution_events row the resolver
    // actually writes.
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

  // Order matters: the resolver's default-funnel lookup picks the
  // tenant_funnel_types association with the lowest funnelTypeId. Insert
  // default first so it wins the "default" slot.
  await db.insert(tenantFunnelTypesTable).values({
    tenantId: tenant.id, funnelTypeId: defaultFunnel.id,
  });
  await db.insert(tenantFunnelTypesTable).values({
    tenantId: tenant.id, funnelTypeId: targetFunnel.id,
  });

  fx = {
    tenantId: tenant.id,
    clientSlug: slug,
    defaultFunnelId: defaultFunnel.id,
    defaultFunnelName: defaultFunnel.name,
    targetFunnelId: targetFunnel.id,
    targetFunnelName: targetFunnel.name,
    subdomain,
    pageUrl: `https://${subdomain}.example-int-test.com/quote`,
  };
  app = makeApp(fx.tenantId);
});

afterAll(async () => {
  if (!fx) return;
  try {
    await db.delete(attributionEventsTable).where(eq(attributionEventsTable.tenantId, fx.tenantId));
    await db.delete(leadsTable).where(eq(leadsTable.tenantId, fx.tenantId));
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

describe("subdomain rule → /collect/submit (real Postgres)", () => {
  it("seeds a rule and the next submit resolves the funnel from the subdomain", async () => {
    // Create the rule through the live POST route so this test also
    // regression-covers the route's backfill query — a prior bug aliased
    // attribution_events as `ae` in a CTE but referenced the unaliased
    // table name in the host-extraction expression, causing Postgres
    // to return "invalid reference to FROM-clause entry" and the POST
    // to 500. Going through the route here keeps that fix honest.
    const { resolveSubdomainFunnel } =
      await import("../services/subdomain-funnel-resolver");
    const createRes = await postJson(app, "/subdomain-funnel-rules", {
      subdomain: fx.subdomain,
      funnelTypeId: fx.targetFunnelId,
    });
    expect(createRes.status).toBe(200);
    expect(createRes.json.created).toBe(true);
    expect((createRes.json.rule as { funnelTypeId: number }).funnelTypeId).toBe(fx.targetFunnelId);

    // Sanity: the resolver agrees the seeded rule is reachable from
    // the same page_url shape the submit will send. If this fails, the
    // submit-level assertion below would still fail but with a more
    // confusing message about a missing event row.
    const direct = await resolveSubdomainFunnel(fx.tenantId, fx.pageUrl);
    expect(direct?.funnelTypeId).toBe(fx.targetFunnelId);

    const submitRes = await postJson(app, "/collect/submit", {
      client_id: fx.clientSlug,
      attribution: {},
      fields: { email: `e2e-${Date.now()}@example.com` },
      page_url: fx.pageUrl,
    });
    expect(submitRes.status).toBe(200);
    expect(submitRes.json.success).toBe(true);

    // The persisted row — not the in-memory response — is the contract.
    // If a future refactor swaps the resolver out and forgets to update
    // the column write, the response could still look "ok" while the
    // stored event reverts to the tenant default.
    const stored = await latestEventResolvedFunnel(fx.tenantId);
    expect(stored).toBe(fx.targetFunnelName);
    expect(stored).not.toBe(fx.defaultFunnelName);
  });

  it("falls back to the tenant default funnel after the rule is deleted (cache invalidated)", async () => {
    // Find the rule id we created above.
    const [rule] = await db
      .select({ id: subdomainFunnelRulesTable.id })
      .from(subdomainFunnelRulesTable)
      .where(and(
        eq(subdomainFunnelRulesTable.tenantId, fx.tenantId),
        eq(subdomainFunnelRulesTable.subdomain, fx.subdomain),
      ));
    expect(rule).toBeDefined();

    const delRes = await postJson(app, `/subdomain-funnel-rules/${rule.id}`, null, "DELETE");
    expect(delRes.status).toBe(200);
    expect(delRes.json.success).toBe(true);

    // Same page_url as the first submit. With the rule gone AND the
    // resolver cache invalidated by DELETE, the waterfall must fall all
    // the way through to the tenant's default funnel. If DELETE
    // forgot to call invalidateSubdomainFunnelCache, the cached map
    // would still resolve to the target funnel and this assertion would
    // fail — which is exactly the regression we want to catch.
    const submitRes = await postJson(app, "/collect/submit", {
      client_id: fx.clientSlug,
      attribution: {},
      fields: { email: `e2e-after-delete-${Date.now()}@example.com` },
      page_url: fx.pageUrl,
    });
    expect(submitRes.status).toBe(200);

    const stored = await latestEventResolvedFunnel(fx.tenantId);
    expect(stored).toBe(fx.defaultFunnelName);
    expect(stored).not.toBe(fx.targetFunnelName);
  });
});
