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
- **Database:** PostgreSQL is the primary database, interfaced via Drizzle ORM. Database migrations are handled as one-time scripts on server startup. Lazy initialization patterns are used to seed default data for new tenants.
- **Authentication:** Session-based authentication is implemented with `express-session` and a PostgreSQL store, featuring 30-day session durations and `bcryptjs` for password hashing. Role-based access control (`super_admin`, `agency_user`, `client_admin`, `client_user`) is in place. User management includes password changes, user inactivation, and hard deletion with foreign key protection.
- **Real-time Features:** Socket.IO provides real-time lead notifications and other interactive functionalities, ensuring tenant isolation.
- **API Codegen:** OpenAPI specifications with Orval generate TypeScript API clients and Zod schemas for robust API interactions.
- **Monorepo Structure:** The project is organized into `artifacts` for applications and `lib` for shared code.

**Feature Specifications:**
- **Attribution Engine:** Implements a 4-level waterfall attribution model for lead source tracking, including a Reconciliation Engine for OCI payloads and Enhanced Conversions.
- **Lead Auto-Assignment:** All lead creation paths trigger `assignLeadRoundRobin()`, which uses routing configurations, pause schedules, and pass-back rules. Leads receive per-lead `setTimeout` timers for auto-pass functionality based on routing configuration `passIntervalMinutes`.
- **Leads Hub:** A comprehensive lead management system with a 5-day outreach sequence lifecycle. It handles lead statuses (e.g., `day_1` through `day_4`, `appt_set`, `dead`), pre-booked leads, and Google Sheets integration. The system includes row re-scanning for updates, a visibility delay for newly imported leads, and confirmation-first flows for pre-booked leads. CSR queues are tabbed (New, Today, Callbacks, Re-engagement, Old Leads, Archive) with structured action logging and lead transfer capabilities. Fuzzy lead search via `pg_trgm` extension (GIN trigram indexes on first_name, last_name, email, phone) with `GET /api/leads/search` endpoint supporting text fuzzy matching, phone digit search, date range filtering (created date vs last touchpoint from call_attempts + podium_messages), funnel filtering, and relevance scoring. Search UI available on both web Pulse page and mobile Queue screen with debounced input and collapsible filter panels.
- **Google Sheets Integration:** Decoupled sheet configurations are stored in `google_sheet_configs`, allowing dynamic funnel routing based on column values and multiple sheets feeding the same funnel. An LLM-powered column mapping feature (Gemini 2.5 Flash) automates field mapping with confidence scores.
- **Lead Source Normalization:** A per-tenant alias mapping system (`lead_source_aliases` table) normalizes raw lead source values to canonical names at ingestion.
- **Login-Aware Speed-to-Lead:** The average speed-to-lead metric considers only the time `client_users` are logged in, tracked via `user_login_sessions` table.
- **Sales Manager Hub:** A rebuilt dashboard with tabs for Dashboard, Team, Scripts, Routing (including "Sticky After Cascade" functionality), Activity Feed, Coaching Insights, and Settings (spiff config, lead source aliases, Google Sheet config).
- **Script Management:** Database-backed management for call, text, email, and voicemail templates with version history. Scripts support filtering by source, stage, and disposition, with smart field placeholders.
- **Media Buying Automation:** A rules-based system for managing marketing campaigns with condition-based alerts and actions.
- **Budget Controls:** Campaign management integrates with budget API calls.
- **Spiff Configuration:** Per-tenant configurable spiff amounts for bookings, with funnel-based overrides.
- **Client Alerts:** Per-tenant configurable alert thresholds with custom email recipients.
- **Chat Analytics (Ask Your Data):** AI-powered natural language data querying using Gemini AI, generating structured JSON query plans and streaming OpenUI Lang markup with visualizations.
- **Client Portal:** A dashboard providing clients with KPIs, financial transparency, and chat analytics.
- **Podium Integration:** OAuth2-connected Podium V4 API integration for two-way SMS/call conversation sync. Per-user OAuth credentials stored encrypted in `podiumConfig` on users table. Webhook-driven real-time message ingestion with HMAC signature verification. Conversation history (texts + calls) displayed in lead detail Interaction Timeline with "View in Podium" deep links. Supports contact auto-creation/linking, conversation assignment sync, and multi-user tenant resolution (any connected user's token can serve API requests). Key files: `podium-api.ts`, `podium-auth.ts`, `podium-oauth.ts`, `podium-routes.ts`, webhooks handler, `podium_messages` DB table.

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
- **Push Notifications:** Expo Push API — tokens stored in `push_tokens` DB table, backend fires notifications on `emitNewLead` events via dynamic import of push-notifications service
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