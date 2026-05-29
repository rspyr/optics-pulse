import type { Request, Response } from "express";

/**
 * Operator-facing hint attached to "No tenant assigned" 403s. A
 * tenant-scoped user (tenant_user, client_admin, client_user) without
 * a `tenantId` is a broken account that should never exist in normal
 * operation. Admins can see and fix affected users on the User
 * Management page (/admin/users), which surfaces the same data as
 * the `[broken-account-audit]` startup log via
 * `GET /admin/broken-accounts`. The hint surfaces a concrete next
 * step instead of leaving end users staring at an unactionable error.
 */
export const NO_TENANT_ASSIGNED_HINT =
  "Your account is missing a tenant. Please contact your administrator — they can find and fix affected users on the User Management admin page (/admin/users).";

export const NO_TENANT_ASSIGNED_ERROR = {
  error: "No tenant assigned",
  hint: NO_TENANT_ASSIGNED_HINT,
} as const;

/**
 * 400 returned by list/drilldown endpoints that opt into
 * `{ requireTenant: true }` when a super_admin / agency_user issues an
 * unfiltered, cross-tenant request (no `tenantId`).
 *
 * The web UI never asks for an unfiltered cross-tenant list — agency /
 * super_admin users must pick a specific tenant first. After the global
 * keyset indexes on leads/jobs/attribution_events were dropped (to speed
 * up writes), such a request would trigger a full sequential scan + sort
 * over the whole table. Rejecting it stops a stray or malicious call from
 * running an unindexed full-table ORDER BY. A genuine cross-tenant
 * aggregate view, if ever wanted, should be built deliberately with its
 * own supporting index rather than relying on this implicit path.
 */
export const TENANT_REQUIRED_ERROR = {
  error: "A tenantId is required",
  hint: "Select a specific tenant before requesting this list. Unfiltered cross-tenant list requests are not supported.",
} as const;

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
 *
 * Pass `{ requireTenant: true }` to forbid the unfiltered cross-tenant
 * path entirely: super_admin / agency_user callers must then supply a
 * concrete `tenantId` or the helper responds 400 (see
 * `TENANT_REQUIRED_ERROR`). Use it on heavy list/drilldown endpoints
 * where an unfiltered request would run an unindexed full-table sort.
 */
export function resolveListTenantScope(
  req: Request,
  res: Response,
  queryTenantId?: number | null,
  options?: { requireTenant?: boolean },
): ListTenantScope {
  const role = req.session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    // Validate the supplied tenant id so an invalid value can never slip
    // past the `requireTenant` check below and then be silently dropped
    // by a truthy `if (scope.tenantId)` filter — which would produce
    // exactly the unscoped, unindexed full-table query this helper exists
    // to prevent. Tenant IDs are positive serials, so anything non-finite
    // (e.g. NaN from a `tenantId=abc` query a route parsed with
    // `Number(...)`) or non-positive (0, negatives) is treated as "no
    // tenant supplied". Coerce before checking so a numeric-string id
    // (some routes hand the raw query value straight through) is accepted.
    const numeric = queryTenantId == null ? NaN : Number(queryTenantId);
    const hasValidTenant = Number.isFinite(numeric) && numeric > 0;
    if (!hasValidTenant) {
      if (options?.requireTenant) {
        res.status(400).json(TENANT_REQUIRED_ERROR);
        return { ok: false };
      }
      return { ok: true, tenantId: null };
    }
    // Preserve the caller-supplied value as-is (numeric in production
    // where the route coerces it; a numeric string in passthrough paths).
    return { ok: true, tenantId: queryTenantId as number };
  }
  const userTenantId = req.session.tenantId ?? null;
  if (!userTenantId) {
    res.status(403).json(NO_TENANT_ASSIGNED_ERROR);
    return { ok: false };
  }
  return { ok: true, tenantId: userTenantId };
}

/**
 * Result of asserting that the caller may access a path-resolved
 * resource (e.g. `GET /resource/:id`, `PATCH /resource/:id`,
 * `DELETE /resource/:id`).
 *
 * `ok: false` means this helper has already written a 4xx response to
 * `res` and the caller MUST early-return without further work.
 */
export type ResourceTenantAccess = { ok: true } | { ok: false };

/**
 * Companion to `resolveListTenantScope` for **detail** and **write**
 * handlers. `enforceTenantScope` middleware only inspects
 * query/body/param `tenantId` — it cannot stop a tenant_user from
 * passing any `:id` and accessing a resource owned by another tenant.
 *
 * Each detail/write handler must:
 *   1. Load the resource (or just its `tenantId` column) from the DB
 *   2. Pass `resource.tenantId` to this helper before reading or
 *      mutating the resource further.
 *
 * Behavior:
 * - super_admin / agency_user: always allowed (cross-tenant access).
 * - any other role with no `session.tenantId`: 403 "No tenant assigned".
 * - any other role whose `session.tenantId` does not match
 *   `resourceTenantId`: responds with `notFoundOnMismatch ? 404 : 403`
 *   so the handler does not leak resource existence to attackers.
 *   The default is 403 "Access denied" to match the existing pattern
 *   on `/leads/:leadId` and `/attribution/events/:id`. Pass
 *   `notFoundOnMismatch: true` for endpoints (like
 *   `/campaigns/:campaignId/breakdown`) that already prefer 404 to
 *   keep responses indistinguishable from "resource does not exist".
 */
export function assertResourceTenantAccess(
  req: Request,
  res: Response,
  resourceTenantId: number | null | undefined,
  options?: { notFoundOnMismatch?: boolean; notFoundMessage?: string; deniedMessage?: string },
): ResourceTenantAccess {
  const role = req.session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    return { ok: true };
  }
  const userTenantId = req.session.tenantId ?? null;
  if (!userTenantId) {
    res.status(403).json({ error: "No tenant assigned" });
    return { ok: false };
  }
  if (resourceTenantId == null || resourceTenantId !== userTenantId) {
    if (options?.notFoundOnMismatch) {
      res.status(404).json({ error: options?.notFoundMessage ?? "Not found" });
    } else {
      res.status(403).json({ error: options?.deniedMessage ?? "Access denied" });
    }
    return { ok: false };
  }
  return { ok: true };
}
