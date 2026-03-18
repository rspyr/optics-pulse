import { useState } from "react";
import {
  useListTrainingItems,
  useCreateTrainingItem,
  useUpdateTrainingItem,
  useDeleteTrainingItem,
  useCheckTrainingAlerts,
} from "@workspace/api-client-react";
import type {
  CreateTrainingItemBody,
  CreateTrainingItemBodyMetricTrigger,
  UpdateTrainingItemBody,
  TrainingAlertResponse,
  TrainingAlertResponseAlertsItem,
} from "@workspace/api-client-react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import {
  Plus, Pencil, Trash2, BookOpen, DollarSign, Target,
  Bell, X, ChevronDown, ChevronUp, AlertTriangle, CheckCircle,
  GraduationCap, Lightbulb,
} from "lucide-react";

const METRIC_OPTIONS = [
  { value: "", label: "No trigger (always visible)" },
  { value: "booking_rate", label: "Booking Rate (%)" },
  { value: "close_rate", label: "Close Rate (%)" },
  { value: "cpl", label: "Cost Per Lead ($)" },
  { value: "roas", label: "ROAS (x)" },
  { value: "avg_sale_value", label: "Avg Sale Value ($)" },
];

const CATEGORY_OPTIONS = ["Sales Training", "Marketing Tips", "Lead Management", "Customer Service", "Technical Skills", "Business Growth"];

interface TrainingFormData {
  title: string;
  description: string;
  category: string;
  contentType: "free_tip" | "paid_course";
  metricTrigger: string;
  thresholdValue: string;
  thresholdDirection: "below" | "above";
  price: string;
  url: string;
  thumbnailUrl: string;
  sortOrder: string;
  isActive: boolean;
}

const emptyForm: TrainingFormData = {
  title: "",
  description: "",
  category: "Sales Training",
  contentType: "free_tip",
  metricTrigger: "",
  thresholdValue: "",
  thresholdDirection: "below",
  price: "",
  url: "",
  thumbnailUrl: "",
  sortOrder: "0",
  isActive: true,
};

export default function AdminTraining() {
  const { data: items, isLoading, refetch } = useListTrainingItems({ activeOnly: "false" });
  const createMutation = useCreateTrainingItem();
  const updateMutation = useUpdateTrainingItem();
  const deleteMutation = useDeleteTrainingItem();
  const alertsMutation = useCheckTrainingAlerts();

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<TrainingFormData>(emptyForm);
  const [expandedAlerts, setExpandedAlerts] = useState(false);

  const openCreate = () => {
    setForm(emptyForm);
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (item: NonNullable<typeof items>[0]) => {
    setForm({
      title: item.title,
      description: item.description,
      category: item.category,
      contentType: item.contentType as "free_tip" | "paid_course",
      metricTrigger: item.metricTrigger || "",
      thresholdValue: item.thresholdValue != null ? String(item.thresholdValue) : "",
      thresholdDirection: (item.thresholdDirection as "below" | "above") || "below",
      price: item.price != null ? String(item.price) : "",
      url: item.url || "",
      thumbnailUrl: item.thumbnailUrl || "",
      sortOrder: String(item.sortOrder),
      isActive: item.isActive,
    });
    setEditingId(item.id);
    setShowForm(true);
  };

  const handleSubmit = async () => {
    if (editingId) {
      const payload: UpdateTrainingItemBody = {
        title: form.title,
        description: form.description,
        category: form.category,
        contentType: form.contentType,
        metricTrigger: form.metricTrigger || null,
        thresholdValue: form.thresholdValue ? Number(form.thresholdValue) : null,
        thresholdDirection: form.thresholdDirection,
        price: form.price ? Number(form.price) : null,
        url: form.url || null,
        sortOrder: Number(form.sortOrder),
        isActive: form.isActive,
      };
      await updateMutation.mutateAsync({ id: editingId, data: payload });
    } else {
      const payload: CreateTrainingItemBody = {
        title: form.title,
        description: form.description,
        category: form.category,
        contentType: form.contentType,
        metricTrigger: (form.metricTrigger || undefined) as CreateTrainingItemBodyMetricTrigger | undefined,
        thresholdValue: form.thresholdValue ? Number(form.thresholdValue) : null,
        thresholdDirection: form.thresholdDirection,
        price: form.price ? Number(form.price) : null,
        url: form.url || null,
        thumbnailUrl: form.thumbnailUrl || null,
        sortOrder: Number(form.sortOrder),
        isActive: form.isActive,
      };
      await createMutation.mutateAsync({ data: payload });
    }
    setShowForm(false);
    refetch();
  };

  const handleDelete = async (id: number) => {
    await deleteMutation.mutateAsync({ id });
    refetch();
  };

  const handleCheckAlerts = async () => {
    await alertsMutation.mutateAsync();
    setExpandedAlerts(true);
  };

  const freeItems = (items || []).filter(i => i.contentType === "free_tip");
  const paidItems = (items || []).filter(i => i.contentType === "paid_course");

  const alertsData = alertsMutation.data as TrainingAlertResponse | undefined;

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-64 bg-white/10 rounded" />
        {[1, 2, 3].map(i => <div key={i} className="h-24 bg-white/5 rounded-xl border border-white/5" />)}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Training & LMS</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">UPSELL ENGINE — MANAGE TRAINING CONTENT & METRIC TRIGGERS</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleCheckAlerts}
            disabled={alertsMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors text-sm font-medium"
          >
            <Bell className="w-4 h-4" />
            {alertsMutation.isPending ? "Checking..." : "Check Alerts"}
          </button>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Add Training
          </button>
        </div>
      </header>

      {alertsData && (
        <PremiumCard className="p-5">
          <button
            onClick={() => setExpandedAlerts(!expandedAlerts)}
            className="w-full flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              {alertsData.alertsGenerated > 0 ? (
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              ) : (
                <CheckCircle className="w-5 h-5 text-emerald-400" />
              )}
              <span className="text-sm text-white font-medium">{alertsData.message}</span>
            </div>
            {expandedAlerts ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>
          {expandedAlerts && alertsData.alerts?.length > 0 && (
            <div className="mt-4 space-y-2">
              {alertsData.alerts.map((alert: TrainingAlertResponseAlertsItem, i: number) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3 bg-white/5 rounded-lg border border-white/5">
                  <div className="flex-1">
                    <p className="text-sm text-white font-medium">{alert.tenantName}</p>
                    <p className="text-xs text-muted-foreground">
                      {(alert.metric || "").replace("_", " ")} is {alert.value} (threshold: {alert.threshold})
                    </p>
                  </div>
                  <span className="text-xs text-amber-400 bg-amber-500/10 px-2 py-1 rounded">{alert.trainingTitle}</span>
                </div>
              ))}
            </div>
          )}
        </PremiumCard>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <PremiumCard className="p-5 text-center">
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 w-fit mx-auto mb-2">
            <Lightbulb className="w-6 h-6 text-emerald-400" />
          </div>
          <p className="text-2xl font-display text-white">{freeItems.length}</p>
          <p className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Free Tips</p>
        </PremiumCard>
        <PremiumCard className="p-5 text-center">
          <div className="p-3 rounded-lg bg-primary/10 border border-primary/20 w-fit mx-auto mb-2">
            <GraduationCap className="w-6 h-6 text-primary" />
          </div>
          <p className="text-2xl font-display text-white">{paidItems.length}</p>
          <p className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Paid Courses</p>
        </PremiumCard>
        <PremiumCard className="p-5 text-center">
          <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 w-fit mx-auto mb-2">
            <Target className="w-6 h-6 text-blue-400" />
          </div>
          <p className="text-2xl font-display text-white">
            {(items || []).filter(i => i.metricTrigger).length}
          </p>
          <p className="text-xs text-muted-foreground uppercase tracking-wider mt-1">With Triggers</p>
        </PremiumCard>
      </div>

      {showForm && (
        <PremiumCard className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-display text-white">{editingId ? "Edit Training Item" : "New Training Item"}</h3>
            <button onClick={() => setShowForm(false)} className="text-muted-foreground hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Title</label>
              <input
                value={form.title}
                onChange={e => setForm({ ...form, title: e.target.value })}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                placeholder="e.g., Speed-to-Lead: 5 Tips to Book More Appointments"
              />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Description</label>
              <textarea
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                rows={3}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
                placeholder="Describe the training content..."
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Category</label>
              <select
                value={form.category}
                onChange={e => setForm({ ...form, category: e.target.value })}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Content Type</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setForm({ ...form, contentType: "free_tip" })}
                  className={cn(
                    "flex-1 py-2 rounded-lg text-sm font-medium border transition-colors",
                    form.contentType === "free_tip"
                      ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                      : "bg-white/5 text-muted-foreground border-white/10 hover:text-white"
                  )}
                >
                  Free Tip
                </button>
                <button
                  onClick={() => setForm({ ...form, contentType: "paid_course" })}
                  className={cn(
                    "flex-1 py-2 rounded-lg text-sm font-medium border transition-colors",
                    form.contentType === "paid_course"
                      ? "bg-primary/20 text-primary border-primary/30"
                      : "bg-white/5 text-muted-foreground border-white/10 hover:text-white"
                  )}
                >
                  Paid Course
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Metric Trigger</label>
              <select
                value={form.metricTrigger}
                onChange={e => setForm({ ...form, metricTrigger: e.target.value })}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                {METRIC_OPTIONS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            {form.metricTrigger && (
              <>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Threshold Value</label>
                  <input
                    type="number"
                    value={form.thresholdValue}
                    onChange={e => setForm({ ...form, thresholdValue: e.target.value })}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                    placeholder="e.g., 25 for 25%"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Direction</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setForm({ ...form, thresholdDirection: "below" })}
                      className={cn(
                        "flex-1 py-2 rounded-lg text-sm font-medium border transition-colors",
                        form.thresholdDirection === "below"
                          ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                          : "bg-white/5 text-muted-foreground border-white/10 hover:text-white"
                      )}
                    >
                      Below
                    </button>
                    <button
                      onClick={() => setForm({ ...form, thresholdDirection: "above" })}
                      className={cn(
                        "flex-1 py-2 rounded-lg text-sm font-medium border transition-colors",
                        form.thresholdDirection === "above"
                          ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                          : "bg-white/5 text-muted-foreground border-white/10 hover:text-white"
                      )}
                    >
                      Above
                    </button>
                  </div>
                </div>
              </>
            )}
            {form.contentType === "paid_course" && (
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Price ($)</label>
                <input
                  type="number"
                  value={form.price}
                  onChange={e => setForm({ ...form, price: e.target.value })}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                  placeholder="e.g., 197"
                />
              </div>
            )}
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">URL (external link)</label>
              <input
                value={form.url}
                onChange={e => setForm({ ...form, url: e.target.value })}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                placeholder="https://..."
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Sort Order</label>
              <input
                type="number"
                value={form.sortOrder}
                onChange={e => setForm({ ...form, sortOrder: e.target.value })}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Active</label>
              <button
                onClick={() => setForm({ ...form, isActive: !form.isActive })}
                className={cn(
                  "w-10 h-6 rounded-full transition-colors relative",
                  form.isActive ? "bg-emerald-500" : "bg-white/20"
                )}
              >
                <span className={cn(
                  "absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform",
                  form.isActive ? "translate-x-4" : "translate-x-0.5"
                )} />
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!form.title || !form.description || createMutation.isPending || updateMutation.isPending}
              className="px-6 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {editingId ? "Update" : "Create"}
            </button>
          </div>
        </PremiumCard>
      )}

      <div className="space-y-3">
        {(items || []).length === 0 && (
          <PremiumCard className="p-10 text-center">
            <BookOpen className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <p className="text-muted-foreground text-sm">No training content yet. Click "Add Training" to create your first item.</p>
          </PremiumCard>
        )}
        {(items || []).map(item => (
          <PremiumCard key={item.id} className={cn("p-5", !item.isActive && "opacity-60")}>
            <div className="flex items-start gap-4">
              <div className={cn(
                "p-2.5 rounded-lg shrink-0",
                item.contentType === "free_tip"
                  ? "bg-emerald-500/10 border border-emerald-500/20"
                  : "bg-primary/10 border border-primary/20"
              )}>
                {item.contentType === "free_tip"
                  ? <Lightbulb className="w-5 h-5 text-emerald-400" />
                  : <GraduationCap className="w-5 h-5 text-primary" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h4 className="text-sm font-medium text-white truncate">{item.title}</h4>
                  {!item.isActive && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-muted-foreground border border-white/5">Inactive</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{item.description}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-muted-foreground border border-white/5">{item.category}</span>
                  {item.contentType === "paid_course" && item.price && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 flex items-center gap-1">
                      <DollarSign className="w-3 h-3" />${item.price}
                    </span>
                  )}
                  {item.metricTrigger && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1">
                      <Target className="w-3 h-3" />
                      {item.metricTrigger.replace("_", " ")} {item.thresholdDirection} {item.thresholdValue}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => openEdit(item)}
                  className="p-2 text-muted-foreground hover:text-white rounded-lg hover:bg-white/5 transition-colors"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(item.id)}
                  className="p-2 text-muted-foreground hover:text-red-400 rounded-lg hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </PremiumCard>
        ))}
      </div>
    </div>
  );
}
