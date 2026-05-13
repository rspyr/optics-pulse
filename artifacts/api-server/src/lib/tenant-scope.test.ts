import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { resolveListTenantScope } from "./tenant-scope";

function makeReq(role: string, tenantId: number | null): Request {
  return {
    session: { userRole: role, tenantId, userId: 1 },
  } as unknown as Request;
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

describe("resolveListTenantScope — list-handler tenant scoping contract", () => {
  it("super_admin without query.tenantId → cross-tenant scope (tenantId: null)", () => {
    const { res, status } = makeRes();
    const out = resolveListTenantScope(makeReq("super_admin", null), res, null);
    expect(out).toEqual({ ok: true, tenantId: null });
    expect(status).not.toHaveBeenCalled();
  });

  it("super_admin with query.tenantId → uses the supplied tenantId", () => {
    const { res, status } = makeRes();
    const out = resolveListTenantScope(makeReq("super_admin", null), res, 9);
    expect(out).toEqual({ ok: true, tenantId: 9 });
    expect(status).not.toHaveBeenCalled();
  });

  it("agency_user without query.tenantId → cross-tenant scope (tenantId: null)", () => {
    const { res, status } = makeRes();
    const out = resolveListTenantScope(makeReq("agency_user", null), res, null);
    expect(out).toEqual({ ok: true, tenantId: null });
    expect(status).not.toHaveBeenCalled();
  });

  it("agency_user with query.tenantId → uses the supplied tenantId", () => {
    const { res, status } = makeRes();
    const out = resolveListTenantScope(makeReq("agency_user", null), res, 12);
    expect(out).toEqual({ ok: true, tenantId: 12 });
    expect(status).not.toHaveBeenCalled();
  });

  it("tenant-scoped role with no session tenantId → 403 'No tenant assigned'", () => {
    const { res, status, json } = makeRes();
    const out = resolveListTenantScope(makeReq("tenant_user", null), res, null);
    expect(out).toEqual({ ok: false });
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: "No tenant assigned" });
  });

  it("tenant-scoped role with no session tenantId → 403 even if a query.tenantId is supplied", () => {
    const { res, status, json } = makeRes();
    const out = resolveListTenantScope(makeReq("tenant_user", null), res, 9);
    expect(out).toEqual({ ok: false });
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: "No tenant assigned" });
  });

  it("tenant-scoped role with session tenantId → forces session tenantId, ignoring query.tenantId", () => {
    const { res, status } = makeRes();
    const out = resolveListTenantScope(makeReq("tenant_user", 7), res, 9);
    // Critical: the attacker-supplied "9" must NOT survive — the helper
    // returns the session tenantId regardless of what the caller asked
    // for. This is the cross-tenant-leak prevention contract.
    expect(out).toEqual({ ok: true, tenantId: 7 });
    expect(status).not.toHaveBeenCalled();
  });

  it("client_admin with session tenantId → forces session tenantId, ignoring query.tenantId", () => {
    const { res } = makeRes();
    const out = resolveListTenantScope(makeReq("client_admin", 5), res, 99);
    expect(out).toEqual({ ok: true, tenantId: 5 });
  });

  it("client_user with session tenantId → forces session tenantId, ignoring query.tenantId", () => {
    const { res } = makeRes();
    const out = resolveListTenantScope(makeReq("client_user", 3), res, 99);
    expect(out).toEqual({ ok: true, tenantId: 3 });
  });

  it("unknown role with session tenantId → treated as tenant-scoped (forces session tenantId)", () => {
    const { res } = makeRes();
    const out = resolveListTenantScope(makeReq("future_role_we_havent_invented", 11), res, 99);
    expect(out).toEqual({ ok: true, tenantId: 11 });
  });

  it("unknown role with no session tenantId → 403 (fail closed)", () => {
    const { res, status, json } = makeRes();
    const out = resolveListTenantScope(makeReq("future_role_we_havent_invented", null), res, null);
    expect(out).toEqual({ ok: false });
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: "No tenant assigned" });
  });
});
