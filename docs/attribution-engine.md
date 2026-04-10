# Attribution Engine

The attribution engine is the core system that connects marketing spend to actual revenue by linking ad clicks, calls, and form fills to completed jobs in ServiceTitan.

---

## Table of Contents

- [Overview](#overview)
- [Data Flow](#data-flow)
- [Integration Sync Pipeline](#integration-sync-pipeline)
  - [ServiceTitan](#servicetitan)
  - [Google Ads](#google-ads)
  - [Meta (Facebook/Instagram)](#meta-facebookinstagram)
- [Attribution Events](#attribution-events)
  - [Event Sources](#event-sources)
  - [Event Types](#event-types)
  - [Ingestion Endpoints](#ingestion-endpoints)
  - [Universal Form Attribution Script](#universal-form-attribution-script-trackerjs)
- [Auto-Adaptive Field Detection](#auto-adaptive-field-detection)
  - [Three-Layer Detection](#three-layer-detection)
  - [Field Mapping Rules](#field-mapping-rules)
- [Funnel Normalization](#funnel-normalization)
  - [Funnel Fallback Chain](#funnel-fallback-chain)
  - [Funnel Aliases](#funnel-aliases)
- [Lead Ingestion Mode](#lead-ingestion-mode)
  - [Mode Definitions](#mode-definitions)
  - [Mode Switchover](#mode-switchover)
  - [Dual-Mode Deduplication](#dual-mode-deduplication)
  - [Audit Log](#audit-log)
  - [GTM Snippet Generation](#gtm-snippet-generation)
- [Reconciliation Engine](#reconciliation-engine)
  - [Match Levels](#match-levels)
  - [Matching Pipeline](#matching-pipeline)
  - [External Conversion Sync](#external-conversion-sync)
- [Data Privacy & PII Purge](#data-privacy--pii-purge)
- [Integration Status Monitoring](#integration-status-monitoring)
  - [Integration States](#integration-states)
  - [Sync Type Breakdown](#sync-type-breakdown)
- [Attribution Page UI](#attribution-page-ui)
  - [Filters](#filters)
  - [Inline Corrections](#inline-corrections)
  - [System Health Panel](#system-health-panel)
- [Key Files](#key-files)

---

## Overview

The attribution engine answers the fundamental question for HVAC agencies: **"Which marketing dollars produced which revenue?"**

It does this by:

1. **Ingesting** marketing touchpoints (clicks, calls, form fills) as attribution events
2. **Detecting** PII and form structure automatically using adaptive field detection
3. **Normalizing** lead sources and funnels via alias resolution
4. **Syncing** completed jobs and invoices from ServiceTitan
5. **Matching** attribution events to jobs using a confidence-tiered waterfall
6. **Reporting** attributed revenue back to the ad platforms and the agency dashboard

---

## Data Flow

```
  Client Website                        Server-Side Sources
  ─────────────                         ───────────────────
  Ad Click / Form Fill                  Inbound Call / CRM Webhook
        │                                       │
        ▼                                       ▼
  tracker.js (IIFE)                     /webhooks/ingest
  captures UTM, click IDs,             receives CallRail, GHL,
  cookies, intercepts form             Podium payloads
        │                                       │
        ▼                                       ▼
  POST /api/tracker/submit ──────────────────────┘
        │
        ▼
  Auto-Adaptive Field Detection
  (3-layer: saved rules → value patterns → field name heuristics)
        │
        ▼
  Funnel Normalization
  (custom.funnel → alias lookup → URL-path alias → tenant default)
        │
        ▼
  Attribution Event Created
  (UTM params, click IDs, form fields JSONB, hashed PII,
   detectedMappings, resolvedLeadSource, resolvedFunnel)
        │
        ├──▶ Lead Created (if ingestion mode allows)
        │    + Round-Robin CSR Assignment
        │    + createdLeadId stamped on event
        │
        ▼
  Sheet Sync (Google Sheets lead ingestion)
  ├── Mode: sheets → leads from sheets only, tracker creates events only
  ├── Mode: both   → both create leads (48h dedup on phone+email)
  └── Mode: tracker → sheet sync paused, tracker creates all leads
        │
        ▼
  ServiceTitan Job Synced (every 15 min)
        │
        ▼
  Reconciliation Engine (matches jobs ↔ attribution events)
        │
        ├──▶ Dashboard (revenue attribution, ROAS, CPL)
        ├──▶ Google Ads (offline conversion upload)
        ├──▶ Meta (CAPI event upload)
        └──▶ ServiceTitan (GCLID writeback to custom field)
```

---

## Integration Sync Pipeline

The sync pipeline runs on scheduled intervals, pulling data from external platforms into the local database. Each sync run is logged in the `integration_sync_logs` table with its type, status, and record count.

### ServiceTitan

| Sync Type | Interval | Description |
|:----------|:---------|:------------|
| `jobs` | 15 minutes | Fetches completed jobs, enriches customer contacts and addresses, then triggers lead matching and reconciliation |
| `invoices` | 60 minutes | Fetches recent invoices, aggregates revenue/rebates/balance, updates corresponding job records |

After jobs sync, the pipeline automatically:
- **Enriches** customer contacts (phone, email) and service addresses via separate ST API calls
- **Matches** jobs to leads using phone/email/address
- **Runs reconciliation** to link jobs to attribution events

### Google Ads

| Sync Type | Interval | Description |
|:----------|:---------|:------------|
| `campaigns` | 60 minutes | Fetches campaign metadata and daily performance stats (spend, impressions, clicks, conversions) for the last 90 days |

### Meta (Facebook/Instagram)

| Sync Type | Interval | Description |
|:----------|:---------|:------------|
| `campaigns` | 60 minutes | Fetches campaign insights (spend, clicks, impressions) similar to Google Ads |

---

## Attribution Events

Attribution events represent a marketing touchpoint — the moment a potential customer interacted with an ad or campaign.

### Event Sources

| Source | Method | Data Captured |
|:-------|:-------|:-------------|
| **Tracker Script** | IIFE on client website (`tracker.js`) | All UTM params (source, medium, campaign, term, content), click IDs (GCLID, FBCLID, MSCLKID, TTCLID, li_fat_id, wbraid), landing page, referrer, form fields |
| CallRail | API sync | Caller phone number (hashed), call duration, tracking number |
| GHL (GoHighLevel) | Webhook | Form fields, hashed email/phone |
| Podium | Webhook | SMS/call conversations, contact data |

### Event Types

- **click** — Ad click captured by the tracker script (carries GCLID or FBCLID)
- **call** — Inbound phone call tracked via CallRail
- **form_fill** — Form submission captured via tracker script or GHL webhook

### Ingestion Endpoints

Events enter the system via two endpoints:

| Endpoint | Purpose | Auth |
|:---------|:--------|:-----|
| `POST /api/tracker/submit` | Client-side tracker script submissions (forms with attribution) | Open CORS (public, keyed by `client_id` slug) |
| `POST /webhooks/ingest` | Server-side webhooks from CallRail, GHL, Podium | Replit-domain CORS only |

### Universal Form Attribution Script (`tracker.js`)

The tracker script is a self-contained IIFE served from `/tracker.js` on the API server. It replaces the earlier passive hidden-field injector with an active script that intercepts form submissions directly. It is embedded on each client's website via a single `<script>` tag:

```html
<script src="https://{api-domain}/tracker.js" data-client-id="acme-hvac" defer></script>
```

**Capabilities:**

| Feature | Details |
|:--------|:--------|
| **UTM Capture** | `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` from URL params |
| **Click ID Capture** | `gclid`, `fbclid`, `msclkid`, `ttclid`, `li_fat_id`, `wbraid` |
| **Cookie Persistence** | Last-touch attribution cookie (`_attr_data`, 30-day TTL) + first-touch landing page cookie (`_attr_lp`) |
| **Form Interception** | Native HTML forms (`submit` event), HubSpot (`postMessage onFormSubmitted`), Gravity Forms (`gform_confirmation_loaded`), WPForms (`wpformsAjaxSubmitSuccess`), Typeform (`postMessage form-submit`) |
| **jQuery Compatibility** | Deferred jQuery detection (polls up to 10s) then binds `$(document).on(...)` for Gravity/WPForms events that are jQuery-triggered rather than native DOM events |
| **Dynamic Forms** | `MutationObserver` with `WeakSet` dedup auto-binds forms injected after page load |
| **Submission Dedup** | 3-second sliding window dedup keyed on `type|id|name` prevents double POSTs when both native submit and plugin success hooks fire for the same form |
| **Delivery** | `fetch` with `keepalive` + 2 retries (1.5s delay) → `navigator.sendBeacon` fallback (with `Blob` content-type) → `localStorage` queue (cap 10) flushed on next page load |
| **Sensitive Field Filtering** | Automatically excludes `password`, `credit_card`, `cvv`, `ssn`, and similar fields; skips `hidden` and `password` input types |
| **Heartbeat** | POST to `/api/tracker/heartbeat` every 6 hours for script health monitoring; accepts both `clientId` (slug) and legacy numeric `tenantId` |

**Script Attributes:**

| Attribute | Required | Description |
|:----------|:---------|:------------|
| `data-client-id` | Yes | Tenant's `clientSlug` (e.g., `acme-hvac`) — auto-generated from tenant name, unique per tenant |
| `data-endpoint` | No | Override submit URL (defaults to same origin `/api/tracker/submit`) |
| `data-cookie-domain` | No | Cookie domain for cross-subdomain tracking |
| `data-exclude-fields` | No | JSON array of field names to exclude from capture |
| `data-capture-fields` | No | JSON array of field names to exclusively capture (allowlist mode) |
| `data-custom` | No | JSON object of custom dimensions sent with every submission |
| `data-funnel` | No | Funnel slug for lead routing — maps to a tenant's configured funnel type |
| `data-tenant` | No | Legacy numeric tenant ID (backward compat for heartbeat) |

**Payload Structure:**

Each submission POSTs this JSON to `/api/tracker/submit`:

```json
{
  "client_id": "acme-hvac",
  "submitted_at": "2026-04-08T19:00:00.000Z",
  "page_url": "https://acmehvac.com/contact",
  "landing_page": "https://acmehvac.com/?utm_source=google&gclid=abc123",
  "referrer": "https://google.com",
  "attribution": {
    "utm_source": "google",
    "utm_medium": "cpc",
    "utm_campaign": "spring-ac",
    "utm_term": "ac repair",
    "utm_content": null,
    "gclid": "abc123",
    "fbclid": null,
    "msclkid": null,
    "ttclid": null,
    "li_fat_id": null,
    "wbraid": null
  },
  "form": {
    "id": "contact-form",
    "name": "Contact Us",
    "type": "native",
    "action": "https://acmehvac.com/submit"
  },
  "fields": {
    "first_name": "Jane",
    "last_name": "Doe",
    "email": "jane@example.com",
    "phone": "555-123-4567",
    "service_needed": "AC Repair"
  },
  "custom": {
    "funnel": "hvac-residential"
  }
}
```

**Backend Processing (`/api/tracker/submit`):**

1. Resolves `client_id` string slug → tenant via `clientSlug` column (unique, not null)
2. Runs **auto-adaptive field detection** on form fields (see below)
3. Runs **funnel normalization** to resolve the canonical funnel (see below)
4. Creates an `attribution_event` with all UTM params, click IDs, referrer, page URL, form metadata, form fields (JSONB), `detectedMappings`, `resolvedLeadSource`, and `resolvedFunnel`
5. Pre-assigns match level: Diamond if GCLID present, Golden if phone detected, Silver if email detected
6. Hashes phone/email (SHA-256) for reconciliation matching
7. Checks **ingestion mode** — if `sheets`, stops here (event-only); if `both` or `tracker`, continues to lead creation
8. In `both` mode: runs **48-hour dedup** against existing leads (phone then email) to avoid duplicates with sheet sync
9. If PII is found and not deduplicated: creates a lead with round-robin CSR assignment, stamps `createdLeadId` on the attribution event, triggers auto-pass timer, and emits real-time Socket.IO notification

**Tenant Identification (`clientSlug`):**

Each tenant has a unique `clientSlug` stored on the tenants table. It is:
- Auto-generated from the tenant name when a tenant is created (e.g., "Acme HVAC" → `acme-hvac`)
- Collision-safe: if a slug already exists, a numeric suffix is appended (`acme-hvac-2`)
- Seeded for existing tenants via a one-time migration
- Enforced as NOT NULL with a unique index

---

## Auto-Adaptive Field Detection

The field detection service (`field-detection.ts`) automatically identifies what each form field represents (email, phone, name, address, etc.) without requiring manual mapping. This is critical because every HVAC client's website uses different form builders with different field naming conventions.

### Three-Layer Detection

Detection runs in priority order — the first match wins:

| Layer | Source | Description |
|:------|:-------|:------------|
| **1. Saved Rules** | `field_mapping_rules` table | Admin-configured rules keyed on `(tenant_id, page_url_pattern, form_identifier, field_name)`. Supports `"*"` wildcard for form identifier to apply rules across all forms on a page. |
| **2. Value Patterns** | Regex analysis | Examines the field's actual value to detect email addresses (`@` + domain), phone numbers (digit patterns), and full names (two+ capitalized words). |
| **3. Field Name Heuristics** | Keyword matching | Matches the field name/key against known patterns: `email`, `phone`, `tel`, `first_name`, `fname`, `last_name`, `lname`, `name`, `zip`, `postal`, `city`, `state`, `street`, `address`, `appointment`, `date`, `time`, etc. |

The detection output includes:
- **`fields`**: Array of `{ fieldName, value, mapsTo }` — each form field with its detected semantic meaning (e.g., `mapsTo: "email"`)
- **`pii`**: Extracted PII object (`firstName`, `lastName`, `email`, `phone`, `fullName`)
- **`addressParts`**: Extracted address components (`street`, `city`, `state`, `zip`)

The `detectedMappings` are persisted on the attribution event as JSONB for audit and correction.

### Field Mapping Rules

Rules are stored in the `field_mapping_rules` table:

| Column | Type | Description |
|:-------|:-----|:------------|
| `tenant_id` | integer | Tenant this rule belongs to |
| `page_url_pattern` | text | URL pattern to match (exact or wildcard) |
| `form_identifier` | text | Form ID or name; `"*"` matches all forms on the page |
| `field_name` | text | The form field name/key to map |
| `maps_to` | text | Semantic target (`email`, `phone`, `firstName`, `lastName`, `fullName`, `appointmentDate`, etc.) |

Rules are managed via:
- `GET /api/field-mapping-rules` — list rules for a tenant
- `POST /api/field-mapping-rules` — create a rule
- `DELETE /api/field-mapping-rules/:id` — delete a rule
- **Inline correction** from the Attribution page (creates rules from event context)

The rule cache is loaded on first use per tenant and invalidated on rule changes.

---

## Funnel Normalization

The funnel normalizer service (`funnel-normalizer.ts`) resolves incoming funnel identifiers to canonical funnel types. This is necessary because funnel information arrives in many forms: a `data-funnel` attribute on the script tag, a `custom.funnel` field in the payload, a URL path segment, or sometimes not at all.

### Funnel Fallback Chain

Resolution follows this priority:

1. **`custom.funnel`** — Explicit funnel slug sent in the payload's custom data
2. **Alias lookup** — The raw funnel string is checked against `funnel_aliases` for this tenant
3. **URL-path alias** — The page URL's path is checked against funnel aliases (e.g., `/fit-funnel/contact` → `fit-funnel`)
4. **Tenant default** — Falls back to the tenant's first assigned funnel type (deterministic ordering by funnel type ID)

The output includes:
- `resolvedFunnel`: The canonical funnel name (stored on the attribution event)
- `resolvedFunnelId`: The funnel type ID (used for lead creation)
- `resolvedLeadType`: The lead type derived from the funnel slug

### Funnel Aliases

Aliases are stored in the `funnel_aliases` table and map alternate names to canonical funnel types:

| Column | Type | Description |
|:-------|:-----|:------------|
| `tenant_id` | integer | Tenant this alias belongs to |
| `funnel_type_id` | integer | The canonical funnel type this alias maps to |
| `alias` | text | The alternate name (e.g., `fb-funnel`, `google-landing`) |

Aliases are managed via:
- `GET /api/funnel-aliases` — list all aliases grouped by funnel type
- `POST /api/funnel-aliases` — create an alias (requires `funnelTypeId` + `alias`)
- `DELETE /api/funnel-aliases/:id` — delete an alias
- `POST /api/funnel-aliases/bulk` — bulk create aliases
- `POST /api/funnel-aliases/load-defaults` — seed default aliases for a tenant
- **Inline correction** from the Attribution page (creates aliases from event context)

The alias cache is tenant-scoped and invalidated on changes.

---

## Lead Ingestion Mode

Each tenant has a `leadIngestionMode` setting (`sheets`, `both`, or `tracker`) that controls how leads enter the system. This enables a gradual migration from Google Sheet-based lead ingestion to fully automated tracker-based ingestion.

### Mode Definitions

| Mode | Tracker Behavior | Sheet Sync Behavior |
|:-----|:----------------|:-------------------|
| **`sheets`** (default) | Creates attribution events only, no leads | Active — creates leads from sheet rows |
| **`both`** | Creates attribution events AND leads (with dedup) | Active — creates leads from sheet rows |
| **`tracker`** | Creates attribution events AND leads | Paused — `syncPaused` set to `true` on all sheet configs |

### Mode Switchover

Mode changes are:
- Restricted to `super_admin` and `agency_user` roles only
- Executed atomically in a single database transaction (mode update + sheet pause toggle + audit log insert)
- Protected by a tenant existence check (returns 404 for invalid tenants)
- Protected by a DB-level check constraint enforcing valid values (`sheets`, `both`, `tracker`)

When switching **to `tracker`**: all Google Sheet configs for the tenant are paused.
When switching **from `tracker` to `sheets` or `both`**: all Google Sheet configs are unpaused.

### Dual-Mode Deduplication

In `both` mode, the tracker checks for existing leads before creating a new one to avoid duplicates with sheet sync:

1. Fetches all leads for the tenant created within the last **48 hours**
2. Normalizes the incoming phone number (strips formatting) and checks for a match
3. If no phone match, normalizes the incoming email and checks for a match
4. If a duplicate is found, the attribution event is created but no new lead is generated

### Audit Log

All ingestion mode changes are recorded in the `ingestion_audit_log` table:

| Column | Type | Description |
|:-------|:-----|:------------|
| `tenant_id` | integer | Tenant whose mode changed |
| `previous_mode` | text | Mode before the change |
| `new_mode` | text | Mode after the change |
| `changed_by` | text | User ID or role of the actor |
| `changed_at` | timestamptz | When the change occurred |

### GTM Snippet Generation

The API provides a GTM-ready tracking snippet via `GET /api/ingestion-mode/gtm-snippet`. It returns a `<script>` tag with an absolute URL pointing to `tracker.js` and the tenant's `clientSlug` as `data-client-id`. The endpoint fails closed — if `API_BASE_URL` is not configured, it returns an error rather than generating a broken snippet.

---

## Reconciliation Engine

The reconciliation engine is the core matching process that links marketing attribution events to revenue-generating jobs. It runs automatically after every ServiceTitan jobs sync.

### Match Levels

The engine uses a five-tier confidence waterfall. Each level represents a different strength of evidence linking a marketing touchpoint to a completed job.

| Level | Confidence | Matching Criteria |
|:------|:-----------|:-----------------|
| **Diamond** | 1.0 | Direct GCLID match — the job's lead has a Google Click ID that matches an attribution event |
| **Golden** | 0.9 | Hashed phone match — the lead's phone number (SHA-256) matches an attribution event's hashed phone |
| **Silver** | 0.8 | Hashed email match — the lead's email (SHA-256) matches an attribution event's hashed email |
| **Bronze** | 0.6 | Address match — the job's service address (normalized) matches the billing address on an attribution event |
| **Unmatched** | 0.0 | No match found after all tiers are attempted |

### Matching Pipeline

For each completed job with revenue > 0 that is currently unmatched:

1. **Diamond**: Check if the job already has a `matchedGclid` (assigned at lead creation) or if a linked lead has a GCLID matching an attribution event
2. **Golden**: Hash the lead's phone number and search for a matching attribution event
3. **Silver**: Hash the lead's email and search for a matching attribution event
4. **Bronze**: Normalize the job's service address and compare against attribution event billing addresses
5. **Unmatched**: If no match is found at any tier, the job remains unmatched

When a match is found, both the job and the attribution event are updated with the match level and linked GCLID.

### External Conversion Sync

After matching, the engine pushes conversion data back to the ad platforms:

| Destination | Sync Type | What Gets Sent |
|:------------|:----------|:---------------|
| Google Ads | `oci_upload` | Offline conversions for GCLID-matched jobs (Diamond tier) |
| Google Ads | `enhanced_conversions` | Enhanced conversions using hashed PII for non-GCLID matches (Golden/Silver) |
| Meta | `capi_upload` | Conversions API events for Meta-attributed jobs |
| ServiceTitan | `attribution_writeback` | Patches the `Attribution_GCLID` custom field on the job record |

---

## Data Privacy & PII Purge

ServiceTitan data often contains personally identifiable information (PII). The platform implements a data retention policy via the `st-data-purge` service.

**How it works:**

- Runs every 60 minutes
- Identifies jobs where `stDataExpiresAt` has passed (default: 24 hours after sync)
- **Redacts**: Sets `customerName`, `customerPhone`, `customerEmail`, `serviceAddress`, and raw `stJobId` to null
- **Preserves**: Retains the hashed job ID (`stJobIdHash`) and non-PII data (revenue, status, job type) for long-term reporting

This ensures the platform can report on revenue attribution without retaining sensitive customer data beyond the matching window.

The purge process logs its activity as `st_data_purge` sync type entries. These are separated from regular sync activity in the status UI to avoid confusion with failed syncs.

---

## Integration Status Monitoring

The internal admin dashboard provides real-time visibility into integration health via the `/integrations/sync-status` endpoint.

### Integration States

Each integration displays one of six states with clear visual indicators:

| State | Indicator | Meaning |
|:------|:----------|:--------|
| **Syncing** | Blue spinner | A data sync is currently in progress |
| **Paused** | Amber clock | Integration syncing is temporarily disabled (e.g., during migration or maintenance) |
| **Healthy** | Green check | Last sync completed successfully |
| **Error** | Red X | Last sync failed — check error details |
| **No Credentials** | Amber warning | Tenant has not configured API keys for this integration |
| **Never Synced** | Gray text | No sync has ever been attempted for this integration |

State precedence (highest to lowest): Running > Paused > No Credentials > Error > Healthy > Never

### Sync Type Breakdown

Each integration card displays a per-sync-type breakdown showing:

- **Status dot** (green/red/amber) for the most recent run of each type
- **Record count** from the last sync
- **Last run date** for operational visibility

Maintenance activities (PII purge, conversion uploads, attribution writebacks) are displayed separately from primary data syncs to keep the status view focused on data freshness.

---

## Attribution Page UI

The Attribution page (`attribution.tsx`) provides a full operational view of all attribution events with filtering, inline correction, and system health monitoring.

### Filters

| Filter | Options |
|:-------|:--------|
| Event Type | click, call, form_fill |
| Match Level | diamond, golden, silver, bronze, unmatched |
| Source | All detected/resolved sources |
| Funnel | All resolved funnels |
| Date Range | Last 24 hours, 7 days, 30 days |
| Text Search | Searches across source, funnel, page URL, form fields |

### Event Table Columns

| Column | Description |
|:-------|:------------|
| Time | Event creation timestamp |
| Type | Event type (click/call/form fill) |
| Source | Resolved lead source (from UTM or detection) |
| Funnel | Resolved funnel name |
| Page | Page URL path where the event occurred |
| Match | Match level badge (diamond/golden/silver/bronze/unmatched) |
| Lead | Shows "created" badge when a lead was generated from this event (`createdLeadId`) |
| Status | Detection status (detected count / matched / unresolved) |

### Inline Corrections

From the event detail panel, users can create corrections that feed back into detection:

- **Source/Funnel Correction**: Creates a `lead_source_alias` or `funnel_alias` from the event's raw values, so future events with the same raw source/funnel are automatically resolved
- **Field Mapping Correction**: Creates a `field_mapping_rule` for the event's page URL and form, so future submissions from the same form are correctly detected

### System Health Panel

The Attribution page includes a system health panel showing:
- Tracker heartbeat status per tenant (last seen, domain, healthy/inactive)
- Total attribution event count
- Google Sheet config count and sync status

---

## Key Files

| File | Purpose |
|:-----|:--------|
| `artifacts/api-server/public/tracker.js` | Client-side universal form attribution IIFE script |
| `artifacts/api-server/src/routes/tracker.ts` | `/api/tracker/submit` endpoint — processes form submissions with adaptive detection, funnel normalization, and ingestion-mode-aware lead creation |
| `artifacts/api-server/src/services/field-detection.ts` | Auto-adaptive field detection service (3-layer: saved rules → value patterns → heuristics) |
| `artifacts/api-server/src/services/funnel-normalizer.ts` | Funnel normalization service with alias resolution and caching |
| `artifacts/api-server/src/routes/funnel-aliases.ts` | CRUD routes for funnel alias management |
| `artifacts/api-server/src/routes/field-mapping-rules.ts` | CRUD routes for field mapping rule management |
| `artifacts/api-server/src/routes/ingestion-mode.ts` | Ingestion mode GET/PUT, system health status, GTM snippet generation |
| `artifacts/api-server/src/routes/sheet-configs.ts` | Google Sheet config management (sync paused by ingestion mode) |
| `artifacts/api-server/src/services/reconciliation.ts` | Core matching engine — waterfall logic, external conversion push |
| `artifacts/api-server/src/services/sync-scheduler.ts` | Scheduled sync orchestration for all integrations |
| `artifacts/api-server/src/services/st-data-purge.ts` | PII redaction worker for ServiceTitan data |
| `artifacts/api-server/src/services/integrations/service-titan.ts` | ServiceTitan API client |
| `artifacts/api-server/src/routes/integrations.ts` | Sync status endpoint and manual sync triggers |
| `artifacts/api-server/src/routes/webhooks.ts` | Attribution event ingestion via webhooks (CallRail, GHL, Podium) |
| `artifacts/api-server/src/routes/attribution.ts` | Attribution event listing API |
| `artifacts/marketing-os/src/pages/internal.tsx` | Admin dashboard with integration status UI |
| `artifacts/marketing-os/src/pages/attribution.tsx` | Attribution log viewer with filters, inline corrections, system health, and ingestion mode controls |
| `artifacts/marketing-os/src/pages/settings.tsx` | Tenant settings — includes ingestion mode switching, GTM snippet, and funnel alias management |
| `artifacts/marketing-os/src/pages/admin-funnels.tsx` | Admin funnel management — includes GTM Tracking tab with per-tenant ingestion mode, snippet generation, and funnel alias CRUD |
| `lib/db/src/schema/attribution-events.ts` | Attribution events table schema (includes formFields JSONB, detectedMappings, resolvedLeadSource, resolvedFunnel, createdLeadId) |
| `lib/db/src/schema/funnel-aliases.ts` | Funnel aliases table schema |
| `lib/db/src/schema/field-mapping-rules.ts` | Field mapping rules table schema |
| `lib/db/src/schema/ingestion-audit-log.ts` | Ingestion mode change audit log schema |
| `lib/db/src/schema/tenants.ts` | Tenants table schema (includes `clientSlug`, `leadIngestionMode` with check constraint) |
| `lib/db/src/schema/jobs.ts` | Jobs table schema (match level, GCLID fields) |
| `lib/db/src/schema/integration-sync-logs.ts` | Sync log table schema |
