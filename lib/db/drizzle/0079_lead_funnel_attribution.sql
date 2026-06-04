ALTER TABLE "reconciliation_runs"
  ADD COLUMN IF NOT EXISTS "lead_funnel_matches" integer NOT NULL DEFAULT 0;

WITH candidates AS (
  SELECT DISTINCT ON (j.id)
    j.id AS job_id,
    l.id AS lead_id,
    CASE
      WHEN right(regexp_replace(coalesce(j.customer_phone, ''), '\D', '', 'g'), 10) <> ''
        AND right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) <> ''
        AND right(regexp_replace(coalesce(j.customer_phone, ''), '\D', '', 'g'), 10)
          = right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10)
        THEN 'golden'
      WHEN lower(trim(coalesce(j.customer_email, ''))) <> ''
        AND lower(trim(coalesce(l.email, ''))) <> ''
        AND lower(trim(j.customer_email)) = lower(trim(l.email))
        THEN 'silver'
      ELSE 'lead_funnel'
    END AS match_level
  FROM jobs j
  JOIN leads l
    ON l.tenant_id = j.tenant_id
    AND (
      (
        right(regexp_replace(coalesce(j.customer_phone, ''), '\D', '', 'g'), 10) <> ''
        AND right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) <> ''
        AND right(regexp_replace(coalesce(j.customer_phone, ''), '\D', '', 'g'), 10)
          = right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10)
      )
      OR (
        lower(trim(coalesce(j.customer_email, ''))) <> ''
        AND lower(trim(coalesce(l.email, ''))) <> ''
        AND lower(trim(j.customer_email)) = lower(trim(l.email))
      )
      OR (
        j.lead_id = l.id
        AND (
          l.funnel_id IS NOT NULL
          OR (
            nullif(trim(coalesce(l.lead_type, '')), '') IS NOT NULL
            AND lower(trim(l.lead_type)) <> 'unknown'
          )
        )
      )
    )
  WHERE j.status = 'completed'
    AND (j.match_level IS NULL OR j.match_level = 'unmatched')
  ORDER BY
    j.id,
    CASE
      WHEN right(regexp_replace(coalesce(j.customer_phone, ''), '\D', '', 'g'), 10) <> ''
        AND right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) <> ''
        AND right(regexp_replace(coalesce(j.customer_phone, ''), '\D', '', 'g'), 10)
          = right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10)
        THEN 1
      WHEN lower(trim(coalesce(j.customer_email, ''))) <> ''
        AND lower(trim(coalesce(l.email, ''))) <> ''
        AND lower(trim(j.customer_email)) = lower(trim(l.email))
        THEN 2
      ELSE 3
    END,
    CASE WHEN j.lead_id = l.id THEN 0 ELSE 1 END,
    l.id
)
UPDATE jobs j
SET
  match_level = c.match_level,
  lead_id = COALESCE(j.lead_id, c.lead_id),
  updated_at = now()
FROM candidates c
WHERE j.id = c.job_id;
