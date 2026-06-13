function normalizeOrigin(value: string | undefined | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function addOrigin(origins: string[], value: string | undefined | null) {
  const normalized = normalizeOrigin(value);
  if (normalized && !origins.includes(normalized)) {
    origins.push(normalized);
  }
}

function addDomain(origins: string[], domain: string | undefined | null) {
  const trimmed = domain?.trim();
  if (!trimmed) return;
  addOrigin(origins, `https://${trimmed}`);
}

function addCommaSeparatedOrigins(origins: string[], value: string | undefined) {
  value?.split(",").forEach((entry) => addOrigin(origins, entry));
}

function addCommaSeparatedDomains(origins: string[], value: string | undefined) {
  value?.split(",").forEach((entry) => addDomain(origins, entry));
}

export function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  addCommaSeparatedOrigins(origins, process.env.APP_ALLOWED_ORIGINS);
  addCommaSeparatedOrigins(origins, process.env.CORS_ORIGINS);
  addOrigin(origins, process.env.APP_PUBLIC_URL);
  addOrigin(origins, process.env.PUBLIC_APP_URL);
  addOrigin(origins, process.env.API_BASE_URL);
  addOrigin(origins, process.env.PUBLIC_API_URL);
  addOrigin(origins, process.env.FRONTEND_URL);
  addOrigin(origins, process.env.APP_URL);

  addDomain(origins, process.env.REPLIT_DEV_DOMAIN);
  addCommaSeparatedDomains(origins, process.env.REPLIT_DOMAINS);
  addDomain(origins, process.env.REPLIT_EXPO_DEV_DOMAIN);

  if (process.env.REPLIT_DEV_DOMAIN) {
    const expoVariant = process.env.REPLIT_DEV_DOMAIN.replace(".worf.replit.dev", ".expo.worf.replit.dev");
    addDomain(origins, expoVariant);
  }

  addOrigin(origins, "http://localhost:5173");
  addOrigin(origins, "http://127.0.0.1:5173");

  return origins;
}

export function getPrimaryPublicOrigin(): string | null {
  const explicit = [
    process.env.APP_PUBLIC_URL,
    process.env.PUBLIC_APP_URL,
    process.env.API_BASE_URL,
    process.env.PUBLIC_API_URL,
    process.env.FRONTEND_URL,
    process.env.APP_URL,
    process.env.APP_ALLOWED_ORIGINS?.split(",")[0],
    process.env.CORS_ORIGINS?.split(",")[0],
  ];

  for (const value of explicit) {
    const origin = normalizeOrigin(value);
    if (origin) return origin;
  }

  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() || process.env.REPLIT_DEV_DOMAIN;
  if (replitDomain) {
    return normalizeOrigin(`https://${replitDomain}`);
  }

  return null;
}

export function buildPublicUrl(path: string, fallbackOrigin = "http://localhost:8080"): string {
  const origin = getPrimaryPublicOrigin() || fallbackOrigin;
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}
