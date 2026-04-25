import { pruneOldTrackerAttempts } from "./tracker-audit";

/** Daily 30-day retention sweep for tracker_submit_attempts. */
const RETENTION_DAYS = 30;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;

let retentionTimer: ReturnType<typeof setInterval> | null = null;

async function runSweep() {
  try {
    const deleted = await pruneOldTrackerAttempts(RETENTION_DAYS);
    if (deleted > 0) {
      console.log(`[TrackerRetention] Pruned ${deleted} tracker_submit_attempts rows older than ${RETENTION_DAYS}d`);
    }
  } catch (err) {
    console.error("[TrackerRetention] Sweep failed:", err);
  }
}

export function startTrackerRetentionCron() {
  if (retentionTimer) clearInterval(retentionTimer);
  setTimeout(() => { runSweep(); }, STARTUP_DELAY_MS);
  retentionTimer = setInterval(() => { runSweep(); }, SWEEP_INTERVAL_MS);
  console.log(`[TrackerRetention] Cron started (every 24h, ${RETENTION_DAYS}d retention)`);
}
