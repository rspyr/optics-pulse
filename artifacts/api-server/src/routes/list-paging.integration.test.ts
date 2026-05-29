/**
 * Real-Postgres integration coverage for **stable LIMIT/OFFSET paging** on the
 * remaining paged list endpoints (the sibling drilldown lists are covered by
 * `drilldown-paging.integration.test.ts`):
 *
 *   GET /jobs                  (jobs.createdAt sort)
 *   GET /leads                 (leads.createdAt sort)
 *   GET /attribution/events    (attribution_events.createdAt sort)
 *   GET /notifications         (notifications.createdAt sort)
 *   GET /admin/background-jobs (background_jobs.createdAt sort)
 *   GET /leads-hub/archive     (COALESCE(bookedAt, updatedAt) sort)
 *
 * Each of these orders by a non-unique column (a timestamp). Postgres gives no
 * guaranteed order among rows the ORDER BY can't distinguish, so paging a tied
 * sort with LIMIT/OFFSET can serve a tied row twice (overlap) or drop one
 * (skip). Every handler now appends the unique primary key (id) as a tiebreaker
 * in the same direction as the primary sort, giving a total order.
 *
 * Each block seeds a fresh tenant with deliberately *tied* timestamps arranged
 * so a tied group straddles a page boundary under limit=2, walks the pages, and
 * asserts they are disjoint, correctly-ordered slices of the route's own full
 * (unpaged) ordering — and that that full ordering matches the intended total
 * order (timestamp desc, then id desc). Remove the id tiebreaker and these fail.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

const dbModule = await import("@workspace/db");
const {
  db,
  tenantsTable,
  leadsTable,
  jobsTable,
  attributionEventsTable,
  notificationsTable,
  backgroundJobsTable,
} = dbModule;

const SOURCE_GOOGLE = "Google";
// Two tied timestamps interleaved so a tied group straddles a page boundary
// under limit=2: EARLY on rows 1,3,5 and LATE on rows 2,4,6.
const T_EARLY = new Date("2026-03-10T12:00:00.000Z");
const T_LATE = new Date("2026-03-20T12:00:00.000Z");
const TIE_PATTERN = [T_EARLY, T_LATE, T_EARLY, T_LATE, T_EARLY, T_LATE];

type Session = { userId: number; userRole: string; tenantId: number | null };

function makeApp(router: express.Router, session: Session): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = { ...session };
    next();
  });
  a.use(router);
  return a;
}

function getJson(
  expressApp: express.Express,
  reqPath: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        { hostname: "127.0.0.1", port, path: reqPath, method: "GET" },
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
      req.end();
    });
  });
}

type Row = { id: number };
type SeedRow = { id: number; tsMs: number };

// timestamp desc, then id desc as the unique tiebreaker.
function expectedOrder(rows: SeedRow[]): number[] {
  return [...rows]
    .sort((a, b) => {
      let cmp = a.tsMs - b.tsMs;
      if (cmp === 0) cmp = a.id - b.id;
      return -cmp; // both primary sort and tiebreaker are desc
    })
    .map((r) => r.id);
}

/**
 * Walk a route's pages with limit=2 and assert they are disjoint, ordered
 * slices of its own full (unpaged) ordering, which must itself equal the
 * intended total order. `extract` pulls the row array out of each route's
 * response envelope.
 */
async function walkPages(
  app: express.Express,
  buildUrl: (limit: number, offset: number) => string,
  expected: number[],
  extract: (json: unknown) => Row[],
): Promise<void> {
  const total = expected.length;

  const full = await getJson(app, buildUrl(1000, 0));
  expect(full.status).toBe(200);
  const fullIds = extract(full.json).map((r) => r.id);
  expect(fullIds).toEqual(expected);

  const limit = 2;
  const pages: number[][] = [];
  for (let offset = 0; offset < total; offset += limit) {
    const res = await getJson(app, buildUrl(limit, offset));
    expect(res.status).toBe(200);
    pages.push(extract(res.json).map((r) => r.id));
  }

  pages.forEach((ids, i) => {
    expect(ids).toEqual(fullIds.slice(i * limit, i * limit + limit));
  });

  const reassembled = pages.flat();
  expect(reassembled).toEqual(fullIds);
  expect(new Set(reassembled).size).toBe(reassembled.length);
}

let tenantId: number;
// The /leads list returns every lead in its tenant, so it gets its own tenant
// holding exactly the 6 tied rows (the shared tenant also has the job-parent and
// archive leads, which would contaminate that list's ordering).
let leadsListTenantId: number;
let leadIds: number[] = [];
let jobIds: number[] = [];
let attributionIds: number[] = [];
let notificationIds: number[] = [];
let backgroundJobIds: number[] = [];
let archiveLeadIds: number[] = [];

let jobsApp: express.Express;
let leadsApp: express.Express;
let attributionApp: express.Express;
let notificationsApp: express.Express;
let backgroundJobsApp: express.Express;
let archiveApp: express.Express;

// Unique background-job type so the (global, un-tenant-scoped) list filters down
// to exactly the rows this test seeds.
let bgType: string;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const slug = `list-page-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  bgType = `paging_test_${slug}`;

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ name: `List Paging ${slug}`, clientSlug: slug })
    .returning();
  tenantId = tenant.id;

  const [leadsListTenant] = await db
    .insert(tenantsTable)
    .values({ name: `List Paging Leads ${slug}`, clientSlug: `${slug}-leads` })
    .returning();
  leadsListTenantId = leadsListTenant.id;

  // --- /leads list: tied createdAt (own tenant, exactly 6 rows) -------------
  const leadRows: SeedRow[] = [];
  for (const ts of TIE_PATTERN) {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        tenantId: leadsListTenantId,
        firstName: "Lead",
        lastName: slug,
        source: SOURCE_GOOGLE,
        originalSource: SOURCE_GOOGLE,
        leadType: "PagingFunnel",
        createdAt: ts,
      })
      .returning();
    leadRows.push({ id: lead.id, tsMs: ts.getTime() });
  }
  leadIds = leadRows.map((r) => r.id);

  // --- /jobs list: tied createdAt (one parent lead) ------------------------
  const [jobLead] = await db
    .insert(leadsTable)
    .values({
      tenantId,
      firstName: "JobParent",
      lastName: slug,
      source: SOURCE_GOOGLE,
      originalSource: SOURCE_GOOGLE,
      leadType: "PagingFunnel",
    })
    .returning();
  leadIds.push(jobLead.id);

  const jobRows: SeedRow[] = [];
  for (const ts of TIE_PATTERN) {
    const [job] = await db
      .insert(jobsTable)
      .values({
        tenantId,
        leadId: jobLead.id,
        jobType: "hvac",
        jobTypeName: "HVAC",
        status: "completed",
        revenue: 1000,
        invoiceTotal: 1000,
        invoiceRebateAmount: 0,
        matchLevel: "gclid",
        createdAt: ts,
      })
      .returning();
    jobRows.push({ id: job.id, tsMs: ts.getTime() });
  }
  jobIds = jobRows.map((r) => r.id);

  // --- /attribution/events list: tied createdAt ----------------------------
  const attributionRows: SeedRow[] = [];
  let extIdx = 0;
  for (const ts of TIE_PATTERN) {
    const [event] = await db
      .insert(attributionEventsTable)
      .values({
        tenantId,
        eventType: "form_fill",
        externalId: `${slug}-evt-${extIdx++}`,
        createdAt: ts,
      })
      .returning();
    attributionRows.push({ id: event.id, tsMs: ts.getTime() });
  }
  attributionIds = attributionRows.map((r) => r.id);

  // --- /notifications list: tied createdAt ---------------------------------
  const notificationRows: SeedRow[] = [];
  for (const ts of TIE_PATTERN) {
    const [n] = await db
      .insert(notificationsTable)
      .values({
        tenantId,
        type: "paging_test",
        title: "Paging",
        message: slug,
        createdAt: ts,
      })
      .returning();
    notificationRows.push({ id: n.id, tsMs: ts.getTime() });
  }
  notificationIds = notificationRows.map((r) => r.id);

  // --- /admin/background-jobs list: tied createdAt (isolated by type) -------
  const backgroundJobRows: SeedRow[] = [];
  for (const ts of TIE_PATTERN) {
    const [bj] = await db
      .insert(backgroundJobsTable)
      .values({ type: bgType, createdAt: ts })
      .returning();
    backgroundJobRows.push({ id: bj.id, tsMs: ts.getTime() });
  }
  backgroundJobIds = backgroundJobRows.map((r) => r.id);

  // --- /leads-hub/archive list: tied bookedAt (COALESCE primary) -----------
  const archiveRows: SeedRow[] = [];
  for (const ts of TIE_PATTERN) {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        tenantId,
        firstName: "Archive",
        lastName: slug,
        source: SOURCE_GOOGLE,
        originalSource: SOURCE_GOOGLE,
        leadType: "PagingFunnel",
        hubStatus: "appt_set",
        bookedAt: ts,
      })
      .returning();
    archiveRows.push({ id: lead.id, tsMs: ts.getTime() });
  }
  archiveLeadIds = archiveRows.map((r) => r.id);
  leadIds.push(...archiveLeadIds);

  const superAdmin: Session = { userId: 1, userRole: "super_admin", tenantId: null };
  jobsApp = makeApp((await import("./jobs")).default, superAdmin);
  leadsApp = makeApp((await import("./leads")).default, superAdmin);
  attributionApp = makeApp((await import("./attribution")).default, superAdmin);
  backgroundJobsApp = makeApp((await import("./admin-background-jobs")).default, superAdmin);
  archiveApp = makeApp((await import("./leads-hub")).default, superAdmin);
  // notifications: super_admin sees ALL tenants' rows (no scope), so use a
  // tenant-scoped role (client_admin) to isolate this tenant's notifications.
  notificationsApp = makeApp((await import("./notifications")).default, {
    userId: 1,
    userRole: "client_admin",
    tenantId,
  });

  // Expose the per-route expected orders via closures used in the tests below.
  expectedByRoute = {
    jobs: expectedOrder(jobRows),
    leads: expectedOrder(leadRows),
    attribution: expectedOrder(attributionRows),
    notifications: expectedOrder(notificationRows),
    backgroundJobs: expectedOrder(backgroundJobRows),
    archive: expectedOrder(archiveRows),
  };
});

afterAll(async () => {
  try {
    if (backgroundJobIds.length) await db.delete(backgroundJobsTable).where(inArray(backgroundJobsTable.id, backgroundJobIds));
    if (notificationIds.length) await db.delete(notificationsTable).where(inArray(notificationsTable.id, notificationIds));
    if (attributionIds.length) await db.delete(attributionEventsTable).where(inArray(attributionEventsTable.id, attributionIds));
    if (jobIds.length) await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    if (leadIds.length) await db.delete(leadsTable).where(inArray(leadsTable.id, leadIds));
    if (tenantId) await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    if (leadsListTenantId) await db.delete(tenantsTable).where(eq(tenantsTable.id, leadsListTenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

let expectedByRoute: Record<string, number[]>;

describe("stable LIMIT/OFFSET paging for tied-timestamp list endpoints (real Postgres)", () => {
  it("GET /jobs: tied createdAt pages into disjoint, ordered slices", async () => {
    await walkPages(
      jobsApp,
      (limit, offset) => `/jobs?tenantId=${tenantId}&limit=${limit}&offset=${offset}`,
      expectedByRoute.jobs,
      (json) => (json as { jobs: Row[] }).jobs,
    );
  });

  it("GET /leads: tied createdAt pages into disjoint, ordered slices", async () => {
    await walkPages(
      leadsApp,
      (limit, offset) => `/leads?tenantId=${leadsListTenantId}&limit=${limit}&offset=${offset}`,
      expectedByRoute.leads,
      (json) => (json as { leads: Row[] }).leads,
    );
  });

  it("GET /attribution/events: tied createdAt pages into disjoint, ordered slices", async () => {
    await walkPages(
      attributionApp,
      (limit, offset) => `/attribution/events?tenantId=${tenantId}&limit=${limit}&offset=${offset}`,
      expectedByRoute.attribution,
      (json) => (json as { events: Row[] }).events,
    );
  });

  it("GET /notifications: tied createdAt pages into disjoint, ordered slices", async () => {
    await walkPages(
      notificationsApp,
      (limit, offset) => `/notifications?limit=${limit}&offset=${offset}`,
      expectedByRoute.notifications,
      (json) => (json as { notifications: Row[] }).notifications,
    );
  });

  it("GET /admin/background-jobs: tied createdAt pages into disjoint, ordered slices", async () => {
    await walkPages(
      backgroundJobsApp,
      (limit, offset) => `/admin/background-jobs?type=${bgType}&limit=${limit}&offset=${offset}`,
      expectedByRoute.backgroundJobs,
      (json) => (json as { jobs: Row[] }).jobs,
    );
  });

  it("GET /leads-hub/archive: tied bookedAt pages into disjoint, ordered slices", async () => {
    await walkPages(
      archiveApp,
      (limit, offset) => `/leads-hub/archive?tenantId=${tenantId}&limit=${limit}&offset=${offset}`,
      expectedByRoute.archive,
      (json) => (json as { leads: Row[] }).leads,
    );
  });
});
