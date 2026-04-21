import { useState } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, XCircle, ExternalLink, Loader2 } from "lucide-react";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

interface ScriptResult {
  src: string;
  resolvedUrl: string | null;
  status: number;
  contentType: string | null;
  bytes: number;
  looksLikePulse: boolean;
  error?: string;
}

interface VerifyResult {
  url: string;
  host: string;
  overall: "green" | "amber" | "red";
  findings: { level: "info" | "warning" | "error"; message: string }[];
  scripts: ScriptResult[];
  heartbeats: {
    tenantId: number;
    tenantName: string | null;
    lastSeenAt: string;
    firstPageUrl: string | null;
  }[];
  recentEventCount24h: number;
  debugUrl: string;
}

export default function VerifyTracker() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/verify-tracker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
      } else {
        setResult(data as VerifyResult);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to verify");
    } finally {
      setLoading(false);
    }
  };

  const overallColor = result?.overall === "green"
    ? "text-emerald-400"
    : result?.overall === "amber"
      ? "text-amber-400"
      : "text-red-400";
  const OverallIcon = result?.overall === "green"
    ? CheckCircle2
    : result?.overall === "amber"
      ? AlertTriangle
      : XCircle;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <GradientHeading>Verify Tracker</GradientHeading>
        <p className="text-sm text-muted-foreground mt-2">
          Enter a public landing-page URL. We'll fetch the HTML, follow each tracker script tag, and check whether a heartbeat
          and form-fill events have actually arrived from that hostname. Best for diagnosing the case where the System Health
          says "Healthy" but Pulse shows no leads.
        </p>
      </div>

      <PremiumCard className="p-6">
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-landing-page.com/offer"
            onKeyDown={(e) => { if (e.key === "Enter" && !loading && url.trim()) run(); }}
          />
          <Button onClick={run} disabled={loading || !url.trim()}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Verify"}
          </Button>
        </div>
        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
      </PremiumCard>

      {result && (
        <>
          <PremiumCard className="p-6">
            <div className="flex items-start gap-3">
              <OverallIcon className={`w-6 h-6 mt-0.5 ${overallColor}`} />
              <div className="flex-1">
                <h3 className="text-lg font-medium text-white">{result.host}</h3>
                <p className={`text-sm ${overallColor}`}>
                  {result.overall === "green" && "Tracker is loading and capturing events."}
                  {result.overall === "amber" && "Tracker is partially working — see warnings below."}
                  {result.overall === "red" && "Tracker is not working on this URL — see errors below."}
                </p>
              </div>
            </div>

            {result.findings.length > 0 && (
              <ul className="mt-4 space-y-2">
                {result.findings.map((f, i) => {
                  const c = f.level === "error" ? "text-red-300 border-red-500/30 bg-red-500/[0.05]"
                    : f.level === "warning" ? "text-amber-300 border-amber-500/30 bg-amber-500/[0.05]"
                    : "text-muted-foreground border-white/10 bg-white/[0.02]";
                  return (
                    <li key={i} className={`text-sm border rounded-md px-3 py-2 ${c}`}>{f.message}</li>
                  );
                })}
              </ul>
            )}
          </PremiumCard>

          <PremiumCard className="p-6">
            <h4 className="text-sm font-medium text-white mb-3">Tracker script tags ({result.scripts.length})</h4>
            {result.scripts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tracker script tags found in static HTML. (GTM-injected scripts won't appear here.)</p>
            ) : (
              <div className="space-y-2">
                {result.scripts.map((s, i) => (
                  <div key={i} className="border border-white/10 bg-white/[0.02] rounded-md p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <code className="text-white/80 truncate">{s.src}</code>
                      <span className={`px-2 py-0.5 rounded ${s.status >= 200 && s.status < 300 ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>
                        HTTP {s.status || "ERR"}
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-1 space-x-3">
                      <span>type: {s.contentType || "(none)"}</span>
                      <span>bytes: {s.bytes.toLocaleString()}</span>
                      <span>looks like pulse.js: {s.looksLikePulse ? "yes" : "no"}</span>
                    </div>
                    {s.error && <p className="text-red-300 mt-1">{s.error}</p>}
                  </div>
                ))}
              </div>
            )}
          </PremiumCard>

          <PremiumCard className="p-6">
            <h4 className="text-sm font-medium text-white mb-3">Heartbeats from {result.host}</h4>
            {result.heartbeats.length === 0 ? (
              <p className="text-sm text-muted-foreground">None on record.</p>
            ) : (
              <div className="space-y-2">
                {result.heartbeats.map((h, i) => (
                  <div key={i} className="border border-white/10 bg-white/[0.02] rounded-md p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-white/80">{h.tenantName || `Tenant #${h.tenantId}`}</span>
                      <span className="text-muted-foreground">last seen {new Date(h.lastSeenAt).toLocaleString()}</span>
                    </div>
                    {h.firstPageUrl && (
                      <p className="text-muted-foreground mt-1 truncate">First seen on: <span className="text-white/60">{h.firstPageUrl}</span></p>
                    )}
                  </div>
                ))}
                <p className="text-xs text-muted-foreground mt-2">Form-fill events from this host in last 24h: <span className="text-white">{result.recentEventCount24h}</span></p>
              </div>
            )}
          </PremiumCard>

          <PremiumCard className="p-6">
            <h4 className="text-sm font-medium text-white mb-2">Live debugging</h4>
            <p className="text-sm text-muted-foreground mb-3">
              Open the URL with the debug overlay to watch capture activity in real time. The overlay shows bound forms, captured
              submissions (with attribution), and any rejected events.
            </p>
            <a
              href={result.debugUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              {result.debugUrl} <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </PremiumCard>
        </>
      )}
    </div>
  );
}
