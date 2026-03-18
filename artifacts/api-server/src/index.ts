import { createServer } from "http";
import app, { sessionMiddleware } from "./app";
import { initSocketIO } from "./socket";
import { startReconciliationCron } from "./services/cron";
import { startSyncScheduler } from "./services/sync-scheduler";
import { startTrainingAlertScheduler } from "./services/training-scheduler";

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

httpServer.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  startReconciliationCron(3, 0);
  startSyncScheduler();
  startTrainingAlertScheduler(6);
});
