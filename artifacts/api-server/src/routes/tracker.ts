import { Router, type IRouter } from "express";
import { db, trackerHeartbeatsTable, tenantsTable, attributionEventsTable, leadsTable, funnelTypesTable, tenantFunnelTypesTable, callAttemptsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { emitNewLead } from "../socket";
import { assignLeadRoundRobin } from "../services/round-robin";
import { scheduleAutoPass } from "../services/auto-pass-scheduler";
import { isValidAppointmentValue } from "../utils/appointment-validation";
import { normalizeSource } from "../services/source-normalizer";
import { normalizeAddress } from "../services/reconciliation";

const router: IRouter = Router();

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\+]/g, "").replace(/^1/, "");
}

async function resolveFunnelType(tenantId: number, funnelSlug: string | null | undefined): Promise<{ name: string; id: number } | null> {
  if (!funnelSlug) return null;
  const [ft] = await db.select().from(funnelTypesTable)
    .where(eq(funnelTypesTable.slug, funnelSlug));
  if (!ft) return null;
  const [assoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, ft.id)));
  if (!assoc) return null;
  return { name: ft.name, id: ft.id };
}

const PII_FIELD_PATTERNS: Record<string, string[]> = {
  firstName: ["first_name", "firstname", "fname", "first-name"],
  lastName: ["last_name", "lastname", "lname", "last-name"],
  email: ["email", "email_address", "emailaddress", "e-mail"],
  phone: ["phone", "phone_number", "phonenumber", "telephone", "tel", "mobile"],
  fullName: ["full_name", "fullname", "name", "your_name", "your-name"],
};

const ADDRESS_FIELD_PATTERNS: Record<string, string[]> = {
  street: ["address", "street", "street_address", "streetaddress", "address1", "address_1", "address_line_1", "addressline1"],
  city: ["city"],
  state: ["state", "province", "region"],
  zip: ["zip", "zipcode", "zip_code", "postal_code", "postalcode", "postal"],
};

function extractAddressFromFields(fields: Record<string, unknown>): string | null {
  const normalized = new Map<string, string>();
  for (const [key, val] of Object.entries(fields)) {
    if (typeof val === "string" && val.trim()) {
      normalized.set(key.toLowerCase().replace(/[\s-]/g, "_"), val.trim());
    }
  }

  const parts: Record<string, string | null> = { street: null, city: null, state: null, zip: null };
  for (const [partKey, patterns] of Object.entries(ADDRESS_FIELD_PATTERNS)) {
    for (const pattern of patterns) {
      const val = normalized.get(pattern);
      if (val) {
        parts[partKey] = val;
        break;
      }
    }
  }

  if (!parts.street && !parts.city) return null;

  const addressParts: string[] = [];
  if (parts.street) addressParts.push(parts.street);
  if (parts.city) addressParts.push(parts.city);
  if (parts.state && parts.zip) {
    addressParts.push(`${parts.state} ${parts.zip}`);
  } else if (parts.state) {
    addressParts.push(parts.state);
  } else if (parts.zip) {
    addressParts.push(parts.zip);
  }

  const raw = addressParts.join(", ");
  return normalizeAddress(raw);
}

function extractPiiFromFields(fields: Record<string, unknown>): { firstName: string | null; lastName: string | null; email: string | null; phone: string | null } {
  const result: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null } = {
    firstName: null, lastName: null, email: null, phone: null,
  };

  const normalized = new Map<string, string>();
  for (const [key, val] of Object.entries(fields)) {
    if (typeof val === "string" && val.trim()) {
      normalized.set(key.toLowerCase().replace(/[\s-]/g, "_"), val.trim());
    }
  }

  for (const [piiKey, patterns] of Object.entries(PII_FIELD_PATTERNS)) {
    if (piiKey === "fullName") continue;
    for (const pattern of patterns) {
      const val = normalized.get(pattern);
      if (val) {
        (result as Record<string, string | null>)[piiKey] = val;
        break;
      }
    }
  }

  if (!result.firstName) {
    for (const pattern of PII_FIELD_PATTERNS.fullName) {
      const val = normalized.get(pattern);
      if (val) {
        const parts = val.split(/\s+/);
        result.firstName = parts[0] || null;
        result.lastName = parts.slice(1).join(" ") || result.lastName;
        break;
      }
    }
  }

  return result;
}

router.post("/tracker/submit", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const clientId = typeof body.client_id === "string" ? body.client_id.trim() : null;

    if (!clientId) {
      res.status(400).json({ success: false, message: "client_id is required" });
      return;
    }

    const [tenant] = await db.select({ id: tenantsTable.id, name: tenantsTable.name })
      .from(tenantsTable)
      .where(eq(tenantsTable.clientSlug, clientId))
      .limit(1);

    if (!tenant) {
      res.status(404).json({ success: false, message: "Unknown client_id" });
      return;
    }

    const tenantId = tenant.id;
    const attribution = (body.attribution || {}) as Record<string, unknown>;
    const form = (body.form || {}) as Record<string, unknown>;
    const fields = (body.fields || {}) as Record<string, unknown>;
    const custom = (body.custom || {}) as Record<string, unknown>;

    const gclid = (attribution.gclid as string) || null;
    const fbclid = (attribution.fbclid as string) || null;
    const wbraid = (attribution.wbraid as string) || null;
    const msclkid = (attribution.msclkid as string) || null;
    const ttclid = (attribution.ttclid as string) || null;
    const liFatId = (attribution.li_fat_id as string) || null;
    const utmSource = (attribution.utm_source as string) || null;
    const utmMedium = (attribution.utm_medium as string) || null;
    const utmCampaign = (attribution.utm_campaign as string) || null;
    const utmTerm = (attribution.utm_term as string) || null;
    const utmContent = (attribution.utm_content as string) || null;

    const pageUrl = (body.page_url as string) || null;
    const landingPage = (body.landing_page as string) || null;
    const referrer = (body.referrer as string) || null;
    const submittedAtRaw = (body.submitted_at as string) || null;
    const submittedAt = submittedAtRaw ? new Date(submittedAtRaw) : new Date();

    const formType = (form.type as string) || null;
    const formId = (form.id as string) || null;
    const formName = (form.name as string) || null;

    const pii = extractPiiFromFields(fields);
    const hashedPhone = pii.phone ? hashValue(normalizePhone(pii.phone)) : null;
    const hashedEmail = pii.email ? hashValue(pii.email) : null;
    const billingAddress = extractAddressFromFields(fields);

    const formFieldsToStore = Object.keys(fields).length > 0
      ? { ...fields, ...(Object.keys(custom).length > 0 ? { _custom: custom } : {}) }
      : null;

    const matchLevel = gclid ? "diamond" as const
      : hashedPhone ? "golden" as const
      : hashedEmail ? "silver" as const
      : "unmatched" as const;
    const matchConfidence = gclid ? 1.0 : hashedPhone ? 0.9 : hashedEmail ? 0.8 : 0;

    const [event] = await db.insert(attributionEventsTable).values({
      tenantId,
      eventType: "form_fill",
      gclid,
      wbraid,
      fbclid,
      msclkid,
      ttclid,
      liFatId,
      hashedPhone,
      hashedEmail,
      billingAddress,
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      landingPage,
      pageUrl,
      referrer,
      userAgent: req.headers["user-agent"] || null,
      formType,
      formId,
      formName,
      formFields: formFieldsToStore,
      submittedAt,
      matchLevel,
      matchConfidence,
    }).returning();

    if (pii.firstName || pii.phone || pii.email) {
      const nameFields = [pii.firstName, pii.lastName].filter(Boolean).join(" ").toLowerCase();
      const isTestLead = nameFields.includes("test");

      if (!isTestLead) {
        const funnelSlug = (custom.funnel as string) || null;
        const resolved = await resolveFunnelType(tenantId, funnelSlug);
        const resolvedLeadType = resolved?.name || (utmSource || "form");
        const resolvedFunnelId = resolved?.id || null;

        const rawApptDate = (fields.appointment_date as string) || (fields.appointmentDate as string) || null;
        const rawApptTime = (fields.appointment_time as string) || (fields.appointmentTime as string) || null;
        const hasApptDetails = isValidAppointmentValue(rawApptDate) || isValidAppointmentValue(rawApptTime);

        const [newLead] = await db.insert(leadsTable).values({
          tenantId,
          firstName: pii.firstName || "Unknown",
          lastName: pii.lastName || "",
          phone: pii.phone || null,
          email: pii.email || null,
          source: await normalizeSource(tenantId, utmSource || "form"),
          matchedGclid: gclid || null,
          interestType: null,
          leadType: resolvedLeadType,
          funnelId: resolvedFunnelId,
          appointmentDate: rawApptDate,
          appointmentTime: rawApptTime,
          hubStatus: hasApptDetails ? "appt_booked" : "day_1",
          preBooked: hasApptDetails,
          dayInSequence: 1,
          status: "new",
          address: (fields.address as string) || null,
          city: (fields.city as string) || null,
          state: (fields.state as string) || null,
          zip: (fields.zip as string) || (fields.zipcode as string) || (fields.postal_code as string) || null,
        }).returning();

        if (newLead) {
          try {
            const result = await assignLeadRoundRobin(tenantId, newLead.id, resolvedFunnelId);
            if (result.assignedCsrId && result.passIntervalMinutes != null) {
              scheduleAutoPass(newLead.id, result.passIntervalMinutes * 60 * 1000);

              await db.insert(callAttemptsTable).values({
                leadId: newLead.id,
                userId: result.assignedCsrId,
                method: "system",
                outcome: "initial_assignment",
                platform: "native",
                actionType: "system",
                notes: `System: Lead initially assigned to ${result.csrName}`,
              });
            }
          } catch (err) {
            console.warn("[Tracker] Auto-assign round-robin failed for lead", newLead.id, err);
          }
          const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, newLead.id));
          emitNewLead(tenantId, (refreshed ?? newLead) as unknown as Record<string, unknown>);
        }
      }
    }

    res.json({ success: true, eventId: event.id });
  } catch (error) {
    console.error("[Tracker Submit] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to process submission";
    res.status(400).json({ success: false, message });
  }
});

router.post("/tracker/heartbeat", async (req, res) => {
  try {
    let tenantId = req.body.tenantId ? Number(req.body.tenantId) : null;
    const clientId = typeof req.body.clientId === "string" ? req.body.clientId.trim() : null;
    const domain = req.body.domain || req.headers.origin || null;
    const userAgent = req.headers["user-agent"] || null;

    if (!tenantId && clientId) {
      const [tenant] = await db.select({ id: tenantsTable.id })
        .from(tenantsTable)
        .where(eq(tenantsTable.clientSlug, clientId))
        .limit(1);
      if (tenant) tenantId = tenant.id;
    }

    if (!tenantId) {
      res.status(400).json({ error: "tenantId or clientId is required" });
      return;
    }

    const existing = await db.select().from(trackerHeartbeatsTable)
      .where(and(
        eq(trackerHeartbeatsTable.tenantId, tenantId),
        ...(domain ? [eq(trackerHeartbeatsTable.domain, domain)] : []),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(trackerHeartbeatsTable)
        .set({ lastSeenAt: new Date(), userAgent })
        .where(eq(trackerHeartbeatsTable.id, existing[0].id));
    } else {
      await db.insert(trackerHeartbeatsTable).values({
        tenantId,
        domain,
        userAgent,
      });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to record heartbeat" });
  }
});

router.get("/tracker/health", async (_req, res) => {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
  const heartbeats = await db.select().from(trackerHeartbeatsTable);

  const health = tenants.map(t => {
    const hb = heartbeats.filter(h => h.tenantId === t.id);
    const latest = hb.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())[0];
    const isHealthy = latest ? new Date(latest.lastSeenAt) > twentyFourHoursAgo : false;
    return {
      tenantId: t.id,
      tenantName: t.name,
      isHealthy,
      lastSeen: latest?.lastSeenAt || null,
      domain: latest?.domain || null,
    };
  });

  res.json(health);
});

export default router;
