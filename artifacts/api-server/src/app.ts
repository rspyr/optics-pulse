import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";

const app: Express = express();

app.use(cors());
app.use(express.json({
  verify: (req: unknown, _res, buf) => {
    (req as Record<string, unknown>).rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));

const currentDir = typeof __dirname !== "undefined"
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(currentDir, "../public")));

app.use("/api", router);

export default app;
