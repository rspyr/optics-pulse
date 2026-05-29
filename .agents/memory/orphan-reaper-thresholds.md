---
name: Orphan sync reaper inactivity threshold
description: How the orphan-sync-reaper staleness threshold must be sized, and why UI/reaper thresholds are tiered.
---

# Orphan sync reaper inactivity threshold

The reaper marks a `status='running'` integration_sync_logs row dead when
`COALESCE(progress_updated_at, started_at)` is older than the threshold —
i.e. INACTIVITY, not absolute `started_at` age.

**Rule:** the reaper inactivity threshold must stay safely larger than the
longest gap a *healthy* backfill can go between progress stamps. That gap used
to be one whole Meta chunk (progress stamped only at chunk start + a ~5-min
async-report poll timeout), which forced a 15-min threshold. The async poll loop
now stamps a mid-chunk liveness heartbeat (`onPollHeartbeat` in
`fetchAdDailyInsightsAsync` → `heartbeatSyncLogProgress` in `sync-scheduler.ts`,
throttled ~30s via `HEARTBEAT_MIN_INTERVAL_MS`), shrinking the worst-case gap to
~30s + the fast report-paging/upsert tail. With that, the single shared default
`DEFAULT_INACTIVITY_STALE_MINUTES` (in `orphan-sync-reaper.ts`, reused by BOTH
the startup reaper and the periodic sweep) was tightened from 15 → 5 min, and
the UI "Stalled" badge (`STALLED_PROGRESS_MS`) from 3 → 2 min.

**Caveat:** the heartbeat covers only the poll-wait phase, NOT report paging or
`upsertMetaInsightRows`. Those are normally fast but uncapped; if paging gets
slow (big chunks near the 200-page cap), extend the heartbeat into the paging
loop before tightening the threshold further.

**Why:** before inactivity-keying, the periodic sweep used a 360-min (6 hr)
buffer purely so long-but-healthy backfills keyed off `started_at` wouldn't be
killed. Once staleness keys off `progress_updated_at`, healthy long runs are
protected by their own stamps, so that buffer just delayed recovery of truly
dead runs by hours. Shortening it (now 5 min) recovers dead runs within ~1 sweep.

**How to apply:** if you change the Meta chunk size, the async poll timeout, the
heartbeat throttle, or add a slower per-chunk operation, re-check that the max
inter-stamp gap is still well under the threshold before lowering it further. The
UI "Stalled" badge (`STALLED_PROGRESS_MS`, 2 min in `marketing-os/internal.tsx`)
is intentionally a SHORTER leading early-warning, not the reap point; both read
the same `progress_updated_at` signal, so keep the UI value below the reaper's.
