---
name: drizzle GROUP BY param-mismatch
description: Why repeating a parameterized sql`` expression in both SELECT and GROUP BY fails in Postgres, and the fix.
---

When you build a grouped drizzle query and pass the SAME `sql\`...\`` expression
object to both the `.select({ col: expr })` projection and `.groupBy(expr)`,
Postgres can reject it with error 42803 ("column ... must appear in the GROUP BY
clause or be used in an aggregate function") — even though the expression is
literally identical in your TS code.

**Why:** drizzle parameterizes any string/value literals inside the template
(e.g. `${"unmatched"}`). The projection's literals bind to `$1,$2,...` and the
GROUP BY copy binds to *later* positions (`$4,$5,...`). Postgres compares the two
CASE/expression trees including bind-parameter positions, sees `$1 vs $4`, and
concludes they are NOT the same expression — so the underlying column looks
ungrouped. Hand-written SQL with literal `'unmatched'` strings works (identical
text), which masks the bug until drizzle parameterizes it.

**How to apply:** group by the SELECT column's ordinal position instead of
repeating the expression: `.groupBy(sql\`1\`)` (1 = first selected column).
Postgres ordinal GROUP BY references the output column and avoids the param
mismatch entirely. Alias-based `GROUP BY <alias>` also works. This bites any
grouped query whose grouping key is a parameterized `sql` expression, not just
CASE buckets.

**Test-harness symptom:** the failure surfaced as a 10s *hang/timeout*, not a
visible SQL error, because the integration `getJson` helper does
`JSON.parse(data)` on the 500 HTML error page — the parse throws before
`resolve()` runs, so the promise never settles and the test times out. A hanging
integration test that hits a route can really be a route-level throw.
