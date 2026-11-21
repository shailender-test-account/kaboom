import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Redirect, useLocation } from "wouter";
import {
  Download, Trophy, Users, ThumbsUp, Loader2, Search, X, BarChart2,
  TrendingUp, Clock, MousePointerClick, Mail, Eye, Phone, Sparkles, MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAuthContext } from "@/contexts/AuthContext";
import { ContactTimelinePanel } from "@/components/analytics/ContactTimelinePanel";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContestEntry {
  id: number;
  name: string;
  org: string;
  designation: string;
  email: string;
  mobile: string;
  current_brand: string | null;
  demo_interest: "yes" | "no" | null;
  marketing_consent: boolean;
  scenario: string;
  challenges: string[] | string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  persona: "executive" | "itmanager" | "none" | null;
  submitted_at: string;
  contact_id: number | null;
  contact_stage: string | null;
  contact_lead_score: number | null;
  contest_page_visits: number | null;
  first_visit_at: string | null;
  stage_reached_at: string | null;
}

interface EntriesResponse {
  entries: ContestEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SCENARIO_LABELS: Record<string, string> = {
  airport: "Busy Airport Lounge",
  support: "Noisy Support Floor",
  home: "Two-Device Home Meeting",
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  });
}

function getChallenges(raw: string[] | string): string[] {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return [raw]; }
}

function scenarioLabel(s: string) {
  return SCENARIO_LABELS[s.toLowerCase()] ?? s;
}

function ScenarioBadge({ scenario }: { scenario: string }) {
  const colors: Record<string, string> = {
    airport: "bg-blue-100 text-blue-700 border-blue-200",
    support: "bg-orange-100 text-orange-700 border-orange-200",
    home:    "bg-green-100 text-green-700 border-green-200",
  };
  const cls = colors[scenario.toLowerCase()] ?? "bg-gray-100 text-gray-600 border-gray-200";
  return (
    <span className={cn("text-[11px] font-semibold px-1.5 py-0.5 rounded border whitespace-nowrap", cls)}>
      {scenarioLabel(scenario)}
    </span>
  );
}

function DemoInterestBadge({ value }: { value: "yes" | "no" | null }) {
  if (value == null) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <span className={cn(
      "text-[11px] font-semibold px-1.5 py-0.5 rounded border",
      value === "yes"
        ? "bg-emerald-100 text-emerald-700 border-emerald-200"
        : "bg-gray-100 text-gray-500 border-gray-200",
    )}>
      {value === "yes" ? "Yes" : "No"}
    </span>
  );
}

// ── Debounce hook ─────────────────────────────────────────────────────────────

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(value), delayMs);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value, delayMs]);
  return debounced;
}

// ── Persona helpers ───────────────────────────────────────────────────────────

const PERSONA_LABELS: Record<string, string> = {
  executive: "Executive",
  itmanager: "IT Manager",
  none:      "No persona",
};

function PersonaBadge({ value }: { value: string | null }) {
  if (!value || value === "none") return <span className="text-muted-foreground text-xs">—</span>;
  const colors: Record<string, string> = {
    executive: "bg-purple-100 text-purple-700 border-purple-200",
    itmanager: "bg-sky-100 text-sky-700 border-sky-200",
  };
  const cls = colors[value] ?? "bg-gray-100 text-gray-600 border-gray-200";
  return (
    <span className={cn("text-[11px] font-semibold px-1.5 py-0.5 rounded border whitespace-nowrap", cls)}>
      {PERSONA_LABELS[value] ?? value}
    </span>
  );
}

// ── CSV export — calls the server so all matching rows are included ─────────────

function exportCsv(scenario: string, demoInterest: string, persona: string, search: string) {
  const params = new URLSearchParams();
  if (scenario !== "all")     params.set("scenario", scenario);
  if (demoInterest !== "all") params.set("demoInterest", demoInterest);
  if (persona !== "all")      params.set("persona", persona);
  if (search)                 params.set("search", search);
  const qs  = params.toString() ? `?${params.toString()}` : "";
  const a   = document.createElement("a");
  a.href    = `/api/contest/entries/export${qs}`;
  a.download = `contest-entries-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ── Journey slide-over ────────────────────────────────────────────────────────

const STAGE_ORDER = ["pre-aware", "aware", "pre-engage", "engage", "advance-engage", "action"];
const STAGE_LABELS: Record<string, string> = {
  "pre-aware": "Pre-Aware", "aware": "Aware", "pre-engage": "Pre-Engage",
  "engage": "Engage", "advance-engage": "Adv-Engage", "action": "Action",
};
const STAGE_COLORS: Record<string, string> = {
  "pre-aware": "bg-gray-100 text-gray-600 border-gray-200",
  "aware": "bg-sky-100 text-sky-700 border-sky-200",
  "pre-engage": "bg-indigo-100 text-indigo-700 border-indigo-200",
  "engage": "bg-violet-100 text-violet-700 border-violet-200",
  "advance-engage": "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200",
  "action": "bg-emerald-100 text-emerald-700 border-emerald-200",
};

function StagePill({ stage }: { stage: string | null }) {
  const s = stage ?? "pre-aware";
  return (
    <span className={cn("text-[11px] font-semibold px-1.5 py-0.5 rounded border whitespace-nowrap", STAGE_COLORS[s] ?? STAGE_COLORS["pre-aware"])}>
      {STAGE_LABELS[s] ?? s}
    </span>
  );
}

function eventIcon(type: string) {
  if (type === "page_view")       return <Eye className="w-3.5 h-3.5 text-sky-500" />;
  if (type === "email_open")      return <Mail className="w-3.5 h-3.5 text-amber-500" />;
  if (type === "email_click")     return <MousePointerClick className="w-3.5 h-3.5 text-indigo-500" />;
  if (type === "call_completed")  return <Phone className="w-3.5 h-3.5 text-emerald-500" />;
  if (type === "stage_advance")   return <TrendingUp className="w-3.5 h-3.5 text-violet-500" />;
  return <Sparkles className="w-3.5 h-3.5 text-muted-foreground" />;
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function LegacyEntryJourneyPanel({ contactId, entryName, onClose }: {
  contactId: number; entryName: string; onClose: () => void;
}) {
  const { data, isLoading } = useQuery<any>({
    queryKey: ["contest-entry-journey", contactId],
    queryFn: () =>
      fetch(`/api/contacts/${contactId}/timeline`, { credentials: "include" }).then(r => {
        if (!r.ok) throw new Error("Failed to load journey");
        return r.json();
      }),
  });

  const contact = data?.contact;
  const timeline: any[] = data?.timeline ?? [];
  const stageHistory: any[] = data?.stageHistory ?? [];

  // Return-visit detection: count distinct calendar days with page_view events
  const visitDays = Array.from(new Set(
    timeline.filter(e => e.eventType === "page_view")
      .map(e => new Date(e.createdAt).toDateString()),
  ));
  const returnVisits = Math.max(visitDays.length - 1, 0);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-background border-l shadow-2xl z-50 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div>
            <p className="text-sm font-semibold">{entryName} — Lifetime Journey</p>
            {contact && (
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <StagePill stage={contact.stage} />
                <span className="text-xs text-muted-foreground">
                  Score: <span className="font-semibold text-foreground">{contact.leadScore}</span>
                </span>
                {(contact.intentScore ?? 0) > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Intent: <span className="font-semibold text-foreground">{contact.intentScore}</span>
                  </span>
                )}
                {contact.intentState && (
                  <span className="text-[11px] font-medium text-indigo-600">{contact.intentState}</span>
                )}
              </div>
            )}
          </div>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center h-40 gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">Loading journey…</span>
          </div>
        )}

        {!isLoading && data && (
          <div className="flex-1 overflow-y-auto">
            {/* Visit summary */}
            <div className="px-4 py-3 border-b bg-muted/20 flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5">
                <Eye className="w-3.5 h-3.5 text-sky-500" />
                <span className="font-semibold">{visitDays.length}</span> visit day{visitDays.length !== 1 && "s"}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-emerald-500" />
                {returnVisits > 0
                  ? <><span className="font-semibold">{returnVisits}</span> return visit{returnVisits !== 1 && "s"}</>
                  : "No return visits yet"}
              </span>
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-violet-500" />
                <span className="font-semibold">{timeline.length}</span> events
              </span>
            </div>

            {/* Stage progression card slider */}
            <div className="px-4 py-3 border-b">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Stage Progression</p>
              <div className="flex gap-2 overflow-x-auto pb-1.5 -mx-1 px-1">
                {STAGE_ORDER.map(stage => {
                  const reached = stageHistory.find((s: any) => s.toStage === stage);
                  const isCurrent = (contact?.stage ?? "pre-aware") === stage;
                  return (
                    <div
                      key={stage}
                      className={cn(
                        "shrink-0 w-[120px] rounded-lg border p-2.5",
                        reached ? "bg-card" : "bg-muted/30 opacity-50",
                        isCurrent && "ring-2 ring-indigo-400 border-indigo-300",
                      )}
                    >
                      <StagePill stage={stage} />
                      {reached ? (
                        <>
                          <p className="text-[11px] text-muted-foreground mt-1.5">{fmtDateTime(reached.achievedAt)}</p>
                          {reached.scoreAtTransition != null && (
                            <p className="text-[11px] text-foreground/70 mt-0.5">Score {reached.scoreAtTransition}</p>
                          )}
                        </>
                      ) : (
                        <p className="text-[11px] text-muted-foreground mt-1.5 italic">Not reached</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Timeline */}
            <div className="px-4 py-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Activity Timeline</p>
              {timeline.length === 0 && (
                <p className="text-sm text-muted-foreground italic">No recorded activity yet.</p>
              )}
              <div className="space-y-0">
                {timeline.map((e: any, i: number) => (
                  <div key={e.id ?? i} className="flex gap-2.5 relative pb-3">
                    {i < timeline.length - 1 && (
                      <div className="absolute left-[9px] top-6 bottom-0 w-px bg-border" />
                    )}
                    <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5 z-10">
                      {eventIcon(e.eventType)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-foreground">
                        {e.isStageChange
                          ? <>Advanced to <span className="font-semibold">{STAGE_LABELS[e.toStage] ?? e.toStage}</span>{e.triggerPageName && <span className="text-muted-foreground"> — via {e.triggerPageName}</span>}</>
                          : (e.description || e.pageName || e.eventType.replace(/_/g, " "))}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className="text-[11px] text-muted-foreground">{fmtDateTime(e.createdAt)}</p>
                        {e.scoreDelta > 0 && (
                          <span className="text-[11px] font-medium text-emerald-600">+{e.scoreDelta}</span>
                        )}
                        {e.journeyName && (
                          <span className="text-[11px] text-muted-foreground truncate">· {e.journeyName}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ContestEntriesPage() {
  const { user } = useAuthContext();
  const [, navigate] = useLocation();
  const [searchInput, setSearchInput]           = useState("");
  const [scenarioFilter, setScenarioFilter]     = useState<string>("all");
  const [demoFilter, setDemoFilter]             = useState<string>("all");
  const [personaFilter, setPersonaFilter]       = useState<string>("all");
  const [journeyPanel, setJourneyPanel]         = useState<{ contactId: number; name: string } | null>(null);

  // Fetch the poly-contest journey so we can deep-link analytics to the right filter
  const { data: journeyData } = useQuery<{ id: number } | null>({
    queryKey: ["journey-poly-contest"],
    queryFn: () =>
      fetch("/api/journeys?search=poly-contest", { credentials: "include" })
        .then(r => r.ok ? r.json() : [])
        .then((rows: any[]) => rows.find((j: any) => j.slug === "poly-contest") ?? null),
    staleTime: Infinity,
  });

  function openAnalytics() {
    const base = "/analytics";
    const params = new URLSearchParams({ section: "traffic" });
    if (journeyData?.id) params.set("journeyId", String(journeyData.id));
    navigate(`${base}?${params.toString()}`);
  }

  // Admin-only page — non-admins are redirected to the dashboard
  if (user && user.role !== "admin") {
    return <Redirect to="/" />;
  }

  // Debounce the text search to avoid a fetch on every keystroke
  const debouncedSearch = useDebounced(searchInput, 350);

  // Build query params that match exactly what the server expects
  const queryParams = new URLSearchParams({ limit: "1000" });
  if (scenarioFilter !== "all") queryParams.set("scenario", scenarioFilter);
  if (demoFilter !== "all")     queryParams.set("demoInterest", demoFilter);
  if (personaFilter !== "all")  queryParams.set("persona", personaFilter);
  if (debouncedSearch)          queryParams.set("search", debouncedSearch);

  const { data, isLoading, isError } = useQuery<EntriesResponse>({
    queryKey: ["contest-entries", scenarioFilter, demoFilter, personaFilter, debouncedSearch],
    queryFn: () =>
      fetch(`/api/contest/entries?${queryParams.toString()}`, { credentials: "include" }).then(r => {
        if (!r.ok) throw new Error("Failed to load entries");
        return r.json();
      }),
    staleTime: 30_000,
  });

  const entries = data?.entries ?? [];
  const total   = data?.total ?? 0;

  const hasFilters = searchInput || scenarioFilter !== "all" || demoFilter !== "all" || personaFilter !== "all";

  function clearFilters() {
    setSearchInput("");
    setScenarioFilter("all");
    setDemoFilter("all");
    setPersonaFilter("all");
  }

  // Count how many shown entries want a demo (within current filter result)
  const demoYesCount = entries.filter(e => e.demo_interest === "yes").length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <Trophy className="w-5 h-5 text-amber-500" />
              <h1 className="text-lg font-semibold text-foreground">Contest Entries</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              HP Poly 2-Minute Meeting Rescue — all submitted entries
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={openAnalytics}
            >
              <BarChart2 className="w-3.5 h-3.5" />
              View Analytics
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={total === 0}
              onClick={() => exportCsv(scenarioFilter, demoFilter, personaFilter, debouncedSearch)}
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
              {total > 0 && (
                <span className="text-muted-foreground font-normal">({total})</span>
              )}
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="flex gap-6 mt-4">
          <div className="flex items-center gap-1.5 text-sm">
            <Users className="w-4 h-4 text-muted-foreground" />
            <span className="font-semibold text-foreground">{total}</span>
            <span className="text-muted-foreground">
              {hasFilters ? "matching entries" : "total entries"}
            </span>
          </div>
          {!hasFilters && (
            <div className="flex items-center gap-1.5 text-sm">
              <ThumbsUp className="w-4 h-4 text-emerald-500" />
              <span className="font-semibold text-foreground">{demoYesCount}</span>
              <span className="text-muted-foreground">want a demo</span>
            </div>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="border-b bg-muted/30 px-6 py-3 shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search name, org, email…"
              className="pl-8 h-8 text-sm bg-background"
            />
          </div>

          <Select value={scenarioFilter} onValueChange={setScenarioFilter}>
            <SelectTrigger className="h-8 text-sm w-[180px] bg-background">
              <SelectValue placeholder="All scenarios" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All scenarios</SelectItem>
              <SelectItem value="airport">Busy Airport Lounge</SelectItem>
              <SelectItem value="support">Noisy Support Floor</SelectItem>
              <SelectItem value="home">Two-Device Home Meeting</SelectItem>
            </SelectContent>
          </Select>

          <Select value={demoFilter} onValueChange={setDemoFilter}>
            <SelectTrigger className="h-8 text-sm w-[160px] bg-background">
              <SelectValue placeholder="Demo interest" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All interest levels</SelectItem>
              <SelectItem value="yes">Wants demo</SelectItem>
              <SelectItem value="no">Declined demo</SelectItem>
              <SelectItem value="none">Not answered</SelectItem>
            </SelectContent>
          </Select>

          <Select value={personaFilter} onValueChange={setPersonaFilter}>
            <SelectTrigger className="h-8 text-sm w-[150px] bg-background">
              <SelectValue placeholder="All personas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All personas</SelectItem>
              <SelectItem value="executive">Executive</SelectItem>
              <SelectItem value="itmanager">IT Manager</SelectItem>
              <SelectItem value="none">No persona</SelectItem>
            </SelectContent>
          </Select>

          {hasFilters && (
            <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-sm px-2" onClick={clearFilters}>
              <X className="w-3 h-3" /> Clear
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading && (
          <div className="flex items-center justify-center h-48 gap-2 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading entries…</span>
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-center h-48">
            <p className="text-sm text-destructive">Failed to load contest entries.</p>
          </div>
        )}

        {!isLoading && !isError && entries.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground">
            <Trophy className="w-8 h-8 opacity-30" />
            <p className="text-sm">
              {hasFilters ? "No entries match the current filters." : "No contest entries yet."}
            </p>
          </div>
        )}

        {!isLoading && !isError && entries.length > 0 && (
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-muted/60 backdrop-blur-sm z-10">
              <tr>
                {[
                  "Name / Org",
                  "Email",
                  "Journey",
                  "Persona",
                  "Scenario",
                  "Challenges",
                  "Demo?",
                  "Current Brand",
                  "UTM",
                  "Submitted",
                ].map(h => (
                  <th
                    key={h}
                    className="text-left text-xs font-semibold text-muted-foreground px-4 py-2.5 border-b whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const challenges = getChallenges(e.challenges);
                const hasUtm = e.utm_source || e.utm_medium || e.utm_campaign;
                return (
                  <tr
                    key={e.id}
                    className={cn(
                      "border-b border-border/50 hover:bg-muted/40 transition-colors",
                      i % 2 === 0 ? "bg-background" : "bg-muted/10",
                    )}
                  >
                    {/* Name / Org */}
                    <td className="px-4 py-2.5 max-w-[200px]">
                      {e.contact_id ? (
                        <button
                          className="font-medium text-foreground truncate hover:text-indigo-600 hover:underline text-left"
                          onClick={() => setJourneyPanel({ contactId: e.contact_id!, name: e.name })}
                        >
                          {e.name}
                        </button>
                      ) : (
                        <p className="font-medium text-foreground truncate">{e.name}</p>
                      )}
                      <p className="text-xs text-muted-foreground truncate">{e.org}</p>
                      <p className="text-xs text-muted-foreground/70 truncate">{e.designation}</p>
                    </td>

                    {/* Email */}
                    <td className="px-4 py-2.5">
                      <a
                        href={`mailto:${e.email}`}
                        className="text-primary hover:underline text-xs"
                      >
                        {e.email}
                      </a>
                      {e.mobile && (
                        <p className="text-xs text-muted-foreground mt-0.5">{e.mobile}</p>
                      )}
                    </td>

                    {/* Journey — stage, visits, score, and when stage was reached */}
                    <td className="px-4 py-2.5 min-w-[190px]">
                      {e.contact_id ? (
                        <div className="space-y-1">
                          {/* Stage + when reached */}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <StagePill stage={e.contact_stage} />
                            {e.stage_reached_at && (
                              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                since {fmtDate(e.stage_reached_at)}
                              </span>
                            )}
                          </div>
                          {/* Contest page visits */}
                          <div className="flex items-center gap-3">
                            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <Eye className="w-3 h-3 text-sky-500" />
                              {e.contest_page_visits != null && e.contest_page_visits > 0
                                ? <><span className="font-semibold text-foreground">{e.contest_page_visits}</span> contest visit{e.contest_page_visits !== 1 ? "s" : ""}</>
                                : <span className="italic opacity-60">No tracked visits</span>
                              }
                            </span>
                            {e.first_visit_at && (
                              <span className="flex items-center gap-1 text-[11px] text-muted-foreground whitespace-nowrap">
                                <Clock className="w-3 h-3 text-emerald-500" />
                                First: {fmtDate(e.first_visit_at)}
                              </span>
                            )}
                          </div>
                          {/* Score + view journey link */}
                          <button
                            className="text-left group"
                            onClick={() => setJourneyPanel({ contactId: e.contact_id!, name: e.name })}
                          >
                            <span className="text-[11px] text-muted-foreground">
                              Score <span className="font-semibold text-foreground">{e.contact_lead_score ?? 0}</span>
                              {" · "}
                            </span>
                            <span className="text-[11px] text-indigo-600 group-hover:underline">View journey</span>
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground/50 italic">No contact match</span>
                      )}
                    </td>

                    {/* Persona */}
                    <td className="px-4 py-2.5">
                      <PersonaBadge value={e.persona ?? null} />
                    </td>

                    {/* Scenario */}
                    <td className="px-4 py-2.5">
                      <ScenarioBadge scenario={e.scenario} />
                    </td>

                    {/* Challenges */}
                    <td className="px-4 py-2.5 max-w-[180px]">
                      <div className="flex flex-wrap gap-1">
                        {challenges.map(c => (
                          <span
                            key={c}
                            className="text-[11px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    </td>

                    {/* Demo interest */}
                    <td className="px-4 py-2.5">
                      <DemoInterestBadge value={e.demo_interest} />
                    </td>

                    {/* Current brand */}
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {e.current_brand || <span className="italic opacity-50">—</span>}
                    </td>

                    {/* UTM */}
                    <td className="px-4 py-2.5">
                      {hasUtm ? (
                        <div className="space-y-0.5">
                          {e.utm_source   && <p className="text-[11px] text-muted-foreground"><span className="font-medium text-foreground/60">src:</span> {e.utm_source}</p>}
                          {e.utm_medium   && <p className="text-[11px] text-muted-foreground"><span className="font-medium text-foreground/60">med:</span> {e.utm_medium}</p>}
                          {e.utm_campaign && <p className="text-[11px] text-muted-foreground"><span className="font-medium text-foreground/60">cmp:</span> {e.utm_campaign}</p>}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground/50 italic">—</span>
                      )}
                    </td>

                    {/* Submitted */}
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <p className="text-xs text-foreground">{fmtDate(e.submitted_at)}</p>
                      <p className="text-[11px] text-muted-foreground">{fmtTime(e.submitted_at)}</p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer count */}
      {!isLoading && entries.length > 0 && (
        <div className="border-t px-6 py-2 shrink-0 bg-muted/20">
          <p className="text-xs text-muted-foreground">
            Showing {entries.length} of {total} entries
            {entries.length < total && " — refine filters or increase limit to see more"}
          </p>
        </div>
      )}

      {/* Contact history slide-over */}
      {journeyPanel && (
        <Sheet open onOpenChange={open => !open && setJourneyPanel(null)}>
          <SheetContent className="w-[480px] sm:w-[520px] p-0 flex flex-col overflow-hidden" side="right">
            <SheetHeader className="px-4 py-3 border-b shrink-0">
              <SheetTitle className="text-sm">{journeyPanel.name} — Contact History</SheetTitle>
              <SheetDescription className="sr-only">
                Complete scoring, stage, call, and activity history for this contact.
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <ContactTimelinePanel contactId={journeyPanel.contactId} />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
