import { Router, type IRouter } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { encryptConfig, decryptConfig } from "../lib/encryption";
import crypto from "crypto";

const router: IRouter = Router();

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/adwords";

function getRedirectUri(): string {
  const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(",")[0];
  if (domain) {
    return `https://${domain}/api/oauth/google-ads/callback`;
  }
  return "http://localhost:8080/api/oauth/google-ads/callback";
}

router.get("/oauth/google-ads/authorize", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = Number(req.query.tenantId);
  if (!tenantId || isNaN(tenantId)) {
    res.status(400).json({ error: "tenantId query param is required" });
    return;
  }

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  let config: Record<string, unknown> = {};
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try { config = decryptConfig(tenant.apiConfig); } catch {}
  }

  const clientId = config.googleAdsClientId as string;
  if (!clientId) {
    res.status(400).json({ error: "Google Ads OAuth Client ID must be saved in tenant settings first" });
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.googleOAuthState = state;
  req.session.googleOAuthTenantId = tenantId;

  const redirectUri = getRedirectUri();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;
  console.log(`[Google OAuth] Authorize requested for tenant ${tenantId}, redirect_uri=${redirectUri}`);
  console.log(`[Google OAuth] Auth URL: ${authUrl}`);
  res.json({ authUrl });
});

router.get("/oauth/google-ads/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (!req.session.userId) {
    res.redirect("/internal?googleAdsOAuth=error&message=not_authenticated");
    return;
  }

  if (error) {
    res.redirect(`/internal?googleAdsOAuth=error&message=${encodeURIComponent(String(error))}`);
    return;
  }

  if (!code || !state) {
    res.redirect("/internal?googleAdsOAuth=error&message=missing_code_or_state");
    return;
  }

  if (state !== req.session.googleOAuthState) {
    res.redirect("/internal?googleAdsOAuth=error&message=invalid_state");
    return;
  }

  const tenantId = req.session.googleOAuthTenantId;
  if (!tenantId) {
    res.redirect("/internal?googleAdsOAuth=error&message=missing_tenant_id");
    return;
  }

  delete req.session.googleOAuthState;
  delete req.session.googleOAuthTenantId;

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.redirect("/internal?googleAdsOAuth=error&message=tenant_not_found");
    return;
  }

  let config: Record<string, unknown> = {};
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try { config = decryptConfig(tenant.apiConfig); } catch {}
  }

  const clientId = config.googleAdsClientId as string;
  const clientSecret = config.googleAdsClientSecret as string;

  if (!clientId || !clientSecret) {
    res.redirect("/internal?googleAdsOAuth=error&message=missing_client_credentials");
    return;
  }

  const redirectUri = getRedirectUri();

  try {
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error(`[Google OAuth] Token exchange failed (${tokenResponse.status}): ${errorText}`);
      res.redirect(`/internal?googleAdsOAuth=error&message=token_exchange_failed`);
      return;
    }

    const tokenData = await tokenResponse.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };

    if (!tokenData.refresh_token) {
      console.error("[Google OAuth] No refresh_token in response — user may have already authorized this app. Try revoking access at https://myaccount.google.com/permissions");
      res.redirect(`/internal?googleAdsOAuth=error&message=no_refresh_token`);
      return;
    }

    config.googleAdsRefreshToken = tokenData.refresh_token;
    config.googleAdsApiKey = tokenData.access_token;

    await db.update(tenantsTable)
      .set({
        apiConfig: encryptConfig(config) as unknown as typeof tenantsTable.$inferInsert.apiConfig,
        updatedAt: new Date(),
      })
      .where(eq(tenantsTable.id, tenantId));

    console.log(`[Google OAuth] Successfully stored refresh token for tenant ${tenantId}`);
    res.redirect(`/internal?googleAdsOAuth=success&tenantId=${tenantId}`);
  } catch (err) {
    console.error("[Google OAuth] Token exchange error:", err);
    res.redirect(`/internal?googleAdsOAuth=error&message=server_error`);
  }
});

router.get("/oauth/google-ads/status", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = Number(req.query.tenantId);
  if (!tenantId || isNaN(tenantId)) {
    res.status(400).json({ error: "tenantId required" });
    return;
  }

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  let config: Record<string, unknown> = {};
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try { config = decryptConfig(tenant.apiConfig); } catch {}
  }

  const hasClientId = Boolean(config.googleAdsClientId);
  const hasClientSecret = Boolean(config.googleAdsClientSecret);
  const hasRefreshToken = Boolean(config.googleAdsRefreshToken);

  res.json({
    connected: hasClientId && hasClientSecret && hasRefreshToken,
    hasClientId,
    hasClientSecret,
    hasRefreshToken,
  });
});

export default router;
