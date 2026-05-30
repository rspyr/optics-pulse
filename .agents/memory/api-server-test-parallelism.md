---
name: api-server vitest parallelism
description: Why artifacts/api-server runs vitest with fileParallelism:false and how to debug "passes alone, fails in full run" flakiness.
---

# api-server test parallelism

`artifacts/api-server/vitest.config.ts` runs files in parallel (`maxWorkers:
4`). Each run now gets its OWN throwaway Postgres DB (see
`api-server-test-db-isolation.md`), so the historical shared-DB pollution below
no longer applies — cross-file writes land in an isolated DB and global-count
assertions are safe again. Keep the worker cap for the CPU reason below.

**Why (historical shared-DB pollution — pre-isolation):**
- Integration tests (`*.integration.test.ts`) used to share ONE Postgres
  instance, and some assert on *global* table state. The worst offender
  snapshots every `leads` row id before/after a write to find the single new
  row; if any sibling integration file inserted leads concurrently, the diff
  count ballooned (saw 17 vs expected 1).
- The container CPU is throttled well below the reported `nproc` (8). With the
  default forks pool (one fork per CPU) the workers starve each other, so mocked
  unit tests that should take ~50ms blow past the 10s `testTimeout`. A timed-out
  test leaves its pending async handler running, which then inflates the NEXT
  test's mock call counts (e.g. retry assertion expected 3, got 5).

**How to apply:**
- Symptom signature: a test passes in isolation but fails only under full
  `pnpm vitest run`, with timeouts and/or off-by-N mock call counts, or
  unscoped DB count assertions. That is parallel contention, NOT drift — do not
  "fix" the assertions; keep files sequential.
- Verify the suite in two halves to stay under shell time limits:
  unit = `pnpm vitest run --exclude '**/*.integration.test.ts'`,
  integration = `pnpm vitest run integration.test` (vitest filters are
  substring matches on the path, NOT globs — `'**/*.integration.test.ts'` as a
  positional filter matches nothing).
- Background runs spawned from the shell tool get killed before the buffered
  reporter flushes; run foreground in halves instead.
