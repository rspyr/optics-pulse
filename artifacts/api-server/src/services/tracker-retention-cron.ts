import { pruneOldTrackerAttempts } from "./tracker-audit";

const DEFAULT_RETENTION_DAYS = 30;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;

let retentionTimer: ReturnType<typeof setInterval> | null = null;

function resolveRetentionDays(): number {
  const raw = process.env["TRACKER_AUDIT_RETENTION_DAYS"];
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[TrackerRetention] Invalid TRACKER_AUDIT_RETENTION_DAYS=${raw}, falling back to ${DEFAULT_RETENTION_DAYS}d`,
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

async function runSweep(retentionDays: number) {
  const startedAt = Date.now();
  try {
    const deleted = await pruneOldTrackerAttempts(retentionDays);
    const ms = Date.now() - startedAt;
    console.log(
      `[TrackerRetention] Pruned ${deleted} tracker_submit_attempts rows older than ${retentionDays}d (${ms}ms)`,
    );
  } catch (err) {
    console.error("[TrackerRetention] Sweep failed:", err);
  }
}

export function startTrackerRetentionCron() {
  if (retentionTimer) clearInterval(retentionTimer);
  const retentionDays = resolveRetentionDays();
  setTimeout(() => { runSweep(retentionDays); }, STARTUP_DELAY_MS);
  retentionTimer = setInterval(() => { runSweep(retentionDays); }, SWEEP_INTERVAL_MS);
  console.log(`[TrackerRetention] Cron started (every 24h, ${retentionDays}d retention)`);
}
