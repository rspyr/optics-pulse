---
name: api-server route test mocks
description: When a route gains a new @workspace/db table or drizzle-orm export, every test that loads that route must mock it.
---

# api-server route test mocks must cover a route's full dependency set

When a route file (e.g. `routes/drilldown.ts`) starts using a new `@workspace/db`
table export or a new `drizzle-orm` export, every vitest file that loads that
route must add the symbol to its `vi.mock("@workspace/db", ...)` /
`vi.mock("drizzle-orm", ...)` factory — otherwise the test fails at module load
with `No "X" export is defined on the "@workspace/db" mock`.

**Why:** vitest evaluates the mock factory eagerly at import time. A missing
export throws before any test body runs, so the failure looks like an unrelated
module-load crash, not a logic bug. Async route handlers can also appear to
"hang/timeout" when a flat-fixture mock returns a shape the route doesn't expect.

**How to apply:** a route is loaded not only by its own test but by any test that
imports the `routes/index.ts` aggregator (these transitively load every route).
After changing a route's table/drizzle imports, grep for all tests that import
the route directly AND those that import `routes/index`, and update each mock.
Proxy-based mocks (`tablecol = (t) => new Proxy(...)`) only need the table name
added; explicit-object mocks need the columns the route reads. For drizzle
helpers added recently here: `asc`, `getTableColumns` (returns `{}` is fine when
the mock ignores projection).

Note: some api-server route suites have long-standing PRE-EXISTING failures
unrelated to current work (e.g. `tenant-scope-detail-leaks.test.ts` missing
`integrationSyncLogsTable` because `routes/index` pulls `services/n` /
sync-scheduler). Don't attribute those to your change — verify against the prior
commit with `git show <commit>:<file>` before treating a suite failure as a
regression.
