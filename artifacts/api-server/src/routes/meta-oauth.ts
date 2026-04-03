import { Router, type IRouter } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { encryptConfig, decryptConfig } from "../lib/encryption";
import crypto from "crypto";

const router: IRouter = Router();

const META_AUTH_URL = "https://www.facebook.com/v21.0/dialog/oauth";
const META_TOKEN_URL = "https://graph.facebook.com/v21.0/oauth/access_token";
const META_EXCHANGE_URL = "https://graph.facebook.com/v21.0/oauth/access_token";
const SCOPES = "ads_read,ads_management,pages_show_list,pages_read_engagement,business_management";

function getRedirectUri(): string {
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0] || process.env.REPLIT_DEV_DOMAIN;
  if (domain) {
    return `https://${domain}/api/oauth/meta/callback`;
  }
  return "http://localhost:8080/api/oauth/meta/callback";
}

router.get("/oauth/meta/authorize", requireRole("super_admin", "agency_user"), async (req, res) => {
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

  const appId = config.metaAppId as string;
  const appSecret = config.metaAppSecret as string;
  if (!appId) {
    res.status(400).json({ error: "Meta App ID must be saved in tenant settings first" });
    return;
  }
  if (!appSecret) {
    res.status(400).json({ error: "Meta App Secret must be saved in tenant settings first" });
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.metaOAuthState = state;
  req.session.metaOAuthTenantId = tenantId;

  const redirectUri = getRedirectUri();

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
  });

  const authUrl = `${META_AUTH_URL}?${params.toString()}`;
  console.log(`[Meta OAuth] Authorize requested for tenant ${tenantId}, redirect_uri=${redirectUri}`);
  res.json({ authUrl });
});

router.get("/oauth/meta/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (!req.session.userId) {
    res.redirect("/internal?metaOAuth=error&message=not_authenticated");
    return;
  }

  if (error) {
    console.error(`[Meta OAuth] Authorization error: ${error} - ${error_description}`);
    res.redirect(`/internal?metaOAuth=error&message=${encodeURIComponent(String(error))}`);
    return;
  }

  if (!code || !state) {
    res.redirect("/internal?metaOAuth=error&message=missing_code_or_state");
    return;
  }

  if (state !== req.session.metaOAuthState) {
    res.redirect("/internal?metaOAuth=error&message=invalid_state");
    return;
  }

  const tenantId = req.session.metaOAuthTenantId;
  if (!tenantId) {
    res.redirect("/internal?metaOAuth=error&message=missing_tenant_id");
    return;
  }

  delete req.session.metaOAuthState;
  delete req.session.metaOAuthTenantId;

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.redirect("/internal?metaOAuth=error&message=tenant_not_found");
    return;
  }

  let config: Record<string, unknown> = {};
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try { config = decryptConfig(tenant.apiConfig); } catch {}
  }

  const appId = config.metaAppId as string;
  const appSecret = config.metaAppSecret as string;

  if (!appId || !appSecret) {
    res.redirect("/internal?metaOAuth=error&message=missing_app_credentials");
    return;
  }

  const redirectUri = getRedirectUri();

  try {
    const tokenResponse = await fetch(META_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code: String(code),
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error(`[Meta OAuth] Token exchange failed (${tokenResponse.status}): ${errorText}`);
      res.redirect("/internal?metaOAuth=error&message=token_exchange_failed");
      return;
    }

    const tokenData = await tokenResponse.json() as {
      access_token: string;
      token_type: string;
      expires_in?: number;
    };

    const exchangeResponse = await fetch(META_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: tokenData.access_token,
      }),
    });

    let longLivedToken = tokenData.access_token;
    if (exchangeResponse.ok) {
      const exchangeData = await exchangeResponse.json() as { access_token: string; expires_in?: number };
      longLivedToken = exchangeData.access_token;
      console.log(`[Meta OAuth] Exchanged for long-lived token (expires in ${exchangeData.expires_in || "unknown"}s)`);
    } else {
      console.warn("[Meta OAuth] Long-lived token exchange failed, using short-lived token");
    }

    const verifyResponse = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(longLivedToken)}`);
    if (!verifyResponse.ok) {
      const verifyError = await verifyResponse.text();
      console.error(`[Meta OAuth] Token verification failed: ${verifyError}`);
      res.redirect("/internal?metaOAuth=error&message=token_verification_failed");
      return;
    }
    const meData = await verifyResponse.json() as { id: string; name?: string };
    console.log(`[Meta OAuth] Token verified — Facebook user: ${meData.name || meData.id}`);

    config.metaAccessToken = longLivedToken;

    await db.update(tenantsTable)
      .set({
        apiConfig: encryptConfig(config) as unknown as typeof tenantsTable.$inferInsert.apiConfig,
        updatedAt: new Date(),
      })
      .where(eq(tenantsTable.id, tenantId));

    console.log(`[Meta OAuth] Successfully stored access token for tenant ${tenantId}`);
    res.redirect(`/internal?metaOAuth=success&tenantId=${tenantId}`);
  } catch (err) {
    console.error("[Meta OAuth] Token exchange error:", err);
    res.redirect("/internal?metaOAuth=error&message=server_error");
  }
});

router.get("/oauth/meta/status", requireRole("super_admin", "agency_user"), async (req, res) => {
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

  res.json({
    connected: Boolean(config.metaAccessToken),
    hasAppId: Boolean(config.metaAppId),
    hasAppSecret: Boolean(config.metaAppSecret),
    hasAccessToken: Boolean(config.metaAccessToken),
  });
});

export default router;
