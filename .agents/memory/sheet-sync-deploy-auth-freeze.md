---
name: Sheet-sync silent freeze on dead deployment Google token
description: Why ALL Google Sheet lead imports stop with no drift warning and a "healthy" connector — the deployed app's OAuth token is rejected by Google.
---

# Sheet-sync silent freeze when the deployment's Google token is invalid

Symptom cluster (all at once): no `sheet_sync_create` leads for many hours across
EVERY tenant/sheet; each sheet's `sync_row_watermark` frozen while new rows sit
above it; NO "headers changed"/drift warning on the stuck sheets; the app itself
is healthy and serving Pulse normally; and a lead provably exists in the source
Google Sheet (and in the attribution tracker) but never reaches the `leads` table.

Root cause shape: every Sheets API read in the **deployed** app fails. Production
logs flood with `[GoogleSheets] Auth error ... Invalid Credentials` +
`Cleared cached token due to auth error`. `readRawSheetData` throws →
`syncSingleSheet` throws BEFORE the header-drift check and BEFORE the watermark
update → caught per-config in `syncAllSheets` (errorCount++), so the loop keeps
running and looks alive but imports nothing.

Misleading signals to NOT trust:
- `listConnections('google-sheet')` from the agent/dev context can return
  `status: healthy` AND a token that successfully reads the sheets — yet the
  deployment still gets `Invalid Credentials`. The dev binding and the deployment
  binding are different; a working dev token does NOT prove the deployment works.
- Absence of a drift warning does NOT mean the sheet is fine — the auth failure is
  upstream of the header check, so a perfectly-mapped sheet (headers match) also
  freezes.

**Why:** the connector token the deployment fetches (via `WEB_REPL_RENEWAL`) is
stale/revoked on Google's side; the in-process refresh keeps re-fetching and still
gets a rejected token.

**How to apply:** confirm via deployment logs (`Invalid Credentials`), not via the
connector's "healthy" status. Fix is ops, not code: re-authorize the Google Sheets
integration (`proposeIntegration` with the connection id) and republish/restart the
deployment so it picks up fresh credentials. Timezone/date formatting is a red
herring — the watermark is row-index based and `parseSubmissionMs` uses
`Date.parse` (returns null, never throws).

Separately/independently: real header drift DOES freeze a single sheet with a
`drift_detected_at` stamp + a one-time drift notification; those sheets need their
column mapping re-approved. Don't conflate the two failure modes.

## Durable fix: a hung read (not a thrown error) freezes ALL sheet sync forever

The auth flood above throws, which the per-config try/catch handles fine. The
worse failure mode is a read that **hangs and never settles**: the Google Sheets
API (`googleapis` `spreadsheets.values.get`) and the connector `fetch` had NO
timeout. A single hung read leaves both locks stuck: the module `syncing` flag
AND `createGuardedRunner("SheetSync")`'s private `inProgress` only release when
the sweep promise *settles* — a hang never settles, so every future 60s tick is
dropped silently with no error and no log. This is the real "stayed dead for
19h" mechanism, distinct from (but triggered by) the token death.

**Rule:** every external call inside the sheet sync sweep MUST be timeout-bounded,
AND the sweep must be bounded at the scheduler/guard boundary too — bounding only
the inner reads is not enough, because an unforeseen hang elsewhere still locks
`inProgress`. Two independent locks (`syncing` + guard `inProgress`) each need
their own release path.

What is in place now (api-server):
- `google-sheets.ts`: `withTimeout()` helper; AbortController timeout on the
  connector `fetch`; both `values.get` calls wrapped in `withTimeout`. Hang → throw.
- `sheet-sync.ts`: `MAX_SWEEP_MS` watchdog resets the `syncing` flag; the guarded
  runner also races `syncAllSheets()` against `MAX_SWEEP_MS` so a hang rejects and
  releases the guard's `inProgress`.
- Stall alerting is **per-tenant** (`consecutiveFullyFailedByTenant`): a tenant
  whose every sheet errored and imported nothing for `STALL_ALERT_CYCLES` (5)
  consecutive sweeps fires `emitSheetSyncStalledNotification` (30min cooldown).
  Must be per-tenant — a global counter lets one healthy tenant mask another's
  outage. Header-drift (`syncSingleSheet` returns -1) is NOT an error and must
  never count toward stall.
