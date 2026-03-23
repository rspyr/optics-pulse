# Marketing OS

## Overview

Marketing OS is a full-stack, monorepo platform designed for HVAC marketing agencies. Its primary purpose is to provide a comprehensive solution for managing client marketing efforts, with a strong focus on lead attribution, performance monitoring, and client reporting. Key capabilities include a proprietary Attribution Engine, a multi-tenant administration portal, a client-facing portal ("Searchlight Killer"), and a gamified leads management system. The platform aims to streamline agency operations, enhance marketing effectiveness through data-driven insights, and improve client transparency and satisfaction.

## User Preferences

I prefer iterative development with clear communication on significant changes. Please ask before making major architectural decisions or introducing new external dependencies. I also prefer detailed explanations for complex features or logic.

## System Architecture

The Marketing OS is built as a pnpm workspace monorepo using Node.js 24 and TypeScript 5.9.

**UI/UX Decisions:**
The frontend, developed with React, Vite, TailwindCSS v4, Wouter, and TanStack React Query, adheres to a dark-mode-only design system. It uses a specific brand palette (Midnight Sky, Stratos, Rebel Red, Circuit White, Steel, Ice) and typography (Söhne Extrafett, Söhne Dreiviertelfett, Inter) to maintain a consistent and branded user experience.

**Technical Implementations:**
- **API:** An Express 5 server handles all API requests.
- **Database:** PostgreSQL is used as the primary database, managed with Drizzle ORM.
- **Authentication:** Session-based authentication is implemented using `express-session` with a PostgreSQL store and `bcryptjs` for password hashing. Role-based access control (`super_admin`, `agency_user`, `client_admin`, `client_user`) governs portal access.
- **Real-time Features:** Socket.IO is integrated for real-time lead notifications and other interactive elements, ensuring tenant isolation.
- **API Codegen:** OpenAPI specifications are used with Orval for generating TypeScript API clients (`api-client-react`) and Zod schemas (`api-zod`), promoting type safety and consistency.
- **Monorepo Structure:** The project is organized into `artifacts` (containing `api-server` and `marketing-os` applications) and `lib` (for shared code like `api-spec`, `api-client-react`, `api-zod`, and `db`).

**Feature Specifications:**
- **Attribution Engine:** A 4-level waterfall attribution model (Diamond, Golden, Silver, Bronze) tracks lead sources with varying confidence levels. It includes a Reconciliation Engine that records run history, generates OCI payloads for Google Ads, and supports Enhanced Conversions.
- **Leads HUD:** A gamified interface for lead management with real-time queues, quick actions, disposition logging, and performance statistics. Lead types are now seeded from the `funnel_types` table and the demo lead generator uses DB-backed funnel types per tenant. Communication routing supports CallRail click-to-call, Podium call/text, and native fallback — configured per-tenant via `communicationConfig` JSONB on the tenants table. Call/text actions from the HUD route through `POST /leads/:leadId/call` and `POST /leads/:leadId/text` endpoints, auto-logging attempts with method/platform tracking in `call_attempts`. Smart scheduling powered by `lead-scoring.ts` service: analyzes call attempt history to compute per-lead priority scores (0-100), optimal contact windows, double-dial recommendations, and tenant-wide hourly pickup rate analysis. Queue endpoint `/leads/hud/queue` returns leads sorted by bucket (new → followup → background) then by optimal window and priority score, with `_suggestion` objects embedded per lead. Frontend displays AI-driven scheduling hints with color-coded urgency, "Why this order?" expandable detail, and attempt/missed counters. **Historical Stats & Comparison Cards:** `coordinator_daily_stats` table stores daily aggregated stats per coordinator per tenant (calls, bookings, rate, commission, speed-to-lead). Nightly aggregation runs at 2 AM via `startNightlyAggregation()`. Comparison API (`GET /leads/hud/comparison?baseline=yesterday|last_week|monthly_avg|all_time_best`) computes live today stats from leads table (matching `getHudStats` logic) and compares against historical baselines. Historical API (`GET /leads/hud/historical?range=30`) returns daily stat series with personal bests. Frontend stat cards show inline delta indicators (green up/red down arrows with % change) next to each metric. Baseline selector dropdown allows switching comparison period. Chart toggle reveals a Recharts AreaChart with metric tabs (Calls/Bookings/Rate/Commission) and range selectors (7d/14d/30d/90d), plus personal bests footer.
- **Script Management:** Database-backed script management for call, text, email, and voicemail templates (`scripts` + `script_versions` tables). Full CRUD API at `/api/scripts` with auto-seeding of 16 default scripts per tenant on first access. Version history tracked on every edit; revert to any previous version via `PUT /scripts/:id/revert/:versionId`. Every script create/update/delete auto-logs a changelog entry (category: "scripts") visible on the spend vs. revenue chart. Agency users pass `?tenantId=` for cross-tenant management. Frontend Script Management UI at `/admin/scripts` with type tabs, editor with live preview (placeholder substitution), and version history. Leads HUD dynamically loads scripts via `useScripts()` hook + `findScript()` helper with inline fallbacks.
- **Media Buying Automation:** Rules-based system for managing marketing campaigns, including condition-based alerts and actions.
- **Budget Controls:** Campaign dropdown in Agency God View fetches campaigns from DB filtered by tenant + platform (uses `externalId` for budget API calls).
- **Client Alerts:** Per-tenant configurable alert thresholds (lead drop %, booking rate %, ROAS, spend spike %), custom email recipients with add/delete, and agency sender email override. Config stored in `tenants.alert_config` (JSONB). Falls back to `client_admin` users when no custom recipients set.
- **Chat Analytics:** Natural language querying for data insights and contextual suggestions.
- **Client Portal:** A "Searchlight Killer" dashboard providing clients with KPIs, financial transparency, bottleneck identification, and chat analytics.

**System Design Choices:**
- **Modularity:** The monorepo structure with pnpm workspaces promotes code reuse and separation of concerns.
- **Scalability:** The architecture supports multi-tenancy, allowing for efficient management of multiple client accounts.
- **Data Security:** API credentials and sensitive tenant configurations are stored encrypted (AES-256-GCM). The `sanitizeTenant` function classifies fields into SECRET_FIELDS (API keys/tokens masked as `••••last4`) and non-secret IDs (returned in full via `loadableConfig`). Frontend dirty-field tracking ensures masked placeholders are never sent back in PATCH requests.
- **Funnel-Aware Tracking:** Funnel types are global agency-level templates (no `tenant_id` column). A `tenant_funnel_types` join table associates tenants with their assigned funnels. tracker.js reads `data-funnel` attribute from its script tag, stores the funnel slug in localStorage UTM data, and injects `_mos_funnel` hidden fields into forms. Webhook ingestion resolves funnel slugs to funnel type names via `funnel_types` lookup AND verifies tenant association via `tenant_funnel_types` join table to prevent cross-tenant data leakage. GHL webhooks parse `_mos_funnel` from custom fields. Slugs are globally unique and immutable after creation.

## External Dependencies

- **ServiceTitan:** OAuth2 client for fetching completed jobs, applying custom field patches, and utilizing a token bucket rate limiter.
- **Google Ads API:** Used for campaign performance data (GAQL), Offline Conversion Import (OCI), and Enhanced Conversions uploads. Requires developer token and access token authentication.
- **Meta Marketing API:** For fetching campaign insights and server-side event uploads via Conversions API (CAPI).
- **CallRail API:** Webhook ingestion with HMAC-SHA256 signature verification using tenant-specific signing keys.
- **Podium API:** For review data synchronization and webhook handling.
- **PostgreSQL:** Primary database.
- **Express:** Web application framework for the API server.
- **React:** Frontend library.
- **Vite:** Frontend build tool.
- **TailwindCSS:** Utility-first CSS framework.
- **Wouter:** Lightweight React router.
- **TanStack React Query:** Data fetching and caching library.
- **Zod:** Schema declaration and validation library.
- **Drizzle ORM:** TypeScript ORM for PostgreSQL.
- **Orval:** OpenAPI client code generator.
- **Socket.IO:** WebSocket library for real-time communication.
- **bcryptjs:** Library for hashing passwords.
- **express-session & connect-pg-simple:** For session management and PostgreSQL session store.