import { pruneOldTrackerAttempts } from "./tracker-audit";

/**
 * Daily retention sweep for the tracker_submit_attempts audit log.
 *
 * tracker_submit_attempts collects every inbound /collect/submit and
 * /collect/heartbeat — including rejected attempts — so it grows quickly
 * for any tenant whose pages get real traffic. We keep a 30-day window;
 * older rows are pruned. 30 days is well past the SLA window for any
 * "investigate why this submit was rejected" question and matches the
 * retention policy advertised in Settings → Tracker Health.
 *
 * Runs once at startup (after 60s, to let the rest of the boot sequence
 * settle) and then every 24 hours.
 */
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
