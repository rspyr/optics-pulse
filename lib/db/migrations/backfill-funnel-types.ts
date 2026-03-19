import { db, funnelTypesTable, tenantsTable } from "../src";
import { eq } from "drizzle-orm";

const DEFAULT_FUNNEL_TYPES = [
  { name: "Fit Funnel", slug: "fit-funnel", description: "Multi-step quiz funnel qualifying homeowner HVAC needs" },
  { name: "Emergency Repair", slug: "emergency-repair", description: "Direct high-intent emergency service landing page" },
  { name: "Financing Quiz", slug: "financing-quiz", description: "Monthly payment calculator with pre-qualification" },
  { name: "Seasonal Promo", slug: "seasonal-promo", description: "Limited-time seasonal discount offer funnel" },
];

const TENANT_SPECIFIC_OVERRIDES: Record<string, Array<{ name: string; slug: string; description: string }>> = {
  "Nordic Climate Solutions": [
    { name: "Home Assessment", slug: "home-assessment", description: "Full-home energy audit and HVAC assessment request" },
    { name: "Referral Program", slug: "referral-program", description: "Customer referral incentive landing page" },
    { name: "AC Tune-Up", slug: "ac-tune-up", description: "Spring AC maintenance special offer" },
  ],
};

async function backfillFunnelTypes() {
  console.log("[Backfill] Checking funnel types for all active tenants...");

  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));

  for (const tenant of tenants) {
    const existing = await db.select().from(funnelTypesTable).where(eq(funnelTypesTable.tenantId, tenant.id));

    if (existing.length > 0) {
      console.log(`[Backfill] ${tenant.name} (id=${tenant.id}): already has ${existing.length} funnel types — skipping`);
      continue;
    }

    const overrides = TENANT_SPECIFIC_OVERRIDES[tenant.name];
    const typesToInsert = overrides
      ? [DEFAULT_FUNNEL_TYPES[0], ...overrides]
      : DEFAULT_FUNNEL_TYPES;

    for (const ft of typesToInsert) {
      await db.insert(funnelTypesTable).values({
        tenantId: tenant.id,
        name: ft.name,
        slug: ft.slug,
        description: ft.description,
      });
    }
    console.log(`[Backfill] ${tenant.name} (id=${tenant.id}): inserted ${typesToInsert.length} funnel types`);
  }

  console.log("[Backfill] Complete!");
  process.exit(0);
}

backfillFunnelTypes().catch((err) => {
  console.error("[Backfill] Failed:", err);
  process.exit(1);
});
