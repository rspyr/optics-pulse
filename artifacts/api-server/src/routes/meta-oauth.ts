import { Router, type IRouter, type Request } from "express";
import { db, tenantsTable, metaAdAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { encryptConfig, decryptConfig } from "../lib/encryption";
import { getPrimaryPublicOrigin } from "../lib/public-origin";
import { MetaAPIService, MetaTokenInvalidError } from "../services/integrations/meta";
import crypto from "crypto";

const router: IRouter = Router();

const META_AUTH_URL = "https://www.facebook.com/v21.0/dialog/oauth";
const META_TOKEN_URL = "https://graph.facebook.com/v21.0/oauth/access_token";
const SCOPES = "ads_read,ads_management,pages_show_list,pages_read_engagement,business_management";

function getRedirectUri(req: Request): string {
  const explicit = process.env.META_REDIRECT_URI;
  if (explicit) return explicit;
  const configuredOrigin = getPrimaryPublicOrigin();
  if (configuredOrigin) return `${configuredOrigin}/api/oauth/meta/callback`;
  const host = req.get("host");
  if (host) {
    const forwardedProto = req.get("x-forwarded-proto");
    const proto = forwardedProto?.split(",")[0]?.trim()
      || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host}/api/oauth/meta/callback`;
  }
  return "http://localhost:8080/api/oauth/meta/callback";
}

function getMetaAppCredentials(): { appId: string; appSecret: string } | null {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

router.get("/oauth/meta/authorize", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = Number(req.query.tenantId);
  if (!tenantId || isNaN(tenantId)) {
    res.status(400).json({ error: "tenantId query param is required" });
    return;
  }

  const creds = getMetaAppCredentials();
  if (!creds) {
    res.status(500).json({ error: "Server is missing META_APP_ID / META_APP_SECRET environment variables. Contact the administrator." });
    return;
  }

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.metaOAuthState = state;
  req.session.metaOAuthTenantId = tenantId;

  const redirectUri = getRedirectUri(req);
  req.session.metaOAuthRedirectUri = redirectUri;

  const params = new URLSearchParams({
    client_id: creds.appId,
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

  const creds = getMetaAppCredentials();
  if (!creds) {
    res.redirect("/internal?metaOAuth=error&message=server_missing_app_credentials");
    return;
  }

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.redirect("/internal?metaOAuth=error&message=tenant_not_found");
    return;
  }

  let config: Record<string, unknown> = {};
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try { config = decryptConfig(tenant.apiConfig); } catch {}
  }

  const redirectUri = req.session.metaOAuthRedirectUri || getRedirectUri(req);
  delete req.session.metaOAuthRedirectUri;

  try {
    const tokenResponse = await fetch(META_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.appId,
        client_secret: creds.appSecret,
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

    const tokenData = await tokenResponse.json() as { access_token: string; token_type: string; expires_in?: number };

    // Exchange short-lived for long-lived (~60 days)
    const exchangeResponse = await fetch(META_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: creds.appId,
        client_secret: creds.appSecret,
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

    // Verify token + discover ad accounts via the new MetaAPIService
    const svc = new MetaAPIService({ accessToken: longLivedToken, adAccountId: "" });
    const me = await svc.verifyToken();
    console.log(`[Meta OAuth] Token verified — Facebook user: ${me.name || me.id}`);

    let discovered: Awaited<ReturnType<MetaAPIService["listAdAccounts"]>> = [];
    try {
      discovered = await svc.listAdAccounts();
    } catch (discErr) {
      console.warn(`[Meta OAuth] Ad-account discovery failed: ${discErr instanceof Error ? discErr.message : discErr}`);
    }

    // Persist token; clear reconnect flag; remove legacy per-tenant App ID/Secret
    config.metaAccessToken = longLivedToken;
    delete (config as Record<string, unknown>).metaAppId;
    delete (config as Record<string, unknown>).metaAppSecret;

    await db.update(tenantsTable)
      .set({
        apiConfig: encryptConfig(config) as unknown as typeof tenantsTable.$inferInsert.apiConfig,
        metaNeedsReconnect: false,
        metaReconnectReason: null,
        updatedAt: new Date(),
      })
      .where(eq(tenantsTable.id, tenantId));

    // Upsert discovered ad accounts; preserve any prior selection.
    if (discovered.length > 0) {
      const existing = await db.select().from(metaAdAccountsTable).where(eq(metaAdAccountsTable.tenantId, tenantId));
      const existingByAcc = new Map(existing.map((r) => [r.accountId, r] as const));

      for (const acc of discovered) {
        const accountId = acc.account_id || acc.id?.replace(/^act_/, "") || "";
        if (!accountId) continue;
        const prior = existingByAcc.get(accountId);
        if (prior) {
          await db.update(metaAdAccountsTable)
            .set({
              name: acc.name || prior.name,
              currency: acc.currency || prior.currency,
              updatedAt: new Date(),
            })
            .where(eq(metaAdAccountsTable.id, prior.id));
        } else {
          await db.insert(metaAdAccountsTable).values({
            tenantId,
            accountId,
            name: acc.name || "",
            currency: acc.currency || "USD",
            isSelected: false,
          });
        }
      }

      // If no account is selected and we discovered exactly one, auto-select it
      const anySelected = existing.some((r) => r.isSelected) || (config.metaAdAccountId ? true : false);
      if (!anySelected && discovered.length === 1) {
        const onlyAccountId = discovered[0].account_id || discovered[0].id.replace(/^act_/, "");
        await db.update(metaAdAccountsTable)
          .set({ isSelected: true })
          .where(and(eq(metaAdAccountsTable.tenantId, tenantId), eq(metaAdAccountsTable.accountId, onlyAccountId)));

        config.metaAdAccountId = `act_${onlyAccountId}`;
        await db.update(tenantsTable)
          .set({
            apiConfig: encryptConfig(config) as unknown as typeof tenantsTable.$inferInsert.apiConfig,
            updatedAt: new Date(),
          })
          .where(eq(tenantsTable.id, tenantId));
      }
    }

    console.log(`[Meta OAuth] Stored access token + discovered ${discovered.length} ad account(s) for tenant ${tenantId}`);
    const needsPick = discovered.length > 1 && !config.metaAdAccountId;
    res.redirect(`/internal?metaOAuth=success&tenantId=${tenantId}${needsPick ? "&pickAccount=1" : ""}`);
  } catch (err) {
    if (err instanceof MetaTokenInvalidError) {
      console.error(`[Meta OAuth] Token verification failed: ${err.message}`);
      res.redirect("/internal?metaOAuth=error&message=token_verification_failed");
      return;
    }
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

  const creds = getMetaAppCredentials();
  res.json({
    connected: Boolean(config.metaAccessToken) && !tenant.metaNeedsReconnect,
    hasAccessToken: Boolean(config.metaAccessToken),
    hasAdAccount: Boolean(config.metaAdAccountId),
    needsReconnect: Boolean(tenant.metaNeedsReconnect),
    reconnectReason: tenant.metaReconnectReason || null,
    serverConfigured: Boolean(creds),
  });
});

export default router;
