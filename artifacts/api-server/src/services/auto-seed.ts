import { db, usersTable, tenantsTable, campaignsTable, campaignDailyStatsTable, leadsTable, jobsTable, attributionEventsTable, changeLogsTable, funnelTypesTable } from "@workspace/db";
import bcrypt from "bcryptjs";
import crypto from "crypto";

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

export async function autoSeedIfEmpty() {
  try {
    const existingUsers = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    if (existingUsers.length > 0) {
      return;
    }

    console.log("[AutoSeed] Empty database detected, seeding...");

    const [t1] = await db.insert(tenantsTable).values({ name: "Apex HVAC", serviceTitanId: "ST-APEX-001", timezone: "America/New_York" }).returning();
    const [t2] = await db.insert(tenantsTable).values({ name: "Nordic Climate Solutions", serviceTitanId: "ST-NORDIC-002", timezone: "America/Chicago" }).returning();
    const [t3] = await db.insert(tenantsTable).values({ name: "Advantage Heating & Cooling", serviceTitanId: "ST-ADV-003", timezone: "America/Denver" }).returning();
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

    const campaignDefs = [
      { tenantId: t1.id, platform: "google", externalId: "G-APEX-BRAND-001", name: "Apex - Brand Search", status: "active" },
      { tenantId: t1.id, platform: "google", externalId: "G-APEX-HEAT-002", name: "Apex - Heat Pump Install", status: "active" },
      { tenantId: t1.id, platform: "meta", externalId: "M-APEX-LEAD-003", name: "Apex - Facebook Lead Gen", status: "active" },
      { tenantId: t2.id, platform: "google", externalId: "G-NORD-AC-001", name: "Nordic - AC Repair Near Me", status: "active" },
      { tenantId: t2.id, platform: "google", externalId: "G-NORD-FURN-002", name: "Nordic - Furnace Replacement", status: "active" },
      { tenantId: t2.id, platform: "meta", externalId: "M-NORD-LEAD-003", name: "Nordic - Instagram Reels", status: "paused" },
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

    const funnelTypeDefs = [
      { tenantId: t1.id, name: "Fit Funnel", slug: "fit-funnel", description: "Multi-step quiz funnel" },
      { tenantId: t1.id, name: "Emergency Repair", slug: "emergency-repair", description: "Emergency service page" },
      { tenantId: t2.id, name: "Fit Funnel", slug: "fit-funnel", description: "Multi-step quiz funnel" },
      { tenantId: t2.id, name: "Home Assessment", slug: "home-assessment", description: "Energy audit request" },
    ];
    const funnelTypes = [];
    for (const ft of funnelTypeDefs) {
      const [ftype] = await db.insert(funnelTypesTable).values(ft).returning();
      funnelTypes.push(ftype);
    }

    const leads = [];
    for (let i = 0; i < 60; i++) {
      const tenantId = i < 35 ? t1.id : i < 50 ? t2.id : t3.id;
      const firstName = randomFrom(FIRST_NAMES);
      const lastName = randomFrom(LAST_NAMES);
      const source = randomFrom(SOURCES);
      const status = randomFrom(LEAD_STATUSES);
      const gclid = source === "Google Ads" ? fakeGclid() : null;
      const createdAt = randomDate(30);
      const tenantFunnels = funnelTypes.filter(ft => ft.tenantId === tenantId);
      const funnelType = tenantFunnels.length > 0 ? randomFrom(tenantFunnels) : null;

      const [lead] = await db.insert(leadsTable).values({
        tenantId,
        firstName,
        lastName,
        phone: fakePhone(),
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
        source,
        leadType: funnelType?.name || "General",
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
      const tenantId = randomFrom([t1.id, t2.id, t3.id]);
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
      { tenantId: t1.id, date: new Date(Date.now() - 25 * 86400000).toISOString().split("T")[0], title: "Launched Google Performance Max", description: "Switched to Performance Max campaign.", category: "campaign" },
      { tenantId: t1.id, date: new Date(Date.now() - 15 * 86400000).toISOString().split("T")[0], title: "Budget Increase: Google Ads", description: "Increased daily budget from $150 to $250.", category: "budget" },
      { tenantId: t2.id, date: new Date(Date.now() - 22 * 86400000).toISOString().split("T")[0], title: "Launched Fit Funnel Campaign", description: "Deployed multi-step quiz funnel.", category: "campaign" },
      { tenantId: t2.id, date: new Date(Date.now() - 8 * 86400000).toISOString().split("T")[0], title: "Seasonal Budget Adjustment", description: "Increased ad budget by 20%.", category: "budget" },
    ];
    await db.insert(changeLogsTable).values(changeLogEntries);

    console.log(`[AutoSeed] Seed complete: 3 tenants, ${users.length} users, ${campaigns.length} campaigns, ${leads.length} leads`);
  } catch (err) {
    console.error("[AutoSeed] Seed failed:", err instanceof Error ? err.message : err);
  }
}
