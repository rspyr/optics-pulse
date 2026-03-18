import { runScheduledReconciliation } from "./reconciliation";
import { setNextScheduledRunGetter } from "./reconciliation";

let cronTimer: ReturnType<typeof setTimeout> | null = null;
let cronHour = 3;
let cronMinute = 0;

function getNextRunTime(): Date {
  const now = new Date();
  const next = new Date(now);
  next.setHours(cronHour, cronMinute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function scheduleNext() {
  const nextRun = getNextRunTime();
  const delay = nextRun.getTime() - Date.now();

  console.log(`[Cron] Next reconciliation scheduled for ${nextRun.toISOString()} (in ${Math.round(delay / 60000)} minutes)`);

  cronTimer = setTimeout(async () => {
    console.log(`[Cron] Starting scheduled reconciliation at ${new Date().toISOString()}`);
    try {
      const results = await runScheduledReconciliation();
      const totalJobs = results.reduce((s, r) => s + r.jobsProcessed, 0);
      const totalMatched = results.reduce((s, r) => s + r.diamond + r.golden + r.silver + r.bronze, 0);
      console.log(`[Cron] Scheduled reconciliation complete: ${results.length} tenants, ${totalJobs} jobs, ${totalMatched} matched`);
    } catch (err) {
      console.error("[Cron] Scheduled reconciliation failed:", err);
    }
    scheduleNext();
  }, delay);
}

export function startReconciliationCron(hour?: number, minute?: number) {
  const envHour = process.env["RECON_CRON_HOUR"];
  const envMinute = process.env["RECON_CRON_MINUTE"];

  cronHour = envHour ? parseInt(envHour, 10) : (hour ?? 3);
  cronMinute = envMinute ? parseInt(envMinute, 10) : (minute ?? 0);

  if (isNaN(cronHour) || cronHour < 0 || cronHour > 23) cronHour = 3;
  if (isNaN(cronMinute) || cronMinute < 0 || cronMinute > 59) cronMinute = 0;

  setNextScheduledRunGetter(() => getNextRunTime().toISOString());

  if (cronTimer) clearTimeout(cronTimer);
  scheduleNext();
  console.log(`[Cron] Reconciliation cron initialized (daily at ${String(cronHour).padStart(2, "0")}:${String(cronMinute).padStart(2, "0")})`);
}

export function stopReconciliationCron() {
  if (cronTimer) {
    clearTimeout(cronTimer);
    cronTimer = null;
    console.log("[Cron] Reconciliation cron stopped");
  }
}

export function getNextScheduledRunTime(): string {
  return getNextRunTime().toISOString();
}
