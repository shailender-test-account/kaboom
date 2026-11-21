import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft, Plus, Loader2, RefreshCw,
  Users, Building2, Tag, TrendingUp,
  Save, Eye, Layers, X, Mail, Clock, BookOpen, GitBranch, Star,
  CheckCircle2, Download, FileText, Search, Play,
} from "lucide-react";
import { RunWizard } from "@/pages/sequences/RunWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

// ── Field definitions ─────────────────────────────────────────────────────────

type FieldDef = {
  key: string;
  label: string;
  group: string;
  icon: React.ComponentType<any>;
  operators: { value: string; label: string }[];
  valueType: "number" | "text" | "date" | "multi-text" | "select" | "multi-select" | "segment-select" | "journey-select" | "form-select" | "client-select" | "none";
  options?: { value: string; label: string }[];
};

const FIELDS: FieldDef[] = [
  // ── Profile ──
  {
    key: "lead_score", label: "Lead Score", group: "Profile",
    icon: TrendingUp,
    operators: [
      { value: "gt", label: "Greater than" },
      { value: "lt", label: "Less than" },
      { value: "eq", label: "Equals" },
      { value: "between", label: "Between" },
    ],
    valueType: "number",
  },
  {
    key: "score_tier", label: "Score Tier", group: "Profile",
    icon: Star,
    operators: [{ value: "is", label: "Is" }, { value: "is_not", label: "Is not" }],
    valueType: "multi-select",
    options: [
      { value: "Cold", label: "Cold" },
      { value: "Warm", label: "Warm" },
      { value: "Hot", label: "Hot" },
      { value: "Very Hot", label: "Very Hot" },
      { value: "Champion", label: "Champion" },
    ],
  },
  {
    key: "score_trend", label: "Score Trend", group: "Profile",
    icon: TrendingUp,
    operators: [
      { value: "rising",  label: "Rising (positive events in 30d)" },
      { value: "flat",    label: "Flat (no events in 30d)" },
      { value: "falling", label: "Falling (negative events in 30d)" },
    ],
    valueType: "none",
  },
  {
    key: "score_change_30d", label: "Score Change (30d)", group: "Profile",
    icon: TrendingUp,
    operators: [
      { value: "gt", label: "Increased by more than" },
      { value: "lt", label: "Decreased by more than" },
      { value: "eq", label: "Changed by exactly" },
    ],
    valueType: "number",
  },
  {
    key: "stage", label: "Journey Stage", group: "Profile",
    icon: TrendingUp,
    operators: [{ value: "is", label: "Is" }, { value: "is_not", label: "Is not" }],
    valueType: "multi-select",
    options: [
      { value: "pre-aware", label: "Pre-Aware" },
      { value: "aware", label: "Aware" },
      { value: "engaged", label: "Engaged" },
      { value: "evaluating", label: "Evaluating" },
      { value: "decision", label: "Decision" },
    ],
  },
  {
    key: "title", label: "Job Title", group: "Profile",
    icon: Users,
    operators: [
      { value: "contains", label: "Contains" },
      { value: "is", label: "Exactly is" },
      { value: "starts_with", label: "Starts with" },
    ],
    valueType: "text",
  },
  {
    key: "company_name", label: "Company Name", group: "Profile",
    icon: Building2,
    operators: [{ value: "contains", label: "Contains" }],
    valueType: "text",
  },
  {
    key: "industry", label: "Industry", group: "Profile",
    icon: Building2,
    operators: [{ value: "contains", label: "Contains" }, { value: "is", label: "Exactly is" }],
    valueType: "text",
  },
  {
    key: "source", label: "Source", group: "Profile",
    icon: Users,
    operators: [{ value: "is", label: "Is" }, { value: "is_not", label: "Is not" }],
    valueType: "multi-select",
    options: [
      { value: "manual", label: "Manual" },
      { value: "import", label: "Import" },
      { value: "form", label: "Form" },
      { value: "linkedin", label: "LinkedIn" },
      { value: "website", label: "Website" },
      { value: "event", label: "Event" },
      { value: "referral", label: "Referral" },
    ],
  },
  {
    key: "tags", label: "Tags", group: "Profile",
    icon: Tag,
    operators: [
      { value: "contains", label: "Has tag" },
      { value: "contains_any", label: "Has any of" },
      { value: "contains_all", label: "Has all of" },
    ],
    valueType: "multi-text",
  },
  {
    key: "client_id", label: "Client / Database", group: "Profile",
    icon: Building2,
    operators: [{ value: "is", label: "Is" }, { value: "is_not", label: "Is not" }],
    valueType: "client-select",
  },
  {
    key: "identifier", label: "Identifier", group: "Profile",
    icon: Tag,
    operators: [
      { value: "is", label: "Is" },
      { value: "is_not", label: "Is not" },
      { value: "contains", label: "Contains" },
    ],
    valueType: "multi-text",
  },
  // ── Activity & Dates ──
  {
    key: "last_activity_at", label: "Last Activity", group: "Activity",
    icon: Clock,
    operators: [
      { value: "last_n_days", label: "Active in last N days" },
      { value: "not_in_n_days", label: "Inactive for N days" },
      { value: "before", label: "Before date" },
      { value: "after", label: "After date" },
    ],
    valueType: "text",
  },
  {
    key: "created_at", label: "Created Date", group: "Activity",
    icon: Clock,
    operators: [
      { value: "last_n_days", label: "In last N days" },
      { value: "before", label: "Before date" },
      { value: "after", label: "After date" },
    ],
    valueType: "text",
  },
  {
    key: "email_opens", label: "Email Opens", group: "Activity",
    icon: Mail,
    operators: [
      { value: "gt", label: "More than" },
      { value: "lt", label: "Fewer than" },
      { value: "eq", label: "Exactly" },
    ],
    valueType: "number",
  },
  {
    key: "email_clicks", label: "Email Clicks", group: "Activity",
    icon: Mail,
    operators: [
      { value: "gt", label: "More than" },
      { value: "lt", label: "Fewer than" },
      { value: "eq", label: "Exactly" },
    ],
    valueType: "number",
  },
  {
    key: "emails_received", label: "Emails Received", group: "Activity",
    icon: Mail,
    operators: [
      { value: "gt", label: "More than" },
      { value: "lt", label: "Fewer than" },
    ],
    valueType: "number",
  },
  {
    key: "pages_viewed", label: "Pages Viewed", group: "Activity",
    icon: Eye,
    operators: [
      { value: "gt", label: "More than" },
      { value: "lt", label: "Fewer than" },
      { value: "eq", label: "Exactly" },
    ],
    valueType: "number",
  },
  {
    key: "visited_journey", label: "Visited Journey", group: "Activity",
    icon: BookOpen,
    operators: [
      { value: "yes", label: "Has visited a journey page" },
      { value: "no", label: "Has not visited a journey page" },
    ],
    valueType: "none",
  },
  {
    key: "submitted_form", label: "Submitted Form", group: "Activity",
    icon: FileText,
    operators: [
      { value: "yes", label: "Has submitted a form" },
      { value: "no", label: "Has not submitted a form" },
    ],
    valueType: "none",
  },
  {
    key: "downloaded_asset", label: "Downloaded Asset", group: "Activity",
    icon: Download,
    operators: [
      { value: "yes", label: "Has downloaded an asset" },
      { value: "no", label: "Has not downloaded an asset" },
    ],
    valueType: "none",
  },
  // ── Journey & Sequences ──
  {
    key: "in_journey", label: "Journey Membership", group: "Journey & Sequences",
    icon: BookOpen,
    operators: [
      { value: "yes", label: "Is in any journey" },
      { value: "no", label: "Not in any journey" },
    ],
    valueType: "none",
  },
  {
    key: "journey_count", label: "Journey Count", group: "Journey & Sequences",
    icon: BookOpen,
    operators: [
      { value: "gt", label: "More than" },
      { value: "lt", label: "Fewer than" },
      { value: "eq", label: "Exactly" },
    ],
    valueType: "number",
  },
  {
    key: "enrolled_sequence", label: "Enrolled in Sequence", group: "Journey & Sequences",
    icon: GitBranch,
    operators: [
      { value: "yes", label: "Is enrolled in any sequence" },
      { value: "no", label: "Is not enrolled in any sequence" },
    ],
    valueType: "none",
  },
  {
    key: "sequence_status", label: "Sequence Status", group: "Journey & Sequences",
    icon: GitBranch,
    operators: [{ value: "is", label: "Is" }, { value: "is_not", label: "Is not" }],
    valueType: "multi-select",
    options: [
      { value: "active", label: "Active" },
      { value: "completed", label: "Completed" },
      { value: "paused", label: "Paused" },
      { value: "failed", label: "Failed" },
    ],
  },
  {
    key: "member_of_segment", label: "Member of Segment", group: "Journey & Sequences",
    icon: Layers,
    operators: [
      { value: "yes", label: "Is in segment" },
      { value: "no",  label: "Is NOT in segment" },
    ],
    valueType: "segment-select",
  },
  {
    key: "visited_journey_id", label: "Visited Journey", group: "Journey & Sequences",
    icon: BookOpen,
    operators: [
      { value: "yes", label: "Has visited" },
      { value: "no",  label: "Has NOT visited" },
    ],
    valueType: "journey-select",
  },
  {
    key: "submitted_form_id", label: "Submitted Form", group: "Journey & Sequences",
    icon: FileText,
    operators: [
      { value: "yes", label: "Has submitted" },
      { value: "no",  label: "Has NOT submitted" },
    ],
    valueType: "form-select",
  },
];

const FIELD_GROUPS = ["Profile", "Activity", "Journey & Sequences"];

// ── Types ─────────────────────────────────────────────────────────────────────

type Criterion = {
  id: string;
  field: string;
  operator: string;
  value: string | number | number[] | string[];
};

type PreviewData = {
  total: number;
  contacts: Array<{
    id: number; first_name: string; last_name: string;
    email: string; lead_score: number; company_name: string | null; tags: string[];
  }>;
  scoreDistribution: Record<string, number>;
  topCompanies: Array<{ name: string; contact_count: number }>;
};

type ExistingSegment = {
  id: number; name: string; description: string | null;
  segment_type: string; filter_criteria: Criterion[];
  logic_operator: string; static_contact_ids: number[] | null;
};

type Journey = { id: number; name: string; status: string; clientName: string | null };

interface SegmentBuilderProps { id?: string }

const TIER_COLORS: Record<string, string> = {
  "Cold": "#94a3b8",
  "Warm": "#60a5fa",
  "Hot": "#f97316",
  "Very Hot": "#ef4444",
  "Champion": "#a855f7",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isNDaysOp(op: string) { return op === "last_n_days" || op === "not_in_n_days"; }
function isDateOp(op: string)  { return op === "before" || op === "after"; }

export default function SegmentBuilder({ id }: SegmentBuilderProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isEdit = !!id;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [segmentType, setSegmentType] = useState<"dynamic" | "static">("dynamic");
  const [logicOperator, setLogicOperator] = useState<"AND" | "OR">("AND");
  const [parentSegmentId, setParentSegmentId] = useState<number | null>(null);
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [staticContactIds, setStaticContactIds] = useState<number[]>([]);
  const [staticSearch, setStaticSearch] = useState("");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [autoPreview, setAutoPreview] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Run Wizard
  const [runWizardOpen, setRunWizardOpen] = useState(false);

  // Assign-to-journey dialog
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [savedSegmentId, setSavedSegmentId] = useState<number | null>(null);
  const [selectedJourneyId, setSelectedJourneyId] = useState<number | null>(null);
  const [assignMode, setAssignMode] = useState<"live" | "snapshot">("live");
  const [isAssigning, setIsAssigning] = useState(false);

  // Load existing segment if editing
  const { data: existing } = useQuery<ExistingSegment>({
    queryKey: ["segments", id],
    queryFn: () => api(`/segments/${id}`).then(r => r.json()),
    enabled: isEdit,
  });

  // Journeys — needed both for the assign dialog and the "Visited Journey" filter
  const { data: journeys = [] } = useQuery<Journey[]>({
    queryKey: ["journeys-list"],
    queryFn: () => api("/journeys").then(r => r.json()),
  });

  // Journey forms — needed for the "Submitted Form" filter
  const { data: allForms = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["journey-forms"],
    queryFn: () => api("/journey-forms").then(r => r.json()),
  });

  // Clients — needed for the "Client / Database" filter (distinguish contact uploads by client)
  const { data: allClients = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["clients-list"],
    queryFn: () => api("/clients").then(r => r.json()),
  });

  // All segments for the member_of_segment picker + parent segment picker
  const { data: allSegments = [] } = useQuery<{ id: number; name: string; last_computed_count: number | null }[]>({
    queryKey: ["segments"],
    queryFn: () => api("/segments").then(r => r.json()),
  });

  // Contacts for static segment picker — /api/contacts returns camelCase
  const { data: allContacts = [] } = useQuery<{ id: number; firstName: string; lastName: string; email: string; leadScore: number; companyName: string | null }[]>({
    queryKey: ["contacts-all"],
    queryFn: () => api("/contacts").then(r => r.json()),
    enabled: segmentType === "static",
  });

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDescription(existing.description ?? "");
      setSegmentType(existing.segment_type as "dynamic" | "static");
      setCriteria(existing.filter_criteria ?? []);
      setLogicOperator((existing.logic_operator as "AND" | "OR") ?? "AND");
      if (existing.static_contact_ids?.length) {
        setStaticContactIds(existing.static_contact_ids);
      }
    }
  }, [existing]);

  // Auto-preview debounce
  useEffect(() => {
    if (autoPreview && segmentType === "dynamic") {
      const timeout = setTimeout(() => runPreview(), 500);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [criteria, segmentType, logicOperator, autoPreview, parentSegmentId]);

  function effectiveCriteria() {
    if (segmentType !== "dynamic") return criteria;
    if (parentSegmentId == null) return criteria;
    return [{ id: "__parent__", field: "member_of_segment", operator: "yes", value: parentSegmentId }, ...criteria];
  }

  async function runPreview() {
    setIsPreviewing(true);
    setPreviewError(null);
    try {
      const body = segmentType === "static"
        ? { segmentType, staticContactIds, logicOperator }
        : { filterCriteria: effectiveCriteria(), segmentType, logicOperator };
      const res = await api("/segments/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setPreviewError((err as any).error ?? "Preview failed — check your filter values");
        return;
      }
      const data = await res.json();
      setPreview(data);
    } catch {
      setPreviewError("Could not reach the server");
    } finally {
      setIsPreviewing(false);
    }
  }

  async function saveSegment(): Promise<number | null> {
    if (!name.trim()) {
      toast({ title: "Segment name is required", variant: "destructive" });
      return null;
    }
    setIsSaving(true);
    try {
      const body = {
        name, description, segmentType,
        filterCriteria: segmentType === "dynamic" ? effectiveCriteria() : criteria,
        logicOperator,
        ...(segmentType === "static" ? { staticContactIds } : {}),
      };
      const res = await api(isEdit ? `/segments/${id}` : "/segments", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Save failed");
      const saved = await res.json();
      qc.invalidateQueries({ queryKey: ["segments"] });
      return saved.id as number;
    } catch {
      toast({ title: "Failed to save segment", variant: "destructive" });
      return null;
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSave() {
    const segId = await saveSegment();
    if (segId) {
      toast({ title: isEdit ? "Segment updated" : "Segment created" });
      navigate("/database/segments");
    }
  }

  function handleExportCsv() {
    if (!id) return;
    const a = document.createElement("a");
    a.href = `/api/segments/${id}/export.csv`;
    a.download = `segment-${id}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function handleSaveAndAssign() {
    const segId = await saveSegment();
    if (segId) {
      setSavedSegmentId(segId);
      setSelectedJourneyId(null);
      setAssignDialogOpen(true);
    }
  }

  async function handleAssign() {
    if (!selectedJourneyId || !savedSegmentId) return;
    setIsAssigning(true);
    try {
      const res = await api(`/journeys/${selectedJourneyId}/segments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segmentId: savedSegmentId, snapshotMode: assignMode === "snapshot" }),
      });
      if (!res.ok) throw new Error();
      toast({ title: `Segment assigned — ${assignMode === "snapshot" ? "static snapshot" : "live dynamic sync"}` });
      setAssignDialogOpen(false);
      navigate("/database/segments");
    } catch {
      toast({ title: "Failed to assign segment", variant: "destructive" });
    } finally {
      setIsAssigning(false);
    }
  }

  function addCriterion() {
    setCriteria(prev => [
      ...prev,
      { id: crypto.randomUUID(), field: "lead_score", operator: "gt", value: 50 },
    ]);
  }

  function removeCriterion(cid: string) {
    setCriteria(prev => prev.filter(c => c.id !== cid));
  }

  function updateCriterion(cid: string, patch: Partial<Criterion>) {
    setCriteria(prev => prev.map(c => c.id === cid ? { ...c, ...patch } : c));
  }

  // ── Criterion Row ──────────────────────────────────────────────────────────
  function CriterionRow({ crit }: { crit: Criterion }) {
    const fieldDef = FIELDS.find(f => f.key === crit.field) ?? FIELDS[0];
    const Icon = fieldDef.icon;
    const selectedValues: string[] = Array.isArray(crit.value) ? crit.value as string[] : [];

    function toggleMulti(optVal: string) {
      const next = selectedValues.includes(optVal)
        ? selectedValues.filter(v => v !== optVal)
        : [...selectedValues, optVal];
      updateCriterion(crit.id, { value: next });
    }

    // Determine value input to show
    let valueInput: React.ReactNode = null;

    if (fieldDef.valueType === "none") {
      valueInput = null;
    } else if (fieldDef.valueType === "segment-select") {
      valueInput = (
        <Select
          value={String(Array.isArray(crit.value) ? "" : crit.value ?? "")}
          onValueChange={val => updateCriterion(crit.id, { value: Number(val) })}
        >
          <SelectTrigger className="h-7 text-xs w-44 bg-white">
            <SelectValue placeholder="Pick segment…" />
          </SelectTrigger>
          <SelectContent>
            {allSegments
              .filter(s => !isEdit || String(s.id) !== id)
              .map(s => (
                <SelectItem key={s.id} value={String(s.id)} className="text-xs">{s.name}</SelectItem>
              ))}
          </SelectContent>
        </Select>
      );
    } else if (fieldDef.valueType === "journey-select") {
      valueInput = (
        <Select
          value={String(Array.isArray(crit.value) ? "" : crit.value ?? "")}
          onValueChange={val => updateCriterion(crit.id, { value: Number(val) })}
        >
          <SelectTrigger className="h-7 text-xs w-48 bg-white">
            <SelectValue placeholder="Pick journey…" />
          </SelectTrigger>
          <SelectContent>
            {journeys.map(j => (
              <SelectItem key={j.id} value={String(j.id)} className="text-xs">{j.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    } else if (fieldDef.valueType === "form-select") {
      valueInput = (
        <Select
          value={String(Array.isArray(crit.value) ? "" : crit.value ?? "")}
          onValueChange={val => updateCriterion(crit.id, { value: Number(val) })}
        >
          <SelectTrigger className="h-7 text-xs w-48 bg-white">
            <SelectValue placeholder="Pick form…" />
          </SelectTrigger>
          <SelectContent>
            {allForms.map(f => (
              <SelectItem key={f.id} value={String(f.id)} className="text-xs">{f.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    } else if (fieldDef.valueType === "client-select") {
      valueInput = (
        <div className="flex flex-wrap gap-1 items-center min-h-7">
          {allClients.map(cl => (
            <button
              key={cl.id}
              type="button"
              onClick={() => toggleMulti(String(cl.id))}
              className={cn(
                "px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors",
                selectedValues.includes(String(cl.id))
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white text-muted-foreground border-border hover:border-indigo-300"
              )}
            >
              {cl.name}
            </button>
          ))}
          {allClients.length === 0 && (
            <span className="text-[10px] text-muted-foreground">No clients found</span>
          )}
        </div>
      );
    } else if (fieldDef.valueType === "multi-select") {
      valueInput = (
        <div className="flex flex-wrap gap-1 items-center min-h-7">
          {fieldDef.options?.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggleMulti(opt.value)}
              className={cn(
                "px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors",
                selectedValues.includes(opt.value)
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white text-muted-foreground border-border hover:border-indigo-300"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      );
    } else if (fieldDef.valueType === "select") {
      valueInput = (
        <Select
          value={Array.isArray(crit.value) ? (crit.value as string[])[0] ?? "" : String(crit.value)}
          onValueChange={val => updateCriterion(crit.id, { value: [val] })}
        >
          <SelectTrigger className="h-7 text-xs w-32 bg-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fieldDef.options?.map(opt => (
              <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    } else if (fieldDef.valueType === "multi-text") {
      valueInput = (
        <Input
          className="h-7 text-xs w-40 bg-white"
          placeholder="tag1, tag2..."
          value={Array.isArray(crit.value) ? (crit.value as string[]).join(", ") : String(crit.value)}
          onChange={e => updateCriterion(crit.id, {
            value: e.target.value.split(",").map(s => s.trim()).filter(Boolean),
          })}
        />
      );
    } else if (crit.operator === "between" && fieldDef.valueType === "number") {
      // Range input for between
      const range = Array.isArray(crit.value) ? crit.value as number[] : [0, 200];
      valueInput = (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            className="h-7 text-xs w-16 bg-white"
            placeholder="min"
            value={String(range[0] ?? 0)}
            onChange={e => updateCriterion(crit.id, { value: [Number(e.target.value), range[1] ?? 200] })}
          />
          <span className="text-xs text-muted-foreground">–</span>
          <Input
            type="number"
            className="h-7 text-xs w-16 bg-white"
            placeholder="max"
            value={String(range[1] ?? 200)}
            onChange={e => updateCriterion(crit.id, { value: [range[0] ?? 0, Number(e.target.value)] })}
          />
        </div>
      );
    } else if (isDateOp(crit.operator)) {
      // Date picker for before/after
      valueInput = (
        <Input
          type="date"
          className="h-7 text-xs w-36 bg-white"
          value={Array.isArray(crit.value) ? "" : String(crit.value)}
          onChange={e => updateCriterion(crit.id, { value: e.target.value })}
        />
      );
    } else if (isNDaysOp(crit.operator) || fieldDef.valueType === "number") {
      valueInput = (
        <Input
          type="number"
          className="h-7 text-xs w-24 bg-white"
          value={Array.isArray(crit.value) ? "" : String(crit.value)}
          onChange={e => updateCriterion(crit.id, { value: Number(e.target.value) })}
        />
      );
    } else {
      valueInput = (
        <Input
          type="text"
          className="h-7 text-xs w-36 bg-white"
          value={Array.isArray(crit.value) ? "" : String(crit.value)}
          onChange={e => updateCriterion(crit.id, { value: e.target.value })}
        />
      );
    }

    return (
      <div className="flex flex-wrap items-start gap-2 bg-muted/30 border rounded-lg p-2.5">
        <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-1.5" />

        {/* Field selector */}
        <Select
          value={crit.field}
          onValueChange={val => {
            const newField = FIELDS.find(f => f.key === val) ?? FIELDS[0];
            const defaultVal: string | number | string[] =
              newField.valueType === "number" ? 0
              : newField.valueType === "multi-text" || newField.valueType === "multi-select" ? []
              : "";
            updateCriterion(crit.id, {
              field: val,
              operator: newField.operators[0].value,
              value: defaultVal,
            });
          }}
        >
          <SelectTrigger className="h-7 text-xs w-36 bg-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72 overflow-y-auto">
            {FIELD_GROUPS.map(group => (
              <div key={group}>
                <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide bg-muted/30">
                  {group}
                </div>
                {FIELDS.filter(f => f.group === group).map(f => (
                  <SelectItem key={f.key} value={f.key} className="text-xs">{f.label}</SelectItem>
                ))}
              </div>
            ))}
          </SelectContent>
        </Select>

        {/* Operator selector */}
        <Select
          value={crit.operator}
          onValueChange={val => {
            // Reset value when switching to/from between
            const prevIsBetween = crit.operator === "between";
            const newIsBetween = val === "between";
            const resetVal = newIsBetween ? [0, 200] : (prevIsBetween ? 0 : crit.value);
            updateCriterion(crit.id, { operator: val, value: resetVal });
          }}
        >
          <SelectTrigger className="h-7 text-xs w-36 bg-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fieldDef.operators.map(op => (
              <SelectItem key={op.value} value={op.value} className="text-xs">{op.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Value input */}
        {valueInput}

        <button
          onClick={() => removeCriterion(crit.id)}
          className="ml-auto text-muted-foreground hover:text-destructive transition-colors mt-0.5"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  // ── Score distribution chart data ──────────────────────────────────────────
  const chartData = preview?.scoreDistribution
    ? Object.entries(preview.scoreDistribution)
        .filter(([, v]) => Number(v) > 0)
        .map(([tier, count]) => ({ tier, count: Number(count), fill: TIER_COLORS[tier] ?? "#6366f1" }))
    : [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b bg-card px-6 py-3 flex items-center gap-3 shrink-0">
        <button
          onClick={() => navigate("/database/segments")}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1">
          <h1 className="text-base font-semibold text-foreground">
            {isEdit ? "Edit Segment" : "New Segment"}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {isEdit && id && (
            <Button variant="outline" size="sm" onClick={() => navigate(`/database?segmentId=${encodeURIComponent(id)}`)}>
              View all contacts · Verify details
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={runPreview} disabled={isPreviewing}>
            {isPreviewing
              ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
            Preview
          </Button>
          {isEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Export CSV
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSaveAndAssign}
            disabled={isSaving}
          >
            {isSaving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
            Save & Assign
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving}
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            {isSaving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
            {isEdit ? "Update" : "Save"} Segment
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!isEdit && !savedSegmentId}
            title={!isEdit && !savedSegmentId ? "Save the segment first" : "Launch a sequence for this segment"}
            onClick={() => setRunWizardOpen(true)}
          >
            <Play className="w-3.5 h-3.5 mr-1.5" />
            Launch Sequence
          </Button>
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Builder */}
        <div className="w-[480px] shrink-0 border-r flex flex-col overflow-y-auto">
          <div className="p-5 space-y-4">
            <div>
              <Label className="text-xs font-medium mb-1.5 block">Segment Name *</Label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. High-Score Champions"
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-xs font-medium mb-1.5 block">Description</Label>
              <Textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Optional description..."
                rows={2}
                className="text-sm resize-none"
              />
            </div>

            {/* Segment type */}
            <div>
              <Label className="text-xs font-medium mb-2 block">Segment Type</Label>
              <div className="flex gap-2">
                {(["dynamic", "static"] as const).map(type => (
                  <button
                    key={type}
                    onClick={() => setSegmentType(type)}
                    className={cn(
                      "flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-all",
                      segmentType === type
                        ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                        : "bg-card border-border text-muted-foreground hover:border-muted-foreground"
                    )}
                  >
                    {type === "dynamic" ? "Dynamic (auto-updates)" : "Static (fixed list)"}
                  </button>
                ))}
              </div>
            </div>

            {/* Parent segment picker — dynamic only */}
            {segmentType === "dynamic" && (
              <div>
                <Label className="text-xs font-medium mb-1.5 block">
                  Based on segment{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Select
                  value={parentSegmentId != null ? String(parentSegmentId) : "__none__"}
                  onValueChange={v => setParentSegmentId(v === "__none__" ? null : Number(v))}
                >
                  <SelectTrigger className="h-8 text-xs bg-white">
                    <SelectValue placeholder="All contacts (no parent)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__" className="text-xs">
                      All contacts (no parent)
                    </SelectItem>
                    {allSegments
                      .filter(s => !isEdit || s.id !== Number(id))
                      .map(s => (
                        <SelectItem key={s.id} value={String(s.id)} className="text-xs">
                          {s.name}
                          {s.last_computed_count != null && (
                            <span className="ml-1.5 text-muted-foreground text-[10px]">
                              ({s.last_computed_count})
                            </span>
                          )}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {parentSegmentId != null && (
                  <p className="text-[11px] text-indigo-600 mt-1.5">
                    Contacts from the selected segment are used as the base pool — your conditions below refine further.
                  </p>
                )}
              </div>
            )}

            {/* Static contact picker */}
            {segmentType === "static" && (
              <div>
                <Label className="text-xs font-medium mb-2 block">
                  Selected Contacts
                  {staticContactIds.length > 0 && (
                    <span className="ml-1.5 text-indigo-600">({staticContactIds.length} selected)</span>
                  )}
                </Label>
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    className="pl-7 h-8 text-xs"
                    placeholder="Search contacts..."
                    value={staticSearch}
                    onChange={e => setStaticSearch(e.target.value)}
                  />
                </div>
                {staticContactIds.length === 0 && (
                  <p className="text-[10px] text-amber-600 mb-2">
                    No contacts selected — this segment will match no contacts when assigned.
                  </p>
                )}
                <div className="border rounded-lg overflow-hidden max-h-52 overflow-y-auto">
                  {allContacts
                    .filter(c => {
                      const q = staticSearch.toLowerCase();
                      return `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) || c.email.toLowerCase().includes(q);
                    })
                    .slice(0, 50)
                    .map(c => {
                      const selected = staticContactIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setStaticContactIds(prev =>
                            selected ? prev.filter(id => id !== c.id) : [...prev, c.id]
                          )}
                          className={cn(
                            "w-full flex items-center gap-2 px-3 py-2 text-left border-b last:border-b-0 transition-colors",
                            selected ? "bg-indigo-50" : "bg-card hover:bg-muted/20"
                          )}
                        >
                          <div className={cn(
                            "w-4 h-4 rounded border shrink-0 flex items-center justify-center",
                            selected ? "bg-indigo-600 border-indigo-600" : "border-border"
                          )}>
                            {selected && <CheckCircle2 className="w-3 h-3 text-white" />}
                          </div>
                          <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                            <span className="text-[9px] font-bold text-indigo-700">
                              {c.firstName?.[0] ?? "?"}{c.lastName?.[0] ?? ""}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">{c.firstName} {c.lastName}</p>
                            <p className="text-[10px] text-muted-foreground truncate">{c.email}</p>
                          </div>
                          <span className="text-xs font-semibold text-indigo-600 shrink-0">{c.leadScore}</span>
                        </button>
                      );
                    })}
                  {allContacts.length === 0 && (
                    <div className="flex items-center justify-center p-4 text-muted-foreground text-xs">
                      <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Loading contacts…
                    </div>
                  )}
                </div>
                {staticContactIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setStaticContactIds([])}
                    className="mt-1 text-[10px] text-muted-foreground hover:text-destructive"
                  >
                    Clear all selections
                  </button>
                )}
              </div>
            )}

            {/* Conditions */}
            {segmentType === "dynamic" && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-xs font-medium">Filter Conditions</Label>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>Auto-preview</span>
                    <Switch
                      checked={autoPreview}
                      onCheckedChange={setAutoPreview}
                      className="scale-75"
                    />
                  </div>
                </div>

                {criteria.length === 0 ? (
                  <div className="border-2 border-dashed rounded-lg p-6 text-center">
                    <Layers className="w-7 h-7 mx-auto text-muted-foreground/40 mb-2" />
                    <p className="text-xs text-muted-foreground">Add conditions to filter contacts</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {criteria.map((crit, idx) => (
                      <div key={crit.id}>
                        {idx > 0 && (
                          <div className="flex items-center gap-2 my-1.5">
                            <div className="flex-1 h-px bg-border" />
                            <button
                              onClick={() => setLogicOperator(lo => lo === "AND" ? "OR" : "AND")}
                              className={cn(
                                "text-[10px] font-bold px-2.5 py-0.5 rounded border transition-colors",
                                logicOperator === "OR"
                                  ? "bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100"
                                  : "bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100"
                              )}
                              title="Click to toggle AND / OR"
                            >
                              {logicOperator}
                            </button>
                            <div className="flex-1 h-px bg-border" />
                          </div>
                        )}
                        <CriterionRow crit={crit} />
                      </div>
                    ))}
                  </div>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 w-full h-8 border-dashed text-muted-foreground hover:text-foreground"
                  onClick={addCriterion}
                >
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Condition
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Live Preview */}
        <div className="flex-1 flex flex-col overflow-hidden bg-muted/20">
          <div className="px-5 py-4 border-b bg-card">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">Live Preview</h2>
                {isPreviewing && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
              </div>
              {preview && (
                <div className="flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-indigo-600" />
                  <span className="text-sm font-bold text-indigo-600">{preview.total}</span>
                  <span className="text-xs text-muted-foreground">contacts match</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {previewError ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <div className="w-8 h-8 mb-3 rounded-full bg-red-100 flex items-center justify-center">
                  <X className="w-4 h-4 text-red-500" />
                </div>
                <p className="text-sm text-red-600 font-medium text-center px-4">{previewError}</p>
                <button onClick={runPreview} className="mt-2 text-xs text-indigo-600 hover:underline">
                  Retry
                </button>
              </div>
            ) : !preview ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <RefreshCw className="w-8 h-8 mb-3 opacity-30" />
                <p className="text-sm">Add conditions to see a preview</p>
                <button onClick={runPreview} className="mt-2 text-xs text-indigo-600 hover:underline">
                  Run preview now
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Stats cards */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-card border rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-indigo-600">{preview.total}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Total Contacts</p>
                  </div>
                  <div className="bg-card border rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-foreground">{preview.topCompanies.length}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Companies</p>
                  </div>
                  <div className="bg-card border rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-foreground">
                      {preview.contacts.length > 0
                        ? Math.round(preview.contacts.reduce((s, c) => s + c.lead_score, 0) / preview.contacts.length)
                        : 0}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">Avg Score</p>
                  </div>
                </div>

                {/* Score distribution chart */}
                {chartData.length > 0 && (
                  <div className="bg-card border rounded-lg p-3">
                    <p className="text-xs font-semibold text-muted-foreground mb-3">Score Distribution by Tier</p>
                    <ResponsiveContainer width="100%" height={120}>
                      <BarChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                        <XAxis dataKey="tier" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        <Tooltip
                          contentStyle={{ fontSize: 11, padding: "4px 8px" }}
                          formatter={(v: number) => [v, "Contacts"]}
                        />
                        <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                          {chartData.map((entry, i) => (
                            <Cell key={i} fill={entry.fill} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Top companies */}
                {preview.topCompanies.length > 0 && (
                  <div className="bg-card border rounded-lg p-3">
                    <p className="text-xs font-semibold text-muted-foreground mb-2">Top Companies</p>
                    {preview.topCompanies.map(co => (
                      <div key={co.name} className="flex items-center justify-between py-1 text-xs">
                        <div className="flex items-center gap-1.5">
                          <Building2 className="w-3 h-3 text-muted-foreground" />
                          <span className="text-foreground">{co.name}</span>
                        </div>
                        <span className="text-muted-foreground">{co.contact_count} contacts</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Sample contacts */}
                {preview.contacts.length > 0 && (
                  <div className="bg-card border rounded-lg overflow-hidden">
                    <div className="px-3 py-2 border-b bg-muted/30">
                      <p className="text-xs font-semibold text-muted-foreground">
                        Sample Contacts (showing {Math.min(preview.contacts.length, 20)} of {preview.total})
                      </p>
                    </div>
                    <div className="divide-y">
                      {preview.contacts.map(c => (
                        <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                          <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                            <span className="text-[10px] font-bold text-indigo-700">
                              {c.first_name?.[0] ?? "?"}{c.last_name?.[0] ?? ""}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-foreground truncate">
                              {c.first_name} {c.last_name}
                            </p>
                            <p className="text-[11px] text-muted-foreground truncate">{c.email}</p>
                          </div>
                          {c.company_name && (
                            <span className="text-[11px] text-muted-foreground hidden sm:block">{c.company_name}</span>
                          )}
                          <span className="text-xs font-semibold text-indigo-600">{c.lead_score}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Assign-to-Journey Dialog */}
      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Assign Segment to Journey</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-4">
            <p className="text-sm text-muted-foreground">
              Segment saved. Pick a journey to attach it to.
            </p>

            {/* Assignment mode toggle */}
            <div>
              <p className="text-xs font-medium text-foreground mb-1.5">Assignment mode</p>
              <div className="flex gap-2">
                {(["live", "snapshot"] as const).map(mode => (
                  <button
                    key={mode}
                    onClick={() => setAssignMode(mode)}
                    className={cn(
                      "flex-1 py-1.5 px-2 rounded-lg border text-xs font-medium transition-all",
                      assignMode === mode
                        ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                        : "bg-card border-border text-muted-foreground hover:border-muted-foreground"
                    )}
                  >
                    {mode === "live" ? "Dynamic (live sync)" : "Static (snapshot)"}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                {assignMode === "live"
                  ? "Contacts update automatically when segment criteria are re-evaluated."
                  : "Contacts are fixed at the time of assignment — no future syncs."}
              </p>
            </div>

            {/* Journey list */}
            <div className="space-y-1.5 max-h-52 overflow-y-auto">
              {journeys.map(j => (
                <button
                  key={j.id}
                  onClick={() => setSelectedJourneyId(j.id)}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors text-sm",
                    selectedJourneyId === j.id
                      ? "bg-indigo-50 border-indigo-400 text-indigo-800"
                      : "bg-card border-border hover:border-muted-foreground"
                  )}
                >
                  <BookOpen className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 font-medium truncate">{j.name}</span>
                  <Badge variant="secondary" className="text-[10px]">{j.status}</Badge>
                  {selectedJourneyId === j.id && <CheckCircle2 className="w-4 h-4 text-indigo-600 shrink-0" />}
                </button>
              ))}
              {journeys.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">No journeys found</p>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => { setAssignDialogOpen(false); navigate("/database/segments"); }}>
              Skip
            </Button>
            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!selectedJourneyId || isAssigning}
              onClick={handleAssign}
            >
              {isAssigning && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Assign to Journey
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RunWizard
        open={runWizardOpen}
        onClose={() => setRunWizardOpen(false)}
        initialSegmentId={isEdit && id ? Number(id) : savedSegmentId ?? undefined}
      />
    </div>
  );
}
