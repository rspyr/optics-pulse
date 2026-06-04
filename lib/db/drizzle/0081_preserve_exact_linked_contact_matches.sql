CREATE OR REPLACE FUNCTION preserve_exact_linked_contact_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  job_phone text;
  lead_phone text;
  job_email text;
  lead_email text;
BEGIN
  IF lower(coalesce(NEW.status::text, '')) <> 'completed' THEN
    RETURN NEW;
  END IF;

  IF NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF coalesce(NEW.match_level, 'unmatched') <> 'unmatched' THEN
    RETURN NEW;
  END IF;

  SELECT
    right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10),
    lower(trim(coalesce(l.email, '')))
  INTO lead_phone, lead_email
  FROM leads l
  WHERE l.id = NEW.lead_id
    AND l.tenant_id = NEW.tenant_id;

  job_phone := right(regexp_replace(coalesce(NEW.customer_phone, ''), '\D', '', 'g'), 10);
  job_email := lower(trim(coalesce(NEW.customer_email, '')));

  IF job_phone <> '' AND lead_phone <> '' AND job_phone = lead_phone THEN
    NEW.match_level := 'golden';
    NEW.updated_at := now();
  ELSIF job_email <> '' AND lead_email <> '' AND job_email = lead_email THEN
    NEW.match_level := 'silver';
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jobs_preserve_exact_linked_contact_match ON jobs;

CREATE TRIGGER jobs_preserve_exact_linked_contact_match
BEFORE INSERT OR UPDATE OF match_level, lead_id, customer_phone, customer_email, status, tenant_id
ON jobs
FOR EACH ROW
EXECUTE FUNCTION preserve_exact_linked_contact_match();
