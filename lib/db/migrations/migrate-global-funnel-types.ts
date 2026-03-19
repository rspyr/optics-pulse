import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_funnel_types (
        tenant_id INTEGER NOT NULL REFERENCES tenants(id),
        funnel_type_id INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, funnel_type_id)
      )
    `);

    const { rows: funnels } = await client.query(`
      SELECT id, tenant_id, name, slug, description, is_active, created_at, updated_at
      FROM funnel_types ORDER BY slug, id
    `);

    const slugMap = new Map<string, number>();
    const duplicateIds: number[] = [];

    for (const f of funnels) {
      if (!slugMap.has(f.slug)) {
        slugMap.set(f.slug, f.id);
      } else {
        duplicateIds.push(f.id);
      }
    }

    for (const f of funnels) {
      const canonicalId = slugMap.get(f.slug)!;
      await client.query(
        `INSERT INTO tenant_funnel_types (tenant_id, funnel_type_id, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (tenant_id, funnel_type_id) DO NOTHING`,
        [f.tenant_id, canonicalId]
      );
    }

    if (duplicateIds.length > 0) {
      await client.query(`DELETE FROM funnel_types WHERE id = ANY($1)`, [duplicateIds]);
      console.log(`Removed ${duplicateIds.length} duplicate funnel type(s): IDs ${duplicateIds.join(", ")}`);
    }

    const hasTenantId = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'funnel_types' AND column_name = 'tenant_id'
    `);
    if (hasTenantId.rows.length > 0) {
      await client.query(`ALTER TABLE funnel_types DROP CONSTRAINT IF EXISTS funnel_types_tenant_slug_idx`);
      await client.query(`DROP INDEX IF EXISTS funnel_types_tenant_slug_idx`);
      await client.query(`ALTER TABLE funnel_types DROP COLUMN tenant_id`);
      console.log("Dropped tenant_id column from funnel_types");
    }

    const slugIdx = await client.query(`
      SELECT indexname FROM pg_indexes WHERE tablename = 'funnel_types' AND indexname = 'funnel_types_slug_idx'
    `);
    if (slugIdx.rows.length === 0) {
      await client.query(`CREATE UNIQUE INDEX funnel_types_slug_idx ON funnel_types (slug)`);
      console.log("Created unique index on funnel_types(slug)");
    }

    await client.query(`
      ALTER TABLE tenant_funnel_types
      DROP CONSTRAINT IF EXISTS tenant_funnel_types_funnel_type_id_fkey
    `);
    await client.query(`
      ALTER TABLE tenant_funnel_types
      ADD CONSTRAINT tenant_funnel_types_funnel_type_id_funnel_types_id_fk
      FOREIGN KEY (funnel_type_id) REFERENCES funnel_types(id) ON DELETE CASCADE
    `);

    await client.query("COMMIT");
    console.log("Migration complete!");

    const { rows: result } = await client.query(`
      SELECT ft.id, ft.slug, ft.name, array_agg(tft.tenant_id ORDER BY tft.tenant_id) as tenant_ids
      FROM funnel_types ft
      LEFT JOIN tenant_funnel_types tft ON tft.funnel_type_id = ft.id
      GROUP BY ft.id, ft.slug, ft.name
      ORDER BY ft.slug
    `);
    console.log("\nFinal state:");
    for (const r of result) {
      console.log(`  ${r.slug} (id=${r.id}) => tenants: [${r.tenant_ids.join(", ")}]`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
