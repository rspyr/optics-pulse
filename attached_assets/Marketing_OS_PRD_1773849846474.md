# Product Requirements Document (PRD): Marketing OS

## 1. Executive Summary

**Marketing OS** is a comprehensive "Single Source of Truth" platform for HVAC marketing agencies and their clients. It solves the critical problem of attribution disconnect between ad spend (Google/Meta) and actual revenue (ServiceTitan). By building a proprietary "Attribution Engine" middleware, the platform proves exact ROI for every marketing dollar. The solution serves three distinct user groups: the Agency (efficiency & benchmarking), the Business Owner (transparency & ROI), and the Sales Team (speed-to-lead gamification).

**MVP Philosophy:** We prioritize the "Hardest Part" first—the backend Attribution Engine and Data Ingest Layer. Without trusted data, the dashboards are useless. We build from the core data truth (Complex/High Priority) outwards to the user interfaces (Simpler/Lower Priority).

---

## 2. Phase Priorities

### **Phase 1: The Attribution Engine (Core & Foundation)**

- **Status:** Highest Priority (Must Have)
- **Description:** The backend middleware that captures tracking data (GCLID), injects it into ServiceTitan, and reconciles revenue nightly.
- **Criticality:** This is the system's brain. All other portals depend on this data to exist. It solves the "Revenue Accuracy" problem.

### **Phase 2: The Internal & Admin Portal (Agency View)**

- **Status:** High Priority
- **Description:** The "Command Center" for agency staff to manage multiple tenants, benchmark performance, and view "God Mode" analytics.
- **Criticality:** Enables the agency to onboard clients and verify the data from Phase 1.

### **Phase 3: The Client Portal (Owner View)**

- **Status:** Medium Priority
- **Description:** The "Searchlight Killer" dashboard showing CPL, ROI, and financial transparency to business owners.
- **Criticality:** Delivers the value proposition to the paying customer.

### **Phase 4: The Leads Dashboard (Sales View)**

- **Status:** Low Priority
- **Description:** A gamified "Heads-Up Display" for lead coordinators to maximize speed-to-lead.
- **Criticality:** A powerful add-on for operational efficiency, but not required for the core "Marketing ROI" proof.

---

## 3. Core Technical Architecture

### Technology Stack (Replit Native)

The application will be built using Replit's preferred patterns for speed and reliability.

```yaml
Frontend:
  Framework: React (Vite)
  Language: TypeScript
  Styling: Tailwind CSS + shadcn/ui
  State Management: React Context / Hooks
  Icons: Lucide React
  Charts: Recharts

Backend:
  Runtime: Node.js (Express)
  Language: TypeScript
  Database: PostgreSQL (Neon / Replit DB)
  ORM: Drizzle ORM
  Queue System: In-memory or Postgres-backed queue (for Webhooks & Cron Jobs)

Core Integrations:
  - ServiceTitan API V2: Job & Revenue Data
  - Google Ads API: Spend Data & OCI Uploads
  - Meta Marketing API: Spend Data & CAPI
  - CallRail / Twilio: Call Tracking Webhooks
  - GoHighLevel: Form Integrations

Deployment:
  Platform: Replit
  CI/CD: Replit Native
```

### Data Models & Schema Design

The database must support Multi-tenancy and the Attribution Waterfall. Below are the core entities required.

#### **User & Tenant Management**

- **Tenant:** Represents an HVAC Client Company.
  - Fields: `id`, `name`, `serviceTitanId`, `timezone`, `apiConfig (encrypted)`.
- **User:** Agency staff or Client staff.
  - Fields: `id`, `email`, `role` (Super Admin, Agency User, Client Admin, Client User), `tenantId`.

#### **The Attribution Core**

- **AttributionEvent:** A raw tracking event (click, call, or form fill).
  - **Level 1 (Diamond):** `gclid`, `wbraid`, `fbclid`
  - **Level 2 (Golden):** `hashedPhone`, `timestamp`
  - **Level 3 (Silver):** `hashedEmail`
  - **Level 4 (Bronze):** `billingAddress` (Normalized)
  - Metadata: `userAgent`, `landingPage`, `utmSource`, `utmCampaign`.

#### **Business Entities**

- **Lead:** A potential customer.
  - Fields: `id`, `tenantId`, `status` (New, Booked, Sold), `source`, `interestType`.
- **Job:** A ServiceTitan job record (Revenue).
  - Fields: `id`, `tenantId`, `stJobId`, `revenue`, `status`.
  - **Critical Link:** `matchedGclid` (The specific ad click credited with this revenue).
- **Campaign:** Marketing campaign data.
  - Fields: `id`, `platform` (Google/Meta), `externalId`, `name`.
- **CampaignDailyStat:** Aggregated spend/performance metrics.
  - Fields: `campaignId`, `date`, `spend`, `impressions`, `clicks`.

---

## 4. Feature Specifications

### **Phase 1: The Attribution Engine**

#### **1.1. Capture Layer (Client-Side Script)**

**Goal:** Persistently store ad click IDs (GCLID) and inject them into forms.\
**Context:** Standard analytics fail because GCLIDs are lost on page navigation or delayed conversions.\
**Core Workflow:**

```markdown
User Clicks Ad (URL contains ?gclid=123)
  ↓
Script runs on landing page
  ↓
Parses URL params & Writes to 1st Party Cookie + localStorage (90 day expiry)
  ↓
User navigates to "Schedule Now" page
  ↓
Script detects Iframe/Form via MutationObserver
  ↓
Script injects GCLID into hidden input field "marketing_click_id"
```

**Service Layer Logic:**

```javascript
// public/tracker.js
function initTracker() {
  const urlParams = new URLSearchParams(window.location.search);
  const gclid = urlParams.get('gclid');

  if (gclid) {
    const data = { gclid, timestamp: Date.now() };
    localStorage.setItem('hl_attribution', JSON.stringify(data));
    document.cookie = `hl_attr=${JSON.stringify(data)}; max-age=7776000; path=/`;
  }
}
```

#### **1.2. Ingest Layer (Webhook Listener)**

**Goal:** Receive real-time data from CallRail/Twilio and Forms, then push to ServiceTitan.\
**Core Workflow:**

```markdown
Webhook Received (CallRail or Form)
  ↓
Extract: Phone, GCLID, Source
  ↓
DB: Create `AttributionEvent` record
  ↓
ServiceTitan API: Search for Customer by Phone
  ↓
IF Customer Exists -> PATCH Job with `Attribution_GCLID` custom field
IF New Customer -> POST Create Job with `Attribution_GCLID`
```

**API Endpoints:**

```typescript
POST /api/webhooks/ingest
// Payload: { source: "callrail", data: { ... } }
// Auth: Webhook Secret Signature Verification
```

#### **1.3. Reconciliation Engine (Cron Job)**

**Goal:** The "Source of Truth" script that runs nightly to match Revenue to Ad Spend.\
**Core Workflow:**

```markdown
Cron Job Triggers (3:00 AM)
  ↓
Fetch ST Jobs (Status='Completed', Revenue > 0, Last 24h)
  ↓
Loop through Jobs:
  1. Check `Attribution_GCLID` custom field (Direct Hit)
  2. IF NULL -> Search DB `AttributionEvent` by Phone (DNI Match)
  3. IF NULL -> Search DB `AttributionEvent` by Normalized Address (Household Match)
  ↓
Update Job Record in Local DB with Match Result & Revenue
  ↓
Trigger OCI Upload to Google Ads API (if GCLID found)
```

**Success Criteria:**

- 90%+ Match Rate on direct calls.
- &lt; 500ms latency on webhook processing.
- Zero duplicate OCI uploads.

---

### **Phase 2: Internal Admin Portal**

#### **2.1. Media Buying Command Center**

**Goal:** A unified table for Agency Media Buyers to see performance across all clients.\
**Core Workflow:**

```markdown
Agency User Logs In
  ↓
Dashboard loads "All Clients" Table
  ↓
Columns: Client Name, MTD Spend, CPL, Booking Rate, ROAS
  ↓
User filters by "ROAS < 3.0"
  ↓
System highlights underperforming accounts
```

**API Endpoints:**

```typescript
GET /api/admin/dashboard-stats
// Returns aggregated stats for all tenants
```

**UI Components:**

- `file ClientPerformanceTable.tsx`: Sortable data grid with conditional formatting (Red/Green).
- `file DateRangePicker.tsx`: Global date filter.

---

### **Phase 3: Client Portal**

#### **3.1. The "Searchlight Killer" Dashboard**

**Goal:** Show the Business Owner exactly how much money they made from marketing.\
**Context:** Replaces vague "clicks" with "Revenue".\
**Core Workflow:**

```markdown
Owner Logs In
  ↓
Sees "Big 5" Cards: CPL, Booking %, Close %, Avg Sale, ROI
  ↓
Clicks "ROI" Card
  ↓
Expands to show "True ROI" (Ad Spend + Agency Fee) vs Revenue
```

**UI Components:**

- `file MetricCard.tsx`: Displays value + trend arrow (green/red).
- `file RevenueChart.tsx`: Bar chart showing Spend vs. Revenue over time.
- `file ChangeLogOverlay.tsx`: Markers on chart showing when marketing changes happened.

#### **3.2. Financial Transparency**

**Goal:** Build trust by showing granular math.\
**Core Workflow:**

```markdown
User toggles "Include Agency Fees" switch
  ↓
Charts redraw calculations: (Revenue - (Ad Spend + $5k Retainer)) / Total Cost
```

---

### **Phase 4: Leads Dashboard (Sales)**

#### **4.1. The HUD (Heads-Up Display)**

**Goal:** Gamify speed-to-lead for the sales coordinator.\
**Core Workflow:**

```markdown
WebSocket Event: "New Lead"
  ↓
Screen flashes / "Ding" plays
  ↓
"New Lead" Card appears in "Focus Queue" with countdown timer (0:00 -> 5:00)
  ↓
User clicks "Call"
  ↓
System logs "Attempted" status
```

**Technical Implementation:**

- Use `Socket.io` (or similar websocket lib) for real-time bi-directional communication.
- State management is critical here to prevent race conditions (two people calling same lead).

---

## 5. Development Plan

### **Week 1-2: Foundation (The Hardest Part)**

- **Tasks:**
  - Initialize Replit Repo, Drizzle Configuration, & Postgres DB.
  - Build "Capture Script" (JS) for client websites.
  - Build ServiceTitan API Wrapper (Auth + Job Fetching).
  - Build Webhook Ingest Endpoint (CallRail/GHL).
- **Deliverable:** A working database accumulating raw attribution events and successfully creating jobs in ST.

### **Week 3-4: The Reconciliation Engine**

- **Tasks:**
  - Build the "Waterfall Logic" (GCLID -&gt; Phone -&gt; Address).
  - Implement Cron Job architecture.
  - Implement Google Ads OCI Upload.
- **Deliverable:** System auto-matches a test job in ST to a Google Click and uploads conversion value back to Google.

### **Week 5-6: Internal Admin Portal**

- **Tasks:**
  - Build User/Tenant Auth system.
  - Build "Command Center" Table.
  - Aggregate Spend Data from Google/Meta APIs.
- **Deliverable:** Agency team can log in and see live spend/revenue data for a test client.

### **Week 7-8: Client Portal**

- **Tasks:**
  - Build Owner Dashboard UI (Charts/Graphs).
  - Implement "Change Log" and "True ROI" logic.
- **Deliverable:** Client-facing URL ready for beta users.

### **Week 9+: Leads Dashboard**

- **Tasks:**
  - Websocket Setup.
  - HUD Interface & Sound Alerts.
  - Gamification logic.

---

## 6. Success Metrics

- **Data Accuracy:** &gt;90% of Revenue in ServiceTitan is attributed to a source (marketing or organic).
- **System Latency:** Ingest webhooks processed &lt; 2 seconds.
- **Client Trust:** "True ROI" metric matches Client's bank account perception (within 5% margin).

---

## 7. Non-Goals

- ❌ **Full CRM Replacement:** We are not rebuilding ServiceTitan or GoHighLevel. We only overlay/inject data.
- ❌ **Email Marketing Tool:** We track leads, we don't send newsletter campaigns (use GHL for that).
- ❌ **Complex HR/Payroll:** Commission tracking is for display only; not legal payroll processing.

---

## 8. Technical Considerations

- **ServiceTitan Rate Limits:** API V2 has strict limits. We must implement a "Token Bucket" rate limiter in our Queue system to prevent 429 errors.
- **Data Hygiene:** ServiceTitan data is often messy. We need robust normalization functions (e.g., stripping `+1`, `(` `)` from phone numbers) before matching.
- **Shadow DOM:** Many scheduling widgets use Shadow DOM. The Capture Script must be able to pierce Shadow DOM to inject inputs.

---

## 9. Dependencies & Integrations

- **ServiceTitan API:** Requires a Developer Account & Tenant API Key.
- **Google Ads API:** Requires a Developer Token (can take weeks to approve) & OAuth setup.
- **CallRail:** Requires API Access & Webhook configuration.

---

## 10. Risk Mitigation


- **Risk:** ServiceTitan API changes or downtime.
  - **Mitigation:** Queue system with exponential backoff retries. We never lose a lead; we just retry later.
- **Risk:** Client website changes break the Capture Script.
  - **Mitigation:** Script sends a "Heartbeat" to our server. If no heartbeat for 24h, alert the Agency.
- **Risk:** iOS 14 blocking Cookies.
  - **Mitigation:** Implement Server-Side CAPI (Facebook) and Enhanced Conversions (Google) as fallbacks (Phase 1).