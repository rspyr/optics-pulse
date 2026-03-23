import { useState, useEffect, useCallback } from "react";
import { PremiumCard } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import {
  Phone, MessageSquare, Mail, Mic, Plus, Save, X, History,
  ChevronDown, Eye, RotateCcw, Trash2, Loader2, Check, AlertTriangle
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

interface Script {
  id: number;
  tenantId: number;
  type: string;
  name: string;
  sourceFilter: string | null;
  stageFilter: string | null;
  content: string;
  version: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ScriptVersion {
  id: number;
  scriptId: number;
  version: number;
  content: string;
  name: string;
  sourceFilter: string | null;
  stageFilter: string | null;
  createdAt: string;
}

const TYPE_CONFIG = {
  call: { label: "Call Scripts", icon: Phone, color: "text-blue-400" },
  text: { label: "Text Templates", icon: MessageSquare, color: "text-emerald-400" },
  email: { label: "Email Templates", icon: Mail, color: "text-amber-400" },
  voicemail: { label: "Voicemail Scripts", icon: Mic, color: "text-purple-400" },
};

const SOURCES = ["Google Ads", "Meta Leads", "CallRail", "Organic Search", "Direct", "Referral"];
const STAGES = [
  { value: "", label: "Any Stage" },
  { value: "new", label: "New Lead" },
  { value: "contacted", label: "Contacted" },
  { value: "re-engage-3mo", label: "3 Month Re-engagement" },
  { value: "re-engage-6mo", label: "6 Month Re-engagement" },
  { value: "re-engage-9mo", label: "9 Month Re-engagement" },
];

function computeDiff(oldText: string, newText: string): { type: "same" | "added" | "removed"; text: string }[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: { type: "same" | "added" | "removed"; text: string }[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = i < oldLines.length ? oldLines[i] : undefined;
    const n = i < newLines.length ? newLines[i] : undefined;
    if (o === n) {
      result.push({ type: "same", text: o! });
    } else {
      if (o !== undefined) result.push({ type: "removed", text: o });
      if (n !== undefined) result.push({ type: "added", text: n });
    }
  }
  return result;
}

function substitutePreview(content: string) {
  return content
    .replace(/\[NAME\]/g, "John")
    .replace(/\[REP\]/g, "Sarah")
    .replace(/\[COMPANY\]/g, "CoolAir HVAC")
    .replace(/\[INTEREST\]/g, "AC repair");
}

export default function ScriptManagement({ tenantId }: { tenantId?: number | null }) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeType, setActiveType] = useState<string>("call");
  const [selectedScript, setSelectedScript] = useState<Script | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<ScriptVersion[]>([]);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editSource, setEditSource] = useState("");
  const [editStage, setEditStage] = useState("");

  const tq = tenantId ? `?tenantId=${tenantId}` : "";

  const fetchScripts = useCallback(async () => {
    setLoading(true);
    try {
      const url = `${API_BASE}/scripts${tq}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) { setLoading(false); return; }
      const data = await res.json();
      if (Array.isArray(data)) setScripts(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [tq]);

  useEffect(() => { fetchScripts(); }, [fetchScripts]);

  const filteredScripts = scripts.filter(s => s.type === activeType);

  const showMsg = (type: "success" | "error", msg: string) => {
    setFeedback({ type, msg });
    setTimeout(() => setFeedback(null), 3000);
  };

  const startEdit = (script: Script) => {
    setSelectedScript(script);
    setEditName(script.name);
    setEditContent(script.content);
    setEditSource(script.sourceFilter || "");
    setEditStage(script.stageFilter || "");
    setEditing(true);
    setCreating(false);
    setShowVersions(false);
  };

  const startCreate = () => {
    setSelectedScript(null);
    setEditName("");
    setEditContent("");
    setEditSource("");
    setEditStage("");
    setEditing(true);
    setCreating(true);
    setShowVersions(false);
  };

  const cancelEdit = () => {
    setEditing(false);
    setCreating(false);
  };

  const handleSave = async () => {
    if (!editName.trim() || !editContent.trim()) {
      showMsg("error", "Name and content are required");
      return;
    }
    setSaving(true);
    try {
      const body = {
        type: activeType,
        name: editName.trim(),
        content: editContent.trim(),
        sourceFilter: editSource || null,
        stageFilter: editStage || null,
      };

      let res: Response;
      if (creating) {
        res = await fetch(`${API_BASE}/scripts${tq}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });
      } else if (selectedScript) {
        res = await fetch(`${API_BASE}/scripts/${selectedScript.id}${tq}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });
      } else {
        return;
      }

      if (res.ok) {
        showMsg("success", creating ? "Script created" : "Script updated");
        setEditing(false);
        setCreating(false);
        fetchScripts();
      } else {
        const err = await res.json();
        showMsg("error", err.error || "Save failed");
      }
    } catch {
      showMsg("error", "Connection error");
    }
    setSaving(false);
  };

  const handleDelete = async (script: Script) => {
    if (!confirm(`Delete "${script.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${API_BASE}/scripts/${script.id}${tq}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        showMsg("success", "Script deleted");
        if (selectedScript?.id === script.id) {
          setSelectedScript(null);
          setEditing(false);
        }
        fetchScripts();
      }
    } catch {
      showMsg("error", "Delete failed");
    }
  };

  const loadVersions = async (script: Script) => {
    try {
      const res = await fetch(`${API_BASE}/scripts/${script.id}/versions${tq}`, { credentials: "include" });
      const data = await res.json();
      setVersions(data);
      setShowVersions(true);
    } catch { /* ignore */ }
  };

  const handleRevert = async (script: Script, versionId: number) => {
    try {
      const res = await fetch(`${API_BASE}/scripts/${script.id}/revert/${versionId}${tq}`, {
        method: "PUT",
        credentials: "include",
      });
      if (res.ok) {
        showMsg("success", "Script reverted");
        setShowVersions(false);
        setEditing(false);
        fetchScripts();
      }
    } catch {
      showMsg("error", "Revert failed");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {feedback && (
        <div className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-lg text-sm",
          feedback.type === "success" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
        )}>
          {feedback.type === "success" ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {feedback.msg}
        </div>
      )}

      <div className="flex items-center gap-2">
        {(Object.entries(TYPE_CONFIG) as [string, typeof TYPE_CONFIG.call][]).map(([type, cfg]) => (
          <button
            key={type}
            onClick={() => { setActiveType(type); setEditing(false); setShowVersions(false); }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs uppercase tracking-wider transition-colors",
              activeType === type
                ? "bg-white/10 text-white border border-white/10"
                : "text-white/40 hover:text-white/60"
            )}
          >
            <cfg.icon className={cn("w-3.5 h-3.5", activeType === type ? cfg.color : "")} />
            {cfg.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 space-y-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-white/40 uppercase tracking-wider">
              {filteredScripts.length} script{filteredScripts.length !== 1 ? "s" : ""}
            </span>
            <button
              onClick={startCreate}
              className="flex items-center gap-1 px-2 py-1 rounded bg-primary/20 text-primary text-xs hover:bg-primary/30 transition-colors"
            >
              <Plus className="w-3 h-3" /> New
            </button>
          </div>

          {filteredScripts.map(script => (
            <PremiumCard
              key={script.id}
              className={cn(
                "p-3 cursor-pointer transition-colors",
                selectedScript?.id === script.id ? "ring-1 ring-primary/50" : "hover:bg-white/[0.02]"
              )}
              onClick={() => { setSelectedScript(script); setEditing(false); setShowVersions(false); }}
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white font-medium truncate">{script.name}</span>
                    <span className="text-[9px] text-white/20 font-mono">v{script.version}</span>
                    {!script.isActive && (
                      <span className="text-[9px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">inactive</span>
                    )}
                  </div>
                  <div className="flex gap-2 mt-1">
                    {script.sourceFilter && (
                      <span className="text-[10px] text-white/30">{script.sourceFilter}</span>
                    )}
                    {script.stageFilter && (
                      <span className="text-[10px] text-white/30">{script.stageFilter}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={e => { e.stopPropagation(); startEdit(script); }}
                    className="p-1 rounded hover:bg-white/5 text-white/30 hover:text-white/60"
                    title="Edit"
                  >
                    <ChevronDown className="w-3.5 h-3.5 -rotate-90" />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(script); }}
                    className="p-1 rounded hover:bg-red-500/10 text-white/20 hover:text-red-400"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </PremiumCard>
          ))}

          {filteredScripts.length === 0 && (
            <p className="text-sm text-white/20 text-center py-6">No {activeType} scripts yet</p>
          )}
        </div>

        <div className="lg:col-span-2">
          {editing ? (
            <PremiumCard className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-display text-white">
                  {creating ? `New ${activeType} Script` : `Edit: ${selectedScript?.name}`}
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowPreview(!showPreview)}
                    className={cn(
                      "flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors",
                      showPreview ? "bg-primary/20 text-primary" : "text-white/40 hover:text-white/60"
                    )}
                  >
                    <Eye className="w-3 h-3" /> Preview
                  </button>
                  <button onClick={cancelEdit} className="text-white/30 hover:text-white/60">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-white/30 uppercase tracking-wider">Name</label>
                  <input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    placeholder="Script name..."
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/30 uppercase tracking-wider">Lead Source</label>
                  <select
                    value={editSource}
                    onChange={e => setEditSource(e.target.value)}
                    className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    <option value="">Any Source</option>
                    {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] text-white/30 uppercase tracking-wider">Lead Stage</label>
                <select
                  value={editStage}
                  onChange={e => setEditStage(e.target.value)}
                  className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                >
                  {STAGES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-white/30 uppercase tracking-wider">Content</label>
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  rows={6}
                  className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono resize-none"
                  placeholder="Script content with [NAME], [REP], [COMPANY], [INTEREST] placeholders..."
                />
              </div>

              {showPreview && editContent && (
                <div className="rounded-lg bg-blue-500/5 border border-blue-500/10 p-4">
                  <p className="text-[10px] text-blue-400/60 uppercase tracking-wider mb-2">Live Preview</p>
                  <p className="text-sm text-white/80 leading-relaxed whitespace-pre-wrap">
                    {substitutePreview(editContent)}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button onClick={cancelEdit} className="px-3 py-1.5 rounded text-sm text-white/40 hover:text-white/60">
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  {creating ? "Create" : "Save Changes"}
                </button>
              </div>
            </PremiumCard>
          ) : selectedScript ? (
            <PremiumCard className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-display text-white">{selectedScript.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] text-white/30 font-mono">v{selectedScript.version}</span>
                    {selectedScript.sourceFilter && (
                      <span className="text-[10px] bg-white/5 text-white/40 px-1.5 py-0.5 rounded">{selectedScript.sourceFilter}</span>
                    )}
                    {selectedScript.stageFilter && (
                      <span className="text-[10px] bg-white/5 text-white/40 px-1.5 py-0.5 rounded">{selectedScript.stageFilter}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => loadVersions(selectedScript)}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs text-white/40 hover:text-white/60 hover:bg-white/5"
                  >
                    <History className="w-3 h-3" /> History
                  </button>
                  <button
                    onClick={() => startEdit(selectedScript)}
                    className="flex items-center gap-1 px-3 py-1 rounded bg-primary/20 text-primary text-xs hover:bg-primary/30"
                  >
                    Edit
                  </button>
                </div>
              </div>

              <div className="rounded-lg bg-white/[0.02] border border-white/5 p-4">
                <p className="text-sm text-white/70 leading-relaxed whitespace-pre-wrap">{selectedScript.content}</p>
              </div>

              <div className="rounded-lg bg-blue-500/5 border border-blue-500/10 p-4">
                <p className="text-[10px] text-blue-400/60 uppercase tracking-wider mb-2">Preview</p>
                <p className="text-sm text-white/80 leading-relaxed whitespace-pre-wrap">
                  {substitutePreview(selectedScript.content)}
                </p>
              </div>

              {showVersions && (
                <div className="space-y-2">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider">Version History</p>
                  {versions.length === 0 ? (
                    <p className="text-sm text-white/20">No previous versions</p>
                  ) : versions.map((v, idx) => {
                    const nextContent = idx === 0 ? selectedScript.content : versions[idx - 1].content;
                    const diffLines = computeDiff(v.content, nextContent);
                    const hasChanges = diffLines.some(d => d.type !== "same");
                    return (
                      <div key={v.id} className="rounded-lg bg-white/[0.02] border border-white/5 p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-white/60 font-mono">v{v.version}</span>
                            <span className="text-[10px] text-white/20">
                              {new Date(v.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            </span>
                            {hasChanges && (
                              <span className="text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded">changed</span>
                            )}
                          </div>
                          <button
                            onClick={() => handleRevert(selectedScript, v.id)}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-amber-400 hover:bg-amber-500/10"
                          >
                            <RotateCcw className="w-3 h-3" /> Revert
                          </button>
                        </div>
                        {hasChanges ? (
                          <div className="font-mono text-xs leading-relaxed space-y-0.5">
                            {diffLines.map((d, i) => (
                              <div
                                key={i}
                                className={cn(
                                  "px-2 py-0.5 rounded-sm",
                                  d.type === "removed" && "bg-red-500/10 text-red-400 line-through",
                                  d.type === "added" && "bg-emerald-500/10 text-emerald-400",
                                  d.type === "same" && "text-white/30"
                                )}
                              >
                                <span className="select-none mr-2 text-white/15">
                                  {d.type === "removed" ? "−" : d.type === "added" ? "+" : " "}
                                </span>
                                {d.text || "\u00A0"}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-white/40 leading-relaxed whitespace-pre-wrap">{v.content}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </PremiumCard>
          ) : (
            <PremiumCard className="p-8 flex flex-col items-center justify-center text-center">
              {(() => {
                const cfg = TYPE_CONFIG[activeType as keyof typeof TYPE_CONFIG];
                return cfg ? <cfg.icon className={cn("w-8 h-8 mb-3", cfg.color, "opacity-20")} /> : null;
              })()}
              <p className="text-sm text-white/30">Select a script to view or edit</p>
              <p className="text-xs text-white/15 mt-1">or click "New" to create one</p>
            </PremiumCard>
          )}
        </div>
      </div>
    </div>
  );
}
