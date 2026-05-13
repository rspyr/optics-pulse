-- Task #399 — enforce at the database layer that any non-admin user
-- (i.e. role NOT IN ('super_admin','agency_user')) has a tenant_id.
--
-- This complements the application-level checks added in task #394
-- (admin user create/patch routes + startup audit) by making the
-- broken state impossible from any code path: direct SQL, future
-- routes, data imports, etc.
--
-- Idempotent: uses IF NOT EXISTS-style guards so re-running is a
-- safe no-op. Any pre-existing violating rows must be repaired or
-- removed beforehand using the broken-account audit output
-- (`[broken-account-audit]` in API server logs); the DO block below
-- raises a clear EXCEPTION listing the offending user_ids if so.

DO $$
DECLARE
  bad_count int;
  bad_ids text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_non_admin_requires_tenant'
      AND conrelid = 'public.users'::regclass
  ) THEN
    SELECT COUNT(*), string_agg(id::text, ',' ORDER BY id)
      INTO bad_count, bad_ids
      FROM public.users
     WHERE tenant_id IS NULL
       AND role NOT IN ('super_admin', 'agency_user');

    IF bad_count > 0 THEN
      RAISE EXCEPTION
        'Cannot add users_non_admin_requires_tenant: % non-admin user row(s) have NULL tenant_id (ids: %). Repair or remove them first — see [broken-account-audit] log lines from the API server.',
        bad_count, bad_ids;
    END IF;

    ALTER TABLE public.users
      ADD CONSTRAINT users_non_admin_requires_tenant
      CHECK (role IN ('super_admin', 'agency_user') OR tenant_id IS NOT NULL);
  END IF;
END
$$;
