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
import { syncSchemaFromDrizzle } from "./services/schema-sync";
import { startStDataPurgeScheduler } from "./services/st-data-purge";
import { startSheetSyncScheduler } from "./services/sheet-sync";
import { recoverTimers } from "./services/auto-pass-scheduler";
import { startCallbackScheduler } from "./services/callback-scheduler";
import { startHeartbeatMonitor } from "./services/notifications";

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

async function bootstrap() {
  // Run schema/data migrations BEFORE accepting traffic so the DB is in
  // sync with the shipped code. If this fails, crash hard — the supervisor
  // will restart us and we'd rather 5xx at the edge than serve a broken
  // dashboard backed by a drifted schema.
  // 1) Sync DB schema from the canonical Drizzle schema in lib/db/src/schema
  //    via `drizzle-kit push`. This is the same command the dev post-merge
  //    script runs, but executing it here means every production deploy also
  //    picks up pending schema changes automatically before serving traffic.
  try {
    await syncSchemaFromDrizzle();
  } catch (err) {
    console.error("[startup] Schema sync (drizzle-kit push) failed, aborting startup:", err);
    process.exit(1);
  }

  // 2) Run data-aware one-time migrations (backfills, constraint tightening,
  //    anything the schema-push step can't express). Tracked in
  //    `_one_time_migrations` so each one runs exactly once.
  try {
    await runOneTimeMigrations();
  } catch (err) {
    console.error("[startup] One-time migrations failed, aborting startup:", err);
    process.exit(1);
  }

  httpServer.listen(port, async () => {
    console.log(`Server listening on port ${port}`);
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
    recoverTimers().catch(err => console.error("[auto-pass] Recovery error:", err));
    startCallbackScheduler();
    startHeartbeatMonitor();
  });
}

bootstrap().catch((err) => {
  console.error("[startup] Fatal bootstrap error:", err);
  process.exit(1);
});
