# Google Ads API — Application for Access

---

## Company Name

HVAC Launch (DBA "Optics")

---

## Business Model

Our company operates a marketing agency specializing in the HVAC and home services industry. We manage Google Ads campaigns on behalf of our clients — HVAC contractors and home service businesses. Each client has their own Google Ads account, and we act as an MCC (Manager Account) to manage advertising across all client accounts. We only manage ads for businesses that are contracted clients of our agency. We do not manage ads for any third parties outside of our direct client relationships.

---

## Tool Access/Use

Our tool, **Optics**, is an internal attribution and reporting platform used exclusively by employees and campaign managers within our agency. Its primary users are:

- **Agency campaign managers** who monitor ad performance, adjust budgets, and review attribution data across all client accounts.
- **Agency leadership** who review aggregated ROI, ROAS, and spend-vs-revenue dashboards for the entire client portfolio.
- **Client account owners** who access a read-only client portal to view their own campaign performance, lead metrics, and ROI reports. Clients cannot modify campaigns or access the API directly.

No external users, third-party advertisers, or end consumers have access to the tool or the underlying API calls. All API interactions are server-to-server, initiated by our backend system — never by end users directly.

---

## Tool Design

Optics is a web-based platform with a Node.js/Express backend and a React frontend, backed by a PostgreSQL database.

### Data Flow Architecture

1. **Inbound Data Sync (Google Ads → Our Database):**
   Our backend runs a scheduled sync process (every 15–60 minutes) that pulls campaign performance data from the Google Ads API into our PostgreSQL database. We use GAQL (Google Ads Query Language) via the `GoogleAdsService.Search` method to fetch campaign-level metrics including impressions, clicks, cost, and conversions for each client's account. This data is stored locally and displayed in our reporting dashboards.

2. **Attribution & Reconciliation Engine:**
   Our platform captures first-party attribution data (GCLIDs from ad clicks, UTM parameters, phone call tracking via CallRail) and matches it against completed jobs in our clients' CRM systems (ServiceTitan). This reconciliation uses a multi-level "waterfall" matching algorithm to link actual revenue back to the original Google Ads click.

3. **Outbound Conversion Upload (Our Database → Google Ads):**
   Once reconciliation is complete, we upload matched conversion data back to Google Ads using the `ConversionUploadService.UploadClickConversions` method. This serves two purposes:
   - **Offline Conversion Import (OCI):** For leads where a GCLID was captured, we upload the GCLID along with conversion time and revenue value so Google can attribute real revenue to specific ad clicks.
   - **Enhanced Conversions:** For leads where no GCLID is available, we upload hashed user identifiers (SHA-256 hashed email addresses and phone numbers) to enable Google's modeled attribution.

4. **Budget Management:**
   Agency campaign managers can adjust daily campaign budgets directly from our dashboard. This uses the `CampaignBudgetService.MutateCampaignBudgets` method to update the `amount_micros` field on campaign budget resources.

### User Interface

The UI provides dashboards for viewing campaign performance over configurable time periods, including:
- Account-level and campaign-level performance metrics (impressions, clicks, conversions, cost, ROAS)
- Spend vs. revenue charts with drill-down capability
- Attribution event logs showing which leads matched to which ad clicks
- Reconciliation run history showing OCI upload results
- Budget adjustment controls for active campaigns

All data displayed in the UI is pulled from our internal PostgreSQL database — the UI never calls the Google Ads API directly.

---

## API Services Called

Our application uses the following Google Ads API (v17) services and resources:

### 1. GoogleAdsService.Search
- **Purpose:** Fetch campaign performance data for reporting dashboards.
- **Resource:** `campaign`
- **Fields queried:** `campaign.id`, `campaign.name`, `campaign.status`, `metrics.impressions`, `metrics.clicks`, `metrics.cost_micros`, `metrics.conversions`, `metrics.average_cpc`, `segments.date`
- **Endpoint:** `POST /customers/{customerId}/googleAds:search`
- **Usage pattern:** Called on a recurring schedule (every 15–60 minutes) per tenant to keep performance data current. Also called on-demand when a user requests a dashboard refresh for a specific date range.

### 2. ConversionUploadService.UploadClickConversions
- **Purpose:** Upload offline conversion data (revenue from completed jobs) back to Google Ads to improve Smart Bidding optimization.
- **Endpoint:** `POST /customers/{customerId}:uploadClickConversions`
- **Usage pattern:** Called after each reconciliation run (typically nightly) to upload matched conversions. Supports both GCLID-based conversions (standard OCI) and hashed-identifier-based conversions (Enhanced Conversions). Uses `partialFailure: true` to maximize successful uploads.
- **Data uploaded:**
  - **OCI:** `gclid`, `conversionAction`, `conversionDateTime`, `conversionValue`, `currencyCode`
  - **Enhanced Conversions:** `conversionAction`, `conversionDateTime`, `conversionValue`, `currencyCode`, `userIdentifiers` (hashed email, hashed phone)

### 3. CampaignBudgetService.MutateCampaignBudgets
- **Purpose:** Allow agency campaign managers to adjust daily campaign budgets from within our dashboard.
- **Endpoint:** `POST /customers/{customerId}/campaignBudgets:mutate`
- **Usage pattern:** Called on-demand when an agency user modifies a campaign's daily budget through the UI. Updates the `amount_micros` field on the campaign's budget resource. First queries for the campaign's budget resource name via `GoogleAdsService.Search`, then issues the mutate call.

---

## OAuth & Authentication

- We authenticate using OAuth 2.0 with a developer token issued to our MCC (Manager Account).
- Each client tenant has its own `customerId` stored (encrypted at rest using AES-256-GCM) in our database.
- We use `login-customer-id` headers for manager-level access to child accounts.
- Access tokens are refreshed server-side using stored refresh tokens — no end user is ever involved in the OAuth flow.

---

## Rate Limiting & Error Handling

- All Google Ads API calls use an automatic retry mechanism with exponential backoff (up to 3 retries).
- Conversion uploads use `partialFailure: true` to ensure individual conversion errors don't block the entire batch.
- All API errors are logged and surfaced in our admin dashboard for monitoring.

---

## Data Privacy & Security

- All API credentials (developer tokens, access tokens, refresh tokens) are stored encrypted using AES-256-GCM in our PostgreSQL database.
- Enhanced Conversion user identifiers are SHA-256 hashed before upload, in compliance with Google's requirements.
- The platform enforces strict multi-tenant data isolation — each client can only access their own data.
- Role-based access control (super_admin, agency_user, client_admin, client_user) ensures appropriate access levels.

---

## Tool Mockups

Screenshots of the application are provided below. Since our tool is externally accessible, these are live screenshots from our production environment.

*(Attach the following screenshots when submitting:)*

1. **Dashboard Overview** — Shows account-level performance metrics (impressions, clicks, conversions, cost, ROAS) with date range selector and campaign filtering.

2. **Attribution & Reconciliation View** — Shows the attribution events log with match levels (Diamond/Golden/Silver/Bronze) and the reconciliation run history including OCI upload results.

3. **Campaign Performance Drilldown** — Shows campaign-level breakdowns with spend, clicks, conversions, and cost-per-conversion for a selected date range.

4. **Budget Management** — Shows the campaign budget adjustment interface where agency users can modify daily budgets that are pushed to Google Ads via the CampaignBudgetService.

5. **Client Portal** — Shows the read-only client-facing dashboard with KPIs, spend transparency, and ROI metrics.

---

## Summary of Compliance

| Requirement | Our Implementation |
|---|---|
| We only manage ads for our own clients | ✅ Agency manages campaigns for contracted HVAC clients only |
| End users cannot access the API directly | ✅ All API calls are server-to-server |
| We store credentials securely | ✅ AES-256-GCM encryption at rest |
| We handle user data responsibly | ✅ SHA-256 hashing for Enhanced Conversions, multi-tenant isolation |
| We have proper error handling | ✅ Retry with backoff, partial failure support, error logging |
| We comply with rate limits | ✅ Token bucket rate limiter with automatic retry |
