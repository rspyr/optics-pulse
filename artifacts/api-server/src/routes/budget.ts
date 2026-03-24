import { Router, type IRouter } from "express";
import { db, tenantsTable, campaignsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { decryptConfig } from "../lib/encryption";
import { updateGoogleAdsCampaignBudget } from "../services/integrations/google-ads";
import { updateMetaAdSetBudget } from "../services/integrations/meta";

const router: IRouter = Router();
const agencyOnly = [requireRole("super_admin", "agency_user")];

router.post("/budget/adjust", ...agencyOnly, async (req, res): Promise<void> => {
  const { tenantId, campaignId, platform, newDailyBudget } = req.body;

  if (!tenantId || !campaignId || !platform || newDailyBudget === undefined) {
    res.status(400).json({ error: "tenantId, campaignId, platform, and newDailyBudget are required" });
    return;
  }

  const parsedBudget = Number(newDailyBudget);
  if (!Number.isFinite(parsedBudget) || parsedBudget < 0) {
    res.status(400).json({ error: "newDailyBudget must be a non-negative number" });
    return;
  }

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  let config: Record<string, string> = {};
  try {
    if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
      config = decryptConfig(tenant.apiConfig) as Record<string, string>;
    }
  } catch {
    res.status(400).json({ error: "Failed to decrypt tenant API config" });
    return;
  }

  const [campaign] = await db.select().from(campaignsTable)
    .where(and(eq(campaignsTable.externalId, String(campaignId)), eq(campaignsTable.tenantId, tenantId)));

  try {
    if (platform.toLowerCase() === "google_ads" || platform.toLowerCase() === "google") {
      if (!config.googleAdsAccessToken || !config.googleAdsDeveloperToken || !config.googleAdsCustomerId) {
        res.status(400).json({ error: "Google Ads credentials not configured for this tenant" });
        return;
      }
      await updateGoogleAdsCampaignBudget(
        {
          developerToken: config.googleAdsDeveloperToken,
          accessToken: config.googleAdsAccessToken,
          refreshToken: config.googleAdsRefreshToken,
          clientId: config.googleAdsClientId,
          clientSecret: config.googleAdsClientSecret,
          customerId: config.googleAdsCustomerId,
          loginCustomerId: config.googleAdsLoginCustomerId,
        },
        campaign?.externalId || String(campaignId),
        parsedBudget,
      );
    } else if (platform.toLowerCase() === "meta" || platform.toLowerCase() === "facebook") {
      if (!config.metaAccessToken) {
        res.status(400).json({ error: "Meta credentials not configured for this tenant" });
        return;
      }
      await updateMetaAdSetBudget(
        { accessToken: config.metaAccessToken, adAccountId: config.metaAdAccountId || "" },
        campaign?.externalId || String(campaignId),
        parsedBudget,
      );
    } else {
      res.status(400).json({ error: `Unsupported platform: ${platform}` });
      return;
    }

    res.json({ success: true, message: `Budget adjusted to $${newDailyBudget}/day for campaign ${campaignId}` });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Budget adjustment failed";
    res.status(500).json({ error: msg });
  }
});

export default router;
