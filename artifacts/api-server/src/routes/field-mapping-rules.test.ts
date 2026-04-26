import { describe, it, expect, vi, beforeEach } from "vitest";

const insertCalls: Array<{ values: Record<string, unknown> }> = [];

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        insertCalls.push({ values: vals });
        return {
          returning: vi.fn().mockResolvedValue([{ id: 99, ...vals }]),
        };
      }),
    })),
  },
  fieldMappingRulesTable: Symbol("fieldMappingRulesTable"),
}));

vi.mock("../services/field-detection", () => ({
  invalidateRuleCache: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));

import express, { type Request, type Response, type NextFunction } from "express";

let app: express.Express;

async function setupApp(role: string | undefined, tenantId: number | null) {
  vi.resetModules();
  insertCalls.length = 0;
  const mod = await import("./field-mapping-rules");
  app = express();
  app.use(express.json());
  // Stub session — the real route reads req.session.userRole / tenantId.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { session: { userRole?: string; tenantId?: number | null } }).session = {
      userRole: role,
      tenantId,
    };
    next();
  });
  app.use(mod.default);
}

function postJson(
  expressApp: express.Express,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res: { statusCode: number; on: Function }) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({
              status: res.statusCode,
              json: data ? JSON.parse(data) : {},
            });
          });
        },
      );
      req.write(payload);
      req.end();
    });
  });
}

describe("POST /field-mapping-rules", () => {
  beforeEach(async () => {
    await setupApp("agency_user", 42);
  });

  // Acceptance (b) for Task #254: when an operator clicks "Map to phone" on a
  // captured field name from the Live Feed, the rule must be inserted scoped
  // to the right tenant, page-URL pattern, form identifier, and field name.
  it("inserts a rule scoped to tenant + page + form + field when an operator saves a mapping", async () => {
    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "ac-breakdown-prevention",
      fieldName: "field_3",
      mapsTo: "phone",
    });
    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values).toEqual({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "ac-breakdown-prevention",
      fieldName: "field_3",
      mapsTo: "phone",
      priority: 0,
    });
  });

  it("rejects non-manager roles (e.g. csr cannot save a mapping from the Live Feed)", async () => {
    await setupApp("csr", 42);
    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "form1",
      fieldName: "field_3",
      mapsTo: "phone",
    });
    expect(res.status).toBe(403);
    expect(insertCalls.length).toBe(0);
  });

  it("rejects unknown mapsTo targets so a typo can't poison the rule table", async () => {
    const res = await postJson(app, "/field-mapping-rules", {
      pageUrlPattern: "/contact",
      formIdentifier: "form1",
      fieldName: "field_3",
      mapsTo: "phon", // typo
    });
    expect(res.status).toBe(400);
    expect((res.json.error as string)).toContain("mapsTo must be one of");
    expect(insertCalls.length).toBe(0);
  });
});
