import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";

const PgStore = connectPgSimple(session);

const app: Express = express();

app.set("trust proxy", 1);

const allowedOrigins = process.env.REPLIT_DEV_DOMAIN
  ? [`https://${process.env.REPLIT_DEV_DOMAIN}`]
  : ["http://localhost:5173"];
if (process.env.REPLIT_DOMAINS) {
  process.env.REPLIT_DOMAINS.split(",").forEach(d => allowedOrigins.push(`https://${d}`));
}
if (process.env.REPLIT_EXPO_DEV_DOMAIN) {
  allowedOrigins.push(`https://${process.env.REPLIT_EXPO_DEV_DOMAIN}`);
}
if (process.env.REPLIT_DEV_DOMAIN) {
  const base = process.env.REPLIT_DEV_DOMAIN;
  const expoVariant = base.replace(".worf.replit.dev", ".expo.worf.replit.dev");
  if (!allowedOrigins.includes(`https://${expoVariant}`)) {
    allowedOrigins.push(`https://${expoVariant}`);
  }
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
}));
const captureRawBody = (req: unknown, _res: unknown, buf: Buffer) => {
  (req as Record<string, unknown>).rawBody = buf;
};

app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
app.use("/api/webhooks", express.raw({ type: "*/*", verify: captureRawBody }));

app.use((req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token && !req.headers.cookie?.includes("mos.sid=")) {
      const cookieValue = "mos.sid=" + encodeURIComponent(token);
      req.headers.cookie = req.headers.cookie
        ? req.headers.cookie + "; " + cookieValue
        : cookieValue;
    }
  }
  next();
});

export const sessionMiddleware = session({
  store: new PgStore({
    pool: pool as never,
    tableName: "session",
    createTableIfMissing: false,
  }),
  secret: (() => {
    const secret = process.env.SESSION_SECRET;
    if (!secret && process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET environment variable is required in production");
    }
    return secret || "mos-dev-secret-change-in-production";
  })(),
  resave: false,
  saveUninitialized: false,
  name: "mos.sid",
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
});

app.use(sessionMiddleware);

const currentDir = typeof __dirname !== "undefined"
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));
const publicDir = process.env.NODE_ENV === "production"
  ? path.join(currentDir, "public")
  : path.join(currentDir, "../public");
app.use("/api", express.static(publicDir));

app.use("/api/collect", cors({ origin: true, methods: ["GET", "POST", "OPTIONS"] }));

app.use("/api", router);

export default app;
