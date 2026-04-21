import { useState, useEffect, useRef } from "react";
import { io as socketIOClient, type Socket } from "socket.io-client";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, XCircle, ExternalLink, Loader2, Radio } from "lucide-react";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

function extractHost(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hostsMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/^www\./, "");
  const nb = b.toLowerCase().replace(/^www\./, "");
  return na === nb;
}

interface LiveAttributionEvent {
  id: number;
  tenantId: number;
  matchLevel: "diamond" | "golden" | "silver" | "unmatched";
  matchConfidence: number;
  resolvedLeadSource: string | null;
  resolvedFunnel: string | null;
  formType: string | null;
  formId: string | null;
  formName: string | null;
  pageUrl: string | null;
  landingPage: string | null;
  hasPhone: boolean;
  hasEmail: boolean;
  gclid: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  submittedAt: string;
  receivedAt: string;
}

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
  const [liveEvents, setLiveEvents] = useState<{ evt: LiveAttributionEvent; arrivedAt: number }[]>([]);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [ignoredCount, setIgnoredCount] = useState(0);
  const socketRef = useRef<Socket | null>(null);

  const MAX_EVENTS = 5;

  const stopWaiting = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setWaitingSince(null);
  };

  useEffect(() => () => stopWaiting(), []);

  useEffect(() => {
    if (waitingSince === null) return;
    const id = setInterval(() => setElapsedMs(Date.now() - waitingSince), 250);
    return () => clearInterval(id);
  }, [waitingSince]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const startWaiting = (verifyResult: VerifyResult) => {
    stopWaiting();
    setIgnoredCount(0);
    const allowedTenantIds = new Set(verifyResult.heartbeats.map(h => h.tenantId));
    const expectedHost = verifyResult.host.toLowerCase();
    const socket = socketIOClient({ path: "/api/socket.io", withCredentials: true, transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      for (const tid of allowedTenantIds) socket.emit("join-tenant", tid);
    });
    socket.on("new-attribution-event", (evt: LiveAttributionEvent) => {
      if (allowedTenantIds.size > 0 && !allowedTenantIds.has(evt.tenantId)) return;
      const evtHost = extractHost(evt.pageUrl) || extractHost(evt.landingPage);
      if (!evtHost || !hostsMatch(evtHost, expectedHost)) {
        setIgnoredCount(c => c + 1);
        return;
      }
      setLiveEvents(prev => [{ evt, arrivedAt: Date.now() }, ...prev].slice(0, MAX_EVENTS));
      setWaitingSince(Date.now());
      setElapsedMs(0);
    });
    socketRef.current = socket;
    setWaitingSince(Date.now());
    setElapsedMs(0);
  };

  const run = async () => {
    setError(null);
    setResult(null);
    setLiveEvents([]);
    stopWaiting();
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
        const v = data as VerifyResult;
        setResult(v);
        startWaiting(v);
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

          <LiveEventCard
            events={liveEvents}
            nowMs={nowMs}
            waitingSince={waitingSince}
            elapsedMs={elapsedMs}
            onRestart={() => startWaiting(result)}
            onStop={stopWaiting}
            onClear={() => setLiveEvents([])}
            tenantsScoped={result.heartbeats.length}
            expectedHost={result.host}
            ignoredCount={ignoredCount}
          />

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

function matchPillClass(level: LiveAttributionEvent["matchLevel"]): string {
  return level === "diamond" ? "bg-cyan-500/20 text-cyan-200 border-cyan-400/30"
    : level === "golden" ? "bg-amber-500/20 text-amber-200 border-amber-400/30"
    : level === "silver" ? "bg-slate-400/20 text-slate-200 border-slate-300/30"
    : "bg-red-500/20 text-red-200 border-red-400/30";
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function LiveEventCard({
  events,
  nowMs,
  waitingSince,
  elapsedMs,
  onRestart,
  onStop,
  onClear,
  tenantsScoped,
  expectedHost,
  ignoredCount,
}: {
  events: { evt: LiveAttributionEvent; arrivedAt: number }[];
  nowMs: number;
  waitingSince: number | null;
  elapsedMs: number;
  onRestart: () => void;
  onStop: () => void;
  onClear: () => void;
  tenantsScoped: number;
  expectedHost: string;
  ignoredCount: number;
}) {
  const seconds = Math.floor(elapsedMs / 1000);
  const hasEvents = events.length > 0;
  const timedOut = waitingSince !== null && !hasEvents && seconds >= 60;

  return (
    <PremiumCard className="p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Radio className={`w-5 h-5 mt-0.5 ${hasEvents ? "text-emerald-400" : timedOut ? "text-amber-400" : "text-primary animate-pulse"}`} />
          <div>
            <h4 className="text-sm font-medium text-white">Live attribution feed</h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              {tenantsScoped > 0
                ? `Listening on ${tenantsScoped} tenant channel${tenantsScoped === 1 ? "" : "s"} matched to ${expectedHost}.`
                : `No heartbeats from ${expectedHost} yet — only events whose page URL matches this host will be shown.`}
            </p>
            {hasEvents && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Showing the {events.length === 1 ? "most recent event" : `last ${events.length} events`} (newest first, capped at 5).
              </p>
            )}
            {ignoredCount > 0 && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Ignored {ignoredCount} event{ignoredCount === 1 ? "" : "s"} from other hosts on the same tenant.
              </p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {hasEvents && (
            <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
          )}
          {waitingSince !== null && (
            <Button size="sm" variant="ghost" onClick={onStop}>Stop</Button>
          )}
          <Button size="sm" variant="outline" onClick={onRestart}>
            {hasEvents || timedOut ? "Wait for next" : "Restart"}
          </Button>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {waitingSince !== null && !timedOut && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>
              {hasEvents
                ? `Waiting for the next form_fill event… (${seconds}s)`
                : `Still waiting for the next form_fill event… (${seconds}s)`}
            </span>
          </div>
        )}
        {waitingSince !== null && timedOut && !hasEvents && (
          <div className="flex items-start gap-2 text-sm text-amber-300 border border-amber-500/30 bg-amber-500/[0.05] rounded-md px-3 py-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">No event after 60s — capture is still failing.</p>
              <p className="text-xs text-amber-300/80 mt-1">
                Submit a test form on the page now. If nothing arrives, the tracker is loading but the form submission isn't being captured (selector mismatch, hidden iframe, or blocked POST).
              </p>
            </div>
          </div>
        )}
        {!hasEvents && waitingSince === null && (
          <p className="text-sm text-muted-foreground">Click "Restart" to begin listening for the next inbound attribution event.</p>
        )}
        {hasEvents && (
          <div className="space-y-2">
            {events.map(({ evt, arrivedAt }) => (
              <div key={`${evt.id}-${arrivedAt}`} className="border border-white/10 bg-white/[0.02] rounded-md p-3">
                <div className="flex items-center gap-2 text-sm text-emerald-300 flex-wrap">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Event #{evt.id}</span>
                  <span className={`text-[11px] px-2 py-0.5 rounded border ${matchPillClass(evt.matchLevel)}`}>match: {evt.matchLevel}</span>
                  <span className="text-[11px] text-muted-foreground ml-auto">{formatAge(nowMs - arrivedAt)}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs mt-2">
                  <Field label="Resolved source" value={evt.resolvedLeadSource} />
                  <Field label="Resolved funnel" value={evt.resolvedFunnel} />
                  <Field label="Form id" value={evt.formId} mono />
                  <Field label="Form" value={[evt.formType, evt.formName].filter(Boolean).join(" / ") || null} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </PremiumCard>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-white/85 truncate ${mono ? "font-mono text-[11px]" : ""}`}>{value || <span className="text-muted-foreground">—</span>}</div>
    </div>
  );
}
