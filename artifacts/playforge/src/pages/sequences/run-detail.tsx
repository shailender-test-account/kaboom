import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft, CheckCircle2, Clock, Loader2,
  Users, SkipForward, AlertCircle, Pause,
  XCircle, RefreshCw, Mail, Download, BarChart2,
  Search, CalendarDays, TrendingUp, MousePointerClick, Ban,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, CartesianGrid, Legend,
} from "recharts";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

// ── Types ─────────────────────────────────────────────────────────────────────
interface StepStat {
  stepNum: number;
  label: string;
  subject: string | undefined;
  sent: number;
  opened: number;
  clicked: number;
  bounced: number;
  openRate: number;
  clickRate: number;
  waitLabel: string | undefined;
}

interface EnrolledContact {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  lead_score: number;
  enrollment_status: string;
  enrolled_at: string | null;
  company_name: string | null;
  opens: number;
  clicks: number;
  enrollment_id: number | null;
  resume_error_count: number;
}

interface StepWhoContact {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  occurred_at: string | null;
}

interface ContactEvent {
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface BackfillSkippedContact {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  lead_score: number;
  company_name: string | null;
  skipped_at: string;
}

interface RunDetail {
  id: number;
  status: string;
  total_contacts: number;
  enrolled: number;
  skipped: number;
  errors: number;
  dnc_excluded_count: number;
  started_at: string | null;
  completed_at: string | null;
  journey_name: string | null;
  client_name: string | null;
  started_by_name: string | null;
  sequence_name: string | null;
  created_at: string;
  scheduled_at: string | null;
  send_window_start: string | null;
  send_window_end: string | null;
  daily_cap: number | null;
  stepStats: StepStat[];
  enrolledContacts: EnrolledContact[];
  enrollmentTimeline: Array<{ date: string; count: number }>;
  emailTimeline: Array<{ date: string; event_type: string; count: number }>;
  backfillSkippedCount: number;
  backfillSkippedContacts: BackfillSkippedContact[];
  erroredEnrollmentCount: number;
}

const STATUS_CONFIG: Record<string, {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge: string;
}> = {
  pending:   { label: "Pending",   icon: Clock,        badge: "bg-gray-100 text-gray-700" },
  scheduled: { label: "Scheduled", icon: CalendarDays, badge: "bg-purple-100 text-purple-700" },
  running:   { label: "Running",   icon: RefreshCw,    badge: "bg-blue-100 text-blue-700" },
  completed: { label: "Completed", icon: CheckCircle2, badge: "bg-emerald-100 text-emerald-700" },
  paused:    { label: "Paused",    icon: Pause,        badge: "bg-amber-100 text-amber-700" },
  cancelled: { label: "Cancelled", icon: XCircle,      badge: "bg-red-100 text-red-700" },
  error:     { label: "Error",     icon: AlertCircle,  badge: "bg-red-100 text-red-700" },
};

const EVENT_LABELS: Record<string, { label: string; color: string }> = {
  email_sent:        { label: "Email sent",     color: "text-gray-700"    },
  email_open:        { label: "Email opened",   color: "text-emerald-600" },
  email_click:       { label: "Link clicked",   color: "text-indigo-600"  },
  email_bounced:     { label: "Email bounced",  color: "text-red-600"     },
  sequence_enrolled: { label: "Enrolled",       color: "text-blue-600"    },
};

function exportCsv(run: RunDetail) {
  const rows: string[] = [
    `"Run ID","Status","Total Contacts","Enrolled","Skipped","Started"`,
    `"${run.id}","${run.status}","${run.total_contacts}","${run.enrolled}","${run.skipped}","${run.started_at ?? ""}"`,
    ``,
    `"Step","Label","Subject","Sent","Opened","Open %","Clicked","Click %","Bounced"`,
    ...(run.stepStats ?? []).map(s =>
      `"${s.stepNum}","${s.label.replace(/"/g, '""')}","${(s.subject ?? "").replace(/"/g, '""')}","${s.sent}","${s.opened}","${s.openRate}%","${s.clicked}","${s.clickRate}%","${s.bounced}"`
    ),
    ``,
    `"Contact ID","Name","Email","Score","Status","Opens","Clicks"`,
    ...(run.enrolledContacts ?? []).map(c =>
      `"${c.id}","${c.first_name} ${c.last_name}","${c.email}","${c.lead_score ?? 0}","${c.enrollment_status ?? "skipped"}","${c.opens ?? 0}","${c.clicks ?? 0}"`
    ),
  ];
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `sequence-run-${run.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── RunDetailPage ─────────────────────────────────────────────────────────────
interface RunDetailProps { id: string; runId: string; }

export default function RunDetailPage({ id, runId }: RunDetailProps) {
  const [, navigate]       = useLocation();
  const { toast }          = useToast();
  const qc                 = useQueryClient();
  const [contactSearch, setContactSearch]     = useState("");
  const [contactStatusFilter, setContactStatusFilter] = useState<"all" | "enrolled" | "skipped" | "errored">("all");
  const [scoreMin, setScoreMin]               = useState("");
  const [scoreMax, setScoreMax]               = useState("");
  const [selectedContact, setSelectedContact] = useState<EnrolledContact | null>(null);
  const [historyOpen, setHistoryOpen]         = useState(false);
  const [cancelConfirm, setCancelConfirm]     = useState(false);
  const [whoDrill, setWhoDrill] = useState<{ stepNum: number; type: "sent" | "opened" | "clicked" | "bounced"; label: string } | null>(null);
  const [backfillOpen, setBackfillOpen] = useState(false);

  const prevStatusRef = useRef<string | undefined>(undefined);

  const { data: run, isLoading, refetch } = useQuery<RunDetail>({
    queryKey: ["sequence-run-detail", id, runId],
    queryFn: () => api(`/sequences/${id}/runs/${runId}`).then(r => r.json()),
    refetchInterval: (query) => query.state.data?.status === "running" ? 5_000 : false,
  });

  useEffect(() => {
    if (!run) return;
    const prev = prevStatusRef.current;
    if (prev === "running" && run.status === "completed") {
      toast({
        title: "Run completed",
        description: `${run.enrolled} contact${run.enrolled !== 1 ? "s" : ""} enrolled successfully.`,
      });
    }
    prevStatusRef.current = run.status;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const { data: contactEvents = [], isFetching: eventsFetching } = useQuery<ContactEvent[]>({
    queryKey: ["run-contact-events", id, runId, selectedContact?.id],
    queryFn: () =>
      api(`/sequences/${id}/runs/${runId}/contacts/${selectedContact!.id}/events`).then(r => r.json()),
    enabled: !!selectedContact && historyOpen,
  });

  const { data: whoContacts = [], isFetching: whoFetching } = useQuery<StepWhoContact[]>({
    queryKey: ["run-step-who", id, runId, whoDrill?.stepNum, whoDrill?.type],
    queryFn: () =>
      api(`/sequences/${id}/runs/${runId}/steps/${whoDrill!.stepNum}/who?type=${whoDrill!.type}`).then(r => r.json()),
    enabled: !!whoDrill,
  });

  const actionMutation = useMutation({
    mutationFn: (action: string) =>
      api(`/sequences/${id}/runs/${runId}/${action}`, { method: "POST" }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sequence-run-detail", id, runId] });
      qc.invalidateQueries({ queryKey: ["sequence-runs", id] });
      toast({ title: "Run updated" });
    },
    onError: () => toast({ title: "Action failed", variant: "destructive" }),
  });

  const retryMutation = useMutation({
    mutationFn: async (enrollmentId: number) => {
      const r = await api(`/sequences/${id}/runs/${runId}/enrollments/${enrollmentId}/retry`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Request failed with status ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sequence-run-detail", id, runId] });
      toast({ title: "Enrollment queued for retry", description: "The resume runner will pick it up on the next tick." });
    },
    onError: (err: Error) => toast({ title: "Retry failed", description: err.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="border-b bg-card px-4 py-2.5 flex items-center gap-3 shrink-0">
          <Skeleton className="h-8 w-8 rounded" />
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div className="grid grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-muted-foreground gap-3">
        <AlertCircle className="w-8 h-8 opacity-40" />
        <p className="text-sm">Run not found.</p>
        <Button variant="outline" size="sm" onClick={() => navigate(`/sequences/${id}/runs`)}>
          Back to run history
        </Button>
      </div>
    );
  }

  const cfg        = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.pending;
  const StatusIcon = cfg.icon;
  const steps      = run.stepStats ?? [];
  const contacts   = run.enrolledContacts ?? [];
  const timeline   = run.enrollmentTimeline ?? [];
  const emailTl    = run.emailTimeline ?? [];

  // Derived email metrics from stepStats
  const totalSent    = steps.reduce((s, x) => s + (x.sent    ?? 0), 0);
  const totalBounced = steps.reduce((s, x) => s + (x.bounced ?? 0), 0);
  const avgOpenRate  = steps.length
    ? Math.round(steps.reduce((s, x) => s + (x.openRate  ?? 0), 0) / steps.length)
    : 0;
  const avgClickRate = steps.length
    ? Math.round(steps.reduce((s, x) => s + (x.clickRate ?? 0), 0) / steps.length)
    : 0;

  // Filtered contacts list (search + status + score range)
  const filteredContacts = contacts.filter(c => {
    if (contactSearch.trim()) {
      const q = contactSearch.toLowerCase();
      if (!`${c.first_name} ${c.last_name} ${c.email} ${c.company_name ?? ""}`.toLowerCase().includes(q)) return false;
    }
    if (contactStatusFilter !== "all") {
      if (contactStatusFilter === "enrolled" && (c.enrollment_status === "skipped" || c.enrollment_status === "errored")) return false;
      if (contactStatusFilter === "skipped"  && c.enrollment_status !== "skipped")  return false;
      if (contactStatusFilter === "errored"  && c.enrollment_status !== "errored")  return false;
    }
    if (scoreMin && !isNaN(Number(scoreMin)) && c.lead_score < Number(scoreMin)) return false;
    if (scoreMax && !isNaN(Number(scoreMax)) && c.lead_score > Number(scoreMax)) return false;
    return true;
  });

  const ENROLLMENT_STATUS_BADGE: Record<string, string> = {
    active:    "bg-emerald-100 text-emerald-700",
    completed: "bg-blue-100 text-blue-700",
    skipped:   "bg-gray-100 text-gray-500",
    paused:    "bg-amber-100 text-amber-700",
    errored:   "bg-red-100 text-red-700",
  };

  // Email activity chart data: pivot emailTimeline into per-date series
  const emailChartDates = [...new Set(emailTl.map(x => x.date))].sort();
  const emailChartData  = emailChartDates.map(date => {
    const row: Record<string, string | number> = { date };
    emailTl.filter(x => x.date === date).forEach(x => { row[x.event_type] = x.count; });
    return row;
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="border-b bg-card px-4 py-2.5 flex items-center gap-3 shrink-0">
        <Button
          variant="ghost" size="icon" className="h-8 w-8"
          onClick={() => navigate(`/sequences/${id}/runs`)}
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm truncate">
              {run.sequence_name ?? "Sequence"}
            </span>
            <span className="text-xs text-muted-foreground">· Run #{run.id}</span>
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", cfg.badge)}>
              {cfg.label}
            </span>
            {run.journey_name && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5">{run.journey_name}</Badge>
            )}
            {run.client_name && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5">{run.client_name}</Badge>
            )}
            {run.status === "running" && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-blue-600">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                </span>
                Live
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => refetch()}>
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
          {run.status === "running" && (
            <Button variant="outline" size="sm" className="h-7 text-xs"
              onClick={() => actionMutation.mutate("pause")} disabled={actionMutation.isPending}
            >
              <Pause className="w-3 h-3 mr-1" /> Pause
            </Button>
          )}
          {run.status === "paused" && (
            <Button variant="outline" size="sm" className="h-7 text-xs"
              onClick={() => actionMutation.mutate("resume")} disabled={actionMutation.isPending}
            >
              <RefreshCw className="w-3 h-3 mr-1" /> Resume
            </Button>
          )}
          {["running", "paused", "scheduled"].includes(run.status) && (
            <Button variant="outline" size="sm" className="h-7 text-xs text-red-600 hover:text-red-700"
              onClick={() => actionMutation.mutate("cancel")} disabled={actionMutation.isPending}
            >
              <XCircle className="w-3 h-3 mr-1" /> Cancel
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => exportCsv(run)}>
            <Download className="w-3 h-3 mr-1" /> Export CSV
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 bg-muted/30 space-y-5">

        {/* Live delivery progress — visible while running, pending, or paused */}
        {(run.status === "running" || run.status === "paused" || (run.status === "pending" && run.total_contacts > 0)) && (
          <Card className={cn(
            "border",
            run.status === "paused"
              ? "border-amber-200 bg-amber-50/60"
              : "border-blue-200 bg-blue-50/60",
          )}>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {run.status === "running" ? (
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
                    </span>
                  ) : (
                    <Pause className="w-3.5 h-3.5 text-amber-600" />
                  )}
                  <span className={cn(
                    "text-sm font-semibold",
                    run.status === "paused" ? "text-amber-800" : "text-blue-800",
                  )}>
                    {run.status === "paused" ? "Enrollment paused" : "Enrollment in progress"}
                  </span>
                </div>
                <span className={cn(
                  "text-xs font-medium tabular-nums",
                  run.status === "paused" ? "text-amber-700" : "text-blue-700",
                )}>
                  {run.enrolled} / {run.total_contacts} contacts
                </span>
              </div>
              <Progress
                value={run.total_contacts > 0 ? Math.round(((run.enrolled + run.skipped) / run.total_contacts) * 100) : 0}
                className={cn(
                  "h-2.5",
                  run.status === "paused"
                    ? "bg-amber-200 [&>div]:bg-amber-500"
                    : "bg-blue-200 [&>div]:bg-blue-500",
                )}
              />
              <div className={cn(
                "flex items-center gap-4 mt-2.5 text-xs",
                run.status === "paused" ? "text-amber-700" : "text-blue-700",
              )}>
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                  <span className="text-emerald-700 font-medium">{run.enrolled}</span> enrolled
                </span>
                <span className="flex items-center gap-1">
                  <SkipForward className="w-3 h-3 text-amber-500" />
                  <span className="text-amber-700 font-medium">{run.skipped}</span> skipped
                </span>
                {totalSent > 0 && (
                  <span className="flex items-center gap-1">
                    <Mail className={cn("w-3 h-3", run.status === "paused" ? "text-amber-500" : "text-blue-500")} />
                    <span className="font-medium">{totalSent}</span> emails sent
                  </span>
                )}
                <span className={cn(
                  "font-medium",
                  run.status === "paused" ? "text-amber-600" : "text-blue-600",
                )}>
                  {run.total_contacts > 0
                    ? `${Math.round(((run.enrolled + run.skipped) / run.total_contacts) * 100)}%`
                    : "0%"} processed
                </span>

                {/* Inline quick-action buttons */}
                <div className="ml-auto flex items-center gap-2">
                  {run.status === "running" && (
                    <Button
                      size="sm" variant="outline"
                      className="h-6 text-[11px] px-2 border-blue-300 text-blue-700 hover:bg-blue-100"
                      onClick={() => actionMutation.mutate("pause")}
                      disabled={actionMutation.isPending}
                    >
                      <Pause className="w-3 h-3 mr-1" /> Pause
                    </Button>
                  )}
                  {run.status === "paused" && (
                    <Button
                      size="sm" variant="outline"
                      className="h-6 text-[11px] px-2 border-amber-300 text-amber-700 hover:bg-amber-100"
                      onClick={() => actionMutation.mutate("resume")}
                      disabled={actionMutation.isPending}
                    >
                      <RefreshCw className="w-3 h-3 mr-1" /> Resume
                    </Button>
                  )}
                  {["running", "paused", "scheduled"].includes(run.status) && (
                    cancelConfirm ? (
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-red-600 font-medium">Cancel run?</span>
                        <Button
                          size="sm" variant="outline"
                          className="h-6 text-[11px] px-2 border-red-300 text-red-600 hover:bg-red-50"
                          onClick={() => { actionMutation.mutate("cancel"); setCancelConfirm(false); }}
                          disabled={actionMutation.isPending}
                        >
                          Yes, cancel
                        </Button>
                        <Button
                          size="sm" variant="ghost"
                          className="h-6 text-[11px] px-2"
                          onClick={() => setCancelConfirm(false)}
                          disabled={actionMutation.isPending}
                        >
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm" variant="outline"
                        className="h-6 text-[11px] px-2 border-red-200 text-red-600 hover:bg-red-50"
                        onClick={() => setCancelConfirm(true)}
                        disabled={actionMutation.isPending}
                      >
                        <XCircle className="w-3 h-3 mr-1" /> Cancel
                      </Button>
                    )
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Daily-cap mid-run banner: show when scheduled with already-enrolled contacts */}
        {run.status === "scheduled" && (run.enrolled ?? 0) > 0 && run.scheduled_at && (
          <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-emerald-800">
                Today's batch sent — {run.enrolled} email{run.enrolled !== 1 ? "s" : ""} delivered
              </p>
              <p className="text-emerald-700 text-xs mt-0.5">
                Daily cap of {run.daily_cap} reached. The remaining{" "}
                {(run.total_contacts ?? 0) - ((run.enrolled ?? 0) + (run.skipped ?? 0))} contacts will automatically
                continue on{" "}
                <span className="font-medium">
                  {format(new Date(run.scheduled_at), "MMM d, yyyy 'at' h:mm a")}
                </span>{" "}
                — no action needed.
              </p>
            </div>
          </div>
        )}

        {/* KPI grid — 4 cols × 2 rows; DNC row only when > 0 */}
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: "Total Contacts", value: run.total_contacts,           icon: Users,             color: "text-indigo-600"  },
            { label: "Enrolled",       value: run.enrolled,                  icon: CheckCircle2,      color: "text-emerald-600" },
            { label: "Skipped",        value: run.skipped,                   icon: SkipForward,       color: "text-amber-600"   },
            { label: "Errors",         value: run.errors ?? 0,               icon: AlertCircle,       color: (run.errors ?? 0) > 0 ? "text-red-600" : "text-muted-foreground" },
            { label: "Emails Sent",    value: totalSent,                     icon: Mail,              color: "text-blue-600"    },
            { label: "Avg Open Rate",  value: `${avgOpenRate}%`,             icon: TrendingUp,        color: "text-emerald-600" },
            { label: "Avg Click Rate", value: `${avgClickRate}%`,            icon: MousePointerClick, color: "text-indigo-600"  },
            { label: "Bounced",        value: totalBounced,                  icon: AlertCircle,       color: totalBounced > 0 ? "text-red-600" : "text-muted-foreground" },
            ...((run.dnc_excluded_count ?? 0) > 0
              ? [{ label: "DNC Excluded", value: run.dnc_excluded_count ?? 0, icon: Ban, color: "text-red-500" }]
              : []),
          ].map(stat => {
            const Icon = stat.icon;
            return (
              <Card key={stat.label}>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={cn("w-3.5 h-3.5", stat.color)} />
                    <p className="text-[11px] text-muted-foreground">{stat.label}</p>
                  </div>
                  <p className={cn("text-xl font-bold truncate", stat.color)}>{stat.value}</p>
                </CardContent>
              </Card>
            );
          })}
          {/* Errored enrollments card — only shown when count > 0 */}
          {(run.erroredEnrollmentCount ?? 0) > 0 && (
            <Card
              className="cursor-pointer hover:bg-muted/40 border-red-200 transition-colors"
              onClick={() => setContactStatusFilter("errored")}
            >
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle className="w-3.5 h-3.5 text-red-500" />
                  <p className="text-[11px] text-muted-foreground">Errored</p>
                </div>
                <p className="text-xl font-bold text-red-600">{run.erroredEnrollmentCount}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Click to view &amp; retry</p>
              </CardContent>
            </Card>
          )}
          {/* Backfill-skipped card — only shown when count > 0 */}
          {(run.backfillSkippedCount ?? 0) > 0 && (
            <Card
              className="cursor-pointer hover:bg-muted/40 border-orange-200 transition-colors"
              onClick={() => setBackfillOpen(true)}
            >
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <SkipForward className="w-3.5 h-3.5 text-orange-500" />
                  <p className="text-[11px] text-muted-foreground">Skipped (backfill)</p>
                </div>
                <p className="text-xl font-bold text-orange-600">{run.backfillSkippedCount}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Click to view contacts</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Run metadata */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
              {run.started_at && (
                <div>
                  <p className="text-muted-foreground mb-0.5">Started</p>
                  <p className="font-medium">{format(new Date(run.started_at), "MMM d, yyyy h:mm a")}</p>
                </div>
              )}
              {run.scheduled_at && run.status === "scheduled" && (
                <div>
                  <p className="text-muted-foreground mb-0.5">Scheduled for</p>
                  <p className="font-medium text-purple-700">{format(new Date(run.scheduled_at), "MMM d, yyyy h:mm a")}</p>
                </div>
              )}
              {run.completed_at && (
                <div>
                  <p className="text-muted-foreground mb-0.5">Completed</p>
                  <p className="font-medium">{format(new Date(run.completed_at), "MMM d, yyyy h:mm a")}</p>
                </div>
              )}
              {run.started_by_name && (
                <div>
                  <p className="text-muted-foreground mb-0.5">Started by</p>
                  <p className="font-medium">{run.started_by_name}</p>
                </div>
              )}
              {(run.send_window_start || run.send_window_end) && (
                <div>
                  <p className="text-muted-foreground mb-0.5">Send window</p>
                  <p className="font-medium">{run.send_window_start ?? "—"} – {run.send_window_end ?? "—"}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Enrollment timeline */}
        {timeline.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-indigo-500" />
                Enrollment timeline
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-4 px-4">
              <ResponsiveContainer width="100%" height={100}>
                <BarChart data={timeline} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis hide allowDecimals={false} />
                  <Tooltip
                    formatter={(v: number) => [`${v} enrolled`, ""]}
                    labelStyle={{ fontSize: 11 }}
                    contentStyle={{ fontSize: 11 }}
                  />
                  <Bar dataKey="count" fill="#6366f1" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Email engagement timeline */}
        {emailChartData.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Mail className="w-4 h-4 text-blue-500" />
                Email engagement over time
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-4 px-4">
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={emailChartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis hide allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 11 }} labelStyle={{ fontSize: 11 }} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 10 }} />
                  <Line type="monotone" dataKey="email_open"    stroke="#10b981" strokeWidth={1.5} dot={false} name="Opens"   />
                  <Line type="monotone" dataKey="email_click"   stroke="#6366f1" strokeWidth={1.5} dot={false} name="Clicks"  />
                  <Line type="monotone" dataKey="email_bounced" stroke="#ef4444" strokeWidth={1.5} dot={false} name="Bounced" />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Per-step breakdown */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-indigo-500" />
              Per-step breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-4">
            {steps.length > 0 ? (
              <>
                <div className="border-t overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-left py-2 px-3 font-medium text-muted-foreground w-6">#</th>
                        <th className="text-left py-2 px-3 font-medium text-muted-foreground">Step</th>
                        <th className="text-center py-2 px-3 font-medium text-muted-foreground">Delivered</th>
                        <th className="text-center py-2 px-3 font-medium text-muted-foreground">Opened</th>
                        <th className="text-center py-2 px-3 font-medium text-muted-foreground">Clicked</th>
                        <th className="text-center py-2 px-3 font-medium text-muted-foreground">Bounced</th>
                        <th className="text-left py-2 px-3 font-medium text-muted-foreground">Wait after</th>
                      </tr>
                    </thead>
                    <tbody>
                      {steps.map(step => (
                        <tr key={step.stepNum} className="border-b last:border-0 hover:bg-muted/20">
                          <td className="py-2 px-3 text-muted-foreground">{step.stepNum}</td>
                          <td className="py-2 px-3">
                            <div className="flex items-center gap-1.5">
                              <Mail className="w-3 h-3 text-blue-500 shrink-0" />
                              <span className="font-medium text-foreground truncate max-w-[140px]">{step.label}</span>
                            </div>
                            {step.subject && (
                              <p className="text-muted-foreground truncate max-w-[200px] text-[10px] mt-0.5 pl-4">{step.subject}</p>
                            )}
                          </td>
                          <td className="py-2 px-3 text-center">
                            <button
                              type="button"
                              className="font-medium hover:underline disabled:no-underline disabled:cursor-default"
                              disabled={step.sent === 0}
                              onClick={() => setWhoDrill({ stepNum: step.stepNum, type: "sent", label: `${step.label} — Delivered` })}
                            >
                              {step.sent}
                            </button>
                          </td>
                          <td className="py-2 px-3 text-center">
                            <div className="flex flex-col items-center">
                              <button
                                type="button"
                                className="font-medium text-emerald-700 hover:underline disabled:no-underline disabled:cursor-default"
                                disabled={step.opened === 0}
                                onClick={() => setWhoDrill({ stepNum: step.stepNum, type: "opened", label: `${step.label} — Opened` })}
                              >
                                {step.opened}
                              </button>
                              <span className="text-muted-foreground text-[10px]">{step.openRate}%</span>
                            </div>
                          </td>
                          <td className="py-2 px-3 text-center">
                            <div className="flex flex-col items-center">
                              <button
                                type="button"
                                className="font-medium text-indigo-700 hover:underline disabled:no-underline disabled:cursor-default"
                                disabled={step.clicked === 0}
                                onClick={() => setWhoDrill({ stepNum: step.stepNum, type: "clicked", label: `${step.label} — Clicked` })}
                              >
                                {step.clicked}
                              </button>
                              <span className="text-muted-foreground text-[10px]">{step.clickRate}%</span>
                            </div>
                          </td>
                          <td className="py-2 px-3 text-center">
                            <button
                              type="button"
                              className={cn("font-medium hover:underline disabled:no-underline disabled:cursor-default", step.bounced > 0 ? "text-red-600" : "text-muted-foreground")}
                              disabled={step.bounced === 0}
                              onClick={() => setWhoDrill({ stepNum: step.stepNum, type: "bounced", label: `${step.label} — Bounced` })}
                            >
                              {step.bounced}
                            </button>
                          </td>
                          <td className="py-2 px-3 text-muted-foreground text-xs">
                            {step.waitLabel ?? <span className="text-muted-foreground/40">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="text-center py-8 text-xs text-muted-foreground">
                <Mail className="w-7 h-7 mx-auto mb-2 opacity-30" />
                No email steps found in this sequence.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Enrolled contacts — filterable */}
        {contacts.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 flex-1">
                  <Users className="w-4 h-4 text-purple-500" />
                  Contacts ({filteredContacts.length}{filteredContacts.length !== contacts.length ? ` of ${contacts.length}` : ""})
                </CardTitle>
                {/* Search */}
                <div className="relative w-40">
                  <Search className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  <Input className="h-7 pl-7 text-xs" placeholder="Name / email / company…"
                    value={contactSearch} onChange={e => setContactSearch(e.target.value)} />
                </div>
                {/* Status filter */}
                <select
                  className="h-7 text-xs border rounded-md px-2 bg-background"
                  value={contactStatusFilter}
                  onChange={e => setContactStatusFilter(e.target.value as "all" | "enrolled" | "skipped" | "errored")}
                >
                  <option value="all">All statuses</option>
                  <option value="enrolled">Enrolled</option>
                  <option value="skipped">Skipped</option>
                  <option value="errored">Errored</option>
                </select>
                {/* Score range */}
                <div className="flex items-center gap-1">
                  <Input className="h-7 w-16 text-xs" placeholder="Min ↑" type="number"
                    value={scoreMin} onChange={e => setScoreMin(e.target.value)} />
                  <span className="text-xs text-muted-foreground">–</span>
                  <Input className="h-7 w-16 text-xs" placeholder="Max ↑" type="number"
                    value={scoreMax} onChange={e => setScoreMax(e.target.value)} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0 pb-0">
              <div className="border-t overflow-hidden max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr className="border-b">
                      <th className="text-left py-2 px-3 font-medium text-muted-foreground">Name</th>
                      <th className="text-left py-2 px-3 font-medium text-muted-foreground hidden sm:table-cell">Company</th>
                      <th className="text-left py-2 px-3 font-medium text-muted-foreground">Email</th>
                      <th className="text-center py-2 px-3 font-medium text-muted-foreground">Status</th>
                      <th className="text-left py-2 px-3 font-medium text-muted-foreground hidden md:table-cell">Enrolled at</th>
                      <th className="text-center py-2 px-3 font-medium text-muted-foreground w-14">Opens</th>
                      <th className="text-center py-2 px-3 font-medium text-muted-foreground w-14">Clicks</th>
                      <th className="text-right py-2 px-3 font-medium text-muted-foreground w-14">Score</th>
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredContacts.map(c => {
                      const badgeCls = ENROLLMENT_STATUS_BADGE[c.enrollment_status] ?? "bg-gray-100 text-gray-500";
                      const isErrored = c.enrollment_status === "errored";
                      return (
                        <tr
                          key={c.id}
                          className={cn(
                            "border-b last:border-0 hover:bg-muted/20 cursor-pointer",
                            isErrored && "bg-red-50/40"
                          )}
                          onClick={() => { setSelectedContact(c); setHistoryOpen(true); }}
                        >
                          <td className="py-1.5 px-3 font-medium text-foreground whitespace-nowrap">
                            {c.first_name} {c.last_name}
                          </td>
                          <td className="py-1.5 px-3 text-muted-foreground hidden sm:table-cell truncate max-w-[120px]">
                            {c.company_name ?? <span className="opacity-30">—</span>}
                          </td>
                          <td className="py-1.5 px-3 text-muted-foreground truncate max-w-[160px]">{c.email}</td>
                          <td className="py-1.5 px-3 text-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", badgeCls)}>
                                {c.enrollment_status ?? "skipped"}
                              </span>
                              {isErrored && (c.resume_error_count ?? 0) > 0 && (
                                <span className="text-[9px] text-red-500">{c.resume_error_count} attempt{c.resume_error_count !== 1 ? "s" : ""}</span>
                              )}
                            </div>
                          </td>
                          <td className="py-1.5 px-3 text-muted-foreground hidden md:table-cell whitespace-nowrap">
                            {c.enrolled_at ? format(new Date(c.enrolled_at), "MMM d, h:mm a") : <span className="opacity-30">—</span>}
                          </td>
                          <td className="py-1.5 px-3 text-center">
                            <span className={cn("font-medium", (c.opens ?? 0) > 0 ? "text-emerald-700" : "text-muted-foreground/40")}>
                              {c.opens ?? 0}
                            </span>
                          </td>
                          <td className="py-1.5 px-3 text-center">
                            <span className={cn("font-medium", (c.clicks ?? 0) > 0 ? "text-indigo-700" : "text-muted-foreground/40")}>
                              {c.clicks ?? 0}
                            </span>
                          </td>
                          <td className="py-1.5 px-3 text-right">
                            <span className="font-mono text-indigo-600 font-medium">{c.lead_score ?? 0}</span>
                          </td>
                          <td className="py-1.5 px-3" onClick={e => e.stopPropagation()}>
                            {isErrored && c.enrollment_id != null ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-5 text-[10px] px-1.5 border-red-300 text-red-600 hover:bg-red-50"
                                disabled={retryMutation.isPending}
                                onClick={() => retryMutation.mutate(c.enrollment_id!)}
                                title="Reset and retry this enrollment"
                              >
                                <RefreshCw className="w-2.5 h-2.5 mr-0.5" /> Retry
                              </Button>
                            ) : (
                              <Mail className="w-3 h-3 text-muted-foreground/40 hover:text-indigo-500" />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredContacts.length === 0 && (
                      <tr>
                        <td colSpan={9} className="py-6 text-center text-muted-foreground">
                          No contacts match the current filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {contacts.length === 0 && run.enrolled === 0 && (
          <div className="text-center py-6 text-xs text-muted-foreground">
            <Users className="w-7 h-7 mx-auto mb-2 opacity-30" />
            No contacts were enrolled in this run.
          </div>
        )}
      </div>

      {/* Email history sheet */}
      <Sheet open={historyOpen} onOpenChange={open => { setHistoryOpen(open); if (!open) setSelectedContact(null); }}>
        <SheetContent className="w-[380px] sm:max-w-[420px] flex flex-col gap-0 p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="text-sm">
              Email history — {selectedContact?.first_name} {selectedContact?.last_name}
            </SheetTitle>
            <p className="text-xs text-muted-foreground">{selectedContact?.email}</p>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-5">
            {eventsFetching ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : contactEvents.length === 0 ? (
              <div className="text-center py-12">
                <Mail className="w-8 h-8 mx-auto mb-2 opacity-20" />
                <p className="text-sm text-muted-foreground">No email events for this run window.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {contactEvents.map((ev, i) => {
                  const evCfg = EVENT_LABELS[ev.event_type];
                  return (
                    <div key={i} className="flex items-start gap-3 p-3 rounded-lg border bg-card">
                      <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                        <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={cn("text-xs font-medium", evCfg?.color ?? "text-foreground")}>
                          {evCfg?.label ?? ev.event_type}
                        </p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {format(new Date(ev.created_at), "MMM d, yyyy h:mm a")}
                        </p>
                        {ev.event_type === "email_sent" && ev.metadata?.smtpAccountName ? (
                          <p className="text-[11px] text-indigo-600 mt-0.5">
                            Sent via {String(ev.metadata.smtpAccountName)}
                          </p>
                        ) : ev.metadata?.subject ? (
                          <p className="text-[10px] text-muted-foreground/70 truncate mt-0.5">
                            {String(ev.metadata.subject)}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Backfill-skipped contacts sheet */}
      <Sheet open={backfillOpen} onOpenChange={setBackfillOpen}>
        <SheetContent className="w-[420px] sm:max-w-[460px] flex flex-col gap-0 p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="text-sm flex items-center gap-2">
              <SkipForward className="w-4 h-4 text-orange-500" />
              Skipped during backfill
            </SheetTitle>
            <p className="text-xs text-muted-foreground">
              {run.backfillSkippedCount} contact{run.backfillSkippedCount !== 1 ? "s" : ""} whose
              intent state changed during a CSV backfill but whose sequence enrollment was suppressed.
              Each contact's timeline has a <em>sequence_enrollment_skipped</em> event with the details.
            </p>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-5">
            {(run.backfillSkippedContacts ?? []).length === 0 ? (
              <div className="text-center py-12">
                <Users className="w-8 h-8 mx-auto mb-2 opacity-20" />
                <p className="text-sm text-muted-foreground">No backfill-skipped contacts found.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {(run.backfillSkippedContacts ?? []).map(c => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground truncate">
                        {c.first_name} {c.last_name}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">{c.email}</p>
                      {c.company_name && (
                        <p className="text-[11px] text-muted-foreground/70 truncate">{c.company_name}</p>
                      )}
                      <p className="text-[10px] text-orange-500 mt-0.5">
                        Skipped {format(new Date(c.skipped_at), "MMM d, h:mm a")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] font-mono text-indigo-600 font-medium">{c.lead_score}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        title="Open contact timeline"
                        onClick={() => navigate(`/crm/contacts/${c.id}`)}
                      >
                        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Step drill-down: WHO opened/clicked/received/bounced a given step */}
      <Sheet open={!!whoDrill} onOpenChange={open => { if (!open) setWhoDrill(null); }}>
        <SheetContent className="w-[380px] sm:max-w-[420px] flex flex-col gap-0 p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="text-sm">{whoDrill?.label}</SheetTitle>
            <p className="text-xs text-muted-foreground">
              {whoFetching ? "Loading…" : `${whoContacts.length} contact${whoContacts.length !== 1 ? "s" : ""}`}
            </p>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-5">
            {whoFetching ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : whoContacts.length === 0 ? (
              <div className="text-center py-12">
                <Users className="w-8 h-8 mx-auto mb-2 opacity-20" />
                <p className="text-sm text-muted-foreground">No contacts found for this metric.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {whoContacts.map(c => (
                  <div key={c.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border bg-card">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{c.first_name} {c.last_name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{c.email}</p>
                    </div>
                    <p className="text-[11px] text-muted-foreground shrink-0 whitespace-nowrap">
                      {c.occurred_at ? format(new Date(c.occurred_at), "MMM d, h:mm a") : "—"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
