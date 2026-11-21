import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Search, Plus, Building2, Download, Upload, ListChecks, X, CheckSquare, Trash2, MoreHorizontal, ArrowUpDown, ClipboardList, Megaphone, Calendar, Users, Tag, AlertCircle, CheckCircle2, PhoneCall, SlidersHorizontal, Loader2, ExternalLink, Hash, PhoneOff, Layers } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScoreBadge } from "@/components/ScoreBadge";
import { CrmSubNav } from "./sub-nav";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { KABOOM_FIELDS, type MappingAction, type ColMapping } from "@/lib/csvImportFields";
import { AddToSegmentDialog } from "@/components/AddToSegmentDialog";

const INTENT_STATE_CONFIG: Record<string, { badge: string; dot: string; icon: string }> = {
  "Decision-Action":   { badge: "bg-red-100 text-red-700 border-red-200",    dot: "bg-red-500",    icon: "🔥" },
  "Evaluating-Engage": { badge: "bg-orange-100 text-orange-700 border-orange-200", dot: "bg-orange-400", icon: "🔆" },
  "Stuck-PreEngage":   { badge: "bg-amber-100 text-amber-700 border-amber-200",  dot: "bg-amber-400",  icon: "⚡" },
  "Re-engaging":       { badge: "bg-cyan-100 text-cyan-700 border-cyan-200",   dot: "bg-cyan-400",   icon: "🔄" },
  "Stuck-Aware":       { badge: "bg-blue-100 text-blue-700 border-blue-200",   dot: "bg-blue-400",   icon: "🌊" },
  "Browsing":          { badge: "bg-gray-100 text-gray-600 border-gray-200",   dot: "bg-gray-400",   icon: "👀" },
  "Dormant":           { badge: "bg-slate-100 text-slate-500 border-slate-200", dot: "bg-slate-300",  icon: "❄️" },
};

const INTENT_STATES = Object.keys(INTENT_STATE_CONFIG);

const INTENT_HEAT_MAP: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  "Decision-Action":   { label: "Very Hot", bg: "bg-red-100",    text: "text-red-700",    dot: "bg-red-500"    },
  "Evaluating-Engage": { label: "Hot",      bg: "bg-orange-100", text: "text-orange-700", dot: "bg-orange-500" },
  "Stuck-PreEngage":   { label: "Warm",     bg: "bg-blue-100",   text: "text-blue-700",   dot: "bg-blue-500"   },
  "Re-engaging":       { label: "Warm",     bg: "bg-blue-100",   text: "text-blue-700",   dot: "bg-blue-500"   },
  "Stuck-Aware":       { label: "Cold",     bg: "bg-slate-100",  text: "text-slate-700",  dot: "bg-slate-400"  },
  "Browsing":          { label: "Cold",     bg: "bg-slate-100",  text: "text-slate-700",  dot: "bg-slate-400"  },
  "Dormant":           { label: "Cold",     bg: "bg-slate-100",  text: "text-slate-700",  dot: "bg-slate-400"  },
};

const api = (path: string) => fetch(`/api${path}`, { credentials: "include" }).then(r => r.json());

const STAGE_KEYS = new Set(["pre-aware","aware","pre-engage","engage","advanced-engaged","action"]);
function formatStage(s: string): string {
  return s.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

type Contact = {
  id: number; firstName: string; lastName: string; email: string; phone: string | null;
  title: string | null; companyName: string | null; companyId: number | null;
  leadScore: number; tags: string[]; stage?: string; status: string; lastActivity: string | null; createdAt: string;
  formSubmissionCount: number;
  playCount: number;
  intentScore: number | null;
  intentState: string | null;
  journeyScore: number | null;
  phoneScore: number | null;
  combinedScore: number;
  identifier: string | null;
  dnc: boolean;
};
type Threshold = { id: number; label: string; minScore: number; color: string };
type JourneyForm = { id: number; name: string; submissionCount: number };
type EmailSequence = { id: number; name: string; status: string; enrolledCount: number };
type Play = { id: number; name: string; status: string };
type Journey = { id: number; name: string; status: string };

export default function ContactsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [formFilter, setFormFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState("all");
  const [intentStateFilter, setIntentStateFilter] = useState("all");
  const [playFilter, setPlayFilter] = useState("all");
  const [journeyFilter, setJourneyFilter] = useState("all");
  const [sortBy, setSortBy] = useState("leadScore");
  const [segmentFilter, setSegmentFilter] = useState("all");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");

  const [stageFilter, setStageFilter] = useState("all");
  const [scoreMin, setScoreMin] = useState("");
  const [scoreMax, setScoreMax] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [identifierFilter, setIdentifierFilter] = useState("");
  const [callOutcomeFilter, setCallOutcomeFilter] = useState("all");
  const [campaignTypeFilter, setCampaignTypeFilter] = useState("all");
  const [dncFilter, setDncFilter] = useState("all");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [selectedSequenceId, setSelectedSequenceId] = useState<string>("");
  const [reEnrollCompleted, setReEnrollCompleted] = useState(false);
  const [callCampaignModalOpen, setCallCampaignModalOpen] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteContactId, setDeleteContactId] = useState<number | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [addToSegmentOpen, setAddToSegmentOpen] = useState(false);
  const [addToSegmentContactIds, setAddToSegmentContactIds] = useState<number[]>([]);

  const { data: clients = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["clients"],
    queryFn: () => api("/clients"),
  });

  const { data: segments = [] } = useQuery<{ id: number; name: string; segment_type: string }[]>({
    queryKey: ["segments-list"],
    queryFn: () => api("/segments"),
  });

  const { data: plays = [] } = useQuery<Play[]>({
    queryKey: ["plays-list"],
    queryFn: () => api("/plays"),
  });

  const { data: journeys = [] } = useQuery<Journey[]>({
    queryKey: ["journeys-list"],
    queryFn: () => api("/journeys"),
  });

  const { data: contactsResponse, isLoading } = useQuery<{ contacts: Contact[]; totalCount: number }>({
    queryKey: ["contacts", formFilter, clientFilter, sortBy, playFilter, journeyFilter, segmentFilter, createdFrom, createdTo, stageFilter, scoreMin, scoreMax, callOutcomeFilter, campaignTypeFilter, dncFilter, identifierFilter, search, statusFilter, intentStateFilter, tagFilter, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (formFilter !== "all") params.set("formId", formFilter);
      if (clientFilter !== "all") params.set("clientId", clientFilter);
      if (playFilter !== "all") params.set("playId", playFilter);
      if (journeyFilter !== "all") params.set("journeyId", journeyFilter);
      if (segmentFilter !== "all") params.set("segmentId", segmentFilter);
      if (createdFrom) params.set("createdFrom", createdFrom);
      if (createdTo) params.set("createdTo", createdTo);
      if (stageFilter !== "all") params.set("stage", stageFilter);
      if (scoreMin !== "") params.set("scoreMin", scoreMin);
      if (scoreMax !== "") params.set("scoreMax", scoreMax);
      if (callOutcomeFilter !== "all") params.set("callOutcome", callOutcomeFilter);
      if (campaignTypeFilter !== "all") params.set("campaignType", campaignTypeFilter);
      if (dncFilter !== "all") params.set("dnc", dncFilter);
      if (identifierFilter.trim()) params.set("identifier", identifierFilter.trim());
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (intentStateFilter !== "all") params.set("intentState", intentStateFilter);
      if (tagFilter.trim()) params.set("tag", tagFilter.trim());
      params.set("sortBy", sortBy);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      const res = await fetch(`/api/contacts?${params.toString()}`, { credentials: "include" });
      const data = await res.json();
      const totalCountHeader = res.headers.get("X-Total-Count");
      return {
        contacts: data as Contact[],
        totalCount: totalCountHeader ? parseInt(totalCountHeader, 10) : (data as Contact[]).length,
      };
    },
  });

  const contacts = contactsResponse?.contacts ?? [];
  const totalCount = contactsResponse?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  // Fetch most-recent score delta for each contact on the current page.
  type ScoreDelta = { contactId: number; oldScore: number; newScore: number; delta: number; source: string | null; createdAt: string };
  const contactIdKey = contacts.map(c => c.id).join(",");
  const { data: scoreDeltas = {} } = useQuery<Record<number, ScoreDelta>>({
    queryKey: ["score-deltas", contactIdKey],
    queryFn: async () => {
      if (contacts.length === 0) return {};
      const res = await fetch("/api/scoring/score-deltas", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds: contacts.map(c => c.id) }),
      });
      return res.json();
    },
    enabled: contacts.length > 0,
    staleTime: 60_000,
  });

  const selectedDncIds = contacts
    .filter(c => selectedIds.has(c.id) && c.dnc)
    .map(c => c.id);

  const { data: thresholds = [] } = useQuery<Threshold[]>({
    queryKey: ["score-thresholds"],
    queryFn: () => api("/score-thresholds"),
  });

  const { data: journeyForms = [] } = useQuery<JourneyForm[]>({
    queryKey: ["journey-forms-list"],
    queryFn: () => api("/journey-forms"),
  });

  const { data: sequences = [] } = useQuery<EmailSequence[]>({
    queryKey: ["email-sequences"],
    queryFn: () => api("/email-sequences"),
    enabled: enrollModalOpen,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/contacts/${id}`, { method: "DELETE", credentials: "include" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      toast({ title: "Contact deleted" });
      setDeleteContactId(null);
    },
    onError: () => toast({ title: "Failed to delete contact", variant: "destructive" }),
  });

  const dncMutation = useMutation({
    mutationFn: ({ id, dnc }: { id: number; dnc: boolean }) =>
      fetch(`/api/contacts/${id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dnc }),
      }).then(r => r.json()),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      toast({ title: vars.dnc ? "Contact marked as DNC — they won't be emailed or called." : "DNC removed — contact can be reached again." });
    },
    onError: () => toast({ title: "Failed to update DNC status", variant: "destructive" }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      await Promise.all(ids.map(id =>
        fetch(`/api/contacts/${id}`, { method: "DELETE", credentials: "include" })
      ));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      toast({ title: `${Array.from(selectedIds).length} contact${selectedIds.size !== 1 ? "s" : ""} deleted` });
      setSelectedIds(new Set());
      setBulkDeleteConfirmOpen(false);
    },
    onError: () => toast({ title: "Failed to delete contacts", variant: "destructive" }),
  });

  const bulkDncMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      await Promise.all(ids.map(id =>
        fetch(`/api/contacts/${id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dnc: true }),
        })
      ));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      const count = selectedIds.size;
      toast({ title: `${count} contact${count !== 1 ? "s" : ""} marked as DNC` });
      setSelectedIds(new Set());
    },
    onError: () => toast({ title: "Failed to mark contacts as DNC", variant: "destructive" }),
  });

  const bulkRemoveDncMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      await Promise.all(ids.map(id =>
        fetch(`/api/contacts/${id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dnc: false }),
        })
      ));
    },
    onSuccess: (_data, ids) => {
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      const count = ids.length;
      toast({ title: `DNC removed from ${count} contact${count !== 1 ? "s" : ""} — they can be reached again.` });
      setSelectedIds(new Set());
    },
    onError: () => toast({ title: "Failed to remove DNC", variant: "destructive" }),
  });

  const bulkEnrollMutation = useMutation({
    mutationFn: async ({ sequenceId, contactIds, reEnroll }: { sequenceId: number; contactIds: number[]; reEnroll: boolean }) => {
      const res = await fetch(`/api/email-sequences/${sequenceId}/bulk-enroll`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds, reEnrollCompleted: reEnroll }),
      });
      if (!res.ok) throw new Error("Enrollment failed");
      return res.json() as Promise<{ enrolled: number; alreadyActive: number; skippedCompleted: number; notFound: number; skippedDnc: number }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["email-sequences"] });
      setEnrollModalOpen(false);
      setSelectedIds(new Set());
      setSelectedSequenceId("");
      setReEnrollCompleted(false);
      const parts: string[] = [];
      if (result.enrolled > 0) parts.push(`${result.enrolled} contact${result.enrolled !== 1 ? "s" : ""} enrolled`);
      if ((result.alreadyActive ?? 0) > 0) parts.push(`${result.alreadyActive} already active`);
      if ((result.skippedCompleted ?? 0) > 0) parts.push(`${result.skippedCompleted} skipped — already completed`);
      if (result.skippedDnc > 0) parts.push(`${result.skippedDnc} skipped — DNC`);
      if (result.notFound > 0) parts.push(`${result.notFound} not found`);
      toast({ title: "Bulk enrollment complete", description: parts.join(" · ") || "No changes made" });
    },
    onError: () => {
      toast({ title: "Enrollment failed", description: "Please try again.", variant: "destructive" });
    },
  });

  // Search, status, intent state, and tag filters are applied server-side (see contacts query above).
  const filtered = contacts;

  const createCallCampaignMutation = useMutation({
    mutationFn: async ({ name, contactIds }: { name: string; contactIds: number[] }) => {
      const campRes = await fetch("/api/call-campaigns", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, status: "draft" }),
      });
      if (!campRes.ok) throw new Error("Failed to create campaign");
      const camp = await campRes.json() as { id: number; name: string };
      const addRes = await fetch(`/api/call-campaigns/${camp.id}/contacts`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds }),
      });
      if (!addRes.ok) throw new Error("Failed to add contacts to campaign");
      const addData = await addRes.json() as { added: number; skippedDnc: number };
      return { campaignId: camp.id, campaignName: camp.name, added: addData.added, skippedDnc: addData.skippedDnc ?? 0 };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["call-campaigns"] });
      setCallCampaignModalOpen(false);
      setNewCampaignName("");
      setSelectedIds(new Set());
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} contact${result.added !== 1 ? "s" : ""} added`);
      if (result.skippedDnc > 0) parts.push(`${result.skippedDnc} skipped — DNC`);
      toast({
        title: `Campaign "${result.campaignName}" created`,
        description: `${parts.join(" · ") || "No contacts added"}. Click to open it.`,
        action: (
          <button
            className="text-xs text-indigo-600 hover:underline font-medium flex items-center gap-1"
            onClick={() => navigate(`/call-campaigns/${result.campaignId}`)}
          >
            Open <ExternalLink className="w-3 h-3" />
          </button>
        ) as any,
      });
    },
    onError: (e: Error) => toast({ title: "Failed to create campaign", description: e.message, variant: "destructive" }),
  });

  const initials = (c: Contact) => `${c.firstName?.[0] ?? ""}${c.lastName?.[0] ?? ""}`.toUpperCase();

  const allFilteredSelected = filtered.length > 0 && filtered.every(c => selectedIds.has(c.id));
  const someFilteredSelected = filtered.some(c => selectedIds.has(c.id)) && !allFilteredSelected;

  const toggleAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        filtered.forEach(c => next.delete(c.id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        filtered.forEach(c => next.add(c.id));
        return next;
      });
    }
  };

  const toggleOne = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirmEnroll = () => {
    if (!selectedSequenceId) return;
    bulkEnrollMutation.mutate({
      sequenceId: parseInt(selectedSequenceId),
      contactIds: Array.from(selectedIds),
      reEnroll: reEnrollCompleted,
    });
  };

  const selectedCount = selectedIds.size;
  const chosenSequence = sequences.find(s => String(s.id) === selectedSequenceId);

  return (
    <div className="flex flex-col h-full">
      <CrmSubNav active="contacts" />
      <div className="p-6 flex-1 overflow-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-foreground tracking-tight">Contacts</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{totalCount.toLocaleString()} contacts in workspace</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const params = new URLSearchParams();
                if (formFilter !== "all") params.set("formId", formFilter);
                if (clientFilter !== "all") params.set("clientId", clientFilter);
                if (playFilter !== "all") params.set("playId", playFilter);
                if (journeyFilter !== "all") params.set("journeyId", journeyFilter);
                if (segmentFilter !== "all") params.set("segmentId", segmentFilter);
                if (createdFrom) params.set("createdFrom", createdFrom);
                if (createdTo) params.set("createdTo", createdTo);
                if (stageFilter !== "all") params.set("stage", stageFilter);
                if (scoreMin !== "") params.set("scoreMin", scoreMin);
                if (scoreMax !== "") params.set("scoreMax", scoreMax);
                if (callOutcomeFilter !== "all") params.set("callOutcome", callOutcomeFilter);
                if (campaignTypeFilter !== "all") params.set("campaignType", campaignTypeFilter);
                if (dncFilter !== "all") params.set("dnc", dncFilter);
                if (identifierFilter.trim()) params.set("identifier", identifierFilter.trim());
                if (search.trim()) params.set("search", search.trim());
                if (statusFilter !== "all") params.set("status", statusFilter);
                if (intentStateFilter !== "all") params.set("intentState", intentStateFilter);
                if (tagFilter.trim()) params.set("tag", tagFilter.trim());
                const qs = params.toString();
                const a = document.createElement("a");
                a.href = `/api/contacts/export${qs ? `?${qs}` : ""}`;
                a.download = dncFilter === "dnc" ? "dnc-contacts.csv" : "contacts.csv";
                a.click();
              }}
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              {dncFilter === "dnc" ? "Export DNC list" : "Export CSV"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="w-3.5 h-3.5 mr-1.5" /> Import CSV
            </Button>
            <Button className="bg-indigo-600 hover:bg-indigo-700" size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="w-4 h-4 mr-1.5" /> New Contact
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
            <Input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search contacts..." className="pl-8 h-8 text-sm" />
          </div>
          <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="unsubscribed">Unsubscribed</SelectItem>
            </SelectContent>
          </Select>
          <Select value={clientFilter} onValueChange={v => { setClientFilter(v); setSelectedIds(new Set()); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-44"><SelectValue placeholder="All clients" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clients</SelectItem>
              {clients.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={formFilter} onValueChange={v => { setFormFilter(v); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-48">
              <SelectValue placeholder="Form submitted" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All forms</SelectItem>
              {journeyForms.map(f => (
                <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={intentStateFilter} onValueChange={v => { setIntentStateFilter(v); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-44">
              <SelectValue placeholder="Intent state" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All intent states</SelectItem>
              {INTENT_STATES.map(s => {
                const cfg = INTENT_STATE_CONFIG[s];
                return (
                  <SelectItem key={s} value={s}>
                    <span className="flex items-center gap-1.5">
                      <span>{cfg.icon}</span>
                      <span>{s}</span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Select value={playFilter} onValueChange={v => { setPlayFilter(v); setJourneyFilter("all"); setSelectedIds(new Set()); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-40">
              <SelectValue placeholder="All plays" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All plays</SelectItem>
              {plays.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={journeyFilter} onValueChange={v => { setJourneyFilter(v); setSelectedIds(new Set()); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-44">
              <SelectValue placeholder="All journeys" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All journeys</SelectItem>
              {journeys.map(j => <SelectItem key={j.id} value={String(j.id)}>{j.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={segmentFilter} onValueChange={v => { setSegmentFilter(v); setSelectedIds(new Set()); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-44">
              <Users className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue placeholder="All segments" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All segments</SelectItem>
              {segments.map(s => (
                <SelectItem key={s.id} value={String(s.id)}>
                  <span className="flex items-center gap-1.5">
                    <span className={cn(
                      "inline-block w-1.5 h-1.5 rounded-full shrink-0",
                      s.segment_type === "static" ? "bg-violet-500" : "bg-indigo-500"
                    )} />
                    {s.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={v => { setSortBy(v); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-44">
              <ArrowUpDown className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="leadScore">Lead Score</SelectItem>
              <SelectItem value="intentScore">Intent Score</SelectItem>
              <SelectItem value="name">Name (A–Z)</SelectItem>
              <SelectItem value="createdAt">Recently Added</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Score range + Stage + Tag + Call outcome row */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium shrink-0">
            <SlidersHorizontal className="w-3.5 h-3.5" /> Filters
          </span>
          <Select value={stageFilter} onValueChange={v => { setStageFilter(v); setSelectedIds(new Set()); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-40">
              <SelectValue placeholder="All stages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              <SelectItem value="pre-aware">Pre-aware</SelectItem>
              <SelectItem value="aware">Aware</SelectItem>
              <SelectItem value="pre-engage">Pre-engage</SelectItem>
              <SelectItem value="engage">Engage</SelectItem>
              <SelectItem value="advanced-engaged">Advanced Engaged</SelectItem>
              <SelectItem value="action">Action</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground shrink-0">Score</span>
            <Input
              type="number"
              min={0}
              max={200}
              placeholder="Min"
              value={scoreMin}
              onChange={e => { setScoreMin(e.target.value); setSelectedIds(new Set()); setPage(1); }}
              className="h-8 text-sm w-20"
            />
            <span className="text-xs text-muted-foreground">–</span>
            <Input
              type="number"
              min={0}
              max={200}
              placeholder="Max"
              value={scoreMax}
              onChange={e => { setScoreMax(e.target.value); setSelectedIds(new Set()); setPage(1); }}
              className="h-8 text-sm w-20"
            />
          </div>
          <div className="relative">
            <Tag className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={tagFilter}
              onChange={e => { setTagFilter(e.target.value); setPage(1); }}
              placeholder="Filter by tag…"
              className="pl-8 h-8 text-sm w-40"
            />
          </div>
          <div className="relative">
            <Hash className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={identifierFilter}
              onChange={e => { setIdentifierFilter(e.target.value); setSelectedIds(new Set()); setPage(1); }}
              placeholder="Filter by identifier…"
              className="pl-8 h-8 text-sm w-44"
            />
          </div>
          <Select value={callOutcomeFilter} onValueChange={v => { setCallOutcomeFilter(v); setSelectedIds(new Set()); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-44">
              <SelectValue placeholder="All call outcomes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All call outcomes</SelectItem>
              <SelectItem value="answered">✅ Answered (≥ 30s)</SelectItem>
              <SelectItem value="short_call">⚡ Picked up briefly (&lt; 30s)</SelectItem>
              <SelectItem value="not_answered">❌ Not answered</SelectItem>
              <SelectItem value="voicemail">📭 Voicemail</SelectItem>
              <SelectItem value="busy">🚫 Busy / No answer</SelectItem>
              <SelectItem value="never_called">🔕 Never called</SelectItem>
            </SelectContent>
          </Select>
          <Select value={campaignTypeFilter} onValueChange={v => { setCampaignTypeFilter(v); setSelectedIds(new Set()); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-40">
              <SelectValue placeholder="All campaign types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign types</SelectItem>
              <SelectItem value="call">📞 Call campaigns</SelectItem>
              <SelectItem value="email">✉️ Email sequences</SelectItem>
            </SelectContent>
          </Select>
          <Select value={dncFilter} onValueChange={v => { setDncFilter(v); setSelectedIds(new Set()); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm w-36">
              <SelectValue placeholder="DNC status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All contacts</SelectItem>
              <SelectItem value="dnc">🚫 DNC only</SelectItem>
              <SelectItem value="non-dnc">✅ Non-DNC only</SelectItem>
            </SelectContent>
          </Select>
          {(stageFilter !== "all" || scoreMin || scoreMax || tagFilter || identifierFilter || callOutcomeFilter !== "all" || campaignTypeFilter !== "all" || dncFilter !== "all") && (
            <button
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              onClick={() => { setStageFilter("all"); setScoreMin(""); setScoreMax(""); setTagFilter(""); setIdentifierFilter(""); setCallOutcomeFilter("all"); setCampaignTypeFilter("all"); setDncFilter("all"); setPage(1); }}
            >
              <X className="w-3 h-3" /> Clear filters
            </button>
          )}
        </div>

        {/* Date range row */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium shrink-0">
            <Calendar className="w-3.5 h-3.5" /> Created
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">From</span>
            <input
              type="date"
              value={createdFrom}
              max={createdTo || undefined}
              onChange={e => { setCreatedFrom(e.target.value); setSelectedIds(new Set()); setPage(1); }}
              className="h-8 text-sm border border-input rounded-md px-2 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500 w-36"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">To</span>
            <input
              type="date"
              value={createdTo}
              min={createdFrom || undefined}
              onChange={e => { setCreatedTo(e.target.value); setSelectedIds(new Set()); setPage(1); }}
              className="h-8 text-sm border border-input rounded-md px-2 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500 w-36"
            />
          </div>
          {(createdFrom || createdTo) && (
            <button
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              onClick={() => { setCreatedFrom(""); setCreatedTo(""); }}
            >
              <X className="w-3 h-3" /> Clear dates
            </button>
          )}
          {(formFilter !== "all" || intentStateFilter !== "all" || playFilter !== "all" || journeyFilter !== "all" || segmentFilter !== "all" || createdFrom || createdTo || stageFilter !== "all" || scoreMin || scoreMax || tagFilter || callOutcomeFilter !== "all" || campaignTypeFilter !== "all" || dncFilter !== "all") && (
            <button
              className="text-xs text-indigo-600 hover:text-indigo-800 underline underline-offset-2 ml-auto"
              onClick={() => {
                setFormFilter("all");
                setIntentStateFilter("all");
                setPlayFilter("all");
                setJourneyFilter("all");
                setSegmentFilter("all");
                setCreatedFrom("");
                setCreatedTo("");
                setStageFilter("all");
                setScoreMin("");
                setScoreMax("");
                setTagFilter("");
                setCallOutcomeFilter("all");
                setCampaignTypeFilter("all");
                setDncFilter("all");
                setPage(1);
              }}
            >
              Clear all filters
            </button>
          )}
        </div>

        {/* Bulk action bar */}
        {selectedCount > 0 && (
          <div className="flex items-center gap-3 mb-3 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg">
            <CheckSquare className="w-4 h-4 text-indigo-600 shrink-0" />
            <span className="text-sm font-medium text-indigo-700">
              {selectedCount} contact{selectedCount !== 1 ? "s" : ""} selected
            </span>
            {selectedDncIds.length > 0 && (
              <span className="flex items-center gap-1 text-xs font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded px-2 py-0.5">
                <PhoneOff className="w-3 h-3 shrink-0" />
                {selectedDncIds.length} DNC — will be skipped from call campaigns
              </span>
            )}
            <div className="flex items-center gap-2 ml-auto">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                onClick={() => setCallCampaignModalOpen(true)}
              >
                <PhoneCall className="w-3.5 h-3.5 mr-1.5" />
                New call campaign
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-violet-200 text-violet-700 hover:bg-violet-50"
                onClick={() => {
                  setAddToSegmentContactIds(Array.from(selectedIds));
                  setAddToSegmentOpen(true);
                }}
              >
                <Layers className="w-3.5 h-3.5 mr-1.5" />
                Add to segment
              </Button>
              <Button
                size="sm"
                className="bg-indigo-600 hover:bg-indigo-700 h-7 text-xs"
                onClick={() => setEnrollModalOpen(true)}
              >
                <ListChecks className="w-3.5 h-3.5 mr-1.5" />
                Add to email sequence
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-orange-200 text-orange-700 hover:bg-orange-50"
                disabled={bulkDncMutation.isPending}
                onClick={() => bulkDncMutation.mutate(Array.from(selectedIds))}
              >
                <PhoneOff className="w-3.5 h-3.5 mr-1.5" />
                {bulkDncMutation.isPending ? "Marking…" : "Mark as DNC"}
              </Button>
              {selectedDncIds.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-green-200 text-green-700 hover:bg-green-50"
                  disabled={bulkRemoveDncMutation.isPending}
                  onClick={() => bulkRemoveDncMutation.mutate(selectedDncIds)}
                >
                  <PhoneOff className="w-3.5 h-3.5 mr-1.5" />
                  {bulkRemoveDncMutation.isPending ? "Removing…" : `Remove DNC (${selectedDncIds.length})`}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs text-destructive hover:text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={() => setBulkDeleteConfirmOpen(true)}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Delete
              </Button>
              <button
                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                onClick={() => setSelectedIds(new Set())}
              >
                <X className="w-3 h-3" /> Clear
              </button>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="border rounded-lg overflow-hidden bg-card">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="py-2.5 px-4 w-10">
                  <Checkbox
                    checked={allFilteredSelected || (someFilteredSelected ? "indeterminate" : false)}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                  />
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Contact</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Email</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Company</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Identifier</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">
                  {journeyFilter !== "all" ? (
                    <span className="text-indigo-600">Journey Score</span>
                  ) : "Score"}
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Intent</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Intent Score</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Forms</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Plays</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Tags</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 w-10" />
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={13} className="py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={13} className="py-12 text-center text-sm text-muted-foreground">No contacts found</td></tr>
              )}
              {filtered.map(c => (
                <tr key={c.id}
                  className={cn(
                    "border-b last:border-0 hover:bg-muted/40 cursor-pointer transition-colors",
                    selectedIds.has(c.id) && "bg-indigo-50/60"
                  )}
                  onClick={() => navigate(`/crm/contacts/${c.id}`)}>
                  <td className="py-3 px-4" onClick={e => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(c.id)}
                      onCheckedChange={() => toggleOne(c.id)}
                      aria-label={`Select ${c.firstName} ${c.lastName}`}
                    />
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold shrink-0">
                        {initials(c)}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium">{c.firstName} {c.lastName}</p>
                          {c.dnc && (
                            <span className="inline-flex items-center gap-0.5 rounded px-1 py-0 text-[10px] font-bold bg-red-100 text-red-700 border border-red-200 leading-4 shrink-0">
                              <PhoneOff className="w-2.5 h-2.5" />DNC
                            </span>
                          )}
                        </div>
                        {c.title && <p className="text-xs text-muted-foreground">{c.title}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4 text-sm text-muted-foreground">{c.email}</td>
                  <td className="py-3 px-4">
                    {c.companyName ? (
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Building2 className="w-3 h-3" />
                        {c.companyName}
                      </div>
                    ) : <span className="text-muted-foreground/50 text-sm">—</span>}
                  </td>
                  <td className="py-3 px-4">
                    {c.identifier
                      ? <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded border text-foreground">{c.identifier}</span>
                      : <span className="text-muted-foreground/50 text-sm">—</span>}
                  </td>
                  <td className="py-3 px-4">
                    {(() => {
                      const sd = scoreDeltas[c.id];
                      const deltaBadge = sd && sd.delta !== 0 ? (
                        <span
                          title={`Score changed: ${sd.oldScore} → ${sd.newScore} (${sd.delta > 0 ? "+" : ""}${sd.delta})\nSource: ${sd.source ?? "recompute"}\n${new Date(sd.createdAt).toLocaleString()}`}
                          className={cn(
                            "inline-flex items-center rounded text-[10px] font-semibold px-1 py-0 leading-4 cursor-default select-none",
                            sd.delta > 0
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-red-50 text-red-600"
                          )}
                        >
                          {sd.delta > 0 ? "+" : ""}{sd.delta}
                        </span>
                      ) : null;
                      if (journeyFilter !== "all") {
                        return (
                          <div className="flex items-center gap-1">
                            <span className={cn(
                              "inline-flex items-center gap-1 rounded-full font-medium px-2 py-0.5 text-xs",
                              "bg-indigo-50 text-indigo-700"
                            )}>
                              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                              {c.journeyScore ?? 0} pts
                            </span>
                            {deltaBadge}
                          </div>
                        );
                      }
                      if (c.intentState && INTENT_HEAT_MAP[c.intentState]) {
                        const heat = INTENT_HEAT_MAP[c.intentState];
                        return (
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1">
                              <span className={cn(
                                "inline-flex items-center gap-1 rounded-full font-medium px-2 py-0.5 text-xs",
                                heat.bg, heat.text
                              )}>
                                <span className={cn("w-1.5 h-1.5 rounded-full", heat.dot)} />
                                {c.combinedScore}
                                <span className="opacity-70">· {heat.label}</span>
                              </span>
                              {deltaBadge}
                            </div>
                            {c.phoneScore != null && (
                              <span className="text-[10px] text-muted-foreground pl-1">
                                ABM {c.leadScore} + 📞 {c.phoneScore * 10}
                              </span>
                            )}
                          </div>
                        );
                      }
                      return (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1">
                            <ScoreBadge score={c.combinedScore} thresholds={thresholds} showLabel />
                            {deltaBadge}
                          </div>
                          {c.phoneScore != null && (
                            <span className="text-[10px] text-muted-foreground">
                              ABM {c.leadScore} + 📞 {c.phoneScore * 10}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="py-3 px-4">
                    {c.intentState ? (() => {
                      const cfg = INTENT_STATE_CONFIG[c.intentState] ?? INTENT_STATE_CONFIG["Browsing"];
                      return (
                        <span className={cn(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border",
                          cfg.badge
                        )}>
                          <span>{cfg.icon}</span>
                          <span>{c.intentState}</span>
                        </span>
                      );
                    })() : (
                      <span className="text-muted-foreground/40 text-sm">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm tabular-nums">
                    {c.intentScore != null ? (
                      <span className={cn(
                        "font-semibold",
                        c.intentScore >= 80 ? "text-red-600" :
                        c.intentScore >= 50 ? "text-orange-500" :
                        c.intentScore >= 30 ? "text-blue-500" :
                        "text-muted-foreground"
                      )}>
                        {c.intentScore}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <button
                      className={cn(
                        "flex items-center gap-1.5 text-sm font-medium transition-colors",
                        c.formSubmissionCount > 0
                          ? "text-indigo-600 hover:text-indigo-800"
                          : "text-muted-foreground/50 cursor-default"
                      )}
                      onClick={e => {
                        if (c.formSubmissionCount === 0) return;
                        e.stopPropagation();
                        navigate(`/crm/contacts/${c.id}?tab=forms`);
                      }}
                    >
                      <ClipboardList className="w-3.5 h-3.5" />
                      {c.formSubmissionCount}
                    </button>
                  </td>
                  <td className="py-3 px-4">
                    <button
                      className={cn(
                        "flex items-center gap-1.5 text-sm font-medium transition-colors",
                        c.playCount > 0
                          ? "text-indigo-600 hover:text-indigo-800"
                          : "text-muted-foreground/50 cursor-default"
                      )}
                      onClick={e => {
                        if (c.playCount === 0) return;
                        e.stopPropagation();
                        navigate(`/crm/contacts/${c.id}?tab=plays`);
                      }}
                    >
                      <Megaphone className="w-3.5 h-3.5" />
                      {c.playCount}
                    </button>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap gap-1">
                      {c.stage && (
                        <Badge key="__stage__" className="text-xs py-0 px-1.5 bg-indigo-50 text-indigo-700 border border-indigo-200 font-medium">
                          {formatStage(c.stage)}
                        </Badge>
                      )}
                      {c.tags.filter(t => !STAGE_KEYS.has(t)).slice(0, 3).map(t => (
                        <Badge key={t} variant="outline" className="text-xs py-0 px-1.5">{t}</Badge>
                      ))}
                      {c.tags.filter(t => !STAGE_KEYS.has(t)).length > 3 && (
                        <span className="text-xs text-muted-foreground">+{c.tags.filter(t => !STAGE_KEYS.has(t)).length - 3}</span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant={c.status === "active" ? "default" : "secondary"} className="text-xs capitalize">
                        {c.status}
                      </Badge>
                      {c.dnc && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-red-50 text-red-700 border-red-200 font-semibold">
                          <PhoneOff className="w-2.5 h-2.5 mr-0.5" />DNC
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4" onClick={e => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => navigate(`/crm/contacts/${c.id}`)}>
                          View contact
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setAddToSegmentContactIds([c.id]);
                            setAddToSegmentOpen(true);
                          }}
                        >
                          <Layers className="w-3.5 h-3.5 mr-2" />
                          Add to segment
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => dncMutation.mutate({ id: c.id, dnc: !c.dnc })}
                          disabled={dncMutation.isPending}
                        >
                          <PhoneOff className="w-3.5 h-3.5 mr-2" />
                          {c.dnc ? "Remove from DNC list" : "Mark as DNC"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteContactId(c.id)}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalCount > 0 && (
          <div className="flex items-center justify-between mt-3 text-sm text-muted-foreground">
            <span>
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, totalCount)} of {totalCount.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="text-xs">Page {page} of {totalPages}</span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={page >= totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Enroll in sequence modal */}
      <Dialog open={enrollModalOpen} onOpenChange={open => { setEnrollModalOpen(open); if (!open) { setSelectedSequenceId(""); setReEnrollCompleted(false); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Enroll in sequence</DialogTitle>
            <DialogDescription>
              {selectedCount} contact{selectedCount !== 1 ? "s" : ""} selected. Contacts already actively enrolled will be skipped.
            </DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground block mb-2">Choose a sequence</label>
              {sequences.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sequences found. Create one first.</p>
              ) : (
                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {sequences.map(seq => (
                    <button
                      key={seq.id}
                      type="button"
                      className={cn(
                        "w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors",
                        selectedSequenceId === String(seq.id)
                          ? "border-indigo-500 bg-indigo-50 text-indigo-900"
                          : "border-border hover:bg-muted/50"
                      )}
                      onClick={() => setSelectedSequenceId(String(seq.id))}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">{seq.name}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge
                            variant={seq.status === "active" ? "default" : "secondary"}
                            className="text-xs capitalize"
                          >
                            {seq.status}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{seq.enrolledCount} enrolled</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                checked={reEnrollCompleted}
                onChange={e => setReEnrollCompleted(e.target.checked)}
              />
              <div>
                <span className="text-sm font-medium text-foreground">Re-enroll completed contacts</span>
                <p className="text-xs text-muted-foreground">Contacts who already finished this sequence will be re-started from step 1.</p>
              </div>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setEnrollModalOpen(false); setSelectedSequenceId(""); setReEnrollCompleted(false); }}>
              Cancel
            </Button>
            <Button
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!selectedSequenceId || bulkEnrollMutation.isPending}
              onClick={handleConfirmEnroll}
            >
              {bulkEnrollMutation.isPending
                ? "Enrolling…"
                : `Enroll ${selectedCount} contact${selectedCount !== 1 ? "s" : ""}${chosenSequence ? ` in "${chosenSequence.name}"` : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NewContactDialog open={newOpen} onClose={() => setNewOpen(false)} />

      {/* Single delete confirmation */}
      <Dialog open={deleteContactId !== null} onOpenChange={o => { if (!o) setDeleteContactId(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete contact?</DialogTitle>
            <DialogDescription>
              This will permanently remove{" "}
              <strong>
                {(() => { const c = contacts.find(x => x.id === deleteContactId); return c ? `${c.firstName} ${c.lastName}` : "this contact"; })()}
              </strong>{" "}
              and all their associated data. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteContactId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteContactId !== null && deleteMutation.mutate(deleteContactId)}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportCsvDialog open={importOpen} onClose={() => setImportOpen(false)} />

      {/* New call campaign dialog */}
      <Dialog
        open={callCampaignModalOpen}
        onOpenChange={open => { setCallCampaignModalOpen(open); if (!open) setNewCampaignName(""); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PhoneCall className="w-4 h-4 text-indigo-600" />
              New call campaign
            </DialogTitle>
            <DialogDescription>
              Create a new call campaign with the {selectedCount} selected contact{selectedCount !== 1 ? "s" : ""}. The campaign will be created as a draft — you can configure the script and start it from the Call Campaigns page.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="campaign-name">Campaign name <span className="text-red-500">*</span></Label>
              <Input
                id="campaign-name"
                value={newCampaignName}
                onChange={e => setNewCampaignName(e.target.value)}
                placeholder="e.g. Q3 Outreach — No-answer retry"
                autoFocus
                onKeyDown={e => {
                  if (e.key === "Enter" && newCampaignName.trim() && !createCallCampaignMutation.isPending) {
                    createCallCampaignMutation.mutate({ name: newCampaignName.trim(), contactIds: Array.from(selectedIds) });
                  }
                }}
              />
            </div>
            <div className="rounded-lg bg-muted/40 border px-3 py-2 text-xs text-muted-foreground flex items-start gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500 shrink-0 mt-0.5" />
              <span>
                {selectedCount} contact{selectedCount !== 1 ? "s" : ""} will be added immediately. The campaign status is <strong>draft</strong> until you start it.
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCallCampaignModalOpen(false); setNewCampaignName(""); }}>
              Cancel
            </Button>
            <Button
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!newCampaignName.trim() || createCallCampaignMutation.isPending}
              onClick={() => createCallCampaignMutation.mutate({ name: newCampaignName.trim(), contactIds: Array.from(selectedIds) })}
            >
              {createCallCampaignMutation.isPending
                ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Creating…</>
                : `Create campaign with ${selectedCount} contact${selectedCount !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirmation */}
      <Dialog open={bulkDeleteConfirmOpen} onOpenChange={setBulkDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {selectedCount} contact{selectedCount !== 1 ? "s" : ""}?</DialogTitle>
            <DialogDescription>
              This will permanently remove {selectedCount} contact{selectedCount !== 1 ? "s" : ""} and all their associated data. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setBulkDeleteConfirmOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={bulkDeleteMutation.isPending}
              onClick={() => bulkDeleteMutation.mutate(Array.from(selectedIds))}
            >
              {bulkDeleteMutation.isPending ? "Deleting…" : `Delete ${selectedCount} contact${selectedCount !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddToSegmentDialog
        contactIds={addToSegmentContactIds}
        open={addToSegmentOpen}
        onOpenChange={setAddToSegmentOpen}
        onSuccess={() => setSelectedIds(new Set())}
      />
    </div>
  );
}

function NewContactDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");

  const { data: clients = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["clients"],
    queryFn: () => api("/clients"),
    enabled: open,
  });

  const { data: companies = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["companies"],
    queryFn: () => api("/companies"),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/contacts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: parseInt(clientId),
          companyId: companyId ? parseInt(companyId) : null,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim() || null,
          title: title.trim() || null,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? "Failed to create contact");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast({ title: "Contact created" });
      handleClose();
    },
    onError: (e: Error) => toast({ title: "Failed to create contact", description: e.message, variant: "destructive" }),
  });

  const handleClose = () => {
    setClientId(""); setCompanyId(""); setFirstName(""); setLastName("");
    setEmail(""); setPhone(""); setTitle("");
    onClose();
  };

  const canSubmit =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    /.+@.+\..+/.test(email.trim()) &&
    clientId !== "" &&
    !create.isPending;

  return (
    <Dialog open={open} onOpenChange={o => !o && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New Contact</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>Client *</Label>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger><SelectValue placeholder="Select a client" /></SelectTrigger>
              <SelectContent>
                {clients.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>First name *</Label>
              <Input value={firstName} onChange={e => setFirstName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Last name *</Label>
              <Input value={lastName} onChange={e => setLastName(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Email *</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@acme.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={phone} onChange={e => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="VP Marketing" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Company</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger><SelectValue placeholder="— No company —" /></SelectTrigger>
              <SelectContent>
                {companies.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button className="bg-indigo-600 hover:bg-indigo-700" disabled={!canSubmit} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create Contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const IMPORT_TEMPLATE_CSV =
  "first_name,last_name,email,phone,title,company,designation,function,employee_size,city,state,country\n" +
  "Jane,Smith,jane@example.com,+1-555-0100,VP Marketing,Acme Corp,Director,Marketing,500,New York,NY,USA\n" +
  "John,Doe,,+91-9876543210,Sales Director,Beta Ltd,Manager,Sales,,Mumbai,,India";

type ImportFileResult = { imported: number; updated: number; skipped: number };
type ImportDialogStep = "select" | "mapping" | "result";

function ImportCsvDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState<ImportDialogStep>("select");
  const [file, setFile] = useState<File | null>(null);
  const [clientId, setClientId] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [unknownHeaders, setUnknownHeaders] = useState<string[]>([]);
  const [colMappings, setColMappings] = useState<Record<string, ColMapping>>({});
  const [result, setResult] = useState<ImportFileResult | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const { data: clients = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["clients"],
    queryFn: () => fetch("/api/clients", { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });

  function handleClose() {
    setStep("select"); setFile(null); setClientId(""); setIdentifier(""); setUnknownHeaders([]); setColMappings({});
    setResult(null); setServerErrors([]); setLoading(false);
    onClose();
  }

  async function handlePrimaryAction() {
    if (!file || !clientId) return;
    if (step === "select") {
      setLoading(true);
      setServerErrors([]);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/contacts/import/preview", {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) {
          const errs: string[] = [...(data.headerErrors ?? []), ...(data.errors ?? [])];
          setServerErrors(errs.length > 0 ? errs : ["Failed to read the file."]);
          return;
        }
        const headers: string[] = data.unknownHeaders ?? [];
        if (headers.length > 0) {
          setUnknownHeaders(headers);
          setColMappings(Object.fromEntries(headers.map(h => [h, { action: "ignore" as MappingAction }])));
          setStep("mapping");
          return;
        }
        await runImport({});
      } catch {
        setServerErrors(["Unexpected error — please try again."]);
      } finally {
        setLoading(false);
      }
    } else if (step === "mapping") {
      await runImport(colMappings);
    }
  }

  async function runImport(mappings: Record<string, ColMapping>) {
    if (!file || !clientId) return;
    setLoading(true);
    setServerErrors([]);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("clientId", clientId);
      if (identifier.trim()) {
        fd.append("identifier", identifier.trim());
      }
      if (Object.keys(mappings).length > 0) {
        fd.append("columnMappings", JSON.stringify(mappings));
      }
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) {
        const errs: string[] = Array.isArray(data.errors) ? data.errors : [data.error ?? "Import failed"];
        setServerErrors(errs);
        return;
      }
      setResult(data as ImportFileResult);
      setStep("result");
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast({ title: `Import complete — ${data.imported} created, ${data.updated} updated` });
    } catch {
      setServerErrors(["Unexpected error — please try again."]);
    } finally {
      setLoading(false);
    }
  }

  const canProceed = !!file && !!clientId && !loading
    && (step !== "mapping" || Object.values(colMappings).every(m => m.action !== "map" || !!m.mapTo));

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Import Contacts
            {step === "mapping" && <span className="ml-2 text-xs font-normal text-muted-foreground">Step 2 of 2 — Map Columns</span>}
          </DialogTitle>
          <DialogDescription>
            Upload a <strong>CSV, XLS, or XLSX</strong> file. Each row needs at least an email or phone number. Columns are auto-detected from the header row.
          </DialogDescription>
        </DialogHeader>

        {step === "select" && (
          <div className="space-y-4">
            {/* Template download */}
            <div className="flex items-center justify-between rounded-lg border border-dashed p-3 bg-muted/30">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Tag className="w-4 h-4 text-indigo-500" />
                <span>Download template to see all supported columns.</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => {
                const blob = new Blob([IMPORT_TEMPLATE_CSV], { type: "text/csv" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "contacts-template.csv";
                a.click();
              }}>
                <Download className="w-3.5 h-3.5 mr-1.5" /> Template
              </Button>
            </div>

            {/* Client selector */}
            <div className="space-y-1.5">
              <Label>Client <span className="text-red-500">*</span></Label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select a client…" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Identifier */}
            <div className="space-y-1.5">
              <Label>Identifier <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                placeholder="e.g. hp-list-jul-2026"
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Tags every contact in this upload with this value — separate from regular tags — so you can segment contacts later by which file they came from.
                If your file has its own identifier column, leave this blank and map that column to "Identifier" on the next step instead.
              </p>
            </div>

            {/* File drop zone */}
            <label className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 cursor-pointer transition-colors ${file ? "border-indigo-400 bg-indigo-50/40" : "border-muted-foreground/30 hover:border-indigo-400 hover:bg-indigo-50/20"}`}>
              <Upload className="w-6 h-6 text-muted-foreground" />
              {file
                ? <span className="text-sm font-medium text-indigo-700">{file.name}</span>
                : <>
                    <span className="text-sm text-muted-foreground">Click to choose a file</span>
                    <span className="text-xs text-muted-foreground/70">.csv, .xls, .xlsx — up to 15 MB</span>
                  </>
              }
              <input type="file" accept=".csv,.xls,.xlsx" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) { setFile(f); setServerErrors([]); setUnknownHeaders([]); setColMappings({}); } e.target.value = ""; }} />
            </label>

            {/* Server-side errors */}
            {serverErrors.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-1">
                {serverErrors.map((e, i) => (
                  <p key={i} className="text-sm text-red-700 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />{e}
                  </p>
                ))}
              </div>
            )}

            {/* Supported columns hint */}
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Auto-detected columns:</span>{" "}
              first name, last name, email, phone, title, company, designation, function, employee size, city, state, country, linkedin url, identifier
            </div>
          </div>
        )}

        {step === "mapping" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Your file has <span className="font-medium text-foreground">{unknownHeaders.length}</span> column{unknownHeaders.length !== 1 ? "s" : ""} that aren't standard Kaboom fields.
              Choose what to do with each one:
            </p>
            <div className="space-y-3 max-h-[50vh] overflow-y-auto">
              {unknownHeaders.map(header => {
                const cur = colMappings[header] ?? { action: "ignore" as MappingAction };
                return (
                  <div key={header} className="rounded-lg border border-border p-3 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">{header}</span>
                      <span className="text-xs text-muted-foreground">— unknown column</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {(["map", "ignore", "custom"] as MappingAction[]).map(action => (
                        <button
                          key={action}
                          onClick={() => setColMappings(prev => ({ ...prev, [header]: { action } }))}
                          className={cn(
                            "text-xs rounded-md border px-2 py-1.5 text-left transition-colors",
                            cur.action === action
                              ? action === "map"   ? "border-indigo-400 bg-indigo-50 text-indigo-700 font-medium"
                              : action === "custom" ? "border-emerald-400 bg-emerald-50 text-emerald-700 font-medium"
                              : "border-gray-400 bg-gray-50 text-gray-700 font-medium"
                              : "border-border bg-background text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {action === "map"    && "Map to Kaboom field"}
                          {action === "ignore" && "Ignore this column"}
                          {action === "custom" && "Add as custom field"}
                        </button>
                      ))}
                    </div>
                    {cur.action === "map" && (
                      <select
                        className="w-full h-8 px-2 text-xs border rounded bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                        value={cur.mapTo ?? ""}
                        onChange={e => setColMappings(prev => ({
                          ...prev,
                          [header]: { action: "map", mapTo: e.target.value as ColMapping["mapTo"] },
                        }))}
                      >
                        <option value="">— Select a Kaboom field —</option>
                        {KABOOM_FIELDS.map(f => (
                          <option key={f.key} value={f.key}>{f.label}</option>
                        ))}
                      </select>
                    )}
                    {cur.action === "ignore" && (
                      <p className="text-[11px] text-muted-foreground">This column will be skipped during import.</p>
                    )}
                    {cur.action === "custom" && (
                      <p className="text-[11px] text-emerald-700">
                        Values will be saved as a custom field named <span className="font-mono font-medium">"{header}"</span> on each contact.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Server-side errors */}
            {serverErrors.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-1">
                {serverErrors.map((e, i) => (
                  <p key={i} className="text-sm text-red-700 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />{e}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {step === "result" && result && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Created",  value: result.imported, color: "text-green-700 bg-green-50 border-green-200" },
                { label: "Updated",  value: result.updated,  color: "text-blue-700 bg-blue-50 border-blue-200" },
                { label: "Skipped",  value: result.skipped,  color: result.skipped ? "text-amber-700 bg-amber-50 border-amber-200" : "text-muted-foreground bg-muted/30 border-border" },
              ].map(s => (
                <div key={s.label} className={`rounded-lg border p-3 text-center ${s.color}`}>
                  <div className="text-2xl font-bold">{s.value}</div>
                  <div className="text-xs font-medium mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>
            {result.skipped > 0 && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
                Skipped rows had no email or phone number, a duplicate, or a formatting error.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {step !== "result" ? (
            <>
              <Button variant="outline" onClick={step === "mapping" ? () => { setStep("select"); setServerErrors([]); } : handleClose}>
                {step === "mapping" ? "Back" : "Cancel"}
              </Button>
              <Button className="bg-indigo-600 hover:bg-indigo-700" disabled={!canProceed} onClick={handlePrimaryAction}>
                {loading ? "Importing…" : step === "mapping" ? "Import" : "Continue"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => { setFile(null); setResult(null); setServerErrors([]); }}>
                Import another file
              </Button>
              <Button className="bg-indigo-600 hover:bg-indigo-700" onClick={handleClose}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
