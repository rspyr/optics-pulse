-- Show live row-by-row progress during chunked backfills (Google Ads). The
-- windowed backfills previously reported a percent derived only from the chunk
-- ordinal ((currentChunk - 1) / totalChunks), so the progress bar jumped once
-- per 30-day chunk and sat still for the whole upsert loop. Capture how many
-- rows of the CURRENT chunk have been upserted so far so the /sync-status route
-- can advance the percent *within* a chunk:
--   percent ≈ ((currentChunk - 1 + chunkRecords / chunkTotalRecords) / totalChunks)
-- where chunkTotalRecords reuses `progress_total_records` (the chunked writers
-- repurpose it to hold the current chunk's total row count).
--
--  * progress_chunk_records — rows upserted within the current chunk. Null on
--    integrations that don't report sub-chunk progress (Meta / ServiceTitan),
--    in which case the percent falls back to the chunk-ordinal estimate.
--    Cleared on terminal status alongside the other progress columns.

ALTER TABLE "integration_sync_logs"
  ADD COLUMN IF NOT EXISTS "progress_chunk_records" integer;
