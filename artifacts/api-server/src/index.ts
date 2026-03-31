import { createServer } from "http";
import app, { sessionMiddleware } from "./app";
import { initSocketIO } from "./socket";
import { startReconciliationCron } from "./services/cron";
import { startSyncScheduler } from "./services/sync-scheduler";
import { evaluateAutoPass } from "./routes/leads-hub";
import { startTrainingAlertScheduler } from "./services/training-scheduler";
import { startAutomationScheduler } from "./services/automation-engine";
import { startClientAlertScheduler } from "./services/client-alerts";
import { startNightlyAggregation } from "./services/coordinator-stats";
import { runOneTimeMigrations } from "./services/one-time-migrations";
import { startStDataPurgeScheduler } from "./services/st-data-purge";
import { startSheetSyncScheduler } from "./services/sheet-sync";

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

httpServer.listen(port, async () => {
  console.log(`Server listening on port ${port}`);
  await runOneTimeMigrations();
  startReconciliationCron(3, 0);
  startSyncScheduler();
  startTrainingAlertScheduler(6);
  startAutomationScheduler();
  startClientAlertScheduler();
  startNightlyAggregation();
  startStDataPurgeScheduler();
  startSheetSyncScheduler();
  setInterval(async () => {
    try {
      const count = await evaluateAutoPass();
      if (count > 0) console.log(`[auto-pass] Reassigned ${count} stale leads`);
    } catch (err) {
      console.error("[auto-pass] Error:", err);
    }
  }, 15 * 60 * 1000);
});
