import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptConfig, decryptConfig } from "../../lib/encryption";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

const tokenCache: Map<number, TokenCache> = new Map();

export function getPodiumConfig(user: { podiumConfig: string | null }): Record<string, unknown> {
  if (!user.podiumConfig || typeof user.podiumConfig !== "string") return {};
  try { return decryptConfig(user.podiumConfig); } catch { return {}; }
}

export async function getValidPodiumToken(userId: number): Promise<string> {
  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) throw new Error("User not found");

  const config = getPodiumConfig(user);

  const accessToken = config.podiumAccessToken as string | undefined;
  const refreshToken = config.podiumRefreshToken as string | undefined;
  const expiresAtStr = config.podiumTokenExpiresAt as string | undefined;

  if (!refreshToken) {
    throw new Error("Podium is not connected for this user");
  }

  const expiresAt = expiresAtStr ? new Date(expiresAtStr).getTime() : 0;

  if (accessToken && expiresAt > Date.now() + 60_000) {
    tokenCache.set(userId, { accessToken, expiresAt });
    return accessToken;
  }

  const clientId = process.env.PODIUM_CLIENT_ID;
  const clientSecret = process.env.PODIUM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PODIUM_CLIENT_ID and PODIUM_CLIENT_SECRET environment variables are required");
  }

  console.log(`[Podium Auth] Refreshing token for user ${userId}`);

  const response = await fetch("https://api.podium.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Podium Auth] Token refresh failed (${response.status}): ${errorText}`);
    throw new Error(`Podium token refresh failed: ${response.status}`);
  }

  const tokenData = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const newExpiresAt = Date.now() + tokenData.expires_in * 1000;

  config.podiumAccessToken = tokenData.access_token;
  config.podiumTokenExpiresAt = new Date(newExpiresAt).toISOString();
  if (tokenData.refresh_token) {
    config.podiumRefreshToken = tokenData.refresh_token;
  }

  await db.update(usersTable)
    .set({
      podiumConfig: encryptConfig(config) as unknown as string,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, userId));

  tokenCache.set(userId, {
    accessToken: tokenData.access_token,
    expiresAt: newExpiresAt,
  });

  console.log(`[Podium Auth] Token refreshed for user ${userId}`);
  return tokenData.access_token;
}

export function clearPodiumTokenCache(userId: number): void {
  tokenCache.delete(userId);
}
