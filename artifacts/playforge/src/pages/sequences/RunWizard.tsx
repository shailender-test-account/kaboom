import { useState, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ChevronRight, ChevronLeft, Loader2, Play,
  Users, Building2, CheckCircle2, Clock, History, MapPin,
  GitBranch, X, AlertCircle, RefreshCw, XCircle, EyeOff, ChevronDown,
  CalendarClock, Ban, UserCheck,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

type ContactSource = "journey" | "segment" | "all" | "manual";

const STEPS = [
  { id: 1, label: "Client",    icon: Building2 },
  { id: 2, label: "Journey",   icon: MapPin },
  { id: 3, label: "Sequence",  icon: GitBranch },
  { id: 4, label: "Contacts",  icon: Users },
  { id: 5, label: "Confirm",   icon: Play },
];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Props ─────────────────────────────────────────────────────────────────────

export interface RunWizardProps {
  open: boolean;
  onClose: () => void;
  /** Pre-selected sequence. When provided, Step 3 is a read-only confirmation. */
  sequence?: { id: number; name: string };
  /** Pre-select journey (e.g. when launched from journey ContactsTab). */
  initialJourneyId?: number;
  /** Pre-select segment (e.g. when launched from Segment Builder). */
  initialSegmentId?: number;
  /** When launched from a play, associate the run with this play so contacts auto-join play_contacts. */
  playId?: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RunWizard({
  open, onClose, sequence,
  initialJourneyId, initialSegmentId, playId,
}: RunWizardProps) {
  const { toast }    = useToast();
  const qc           = useQueryClient();
  const [, navigate] = useLocation();

  // ── Step state ───────────────────────────────────────────────────────────────
  const [step, setStep] = useState(1);

  // Step 1 — Client
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);

  // Step 2 — Journey
  const [selectedJourneyId, setSelectedJourneyId] = useState<number | null>(null);

  // Step 3 — Sequence (only active when sequence prop is not provided)
  const [selectedSequenceId, setSelectedSequenceId] = useState<number | null>(null);
  const [selectedSequenceName, setSelectedSequenceName] = useState("");

  // Step 4 — Contacts
  const [contactSource, setContactSource] = useState<ContactSource>("all");
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([]);
  const [segmentMode, setSegmentMode] = useState<"union" | "intersection">("union");
  const [manualEmails, setManualEmails] = useState("");
  const [excludeActive, setExcludeActive] = useState(true);
  const [skipRecentlyEnrolled, setSkipRecentlyEnrolled] = useState(true);
  const [excludeUnsubscribed, setExcludeUnsubscribed] = useState(true);
  const [minScore, setMinScore] = useState<string>("");

  // Step 5 — Schedule + Confirm
  const [sendImmediately, setSendImmediately] = useState(true);
  const [scheduledAt, setScheduledAt]         = useState("");
  const [windowStart, setWindowStart]         = useState("09:00");
  const [windowEnd, setWindowEnd]             = useState("18:00");
  const [dailyCap, setDailyCap]               = useState<string>("");
  const [sendDays, setSendDays]               = useState([1, 2, 3, 4, 5]);

  // Post-launch tracking
  type LaunchedRun = { id: number; status: string; enrolled: number; skipped: number; errors?: number; total_contacts: number; scheduled_at?: string | null };
  const [launchedRun, setLaunchedRun] = useState<LaunchedRun | null>(null);
  const [isPolling,   setIsPolling]   = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  // Reset all state when wizard opens with fresh initial values
  useEffect(() => {
    if (open) {
      setStep(1);
      setSelectedClientId(null);
      setSelectedJourneyId(initialJourneyId ?? null);
      setSelectedSequenceId(sequence?.id ?? null);
      setSelectedSequenceName(sequence?.name ?? "");
      setContactSource(
        initialJourneyId ? "journey"
        : initialSegmentId ? "segment"
        : "all"
      );
      setSelectedSegmentIds(initialSegmentId ? [String(initialSegmentId)] : []);
      setSegmentMode("union");
      setManualEmails("");
      setScheduledAt("");
      setLaunchedRun(null);
      setIsPolling(false);
      setIsCancelling(false);
      setExcludeActive(true);
      setExcludeUnsubscribed(true);
      setMinScore("");
      setSendImmediately(true);
      setWindowStart("09:00");
      setWindowEnd("18:00");
      setDailyCap("");
      setSendDays([1, 2, 3, 4, 5]);
    }
  // NOTE: Use primitive deps (sequence?.id, not sequence object) so a new
  // object literal passed by the parent on every render doesn't re-trigger
  // this effect and reset the wizard mid-flow.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialJourneyId, initialSegmentId, sequence?.id]);

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: clients = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["clients"],
    queryFn: () => api("/clients").then(r => r.json()),
    enabled: open,
  });
  const { data: journeys = [] } = useQuery<{ id: number; name: string; clientId?: number | null; client_id?: number | null }[]>({
    queryKey: ["journeys-slim"],
    queryFn: () => api("/journeys").then(r => r.json()),
    enabled: open,
  });
  const { data: sequences = [] } = useQuery<{ id: number; name: string; status: string }[]>({
    queryKey: ["email-sequences"],
    queryFn: () => api("/email-sequences").then(r => r.json()),
    // Only needed when no sequence is pre-selected
    enabled: open && !sequence,
  });
  const { data: segments = [] } = useQuery<{ id: number; name: string; last_computed_count: number }[]>({
    queryKey: ["segments"],
    queryFn: () => api("/segments").then(r => r.json()),
    enabled: open,
  });

  // Preview count + sample contacts — only fetch when on the Contacts step
  const targetSeqId = sequence?.id ?? selectedSequenceId;
  type SampleContact = { id: number; first_name: string; last_name: string; email: string; lead_score: number };
  type PreviewData = {
    estimatedCount: number;
    sampleContacts?: SampleContact[];
    scoreDistribution?: { cold: number; warm: number; hot: number; champion: number };
    excludedCount?: number;
    excludedSample?: SampleContact[];
    dncExcludedCount?: number;
    dncExcludedSample?: SampleContact[];
    personalizationWarning?: boolean;
    personalizationMissingCount?: number;
    unconfiguredEmailNodes?: number;
    totalEmailNodes?: number;
  };

  // Excluded contacts open/close toggle
  const [excludedOpen, setExcludedOpen] = useState(false);
  // DNC excluded contacts open/close toggle
  const [dncOpen, setDncOpen] = useState(false);

  const { data: previewData, isFetching: previewLoading } = useQuery<PreviewData>({
    queryKey: [
      "run-preview", targetSeqId,
      selectedClientId, selectedJourneyId, selectedSegmentIds.join(","),
      contactSource, excludeActive, excludeUnsubscribed, minScore,
    ],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (selectedClientId) p.set("clientId", String(selectedClientId));
      if (contactSource === "journey" && selectedJourneyId) p.set("journeyId", String(selectedJourneyId));
      if (contactSource === "segment" && selectedSegmentIds.length > 0) {
        p.set("segmentIds", selectedSegmentIds.join(","));
        p.set("segmentMode", segmentMode);
      }
      p.set("excludeActive",       String(excludeActive));
      p.set("excludeUnsubscribed", String(excludeUnsubscribed));
      p.set("includeContacts",     "true");
      p.set("includeExcluded",     "true");
      if (minScore) p.set("minScore", minScore);
      const r = await api(`/sequences/${targetSeqId}/runs/preview?${p}`);
      if (!r.ok) throw new Error(`Preview failed: ${r.status}`);
      return r.json() as Promise<PreviewData>;
    },
    enabled: step === 4 && !!targetSeqId && contactSource !== "manual",
    staleTime: 10_000,
  });

  // Live run status polling — active after launch until terminal state
  const { data: liveRun } = useQuery<LaunchedRun>({
    queryKey: ["live-run", launchedRun?.id ?? 0],
    queryFn:  () => api(`/sequences/${targetSeqId}/runs/${launchedRun!.id}`).then(r => r.json()),
    enabled:  isPolling && !!launchedRun?.id && !!targetSeqId,
    refetchInterval: isPolling ? 2000 : false,
  });

  // Stop polling once run reaches a terminal state, OR once it's confirmed as
  // scheduled for a future date/time — nothing will change until that time
  // arrives, so a 2s poll loop is pointless and only feeds a misleading
  // "actively processing" spinner (see Step 5 render below).
  useEffect(() => {
    const s = liveRun?.status;
    if (s === "completed" || s === "error" || s === "cancelled" || s === "scheduled") {
      setIsPolling(false);
      if (targetSeqId) qc.invalidateQueries({ queryKey: ["sequence-runs", String(targetSeqId)] });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRun?.status]);

  // ── Derived ──────────────────────────────────────────────────────────────────

  // Journeys can be linked to a client either directly via `clientId` on the
  // journeys row, or transitively through journey_plays → abm_plays.client_id.
  // The API now returns camelCase `clientId` (it previously was `client_id`,
  // hence the dual-key fallback for safety during rollout).
  const filteredJourneys = selectedClientId
    ? journeys.filter(j => (j.clientId ?? j.client_id) === selectedClientId)
    : journeys;

  const selectedClient  = clients.find(c => c.id === selectedClientId);
  const selectedJourney = journeys.find(j => j.id === selectedJourneyId);
  const selectedSegment = segments.find(s => selectedSegmentIds.includes(String(s.id)));
  const selectedSeq     = sequence ?? sequences.find(s => s.id === selectedSequenceId);

  const manualEmailsList = useMemo(
    () => manualEmails.split("\n").map(e => e.trim()).filter(e => e.includes("@")),
    [manualEmails]
  );

  // ── Step validation ───────────────────────────────────────────────────────────
  const canContinue = useMemo(() => {
    if (step === 3) return !!targetSeqId;
    if (step === 4) {
      if (contactSource === "journey"  && !selectedJourneyId) return false;
      if (contactSource === "segment"  && selectedSegmentIds.length === 0) return false;
      if (contactSource === "manual"   && manualEmailsList.length === 0) return false;
    }
    return true;
  }, [step, targetSeqId, contactSource, selectedJourneyId, selectedSegmentIds, manualEmailsList]);

  // ── Launch mutation ───────────────────────────────────────────────────────────

  const runMutation = useMutation({
    mutationFn: async () => {
      if (!targetSeqId) throw new Error("No sequence selected");
      const r = await api(`/sequences/${targetSeqId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId:  selectedClientId ?? undefined,
          playId:    playId ?? undefined,
          journeyId: contactSource === "journey" && selectedJourneyId ? selectedJourneyId : undefined,
          segmentIds:  contactSource === "segment" && selectedSegmentIds.length > 0 ? selectedSegmentIds.map(Number) : undefined,
          segmentMode: contactSource === "segment" ? segmentMode : undefined,
          manualEmails: contactSource === "manual" ? manualEmailsList : undefined,
          sendImmediately,
          scheduledAt: !sendImmediately && scheduledAt ? scheduledAt : undefined,
          sendWindowStart: windowStart,
          sendWindowEnd:   windowEnd,
          dailyCap:  dailyCap ? Number(dailyCap) : undefined,
          sendDays,
          excludeActive,
          skipRecentlyEnrolled,
          excludeUnsubscribed,
          minScore: minScore ? Number(minScore) : undefined,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Launch failed (${r.status})`);
      }
      return r.json() as Promise<LaunchedRun>;
    },
    onSuccess: (data: unknown) => {
      const run = data as LaunchedRun;
      setLaunchedRun(run);
      // Only start the live-progress poll for runs that are actually being
      // processed now. A run created as 'scheduled' (future scheduledAt) has
      // nothing to poll for until that time arrives, so skip the loop and go
      // straight to the "scheduled" confirmation state.
      setIsPolling(run.status !== "scheduled");
    },
    onError: () => toast({ title: "Failed to launch sequence", variant: "destructive" }),
  });

  // Tracks which contact IDs are mid-removal so we can show per-row spinner
  const [removingDncIds, setRemovingDncIds] = useState<Set<number>>(new Set());

  const removeDncMutation = useMutation({
    mutationFn: async (contactId: number) => {
      setRemovingDncIds(prev => new Set(prev).add(contactId));
      const r = await api(`/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dnc: false }),
      });
      if (!r.ok) throw new Error(`Failed to remove DNC (${r.status})`);
      return contactId;
    },
    onSuccess: (contactId) => {
      setRemovingDncIds(prev => { const s = new Set(prev); s.delete(contactId); return s; });
      toast({ title: "DNC removed — contact is now eligible for this run." });
      qc.invalidateQueries({ queryKey: ["run-preview"] });
    },
    onError: (_err, contactId) => {
      setRemovingDncIds(prev => { const s = new Set(prev); s.delete(contactId); return s; });
      toast({ title: "Failed to remove DNC flag", variant: "destructive" });
    },
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function closeAndReset() {
    onClose();
  }

  if (!open) return null;

  // ── Full-screen overlay ───────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col overflow-hidden">

      {/* Top bar */}
      <div className="border-b bg-card px-6 py-3 flex items-center gap-4 shrink-0">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={closeAndReset}>
          <X className="w-4 h-4" /> Close
        </Button>
        <div className="text-sm font-semibold text-foreground">
          Launch Sequence Run
          {selectedSeq && (
            <span className="text-muted-foreground font-normal"> — {selectedSeq.name}</span>
          )}
        </div>
        <div className="flex-1" />

        {/* Step breadcrumb */}
        <div className="flex items-center gap-0">
          {STEPS.map((s, idx) => {
            const Icon  = s.icon;
            const done  = step > s.id;
            const active= step === s.id;
            return (
              <div key={s.id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => {
                    // Allow free navigation to any step; per-step validation
                    // already prevents launching with an invalid config.
                    setStep(s.id);
                  }}
                  className={cn(
                    "flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer",
                    active ? "text-indigo-700 bg-indigo-50"
                    : done  ? "text-emerald-600 hover:bg-muted"
                    : "text-muted-foreground hover:bg-muted/60"
                  )}
                >
                  {done
                    ? <CheckCircle2 className="w-3.5 h-3.5" />
                    : <Icon className="w-3.5 h-3.5" />}
                  <span>{s.label}</span>
                </button>
                {idx < STEPS.length - 1 && (
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Scrollable step content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">

          {/* ── Step 1 — Client ── */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Select a client</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Choose a client to scope contacts, or skip to target all contacts.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {clients.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedClientId(selectedClientId === c.id ? null : c.id)}
                    className={cn(
                      "p-4 rounded-xl border text-left transition-all",
                      selectedClientId === c.id
                        ? "bg-indigo-50 border-indigo-300 ring-1 ring-indigo-200"
                        : "bg-card hover:bg-muted/40 border-border"
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <Building2 className={cn("w-4 h-4 shrink-0",
                        selectedClientId === c.id ? "text-indigo-600" : "text-muted-foreground"
                      )} />
                      <span className={cn("text-sm font-medium",
                        selectedClientId === c.id ? "text-indigo-700" : "text-foreground"
                      )}>
                        {c.name}
                      </span>
                      {selectedClientId === c.id && (
                        <CheckCircle2 className="w-4 h-4 text-indigo-500 ml-auto shrink-0" />
                      )}
                    </div>
                  </button>
                ))}
                {clients.length === 0 && (
                  <div className="col-span-2 text-center py-10 text-sm text-muted-foreground">
                    No clients found.
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {selectedClientId
                  ? `"${selectedClient?.name}" selected — contacts will be scoped to this client.`
                  : "No client selected — all tenant contacts will be eligible."}
              </p>
            </div>
          )}

          {/* ── Step 2 — Journey ── */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Select a journey</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Optionally link this run to a journey
                  {selectedClient ? ` for ${selectedClient.name}` : ""}.
                  Skip to choose contacts another way.
                </p>
              </div>
              {filteredJourneys.length > 0 ? (
                <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {filteredJourneys.map(j => (
                    <button
                      key={j.id}
                      onClick={() => setSelectedJourneyId(selectedJourneyId === j.id ? null : j.id)}
                      className={cn(
                        "w-full p-3.5 rounded-xl border text-left flex items-center gap-3 transition-all",
                        selectedJourneyId === j.id
                          ? "bg-indigo-50 border-indigo-300 ring-1 ring-indigo-200"
                          : "bg-card hover:bg-muted/40 border-border"
                      )}
                    >
                      <MapPin className={cn("w-4 h-4 shrink-0",
                        selectedJourneyId === j.id ? "text-indigo-600" : "text-muted-foreground"
                      )} />
                      <span className={cn("text-sm font-medium flex-1",
                        selectedJourneyId === j.id ? "text-indigo-700" : "text-foreground"
                      )}>
                        {j.name}
                      </span>
                      {selectedJourneyId === j.id && (
                        <CheckCircle2 className="w-4 h-4 text-indigo-500 shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="py-10 text-center space-y-2">
                  <MapPin className="w-8 h-8 mx-auto text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">
                    {selectedClientId ? "No journeys for this client." : "No journeys found."}
                  </p>
                  <p className="text-xs text-muted-foreground/80">
                    This step is optional — click <span className="font-semibold text-foreground">Continue</span> to choose contacts another way.
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {selectedJourneyId
                  ? `Journey "${selectedJourney?.name}" selected.`
                  : "No journey selected — skip to use a different contact source."}
              </p>
            </div>
          )}

          {/* ── Step 3 — Sequence ── */}
          {step === 3 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Select a sequence</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {sequence
                    ? "Review the selected sequence before continuing."
                    : "Choose the email sequence to run for the selected audience."}
                </p>
              </div>

              {sequence ? (
                /* Read-only confirmation when sequence was pre-selected */
                <div className="p-5 rounded-xl border bg-indigo-50 border-indigo-200">
                  <div className="flex items-center gap-3">
                    <GitBranch className="w-5 h-5 text-indigo-600 shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-indigo-800">{sequence.name}</p>
                      <p className="text-xs text-indigo-600 mt-0.5">
                        Sequence #{sequence.id}
                      </p>
                    </div>
                    <CheckCircle2 className="w-5 h-5 text-indigo-500" />
                  </div>
                  <p className="text-xs text-indigo-700/70 mt-3 pl-8">
                    This sequence will run for the audience you define in the next step.
                  </p>
                </div>
              ) : (
                /* Sequence picker — all sequences */
                <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {sequences.map(s => (
                    <button
                      key={s.id}
                      onClick={() => { setSelectedSequenceId(s.id); setSelectedSequenceName(s.name); }}
                      className={cn(
                        "w-full p-3.5 rounded-xl border text-left flex items-center gap-3 transition-all",
                        selectedSequenceId === s.id
                          ? "bg-indigo-50 border-indigo-300 ring-1 ring-indigo-200"
                          : "bg-card hover:bg-muted/40 border-border"
                      )}
                    >
                      <GitBranch className={cn("w-4 h-4 shrink-0",
                        selectedSequenceId === s.id ? "text-indigo-600" : "text-muted-foreground"
                      )} />
                      <div className="flex-1 min-w-0">
                        <p className={cn("text-sm font-medium truncate",
                          selectedSequenceId === s.id ? "text-indigo-700" : "text-foreground"
                        )}>
                          {s.name}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] shrink-0",
                          s.status === "active"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : s.status === "paused"
                            ? "bg-amber-50 text-amber-700 border-amber-200"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        {s.status}
                      </Badge>
                      {selectedSequenceId === s.id && (
                        <CheckCircle2 className="w-4 h-4 text-indigo-500 shrink-0" />
                      )}
                    </button>
                  ))}
                  {sequences.length === 0 && (
                    <div className="text-center py-10 text-sm text-muted-foreground">
                      No sequences found. Create a sequence first.
                    </div>
                  )}
                </div>
              )}

              {!canContinue && (
                <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  Select a sequence to continue.
                </div>
              )}
            </div>
          )}

          {/* ── Step 4 — Contacts ── */}
          {step === 4 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Define your audience</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Choose which contacts to enroll in this run.
                </p>
              </div>

              <Tabs value={contactSource} onValueChange={v => setContactSource(v as ContactSource)}>
                <TabsList className="w-full">
                  <TabsTrigger value="journey"  className="flex-1" disabled={!selectedJourneyId}>
                    Journey
                  </TabsTrigger>
                  <TabsTrigger value="segment"  className="flex-1">Segment</TabsTrigger>
                  <TabsTrigger value="all"      className="flex-1">All Contacts</TabsTrigger>
                  <TabsTrigger value="manual"   className="flex-1">Manual</TabsTrigger>
                </TabsList>

                <TabsContent value="journey" className="pt-4">
                  {selectedJourney ? (
                    <div className="p-4 rounded-xl bg-indigo-50 border border-indigo-100">
                      <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wide mb-1">
                        Sourcing from journey
                      </p>
                      <p className="text-sm font-semibold text-indigo-800">{selectedJourney.name}</p>
                      <p className="text-xs text-indigo-600/70 mt-1">
                        All contacts assigned to this journey will be enrolled.
                      </p>
                    </div>
                  ) : (
                    <div className="py-6 text-center text-sm text-muted-foreground">
                      No journey selected. Go back to Step 2 to select one.
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="segment" className="pt-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs">Select segments</Label>
                      <div className="flex items-center gap-2">
                        {/* Union / Intersection toggle */}
                        <div className="flex items-center rounded-lg border overflow-hidden text-[10px]">
                          {(["union", "intersection"] as const).map(mode => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setSegmentMode(mode)}
                              className={cn(
                                "px-2 py-1 capitalize transition-colors",
                                segmentMode === mode
                                  ? "bg-indigo-600 text-white"
                                  : "bg-muted text-muted-foreground hover:bg-muted/70"
                              )}
                            >
                              {mode}
                            </button>
                          ))}
                        </div>
                        {selectedSegmentIds.length > 0 && (
                          <button
                            onClick={() => setSelectedSegmentIds([])}
                            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Clear all
                          </button>
                        )}
                      </div>
                    </div>
                    {selectedSegmentIds.length > 1 && (
                      <p className="text-[10px] text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-md px-2 py-1">
                        {segmentMode === "intersection"
                          ? `Intersection: only contacts in all ${selectedSegmentIds.length} segments.`
                          : `Union: contacts from any of the ${selectedSegmentIds.length} segments (deduplicated).`}
                      </p>
                    )}
                    <div className="border rounded-lg divide-y max-h-52 overflow-y-auto bg-card">
                      {segments.map(s => {
                        const checked = selectedSegmentIds.includes(String(s.id));
                        return (
                          <label
                            key={s.id}
                            className={cn(
                              "flex items-center gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-muted/20 transition-colors",
                              checked && "bg-indigo-50/60"
                            )}
                          >
                            <input
                              type="checkbox"
                              className="w-3.5 h-3.5 rounded accent-indigo-600 shrink-0"
                              checked={checked}
                              onChange={e => {
                                setSelectedSegmentIds(prev =>
                                  e.target.checked
                                    ? [...prev, String(s.id)]
                                    : prev.filter(id => id !== String(s.id))
                                );
                              }}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{s.name}</p>
                            </div>
                            <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                              {s.last_computed_count ?? 0}
                            </span>
                          </label>
                        );
                      })}
                      {segments.length === 0 && (
                        <p className="text-xs text-muted-foreground p-4 text-center">No segments yet.</p>
                      )}
                    </div>
                    {selectedSegmentIds.length === 0 && (
                      <p className="text-xs text-amber-600">Select at least one segment to continue.</p>
                    )}
                    {selectedSegmentIds.length > 1 && (
                      <p className="text-[10px] text-indigo-600 font-medium">
                        {selectedSegmentIds.length} segments selected — contacts from all are merged.
                      </p>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="all" className="pt-4">
                  <div className="p-4 rounded-xl bg-muted/40 border text-center">
                    <Users className="w-6 h-6 mx-auto mb-2 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">
                      All{selectedClient ? ` ${selectedClient.name}` : ""} contacts in your
                      workspace will be eligible for this run.
                    </p>
                  </div>
                </TabsContent>

                <TabsContent value="manual" className="pt-4">
                  <div>
                    <Label className="text-xs mb-1.5 block">
                      Paste email addresses (one per line)
                    </Label>
                    <Textarea
                      value={manualEmails}
                      onChange={e => setManualEmails(e.target.value)}
                      placeholder={"john@example.com\njane@example.com\n..."}
                      className="min-h-[140px] text-xs font-mono resize-none"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {manualEmailsList.length} valid email{manualEmailsList.length !== 1 ? "s" : ""} entered.
                      Only emails matching existing contacts will be enrolled.
                    </p>
                  </div>
                </TabsContent>
              </Tabs>

              {/* Estimated count */}
              {contactSource !== "manual" && (
                <>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 border rounded-lg px-3 py-2">
                    {previewLoading
                      ? <><RefreshCw className="w-3 h-3 animate-spin" /> Calculating estimated contacts…</>
                      : previewData
                      ? <><Users className="w-3 h-3 text-indigo-500" /> Estimated <strong className="text-foreground">{previewData.estimatedCount}</strong> contacts after applying exclusions.</>
                      : <><Users className="w-3 h-3" /> Contact count will be shown here.</>
                    }
                  </div>

                  {/* Score distribution chart */}
                  {previewData?.scoreDistribution && (() => {
                    const dist = previewData.scoreDistribution!;
                    const data = [
                      { tier: "Cold",     count: Number(dist.cold),     fill: "#94a3b8" },
                      { tier: "Warm",     count: Number(dist.warm),     fill: "#fbbf24" },
                      { tier: "Hot",      count: Number(dist.hot),      fill: "#f97316" },
                      { tier: "Champion", count: Number(dist.champion), fill: "#6366f1" },
                    ];
                    return (
                      <div className="bg-muted/30 border rounded-xl p-3">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Score distribution</p>
                        <ResponsiveContainer width="100%" height={72}>
                          <BarChart data={data} margin={{ top: 0, right: 0, bottom: 14, left: 0 }}>
                            <XAxis dataKey="tier" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                            <YAxis hide allowDecimals={false} />
                            <Tooltip formatter={(v: number) => [`${v} contacts`, ""]} contentStyle={{ fontSize: 11 }} />
                            <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                              {data.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    );
                  })()}

                  {/* Sample contact list */}
                  {previewData?.sampleContacts && previewData.sampleContacts.length > 0 && (
                    <div className="border rounded-xl overflow-hidden">
                      <div className="px-3 py-2 bg-muted/30 border-b">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                          Sample contacts ({previewData.sampleContacts.length} of {previewData.estimatedCount})
                        </p>
                      </div>
                      {previewData.sampleContacts.map(c => (
                        <div key={c.id} className="flex items-center gap-2.5 px-3 py-2 border-b last:border-0 text-sm">
                          <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                            <span className="text-[9px] font-bold text-indigo-700">
                              {c.first_name?.[0] ?? c.email?.[0] ?? "?"}{c.last_name?.[0] ?? ""}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-foreground truncate text-xs">{c.first_name} {c.last_name}</p>
                            <p className="text-[10px] text-muted-foreground truncate">{c.email}</p>
                          </div>
                          <Badge variant="secondary" className="text-[10px] shrink-0">{c.lead_score}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Excluded contacts disclosure */}
              {previewData && (previewData.excludedCount ?? 0) > 0 && (
                <div className="border rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExcludedOpen(o => !o)}
                    className="w-full flex items-center justify-between px-3 py-2.5 bg-amber-50 hover:bg-amber-100/70 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2 text-xs text-amber-700">
                      <EyeOff className="w-3.5 h-3.5 shrink-0" />
                      <span className="font-medium">{previewData.excludedCount} contact{previewData.excludedCount !== 1 ? "s" : ""} excluded</span>
                      <span className="text-amber-600/70">by your exclusion rules</span>
                    </div>
                    <ChevronDown className={cn("w-3.5 h-3.5 text-amber-600 transition-transform shrink-0", excludedOpen && "rotate-180")} />
                  </button>
                  {excludedOpen && previewData.excludedSample && previewData.excludedSample.length > 0 && (
                    <div className="divide-y">
                      {previewData.excludedSample.map(c => (
                        <div key={c.id} className="flex items-center gap-2.5 px-3 py-2 text-sm bg-amber-50/30">
                          <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                            <span className="text-[9px] font-bold text-amber-700">
                              {(c.first_name?.[0] ?? "?")}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-foreground truncate text-xs">{c.first_name} {c.last_name}</p>
                            <p className="text-[10px] text-muted-foreground truncate">{c.email}</p>
                          </div>
                          <Badge variant="secondary" className="text-[10px] shrink-0 bg-amber-50 text-amber-700 border-amber-200">
                            {c.lead_score}
                          </Badge>
                        </div>
                      ))}
                      {(previewData.excludedCount ?? 0) > (previewData.excludedSample?.length ?? 0) && (
                        <div className="px-3 py-2 text-[10px] text-muted-foreground bg-muted/20">
                          +{(previewData.excludedCount ?? 0) - (previewData.excludedSample?.length ?? 0)} more excluded
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* DNC excluded contacts disclosure */}
              {previewData && (previewData.dncExcludedCount ?? 0) > 0 && (
                <div className="border border-red-200 rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setDncOpen(o => !o)}
                    className="w-full flex items-center justify-between px-3 py-2.5 bg-red-50 hover:bg-red-100/70 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2 text-xs text-red-700">
                      <Ban className="w-3.5 h-3.5 shrink-0" />
                      <span className="font-medium">{previewData.dncExcludedCount} contact{previewData.dncExcludedCount !== 1 ? "s" : ""} excluded (DNC)</span>
                      <span className="text-red-500/70">Do Not Contact — will never be emailed</span>
                    </div>
                    <ChevronDown className={cn("w-3.5 h-3.5 text-red-500 transition-transform shrink-0", dncOpen && "rotate-180")} />
                  </button>
                  {dncOpen && previewData.dncExcludedSample && previewData.dncExcludedSample.length > 0 && (
                    <div className="divide-y">
                      {previewData.dncExcludedSample.map(c => (
                        <div key={c.id} className="flex items-center gap-2.5 px-3 py-2 text-sm bg-red-50/30">
                          <div className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                            <Ban className="w-3 h-3 text-red-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-foreground truncate text-xs">{c.first_name} {c.last_name}</p>
                            <p className="text-[10px] text-muted-foreground truncate">{c.email}</p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px] text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50 shrink-0 gap-1"
                            disabled={removingDncIds.has(c.id)}
                            onClick={() => removeDncMutation.mutate(c.id)}
                          >
                            {removingDncIds.has(c.id)
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <UserCheck className="w-3 h-3" />}
                            Remove DNC
                          </Button>
                        </div>
                      ))}
                      {(previewData.dncExcludedCount ?? 0) > (previewData.dncExcludedSample?.length ?? 0) && (
                        <div className="px-3 py-2 text-[10px] text-muted-foreground bg-muted/20">
                          +{(previewData.dncExcludedCount ?? 0) - (previewData.dncExcludedSample?.length ?? 0)} more DNC contacts
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Exclusion rules */}
              <div className="border rounded-xl p-4 space-y-3 bg-card">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Exclusion rules
                </p>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">Skip already-active contacts</p>
                    <p className="text-xs text-muted-foreground">Don't re-enroll contacts mid-sequence</p>
                  </div>
                  <Switch checked={excludeActive} onCheckedChange={setExcludeActive} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">Skip recently enrolled contacts</p>
                    <p className="text-xs text-muted-foreground">Don't re-enroll contacts from a run in the last 24 h</p>
                  </div>
                  <Switch checked={skipRecentlyEnrolled} onCheckedChange={setSkipRecentlyEnrolled} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">Skip unsubscribed contacts</p>
                    <p className="text-xs text-muted-foreground">Contacts who have opted out</p>
                  </div>
                  <Switch checked={excludeUnsubscribed} onCheckedChange={setExcludeUnsubscribed} />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Min lead score (optional)</Label>
                  <Input
                    type="number"
                    value={minScore}
                    onChange={e => setMinScore(e.target.value)}
                    placeholder="e.g. 25 — leave blank for no minimum"
                    className="h-9 text-sm max-w-[240px]"
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── Step 5 — Confirm + Schedule ── */}
          {step === 5 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Confirm &amp; schedule</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Review the run configuration and set your send schedule.
                </p>
              </div>

              {runMutation.isPending ? (
                <div className="flex flex-col items-center justify-center py-14 text-center">
                  <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mb-4" />
                  <p className="text-base font-semibold text-foreground">Launching sequence...</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Enrolling contacts and queuing emails
                  </p>
                </div>
              ) : runMutation.isSuccess ? (
                (() => {
                  const displayRun   = liveRun ?? launchedRun;
                  const isTerminal   = displayRun?.status === "completed"
                    || displayRun?.status === "error"
                    || displayRun?.status === "cancelled";
                  const isScheduled  = displayRun?.status === "scheduled";
                  // total_contacts = -1 is a sentinel meaning the audience is still
                  // being resolved in the background (may take seconds on large lists).
                  const isResolving  = (displayRun?.total_contacts ?? -1) === -1;
                  const runTotal     = isResolving ? 0 : (displayRun?.total_contacts ?? 0);
                  const runProcessed = (displayRun?.enrolled ?? 0) + (displayRun?.skipped ?? 0);
                  const pct          = runTotal > 0 ? Math.min(100, Math.round((runProcessed / runTotal) * 100)) : 0;
                  const scheduledLabel = displayRun?.scheduled_at
                    ? new Date(displayRun.scheduled_at).toLocaleString(undefined, {
                        dateStyle: "medium", timeStyle: "short",
                      })
                    : null;
                  const enrolledToday  = displayRun?.enrolled ?? 0;
                  const remaining      = runTotal - runProcessed;
                  const dailyCapHit    = isScheduled && enrolledToday > 0;
                  return (
                    <div className="flex flex-col items-center justify-center py-12 text-center max-w-sm mx-auto">
                      {isTerminal
                        ? <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-4" />
                        : isScheduled
                        ? dailyCapHit
                          ? <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-4" />
                          : <CalendarClock className="w-12 h-12 text-indigo-600 mb-4" />
                        : <Loader2    className="w-12 h-12 text-indigo-600 animate-spin mb-4" />}
                      <p className="text-base font-semibold text-foreground">
                        {isTerminal
                          ? "Run complete!"
                          : isScheduled
                          ? dailyCapHit
                            ? `Today's batch sent!`
                            : "Run scheduled"
                          : "Enrolling contacts…"}
                      </p>
                      {isScheduled && (
                        <p className="text-sm text-muted-foreground mt-1">
                          {dailyCapHit ? (
                            <>
                              <span className="font-medium text-emerald-600">{enrolledToday} email{enrolledToday !== 1 ? "s" : ""} sent today.</span>
                              {remaining > 0 && scheduledLabel && (
                                <> The remaining <span className="font-medium text-foreground">{remaining}</span> contact{remaining !== 1 ? "s" : ""} will automatically continue on <span className="font-medium text-foreground">{scheduledLabel}</span> — no action needed.</>
                              )}
                            </>
                          ) : scheduledLabel
                            ? `This run will start automatically on ${scheduledLabel}.`
                            : "This run is scheduled to start automatically at a later time."}
                          {!dailyCapHit && <>{" "}It will enroll {runTotal > 0 ? runTotal : "the selected"} contacts once its send window opens — no action needed.</>}
                        </p>
                      )}
                      {isTerminal ? (
                        <div className="flex gap-10 mt-5">
                          <div>
                            <p className="text-2xl font-bold text-emerald-600">{displayRun?.enrolled ?? 0}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">Enrolled</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-muted-foreground">{displayRun?.skipped ?? 0}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">Skipped</p>
                          </div>
                          {(displayRun?.errors ?? 0) > 0 && (
                            <div>
                              <p className="text-2xl font-bold text-red-500">{displayRun?.errors}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">Errors</p>
                            </div>
                          )}
                        </div>
                      ) : isScheduled ? (
                        <div className="flex flex-col items-center gap-3 mt-5">
                          {dailyCapHit && (
                            <div className="flex gap-8">
                              <div>
                                <p className="text-2xl font-bold text-emerald-600">{enrolledToday}</p>
                                <p className="text-xs text-muted-foreground mt-0.5">Sent today</p>
                              </div>
                              {remaining > 0 && (
                                <div>
                                  <p className="text-2xl font-bold text-indigo-600">{remaining}</p>
                                  <p className="text-xs text-muted-foreground mt-0.5">Queued next</p>
                                </div>
                              )}
                              {(displayRun?.skipped ?? 0) > 0 && (
                                <div>
                                  <p className="text-2xl font-bold text-muted-foreground">{displayRun?.skipped}</p>
                                  <p className="text-xs text-muted-foreground mt-0.5">Skipped</p>
                                </div>
                              )}
                            </div>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs text-red-600 hover:text-red-700 border-red-200"
                            disabled={isCancelling}
                            onClick={async () => {
                              if (!launchedRun?.id || !targetSeqId) return;
                              setIsCancelling(true);
                              try {
                                await api(`/sequences/${targetSeqId}/runs/${launchedRun.id}/cancel`, { method: "POST" });
                                qc.invalidateQueries({ queryKey: ["live-run", launchedRun.id] });
                                qc.invalidateQueries({ queryKey: ["sequence-runs", String(targetSeqId)] });
                              } finally { setIsCancelling(false); }
                            }}
                          >
                            <XCircle className="w-3 h-3 mr-1" />
                            {isCancelling ? "Cancelling…" : dailyCapHit ? "Cancel remaining batch" : "Cancel scheduled run"}
                          </Button>
                        </div>
                      ) : (
                        <div className="w-full mt-5 space-y-2">
                          <p className="text-sm text-muted-foreground">
                            {isResolving
                              ? "Building contact list…"
                              : `${runProcessed} / ${runTotal > 0 ? runTotal : "…"} contacts processed`}
                          </p>
                          {runTotal > 0 && (
                            <div className="w-full bg-muted rounded-full h-2">
                              <div
                                className="bg-indigo-600 h-2 rounded-full transition-all duration-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-3 text-xs text-red-600 hover:text-red-700 border-red-200"
                            disabled={isCancelling}
                            onClick={async () => {
                              if (!launchedRun?.id || !targetSeqId) return;
                              setIsCancelling(true);
                              try {
                                await api(`/sequences/${targetSeqId}/runs/${launchedRun.id}/cancel`, { method: "POST" });
                                setIsPolling(false);
                              } finally { setIsCancelling(false); }
                            }}
                          >
                            <XCircle className="w-3 h-3 mr-1" />
                            {isCancelling ? "Cancelling…" : "Cancel run"}
                          </Button>
                        </div>
                      )}
                      <div className="flex items-center gap-3 mt-8">
                        {targetSeqId && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { closeAndReset(); navigate(`/sequences/${targetSeqId}/runs`); }}
                          >
                            <History className="w-3.5 h-3.5 mr-1.5" />
                            View Run History
                          </Button>
                        )}
                        <Button size="sm" onClick={closeAndReset}>Close</Button>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div className="grid grid-cols-5 gap-5">
                  {/* Left: Summary */}
                  <div className="col-span-3 space-y-3">
                    <div className="bg-muted/30 rounded-xl border p-4 space-y-2.5">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                        Run summary
                      </p>
                      <ConfirmRow label="Sequence" value={selectedSeq?.name ?? "—"} />
                      {selectedClient  && <ConfirmRow label="Client"   value={selectedClient.name} />}
                      {selectedJourney && <ConfirmRow label="Journey"  value={selectedJourney.name} />}
                      <ConfirmRow
                        label="Audience"
                        value={
                          contactSource === "journey"
                            ? `Journey — ${selectedJourney?.name ?? "—"}`
                            : contactSource === "segment"
                              ? selectedSegmentIds.length > 1
                                ? `${selectedSegmentIds.length} segments (union)`
                                : `Segment — ${selectedSegment?.name ?? "—"}`
                              : contactSource === "manual"
                                ? `Manual (${manualEmailsList.length} emails)`
                                : "All contacts"
                        }
                      />
                      {previewData && contactSource !== "manual" && (
                        <ConfirmRow label="Est. contacts" value={String(previewData.estimatedCount)} />
                      )}
                      {previewData && (previewData.dncExcludedCount ?? 0) > 0 && (
                        <div className="flex justify-between items-center text-sm">
                          <span className="text-muted-foreground shrink-0">DNC excluded</span>
                          <span className="flex items-center gap-1 font-medium text-red-600 text-right">
                            <Ban className="w-3 h-3 shrink-0" />
                            {previewData.dncExcludedCount} contact{previewData.dncExcludedCount !== 1 ? "s" : ""}
                          </span>
                        </div>
                      )}
                      <ConfirmRow
                        label="Exclusions"
                        value={[
                          excludeActive       ? "Skip active"       : null,
                          excludeUnsubscribed ? "Skip unsubscribed" : null,
                          minScore            ? `Min score: ${minScore}` : null,
                        ].filter(Boolean).join(", ") || "None"}
                      />
                    </div>
                  </div>

                  {/* Right: Schedule */}
                  <div className="col-span-2 space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-foreground">Send immediately</p>
                        <p className="text-xs text-muted-foreground">Start on launch</p>
                      </div>
                      <Switch checked={sendImmediately} onCheckedChange={setSendImmediately} />
                    </div>

                    {!sendImmediately && (
                      <div>
                        <Label className="text-xs mb-1 block">Schedule date &amp; time</Label>
                        <Input
                          type="datetime-local"
                          value={scheduledAt}
                          onChange={e => setScheduledAt(e.target.value)}
                          className="h-9 text-sm"
                        />
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Leave blank to start manually from Run History.
                        </p>
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label className="text-xs">Send window</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <Input type="time" value={windowStart} onChange={e => setWindowStart(e.target.value)} className="h-9 text-xs" />
                        <Input type="time" value={windowEnd}   onChange={e => setWindowEnd(e.target.value)}   className="h-9 text-xs" />
                      </div>
                    </div>

                    <div>
                      <Label className="text-xs mb-1.5 block">Send days</Label>
                      <div className="flex gap-1 flex-wrap">
                        {DAYS.map((day, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setSendDays(prev =>
                              prev.includes(idx)
                                ? prev.filter(d => d !== idx)
                                : [...prev, idx]
                            )}
                            className={cn(
                              "w-8 h-8 rounded-lg text-[10px] font-medium transition-colors",
                              sendDays.includes(idx)
                                ? "bg-indigo-600 text-white"
                                : "bg-muted text-muted-foreground hover:bg-muted/70"
                            )}
                          >
                            {day}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <Label className="text-xs mb-1 block">Daily cap</Label>
                      <Input
                        type="number"
                        value={dailyCap}
                        onChange={e => setDailyCap(e.target.value)}
                        placeholder="No limit"
                        className="h-9 text-sm"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Zero-contact warning */}
              {!runMutation.isPending && !runMutation.isSuccess && previewData && previewData.estimatedCount === 0 && (
                <div className="flex items-start gap-2.5 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-amber-800">No contacts found</p>
                    <p className="text-amber-700 mt-0.5">
                      The selected audience has 0 eligible contacts after exclusions. No emails will be sent.
                      Go back to adjust the audience or add contacts for this client first.
                    </p>
                  </div>
                </div>
              )}

              {/* Unconfigured email nodes — blocking error */}
              {!runMutation.isPending && !runMutation.isSuccess && (previewData?.unconfiguredEmailNodes ?? 0) > 0 && (
                <div className="flex items-start gap-2.5 text-xs bg-red-50 border border-red-300 rounded-lg px-3 py-2.5">
                  <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-red-800">Sequence not ready — email templates missing</p>
                    <p className="text-red-700 mt-0.5">
                      {previewData!.unconfiguredEmailNodes} of {previewData!.totalEmailNodes} email step{(previewData!.totalEmailNodes ?? 1) !== 1 ? "s" : ""} in
                      this sequence {previewData!.unconfiguredEmailNodes !== 1 ? "have" : "has"} no template assigned.
                      Without a template, those steps will be skipped and 0 emails will be sent.
                      Go back to the sequence editor and assign an email template to each step.
                    </p>
                  </div>
                </div>
              )}

              {/* Personalization warning */}
              {!runMutation.isPending && !runMutation.isSuccess && previewData?.personalizationWarning && (
                <div className="flex items-start gap-2.5 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-amber-800">Personalization warning</p>
                    <p className="text-amber-700 mt-0.5">
                      {previewData.personalizationMissingCount} contact{previewData.personalizationMissingCount !== 1 ? "s" : ""} in
                      your audience are missing a first name or email address. Email personalization
                      (e.g. <span className="font-mono">{"{{firstName}}"}</span>) may render blank for these contacts.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom navigation */}
      {!runMutation.isSuccess && (
        <div className="border-t bg-card px-6 py-4 flex items-center justify-between shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => step > 1 ? setStep(step - 1) : closeAndReset()}
            disabled={runMutation.isPending}
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            {step === 1 ? "Cancel" : "Back"}
          </Button>
          {step < 5 && (
            <Button
              size="sm"
              data-testid="wizard-continue"
              onClick={() => setStep(step + 1)}
              disabled={!canContinue}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              Continue <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          )}
          {step === 5 && !runMutation.isPending && (
            <Button
              size="sm"
              data-testid="wizard-launch"
              onClick={() => runMutation.mutate()}
              disabled={(previewData?.unconfiguredEmailNodes ?? 0) > 0}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              <Play className="w-4 h-4 mr-1.5" />
              Launch Sequence Run
            </Button>
          )}
          {step === 5 && runMutation.isPending && (
            <Button size="sm" disabled className="bg-indigo-600 opacity-70">
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              Launching…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Small helper ──────────────────────────────────────────────────────────────

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-medium text-foreground text-right truncate max-w-[180px]">
        {value}
      </span>
    </div>
  );
}
