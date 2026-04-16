# Marketing OS

## Overview

Marketing OS is a full-stack monorepo platform designed for HVAC marketing agencies. It aims to streamline operations, enhance marketing effectiveness, and improve client transparency through a comprehensive suite of tools. Key capabilities include lead attribution, performance monitoring, client reporting, a proprietary Attribution Engine, a multi-tenant administration portal, a client-facing portal ("Searchlight Killer"), and a gamified leads management system. The platform focuses on providing data-driven insights to manage client marketing efforts efficiently.

## User Preferences

I prefer iterative development with clear communication on significant changes. Please ask before making major architectural decisions or introducing new external dependencies. I also prefer detailed explanations for complex features or logic.

## System Architecture

The Marketing OS is structured as a pnpm workspace monorepo, utilizing Node.js 24 and TypeScript 5.9.

**UI/UX Decisions:**
The frontend employs React, Vite, TailwindCSS v4, Wouter, and TanStack React Query. It features a dark-mode-only design system with a specific brand color palette (Midnight Sky, Stratos, Rebel Red, Circuit White, Steel, Ice) and typography (Söhne Extrafett, Söhne Dreiviertelfett, Inter).

**Technical Implementations:**
- **API:** An Express 5 server manages all API interactions.
- **Database:** PostgreSQL is the primary database, interfaced via Drizzle ORM. On every startup, the API Server (1) runs `drizzle-kit push --force` against the active DB to sync the schema from the canonical Drizzle definitions in `lib/db/src/schema/`, and (2) runs data-aware one-time migrations from `artifacts/api-server/src/services/one-time-migrations.ts` for backfills and constraint tightening that `push` can't express. Both steps run **before** the server accepts traffic, so production stays in sync with the shipped schema on every deploy with no manual migration-mirroring required. Lazy initialization patterns are used to seed default data for new tenants.
- **Authentication:** Session-based authentication is implemented with `express-session` and a PostgreSQL store, featuring 30-day session durations and `bcryptjs` for password hashing. Role-based access control (`super_admin`, `agency_user`, `client_admin`, `client_user`) is in place. User management includes password changes, user inactivation, and hard deletion with foreign key protection.
- **Real-time Features:** Socket.IO provides real-time lead notifications and other interactive functionalities, ensuring tenant isolation. A global `LeadNotificationProvider` context (`contexts/lead-notification-context.tsx`) handles new-lead socket events and notification sound playback across all pages. It includes browser audio-unlock on first user gesture, visual toast fallback when audio is blocked by autoplay policy, and uses refs for the sound-enabled flag to avoid unnecessary socket reconnections.
- **API Codegen:** OpenAPI specifications with Orval generate TypeScript API clients and Zod schemas for robust API interactions.
- **Monorepo Structure:** The project is organized into `artifacts` for applications and `lib` for shared code.

**Feature Specifications:**
- **Attribution Engine:** Implements a 4-level waterfall attribution model for lead source tracking, including a Reconciliation Engine for OCI payloads and Enhanced Conversions. Phone normalization is centralized in `api-server/src/lib/phone-utils.ts` (strips to bare 10 digits, consistent hashing across all pipeline stages). CallRail sync paginates through all API pages with retry logic and logs to `integration_sync_logs`. Outbound push dedup prevents duplicate OCI/Enhanced/CAPI uploads via `oci_uploaded_at`, `enhanced_conversion_uploaded_at`, `capi_uploaded_at` timestamp columns on jobs (only set on confirmed full success). Reconciliation uses a 90-day lookback window, matches jobs directly by phone/email before falling back to lead name matching, and has no artificial row caps on address matching. Meta CAPI events include actual hashed user identifiers. A Universal Form Attribution Script (`tracker.js`) is embedded on client websites to capture UTM params, click IDs (GCLID, FBCLID, MSCLKID, TTCLID, li_fat_id, wbraid), and form submissions. The script intercepts native HTML forms, HubSpot, Gravity Forms, WPForms, and Typeform submissions, then POSTs structured JSON to `/api/tracker/submit`. Tenants are identified by `clientSlug` (a dedicated column on tenants). Form fields are stored as JSONB in `attribution_events.formFields`. The submit endpoint auto-creates leads with round-robin assignment when PII is detected.
- **Invoice-Based Metrics:** ServiceTitan Accounting API integration syncs invoices to jobs. Close rate is calculated as invoiced jobs / booked leads (not sold leads), using `lead_id` FK on jobs table for reliable matching even after PII purge. Revenue uses invoice totals with rebates (negative line items) added back, falling back to job revenue when no invoice exists. Dashboard shows paid vs unpaid revenue breakdown. Invoice columns on jobs table: `has_invoice`, `invoice_total`, `invoice_rebate_amount`, `invoice_paid_amount`, `invoice_balance`, `st_invoice_id`, `invoice_date`, `invoice_paid_on`.
- **Signed Contract Tracking:** ServiceTitan Sales API integration syncs sold estimates (status=Sold) to a `sold_estimates` table. When an estimate is marked "Sold" in ServiceTitan, the system: (1) stores contract details (amount, salesperson via Settings API employee resolver, sold date, rebates), (2) matches to jobs/leads via ST job ID, (3) sets `hasSoldEstimate=true` on the lead for fast badge lookup, (4) creates a system action history entry ("Contract signed — $X,XXX.XX (Sold by: Name)"). A gold/amber CLOSED badge appears alongside existing day/status badges on both web and mobile. Contract details (amount, salesperson, date, rebates) display in the lead detail view. Invoice revenue remains the single source of truth for dashboards — estimate amounts are display-only. Sync runs hourly alongside invoice sync.
- **Sync-Process-Purge Pipeline:** After ServiceTitan jobs sync, the system immediately runs: (1) customer contact/address enrichment, (2) lead matching (stores permanent `lead_id` FK on jobs before PII purge), (3) reconciliation (attribution matching), (4) invoice sync, (5) estimate sync. The PII purge (24h) wipes phone/email/name/stJobId but `lead_id` linkages survive. The 6h scheduled reconciliation remains as a fallback safety net.
- **Lead Auto-Assignment:** All lead creation paths trigger `assignLeadRoundRobin()`, which uses routing configurations, pause schedules, and pass-back rules. Leads receive per-lead `setTimeout` timers for auto-pass functionality based on routing configuration `passIntervalMinutes`. The CSR pause system supports three pause sources: `manager` (set by admins via Sales Manager), `self` (CSR-initiated via Pause/Play toggle), and `auto` (triggered by socket disconnect after 30s grace period). Auto and self pauses are cleared on reconnect; manager pauses are never auto-cleared. When all CSRs in the cascade order are paused, routing falls back to the full cascade order. Self-service pause/unpause is available via `GET/POST /api/leads-hub/my-pause` endpoints, with UI toggles in the web Leads Hub header and mobile Lead Queue/Pulse Dashboard screens.
- **Leads Hub:** A comprehensive lead management system with a 5-day outreach sequence lifecycle. It handles lead statuses (e.g., `day_1` through `day_4`, `appt_set`, `dead`), pre-booked leads, and Google Sheets integration. The system includes row re-scanning for updates, a visibility delay for newly imported leads, and confirmation-first flows for pre-booked leads. CSR queues are tabbed (New, Today, Callbacks, Re-engagement, Old Leads, Archive) with structured action logging and lead transfer capabilities. Fuzzy lead search via `pg_trgm` extension (GIN trigram indexes on first_name, last_name, email, phone) with `GET /api/leads/search` endpoint supporting text fuzzy matching, phone digit search, date range filtering (created date vs last touchpoint from call_attempts + podium_messages), funnel filtering, and relevance scoring. Search UI available on both web Pulse page and mobile Queue screen with debounced input and collapsible filter panels.
- **Google Sheets Integration:** Decoupled sheet configurations are stored in `google_sheet_configs`, allowing dynamic funnel routing based on column values and multiple sheets feeding the same funnel. An LLM-powered column mapping feature (Gemini 2.5 Flash) automates field mapping with confidence scores.
- **Lead Source Normalization:** A per-tenant alias mapping system (`lead_source_aliases` table) normalizes raw lead source values to canonical names at ingestion.
- **GTM Attribution with Auto-Adaptive Field Detection:** Enhanced attribution system with: (1) Auto-adaptive field detection service (`field-detection.ts`) using a 3-layer approach — value-pattern regex, field-name heuristics, and page+form-scoped saved rules (`field_mapping_rules` table). (2) Funnel alias normalization (`funnel-normalizer.ts`, `funnel_aliases` table) mapping raw form values to canonical funnel types with cached lookups and HVAC default aliases. (3) Lead ingestion mode switchover (`tenants.lead_ingestion_mode` — `sheets`/`both`/`tracker`) controlling whether tracker creates leads, with phone dedup in dual mode. (4) Attribution events store detection metadata (`detected_mappings` JSONB, `resolved_lead_source`, `resolved_funnel`). (5) GTM snippet generator API. (6) Enhanced Attribution page with filters, resolved source/funnel columns, detection metadata display, ingestion mode switchover panel, and funnel alias management.
- **Login-Aware Speed-to-Lead:** The average speed-to-lead metric considers only the time `client_users` are logged in, tracked via `user_login_sessions` table.
- **Sales Manager Hub:** A rebuilt dashboard with tabs for Dashboard, Team, Scripts, Routing (including "Sticky After Cascade" functionality), Activity Feed, Coaching Insights, and Settings (spiff config, lead source aliases, Google Sheet config).
- **Script Management:** Database-backed management for call, text, email, and voicemail templates with version history. Scripts support filtering by source, stage, and disposition, with smart field placeholders.
- **Media Buying Automation:** A rules-based system for managing marketing campaigns with condition-based alerts and actions.
- **Budget Controls:** Campaign management integrates with budget API calls.
- **Spiff Configuration:** Per-tenant configurable spiff amounts for bookings, with funnel-based overrides.
- **Client Alerts:** Per-tenant configurable alert thresholds with custom email recipients.
- **Sync Failure Alerting & Notifications:** In-app notification system for agency admins. Automatically creates notifications when sync jobs fail (with consecutive failure escalation to "critical" severity after 3+ failures), and when tenant tracker heartbeats go stale (24+ hours). Features: notification bell in admin layout header with unread badge, dropdown with recent alerts, read/dismiss/clear-all actions, notification history view, 15-minute cooldown to prevent duplicate alerts. DB table: `notifications` with tenant scoping, role-based access control (agency/super_admin only).
- **Chat Analytics (Ask Your Data):** AI-powered natural language data querying using Gemini AI, generating structured JSON query plans and streaming OpenUI Lang markup with visualizations.
- **Client Portal:** A dashboard providing clients with KPIs, financial transparency, and chat analytics.
- **Podium Integration:** OAuth2-connected Podium V4 API integration for two-way SMS/call conversation sync. Per-user OAuth credentials stored encrypted in `podiumConfig` on users table. Webhook-driven real-time message ingestion with HMAC signature verification. Conversation history (texts + calls) displayed in lead detail Interaction Timeline with "View in Podium" deep links. Supports contact auto-creation/linking, conversation assignment sync, and multi-user tenant resolution (any connected user's token can serve API requests). Key files: `podium-api.ts`, `podium-auth.ts`, `podium-oauth.ts`, `podium-routes.ts`, webhooks handler, `podium_messages` DB table.
- **Push Notifications:** Three-channel push notification system: Expo Push Service (for Expo React Native tokens), APNs HTTP/2 (for native iOS tokens with `platform: "ios"`), and Web Push via VAPID. APNs uses `@parse/node-apn` with .p8 token-based auth, configured via `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_KEY_PATH` env vars. Gracefully disabled when env vars are missing. Invalid/expired tokens are auto-cleaned from DB for all channels. Key file: `api-server/src/services/push-notifications.ts`.

**System Design Choices:**
- **Modularity:** Monorepo structure with pnpm workspaces for code reuse and separation.
- **Scalability:** Multi-tenancy support for client account management.
- **Demo vs Real Tenant Isolation:** `isDemo` flag for tenants to receive auto-generated dummy data.
- **Data Security:** Sensitive configurations and API credentials are encrypted, with a `sanitizeTenant` function to mask secret fields.
- **Funnel-Aware Tracking:** Global funnel types with tenant associations for tracking and webhook ingestion.

## External Dependencies

- **Google Sheets API:** Integrated via Replit Connectors for lead ingestion.
- **Google Ads API:** Used for campaign performance queries, Offline Conversion Import (OCI), and Enhanced Conversions uploads.
- **Meta Marketing API:** Used for fetching campaign insights and server-side event uploads via Conversions API (CAPI).
- **Podium V4 API:** OAuth2 integration for two-way SMS/call messaging, contact management, and conversation sync. Endpoints: `/v4/contacts`, `/v4/messages`, `/v4/conversations`, `/v4/locations`, `/v4/users`, `/v4/webhooks`.
- **PostgreSQL:** Primary database for the application.
- **Express:** Web framework for the API server.
- **React:** Frontend library for user interfaces.
- **Vite:** Frontend build tool.
- **TailwindCSS:** Utility-first CSS framework.
- **Wouter:** Lightweight React router.
- **TanStack React Query:** Data fetching and caching.
- **Zod:** Schema declaration and validation.
- **Drizzle ORM:** TypeScript ORM for PostgreSQL.
- **Orval:** OpenAPI client code generator.
- **Socket.IO:** For real-time communication.
- **bcryptjs:** For password hashing.
- **express-session & connect-pg-simple:** For session management.

## Pulse Mobile (Expo App)

A native mobile app (`artifacts/mobile`) for sales reps/lead coordinators, mirroring core Pulse web features.

**Architecture:**
- **Framework:** Expo (React Native) with expo-router file-based routing
- **Auth:** Session-based — on native, login endpoint returns signed `sessionToken` in response body (only for mobile user-agents) using HMAC-SHA256 matching express-session's cookie-signature. Token stored in SecureStore (native) or localStorage (web). Passed via `Cookie` header in all API requests and Socket.IO `extraHeaders`.
- **Real-time:** Socket.IO client connected with session cookie auth, path `/api/socket.io`. Both web and mobile apps listen to `new-lead`, `lead-updated`, and `hud-stats` events for seamless cross-platform sync.
- **Push Notifications:** Expo Push API + Web Push (VAPID) — tokens stored in `push_tokens` DB table with `platform` ("expo" or "web") and `subscription` JSONB for web push. Backend fires notifications on `emitNewLead` events via dynamic import of push-notifications service. Web push uses `web-push` npm package with VAPID keys (env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). Service worker at `marketing-os/public/sw.js` handles push display and notification click navigation. Frontend `usePushNotifications` hook manages service worker registration, subscription lifecycle, and permission state. Push endpoint validation enforces HTTPS and allowlists known push service hosts (FCM, Mozilla, Windows, Apple) to prevent SSRF.
- **Branding:** Matches web app exactly — Rebel Red (#F20505) primary, Midnight Sky (#0A0F1F) background, Card (#0B1224), Stratos (#002D5E) secondary, Pulse logo on login/dashboard

**Screens:**
- **Login** (`app/login.tsx`): Email/password auth with Pulse logo and Rebel Red branding
- **Dashboard** (`app/(tabs)/index.tsx`): HUD with date filters (Today/7D/30D/90D), live performance stats (Calls, Booked, Book Rate, Earned, Speed to Lead, New Leads), 10s polling + Socket.IO event refresh, haptic feedback, tenant selector for agency users
- **Lead Queue** (`app/(tabs)/queue.tsx`): Horizontally scrollable tabs (New, Re-engage, Callbacks, Old, Archive) with matching web colors, pull-to-refresh, real-time updates, tenant-scoped data
- **Lead Detail** (`app/lead/[id].tsx`): Tabbed detail view (Actions, Details, Messages, History). Day badges (D1-D4, OLD, APPT, CB, DEAD) with web-matching colors. Contact flags (Text Only, Spanish, DNC). Callback scheduling. Podium chat integration with real-time Socket.IO message sync. Podium conversation assignment (managers assign to any linked team member, CSRs claim for themselves). Form fill display (appointment date/time, address, add-ons).
- **Settings** (`app/(tabs)/settings.tsx`): Account info, password change, Podium connect/disconnect, sign out

**Key Files:**
- `contexts/AuthContext.tsx` — Auth state, SecureStore persistence, session cookie management
- `contexts/SocketContext.tsx` — Socket.IO connection with cookie auth
- `contexts/TenantContext.tsx` — Tenant switching for agency/super_admin users
- `hooks/useApi.ts` — Authenticated API fetch hook
- `hooks/usePushNotifications.ts` — Push notification registration with retry logic
- `components/LeadCard.tsx` — Lead card with day badges, timer countdowns, contact flags matching web app
- `constants/colors.ts` — Dark Pulse theme colors

**Backend Push Infra:**
- `push_tokens` table: `user_id`, `token`, `platform`, unique(user_id, token)
- `POST/DELETE /api/push-tokens` — Registration endpoints
- `api-server/src/services/push-notifications.ts` — Expo Push API service
- `api-server/src/services/callback-scheduler.ts` — Polls every 60s for due callbacks, sends push notification to assigned CSR