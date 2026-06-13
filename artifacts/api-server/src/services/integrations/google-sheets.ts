// Google Sheets integration. Cloudflare/Neon production uses a Google Service
// Account; the Replit Connector path remains as a legacy/local fallback.
import { google, type sheets_v4 } from "googleapis";

type SheetsClient = sheets_v4.Sheets;

interface ConnectionSettings {
  settings: {
    access_token?: string;
    expires_at?: string;
    oauth?: { credentials?: { access_token?: string } };
  };
}

interface GoogleServiceAccountCredentials {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

let connectionSettings: ConnectionSettings | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let serviceAccountClient: SheetsClient | null = null;
let serviceAccountClientKey: string | null = null;

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const FALLBACK_REFRESH_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 1000;
const MAX_RETRIES = 3;
const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

// Hard timeouts so a hung network call can never stall the sheet-sync loop
// indefinitely. Without these, a single never-resolving request freezes ALL
// sheet imports for every tenant until the process is restarted.
const CONNECTOR_FETCH_TIMEOUT_MS = 15 * 1000;
const SHEETS_API_TIMEOUT_MS = 30 * 1000;

/**
 * Reject a promise if it does not settle within `ms`. Used to bound external
 * calls (Google Sheets API) that have no built-in timeout, so a hang surfaces
 * as a normal error the caller already handles instead of locking up forever.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[GoogleSheets] ${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function extractAccessToken(cs: ConnectionSettings | null): string | undefined {
  return cs?.settings?.access_token || cs?.settings?.oauth?.credentials?.access_token;
}

function configuredAuthMode(): "auto" | "service_account" | "replit_connector" {
  const raw = process.env.GOOGLE_SHEETS_AUTH_MODE?.trim().toLowerCase();
  if (raw === "service_account" || raw === "service-account") return "service_account";
  if (raw === "replit_connector" || raw === "replit-connector" || raw === "replit") return "replit_connector";
  return "auto";
}

function decodeServiceAccountJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (decoded.startsWith("{")) return decoded;
  } catch {
    // Fall through to JSON.parse below so the caller gets a useful error.
  }

  return trimmed;
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
}

function readServiceAccountCredentials(): GoogleServiceAccountCredentials | null {
  const json =
    process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_BASE64 ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;

  if (json?.trim()) {
    const parsed = JSON.parse(decodeServiceAccountJson(json)) as Partial<GoogleServiceAccountCredentials>;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("Google Sheets service account JSON is missing client_email or private_key");
    }
    return {
      client_email: parsed.client_email,
      private_key: normalizePrivateKey(parsed.private_key),
      private_key_id: parsed.private_key_id,
    };
  }

  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY?.trim();
  if (clientEmail && privateKey) {
    return {
      client_email: clientEmail,
      private_key: normalizePrivateKey(privateKey),
      private_key_id: process.env.GOOGLE_SHEETS_PRIVATE_KEY_ID?.trim(),
    };
  }

  return null;
}

function getServiceAccountCacheKey(credentials: GoogleServiceAccountCredentials): string {
  return `${credentials.client_email}:${credentials.private_key_id ?? "no-key-id"}`;
}

async function getServiceAccountGoogleSheetClient(credentials: GoogleServiceAccountCredentials): Promise<SheetsClient> {
  const cacheKey = getServiceAccountCacheKey(credentials);
  if (serviceAccountClient && serviceAccountClientKey === cacheKey) {
    return serviceAccountClient;
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [SHEETS_READONLY_SCOPE],
  });

  await withTimeout(
    auth.authorize(),
    CONNECTOR_FETCH_TIMEOUT_MS,
    "service account authorization",
  );

  serviceAccountClient = google.sheets({ version: "v4", auth });
  serviceAccountClientKey = cacheKey;
  console.log("[GoogleSheets] Using Google Service Account authentication");
  return serviceAccountClient;
}

function hasReplitConnectorConfig(): boolean {
  return Boolean(
    process.env.REPLIT_CONNECTORS_HOSTNAME &&
    (process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL),
  );
}

function scheduleProactiveRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);

  let delayMs = FALLBACK_REFRESH_MS;
  if (connectionSettings?.settings?.expires_at) {
    const expiresAt = new Date(connectionSettings.settings.expires_at).getTime();
    delayMs = Math.max(expiresAt - Date.now() - REFRESH_BUFFER_MS, 10_000);
  }

  refreshTimer = setTimeout(async () => {
    try {
      await fetchConnectionSettings();
      console.log("[GoogleSheets] Proactively refreshed access token");
    } catch (err) {
      console.error("[GoogleSheets] Proactive refresh failed, will retry on next use:", err);
      connectionSettings = null;
    }
  }, delayMs);
}

async function fetchConnectionSettings(): Promise<string> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      "Google Sheets auth is not configured. Set GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON for Cloudflare production.",
    );
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), CONNECTOR_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(
        "https://" +
          hostname +
          "/api/v2/connection?include_secrets=true&connector_names=google-sheet",
        {
          headers: {
            Accept: "application/json",
            "X-Replit-Token": xReplitToken,
          },
          signal: controller.signal,
        },
      );

      if (!resp.ok) {
        throw new Error(`Connector API returned ${resp.status} ${resp.statusText}`);
      }

      const data = (await resp.json()) as { items?: ConnectionSettings[] };
      connectionSettings = data.items?.[0] ?? null;

      const accessToken = extractAccessToken(connectionSettings);
      if (!connectionSettings || !accessToken) {
        throw new Error("Google Sheet not connected");
      }

      lastFetchedAt = Date.now();
      scheduleProactiveRefresh();
      return accessToken;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    } finally {
      clearTimeout(fetchTimer);
    }
  }

  connectionSettings = null;
  throw lastError;
}

let lastFetchedAt = 0;

async function getAccessToken() {
  if (connectionSettings) {
    const cachedToken = extractAccessToken(connectionSettings);
    if (cachedToken) {
      if (connectionSettings.settings.expires_at) {
        const expiresAt = new Date(connectionSettings.settings.expires_at).getTime();
        if (expiresAt > Date.now() + REFRESH_BUFFER_MS) {
          return cachedToken;
        }
      } else if (Date.now() - lastFetchedAt < FALLBACK_REFRESH_MS) {
        return cachedToken;
      }
    }
  }

  return fetchConnectionSettings();
}

export function getGoogleSheetsAuthProvider(): "service_account" | "replit_connector" | "unconfigured" {
  const mode = configuredAuthMode();
  if (mode !== "replit_connector" && readServiceAccountCredentials()) return "service_account";
  if (mode !== "service_account" && hasReplitConnectorConfig()) return "replit_connector";
  return "unconfigured";
}

export async function getUncachableGoogleSheetClient(): Promise<SheetsClient> {
  const mode = configuredAuthMode();
  if (mode !== "replit_connector") {
    const credentials = readServiceAccountCredentials();
    if (credentials) {
      return getServiceAccountGoogleSheetClient(credentials);
    }
    if (mode === "service_account") {
      throw new Error(
        "Google Sheets service account auth is enabled, but GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON is not configured",
      );
    }
  }

  const accessToken = await getAccessToken();

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken,
  });

  return google.sheets({ version: "v4", auth: oauth2Client });
}

export interface SheetRow {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  source: string;
  serviceType: string;
  [key: string]: string;
}

function isAuthError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as { code?: number; status?: number }).code ?? (err as { code?: number; status?: number }).status;
    if (status === 401) return true;
    const message = String((err as { message?: string }).message || "");
    if (/invalid credentials/i.test(message)) return true;
  }
  return false;
}

function clearCachedToken() {
  connectionSettings = null;
  serviceAccountClient = null;
  serviceAccountClientKey = null;
  lastFetchedAt = 0;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  console.log("[GoogleSheets] Cleared cached auth due to auth error");
}

export async function readRawSheetData(
  spreadsheetId: string,
  tabName: string,
): Promise<{ headers: string[]; rawRows: string[][] }> {
  const range = tabName;

  let client = await getUncachableGoogleSheetClient();
  let response;
  try {
    response = await withTimeout(
      client.spreadsheets.values.get({ spreadsheetId, range }),
      SHEETS_API_TIMEOUT_MS,
      `values.get(${spreadsheetId})`,
    );
  } catch (err) {
    if (!isAuthError(err)) throw err;
    console.warn("[GoogleSheets] Auth error on Sheets API call, clearing token and retrying once:", (err as Error).message);
    clearCachedToken();
    client = await getUncachableGoogleSheetClient();
    response = await withTimeout(
      client.spreadsheets.values.get({ spreadsheetId, range }),
      SHEETS_API_TIMEOUT_MS,
      `values.get(${spreadsheetId}) retry`,
    );
  }

  const values = response.data.values;
  if (!values || values.length === 0) {
    return { headers: [], rawRows: [] };
  }
  const headers = (values[0] as string[]).map(h => h.trim());
  const rawRows = values.length > 1
    ? values.slice(1).map(r => (r as string[]).map(c => (c || "").trim()))
    : [];
  return { headers, rawRows };
}

const DEFAULT_HEADER_MAP: Record<string, string> = {
  "first name": "firstName",
  "first_name": "firstName",
  firstname: "firstName",
  "last name": "lastName",
  "last_name": "lastName",
  lastname: "lastName",
  name: "fullName",
  phone: "phone",
  "phone number": "phone",
  phone_number: "phone",
  email: "email",
  "email address": "email",
  source: "source",
  "lead source": "source",
  lead_source: "source",
  "service type": "serviceType",
  service_type: "serviceType",
  servicetype: "serviceType",
  service: "serviceType",
  "looking for": "serviceType",
  interest: "serviceType",
};

export async function readSheetRows(
  spreadsheetId: string,
  tabName: string,
  customMapping?: Record<string, string> | null,
): Promise<{ headers: string[]; rows: SheetRow[] }> {
  const { headers: rawHeaders, rawRows } = await readRawSheetData(spreadsheetId, tabName);
  if (rawHeaders.length === 0) return { headers: [], rows: [] };

  const headerMap = customMapping || DEFAULT_HEADER_MAP;
  const useCustom = !!customMapping;

  const rows: SheetRow[] = [];

  for (const row of rawRows) {
    const obj: Record<string, string> = {};
    const notesParts: string[] = [];

    const sourceParts: string[] = [];

    for (let j = 0; j < rawHeaders.length; j++) {
      const headerKey = rawHeaders[j];
      let normalized: string;
      if (useCustom) {
        normalized = headerMap[headerKey] || headerKey;
      } else {
        normalized = headerMap[headerKey.toLowerCase()] || headerKey.toLowerCase();
      }
      if (normalized && normalized !== "__skip__") {
        const val = (row[j] || "").trim();
        if (normalized === "notes") {
          if (val) notesParts.push(`${headerKey}: ${val}`);
        } else if (normalized === "source") {
          if (val) sourceParts.push(val);
        } else {
          obj[normalized] = val;
        }
      }
    }

    if (sourceParts.length > 0) {
      obj.source = sourceParts[0];
    }

    if (notesParts.length > 0) {
      obj.notes = notesParts.join("\n");
    }

    if (obj.fullName && !obj.firstName) {
      const parts = obj.fullName.split(/\s+/);
      obj.firstName = parts[0] || "";
      obj.lastName = parts.slice(1).join(" ") || "";
    }

    if (!obj.firstName && !obj.phone) continue;

    rows.push({
      firstName: obj.firstName || "",
      lastName: obj.lastName || "",
      phone: obj.phone || "",
      email: obj.email || "",
      source: obj.source || "",
      serviceType: obj.serviceType || "",
      ...obj,
    });
  }

  return { headers: rawHeaders, rows };
}
