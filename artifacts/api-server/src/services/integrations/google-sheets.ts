// Google Sheets integration via Replit Connectors
import { google } from "googleapis";

interface ConnectionSettings {
  settings: {
    access_token?: string;
    expires_at?: string;
    oauth?: { credentials?: { access_token?: string } };
  };
}

let connectionSettings: ConnectionSettings | null = null;

async function getAccessToken() {
  if (
    connectionSettings &&
    connectionSettings.settings.expires_at &&
    new Date(connectionSettings.settings.expires_at).getTime() > Date.now()
  ) {
    return connectionSettings.settings.access_token;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error("X-Replit-Token not found for repl/depl");
  }

  const resp = await fetch(
    "https://" +
      hostname +
      "/api/v2/connection?include_secrets=true&connector_names=google-sheet",
    {
      headers: {
        Accept: "application/json",
        "X-Replit-Token": xReplitToken,
      },
    },
  );
  const data = (await resp.json()) as { items?: ConnectionSettings[] };
  connectionSettings = data.items?.[0] ?? null;

  const accessToken =
    connectionSettings?.settings?.access_token ||
    connectionSettings?.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error("Google Sheet not connected");
  }
  return accessToken;
}

export async function getUncachableGoogleSheetClient() {
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

export async function readSheetRows(
  spreadsheetId: string,
  tabName: string,
): Promise<{ headers: string[]; rows: SheetRow[] }> {
  const client = await getUncachableGoogleSheetClient();

  const range = `${tabName}!A:Z`;
  const response = await client.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const values = response.data.values;
  if (!values || values.length < 2) {
    return { headers: [], rows: [] };
  }

  const rawHeaders = values[0] as string[];
  const headers = rawHeaders.map((h) => h.trim().toLowerCase());

  const headerMap: Record<string, string> = {
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

  const rows: SheetRow[] = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i] as string[];
    const obj: Record<string, string> = {};

    for (let j = 0; j < headers.length; j++) {
      const normalized = headerMap[headers[j]] || headers[j];
      obj[normalized] = (row[j] || "").trim();
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
