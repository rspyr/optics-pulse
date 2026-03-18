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
│   └── db/                 # Drizzle ORM schema + DB connection + seed.ts
├── attached_assets/        # PRD, Product Map, Attribution Strategy, Brand Guidelines, fonts
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

## Database Schema

Tables: `tenants`, `users`, `leads`, `jobs`, `campaigns`, `campaign_daily_stats`, `attribution_events`
Enums: `lead_status`, `job_status`, `event_type`, `match_level`

## API Endpoints

All under `/api` prefix:
- `GET /health` — health check
- `GET/POST /tenants`, `GET /tenants/:tenantId` — tenant CRUD
- `GET /leads`, `GET /leads/:leadId`, `PATCH /leads/:leadId` — leads with filtering
- `GET /campaigns`, `GET /campaigns/stats` — campaigns and daily stats
- `GET /attribution/events` — attribution events with match level filtering
- `GET /jobs` — jobs with status filtering
- `POST /webhooks/ingest` — webhook ingestion (CallRail, ServiceTitan, manual)
- `GET /dashboard/overview` — KPI overview (spend, revenue, ROAS, leads, booking/close rates)
- `GET /dashboard/spend-revenue` — daily spend vs revenue chart data
- `GET /dashboard/tenant-performance` — cross-client benchmarking

## Attribution Engine (4-Level Waterfall)

1. **Diamond** — GCLID/WBRAID direct match (confidence: 1.0)
2. **Golden** — hashedPhone + timestamp fuzzy (confidence: 0.9)
3. **Silver** — hashedEmail match (confidence: 0.8)
4. **Bronze** — billingAddress match (confidence: 0.6)
5. **Unmatched** — no match found

## Frontend Pages

- `/` — Command Center dashboard (KPI cards + spend vs revenue chart)
- `/leads` — Leads HUD (speed-to-lead table with status filters)
- `/clients` — Client Portal / Searchlight Killer (CPL, booking rate, funnel bottlenecks)
- `/internal` — Agency God View (cross-client benchmarking table)
- `/attribution` — Attribution Log (event ingestion & matching waterfall)
- `/settings` — System configuration (API keys, capture script)

## Seed Data

Run `npx tsx lib/db/seed.ts` to populate demo data:
- 2 tenants (Apex HVAC, Nordic Climate Solutions)
- 6 campaigns (Google + Meta per tenant)
- 31 days of daily stats (186 rows)
- 80 leads with varied statuses
- 28 jobs linked to booked/sold leads
- 120 attribution events across all match levels

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. Run `pnpm run typecheck` from root.

## Packages

### `artifacts/api-server` (`@workspace/api-server`)
Express 5 API server. Routes in `src/routes/`. Uses `@workspace/api-zod` for validation and `@workspace/db` for persistence.

### `artifacts/marketing-os` (`@workspace/marketing-os`)
React + Vite frontend. Dark mode only, branded with Söhne fonts. Uses `@workspace/api-client-react` for API calls.

### `lib/db` (`@workspace/db`)
Drizzle ORM with PostgreSQL. Exports db client and schema models. Seed script at `lib/db/seed.ts`.

### `lib/api-spec` (`@workspace/api-spec`)
OpenAPI 3.1 spec and Orval codegen config. Run `pnpm --filter @workspace/api-spec run codegen`.

### `lib/api-zod` (`@workspace/api-zod`)
Generated Zod schemas from OpenAPI spec.

### `lib/api-client-react` (`@workspace/api-client-react`)
Generated React Query hooks and fetch client from OpenAPI spec.
