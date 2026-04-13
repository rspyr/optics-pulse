# Pulse iOS — Swift/SwiftUI Product Requirements Document

> **Purpose**: This document fully specifies the Pulse Mobile app so that a code-generation agent (OpenAI Codex) can produce a native Swift/SwiftUI iOS client in a single pass. Every API contract, UI layout, color token, data model, and interaction is defined below. The existing Node.js/Express API server is the source of truth.
>
> **Server change required**: Push notifications currently use Expo Push Notification Service. A native Swift app needs a server-side APNs adapter added to `services/push-notifications.ts` (see §8.5 for the exact change needed). All other features work with no server changes.

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Authentication & Session Management](#2-authentication--session-management)
3. [API Reference](#3-api-reference)
4. [Real-Time Events (Socket.io)](#4-real-time-events-socketio)
5. [Screen Specifications](#5-screen-specifications)
6. [Design System](#6-design-system)
7. [Data Models](#7-data-models)
8. [Push Notifications](#8-push-notifications)
9. [Swift Architecture Recommendations](#9-swift-architecture-recommendations)

---

## 1. Product Overview

Pulse is a lead-management CRM for home-services companies. CSRs (Customer Service Representatives) use the mobile app to:

- View a real-time HUD (heads-up display) of today's stats
- Work a prioritized queue of leads (new, callbacks, re-engagement, old)
- Log call/text/voicemail actions on each lead
- Send and receive SMS via Podium integration
- Transfer leads to other CSRs
- Receive push notifications for new leads and callbacks

### Roles

| Role | Code | Capabilities |
|------|------|-------------|
| CSR | `client_user` | Sees only their own leads. No CSR filter. |
| Client Admin | `client_admin` | Sees all leads in their tenant. Has CSR filter. |
| Agency User | `agency_user` | Cross-tenant access. Has tenant selector + CSR filter. |
| Super Admin | `super_admin` | Full access. Has tenant selector + CSR filter. |

### Multi-Tenancy

The API is multi-tenant. Every request that touches lead data requires a `tenantId`. For `client_user` and `client_admin`, the server infers `tenantId` from the session. For `agency_user` and `super_admin`, the client must pass `tenantId` as a query parameter (or body field).

---

## 2. Authentication & Session Management

### 2.1 Login

```
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "secret"
}
```

**Success 200** (flat object — not wrapped in `user`):
```json
{
  "id": 42,
  "email": "user@example.com",
  "name": "Jane Doe",
  "role": "client_user",
  "tenantId": 1,
  "tenantName": "Acme HVAC",
  "leaderboardConfig": { "visible": true, "displayMode": "named" },
  "bearerToken": "s:abc123.signature",
  "sessionToken": "mos.sid=s%3Aabc123.signature"
}
```

> The `bearerToken` is a signed session ID. The `sessionToken` is the full cookie string. On iOS, use only `bearerToken` in the `Authorization` header. The `leaderboardConfig` field is optional and may be `null`.

**Error 401:**
```json
{ "error": "Invalid credentials" }
```

### 2.2 User-Agent Requirement

The server only includes `bearerToken` and `sessionToken` in the login response when `User-Agent` matches `/expo|react-native|okhttp/i`. A native Swift `URLSession` will not match by default.

**Required**: Set a custom `User-Agent` on all requests:
```swift
let config = URLSessionConfiguration.default
config.httpAdditionalHeaders = [
    "User-Agent": "PulseSwift/1.0 (react-native)"
]
let session = URLSession(configuration: config)
```

This ensures the server returns the `bearerToken` field on login and correctly identifies the client as mobile.

### 2.3 Token Storage

- Store `bearerToken` in the iOS **Keychain** under service `com.pulse.app`, key `bearer_token`.
- Store the user object in `@AppStorage` or `UserDefaults` (non-sensitive).
- All subsequent API requests must include `Authorization: Bearer <token>` header.

### 2.4 Session Restore

On app launch, if a Keychain token exists, call:

```
GET /api/auth/me
Authorization: Bearer <token>
```

**Success 200** (flat user object — same shape as login minus `bearerToken`/`sessionToken`):
```json
{
  "id": 42,
  "email": "user@example.com",
  "name": "Jane Doe",
  "role": "client_user",
  "tenantId": 1,
  "tenantName": "Acme HVAC",
  "leaderboardConfig": { "visible": true, "displayMode": "named" }
}
```
Resume the session with the stored Keychain token.

**Error 401:** Token expired. Clear Keychain and show login screen.

### 2.5 Logout

```
POST /api/auth/logout
Authorization: Bearer <token>
```

Before calling logout:
1. Unregister push token via `DELETE /api/push-tokens` (see §8).
2. Disconnect Socket.io.
3. Clear Keychain token and stored user.
4. Navigate to login screen.

### 2.6 Change Password

```
POST /api/auth/change-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "currentPassword": "old",
  "newPassword": "new123"
}
```

**Success 200:** `{ "success": true }`
**Error 401:** `{ "error": "Current password is incorrect" }`
**Error 400:** `{ "error": "New password must be at least 6 characters" }`

---

## 3. API Reference

**Base URL**: `https://<DOMAIN>/api`
**Content-Type**: `application/json` for all requests and responses.
**Auth header**: `Authorization: Bearer <token>` on every request (except login).

### 3.1 HUD Stats

```
GET /api/leads/hud/stats?tenantId={id}&csrId={id}&startDate={ISO}&endDate={ISO}
```

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `tenantId` | int | Agency/super only | Inferred for client roles |
| `csrId` | int | No | Filters to one CSR. `client_user` auto-scoped to self |
| `startDate` | ISO string | No | Defaults to today in tenant timezone |
| `endDate` | ISO string | No | Defaults to today in tenant timezone |

**Response 200:**
```json
{
  "callsMadeToday": 35,
  "bookingsToday": 4,
  "bookingRate": 16.7,
  "commission": 250.00,
  "newLeadsToday": 8,
  "avgSpeedToLead": 720,
  "soldToday": 2,
  "bonusTier": "silver",
  "bonusThreshold": 10,
  "nextBonusAt": 12
}
```

### 3.2 Lead Queue

```
GET /api/leads-hub/queue?tenantId={id}&csrId={id}&tab={tab}
```

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `tenantId` | int | Agency/super | — |
| `csrId` | int | No | `client_user` auto-scoped to self |
| `tab` | string | No | One of: `all`, `new`, `callbacks`, `reengagement`, `old`. Default `all` |

**Response 200:**
```json
{
  "newLeads": [ /* Lead[] with nextPassAt, passIntervalMinutes */ ],
  "callbacks": [ /* Lead[] with callbackAt */ ],
  "reengagement": [ /* Lead[] with lastAttemptAt, attemptCount, nextPassAt */ ],
  "oldLeads": [ /* Lead[] */ ],
  "total": 42,
  "timezone": "America/New_York"
}
```

Each lead in the arrays includes the full Lead model (§7.1) plus enrichment fields:
- `nextPassAt: string | null` — ISO timestamp when auto-pass fires
- `passIntervalMinutes: number | null` — pass interval config
- Reengagement leads also include: `lastAttemptAt: string | null`, `attemptCount: number`

### 3.3 Archive (Completed Leads)

```
GET /api/leads-hub/archive?tenantId={id}&csrId={id}&limit=50&offset=0&month=2026-04&source=google&status=appt_set
```

| Param | Type | Notes |
|-------|------|-------|
| `limit` | int | Max 200, default 50 |
| `offset` | int | Pagination offset |
| `month` | string | `YYYY-MM` format |
| `source` | string | Filter by lead source |
| `serviceType` | string | Filter by service type |
| `csrId` | int | Filter by CSR |
| `status` | string | `appt_set` or `dead` |

**Response 200:**
```json
{
  "leads": [ /* Lead[] */ ],
  "total": 156
}
```

### 3.4 Lead Detail

```
GET /api/leads/{id}?tenantId={id}
```

**Response 200:** Single Lead object (§7.1).

### 3.5 Lead Action History

```
GET /api/leads-hub/{leadId}/history?tenantId={id}
```

**Response 200:**
```json
{
  "history": [
    {
      "id": 1,
      "leadId": 100,
      "userId": 42,
      "method": "call",
      "outcome": "no_answer",
      "platform": "native",
      "attemptedAt": "2026-04-13T14:30:00Z",
      "notes": null,
      "actionType": "call",
      "callResult": "no_answer",
      "vmResult": null,
      "textResult": null,
      "deadReason": null,
      "csrName": "Jane Doe"
    }
  ]
}
```

### 3.6 Claim / Release Claim

Before logging an action, the CSR must claim the lead (optimistic lock). Release when navigating away.

**Claim:**
```
POST /api/leads-hub/{id}/claim
Authorization: Bearer <token>
Content-Type: application/json
{ "tenantId": 1 }
```

**Success 200:** `{ "ok": true }`
**Error 409:** `{ "error": "Lead is currently being worked by another CSR" }`
**Error 403:** `{ "error": "This lead has been reassigned to another CSR. Please refresh your queue." }`

**Release:**
```
POST /api/leads-hub/{id}/release-claim
Authorization: Bearer <token>
Content-Type: application/json
{ "tenantId": 1 }
```

**Success 200:** `{ "ok": true }`

### 3.7 Log Action

```
POST /api/leads-hub/action
Authorization: Bearer <token>
Content-Type: application/json

{
  "leadId": 100,
  "tenantId": 1,
  "actionType": "call",
  "callResult": "no_answer",
  "vmResult": null,
  "textResult": null,
  "deadReason": null,
  "notes": "Left message with receptionist",
  "callbackAt": null,
  "appointmentSet": false,
  "apptBookedOutcome": null
}
```

**Action types**: `call`, `text`, `voicemail_drop`, `voicemail`

**Call results**: `no_answer`, `left_voicemail`, `vm_full`, `vm_not_setup`, `bad_number`, `spoke_with_customer`, `hung_up`, `blocked`, `out_of_service_area`

**Text results**: `yes`, `not_able_to`, `dead`, `no_need`, `reached_out`

**VM results**: `yes`, `no`, `bad_number`, `vm_full`, `vm_not_setup`, `spoke_with_customer`

**Dead reasons**: Free-text string (e.g., `"not_interested"`, `"wrong_number"`, `"duplicate"`)

**Appointment booked outcomes** (only when `lead.hubStatus == "appt_booked"`): `confirmed`, `rescheduled`, `canceled`

**Response 200:**
```json
{
  "lead": { /* updated Lead */ },
  "action": {
    "actionType": "call",
    "outcome": "no_answer"
  }
}
```

### 3.8 Edit Action

```
PUT /api/leads-hub/action/{attemptId}
Authorization: Bearer <token>
Content-Type: application/json

{
  "tenantId": 1,
  "actionType": "call",
  "callResult": "spoke_with_customer",
  "spokeResult": "call_back",
  "callbackAt": "2026-04-14T10:00:00Z",
  "notes": "Updated notes"
}
```

**Response 200:** `{ "attempt": { /* updated CallAttempt */ } }`

### 3.9 Transfer Lead

```
POST /api/leads-hub/{leadId}/transfer
Authorization: Bearer <token>
Content-Type: application/json

{
  "tenantId": 1,
  "targetCsrId": 55
}
```

**Response 200:** `{ "lead": { /* updated Lead with new assignedCsrId */ } }`

### 3.10 CSR List

```
GET /api/leads-hub/csrs?tenantId={id}
```

**Response 200:**
```json
{
  "csrs": [
    { "id": 42, "name": "Jane Doe", "email": "jane@example.com" }
  ]
}
```

### 3.11 Pause / Resume

**Get current pause state** (CSRs only — `client_user` role):
```
GET /api/leads-hub/my-pause?tenantId={id}
```

**Response 200:**
```json
{
  "isPaused": true,
  "pauseSource": "self"
}
```

`pauseSource` is `"self"` (CSR paused themselves) or `"manager"` (paused by admin).

**Toggle pause:**
```
POST /api/leads-hub/my-pause
Authorization: Bearer <token>
Content-Type: application/json

{
  "tenantId": 1,
  "isPaused": true
}
```

Pass `{ "isPaused": false }` to resume.

**Response 200:**
```json
{ "isPaused": true, "pauseSource": "self" }
```

**Error 409** (manager-paused — CSR cannot self-resume):
```json
{
  "error": "Your leads are paused by a manager. Contact your manager to resume.",
  "isPaused": true,
  "pauseSource": "manager"
}
```

### 3.12 Lead Search

```
GET /api/leads/search?q={term}&tenantId={id}&funnelId={id}&startDate={ISO}&endDate={ISO}&dateType={type}
```

| Param | Type | Notes |
|-------|------|-------|
| `q` | string | Searches name, email, phone, source |
| `funnelId` | int | Filter by funnel type |
| `startDate` / `endDate` | ISO string | Date range filter |
| `dateType` | string | `created` or `updated` |

**Response 200:**
```json
{
  "leads": [ /* Lead[] */ ],
  "total": 12
}
```

### 3.13 Podium Conversations

```
GET /api/podium/conversations/{leadId}?tenantId={id}
```

**Response 200:**
```json
{
  "messages": [
    {
      "id": 1,
      "tenantId": 1,
      "leadId": 100,
      "podiumConversationUid": "conv_abc",
      "podiumMessageUid": "msg_xyz",
      "direction": "inbound",
      "body": "Hi, I need a quote",
      "channelType": "sms",
      "senderName": "John Smith",
      "deliveryStatus": "delivered",
      "podiumCreatedAt": "2026-04-13T10:00:00Z"
    }
  ],
  "conversationUid": "conv_abc",
  "podiumDeepLink": "https://app.podium.com/inbox/redirect-messages/conv_abc",
  "notConnected": false
}
```

### 3.14 Send Podium Message

```
POST /api/podium/messages
Authorization: Bearer <token>
Content-Type: application/json

{
  "leadId": 100,
  "body": "Hi John, following up on your request.",
  "tenantId": 1
}
```

**Response 200:**
```json
{
  "success": true,
  "message": { /* PodiumMessage row */ }
}
```

### 3.15 Podium Timeline

```
GET /api/podium/timeline/{leadId}?tenantId={id}
```

Returns a merged timeline of call attempts and Podium messages ordered by date.

**Response 200:**

Each entry is a flat object with a `type` discriminator and top-level fields:

```json
{
  "timeline": [
    {
      "type": "pulse_action",
      "source": "pulse",
      "timestamp": "2026-04-13T14:30:00Z",
      "id": 1,
      "leadId": 100,
      "userId": 42,
      "method": "call",
      "outcome": "no_answer",
      "actionType": "call",
      "callResult": "no_answer",
      "vmResult": null,
      "textResult": null,
      "deadReason": null,
      "notes": null,
      "csrName": "Jane Doe"
    },
    {
      "type": "podium_text",
      "source": "podium",
      "timestamp": "2026-04-13T14:35:00Z",
      "id": 5,
      "direction": "inbound",
      "body": "Hi, I need a quote",
      "channelType": "sms",
      "senderName": "John Smith",
      "deliveryStatus": "delivered",
      "podiumMessageUid": "msg_xyz",
      "podiumConversationUid": "conv_abc",
      "podiumDeepLink": "https://app.podium.com/inbox/redirect-messages/conv_abc",
      "messageItems": null
    },
    {
      "type": "podium_call",
      "source": "podium",
      "timestamp": "2026-04-13T14:20:00Z",
      "id": 3,
      "direction": "inbound",
      "body": null,
      "channelType": "call",
      "senderName": null,
      "deliveryStatus": null,
      "podiumMessageUid": "msg_abc",
      "podiumConversationUid": "conv_abc",
      "podiumDeepLink": null,
      "messageItems": null
    }
  ]
}
```

Timeline `type` values: `"pulse_action"` | `"podium_text"` | `"podium_call"`. Sorted newest-first.

### 3.16 Communication Config

```
GET /api/leads/comm-config?tenantId={id}
```

**Response 200:**
```json
{
  "callPlatform": "native",
  "textPlatform": "podium",
  "callReady": true,
  "textReady": true,
  "callStatusMessage": "Using native phone dialer",
  "textStatusMessage": "Using Podium"
}
```

`callPlatform` / `textPlatform` values: `"native"`, `"callrail"`, `"podium"`, `"none"`.
`callReady` / `textReady`: `false` when platform is `"none"` (no comm platform configured).

### 3.17 Tenants List (Agency/Super Only)

```
GET /api/tenants
```

**Response 200:**
```json
[
  { "id": 1, "name": "Acme HVAC", "timezone": "America/New_York" },
  { "id": 2, "name": "Best Plumbing", "timezone": "America/Chicago" }
]
```

### 3.18 Funnel Types

```
GET /api/funnel-types?tenantId={id}
```

**Response 200:**
```json
[
  { "id": 1, "name": "HVAC", "tenantId": 1 },
  { "id": 2, "name": "Plumbing", "tenantId": 1 }
]
```

### 3.19 Podium OAuth

**Initiate connection:**
```
GET /api/oauth/podium/authorize
Authorization: Bearer <token>
```

**Response 200:**
```json
{ "authUrl": "https://api.podium.com/oauth/authorize?client_id=...&redirect_uri=...&state=..." }
```

Open `authUrl` in `ASWebAuthenticationSession`. The server handles the OAuth callback at `/api/oauth/podium/callback`.

**Disconnect:**
```
POST /api/oauth/podium/disconnect
Authorization: Bearer <token>
```

**Response 200:** `{ "success": true }`

---

## 4. Real-Time Events (Socket.io)

### 4.1 Connection

Use the `socket.io-client-swift` library (v16+).

```swift
let manager = SocketManager(
    socketURL: URL(string: "https://<DOMAIN>")!,
    config: [
        .path("/api/socket.io"),
        .forceWebsockets(true),
        .extraHeaders(["Authorization": "Bearer \(token)"])
    ]
)
let socket = manager.defaultSocket
socket.connect()
```

### 4.2 Join Tenant Room

After `connect`, emit with a **single integer** argument (not a dictionary):
```swift
socket.emit("join-tenant", tenantId)
```

> The server auto-joins agency/super users to all tenant rooms on connect. For `client_user`/`client_admin`, the server auto-joins their own tenant. The `join-tenant` event is primarily used by agency/super users switching tenants.

### 4.3 Events to Listen For

| Event | Payload | Action |
|-------|---------|--------|
| `new-lead` | `Lead` JSON | Insert into queue, play notification sound, show in-app banner |
| `lead-updated` | `Lead` JSON | Update lead in queue/detail if visible |
| `podium-message` | `PodiumMessage` JSON | Append to conversation if lead detail is open |
| `hud-stats` | `HudStats` JSON | Refresh HUD counters |
| `callback-due` | `{ leadId, leadName, callbackAt }` | Show local notification / in-app alert |

### 4.4 Lifecycle Management

- **Foreground**: Connect socket, join tenant room.
- **Background**: Disconnect socket. Rely on push notifications.
- **App termination**: Socket auto-disconnects.
- **Token refresh**: If auth fails, disconnect and reconnect with new token.
- **Tenant switch** (agency/super): Simply emit `join-tenant` with the new `tenantId` integer. There is no `leave-tenant` event — agency/super users are joined to all tenant rooms on connect. The server ignores duplicate joins.

---

## 5. Screen Specifications

### 5.1 Login Screen

**Route**: Shown when no valid token exists.

**Layout:**
- Full-screen dark background (`#0A0F1F`)
- Centered card with app logo at top
- `Email` text field (`.textContentType(.emailAddress)`, `.keyboardType(.emailAddress)`)
- `Password` secure field (`.textContentType(.password)`)
- `Sign In` button (full-width, red `#F20505`, 48pt height, 12pt corner radius)
- Error message text in red below button
- Loading spinner overlaid on button during request

**Behavior:**
1. Validate non-empty fields client-side.
2. `POST /api/auth/login`.
3. On success: store token in Keychain, store user in memory, connect socket, navigate to main tab view.
4. On error: show error message, shake the form.

### 5.2 Main Tab Bar

Three tabs at bottom:

| Tab | Icon | Label | Screen |
|-----|------|-------|--------|
| 1 | `chart.bar.fill` | Dashboard | HUD Screen |
| 2 | `tray.full.fill` | Queue | Queue Screen |
| 3 | `gearshape.fill` | Settings | Settings Screen |

Tab bar background: `#0B1224` with `#1E2A3E` top border.
Selected tint: `#F20505`. Unselected: `#8B919E`.

### 5.3 HUD Screen (Tab 1)

**Data**: `GET /api/leads/hud/stats`

**Header:**
- Title "Dashboard" in 28pt bold white
- If manager role: CSR filter dropdown (pill-shaped, shows "All CSRs" or selected name)
- If agency/super: Tenant selector above CSR filter
- Timeframe picker (horizontal pill buttons): Today | 7D | 30D | 90D

**Pause Banner** (CSRs only):
- If paused: amber banner showing pause status with toggle button
- If manager-paused: shows "Paused by manager" (non-toggleable)

**Stat Cards** (2-column grid, 12pt gap):

| Card | Value | Label | Color |
|------|-------|-------|-------|
| Calls Made | `callsMadeToday` | "Calls Made" | Cyan `#06B6D4` |
| New Leads | `newLeadsToday` | "New Leads" | Cyan `#06B6D4` |
| Bookings | `bookingsToday` | "Bookings" | Emerald `#10B981` |
| Booking Rate | `bookingRate` | "Booking %" | Emerald `#10B981` |
| Commission | `commission` | "Commission" | Amber `#F59E0B` |
| Avg Speed to Lead | `avgSpeedToLead` | "Speed to Lead" | Purple `#8B5CF6` |
| Sold | `soldToday` | "Sold" | Emerald `#10B981` |
| Bonus Tier | `bonusTier` | "Bonus Tier" | Gold/Silver/Bronze |

`avgSpeedToLead` is in seconds — format as "Xm Ys" or "Xh Ym".
`bonusTier` values: `"gold"` (#FFD700), `"silver"` (#C0C0C0), `"bronze"` (#CD7F32), or empty (#8B919E).

Each card:
- Background `#0B1224`, border `#1E2A3E`, corner radius 12pt
- Value in 32pt bold, label in 12pt `#8B919E`
- Subtle colored left accent bar (3pt wide)

**Pull-to-refresh**: Re-fetch stats.
**Socket**: Listen for `hud-stats` to update in real time.

### 5.4 Queue Screen (Tab 2)

**Data**: `GET /api/leads-hub/queue`

**Header:**
- Title "Queue" in 28pt bold white
- Badge showing `total` count
- If manager: CSR filter dropdown
- If agency/super: Tenant selector

**Pause Banner** (conditionally shown):
- If CSR is paused: amber banner "You are paused until {time}" with Resume button
- Pause/Resume via `POST /api/leads-hub/my-pause`

**Section Tabs** (horizontal scroll, underline-style buttons):

| Tab Key | Label | Icon | Color |
|---------|-------|------|-------|
| `new` | "New" | `zap` | `#EF4444` |
| `reengagement` | "Re-engage" | `refresh-cw` | `#8B5CF6` |
| `callbacks` | "Callbacks" | `phone-incoming` | `#F59E0B` |
| `old` | "Old" | `clock` | `#EF4444` |
| `archive` | "Archive" | `archive` | `#6B7280` |

Each tab shows a count badge. Active tab has a colored bottom border.

**Lead Cards** (vertical scroll list):

Each card:
- Background `#0B1224`, border `#1E2A3E`, 12pt radius
- **Top row**: Lead name (16pt semibold white), hub status badge (right-aligned)
- **Middle row**: Phone number (14pt `#8B919E`), source tag
- **Bottom row**: Funnel type, time indicator
- Tap → navigate to Lead Detail

**Status Badge Colors:**

| Status | Label | Background | Text |
|--------|-------|------------|------|
| `day_1` | "Day 1" | `#06B6D4` 20% | `#06B6D4` |
| `day_2` | "Day 2" | `#8B5CF6` 20% | `#8B5CF6` |
| `day_3` | "Day 3" | `#F59E0B` 20% | `#F59E0B` |
| `day_4` | "Day 4" | `#F97316` 20% | `#F97316` |
| `day_5_old` | "Old" | `#EF4444` 20% | `#EF4444` |
| `appt_set` | "Appt Set" | `#10B981` 20% | `#10B981` |
| `appt_booked` | "Appt Booked" | `#10B981` 20% | `#10B981` |
| `call_back` | "Callback" | `#F59E0B` 20% | `#F59E0B` |
| `dead` | "Dead" | `#6B7280` 20% | `#6B7280` |

**Callback section**: Show `callbackAt` as relative time ("in 2 hours", "overdue 30 min"). Sort by `callbackAt` ascending.

**Re-engagement section**: Show `attemptCount` and `lastAttemptAt`. If `nextPassAt` exists, show countdown "Auto-pass in {time}".

**Empty state**: Illustration + "No leads in queue" message.

**Pull-to-refresh**: Re-fetch queue.
**Socket**: Listen for `new-lead` (insert to new section) and `lead-updated` (update in-place or remove if status changed to terminal).

### 5.5 Lead Detail Screen

**Route**: Push navigation from Queue or Search. URL: `/lead/{id}`

**Data loading** (parallel):
1. `GET /api/leads/{id}?tenantId={id}` (if not passed from queue)
2. `GET /api/podium/timeline/{id}?tenantId={id}` (merged timeline of actions + messages)
3. `GET /api/podium/conversations/{id}?tenantId={id}` (for chat-style view)
4. `GET /api/leads/comm-config?tenantId={id}`
5. `POST /api/leads-hub/{id}/claim` (claim on appear)

**On disappear**: `POST /api/leads-hub/{id}/release-claim`

**Layout** (scrollable):

#### 5.5.1 Lead Header
- Back button (chevron.left)
- Lead name (20pt bold white)
- Hub status badge (right side)
- Source + funnel type tags below name

#### 5.5.2 Contact Info Card
- Phone: tappable, opens `tel:` URL
- Email: tappable, opens `mailto:` URL
- Address (if present)
- Service type
- Created date (relative)

#### 5.5.3 Action Buttons Row
Horizontal row of action buttons (only show enabled ones from comm-config):

| Button | Icon | Color | Action |
|--------|------|-------|--------|
| Call | `phone.fill` | Emerald | Open action sheet → log call |
| Text | `message.fill` | Cyan | Open action sheet → log text |
| VM Drop | `recordingtape` | Purple | Log voicemail drop |
| Transfer | `arrow.right.arrow.left` | Amber | Open transfer picker |

#### 5.5.4 Action Sheet (Modal)

When "Call" is tapped:
1. Open native dialer via `tel:{phone}`
2. When user returns, show bottom sheet:
   - "What happened?" title
   - Call result picker (segmented or list):
     - No Answer
     - Left Voicemail
     - VM Full
     - VM Not Set Up
     - Spoke with Customer
     - Hung Up
     - Bad Number
     - Blocked
     - Out of Service Area
   - If "Spoke with Customer":
     - "Set Appointment?" toggle
     - "Schedule Callback?" with date/time picker
   - "Mark as Dead?" toggle → shows dead reason text field
   - Notes text field
   - "Save" button

When "Text" is tapped:
1. Show bottom sheet:
   - Text result picker:
     - Responded (yes)
     - Not Able To
     - Dead
     - No Need
     - Reached Out
   - Notes text field
   - "Save" button

All actions call `POST /api/leads-hub/action`.

#### 5.5.5 Appointment Booked Actions

If `lead.hubStatus == "appt_booked"`, show special action buttons:
- **Confirm** (green) → `apptBookedOutcome: "confirmed"`
- **Reschedule** (amber) → `apptBookedOutcome: "rescheduled"`
- **Cancel** (red) → `apptBookedOutcome: "canceled"` + cancel reason

These outcomes require speaking with the customer first (call result `spoke_with_customer` or text result `yes`).

#### 5.5.6 Transfer Sheet

When Transfer is tapped:
1. Fetch `GET /api/leads-hub/csrs?tenantId={id}`
2. Show list of CSRs (exclude current assignee)
3. On select: `POST /api/leads-hub/{leadId}/transfer`
4. Show success toast, pop back to queue

#### 5.5.7 Messages Tab (Podium)

Tab picker: "Activity" | "Messages"

**Messages view:**
- Chat-bubble UI (iMessage style)
- Outbound messages: right-aligned, red/dark background
- Inbound messages: left-aligned, `#1E2A3E` background
- Sender name above inbound bubbles
- Timestamp below each bubble (relative)
- Compose bar at bottom: text field + send button
- Send via `POST /api/podium/messages`
- If `notConnected`: show banner "Podium not connected. Connect in Settings."

**Activity/Timeline view:**
- Merged chronological list from `GET /api/podium/timeline/{leadId}`
- Three entry types:
  - `pulse_action`: call/text/voicemail with icon + outcome + CSR name + timestamp + notes
  - `podium_text`: SMS message with direction arrow + body + sender name
  - `podium_call`: Phone call record with direction indicator
- Pulse actions are editable: tap to edit via `PUT /api/leads-hub/action/{attemptId}`
- Podium deep links open in Safari when tapped

#### 5.5.8 Lead Info Section (expandable)
- Notes / additional fields
- Assignment info: assigned CSR name, assigned date
- Auto-pass countdown if `nextPassAt` present

### 5.6 Settings Screen (Tab 3)

**Layout** (grouped list):

**Profile Section:**
- User name (non-editable display)
- Email (non-editable display)
- Role badge

**Account Section:**
- Change Password (navigates to sub-screen with old/new/confirm fields)
- Podium Connection status
  - If connected: "Connected" badge + "Disconnect" button
  - If not connected: "Connect Podium" button → opens `ASWebAuthenticationSession` to `/api/oauth/podium/authorize`

**Preferences Section:**
- Push Notifications toggle (registers/unregisters token)

**Danger Zone:**
- Sign Out button (red text, no background)

**Version footer**: "Pulse v{version} ({build})"

---

## 6. Design System

### 6.1 Color Tokens

```swift
enum PulseColors {
    static let background = Color(hex: "#0A0F1F")
    static let card = Color(hex: "#0B1224")
    static let cardHover = Color(hex: "#111B33")
    static let border = Color(hex: "#1E2A3E")
    static let borderLight = Color(hex: "#2A3A52")

    static let primary = Color(hex: "#F20505")        // Red — primary actions
    static let secondary = Color(hex: "#002D5E")       // Navy — secondary elements

    static let textPrimary = Color.white
    static let textSecondary = Color(hex: "#8B919E")    // Muted foreground
    static let textTertiary = Color(hex: "#6B7280")

    static let emerald = Color(hex: "#10B981")          // Success, booked
    static let amber = Color(hex: "#F59E0B")            // Warning, callbacks
    static let red = Color(hex: "#EF4444")              // Destructive, errors
    static let purple = Color(hex: "#8B5CF6")           // Contacted, voicemail
    static let cyan = Color(hex: "#06B6D4")             // New leads, info
    static let orange = Color(hex: "#F97316")            // Day 4

    static let tabBarBackground = Color(hex: "#0B1224")
    static let tabBarBorder = Color(hex: "#1E2A3E")
    static let tabBarSelected = Color(hex: "#F20505")
    static let tabBarUnselected = Color(hex: "#8B919E")
}
```

### 6.2 Typography

Font family: **Inter** (bundle via SPM or use system `.rounded` as fallback).

| Style | Weight | Size | Usage |
|-------|--------|------|-------|
| `largeTitle` | Bold (700) | 28pt | Screen titles |
| `title` | Semibold (600) | 20pt | Card titles, lead names |
| `headline` | Semibold (600) | 16pt | Section headers |
| `body` | Regular (400) | 14pt | Body text, descriptions |
| `callout` | Medium (500) | 14pt | Buttons, labels |
| `caption` | Regular (400) | 12pt | Timestamps, metadata |
| `statValue` | Bold (700) | 32pt | HUD stat numbers |

### 6.3 Spacing & Radius

| Token | Value |
|-------|-------|
| `paddingXS` | 4pt |
| `paddingSM` | 8pt |
| `paddingMD` | 12pt |
| `paddingLG` | 16pt |
| `paddingXL` | 24pt |
| `cornerRadius` | 12pt |
| `cornerRadiusSM` | 8pt |
| `cornerRadiusPill` | 999pt |
| `borderWidth` | 1pt |
| `cardShadow` | none (flat dark UI) |

### 6.4 Component Patterns

**Card:**
```
Background: PulseColors.card
Border: 1pt PulseColors.border
Corner radius: 12pt
Padding: 16pt
```

**Button (Primary):**
```
Background: PulseColors.primary
Foreground: white
Height: 48pt
Corner radius: 12pt
Font: callout weight
```

**Button (Secondary):**
```
Background: transparent
Border: 1pt PulseColors.border
Foreground: white
Height: 44pt
Corner radius: 12pt
```

**Badge/Pill:**
```
Horizontal padding: 8pt
Vertical padding: 4pt
Corner radius: 999pt (pill)
Font: caption
Background: color at 20% opacity
Text: full color
```

**Text Field:**
```
Background: PulseColors.card
Border: 1pt PulseColors.border (focus: PulseColors.primary)
Corner radius: 12pt
Padding: 12pt horizontal, 14pt vertical
Text color: white
Placeholder color: PulseColors.textSecondary
```

---

## 7. Data Models

### 7.1 Lead

```swift
struct Lead: Codable, Identifiable {
    let id: Int
    let tenantId: Int
    let firstName: String?
    let lastName: String?
    let email: String?
    let phone: String?
    let source: String?
    let leadType: String?
    let serviceType: String?
    let status: String             // "new", "contacted", "booked", "sold", "lost", "cancelled"
    let hubStatus: String?         // "day_1"..."day_5_old", "appt_set", "appt_booked", "call_back", "dead"
    let disposition: String?
    let funnelId: Int?
    let assignedTo: String?
    let assignedCsrId: Int?
    let assignedAt: String?        // ISO 8601
    let dayInSequence: Int
    let callbackAt: String?        // ISO 8601
    let deadReason: String?
    let visibleAfter: String?      // ISO 8601
    let cascadePassCount: Int?
    let manuallyTransferred: Bool?
    let bookedByCsrId: Int?
    let city: String?
    let state: String?
    let zip: String?
    let address: String?
    let notes: String?
    let createdAt: String           // ISO 8601
    let updatedAt: String           // ISO 8601

    var fullName: String {
        [firstName, lastName].compactMap { $0 }.joined(separator: " ")
    }
}
```

### 7.2 Lead (Queue Enriched)

```swift
struct QueueLead: Codable, Identifiable {
    // All Lead fields plus:
    let nextPassAt: String?
    let passIntervalMinutes: Int?
    let lastAttemptAt: String?      // Reengagement only
    let attemptCount: Int?          // Reengagement only
}
```

### 7.3 CallAttempt (History Entry)

```swift
struct CallAttempt: Codable, Identifiable {
    let id: Int
    let leadId: Int
    let userId: Int
    let method: String
    let outcome: String
    let platform: String
    let attemptedAt: String         // ISO 8601
    let notes: String?
    let actionType: String          // "call", "text", "voicemail_drop", "voicemail", "transfer", "system"
    let callResult: String?
    let vmResult: String?
    let textResult: String?
    let deadReason: String?
    let csrName: String
}
```

### 7.4 PodiumMessage

```swift
struct PodiumMessage: Codable, Identifiable {
    let id: Int
    let tenantId: Int
    let leadId: Int
    let podiumConversationUid: String
    let podiumMessageUid: String
    let direction: String           // "inbound" or "outbound"
    let body: String?
    let channelType: String         // "sms", "email", etc.
    let senderName: String?
    let deliveryStatus: String?
    let messageItems: [MessageItem]?
    let podiumCreatedAt: String     // ISO 8601
}

struct MessageItem: Codable {
    let type: String?
    let url: String?
    let mimeType: String?
}
```

### 7.5 User

```swift
struct User: Codable, Identifiable {
    let id: Int
    let email: String
    let name: String
    let role: String                // "client_user", "client_admin", "agency_user", "super_admin"
    let tenantId: Int
    let tenantName: String?
    let leaderboardConfig: LeaderboardConfig?
}

struct LeaderboardConfig: Codable {
    let visible: Bool
    let displayMode: String         // "named" or "anonymized"
}
```

### 7.6 HudStats

```swift
struct HudStats: Codable {
    let callsMadeToday: Int
    let bookingsToday: Int
    let bookingRate: Double
    let commission: Double
    let newLeadsToday: Int
    let avgSpeedToLead: Double      // seconds
    let soldToday: Int?
    let bonusTier: String?          // "gold", "silver", "bronze", or nil
    let bonusThreshold: Int?
    let nextBonusAt: Int?
}
```

### 7.7 CSR

```swift
struct CSR: Codable, Identifiable {
    let id: Int
    let name: String
    let email: String
}
```

### 7.8 Tenant

```swift
struct Tenant: Codable, Identifiable {
    let id: Int
    let name: String
    let timezone: String
}
```

### 7.9 QueueResponse

```swift
struct QueueResponse: Codable {
    let newLeads: [QueueLead]
    let callbacks: [QueueLead]
    let reengagement: [QueueLead]
    let oldLeads: [QueueLead]
    let total: Int
    let timezone: String
}
```

### 7.10 CommConfig

```swift
struct CommConfig: Codable {
    let callPlatform: String        // "native", "callrail", "podium", "none"
    let textPlatform: String
    let callReady: Bool
    let textReady: Bool
    let callStatusMessage: String
    let textStatusMessage: String
}
```

### 7.11 PauseState

```swift
struct PauseState: Codable {
    let isPaused: Bool
    let pauseSource: String         // "self" or "manager"
}
```

### 7.12 TimelineEntry

```swift
enum TimelineEntryType: String, Codable {
    case pulseAction = "pulse_action"
    case podiumText = "podium_text"
    case podiumCall = "podium_call"
}

struct TimelineEntry: Codable, Identifiable {
    let type: TimelineEntryType
    let source: String              // "pulse" or "podium"
    let timestamp: String           // ISO 8601
    let id: Int

    // Pulse action fields (present when type == .pulseAction)
    let leadId: Int?
    let userId: Int?
    let method: String?
    let outcome: String?
    let actionType: String?
    let callResult: String?
    let vmResult: String?
    let textResult: String?
    let deadReason: String?
    let notes: String?
    let csrName: String?

    // Podium fields (present when type == .podiumText or .podiumCall)
    let direction: String?          // "inbound" or "outbound"
    let body: String?
    let channelType: String?
    let senderName: String?
    let deliveryStatus: String?
    let podiumMessageUid: String?
    let podiumConversationUid: String?
    let podiumDeepLink: String?
    let messageItems: [MessageItem]?
}
```

---

## 8. Push Notifications

### 8.1 Current Server Architecture (Expo Push)

The server currently sends push notifications via the **Expo Push Notification Service** (`https://exp.host/--/api/v2/push/send`) in `services/push-notifications.ts`. This works because the existing mobile app is built with Expo, which provides Expo Push Tokens (e.g., `ExponentPushToken[xxxxx]`).

A native Swift app cannot obtain Expo Push Tokens — it uses APNs device tokens instead. The `POST /api/push-tokens` endpoint accepts any string token, but the server will attempt to send it via Expo's API, which will fail for raw APNs tokens.

### 8.2 Token Registration API (Existing)

```
POST /api/push-tokens
Authorization: Bearer <token>
Content-Type: application/json

{
  "token": "<token string>",
  "platform": "ios"
}
```

**Response 200:** `{ "success": true, "id": 1 }`

### 8.3 Token Unregistration API (Existing)

On logout or when user disables notifications:

```
DELETE /api/push-tokens
Authorization: Bearer <token>
Content-Type: application/json

{
  "token": "<token string>"
}
```

**Response 200:** `{ "success": true }`

### 8.4 Notification Data Shape

The server sends notifications with this data payload (used by both Expo and the future APNs adapter):

```json
{
  "title": "New Lead Assigned",
  "body": "John Smith — Google Ads",
  "leadId": 100,
  "type": "new-lead"
}
```

**Notification types sent by server:**

| Type | Trigger | Action on tap |
|------|---------|---------------|
| `new-lead` | Lead assigned to CSR | Navigate to Lead Detail for `leadId` |
| `callback-due` | Callback time reached | Navigate to Lead Detail for `leadId` |

### 8.5 Required Server Change: APNs Adapter

To support native Swift push notifications, add an APNs sending path to `services/push-notifications.ts`. The change is localized to one file:

**What to add**: In the `sendPushToUser` function, after the Expo token block (line ~120), add an APNs block:

```typescript
const apnsTokens = tokens.filter(t => t.platform === "ios");
if (apnsTokens.length > 0) {
  for (const t of apnsTokens) {
    await sendAPNS(t.token, { title, body, data });
  }
}
```

The `sendAPNS` function should use the `@parse/node-apn` package (or raw HTTP/2 to `api.push.apple.com`) with:
- **APNs key**: `.p8` key file from Apple Developer portal
- **Key ID**, **Team ID**, **Bundle ID**: configured via environment variables
- **Payload**:
```json
{
  "aps": {
    "alert": { "title": "...", "body": "..." },
    "sound": "default",
    "badge": 1
  },
  "leadId": 100,
  "type": "new-lead"
}
```

The existing `platform` field in `push_tokens` table already supports `"ios"` to distinguish from Expo tokens (which use `"expo"` as default platform).

### 8.6 Swift Client Implementation

**Registration:**
```swift
func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    let tokenString = deviceToken.map { String(format: "%02x", $0) }.joined()
    // POST to /api/push-tokens with { token: tokenString, platform: "ios" }
}
```

**Notification handling:**
```swift
func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) {
    let userInfo = response.notification.request.content.userInfo
    if let leadId = userInfo["leadId"] as? Int {
        // Navigate to Lead Detail
    }
}
```

### 8.7 Deep Link Handling

When notification is tapped:
1. If app is in foreground: push Lead Detail onto navigation stack.
2. If app is in background/terminated: store `leadId` in launch state, navigate after auth restore completes.

---

## 9. Swift Architecture Recommendations

### 9.1 Project Structure

```
PulseApp/
├── App/
│   ├── PulseApp.swift              // @main, WindowGroup
│   └── AppState.swift              // Root ObservableObject
├── Core/
│   ├── Network/
│   │   ├── APIClient.swift         // URLSession wrapper, auth header injection
│   │   ├── APIEndpoint.swift       // Enum of all endpoints
│   │   └── APIError.swift          // Error types
│   ├── Auth/
│   │   ├── AuthManager.swift       // Login, logout, token management
│   │   └── KeychainService.swift   // Keychain read/write
│   ├── Socket/
│   │   └── SocketManager.swift     // Socket.io connection, event handlers
│   └── Push/
│       └── PushManager.swift       // APNs registration, notification handling
├── Models/
│   ├── Lead.swift
│   ├── CallAttempt.swift
│   ├── PodiumMessage.swift
│   ├── User.swift
│   ├── HudStats.swift
│   └── ...
├── Features/
│   ├── Login/
│   │   ├── LoginView.swift
│   │   └── LoginViewModel.swift
│   ├── HUD/
│   │   ├── HUDView.swift
│   │   └── HUDViewModel.swift
│   ├── Queue/
│   │   ├── QueueView.swift
│   │   ├── QueueViewModel.swift
│   │   └── LeadCardView.swift
│   ├── LeadDetail/
│   │   ├── LeadDetailView.swift
│   │   ├── LeadDetailViewModel.swift
│   │   ├── ActionSheetView.swift
│   │   ├── MessagesView.swift
│   │   ├── ActivityView.swift
│   │   └── TransferSheet.swift
│   ├── Search/
│   │   ├── SearchView.swift
│   │   └── SearchViewModel.swift
│   └── Settings/
│       ├── SettingsView.swift
│       └── ChangePasswordView.swift
├── Components/
│   ├── StatCard.swift
│   ├── StatusBadge.swift
│   ├── PulseButton.swift
│   ├── PulseTextField.swift
│   ├── CSRFilterPicker.swift
│   ├── TenantSelector.swift
│   └── ChatBubble.swift
├── Design/
│   ├── PulseColors.swift
│   ├── PulseTypography.swift
│   └── PulseSpacing.swift
└── Resources/
    ├── Assets.xcassets
    └── Inter.ttf (font files)
```

### 9.2 Architecture Pattern

Use **MVVM** with `@Observable` (iOS 17+) or `ObservableObject` (iOS 16 compat):

```swift
@Observable
class QueueViewModel {
    var queue: QueueResponse?
    var isLoading = false
    var error: String?
    var selectedTab: QueueTab = .all

    private let api: APIClient

    func loadQueue() async { ... }
    func claimLead(_ id: Int) async { ... }
}
```

### 9.3 Networking Layer

Single `APIClient` class:

```swift
actor APIClient {
    private let session: URLSession
    private let baseURL: URL
    private let authManager: AuthManager

    init(baseURL: URL, authManager: AuthManager) {
        self.baseURL = baseURL
        self.authManager = authManager
        let config = URLSessionConfiguration.default
        config.httpAdditionalHeaders = [
            "User-Agent": "PulseSwift/1.0 (react-native)"
        ]
        self.session = URLSession(configuration: config)
    }

    func request<T: Decodable>(
        _ endpoint: APIEndpoint,
        method: HTTPMethod = .get,
        body: Encodable? = nil
    ) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(endpoint.path))
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let token = await authManager.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        if httpResponse.statusCode == 401 {
            await authManager.clearSession()
            throw APIError.unauthorized
        }

        guard 200..<300 ~= httpResponse.statusCode else {
            let errorBody = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            throw APIError.server(httpResponse.statusCode, errorBody?.error)
        }

        return try JSONDecoder().decode(T.self, from: data)
    }
}
```

### 9.4 Tenant Context

Create a `TenantContext` environment object that holds the active `tenantId`. All ViewModels read from it:

```swift
@Observable
class TenantContext {
    var activeTenantId: Int
    var activeTenantName: String
    var availableTenants: [Tenant] = []

    var showTenantSelector: Bool {
        // true for agency_user and super_admin
    }
}
```

Pass `tenantId` as query parameter on every API call: `?tenantId=\(context.activeTenantId)`.

### 9.5 CSR Filter Context

```swift
@Observable
class CSRFilterContext {
    var selectedCSRId: Int?           // nil = "All CSRs"
    var availableCSRs: [CSR] = []

    var showCSRFilter: Bool {
        // true for client_admin, agency_user, super_admin
    }
}
```

### 9.6 Socket.io Integration

Use the `SocketIO` Swift package (https://github.com/socketio/socket.io-client-swift).

```swift
class PulseSocketManager: ObservableObject {
    private var manager: SocketManager?
    private var socket: SocketIOClient?

    func connect(token: String, domain: String) {
        manager = SocketManager(
            socketURL: URL(string: domain)!,
            config: [
                .path("/api/socket.io"),
                .forceWebsockets(true),
                .extraHeaders(["Authorization": "Bearer \(token)"]),
                .reconnects(true),
                .reconnectWait(3)
            ]
        )
        socket = manager?.defaultSocket

        socket?.on(clientEvent: .connect) { [weak self] _, _ in
            self?.joinTenant()
        }

        socket?.on("new-lead") { data, _ in
            // Parse Lead JSON, notify via Combine/AsyncStream
        }

        socket?.on("lead-updated") { data, _ in
            // Parse Lead JSON, update in-memory state
        }

        socket?.on("podium-message") { data, _ in
            // Parse PodiumMessage JSON
        }

        socket?.on("hud-stats") { data, _ in
            // Parse HudStats JSON
        }

        socket?.on("callback-due") { data, _ in
            // Show local notification
        }

        socket?.connect()
    }

    func joinTenant(tenantId: Int) {
        socket?.emit("join-tenant", tenantId)
    }

    func disconnect() {
        socket?.disconnect()
        manager = nil
    }
}
```

### 9.7 Dependencies

| Package | Purpose | Source |
|---------|---------|--------|
| `SocketIO` | Socket.io client | `https://github.com/socketio/socket.io-client-swift` |
| `KeychainAccess` | Keychain wrapper | `https://github.com/kishikawakatsumi/KeychainAccess` |

No other third-party dependencies are required. Use native SwiftUI for all UI, `URLSession` for networking, and `UserNotifications` for push.

### 9.8 Minimum Deployment Target

- **iOS 16.0** (for wide device support)
- Use `@Observable` macro if targeting iOS 17+, otherwise `ObservableObject`

### 9.9 Error Handling Strategy

- Network errors: show inline error banner with retry button (not alerts)
- 401 responses: auto-logout, navigate to login
- 409 (claim conflict): show toast "Lead is being worked by another CSR"
- 403 (reassigned): show toast "Lead has been reassigned", pop to queue
- Offline: show persistent banner "No connection", queue actions locally if feasible

### 9.10 JSON Decoding Strategy

Use `JSONDecoder` with:
```swift
let decoder = JSONDecoder()
decoder.keyDecodingStrategy = .convertFromSnakeCase
decoder.dateDecodingStrategy = .iso8601
```

All date fields in the API are ISO 8601 strings. Decode to `String` and convert to `Date` as needed for display using `RelativeDateTimeFormatter`.

---

## Appendix A: Hub Status State Machine

```
            ┌─────────────┐
            │   day_1      │ ← New lead arrives
            └──────┬───────┘
                   │ no_answer / vm
            ┌──────▼───────┐
            │   day_2      │
            └──────┬───────┘
                   │ no_answer / vm
            ┌──────▼───────┐
            │   day_3      │
            └──────┬───────┘
                   │ no_answer / vm
            ┌──────▼───────┐
            │   day_4      │
            └──────┬───────┘
                   │ no_answer / vm
            ┌──────▼───────┐
            │  day_5_old   │ (also via 5+ unresponsive or 5-day age)
            └──────────────┘

    spoke_with_customer + callbackAt → call_back
    spoke_with_customer + appointmentSet → appt_set
    appt_booked (from external booking) → appt_booked
    deadReason → dead

    appt_booked + confirmed → appt_set
    appt_booked + rescheduled → appt_booked
    appt_booked + canceled → dead
```

## Appendix B: API Error Shape

All error responses use the same shape:
```json
{
  "error": "Human-readable error message"
}
```

HTTP status codes used:
- `200` — Success
- `400` — Validation error
- `401` — Not authenticated / token expired
- `403` — Not authorized (role or assignment)
- `404` — Resource not found
- `409` — Conflict (claim)
- `500` — Server error

## Appendix C: Checklist for Code Generation

- [ ] Xcode project with SwiftUI lifecycle
- [ ] Inter font bundled and registered in Info.plist
- [ ] `PulseColors.swift` with all color tokens
- [ ] `APIClient.swift` with Bearer token injection
- [ ] `KeychainService.swift` for secure token storage
- [ ] `AuthManager.swift` with login/logout/restore flow
- [ ] `PulseSocketManager.swift` with all 5 event handlers
- [ ] `PushManager.swift` with APNs registration + notification routing
- [ ] Login screen with error handling
- [ ] Tab bar with 3 tabs (Dashboard, Queue, Settings)
- [ ] HUD screen with stat cards + timeframe picker (Today/7D/30D/90D) + CSR filter
- [ ] Queue screen with 5 sections (New/Re-engage/Callbacks/Old/Archive) + pull-to-refresh + real-time updates
- [ ] Lead Detail screen with claim/release, action logging, transfer, timeline + messages
- [ ] Settings screen with password change, Podium connect, sign out
- [ ] Deep link handling from push notification tap
- [ ] Tenant selector for agency/super roles
- [ ] CSR filter for manager roles
- [ ] All data models with Codable conformance
- [ ] Error banner component (not alerts)
- [ ] Loading states on all screens
- [ ] Empty states on all screens
- [ ] Pull-to-refresh on HUD and Queue
