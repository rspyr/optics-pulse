import { Router, type IRouter } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { getDomainHealthRollup } from "../services/tracker-audit";

// Operator surfaces; client_user excluded.
const requireOperator = requireRole("super_admin", "agency_user", "client_admin");

const router: IRouter = Router();

/**
 * Resolve the public origin for the pulse.js script tag. Pages outside
 * Replit (e.g. customer landing pages on Framer / GHL) need an absolute
 * URL — never `/api/pulse.js`. Order of preference:
 *   1. PUBLIC_API_URL env (set in production)
 *   2. REPLIT_DOMAINS  (deployed)
 *   3. REPLIT_DEV_DOMAIN (workspace)
 *   4. fall back to localhost:8080 for tests
 */
function resolvePublicOrigin(): string {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/$/, "");
  const fromDomains = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (fromDomains) return `https://${fromDomains}`;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return "http://localhost:8080";
}

/**
 * Funnel suggestions surfaced alongside the install snippet. Tenants whose
 * install has historically used a static `data-funnel` value get a
 * convenience copy-paste here; everyone else gets the generic snippet.
 *
 * Vance Heating's two production funnels are hardcoded because that
 * tenant is the canonical fix-target for this task and its slugs are
 * stable in the funnel-types table.
 */
const TENANT_FUNNEL_HINTS: Record<string, { funnels: string[]; note?: string }> = {
  "vance-heating": {
    funnels: ["ac-tune-up", "bogo-deal"],
    note: "Vance's two live funnels — install one snippet per landing page with the matching data-funnel value.",
  },
};

interface SnippetVariant {
  label: string;
  description: string;
  /** Where to paste it. */
  placement: string;
  /** The actual <script> snippet, ready to copy. */
  snippet: string;
}

router.get("/api/tracker/install-snippet", requireOperator, async (req, res) => {
  const sessionTenantId = req.session?.tenantId ? Number(req.session.tenantId) : null;
  const isAgency = req.session?.userRole === "agency_user" || req.session?.userRole === "super_admin";
  // Agency users may pass ?tenantId=N to fetch any tenant's snippet.
  const requestedTenantId = (() => {
    const raw = req.query.tenantId;
    if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
    return null;
  })();
  const tenantId = isAgency && requestedTenantId !== null ? requestedTenantId : sessionTenantId;

  if (!tenantId) {
    return res.status(400).json({ error: "No tenant in session and no tenantId query parameter provided." });
  }

  const [tenant] = await db.select({
    id: tenantsTable.id,
    name: tenantsTable.name,
    clientSlug: tenantsTable.clientSlug,
  }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);

  if (!tenant) {
    return res.status(404).json({ error: `Tenant ${tenantId} not found.` });
  }

  const origin = resolvePublicOrigin();
  // Static assets are mounted under /api (app.use("/api", express.static(...))).
  const scriptUrl = `${origin}/api/pulse.js`;
  const tenantHint = TENANT_FUNNEL_HINTS[tenant.clientSlug];
  const funnelToUse = tenantHint?.funnels[0] || "default";

  // Standard snippet (no funnel) — drop into <head> of every landing page.
  const standardSnippet =
    `<script async\n` +
    `  src="${scriptUrl}"\n` +
    `  data-client-id="${tenant.clientSlug}"\n` +
    `  data-tenant="${tenant.id}"></script>`;

  // Per-funnel snippet — used when the tenant maintains separate landing
  // pages per funnel and wants pulse.js to attribute submits without
  // having to read the URL.
  const funnelSnippet =
    `<script async\n` +
    `  src="${scriptUrl}"\n` +
    `  data-client-id="${tenant.clientSlug}"\n` +
    `  data-tenant="${tenant.id}"\n` +
    `  data-funnel="${funnelToUse}"></script>`;

  const variants: SnippetVariant[] = [
    {
      label: "Standard install",
      description:
        "Use this on any landing page. pulse.js will infer the funnel from the URL when possible.",
      placement: "Paste inside <head>, as high as possible (before any form scripts).",
      snippet: standardSnippet,
    },
    {
      label: "Per-funnel install",
      description: tenantHint
        ? `Use one of these per landing page. Replace data-funnel="${funnelToUse}" with the slug for that page.`
        : `Use this when one landing page only ever submits one funnel — the value of data-funnel="…" is what shows up as 'Resolved funnel' in attribution.`,
      placement: "Paste inside <head>, as high as possible (before any form scripts).",
      snippet: funnelSnippet,
    },
  ];

  // Builder-specific guidance for the embeds we have to special-case in
  // pulse.js because their forms live in cross-origin iframes.
  const builderGuidance: { builder: string; instructions: string }[] = [
    {
      builder: "Framer",
      instructions:
        "In Framer Site Settings → Custom Code → End of <head>, paste the snippet. Do NOT add it as a code component on a single page — it must be in the site-wide <head> so it loads before the Framer form iframe initialises.",
    },
    {
      builder: "GoHighLevel / LeadConnector",
      instructions:
        "Funnel/Website → Settings → Tracking Code → Header Tracking Code, paste the snippet. pulse.js listens for the GHL form-submission postMessage from the embedded form iframe — installing it inside the iframe alone does NOT work.",
    },
    {
      builder: "WordPress",
      instructions:
        "Use the 'Insert Headers and Footers' (or equivalent) plugin and paste into the Header section. Avoid Google Tag Manager-only injection — pulse.js works best when present at first paint.",
    },
    {
      builder: "ServiceTitan booking widget",
      instructions:
        "Install the snippet on the parent page where the booking widget is embedded. The widget posts via a same-origin form pulse.js can bind to.",
    },
  ];

  return res.json({
    tenantId: tenant.id,
    tenantName: tenant.name,
    clientSlug: tenant.clientSlug,
    scriptUrl,
    suggestedFunnels: tenantHint?.funnels || [],
    funnelNote: tenantHint?.note || null,
    variants,
    builderGuidance,
  });
});

/** Per-tenant per-domain health rollup over last 30d (Settings → Tracker Health). */
router.get("/api/tracker/health-rollup", requireOperator, async (req, res) => {
  const sessionTenantId = req.session?.tenantId ? Number(req.session.tenantId) : null;
  const isAgency = req.session?.userRole === "agency_user" || req.session?.userRole === "super_admin";
  const requestedTenantId = (() => {
    const raw = req.query.tenantId;
    if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
    return null;
  })();
  const tenantId = isAgency && requestedTenantId !== null ? requestedTenantId : sessionTenantId;

  if (!tenantId) {
    return res.status(400).json({ error: "No tenant in session and no tenantId query parameter provided." });
  }

  const rows = await getDomainHealthRollup({ tenantIds: [tenantId], limit: 50 });
  return res.json({
    tenantId,
    domains: rows.map(r => ({
      domain: r.domain,
      lastSubmitAt: r.lastSubmitAt,
      lastSubmitStatus: r.lastSubmitStatus,
      lastSubmitOutcome: r.lastSubmitOutcome,
      lastHeartbeatAt: r.lastHeartbeatAt,
      submitCount24h: r.submitCount24h,
      submitCount7d: r.submitCount7d,
      statusBuckets24h: r.statusBuckets24h,
      statusBuckets7d: r.statusBuckets7d,
      recentAttempts: r.recentAttempts,
    })),
  });
});

export default router;
