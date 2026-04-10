import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

function requireManagerRole(req: Request, res: Response, next: NextFunction) {
  const role = (req.session as Record<string, unknown>)?.userRole as string | undefined;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied. Requires manager role." });
    return;
  }
  next();
}

function resolveTenantId(req: Request): number | null {
  const session = req.session as Record<string, unknown>;
  const role = session?.userRole as string | undefined;
  if (role === "super_admin" || role === "agency_user") {
    return req.query.tenantId ? Number(req.query.tenantId) : (session.tenantId as number | null) ?? null;
  }
  return (session?.tenantId as number | null) ?? null;
}

router.use("/ingestion-mode", requireManagerRole);

router.get("/ingestion-mode", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const [tenant] = await db.select({ leadIngestionMode: tenantsTable.leadIngestionMode })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));

  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  res.json({ mode: tenant.leadIngestionMode });
});

router.put("/ingestion-mode", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { mode } = req.body;
  const valid = ["sheets", "both", "tracker"];
  if (!mode || !valid.includes(mode)) {
    res.status(400).json({ error: `mode must be one of: ${valid.join(", ")}` });
    return;
  }

  await db.update(tenantsTable)
    .set({ leadIngestionMode: mode, updatedAt: new Date() })
    .where(eq(tenantsTable.id, tenantId));

  res.json({ success: true, mode });
});

router.get("/ingestion-mode/gtm-snippet", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const [tenant] = await db.select({ clientSlug: tenantsTable.clientSlug })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));

  if (!tenant || !tenant.clientSlug) {
    res.status(404).json({ error: "Tenant not found or missing client slug" });
    return;
  }

  const apiBase = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/api-server`
    : process.env.API_BASE_URL || "";

  const snippet = `<script>
(function(){
  var TRACKER_URL = "${apiBase}/api/tracker/submit";
  var CLIENT_ID = "${tenant.clientSlug}";

  function getParams() {
    var params = {};
    var search = window.location.search.substring(1);
    if (!search) return params;
    search.split("&").forEach(function(pair) {
      var kv = pair.split("=");
      params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
    });
    return params;
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
    return match ? match[2] : null;
  }

  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + (days * 86400000));
    document.cookie = name + "=" + value + ";expires=" + d.toUTCString() + ";path=/;SameSite=Lax";
  }

  var params = getParams();
  var attrKeys = ["gclid","wbraid","fbclid","msclkid","ttclid","li_fat_id","utm_source","utm_medium","utm_campaign","utm_term","utm_content"];
  attrKeys.forEach(function(k) {
    if (params[k]) setCookie("_pulse_" + k, params[k], 90);
  });

  if (!getCookie("_pulse_landing")) {
    setCookie("_pulse_landing", window.location.href, 90);
  }

  window.__pulseTracker = {
    submitForm: function(formFields, options) {
      options = options || {};
      var attribution = {};
      attrKeys.forEach(function(k) {
        var v = getCookie("_pulse_" + k);
        if (v) attribution[k] = v;
      });

      var payload = {
        client_id: CLIENT_ID,
        page_url: window.location.href,
        landing_page: getCookie("_pulse_landing") || window.location.href,
        referrer: document.referrer || null,
        submitted_at: new Date().toISOString(),
        attribution: attribution,
        form: {
          type: options.formType || "contact",
          id: options.formId || null,
          name: options.formName || null
        },
        fields: formFields || {},
        custom: options.custom || {}
      };

      var xhr = new XMLHttpRequest();
      xhr.open("POST", TRACKER_URL, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify(payload));
    }
  };
})();
</script>`;

  res.json({ snippet, clientSlug: tenant.clientSlug });
});

export default router;
