import { createServer } from "http";
import app, { sessionMiddleware } from "./app";
import { initSocketIO, closeStaleLoginSessions, startLoginSessionExpiryJob } from "./socket";
import { startReconciliationCron } from "./services/cron";
import { startSyncScheduler } from "./services/sync-scheduler";
import { startTrainingAlertScheduler } from "./services/training-scheduler";
import { startAutomationScheduler } from "./services/automation-engine";
import { startClientAlertScheduler } from "./services/client-alerts";
import { startNightlyAggregation } from "./services/coordinator-stats";
import { runOneTimeMigrations } from "./services/one-time-migrations";
import { runSchemaMigrations } from "./services/schema-migrations";
import { startStDataPurgeScheduler } from "./services/st-data-purge";
import { startSheetSyncScheduler } from "./services/sheet-sync";
import { recoverTimers } from "./services/auto-pass-scheduler";
import { recoverPendingNewLeadEmits } from "./services/lead-notify-scheduler";
import { startCallbackScheduler } from "./services/callback-scheduler";
import { startHeartbeatMonitor, startStaleInstallMonitor } from "./services/notifications";
import { startTrackerRetentionCron } from "./services/tracker-retention-cron";
import { auditUsersWithoutTenant } from "./services/broken-account-audit";
import { startBackgroundJobWorker } from "./services/background-jobs";
import { registerReDeriveJobHandlers } from "./services/re-derive-jobs";
import { registerPodiumSyncJobHandlers } from "./services/podium-sync-jobs";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);
initSocketIO(httpServer, sessionMiddleware);

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[startup] Port ${port} is already in use. A previous instance likely did not exit cleanly. Exiting so the supervisor can restart.`,
    );
    process.exit(1);
  }
  console.error("[startup] HTTP server error:", err);
  process.exit(1);
});

async function startServer() {
  try {
    await runSchemaMigrations();
  } catch (err) {
    console.error("[startup] Schema migrations failed, exiting:", err);
    process.exit(1);
  }

  httpServer.listen(port, async () => {
    console.log(`Server listening on port ${port}`);
    await runOneTimeMigrations();
    // Reap orphaned sync_log rows left at status='running' by the previous
    // process — otherwise a backfill that was in flight during the last
    // deploy will sit "running" forever, and the UI gets stuck on
    // "Cancelling…" because there's no worker to flip cancel_requested.
    try {
      const { reapOrphanedSyncLogs } = await import("./services/orphan-sync-reaper");
      const reaped = await reapOrphanedSyncLogs(15);
      if (reaped > 0) console.log(`[startup] Reaped ${reaped} orphaned sync_log row(s)`);
    } catch (err) {
      console.error("[startup] Orphan sync reaper failed:", err);
    }
    await auditUsersWithoutTenant();
    await closeStaleLoginSessions();
    startLoginSessionExpiryJob();
    startReconciliationCron(3, 0);
    startSyncScheduler();
    startTrainingAlertScheduler(6);
    startAutomationScheduler();
    startClientAlertScheduler();
    startNightlyAggregation();
    startStDataPurgeScheduler();
    startSheetSyncScheduler();
    recoverTimers().catch((err) =>
      console.error("[auto-pass] Recovery error:", err),
    );
    recoverPendingNewLeadEmits().catch((err) =>
      console.error("[lead-notify] Recovery error:", err),
    );
    startCallbackScheduler();
    startHeartbeatMonitor();
    startStaleInstallMonitor();
    startTrackerRetentionCron();
    registerReDeriveJobHandlers();
    registerPodiumSyncJobHandlers();
    startBackgroundJobWorker().catch((err) =>
      console.error("[background-jobs] failed to start:", err),
    );
  });
}

startServer().catch((err) => {
  console.error("[startup] Fatal error:", err);
  process.exit(1);
});
