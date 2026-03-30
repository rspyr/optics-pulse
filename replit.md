# Marketing OS

## Overview

Marketing OS is a full-stack, monorepo platform tailored for HVAC marketing agencies. It provides a comprehensive solution for managing client marketing efforts, emphasizing lead attribution, performance monitoring, and client reporting. Key features include a proprietary Attribution Engine, a multi-tenant administration portal, a client-facing portal ("Searchlight Killer"), and a gamified leads management system. The platform's goal is to streamline agency operations, enhance marketing effectiveness through data-driven insights, and improve client transparency and satisfaction.

## User Preferences

I prefer iterative development with clear communication on significant changes. Please ask before making major architectural decisions or introducing new external dependencies. I also prefer detailed explanations for complex features or logic.

## System Architecture

The Marketing OS is built as a pnpm workspace monorepo using Node.js 24 and TypeScript 5.9.

**UI/UX Decisions:**
The frontend, developed with React, Vite, TailwindCSS v4, Wouter, and TanStack React Query, uses a dark-mode-only design system with a specific brand palette (Midnight Sky, Stratos, Rebel Red, Circuit White, Steel, Ice) and typography (Söhne Extrafett, Söhne Dreiviertelfett, Inter).

**Technical Implementations:**
- **API:** An Express 5 server handles all API requests.
- **Database:** PostgreSQL is used as the primary database, managed with Drizzle ORM. Production seeding is handled by `autoSeedIfEmpty()`, loading tenant data from `src/seed-data.json`. One-time migrations run on server startup via `one-time-migrations.ts`.
- **Authentication:** Session-based authentication uses `express-session` with a PostgreSQL store (30-day session duration) and `bcryptjs` for password hashing. Role-based access control (`super_admin`, `agency_user`, `client_admin`, `client_user`) is implemented. Login page includes a "Remember Me" checkbox that persists credentials to localStorage. All users can change their own password via Settings. Admin users can hard-delete users (with FK constraint protection) or toggle them inactive.
- **Real-time Features:** Socket.IO is integrated for real-time lead notifications and other interactive elements, ensuring tenant isolation.
- **API Codegen:** OpenAPI specifications with Orval generate TypeScript API clients (`api-client-react`) and Zod schemas (`api-zod`).
- **Monorepo Structure:** The project is organized into `artifacts` (applications) and `lib` (shared code).

**Feature Specifications:**
- **Attribution Engine:** A 4-level waterfall attribution model tracks lead sources. It includes a Reconciliation Engine for OCI payloads and Enhanced Conversions.
- **Leads Hub:** A comprehensive lead management system with a 5-day outreach sequence lifecycle. Leads flow through statuses: day_1 through day_4 (active), day_5_old (re-engagement pool), appt_set (booked), appt_booked (pre-booked appointment, purple badge), call_back (scheduled follow-up), and dead (removed). Pre-booked leads (`preBooked=true`) arrive via Google Sheets with "Appointment Booked" = "yes" and enter the `appt_booked` status directly. CSRs see a confirmation-first flow (Confirmed → appt_set, Rescheduled → stays appt_booked, Canceled → dead with free-form reason). Pre-booked leads are excluded from spiff/commission calculations, HUD booking stats, booking rate, and avg speed-to-lead. Sales Manager dashboard has an "Include Pre-Booked" toggle (defaults OFF) for stats. Features tabbed CSR queues (New, Today, Callbacks, Re-engagement, Old Leads, Archive), structured action logging (call/text/voicemail_drop with full outcome taxonomy), round-robin routing with cascade ordering and CSR pause/schedule, and lead transfer. Google Sheets integration provides lead ingestion per-funnel via `google_sheet_id` and `google_sheet_tab` fields on `tenant_funnel_types`. **LLM-Powered Column Mapping:** Agency users can run AI analysis (Gemini 2.0 Flash) to auto-map sheet columns to internal fields (firstName, lastName, phone, email, source, serviceType, etc.) with confidence scores. The mapping is stored in `column_mapping` (JSONB) and `mapping_headers` (JSONB) on `tenant_funnel_types`. Agency users review/adjust mappings in Settings tab and approve. Import uses approved mappings; header drift detection blocks imports with 409 until re-approved. `__skip__` sentinel skips columns; `fullName` auto-splits to first/last.
- **Sales Manager Hub:** Rebuilt dashboard with 7 tabs: Dashboard (stats with date range + funnel filter, by-source and by-funnel breakdowns), Team (per-CSR stats: calls/VMs/texts/appts/rate with collapsible funnel breakdown), Scripts (funnel/service type filtering + smart fields), Routing (round-robin cascade order per funnel, pass interval, pass-back toggle, sticky-after-cascade toggle with designated CSR selector, CSR pause/schedule), Activity Feed, Coaching Insights, and Settings (spiff config, Google Sheet config per funnel, native-only comms). Podium/CallRail/ServiceTitan options removed from UI. **Sticky After Cascade:** When Allow Pass-Back is enabled, a "Sticky After Cascade" toggle lets managers designate a specific CSR that leads are assigned to after completing one full cycle through the cascade. The lead's `cascade_pass_count` tracks auto-passes; once it reaches `activeOrder.length - 1`, the lead is transferred to the designated `sticky_csr_id`. Count resets on manual transfer or round-robin reassignment. Server-side validation requires a valid `sticky_csr_id` when `sticky_after_cascade` is enabled. Leads already at their sticky CSR get their timestamp refreshed to prevent repeated cron re-evaluation.
- **Script Management:** Database-backed management for call, text, email, and voicemail templates with version history and CRUD API. Scripts support `sourceFilter`, `stageFilter`, `dispositionFilter` for targeted matching, plus text-based funnel and service type filtering. Smart field placeholders use `{{lead_name}}`, `{{csr_name}}`, `{{service_type}}`, `{{funnel}}`, `{{company}}` format with live preview. Disposition-based scripts (callback_requested, already_had_estimate, dont_remember, never_answered) override source/stage matching in the Pulse queue.
- **Media Buying Automation:** Rules-based system for managing marketing campaigns, including condition-based alerts and actions.
- **Budget Controls:** Campaign management integrated with budget API calls.
- **Spiff Configuration:** Per-tenant configurable spiff amounts for bookings, overriding values for specific lead types.
- **Client Alerts:** Per-tenant configurable alert thresholds with custom email recipients.
- **Chat Analytics (Ask Your Data):** AI-powered natural language data querying using Gemini AI. It generates structured JSON query plans, executes safe Drizzle ORM queries, and presents streaming OpenUI Lang markup with visualizations.
- **Client Portal:** A dashboard providing clients with KPIs, financial transparency, and chat analytics.

**System Design Choices:**
- **Modularity:** Monorepo structure with pnpm workspaces promotes code reuse and separation of concerns.
- **Scalability:** Multi-tenancy support for managing multiple client accounts.
- **Demo vs Real Tenant Isolation:** Tenants are flagged as `isDemo` to receive auto-generated dummy data, while real tenants receive zero dummy data.
- **Data Security:** Sensitive configurations and API credentials are encrypted. A `sanitizeTenant` function masks secret fields.
- **Funnel-Aware Tracking:** Global funnel types with tenant association via `tenant_funnel_types` for tracking and webhook ingestion.

## External Dependencies

- **Google Sheets API:** Lead ingestion from Google Sheets via Replit Connectors integration (`googleapis` package). Each funnel can have its own Google Sheet ID + tab name configured per tenant.
- **ServiceTitan:** PAUSED — OAuth2 client code preserved but sync disabled and data wiped for compliance.
- **Google Ads API:** Used for campaign performance queries, Offline Conversion Import (OCI), and Enhanced Conversions uploads, with OAuth2 for authentication.
- **Meta Marketing API:** For fetching campaign insights and server-side event uploads via Conversions API (CAPI), with OAuth2 for authentication.
- **CallRail API:** PAUSED — Webhook ingestion code preserved but communication integration disabled.
- **Podium API:** PAUSED — Review sync and communication integration disabled.
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
- **express-session & connect-pg-simple:** For session management.