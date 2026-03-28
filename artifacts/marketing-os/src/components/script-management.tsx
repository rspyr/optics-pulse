import { useState, useEffect, useCallback } from "react";
import { PremiumCard } from "@/components/ui-helpers";
import { cn } from "@/lib/utils";
import {
  Phone, MessageSquare, Mail, Mic, Plus, Save, X, History,
  ChevronDown, Eye, RotateCcw, Trash2, Loader2, Check, AlertTriangle,
  Filter,
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

interface Script {
  id: number;
  tenantId: number;
  type: string;
  name: string;
  sourceFilter: string | null;
  stageFilter: string | null;
  dispositionFilter: string | null;
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
  dispositionFilter: string | null;
  createdAt: string;
}

interface FunnelType {
  id: number;
  name: string;
  slug: string;
}

const TYPE_CONFIG = {
  call: { label: "Call Scripts", icon: Phone, color: "text-blue-400" },
  text: { label: "Text Templates", icon: MessageSquare, color: "text-emerald-400" },
  email: { label: "Email Templates", icon: Mail, color: "text-amber-400" },
  voicemail: { label: "Voicemail Scripts", icon: Mic, color: "text-purple-400" },
};

const SOURCES = ["Google Ads", "Meta Leads", "Organic Search", "Direct", "Referral"];
const SERVICE_TYPES = ["AC Repair", "AC Install", "Heating Repair", "Heating Install", "Maintenance", "Duct Work", "Indoor Air Quality", "Other"];
const STAGES = [
  { value: "", label: "Any Stage" },
  { value: "new", label: "New Lead" },
  { value: "contacted", label: "Contacted" },
  { value: "re-engage-3mo", label: "3 Month Re-engagement" },
  { value: "re-engage-6mo", label: "6 Month Re-engagement" },
  { value: "re-engage-9mo", label: "9 Month Re-engagement" },
];
const DISPOSITIONS = [
  { value: "", label: "Any Disposition" },
  { value: "callback_requested", label: "Callback Requested" },
  { value: "already_had_estimate", label: "Already Had Estimate" },
  { value: "dont_remember", label: "Don't Remember Form" },
  { value: "never_answered", label: "Never Answered" },
];

const SMART_FIELDS = [
  { token: "{{lead_name}}", label: "Lead Name", preview: "John" },
  { token: "{{csr_name}}", label: "CSR Name", preview: "Sarah" },
  { token: "{{service_type}}", label: "Service Type", preview: "AC Repair" },
  { token: "{{funnel}}", label: "Funnel", preview: "Google Ads" },
  { token: "{{company}}", label: "Company", preview: "CoolAir HVAC" },
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
  let result = content;
  for (const sf of SMART_FIELDS) {
    result = result.replace(new RegExp(sf.token.replace(/[{}]/g, "\\$&"), "g"), sf.preview);
  }
  result = result
    .replace(/\[NAME\]/g, "John")
    .replace(/\[REP\]/g, "Sarah")
    .replace(/\[COMPANY\]/g, "CoolAir HVAC")
    .replace(/\[INTEREST\]/g, "AC Repair");
  return result;
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
  const [editDisposition, setEditDisposition] = useState("");

  const [funnels, setFunnels] = useState<FunnelType[]>([]);
  const [funnelFilter, setFunnelFilter] = useState<string>("");
  const [serviceFilter, setServiceFilter] = useState<string>("");

  const tq = tenantId ? `?tenantId=${tenantId}` : "";

  useEffect(() => {
    if (!tenantId) return;
    fetch(`${API_BASE}/funnel-types?tenantId=${tenantId}`, { credentials: "include" })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setFunnels(data); })
      .catch(() => {});
  }, [tenantId]);

  const fetchScripts = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const url = `${API_BASE}/scripts${tq}`;
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setScripts(data);
      }
    } catch {}
    finally { setLoading(false); }
  }, [tq]);

  useEffect(() => { fetchScripts(true); }, [fetchScripts]);

  const filteredScripts = scripts.filter(s => {
    if (s.type !== activeType) return false;
    if (funnelFilter) {
      const matchesFunnel = s.name.toLowerCase().includes(funnelFilter.toLowerCase()) ||
        s.sourceFilter?.toLowerCase().includes(funnelFilter.toLowerCase()) ||
        s.content.toLowerCase().includes(funnelFilter.toLowerCase());
      if (!matchesFunnel) return false;
    }
    if (serviceFilter) {
      const matchesService = s.name.toLowerCase().includes(serviceFilter.toLowerCase()) ||
        s.content.toLowerCase().includes(serviceFilter.toLowerCase()) ||
        s.dispositionFilter?.toLowerCase().includes(serviceFilter.toLowerCase());
      if (!matchesService) return false;
    }
    return true;
  });

  const groupedScripts = (() => {
    const groups: Record<string, Script[]> = {};
    for (const s of filteredScripts) {
      let groupKey = "General";
      if (funnelFilter) {
        groupKey = funnels.find(f => f.slug === funnelFilter)?.name || funnelFilter;
      } else if (serviceFilter) {
        groupKey = serviceFilter;
      } else {
        const matchedFunnel = funnels.find(f =>
          s.name.toLowerCase().includes(f.slug.toLowerCase()) ||
          s.name.toLowerCase().includes(f.name.toLowerCase()) ||
          s.sourceFilter?.toLowerCase().includes(f.slug.toLowerCase()) ||
          s.content.toLowerCase().includes(f.slug.toLowerCase())
        );
        if (matchedFunnel) {
          groupKey = matchedFunnel.name;
        } else {
          const matchedService = SERVICE_TYPES.find(svc =>
            s.name.toLowerCase().includes(svc.toLowerCase()) ||
            s.content.toLowerCase().includes(svc.toLowerCase())
          );
          if (matchedService) groupKey = matchedService;
        }
      }
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(s);
    }
    const sorted = Object.entries(groups).sort(([a], [b]) => {
      if (a === "General") return 1;
      if (b === "General") return -1;
      return a.localeCompare(b);
    });
    return sorted;
  })();

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
    setEditDisposition(script.dispositionFilter || "");
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
    setEditDisposition("");
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
        dispositionFilter: editDisposition || null,
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
    } catch {}
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

  const insertSmartField = (token: string) => {
    setEditContent(prev => prev + token);
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

      <div className="flex items-center gap-2 flex-wrap">
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

      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="w-3.5 h-3.5 text-white/20" />
        {funnels.length > 0 && (
          <select
            value={funnelFilter}
            onChange={e => setFunnelFilter(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
          >
            <option value="">All Funnels</option>
            {funnels.map(f => <option key={f.id} value={f.slug}>{f.name}</option>)}
          </select>
        )}
        <select
          value={serviceFilter}
          onChange={e => setServiceFilter(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="">All Service Types</option>
          {SERVICE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
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

          {groupedScripts.map(([groupName, groupScripts]) => (
            <div key={groupName}>
              {groupedScripts.length > 1 && (
                <div className="flex items-center gap-2 mb-1 mt-2 first:mt-0">
                  <div className="h-px flex-1 bg-white/5" />
                  <span className="text-[9px] text-white/20 uppercase tracking-widest font-mono">{groupName}</span>
                  <span className="text-[9px] text-white/10 font-mono">({groupScripts.length})</span>
                  <div className="h-px flex-1 bg-white/5" />
                </div>
              )}
              {groupScripts.map(script => (
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
                    {script.dispositionFilter && (
                      <span className="text-[10px] text-blue-400/60">{DISPOSITIONS.find(d => d.value === script.dispositionFilter)?.label || script.dispositionFilter}</span>
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
            </div>
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

              <div className="grid grid-cols-2 gap-3">
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
                  <label className="text-[10px] text-white/30 uppercase tracking-wider">Disposition</label>
                  <select
                    value={editDisposition}
                    onChange={e => setEditDisposition(e.target.value)}
                    className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    {DISPOSITIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] text-white/30 uppercase tracking-wider">Content</label>
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-[9px] text-white/20 mr-1">Insert:</span>
                    {SMART_FIELDS.map(sf => (
                      <button
                        key={sf.token}
                        onClick={() => insertSmartField(sf.token)}
                        className="px-1.5 py-0.5 rounded text-[9px] bg-blue-500/10 text-blue-400/70 hover:bg-blue-500/20 transition-colors"
                        title={sf.label}
                      >
                        {sf.token}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  rows={6}
                  className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-primary/50 font-mono resize-none"
                  placeholder={`Script content with smart fields like {{lead_name}}, {{csr_name}}, {{service_type}}...`}
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
                    {selectedScript.dispositionFilter && (
                      <span className="text-[10px] bg-blue-500/10 text-blue-400/70 px-1.5 py-0.5 rounded">{DISPOSITIONS.find(d => d.value === selectedScript.dispositionFilter)?.label || selectedScript.dispositionFilter}</span>
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
