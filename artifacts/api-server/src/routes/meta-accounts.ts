import { Router, type IRouter } from "express";
import { db, tenantsTable, metaAdAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { encryptConfig, decryptConfig } from "../lib/encryption";
import { MetaAPIService, MetaTokenInvalidError } from "../services/integrations/meta";
import { backfillMetaCampaigns } from "../services/sync-scheduler";

const router: IRouter = Router();

router.get("/integrations/meta/ad-accounts", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = Number(req.query.tenantId);
  if (!tenantId || isNaN(tenantId)) {
    res.status(400).json({ error: "tenantId required" });
    return;
  }
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  let config: Record<string, unknown> = {};
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try { config = decryptConfig(tenant.apiConfig); } catch {}
  }

  if (refresh) {
    const accessToken = config.metaAccessToken as string | undefined;
    if (!accessToken) {
      res.status(400).json({ error: "Tenant is not connected to Meta. Connect via OAuth first." });
      return;
    }
    try {
      const svc = new MetaAPIService({ accessToken, adAccountId: "" });
      const discovered = await svc.listAdAccounts();
      const existing = await db.select().from(metaAdAccountsTable).where(eq(metaAdAccountsTable.tenantId, tenantId));
      const existingByAcc = new Map(existing.map((r) => [r.accountId, r] as const));
      for (const acc of discovered) {
        const accountId = acc.account_id || acc.id?.replace(/^act_/, "") || "";
        if (!accountId) continue;
        const prior = existingByAcc.get(accountId);
        if (prior) {
          await db.update(metaAdAccountsTable)
            .set({ name: acc.name || prior.name, currency: acc.currency || prior.currency, updatedAt: new Date() })
            .where(eq(metaAdAccountsTable.id, prior.id));
        } else {
          await db.insert(metaAdAccountsTable).values({
            tenantId, accountId, name: acc.name || "", currency: acc.currency || "USD", isSelected: false,
          });
        }
      }
    } catch (err) {
      if (err instanceof MetaTokenInvalidError) {
        await db.update(tenantsTable)
          .set({ metaNeedsReconnect: true, metaReconnectReason: err.message, updatedAt: new Date() })
          .where(eq(tenantsTable.id, tenantId));
        res.status(401).json({ error: "Meta access token has expired. Reconnect required.", needsReconnect: true });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `Failed to fetch ad accounts from Meta: ${msg}` });
      return;
    }
  }

  const accounts = await db.select().from(metaAdAccountsTable).where(eq(metaAdAccountsTable.tenantId, tenantId));
  const selectedAdAccountId = (config.metaAdAccountId as string | undefined) || null;

  res.json({
    tenantId,
    selectedAdAccountId,
    needsReconnect: Boolean(tenant.metaNeedsReconnect),
    accounts: accounts.map((a) => ({
      accountId: a.accountId,
      name: a.name,
      currency: a.currency,
      isSelected: a.isSelected,
      discoveredAt: a.discoveredAt,
    })),
  });
});

router.post("/integrations/meta/ad-accounts/select", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = Number(req.body?.tenantId);
  const accountIdRaw = String(req.body?.accountId || "");
  if (!tenantId || isNaN(tenantId)) {
    res.status(400).json({ error: "tenantId required" });
    return;
  }
  if (!accountIdRaw) {
    res.status(400).json({ error: "accountId required" });
    return;
  }
  const accountId = accountIdRaw.replace(/^act_/, "");

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const [acct] = await db.select().from(metaAdAccountsTable)
    .where(and(eq(metaAdAccountsTable.tenantId, tenantId), eq(metaAdAccountsTable.accountId, accountId)));
  if (!acct) {
    res.status(404).json({ error: "Ad account not found for this tenant. Reconnect Meta to refresh the list." });
    return;
  }

  await db.update(metaAdAccountsTable).set({ isSelected: false }).where(eq(metaAdAccountsTable.tenantId, tenantId));
  await db.update(metaAdAccountsTable).set({ isSelected: true, updatedAt: new Date() })
    .where(and(eq(metaAdAccountsTable.tenantId, tenantId), eq(metaAdAccountsTable.accountId, accountId)));

  let config: Record<string, unknown> = {};
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try { config = decryptConfig(tenant.apiConfig); } catch {}
  }
  config.metaAdAccountId = `act_${accountId}`;
  await db.update(tenantsTable)
    .set({
      apiConfig: encryptConfig(config) as unknown as typeof tenantsTable.$inferInsert.apiConfig,
      updatedAt: new Date(),
    })
    .where(eq(tenantsTable.id, tenantId));

  res.json({ success: true, selectedAdAccountId: `act_${accountId}` });
});

/**
 * One-shot historical Meta backfill. Pulls per-ad insights for the trailing
 * `days` window (default 365, max 1095 ≈ 3 years) in 30-day chunks and writes
 * into `meta_ad_daily_stats` + `campaign_daily_stats` via the same ON CONFLICT
 * upsert path as the nightly sync. Honors the per-tenant Meta advisory lock,
 * so it cannot overlap with the scheduled 30-day refresh — operators get a
 * `409 sync_in_progress` if the scheduler is mid-run. Progress + completion
 * land in `integration_sync_logs` with sync_type=`backfill`.
 */
router.post("/integrations/meta/backfill", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = Number(req.query.tenantId ?? req.body?.tenantId);
  const daysRaw = req.query.days ?? req.body?.days ?? 365;
  const days = Number(daysRaw);

  if (!tenantId || isNaN(tenantId)) {
    res.status(400).json({ error: "tenantId required" });
    return;
  }
  if (!Number.isFinite(days) || days <= 30) {
    res.status(400).json({ error: "days must be a number > 30 (the nightly sync already covers the last 30 days)" });
    return;
  }
  if (days > 1095) {
    res.status(400).json({ error: "days cannot exceed 1095 (Meta's insights retention is ~37 months)" });
    return;
  }

  const result = await backfillMetaCampaigns(tenantId, days);
  if (result.error) {
    // A cooperative cancel is a deliberate stop, not a failure — finalize the
    // request as a 200 success with `cancelled: true` (mirrors the google_ads
    // / service_titan backfill cancel contract) so the UI shows a "cancelled"
    // toast instead of a misleading "backfill failed" error. Rows already
    // synced are kept (the sync log row is finalized as `cancelled`).
    if (result.error === "cancelled") {
      res.json({ success: true, cancelled: true, ...result });
      return;
    }
    const status = /already running/i.test(result.error) ? 409
      : /not found/i.test(result.error) ? 404
      : /not configured|needs reconnect/i.test(result.error) ? 400
      : 502;
    res.status(status).json({ success: false, ...result });
    return;
  }
  res.json({ success: true, ...result });
});

export default router;
