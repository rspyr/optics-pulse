import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { encryptConfig, decryptConfig } from "../lib/encryption";
import { clearPodiumTokenCache } from "../services/integrations/podium-auth";
import crypto from "crypto";

const router: IRouter = Router();

const PODIUM_AUTH_URL = "https://api.podium.com/oauth/authorize";
const PODIUM_TOKEN_URL = "https://api.podium.com/oauth/token";
const SCOPES = "read_messages write_messages contacts.read contacts.write locations.read";

function getRedirectUri(): string {
  const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(",")[0];
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

  const state = crypto.randomBytes(16).toString("hex");
  req.session.podiumOAuthState = state;

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
  res.json({ authUrl });
});

router.get("/oauth/podium/callback", async (req, res) => {
  const { code, state, error } = req.query;

  const userId = req.session?.userId;
  if (!userId) {
    res.redirect("/settings?podiumOAuth=error&message=not_authenticated");
    return;
  }

  if (error) {
    res.redirect(`/settings?podiumOAuth=error&message=${encodeURIComponent(String(error))}`);
    return;
  }

  if (!code || !state) {
    res.redirect("/settings?podiumOAuth=error&message=missing_code_or_state");
    return;
  }

  if (state !== req.session.podiumOAuthState) {
    res.redirect("/settings?podiumOAuth=error&message=invalid_state");
    return;
  }

  delete req.session.podiumOAuthState;

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
          "podium-version": "2024-04-01",
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

    if (locationUid) {
      try {
        const webhookVerifyToken = crypto.randomBytes(32).toString("hex");
        config.podiumWebhookVerifyToken = webhookVerifyToken;

        const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(",")[0];
        const baseUrl = domain
          ? `https://${domain}/api/webhooks/podium`
          : "http://localhost:8080/api/webhooks/podium";
        const webhookUrl = `${baseUrl}?verify=${webhookVerifyToken}`;

        const whResponse = await fetch("https://api.podium.com/v4/webhooks", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "podium-version": "2024-04-01",
          },
          body: JSON.stringify({
            url: webhookUrl,
            locationUid,
            eventTypes: ["message.sent", "message.received", "message.failed"],
          }),
        });
        if (whResponse.ok) {
          console.log(`[Podium OAuth] Webhook registered at ${webhookUrl}`);
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
