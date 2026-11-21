import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Users, Building2, Layers, Plus, Trash2, Loader2,
  RefreshCw, User, Search, ChevronDown, ChevronRight,
  Unplug, GitBranch, CheckCircle, AlertCircle, List,
  Download, Mail, Play,
} from "lucide-react";
import { RunWizard } from "@/pages/sequences/RunWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

type JourneyContact = {
  id: number; first_name: string; last_name: string; email: string;
  title: string | null; company_name: string | null;
  lead_score: number; stage: string | null; tags: string[];
  added_via: string; added_at: string; segment_name: string | null;
  sequence_status: string | null;
  activity_count: number;
};
type JourneyCompany = {
  id: number; added_at: string; company_id: number; name: string; industry: string | null; contact_count: number;
};
type JourneySegment = {
  id: number; segment_id: number; segment_name: string; segment_type: string;
  last_computed_count: number; snapshot_mode: boolean; last_synced_at: string | null;
};
type Stats = {
  manual_count: number;
  company_count: number;
  segment_contact_count: number;
  attached_segment_count: number;
  active_sequence_count: number;
  completed_sequence_count: number;
};

type AllContact = { id: number; firstName: string; lastName: string; email: string; leadScore: number };
type AllCompany = { id: number; name: string };
type AllSegment = { id: number; name: string; last_computed_count: number; segment_type: string };
type EmailSequence = { id: number; name: string; status: string; stepCount: number };

type SegmentPreview = {
  contacts: Array<{ id: number; first_name: string; last_name: string; email: string; lead_score: number; company_name: string | null }>;
  total: number;
};

interface ContactsTabProps { journeyId: number }

// ── Small helpers ──────────────────────────────────────────────────────────────

function AddedViaBadge({ via, segName }: { via: string; segName: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    manual:        { label: "Manual",                             cls: "bg-slate-100 text-slate-700" },
    segment:       { label: segName ? `Seg: ${segName}` : "Segment", cls: "bg-violet-100 text-violet-700" },
    company:       { label: "Company",                           cls: "bg-sky-100 text-sky-700" },
    routing_rule:  { label: "Rule",                              cls: "bg-amber-100 text-amber-700" },
  };
  const cfg = map[via] ?? { label: via, cls: "bg-gray-100 text-gray-700" };
  return (
    <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap", cfg.cls)}>
      {cfg.label}
    </span>
  );
}

function SeqStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-[10px] text-muted-foreground">—</span>;
  const cls: Record<string, string> = {
    active:    "bg-emerald-100 text-emerald-700",
    completed: "bg-blue-100 text-blue-700",
    paused:    "bg-amber-100 text-amber-700",
    failed:    "bg-red-100 text-red-700",
  };
  return (
    <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full capitalize", cls[status] ?? "bg-gray-100 text-gray-700")}>
      {status}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ContactsTab({ journeyId }: ContactsTabProps) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [addSection, setAddSection] = useState<"contact" | "company" | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [openSections, setOpenSections] = useState({
    manual: true, company: true, segment: true, all: false,
  });
  const [contactPage, setContactPage] = useState(1);
  const CONTACT_LIMIT = 50;

  // Segment assignment modal
  const [segModalOpen, setSegModalOpen] = useState(false);
  const [segSearch, setSegSearch] = useState("");
  const [previewSegId, setPreviewSegId] = useState<number | null>(null);
  const [assignMode, setAssignMode] = useState<"live" | "snapshot">("live");
  const [dupHandling, setDupHandling] = useState<"skip" | "update">("skip");

  // Sync confirmation dialog
  const [syncConfirm, setSyncConfirm] = useState<{ segmentId: number; segmentName: string } | null>(null);
  const [syncRemoveMode, setSyncRemoveMode] = useState<"add_only" | "add_and_remove">("add_only");

  // Bulk selection
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());

  // Bulk enroll dialog
  const [enrollDialogOpen, setEnrollDialogOpen] = useState(false);
  const [selectedSeqId, setSelectedSeqId] = useState<number | null>(null);
  const [isEnrolling, setIsEnrolling] = useState(false);

  // Run Wizard
  const [runWizardOpen, setRunWizardOpen] = useState(false);

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: cData, isLoading: cLoading, isFetching: cFetching } = useQuery<{
    rows: JourneyContact[]; total: number; page: number; limit: number; stats: Stats;
  }>({
    queryKey: ["journey-contacts", journeyId, contactPage],
    queryFn: () => api(`/journeys/${journeyId}/contacts?page=${contactPage}`).then(r => r.json()),
    placeholderData: (prev) => prev,
  });
  const { data: companies = [] } = useQuery<JourneyCompany[]>({
    queryKey: ["journey-companies", journeyId],
    queryFn: () => api(`/journeys/${journeyId}/companies`).then(r => r.json()),
  });
  const { data: segments = [] } = useQuery<JourneySegment[]>({
    queryKey: ["journey-segments", journeyId],
    queryFn: () => api(`/journeys/${journeyId}/segments`).then(r => r.json()),
  });
  const { data: allContacts = [] } = useQuery<AllContact[]>({
    queryKey: ["contacts"],
    queryFn: () => api("/contacts").then(r => r.json()),
    enabled: addSection === "contact",
  });
  const { data: allCompanies = [] } = useQuery<AllCompany[]>({
    queryKey: ["companies"],
    queryFn: () => api("/companies").then(r => r.json()),
    enabled: addSection === "company",
  });
  const { data: allSegments = [] } = useQuery<AllSegment[]>({
    queryKey: ["segments"],
    queryFn: () => api("/segments").then(r => r.json()),
    enabled: segModalOpen,
  });
  const { data: allSequences = [] } = useQuery<EmailSequence[]>({
    queryKey: ["email-sequences"],
    queryFn: () => api("/email-sequences").then(r => r.json()),
    enabled: enrollDialogOpen,
  });

  // Segment preview in modal
  const { data: segPreview, isLoading: segPreviewLoading } = useQuery<SegmentPreview>({
    queryKey: ["segment-contacts-preview", previewSegId],
    queryFn: async () => {
      const res = await api(`/segments/${previewSegId}/contacts?page=1`);
      if (!res.ok) throw new Error(`Preview failed: ${res.status}`);
      return res.json();
    },
    enabled: !!previewSegId,
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const allRows = cData?.rows ?? [];
  const stats: Stats = cData?.stats ?? {
    manual_count: 0, company_count: 0, segment_contact_count: 0, attached_segment_count: 0,
    active_sequence_count: 0, completed_sequence_count: 0,
  };
  const total = cData?.total ?? 0;

  const manualContacts = allRows.filter(c =>
    c.added_via === "manual" || c.added_via === "routing_rule"
  );

  const availableContacts = allContacts.filter(c => {
    const already = allRows.some(jc => jc.id === c.id);
    if (already) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return `${c.firstName} ${c.lastName} ${c.email}`.toLowerCase().includes(q);
  });

  const availableSegments = allSegments.filter(
    s => !segments.some(js => js.segment_id === s.id)
  );

  // ── Mutations ──────────────────────────────────────────────────────────────

  const addContactMutation = useMutation({
    mutationFn: (contactId: number) => api(`/journeys/${journeyId}/contacts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactIds: [contactId] }),
    }).then(r => r.json()) as Promise<{ added: number; dncSkipped: number }>,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["journey-contacts", journeyId] });
      if (data.dncSkipped > 0) {
        toast({ title: "Contact not added — DNC", description: "This contact is on the Do Not Contact list.", variant: "destructive" });
      } else {
        toast({ title: "Contact added" });
      }
    },
    onError: () => toast({ title: "Failed to add contact", variant: "destructive" }),
  });

  const removeContactMutation = useMutation({
    mutationFn: (contactId: number) => api(`/journeys/${journeyId}/contacts/${contactId}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["journey-contacts", journeyId] }); toast({ title: "Contact removed" }); },
    onError: () => toast({ title: "Failed to remove contact", variant: "destructive" }),
  });

  const addCompanyMutation = useMutation({
    mutationFn: (companyId: number) => api(`/journeys/${journeyId}/companies`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyIds: [companyId] }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journey-companies", journeyId] });
      qc.invalidateQueries({ queryKey: ["journey-contacts", journeyId] });
      toast({ title: "Company added" });
    },
    onError: () => toast({ title: "Failed to add company", variant: "destructive" }),
  });

  const removeCompanyMutation = useMutation({
    mutationFn: (companyId: number) => api(`/journeys/${journeyId}/companies/${companyId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journey-companies", journeyId] });
      qc.invalidateQueries({ queryKey: ["journey-contacts", journeyId] });
      toast({ title: "Company removed" });
    },
  });

  const addSegmentMutation = useMutation({
    mutationFn: async (segmentId: number) => {
      const r = await api(`/journeys/${journeyId}/segments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segmentId, snapshotMode: assignMode === "snapshot", duplicateHandling: dupHandling }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error ?? r.statusText);
      return r.json() as Promise<{ ok: boolean; added: number; alreadyInJourney: number; dncSkipped: number; total: number }>;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["journey-segments", journeyId] });
      qc.invalidateQueries({ queryKey: ["journey-contacts", journeyId] });
      setSegModalOpen(false);
      const mode = assignMode === "snapshot" ? "snapshot" : "live";
      const dncNote = data.dncSkipped > 0 ? `, ${data.dncSkipped} DNC skipped` : "";
      toast({
        title: `Segment attached (${mode})`,
        description: `${data.added} contacts added${data.alreadyInJourney > 0 ? `, ${data.alreadyInJourney} already in journey` : ""}${dncNote}`,
      });
    },
    onError: () => toast({ title: "Failed to attach segment", variant: "destructive" }),
  });

  const syncSegmentMutation = useMutation({
    mutationFn: async ({ segmentId, removeNonMatching }: { segmentId: number; removeNonMatching: boolean }) => {
      const r = await api(`/journeys/${journeyId}/segments/${segmentId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeNonMatching }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error ?? r.statusText);
      return r.json() as Promise<{ added: number; removed: number; dncSkipped: number; total: number }>;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["journey-contacts", journeyId] });
      const dncNote = data.dncSkipped > 0 ? `, ${data.dncSkipped} DNC skipped` : "";
      toast({ title: `Sync complete — ${data.added} added, ${data.removed} removed${dncNote}` });
      setSyncConfirm(null);
    },
    onError: () => toast({ title: "Sync failed", variant: "destructive" }),
  });

  const removeSegmentMutation = useMutation({
    mutationFn: (segmentId: number) => api(`/journeys/${journeyId}/segments/${segmentId}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["journey-segments", journeyId] }); toast({ title: "Segment detached" }); },
  });

  // ── Bulk actions ───────────────────────────────────────────────────────────

  function toggleBulk(id: number, checked: boolean) {
    setBulkSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleBulkRemove() {
    const ids = Array.from(bulkSelected);
    for (const id of ids) {
      await api(`/journeys/${journeyId}/contacts/${id}`, { method: "DELETE" });
    }
    qc.invalidateQueries({ queryKey: ["journey-contacts", journeyId] });
    setBulkSelected(new Set());
    toast({ title: `${ids.length} contact${ids.length !== 1 ? "s" : ""} removed` });
  }

  async function handleBulkEnroll() {
    if (!selectedSeqId) return;
    setIsEnrolling(true);
    const ids = Array.from(bulkSelected);
    let enrolled = 0;
    let skippedDnc = 0;
    for (const id of ids) {
      try {
        const res = await api(`/email-sequences/${selectedSeqId}/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId: id }),
        });
        if (res.ok) {
          enrolled++;
        } else if (res.status === 422) {
          skippedDnc++;
        }
      } catch { /* skip failures */ }
    }
    qc.invalidateQueries({ queryKey: ["journey-contacts", journeyId] });
    setBulkSelected(new Set());
    setEnrollDialogOpen(false);
    setIsEnrolling(false);
    const seqName = allSequences.find(s => s.id === selectedSeqId)?.name ?? "sequence";
    const dncNote = skippedDnc > 0 ? ` (${skippedDnc} skipped — on DNC list)` : "";
    toast({ title: `${enrolled} contact${enrolled !== 1 ? "s" : ""} enrolled in "${seqName}"${dncNote}` });
  }

  function exportContacts(contacts: JourneyContact[], filename: string) {
    const headers = ["First Name", "Last Name", "Email", "Company", "Score", "Stage", "Added Via", "Seq. Status", "Activity Events"];
    const rows = contacts.map(c => [
      c.first_name, c.last_name, c.email, c.company_name ?? "",
      c.lead_score, c.stage ?? "", c.added_via,
      c.sequence_status ?? "—", c.activity_count ?? 0,
    ]);
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleBulkExport() {
    const selected = allRows.filter(c => bulkSelected.has(c.id));
    exportContacts(selected, `journey-${journeyId}-selected.csv`);
    setBulkSelected(new Set());
    toast({ title: `${selected.length} contacts exported` });
  }

  function handleExportAll() {
    exportContacts(allRows, `journey-${journeyId}-contacts.csv`);
    toast({ title: `${allRows.length} contacts exported` });
  }

  // ── Section header helper ──────────────────────────────────────────────────

  function SectionHeader({
    label, icon: Icon, count, sectionKey, action,
  }: {
    label: string; icon: React.ComponentType<any>; count: number;
    sectionKey: keyof typeof openSections;
    action?: React.ReactNode;
  }) {
    const open = openSections[sectionKey];
    return (
      <CollapsibleTrigger
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setOpenSections(s => ({ ...s, [sectionKey]: !open }))}
      >
        <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="flex-1 text-sm font-semibold text-foreground">{label}</span>
        <Badge variant="secondary" className="text-xs">{count}</Badge>
        {action}
        {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
      </CollapsibleTrigger>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-0">
      {/* ── Action bar ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-card">
        <p className="text-xs text-muted-foreground">Contact management for this journey</p>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setRunWizardOpen(true)}
        >
          <Play className="w-3 h-3" /> Launch Sequence
        </Button>
      </div>

      {/* ── KPI Header ── */}
      <div className="grid grid-cols-3 gap-2 p-4 border-b bg-card">
        {[
          { label: "Total Assigned",  value: total,                           icon: Users,     color: "text-indigo-600", bg: "bg-indigo-50" },
          { label: "From Segments",   value: stats.segment_contact_count,     icon: Layers,    color: "text-violet-600", bg: "bg-violet-50" },
          { label: "From Companies",  value: stats.company_count,             icon: Building2, color: "text-sky-600",    bg: "bg-sky-50" },
          { label: "Manual",          value: stats.manual_count,              icon: User,      color: "text-emerald-600", bg: "bg-emerald-50" },
          { label: "Active in Seq.",  value: stats.active_sequence_count,     icon: GitBranch, color: "text-amber-600",  bg: "bg-amber-50" },
          { label: "Seq. Completed",  value: stats.completed_sequence_count,  icon: CheckCircle, color: "text-green-600", bg: "bg-green-50" },
        ].map(kpi => (
          <div key={kpi.label} className="flex items-center gap-2 bg-muted/30 rounded-lg p-2.5">
            <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0", kpi.bg)}>
              <kpi.icon className={cn("w-3.5 h-3.5", kpi.color)} />
            </div>
            <div>
              <p className="text-base font-bold text-foreground leading-none">{kpi.value}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{kpi.label}</p>
            </div>
          </div>
        ))}
      </div>

      {cLoading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="divide-y">
          {/* ── Individual Contacts ── */}
          <Collapsible open={openSections.manual}>
            <SectionHeader
              label="Individual Contacts"
              icon={User}
              count={manualContacts.length}
              sectionKey="manual"
              action={
                <button
                  onClick={e => { e.stopPropagation(); setAddSection(a => a === "contact" ? null : "contact"); }}
                  className="ml-2 text-indigo-600 hover:text-indigo-800 p-1 rounded"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              }
            />
            <CollapsibleContent>
              {addSection === "contact" && (
                <div className="px-4 pb-3 bg-indigo-50/50 border-b">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Search & add contacts</p>
                  <div className="relative mb-2">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      className="pl-7 h-8 text-sm"
                      placeholder="Search by name or email..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                    />
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {availableContacts.slice(0, 20).map(c => (
                      <button
                        key={c.id}
                        onClick={() => addContactMutation.mutate(c.id)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white text-left text-sm"
                      >
                        <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                          <span className="text-[10px] font-bold text-indigo-700">{c.firstName[0]}{c.lastName[0]}</span>
                        </div>
                        <span className="flex-1 truncate">{c.firstName} {c.lastName}</span>
                        <span className="text-muted-foreground text-xs">{c.leadScore}</span>
                        <Plus className="w-3.5 h-3.5 text-indigo-600" />
                      </button>
                    ))}
                    {availableContacts.length === 0 && (
                      <p className="text-xs text-muted-foreground py-2 text-center">No contacts to add</p>
                    )}
                  </div>
                </div>
              )}
              {manualContacts.length === 0 ? (
                <p className="text-xs text-muted-foreground px-4 py-3 text-center">
                  No individual contacts yet — click + to add
                </p>
              ) : (
                <div className="divide-y">
                  {manualContacts.map(c => (
                    <div key={c.id} className="flex items-center gap-3 px-4 py-2.5 group hover:bg-muted/20">
                      <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                        <span className="text-[10px] font-bold text-indigo-700">{c.first_name[0]}{c.last_name[0]}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{c.first_name} {c.last_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{c.email}</p>
                      </div>
                      {c.company_name && (
                        <span className="text-xs text-muted-foreground hidden md:block">{c.company_name}</span>
                      )}
                      <span className="text-xs font-semibold text-indigo-600">{c.lead_score}</span>
                      <AddedViaBadge via={c.added_via} segName={c.segment_name} />
                      <button
                        onClick={() => removeContactMutation.mutate(c.id)}
                        className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all ml-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>

          {/* ── Companies ── */}
          <Collapsible open={openSections.company}>
            <SectionHeader
              label="Companies"
              icon={Building2}
              count={companies.length}
              sectionKey="company"
              action={
                <button
                  onClick={e => { e.stopPropagation(); setAddSection(a => a === "company" ? null : "company"); }}
                  className="ml-2 text-indigo-600 hover:text-indigo-800 p-1 rounded"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              }
            />
            <CollapsibleContent>
              {addSection === "company" && (
                <div className="px-4 pb-3 bg-indigo-50/50 border-b">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Add company — all its contacts will be included</p>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {allCompanies.filter(co => !companies.some(jco => jco.company_id === co.id)).map(co => (
                      <button
                        key={co.id}
                        onClick={() => addCompanyMutation.mutate(co.id)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white text-left text-sm"
                      >
                        <Building2 className="w-4 h-4 text-muted-foreground" />
                        <span className="flex-1">{co.name}</span>
                        <Plus className="w-3.5 h-3.5 text-indigo-600" />
                      </button>
                    ))}
                    {allCompanies.filter(co => !companies.some(jco => jco.company_id === co.id)).length === 0 && (
                      <p className="text-xs text-muted-foreground py-2 text-center">All companies already added</p>
                    )}
                  </div>
                </div>
              )}
              {companies.length === 0 ? (
                <p className="text-xs text-muted-foreground px-4 py-3 text-center">No companies — click + to add one</p>
              ) : (
                <div className="divide-y">
                  {companies.map(co => (
                    <div key={co.id} className="flex items-center gap-3 px-4 py-2.5 group hover:bg-muted/20">
                      <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-foreground">{co.name}</p>
                        <p className="text-xs text-muted-foreground">{co.contact_count} contacts · {co.industry ?? "—"}</p>
                      </div>
                      <button
                        onClick={() => removeCompanyMutation.mutate(co.company_id)}
                        className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>

          {/* ── Segments ── */}
          <Collapsible open={openSections.segment}>
            <SectionHeader
              label="Segments"
              icon={Layers}
              count={segments.length}
              sectionKey="segment"
              action={
                <button
                  onClick={e => { e.stopPropagation(); setPreviewSegId(null); setSegSearch(""); setAssignMode("live"); setSegModalOpen(true); }}
                  className="ml-2 text-indigo-600 hover:text-indigo-800 p-1 rounded"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              }
            />
            <CollapsibleContent>
              {segments.length === 0 ? (
                <p className="text-xs text-muted-foreground px-4 py-3 text-center">
                  No segments attached — click + to assign one
                </p>
              ) : (
                <div className="divide-y">
                  {segments.map(seg => (
                    <div key={seg.id} className="flex items-center gap-3 px-4 py-2.5 group hover:bg-muted/20">
                      <Layers className="w-4 h-4 text-indigo-500 shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-foreground">{seg.segment_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {seg.last_computed_count} contacts ·
                          {seg.last_synced_at
                            ? ` synced ${new Date(seg.last_synced_at).toLocaleDateString()}`
                            : " not synced yet"}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {seg.snapshot_mode ? "Snapshot" : "Live"}
                      </Badge>
                      {!seg.snapshot_mode && (
                        <button
                          onClick={() => { setSyncRemoveMode("add_only"); setSyncConfirm({ segmentId: seg.segment_id, segmentName: seg.segment_name }); }}
                          className="text-muted-foreground hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-all"
                          title="Sync now"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => removeSegmentMutation.mutate(seg.segment_id)}
                        className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Unplug className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>

          {/* ── Full Contact List ── */}
          <Collapsible open={openSections.all}>
            <SectionHeader
              label="All Contacts"
              icon={List}
              count={total}
              sectionKey="all"
            />
            <CollapsibleContent>
              {total === 0 ? (
                <p className="text-xs text-muted-foreground px-4 py-3 text-center">
                  No contacts assigned yet
                </p>
              ) : (
                <div>
                  {/* Bulk actions bar */}
                  {bulkSelected.size > 0 ? (
                    <div className="flex items-center gap-2 px-4 py-2 bg-indigo-50 border-b">
                      <span className="text-xs font-semibold text-indigo-700">{bulkSelected.size} selected</span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs px-2 border-destructive text-destructive hover:bg-destructive hover:text-white"
                        onClick={handleBulkRemove}
                      >
                        <Trash2 className="w-3 h-3 mr-1" />Remove
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs px-2"
                        onClick={() => { setSelectedSeqId(null); setEnrollDialogOpen(true); }}
                      >
                        <Mail className="w-3 h-3 mr-1" />Enroll in Sequence
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs px-2"
                        onClick={handleBulkExport}
                      >
                        <Download className="w-3 h-3 mr-1" />Export CSV
                      </Button>
                      <button
                        onClick={() => setBulkSelected(new Set())}
                        className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                      >
                        Clear
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/10">
                      <span className="text-xs text-muted-foreground">Select contacts for bulk actions</span>
                      <button
                        onClick={handleExportAll}
                        className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        title="Export all contacts as CSV"
                      >
                        <Download className="w-3 h-3" /> Export all
                      </button>
                    </div>
                  )}

                  {/* Table header */}
                  <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <div className="w-4 shrink-0">
                      <input
                        type="checkbox"
                        className="w-3 h-3 cursor-pointer"
                        checked={bulkSelected.size === allRows.length && allRows.length > 0}
                        onChange={e => {
                          if (e.target.checked) setBulkSelected(new Set(allRows.map(c => c.id)));
                          else setBulkSelected(new Set());
                        }}
                      />
                    </div>
                    <span className="flex-1">Contact</span>
                    <span className="w-24 hidden md:block">Company</span>
                    <span className="w-10 text-center">Score</span>
                    <span className="w-16 text-center hidden lg:block">Activities</span>
                    <span className="w-20 text-center hidden sm:block">Seq. Status</span>
                    <span className="w-24 hidden sm:block">Added via</span>
                    <span className="w-8 shrink-0" />
                  </div>

                  {/* Rows */}
                  <div className="divide-y max-h-[400px] overflow-y-auto" key={contactPage}>
                    {allRows.map(c => (
                      <div
                        key={c.id}
                        className={cn(
                          "flex items-center gap-2 px-4 py-2.5 group hover:bg-muted/20 transition-colors",
                          bulkSelected.has(c.id) && "bg-indigo-50/60"
                        )}
                      >
                        <div className="w-4 shrink-0">
                          <input
                            type="checkbox"
                            className="w-3 h-3 cursor-pointer"
                            checked={bulkSelected.has(c.id)}
                            onChange={e => toggleBulk(c.id, e.target.checked)}
                          />
                        </div>
                        <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                          <span className="text-[10px] font-bold text-indigo-700">
                            {c.first_name[0]}{c.last_name[0]}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{c.first_name} {c.last_name}</p>
                          <p className="text-xs text-muted-foreground truncate">{c.email}</p>
                        </div>
                        <span className="w-24 text-xs text-muted-foreground hidden md:block truncate">
                          {c.company_name ?? "—"}
                        </span>
                        <span className="w-10 text-center text-xs font-semibold text-indigo-600">
                          {c.lead_score}
                        </span>
                        <span className="w-16 text-center hidden lg:flex items-center justify-center">
                          <span className="text-xs text-muted-foreground">{c.activity_count ?? 0}</span>
                        </span>
                        <div className="w-20 hidden sm:flex items-center justify-center">
                          <SeqStatusBadge status={c.sequence_status} />
                        </div>
                        <div className="w-24 hidden sm:flex items-center">
                          <AddedViaBadge via={c.added_via} segName={c.segment_name} />
                        </div>
                        <button
                          onClick={() => removeContactMutation.mutate(c.id)}
                          className="w-8 flex items-center justify-center text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-all shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Pagination bar */}
                  {total > CONTACT_LIMIT && (
                    <div className="flex items-center justify-between px-4 py-2.5 border-t bg-muted/10">
                      <span className="text-xs text-muted-foreground">
                        {cFetching
                          ? "Loading…"
                          : `${Math.min((contactPage - 1) * CONTACT_LIMIT + 1, total)}–${Math.min(contactPage * CONTACT_LIMIT, total)} of ${total} contacts`}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          disabled={contactPage === 1 || cFetching}
                          onClick={() => { setContactPage(p => p - 1); setBulkSelected(new Set()); }}
                        >
                          ← Prev
                        </Button>
                        <span className="text-xs text-muted-foreground px-1">
                          {contactPage} / {Math.ceil(total / CONTACT_LIMIT)}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          disabled={contactPage * CONTACT_LIMIT >= total || cFetching}
                          onClick={() => { setContactPage(p => p + 1); setBulkSelected(new Set()); }}
                        >
                          Next →
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      {/* ── Sync Confirmation Dialog ── */}
      <Dialog open={!!syncConfirm} onOpenChange={() => setSyncConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Sync "{syncConfirm?.segmentName}"</DialogTitle>
          </DialogHeader>
          <div className="py-3 space-y-3">
            <p className="text-sm text-muted-foreground">
              This will re-evaluate the segment criteria and update contacts in this journey.
            </p>
            <div className="space-y-2">
              {(["add_only", "add_and_remove"] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setSyncRemoveMode(mode)}
                  className={cn(
                    "w-full text-left flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-sm transition-colors",
                    syncRemoveMode === mode
                      ? "bg-indigo-50 border-indigo-300 text-indigo-800"
                      : "bg-card border-border hover:border-muted-foreground"
                  )}
                >
                  <div className={cn(
                    "w-3.5 h-3.5 rounded-full border-2 mt-0.5 shrink-0",
                    syncRemoveMode === mode ? "border-indigo-600 bg-indigo-600" : "border-border"
                  )} />
                  <div>
                    <p className="font-medium text-xs">
                      {mode === "add_only" ? "Add new matches only" : "Add new + remove stale"}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {mode === "add_only"
                        ? "Contacts that no longer match criteria are kept in the journey."
                        : "Contacts that no longer match criteria are removed from the journey."}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setSyncConfirm(null)}>Cancel</Button>
            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={syncSegmentMutation.isPending}
              onClick={() => syncConfirm && syncSegmentMutation.mutate({
                segmentId: syncConfirm.segmentId,
                removeNonMatching: syncRemoveMode === "add_and_remove",
              })}
            >
              {syncSegmentMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Sync now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Enroll in Sequence Dialog ── */}
      <Dialog open={enrollDialogOpen} onOpenChange={setEnrollDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Enroll {bulkSelected.size} Contact{bulkSelected.size !== 1 ? "s" : ""} in Sequence</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2 max-h-64 overflow-y-auto">
            {allSequences.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">No sequences found</p>
            ) : allSequences.map(seq => (
              <button
                key={seq.id}
                onClick={() => setSelectedSeqId(seq.id)}
                className={cn(
                  "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors text-sm",
                  selectedSeqId === seq.id
                    ? "bg-indigo-50 border-indigo-300 text-indigo-800"
                    : "bg-card border-border hover:border-muted-foreground"
                )}
              >
                <GitBranch className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{seq.name}</p>
                  <p className="text-xs text-muted-foreground">{seq.stepCount} steps</p>
                </div>
                <Badge variant="secondary" className="text-[10px] capitalize">{seq.status}</Badge>
                {selectedSeqId === seq.id && <div className="w-2 h-2 rounded-full bg-indigo-600 shrink-0" />}
              </button>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setEnrollDialogOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!selectedSeqId || isEnrolling}
              onClick={handleBulkEnroll}
            >
              {isEnrolling && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Enroll Contacts
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Segment Assignment Modal ── */}
      <Dialog open={segModalOpen} onOpenChange={setSegModalOpen}>
        <DialogContent className="max-w-2xl p-0 overflow-hidden">
          <DialogHeader className="px-4 py-3 border-b">
            <DialogTitle className="text-sm font-semibold">Assign Segment to Journey</DialogTitle>
          </DialogHeader>
          <div className="flex h-[500px]">
            {/* Left: segment list + mode toggle */}
            <div className="w-64 border-r flex flex-col shrink-0">
              <div className="p-3 border-b space-y-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    className="pl-8 h-8 text-xs"
                    placeholder="Search segments..."
                    value={segSearch}
                    onChange={e => setSegSearch(e.target.value)}
                  />
                </div>
                {/* Assignment mode toggle */}
                <div className="flex gap-1">
                  {(["live", "snapshot"] as const).map(mode => (
                    <button
                      key={mode}
                      onClick={() => setAssignMode(mode)}
                      className={cn(
                        "flex-1 py-1 px-1.5 rounded border text-[10px] font-medium transition-all",
                        assignMode === mode
                          ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                          : "bg-card border-border text-muted-foreground"
                      )}
                    >
                      {mode === "live" ? "Dynamic" : "Snapshot"}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground leading-tight">
                  {assignMode === "live"
                    ? "Contacts update when segment syncs."
                    : "Contacts fixed at time of assignment."}
                </p>
                {/* Duplicate handling */}
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">If contact already in journey</p>
                  <div className="flex gap-1">
                    {(["skip", "update"] as const).map(opt => (
                      <button
                        key={opt}
                        onClick={() => setDupHandling(opt)}
                        className={cn(
                          "flex-1 py-1 px-1.5 rounded border text-[10px] font-medium transition-all",
                          dupHandling === opt
                            ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                            : "bg-card border-border text-muted-foreground"
                        )}
                      >
                        {opt === "skip" ? "Keep existing" : "Re-attribute"}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
                    {dupHandling === "skip"
                      ? "Existing entries kept as-is."
                      : "Existing entries re-attributed to this segment."}
                  </p>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto divide-y">
                {availableSegments
                  .filter(s => s.name.toLowerCase().includes(segSearch.toLowerCase()))
                  .map(s => (
                    <button
                      key={s.id}
                      onClick={() => setPreviewSegId(s.id)}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-3 text-left hover:bg-muted/30 transition-colors",
                        previewSegId === s.id && "bg-indigo-50 border-l-2 border-indigo-500"
                      )}
                    >
                      <Layers className={cn("w-4 h-4 shrink-0", previewSegId === s.id ? "text-indigo-600" : "text-muted-foreground")} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{s.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {s.last_computed_count} contacts · {s.segment_type}
                        </p>
                      </div>
                    </button>
                  ))}
                {availableSegments.length === 0 && (
                  <p className="text-xs text-muted-foreground p-4 text-center">All segments already assigned</p>
                )}
              </div>
              <div className="p-3 border-t">
                <Button
                  size="sm"
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-xs h-8"
                  disabled={!previewSegId || addSegmentMutation.isPending}
                  onClick={() => previewSegId && addSegmentMutation.mutate(previewSegId)}
                >
                  {addSegmentMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  Assign to Journey
                </Button>
              </div>
            </div>

            {/* Right: preview pane */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {!previewSegId ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <Layers className="w-10 h-10 mx-auto opacity-20 mb-3" />
                    <p className="text-sm">Select a segment to preview</p>
                    <p className="text-xs text-muted-foreground mt-1">See contacts and score breakdown</p>
                  </div>
                </div>
              ) : segPreviewLoading ? (
                <div className="flex-1 flex items-center justify-center">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : segPreview ? (
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {/* Summary */}
                  {(() => {
                    const alreadyIn = segPreview.contacts.filter(c => allRows.some(jc => jc.id === c.id)).length;
                    const newContacts = segPreview.contacts.length - alreadyIn;
                    return (
                      <div className="flex items-start gap-3">
                        <div className="bg-indigo-50 rounded-lg px-3 py-2 text-center shrink-0">
                          <p className="text-xl font-bold text-indigo-600">{segPreview.total}</p>
                          <p className="text-[10px] text-muted-foreground">Total</p>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground">
                            {availableSegments.find(s => s.id === previewSegId)?.name}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Showing first {Math.min(segPreview.contacts.length, 5)} of {segPreview.total} contacts
                          </p>
                          <Badge variant="outline" className="text-[10px] mt-1">
                            {assignMode === "live" ? "Dynamic sync" : "Static snapshot"}
                          </Badge>
                          {alreadyIn > 0 && (
                            <p className="text-[10px] text-amber-600 mt-1">
                              {alreadyIn} sample contact{alreadyIn !== 1 ? "s" : ""} already in this journey
                              {newContacts > 0 ? ` · ${newContacts} would be new` : ""}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Score tier breakdown */}
                  {segPreview.contacts.length > 0 && (() => {
                    const tiers = segPreview.contacts.reduce((acc: Record<string, number>, c) => {
                      const tier = c.lead_score >= 120 ? "Champion" : c.lead_score >= 75 ? "Very Hot" : c.lead_score >= 50 ? "Hot" : c.lead_score >= 25 ? "Warm" : "Cold";
                      acc[tier] = (acc[tier] || 0) + 1;
                      return acc;
                    }, {});
                    const tTotal = Object.values(tiers).reduce((a, b) => a + b, 0);
                    const TIER_COLORS_CLS: Record<string, string> = {
                      Cold: "bg-slate-400", Warm: "bg-blue-400", Hot: "bg-orange-400",
                      "Very Hot": "bg-red-400", Champion: "bg-violet-500",
                    };
                    return (
                      <div className="bg-muted/30 rounded-lg p-3">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Score Tiers (sample)</p>
                        {Object.entries(tiers).map(([tier, count]) => (
                          <div key={tier} className="flex items-center gap-2 text-xs mb-1.5">
                            <span className="w-16 text-muted-foreground shrink-0">{tier}</span>
                            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className={cn("h-full rounded-full", TIER_COLORS_CLS[tier] ?? "bg-indigo-400")}
                                style={{ width: `${Math.round((count / tTotal) * 100)}%` }}
                              />
                            </div>
                            <span className="w-5 text-right text-muted-foreground tabular-nums">{count}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Sample contacts */}
                  <div className="bg-card border rounded-lg overflow-hidden">
                    <div className="px-3 py-2 border-b bg-muted/20 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Sample Contacts
                    </div>
                    {segPreview.contacts.slice(0, 5).map(c => (
                      <div key={c.id} className="flex items-center gap-2 px-3 py-2.5 border-b last:border-b-0 hover:bg-muted/20">
                        <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                          <span className="text-[10px] font-bold text-indigo-700">{c.first_name[0]}{c.last_name[0]}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{c.first_name} {c.last_name}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{c.email}</p>
                        </div>
                        {c.company_name && (
                          <span className="text-[11px] text-muted-foreground hidden sm:block truncate max-w-[80px]">{c.company_name}</span>
                        )}
                        <span className="text-xs font-semibold text-indigo-600 shrink-0">{c.lead_score}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <AlertCircle className="w-8 h-8 mx-auto opacity-30 mb-2" />
                    <p className="text-sm">Could not load preview</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <RunWizard
        open={runWizardOpen}
        onClose={() => setRunWizardOpen(false)}
        initialJourneyId={journeyId}
      />
    </div>
  );
}
