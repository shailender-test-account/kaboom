import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft, Phone, Play, Users, Save, Plus, Trash2, Loader2,
  CheckCircle2, AlertCircle, PhoneCall, Clock, Mic, Target,
  FileText, Settings2, ChevronRight, Sparkles, ChevronDown, ExternalLink,
  BarChart2, ThumbsUp, ThumbsDown, TrendingUp,
  Layers, Zap, Timer, Pause, RefreshCw,
  PhoneMissed, PhoneOff, RotateCcw, Filter, CheckSquare,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });
const json = (path: string, method: string, body: unknown) =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ── AssistantPicker ────────────────────────────────────────────────────────────
// Dropdown of saved assistants from Settings → Integrations → Vapi, with a
// "Custom ID" fallback for pasting a raw assistant ID.
function AssistantPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data: vapiCfg } = useQuery<{ assistants: { name: string; id: string }[] }>({
    queryKey: ["integration", "vapi"],
    queryFn:  () => api("/integrations/vapi").then(r => r.json()),
    staleTime: 30_000,
  });
  const assistants = vapiCfg?.assistants ?? [];

  // Determine select value: known id, "custom", or ""
  const isKnown  = assistants.some(a => a.id === value);
  const selectVal = value === "" ? "" : isKnown ? value : "custom";
  const [customId, setCustomId] = useState(selectVal === "custom" ? value : "");

  const handleSelect = (v: string) => {
    if (v === "custom") {
      onChange(customId);
    } else {
      setCustomId("");
      onChange(v);
    }
  };

  const handleCustomChange = (v: string) => {
    setCustomId(v);
    onChange(v);
  };

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 space-y-2">
      <Label className="text-xs font-semibold text-indigo-700">Assistant (use your pre-built assistant)</Label>
      <select
        className="w-full h-8 px-2 text-sm border rounded bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400 mt-1.5"
        value={selectVal}
        onChange={e => handleSelect(e.target.value)}
      >
        <option value="">— No assistant (use inline script below) —</option>
        {assistants.map(a => (
          <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
        ))}
        <option value="custom">Custom ID…</option>
      </select>
      {selectVal === "custom" && (
        <Input
          className="h-8 text-sm font-mono mt-1.5"
          placeholder="Paste assistant ID, e.g. asst_abc123…"
          value={customId}
          onChange={e => handleCustomChange(e.target.value)}
        />
      )}
      {assistants.length === 0 && (
        <p className="text-[11px] text-indigo-500/80">
          No assistants saved yet — add them in <strong>Settings → Integrations → Vapi</strong>.
        </p>
      )}
      {value && (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
          Using pre-built assistant — inline script fields below are inactive
        </div>
      )}
    </div>
  );
}

const OUTCOME_BADGE: Record<string, string> = {
  interested:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  callback:      "bg-blue-50 text-blue-700 border-blue-200",
  answered:      "bg-violet-50 text-violet-700 border-violet-200",
  no_answer:     "bg-gray-50 text-gray-600 border-gray-200",
  not_interested:"bg-red-50 text-red-600 border-red-200",
  dnc:           "bg-orange-50 text-orange-700 border-orange-200",
  busy:          "bg-orange-50 text-orange-700 border-orange-200",
  failed:        "bg-red-50 text-red-600 border-red-200",
  voicemail:     "bg-slate-50 text-slate-600 border-slate-200",
};

type FollowUpStatus = { label: string; cls: string };

function getFollowUpStatus(log: any): FollowUpStatus | null {
  const outcome  = (log.outcome ?? log.status ?? "").toLowerCase().replace(/-/g, "_");
  const duration = Number(log.duration_seconds ?? 0);
  const ra       = (log.recommended_action ?? "").toLowerCase().replace(/[_\s-]/g, "");

  if (outcome === "failed")    return { label: "Failed",    cls: "bg-red-50 text-red-600 border-red-200" };
  if (outcome === "busy")      return { label: "Busy",      cls: "bg-orange-50 text-orange-700 border-orange-200" };
  if (outcome === "voicemail") return { label: "Voicemail", cls: "bg-slate-50 text-slate-600 border-slate-200" };
  if (outcome === "no_answer") return { label: "No Answer", cls: "bg-gray-50 text-gray-600 border-gray-200" };

  if (outcome === "callback" || ra.includes("callback") || ra.includes("callback"))
    return { label: "Call Back", cls: "bg-blue-50 text-blue-700 border-blue-200" };

  if (["answered", "interested"].includes(outcome) && duration > 0 && duration < 30)
    return { label: "Incomplete", cls: "bg-amber-50 text-amber-700 border-amber-200" };

  if (ra && !["", "none", "noaction"].includes(ra) && !["not_interested", "dnc"].includes(outcome)) {
    if (ra.includes("followup") || ra.includes("nurture") || ra.includes("email") || ra.includes("followup"))
      return { label: "Follow Up", cls: "bg-indigo-50 text-indigo-700 border-indigo-200" };
  }

  return null;
}

// Which logs need re-calling?
function needsFollowUp(log: any): boolean {
  const outcome = (log.outcome ?? log.status ?? "").toLowerCase().replace(/-/g, "_");
  const ra      = (log.recommended_action ?? "").toLowerCase().replace(/[_\s-]/g, "");
  const dur     = Number(log.duration_seconds ?? 0);
  if (["failed","busy","voicemail","no_answer","callback"].includes(outcome)) return true;
  if (outcome === "callback" || ra.includes("callback")) return true;
  if (["answered","interested"].includes(outcome) && dur > 0 && dur < 30) return true;
  return false;
}

const STATUS_BADGE: Record<string, string> = {
  draft:     "bg-gray-100 text-gray-600 border-gray-200",
  active:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  paused:    "bg-amber-50 text-amber-700 border-amber-200",
  completed: "bg-blue-50 text-blue-700 border-blue-200",
  pending:   "bg-gray-50 text-gray-500 border-gray-200",
  calling:   "bg-violet-50 text-violet-700 border-violet-200",
  done:      "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed:    "bg-red-50 text-red-600 border-red-200",
  blocked:   "bg-amber-50 text-amber-700 border-amber-200",
  queued:    "bg-gray-50 text-gray-500 border-gray-200",
};

const WAVE_STATUS_BADGE: Record<string, string> = {
  pending:   "bg-gray-50 text-gray-600 border-gray-200",
  scheduled: "bg-blue-50 text-blue-700 border-blue-200",
  active:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  paused:    "bg-amber-50 text-amber-700 border-amber-200",
  completed: "bg-violet-50 text-violet-700 border-violet-200",
  cancelled: "bg-red-50 text-red-600 border-red-200",
};

interface Props { id: string }

export default function CallCampaignDetailPage({ id }: Props) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const campaignId = parseInt(id);
  const [tab, setTab] = useState("contacts");
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [addMode, setAddMode] = useState<"browse" | "segment">("browse");
  const [contactSearch, setContactSearch] = useState("");
  const [minScore, setMinScore] = useState<number | null>(null);
  const [filterTag, setFilterTag] = useState("");
  const [filterPlayId, setFilterPlayId] = useState<number | null>(null);
  const [filterCompanyId, setFilterCompanyId] = useState<number | null>(null);
  const [filterSegmentId, setFilterSegmentId] = useState<number | null>(null);
  const [segSearch, setSegSearch] = useState("");
  const [segCity, setSegCity] = useState("");
  const [segSize, setSegSize] = useState("");
  const [segFunction, setSegFunction] = useState("");
  const [segIndustry, setSegIndustry] = useState("");
  const [segStage, setSegStage] = useState("");
  const [segMinScore, setSegMinScore] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [removeContactId, setRemoveContactId] = useState<number | null>(null);
  const [startConfirm, setStartConfirm] = useState(false);
  const [selectedLog, setSelectedLog] = useState<any | null>(null);
  const [aiInsights, setAiInsights] = useState<{ aiSummary: string; aiNextSteps: string } | null>(null);
  const [logFilter, setLogFilter] = useState<"all" | "callback" | "incomplete" | "followup">("all");
  const [selectedLogContactIds, setSelectedLogContactIds] = useState<Set<number>>(new Set());
  const [reEnrollOpen, setReEnrollOpen] = useState(false);

  // Campaign data
  const { data: campaign, isLoading } = useQuery<any>({
    queryKey: ["call-campaign", campaignId],
    queryFn: () => api(`/call-campaigns/${campaignId}`).then(r => r.json()),
    refetchInterval: 10000,
  });

  // Agent config local state
  const [agentCfg, setAgentCfg] = useState<any>(null);
  const resolvedCfg = agentCfg ?? (campaign?.agent_config ?? {});
  const [pitchTemplateId, setPitchTemplateId] = useState<number | null>(null);
  const resolvedTemplateId = pitchTemplateId ?? (campaign?.pitch_template_id ?? null);

  // Pitch templates for picker
  const { data: pitchTemplates = [] } = useQuery<any[]>({
    queryKey: ["pitch-templates"],
    queryFn: () => api("/pitch-templates").then(r => r.json()),
  });

  // Contacts in campaign
  const { data: contacts = [] } = useQuery<any[]>({
    queryKey: ["call-campaign-contacts", campaignId],
    queryFn: () => api(`/call-campaigns/${campaignId}/contacts`).then(r => r.json()),
    refetchInterval: 10000,
  });

  // DNC list — to show badge on contacts tab
  const { data: dncList = [] } = useQuery<any[]>({
    queryKey: ["dnc-list"],
    queryFn: () => api("/call-campaigns/dnc").then(r => r.json()),
  });
  const dncContactIds = new Set<number>(dncList.map((d: any) => d.contact_id));

  // CRM contacts for picker (with score + search + tag + play + company filters)
  const { data: crmContacts = [] } = useQuery<any[]>({
    queryKey: ["contacts-pick", contactSearch, minScore, filterTag, filterPlayId, filterCompanyId],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "50" });
      if (contactSearch) params.set("search", contactSearch);
      if (minScore !== null) params.set("scoreMin", String(minScore));
      if (filterTag) params.set("tag", filterTag);
      if (filterPlayId !== null) params.set("playId", String(filterPlayId));
      if (filterCompanyId !== null) params.set("clientId", String(filterCompanyId));
      return api(`/contacts?${params}`).then(r => r.json());
    },
    enabled: addContactOpen,
  });

  // Lists for filter dropdowns
  const { data: availableTags = [] } = useQuery<string[]>({
    queryKey: ["contact-tags"],
    queryFn: () => api("/contacts/tags").then(r => r.json()),
    enabled: addContactOpen,
  });
  const { data: availablePlays = [] } = useQuery<any[]>({
    queryKey: ["plays-list"],
    queryFn: () => api("/plays").then(r => r.json()),
    enabled: addContactOpen,
  });
  const { data: availableCompanies = [] } = useQuery<any[]>({
    queryKey: ["companies-list"],
    queryFn: () => api("/companies").then(r => r.json()),
    enabled: addContactOpen,
  });
  const { data: availableSegments = [], isLoading: segmentsLoading } = useQuery<{ id: number; name: string; last_computed_count: number | null }[]>({
    queryKey: ["segments-list"],
    queryFn: () => api("/segments").then(r => r.json()),
    enabled: addContactOpen,
    staleTime: 0,
  });
  const { data: segmentContactsRaw, isLoading: segmentLoading } = useQuery<{ contacts: any[]; total: number }>({
    queryKey: ["segment-contacts-picker", filterSegmentId],
    queryFn: () => api(`/segments/${filterSegmentId}/contacts?limit=1000&page=1`).then(r => r.json()),
    enabled: addMode === "segment" && filterSegmentId !== null,
  });
  const segmentContacts: any[] = segmentContactsRaw?.contacts ?? [];

  // Unique values for segment filter dropdowns (derived from loaded contacts)
  const segCityOptions   = [...new Set(segmentContacts.map(c => c.city).filter(Boolean))].sort() as string[];
  const segSizeOptions   = [...new Set(segmentContacts.map(c => c.employee_size || c.company_size).filter(Boolean))].sort() as string[];
  const segFuncOptions   = [...new Set(segmentContacts.map(c => c.function).filter(Boolean))].sort() as string[];
  const segIndOptions    = [...new Set(segmentContacts.map(c => c.industry).filter(Boolean))].sort() as string[];
  const segStageOptions  = [...new Set(segmentContacts.map(c => c.stage).filter(Boolean))].sort() as string[];

  const filteredSegContacts = segmentContacts.filter(c => {
    const q = segSearch.toLowerCase();
    if (q && !`${c.first_name} ${c.last_name} ${c.email}`.toLowerCase().includes(q)) return false;
    if (segCity     && (c.city ?? "") !== segCity)                           return false;
    if (segSize     && (c.employee_size || c.company_size || "") !== segSize) return false;
    if (segFunction && (c.function ?? "") !== segFunction)                   return false;
    if (segIndustry && (c.industry ?? "") !== segIndustry)                   return false;
    if (segStage    && (c.stage ?? "") !== segStage)                         return false;
    if (segMinScore !== null && (c.lead_score ?? 0) < segMinScore)           return false;
    return true;
  });

  function resetSegFilters() {
    setSegSearch(""); setSegCity(""); setSegSize(""); setSegFunction("");
    setSegIndustry(""); setSegStage(""); setSegMinScore(null);
  }

  // Call logs
  const { data: callLogs = [] } = useQuery<any[]>({
    queryKey: ["call-logs", campaignId],
    queryFn: () => api(`/call-campaigns/${campaignId}/logs`).then(r => r.json()),
    enabled: tab === "logs",
    refetchInterval: 15000,
  });

  // Campaign analytics
  const { data: analytics } = useQuery<{
    summary: { totalCalls: number; answeredCalls: number; answerRate: number; avgDurationSeconds: number; positiveCount: number; negativeCount: number; positiveRate: number };
    byDayOfWeek: Array<{ dow: number; dayLabel: string; totalCalls: number; answered: number; answerRate: number; avgDurationSeconds: number; positiveCount: number; negativeCount: number }>;
    byHourOfDay: Array<{ hour: number; totalCalls: number; answered: number; answerRate: number; avgDurationSeconds: number; positiveCount: number; negativeCount: number }>;
  }>({
    queryKey: ["call-campaign-analytics", campaignId],
    queryFn: () => api(`/call-campaigns/${campaignId}/analytics`).then(r => r.json()),
    enabled: tab === "analytics",
  });

  const saveCfg = useMutation({
    mutationFn: () => json(`/call-campaigns/${campaignId}`, "PATCH", {
      name: campaign?.name,
      agentConfig: resolvedCfg,
      ...(resolvedTemplateId !== (campaign?.pitch_template_id ?? null) ? { pitchTemplateId: resolvedTemplateId } : {}),
    }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["call-campaign", campaignId] });
      toast({ title: "Agent configuration saved" });
      setAgentCfg(null);
      setPitchTemplateId(null);
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });

  const addContacts = useMutation({
    mutationFn: (ids: number[]) => json(`/call-campaigns/${campaignId}/contacts`, "POST", { contactIds: ids }).then(r => r.json()),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["call-campaign-contacts", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-campaign", campaignId] });
      toast({ title: `Added ${d.added} contact${d.added !== 1 ? "s" : ""}` });
    },
    onError: () => toast({ title: "Failed to add contacts", variant: "destructive" }),
  });

  const removeContact = useMutation({
    mutationFn: (cid: number) => api(`/call-campaigns/${campaignId}/contacts/${cid}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["call-campaign-contacts", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-campaign", campaignId] });
      setRemoveContactId(null);
    },
    onError: () => toast({ title: "Failed to remove", variant: "destructive" }),
  });

  const startCampaign = useMutation({
    mutationFn: () => json(`/call-campaigns/${campaignId}/start`, "POST", {}).then(r => r.json()),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["call-campaign", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-campaign-contacts", campaignId] });
      setStartConfirm(false);
      toast({ title: d.message ?? "Campaign started!" });
    },
    onError: () => toast({ title: "Failed to start campaign", variant: "destructive" }),
  });

  const pauseCampaign = useMutation({
    mutationFn: () => json(`/call-campaigns/${campaignId}`, "PATCH", { name: campaign?.name, status: "paused" }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["call-campaign", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-campaign-waves", campaignId] });
      toast({ title: "Campaign paused — no further calls will be placed until resumed." });
    },
    onError: () => toast({ title: "Failed to pause campaign", variant: "destructive" }),
  });

  const resumeCampaign = useMutation({
    mutationFn: () => json(`/call-campaigns/${campaignId}`, "PATCH", { name: campaign?.name, status: "active" }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["call-campaign", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-campaign-waves", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-campaign-contacts", campaignId] });
      toast({ title: "Campaign resumed." });
    },
    onError: () => toast({ title: "Failed to resume campaign", variant: "destructive" }),
  });

  const summarize = useMutation({
    mutationFn: (logId: number) =>
      api(`/call-campaigns/${campaignId}/logs/${logId}/summarize`, { method: "POST" }).then(r => r.json()),
    onSuccess: (d) => setAiInsights(d),
    onError: () => toast({ title: "AI summarization failed", variant: "destructive" }),
  });

  const reEnrollMut = useMutation({
    mutationFn: (contactIds: number[]) =>
      json(`/call-campaigns/${campaignId}/contacts/re-enroll`, "POST", { contactIds }).then(r => r.json()),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["call-campaign-contacts", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-logs", campaignId] });
      setSelectedLogContactIds(new Set());
      setReEnrollOpen(false);
      toast({
        title: `${d.reEnrolled} contact${d.reEnrolled !== 1 ? "s" : ""} re-enrolled`,
        description: "They're queued as pending. Start the campaign to call them now.",
        action: (
          <ToastAction
            altText="Start calling now"
            onClick={() => startCampaign.mutate()}
          >
            Start calling now →
          </ToastAction>
        ),
      });
    },
    onError: () => toast({ title: "Re-enroll failed", variant: "destructive" }),
  });

  // Waves
  const { data: waves = [], refetch: refetchWaves } = useQuery<any[]>({
    queryKey: ["call-campaign-waves", campaignId],
    queryFn: () => api(`/call-campaigns/${campaignId}/waves`).then(r => r.json()),
    enabled: tab === "waves",
    refetchInterval: (query) => {
      if (tab !== "waves") return false;
      const data = query.state.data as any[] | undefined;
      if (data?.some((w: any) => w.status === "active")) return 5_000;
      return 30_000;
    },
  });

  const hasActiveWave = waves.some((w: any) => w.status === "active");

  const startWaveMut = useMutation({
    mutationFn: (waveId: number) => json(`/call-campaigns/${campaignId}/waves/${waveId}/start`, "POST", {}).then(r => r.json()),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["call-campaign-waves", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-campaign", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-campaign-contacts", campaignId] });
      toast({ title: d.message ?? "Wave started" });
    },
    onError: () => toast({ title: "Failed to start wave", variant: "destructive" }),
  });

  const pauseWaveMut = useMutation({
    mutationFn: (waveId: number) => json(`/call-campaigns/${campaignId}/waves/${waveId}/pause`, "POST", {}).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["call-campaign-waves", campaignId] });
      toast({ title: "Wave paused" });
    },
    onError: () => toast({ title: "Failed to pause wave", variant: "destructive" }),
  });

  const resumeWaveMut = useMutation({
    mutationFn: (waveId: number) => json(`/call-campaigns/${campaignId}/waves/${waveId}/resume`, "POST", {}).then(r => r.json()),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["call-campaign-waves", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-campaign", campaignId] });
      qc.invalidateQueries({ queryKey: ["call-campaign-contacts", campaignId] });
      toast({ title: d.message ?? "Wave resumed" });
    },
    onError: () => toast({ title: "Failed to resume wave", variant: "destructive" }),
  });

  // Inline wave-settings editing
  const [editBatchSize, setEditBatchSize] = useState<number | null>(null);
  const [editGapMinutes, setEditGapMinutes] = useState<number | null>(null);

  const saveWaveSettings = useMutation({
    mutationFn: (data: { batchSize: number; waveGapMinutes: number }) =>
      json(`/call-campaigns/${campaignId}`, "PATCH", data).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["call-campaign", campaignId] });
      setEditBatchSize(null);
      setEditGapMinutes(null);
      toast({ title: "Wave settings saved" });
    },
    onError: () => toast({ title: "Failed to save wave settings", variant: "destructive" }),
  });

  const enrolledIds = new Set(contacts.map((c: any) => c.contact_id));

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading campaign…
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Campaign not found.</p>
        <Button variant="ghost" size="sm" onClick={() => navigate("/calls")} className="mt-2">← Back</Button>
      </div>
    );
  }

  const total   = Number(campaign.total_contacts   ?? 0);
  const done    = Number(campaign.done_contacts    ?? 0);
  const calling = Number(campaign.calling_contacts ?? 0);
  const failed  = Number(campaign.failed_contacts  ?? 0);
  const pending = total - done - calling - failed;
  const pct     = total > 0 ? Math.round((done / total) * 100) : 0;

  const isRetell = campaign.provider === "retell";
  const hasTemplate = isRetell || !!(campaign.pitch_template_id ?? resolvedTemplateId);
  const canStart = campaign.status !== "completed" && total > 0 && pending > 0 && hasTemplate;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Back + header */}
      <div>
        <button
          onClick={() => navigate("/calls")}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> All campaigns
        </button>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">{campaign.name}</h1>
              <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", STATUS_BADGE[campaign.status] ?? STATUS_BADGE.draft)}>
                {campaign.status}
              </Badge>
              {calling > 0 && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-violet-50 text-violet-700 border-violet-200 animate-pulse">
                  {calling} calling now
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Created {formatDistanceToNow(new Date(campaign.created_at), { addSuffix: true })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {agentCfg && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={() => setAgentCfg(null)}
              >
                Discard
              </Button>
            )}
            {agentCfg && (
              <Button
                size="sm"
                className="h-7 text-xs gap-1 bg-indigo-600 hover:bg-indigo-700"
                onClick={() => saveCfg.mutate()}
                disabled={saveCfg.isPending}
              >
                {saveCfg.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Save
              </Button>
            )}
            {campaign.status === "active" && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1 border-amber-300 text-amber-700 hover:bg-amber-50"
                onClick={() => pauseCampaign.mutate()}
                disabled={pauseCampaign.isPending}
              >
                {pauseCampaign.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />}
                Pause Campaign
              </Button>
            )}
            {campaign.status === "paused" && (
              <Button
                size="sm"
                className="h-7 text-xs gap-1 bg-indigo-600 hover:bg-indigo-700"
                onClick={() => resumeCampaign.mutate()}
                disabled={resumeCampaign.isPending}
              >
                {resumeCampaign.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Resume Campaign
              </Button>
            )}
            {(canStart || (!hasTemplate && total > 0 && pending > 0)) && (
              <Button
                size="sm"
                className="h-7 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50"
                disabled={!hasTemplate}
                title={!hasTemplate ? "Select a pitch template in Agent Script tab before starting" : undefined}
                onClick={() => hasTemplate && setStartConfirm(true)}
              >
                <Play className="w-3 h-3" />
                {campaign.status === "active" ? `Dial ${pending} Pending` : "Start Campaign"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Users className="w-3 h-3" />{total} total</span>
            <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3 h-3" />{done} done ({pct}%)</span>
            {calling > 0 && <span className="flex items-center gap-1 text-violet-600"><PhoneCall className="w-3 h-3" />{calling} active</span>}
            {failed > 0 && <span className="flex items-center gap-1 text-destructive"><AlertCircle className="w-3 h-3" />{failed} failed</span>}
            {pending > 0 && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{pending} pending</span>}
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-8">
          <TabsTrigger value="contacts" className="text-xs"><Users className="w-3 h-3 mr-1" />Contacts ({total})</TabsTrigger>
          <TabsTrigger value="waves" className="text-xs"><Layers className="w-3 h-3 mr-1" />Waves</TabsTrigger>
          <TabsTrigger value="script" className="text-xs"><Mic className="w-3 h-3 mr-1" />Agent Script</TabsTrigger>
          <TabsTrigger value="logs" className="text-xs"><FileText className="w-3 h-3 mr-1" />Call Logs</TabsTrigger>
          <TabsTrigger value="analytics" className="text-xs"><BarChart2 className="w-3 h-3 mr-1" />Analytics</TabsTrigger>
        </TabsList>

        {/* ── Contacts tab ──────────────────────────────────────────────── */}
        <TabsContent value="contacts" className="mt-4 space-y-3">

          {/* No-template warning — blocks calling */}
          {!hasTemplate && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5">
              <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-amber-800">No pitch template selected</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Go to the <button className="underline font-medium" onClick={() => setTab("script")}>Agent Script</button> tab, choose a pitch template, and click <strong>Save</strong> before running this campaign.
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">{total} contact{total !== 1 ? "s" : ""} enrolled</p>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setAddContactOpen(true)}>
              <Plus className="w-3 h-3" /> Add Contacts
            </Button>
          </div>

          {contacts.length === 0 ? (
            <Card>
              <CardContent className="py-12 flex flex-col items-center gap-3">
                <Users className="w-8 h-8 text-muted-foreground/30" />
                <p className="text-sm font-medium">No contacts added yet</p>
                <p className="text-xs text-muted-foreground">Add contacts from your CRM to enroll them in this call campaign.</p>
                <Button size="sm" variant="outline" className="mt-1 gap-1" onClick={() => setAddContactOpen(true)}>
                  <Plus className="w-3.5 h-3.5" /> Add contacts
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="border rounded-lg overflow-hidden bg-card">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Contact</th>
                    <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Company</th>
                    <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Phone</th>
                    <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Status</th>
                    <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Source</th>
                    <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Outcome</th>
                    <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">AI Status</th>
                    <th className="py-2 px-3 w-10" />
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c: any) => {
                    const fus = getFollowUpStatus(c);
                    return (
                    <tr key={c.id} className="border-b last:border-0 group hover:bg-muted/20">
                      <td className="py-2.5 px-3">
                        <p className="text-sm font-medium">{c.first_name} {c.last_name}</p>
                        <p className="text-xs text-muted-foreground">{c.email}</p>
                      </td>
                      <td className="py-2.5 px-3 text-xs text-muted-foreground">{c.company_name ?? "—"}</td>
                      <td className="py-2.5 px-3 text-xs font-mono text-muted-foreground">
                        {c.phone ?? <span className="text-destructive/60">No phone</span>}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex flex-col gap-0.5">
                          {dncContactIds.has(c.contact_id) && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5 self-start bg-red-50 text-red-600 border-red-200 font-semibold">
                              DNC
                            </Badge>
                          )}
                          <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5 self-start", STATUS_BADGE[c.status] ?? STATUS_BADGE.pending)}>
                            {c.status}
                          </Badge>
                          {(c.status === "failed" || c.status === "blocked") && c.failure_reason && (
                            <p className={cn(
                              "text-[10px] leading-tight max-w-[180px]",
                              c.status === "blocked" ? "text-amber-700" : "text-destructive"
                            )} title={c.failure_reason}>
                              {c.failure_reason.length > 60 ? c.failure_reason.slice(0, 57) + "…" : c.failure_reason}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5",
                          c.provider === "retell" ? "bg-teal-50 text-teal-700 border-teal-200"
                          : "bg-gray-50 text-gray-600 border-gray-200"
                        )}>
                          {c.provider === "retell" ? "RetellAI" : "Vapi"}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-3">
                        {c.outcome ? (
                          <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", OUTCOME_BADGE[c.outcome] ?? "")}>
                            {c.outcome.replace(/_/g, " ")}
                          </Badge>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="py-2.5 px-3">
                        {fus ? (
                          <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5 font-semibold", fus.cls)}>
                            {fus.label}
                          </Badge>
                        ) : c.sentiment ? (
                          <Badge variant="outline" className={cn(
                            "text-[10px] h-4 px-1.5",
                            c.sentiment === "positive" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : c.sentiment === "negative" ? "bg-red-50 text-red-600 border-red-200"
                            : "bg-gray-50 text-gray-600 border-gray-200"
                          )}>
                            {c.sentiment}
                          </Badge>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="py-2.5 px-3">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                          onClick={() => setRemoveContactId(c.contact_id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </td>
                    </tr>
                  );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* ── Waves tab ─────────────────────────────────────────────────── */}
        <TabsContent value="waves" className="mt-4 space-y-3">
          {/* Config summary — editable */}
          <div className="flex items-center gap-3 flex-wrap bg-muted/40 rounded-lg px-3 py-2">
            <div className="flex items-center gap-1.5 text-xs">
              <Layers className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Batch size:</span>
              {editBatchSize !== null ? (
                <Input
                  type="number" min={1} max={50}
                  value={editBatchSize}
                  onChange={e => setEditBatchSize(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                  className="h-6 w-14 text-xs"
                />
              ) : (
                <strong className="text-foreground">{campaign?.batch_size ?? 3}</strong>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <Timer className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Gap:</span>
              {editGapMinutes !== null ? (
                <Input
                  type="number" min={1} max={1440}
                  value={editGapMinutes}
                  onChange={e => setEditGapMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                  className="h-6 w-16 text-xs"
                />
              ) : (
                <strong className="text-foreground">{campaign?.wave_gap_minutes ?? 6} min</strong>
              )}
            </div>
            {editBatchSize !== null || editGapMinutes !== null ? (
              <div className="flex flex-col gap-2 w-full">
                {waves.length > 0 && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 w-full">
                    <AlertCircle className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                    <span>Existing scheduled waves use the old gap. New contacts enrolled after saving will use the updated values on next start.</span>
                  </div>
                )}
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    className="h-6 text-xs bg-indigo-600 hover:bg-indigo-700"
                    onClick={() => saveWaveSettings.mutate({
                      batchSize: editBatchSize ?? (campaign?.batch_size ?? 3),
                      waveGapMinutes: editGapMinutes ?? (campaign?.wave_gap_minutes ?? 6),
                    })}
                    disabled={saveWaveSettings.isPending}
                  >
                    {saveWaveSettings.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { setEditBatchSize(null); setEditGapMinutes(null); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {waves.length > 0 && (
                  <span className="text-xs text-muted-foreground">{waves.length} wave{waves.length !== 1 ? "s" : ""} total</span>
                )}
                <Button
                  size="sm" variant="ghost"
                  className="h-6 text-xs gap-1 ml-auto"
                  onClick={() => { setEditBatchSize(campaign?.batch_size ?? 3); setEditGapMinutes(campaign?.wave_gap_minutes ?? 6); }}
                >
                  <Settings2 className="w-3 h-3" /> Edit settings
                </Button>
              </>
            )}
          </div>

          {waves.length === 0 ? (
            <Card>
              <CardContent className="py-12 flex flex-col items-center gap-3">
                <Layers className="w-8 h-8 text-muted-foreground/30" />
                <p className="text-sm font-medium">No waves yet</p>
                <p className="text-xs text-muted-foreground text-center max-w-xs">
                  Waves are created automatically when you start the campaign. Each wave dials{" "}
                  <strong>{campaign?.batch_size ?? 3}</strong> contacts, with a{" "}
                  <strong>{campaign?.wave_gap_minutes ?? 6}-min</strong> gap between waves.
                </p>
                {total > 0 && pending > 0 && hasTemplate && (
                  <p className="text-xs text-indigo-600 font-medium">
                    {pending} pending → {Math.ceil(pending / (campaign?.batch_size ?? 3))} wave{Math.ceil(pending / (campaign?.batch_size ?? 3)) !== 1 ? "s" : ""}
                  </p>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="border rounded-lg overflow-hidden bg-card">
                <table className="w-full">
                  <thead>
                    <tr className="bg-muted/50 border-b">
                      <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Wave</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Contacts</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Status</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">When</th>
                      <th className="py-2 px-3 w-28 text-right text-xs font-medium text-muted-foreground">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {waves.map((wave: any) => {
                      const done = Number(wave.done_count ?? 0);
                      const pending = Number(wave.pending_count ?? 0);
                      const failed = Number(wave.failed_count ?? 0);
                      const total = Number(wave.contact_count ?? 0);
                      const settled = done + failed;
                      const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
                      const isActive = wave.status === "active";
                      return (
                      <tr key={wave.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="py-2.5 px-3">
                          <span className="text-sm font-semibold">Wave {wave.wave_number}</span>
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="text-xs space-x-1">
                            <span className="font-medium">{total}</span>
                            <span className="text-muted-foreground">total</span>
                            {done > 0 && <span className="text-emerald-600">· {done} done</span>}
                            {pending > 0 && <span className="text-muted-foreground">· {pending} pending</span>}
                            {failed > 0 && <span className="text-destructive">· {failed} failed</span>}
                          </div>
                          {isActive && total > 0 && (
                            <div className="mt-1.5 space-y-0.5">
                              <Progress value={progressPct} className="h-1.5 w-32" />
                              <p className="text-[10px] text-muted-foreground">
                                {settled} / {total} calls completed
                              </p>
                              {(() => {
                                const callingNames: string[] = wave.calling_contact_names ?? [];
                                const callingCount = Number(wave.calling_count ?? 0);
                                if (callingCount === 0) return null;
                                const firstName = callingNames[0] || "Unknown";
                                return (
                                  <p className="text-[10px] text-violet-600 font-medium flex items-center gap-1">
                                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse flex-shrink-0" />
                                    {callingCount === 1
                                      ? `Now dialing: ${firstName}`
                                      : `Now dialing: ${firstName} +${callingCount - 1} more`}
                                  </p>
                                );
                              })()}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-1">
                            <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", WAVE_STATUS_BADGE[wave.status] ?? "")}>
                              {wave.status}
                            </Badge>
                            {isActive && (
                              <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-violet-50 text-violet-700 border-violet-200 animate-pulse">
                                live
                              </Badge>
                            )}
                            {isActive && total > 0 && (
                              <span className="text-[10px] text-muted-foreground font-medium">
                                {settled}/{total}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-xs text-muted-foreground">
                          {wave.started_at
                            ? <span>Started {formatDistanceToNow(new Date(wave.started_at), { addSuffix: true })}</span>
                            : wave.scheduled_at
                              ? new Date(wave.scheduled_at) > new Date()
                                ? <span>in {formatDistanceToNow(new Date(wave.scheduled_at))}</span>
                                : <span className="text-amber-600">overdue</span>
                              : <span>—</span>}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {["pending", "scheduled"].includes(wave.status) && (
                            <Button
                              size="sm" variant="outline"
                              className="h-6 text-xs gap-1 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                              onClick={() => startWaveMut.mutate(wave.id)}
                              disabled={startWaveMut.isPending}
                            >
                              {startWaveMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                              Start now
                            </Button>
                          )}
                          {wave.status === "active" && (
                            <Button
                              size="sm" variant="outline"
                              className="h-6 text-xs gap-1 text-amber-700 border-amber-200 hover:bg-amber-50"
                              onClick={() => pauseWaveMut.mutate(wave.id)}
                              disabled={pauseWaveMut.isPending}
                            >
                              {pauseWaveMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />}
                              Pause
                            </Button>
                          )}
                          {wave.status === "paused" && (
                            <Button
                              size="sm" variant="outline"
                              className="h-6 text-xs gap-1 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                              onClick={() => resumeWaveMut.mutate(wave.id)}
                              disabled={resumeWaveMut.isPending}
                            >
                              {resumeWaveMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                              Resume
                            </Button>
                          )}
                          {wave.status === "completed" && (
                            <span className="text-[10px] text-muted-foreground flex items-center gap-1 justify-end">
                              <CheckCircle2 className="w-3 h-3 text-emerald-500" /> done
                            </span>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Timer className="w-3 h-3" />
                  {hasActiveWave
                    ? "Refreshing every 5 s while a wave is active — scheduled waves activate automatically."
                    : "Heartbeat checks every 30 s — scheduled waves activate automatically."}
                </p>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  onClick={() => refetchWaves()}
                  title="Refresh now"
                >
                  <RefreshCw className="w-3 h-3" />
                </Button>
              </div>
            </>
          )}
        </TabsContent>

        {/* ── Agent Script tab ──────────────────────────────────────────── */}
        <TabsContent value="script" className="mt-4">
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Mic className="w-3.5 h-3.5" /> AI Voice Agent Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-4">

              {/* Pitch Template picker */}
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-emerald-700">Pitch Template (product)</p>
                  {resolvedTemplateId && (
                    <span className="text-[11px] text-emerald-600 font-medium flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                      Script variables injected into every call
                    </span>
                  )}
                </div>
                <select
                  className="w-full h-8 px-2 text-sm border rounded bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  value={resolvedTemplateId ?? ""}
                  onChange={e => {
                    const v = e.target.value ? Number(e.target.value) : null;
                    setPitchTemplateId(v);
                    if (agentCfg === null) setAgentCfg(resolvedCfg);
                  }}
                >
                  <option value="">— No template —</option>
                  {(pitchTemplates as any[]).map((t: any) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                {resolvedTemplateId && (() => {
                  const tpl = (pitchTemplates as any[]).find((t: any) => t.id === resolvedTemplateId);
                  return tpl ? (
                    <div className="text-[11px] text-emerald-700/80 space-y-0.5">
                      {tpl.product_name && <p><span className="font-medium">Product:</span> {tpl.product_name}</p>}
                      {tpl.offer_name && <p><span className="font-medium">Offer:</span> {tpl.offer_name}{tpl.offer_duration ? ` · ${tpl.offer_duration}` : ""}</p>}
                      {tpl.language_mode && tpl.language_mode !== "auto" && <p><span className="font-medium">Language:</span> {tpl.language_mode === "hindiOnly" ? "Hindi only" : "English only"}</p>}
                    </div>
                  ) : null;
                })()}
                {(pitchTemplates as any[]).length === 0 && (
                  <p className="text-[11px] text-emerald-600/80">
                    No templates yet — create one in <strong>Library → Pitch Templates</strong>.
                  </p>
                )}
              </div>

              {/* Provider-specific agent config */}
              {campaign.provider === "retell" ? (
                <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-teal-700">RetellAI Agent Configuration</p>
                    <p className="text-[11px] text-teal-600/80 mt-0.5">
                      Your Retell API key, Agent ID, and From Number are configured globally in{" "}
                      <button
                        className="underline font-medium"
                        onClick={() => navigate("/settings")}
                      >Settings → Integrations → RetellAI</button>.
                      Use the fields below to override them for this campaign only.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Retell Agent ID (override)</Label>
                      <Input
                        className="mt-1.5 h-8 text-sm font-mono"
                        placeholder="agent_… (leave blank to use global setting)"
                        value={resolvedCfg.agentId ?? ""}
                        onChange={e => setAgentCfg({ ...resolvedCfg, agentId: e.target.value })}
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Copy from your <a href="https://app.retellai.com" target="_blank" rel="noreferrer" className="underline">Retell dashboard</a> → Agents
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">From Number (override)</Label>
                      <Input
                        className="mt-1.5 h-8 text-sm font-mono"
                        placeholder="+1… (leave blank to use global setting)"
                        value={resolvedCfg.fromNumber ?? ""}
                        onChange={e => setAgentCfg({ ...resolvedCfg, fromNumber: e.target.value })}
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        E.164 format — must be registered in your Retell account
                      </p>
                    </div>
                  </div>
                  {!resolvedCfg.agentId && (
                    <div className="flex items-start gap-1.5 text-[11px] text-teal-700/80">
                      <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                      <span>
                        If no Agent ID is set here, calls will use the <strong>Agent ID saved in Settings → Integrations → RetellAI</strong>.
                        Make sure that is filled in before starting the campaign.
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                /* Vapi: assistant picker */
                <AssistantPicker
                  value={resolvedCfg.assistantId ?? ""}
                  onChange={id => setAgentCfg({ ...resolvedCfg, assistantId: id })}
                />
              )}

              <div className={campaign.provider !== "retell" && resolvedCfg.assistantId ? "opacity-40 pointer-events-none select-none" : ""}>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                  {campaign.provider === "retell"
                    ? "Call script — injected as context into Retell agent"
                    : "Inline script (used when no Assistant ID is set)"}
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground">Agent Persona Name</Label>
                    <Input
                      className="mt-1.5 h-8 text-sm"
                      placeholder="e.g. Alex"
                      value={resolvedCfg.personaName ?? ""}
                      onChange={e => setAgentCfg({ ...resolvedCfg, personaName: e.target.value })}
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">The name the AI agent will introduce itself as</p>
                  </div>
                  {campaign.provider !== "retell" && (
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">ElevenLabs Voice ID</Label>
                      <Input
                        className="mt-1.5 h-8 text-sm font-mono"
                        placeholder="e.g. rachel or a voice ID"
                        value={resolvedCfg.voiceId ?? ""}
                        onChange={e => setAgentCfg({ ...resolvedCfg, voiceId: e.target.value })}
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">Overrides the default ElevenLabs voice for this campaign</p>
                    </div>
                  )}
                </div>

                <div className="mt-4">
                  <Label className="text-xs font-medium text-muted-foreground">Call Goal</Label>
                  <Input
                    className="mt-1.5 h-8 text-sm"
                    placeholder="e.g. Qualify interest and book a demo call"
                    value={resolvedCfg.goal ?? ""}
                    onChange={e => setAgentCfg({ ...resolvedCfg, goal: e.target.value })}
                  />
                </div>

                <div className="mt-4">
                  <Label className="text-xs font-medium text-muted-foreground">Key Talking Points</Label>
                  <Textarea
                    className="mt-1.5 text-sm min-h-[120px]"
                    placeholder={`- Introduce our Q3 AI Analytics platform\n- Ask about their current reporting challenges\n- Offer a 30-minute live demo\n- Share ROI: customers save 4 hours/week on reports`}
                    value={resolvedCfg.keyTalkingPoints ?? ""}
                    onChange={e => setAgentCfg({ ...resolvedCfg, keyTalkingPoints: e.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    The AI agent will use these as guidance. Use bullet points for best results.
                  </p>
                </div>

                {campaign.provider !== "retell" && (
                  <div className="mt-4">
                    <Label className="text-xs font-medium text-muted-foreground">Vapi Phone Number ID (optional override)</Label>
                    <Input
                      className="mt-1.5 h-8 text-sm font-mono"
                      placeholder="Defaults to your configured Vapi phone number"
                      value={resolvedCfg.phoneNumberId ?? ""}
                      onChange={e => setAgentCfg({ ...resolvedCfg, phoneNumberId: e.target.value })}
                    />
                  </div>
                )}
              </div>{/* end inline script wrapper */}

              <div className="p-3 bg-muted/40 rounded-lg text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">Outcome scoring</p>
                <div className="grid grid-cols-2 gap-1 mt-1">
                  <span>✅ Interested → <strong>+15 pts</strong></span>
                  <span>📅 Callback → <strong>+8 pts</strong></span>
                  <span>📵 No answer → <strong>0 pts</strong></span>
                  <span>❌ Not interested → <strong>0 pts</strong></span>
                  <span>🚫 DNC → <strong>-5 pts</strong></span>
                </div>
              </div>

              {agentCfg && (
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700"
                    onClick={() => saveCfg.mutate()}
                    disabled={saveCfg.isPending}
                  >
                    {saveCfg.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                    <Save className="w-3 h-3 mr-1.5" />
                    Save Script
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setAgentCfg(null)}>
                    Discard
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Call Logs tab ──────────────────────────────────────────────── */}
        <TabsContent value="logs" className="mt-4 space-y-3">
          {(() => {
            const callbackLogs   = callLogs.filter(needsFollowUp);
            const incompleteLogs = callLogs.filter(l => {
              const d = Number(l.duration_seconds ?? 0);
              const o = (l.outcome ?? "").toLowerCase().replace(/-/g,"_");
              return ["answered","interested"].includes(o) && d > 0 && d < 30;
            });
            const followupLogs = callLogs.filter(l => {
              const ra = (l.recommended_action ?? "").toLowerCase().replace(/[_\s-]/g,"");
              const o  = (l.outcome ?? "").toLowerCase();
              return ra && !["none","noaction",""].includes(ra) && !["not_interested","dnc"].includes(o);
            });

            const filtered =
              logFilter === "callback"   ? callbackLogs
              : logFilter === "incomplete" ? incompleteLogs
              : logFilter === "followup"   ? followupLogs
              : callLogs;

            const selectable = filtered.filter(l => l.contact_id);
            const allSel = selectable.length > 0 && selectable.every(l => selectedLogContactIds.has(l.contact_id));

            return (
              <>
                {/* Filter tabs + bulk action bar */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-1">
                    {([
                      { key: "all",        label: `All (${callLogs.length})` },
                      { key: "callback",   label: `Needs Callback (${callbackLogs.length})`,   cls: "text-amber-700" },
                      { key: "incomplete", label: `Incomplete (${incompleteLogs.length})`,      cls: "text-orange-700" },
                      { key: "followup",   label: `Follow Up (${followupLogs.length})`,         cls: "text-indigo-700" },
                    ] as { key: string; label: string; cls?: string }[]).map(tab => (
                      <button
                        key={tab.key}
                        onClick={() => { setLogFilter(tab.key as any); setSelectedLogContactIds(new Set()); }}
                        className={cn(
                          "h-7 px-3 text-xs rounded-md border font-medium transition-colors",
                          logFilter === tab.key
                            ? "bg-indigo-600 text-white border-indigo-600"
                            : `bg-background border-border ${tab.cls ?? "text-muted-foreground"} hover:bg-muted`
                        )}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                  {selectedLogContactIds.size > 0 && (
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1.5 bg-indigo-600 hover:bg-indigo-700"
                      onClick={() => setReEnrollOpen(true)}
                    >
                      <RotateCcw className="w-3 h-3" />
                      Re-enroll {selectedLogContactIds.size} selected
                    </Button>
                  )}
                </div>

                {filtered.length === 0 ? (
                  <Card>
                    <CardContent className="py-12 flex flex-col items-center gap-3">
                      <FileText className="w-8 h-8 text-muted-foreground/30" />
                      <p className="text-sm font-medium">
                        {logFilter === "all" ? "No calls logged yet" : `No ${logFilter === "callback" ? "callback-needed" : logFilter} calls found`}
                      </p>
                      <p className="text-xs text-muted-foreground text-center max-w-xs">
                        {logFilter === "all"
                          ? "Completed calls from this campaign will appear here with transcripts and AI insights."
                          : "Change the filter above to see other call results."}
                      </p>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="border rounded-lg overflow-hidden bg-card">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-muted/50 border-b">
                          <th className="py-2 px-3 w-8">
                            <Checkbox
                              checked={allSel}
                              onCheckedChange={(v) => {
                                if (v) setSelectedLogContactIds(new Set(selectable.map(l => l.contact_id)));
                                else   setSelectedLogContactIds(new Set());
                              }}
                            />
                          </th>
                          <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Contact</th>
                          <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Source</th>
                          <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Outcome</th>
                          <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">AI Status</th>
                          <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Score</th>
                          <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Duration</th>
                          <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Called</th>
                          <th className="text-left text-xs font-medium text-muted-foreground py-2 px-3">Next Action</th>
                          <th className="py-2 px-3 w-20" />
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((log: any) => {
                          const fus = getFollowUpStatus(log);
                          const sel = selectedLogContactIds.has(log.contact_id);
                          return (
                            <tr
                              key={log.id}
                              className={cn("border-b last:border-0 hover:bg-muted/20 cursor-pointer", sel && "bg-indigo-50/40")}
                              onClick={() => { setSelectedLog(log); setAiInsights(log.ai_summary ? { aiSummary: log.ai_summary, aiNextSteps: log.ai_next_steps ?? "" } : null); }}
                            >
                              <td className="py-2.5 px-3" onClick={e => e.stopPropagation()}>
                                {log.contact_id && (
                                  <Checkbox
                                    checked={sel}
                                    onCheckedChange={() => {
                                      setSelectedLogContactIds(prev => {
                                        const next = new Set(prev);
                                        if (next.has(log.contact_id)) next.delete(log.contact_id);
                                        else next.add(log.contact_id);
                                        return next;
                                      });
                                    }}
                                  />
                                )}
                              </td>
                              <td className="py-2.5 px-3">
                                <p className="text-sm font-medium">{log.first_name} {log.last_name}</p>
                                <p className="text-xs text-muted-foreground">{log.company_name ?? log.email ?? "—"}</p>
                              </td>
                              <td className="py-2.5 px-3">
                                <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5",
                                  log.provider === "retell" ? "bg-teal-50 text-teal-700 border-teal-200"
                                  : "bg-gray-50 text-gray-600 border-gray-200"
                                )}>
                                  {log.provider === "retell" ? "RetellAI" : "Vapi"}
                                </Badge>
                              </td>
                              <td className="py-2.5 px-3">
                                {log.outcome ? (
                                  <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", OUTCOME_BADGE[log.outcome] ?? "")}>
                                    {log.outcome.replace(/_/g, " ")}
                                  </Badge>
                                ) : <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">{log.status}</Badge>}
                              </td>
                              <td className="py-2.5 px-3">
                                {fus ? (
                                  <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5 font-semibold", fus.cls)}>
                                    {fus.label}
                                  </Badge>
                                ) : log.sentiment ? (
                                  <Badge variant="outline" className={cn(
                                    "text-[10px] h-4 px-1.5",
                                    log.sentiment === "positive" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : log.sentiment === "negative" ? "bg-red-50 text-red-600 border-red-200"
                                    : "bg-gray-50 text-gray-600 border-gray-200"
                                  )}>
                                    {log.sentiment}
                                  </Badge>
                                ) : <span className="text-xs text-muted-foreground">—</span>}
                              </td>
                              <td className="py-2.5 px-3 text-xs font-semibold">
                                {log.interest_score != null
                                  ? <span className={cn(
                                      Number(log.interest_score) >= 7 ? "text-emerald-600"
                                      : Number(log.interest_score) >= 4 ? "text-amber-600"
                                      : "text-muted-foreground"
                                    )}>{log.interest_score}/10</span>
                                  : <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="py-2.5 px-3 text-xs text-muted-foreground">
                                {log.duration_seconds ? `${Math.round(log.duration_seconds)}s` : "—"}
                              </td>
                              <td className="py-2.5 px-3 text-xs text-muted-foreground">
                                {log.started_at ? formatDistanceToNow(new Date(log.started_at), { addSuffix: true }) : "—"}
                              </td>
                              <td className="py-2.5 px-3 text-xs text-muted-foreground max-w-[140px] truncate">
                                {log.recommended_action
                                  ? <span className="text-indigo-600 font-medium">{log.recommended_action.replace(/_/g," ")}</span>
                                  : log.follow_up_message
                                  ? <span className="truncate block">{String(log.follow_up_message).slice(0,50)}</span>
                                  : "—"}
                              </td>
                              <td className="py-2.5 px-3 text-right">
                                <span className="inline-flex items-center gap-1 text-[10px] text-indigo-600 font-medium">
                                  {log.ai_summary ? <><Sparkles className="w-3 h-3" />AI ready</> : "View →"}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            );
          })()}
        </TabsContent>

        {/* ── Analytics tab ─────────────────────────────────────────────── */}
        <TabsContent value="analytics" className="mt-4 space-y-5">
          {!analytics ? (
            <div className="space-y-3">
              {[1,2].map(i => <div key={i} className="h-28 bg-muted animate-pulse rounded-lg" />)}
            </div>
          ) : analytics.summary.totalCalls === 0 ? (
            <Card>
              <CardContent className="py-14 flex flex-col items-center gap-3">
                <BarChart2 className="w-8 h-8 text-muted-foreground/30" />
                <p className="text-sm font-medium">No call data yet</p>
                <p className="text-xs text-muted-foreground text-center max-w-xs">
                  Analytics will appear here once calls have been made from this campaign.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* KPI summary row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Total Calls", value: analytics.summary.totalCalls, sub: null, icon: <Phone className="w-4 h-4 text-indigo-500" /> },
                  { label: "Answer Rate", value: `${analytics.summary.answerRate}%`, sub: `${analytics.summary.answeredCalls} answered`, icon: <PhoneCall className="w-4 h-4 text-emerald-500" /> },
                  { label: "Avg Duration", value: analytics.summary.avgDurationSeconds >= 60 ? `${Math.floor(analytics.summary.avgDurationSeconds/60)}m ${analytics.summary.avgDurationSeconds%60}s` : `${analytics.summary.avgDurationSeconds}s`, sub: "answered calls only", icon: <Clock className="w-4 h-4 text-blue-500" /> },
                  { label: "Positive Rate", value: `${analytics.summary.positiveRate}%`, sub: `${analytics.summary.positiveCount} positive / ${analytics.summary.negativeCount} negative`, icon: <TrendingUp className="w-4 h-4 text-violet-500" /> },
                ].map(({ label, value, sub, icon }) => (
                  <Card key={label}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs text-muted-foreground font-medium">{label}</p>
                        {icon}
                      </div>
                      <p className="text-2xl font-bold">{value}</p>
                      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Breakdown tables */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

                {/* Day of week */}
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">By Day of Week</CardTitle>
                  </CardHeader>
                  <CardContent className="px-0 pb-0">
                    {analytics.byDayOfWeek.length === 0 ? (
                      <p className="px-4 pb-4 text-xs text-muted-foreground">No data yet.</p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b bg-muted/40">
                            <th className="text-left font-medium text-muted-foreground py-2 px-4">Day</th>
                            <th className="text-right font-medium text-muted-foreground py-2 px-3">Calls</th>
                            <th className="text-right font-medium text-muted-foreground py-2 px-3">Answer%</th>
                            <th className="text-right font-medium text-muted-foreground py-2 px-3">Avg dur.</th>
                            <th className="text-right font-medium text-muted-foreground py-2 px-4">Sentiment</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.byDayOfWeek.map(row => (
                            <tr key={row.dow} className="border-b last:border-0 hover:bg-muted/20">
                              <td className="py-2 px-4 font-medium">{row.dayLabel}</td>
                              <td className="py-2 px-3 text-right text-muted-foreground">{row.totalCalls}</td>
                              <td className="py-2 px-3 text-right">
                                <span className={cn("font-medium", row.answerRate >= 50 ? "text-emerald-600" : row.answerRate >= 25 ? "text-amber-600" : "text-destructive")}>
                                  {row.answerRate}%
                                </span>
                              </td>
                              <td className="py-2 px-3 text-right text-muted-foreground">
                                {row.avgDurationSeconds ? (row.avgDurationSeconds >= 60 ? `${Math.floor(row.avgDurationSeconds/60)}m${row.avgDurationSeconds%60}s` : `${row.avgDurationSeconds}s`) : "—"}
                              </td>
                              <td className="py-2 px-4 text-right">
                                {row.answered > 0 ? (
                                  <span className="inline-flex items-center gap-1.5">
                                    <span className="text-emerald-600 flex items-center gap-0.5"><ThumbsUp className="w-3 h-3" />{row.positiveCount}</span>
                                    <span className="text-destructive flex items-center gap-0.5"><ThumbsDown className="w-3 h-3" />{row.negativeCount}</span>
                                  </span>
                                ) : <span className="text-muted-foreground">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </CardContent>
                </Card>

                {/* Hour of day */}
                <Card>
                  <CardHeader className="pb-2 pt-4 px-4">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">By Time of Day</CardTitle>
                  </CardHeader>
                  <CardContent className="px-0 pb-0">
                    {analytics.byHourOfDay.length === 0 ? (
                      <p className="px-4 pb-4 text-xs text-muted-foreground">No data yet.</p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b bg-muted/40">
                            <th className="text-left font-medium text-muted-foreground py-2 px-4">Time</th>
                            <th className="text-right font-medium text-muted-foreground py-2 px-3">Calls</th>
                            <th className="text-right font-medium text-muted-foreground py-2 px-3">Answer%</th>
                            <th className="text-right font-medium text-muted-foreground py-2 px-3">Avg dur.</th>
                            <th className="text-right font-medium text-muted-foreground py-2 px-4">Sentiment</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.byHourOfDay.map(row => {
                            const h = row.hour;
                            const label = h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h-12} PM`;
                            return (
                              <tr key={row.hour} className="border-b last:border-0 hover:bg-muted/20">
                                <td className="py-2 px-4 font-medium">{label}</td>
                                <td className="py-2 px-3 text-right text-muted-foreground">{row.totalCalls}</td>
                                <td className="py-2 px-3 text-right">
                                  <span className={cn("font-medium", row.answerRate >= 50 ? "text-emerald-600" : row.answerRate >= 25 ? "text-amber-600" : "text-destructive")}>
                                    {row.answerRate}%
                                  </span>
                                </td>
                                <td className="py-2 px-3 text-right text-muted-foreground">
                                  {row.avgDurationSeconds ? (row.avgDurationSeconds >= 60 ? `${Math.floor(row.avgDurationSeconds/60)}m${row.avgDurationSeconds%60}s` : `${row.avgDurationSeconds}s`) : "—"}
                                </td>
                                <td className="py-2 px-4 text-right">
                                  {row.answered > 0 ? (
                                    <span className="inline-flex items-center gap-1.5">
                                      <span className="text-emerald-600 flex items-center gap-0.5"><ThumbsUp className="w-3 h-3" />{row.positiveCount}</span>
                                      <span className="text-destructive flex items-center gap-0.5"><ThumbsDown className="w-3 h-3" />{row.negativeCount}</span>
                                    </span>
                                  ) : <span className="text-muted-foreground">—</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </CardContent>
                </Card>
              </div>

              <p className="text-[11px] text-muted-foreground">
                * Sentiment: <span className="text-emerald-600 font-medium">positive</span> = answered + ≥60s + no silence ending &nbsp;|&nbsp; <span className="text-destructive font-medium">negative</span> = answered but short or silence.
                Times shown in UTC.
              </p>
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* Add Contacts dialog */}
      <Dialog open={addContactOpen} onOpenChange={(open) => {
        setAddContactOpen(open);
        if (!open) {
          setSelectedIds(new Set());
          setContactSearch("");
          setMinScore(null);
          setFilterTag("");
          setFilterPlayId(null);
          setFilterCompanyId(null);
          setFilterSegmentId(null);
          resetSegFilters();
          setAddMode("browse");
        }
      }}>
        <DialogContent className="max-w-2xl w-full overflow-hidden">
          <DialogHeader>
            <DialogTitle>Enroll Contacts into Campaign</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {/* Mode toggle */}
            <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
              {(["browse", "segment"] as const).map(m => (
                <button
                  key={m}
                  onClick={() => { setAddMode(m); setSelectedIds(new Set()); }}
                  className={cn(
                    "px-3 py-1 text-xs rounded-md font-medium transition-colors",
                    addMode === m
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {m === "browse" ? "Browse Contacts" : "By Segment"}
                </button>
              ))}
            </div>

            {addMode === "browse" ? (
              <>
                {/* Filter bar */}
                <div className="space-y-2">
                  <Input
                    placeholder="Search by name or email…"
                    className="h-8 text-sm"
                    value={contactSearch}
                    onChange={e => setContactSearch(e.target.value)}
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Min score pills */}
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-[11px] text-muted-foreground font-medium">Score:</span>
                      {([null, 25, 50, 75] as Array<number | null>).map(s => (
                        <button
                          key={String(s)}
                          onClick={() => setMinScore(s)}
                          className={cn(
                            "h-6 px-2 text-[11px] rounded border font-medium transition-colors",
                            minScore === s
                              ? "bg-indigo-600 text-white border-indigo-600"
                              : "bg-card text-muted-foreground border-border hover:border-indigo-400"
                          )}
                        >
                          {s === null ? "Any" : `${s}+`}
                        </button>
                      ))}
                    </div>
                    {/* Tag filter */}
                    {availableTags.length > 0 && (
                      <select
                        className="h-6 text-[11px] border border-border rounded px-1.5 bg-card text-muted-foreground max-w-[130px]"
                        value={filterTag}
                        onChange={e => setFilterTag(e.target.value)}
                      >
                        <option value="">All tags</option>
                        {availableTags.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    )}
                    {/* Play filter */}
                    {availablePlays.length > 0 && (
                      <select
                        className="h-6 text-[11px] border border-border rounded px-1.5 bg-card text-muted-foreground max-w-[130px]"
                        value={filterPlayId ?? ""}
                        onChange={e => setFilterPlayId(e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">All plays</option>
                        {availablePlays.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                    {/* Company filter */}
                    {availableCompanies.length > 0 && (
                      <select
                        className="h-6 text-[11px] border border-border rounded px-1.5 bg-card text-muted-foreground max-w-[130px]"
                        value={filterCompanyId ?? ""}
                        onChange={e => setFilterCompanyId(e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">All companies</option>
                        {availableCompanies.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    )}
                  </div>
                </div>

                {/* Bulk select row */}
                {(() => {
                  const pickable = crmContacts.filter((c: any) => !enrolledIds.has(c.id));
                  const allSelected = pickable.length > 0 && pickable.every((c: any) => selectedIds.has(c.id));
                  return (
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded"
                          checked={allSelected}
                          onChange={() => {
                            if (allSelected) setSelectedIds(new Set());
                            else setSelectedIds(new Set(pickable.map((c: any) => c.id)));
                          }}
                        />
                        Select all visible ({pickable.length})
                      </label>
                      {selectedIds.size > 0 && (
                        <Button
                          size="sm"
                          className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700"
                          onClick={() => { addContacts.mutate([...selectedIds]); setSelectedIds(new Set()); }}
                          disabled={addContacts.isPending}
                        >
                          {addContacts.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Plus className="w-3 h-3 mr-1" />}
                          Add {selectedIds.size} selected
                        </Button>
                      )}
                    </div>
                  );
                })()}

                {/* Contact list — outer clips X, inner scrolls Y */}
                <div className="border rounded-lg overflow-hidden">
                  <div className="max-h-72 overflow-y-auto divide-y">
                    {crmContacts.length === 0 && (
                      <p className="text-xs text-muted-foreground p-4 text-center">No contacts found</p>
                    )}
                    {crmContacts.map((c: any) => {
                      const alreadyIn = enrolledIds.has(c.id);
                      const checked = selectedIds.has(c.id);
                      return (
                        <div key={c.id} className={cn("flex items-center gap-2 px-3 py-2", alreadyIn && "opacity-50")}>
                          <div className="w-4 shrink-0 flex items-center justify-center">
                            {!alreadyIn && (
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5 rounded"
                                checked={checked}
                                onChange={() => setSelectedIds(prev => {
                                  const next = new Set(prev);
                                  if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                                  return next;
                                })}
                              />
                            )}
                          </div>
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <p className="text-sm font-medium truncate">{c.firstName} {c.lastName}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              {c.email}{c.companyName ? ` · ${c.companyName}` : ""}
                            </p>
                          </div>
                          {c.leadScore !== undefined && c.leadScore !== null && (
                            <span className={cn(
                              "text-[10px] font-bold px-1.5 py-0.5 rounded tabular-nums shrink-0",
                              c.leadScore >= 75 ? "bg-rose-100 text-rose-700" :
                              c.leadScore >= 50 ? "bg-amber-100 text-amber-700" :
                              c.leadScore >= 25 ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"
                            )}>{c.leadScore}</span>
                          )}
                          <div className="shrink-0">
                            {alreadyIn
                              ? <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-emerald-600 border-emerald-200">Added</Badge>
                              : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-xs px-2"
                                  onClick={() => addContacts.mutate([c.id])}
                                  disabled={addContacts.isPending}
                                >
                                  <Plus className="w-3 h-3 mr-1" />Add
                                </Button>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              /* ── Segment mode ────────────────────────────────────────── */
              <>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Select a segment</label>
                  {segmentsLoading ? (
                    <div className="flex items-center gap-2 h-8 px-2 text-xs text-muted-foreground border border-border rounded bg-card/50">
                      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                      Loading segments…
                    </div>
                  ) : (
                    <select
                      className="w-full h-8 px-2 text-sm border border-border rounded bg-card focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      value={filterSegmentId ?? ""}
                      onChange={e => {
                        setFilterSegmentId(e.target.value ? Number(e.target.value) : null);
                        setSelectedIds(new Set());
                        resetSegFilters();
                      }}
                    >
                      <option value="">— Choose a segment —</option>
                      {availableSegments.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.name}{s.last_computed_count ? ` (${s.last_computed_count} contacts)` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {!segmentsLoading && availableSegments.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No segments yet —{" "}
                      <button
                        className="underline text-indigo-600 hover:text-indigo-700"
                        onClick={() => { setAddContactOpen(false); navigate("/database/segments"); }}
                      >
                        create one in Database → Segments
                      </button>{" "}
                      first.
                    </p>
                  )}
                </div>

                {filterSegmentId !== null && (
                  <>
                    {/* ── Segment filter bar ───────────────────────────── */}
                    {!segmentLoading && segmentContacts.length > 0 && (
                      <div className="space-y-2 p-3 bg-muted/40 rounded-lg border">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                            Filter within segment ({filteredSegContacts.length} of {segmentContacts.length})
                          </span>
                          {(segSearch || segCity || segSize || segFunction || segIndustry || segStage || segMinScore !== null) && (
                            <button onClick={resetSegFilters} className="text-[11px] text-indigo-600 hover:underline">Clear all</button>
                          )}
                        </div>
                        {/* Row 1: search + score */}
                        <div className="flex gap-2">
                          <Input
                            placeholder="Search name or email…"
                            className="h-7 text-xs flex-1"
                            value={segSearch}
                            onChange={e => setSegSearch(e.target.value)}
                          />
                          <div className="flex items-center gap-1 shrink-0">
                            <span className="text-[11px] text-muted-foreground">Score:</span>
                            {([null, 25, 50, 75] as Array<number | null>).map(s => (
                              <button
                                key={String(s)}
                                onClick={() => setSegMinScore(s)}
                                className={cn(
                                  "h-6 px-2 text-[11px] rounded border font-medium transition-colors",
                                  segMinScore === s
                                    ? "bg-indigo-600 text-white border-indigo-600"
                                    : "bg-background text-muted-foreground border-border hover:border-indigo-400"
                                )}
                              >{s === null ? "Any" : `${s}+`}</button>
                            ))}
                          </div>
                        </div>
                        {/* Row 2: dropdowns */}
                        <div className="flex gap-2 flex-wrap">
                          {segCityOptions.length > 0 && (
                            <select
                              className="h-6 text-[11px] border border-border rounded px-1.5 bg-background text-muted-foreground max-w-[130px]"
                              value={segCity}
                              onChange={e => setSegCity(e.target.value)}
                            >
                              <option value="">All cities</option>
                              {segCityOptions.map(v => <option key={v} value={v}>{v}</option>)}
                            </select>
                          )}
                          {segSizeOptions.length > 0 && (
                            <select
                              className="h-6 text-[11px] border border-border rounded px-1.5 bg-background text-muted-foreground max-w-[140px]"
                              value={segSize}
                              onChange={e => setSegSize(e.target.value)}
                            >
                              <option value="">All sizes</option>
                              {segSizeOptions.map(v => <option key={v} value={v}>{v}</option>)}
                            </select>
                          )}
                          {segFuncOptions.length > 0 && (
                            <select
                              className="h-6 text-[11px] border border-border rounded px-1.5 bg-background text-muted-foreground max-w-[140px]"
                              value={segFunction}
                              onChange={e => setSegFunction(e.target.value)}
                            >
                              <option value="">All functions</option>
                              {segFuncOptions.map(v => <option key={v} value={v}>{v}</option>)}
                            </select>
                          )}
                          {segIndOptions.length > 0 && (
                            <select
                              className="h-6 text-[11px] border border-border rounded px-1.5 bg-background text-muted-foreground max-w-[140px]"
                              value={segIndustry}
                              onChange={e => setSegIndustry(e.target.value)}
                            >
                              <option value="">All industries</option>
                              {segIndOptions.map(v => <option key={v} value={v}>{v}</option>)}
                            </select>
                          )}
                          {segStageOptions.length > 0 && (
                            <select
                              className="h-6 text-[11px] border border-border rounded px-1.5 bg-background text-muted-foreground max-w-[120px]"
                              value={segStage}
                              onChange={e => setSegStage(e.target.value)}
                            >
                              <option value="">All stages</option>
                              {segStageOptions.map(v => <option key={v} value={v}>{v}</option>)}
                            </select>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Segment bulk-add row */}
                    {(() => {
                      const pickable = filteredSegContacts.filter((c: any) => !enrolledIds.has(c.id));
                      const allSelected = pickable.length > 0 && pickable.every((c: any) => selectedIds.has(c.id));
                      return (
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded"
                              checked={allSelected}
                              disabled={segmentLoading}
                              onChange={() => {
                                if (allSelected) setSelectedIds(new Set());
                                else setSelectedIds(new Set(pickable.map((c: any) => c.id)));
                              }}
                            />
                            Select all visible ({pickable.length})
                          </label>
                          {selectedIds.size > 0 && (
                            <Button
                              size="sm"
                              className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700"
                              onClick={() => { addContacts.mutate([...selectedIds]); setSelectedIds(new Set()); }}
                              disabled={addContacts.isPending}
                            >
                              {addContacts.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Plus className="w-3 h-3 mr-1" />}
                              Add {selectedIds.size} selected
                            </Button>
                          )}
                          {selectedIds.size === 0 && pickable.length > 0 && (
                            <Button
                              size="sm"
                              className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700"
                              onClick={() => addContacts.mutate(pickable.map((c: any) => c.id))}
                              disabled={addContacts.isPending}
                            >
                              {addContacts.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Users className="w-3 h-3 mr-1" />}
                              Add all {pickable.length}
                            </Button>
                          )}
                        </div>
                      );
                    })()}

                    {/* Segment contact list — outer clips X, inner scrolls Y */}
                    <div className="border rounded-lg overflow-hidden">
                      <div className="max-h-64 overflow-y-auto divide-y">
                        {segmentLoading && (
                          <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading segment contacts…
                          </div>
                        )}
                        {!segmentLoading && segmentContacts.length === 0 && (
                          <p className="text-xs text-muted-foreground p-4 text-center">No contacts in this segment</p>
                        )}
                        {!segmentLoading && segmentContacts.length > 0 && filteredSegContacts.length === 0 && (
                          <p className="text-xs text-muted-foreground p-4 text-center">No contacts match the current filters</p>
                        )}
                        {!segmentLoading && filteredSegContacts.map((c: any) => {
                          const alreadyIn = enrolledIds.has(c.id);
                          const checked = selectedIds.has(c.id);
                          const meta = [c.function, c.city, c.employee_size || c.company_size].filter(Boolean).join(" · ");
                          return (
                            <div key={c.id} className={cn("flex items-center gap-2 px-3 py-2", alreadyIn && "opacity-50")}>
                              <div className="w-4 shrink-0 flex items-center justify-center">
                                {!alreadyIn && (
                                  <input
                                    type="checkbox"
                                    className="h-3.5 w-3.5 rounded"
                                    checked={checked}
                                    onChange={() => setSelectedIds(prev => {
                                      const next = new Set(prev);
                                      if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                                      return next;
                                    })}
                                  />
                                )}
                              </div>
                              <div className="flex-1 min-w-0 overflow-hidden">
                                <p className="text-sm font-medium truncate">{c.first_name} {c.last_name}</p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {c.company_name}{meta ? ` · ${meta}` : ""}
                                </p>
                              </div>
                              {c.lead_score !== undefined && c.lead_score !== null && (
                                <span className={cn(
                                  "text-[10px] font-bold px-1.5 py-0.5 rounded tabular-nums shrink-0",
                                  c.lead_score >= 75 ? "bg-rose-100 text-rose-700" :
                                  c.lead_score >= 50 ? "bg-amber-100 text-amber-700" :
                                  c.lead_score >= 25 ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"
                                )}>{c.lead_score}</span>
                              )}
                              <div className="shrink-0">
                                {alreadyIn
                                  ? <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-emerald-600 border-emerald-200">Added</Badge>
                                  : (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-6 text-xs px-2"
                                      onClick={() => addContacts.mutate([c.id])}
                                      disabled={addContacts.isPending}
                                    >
                                      <Plus className="w-3 h-3 mr-1" />Add
                                    </Button>
                                  )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* Wave enrollment preview */}
          {(() => {
            const bs = campaign?.batch_size ?? 3;
            const gap = campaign?.wave_gap_minutes ?? 6;
            const pendingCount = total - done - calling;
            if (pendingCount <= 0) return null;
            const waveCount = Math.ceil(pendingCount / bs);
            return (
              <div className="px-6 pb-2">
                <div className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
                  <Layers className="w-3.5 h-3.5 shrink-0 text-indigo-500" />
                  <span>
                    <strong>{pendingCount}</strong> pending →{" "}
                    <strong>{waveCount}</strong> wave{waveCount !== 1 ? "s" : ""} of{" "}
                    <strong>{bs}</strong> each, ~<strong>{gap} min</strong> apart
                  </span>
                </div>
              </div>
            );
          })()}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => { setAddContactOpen(false); setSelectedIds(new Set()); }}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove contact confirm */}
      <AlertDialog open={removeContactId !== null} onOpenChange={() => setRemoveContactId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove contact from campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the contact from this campaign. If a call is in progress it will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => removeContactId !== null && removeContact.mutate(removeContactId)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Start campaign confirm */}
      <AlertDialog open={startConfirm} onOpenChange={setStartConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start call campaign?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {pending > 0 && (() => {
                  const bs = campaign?.batch_size ?? 3;
                  const gap = campaign?.wave_gap_minutes ?? 6;
                  const waveCount = Math.ceil(pending / bs);
                  return (
                    <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-indigo-800 text-sm">
                      <div className="flex items-center gap-2 font-medium mb-1">
                        <Layers className="w-4 h-4 text-indigo-600" />
                        Wave batching preview
                      </div>
                      <p className="text-xs text-indigo-700">
                        <strong>{pending}</strong> contacts →{" "}
                        <strong>{waveCount}</strong> wave{waveCount !== 1 ? "s" : ""} of{" "}
                        <strong>{bs}</strong> each, ~<strong>{gap} min</strong> apart.
                        Wave 1 fires immediately; later waves auto-activate via the 30-second heartbeat.
                      </p>
                    </div>
                  );
                })()}
                <p className="text-sm text-muted-foreground">
                  Make sure your Vapi API key and phone number are configured in Settings → Integrations.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => startCampaign.mutate()}
            >
              {startCampaign.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Start Campaign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Re-enroll confirm dialog ──────────────────────────────────────── */}
      <AlertDialog open={reEnrollOpen} onOpenChange={setReEnrollOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-enroll {selectedLogContactIds.size} contact{selectedLogContactIds.size !== 1 ? "s" : ""} for follow-up?</AlertDialogTitle>
            <AlertDialogDescription>
              Their status will be reset to <strong>pending</strong> so they are called again in the next wave of this campaign. Previous call logs are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-indigo-600 hover:bg-indigo-700"
              onClick={() => reEnrollMut.mutate(Array.from(selectedLogContactIds))}
              disabled={reEnrollMut.isPending}
            >
              {reEnrollMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}
              Re-enroll
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Call detail Sheet ─────────────────────────────────────────────── */}
      <Sheet open={!!selectedLog} onOpenChange={(open) => { if (!open) { setSelectedLog(null); setAiInsights(null); } }}>
        <SheetContent className="w-full sm:max-w-lg flex flex-col gap-0 p-0">
          {selectedLog && (
            <>
              {/* Header */}
              <SheetHeader className="px-5 pt-5 pb-4 border-b shrink-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <SheetTitle className="text-base">
                      {selectedLog.first_name} {selectedLog.last_name}
                    </SheetTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {selectedLog.company_name ?? selectedLog.email ?? "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {selectedLog.outcome && (
                      <Badge variant="outline" className={cn("text-[10px] h-5 px-2", OUTCOME_BADGE[selectedLog.outcome] ?? "")}>
                        {selectedLog.outcome.replace(/_/g, " ")}
                      </Badge>
                    )}
                    {selectedLog.duration_seconds && (
                      <Badge variant="outline" className="text-[10px] h-5 px-2 text-muted-foreground">
                        <Clock className="w-2.5 h-2.5 mr-1" />{Math.round(selectedLog.duration_seconds)}s
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
                  {selectedLog.started_at && (
                    <span>Called {formatDistanceToNow(new Date(selectedLog.started_at), { addSuffix: true })}</span>
                  )}
                  {selectedLog.recording_url && (
                    <a href={selectedLog.recording_url} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-indigo-600 hover:underline"
                      onClick={e => e.stopPropagation()}>
                      <ExternalLink className="w-2.5 h-2.5" /> Recording
                    </a>
                  )}
                </div>
              </SheetHeader>

              <ScrollArea className="flex-1 min-h-0">
                <div className="px-5 py-4 space-y-5">

                  {/* Transcript */}
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                      <FileText className="w-3 h-3" /> Transcript
                    </p>
                    {selectedLog.transcript?.text ? (
                      <div className="bg-muted/40 rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap font-mono text-foreground/80 max-h-52 overflow-y-auto border">
                        {selectedLog.transcript.text}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">No transcript recorded for this call.</p>
                    )}
                  </div>

                  {/* AI Insights */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <Sparkles className="w-3 h-3 text-indigo-500" /> AI Insights
                      </p>
                      {!aiInsights && (
                        <Button
                          size="sm"
                          className="h-6 text-[11px] px-2.5 gap-1 bg-indigo-600 hover:bg-indigo-700"
                          disabled={summarize.isPending || !selectedLog.transcript?.text}
                          onClick={() => summarize.mutate(selectedLog.id)}
                        >
                          {summarize.isPending
                            ? <><Loader2 className="w-3 h-3 animate-spin" /> Analysing…</>
                            : <><Sparkles className="w-3 h-3" /> Generate</>}
                        </Button>
                      )}
                      {aiInsights && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[11px] px-2 text-muted-foreground"
                          disabled={summarize.isPending}
                          onClick={() => summarize.mutate(selectedLog.id)}
                        >
                          {summarize.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Regenerate"}
                        </Button>
                      )}
                    </div>

                    {!aiInsights && !summarize.isPending && (
                      <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50/40 p-4 flex flex-col items-center gap-2">
                        <Sparkles className="w-5 h-5 text-indigo-300" />
                        <p className="text-xs text-muted-foreground text-center">
                          Click <strong>Generate</strong> to get an AI summary and recommended next steps for this call.
                        </p>
                      </div>
                    )}

                    {summarize.isPending && (
                      <div className="rounded-lg border bg-muted/30 p-4 flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />
                        Analysing transcript with AI…
                      </div>
                    )}

                    {aiInsights && (
                      <div className="space-y-3">
                        <div className="rounded-lg border bg-card p-3.5">
                          <p className="text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Summary</p>
                          <p className="text-xs leading-relaxed text-foreground/90">{aiInsights.aiSummary}</p>
                        </div>
                        {aiInsights.aiNextSteps && (
                          <div className="rounded-lg border bg-card p-3.5">
                            <p className="text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Next Steps</p>
                            <div className="text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap">
                              {aiInsights.aiNextSteps}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                </div>
              </ScrollArea>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
