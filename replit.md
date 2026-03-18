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

Tables: `tenants`, `users`, `leads`, `jobs`, `campaigns`, `campaign_daily_stats`, `attribution_events`, `session`, `change_logs`
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

### Data
- `GET /leads`, `GET /leads/:leadId`, `PATCH /leads/:leadId` — leads with filtering
- `GET /campaigns`, `GET /campaigns/stats` — campaigns and daily stats
- `GET /attribution/events` — attribution events with match level filtering
- `POST /attribution/reconcile` — run waterfall reconciliation
- `GET /jobs` — jobs with status filtering
- `POST /webhooks/ingest` — webhook ingestion (CallRail, GHL, form, manual) with HMAC verification

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

## Frontend Pages

### Agency Portal (super_admin, agency_user)
- `/` — Command Center dashboard (KPI cards + spend vs revenue chart)
- `/internal` — Agency God View: sortable cross-client table with conditional red/green formatting, ROAS filter, budget pacing bars, benchmarking vs agency average, click-to-drill-down lead modal
- `/leads` — Leads HUD (speed-to-lead table with status filters)
- `/clients` — Client Portal preview
- `/attribution` — Attribution Log (event ingestion & matching waterfall)
- `/admin/tenants` — Tenant management (CRUD with inline edit)
- `/admin/users` — User management (CRUD with role assignment)
- `/settings` — System configuration

### Client Portal (client_admin, client_user) — "Searchlight Killer"
- `/` — Full Searchlight Killer dashboard: Big 5 KPI cards (CPL, Booking Rate, Close Rate, Avg Sale Value, ROI) with trend arrows, True ROI toggle (ROAS vs All Costs), Recharts spend/revenue bar chart (7/14/30/90 day), Change Log overlay with markers, filter system (source/type/salesperson), NL filter bar, Financial Transparency section, Bottleneck Identifier funnel chart
- `/leads` — Leads view
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

### `artifacts/api-server` (`@workspace/api-server`)
Express 5 API server. Routes in `src/routes/`. Uses `@workspace/api-zod` for validation and `@workspace/db` for persistence. Session middleware with PostgreSQL store.

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
