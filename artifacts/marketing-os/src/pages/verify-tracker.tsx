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

type ScriptKind = "pulse-current" | "pulse-legacy" | "optics-legacy" | "unknown-tracker" | "none";
type InstallVerdict =
  | "pulse-ok"
  | "wrong-tracker-installed"
  | "legacy-tag-dead"
  | "no-tracker-found"
  | "heartbeat-only-never-submitted"
  | "stale-install";

interface ScriptResult {
  src: string;
  resolvedUrl: string | null;
  status: number;
  contentType: string | null;
  bytes: number;
  looksLikePulse: boolean;
  kind: ScriptKind;
  dataAttrs: Record<string, string> | null;
  isDeadResource?: boolean;
  error?: string;
}

interface FormInventoryItem {
  kind: "form" | "iframe";
  source: string | null;
  builder: string | null;
  host: string | null;
  fieldNames: string[];
}

interface SubmitBreakdown {
  total: number;
  submitOk: number;
  submitClientError: number;
  submitRateLimited: number;
  submitServerError: number;
}

interface StoredEvent {
  evt: LiveAttributionEvent;
  arrivedAt: number;
  sessionId: string;
}

interface VerifyResult {
  url: string;
  host: string;
  overall: "green" | "amber" | "red";
  findings: { level: "info" | "warning" | "error"; message: string }[];
  scripts: ScriptResult[];
  pageScriptKind: ScriptKind;
  installVerdict: InstallVerdict;
  formInventory: FormInventoryItem[];
  statusBreakdown: {
    last24h: SubmitBreakdown;
    last7d: SubmitBreakdown;
  };
  heartbeats: {
    tenantId: number;
    tenantName: string | null;
    lastSeenAt: string;
    firstPageUrl: string | null;
  }[];
  recentEventCount24h: number;
  recentAttempts: {
    id: number;
    tenantId: number | null;
    tenantName: string | null;
    clientId: string | null;
    endpoint: "submit" | "heartbeat";
    pageUrl: string | null;
    outcome: string;
    httpStatus: number;
    message: string | null;
    pulseVersion: string | null;
    attributionEventId: number | null;
    createdAt: string;
  }[];
  debugUrl: string;
  captureUrl: string;
}

export default function VerifyTracker() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<StoredEvent[]>([]);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [ignoredCount, setIgnoredCount] = useState(0);
  const [storedHostCount, setStoredHostCount] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const persistHostRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string>(`s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const MAX_EVENTS = 5;
  const STORAGE_PREFIX = "verify-tracker:events:";

  const storageKeyFor = (host: string) => `${STORAGE_PREFIX}${host.toLowerCase()}`;

  const loadPersistedEvents = (host: string): StoredEvent[] => {
    try {
      const raw = localStorage.getItem(storageKeyFor(host));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(0, MAX_EVENTS).map((e: StoredEvent) => ({
        ...e,
        sessionId: e.sessionId ?? "__legacy__",
      }));
    } catch {
      return [];
    }
  };

  const persistEvents = (host: string | null, events: StoredEvent[]) => {
    if (!host) return;
    try {
      localStorage.setItem(storageKeyFor(host), JSON.stringify(events.slice(0, MAX_EVENTS)));
      setStoredHostCount(countAllPersistedHosts());
    } catch {
      /* ignore quota / disabled storage */
    }
  };

  const clearPersistedEvents = (host: string | null) => {
    if (!host) return;
    try {
      localStorage.removeItem(storageKeyFor(host));
      setStoredHostCount(countAllPersistedHosts());
    } catch {
      /* ignore */
    }
  };

  const countAllPersistedHosts = (): number => {
    try {
      let n = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) n++;
      }
      return n;
    } catch {
      return 0;
    }
  };

  const clearAllPersistedEvents = (): number => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
      return keys.length;
    } catch {
      return 0;
    }
  };

  const stopWaiting = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setWaitingSince(null);
  };

  useEffect(() => () => stopWaiting(), []);

  useEffect(() => { setStoredHostCount(countAllPersistedHosts()); }, []);

  const handleClearAllHistory = () => {
    const total = countAllPersistedHosts();
    if (total === 0) return;
    const ok = window.confirm(
      `Clear saved Verify Tracker history for all ${total} host${total === 1 ? "" : "s"}? This cannot be undone — events will only return as new submissions are captured.`,
    );
    if (!ok) return;
    clearAllPersistedEvents();
    setLiveEvents([]);
    setStoredHostCount(0);
  };

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
    persistHostRef.current = expectedHost;
    const persisted = loadPersistedEvents(expectedHost);
    if (persisted.length > 0) setLiveEvents(persisted);
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
      setLiveEvents(prev => {
        const next: StoredEvent[] = [{ evt, arrivedAt: Date.now(), sessionId: sessionIdRef.current }, ...prev].slice(0, MAX_EVENTS);
        persistEvents(expectedHost, next);
        return next;
      });
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
        <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {storedHostCount === 0
              ? "No saved event history yet. Verified hosts will keep their last few captured events here in your browser."
              : `Saved event history for ${storedHostCount} host${storedHostCount === 1 ? "" : "s"} is kept in this browser. Clearing it cannot be undone — events will only return as new submissions are captured.`}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleClearAllHistory}
            disabled={storedHostCount === 0}
          >
            Clear all history
          </Button>
        </div>
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
            onClear={() => { setLiveEvents([]); clearPersistedEvents(persistHostRef.current); }}
            tenantsScoped={result.heartbeats.length}
            expectedHost={result.host}
            ignoredCount={ignoredCount}
            currentSessionId={sessionIdRef.current}
          />

          <InstallVerdictBanner verdict={result.installVerdict} pageScriptKind={result.pageScriptKind} captureUrl={result.captureUrl} />

          <StatusBreakdownCard last24h={result.statusBreakdown.last24h} last7d={result.statusBreakdown.last7d} host={result.host} />

          <PremiumCard className="p-6">
            <h4 className="text-sm font-medium text-white mb-3">Tracker script tags ({result.scripts.length})</h4>
            {result.scripts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tracker script tags found in static HTML. (GTM-injected scripts won't appear here.)</p>
            ) : (
              <div className="space-y-2">
                {result.scripts.map((s, i) => {
                  const kindColor = s.kind === "pulse-current" ? "bg-emerald-500/20 text-emerald-300"
                    : s.kind === "pulse-legacy" ? "bg-amber-500/20 text-amber-300"
                    : s.kind === "optics-legacy" ? "bg-red-500/20 text-red-300"
                    : s.kind === "unknown-tracker" ? "bg-amber-500/20 text-amber-300"
                    : "bg-white/10 text-white/60";
                  return (
                    <div key={i} className="border border-white/10 bg-white/[0.02] rounded-md p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <code className="text-white/80 truncate">{s.src}</code>
                        <div className="flex gap-1.5 shrink-0">
                          <span className={`px-2 py-0.5 rounded ${kindColor}`}>{s.kind}</span>
                          <span className={`px-2 py-0.5 rounded ${s.status >= 200 && s.status < 300 ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>
                            HTTP {s.status || "ERR"}
                          </span>
                        </div>
                      </div>
                      <div className="text-muted-foreground mt-1 space-x-3">
                        <span>type: {s.contentType || "(none)"}</span>
                        <span>bytes: {s.bytes.toLocaleString()}</span>
                        <span>looks like pulse.js: {s.looksLikePulse ? "yes" : "no"}</span>
                      </div>
                      {s.dataAttrs && Object.keys(s.dataAttrs).length > 0 && (
                        <div className="text-muted-foreground mt-1">
                          attrs: {Object.entries(s.dataAttrs).map(([k, v]) => (
                            <code key={k} className="text-white/60 mr-2">data-{k}="{v}"</code>
                          ))}
                        </div>
                      )}
                      {s.error && <p className="text-red-300 mt-1">{s.error}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </PremiumCard>

          <FormInventoryCard items={result.formInventory} />

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
            <h4 className="text-sm font-medium text-white mb-1">Recent submit attempts</h4>
            <p className="text-xs text-muted-foreground mb-3">
              Every inbound /collect/submit and /collect/heartbeat from {result.host} — including ones rejected before validation.
              This is the trip-wire for silent capture failures (heartbeat green + submit red is the textbook silent outage).
            </p>
            {result.recentAttempts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No attempts on record yet.</p>
            ) : (
              <div className="space-y-1.5">
                {result.recentAttempts.map((a) => {
                  const isAccepted = a.outcome === "accepted" || a.outcome === "duplicate" || a.outcome === "resubmitted";
                  const isInvalid = a.outcome === "invalid_payload" || a.outcome === "missing_client_id" || a.outcome === "unknown_client";
                  const pillClass = isAccepted
                    ? "bg-emerald-500/15 text-emerald-200 border-emerald-400/30"
                    : isInvalid
                      ? "bg-amber-500/15 text-amber-200 border-amber-400/30"
                      : "bg-red-500/15 text-red-200 border-red-400/30";
                  const statusClass = a.httpStatus >= 200 && a.httpStatus < 300
                    ? "text-emerald-300"
                    : a.httpStatus >= 400
                      ? "text-red-300"
                      : "text-muted-foreground";
                  return (
                    <div key={a.id} className="border border-white/10 bg-white/[0.02] rounded-md p-2.5 text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-1.5 py-0.5 rounded border ${pillClass} font-medium`}>{a.outcome}</span>
                        <span className={`font-mono ${statusClass}`}>HTTP {a.httpStatus || "—"}</span>
                        <span className="text-white/70">{a.endpoint}</span>
                        {a.clientId && <span className="text-muted-foreground">· {a.clientId}</span>}
                        {a.tenantName && <span className="text-muted-foreground">· {a.tenantName}</span>}
                        {a.pulseVersion && <span className="text-muted-foreground">· pulse v{a.pulseVersion}</span>}
                        <span className="text-muted-foreground ml-auto">{new Date(a.createdAt).toLocaleString()}</span>
                      </div>
                      {a.message && <p className="text-muted-foreground mt-1 break-all"><span className="text-white/60">{a.message}</span></p>}
                      {a.pageUrl && <p className="text-muted-foreground mt-0.5 truncate" title={a.pageUrl}>on {a.pageUrl}</p>}
                    </div>
                  );
                })}
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
  currentSessionId,
}: {
  events: StoredEvent[];
  nowMs: number;
  waitingSince: number | null;
  elapsedMs: number;
  onRestart: () => void;
  onStop: () => void;
  onClear: () => void;
  tenantsScoped: number;
  expectedHost: string;
  ignoredCount: number;
  currentSessionId: string;
}) {
  const seconds = Math.floor(elapsedMs / 1000);
  const hasEvents = events.length > 0;
  const timedOut = waitingSince !== null && !hasEvents && seconds >= 60;
  const hasPriorSession = events.some(e => e.sessionId !== currentSessionId);

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
                {hasPriorSession && " Events from a previous session show their actual capture time."}
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
            {events.map(({ evt, arrivedAt, sessionId }) => {
              const fromPriorSession = sessionId !== currentSessionId;
              const capturedAtIso = evt.receivedAt || evt.submittedAt;
              const capturedAtMs = capturedAtIso ? Date.parse(capturedAtIso) : NaN;
              const capturedAtLabel = Number.isFinite(capturedAtMs)
                ? new Date(capturedAtMs).toLocaleString()
                : new Date(arrivedAt).toLocaleString();
              return (
              <div key={`${evt.id}-${arrivedAt}`} className="border border-white/10 bg-white/[0.02] rounded-md p-3">
                <div className="flex items-center gap-2 text-sm text-emerald-300 flex-wrap">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Event #{evt.id}</span>
                  <span className={`text-[11px] px-2 py-0.5 rounded border ${matchPillClass(evt.matchLevel)}`}>match: {evt.matchLevel}</span>
                  {fromPriorSession && (
                    <span className="text-[11px] px-2 py-0.5 rounded border bg-white/[0.04] text-muted-foreground border-white/15">from previous session</span>
                  )}
                  <span
                    className="text-[11px] text-muted-foreground ml-auto"
                    title={fromPriorSession ? `Captured ${capturedAtLabel}` : `Arrived ${new Date(arrivedAt).toLocaleString()}`}
                  >
                    {fromPriorSession ? `captured ${capturedAtLabel}` : formatAge(nowMs - arrivedAt)}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs mt-2">
                  <Field label="Resolved source" value={evt.resolvedLeadSource} />
                  <Field label="Resolved funnel" value={evt.resolvedFunnel} />
                  <Field label="Form id" value={evt.formId} mono />
                  <Field label="Form" value={[evt.formType, evt.formName].filter(Boolean).join(" / ") || null} />
                </div>
              </div>
              );
            })}
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

function InstallVerdictBanner({ verdict, pageScriptKind, captureUrl }: { verdict: InstallVerdict; pageScriptKind: ScriptKind; captureUrl: string }) {
  const config = {
    "pulse-ok": { color: "border-emerald-500/40 bg-emerald-500/[0.08]", chip: "bg-emerald-500/30 text-emerald-200", icon: <CheckCircle2 className="h-5 w-5 text-emerald-300" />, label: "Pulse OK", body: "Current Pulse build is installed and submits are flowing. Heartbeat fresh." },
    "wrong-tracker-installed": { color: "border-red-500/40 bg-red-500/[0.10]", chip: "bg-red-500/30 text-red-200", icon: <XCircle className="h-5 w-5 text-red-300" />, label: "Wrong tracker installed", body: pageScriptKind === "optics-legacy" ? "This page is loading the LEGACY Optics tracker (tracker.js / hvaclaunch-optics.replit.app). Submits go to a different deployment AND a different tenant id — this is the exact failure mode that broke Vance Heating. Replace with the Pulse install snippet from Settings → Tracker Health." : "This page has a tracker-shaped script tag that is not a recognised Pulse build." },
    "legacy-tag-dead": { color: "border-amber-500/40 bg-amber-500/[0.08]", chip: "bg-amber-500/30 text-amber-200", icon: <AlertTriangle className="h-5 w-5 text-amber-300" />, label: "Legacy tag is dead", body: "The legacy <script src=…tracker.js> tag is still in this page's HTML, but the URL is dead (returns non-JS / 4xx / 5xx). Pulse is actively running via GTM (heartbeats in the last 24h) — submits are flowing to the right tenant. The legacy tag is harmless. Remove the <script> tag from the page HTML at your convenience." },
    "no-tracker-found": { color: "border-amber-500/40 bg-amber-500/[0.08]", chip: "bg-amber-500/30 text-amber-200", icon: <AlertTriangle className="h-5 w-5 text-amber-300" />, label: "No tracker found", body: "No <script src=…pulse.js> or recognised tracker tag in the static HTML. If pulse.js is injected via GTM, the static HTML scan won't see it — load the page in capture mode to confirm." },
    "heartbeat-only-never-submitted": { color: "border-amber-500/40 bg-amber-500/[0.08]", chip: "bg-amber-500/30 text-amber-200", icon: <AlertTriangle className="h-5 w-5 text-amber-300" />, label: "Heartbeats but no submits", body: "pulse.js loads (heartbeats are coming in) but no successful submits in the last 7 days. Forms exist but pulse.js can't see them — check the form inventory below and use capture mode to investigate." },
    "stale-install": { color: "border-amber-500/40 bg-amber-500/[0.08]", chip: "bg-amber-500/30 text-amber-200", icon: <AlertTriangle className="h-5 w-5 text-amber-300" />, label: "Stale install", body: "Pulse is installed but the most recent heartbeat is over 24 hours old. Either the page hasn't been visited recently or the tracker has been removed." },
  } as const;
  const c = config[verdict];
  return (
    <PremiumCard className={`p-5 border ${c.color}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">{c.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-white">Install verdict</h4>
            <span className={`text-[11px] px-2 py-0.5 rounded ${c.chip}`}>{c.label}</span>
            <span className="text-[11px] text-muted-foreground">script kind: <code className="text-white/70">{pageScriptKind}</code></span>
          </div>
          <p className="text-sm text-white/75 mt-2 leading-relaxed">{c.body}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href={captureUrl} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/5 text-white/80 inline-flex items-center gap-1.5">
              Open page in capture mode <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}

function StatusBreakdownCard({ last24h, last7d, host }: { last24h: SubmitBreakdown; last7d: SubmitBreakdown; host: string }) {
  const Pill = ({ label, n, tone }: { label: string; n: number; tone: "ok" | "warn" | "err" | "muted" }) => {
    const c = tone === "ok" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
      : tone === "warn" ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
      : tone === "err" ? "bg-red-500/15 text-red-300 border-red-500/30"
      : "bg-white/5 text-white/60 border-white/10";
    return (
      <div className={`border rounded-md px-2.5 py-2 ${c}`}>
        <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
        <div className="text-base font-semibold mt-0.5">{n.toLocaleString()}</div>
      </div>
    );
  };
  const Row = ({ title, b }: { title: string; b: SubmitBreakdown }) => (
    <div>
      <div className="text-xs text-white/60 mb-2">{title} ({b.total.toLocaleString()} total)</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Pill label="submit ok" n={b.submitOk} tone="ok" />
        <Pill label="submit 4xx" n={b.submitClientError} tone="err" />
        <Pill label="submit 429" n={b.submitRateLimited} tone="warn" />
        <Pill label="submit 5xx" n={b.submitServerError} tone="err" />
      </div>
    </div>
  );
  return (
    <PremiumCard className="p-6">
      <h4 className="text-sm font-medium text-white mb-1">Tracker Health — {host}</h4>
      <p className="text-xs text-muted-foreground mb-4">HTTP-status rollup of every /collect/* attempt from this hostname, grouped by outcome.</p>
      <div className="space-y-4">
        <Row title="Last 24h" b={last24h} />
        <Row title="Last 7 days" b={last7d} />
      </div>
    </PremiumCard>
  );
}

function FormInventoryCard({ items }: { items: FormInventoryItem[] }) {
  if (!items.length) return null;
  const forms = items.filter(i => i.kind === "form");
  const iframes = items.filter(i => i.kind === "iframe");
  return (
    <PremiumCard className="p-6">
      <h4 className="text-sm font-medium text-white mb-1">Form & iframe inventory</h4>
      <p className="text-xs text-muted-foreground mb-4">
        What pulse.js will see when this page loads — native forms it can bind to directly, plus form-builder iframes (where it has to listen for postMessage).
      </p>
      {forms.length > 0 && (
        <div className="mb-4">
          <div className="text-xs text-white/60 mb-2">Native &lt;form&gt; ({forms.length})</div>
          <div className="space-y-2">
            {forms.map((f, i) => (
              <div key={`f${i}`} className="border border-white/10 bg-white/[0.02] rounded-md p-3 text-xs">
                <div className="text-white/80">action: <code className="text-white/60">{f.source || "(none)"}</code></div>
                {f.fieldNames.length > 0 && (
                  <div className="text-muted-foreground mt-1">fields: {f.fieldNames.map(n => <code key={n} className="text-white/60 mr-2">{n}</code>)}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {iframes.length > 0 && (
        <div>
          <div className="text-xs text-white/60 mb-2">Form-builder iframes ({iframes.length})</div>
          <div className="space-y-2">
            {iframes.map((f, i) => {
              const known = f.builder && f.builder !== "unknown";
              return (
                <div key={`i${i}`} className="border border-white/10 bg-white/[0.02] rounded-md p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] ${known ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}>{f.builder || "unknown"}</span>
                    <span className="text-muted-foreground truncate">{f.host || ""}</span>
                  </div>
                  <code className="text-white/60 mt-1 block truncate">{f.source}</code>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </PremiumCard>
  );
}
