import { useState } from "react";
import {
  useListAutomationRules,
  useCreateAutomationRule,
  useUpdateAutomationRule,
  useDeleteAutomationRule,
  useToggleAutomationRule,
  useListAutomationAlerts,
  useAcknowledgeAutomationAlert,
  useGetAutomationAlertCount,
  useListTenants,
} from "@workspace/api-client-react";
import type {
  AutomationRule,
  AutomationAlert,
  CreateAutomationRuleBody,
} from "@workspace/api-client-react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import {
  Plus, Pencil, Trash2, X, Power, PowerOff,
  AlertTriangle, CheckCircle, Bell, BellOff,
  Zap, Shield, Pause, Settings, Activity, Eye,
} from "lucide-react";

const CONDITION_LABELS: Record<string, string> = {
  spend_below: "Spend Below",
  spend_above: "Spend Above",
  days_active_above: "Days Active Above",
  conversions_below: "Conversions Below",
  cpl_above: "CPL Above",
  roas_below: "ROAS Below",
};

const CONDITION_UNITS: Record<string, string> = {
  spend_below: "$",
  spend_above: "$",
  days_active_above: "days",
  conversions_below: "",
  cpl_above: "$",
  roas_below: "x",
};

const ACTION_LABELS: Record<string, string> = {
  send_alert: "Send Alert",
  flag_for_review: "Flag for Review",
  auto_pause: "Auto-Pause",
};

const ACTION_ICONS: Record<string, typeof Bell> = {
  send_alert: Bell,
  flag_for_review: Eye,
  auto_pause: Pause,
};

type Tab = "rules" | "alerts";

export default function Automation() {
  const [tab, setTab] = useState<Tab>("rules");
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [alertFilter, setAlertFilter] = useState<"all" | "unacknowledged" | "acknowledged">("unacknowledged");

  const { data: tenants } = useListTenants();
  const { data: rules, refetch: refetchRules, isLoading: rulesLoading } = useListAutomationRules();
  const { data: alerts, refetch: refetchAlerts, isLoading: alertsLoading } = useListAutomationAlerts({
    acknowledged: alertFilter === "all" ? undefined : alertFilter === "acknowledged" ? "true" : "false",
  });
  const { data: alertCount, refetch: refetchCount } = useGetAutomationAlertCount();
  const createMutation = useCreateAutomationRule();
  const updateMutation = useUpdateAutomationRule();
  const deleteMutation = useDeleteAutomationRule();
  const toggleMutation = useToggleAutomationRule();
  const acknowledgeMutation = useAcknowledgeAutomationAlert();

  const unacknowledgedCount = alertCount?.unacknowledged ?? 0;

  const [formData, setFormData] = useState<CreateAutomationRuleBody>({
    name: "",
    conditionType: "spend_above" as CreateAutomationRuleBody["conditionType"],
    conditionValue: 0,
    actionType: "send_alert" as CreateAutomationRuleBody["actionType"],
    lookbackDays: 30,
  });

  function openCreateForm() {
    setEditingRule(null);
    setFormData({
      name: "",
      conditionType: "spend_above" as CreateAutomationRuleBody["conditionType"],
      conditionValue: 0,
      actionType: "send_alert" as CreateAutomationRuleBody["actionType"],
      lookbackDays: 30,
    });
    setShowForm(true);
  }

  function openEditForm(rule: AutomationRule) {
    setEditingRule(rule);
    setFormData({
      name: rule.name,
      description: rule.description ?? undefined,
      conditionType: rule.conditionType,
      conditionValue: rule.conditionValue,
      actionType: rule.actionType,
      lookbackDays: rule.lookbackDays,
      platform: rule.platform ?? undefined,
      tenantId: rule.tenantId ?? undefined,
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editingRule) {
        await updateMutation.mutateAsync({ id: editingRule.id, data: formData });
      } else {
        await createMutation.mutateAsync({ data: formData });
      }
      setShowForm(false);
      refetchRules();
    } catch {}
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this automation rule and all its alerts?")) return;
    try {
      await deleteMutation.mutateAsync({ id });
      refetchRules();
      refetchAlerts();
      refetchCount();
    } catch {}
  }

  async function handleToggle(id: number) {
    try {
      await toggleMutation.mutateAsync({ id });
      refetchRules();
    } catch {}
  }

  async function handleAcknowledge(id: number) {
    try {
      await acknowledgeMutation.mutateAsync({ id });
      refetchAlerts();
      refetchCount();
    } catch {}
  }

  return (
    <div className="min-h-screen bg-[#0A0F1F] p-6 space-y-6">
      <div className="flex items-center justify-between">
        <GradientHeading>Media Buying Automation</GradientHeading>
      </div>

      <div className="flex items-center gap-4 border-b border-white/10 pb-2">
        <button
          onClick={() => setTab("rules")}
          className={cn(
            "px-4 py-2 rounded-t-lg text-sm font-medium transition-colors",
            tab === "rules" ? "bg-[#002D5E] text-white" : "text-white/50 hover:text-white/70"
          )}
        >
          <Settings className="w-4 h-4 inline mr-2" />
          Rules ({rules?.length ?? 0})
        </button>
        <button
          onClick={() => setTab("alerts")}
          className={cn(
            "px-4 py-2 rounded-t-lg text-sm font-medium transition-colors relative",
            tab === "alerts" ? "bg-[#002D5E] text-white" : "text-white/50 hover:text-white/70"
          )}
        >
          <Activity className="w-4 h-4 inline mr-2" />
          Alerts
          {unacknowledgedCount > 0 && (
            <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-[#F20505] text-white animate-pulse">
              {unacknowledgedCount}
            </span>
          )}
        </button>
      </div>

      {tab === "rules" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={openCreateForm}
              className="flex items-center gap-2 px-4 py-2 bg-[#F20505] hover:bg-[#F20505]/90 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Rule
            </button>
          </div>

          {rulesLoading && (
            <div className="text-center text-white/50 py-12">Loading rules...</div>
          )}

          {!rulesLoading && (!rules || rules.length === 0) && (
            <PremiumCard>
              <div className="text-center py-12 space-y-3">
                <Zap className="w-12 h-12 mx-auto text-[#F20505]/60" />
                <h3 className="text-lg font-semibold text-white">No automation rules yet</h3>
                <p className="text-white/50 text-sm max-w-md mx-auto">
                  Create rules to automatically monitor campaign performance, flag underperformers, 
                  and get alerted when thresholds are breached.
                </p>
              </div>
            </PremiumCard>
          )}

          {rules && rules.length > 0 && (
            <div className="grid gap-4">
              {rules.map((rule: AutomationRule) => {
                const ActionIcon = ACTION_ICONS[rule.actionType] || Bell;
                return (
                  <PremiumCard key={rule.id}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            "w-2 h-2 rounded-full",
                            rule.isEnabled ? "bg-green-400" : "bg-white/30"
                          )} />
                          <h3 className="text-white font-semibold text-lg">{rule.name}</h3>
                          <span className={cn(
                            "px-2 py-0.5 rounded text-xs font-medium",
                            rule.isEnabled
                              ? "bg-green-500/20 text-green-400"
                              : "bg-white/10 text-white/40"
                          )}>
                            {rule.isEnabled ? "Active" : "Disabled"}
                          </span>
                        </div>
                        {rule.description && (
                          <p className="text-white/50 text-sm ml-5">{rule.description}</p>
                        )}
                        <div className="flex items-center gap-6 ml-5 text-sm">
                          <span className="text-white/70">
                            <span className="text-white/40">When</span>{" "}
                            <span className="text-[#F20505] font-medium">
                              {CONDITION_LABELS[rule.conditionType]}
                            </span>{" "}
                            <span className="text-white">
                              {CONDITION_UNITS[rule.conditionType] === "$" ? "$" : ""}
                              {rule.conditionValue}
                              {CONDITION_UNITS[rule.conditionType] && CONDITION_UNITS[rule.conditionType] !== "$"
                                ? ` ${CONDITION_UNITS[rule.conditionType]}`
                                : ""}
                            </span>
                          </span>
                          <span className="text-white/70 flex items-center gap-1">
                            <ActionIcon className="w-3.5 h-3.5" />
                            {ACTION_LABELS[rule.actionType]}
                          </span>
                          <span className="text-white/40">
                            {rule.lookbackDays}d window
                          </span>
                          {rule.platform && (
                            <span className="text-white/40">
                              Platform: <span className="text-white/60">{rule.platform}</span>
                            </span>
                          )}
                          {rule.tenantId && (
                            <span className="text-white/40">
                              Tenant: <span className="text-white/60">
                                {tenants?.find((t: { id: number }) => t.id === rule.tenantId)?.name || `#${rule.tenantId}`}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleToggle(rule.id)}
                          className={cn(
                            "p-2 rounded-lg transition-colors",
                            rule.isEnabled
                              ? "text-green-400 hover:bg-green-500/20"
                              : "text-white/30 hover:bg-white/10"
                          )}
                          title={rule.isEnabled ? "Disable" : "Enable"}
                        >
                          {rule.isEnabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => openEditForm(rule)}
                          className="p-2 text-white/50 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(rule.id)}
                          className="p-2 text-white/50 hover:text-[#F20505] hover:bg-[#F20505]/10 rounded-lg transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </PremiumCard>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "alerts" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            {(["unacknowledged", "all", "acknowledged"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setAlertFilter(f)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize",
                  alertFilter === f ? "bg-[#002D5E] text-white" : "text-white/40 hover:text-white/60 bg-white/5"
                )}
              >
                {f}
              </button>
            ))}
          </div>

          {alertsLoading && (
            <div className="text-center text-white/50 py-12">Loading alerts...</div>
          )}

          {!alertsLoading && (!alerts || alerts.length === 0) && (
            <PremiumCard>
              <div className="text-center py-12 space-y-3">
                <BellOff className="w-12 h-12 mx-auto text-white/20" />
                <h3 className="text-lg font-semibold text-white">No alerts</h3>
                <p className="text-white/50 text-sm">
                  {alertFilter === "unacknowledged"
                    ? "No new alerts. All quiet on the campaign front."
                    : "No alerts match this filter."}
                </p>
              </div>
            </PremiumCard>
          )}

          {alerts && alerts.length > 0 && (
            <div className="space-y-3">
              {alerts.map((alert: AutomationAlert) => (
                <PremiumCard key={alert.id}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className={cn(
                        "p-2 rounded-lg mt-0.5",
                        alert.isAcknowledged ? "bg-white/5" : "bg-[#F20505]/10"
                      )}>
                        {alert.isAcknowledged
                          ? <CheckCircle className="w-4 h-4 text-green-400" />
                          : <AlertTriangle className="w-4 h-4 text-[#F20505]" />
                        }
                      </div>
                      <div className="space-y-1">
                        <p className="text-white font-medium text-sm">
                          {alert.campaignName || "Campaign"}
                          <span className="text-white/40 font-normal ml-2">
                            ({alert.tenantName || `Tenant ${alert.tenantId}`})
                          </span>
                        </p>
                        <p className="text-white/60 text-sm">
                          {CONDITION_LABELS[alert.conditionType] || alert.conditionType}:{" "}
                          <span className="text-[#F20505] font-medium">{alert.actualValue}</span>
                          <span className="text-white/40"> (threshold: {alert.conditionValue})</span>
                        </p>
                        {alert.actionTaken && (
                          <p className="text-white/40 text-xs">{alert.actionTaken}</p>
                        )}
                        <p className="text-white/30 text-xs">
                          {new Date(alert.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    {!alert.isAcknowledged && (
                      <button
                        onClick={() => handleAcknowledge(alert.id)}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-[#002D5E] hover:bg-[#002D5E]/80 rounded-lg transition-colors"
                      >
                        Acknowledge
                      </button>
                    )}
                  </div>
                </PremiumCard>
              ))}
            </div>
          )}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0F1629] border border-white/10 rounded-xl w-full max-w-lg mx-4 p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">
                {editingRule ? "Edit Rule" : "New Automation Rule"}
              </h2>
              <button
                onClick={() => setShowForm(false)}
                className="p-1 text-white/50 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-white/70 mb-1">Rule Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-[#F20505]/50"
                  placeholder="e.g., High-spend alert"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-white/70 mb-1">Description (optional)</label>
                <input
                  type="text"
                  value={formData.description || ""}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-[#F20505]/50"
                  placeholder="Brief description"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-white/70 mb-1">Condition</label>
                  <select
                    value={formData.conditionType}
                    onChange={(e) => setFormData({ ...formData, conditionType: e.target.value as CreateAutomationRuleBody["conditionType"] })}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm focus:outline-none"
                  >
                    {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-white/70 mb-1">
                    Threshold {CONDITION_UNITS[formData.conditionType] ? `(${CONDITION_UNITS[formData.conditionType]})` : ""}
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={formData.conditionValue}
                    onChange={(e) => setFormData({ ...formData, conditionValue: Number(e.target.value) })}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-[#F20505]/50"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm text-white/70 mb-1">Action</label>
                <select
                  value={formData.actionType}
                  onChange={(e) => setFormData({ ...formData, actionType: e.target.value as CreateAutomationRuleBody["actionType"] })}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm focus:outline-none"
                >
                  {Object.entries(ACTION_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-white/70 mb-1">Lookback Window</label>
                  <select
                    value={formData.lookbackDays || 30}
                    onChange={(e) => setFormData({ ...formData, lookbackDays: Number(e.target.value) })}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm focus:outline-none"
                  >
                    <option value={1}>Last 1 day</option>
                    <option value={3}>Last 3 days</option>
                    <option value={7}>Last 7 days</option>
                    <option value={14}>Last 14 days</option>
                    <option value={30}>Last 30 days</option>
                    <option value={60}>Last 60 days</option>
                    <option value={90}>Last 90 days</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-white/70 mb-1">Tenant Scope</label>
                  <select
                    value={formData.tenantId || ""}
                    onChange={(e) => setFormData({ ...formData, tenantId: e.target.value ? Number(e.target.value) : undefined })}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm focus:outline-none"
                  >
                    <option value="">All Tenants (Global)</option>
                    {tenants?.map((t: { id: number; name: string }) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm text-white/70 mb-1">Platform Filter (optional)</label>
                <input
                  type="text"
                  value={formData.platform || ""}
                  onChange={(e) => setFormData({ ...formData, platform: e.target.value || undefined })}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-[#F20505]/50"
                  placeholder="e.g., google, facebook (leave empty for all)"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-sm text-white/50 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-[#F20505] hover:bg-[#F20505]/90 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {editingRule ? "Update Rule" : "Create Rule"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
