import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Check } from "lucide-react";
import { MAP_TO_OPTIONS, suggestMapTarget, type MapToTarget } from "@/lib/field-mapping-heuristic";

const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export interface UnmatchedFieldsPanelEvent {
  tenantId: number;
  pageUrl: string | null;
  formId: string | null;
  formName: string | null;
  fieldNames?: string[] | null;
  unmatchedReason?: string | null;
}

export { MAP_TO_OPTIONS, type MapToTarget };

export function deriveMappingScope(
  evt: Pick<UnmatchedFieldsPanelEvent, "pageUrl" | "formId" | "formName">,
): { pageUrlPattern: string; formIdentifier: string } {
  let pageUrlPattern = "*";
  if (evt.pageUrl) {
    try { pageUrlPattern = new URL(evt.pageUrl).pathname || "*"; } catch { /* keep "*" */ }
  }
  const formIdentifier = (evt.formId && evt.formId.trim()) || (evt.formName && evt.formName.trim()) || "*";
  return { pageUrlPattern, formIdentifier };
}

export function UnmatchedFieldsPanel({ evt }: { evt: UnmatchedFieldsPanelEvent }) {
  const [expanded, setExpanded] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [savedFields, setSavedFields] = useState<Map<string, MapToTarget>>(new Map());

  const fieldNames = Array.isArray(evt.fieldNames) ? evt.fieldNames : [];
  const reason = evt.unmatchedReason || "Pulse could not link this fill to a known job, lead, or click.";

  const saveMapping = async (fieldName: string, mapsTo: MapToTarget) => {
    const { pageUrlPattern, formIdentifier } = deriveMappingScope(evt);
    setSavingField(fieldName);
    try {
      const res = await fetch(`${API_BASE}/api/field-mapping-rules?tenantId=${evt.tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pageUrlPattern, formIdentifier, fieldName, mapsTo }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as { error?: string }));
        toast.error(d.error || `Failed to save mapping (HTTP ${res.status})`);
        return;
      }
      setSavedFields((prev) => {
        const next = new Map(prev);
        next.set(fieldName, mapsTo);
        return next;
      });
      toast.success(`Mapped "${fieldName}" → ${mapsTo}. Applies to future fills of this form only.`);
    } catch {
      toast.error("Network error saving mapping rule.");
    } finally {
      setSavingField(null);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-white/10">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-amber-300 hover:text-amber-200 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span className="font-medium">Why unmatched?</span>
        <span className="text-[11px] text-muted-foreground">({fieldNames.length} field{fieldNames.length === 1 ? "" : "s"} captured)</span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-amber-200/85 bg-amber-500/[0.06] border border-amber-500/20 rounded-md px-2.5 py-1.5">
            {reason}
          </p>

          {fieldNames.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">
              No field names were captured for this submit. The form may not have been visible to pulse.js, or fields were sent without names.
            </p>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground">
                Map a captured field to a semantic target (e.g. <code className="text-white/70">field_3 → phone</code>).
                Mappings apply to <strong className="text-white/85">future fills of this form only</strong> — they do not re-match this event.
              </p>
              <div className="space-y-1">
                {fieldNames.map((name) => (
                  <UnmatchedFieldRow
                    key={name}
                    name={name}
                    savedAs={savedFields.get(name)}
                    isSaving={savingField === name}
                    onSave={saveMapping}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function UnmatchedFieldRow({
  name,
  savedAs,
  isSaving,
  onSave,
}: {
  name: string;
  savedAs: MapToTarget | undefined;
  isSaving: boolean;
  onSave: (fieldName: string, target: MapToTarget) => void;
}) {
  const suggested = useMemo(() => suggestMapTarget(name), [name]);
  const [selected, setSelected] = useState<MapToTarget | "">(suggested ?? "");
  const showSuggestedHint = !savedAs && suggested !== null && selected === suggested;

  if (savedAs) {
    return (
      <div className="flex items-center gap-2 bg-white/[0.02] border border-white/10 rounded-md px-2.5 py-1.5">
        <code className="text-[11px] text-white/80 truncate flex-1 min-w-0" title={name}>{name}</code>
        <span className="flex items-center gap-1 text-[11px] text-emerald-300">
          <Check className="w-3 h-3" />
          mapped → {savedAs}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 bg-white/[0.02] border border-white/10 rounded-md px-2.5 py-1.5">
      <code className="text-[11px] text-white/80 truncate flex-1 min-w-0" title={name}>{name}</code>
      <select
        aria-label={`Map ${name} to`}
        value={selected}
        disabled={isSaving}
        onChange={(e) => setSelected(e.target.value as MapToTarget | "")}
        className="bg-black/40 border border-white/15 rounded text-[11px] text-amber-300 hover:text-amber-200 px-1.5 py-0.5 cursor-pointer disabled:opacity-50"
      >
        <option value="">Map to…</option>
        {MAP_TO_OPTIONS.map((opt) => (
          <option key={opt} value={opt} className="text-white">{opt}</option>
        ))}
      </select>
      {showSuggestedHint && (
        <span className="text-[10px] text-amber-300/70 italic" title="Pre-selected based on field name">
          suggested
        </span>
      )}
      {selected && (
        <button
          type="button"
          disabled={isSaving}
          onClick={() => onSave(name, selected as MapToTarget)}
          className="text-[11px] px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
      )}
    </div>
  );
}
