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

// node-postgres emits this event for idle clients when the database closes a
// connection out of band, such as during maintenance or a network interruption.
// Without a listener, Node treats it as an uncaught exception. The pool discards
// the dead client and replaces it on the next query, so logging is enough here.
pool.on("error", (err) => {
  console.error("[db] Unexpected idle Postgres client error (recovered):", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
