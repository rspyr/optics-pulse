import { useState, useMemo } from "react";
import { useListTrainingItems } from "@workspace/api-client-react";
import { PremiumCard, GradientHeading } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import {
  BookOpen, ExternalLink, DollarSign, Search,
  GraduationCap, Lightbulb, Filter,
} from "lucide-react";

export default function TrainingResources() {
  const { data: items, isLoading } = useListTrainingItems({ activeOnly: "true" });
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | "free_tip" | "paid_course">("");

  const categories = useMemo(() => {
    if (!items) return [];
    return [...new Set(items.map(i => i.category))].sort();
  }, [items]);

  const filtered = useMemo(() => {
    if (!items) return [];
    return items.filter(item => {
      if (search && !item.title.toLowerCase().includes(search.toLowerCase()) && !item.description.toLowerCase().includes(search.toLowerCase())) return false;
      if (categoryFilter && item.category !== categoryFilter) return false;
      if (typeFilter && item.contentType !== typeFilter) return false;
      return true;
    });
  }, [items, search, categoryFilter, typeFilter]);

  const freeItems = filtered.filter(i => i.contentType === "free_tip");
  const paidItems = filtered.filter(i => i.contentType === "paid_course");

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-64 bg-white/10 rounded" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="h-48 bg-white/5 rounded-xl border border-white/5" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <GradientHeading className="text-3xl md:text-4xl mb-2">Training & Resources</GradientHeading>
          <p className="font-sub text-muted-foreground text-sm tracking-wide">IMPROVE YOUR PERFORMANCE WITH EXPERT TRAINING</p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search training..."
            className="w-full bg-card border border-white/10 rounded-lg pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="bg-card border border-white/10 text-white text-xs rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="flex items-center gap-1 bg-card border border-white/10 rounded-lg p-1">
          <button
            onClick={() => setTypeFilter("")}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
              typeFilter === "" ? "bg-white/10 text-white" : "text-muted-foreground hover:text-white"
            )}
          >
            All
          </button>
          <button
            onClick={() => setTypeFilter("free_tip")}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
              typeFilter === "free_tip" ? "bg-emerald-500/20 text-emerald-400" : "text-muted-foreground hover:text-white"
            )}
          >
            Free
          </button>
          <button
            onClick={() => setTypeFilter("paid_course")}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
              typeFilter === "paid_course" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-white"
            )}
          >
            Courses
          </button>
        </div>
      </div>

      {filtered.length === 0 && (
        <PremiumCard className="p-10 text-center">
          <BookOpen className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <p className="text-muted-foreground text-sm">
            {search || categoryFilter || typeFilter ? "No training content matches your filters." : "No training content available yet."}
          </p>
        </PremiumCard>
      )}

      {freeItems.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Lightbulb className="w-5 h-5 text-emerald-400" />
            <h3 className="text-lg font-display text-white">Free Tips & Resources</h3>
            <span className="text-xs text-muted-foreground">({freeItems.length})</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {freeItems.map(item => (
              <PremiumCard key={item.id} className="p-5 group hover:border-emerald-500/20 transition-colors">
                <div className="flex items-start gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 shrink-0">
                    <Lightbulb className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-sm font-medium text-white mb-1 line-clamp-2">{item.title}</h4>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-muted-foreground">{item.category}</span>
                  </div>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed mb-4 line-clamp-3">{item.description}</p>
                {item.url && (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors font-medium"
                  >
                    Read More <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </PremiumCard>
            ))}
          </div>
        </div>
      )}

      {paidItems.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <GraduationCap className="w-5 h-5 text-primary" />
            <h3 className="text-lg font-display text-white">Premium Courses</h3>
            <span className="text-xs text-muted-foreground">({paidItems.length})</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {paidItems.map(item => (
              <PremiumCard key={item.id} className="p-5 group hover:border-primary/20 transition-colors relative overflow-hidden">
                <div className="absolute top-0 right-0 w-24 h-24 bg-primary/5 rounded-bl-full -z-10" />
                <div className="flex items-start gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-primary/10 border border-primary/20 shrink-0">
                    <GraduationCap className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-sm font-medium text-white mb-1 line-clamp-2">{item.title}</h4>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-muted-foreground">{item.category}</span>
                  </div>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed mb-4 line-clamp-3">{item.description}</p>
                <div className="flex items-center justify-between">
                  {item.price && (
                    <span className="text-lg font-display text-white flex items-center">
                      <DollarSign className="w-4 h-4 text-primary" />{item.price}
                    </span>
                  )}
                  {item.url ? (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary/90 transition-colors flex items-center gap-1.5"
                    >
                      Get Course <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <span className="px-4 py-2 rounded-lg bg-white/5 text-muted-foreground text-xs border border-white/10">Coming Soon</span>
                  )}
                </div>
              </PremiumCard>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
