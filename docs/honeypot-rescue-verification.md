# Honeypot-Rescue Production Verification (Task #293)

Follow-up to Task #292: confirm in production data that pulse.js
v2026.04.26 is now capturing real Name / Phone / Email on pages whose
visible form was previously a honeypot-only shell.

## TL;DR

The verification has three checks. They split cleanly into
"blocked by deploy" and "verifiable now":

| # | Check                                                                                          | Verifiable now?  | Result   |
|---|------------------------------------------------------------------------------------------------|------------------|----------|
| 1 | Submits from affected hosts now contain `name`/`phone`/`email` (not just `company_url`)         | Blocked by deploy| NOT MET  |
| 2 | Those submits are labelled `honeypot-rescue` instead of `native`                                | Blocked by deploy| NOT MET  |
| 3 | `/api/verify-tracker` "Honeypot-only form detected" warning fires, then clears after recache    | Yes (static-HTML driven)| NOT MET — and will not fire post-deploy either, see §4 |

Root cause for #1 and #2: the v2026.04.26 build has not shipped to
production. Every submit row in `tracker_submit_attempts` for the last
30 days carries `pulse_version='2026.04.25'` (or NULL for legacy
clients). The fix code is on disk (`PULSE_VERSION = "2026.04.26"` in
`artifacts/api-server/public/pulse.js`) but customer browsers are still
running the prior bundle.

Per the task's "if unmet, list pages still failing and what shape they
have" branch, evidence and per-page list are below.

## Schema note (deviation from task brief)

The brief mentions tables `tracker_form_submissions` and
`tracker_form_scans`. Those names do not exist in the current schema.
The actual audit log for `/api/collect/{submit,heartbeat,diagnostics}`
is `tracker_submit_attempts`, discriminated by the `kind` column
(`submit` / `heartbeat` / `diagnostic`). There is no separate scans
table — form-scan diagnostics from `?pulse_capture=1` are written as
`kind='diagnostic'` rows in the same table. All queries below use the
real schema.

Also: `tracker_submit_attempts.payload_sample` is intentionally always
`NULL` (field-names-only audit policy). We can therefore verify the
**shape** of submits from `supplied_field_names` (just the names) but
not the values themselves; values surface in
`attribution_events.form_fields` once a submit is accepted.

## Evidence — checks #1 and #2 (blocked by deploy)

### Pulse version distribution

```sql
SELECT pulse_version, COUNT(*) AS rows, MIN(created_at), MAX(created_at)
FROM tracker_submit_attempts
WHERE created_at > now() - interval '30 days'
GROUP BY pulse_version;
```

| pulse_version | rows | first_seen           | last_seen            |
|---------------|------|----------------------|----------------------|
| (NULL)        | 27   | 2026-04-26 01:35:04  | 2026-04-27 00:31:56  |
| 2026.04.25    | 1701 | 2026-04-26 01:24:46  | 2026-04-27 02:46:47  |

No rows for `2026.04.26`. The fix is not live.

### attribution_events.form_type (last 7d, form_fill)

```sql
SELECT form_type, COUNT(*) AS rows, MAX(created_at) AS last_seen
FROM attribution_events
WHERE created_at > now() - interval '7 days' AND event_type = 'form_fill'
GROUP BY form_type;
```

| form_type        | rows |
|------------------|------|
| native           | 18   |
| button-fallback  | 1    |

Zero `honeypot-rescue` rows.

### Pages still emitting honeypot-only payloads (last 7d)

```sql
SELECT domain,
       COUNT(*) FILTER (
         WHERE supplied_field_names::text ILIKE '%company_url%'
           AND supplied_field_names::text NOT ILIKE '%phone%'
           AND supplied_field_names::text NOT ILIKE '%email%'
       ) AS honeypot_only,
       COUNT(*) AS total
FROM tracker_submit_attempts
WHERE created_at > now() - interval '7 days' AND kind = 'submit'
GROUP BY domain
HAVING COUNT(*) FILTER (
         WHERE supplied_field_names::text ILIKE '%company_url%'
           AND supplied_field_names::text NOT ILIKE '%phone%'
           AND supplied_field_names::text NOT ILIKE '%email%'
       ) > 0
ORDER BY honeypot_only DESC;
```

| domain                                 | honeypot_only | total | tenant                          |
|----------------------------------------|---------------|-------|---------------------------------|
| vance.protect.neighborhood-hvac.com    | 3             | 3     | Vance Heating (id 4)            |
| protect.advantageheatingllc.com        | 1             | 2     | Advantage Heating & Cooling (3) |
| fit.advantageheatingllc.com            | 1             | 1     | Advantage Heating & Cooling (3) |

All three pages send exactly the shape the rescue path is designed to
fix:

```json
["fields.company_url", "form.id", "form.name", "form.type", "form.action"]
```

i.e. the only `fields.*` key is the `company_url` honeypot — no
`fields.name`, `fields.email`, `fields.phone`. All such rows carry
`pulse_version = '2026.04.25'`.

For a single-row drilldown:

```sql
SELECT page_url, supplied_field_names, pulse_version, outcome, created_at
FROM tracker_submit_attempts
WHERE created_at > now() - interval '24 hours'
  AND kind = 'submit'
  AND domain = 'vance.protect.neighborhood-hvac.com'
ORDER BY created_at DESC
LIMIT 10;
```

| page_url                                                          | supplied_field_names                                                                                  | pulse_version | outcome  | created_at                |
|-------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|---------------|----------|---------------------------|
| https://vance.protect.neighborhood-hvac.com/?pulse_capture=1     | `["fields.company_url","form.id","form.name","form.type","form.action"]`                              | 2026.04.25    | accepted | 2026-04-26 21:10:51.890  |

### Tenants impacted

```sql
SELECT t.id, t.name AS tenant_name, t.client_slug
FROM tenants t
WHERE EXISTS (
  SELECT 1 FROM tracker_submit_attempts s
  WHERE s.tenant_id = t.id
    AND s.created_at > now() - interval '7 days'
    AND s.kind = 'submit'
    AND s.supplied_field_names::text ILIKE '%company_url%'
    AND s.supplied_field_names::text NOT ILIKE '%phone%'
    AND s.supplied_field_names::text NOT ILIKE '%email%'
)
ORDER BY t.id;
```

| id | tenant_name                  | client_slug                  |
|----|------------------------------|------------------------------|
| 3  | Advantage Heating & Cooling  | advantage-heating-cooling    |
| 4  | Vance Heating                | vance-heating                |

### Capture-mode diagnostics on affected hosts

```sql
SELECT domain, COUNT(*)
FROM tracker_submit_attempts
WHERE created_at > now() - interval '30 days' AND kind = 'diagnostic'
GROUP BY domain;
```

Returns zero rows. Nobody has visited any page with `?pulse_capture=1`
in the last 30 days, so we have no runtime form-scan diagnostics in
the DB.

## §4 Evidence — check #3, the verify-tracker warning (verifiable now)

The "Honeypot-only form detected" warning in
`artifacts/api-server/src/routes/verify-tracker.ts` (line 735) is
keyed off `formInventoryHasHoneypotOnlyShape(formInventory)`, where
`formInventory` is built by `buildFormInventory(page.body, targetUrl)`
— a regex parse over the **statically-fetched HTML body** of the
target page. It is not driven by `tracker_submit_attempts` rows at
all. (My initial draft of this doc said otherwise; that was wrong.)

So check #3 can be verified right now by replicating the same static
fetch + parse against each affected host. Result:

| host                                  | HTTP | bytes | `<form>` count | iframes (non-GTM)  | honeypot-only? |
|---------------------------------------|------|-------|----------------|--------------------|----------------|
| vance.protect.neighborhood-hvac.com   | 200  | 4449  | 0              | 0 (just GTM noscript) | false       |
| protect.advantageheatingllc.com       | 200  | 3695  | 0              | 0 (just GTM noscript) | false       |
| fit.advantageheatingllc.com/pricing   | 200  | 2503  | 0              | 0 (just GTM noscript) | false       |

Reproducer (Node ≥18; uses the same regex/normalisation as
`buildFormInventory` / `formInventoryHasHoneypotOnlyShape`):

```js
const HONEYPOT = new Set([
  "company_url","honeypot","bot_field","leave_blank",
  "_gotcha","form_honeypot","winnie_the_pooh",
]);
const norm = (n) => n.toLowerCase().replace(/[\s-]/g, "_");

function inventoryAndCheck(html) {
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  const forms = []; let fm, count = 0;
  while ((fm = formRe.exec(html)) !== null && count++ < 100) {
    const inner = fm[2] || "";
    const fieldRe = /<(?:input|select|textarea)\b[^>]*\bname\s*=\s*(['"])([^'"]+)\1/gi;
    const names = new Set(); let nm;
    while ((nm = fieldRe.exec(inner)) !== null) {
      names.add(nm[2]); if (names.size >= 50) break;
    }
    forms.push({ fieldNames: [...names] });
  }
  let honeypotOnly = false;
  for (const f of forms) {
    if (!f.fieldNames.length) continue;
    if (f.fieldNames.every(n => HONEYPOT.has(norm(n)))) { honeypotOnly = true; break; }
  }
  return { formCount: forms.length, honeypotOnly };
}

const targets = [
  "https://vance.protect.neighborhood-hvac.com/",
  "https://protect.advantageheatingllc.com/",
  "https://fit.advantageheatingllc.com/pricing",
];
for (const url of targets) {
  const res = await fetch(url, { redirect: "follow" });
  const html = await res.text();
  console.log(url, res.status, inventoryAndCheck(html));
}
```

### What this means

For these three customer pages the warning **does not fire today and
will not fire post-deploy either**. The pages are SPA / Framer pages
that mount the form widget at runtime via JavaScript; the SSR'd HTML
contains zero `<form>` tags, so the static-HTML inventory has nothing
to classify as honeypot-only.

The warning is still correct for its design target — pages where the
honeypot-only `<form>` shell *is* in the SSR HTML (e.g. a directly
embedded GHL `<form>` with `name="company_url"` as the only input) —
but those happen not to be the shape these three customers are
serving. For the SPA case, the existing "No `<form>` tags or
recognised form-builder iframes found in the static HTML" info-level
finding (verify-tracker.ts line 714) already steers operators to
`?pulse_capture=1`, which IS where the rescue path leaves a signal.

So check #3 is operationally **not met** for the affected hosts, but
the gap is in the warning's coverage rather than in the rescue path.
The runtime rescue itself still applies to these pages — once
v2026.04.26 ships, checks #1 and #2 will (per the code path in
pulse.js around lines 696–754) start producing `honeypot-rescue`
events on these same hosts.

## Done-looks-like assessment

| Criterion (from task)                                                                                            | Status |
|------------------------------------------------------------------------------------------------------------------|--------|
| `tracker_form_submissions` 24h post-ship shows real `name`/`phone`/`email` keys, not just `company_url`           | NOT MET — fix not deployed; honeypot-only shape persists on all 3 pages |
| Submissions labelled `honeypot-rescue` instead of `native`                                                        | NOT MET — zero `honeypot-rescue` rows in `attribution_events` |
| `/api/verify-tracker` "Honeypot-only form detected" warning fires for affected hosts and clears once page recaches | NOT MET — affected hosts have zero static `<form>` tags, so the warning's input is empty regardless of pulse.js version. Documented as a coverage gap (see §4). |
| Note posted to Task #292 thread                                                                                   | This document is that note (no thread system in repo) |

## Recommended follow-up

1. Ship the v2026.04.26 build (deploy `artifacts/api-server`) and let
   customer browsers / CDN bust the cached v2026.04.25 bundle.
2. Re-run the "Pages still emitting honeypot-only payloads" query 24 h
   after the new build is in place. Expectation: those three rows drop
   off as new submits arrive with real `fields.name` / `fields.phone` /
   `fields.email` keys and `pulse_version = '2026.04.26'`.
3. Re-run the `attribution_events.form_type` query. Expectation: a
   non-zero `honeypot-rescue` count, all from those same hosts.
4. (Optional, separately scoped) Extend the verify-tracker warning to
   cover SPA/Framer pages — e.g. flag when the page has zero static
   `<form>` AND a known SPA marker (Framer header, GHL builder asset,
   etc.) so the operator at least gets a "you'll need
   `?pulse_capture=1` to verify this page" nudge specific to the
   honeypot failure mode rather than the generic "no forms found"
   info finding.

All SQL above is read-only and safe to re-run any time; the JS in §4
is a faithful port of the production warning's input pipeline.
