This is an **Attribution Engine**. The PRD must focus heavily on *how* you prove that a specific Google Ad led to a specific $15,000 AC installation in ServiceTitan.

Building a "Single Source of Truth" for marketing efforts.

---

## **The "Attribution Logic" Interview (Internal Only)**

**Who to ask:** Your Head of Paid Media, Lead Data Analyst, and Senior Strategy Leads.

*The Goal: Define the "Business Rules" for matching marketing spend to actual revenue. This is the hardest part of the build.*

1. **The "Join Key" Definition:**

   **The Architecture: "The Golden Record" Middleware**

   Instead of trying to force Google Ads and ServiceTitan to talk directly (which is often limited by API constraints), you build a **Middle Layer (The Attribution Engine)** that acts as the single source of truth.

   **The "Join Key" is not one field. It is a Hierarchy of Evidence.**\
   Your engine will attempt to match a conversion using this waterfall logic:

   1. **Level 1 (The Diamond Key):** `GCLID` / `WBRAID` (Click ID) — *100% Accuracy.*
   2. **Level 2 (The Golden Key):** `hashed_phone_number` + `timestamp` — *90% Accuracy.*
   3. **Level 3 (The Silver Key):** `hashed_email` — *80% Accuracy.*
   4. **Level 4 (The Bronze Key):** `billing_address` — *High false positive risk, use only for "Households".*

   ---

   **Phase 1: The "Capture" (Client-Side)**

   You need a proprietary tracking script (like a lightweight pixel) on the HVAC client's website. Standard Google Analytics isn't enough because it doesn't give you raw access to the data for server-side processing.

   **A. The "Cookie Jar" Script**

   - **Action:** When a user lands, your script parses the URL parameters (`?gclid=...`, `?utm_source=...`) and writes them to a **First-Party Cookie** (lasts 90 days) and `localStorage`.
   - **Code Spec:**

     ```javascript
     // Capture logic (simplified)
     const params = new URLSearchParams(window.location.search);
     const gclid = params.get('gclid') || params.get('wbraid') || params.get('gbraid');
     if (gclid) {
         const attributionData = {
             id: gclid,
             source: params.get('utm_source') || 'google',
             landing_page: window.location.pathname,
             timestamp: new Date().toISOString()
         };
         // Write to Cookie (Server-Readable) & LocalStorage (Persistent)
         document.cookie = `hl_attr=${JSON.stringify(attributionData)}; max-age=7776000; path=/`;
         localStorage.setItem('hl_attribution', JSON.stringify(attributionData));
     }
     ```
   - **Why:** If they click an ad on Tuesday but don't call until Friday, the URL parameters are gone. The cookie remembers.

   **B. The "Injection" (Form Fills)**

   - **Action:** When a user loads a scheduling widget (ServiceTitan Web Scheduler, Schedule Engine, or a custom form), your script silently injects the `GCLID` into a **hidden field** or custom parameter named `marketing_click_id`.
   - **Execution:** Use `MutationObserver` in JS to watch for the form iframe or DOM elements to load, then programmatically inject the value from `localStorage`.

   **C. The "Swap" (Phone Calls)**

   - **Action:** You **MUST** use a DNI (Dynamic Number Insertion) tool like CallRail or a custom Twilio build.
   - **The Bridge:** When the user calls the trackable number, the DNI provider captures the `GCLID` associated with that specific session and stores it in the call metadata.
   - **Integration:** Configure the DNI provider's "Integration Triggers" to send a JSON payload to your Middleware Webhook immediately upon call completion.

   ---

   **Phase 2: The "Ingest" (Server-Side Integration)**

   This is where your software shines. You aren't just reading data; you are writing it.

   **A. ServiceTitan "Custom Field" Architecture**

   - Do not rely on the standard "Campaign" field in ServiceTitan (it’s often user-editable and messy).
   - **Build This:** Create a Custom Field Group in ServiceTitan called `Attribution_Meta`.
   - **Fields (API Names):**
     - `Attribution_GCLID` (String) - *Primary Key*
     - `Attribution_Source` (String)
     - `Attribution_Landing_Page` (String)
     - `Attribution_Timestamp` (DateTime)

   **B. The Webhook Listener**

   - **Scenario:** A booking happens.
   - **Action:** Your engine listens for the webhook from the DNI provider (CallRail) or the Form.
   - **The Magic:** Your engine calls the **ServiceTitan API** (`POST /crm/v2/tenant/{tenant_id}/jobs`) to create the job, **OR** (if the job is already created) it hits `PATCH /crm/v2/tenant/{tenant_id}/jobs/{id}` to inject the `GCLID`.
   - **Payload Spec:**

     ```json
     {
       "customFields": [
         {
           "typeId": "Attribution_GCLID",
           "value": "CjwKCAjw7--pBhA..." 
         },
         {
           "typeId": "Attribution_Source",
           "value": "google_ads" 
         }
       ]
     }
     ```

   ---

   **Phase 3: The "Reconciliation" (The Daily Cron Job)**

   This is the "Source of Truth" logic. Every night at 3:00 AM, your Engine runs a reconciliation script.

   1. **Fetch Revenue:** Pull all jobs from ServiceTitan where `status = 'Completed'` and `total_revenue > 0`.
   2. **Fetch Spend:** Pull all ad spend from Google/Facebook APIs.
   3. **The Match Algorithm:**
      - **Check 1 (Direct Hit):** Does the ServiceTitan Job have a `GCLID` in your custom field? -&gt; **Match.**
      - **Check 2 (DNI Fallback):** If NO GCLID in ServiceTitan:
        - Take the customer's phone number from ServiceTitan (`customer.contacts[].mobilePhone`).
        - Query your DNI Database (CallRail API): `GET /calls?search={phone_number}&date_range={attribution_window}`.
        - Did *that* call have a GCLID? -&gt; **Match.**
      - **Check 3 (Household Match):**
        - Take the `serviceLocation.address` from ServiceTitan.
        - Normalize the string (e.g., "123 Main St" == "123 Main Street").
        - Check your DNI/Form logs for *any* activity from this address that had a GCLID.
        - \-&gt; **Probable Match** (Flag for manual review or auto-accept based on confidence score).

   ---

   **Phase 4: The "Feedback Loop" (Offline Conversion Import)**

   This is how you train Google's AI to find "High Paying" customers, not just "Tire Kickers."

   - **Action:** Once a match is confirmed and revenue is booked, your Engine formats a **Google Click Conversion Upload** (OCI).
   - **Protocol:** Use the Google Ads API `UploadClickConversions` service.
   - **Payload:**
     - `GCLID`: The key you captured.
     - `Conversion Name`: "ServiceTitan_Installation_Revenue" (Must match Google Ads "Conversion Action" name exactly).
     - `Conversion Time`: The time the job was *booked* (or paid).
     - `Conversion Value`: $15,000 (The actual ticket size).
     - `Currency Code`: "USD"
   - **Result:** Google Ads now knows *exactly* which keyword produced the $15k job, not just the phone call.

   **Edge Case Handling (Why this wins)**

   1. **The "Wife Clicks, Husband Calls" Problem:**
      - *Solution:* Your "Household Match" logic (Level 4) handles this by keying off the ServiceTitan `Service Location` address, not just the personal phone number.
   2. **iOS 14 / Privacy Blocks:**
      - *Solution:* When `GCLID` is stripped, you fallback to **Google Enhanced Conversions**. Your engine uploads the *hashed* email/phone back to Google (SHA-256). Google attempts to match this to a logged-in Google User who clicked an ad.
   3. **"Repeat Customer" Noise:**
      - *Solution:* Your engine checks ServiceTitan for *previous* jobs. If this customer has existed for &gt;5 years, you can exclude them from "New Customer Acquisition" ROAS reports, or attribute it to a "Brand Retention" campaign instead of "Non-Brand Search."

2. **The Attribution Model:**

   - "Since HVAC sales cycles can be long (e.g., research in March, install in May), what attribution window do we need? 30 days? 90 days?"

   - "If a user clicks a Facebook Ad, then Googles the brand name and clicks a Search Ad, who gets credit? (First Touch vs. Last Touch)."

3. **Handling "Fuzzy" Data:**

   - "How do we handle 'Unattributed Revenue'? (e.g., A technician upsells a unit on-site. Do we filter that out of Marketing ROI, or include it?)"

---

## **The Internal Team Portal (Agency Efficiency)**

**Who to ask:** Account Managers (AMs) and Media Buyers.

*The Goal: Reduce the time they spend manually cobbling reports together so they can focus on strategy.*

1. **The "God View" (Multi-Tenant):**

   - "You manage 15 HVAC accounts. Do you need a single table that lists all 15 with columns for 'MTD Spend,' 'CPA,' and 'ROAS' so you can sort by 'Worst Performer' and prioritize your day?"

2. **Budget Pacing & Alerts:**

   - "HVAC demand fluctuates wildly with weather. Do you need automated alerts if a client is underspending due to low search volume (mild weather), or overspending?"

3. **The "Defense" Narrative:**

   - "When a client calls angry that 'leads are slow,' what specific data do you currently screenshot to prove them wrong? (e.g., 'Your leads are actually up, but your booking rate in ServiceTitan is down'). We need to front-load this data."

4. **ServiceTitan Granularity:**

   - "Do you need to filter ROI by 'Job Type'? (e.g., differentiating between 'Maintenance Tune-up' (low value) vs. 'System Replacement' (high value) to show true profitability?"

---

### **Phase 3: The Client Portal (HVAC Business Owner)**

**Who to ask:** Your friendliest 2-3 clients (owners or ops managers).

*The Goal: Prove value and reduce "Where is my money going?" anxiety.*

1. **The "BS" Detector:**

   - "When you look at Google Analytics, you see 'Conversions.' When you look at ServiceTitan, you see 'Revenue.' They never match. If we give you one number called 'Marketing Influenced Revenue,' will you trust it? What proof do you need to see to believe it? (e.g., A list of customer names associated with that revenue?)"

2. **Operational Insights:**

   - "Would it be helpful to see your 'Call Booking Rate' (CSR performance) right next to your Marketing Lead volume? (i.e., proving that we sent leads, but your front desk didn't book them)."

3. **Simplicity vs. Depth:**

   - "Do you want to see granular CPC (Cost Per Click) data, or do you strictly care about CPL (Cost Per Lead) and CPR (Cost Per Revenue)? Do you want to know *which* keywords are working, or just that 'Google Ads' is working?"

4. **Review Sentiment (Podium):**

   - "Since we are pulling Podium data read-only, do you want a simple 'Sentiment Score' (e.g., 'Your reputation is trending down this month'), or just a raw feed of recent reviews?"

---

### **Phase 4: The Admin Portal (Management & Ops)**

**Who to ask:** Your CTO/Tech Lead and Operations Director.

*The Goal: Scalability and stability.*

1. **Client Onboarding:**

   - "We know connecting ServiceTitan APIs can be tricky (Tenant IDs, API keys). Do we need a self-serve flow where the client logs in and connects it themselves, or will an internal Admin do the setup for them?"

2. **Data Hygiene:**

   - "If a client disconnects their ServiceTitan account or changes their password, how should the system alert us that the data flow has stopped?"

3. **User Roles:**

   - "Do your clients have different users? Does the 'Office Manager' need different access than the 'Business Owner'?"

---

### **Phase 5: Technical Feasibility (The "Gotchas")**

**Who to ask:** Your Developers / Data Engineers.

*The Goal: Ensure the API limits and data structures support the vision.*

1. **ServiceTitan Reporting API Limits:**

   - "ServiceTitan's reporting API can be slow. If we have 50 clients and we sync hourly, will we hit rate limits? Do we need to stagger the syncs? (e.g., Client A at :00, Client B at :05)."

2. **Historical Data:**

   - "When we onboard a new client, do we pull the last 12 months of ServiceTitan/Google data to show Year-over-Year comparison immediately? How long will that initial sync take?"

3. **Mapping "Campaigns" to "Revenue":**

   - "ServiceTitan has a 'Marketing Campaign' field. Is our team currently updating that field correctly in ServiceTitan? If not, our platform will show $0 revenue. Do we need to build a tool to 'fix' bad data in the platform?"

### Suggestion for your Next Step

Once you ask **Phase 1 (The Attribution Logic)** questions, you will likely hit a roadblock on *how* to match the data.

Would you like me to outline the **3 Common Data Architectures for Marketing Attribution** (e.g., UTM-based, GCLID-based, or Call-Tracking-based) so you can propose solutions during these interviews?