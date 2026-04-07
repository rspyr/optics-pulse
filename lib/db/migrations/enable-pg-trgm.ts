import pg from "pg";

const { Pool } = pg;

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    console.log("pg_trgm extension enabled");

    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_first_name_trgm ON leads USING gin (first_name gin_trgm_ops);`);
    console.log("Index leads_first_name_trgm created");

    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_last_name_trgm ON leads USING gin (last_name gin_trgm_ops);`);
    console.log("Index leads_last_name_trgm created");

    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_email_trgm ON leads USING gin (email gin_trgm_ops);`);
    console.log("Index leads_email_trgm created");

    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_phone_trgm ON leads USING gin (phone gin_trgm_ops);`);
    console.log("Index leads_phone_trgm created");

    console.log("All pg_trgm indexes created successfully");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
