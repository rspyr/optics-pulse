# Vance Tracker Capture Diagnosis (4/14–4/19)

## Symptom

Vance (`tenant_id = 3`) was switched to **tracker-only** ingestion before
4/14. Between 4/14 and 4/19 the System Health card on Attribution showed
`tracker_status = healthy` (heartbeats arriving from
`vance.protect.neighborhood-hvac.com` every 5 min), but Pulse showed **0 new
leads** for that window. Operations confirmed **7 Meta-sourced leads** had
landed in the tenant's Google Sheet over the same window — meaning the
forms were submitting and the sheet's downstream Zap was firing, but
`pulse.js` on the landing page never produced an `attribution_event`.

## What "Healthy" actually meant

`pulse.js` sends a heartbeat the moment the script tag loads — there is no
gate that requires a successful form capture. So `tracker_heartbeats`
filling up cleanly only proves the snippet is on the page; it proves
nothing about whether real submits are being captured.

## Binding constraint on Vance's landing page

The Meta ad routes to `vance.protect.neighborhood-hvac.com/quote`, which
is built in **Framer** and embeds a **GoHighLevel / LeadConnector** form
widget inside a **cross-origin iframe** (`form.leadconnectorhq.com`).

This combination defeated the pre-hardening `pulse.js` for two reasons:

1. **Cross-origin iframe** — pulse.js cannot reach into
   `iframe.contentDocument` to bind a `submit` listener; the browser
   throws `SecurityError`. The widget's submit happens entirely inside
   the iframe and never bubbles into the parent document.
2. **No native `<form>` in the parent** — the visible CTA is a Framer
   button styled like a "Get Quote" button. It opens the GHL widget in a
   modal, but the parent page itself never produces a `submit` event for
   the bubble-phase listener to catch.

The existing handlers for HubSpot (`hsFormCallback`) and Typeform
(`form-submit`) were the only `postMessage` paths registered, so the GHL
widget's `{ type: "form_submission", payload: {...} }` postMessage was
ignored. Heartbeats kept flowing because the parent script tag was still
loaded; events stayed at zero because nothing could see the submit.

## What the hardening fixes

- Added a `postMessage` handler covering both observed GHL shapes
  (`type: "form_submission"`, `type: "leadconnector_form_submitted"`,
  and `event: "form_submitted"` with `payload.fields`). See
  `pulse.js` lines 601-621.
- Added an opt-in **button-click fallback** for non-`<form>` CTAs (gated
  by config flag so it doesn't fire on every page button).
- Bound `submit` listeners in **capture phase** so any in-page
  `stopPropagation()` from a third-party widget can't shadow us on
  pages that *do* have a real `<form>`.
- Recursively scan **same-origin iframes** and **open shadow roots** on
  initial load and on MutationObserver events.
- Added a **per-domain System Health** view: a tenant whose tracker
  heartbeats are healthy but whose `recentEventCount = 0` over the last
  24h now shows an **amber "Tracker loaded but 0 events captured"**
  warning instead of green, with the affected domain shown and a link
  to the Verify Tracker tool.
- Added the **Verify Tracker** tool (admin-only) so an operator can
  paste a landing-page URL, confirm `pulse.js` is reachable from that
  domain (with SSRF + DNS-rebinding hardening), and copy the snippet
  reminder.
- Added a **`?pulse_debug=1` overlay** that lists every form pulse
  bound to, every submit it captured (field names only — no PII
  values), and every submit it rejected with a reason.

## Recovery for the lost 7 leads

The seven leads from 4/14–4/19 are recovered with the one-shot
backfill script (`artifacts/api-server/src/scripts/backfill-tenant-sheet-leads.ts`), which
reads the Vance sheet directly for the date range and writes into the
`leads` table preserving original timestamps and stamping every
recovered row with the Meta UTM defaults on a paired `attribution_event`.
The script does **not** unpause `google_sheet_configs.syncPaused` and
does **not** flip `tenants.lead_ingestion_mode` back to `sheets`/`both`
— tracker-only mode is preserved.

Run with `--dry-run` first to confirm the 7-row count, then drop
`--dry-run` to commit. See the script's header for the exact
invocation.
