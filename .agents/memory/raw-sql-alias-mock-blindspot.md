---
name: Raw-SQL table-alias bug hidden by db.execute mocks
description: Why a hand-written CTE in the funnel-rule revert path failed in prod but passed unit tests; how to avoid the class of bug.
---

# Raw-SQL alias bug masked by mocked db.execute

In `artifacts/api-server/src/routes/subdomain-funnel-rules.ts` the host-parsing
candidate query is a hand-written `sql\`...\`` CTE whose FROM clause aliases the
table: `FROM attribution_events ae`. Inside that CTE every column MUST be
referenced through the alias (`ae.page_url`). If you build a sub-expression with
a Drizzle column reference (`${attributionEventsTable.pageUrl}`), Drizzle emits
the fully-qualified `"attribution_events"."page_url"`, and Postgres rejects it
with `42P01 invalid reference to FROM-clause entry ... Perhaps you meant the
table alias "ae"`. The backfill paths use `ae.page_url` (correct); the revert
path had drifted to the Drizzle ref and threw 500 on every revert.

**Why it went unnoticed:** the existing subdomain-funnel-rules unit test mocks
`db.execute`, so the raw SQL string is never sent to a real Postgres. Mocked
`db.execute`/`db.query` paths CANNOT catch SQL syntax/alias/column errors.

**How to apply:**
- Any route path that runs hand-written `sql\`...\`` (especially CTEs with table
  aliases) needs at least one integration test against the real per-run DB, not
  only a mocked unit test. The override-respect + route integration tests now
  cover create AND revert for both subdomain and route rules.
- When composing a shared `sql\`\`` fragment that is spliced into an aliased CTE,
  reference columns by the literal alias (`ae.page_url`), never via the Drizzle
  table object — the table object always qualifies with the real table name.
