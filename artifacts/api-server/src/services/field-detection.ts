import { db, fieldMappingRulesTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";

export type SemanticField =
  | "firstName"
  | "lastName"
  | "fullName"
  | "email"
  | "phone"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "funnel"
  | "appointmentDate"
  | "appointmentTime";

export interface DetectedField {
  fieldName: string;
  mapsTo: SemanticField;
  value: string;
  method: "value_pattern" | "field_name" | "saved_rule";
  confidence: number;
}

export interface DetectionResult {
  fields: DetectedField[];
  pii: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  };
  funnelRawValue: string | null;
  addressParts: {
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[\d\s\-\(\)\+\.]{7,20}$/;
const PHONE_DIGIT_MIN = 7;

const FIELD_NAME_PATTERNS: Record<SemanticField, string[]> = {
  firstName: ["first_name", "firstname", "fname", "first", "first-name", "your_first_name"],
  lastName: ["last_name", "lastname", "lname", "last", "last-name", "your_last_name"],
  fullName: ["full_name", "fullname", "name", "your_name", "your-name", "contact_name", "customer_name"],
  email: ["email", "email_address", "emailaddress", "e-mail", "e_mail", "your_email", "contact_email"],
  phone: [
    "phone", "phone_number", "phonenumber", "telephone", "tel", "mobile",
    "cell", "cellphone", "cell_phone", "contact_phone", "your_phone",
    "phone-number", "mobile_number", "mobile_phone",
  ],
  address: [
    "address", "street", "street_address", "streetaddress", "address1",
    "address_1", "address_line_1", "addressline1", "street_address_1",
  ],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  zip: ["zip", "zipcode", "zip_code", "postal_code", "postalcode", "postal"],
  funnel: [
    "service", "service_needed", "service_type", "servicetype", "interest",
    "project_type", "projecttype", "service_interest", "type_of_service",
    "what_do_you_need", "how_can_we_help", "reason", "inquiry_type",
    "request_type", "service_requested", "services",
  ],
  appointmentDate: ["appointment_date", "appointmentdate", "preferred_date", "date", "schedule_date"],
  appointmentTime: ["appointment_time", "appointmenttime", "preferred_time", "time", "schedule_time"],
};

function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[\s\-\.]/g, "_");
}

export function extractPagePath(pageUrl: string | null): string {
  if (!pageUrl) return "/";
  try {
    const url = new URL(pageUrl);
    return url.pathname || "/";
  } catch {
    return "/";
  }
}

export function getFormIdentifier(formId: string | null, formName: string | null): string {
  return formId || formName || "_unknown_";
}

interface RuleCacheEntry {
  rules: Map<string, SemanticField>;
  expiresAt: number;
}

const ruleCache = new Map<string, RuleCacheEntry>();
const RULE_TTL_MS = 60_000;

async function loadRules(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
): Promise<Map<string, SemanticField>> {
  const identifiers = [formIdentifier];
  if (formIdentifier !== "*") identifiers.push("*");

  const rows = await db
    .select()
    .from(fieldMappingRulesTable)
    .where(
      and(
        eq(fieldMappingRulesTable.tenantId, tenantId),
        eq(fieldMappingRulesTable.pageUrlPattern, pageUrlPattern),
        inArray(fieldMappingRulesTable.formIdentifier, identifiers),
      ),
    )
    .orderBy(fieldMappingRulesTable.priority);

  const map = new Map<string, SemanticField>();
  for (const row of rows) {
    const key = normalizeFieldKey(row.fieldName);
    if (!map.has(key)) {
      map.set(key, row.mapsTo as SemanticField);
    }
  }
  return map;
}

async function getRules(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
): Promise<Map<string, SemanticField>> {
  const cacheKey = `${tenantId}:${pageUrlPattern}:${formIdentifier}`;
  const cached = ruleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rules;
  }
  const rules = await loadRules(tenantId, pageUrlPattern, formIdentifier);
  ruleCache.set(cacheKey, { rules, expiresAt: Date.now() + RULE_TTL_MS });
  return rules;
}

export function invalidateRuleCache(tenantId: number, pageUrlPattern?: string): void {
  for (const key of ruleCache.keys()) {
    if (key.startsWith(`${tenantId}:`)) {
      if (!pageUrlPattern || key.startsWith(`${tenantId}:${pageUrlPattern}:`)) {
        ruleCache.delete(key);
      }
    }
  }
}

function matchFieldName(normalizedKey: string, semantic: SemanticField): boolean {
  const patterns = FIELD_NAME_PATTERNS[semantic];
  if (!patterns) return false;
  for (const p of patterns) {
    if (normalizedKey === p) return true;
  }
  for (const p of patterns) {
    if (normalizedKey.includes(p) || p.includes(normalizedKey)) return true;
  }
  return false;
}

const NAME_REGEX = /^[A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20}){0,3}$/;

function detectByValuePattern(value: string): SemanticField | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (EMAIL_REGEX.test(trimmed)) return "email";

  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length >= PHONE_DIGIT_MIN && PHONE_REGEX.test(trimmed)) return "phone";

  if (NAME_REGEX.test(trimmed) && trimmed.length >= 2 && trimmed.length <= 50) {
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) return "fullName";
    return "firstName";
  }

  return null;
}

export async function detectFields(
  tenantId: number,
  fields: Record<string, unknown>,
  pageUrl: string | null,
  formId: string | null,
  formName: string | null,
): Promise<DetectionResult> {
  const pagePath = extractPagePath(pageUrl);
  const formIdent = getFormIdentifier(formId, formName);
  const savedRules = await getRules(tenantId, pagePath, formIdent);

  const detected: DetectedField[] = [];
  const claimed = new Set<SemanticField>();

  for (const [rawKey, rawVal] of Object.entries(fields)) {
    if (typeof rawVal !== "string" || !rawVal.trim()) continue;
    const normalizedKey = normalizeFieldKey(rawKey);
    const value = rawVal.trim();

    const savedMapping = savedRules.get(normalizedKey);
    if (savedMapping && !claimed.has(savedMapping)) {
      detected.push({ fieldName: rawKey, mapsTo: savedMapping, value, method: "saved_rule", confidence: 1.0 });
      claimed.add(savedMapping);
      continue;
    }

    const valueDetected = detectByValuePattern(value);
    if (valueDetected && !claimed.has(valueDetected)) {
      detected.push({ fieldName: rawKey, mapsTo: valueDetected, value, method: "value_pattern", confidence: 0.95 });
      claimed.add(valueDetected);
      continue;
    }

    for (const semantic of Object.keys(FIELD_NAME_PATTERNS) as SemanticField[]) {
      if (claimed.has(semantic)) continue;
      if (matchFieldName(normalizedKey, semantic)) {
        detected.push({ fieldName: rawKey, mapsTo: semantic, value, method: "field_name", confidence: 0.8 });
        claimed.add(semantic);
        break;
      }
    }
  }

  const pii = { firstName: null as string | null, lastName: null as string | null, email: null as string | null, phone: null as string | null };
  const addressParts = { street: null as string | null, city: null as string | null, state: null as string | null, zip: null as string | null };
  let funnelRawValue: string | null = null;

  for (const d of detected) {
    switch (d.mapsTo) {
      case "firstName": pii.firstName = d.value; break;
      case "lastName": pii.lastName = d.value; break;
      case "email": pii.email = d.value; break;
      case "phone": pii.phone = d.value; break;
      case "fullName": {
        const parts = d.value.split(/\s+/);
        if (!pii.firstName) pii.firstName = parts[0] || null;
        if (!pii.lastName) pii.lastName = parts.slice(1).join(" ") || null;
        break;
      }
      case "address": addressParts.street = d.value; break;
      case "city": addressParts.city = d.value; break;
      case "state": addressParts.state = d.value; break;
      case "zip": addressParts.zip = d.value; break;
      case "funnel": funnelRawValue = d.value; break;
    }
  }

  return { fields: detected, pii, funnelRawValue, addressParts };
}
