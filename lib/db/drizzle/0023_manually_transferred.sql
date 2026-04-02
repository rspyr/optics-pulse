ALTER TABLE "leads" ADD COLUMN "manually_transferred" BOOLEAN NOT NULL DEFAULT false;

UPDATE "leads" SET "manually_transferred" = true
WHERE EXISTS (
  SELECT 1 FROM "call_attempts"
  WHERE "call_attempts"."lead_id" = "leads"."id"
    AND "call_attempts"."action_type" = 'transfer'
    AND "call_attempts"."outcome" = 'transferred'
);
