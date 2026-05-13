import type { Request, Response } from "express";

/**
 * Result of resolving the tenant scope for a list-style handler.
 *
 * `ok: false` means the helper has already written a 403 response to
 * `res` and the caller MUST early-return without further work.
 *
 * `ok: true` means the caller should scope its query to `tenantId` if
 * non-null, or skip tenant scoping entirely if null (cross-tenant view
 * for super_admin / agency_user).
 */
export type ListTenantScope =
  | { ok: true; tenantId: number | null }
  | { ok: false };

/**
 * Mirrors the contract used by GET /attribution/events (task #382 /
 * task #388): list-style endpoints must force `req.session.tenantId`
 * for tenant-scoped roles instead of trusting an optional
 * `query.tenantId` that the caller can omit or change.
 *
 * Behavior:
 * - super_admin / agency_user: returns the caller-supplied
 *   `queryTenantId` (or null for a cross-tenant view).
 * - any other role: returns `req.session.tenantId`, ignoring the
 *   query param entirely. Responds 403 "No tenant assigned" when the
 *   session has no tenantId so the handler cannot accidentally fall
 *   back to an unscoped query.
 *
 * The middleware `enforceTenantScope` already auto-injects the session
 * tenantId into `req.query.tenantId` for non-admin roles, but list
 * handlers should NOT rely on that as their sole defense — this helper
 * is the in-handler enforcement layer.
 */
export function resolveListTenantScope(
  req: Request,
  res: Response,
  queryTenantId?: number | null,
): ListTenantScope {
  const role = req.session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    return { ok: true, tenantId: queryTenantId ?? null };
  }
  const userTenantId = req.session.tenantId ?? null;
  if (!userTenantId) {
    res.status(403).json({ error: "No tenant assigned" });
    return { ok: false };
  }
  return { ok: true, tenantId: userTenantId };
}
