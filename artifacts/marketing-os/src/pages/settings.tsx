import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { useAuth } from "@/components/auth-context";
import { Copy, Check, Save, Loader2, Phone, MessageSquare, Wifi, WifiOff, Lock, ChevronDown, CheckCircle, XCircle, Key, Unplug, Users, Link2, Unlink, Bell, BellOff, Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { useTenants } from "@/hooks/use-tenants";
import { toast } from "@/hooks/use-toast";
import { useGetPodiumUsers, useLinkPodiumUser } from "@workspace/api-client-react";

const API = import.meta.env.VITE_API_URL || "";
const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

interface PodiumUserEntry {
  uid: string;
  name?: string;
  email?: string;
  internalUserId: number | null;
  internalUserName: string | null;
}

interface TeamMemberEntry {
  id: number;
  name: string | null;
  email: string | null;
  podiumUserUid: string | null;
}

function PushNotificationCard() {
  const { permission, subscribed, loading, supported, subscribe, unsubscribe } = usePushNotifications();

  if (!supported) return null;

  const handleToggle = async () => {
    if (subscribed) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  };

  return (
    <PremiumCard>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bell className="w-5 h-5 text-cyan-400" />
          <div>
            <h3 className="text-xl font-display text-white">Push Notifications</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {permission === "denied"
                ? "Notifications are blocked in your browser settings."
                : subscribed
                  ? "You'll receive browser notifications for new leads."
                  : "Enable browser notifications to get alerted for new leads."}
            </p>
          </div>
        </div>
        <button
          onClick={handleToggle}
          disabled={loading || permission === "denied"}
          className={cn(
            "relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50",
            subscribed ? "bg-cyan-500" : "bg-white/10"
          )}
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin text-white mx-auto" />
          ) : (
            <span className={cn(
              "inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform duration-200",
              subscribed ? "translate-x-6" : "translate-x-1"
            )} />
          )}
        </button>
      </div>
      {permission === "denied" && (
        <p className="text-xs text-amber-400/70 mt-3 flex items-center gap-1.5">
          <BellOff className="w-3.5 h-3.5" />
          To enable notifications, update your browser's notification permissions for this site.
        </p>
      )}
    </PremiumCard>
  );
}

function PodiumUserLinkingPanel({ tenantId }: { tenantId: number }) {
  const [linkingId, setLinkingId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const { data: usersData, isFetching: loading, refetch } = useGetPodiumUsers({ tenantId });
  const podiumUsers: PodiumUserEntry[] = (usersData?.podiumUsers ?? []) as PodiumUserEntry[];
  const teamMembers: TeamMemberEntry[] = (usersData?.teamMembers ?? []) as TeamMemberEntry[];

  const linkMutation = useLinkPodiumUser();

  const handleLink = async (internalUserId: number, podiumUserUid: string | null) => {
    setLinkingId(internalUserId);
    try {
      await linkMutation.mutateAsync({
        data: { internalUserId, podiumUserUid },
        params: { tenantId },
      });
      setFeedback({ type: "success", msg: podiumUserUid ? "Linked successfully" : "Unlinked" });
      refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection error";
      setFeedback({ type: "error", msg });
    } finally {
      setLinkingId(null);
      setTimeout(() => setFeedback(null), 3000);
    }
  };

  const linkedUids = new Set(teamMembers.filter(m => m.podiumUserUid).map(m => m.podiumUserUid));

  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-muted-foreground">
        Link your team members to their Podium accounts to enable conversation assignment.
      </p>

      {feedback && (
        <div className={cn(
          "px-3 py-2 rounded-lg text-sm flex items-center gap-2",
          feedback.type === "success" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
        )}>
          {feedback.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {feedback.msg}
        </div>
      )}

      {loading ? (
        <div className="py-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
      ) : (
        <div className="space-y-2">
          {teamMembers.length === 0 && (
            <p className="text-sm text-white/30 text-center py-4">No team members found for this tenant.</p>
          )}
          {teamMembers.map(member => {
            const linkedPodiumUser = podiumUsers.find(pu => pu.uid === member.podiumUserUid);
            const isLinking = linkingId === member.id;
            return (
              <div key={member.id} className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-lg px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{member.name || member.email || `User #${member.id}`}</p>
                  {member.email && member.name && (
                    <p className="text-xs text-white/30 truncate">{member.email}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {member.podiumUserUid ? (
                    <>
                      <div className="flex items-center gap-1.5 px-2 py-1 bg-emerald-500/10 rounded text-emerald-400">
                        <Link2 className="w-3 h-3" />
                        <span className="text-xs">{linkedPodiumUser?.name || linkedPodiumUser?.email || member.podiumUserUid}</span>
                      </div>
                      <button
                        onClick={() => handleLink(member.id, null)}
                        disabled={isLinking}
                        className="p-1.5 rounded hover:bg-red-500/10 text-white/30 hover:text-red-400 transition-colors disabled:opacity-50"
                        title="Unlink"
                      >
                        {isLinking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unlink className="w-3.5 h-3.5" />}
                      </button>
                    </>
                  ) : (
                    <select
                      onChange={e => { if (e.target.value) handleLink(member.id, e.target.value); }}
                      disabled={isLinking}
                      className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white focus:outline-none focus:border-cyan-500/30 disabled:opacity-50 max-w-[180px]"
                      defaultValue=""
                    >
                      <option value="" className="bg-gray-900">Link to Podium user...</option>
                      {podiumUsers.filter(pu => !linkedUids.has(pu.uid)).map(pu => (
                        <option key={pu.uid} value={pu.uid} className="bg-gray-900">
                          {pu.name || pu.email || pu.uid}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            );
          })}
          {podiumUsers.length === 0 && teamMembers.length > 0 && (
            <p className="text-xs text-amber-400/60 mt-2">
              No Podium users found. A user within this tenant needs to connect their Podium account in their own Settings first, or reconnect with the "read_users" scope above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PodiumUserLinking({ tenantId }: { tenantId: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <PremiumCard>
      <button
        onClick={() => setExpanded(o => !o)}
        className="w-full flex items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-cyan-400" />
          <h3 className="text-xl font-display text-white">Podium User Mapping</h3>
        </div>
        <ChevronDown className={cn("w-5 h-5 text-gray-400 transition-transform duration-200", expanded && "rotate-180")} />
      </button>
      {expanded && <PodiumUserLinkingPanel tenantId={tenantId} />}
    </PremiumCard>
  );
}

export default function Settings() {
  const { user, isAgency, selectedTenantId, setSelectedTenantId, effectiveTenantId } = useAuth();
  const isClientUser = user?.role === "client_user";
  const tenantId = effectiveTenantId;
  const { tenants, tenantsLoading } = useTenants();

  useEffect(() => {
    if (!isAgency) return;
    if (!selectedTenantId && tenants.length > 0) setSelectedTenantId(tenants[0].id);
  }, [isAgency, selectedTenantId, tenants, setSelectedTenantId]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
  const [commConfig, setCommConfig] = useState({
    callPlatform: "native" as string,
    textPlatform: "native" as string,
  });
  const [commStatus, setCommStatus] = useState<{ callReady: boolean; textReady: boolean; callStatusMessage: string; textStatusMessage: string } | null>(null);
  const [commSaving, setCommSaving] = useState(false);
  const [commSaved, setCommSaved] = useState(false);
  const [commError, setCommError] = useState<string | null>(null);
  const [commInitial, setCommInitial] = useState({ callPlatform: "native", textPlatform: "native" });
  const commDirty = commConfig.callPlatform !== commInitial.callPlatform || commConfig.textPlatform !== commInitial.textPlatform;
  const [form, setForm] = useState({
    serviceTitanId: "",
    googleAdsCustomerId: "",
    metaAdAccountId: "",
    callRailAccountId: "",
    callRailApiKey: "",
    callRailCompanyId: "",
    callRailTrackingNumber: "",
    ghlApiKey: "",
    podiumApiToken: "",
    podiumLocationId: "",
  });
  const [rebateLabels, setRebateLabels] = useState<string[]>([]);
  const [rebateInitial, setRebateInitial] = useState<string[]>([]);
  const [rebateUsingDefaults, setRebateUsingDefaults] = useState(true);
  const [rebateInput, setRebateInput] = useState("");
  const [rebateSaving, setRebateSaving] = useState(false);
  const [rebateSaved, setRebateSaved] = useState(false);
  const [rebateError, setRebateError] = useState<string | null>(null);
  const rebateDirty = JSON.stringify(rebateLabels) !== JSON.stringify(rebateInitial);

  // Live progress for the historical revenue recompute that the server kicks
  // off (fire-and-forget) when the rebate program list actually changes. We
  // reuse the same sync-status / percent-bar plumbing the manual "Recompute
  // revenue" button surfaces in the internal admin page: the recompute runs
  // ServiceTitan invoices first, then estimates, each publishing a running
  // row tally (and an estimated total) to its sync log.
  type RecomputePhase = { lastStatus: string; recordsProcessed: number; totalRecords: number | null; lastRun: string | null; runningLogId: number | null; cancelRequested: boolean };
  const [recomputePhases, setRecomputePhases] = useState<{ invoices: RecomputePhase; estimates: RecomputePhase } | null>(null);
  const [recomputeArmed, setRecomputeArmed] = useState(false);
  const [recomputeOutcome, setRecomputeOutcome] = useState<null | "success" | "failed">(null);
  // Pre-recompute baseline of each phase's last completion timestamp. A phase
  // is considered freshly finished once its `lastRun` differs from this.
  const recomputeBaseline = useRef<{ inv: string | null; est: string | null } | null>(null);
  const recomputeSawRunning = useRef(false);
  const recomputeArmedAt = useRef(0);

  // Cancel handshake state for the running recompute phase. Mirrors the
  // internal admin page: optimistically flip to a "Cancelling…" state, then
  // reveal a "Force cancel" affordance after a short delay so the cooperative
  // cancel has time to unwind before suggesting a hard kill.
  const [cancellingLogIds, setCancellingLogIds] = useState<Record<number, boolean>>({});
  const [cancelStartedAt, setCancelStartedAt] = useState<Record<number, number>>({});
  const [, setCancelNowTick] = useState(0);
  useEffect(() => {
    if (Object.keys(cancelStartedAt).length === 0) return;
    const id = setInterval(() => setCancelNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [cancelStartedAt]);
  const FORCE_CANCEL_DELAY_MS = 8000;

  const recomputeRunning = recomputePhases
    ? recomputePhases.invoices.lastStatus === "running" || recomputePhases.estimates.lastStatus === "running"
    : false;

  const readRecomputePhase = (raw: unknown): RecomputePhase => {
    const p = (raw || {}) as Record<string, unknown>;
    return {
      lastStatus: typeof p.lastStatus === "string" ? p.lastStatus : "never",
      recordsProcessed: typeof p.recordsProcessed === "number" ? p.recordsProcessed : 0,
      totalRecords: typeof p.totalRecords === "number" ? p.totalRecords : null,
      lastRun: typeof p.lastRun === "string" ? p.lastRun : null,
      runningLogId: typeof p.runningLogId === "number" ? p.runningLogId : null,
      cancelRequested: p.cancelRequested === true,
    };
  };

  const fetchRecomputeStatus = useCallback(async () => {
    if (!tenantId) return;
    try {
      const res = await fetch(`${API}/api/integrations/sync-status?tenantId=${tenantId}`, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const st = data?.statusByIntegration?.service_titan?.syncTypes || {};
      setRecomputePhases({
        invoices: readRecomputePhase(st.invoices),
        estimates: readRecomputePhase(st.estimates),
      });
    } catch { /* ignore */ }
  }, [tenantId]);

  // Cancel the in-flight recompute. Targets the sync log of whichever phase
  // (invoices or estimates) currently owns a running row. Reuses the same
  // cooperative cancel route the internal admin page uses; rows already
  // reprocessed are kept and the run stops after the current batch.
  const cancelRecompute = async (logId: number, force = false) => {
    if (!logId) return;
    const prompt = force
      ? `Force-cancel the revenue recompute? This hard-flips the run to "cancelled" — use only if the worker is unresponsive.`
      : "Cancel the running revenue recompute? Rows already reprocessed will be kept.";
    if (!confirm(prompt)) return;
    setCancellingLogIds((s) => ({ ...s, [logId]: true }));
    if (!force) setCancelStartedAt((s) => (s[logId] ? s : { ...s, [logId]: Date.now() }));
    try {
      const url = `${API_BASE}/api/integrations/sync-logs/${logId}/cancel${force ? "?force=true" : ""}`;
      const res = await fetch(url, { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Cancel failed", description: body?.error || `HTTP ${res.status}`, variant: "destructive" });
      } else {
        toast({
          title: body?.forced ? "Run hard-cancelled" : "Cancel requested",
          description: body?.message || "The recompute will stop after the current batch finishes.",
        });
      }
    } catch (err) {
      toast({ title: "Cancel failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      fetchRecomputeStatus();
    }
  };

  // Seed the recompute status once on mount so a run that's already in flight
  // (the user kicked off a recompute, navigated away or refreshed, and came
  // back) re-surfaces from a "running" snapshot even though nothing was armed
  // in this session.
  useEffect(() => {
    if (!tenantId || !isAgency) return;
    fetchRecomputeStatus();
  }, [tenantId, isAgency, fetchRecomputeStatus]);

  // Adopt a recompute that's already running when we land on the page without
  // having armed it ourselves. There's no pre-save baseline in this case, so
  // the completion branch below treats base as null and any terminal lastRun
  // counts as freshly done.
  useEffect(() => {
    if (recomputeRunning && !recomputeArmed) setRecomputeArmed(true);
  }, [recomputeRunning, recomputeArmed]);

  // Poll while we're waiting on a recompute we armed OR while a recompute is
  // observed running (covers reopening the panel mid-run).
  useEffect(() => {
    if (!recomputeArmed && !recomputeRunning) return;
    const id = setInterval(() => { fetchRecomputeStatus(); }, 3000);
    return () => clearInterval(id);
  }, [recomputeArmed, recomputeRunning, fetchRecomputeStatus]);

  // Resolve the armed recompute to a terminal outcome once both phases have
  // produced fresh terminal rows (their `lastRun` moved past the baseline) and
  // nothing is running. If we never see it start within a short grace window,
  // assume the edit was a no-op server-side (no recompute triggered) and clear.
  useEffect(() => {
    if (!recomputeArmed || !recomputePhases) return;
    const { invoices: inv, estimates: est } = recomputePhases;
    const running = inv.lastStatus === "running" || est.lastStatus === "running";
    if (running) {
      recomputeSawRunning.current = true;
      return;
    }
    const base = recomputeBaseline.current;
    // With a pre-save baseline we detect a fresh finish by the phase's `lastRun`
    // moving past the captured value. An adopted run has no baseline, so we
    // can't use that signal — instead each phase must actually reach a terminal
    // status. Otherwise the brief gap after invoices finishes but before
    // estimates starts (neither phase "running") would resolve prematurely to a
    // false "complete".
    const isTerminal = (s: string) => s === "completed" || s === "error";
    const invDone = base ? inv.lastRun !== base.inv : isTerminal(inv.lastStatus);
    const estDone = base ? est.lastRun !== base.est : isTerminal(est.lastStatus);
    if (recomputeSawRunning.current && invDone && estDone) {
      const failed = inv.lastStatus === "error" || est.lastStatus === "error";
      setRecomputeOutcome(failed ? "failed" : "success");
      setRecomputeArmed(false);
      recomputeSawRunning.current = false;
      return;
    }
    if (!recomputeSawRunning.current && Date.now() - recomputeArmedAt.current > 15000) {
      setRecomputeArmed(false);
    }
  }, [recomputePhases, recomputeArmed]);

  // Auto-dismiss the success note; failures persist until the next save.
  useEffect(() => {
    if (recomputeOutcome !== "success") return;
    const t = setTimeout(() => setRecomputeOutcome(null), 8000);
    return () => clearTimeout(t);
  }, [recomputeOutcome]);

  useEffect(() => {
    if (!tenantId || isClientUser) return;
    fetch(`${API}/api/tenants/${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => {
        const lc = data.loadableConfig || {};
        const rc = data.revenueConfig || {};
        const labels = Array.isArray(rc.rebateLabels) ? rc.rebateLabels : [];
        setRebateLabels(labels);
        setRebateInitial(labels);
        setRebateUsingDefaults(rc.usingDefaults !== false);
        setForm(f => ({
          ...f,
          serviceTitanId: data.serviceTitanId || "",
          googleAdsCustomerId: lc.googleAdsCustomerId || "",
          metaAdAccountId: lc.metaAdAccountId || "",
          callRailAccountId: lc.callRailAccountId || "",
          callRailApiKey: lc.callRailApiKey || "",
          callRailCompanyId: lc.callRailCompanyId || "",
          callRailTrackingNumber: lc.callRailTrackingNumber || "",
          ghlApiKey: lc.ghlApiKey || "",
          podiumApiToken: lc.podiumApiToken || "",
          podiumLocationId: lc.podiumLocationId || "",
        }));
        setDirtyFields(new Set());
        const cc = data.communicationConfig || {};
        const loadedComm = {
          callPlatform: cc.callPlatform || "native",
          textPlatform: cc.textPlatform || "native",
        };
        setCommConfig(loadedComm);
        setCommInitial(loadedComm);
      })
      .catch(() => {});

    const commConfigUrl = `${API}/api/leads/comm-config${tenantId ? `?tenantId=${tenantId}` : ""}`;
    fetch(commConfigUrl, { credentials: "include" })
      .then(r => r.json())
      .then(data => setCommStatus({ callReady: data.callReady, textReady: data.textReady, callStatusMessage: data.callStatusMessage, textStatusMessage: data.textStatusMessage }))
      .catch(() => {});

  }, [tenantId, isClientUser]);

  function trackField(field: string) {
    setSaveError(null);
    setDirtyFields(prev => new Set(prev).add(field));
  }

  async function handleSave() {
    if (!tenantId) return;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isMasked = (v: string) => v.startsWith("••••") || v.startsWith("****");
    if (form.podiumLocationId && !isMasked(form.podiumLocationId) && !uuidRe.test(form.podiumLocationId)) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const integrationConfig: Record<string, string | null> = {};
      const configKeys = ["googleAdsCustomerId", "metaAdAccountId", "ghlApiKey", "callRailAccountId", "callRailApiKey", "callRailCompanyId", "callRailTrackingNumber", "podiumApiToken", "podiumLocationId"] as const;
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
          ...(form.serviceTitanId ? { serviceTitanId: form.serviceTitanId } : {}),
          ...(Object.keys(integrationConfig).length > 0 ? { integrationConfig } : {}),
        }),
      });
      if (res.ok) {
        setSaved(true);
        setDirtyFields(new Set());
        setTimeout(() => setSaved(false), 2000);
      } else {
        let message = "Couldn't save configuration. Please try again.";
        try {
          const data = await res.json();
          if (data && typeof data.error === "string" && data.error.trim()) {
            message = data.error;
          } else if (res.status === 403) {
            message = "You don't have permission to modify these settings.";
          }
        } catch {
          if (res.status === 403) {
            message = "You don't have permission to modify these settings.";
          }
        }
        setSaveError(message);
      }
    } catch {
      setSaveError("Couldn't reach the server. Check your connection and try again.");
    }
    setSaving(false);
  }

  function addRebateLabel() {
    const label = rebateInput.trim();
    if (!label) return;
    if (rebateLabels.some(l => l.toLowerCase() === label.toLowerCase())) {
      setRebateInput("");
      return;
    }
    setRebateError(null);
    setRebateLabels(prev => [...prev, label]);
    setRebateInput("");
  }

  function removeRebateLabel(index: number) {
    setRebateError(null);
    setRebateLabels(prev => prev.filter((_, i) => i !== index));
  }

  async function handleRebateSave() {
    if (!tenantId) return;
    // The server only kicks off a historical recompute when the list actually
    // changes; mirror that here so we don't arm a progress indicator for a
    // no-op save.
    const willRecompute = rebateDirty;
    // Capture each phase's last-completion timestamp BEFORE the save so we can
    // tell a fresh recompute apart from a stale earlier run.
    let baseInv: string | null = null;
    let baseEst: string | null = null;
    if (willRecompute) {
      try {
        const sres = await fetch(`${API}/api/integrations/sync-status?tenantId=${tenantId}`, { credentials: "include" });
        if (sres.ok) {
          const sdata = await sres.json();
          const st = sdata?.statusByIntegration?.service_titan?.syncTypes || {};
          baseInv = typeof st.invoices?.lastRun === "string" ? st.invoices.lastRun : null;
          baseEst = typeof st.estimates?.lastRun === "string" ? st.estimates.lastRun : null;
        }
      } catch { /* baseline best-effort */ }
    }
    setRebateSaving(true);
    setRebateError(null);
    try {
      const res = await fetch(`${API}/api/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ revenueConfig: { rebateLabels } }),
      });
      if (res.ok) {
        const data = await res.json();
        const rc = data.revenueConfig || {};
        const labels = Array.isArray(rc.rebateLabels) ? rc.rebateLabels : [];
        setRebateLabels(labels);
        setRebateInitial(labels);
        setRebateUsingDefaults(rc.usingDefaults !== false);
        setRebateSaved(true);
        setTimeout(() => setRebateSaved(false), 2000);
        if (willRecompute) {
          recomputeBaseline.current = { inv: baseInv, est: baseEst };
          recomputeSawRunning.current = false;
          recomputeArmedAt.current = Date.now();
          setRecomputeOutcome(null);
          setRecomputeArmed(true);
          fetchRecomputeStatus();
        }
      } else {
        let message = "Couldn't save rebate programs. Please try again.";
        try {
          const data = await res.json();
          if (data && typeof data.error === "string" && data.error.trim()) {
            message = data.error;
          } else if (res.status === 403) {
            message = "You don't have permission to modify revenue settings.";
          }
        } catch {
          if (res.status === 403) {
            message = "You don't have permission to modify revenue settings.";
          }
        }
        setRebateError(message);
      }
    } catch {
      setRebateError("Couldn't reach the server. Check your connection and try again.");
    }
    setRebateSaving(false);
  }

  async function handleCommSave() {
    if (!tenantId) return;
    setCommSaving(true);
    setCommError(null);
    try {
      const res = await fetch(`${API}/api/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ communicationConfig: commConfig }),
      });
      if (res.ok) {
        setCommSaved(true);
        setCommInitial({ ...commConfig });
        setTimeout(() => setCommSaved(false), 2000);
        const statusRes = await fetch(`${API}/api/leads/comm-config${tenantId ? `?tenantId=${tenantId}` : ""}`, { credentials: "include" });
        if (statusRes.ok) {
          const data = await statusRes.json();
          setCommStatus({ callReady: data.callReady, textReady: data.textReady, callStatusMessage: data.callStatusMessage, textStatusMessage: data.textStatusMessage });
        }
      } else {
        let message = "Couldn't save platform settings. Please try again.";
        try {
          const data = await res.json();
          if (data && typeof data.error === "string" && data.error.trim()) {
            message = data.error;
          } else if (res.status === 403) {
            message = "You don't have permission to modify these settings.";
          }
        } catch {
          if (res.status === 403) {
            message = "You don't have permission to modify these settings.";
          }
        }
        setCommError(message);
      }
    } catch {
      setCommError("Couldn't reach the server. Check your connection and try again.");
    }
    setCommSaving(false);
  }


  const [apiIntegrationsOpen, setApiIntegrationsOpen] = useState(false);
  const [commPlatformOpen, setCommPlatformOpen] = useState(false);
  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [podiumStatus, setPodiumStatus] = useState<{ connected: boolean; locationName?: string | null } | null>(null);
  const [podiumConnecting, setPodiumConnecting] = useState(false);
  const [podiumMessage, setPodiumMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetch(`${API}/api/oauth/podium/status`, { credentials: "include" })
      .then(r => r.json())
      .then(data => setPodiumStatus({ connected: data.connected, locationName: data.locationName }))
      .catch(() => setPodiumStatus(null));

    const params = new URLSearchParams(window.location.search);
    const podiumResult = params.get("podiumOAuth");
    if (podiumResult === "success") {
      setPodiumMessage({ type: "success", text: "Podium connected successfully!" });
      fetch(`${API}/api/oauth/podium/status`, { credentials: "include" })
        .then(r => r.json())
        .then(data => setPodiumStatus({ connected: data.connected, locationName: data.locationName }))
        .catch(() => {});
      const url = new URL(window.location.href);
      url.searchParams.delete("podiumOAuth");
      window.history.replaceState({}, "", url.pathname + url.search);
    } else if (podiumResult === "error") {
      const message = params.get("message") || "Unknown error";
      const readable: Record<string, string> = {
        token_exchange_failed: "Failed to exchange authorization code for tokens.",
        missing_podium_env_credentials: "Podium integration is not configured. Contact your administrator.",
        no_refresh_token: "Podium didn't return a refresh token. Please try again.",
        invalid_state: "Security validation failed. Please try again.",
      };
      setPodiumMessage({ type: "error", text: readable[message] || `OAuth error: ${message}` });
      const url = new URL(window.location.href);
      url.searchParams.delete("podiumOAuth");
      url.searchParams.delete("message");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  }, []);

  async function handleConnectPodium() {
    setPodiumConnecting(true);
    setPodiumMessage(null);
    try {
      const res = await fetch(`${API}/api/oauth/podium/authorize`, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json();
        setPodiumMessage({ type: "error", text: data.error || "Failed to start OAuth flow" });
        return;
      }
      const { authUrl } = await res.json();
      window.location.href = authUrl;
    } catch {
      setPodiumMessage({ type: "error", text: "Network error starting OAuth flow" });
    } finally {
      setPodiumConnecting(false);
    }
  }

  async function handleDisconnectPodium() {
    try {
      const res = await fetch(`${API}/api/oauth/podium/disconnect`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        setPodiumStatus({ connected: false });
        setPodiumMessage({ type: "success", text: "Podium disconnected." });
      }
    } catch {
      setPodiumMessage({ type: "error", text: "Failed to disconnect Podium" });
    }
  }

  async function handleChangePassword() {
    setPwMessage(null);
    if (!pwForm.currentPassword || !pwForm.newPassword) {
      setPwMessage({ type: "error", text: "All fields are required" });
      return;
    }
    if (pwForm.newPassword.length < 6) {
      setPwMessage({ type: "error", text: "New password must be at least 6 characters" });
      return;
    }
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      setPwMessage({ type: "error", text: "New passwords do not match" });
      return;
    }
    setPwSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword }),
      });
      if (res.ok) {
        setPwMessage({ type: "success", text: "Password changed successfully" });
        setPwForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      } else {
        const data = await res.json();
        setPwMessage({ type: "error", text: data.error || "Failed to change password" });
      }
    } catch {
      setPwMessage({ type: "error", text: "Failed to change password" });
    }
    setPwSaving(false);
  }

  const inputClass = "w-full bg-background border border-white/10 text-white rounded-lg px-4 py-3 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all";

  return (
    <div className="space-y-6 max-w-4xl">
      <header>
        <GradientHeading className="text-3xl md:text-4xl mb-2">Settings</GradientHeading>
        <p className="font-sub text-muted-foreground text-sm tracking-wide">YOUR ACCOUNT CONFIGURATION</p>
      </header>

      {isAgency && tenants.length > 0 && (
        <PremiumCard className="p-4">
          <div className="flex items-center gap-3">
            <label className="text-xs text-white/40 uppercase tracking-wider">Tenant</label>
            <Select value={selectedTenantId != null ? String(selectedTenantId) : ""} onValueChange={v => setSelectedTenantId(parseInt(v))}>
              <SelectTrigger className="bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50 w-auto min-w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tenants.map(t => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </PremiumCard>
      )}

      {isAgency && !tenantId && tenantsLoading && (
        <PremiumCard className="p-6">
          <div className="animate-pulse space-y-3">
            <div className="h-4 w-1/3 bg-white/10 rounded" />
            <div className="h-3 w-1/2 bg-white/5 rounded" />
            <div className="h-3 w-2/5 bg-white/5 rounded" />
          </div>
        </PremiumCard>
      )}

      {isAgency && !tenantId && !tenantsLoading && (
        <PremiumCard>
          <p className="text-center text-muted-foreground py-8">Select a tenant above to manage settings.</p>
        </PremiumCard>
      )}

      <PremiumCard>
        <div className="flex items-center gap-2 mb-6">
          <Lock className="w-5 h-5 text-primary" />
          <h3 className="text-xl font-display text-white">Change Password</h3>
        </div>
        {pwMessage && (
          <div className={cn(
            "px-4 py-3 rounded-lg text-sm mb-4 border",
            pwMessage.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
              : "bg-red-500/10 border-red-500/20 text-red-400"
          )}>
            {pwMessage.text}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Current Password</label>
            <input
              type="password"
              value={pwForm.currentPassword}
              onChange={e => setPwForm(f => ({ ...f, currentPassword: e.target.value }))}
              className={inputClass}
              placeholder="Enter current password"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">New Password</label>
            <input
              type="password"
              value={pwForm.newPassword}
              onChange={e => setPwForm(f => ({ ...f, newPassword: e.target.value }))}
              className={inputClass}
              placeholder="Enter new password"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Confirm New Password</label>
            <input
              type="password"
              value={pwForm.confirmPassword}
              onChange={e => setPwForm(f => ({ ...f, confirmPassword: e.target.value }))}
              className={inputClass}
              placeholder="Confirm new password"
            />
          </div>
        </div>
        <button
          onClick={handleChangePassword}
          disabled={pwSaving}
          className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all mt-4 flex items-center gap-2 disabled:opacity-50"
        >
          {pwSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
          {pwSaving ? "Changing..." : "Change Password"}
        </button>
      </PremiumCard>

      <PushNotificationCard />

      <PremiumCard>
        <div className="flex items-center gap-2 mb-4">
          <MessageSquare className="w-5 h-5 text-cyan-400" />
          <h3 className="text-xl font-display text-white">Podium Integration</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Connect your Podium account to send and receive texts through Pulse. Each user connects their own account so conversations are properly attributed.
        </p>

        {podiumMessage && (
          <div className={cn(
            "px-4 py-3 rounded-lg text-sm mb-4 border flex items-center gap-2",
            podiumMessage.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
              : "bg-red-500/10 border-red-500/20 text-red-400"
          )}>
            {podiumMessage.type === "success" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            {podiumMessage.text}
          </div>
        )}

        {podiumStatus?.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
              <CheckCircle className="w-4 h-4" />
              Connected{podiumStatus.locationName ? ` — ${podiumStatus.locationName}` : ""}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleConnectPodium}
                disabled={podiumConnecting}
                className="bg-white/10 hover:bg-white/20 text-white font-medium px-4 py-2 rounded-lg transition-all text-sm flex items-center gap-2 disabled:opacity-50"
              >
                {podiumConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                Reconnect
              </button>
              <button
                onClick={handleDisconnectPodium}
                className="bg-red-500/10 hover:bg-red-500/20 text-red-400 font-medium px-4 py-2 rounded-lg transition-all text-sm flex items-center gap-2 border border-red-500/20"
              >
                <Unplug className="w-4 h-4" />
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={handleConnectPodium}
            disabled={podiumConnecting}
            className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {podiumConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
            Connect Podium
          </button>
        )}
      </PremiumCard>

      {!isClientUser && tenantId && podiumStatus?.connected && (
        <PodiumUserLinking tenantId={tenantId} />
      )}

      {!isClientUser && tenantId && <PremiumCard>
        <button
          onClick={() => setApiIntegrationsOpen(o => !o)}
          className="w-full flex items-center justify-between"
        >
          <h3 className="text-xl font-display text-white">API Integrations</h3>
          <ChevronDown className={cn("w-5 h-5 text-gray-400 transition-transform duration-200", apiIntegrationsOpen && "rotate-180")} />
        </button>
        {apiIntegrationsOpen ? <div className="space-y-5 mt-6">
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
          <div className="space-y-2 border border-white/10 rounded-lg p-4 bg-white/5">
            <label className="text-sm font-medium text-gray-300">Rebate Programs Counted as Revenue</label>
            <p className="text-xs text-gray-500">
              ServiceTitan subtracts these rebates (e.g. ETO, Energy Trust, ODEE) from the invoice total,
              but the company still collects the money — so they're added back as real revenue. Genuine
              discounts and coupons are never added back. Add a program's name as it appears on the line item.
            </p>
            {rebateUsingDefaults && (
              <p className="text-xs text-amber-400/80">Currently using the default programs. Editing creates a custom list for this client.</p>
            )}
            <div className="flex flex-wrap gap-2 mt-2">
              {rebateLabels.length === 0 && (
                <span className="text-xs text-gray-500 italic">No rebate programs — no rebates will be added back to revenue.</span>
              )}
              {rebateLabels.map((label, i) => (
                <span key={`${label}-${i}`} className="inline-flex items-center gap-1.5 bg-primary/15 border border-primary/30 text-white text-sm px-3 py-1.5 rounded-full">
                  {label}
                  {isAgency && (
                    <button
                      type="button"
                      onClick={() => removeRebateLabel(i)}
                      className="text-gray-400 hover:text-red-400 transition-colors"
                      aria-label={`Remove ${label}`}
                    >
                      <XCircle className="w-3.5 h-3.5" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {!isAgency && (
              <p className="text-xs text-amber-400/80 mt-2">
                Only agency users can change which rebate programs count as revenue. Contact your agency to update this list.
              </p>
            )}
            {isAgency && (
            <div className="flex gap-2 mt-2">
              <input
                type="text"
                value={rebateInput}
                onChange={e => setRebateInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addRebateLabel(); } }}
                className={inputClass}
                placeholder="e.g. PGE Rebate"
              />
              <button
                type="button"
                onClick={addRebateLabel}
                disabled={!rebateInput.trim()}
                className="bg-white/10 hover:bg-white/20 text-white font-medium px-4 py-2 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                Add
              </button>
            </div>
            )}
            {rebateError && (
              <div className="flex items-start gap-2 mt-3 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2" role="alert">
                <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{rebateError}</span>
              </div>
            )}
            {isAgency && (
            <button
              type="button"
              onClick={handleRebateSave}
              disabled={rebateSaving || (!rebateDirty && !rebateSaved)}
              className="bg-primary hover:bg-primary/90 text-white font-medium px-4 py-2 rounded-lg transition-all mt-3 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {rebateSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : rebateSaved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
              {rebateSaved ? "Saved!" : "Save Rebate Programs"}
            </button>
            )}
            {isAgency && (
            <>
            {!(recomputeArmed || recomputeRunning) && recomputeOutcome === null && (
              <p className="text-xs text-gray-500 mt-1">
                Saving a changed list automatically re-applies it to existing invoices and estimates.
              </p>
            )}
            {(recomputeArmed || recomputeRunning) && (() => {
              const inv = recomputePhases?.invoices;
              const est = recomputePhases?.estimates;
              const phaseRow = (name: string, phase: RecomputePhase | undefined) => {
                const status = phase?.lastStatus;
                const rows = phase?.recordsProcessed ?? 0;
                const total = phase?.totalRecords ?? null;
                const isRunning = status === "running";
                const isDone = status === "completed" || status === "error";
                const percent =
                  isRunning && total && total > 0
                    ? Math.max(0, Math.min(100, Math.round((rows / total) * 100)))
                    : null;
                return (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-1.5 text-gray-300">
                        {isRunning ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
                        ) : isDone ? (
                          <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Clock className="w-3.5 h-3.5 text-gray-500" />
                        )}
                        {name}
                      </span>
                      <span className="text-gray-500">
                        {isRunning
                          ? percent != null
                            ? `${rows.toLocaleString()} / ~${total!.toLocaleString()} (${percent}%)`
                            : `${rows.toLocaleString()} processed…`
                          : isDone
                            ? `${rows.toLocaleString()} done`
                            : "queued"}
                      </span>
                    </div>
                    {isRunning && (
                      <div className="h-1.5 w-full bg-white/10 rounded overflow-hidden">
                        <div
                          className={cn("h-full bg-blue-400/70 transition-all", percent == null && "animate-pulse")}
                          style={{ width: `${percent ?? 100}%` }}
                        />
                      </div>
                    )}
                  </div>
                );
              };
              // The endpoint runs invoices then estimates, one phase running
              // at a time. The cancel button targets whichever phase currently
              // owns a `running` sync log.
              const runningPhase = inv?.lastStatus === "running" ? inv
                : est?.lastStatus === "running" ? est
                  : null;
              const runningLogId = runningPhase?.runningLogId ?? null;
              const isCancelling = (runningPhase?.cancelRequested ?? false)
                || (runningLogId ? !!cancellingLogIds[runningLogId] : false);
              return (
                <div className="mt-3 rounded-lg border border-blue-400/20 bg-blue-500/[0.06] p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-blue-300">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Recomputing historical revenue…
                    </p>
                    {runningLogId && (
                      isCancelling ? (() => {
                        const startedAt = cancelStartedAt[runningLogId];
                        const elapsedMs = startedAt ? Date.now() - startedAt : Number.MAX_SAFE_INTEGER;
                        const showForce = !startedAt || elapsedMs > FORCE_CANCEL_DELAY_MS;
                        const secondsLeft = startedAt ? Math.max(0, Math.ceil((FORCE_CANCEL_DELAY_MS - elapsedMs) / 1000)) : 0;
                        return (
                          <span className="flex items-center gap-1.5">
                            <span className="text-[11px] text-amber-400">Cancelling…</span>
                            {showForce ? (
                              <button
                                onClick={() => cancelRecompute(runningLogId, true)}
                                title="Worker may be stuck — hard-flip the run to cancelled"
                                className="text-[10px] px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/15 text-red-200 hover:bg-red-500/25 transition-colors"
                              >
                                Force cancel
                              </button>
                            ) : (
                              <span className="text-[10px] text-white/40">(force in {secondsLeft}s)</span>
                            )}
                          </span>
                        );
                      })() : (
                        <button
                          onClick={() => cancelRecompute(runningLogId)}
                          className="text-[11px] py-0.5 px-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-400/30 rounded text-red-300 transition-colors"
                          title="Stop the recompute after the current batch. Rows already processed are kept."
                        >
                          Cancel
                        </button>
                      )
                    )}
                  </div>
                  <p className="text-[11px] text-gray-500">
                    Re-applying the rebate program list to existing invoices and estimates. You can leave this page — it'll keep running.
                  </p>
                  {phaseRow("Invoices", inv)}
                  {phaseRow("Estimates", est)}
                </div>
              );
            })()}
            {!(recomputeArmed || recomputeRunning) && recomputeOutcome === "success" && (
              <div className="mt-3 rounded-lg border border-emerald-400/20 bg-emerald-500/[0.06] p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-300">
                  <CheckCircle className="w-3.5 h-3.5" />
                  Revenue recompute complete — historical totals now reflect the updated rebate programs.
                </p>
              </div>
            )}
            {!(recomputeArmed || recomputeRunning) && recomputeOutcome === "failed" && (
              <div className="mt-3 rounded-lg border border-red-400/20 bg-red-500/[0.06] p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium text-red-300">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Revenue recompute failed. The rebate list was saved, but historical totals weren't updated — retry from the integrations admin page.
                </p>
              </div>
            )}
            </>
            )}
          </div>
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
            <label className="text-sm font-medium text-gray-300">CallRail Account ID</label>
            <input
              type="text"
              value={form.callRailAccountId}
              onChange={e => { trackField("callRailAccountId"); setForm({ ...form, callRailAccountId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. 123456789"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">CallRail API Key</label>
            <input
              type={dirtyFields.has("callRailApiKey") ? "password" : "text"}
              value={form.callRailApiKey}
              onFocus={() => { if (!dirtyFields.has("callRailApiKey") && form.callRailApiKey.startsWith("••••")) { setForm({ ...form, callRailApiKey: "" }); trackField("callRailApiKey"); } }}
              onChange={e => { trackField("callRailApiKey"); setForm({ ...form, callRailApiKey: e.target.value }); }}
              className={inputClass}
              placeholder="Enter to update"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">CallRail Company ID</label>
            <input
              type="text"
              value={form.callRailCompanyId}
              onChange={e => { trackField("callRailCompanyId"); setForm({ ...form, callRailCompanyId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. COM123456"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">CallRail Tracking Number (optional)</label>
            <input
              type="text"
              value={form.callRailTrackingNumber}
              onChange={e => { trackField("callRailTrackingNumber"); setForm({ ...form, callRailTrackingNumber: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. +18005551234"
            />
            <p className="text-xs text-gray-500">Reference field — outbound SMS via CallRail is not yet wired up.</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">GoHighLevel API Key</label>
            <input
              type={dirtyFields.has("ghlApiKey") ? "password" : "text"}
              value={form.ghlApiKey}
              onFocus={() => { if (!dirtyFields.has("ghlApiKey") && form.ghlApiKey.startsWith("••••")) { setForm({ ...form, ghlApiKey: "" }); trackField("ghlApiKey"); } }}
              onChange={e => { trackField("ghlApiKey"); setForm({ ...form, ghlApiKey: e.target.value }); }}
              className={inputClass}
              placeholder="Enter to update"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Podium API Token</label>
            <input
              type={dirtyFields.has("podiumApiToken") ? "password" : "text"}
              value={form.podiumApiToken}
              onFocus={() => { if (!dirtyFields.has("podiumApiToken") && form.podiumApiToken.startsWith("••••")) { setForm({ ...form, podiumApiToken: "" }); trackField("podiumApiToken"); } }}
              onChange={e => { trackField("podiumApiToken"); setForm({ ...form, podiumApiToken: e.target.value }); }}
              className={inputClass}
              placeholder="Enter to update"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-300">Podium Location UID</label>
            <input
              type="text"
              value={form.podiumLocationId}
              onChange={e => { trackField("podiumLocationId"); setForm({ ...form, podiumLocationId: e.target.value }); }}
              className={inputClass}
              placeholder="e.g. 12345678-abcd-1234-abcd-123456789012"
            />
            {form.podiumLocationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(form.podiumLocationId) && !form.podiumLocationId.startsWith("••••") && !form.podiumLocationId.startsWith("****") && (
              <p className="text-xs text-red-400">Must be a valid UUID format</p>
            )}
          </div>
          {saveError && (
            <div className="flex items-start gap-2 mt-4 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2" role="alert">
              <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}
          <button
            onClick={handleSave}
            disabled={saving || (dirtyFields.size === 0 && !saved)}
            className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all mt-4 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saved ? "Saved!" : "Save Configuration"}
          </button>
        </div> : null}
      </PremiumCard>}

      {!isClientUser && tenantId && <PremiumCard>
        <button
          onClick={() => setCommPlatformOpen(o => !o)}
          className="w-full flex items-center justify-between"
        >
          <h3 className="text-xl font-display text-white">Communication Platform</h3>
          <ChevronDown className={cn("w-5 h-5 text-gray-400 transition-transform duration-200", commPlatformOpen && "rotate-180")} />
        </button>
        {commPlatformOpen ? <div className="mt-4">
        <p className="text-sm text-muted-foreground mb-6">
          Choose how Pulse routes calls and texts. Configure API credentials above, then select your preferred platforms here.
        </p>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-2">
              <Phone className="w-4 h-4 text-emerald-400" />
              <label className="text-sm font-medium text-gray-300">Call Platform</label>
            </div>
            <div className="space-y-2">
              {[
                { value: "none", label: "None", desc: "No communication trigger — action is logged only" },
                { value: "native", label: "Native Phone Dialer", desc: "Opens system phone app" },
                { value: "callrail", label: "CallRail", desc: "Click-to-call via CallRail API" },
                { value: "podium", label: "Podium", desc: "Call routing via Podium API" },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setCommError(null); setCommConfig(c => ({ ...c, callPlatform: opt.value })); }}
                  className={cn(
                    "w-full text-left px-4 py-3 rounded-lg border transition-all",
                    commConfig.callPlatform === opt.value
                      ? "bg-emerald-500/10 border-emerald-500/30 text-white"
                      : "bg-white/5 border-white/10 text-gray-400 hover:border-white/20"
                  )}
                >
                  <span className="text-sm font-medium">{opt.label}</span>
                  <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                </button>
              ))}
            </div>
            {commStatus && (
              <div className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-xs",
                commStatus.callReady ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400" : "bg-red-500/10 border border-red-500/20 text-red-400"
              )}>
                {commStatus.callReady ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                {commStatus.callStatusMessage}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare className="w-4 h-4 text-blue-400" />
              <label className="text-sm font-medium text-gray-300">Text Platform</label>
            </div>
            <div className="space-y-2">
              {[
                { value: "none", label: "None", desc: "No communication trigger — action is logged only" },
                { value: "native", label: "Native SMS App", desc: "Opens system messaging app" },
                { value: "callrail", label: "CallRail", desc: "Send texts via CallRail API" },
                { value: "podium", label: "Podium", desc: "Send texts via Podium API" },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setCommError(null); setCommConfig(c => ({ ...c, textPlatform: opt.value })); }}
                  className={cn(
                    "w-full text-left px-4 py-3 rounded-lg border transition-all",
                    commConfig.textPlatform === opt.value
                      ? "bg-blue-500/10 border-blue-500/30 text-white"
                      : "bg-white/5 border-white/10 text-gray-400 hover:border-white/20"
                  )}
                >
                  <span className="text-sm font-medium">{opt.label}</span>
                  <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                </button>
              ))}
            </div>
            {commStatus && (
              <div className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-xs",
                commStatus.textReady ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400" : "bg-red-500/10 border border-red-500/20 text-red-400"
              )}>
                {commStatus.textReady ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                {commStatus.textStatusMessage}
              </div>
            )}
          </div>
        </div>

        {commError && (
          <div className="flex items-start gap-2 mt-6 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2" role="alert">
            <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{commError}</span>
          </div>
        )}
        <button
          onClick={handleCommSave}
          disabled={commSaving || (!commDirty && !commSaved)}
          className="bg-primary hover:bg-primary/90 text-white font-medium px-6 py-3 rounded-lg transition-all mt-6 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {commSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : commSaved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {commSaved ? "Saved!" : "Save Platform Settings"}
        </button>
        </div> : null}
      </PremiumCard>}

      {!isClientUser && tenantId && (
        <IngestionModeSettings tenantId={tenantId} />
      )}

      {!isClientUser && tenantId && (
        <TrackerHealthSettings tenantId={tenantId} />
      )}

      {isClientUser && (
        <PremiumCard>
          <h3 className="text-xl font-display text-white mb-4">Account Information</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-white/10">
              <span className="text-sm text-gray-400">Name</span>
              <span className="text-sm text-white">{user?.name || "—"}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-white/10">
              <span className="text-sm text-gray-400">Email</span>
              <span className="text-sm text-white">{user?.email || "—"}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-gray-400">Organization</span>
              <span className="text-sm text-white">{user?.tenantName || "—"}</span>
            </div>
          </div>
        </PremiumCard>
      )}
    </div>
  );
}

interface AliasGroup { funnelTypeId: number; funnelName: string; aliases: { id: number; alias: string }[] }

function IngestionModeSettings({ tenantId }: { tenantId: number }) {
  const [mode, setMode] = useState("sheets");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [snippetError, setSnippetError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [aliasGroups, setAliasGroups] = useState<AliasGroup[]>([]);
  const [tenantFunnels, setTenantFunnels] = useState<{ id: number; name: string }[]>([]);
  const [newAlias, setNewAlias] = useState("");
  const [newFunnelTypeId, setNewFunnelTypeId] = useState<number | "">("");

  const loadAliases = async () => {
    const r = await fetch(`${API_BASE}/api/funnel-aliases?tenantId=${tenantId}`, { credentials: "include" });
    const d = await r.json();
    setAliasGroups(d.aliases || []);
  };

  useEffect(() => {
    setLoading(true);
    setSnippet(null);
    setSnippetError(null);
    Promise.all([
      fetch(`${API_BASE}/api/ingestion-mode?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json()),
      fetch(`${API_BASE}/api/ingestion-mode/gtm-snippet?tenantId=${tenantId}`, { credentials: "include" }).then(r => r.json().then(d => ({ ok: r.ok, data: d }))),
    ]).then(([modeData, snippetResult]) => {
      setMode(modeData.mode || "sheets");
      if (snippetResult.ok) {
        setSnippet(snippetResult.data.snippet || null);
      } else {
        setSnippetError(snippetResult.data.error || "Failed to load snippet");
      }
    }).catch(() => { setSnippetError("Failed to load snippet"); }).finally(() => setLoading(false));
    loadAliases();
    fetch(`${API}/api/tenants/${tenantId}/funnel-types`, { credentials: "include" })
      .then(r => r.json()).then(d => setTenantFunnels(Array.isArray(d) ? d.map((f: Record<string, unknown>) => ({ id: Number(f.funnelTypeId || f.id), name: String(f.funnelName || f.name || "") })) : []))
      .catch(() => setTenantFunnels([]));
  }, [tenantId]);

  const addAlias = async () => {
    if (!newAlias.trim() || !newFunnelTypeId) return;
    await fetch(`${API_BASE}/api/funnel-aliases?tenantId=${tenantId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ funnelTypeId: newFunnelTypeId, alias: newAlias.trim() }),
    });
    setNewAlias(""); setNewFunnelTypeId("");
    loadAliases();
  };

  const deleteAlias = async (id: number) => {
    await fetch(`${API_BASE}/api/funnel-aliases/${id}?tenantId=${tenantId}`, { method: "DELETE", credentials: "include" });
    loadAliases();
  };

  const updateMode = async (newMode: string) => {
    setSaving(true);
    const res = await fetch(`${API_BASE}/api/ingestion-mode?tenantId=${tenantId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: newMode }),
    });
    if (res.ok) setMode(newMode);
    setSaving(false);
  };

  if (loading) return null;

  const steps = [
    { key: "sheets", label: "Sheets Only", desc: "Leads from sheet sync only" },
    { key: "both", label: "Dual Mode", desc: "Both sheet sync and tracker" },
    { key: "tracker", label: "Tracker Only", desc: "All leads from tracker" },
  ];

  return (
    <>
      <PremiumCard>
        <div className="flex items-center gap-2 mb-4">
          <Wifi className="w-5 h-5 text-primary" />
          <h3 className="text-xl font-display text-white">Lead Ingestion Mode</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Control how leads enter the system for this tenant.</p>
        <div className="grid gap-3 md:grid-cols-3">
          {steps.map(step => (
            <button
              key={step.key}
              disabled={saving}
              onClick={() => updateMode(step.key)}
              className={cn(
                "p-4 rounded-xl border text-left transition-all",
                mode === step.key
                  ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                  : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
              )}
            >
              {mode === step.key && <Check className="w-4 h-4 text-primary float-right" />}
              <h4 className="font-medium text-sm text-white mb-1">{step.label}</h4>
              <p className="text-xs text-muted-foreground">{step.desc}</p>
            </button>
          ))}
        </div>
      </PremiumCard>

      <PremiumCard>
        <div className="flex items-center gap-2 mb-4">
          <Key className="w-5 h-5 text-primary" />
          <h3 className="text-xl font-display text-white">GTM Tracking Snippet</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Copy this into your Google Tag Manager custom HTML tag.</p>
        {snippetError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">
            <p className="text-xs text-red-400">{snippetError}</p>
          </div>
        )}
        {snippet ? (
          <div className="relative">
            <button
              onClick={() => { navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="absolute top-3 right-3 p-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-white/60" />}
            </button>
            <pre className="bg-black/40 border border-white/10 rounded-lg p-4 text-xs text-emerald-300/80 overflow-x-auto font-mono whitespace-pre-wrap">
              {snippet}
            </pre>
          </div>
        ) : !snippetError && (
          <p className="text-sm text-muted-foreground">Loading snippet...</p>
        )}
      </PremiumCard>

      <PremiumCard>
        <div className="flex items-center gap-2 mb-4">
          <Link2 className="w-5 h-5 text-primary" />
          <h3 className="text-xl font-display text-white">Funnel Aliases</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">Map alternate funnel names to their canonical funnel types.</p>
        <div className="flex gap-2 mb-4">
          <select value={newFunnelTypeId} onChange={e => setNewFunnelTypeId(e.target.value ? Number(e.target.value) : "")}
            className="bg-background border border-white/10 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all min-w-[160px]">
            <option value="">Select funnel...</option>
            {tenantFunnels.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <input value={newAlias} onChange={e => setNewAlias(e.target.value)} placeholder="Alias (e.g. fb-funnel)"
            className="flex-1 bg-background border border-white/10 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all" />
          <button onClick={addAlias} className="bg-primary hover:bg-primary/90 text-white px-4 py-3 rounded-lg text-sm font-medium transition-all shadow-[0_0_15px_rgba(242,5,5,0.3)]">
            Add
          </button>
        </div>
        {aliasGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No funnel aliases configured for this tenant.</p>
        ) : (
          <div className="space-y-3">
            {aliasGroups.map(g => (
              <div key={g.funnelTypeId}>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{g.funnelName}</p>
                <div className="space-y-1">
                  {g.aliases.map(a => (
                    <div key={a.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-white/[0.02] border border-white/5">
                      <span className="text-sm text-white font-medium">{a.alias}</span>
                      <button onClick={() => deleteAlias(a.id)} className="text-muted-foreground hover:text-red-400 p-1 transition-colors">
                        <XCircle className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </PremiumCard>
    </>
  );
}

interface InstallSnippetVariant {
  label: string;
  description: string;
  placement: string;
  snippet: string;
}
interface InstallSnippetResponse {
  tenantId: number;
  tenantName: string;
  clientSlug: string;
  scriptUrl: string;
  suggestedFunnels: string[];
  funnelNote: string | null;
  variants: InstallSnippetVariant[];
  builderGuidance: { builder: string; instructions: string }[];
}

interface StatusBuckets {
  s200: number;
  s400: number;
  s404: number;
  s429: number;
  s500: number;
  other: number;
}

interface RecentAttempt {
  createdAt: string;
  kind: string;
  endpoint: string;
  httpStatus: number;
  outcome: string;
  message: string | null;
  origin: string | null;
  contentLength: number | null;
}

interface DomainHealthRow {
  domain: string;
  lastSubmitAt: string | null;
  lastSubmitStatus: number | null;
  lastSubmitOutcome: string | null;
  lastHeartbeatAt: string | null;
  lastPulseVersion: string | null;
  scriptSource: "pulse" | "unknown" | "no-tracker";
  submitCount24h: number;
  submitCount7d: number;
  statusBuckets24h: StatusBuckets;
  statusBuckets7d: StatusBuckets;
  recentAttempts: RecentAttempt[];
}

function TrackerHealthSettings({ tenantId }: { tenantId: number }) {
  const [data, setData] = useState<InstallSnippetResponse | null>(null);
  const [domains, setDomains] = useState<DomainHealthRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setDomains(null);
    Promise.all([
      fetch(`${API_BASE}/api/tracker/install-snippet?tenantId=${tenantId}`, { credentials: "include" })
        .then(async r => {
          if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
          return r.json() as Promise<InstallSnippetResponse>;
        }),
      fetch(`${API_BASE}/api/tracker/health-rollup?tenantId=${tenantId}`, { credentials: "include" })
        .then(async r => {
          if (!r.ok) return { domains: [] as DomainHealthRow[] };
          return r.json() as Promise<{ domains: DomainHealthRow[] }>;
        })
        .catch(() => ({ domains: [] as DomainHealthRow[] })),
    ])
      .then(([snippetData, rollupData]) => {
        setData(snippetData);
        setDomains(rollupData.domains || []);
      })
      .catch(e => setError(e.message || "Failed to load install snippet"))
      .finally(() => setLoading(false));
  }, [tenantId]);

  const copy = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 2000);
    } catch {
      /* ignore */
    }
  };

  if (loading) return null;

  return (
    <PremiumCard>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-xl font-display text-white">Tracker Health — Pulse install</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Per-tenant install snippet for pulse.js. Paste into the &lt;head&gt; of every landing page that should attribute leads to{" "}
            <span className="text-white">{data?.tenantName || "this tenant"}</span>.
          </p>
        </div>
        <a
          href={`${API_BASE}/verify-tracker`}
          className="text-xs px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/5 text-white/80 shrink-0"
        >
          Open Verify Tracker
        </a>
      </div>

      {error && (
        <div className="border border-red-500/30 bg-red-500/[0.05] text-red-300 text-sm rounded-md px-3 py-2 mb-3">{error}</div>
      )}

      {data?.funnelNote && (
        <div className="border border-amber-500/30 bg-amber-500/[0.05] text-amber-200 text-sm rounded-md px-3 py-2 mb-4">
          {data.funnelNote}
          {data.suggestedFunnels.length > 0 && (
            <div className="mt-1 text-xs text-amber-200/80">
              Suggested funnel slugs: {data.suggestedFunnels.map(f => <code key={f} className="text-white/80 mr-2">{f}</code>)}
            </div>
          )}
        </div>
      )}

      {data && (
        <div className="space-y-4">
          {data.variants.map((v, idx) => (
            <div key={v.label} className="border border-white/10 bg-white/[0.02] rounded-lg p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <div className="text-sm font-medium text-white">{v.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{v.description}</div>
                </div>
                <button
                  onClick={() => copy(v.snippet, idx)}
                  className="text-xs px-3 py-1.5 rounded-md border border-white/15 hover:bg-white/10 text-white/80 shrink-0"
                >
                  {copiedIdx === idx ? "Copied!" : "Copy"}
                </button>
              </div>
              <pre className="text-xs bg-black/40 border border-white/5 rounded px-3 py-2 overflow-x-auto text-white/85 whitespace-pre">
                <code>{v.snippet}</code>
              </pre>
              <p className="text-[11px] text-muted-foreground mt-2">{v.placement}</p>
            </div>
          ))}

          <div className="border border-white/10 bg-white/[0.02] rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium text-white">Per-domain health (last 30 days)</div>
              <div className="text-[11px] text-muted-foreground">Each landing page that has talked to pulse.js, with most recent submit + 24h/7d submit volume.</div>
            </div>
            {domains && domains.length === 0 && (
              <div className="text-xs text-muted-foreground italic">
                No tracker traffic yet for this tenant in the last 30 days. Once the snippet above is installed and a page loads, that domain will appear here.
              </div>
            )}
            {domains && domains.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[11px] uppercase tracking-wider text-white/50">
                    <tr className="border-b border-white/10">
                      <th className="text-left py-2 pr-3 font-medium">Domain</th>
                      <th className="text-left py-2 pr-3 font-medium">Source</th>
                      <th className="text-left py-2 pr-3 font-medium">Last heartbeat</th>
                      <th className="text-left py-2 pr-3 font-medium">Last submit</th>
                      <th className="text-left py-2 pr-3 font-medium">Outcome</th>
                      <th className="text-left py-2 pr-3 font-medium">7d status</th>
                      <th className="text-right py-2 pr-3 font-medium">24h</th>
                      <th className="text-right py-2 font-medium">7d</th>
                    </tr>
                  </thead>
                  <tbody>
                    {domains.map(d => {
                      const ok = d.lastSubmitOutcome === "accepted" || d.lastSubmitOutcome === "duplicate" || d.lastSubmitOutcome === "resubmitted";
                      const outcomeClass = !d.lastSubmitOutcome
                        ? "text-white/40"
                        : ok
                          ? "text-emerald-300"
                          : "text-red-300";
                      const submitTs = d.lastSubmitAt ? new Date(d.lastSubmitAt).toLocaleString() : "—";
                      const hbTs = d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt).toLocaleString() : "—";
                      const buckets = d.statusBuckets7d;
                      const Pill = ({ label, n, cls }: { label: string; n: number; cls: string }) =>
                        n > 0 ? <span className={`inline-block px-1.5 py-0.5 rounded mr-1 text-[10px] ${cls}`}>{label} {n}</span> : null;
                      const sourcePill = d.scriptSource === "pulse"
                        ? { label: `pulse${d.lastPulseVersion ? ` ${d.lastPulseVersion}` : ""}`, cls: "bg-emerald-500/15 text-emerald-200", title: "Heartbeats arriving with pulse.js — install looks current." }
                        : d.scriptSource === "unknown"
                          ? { label: "unknown tracker", cls: "bg-amber-500/15 text-amber-200", title: "Heartbeats arriving without a pulse_version header. Likely legacy Optics tracker.js or a hand-rolled script — recommend swapping to the snippet above." }
                          : { label: "no tracker", cls: "bg-red-500/15 text-red-200", title: "No heartbeats from this domain in the last 30 days. The snippet above is not installed (or pages aren't loading)." };
                      return (
                        <Fragment key={d.domain}>
                          <tr className="border-b border-white/5 align-top">
                            <td className="py-2 pr-3 text-white/85 font-mono">{d.domain}</td>
                            <td className="py-2 pr-3">
                              <span title={sourcePill.title} className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${sourcePill.cls}`}>{sourcePill.label}</span>
                            </td>
                            <td className="py-2 pr-3 text-muted-foreground">{hbTs}</td>
                            <td className="py-2 pr-3 text-muted-foreground">{submitTs}</td>
                            <td className={`py-2 pr-3 ${outcomeClass}`}>
                              {d.lastSubmitOutcome || "—"}
                              {d.lastSubmitStatus ? <span className="text-white/40 ml-1">({d.lastSubmitStatus})</span> : null}
                            </td>
                            <td className="py-2 pr-3">
                              <Pill label="200" n={buckets.s200} cls="bg-emerald-500/15 text-emerald-200" />
                              <Pill label="400" n={buckets.s400} cls="bg-amber-500/15 text-amber-200" />
                              <Pill label="404" n={buckets.s404} cls="bg-amber-500/15 text-amber-200" />
                              <Pill label="429" n={buckets.s429} cls="bg-orange-500/15 text-orange-200" />
                              <Pill label="500" n={buckets.s500} cls="bg-red-500/15 text-red-200" />
                              <Pill label="other" n={buckets.other} cls="bg-white/10 text-white/70" />
                            </td>
                            <td className="py-2 pr-3 text-right text-white/80">{d.submitCount24h.toLocaleString()}</td>
                            <td className="py-2 text-right text-white/80">{d.submitCount7d.toLocaleString()}</td>
                          </tr>
                          {d.recentAttempts.length > 0 && (
                            <tr className="border-b border-white/10">
                              <td colSpan={8} className="py-2 pr-3 pl-4 bg-black/20">
                                <details>
                                  <summary className="text-[11px] text-white/50 cursor-pointer hover:text-white/80">
                                    Recent attempts ({d.recentAttempts.length})
                                  </summary>
                                  <table className="w-full mt-2 text-[11px]">
                                    <thead className="text-white/40">
                                      <tr>
                                        <th className="text-left pr-2">Time</th>
                                        <th className="text-left pr-2">Kind</th>
                                        <th className="text-left pr-2">Status</th>
                                        <th className="text-left pr-2">Outcome</th>
                                        <th className="text-left pr-2">Origin</th>
                                        <th className="text-right pr-2">Bytes</th>
                                        <th className="text-left">Message</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {d.recentAttempts.map((a, i) => (
                                        <tr key={i} className="text-white/70">
                                          <td className="pr-2 py-1">{new Date(a.createdAt).toLocaleTimeString()}</td>
                                          <td className="pr-2">{a.kind}</td>
                                          <td className={`pr-2 ${a.httpStatus >= 400 ? "text-red-300" : "text-emerald-300"}`}>{a.httpStatus}</td>
                                          <td className="pr-2">{a.outcome}</td>
                                          <td className="pr-2 font-mono text-white/50 truncate max-w-[180px]">{a.origin || "—"}</td>
                                          <td className="pr-2 text-right text-white/50">{a.contentLength ?? "—"}</td>
                                          <td className="text-white/60 truncate max-w-[260px]">{a.message || ""}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </details>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="border border-white/10 bg-white/[0.02] rounded-lg p-4">
            <div className="text-sm font-medium text-white mb-2">Builder-specific install notes</div>
            <ul className="space-y-2 text-xs">
              {data.builderGuidance.map(g => (
                <li key={g.builder} className="border-l-2 border-white/20 pl-3 py-1">
                  <div className="text-white/80 font-medium">{g.builder}</div>
                  <div className="text-muted-foreground mt-0.5 leading-relaxed">{g.instructions}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </PremiumCard>
  );
}
