---
name: tenant-scope id validation
description: How resolveListTenantScope validates an admin-supplied tenantId, and why it coerces before Number.isFinite.
---

# Admin tenantId validation in resolveListTenantScope

When a `super_admin`/`agency_user` supplies a `tenantId` for a list/drilldown
request, the helper validates it before using it as a query filter. With the
`requireTenant: true` option, an invalid/missing tenantId yields a 400 and no
DB access (prevents unfiltered cross-tenant full-table scans).

**The gotcha:** the supplied value is NOT uniformly a number across call sites.
- Routes using the zod `*QueryParams.parse` schema coerce it to a real number
  (`zod.coerce.number()`), and reject non-numeric strings by throwing a
  ZodError *before* the handler runs.
- Drilldown routes parse it manually with `Number(req.query.tenantId)`, so an
  invalid value like `tenantId=abc` arrives as **NaN**.
- Some tests mock the zod schema as identity passthrough, so the value arrives
  as a **numeric string** like `"9"`.

**Why coerce before checking:** `Number.isFinite("9")` is `false` — it does NOT
coerce strings. So validating with `Number.isFinite(queryTenantId)` directly
would wrongly reject a valid numeric-string id. The helper instead does
`Number.isFinite(Number(queryTenantId)) && Number(queryTenantId) > 0`, then
returns the *original* caller-supplied value unchanged (number in production,
numeric string in passthrough paths) to preserve prior filter semantics.

**How to apply:** if you add validation/normalization to admin-supplied query
ids, coerce with `Number(...)` before `Number.isFinite`/comparison, and don't
assume the value is already a number — it depends on whether the route uses the
zod schema or manual `Number(...)` parsing.

**Testing note:** an invalid `tenantId=abc` regression test only makes sense
against the manual-parse (drilldown) routes. The zod-schema routes throw a
ZodError on `abc` in an async handler, which Express doesn't catch by default,
so the request hangs and the test times out — scope that regression case to the
drilldown endpoints only.
