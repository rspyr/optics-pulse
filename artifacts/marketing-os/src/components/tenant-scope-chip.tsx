import React, { useEffect, useMemo, useRef, useState } from "react";
import { Building2, Check, ChevronDown, Globe2, X } from "lucide-react";
import { useAuth } from "@/components/auth-context";
import { useTenants, type TenantOption } from "@/hooks/use-tenants";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
const shortcutLabel = isMac ? "⌘K" : "Ctrl+K";

export function TenantScopeChip() {
  const { isAgency, selectedTenantId, setSelectedTenantId } = useAuth();
  const { tenants: allTenants } = useTenants<TenantOption & { isActive?: boolean }>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const tenantOptions = useMemo(() => {
    const all = allTenants ?? [];
    const active = all
      .filter((t) => t.isActive !== false)
      .map((t) => ({ id: t.id, name: t.name, inactive: false }));
    if (selectedTenantId && !active.some((t) => t.id === selectedTenantId)) {
      const inactive = all.find((t) => t.id === selectedTenantId);
      if (inactive) active.push({ id: inactive.id, name: inactive.name, inactive: true });
    }
    return active.sort((a, b) => a.name.localeCompare(b.name));
  }, [allTenants, selectedTenantId]);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tenantOptions;
    return tenantOptions.filter((t) => t.name.toLowerCase().includes(q));
  }, [tenantOptions, query]);

  useEffect(() => {
    if (!isAgency) return;
    const handler = (e: KeyboardEvent) => {
      const isShortcut =
        (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k";
      if (!isShortcut) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        target?.isContentEditable ||
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT";
      if (isEditable && target !== searchRef.current) return;
      e.preventDefault();
      setOpen(true);
      setQuery("");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isAgency]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [open]);

  const totalItems = 1 + filteredOptions.length;

  useEffect(() => {
    setHighlightIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const el = itemRefs.current[highlightIndex];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex, open, filteredOptions]);

  const commitSelection = (idx: number) => {
    if (idx === 0) {
      setSelectedTenantId(null);
    } else {
      const t = filteredOptions[idx - 1];
      if (!t) return;
      setSelectedTenantId(t.id);
    }
    setOpen(false);
    setQuery("");
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => (totalItems === 0 ? 0 : (i + 1) % totalItems));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => (totalItems === 0 ? 0 : (i - 1 + totalItems) % totalItems));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitSelection(highlightIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQuery("");
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlightIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlightIndex(Math.max(0, totalItems - 1));
    }
  };

  if (!isAgency) return null;

  const selected = selectedTenantId
    ? tenantOptions.find((t) => t.id === selectedTenantId)
    : null;
  const isAll = selectedTenantId == null;
  const label = selected?.name ?? "All Tenants";

  return (
    <DropdownMenu open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="tenant-scope-chip"
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
            "bg-white/5 hover:bg-white/10 backdrop-blur",
            isAll
              ? "border-white/10 text-white/80"
              : "border-primary/40 text-white shadow-[0_0_15px_rgba(242,5,5,0.15)]",
          )}
          title={`Switch tenant scope (${shortcutLabel})`}
        >
          {isAll ? (
            <Globe2 className="w-3.5 h-3.5 text-white/60" />
          ) : (
            <Building2 className="w-3.5 h-3.5 text-primary" />
          )}
          <span className="text-white/50 uppercase tracking-wider text-[10px]">Scope</span>
          <span className="truncate max-w-[160px]">
            {label}
            {selected?.inactive ? " (inactive)" : ""}
          </span>
          <kbd className="hidden sm:inline-flex items-center rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-mono text-white/50">
            {shortcutLabel}
          </kbd>
          <ChevronDown className="w-3 h-3 text-white/40" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72 bg-card/95 backdrop-blur-2xl border-white/10"
      >
        <DropdownMenuLabel className="flex items-center justify-between text-xs uppercase tracking-wider text-white/40">
          <span>Tenant scope</span>
          <kbd className="inline-flex items-center rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-mono text-white/50 normal-case tracking-normal">
            {shortcutLabel}
          </kbd>
        </DropdownMenuLabel>
        <div className="px-2 pb-2">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tenants…"
            data-testid="tenant-scope-search"
            className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
            onKeyDown={handleSearchKeyDown}
          />
        </div>
        <DropdownMenuItem
          ref={(el) => {
            itemRefs.current[0] = el as HTMLDivElement | null;
          }}
          data-testid="tenant-scope-reset"
          onSelect={() => commitSelection(0)}
          onMouseEnter={() => setHighlightIndex(0)}
          data-highlighted-kb={highlightIndex === 0 ? "true" : undefined}
          className={cn(
            "flex items-center gap-2 cursor-pointer",
            highlightIndex === 0 && "bg-white/10",
          )}
        >
          <Globe2 className="w-4 h-4 text-white/60" />
          <span className="flex-1">All Tenants</span>
          {isAll ? <Check className="w-4 h-4 text-primary" /> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-white/5" />
        <div className="max-h-72 overflow-y-auto">
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-white/40">
              No tenants match
            </div>
          ) : (
            filteredOptions.map((t, i) => {
              const idx = i + 1;
              const isHighlighted = highlightIndex === idx;
              return (
                <DropdownMenuItem
                  key={t.id}
                  ref={(el) => {
                    itemRefs.current[idx] = el as HTMLDivElement | null;
                  }}
                  data-testid={`tenant-scope-option-${t.id}`}
                  onSelect={() => commitSelection(idx)}
                  onMouseEnter={() => setHighlightIndex(idx)}
                  data-highlighted-kb={isHighlighted ? "true" : undefined}
                  className={cn(
                    "flex items-center gap-2 cursor-pointer",
                    isHighlighted && "bg-white/10",
                  )}
                >
                  <Building2 className="w-4 h-4 text-white/50" />
                  <span className="flex-1 truncate">
                    {t.name}
                    {t.inactive ? (
                      <span className="ml-1 text-white/40">(inactive)</span>
                    ) : null}
                  </span>
                  {selectedTenantId === t.id ? <Check className="w-4 h-4 text-primary" /> : null}
                </DropdownMenuItem>
              );
            })
          )}
        </div>
        {!isAll ? (
          <>
            <DropdownMenuSeparator className="bg-white/5" />
            <DropdownMenuItem
              onSelect={() => setSelectedTenantId(null)}
              data-testid="tenant-scope-clear"
              className="flex items-center gap-2 text-primary cursor-pointer"
            >
              <X className="w-4 h-4" />
              Reset to All Tenants
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
