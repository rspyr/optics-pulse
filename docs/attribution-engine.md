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
- [Reconciliation Engine](#reconciliation-engine)
  - [Match Levels](#match-levels)
  - [Matching Pipeline](#matching-pipeline)
  - [External Conversion Sync](#external-conversion-sync)
- [Data Privacy & PII Purge](#data-privacy--pii-purge)
- [Integration Status Monitoring](#integration-status-monitoring)
  - [Integration States](#integration-states)
  - [Sync Type Breakdown](#sync-type-breakdown)
- [Key Files](#key-files)

---

## Overview

The attribution engine answers the fundamental question for HVAC agencies: **"Which marketing dollars produced which revenue?"**

It does this by:

1. **Ingesting** marketing touchpoints (clicks, calls, form fills) as attribution events
2. **Syncing** completed jobs and invoices from ServiceTitan
3. **Matching** attribution events to jobs using a confidence-tiered waterfall
4. **Reporting** attributed revenue back to the ad platforms and the agency dashboard

---

## Data Flow

```
Ad Click / Call / Form Fill
        │
        ▼
  Attribution Event (webhook ingestion)
        │
        ▼
  Lead Created (with GCLID, UTM params, hashed PII)
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

The tracker script is a self-contained IIFE served from `/tracker.js` on the API server. It is embedded on each client's website via a single `<script>` tag:

```html
<script src="https://{api-domain}/tracker.js" data-client-id="acme-hvac" defer></script>
```

**Capabilities:**

| Feature | Details |
|:--------|:--------|
| **UTM Capture** | `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` from URL params |
| **Click ID Capture** | `gclid`, `fbclid`, `msclkid`, `ttclid`, `li_fat_id`, `wbraid` |
| **Cookie Persistence** | Last-touch attribution cookie (`_attr_data`, 30-day TTL) + first-touch landing page cookie (`_attr_lp`) |
| **Form Interception** | Native HTML forms (`submit` event), HubSpot (`postMessage`), Gravity Forms (`gform_confirmation_loaded`), WPForms (`wpformsAjaxSubmitSuccess`), Typeform (`postMessage`) |
| **Dynamic Forms** | `MutationObserver` with `WeakSet` dedup auto-binds forms injected after page load |
| **Delivery** | `fetch` with `keepalive` + 2 retries (1.5s delay); `navigator.sendBeacon` fallback; `localStorage` queue (cap 10) with flush on next page load |
| **Heartbeat** | POST to `/api/tracker/heartbeat` every 6 hours for script health monitoring |

**Script Attributes:**

| Attribute | Required | Description |
|:----------|:---------|:------------|
| `data-client-id` | Yes | Tenant's `clientSlug` (e.g., `acme-hvac`) |
| `data-endpoint` | No | Override submit URL (defaults to same origin `/api/tracker/submit`) |
| `data-cookie-domain` | No | Cookie domain for cross-subdomain tracking |
| `data-exclude-fields` | No | JSON array of field names to exclude from capture |
| `data-capture-fields` | No | JSON array of field names to exclusively capture (allowlist mode) |
| `data-custom` | No | JSON object of custom dimensions sent with every submission |
| `data-funnel` | No | Funnel slug for routing |
| `data-tenant` | No | Legacy numeric tenant ID (backward compat for heartbeat) |

**Backend Processing (`/api/tracker/submit`):**

1. Resolves `client_id` string slug → tenant via `clientSlug` column
2. Creates an `attribution_event` with all UTM params, click IDs, referrer, page URL, form metadata, and form fields (JSONB)
3. Extracts PII from form fields (name, email, phone) using keyword matching
4. If PII is found: creates a lead with round-robin CSR assignment (same flow as webhook ingestion)
5. Hashes phone/email (SHA-256) for reconciliation matching

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

## Key Files

| File | Purpose |
|:-----|:--------|
| `artifacts/api-server/public/tracker.js` | Client-side universal form attribution IIFE script |
| `artifacts/api-server/src/routes/tracker.ts` | `/api/tracker/submit` endpoint — processes form submissions with attribution |
| `artifacts/api-server/src/services/reconciliation.ts` | Core matching engine — waterfall logic, external conversion push |
| `artifacts/api-server/src/services/sync-scheduler.ts` | Scheduled sync orchestration for all integrations |
| `artifacts/api-server/src/services/st-data-purge.ts` | PII redaction worker for ServiceTitan data |
| `artifacts/api-server/src/services/integrations/service-titan.ts` | ServiceTitan API client |
| `artifacts/api-server/src/routes/integrations.ts` | Sync status endpoint and manual sync triggers |
| `artifacts/api-server/src/routes/webhooks.ts` | Attribution event ingestion via webhooks (CallRail, GHL, Podium) |
| `artifacts/api-server/src/routes/attribution.ts` | Attribution event listing API |
| `artifacts/marketing-os/src/pages/internal.tsx` | Admin dashboard with integration status UI |
| `artifacts/marketing-os/src/pages/attribution.tsx` | Attribution log viewer |
| `lib/db/src/schema/attribution-events.ts` | Attribution events table schema (includes formFields JSONB, all UTM/click ID columns) |
| `lib/db/src/schema/tenants.ts` | Tenants table schema (includes `clientSlug` for tracker identification) |
| `lib/db/src/schema/jobs.ts` | Jobs table schema (match level, GCLID fields) |
| `lib/db/src/schema/integration-sync-logs.ts` | Sync log table schema |
