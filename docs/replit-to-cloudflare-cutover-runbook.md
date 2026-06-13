# Replit to Cloudflare/Neon Cutover Runbook

## Current Rehearsal Result

- Neon was refreshed from a fresh Replit production dump using native Postgres `pg_dump`/`pg_restore`.
- Cloudflare backend health passes against the refreshed Neon database.
- Critical live counts currently match for tenants, users, leads, lead assignments, lead status history, call attempts, jobs, sold estimates, Podium messages, and push tokens.
- Replit continued writing low-risk operational rows after the dump, mainly tracker attempts, sync logs, and notifications. This confirms the final cutover needs a last quiet-window sync.

## Important Migration Rule

Use native Postgres dump/restore or a native SQL staging merge for final data movement.

Do not use an app-driver JSON/timestamp round trip for the final delta. It can preserve logical values but still normalize timestamp/JSON formatting, which makes exact forensic comparison harder.

## Final Cutover Sequence

1. Lower/confirm DNS TTL for `optics.hvaclaunch.ai`.
2. Keep Replit serving production while Cloudflare remains staged.
3. Put operations into a short quiet window:
   - CSRs pause edits/actions for a few minutes.
   - Background automation remains off on Cloudflare.
   - Replit remains the source of truth until the final restore finishes.
4. Take a final Replit production dump.
5. Restore that dump into Neon using native `pg_restore`.
6. Run the API schema migration check against Neon.
7. Verify critical counts and health:
   - tenants
   - users
   - leads
   - lead assignments
   - lead status history
   - call attempts
   - jobs
   - sold estimates
   - tracker submit attempts
   - integration sync logs
   - notifications
   - Podium messages
   - push tokens
8. Switch `optics.hvaclaunch.ai` to the Cloudflare Worker.
9. Smoke-test login, dashboard load, lead list, lead detail, CSR actions, tracker intake, OAuth callback URLs, and mobile API access.
10. Watch Replit for late writes during DNS propagation.
11. If late writes appear, backfill them into Neon using a native SQL/staging merge, then re-run the critical count checks.
12. Enable Cloudflare background jobs only after Replit late-write monitoring is clean.

## Rollback

- Keep Replit running during the cutover window.
- Keep the latest Neon pre-cutover backup in `artifacts/migration`.
- If Cloudflare fails validation, point the domain back to Replit and inspect Neon while Replit remains production.

## 2026-06-12 Production Cutover Log

- Final Replit source dump was created before DNS moved.
- Final Neon pre-cutover backup was created before Neon was replaced.
- Neon was restored from the final Replit dump with native Postgres tooling.
- `optics.hvaclaunch.ai/*` was attached as a Cloudflare Worker route for `optics-pulse-app`.
- Cloudflare DNS proxy was enabled for `optics.hvaclaunch.ai`, moving public traffic onto Cloudflare.
- The Replit deployment was stopped after the public route moved.
- Late Replit operational rows were backfilled into Neon with native Postgres binary copy.
- Cloudflare background jobs were enabled after Replit stopped responding to `/api/healthz`.
- Final public checks passed for:
  - `https://optics.hvaclaunch.ai/_edge/health`
  - `https://optics.hvaclaunch.ai/api/healthz`
  - frontend shell load
  - Cloudflare Workers AI internal route
- Final business-critical table counts matched for tenants, users, leads, lead assignments, lead status history, call attempts, jobs, sold estimates, Podium messages, and push tokens.
- `tracker_submit_attempts` diverged after Cloudflare jobs started because the app's 30-day tracker audit retention job pruned old rows. The final Replit dump remains the archive for those pruned audit rows.
