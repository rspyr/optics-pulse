---
name: Test sequence resync (obsolete — now isolated DB)
description: Why per-file setval() resyncs broke parallel tests; superseded by per-run throwaway databases.
---

# Serial-sequence resync for integration tests (historical)

**Current state:** api-server integration tests now run against a fresh,
schema-cloned throwaway DB per run (see `api-server-test-db-isolation.md`), so
sequences start at their defaults and need no resync. The one-time resync block
that used to live in `global-setup.ts` has been removed.

**Historical rule (still true if you ever reintroduce a shared DB):** never
resync a sequence from inside a test file. `setval` based on a read is racy
under cross-file parallelism — File A reads a stale `MAX(id)`; before its
`setval`, File B inserts rows advancing the sequence; A's `setval` resets the
sequence *backwards* beneath B's rows → `*_pkey` duplicate-key errors. Do any
unavoidable resync once, in a single process before any worker runs.
