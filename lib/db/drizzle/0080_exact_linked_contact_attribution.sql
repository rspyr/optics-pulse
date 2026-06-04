WITH exact_linked_contact AS (
  SELECT
    j.id AS job_id,
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
    END AS match_level
  FROM jobs j
  JOIN leads l
    ON l.id = j.lead_id
    AND l.tenant_id = j.tenant_id
  WHERE j.status = 'completed'
    AND (j.match_level IS NULL OR j.match_level = 'unmatched')
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
    )
)
UPDATE jobs j
SET
  match_level = c.match_level,
  updated_at = now()
FROM exact_linked_contact c
WHERE j.id = c.job_id
  AND c.match_level IS NOT NULL;
