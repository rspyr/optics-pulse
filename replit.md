# Marketing OS

## Overview

Full-stack Marketing OS platform for HVAC marketing agencies. Features a proprietary Attribution Engine, multi-tenant admin portal, client portal ("Searchlight Killer"), and gamified leads HUD. Built as a pnpm workspace monorepo using TypeScript.

## Brand System

- **Midnight Sky** `#0A0F1F` — primary background
- **Stratos** `#002D5E` — secondary blue
- **Rebel Red** `#F20505` — accent/CTA
- **Circuit White** `#FFFFFF` — text
- **Steel** `#879199` — muted text
- **Ice** `#C0D4E6` — light accent
- **Fonts**: Söhne Extrafett (headlines, all caps) + Söhne Dreiviertelfett (subheadings) + Inter (body)
- Dark mode only

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Frontend**: React + Vite + TailwindCSS v4 + Wouter + TanStack React Query
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Auth**: express-session + connect-pg-simple + bcryptjs

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server (port 8080)
│   └── marketing-os/       # React + Vite frontend (artifact path: /)
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection + seed files
├── attached_assets/        # PRD, Product Map, Attribution Strategy, Brand Guidelines, fonts
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

## Database Schema

Tables: `tenants`, `users`, `leads`, `jobs`, `campaigns`, `campaign_daily_stats`, `attribution_events`, `session`, `change_logs`, `reconciliation_runs`, `integration_sync_logs`
Enums: `lead_status`, `job_status`, `event_type`, `match_level`, `user_role`
User roles: `super_admin`, `agency_user`, `client_admin`, `client_user`

## Authentication

- Session-based auth using `express-session` with PostgreSQL session store (`connect-pg-simple`)
- Passwords hashed with `bcryptjs`
- Session cookie name: `mos.sid` (7-day expiry)
- Role-based access: super_admin/agency_user see full admin portal; client_admin/client_user see limited portal
- Demo users seeded via `npx tsx lib/db/seed-users.ts` (password: demo1234)

## API Endpoints

All under `/api` prefix:

### Auth
- `POST /auth/login` — login with email/password, returns user
- `POST /auth/logout` — destroy session
- `GET /auth/me` — get current authenticated user

### Admin
- `GET /admin/users` — list all users
- `POST /admin/users` — create user (email, name, password, role, tenantId)
- `PATCH /admin/users/:userId` — update user
- `GET /admin/dashboard-stats` — aggregated per-tenant stats with budget pacing and agency averages

### Tenants
- `GET /tenants` — list tenants
- `POST /tenants` — create tenant
- `GET /tenants/:tenantId` — get tenant
- `PATCH /tenants/:tenantId` — update tenant
- `DELETE /tenants/:tenantId` — soft-delete (deactivate)

### Leads HUD
- `GET /leads/hud/queue` — categorized lead queue (new, follow-ups, background) for HUD focus queue
- `GET /leads/hud/stats` — coordinator performance stats (calls, bookings, booking rate, commission, speed-to-lead)

### Data
- `GET /leads`, `GET /leads/:leadId`, `PATCH /leads/:leadId` — leads with filtering
- `GET /campaigns`, `GET /campaigns/stats` — campaigns and daily stats
- `GET /attribution/events` — attribution events with match level filtering
- `POST /attribution/reconcile` — run waterfall reconciliation engine (records run history, generates OCI payloads)
- `GET /attribution/reconciliation-status` — get latest/recent reconciliation runs and next scheduled time
- `GET /attribution/oci-payloads` — generate OCI payloads for Google Ads upload (agency only)
- `GET /jobs` — jobs with status filtering
- `POST /webhooks/ingest` — webhook ingestion (CallRail, GHL, form, manual) with HMAC verification; CallRail-specific signature verification via per-tenant signing key

### Integrations
- `POST /integrations/sync/:integration` — trigger manual sync (service_titan, google_ads, meta) for a tenant
- `GET /integrations/sync-status` — sync status dashboard with per-integration last sync time, record counts, error counts
- `GET /integrations/tenant-config/:tenantId` — check which integrations are configured per tenant

### Dashboard
- `GET /dashboard/overview` — KPI overview with previousPeriod comparison data
- `GET /dashboard/spend-revenue` — daily spend vs revenue chart data (supports date range filtering)
- `GET /dashboard/tenant-performance` — cross-client benchmarking

### Change Logs
- `GET /change-logs` — list change log entries (by tenantId + date range)
- `POST /change-logs` — create change log entry (agency only)

## Attribution Engine (4-Level Waterfall)

1. **Diamond** — GCLID/WBRAID direct match (confidence: 1.0)
2. **Golden** — hashedPhone + timestamp fuzzy (confidence: 0.9)
3. **Silver** — hashedEmail match (confidence: 0.8)
4. **Bronze** — billingAddress household match (confidence: 0.6)
5. **Unmatched** — no match found

### Reconciliation Engine
- Extracted waterfall logic into `artifacts/api-server/src/services/reconciliation.ts`
- Records each run in `reconciliation_runs` table with per-level match counts, match rate, trigger type (manual/scheduled), status, and timing
- Generates OCI (Offline Conversion Import) payloads for matched jobs with GCLIDs — ready for Google Ads API upload
- Nightly cron scheduler (`services/cron.ts`) runs at 3:00 AM daily, processing all tenants sequentially
- Command Center UI panel shows latest run breakdown (Diamond/Golden/Silver/Bronze/Match Rate), run history with trigger badges, next scheduled time, and manual "Run Now" button

## External API Integrations

### API Client Modules (`artifacts/api-server/src/services/integrations/`)
- **ServiceTitan** — `service-titan.ts`: OAuth2 client credentials auth, token caching, completed job fetch with pagination, custom field PATCH for attribution GCLID writeback, token bucket rate limiter (10 tokens, 5/sec refill)
- **Google Ads** — `google-ads.ts`: Campaign performance fetch via GAQL, OCI (Offline Conversion Import) upload for matched conversions, uses developer token + access token auth
- **Meta Marketing** — `meta.ts`: Campaign insights fetch with date range + pagination, CAPI (Conversions API) server-side event upload for lead events, Pixel ID scoped
- **CallRail** — `callrail.ts`: HMAC-SHA256 webhook signature verification using per-tenant signing key from encrypted config
- **Rate Limiter** — `rate-limiter.ts`: Generic token bucket rate limiter + exponential backoff retry utility (used by all API clients)

### Sync Scheduler (`artifacts/api-server/src/services/sync-scheduler.ts`)
- ServiceTitan jobs sync: every 15 minutes (upsert by stJobId)
- Google Ads + Meta campaign stats sync: every 60 minutes
- All syncs logged to `integration_sync_logs` table with status, record counts, error messages
- Per-tenant API credentials stored encrypted in `tenants.apiConfig` (AES-256-GCM)

### Tenant Integration Config Fields
Stored encrypted in `tenants.apiConfig`: `serviceTitanClientId`, `serviceTitanClientSecret`, `serviceTitanTenantId`, `googleAdsApiKey`, `googleAdsDeveloperToken`, `googleAdsCustomerId`, `googleAdsLoginCustomerId`, `metaAccessToken`, `metaAdAccountId`, `metaPixelId`, `callRailApiKey`, `callRailSigningKey`

## Frontend Pages

### Agency Portal (super_admin, agency_user)
- `/` — Command Center dashboard (KPI cards + spend vs revenue chart)
- `/internal` — Agency God View: sortable cross-client table with conditional red/green formatting, ROAS filter, budget pacing bars, benchmarking vs agency average, click-to-drill-down lead modal
- `/leads` — Gamified Leads HUD: Focus Queue with real-time lead cards (countdown timers, source badges, priority sorting), Quick Actions (click-to-dial, SMS, email, voicemail script), disposition logging (Booked, Never Answered, Out of Area, etc.), commission ticker (+$20 animation on booking), performance stats (calls, bookings, booking rate, speed-to-lead, earned), smart queue tabs (New Leads / Touch These / Background), AI scheduling hints, screen flash + ding on new lead arrival via WebSocket
- `/clients` — Client Portal preview
- `/attribution` — Attribution Log (event ingestion & matching waterfall)
- `/admin/tenants` — Tenant management (CRUD with inline edit)
- `/admin/users` — User management (CRUD with role assignment)
- `/settings` — System configuration

### Client Portal (client_admin, client_user) — "Searchlight Killer"
- `/` — Full Searchlight Killer dashboard: Big 5 KPI cards (CPL, Booking Rate, Close Rate, Avg Sale Value, ROI) with trend arrows, True ROI toggle (ROAS vs All Costs), Recharts spend/revenue bar chart (7/14/30/90 day), Change Log overlay with markers, filter system (source/type/salesperson), NL filter bar, Financial Transparency section, Bottleneck Identifier funnel chart
- `/leads` — Leads HUD (same gamified interface as agency, scoped to client's tenant)
- `/attribution` — Attribution Log
- `/settings` — Settings

## Seed Data

Run `npx tsx lib/db/seed.ts` to populate demo data, then `npx tsx lib/db/seed-users.ts` for users:
- 2 tenants (Apex HVAC, Nordic Climate Solutions)
- 7 demo users (3 agency, 4 client)
- 6 campaigns (Google + Meta per tenant)
- 31 days of daily stats (186 rows)
- 80 leads with varied statuses
- 28 jobs linked to booked/sold leads
- 120 attribution events across all match levels
- 10 change log entries (marketing changes with dates + descriptions)

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. Run `pnpm run typecheck` from root.

## Packages

## WebSocket (Socket.IO)

- Socket.IO server attached to the HTTP server via `src/socket.ts`
- Path: `/api/socket.io`
- Session middleware shared with Express for authentication
- Unauthenticated connections are rejected
- Tenant isolation: clients can only join their own tenant room; agency/admin can join any
- Events: `new-lead` (emitted to tenant room when new lead arrives), `join-tenant` (client joins tenant room)
- Demo mode: in development (`NODE_ENV !== 'production'`), auto-creates new leads every 30-60s

### `artifacts/api-server` (`@workspace/api-server`)
Express 5 API server. Routes in `src/routes/`. Uses `@workspace/api-zod` for validation and `@workspace/db` for persistence. Session middleware with PostgreSQL store. Socket.IO for real-time lead notifications.

### `artifacts/marketing-os` (`@workspace/marketing-os`)
React + Vite frontend. Dark mode only, branded with Söhne fonts. Uses `@workspace/api-client-react` for API calls. Auth context provides role-based routing.

### `lib/db` (`@workspace/db`)
Drizzle ORM with PostgreSQL. Exports db client, pool, and schema models. Seed scripts at `lib/db/seed.ts` and `lib/db/seed-users.ts`.

### `lib/api-spec` (`@workspace/api-spec`)
OpenAPI 3.1 spec and Orval codegen config. Run `pnpm --filter @workspace/api-spec run codegen`.

### `lib/api-zod` (`@workspace/api-zod`)
Generated Zod schemas from OpenAPI spec.

### `lib/api-client-react` (`@workspace/api-client-react`)
Generated React Query hooks and fetch client from OpenAPI spec.
