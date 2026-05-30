/**
 * Task #592 — Coverage for the `2026-05-20_backfill-attribution-event-
 * manual-source` one-time migration heuristic. The migration walks legacy
 * `match_level='manual'` attribution_events rows that have
 * `manual_source IS NULL` (written before task #584 added the column) and
 * stamps them with the *most plausible* operator action that caused the
 * flip, using two time-bounded signals:
 *   - Per-lead funnel correction with newValue == event.resolvedFunnel and
 *     changedAt > event.createdAt  →  `funnel_override:lead/<leadId>`
 *   - Field-mapping rule whose scope matches (pagePath, formIdent or `*`),
 *     whose fieldName appears in event.form_fields, and whose updatedAt
 *     > event.createdAt  →  `field_mapping_rule:<ruleId>`
 *
 * The funnel override takes precedence when both signals match. Rows with
 * neither signal stay NULL so the read-side fallback "resolved by hand"
 * line still renders.
 *
 * This file pins down all three branches plus the precedence ordering and
 * the wildcard form rule, so a future refactor (e.g. dropping the `*`
 * scope match, or flipping the priority) trips a loud test instead of
 * silently degrading coverage on the next tenant to run the migration.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sql, and, eq, inArray } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const {
  db,
  pool,
  tenantsTable,
  leadsTable,
  attributionEventsTable,
  fieldMappingRulesTable,
  leadAttributionCorrectionsTable,
} = dbModule;

const { backfillManualSourceForLegacyEvents } = await import("./one-time-migrations");

async function createTestTenant(suffix: string): Promise<number> {
  const slug = `man-src-bf-${suffix}`;
  const [row] = await db.insert(tenantsTable).values({
    name: `Manual-source backfill ${slug}`,
    clientSlug: slug,
  }).returning();
  return row.id;
}

async function createTestLead(tenantId: number): Promise<number> {
  const [row] = await db.insert(leadsTable).values({
    tenantId,
    firstName: "Test",
    lastName: "Lead",
    source: "manual",
    originalSource: "manual",
  }).returning();
  return row.id;
}

interface SeedEventOpts {
  tenantId: number;
  leadId: number;
  pageUrl: string;
  formId: string;
  formName?: string;
  formFields: Record<string, unknown>;
  resolvedFunnel: string;
  createdAt: Date;
}

async function seedLegacyManualEvent(opts: SeedEventOpts): Promise<number> {
  // We need a deterministic createdAt so the migration's "signal happened
  // AFTER the event" temporal gate is testable; drizzle's defaultNow()
  // would shadow whatever we pass, so go through raw SQL.
  const externalId = `man-src-bf-${opts.tenantId}-${opts.leadId}`;
  const result = await db.execute(sql`
    INSERT INTO attribution_events (
      tenant_id, event_type, page_url, form_id, form_name, form_fields,
      resolved_funnel, match_level, match_confidence, manual_source,
      external_id, created_lead_id, created_at
    ) VALUES (
      ${opts.tenantId}, 'form_fill', ${opts.pageUrl}, ${opts.formId},
      ${opts.formName ?? null}, ${JSON.stringify(opts.formFields)}::jsonb,
      ${opts.resolvedFunnel}, 'manual', 1.0, NULL,
      ${externalId}, ${opts.leadId}, ${opts.createdAt.toISOString()}
    ) RETURNING id
  `);
  return Number((result.rows[0] as { id: number }).id);
}

const createdTenants: number[] = [];
const createdLeads: number[] = [];

async function deleteTenantCascade(tenantId: number): Promise<void> {
  await db.delete(attributionEventsTable).where(eq(attributionEventsTable.tenantId, tenantId));
  await db.delete(fieldMappingRulesTable).where(eq(fieldMappingRulesTable.tenantId, tenantId));
  await db.delete(leadAttributionCorrectionsTable).where(eq(leadAttributionCorrectionsTable.tenantId, tenantId));
  if (createdLeads.length > 0) {
    await db.delete(leadsTable).where(and(
      eq(leadsTable.tenantId, tenantId),
      inArray(leadsTable.id, createdLeads),
    ));
  }
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  for (const id of createdTenants) {
    try { await deleteTenantCascade(id); } catch { /* best-effort */ }
  }
  vi.restoreAllMocks();
  await pool.end().catch(() => {});
});

beforeEach(() => {
  delete process.env.BACKFILL_MANUAL_SOURCE_DRY_RUN;
});

describe("backfillManualSourceForLegacyEvents (real Postgres, task #592)", () => {
  it("stamps `field_mapping_rule:<id>` when a matching rule was last edited AFTER the event was created and one of the rule's fields appears in form_fields", async () => {
    const tenantId = await createTestTenant("rule");
    createdTenants.push(tenantId);
    const leadId = await createTestLead(tenantId);
    createdLeads.push(leadId);

    const eventCreatedAt = new Date("2026-01-01T00:00:00Z");
    const eventId = await seedLegacyManualEvent({
      tenantId,
      leadId,
      pageUrl: "https://example.com/contact",
      formId: "contact-form",
      formFields: { email: "x@y.com", phone: "555" },
      resolvedFunnel: "Bath",
      createdAt: eventCreatedAt,
    });

    const [rule] = await db.insert(fieldMappingRulesTable).values({
      tenantId,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      fieldName: "email",
      mapsTo: "email",
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    }).returning();

    await backfillManualSourceForLegacyEvents();

    const [stamped] = await db.select().from(attributionEventsTable)
      .where(eq(attributionEventsTable.id, eventId));
    expect(stamped.manualSource).toBe(`field_mapping_rule:${rule.id}`);
  });

  it("matches wildcard `*` form rules so a tenant-wide page rule (not bound to a specific formId) still claims credit", async () => {
    const tenantId = await createTestTenant("wildcard");
    createdTenants.push(tenantId);
    const leadId = await createTestLead(tenantId);
    createdLeads.push(leadId);

    const eventId = await seedLegacyManualEvent({
      tenantId,
      leadId,
      pageUrl: "https://example.com/quote",
      formId: "some-random-form-id",
      formFields: { phone: "555-1212" },
      resolvedFunnel: "Windows",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const [wildcardRule] = await db.insert(fieldMappingRulesTable).values({
      tenantId,
      pageUrlPattern: "/quote",
      formIdentifier: "*",
      fieldName: "phone",
      mapsTo: "phone",
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    }).returning();

    await backfillManualSourceForLegacyEvents();

    const [stamped] = await db.select().from(attributionEventsTable)
      .where(eq(attributionEventsTable.id, eventId));
    expect(stamped.manualSource).toBe(`field_mapping_rule:${wildcardRule.id}`);
  });

  it("stamps `funnel_override:lead/<leadId>` when a per-lead funnel correction with newValue == event.resolvedFunnel was recorded after the event — AND prefers it over a simultaneously-matching rule (override wins)", async () => {
    const tenantId = await createTestTenant("override");
    createdTenants.push(tenantId);
    const leadId = await createTestLead(tenantId);
    createdLeads.push(leadId);

    const eventId = await seedLegacyManualEvent({
      tenantId,
      leadId,
      pageUrl: "https://example.com/contact",
      formId: "contact-form",
      formFields: { email: "x@y.com" },
      resolvedFunnel: "Roofing",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    // Seed a rule that WOULD match if the override priority were reversed.
    // The test asserts the override stamp lands, which is only possible if
    // the override branch fires first and `continue`s past the rule branch.
    await db.insert(fieldMappingRulesTable).values({
      tenantId,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      fieldName: "email",
      mapsTo: "email",
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    });

    await db.insert(leadAttributionCorrectionsTable).values({
      tenantId,
      leadId,
      field: "funnel",
      oldValue: "Unknown",
      newValue: "Roofing",
      changedAt: new Date("2026-02-15T00:00:00Z"),
    });

    await backfillManualSourceForLegacyEvents();

    const [stamped] = await db.select().from(attributionEventsTable)
      .where(eq(attributionEventsTable.id, eventId));
    expect(stamped.manualSource).toBe(`funnel_override:lead/${leadId}`);
  });

  it("leaves manual_source NULL when no qualifying signal exists — neither a matching post-event funnel correction nor a matching post-event field-mapping rule", async () => {
    const tenantId = await createTestTenant("null");
    createdTenants.push(tenantId);
    const leadId = await createTestLead(tenantId);
    createdLeads.push(leadId);

    const eventId = await seedLegacyManualEvent({
      tenantId,
      leadId,
      pageUrl: "https://example.com/contact",
      formId: "contact-form",
      formFields: { email: "x@y.com" },
      resolvedFunnel: "Bath",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    // A rule exists, but its updatedAt PREDATES the event — the temporal
    // gate must reject it so the row stays NULL (a rule edited before the
    // event existed couldn't be the cause of the manual flip).
    await db.insert(fieldMappingRulesTable).values({
      tenantId,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      fieldName: "email",
      mapsTo: "email",
      updatedAt: new Date("2025-12-01T00:00:00Z"),
    });

    // A funnel correction exists, but its newValue does not equal
    // event.resolvedFunnel — the override path must reject it (the live
    // override writes (correction.newValue == event.resolvedFunnel) in
    // one transaction; anything else is an unrelated later edit).
    await db.insert(leadAttributionCorrectionsTable).values({
      tenantId,
      leadId,
      field: "funnel",
      oldValue: "Bath",
      newValue: "Windows",
      changedAt: new Date("2026-02-15T00:00:00Z"),
    });

    await backfillManualSourceForLegacyEvents();

    const [stamped] = await db.select().from(attributionEventsTable)
      .where(eq(attributionEventsTable.id, eventId));
    expect(stamped.manualSource).toBeNull();
  });

  it("classifyAlreadyStamped=true returns the full legacy cohort (already-stamped + still-NULL) scoped to a tenant — backs the task #596 admin diagnostics endpoint", async () => {
    const tenantId = await createTestTenant("diag");
    createdTenants.push(tenantId);
    const leadOverride = await createTestLead(tenantId);
    const leadRule = await createTestLead(tenantId);
    const leadAmbiguous = await createTestLead(tenantId);
    createdLeads.push(leadOverride, leadRule, leadAmbiguous);

    // Already-stamped: simulate a row the live override path wrote
    // (manualSource present, prefix "funnel_override:").
    const stampedOverrideId = await seedLegacyManualEvent({
      tenantId,
      leadId: leadOverride,
      pageUrl: "https://example.com/a",
      formId: "fa",
      formFields: { email: "a@b.com" },
      resolvedFunnel: "Bath",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.execute(sql`
      UPDATE attribution_events SET manual_source = ${`funnel_override:lead/${leadOverride}`}
      WHERE id = ${stampedOverrideId}
    `);

    // Will be stamped by the heuristic during the read-only pass
    // (rule.updatedAt > event.createdAt, field matches).
    await seedLegacyManualEvent({
      tenantId,
      leadId: leadRule,
      pageUrl: "https://example.com/contact",
      formId: "contact-form",
      formFields: { email: "c@d.com" },
      resolvedFunnel: "Bath",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(fieldMappingRulesTable).values({
      tenantId,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      fieldName: "email",
      mapsTo: "email",
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    });

    // Ambiguous tail — a rule exists but its updatedAt predates the event,
    // so the temporal gate must reject it and bump the rule-skip counter
    // rather than leftNullAmbiguous-only (the report needs the distinction).
    await seedLegacyManualEvent({
      tenantId,
      leadId: leadAmbiguous,
      pageUrl: "https://example.com/quote",
      formId: "quote-form",
      formFields: { phone: "555" },
      resolvedFunnel: "Roofing",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(fieldMappingRulesTable).values({
      tenantId,
      pageUrlPattern: "/quote",
      formIdentifier: "quote-form",
      fieldName: "phone",
      mapsTo: "phone",
      updatedAt: new Date("2025-12-01T00:00:00Z"),
    });

    const counters = await backfillManualSourceForLegacyEvents({
      dryRun: true,
      classifyAlreadyStamped: true,
      tenantId,
    });

    expect(counters.totalLegacyManualRows).toBe(3);
    expect(counters.stampedByFunnelOverride).toBe(1); // already-stamped
    expect(counters.stampedByFieldMappingRule).toBe(1); // would-stamp on re-run
    expect(counters.leftNullAmbiguous).toBe(1);
    expect(counters.skippedRuleNoTemporalMatch).toBe(1);
    expect(counters.skippedOverrideNoTemporalMatch).toBe(0);

    // dryRun + classifyAlreadyStamped must NOT mutate the table: the
    // would-be-stamped rule row should still have manual_source IS NULL.
    const stillNull = await db.select().from(attributionEventsTable)
      .where(and(
        eq(attributionEventsTable.tenantId, tenantId),
        eq(attributionEventsTable.createdLeadId, leadRule),
      ));
    expect(stillNull[0].manualSource).toBeNull();
  });
});
