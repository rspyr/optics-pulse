import { db, tenantsTable, usersTable, funnelTypesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function exportSeedData() {
  console.log("[Export] Reading current database state...");

  const tenants = await db.select().from(tenantsTable);
  console.log(`[Export] Found ${tenants.length} tenants`);

  const users = await db.select({
    email: usersTable.email,
    name: usersTable.name,
    role: usersTable.role,
    tenantId: usersTable.tenantId,
  }).from(usersTable);
  console.log(`[Export] Found ${users.length} users`);

  const funnelTypes = await db.select().from(funnelTypesTable);
  console.log(`[Export] Found ${funnelTypes.length} funnel types`);

  const tenantFunnelRows = await db.execute(
    sql`SELECT tenant_id, funnel_type_id FROM tenant_funnel_types`
  );
  console.log(`[Export] Found ${tenantFunnelRows.rows.length} tenant-funnel associations`);

  const automationRules = await db.execute(
    sql`SELECT name, description, condition_type, condition_value, action_type, platform, tenant_id, is_enabled, lookback_days FROM automation_rules`
  );
  console.log(`[Export] Found ${automationRules.rows.length} automation rules`);

  const seedData = {
    exportedAt: new Date().toISOString(),
    tenants: tenants.map(t => ({
      name: t.name,
      serviceTitanId: t.serviceTitanId,
      timezone: t.timezone,
      apiConfig: t.apiConfig,
      alertConfig: t.alertConfig,
      communicationConfig: t.communicationConfig,
      leaderboardConfig: t.leaderboardConfig,
      spiffConfig: t.spiffConfig,
      isActive: t.isActive,
      isDemo: t.isDemo,
    })),
    users: users.map(u => ({
      email: u.email,
      name: u.name,
      role: u.role,
      tenantName: u.tenantId ? tenants.find(t => t.id === u.tenantId)?.name || null : null,
    })),
    funnelTypes: funnelTypes.map(ft => ({
      name: ft.name,
      slug: ft.slug,
      description: ft.description,
      isActive: ft.isActive,
    })),
    tenantFunnelAssociations: (tenantFunnelRows.rows as any[]).map(r => ({
      tenantName: tenants.find(t => t.id === r.tenant_id)?.name || null,
      funnelSlug: funnelTypes.find(ft => ft.id === r.funnel_type_id)?.slug || null,
    })).filter(r => r.tenantName && r.funnelSlug),
    automationRules: (automationRules.rows as any[]).map(r => ({
      name: r.name,
      description: r.description,
      conditionType: r.condition_type,
      conditionValue: r.condition_value,
      actionType: r.action_type,
      platform: r.platform,
      tenantName: r.tenant_id ? tenants.find(t => t.id === r.tenant_id)?.name || null : null,
      isEnabled: r.is_enabled,
      lookbackDays: r.lookback_days,
    })),
  };

  const outPath = path.join(__dirname, "..", "src", "seed-data.json");
  fs.writeFileSync(outPath, JSON.stringify(seedData, null, 2));
  console.log(`[Export] Seed data written to ${outPath}`);
  console.log("[Export] Done! This file will be used by autoSeedIfEmpty on production startup.");

  process.exit(0);
}

exportSeedData().catch(err => {
  console.error("[Export] Failed:", err);
  process.exit(1);
});
