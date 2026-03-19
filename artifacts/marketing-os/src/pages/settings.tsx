import { useState, useEffect } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { useAuth } from "@/components/auth-context";
import { Copy, Check, Save, Loader2 } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "";

const SECRET_KEYS = new Set(["ghlApiKey", "podiumApiToken"]);

export default function Settings() {
  const { user, isAgency } = useAuth();
  const tenantId = user?.tenantId;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [scriptTag, setScriptTag] = useState("");
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({
    serviceTitanId: "",
    googleAdsCustomerId: "",
    metaAdAccountId: "",
    callRailAccountId: "",
    ghlApiKey: "",
    podiumApiToken: "",
    podiumLocationId: "",
  });

  useEffect(() => {
    if (!tenantId) return;
    fetch(`${API}/api/tenants/${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        const lc = data.loadableConfig || {};
        setForm(f => ({
          ...f,
          serviceTitanId: data.serviceTitanId || "",
          googleAdsCustomerId: lc.googleAdsCustomerId || "",
          metaAdAccountId: lc.metaAdAccountId || "",
          callRailAccountId: lc.callRailAccountId || "",
          ghlApiKey: lc.ghlApiKey || "",
          podiumApiToken: lc.podiumApiToken || "",
          podiumLocationId: lc.podiumLocationId || "",
        }));
        setDirtyFields(new Set());
      })
      .catch(() => {});

    fetch(`${API}/api/funnel-types/script/${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => setScriptTag(data.script || ""))
      .catch(() => {
        setScriptTag(`<script src="${window.location.origin}/tracker.js" data-tenant="${tenantId}"></script>`);
      });
  }, [tenantId]);

  function trackField(field: string) {
    setDirtyFields(prev => new Set(prev).add(field));
  }

  async function handleSave() {
    if (!tenantId) return;
    setSaving(true);
    try {
      const integrationConfig: Record<string, string | null> = {};
      const configKeys = ["googleAdsCustomerId", "metaAdAccountId", "ghlApiKey", "callRailAccountId", "podiumApiToken", "podiumLocationId"] as const;
      for (const key of configKeys) {
        const val = form[key];
        if (!val) continue;
        if (!dirtyFields.has(key) && (val.startsWith("••••") || val.startsWith("****"))) continue;
        integrationConfig[key] = val;
      }

      const res = await fetch(`${API}/api/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          serviceTitanId: form.serviceTitanId || null,
          ...(Object.keys(integrationConfig).length > 0 ? { integrationConfig } : {}),
        }),
      });
      if (res.ok) {
        setSaved(true);
        setDirtyFields(new Set());
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {}
    setSaving(false);
  }

  async function handleCopyScript() {
    try {
      await navigator.clipboard.writeText(scriptTag);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  const inputClass = "w-full bg-background border border-white/10 text-white rounded-lg px-4 py-3 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all";

  return (
    <div className="space-y-6 max-w-4xl">
      <header>
        <GradientHeading className="text-3xl md:text-4xl mb-2">Client Settings</GradientHeading>
        <p className="font-sub text-muted-foreground text-sm tracking-wide">YOUR ACCOUNT CONFIGURATION</p>
      </header>

      <PremiumCard>
        <h3 className="text-xl font-display text-white mb-6">API Integrations</h3>
        <div className="space-y-5">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">ServiceTitan Tenant ID</label>
            <input
              type="text"
              value={form.serviceTitanId}
              onChange={e => { trackField("serviceTitanId"); setForm({ ...form, serviceTitanId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. 123456"
            />
          </div>
          {isAgency && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Google Ads Customer ID</label>
                <input
                  type="text"
                  value={form.googleAdsCustomerId}
                  onChange={e => { trackField("googleAdsCustomerId"); setForm({ ...form, googleAdsCustomerId: e.target.value }); }}
                  className={inputClass}
                  placeholder="e.g. 123-456-7890"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Meta Ad Account ID</label>
                <input
                  type="text"
                  value={form.metaAdAccountId}
                  onChange={e => { trackField("metaAdAccountId"); setForm({ ...form, metaAdAccountId: e.target.value }); }}
                  className={inputClass}
                  placeholder="e.g. act_123456789"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">GoHighLevel API Key</label>
                <input
                  type="password"
                  value={form.ghlApiKey}
                  onChange={e => { trackField("ghlApiKey"); setForm({ ...form, ghlApiKey: e.target.value }); }}
                  className={inputClass}
                  placeholder="Enter to update"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Podium API Token</label>
                <input
                  type="password"
                  value={form.podiumApiToken}
                  onChange={e => { trackField("podiumApiToken"); setForm({ ...form, podiumApiToken: e.target.value }); }}
                  className={inputClass}
                  placeholder="Enter to update"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Podium Location ID</label>
                <input
                  type="text"
                  value={form.podiumLocationId}
                  onChange={e => { trackField("podiumLocationId"); setForm({ ...form, podiumLocationId: e.target.value }); }}
                  className={inputClass}
                  placeholder="e.g. loc_abc123"
                />
              </div>
            </>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all mt-4 flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saved ? "Saved!" : "Save Configuration"}
          </button>
        </div>
      </PremiumCard>

      <PremiumCard>
        <h3 className="text-xl font-display text-white mb-2">Capture Script</h3>
        <p className="text-sm text-muted-foreground mb-6">Install this script in the &lt;head&gt; of your website to enable GCLID capture, cookie storage, and heartbeat monitoring.</p>

        <div className="bg-background border border-white/10 rounded-lg p-4 font-mono text-sm text-emerald-400 overflow-x-auto relative group">
          <pre>{scriptTag || "Loading..."}</pre>
          <button
            onClick={handleCopyScript}
            className="absolute top-2 right-2 bg-white/10 hover:bg-white/20 text-white px-3 py-1 rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </PremiumCard>
    </div>
  );
}
