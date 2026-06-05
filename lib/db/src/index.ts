
  import { drizzle } from "drizzle-orm/node-postgres";
  import pg from "pg";
  import * as schema from "./schema";

  const { Pool } = pg;

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }

  export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // node-postgres emits an 'error' event on idle clients when the backend
  // terminates a connection out-of-band (e.g. "terminating connection due to
  // administrator command" during DB maintenance/scaling, or network drops).
  // Without a listener, Node promotes it to an uncaught exception that crashes
  // the whole process and triggers a deploy crash loop. The pool transparently
  // removes the dead client and creates a fresh one on the next query, so we
  // only need to log and swallow these background errors.
  pool.on("error", (err) => {
    console.error("[db] Unexpected idle Postgres client error (recovered):", err.message);
  });

  export const db = drizzle(pool, { schema });

  export * from "./schema";
  