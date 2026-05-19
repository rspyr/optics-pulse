import { db, pool, leadsTable } from "../src";
import { and, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";

const SCRIPT_ID = "backfill-callback-notified-at";

async function main() {
  console.log(`[${SCRIPT_ID}] Backfilling callback_notified_at for already-fired callbacks...`);

  const now = new Date();

  const updated = await db
    .update(leadsTable)
    .set({ callbackNotifiedAt: sql`${leadsTable.callbackAt}` })
    .where(
      and(
        isNotNull(leadsTable.callbackAt),
        lte(leadsTable.callbackAt, now),
        isNotNull(leadsTable.assignedCsrId),
        ne(leadsTable.hubStatus, "dead"),
        isNull(leadsTable.callbackNotifiedAt),
      ),
    )
    .returning({ id: leadsTable.id });

  console.log(`[${SCRIPT_ID}] Marked ${updated.length} leads as already-notified.`);
}

main()
  .then(() => pool.end().then(() => process.exit(0)))
  .catch((err) => {
    console.error(`[${SCRIPT_ID}] Failed:`, err);
    pool.end().then(() => process.exit(1));
  });
