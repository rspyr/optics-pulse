import { db, usersTable, tenantsTable, campaignsTable, campaignDailyStatsTable, leadsTable, jobsTable, attributionEventsTable, changeLogsTable, funnelTypesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const FIRST_NAMES = ["John", "Sarah", "Michael", "Emily", "David", "Jessica", "Robert", "Amanda", "William", "Jennifer", "James", "Lisa", "Daniel", "Maria", "Christopher", "Ashley", "Matthew", "Nicole", "Andrew", "Stephanie"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee"];
const SOURCES = ["Google Ads", "Meta Leads", "CallRail", "Organic Search", "Direct", "Referral"];
const INTEREST_TYPES = ["Heat Pump", "AC Repair", "Full System", "Furnace", "Maintenance", "Ductless Mini-Split", "Thermostat", "Air Quality"];
const LEAD_STATUSES = ["new", "contacted", "booked", "sold", "lost"] as const;
const JOB_TYPES = ["Install", "Repair", "Maintenance", "Replacement", "Inspection", "Emergency"];
const MATCH_LEVELS = ["diamond", "golden", "silver", "bronze", "unmatched"] as const;
const EVENT_TYPES = ["click", "call", "form_fill"] as const;
const STREETS = ["123 Oak Street", "456 Maple Avenue", "789 Pine Drive", "321 Elm Road", "654 Cedar Boulevard"];
const CITIES = ["Phoenix, AZ 85001", "Mesa, AZ 85201", "Scottsdale, AZ 85251", "Minneapolis, MN 55401", "St Paul, MN 55101"];

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function hashValue(val: string): string {
  return crypto.createHash("sha256").update(val.trim().toLowerCase()).digest("hex");
}
function randomDate(daysAgo: number): Date {
  return new Date(Date.now() - Math.random() * daysAgo * 86400000);
}
function fakePhone(): string {
  return `(${randomBetween(200, 999)}) ${randomBetween(200, 999)}-${randomBetween(1000, 9999)}`;
}
function fakeGclid(): string {
  return `CjwKCAjw${crypto.randomBytes(8).toString("hex")}`;
}

function loadSeedData(): any | null {
  const candidates = [
    path.resolve(process.cwd(), "src", "seed-data.json"),
    path.resolve(process.cwd(), "dist", "seed-data.json"),
    path.resolve(process.cwd(), "seed-data.json"),
    path.resolve(process.cwd(), "artifacts", "api-server", "src", "seed-data.json"),
    path.resolve(process.cwd(), "artifacts", "api-server", "dist", "seed-data.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`[AutoSeed] Loading seed data from ${p}`);
      const raw = fs.readFileSync(p, "utf-8");
      return JSON.parse(raw);
    }
  }
  return null;
}

function extractCount(result: { rows: Record<string, unknown>[] }): number {
  const row = result.rows[0];
  if (!row) return 0;
  return Number(row.cnt ?? 0);
}

async function cleanupSeededDemoData() {
  const { eq } = await import("drizzle-orm");
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS _demo_cleanup_flags (key TEXT PRIMARY KEY, done_at TIMESTAMP DEFAULT NOW())`);
    const flagResult = await db.execute(sql`SELECT 1 FROM _demo_cleanup_flags WHERE key = 'initial_cleanup'`);
    if ((flagResult.rows?.length ?? 0) > 0) return;

    const nonDemoTenants = await db.select({ id: tenantsTable.id, name: tenantsTable.name })
      .from(tenantsTable)
      .where(eq(tenantsTable.isDemo, false));

    let totalCleaned = 0;
    for (const tenant of nonDemoTenants) {
      const seededLeadResult = await db.execute(
        sql`SELECT count(*) as cnt FROM leads WHERE tenant_id = ${tenant.id} AND email LIKE '%@example.com'`
      );
      const seededLeadCount = extractCount(seededLeadResult);

      const seedCampaignResult = await db.execute(
        sql`SELECT count(*) as cnt FROM campaigns WHERE tenant_id = ${tenant.id} AND (
          external_id LIKE 'G-%' OR external_id LIKE 'M-%'
        )`
      );
      const seedCampaignCount = extractCount(seedCampaignResult);

      const seedJobResult = await db.execute(
        sql`SELECT count(*) as cnt FROM jobs WHERE tenant_id = ${tenant.id} AND st_job_id LIKE 'STJ-%'`
      );
      const seedJobCount = extractCount(seedJobResult);

      if (seededLeadCount === 0 && seedCampaignCount === 0 && seedJobCount === 0) continue;

      if (seededLeadCount > 0) {
        await db.execute(sql`DELETE FROM call_attempts WHERE lead_id IN (
          SELECT id FROM leads WHERE tenant_id = ${tenant.id} AND email LIKE '%@example.com'
        )`);
        await db.execute(sql`DELETE FROM leads WHERE tenant_id = ${tenant.id} AND email LIKE '%@example.com'`);
      }

      if (seedCampaignCount > 0) {
        await db.execute(sql`DELETE FROM campaign_daily_stats WHERE campaign_id IN (
          SELECT id FROM campaigns WHERE tenant_id = ${tenant.id} AND (
            external_id LIKE 'G-%' OR external_id LIKE 'M-%'
          )
        )`);
        await db.execute(sql`DELETE FROM campaigns WHERE tenant_id = ${tenant.id} AND (
          external_id LIKE 'G-%' OR external_id LIKE 'M-%'
        )`);
      }

      if (seedJobCount > 0) {
        await db.execute(sql`DELETE FROM jobs WHERE tenant_id = ${tenant.id} AND st_job_id LIKE 'STJ-%'`);
      }

      if (tenant.name === "Advantage Heating & Cooling") {
        await db.execute(sql`DELETE FROM attribution_events WHERE tenant_id = ${tenant.id}`);
        await db.execute(sql`DELETE FROM change_logs WHERE tenant_id = ${tenant.id}`);
      }

      const cleaned = seededLeadCount + seedCampaignCount + seedJobCount;
      totalCleaned += cleaned;
      console.log(`[AutoSeed] Cleaned up seeded demo data for non-demo tenant "${tenant.name}": ${seededLeadCount} leads, ${seedCampaignCount} campaigns, ${seedJobCount} jobs`);
    }

    await db.execute(sql`INSERT INTO _demo_cleanup_flags (key) VALUES ('initial_cleanup')`);
    if (totalCleaned > 0) {
      console.log(`[AutoSeed] One-time demo data cleanup complete: ${totalCleaned} total seeded records removed`);
    }
  } catch (err) {
    console.error("[AutoSeed] Cleanup seeded demo data failed:", err instanceof Error ? err.message : err);
  }
}

export async function autoSeedIfEmpty() {
  try {
    const seedData = loadSeedData();
    const existingUsers = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    const isEmpty = existingUsers.length === 0;

    if (isEmpty) {
      if (seedData) {
        console.log(`[AutoSeed] Empty database detected, seeding from exported snapshot (${seedData.exportedAt})...`);
        await seedFromSnapshot(seedData);
      } else {
        console.log("[AutoSeed] Empty database detected, seeding with defaults...");
        await seedDefaults();
      }
    } else if (seedData) {
      await syncTenantConfigs(seedData);
    }

    await cleanupSeededDemoData();
  } catch (err) {
    console.error("[AutoSeed] Seed failed:", err instanceof Error ? err.message : err);
  }
}

async function syncTenantConfigs(seedData: any) {
  const { eq } = await import("drizzle-orm");
  let updated = 0;

  for (const t of seedData.tenants) {
    const [existing] = await db.select().from(tenantsTable).where(eq(tenantsTable.name, t.name));
    if (existing) {
      await db.update(tenantsTable).set({
        serviceTitanId: t.serviceTitanId,
        timezone: t.timezone,
        apiConfig: t.apiConfig,
        alertConfig: t.alertConfig,
        communicationConfig: t.communicationConfig,
        leaderboardConfig: t.leaderboardConfig,
        spiffConfig: t.spiffConfig,
        isActive: t.isActive,
        isDemo: t.isDemo === true,
      }).where(eq(tenantsTable.id, existing.id));
      updated++;
    } else {
      await db.insert(tenantsTable).values({
        name: t.name,
        serviceTitanId: t.serviceTitanId,
        timezone: t.timezone,
        apiConfig: t.apiConfig,
        alertConfig: t.alertConfig,
        communicationConfig: t.communicationConfig,
        leaderboardConfig: t.leaderboardConfig,
        spiffConfig: t.spiffConfig,
        isActive: t.isActive,
        isDemo: t.isDemo === true,
      });
      updated++;
    }
  }

  const existingTenants = await db.select().from(tenantsTable);
  const tenantMap = new Map<string, number>();
  for (const t of existingTenants) {
    tenantMap.set(t.name, t.id);
  }

  for (const ft of seedData.funnelTypes) {
    await db.insert(funnelTypesTable).values({
      name: ft.name,
      slug: ft.slug,
      description: ft.description,
      isActive: ft.isActive,
    }).onConflictDoNothing();
  }

  const allFunnels = await db.select().from(funnelTypesTable);
  const funnelMap = new Map<string, number>();
  for (const f of allFunnels) {
    funnelMap.set(f.slug, f.id);
  }

  for (const assoc of seedData.tenantFunnelAssociations) {
    const tenantId = tenantMap.get(assoc.tenantName);
    const funnelTypeId = funnelMap.get(assoc.funnelSlug);
    if (tenantId && funnelTypeId) {
      await db.execute(
        sql`INSERT INTO tenant_funnel_types (tenant_id, funnel_type_id) VALUES (${tenantId}, ${funnelTypeId}) ON CONFLICT DO NOTHING`
      );
    }
  }

  if (seedData.automationRules?.length) {
    for (const rule of seedData.automationRules) {
      const tenantId = rule.tenantName ? tenantMap.get(rule.tenantName) || null : null;
      await db.execute(
        sql`INSERT INTO automation_rules (name, description, condition_type, condition_value, action_type, platform, tenant_id, is_enabled, lookback_days, created_by)
            VALUES (${rule.name}, ${rule.description}, ${rule.conditionType}, ${String(rule.conditionValue)}, ${rule.actionType}, ${rule.platform}, ${tenantId}, ${rule.isEnabled}, ${rule.lookbackDays || 30}, 1)
            ON CONFLICT DO NOTHING`
      );
    }
  }

  const existingLeads = await db.select({ id: leadsTable.id }).from(leadsTable).limit(1);
  if (existingLeads.length === 0) {
    console.log("[AutoSeed] No demo activity found, generating...");
    const demoTenantNames = seedData.tenants
      .filter((t: any) => t.isDemo === true)
      .map((t: any) => t.name);
    const demoTenantIds = demoTenantNames
      .map((name: string) => tenantMap.get(name))
      .filter((id: number | undefined): id is number => id !== undefined);
    if (demoTenantIds.length > 0) {
      await seedDemoActivity(demoTenantIds, tenantMap);
    }
  }

  console.log(`[AutoSeed] Synced ${updated} tenant configs from snapshot (${seedData.exportedAt})`);
}

async function seedFromSnapshot(seedData: any) {
  const tenantMap = new Map<string, number>();
  for (const t of seedData.tenants) {
    const [tenant] = await db.insert(tenantsTable).values({
      name: t.name,
      serviceTitanId: t.serviceTitanId,
      timezone: t.timezone,
      apiConfig: t.apiConfig,
      alertConfig: t.alertConfig,
      communicationConfig: t.communicationConfig,
      leaderboardConfig: t.leaderboardConfig,
      spiffConfig: t.spiffConfig,
      isActive: t.isActive,
      isDemo: t.isDemo === true,
    }).returning();
    tenantMap.set(t.name, tenant.id);
  }
  console.log(`[AutoSeed] Created ${tenantMap.size} tenants with configs`);

  const passwordHash = await bcrypt.hash("demo1234", 10);
  for (const u of seedData.users) {
    const tenantId = u.tenantName ? tenantMap.get(u.tenantName) || null : null;
    await db.insert(usersTable).values({
      email: u.email,
      name: u.name,
      passwordHash,
      role: u.role,
      tenantId,
    }).onConflictDoNothing();
  }
  console.log(`[AutoSeed] Created ${seedData.users.length} users`);

  const funnelMap = new Map<string, number>();
  for (const ft of seedData.funnelTypes) {
    const [funnel] = await db.insert(funnelTypesTable).values({
      name: ft.name,
      slug: ft.slug,
      description: ft.description,
      isActive: ft.isActive,
    }).onConflictDoNothing().returning();
    if (funnel) {
      funnelMap.set(ft.slug, funnel.id);
    }
  }
  console.log(`[AutoSeed] Created ${funnelMap.size} funnel types`);

  for (const assoc of seedData.tenantFunnelAssociations) {
    const tenantId = tenantMap.get(assoc.tenantName);
    const funnelTypeId = funnelMap.get(assoc.funnelSlug);
    if (tenantId && funnelTypeId) {
      await db.execute(
        sql`INSERT INTO tenant_funnel_types (tenant_id, funnel_type_id) VALUES (${tenantId}, ${funnelTypeId}) ON CONFLICT DO NOTHING`
      );
    }
  }
  console.log(`[AutoSeed] Created ${seedData.tenantFunnelAssociations.length} tenant-funnel associations`);

  if (seedData.automationRules?.length) {
    for (const rule of seedData.automationRules) {
      const tenantId = rule.tenantName ? tenantMap.get(rule.tenantName) || null : null;
      await db.execute(
        sql`INSERT INTO automation_rules (name, description, condition_type, condition_value, action_type, platform, tenant_id, is_enabled, lookback_days, created_by)
            VALUES (${rule.name}, ${rule.description}, ${rule.conditionType}, ${String(rule.conditionValue)}, ${rule.actionType}, ${rule.platform}, ${tenantId}, ${rule.isEnabled}, ${rule.lookbackDays || 30}, 1)
            ON CONFLICT DO NOTHING`
      );
    }
    console.log(`[AutoSeed] Created ${seedData.automationRules.length} automation rules`);
  }

  const demoTenantNames = seedData.tenants
    .filter((t: any) => t.isDemo === true)
    .map((t: any) => t.name);
  const demoTenantIds = demoTenantNames
    .map((name: string) => tenantMap.get(name))
    .filter((id: number | undefined): id is number => id !== undefined);
  if (demoTenantIds.length > 0) {
    await seedDemoActivity(demoTenantIds, tenantMap);
  }

  console.log(`[AutoSeed] Production seed complete from snapshot`);
}

async function seedDefaults() {
  const [t1] = await db.insert(tenantsTable).values({ name: "Apex HVAC", serviceTitanId: "ST-APEX-001", timezone: "America/New_York", isDemo: true }).returning();
  const [t2] = await db.insert(tenantsTable).values({ name: "Nordic Climate Solutions", serviceTitanId: "ST-NORDIC-002", timezone: "America/Chicago", isDemo: true }).returning();
  const [t3] = await db.insert(tenantsTable).values({ name: "Advantage Heating & Cooling", serviceTitanId: "ST-ADV-003", timezone: "America/Denver", isDemo: false }).returning();
  console.log(`[AutoSeed] Created tenants: ${t1.name}, ${t2.name}, ${t3.name}`);

  const passwordHash = await bcrypt.hash("demo1234", 10);
  const users = [
    { email: "admin@hvaclaunch.com", name: "Aaron Mitchell", passwordHash, role: "super_admin" as const, tenantId: null },
    { email: "yoojin@hvaclaunch.com", name: "YooJin Park", passwordHash, role: "agency_user" as const, tenantId: null },
    { email: "ben@hvaclaunch.com", name: "Ben Carter", passwordHash, role: "agency_user" as const, tenantId: null },
    { email: "brandon@apexhvac.com", name: "Brandon Hayes", passwordHash, role: "client_admin" as const, tenantId: t1.id },
    { email: "dan@apexhvac.com", name: "Dan Collins", passwordHash, role: "client_user" as const, tenantId: t1.id },
    { email: "corey@apexhvac.com", name: "Corey Mitchell", passwordHash, role: "client_user" as const, tenantId: t1.id },
    { email: "owner@nordicclimate.com", name: "Erik Johansson", passwordHash, role: "client_admin" as const, tenantId: t2.id },
  ];
  for (const user of users) {
    await db.insert(usersTable).values(user).onConflictDoNothing();
  }
  console.log(`[AutoSeed] Created ${users.length} users`);

  const funnelTypeDefs = [
    { name: "Fit Funnel", slug: "fit-funnel", description: "Multi-step quiz funnel" },
    { name: "Emergency Repair", slug: "emergency-repair", description: "Emergency service page" },
  ];
  for (const ft of funnelTypeDefs) {
    await db.insert(funnelTypesTable).values(ft).onConflictDoNothing();
  }

  const tenantMap = new Map<string, number>([
    ["Apex HVAC", t1.id],
    ["Nordic Climate Solutions", t2.id],
    ["Advantage Heating & Cooling", t3.id],
  ]);

  await seedDemoActivity([t1.id, t2.id], tenantMap);

  console.log(`[AutoSeed] Default seed complete`);
}

async function seedDemoActivity(tenantIds: number[], tenantMap: Map<string, number>) {
  const t1Id = tenantIds[0];
  const t2Id = tenantIds[1];

  const campaignDefs = [
    { tenantId: t1Id, platform: "google", externalId: "G-APEX-BRAND-001", name: "Apex - Brand Search", status: "active" },
    { tenantId: t1Id, platform: "google", externalId: "G-APEX-HEAT-002", name: "Apex - Heat Pump Install", status: "active" },
    { tenantId: t1Id, platform: "meta", externalId: "M-APEX-LEAD-003", name: "Apex - Facebook Lead Gen", status: "active" },
    { tenantId: t2Id, platform: "google", externalId: "G-NORD-AC-001", name: "Nordic - AC Repair Near Me", status: "active" },
    { tenantId: t2Id, platform: "google", externalId: "G-NORD-FURN-002", name: "Nordic - Furnace Replacement", status: "active" },
    { tenantId: t2Id, platform: "meta", externalId: "M-NORD-LEAD-003", name: "Nordic - Instagram Reels", status: "paused" },
  ];
  const campaigns = [];
  for (const c of campaignDefs) {
    const [campaign] = await db.insert(campaignsTable).values(c).returning();
    campaigns.push(campaign);
  }

  const dailyStats = [];
  for (let dayOffset = 30; dayOffset >= 0; dayOffset--) {
    const d = new Date();
    d.setDate(d.getDate() - dayOffset);
    const dateStr = d.toISOString().split("T")[0];
    for (const campaign of campaigns) {
      const isActive = campaign.status === "active";
      dailyStats.push({
        campaignId: campaign.id,
        date: dateStr,
        spend: isActive ? randomBetween(80, 350) + Math.random() * 50 : 0,
        impressions: isActive ? randomBetween(500, 5000) : 0,
        clicks: isActive ? randomBetween(10, 120) : 0,
        conversions: isActive ? randomBetween(0, 8) : 0,
      });
    }
  }
  await db.insert(campaignDailyStatsTable).values(dailyStats);

  const leads = [];
  for (let i = 0; i < 60; i++) {
    const tenantId = tenantIds[i % tenantIds.length];
    const firstName = randomFrom(FIRST_NAMES);
    const lastName = randomFrom(LAST_NAMES);
    const source = randomFrom(SOURCES);
    const status = randomFrom(LEAD_STATUSES);
    const gclid = source === "Google Ads" ? fakeGclid() : null;
    const createdAt = randomDate(30);

    const [lead] = await db.insert(leadsTable).values({
      tenantId,
      firstName,
      lastName,
      phone: fakePhone(),
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      source,
      leadType: "General",
      interestType: randomFrom(INTEREST_TYPES),
      status,
      isNewCustomer: Math.random() > 0.3,
      matchedGclid: gclid,
      createdAt,
      updatedAt: createdAt,
    }).returning();
    leads.push(lead);
  }

  const soldLeads = leads.filter(l => l.status === "sold" || l.status === "booked");
  for (const lead of soldLeads) {
    const revenue = randomBetween(800, 12000);
    const completed = lead.status === "sold";
    const completedAt = completed ? new Date(lead.createdAt.getTime() + randomBetween(1, 14) * 86400000) : null;
    await db.insert(jobsTable).values({
      tenantId: lead.tenantId,
      stJobId: `STJ-${randomBetween(10000, 99999)}`,
      customerName: `${lead.firstName} ${lead.lastName}`,
      serviceAddress: `${randomFrom(STREETS)}, ${randomFrom(CITIES)}`,
      jobType: randomFrom(JOB_TYPES),
      revenue,
      status: completed ? "completed" : "in_progress",
      matchedGclid: lead.matchedGclid,
      matchLevel: lead.matchedGclid ? "diamond" : Math.random() > 0.5 ? "golden" : "silver",
      completedAt,
      createdAt: lead.createdAt,
      updatedAt: completedAt || lead.createdAt,
    });
  }

  const events = [];
  for (let i = 0; i < 80; i++) {
    const tenantId = randomFrom(tenantIds);
    const eventType = randomFrom(EVENT_TYPES);
    const matchLevel = randomFrom(MATCH_LEVELS);
    events.push({
      tenantId,
      eventType,
      gclid: matchLevel === "diamond" ? fakeGclid() : null,
      hashedPhone: matchLevel === "golden" ? hashValue(fakePhone()) : null,
      hashedEmail: matchLevel === "silver" ? hashValue(`user${i}@example.com`) : null,
      billingAddress: matchLevel === "bronze" ? `${randomFrom(STREETS)}, ${randomFrom(CITIES)}` : null,
      utmSource: eventType === "click" ? randomFrom(["google", "meta"]) : null,
      utmCampaign: eventType === "click" ? `campaign-${randomBetween(1, 6)}` : null,
      utmMedium: eventType === "click" ? "cpc" : null,
      landingPage: eventType === "click" ? `https://example.com/${randomFrom(["ac-repair", "heat-pump"])}` : null,
      matchLevel,
      matchConfidence: matchLevel === "diamond" ? 1.0 : matchLevel === "golden" ? 0.9 : matchLevel === "silver" ? 0.8 : matchLevel === "bronze" ? 0.6 : 0,
      createdAt: randomDate(30),
    });
  }
  await db.insert(attributionEventsTable).values(events);

  const changeLogEntries = [
    { tenantId: tenantIds[0], date: new Date(Date.now() - 25 * 86400000).toISOString().split("T")[0], title: "Launched Google Performance Max", description: "Switched to Performance Max campaign.", category: "campaign" },
    { tenantId: tenantIds[0], date: new Date(Date.now() - 15 * 86400000).toISOString().split("T")[0], title: "Budget Increase: Google Ads", description: "Increased daily budget from $150 to $250.", category: "budget" },
    { tenantId: tenantIds[1], date: new Date(Date.now() - 22 * 86400000).toISOString().split("T")[0], title: "Launched Fit Funnel Campaign", description: "Deployed multi-step quiz funnel.", category: "campaign" },
    { tenantId: tenantIds[1], date: new Date(Date.now() - 8 * 86400000).toISOString().split("T")[0], title: "Seasonal Budget Adjustment", description: "Increased ad budget by 20%.", category: "budget" },
  ];
  await db.insert(changeLogsTable).values(changeLogEntries);
}
