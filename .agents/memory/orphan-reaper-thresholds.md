---
name: Orphan sync reaper inactivity threshold
description: How the orphan-sync-reaper staleness threshold must be sized, and why UI/reaper thresholds are tiered.
---

# Orphan sync reaper inactivity threshold

The reaper marks a `status='running'` integration_sync_logs row dead when
`COALESCE(progress_updated_at, started_at)` is older than the threshold —
i.e. INACTIVITY, not absolute `started_at` age.

**Rule:** the reaper inactivity threshold must stay safely larger than the
longest gap a *healthy* backfill can go between progress stamps. That gap is
bounded by one Meta backfill chunk: progress is stamped at the start of each
30-day chunk, and a chunk's async insights report has a ~5-min poll timeout
(`fetchAdDailyInsightsAsync` default `timeoutMs`). The single shared default
`DEFAULT_INACTIVITY_STALE_MINUTES = 15` (in `orphan-sync-reaper.ts`) gives ~2.5x
margin and is reused by BOTH the startup reaper and the periodic scheduler sweep.

**Why:** before inactivity-keying, the periodic sweep used a 360-min (6 hr)
buffer purely so long-but-healthy backfills keyed off `started_at` wouldn't be
killed. Once staleness keys off `progress_updated_at`, healthy long runs are
protected by their own stamps, so that buffer just delayed recovery of truly
dead runs by hours. Shortening it to 15 min recovers dead runs within ~1 sweep.

**How to apply:** if you change the Meta chunk size, the async poll timeout, or
add a slower per-chunk operation, re-check that the max inter-stamp gap is still
well under the threshold — or add a mid-chunk progress heartbeat — before
lowering it further. The UI "Stalled" badge (`STALLED_PROGRESS_MS`, 3 min in
`marketing-os/internal.tsx`) is intentionally a SHORTER leading early-warning,
not the reap point; both read the same `progress_updated_at` signal.
