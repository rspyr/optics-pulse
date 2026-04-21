/**
 * One-shot CLI wrapper around `backfillSheetLeads`.
 *
 * Use this to recover historical leads that landed in a tenant's Google Sheet
 * but never made it into the `leads` table (e.g. tracker-only tenants whose
 * pulse.js missed the real submits during a capture-gap window).
 *
 * Example (Vance, 4/14-4/19, Meta UTM):
 *   pnpm --filter @workspace/api-server exec tsx ./src/scripts/backfill-tenant-sheet-leads.ts \
 *     --tenant=3 \
 *     --sheet=1AbC...XYZ --tab="Leads" \
 *     --dateColumn="Submitted At" \
 *     --from=2026-04-14T00:00:00 --to=2026-04-19T23:59:59 \
 *     --source=Meta --utmMedium=cpc --utmCampaign=spring-2026 \
 *     --funnel=12 \
 *     --map=first_name=firstName,last_name=lastName,phone=phone,email=email \
 *     --dry-run
 *
 * Drop --dry-run to actually write. Sheet sync remains paused; this never
 * touches `google_sheet_configs.syncPaused` or `tenants.leadIngestionMode`.
 */

import { backfillSheetLeads } from "../services/backfill-sheet-leads";

interface CliArgs {
  tenant: number;
  sheet: string;
  tab: string;
  dateColumn: string;
  from: Date;
  to: Date;
  source: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  funnel: number | null;
  mapping: Record<string, string>;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") { dryRun = true; continue; }
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) opts[m[1]] = m[2];
  }

  const required = ["tenant", "sheet", "tab", "dateColumn", "from", "to", "map"];
  for (const r of required) {
    if (!opts[r]) {
      console.error(`Missing required arg: --${r}`);
      console.error("See script header for usage.");
      process.exit(2);
    }
  }

  const mapping: Record<string, string> = {};
  for (const pair of opts.map.split(",")) {
    const [header, semantic] = pair.split("=");
    if (header && semantic) mapping[header.trim()] = semantic.trim();
  }

  const tenant = parseInt(opts.tenant, 10);
  if (!Number.isInteger(tenant) || tenant <= 0) {
    console.error(`Invalid --tenant: ${opts.tenant}`);
    process.exit(2);
  }
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    console.error(`Invalid --from or --to date (got from=${opts.from}, to=${opts.to})`);
    process.exit(2);
  }
  if (from.getTime() > to.getTime()) {
    console.error(`--from must be before --to`);
    process.exit(2);
  }
  if (Object.keys(mapping).length === 0) {
    console.error(`--map produced an empty mapping; expected header=semantic pairs separated by commas`);
    process.exit(2);
  }
  if (opts.funnel && !Number.isInteger(parseInt(opts.funnel, 10))) {
    console.error(`Invalid --funnel: ${opts.funnel}`);
    process.exit(2);
  }

  return {
    tenant,
    sheet: opts.sheet,
    tab: opts.tab,
    dateColumn: opts.dateColumn,
    from,
    to,
    source: opts.source || null,
    utmSource: opts.utmSource || opts.source || null,
    utmMedium: opts.utmMedium || null,
    utmCampaign: opts.utmCampaign || null,
    utmContent: opts.utmContent || null,
    utmTerm: opts.utmTerm || null,
    funnel: opts.funnel ? parseInt(opts.funnel, 10) : null,
    mapping,
    dryRun,
  };
}

async function main() {
  const a = parseArgs();
  console.log(`[Backfill] tenant=${a.tenant} sheet=${a.sheet} tab=${a.tab}`);
  console.log(`[Backfill] window: ${a.from.toISOString()} -> ${a.to.toISOString()}`);
  console.log(`[Backfill] mapping: ${JSON.stringify(a.mapping)}`);
  console.log(`[Backfill] dryRun=${a.dryRun}`);

  const result = await backfillSheetLeads({
    tenantId: a.tenant,
    spreadsheetId: a.sheet,
    tabName: a.tab,
    dateColumn: a.dateColumn,
    dateFrom: a.from,
    dateTo: a.to,
    columnMapping: a.mapping,
    resolvedSource: a.source,
    utmDefaults: {
      utmSource: a.utmSource,
      utmMedium: a.utmMedium,
      utmCampaign: a.utmCampaign,
      utmContent: a.utmContent,
      utmTerm: a.utmTerm,
    },
    defaultFunnelTypeId: a.funnel,
    dryRun: a.dryRun,
  });

  console.log("[Backfill] result:", JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("[Backfill] FAILED:", err);
  process.exit(1);
});
