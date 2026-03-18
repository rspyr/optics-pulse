import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Lightbulb, GraduationCap, ExternalLink, X, DollarSign,
  TrendingDown, AlertTriangle, ChevronDown, ChevronUp,
} from "lucide-react";
import type { TrainingItem, TrainingContextualResponseMetrics } from "@workspace/api-client-react";

const API_BASE = "";

interface TrainingCardsProps {
  items: TrainingItem[];
  metrics: TrainingContextualResponseMetrics;
  onDismiss: (id: number) => void;
}

const METRIC_LABELS: Record<string, string> = {
  booking_rate: "Booking Rate",
  close_rate: "Close Rate",
  cpl: "Cost Per Lead",
  roas: "ROAS",
  avg_sale_value: "Avg Sale Value",
};

const METRIC_FORMATS: Record<string, (v: number) => string> = {
  booking_rate: v => `${v.toFixed(1)}%`,
  close_rate: v => `${v.toFixed(1)}%`,
  cpl: v => `$${v.toFixed(2)}`,
  roas: v => `${v.toFixed(1)}x`,
  avg_sale_value: v => `$${v.toFixed(0)}`,
};

export default function TrainingCards({ items, metrics, onDismiss }: TrainingCardsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dismissingId, setDismissingId] = useState<number | null>(null);

  if (items.length === 0) return null;

  const handleDismiss = async (id: number) => {
    setDismissingId(id);
    try {
      const response = await fetch(`${API_BASE}/api/training/dismiss/${id}`, {
        method: "POST",
        credentials: "include",
      });
      if (response.ok) {
        onDismiss(id);
      }
    } finally {
      setDismissingId(null);
    }
  };

  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-5 py-3"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-medium text-amber-400">
            {items.length} Performance {items.length === 1 ? "Tip" : "Tips"} Available
          </span>
        </div>
        {collapsed ? <ChevronDown className="w-4 h-4 text-amber-400" /> : <ChevronUp className="w-4 h-4 text-amber-400" />}
      </button>

      {!collapsed && (
        <div className="px-5 pb-5 space-y-3">
          {items.map(item => {
            const trigger = item.metricTrigger || null;
            const metricLabel = trigger ? METRIC_LABELS[trigger] || trigger : null;
            const currentValue = trigger ? (metrics as Record<string, number | undefined>)[trigger] ?? null : null;
            const formatter = trigger ? METRIC_FORMATS[trigger] : null;

            return (
              <div
                key={item.id}
                className={cn(
                  "relative rounded-lg border p-4 transition-all",
                  item.contentType === "free_tip"
                    ? "bg-card border-emerald-500/10 hover:border-emerald-500/20"
                    : "bg-card border-primary/10 hover:border-primary/20"
                )}
              >
                <button
                  onClick={() => handleDismiss(item.id)}
                  disabled={dismissingId === item.id}
                  className="absolute top-3 right-3 p-1 text-muted-foreground hover:text-white rounded transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>

                <div className="flex items-start gap-3 pr-6">
                  <div className={cn(
                    "p-2 rounded-lg shrink-0",
                    item.contentType === "free_tip"
                      ? "bg-emerald-500/10 border border-emerald-500/20"
                      : "bg-primary/10 border border-primary/20"
                  )}>
                    {item.contentType === "free_tip"
                      ? <Lightbulb className="w-4 h-4 text-emerald-400" />
                      : <GraduationCap className="w-4 h-4 text-primary" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium text-white mb-1">{item.title}</h4>

                    {metricLabel && currentValue != null && formatter && (
                      <div className="flex items-center gap-1.5 mb-2">
                        <TrendingDown className="w-3 h-3 text-amber-400" />
                        <span className="text-[10px] text-amber-400">
                          Your {metricLabel}: {formatter(currentValue)} (threshold: {item.thresholdValue != null ? formatter(item.thresholdValue) : "N/A"})
                        </span>
                      </div>
                    )}

                    <p className="text-xs text-gray-400 leading-relaxed mb-3">{item.description}</p>

                    <div className="flex items-center gap-3">
                      {item.contentType === "paid_course" && item.price && (
                        <span className="text-sm font-display text-white flex items-center">
                          <DollarSign className="w-3.5 h-3.5 text-primary" />{item.price}
                        </span>
                      )}
                      {item.url && item.contentType === "free_tip" && (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
                        >
                          Read More
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      {item.contentType === "paid_course" && (
                        <button
                          onClick={async () => {
                            await fetch(`${API_BASE}/api/training/purchase/${item.id}`, {
                              method: "POST",
                              credentials: "include",
                            });
                            if (item.url) window.open(item.url, "_blank", "noopener,noreferrer");
                          }}
                          className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
                        >
                          Get Course
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
