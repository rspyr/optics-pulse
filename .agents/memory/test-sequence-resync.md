---
name: Test sequence resync under parallelism
description: Why per-file setval() resyncs break parallel integration tests, and where the safe one-time resync lives.
---

# Serial-sequence resync for shared-DB integration tests

The api-server integration tests share one Postgres dev DB whose serial
sequences can lag `MAX(id)` (rows seeded with explicit ids). The old fix was a
per-file `resyncSerial(table)` helper running `setval(seq, MAX(id)+1, false)`
in `beforeAll` / before inserts.

**Rule:** never resync a sequence from inside a test file. Do it once, before
any worker runs.

**Why:** `setval` based on a read is racy under cross-file parallelism. File A
reads a stale `MAX(id)`; before its `setval`, File B inserts rows advancing the
sequence; A's `setval` then resets the sequence *backwards* beneath B's rows →
`*_pkey` duplicate-key errors (observed on `leads_pkey`). It is invisible with
`fileParallelism: false` and only surfaces once files run concurrently.

**How to apply:** the one-time resync lives in `src/test-setup/global-setup.ts`
(runs in a single process after `runSchemaMigrations()`, before `pool.end()`).
A PL/pgSQL `DO` block walks every owned sequence via pg_depend and
`setval(seq, MAX(id)+1, false)`. Add no per-file resync; if a new table needs
it, the global block already covers all sequences automatically.
