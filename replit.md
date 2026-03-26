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
- **Authentication:** Session-based authentication uses `express-session` with a PostgreSQL store and `bcryptjs` for password hashing. Role-based access control (`super_admin`, `agency_user`, `client_admin`, `client_user`) is implemented.
- **Real-time Features:** Socket.IO is integrated for real-time lead notifications and other interactive elements, ensuring tenant isolation.
- **API Codegen:** OpenAPI specifications with Orval generate TypeScript API clients (`api-client-react`) and Zod schemas (`api-zod`).
- **Monorepo Structure:** The project is organized into `artifacts` (applications) and `lib` (shared code).

**Feature Specifications:**
- **Attribution Engine:** A 4-level waterfall attribution model tracks lead sources. It includes a Reconciliation Engine for OCI payloads and Enhanced Conversions.
- **Leads HUD:** A gamified interface for lead management with real-time queues, quick actions, disposition logging, and performance statistics. Features include smart scheduling, historical stats, and comparison cards.
- **Script Management:** Database-backed management for call, text, email, and voicemail templates with version history and CRUD API.
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

- **ServiceTitan:** OAuth2 client for fetching jobs, customers, and locations. Includes a 24-hour data retention compliance mechanism for PII.
- **Google Ads API:** Used for campaign performance queries, Offline Conversion Import (OCI), and Enhanced Conversions uploads, with OAuth2 for authentication.
- **Meta Marketing API:** For fetching campaign insights and server-side event uploads via Conversions API (CAPI), with OAuth2 for authentication.
- **CallRail API:** Webhook ingestion with HMAC-SHA256 signature verification.
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
- **express-session & connect-pg-simple:** For session management.