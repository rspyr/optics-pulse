/**
 * Real-Postgres integration coverage for **tenant isolation** on the agency-only
 * manual job→lead matching surface of the drilldown router:
 *
 *   GET   /drilldown/leads/search   (lead typeahead, scoped to query.tenantId)
 *   PATCH /drilldown/jobs/:id/lead  (attach/clear a job's lead)
 *
 * The sibling unit test (`drilldown-leads-search-match.test.ts`) mocks the db,
 * so the tenant-scoping WHERE clauses (`leads.tenant_id = ?` on the search, the
 * `lead.tenantId !== job.tenantId` guard on the PATCH) are only ever exercised
 * symbolically — the mock returns whatever rows it is told to regardless of the
 * predicate. That cannot prove the live SQL actually prevents one agency client
 * from reaching another client's data. This is the highest-risk correctness
 * property of the manual-match tools: a search must never surface another
 * tenant's leads, and a match must never bind a job to a cross-tenant lead.
 *
 * This file seeds TWO tenants, each with leads (sharing a common surname so the
 * typeahead term matches both, plus a tenant-distinctive name) and completed
 * jobs, then asserts against real Postgres that:
 *   - /drilldown/leads/search?tenantId=A never returns tenant B's leads (and B
 *     never returns A's), even for a term that matches leads in both tenants
 *   - a tenant-distinctive name is invisible to the other tenant's search
 *   - PATCH attaching a job to a SAME-tenant lead succeeds (control)
 *   - PATCH attaching a job to a CROSS-tenant lead is rejected 404 and leaves
 *     the job's leadId untouched
 *   - a tenant-scoped role (client_admin) cannot mutate another tenant's job
 *     (403) and the job is left untouched
 *   - non-agency roles get 403 on both endpoints (no DB mutation)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

const dbModule = await import("@workspace/db");
const { db, tenantsTable, leadsTable, jobsTable } = dbModule;
const routerMod = await import("./drilldown");

// Common surname shared by a lead in BOTH tenants so a single typeahead term
// matches across the tenant boundary — the partition must be by tenant_id, not
// by name. The searches below are tenant-scoped and assert on specific seeded
// ids, so a stable surname is safe on the empty per-run DB.
const SHARED_SURNAME = `Sharedsurname`;
const A_DISTINCT_NAME = `AonlyName`;
const B_DISTINCT_NAME = `BonlyName`;

interface TenantFx {
  tenantId: number;
  leadIds: number[];
  jobIds: number[];
  // The lead carrying SHARED_SURNAME for this tenant.
  sharedLeadId: number;
  // The lead carrying the tenant-distinctive name.
  distinctLeadId: number;
  // A completed job seeded for this tenant (starts unmatched).
  jobId: number;
}

let A: TenantFx;
let B: TenantFx;

// Each app pins a session (role + tenantId). `super_admin` with a null session
// tenant is the agency operator and takes its scope from query.tenantId;
// `client_admin` is tenant-scoped and is the non-agency caller under test.
function makeApp(session: { userRole: string; tenantId: number | null }): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: 1,
      userRole: session.userRole,
      tenantId: session.tenantId,
    };
    next();
  });
  a.use(routerMod.default);
  return a;
}

function send(
  expressApp: express.Express,
  method: string,
  reqPath: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: reqPath,
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
            resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null });
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const getJson = (a: express.Express, p: string) => send(a, "GET", p);
const patchJson = (a: express.Express, p: string, body: unknown) => send(a, "PATCH", p, body);

type SearchRow = { id: number; firstName: string; lastName: string };

/**
 * Seeds one tenant with:
 *   - a lead whose last name is SHARED_SURNAME (matches across tenants)
 *   - a lead whose first name is the tenant-distinctive name
 *   - a completed, initially-unmatched job
 */
async function seedTenant(opts: { label: string; distinctName: string }): Promise<TenantFx> {
  const slug = `match-iso-${opts.label}`;
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ name: `Match Iso ${slug}`, clientSlug: slug })
    .returning();

  const mkLead = async (firstName: string, lastName: string) => {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        tenantId: tenant.id,
        firstName,
        lastName,
        source: "Google",
        originalSource: "Google",
      })
      .returning();
    return lead;
  };

  const sharedLead = await mkLead(`Person${opts.label}`, SHARED_SURNAME);
  const distinctLead = await mkLead(opts.distinctName, `Last${opts.label}`);

  const [job] = await db
    .insert(jobsTable)
    .values({
      tenantId: tenant.id,
      jobType: "hvac",
      jobTypeName: "HVAC",
      status: "completed",
      revenue: 1000,
      invoiceTotal: 1000,
      invoiceRebateAmount: 0,
      customerName: `Customer ${slug}`,
    })
    .returning();

  return {
    tenantId: tenant.id,
    leadIds: [sharedLead.id, distinctLead.id],
    jobIds: [job.id],
    sharedLeadId: sharedLead.id,
    distinctLeadId: distinctLead.id,
    jobId: job.id,
  };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  A = await seedTenant({ label: "a", distinctName: A_DISTINCT_NAME });
  B = await seedTenant({ label: "b", distinctName: B_DISTINCT_NAME });
});

afterAll(async () => {
  const cleanup = async (fx: TenantFx | undefined) => {
    if (!fx) return;
    try {
      await db.delete(jobsTable).where(inArray(jobsTable.id, fx.jobIds));
      await db.delete(leadsTable).where(inArray(leadsTable.id, fx.leadIds));
      await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
    } catch {
      /* best-effort cleanup */
    }
  };
  await cleanup(A);
  await cleanup(B);
  vi.restoreAllMocks();
});

// super_admin app: the agency operator. Scope is driven purely by query.tenantId.
const adminApp = () => makeApp({ userRole: "super_admin", tenantId: null });

describe("GET /drilldown/leads/search — tenant isolation (real Postgres)", () => {
  it("a term matching leads in BOTH tenants returns only tenant A's lead when scoped to A", async () => {
    const res = await getJson(adminApp(), `/drilldown/leads/search?tenantId=${A.tenantId}&q=${SHARED_SURNAME}`);
    expect(res.status).toBe(200);
    const rows = res.json as SearchRow[];

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(A.sharedLeadId);
    expect(ids).not.toContain(B.sharedLeadId);
    // Every returned lead really belongs to tenant A.
    for (const id of ids) expect(A.leadIds).toContain(id);
  });

  it("the same term returns only tenant B's lead when scoped to B (symmetric)", async () => {
    const res = await getJson(adminApp(), `/drilldown/leads/search?tenantId=${B.tenantId}&q=${SHARED_SURNAME}`);
    expect(res.status).toBe(200);
    const rows = res.json as SearchRow[];

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(B.sharedLeadId);
    expect(ids).not.toContain(A.sharedLeadId);
    for (const id of ids) expect(B.leadIds).toContain(id);
  });

  it("tenant A's distinctive lead is invisible to a search scoped to tenant B", async () => {
    const res = await getJson(adminApp(), `/drilldown/leads/search?tenantId=${B.tenantId}&q=${A_DISTINCT_NAME}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });

  it("tenant B's distinctive lead IS visible to a search scoped to tenant B (control)", async () => {
    const res = await getJson(adminApp(), `/drilldown/leads/search?tenantId=${B.tenantId}&q=${B_DISTINCT_NAME}`);
    expect(res.status).toBe(200);
    const rows = res.json as SearchRow[];
    expect(rows.map((r) => r.id)).toContain(B.distinctLeadId);
  });

  it("a tenant-scoped role (client_admin) is denied — manual match is agency-only", async () => {
    const scoped = makeApp({ userRole: "client_admin", tenantId: A.tenantId });
    const res = await getJson(scoped, `/drilldown/leads/search?tenantId=${A.tenantId}&q=${SHARED_SURNAME}`);
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: "Only agency users can search leads for matching." });
  });
});

describe("PATCH /drilldown/jobs/:id/lead — tenant isolation (real Postgres)", () => {
  // The matched/unmatched state is mutated across these tests, so each one
  // resets the job's leadId first and asserts the final DB state itself.
  const resetJob = async (jobId: number) => {
    await db.update(jobsTable).set({ leadId: null, matchLevel: null }).where(eq(jobsTable.id, jobId));
  };
  const readJob = async (jobId: number) => {
    const [job] = await db
      .select({ id: jobsTable.id, leadId: jobsTable.leadId, matchLevel: jobsTable.matchLevel })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));
    return job;
  };

  it("matches a job to a SAME-tenant lead (control: the happy path works)", async () => {
    await resetJob(A.jobId);
    const res = await patchJson(adminApp(), `/drilldown/jobs/${A.jobId}/lead`, { leadId: A.sharedLeadId });
    expect(res.status).toBe(200);
    expect((res.json as { leadId: number }).leadId).toBe(A.sharedLeadId);

    const job = await readJob(A.jobId);
    expect(job.leadId).toBe(A.sharedLeadId);
    expect(job.matchLevel).toBe("manual");
  });

  it("rejects matching tenant A's job to tenant B's lead (404) and leaves the job untouched", async () => {
    await resetJob(A.jobId);
    const res = await patchJson(adminApp(), `/drilldown/jobs/${A.jobId}/lead`, { leadId: B.sharedLeadId });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "Lead not found" });

    // The cross-tenant lead must NOT have been attached.
    const job = await readJob(A.jobId);
    expect(job.leadId).toBeNull();
    expect(job.matchLevel).toBeNull();
  });

  it("rejects matching tenant B's job to tenant A's lead (404), symmetric", async () => {
    await resetJob(B.jobId);
    const res = await patchJson(adminApp(), `/drilldown/jobs/${B.jobId}/lead`, { leadId: A.sharedLeadId });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "Lead not found" });

    const job = await readJob(B.jobId);
    expect(job.leadId).toBeNull();
  });

  it("a tenant-scoped role (client_admin) cannot mutate ANOTHER tenant's job (403, untouched)", async () => {
    await resetJob(B.jobId);
    // client_admin pinned to tenant A tries to attach a lead to tenant B's job.
    const scopedToA = makeApp({ userRole: "client_admin", tenantId: A.tenantId });
    const res = await patchJson(scopedToA, `/drilldown/jobs/${B.jobId}/lead`, { leadId: B.sharedLeadId });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: "Only agency users can manually match jobs to leads." });

    // Nothing was written to tenant B's job.
    const job = await readJob(B.jobId);
    expect(job.leadId).toBeNull();
    expect(job.matchLevel).toBeNull();
  });

  it("a tenant-scoped role cannot mutate its OWN tenant's job either (agency-only endpoint)", async () => {
    await resetJob(A.jobId);
    const scopedToA = makeApp({ userRole: "client_admin", tenantId: A.tenantId });
    const res = await patchJson(scopedToA, `/drilldown/jobs/${A.jobId}/lead`, { leadId: A.sharedLeadId });
    expect(res.status).toBe(403);

    const job = await readJob(A.jobId);
    expect(job.leadId).toBeNull();
  });
});
