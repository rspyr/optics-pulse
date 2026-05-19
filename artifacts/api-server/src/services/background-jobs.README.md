# Background jobs — when (and how) to use them

The durable runner in `background-jobs.ts` is the preferred home for any
async work that:

- Was previously written as `void (async () => { ... })()` /
  `something().catch(() => {})` (fire-and-forget),
- Should keep going (or be retried) if the api-server process restarts mid-run,
- Talks to a flaky external system (Podium, sheet APIs, push providers, …) and
  benefits from automatic backoff, or
- Is operator-visible enough that you want a row to point at when someone
  asks "did that actually happen?".

## What you get for free

- Persistence in the `background_jobs` table — work survives restarts.
- `SELECT … FOR UPDATE SKIP LOCKED` claiming, so multiple api-server replicas
  can run in parallel without double-processing a job.
- Exponential backoff retries up to `max_attempts` (default 5).
- Stale-lock recovery for processes that died mid-run.
- A single place (the `background_jobs` table) to look when debugging
  "what happened to that async thing?".

## How to add a new job type

1. Create a `*-jobs.ts` file in `services/` (e.g. `podium-sync-jobs.ts`,
   `re-derive-jobs.ts`). It should export:
   - A string constant for the job type (`"sync_podium_conversation_assignment"`).
   - A `registerXxxJobHandlers()` function that calls `registerJobHandler`.
   - An `enqueueXxx(args)` helper that wraps `enqueueJob` and validates the
     payload shape.
2. Wire `registerXxxJobHandlers()` into `src/index.ts` next to the other
   `register*JobHandlers()` calls. Handlers must be registered **before**
   `startBackgroundJobWorker()` so the worker can find them.
3. Replace the call site:

   ```ts
   // before
   doSomeWork(args).catch(() => {});

   // after
   await enqueueDoSomeWork(args);
   ```

   Pass `tenantId` when you have it so the row is easy to filter on later.

## When *not* to use it

- Hard real-time work tied to an open socket/HTTP connection (e.g. echoing
  a message back over the same socket). Those are tied to the connection's
  lifetime, so durability doesn't help — if the process restarts, the
  client reconnects and re-requests anyway.
- Cron-style recurring schedulers. Those already self-heal on restart by
  re-scanning state on their next tick; converting them buys nothing.
- Work that *must* be transactional with the surrounding request. The job
  runs in a separate transaction, so you'd lose atomicity.
