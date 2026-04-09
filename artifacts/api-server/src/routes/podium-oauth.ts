import { Router, type IRouter } from "express";
import { db, usersTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { encryptConfig, decryptConfig } from "../lib/encryption";
import { clearPodiumTokenCache } from "../services/integrations/podium-auth";
import crypto from "crypto";

const router: IRouter = Router();

const PODIUM_AUTH_URL = "https://api.podium.com/oauth/authorize";
const PODIUM_TOKEN_URL = "https://api.podium.com/oauth/token";
const SCOPES = "read_messages write_messages read_contacts write_contacts read_locations read_users";

function getOAuthSigningKey(): string {
  return process.env.SESSION_SECRET || "mos-dev-secret-change-in-production";
}

const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

function buildSignedState(userId: number): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(16).toString("hex");
  const ts = Date.now().toString(36);
  const payload = `${userId}:${nonce}:${ts}`;
  const signature = crypto
    .createHmac("sha256", getOAuthSigningKey())
    .update(payload)
    .digest("hex");
  return { state: `${payload}:${signature}`, nonce };
}

function parseSignedState(state: string): { userId: number; nonce: string } | null {
  try {
    const parts = state.split(":");
    if (parts.length !== 4) return null;
    const [userIdStr, nonce, ts, signature] = parts;
    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) return null;
    if (!/^[0-9a-f]{64}$/i.test(signature)) return null;
    const payload = `${userId}:${nonce}:${ts}`;
    const expected = crypto
      .createHmac("sha256", getOAuthSigningKey())
      .update(payload)
      .digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
      return null;
    }
    const issuedAt = parseInt(ts, 36);
    if (isNaN(issuedAt) || Date.now() - issuedAt > OAUTH_STATE_MAX_AGE_MS) {
      console.warn(`[Podium OAuth] State expired for user ${userId} (age ${Date.now() - issuedAt}ms)`);
      return null;
    }
    return { userId, nonce };
  } catch {
    return null;
  }
}

function getRedirectUri(): string {
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0] || process.env.REPLIT_DEV_DOMAIN;
  if (domain) {
    return `https://${domain}/api/oauth/podium/callback`;
  }
  return "http://localhost:8080/api/oauth/podium/callback";
}

router.get("/oauth/podium/authorize", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const clientId = process.env.PODIUM_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: "PODIUM_CLIENT_ID environment variable is not configured" });
    return;
  }

  const { state, nonce } = buildSignedState(userId);
  req.session.podiumOAuthState = nonce;

  const redirectUri = getRedirectUri();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
  });

  const authUrl = `${PODIUM_AUTH_URL}?${params.toString()}`;
  console.log(`[Podium OAuth] Authorize requested for user ${userId}, redirect_uri=${redirectUri}`);

  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        console.error("[Podium OAuth] Failed to save session with OAuth state:", err);
        reject(err);
      } else {
        console.log(`[Podium OAuth] Session saved with OAuth state for user ${userId}`);
        resolve();
      }
    });
  });

  res.json({ authUrl });
});

router.get("/oauth/podium/callback", async (req, res) => {
  const { code, state, error } = req.query;

  const sessionUserId = req.session?.userId as number | undefined;
  const sessionNonce = req.session?.podiumOAuthState as string | undefined;

  const parsed = state ? parseSignedState(String(state)) : null;

  let userId: number | undefined = sessionUserId;
  let sessionRecovered = false;

  if (!userId && parsed) {
    userId = parsed.userId;
    sessionRecovered = true;
    console.warn(`[Podium OAuth] Session lost on callback — recovered userId=${userId} from signed state`);
  }

  console.log(`[Podium OAuth] Callback received: hasCode=${!!code}, hasState=${!!state}, hasError=${!!error}, hasSessionState=${!!sessionNonce}, hasSessionUserId=${!!sessionUserId}, recoveredFromState=${sessionRecovered}, resolvedUserId=${userId ?? "none"}`);

  if (!userId) {
    console.error("[Podium OAuth] Callback failed: no session and state signature invalid or missing");
    res.redirect("/settings?podiumOAuth=error&message=not_authenticated");
    return;
  }

  if (error) {
    console.error(`[Podium OAuth] Podium returned error for user ${userId}: ${String(error)}`);
    res.redirect(`/settings?podiumOAuth=error&message=${encodeURIComponent(String(error))}`);
    return;
  }

  if (!code || !state) {
    console.error(`[Podium OAuth] Missing code or state for user ${userId}`);
    res.redirect("/settings?podiumOAuth=error&message=missing_code_or_state");
    return;
  }

  if (!parsed) {
    console.error(`[Podium OAuth] State signature verification failed for user ${userId}`);
    res.redirect("/settings?podiumOAuth=error&message=invalid_state");
    return;
  }

  if (sessionNonce && parsed.nonce !== sessionNonce) {
    console.error(`[Podium OAuth] Nonce mismatch for user ${userId}: session nonce does not match state nonce`);
    res.redirect("/settings?podiumOAuth=error&message=invalid_state");
    return;
  }

  if (req.session?.podiumOAuthState) {
    delete req.session.podiumOAuthState;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.redirect("/settings?podiumOAuth=error&message=user_not_found");
    return;
  }

  const clientId = process.env.PODIUM_CLIENT_ID;
  const clientSecret = process.env.PODIUM_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    res.redirect("/settings?podiumOAuth=error&message=missing_podium_env_credentials");
    return;
  }

  const redirectUri = getRedirectUri();

  try {
    const tokenResponse = await fetch(PODIUM_TOKEN_URL, {
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
      console.error(`[Podium OAuth] Token exchange failed (${tokenResponse.status}): ${errorText}`);
      res.redirect("/settings?podiumOAuth=error&message=token_exchange_failed");
      return;
    }

    const tokenData = await tokenResponse.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    };

    if (!tokenData.refresh_token) {
      console.error("[Podium OAuth] No refresh_token in response");
      res.redirect("/settings?podiumOAuth=error&message=no_refresh_token");
      return;
    }

    let config: Record<string, unknown> = {};
    if (user.podiumConfig && typeof user.podiumConfig === "string") {
      try { config = decryptConfig(user.podiumConfig); } catch {}
    }

    config.podiumAccessToken = tokenData.access_token;
    config.podiumRefreshToken = tokenData.refresh_token;
    config.podiumTokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

    let locationUid: string | null = null;
    try {
      const locResponse = await fetch("https://api.podium.com/v4/locations", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/json",
        },
      });
      if (locResponse.ok) {
        const locData = await locResponse.json() as { data?: Array<{ uid: string; name?: string }> };
        if (locData.data && locData.data.length > 0) {
          locationUid = locData.data[0].uid;
          config.podiumLocationUid = locationUid;
          config.podiumLocationName = locData.data[0].name || "Unknown Location";
          console.log(`[Podium OAuth] Resolved location: ${locationUid} (${locData.data[0].name})`);
        }
      }
    } catch (err) {
      console.warn("[Podium OAuth] Failed to fetch locations:", err);
    }

    if (locationUid && user.tenantId) {
      try {
        const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId));
        if (tenant) {
          const tenantApiConfig = (tenant.apiConfig && typeof tenant.apiConfig === "object"
            ? tenant.apiConfig
            : {}) as Record<string, unknown>;
          if (!tenantApiConfig.podiumLocationId) {
            tenantApiConfig.podiumLocationId = locationUid;
            await db.update(tenantsTable)
              .set({ apiConfig: tenantApiConfig, updatedAt: new Date() })
              .where(eq(tenantsTable.id, user.tenantId));
            console.log(`[Podium OAuth] Propagated location UID to tenant ${user.tenantId}`);
          }
        }
      } catch (err) {
        console.warn("[Podium OAuth] Failed to propagate location to tenant:", err);
      }

      try {
        const webhookSecret = crypto.randomBytes(32).toString("hex");

        const domain = process.env.REPLIT_DOMAINS?.split(",")[0] || process.env.REPLIT_DEV_DOMAIN;
        const webhookUrl = domain
          ? `https://${domain}/api/webhooks/podium`
          : "http://localhost:8080/api/webhooks/podium";

        const whResponse = await fetch("https://api.podium.com/v4/webhooks", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            url: webhookUrl,
            secret: webhookSecret,
            locationUid,
            eventTypes: ["message.sent", "message.received", "message.failed"],
          }),
        });
        if (whResponse.ok) {
          const whData = await whResponse.json() as { data?: { uid?: string } };
          config.podiumWebhookSecret = webhookSecret;
          if (whData.data?.uid) {
            config.podiumWebhookUid = whData.data.uid;
          }
          console.log(`[Podium OAuth] Webhook registered at ${webhookUrl} (uid: ${whData.data?.uid || "unknown"})`);
        } else {
          const whErr = await whResponse.text();
          console.warn(`[Podium OAuth] Webhook registration failed: ${whErr}`);
        }
      } catch (err) {
        console.warn("[Podium OAuth] Webhook registration error:", err);
      }
    }

    await db.update(usersTable)
      .set({
        podiumConfig: encryptConfig(config) as unknown as string,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, userId));

    clearPodiumTokenCache(userId);
    console.log(`[Podium OAuth] Successfully stored tokens for user ${userId}`);
    res.redirect(`/settings?podiumOAuth=success`);
  } catch (err) {
    console.error("[Podium OAuth] Token exchange error:", err);
    res.redirect("/settings?podiumOAuth=error&message=server_error");
  }
});

router.get("/oauth/podium/status", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  let config: Record<string, unknown> = {};
  if (user.podiumConfig && typeof user.podiumConfig === "string") {
    try { config = decryptConfig(user.podiumConfig); } catch {}
  }

  res.json({
    connected: Boolean(config.podiumAccessToken && config.podiumRefreshToken),
    hasAccessToken: Boolean(config.podiumAccessToken),
    hasRefreshToken: Boolean(config.podiumRefreshToken),
    locationUid: config.podiumLocationUid || null,
    locationName: config.podiumLocationName || null,
  });
});

router.post("/oauth/podium/disconnect", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (user.podiumConfig && typeof user.podiumConfig === "string") {
    try {
      const config = decryptConfig(user.podiumConfig);
      const webhookUid = config.podiumWebhookUid as string | undefined;
      if (webhookUid && config.podiumRefreshToken) {
        try {
          const { getValidPodiumToken: getToken } = await import("../services/integrations/podium-auth");
          const freshToken = await getToken(userId);
          const delRes = await fetch(`https://api.podium.com/v4/webhooks/${webhookUid}`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${freshToken}`,
              Accept: "application/json",
            },
          });
          if (delRes.ok) {
            console.log(`[Podium OAuth] Deleted webhook ${webhookUid} for user ${userId}`);
          } else {
            console.warn(`[Podium OAuth] Failed to delete webhook ${webhookUid}: ${delRes.status}`);
          }
        } catch (err) {
          console.warn(`[Podium OAuth] Error deleting webhook (token may be expired):`, err);
        }
      }
    } catch {}
  }

  await db.update(usersTable)
    .set({
      podiumConfig: null,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, userId));

  clearPodiumTokenCache(userId);
  console.log(`[Podium OAuth] Disconnected for user ${userId}, token cache cleared`);
  res.json({ success: true });
});

export default router;
