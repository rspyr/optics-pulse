import { db, tenantsTable, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable, attributionEventsTable, changeLogsTable, funnelTypesTable } from "./src";
import crypto from "crypto";

const FIRST_NAMES = ["John", "Sarah", "Michael", "Emily", "David", "Jessica", "Robert", "Amanda", "William", "Jennifer", "James", "Lisa", "Daniel", "Maria", "Christopher", "Ashley", "Matthew", "Nicole", "Andrew", "Stephanie"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee"];
const SOURCES = ["Google Ads", "Meta Leads", "CallRail", "Organic Search", "Direct", "Referral"];
const INTEREST_TYPES = ["Heat Pump", "AC Repair", "Full System", "Furnace", "Maintenance", "Ductless Mini-Split", "Thermostat", "Air Quality"];
const LEAD_STATUSES = ["new", "contacted", "booked", "sold", "lost"] as const;
const JOB_TYPES = ["Install", "Repair", "Maintenance", "Replacement", "Inspection", "Emergency"];
const MATCH_LEVELS = ["diamond", "golden", "silver", "bronze", "unmatched"] as const;
const EVENT_TYPES = ["click", "call", "form_fill"] as const;
const STREETS = ["123 Oak Street", "456 Maple Avenue", "789 Pine Drive", "321 Elm Road", "654 Cedar Boulevard", "987 Birch Lane", "246 Walnut Court", "135 Cherry Street", "864 Spruce Avenue", "753 Ash Drive"];
const CITIES = ["Phoenix, AZ 85001", "Mesa, AZ 85201", "Scottsdale, AZ 85251", "Tempe, AZ 85281", "Chandler, AZ 85224", "Minneapolis, MN 55401", "St Paul, MN 55101", "Bloomington, MN 55420", "Edina, MN 55424", "Plymouth, MN 55441"];

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
  const now = new Date();
  const ms = now.getTime() - Math.random() * daysAgo * 86400000;
  return new Date(ms);
}

function fakePhone(): string {
  return `(${randomBetween(200, 999)}) ${randomBetween(200, 999)}-${randomBetween(1000, 9999)}`;
}

function fakeGclid(): string {
  return `CjwKCAjw${crypto.randomBytes(8).toString("hex")}`;
}

async function seed() {
  console.log("Seeding database...");

  const [t1] = await db.insert(tenantsTable).values({ name: "Apex HVAC", serviceTitanId: "ST-APEX-001", timezone: "America/New_York" }).returning();
  const [t2] = await db.insert(tenantsTable).values({ name: "Nordic Climate Solutions", serviceTitanId: "ST-NORDIC-002", timezone: "America/Chicago" }).returning();
  console.log(`Created tenants: ${t1.name} (id=${t1.id}), ${t2.name} (id=${t2.id})`);

  const campaigns = [];
  const campaignDefs = [
    { tenantId: t1.id, platform: "google", externalId: "G-APEX-BRAND-001", name: "Apex - Brand Search", status: "active" },
    { tenantId: t1.id, platform: "google", externalId: "G-APEX-HEAT-002", name: "Apex - Heat Pump Install", status: "active" },
    { tenantId: t1.id, platform: "meta", externalId: "M-APEX-LEAD-003", name: "Apex - Facebook Lead Gen", status: "active" },
    { tenantId: t2.id, platform: "google", externalId: "G-NORD-AC-001", name: "Nordic - AC Repair Near Me", status: "active" },
    { tenantId: t2.id, platform: "google", externalId: "G-NORD-FURN-002", name: "Nordic - Furnace Replacement", status: "active" },
    { tenantId: t2.id, platform: "meta", externalId: "M-NORD-LEAD-003", name: "Nordic - Instagram Reels", status: "paused" },
  ];
  for (const c of campaignDefs) {
    const [campaign] = await db.insert(campaignsTable).values(c).returning();
    campaigns.push(campaign);
  }
  console.log(`Created ${campaigns.length} campaigns`);

  const dailyStats = [];
  for (let dayOffset = 30; dayOffset >= 0; dayOffset--) {
    const d = new Date();
    d.setDate(d.getDate() - dayOffset);
    const dateStr = d.toISOString().split("T")[0];

    for (const campaign of campaigns) {
      const isActive = campaign.status === "active";
      const baseSpend = campaign.platform === "google" ? randomBetween(80, 350) : randomBetween(40, 200);
      dailyStats.push({
        campaignId: campaign.id,
        date: dateStr,
        spend: isActive ? baseSpend + Math.random() * 50 : 0,
        impressions: isActive ? randomBetween(500, 5000) : 0,
        clicks: isActive ? randomBetween(10, 120) : 0,
        conversions: isActive ? randomBetween(0, 8) : 0,
      });
    }
  }
  await db.insert(campaignDailyStatsTable).values(dailyStats);
  console.log(`Created ${dailyStats.length} daily stat rows`);

  const funnelTypeDefs = [
    { tenantId: t1.id, name: "Fit Funnel", slug: "fit-funnel", description: "Multi-step quiz funnel qualifying homeowner HVAC needs" },
    { tenantId: t1.id, name: "Emergency Repair", slug: "emergency-repair", description: "Direct high-intent emergency service landing page" },
    { tenantId: t1.id, name: "Financing Quiz", slug: "financing-quiz", description: "Monthly payment calculator with pre-qualification" },
    { tenantId: t1.id, name: "Seasonal Promo", slug: "seasonal-promo", description: "Limited-time seasonal discount offer funnel" },
    { tenantId: t2.id, name: "Fit Funnel", slug: "fit-funnel", description: "Multi-step quiz funnel qualifying homeowner HVAC needs" },
    { tenantId: t2.id, name: "Home Assessment", slug: "home-assessment", description: "Full-home energy audit and HVAC assessment request" },
    { tenantId: t2.id, name: "Referral Program", slug: "referral-program", description: "Customer referral incentive landing page" },
    { tenantId: t2.id, name: "AC Tune-Up", slug: "ac-tune-up", description: "Spring AC maintenance special offer" },
  ];
  const funnelTypes = [];
  for (const ft of funnelTypeDefs) {
    const [ftype] = await db.insert(funnelTypesTable).values(ft).returning();
    funnelTypes.push(ftype);
  }
  console.log(`Created ${funnelTypes.length} funnel types`);

  const t1FunnelTypes = funnelTypes.filter(ft => ft.tenantId === t1.id);
  const t2FunnelTypes = funnelTypes.filter(ft => ft.tenantId === t2.id);

  const tenantIds = [t1.id, t2.id];
  const leads = [];
  for (let i = 0; i < 80; i++) {
    const tenantId = i < 50 ? t1.id : t2.id;
    const firstName = randomFrom(FIRST_NAMES);
    const lastName = randomFrom(LAST_NAMES);
    const phone = fakePhone();
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`;
    const source = randomFrom(SOURCES);
    const status = randomFrom(LEAD_STATUSES);
    const gclid = source === "Google Ads" ? fakeGclid() : null;
    const createdAt = randomDate(30);
    const tenantFunnels = tenantId === t1.id ? t1FunnelTypes : t2FunnelTypes;
    const funnelType = randomFrom(tenantFunnels);

    const [lead] = await db.insert(leadsTable).values({
      tenantId,
      firstName,
      lastName,
      phone,
      email,
      source,
      leadType: funnelType.name,
      interestType: randomFrom(INTEREST_TYPES),
      status,
      isNewCustomer: Math.random() > 0.3,
      matchedGclid: gclid,
      createdAt,
      updatedAt: createdAt,
    }).returning();
    leads.push(lead);
  }
  console.log(`Created ${leads.length} leads`);

  const jobs = [];
  const soldLeads = leads.filter(l => l.status === "sold" || l.status === "booked");
  for (const lead of soldLeads) {
    const revenue = randomBetween(800, 12000);
    const completed = lead.status === "sold";
    const completedAt = completed ? new Date(lead.createdAt.getTime() + randomBetween(1, 14) * 86400000) : null;
    const matchLevel = lead.matchedGclid ? "diamond" : Math.random() > 0.5 ? "golden" : "silver";

    const serviceAddress = `${randomFrom(STREETS)}, ${randomFrom(CITIES)}`;
    const [job] = await db.insert(jobsTable).values({
      tenantId: lead.tenantId,
      stJobId: `STJ-${randomBetween(10000, 99999)}`,
      customerName: `${lead.firstName} ${lead.lastName}`,
      serviceAddress,
      jobType: randomFrom(JOB_TYPES),
      revenue,
      status: completed ? "completed" : "in_progress",
      matchedGclid: lead.matchedGclid,
      matchLevel,
      completedAt,
      createdAt: lead.createdAt,
      updatedAt: completedAt || lead.createdAt,
    }).returning();
    jobs.push(job);
  }
  console.log(`Created ${jobs.length} jobs`);

  const events = [];
  for (let i = 0; i < 120; i++) {
    const tenantId = randomFrom(tenantIds);
    const eventType = randomFrom(EVENT_TYPES);
    const matchLevel = randomFrom(MATCH_LEVELS);
    const gclid = matchLevel === "diamond" ? fakeGclid() : null;
    const hashedPhone = matchLevel === "golden" ? hashValue(fakePhone()) : null;
    const hashedEmail = matchLevel === "silver" ? hashValue(`user${i}@example.com`) : null;

    events.push({
      tenantId,
      eventType,
      gclid,
      hashedPhone,
      hashedEmail,
      billingAddress: matchLevel === "bronze" ? `${randomFrom(STREETS)}, ${randomFrom(CITIES)}` : null,
      utmSource: eventType === "click" ? randomFrom(["google", "meta", "bing"]) : null,
      utmCampaign: eventType === "click" ? `campaign-${randomBetween(1, 6)}` : null,
      utmMedium: eventType === "click" ? "cpc" : null,
      landingPage: eventType === "click" ? `https://example.com/${randomFrom(["ac-repair", "heat-pump", "furnace", "hvac-near-me"])}` : null,
      matchLevel,
      matchConfidence: matchLevel === "diamond" ? 1.0 : matchLevel === "golden" ? 0.9 : matchLevel === "silver" ? 0.8 : matchLevel === "bronze" ? 0.6 : 0,
      createdAt: randomDate(30),
    });
  }
  await db.insert(attributionEventsTable).values(events);
  console.log(`Created ${events.length} attribution events`);

  const changeLogEntries = [
    { tenantId: t1.id, date: new Date(Date.now() - 25 * 86400000).toISOString().split("T")[0], title: "Launched Google Performance Max", description: "Switched from standard search to Performance Max campaign targeting HVAC install keywords across Google properties.", category: "campaign" },
    { tenantId: t1.id, date: new Date(Date.now() - 20 * 86400000).toISOString().split("T")[0], title: "Updated Meta Lead Form", description: "Reduced lead form fields from 8 to 4. Added instant form pre-fill for returning visitors.", category: "creative" },
    { tenantId: t1.id, date: new Date(Date.now() - 15 * 86400000).toISOString().split("T")[0], title: "Budget Increase: Google Ads", description: "Increased daily budget from $150 to $250 based on strong ROAS performance over last 14 days.", category: "budget" },
    { tenantId: t1.id, date: new Date(Date.now() - 10 * 86400000).toISOString().split("T")[0], title: "New Landing Page: Heat Pump", description: "Deployed dedicated heat pump landing page with video testimonial and financing calculator.", category: "creative" },
    { tenantId: t1.id, date: new Date(Date.now() - 5 * 86400000).toISOString().split("T")[0], title: "Paused Low-Performing Ad Sets", description: "Paused 3 Meta ad sets with CPL above $200. Reallocated budget to top-performing lookalike audiences.", category: "campaign" },
    { tenantId: t2.id, date: new Date(Date.now() - 22 * 86400000).toISOString().split("T")[0], title: "Launched Fit Funnel Campaign", description: "Deployed new multi-step quiz funnel targeting homeowners with aging HVAC systems.", category: "campaign" },
    { tenantId: t2.id, date: new Date(Date.now() - 18 * 86400000).toISOString().split("T")[0], title: "Google Ads: Negative Keywords Update", description: "Added 45 negative keywords to eliminate commercial/DIY search traffic waste.", category: "campaign" },
    { tenantId: t2.id, date: new Date(Date.now() - 12 * 86400000).toISOString().split("T")[0], title: "New Video Creative", description: "Launched 3 new 15-second video ads featuring customer testimonials for Meta placement.", category: "creative" },
    { tenantId: t2.id, date: new Date(Date.now() - 8 * 86400000).toISOString().split("T")[0], title: "Seasonal Budget Adjustment", description: "Increased overall ad budget by 20% ahead of spring HVAC season.", category: "budget" },
    { tenantId: t2.id, date: new Date(Date.now() - 3 * 86400000).toISOString().split("T")[0], title: "A/B Test: Landing Page CTAs", description: "Started A/B test comparing 'Get Free Estimate' vs 'Schedule Your Consultation' CTAs.", category: "creative" },
  ];
  await db.insert(changeLogsTable).values(changeLogEntries);
  console.log(`Created ${changeLogEntries.length} change log entries`);

  console.log("\nSeed complete!");
  console.log(`Summary: 2 tenants, ${campaigns.length} campaigns, ${dailyStats.length} daily stats, ${leads.length} leads, ${jobs.length} jobs, ${events.length} attribution events, ${changeLogEntries.length} change logs`);
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
