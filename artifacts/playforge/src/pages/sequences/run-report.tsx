import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft, Play, CheckCircle2, Clock,
  Users, SkipForward, AlertCircle, RefreshCw,
  BarChart2, ExternalLink, Pause, XCircle, Ban,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { formatReportDate, formatReportDateTime } from "@/lib/reportTime";
import { RunWizard } from "./RunWizard";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

// ── Types ─────────────────────────────────────────────────────────────────────
interface SequenceRun {
  id: number;
  status: string;
  total_contacts: number;
  enrolled: number;
  skipped: number;
  errors: number;
  dnc_excluded_count: number;
  started_at: string | null;
  completed_at: string | null;
  scheduled_at: string | null;
  journey_name: string | null;
  client_name: string | null;
  started_by_name: string | null;
  created_at: string;
}

// ── Status config ─────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { label: string; badge: string }> = {
  pending:   { label: "Pending",   badge: "bg-gray-100 text-gray-700" },
  scheduled: { label: "Scheduled", badge: "bg-indigo-100 text-indigo-700" },
  running:   { label: "Running",   badge: "bg-blue-100 text-blue-700" },
  completed: { label: "Completed", badge: "bg-emerald-100 text-emerald-700" },
  paused:    { label: "Paused",    badge: "bg-amber-100 text-amber-700" },
  cancelled: { label: "Cancelled", badge: "bg-red-100 text-red-700" },
  error:     { label: "Error",     badge: "bg-red-100 text-red-700" },
};

const STATUS_CHART_COLORS: Record<string, string> = {
  completed: "#10b981",
  running:   "#3b82f6",
  scheduled: "#6366f1",
  paused:    "#f59e0b",
  cancelled: "#ef4444",
  error:     "#ef4444",
  pending:   "#6b7280",
};

// ── RunReportPage ─────────────────────────────────────────────────────────────
interface RunReportProps { id: string; }

export default function RunReportPage({ id }: RunReportProps) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [runWizardOpen, setRunWizardOpen] = useState(false);
  const [cancelConfirmId, setCancelConfirmId] = useState<number | null>(null);
  const [bulkCancelOpen, setBulkCancelOpen] = useState(false);
  const [bulkCancelling, setBulkCancelling] = useState(false);

  const actionMutation = useMutation({
    mutationFn: async ({ runId, action }: { runId: number; action: string }) => {
      const r = await api(`/sequences/${id}/runs/${runId}/${action}`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Request failed with status ${r.status}`);
      }
      return r.json();
    },
    onMutate: async ({ runId, action }) => {
      await qc.cancelQueries({ queryKey: ["sequence-runs", id] });
      const prev = qc.getQueryData<SequenceRun[]>(["sequence-runs", id]);
      qc.setQueryData<SequenceRun[]>(["sequence-runs", id], old =>
        old?.map(r =>
          r.id === runId
            ? { ...r, status: action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled" }
            : r
        ) ?? old
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["sequence-runs", id], ctx.prev);
      toast({ title: "Action failed", variant: "destructive" });
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ["sequence-runs", id] });
      if (cancelConfirmId === vars?.runId) setCancelConfirmId(null);
    },
    onSuccess: () => {
      toast({ title: "Run updated" });
    },
  });

  const { data: runs = [], isLoading, refetch } = useQuery<SequenceRun[]>({
    queryKey: ["sequence-runs", id],
    queryFn: () => api(`/sequences/${id}/runs`).then(r => r.json()),
    refetchInterval: 15_000,
  });

  const { data: sequence } = useQuery<{ id: number; name: string }>({
    queryKey: ["email-sequences", id],
    queryFn: () => api(`/email-sequences/${id}`).then(r => r.json()),
  });

  const activeRuns = runs.filter(r => r.status === "running" || r.status === "paused");
  const activeCount = activeRuns.length;

  const handleBulkCancel = async () => {
    if (activeRuns.length === 0) return;
    setBulkCancelling(true);
    const ids = activeRuns.map(r => r.id);

    await qc.cancelQueries({ queryKey: ["sequence-runs", id] });
    const prev = qc.getQueryData<SequenceRun[]>(["sequence-runs", id]);
    qc.setQueryData<SequenceRun[]>(["sequence-runs", id], old =>
      old?.map(r => (ids.includes(r.id) ? { ...r, status: "cancelled" } : r)) ?? old
    );

    const results = await Promise.allSettled(
      ids.map(runId =>
        api(`/sequences/${id}/runs/${runId}/cancel`, { method: "POST" }).then(r => {
          if (!r.ok) throw new Error(`Run ${runId} failed`);
        })
      )
    );

    const failed = results.filter(r => r.status === "rejected").length;
    const succeeded = ids.length - failed;

    if (failed > 0) {
      if (prev) qc.setQueryData(["sequence-runs", id], prev);
      toast({
        title: failed === ids.length ? "Cancel failed" : "Some runs failed to cancel",
        description: `${succeeded} cancelled, ${failed} failed.`,
        variant: "destructive",
      });
    } else {
      toast({ title: `Cancelled ${succeeded} run${succeeded !== 1 ? "s" : ""}` });
    }

    qc.invalidateQueries({ queryKey: ["sequence-runs", id] });
    setBulkCancelling(false);
    setBulkCancelOpen(false);
  };

  const totalEnrolled  = runs.reduce((s, r) => s + (r.enrolled           ?? 0), 0);
  const totalSkipped   = runs.reduce((s, r) => s + (r.skipped            ?? 0), 0);
  const totalErrors    = runs.reduce((s, r) => s + (r.errors             ?? 0), 0);
  const totalDnc       = runs.reduce((s, r) => s + (r.dnc_excluded_count ?? 0), 0);
  const completedCount = runs.filter(r => r.status === "completed").length;
  const runningCount   = runs.filter(r => r.status === "running").length;

  const chartData = [...runs].reverse().slice(-10).map(r => ({
    label:    r.started_at ? formatReportDate(r.started_at) : `#${r.id}`,
    enrolled: r.enrolled ?? 0,
    status:   r.status,
  }));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="border-b bg-card px-4 py-2.5 flex items-center gap-3 shrink-0">
        <Button variant="ghost" size="icon" className="h-8 w-8"
          onClick={() => navigate(`/sequences/${id}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm truncate">{sequence?.name ?? "Sequence"}</span>
            <span className="text-xs text-muted-foreground">· Run History</span>
          </div>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => refetch()}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
        </Button>
        <Button
          size="sm"
          className="bg-emerald-600 hover:bg-emerald-700 shrink-0"
          onClick={() => setRunWizardOpen(true)}
        >
          <Play className="w-3.5 h-3.5 mr-1.5" /> New Run
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 bg-muted/30 space-y-5">
        {/* KPI row */}
        <div className="grid grid-cols-5 gap-3">
          {isLoading
            ? Array.from({ length: 5 }).map((_, i) => (
                <Card key={i}><CardContent className="pt-4 pb-4"><Skeleton className="h-8 w-full" /></CardContent></Card>
              ))
            : [
                { label: "Total Runs",   value: runs.length,    icon: BarChart2,    color: "text-indigo-600" },
                { label: "Running",      value: runningCount,   icon: RefreshCw,    color: "text-blue-600" },
                { label: "Completed",    value: completedCount, icon: CheckCircle2, color: "text-emerald-600" },
                { label: "Total Enrolled", value: totalEnrolled, icon: Users,       color: "text-purple-600" },
                { label: "Total Skipped",  value: totalSkipped,  icon: SkipForward, color: "text-amber-600" },
                ...(totalDnc > 0 ? [{ label: "DNC Excluded", value: totalDnc, icon: Ban, color: "text-red-500" }] : []),
              ].map(stat => {
                const Icon = stat.icon;
                return (
                  <Card key={stat.label}>
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className={cn("w-4 h-4", stat.color)} />
                        <p className="text-xs text-muted-foreground">{stat.label}</p>
                      </div>
                      <p className={cn("text-2xl font-bold", stat.color)}>{stat.value}</p>
                    </CardContent>
                  </Card>
                );
              })}
        </div>

        {/* Timeline chart */}
        {!isLoading && chartData.length >= 2 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Contacts Enrolled per Run</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 pb-4">
              <ResponsiveContainer width="100%" height={130}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, borderRadius: 6 }}
                    formatter={(v: number) => [v, "Enrolled"]}
                  />
                  <Bar dataKey="enrolled" radius={[3, 3, 0, 0]} maxBarSize={40}>
                    {chartData.map((entry, idx) => (
                      <Cell key={idx} fill={STATUS_CHART_COLORS[entry.status] ?? "#6366f1"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Runs table */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-sm font-semibold">All Runs</CardTitle>
              <div className="flex items-center gap-3">
                {activeCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs px-2.5 text-red-600 hover:text-red-700 border-red-200 hover:bg-red-50"
                    onClick={() => setBulkCancelOpen(true)}
                    disabled={bulkCancelling}
                  >
                    <XCircle className="w-3 h-3 mr-1" />
                    Cancel all active ({activeCount})
                  </Button>
                )}
                {runs.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {runs.length} run{runs.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="space-y-2 p-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 rounded-lg" />)}
              </div>
            ) : runs.length === 0 ? (
              <div className="text-center py-14 text-muted-foreground">
                <Play className="w-8 h-8 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">No runs yet</p>
                <p className="text-xs mt-1 mb-4">
                  Launch this sequence to start sending emails to contacts.
                </p>
                <Button
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => setRunWizardOpen(true)}
                >
                  <Play className="w-3.5 h-3.5 mr-1.5" /> Start First Run
                </Button>
              </div>
            ) : (
              <div className="divide-y">
                {runs.map(run => {
                  const cfg = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.pending;
                  const isActionable = run.status === "running" || run.status === "paused";
                  const isPending = actionMutation.isPending && actionMutation.variables?.runId === run.id;
                  const isCancelConfirming = cancelConfirmId === run.id;
                  return (
                    <div
                      key={run.id}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors"
                    >
                      {/* Status badge */}
                      <span className={cn(
                        "text-xs px-2 py-0.5 rounded-full font-medium shrink-0",
                        cfg.badge
                      )}>
                        {cfg.label}
                      </span>

                      {/* Info */}
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground">Run #{run.id}</span>
                          {run.journey_name && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                              {run.journey_name}
                            </Badge>
                          )}
                          {run.client_name && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                              {run.client_name}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          {run.status === "scheduled" ? (
                            <span className="flex items-center gap-1 text-indigo-600 font-medium">
                              <Clock className="w-3 h-3" />
                              Sends {run.scheduled_at ? formatReportDateTime(run.scheduled_at) : "scheduled"}
                            </span>
                          ) : (
                            <>
                              <span className="flex items-center gap-1">
                                <Users className="w-3 h-3" />
                                {run.enrolled} enrolled
                              </span>
                              {run.skipped > 0 && (
                                <span className="flex items-center gap-1">
                                  <SkipForward className="w-3 h-3" />
                                  {run.skipped} skipped
                                </span>
                              )}
                              {(run.dnc_excluded_count ?? 0) > 0 && (
                                <span className="flex items-center gap-1 text-red-500">
                                  <Ban className="w-3 h-3" />
                                  {run.dnc_excluded_count} DNC
                                </span>
                              )}
                              {run.started_at && (
                                <span className="flex items-center gap-1">
                                  <Clock className="w-3 h-3" />
                                  {formatReportDateTime(run.started_at)}
                                </span>
                              )}
                            </>
                          )}
                          {run.started_by_name && (
                            <span className="text-muted-foreground/70">by {run.started_by_name}</span>
                          )}
                          {run.total_contacts > 0 && run.status === "scheduled" && (
                            <span className="text-muted-foreground/70">· {run.total_contacts} contacts</span>
                          )}
                        </div>
                      </div>

                      {/* Inline actions for running / paused rows */}
                      {isActionable && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          {run.status === "running" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs px-2.5"
                              disabled={isPending}
                              onClick={() => actionMutation.mutate({ runId: run.id, action: "pause" })}
                            >
                              <Pause className="w-3 h-3 mr-1" />
                              Pause
                            </Button>
                          )}
                          {run.status === "paused" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs px-2.5"
                              disabled={isPending}
                              onClick={() => actionMutation.mutate({ runId: run.id, action: "resume" })}
                            >
                              <RefreshCw className="w-3 h-3 mr-1" />
                              Resume
                            </Button>
                          )}
                          {isCancelConfirming ? (
                            <div className="flex items-center gap-1">
                              <span className="text-[11px] text-red-600 font-medium">Cancel?</span>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs px-2 border-red-300 text-red-600 hover:bg-red-50"
                                disabled={isPending}
                                onClick={() => {
                                  actionMutation.mutate({ runId: run.id, action: "cancel" });
                                  setCancelConfirmId(null);
                                }}
                              >
                                Yes
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs px-2"
                                disabled={isPending}
                                onClick={() => setCancelConfirmId(null)}
                              >
                                No
                              </Button>
                            </div>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs px-2.5 text-red-600 hover:text-red-700 border-red-200 hover:bg-red-50"
                              disabled={isPending}
                              onClick={() => setCancelConfirmId(run.id)}
                            >
                              <XCircle className="w-3 h-3 mr-1" />
                              Cancel
                            </Button>
                          )}
                        </div>
                      )}

                      {/* View detail */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs shrink-0"
                        onClick={() => navigate(`/sequences/${id}/runs/${run.id}`)}
                      >
                        <ExternalLink className="w-3 h-3 mr-1" />
                        View
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Error alert */}
        {!isLoading && totalErrors > 0 && (
          <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>
              {totalErrors} total errors across all runs. Check your sequence configuration.
            </span>
          </div>
        )}
      </div>

      <AlertDialog open={bulkCancelOpen} onOpenChange={o => !bulkCancelling && setBulkCancelOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel all active runs?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel {activeCount} run{activeCount !== 1 ? "s" : ""} currently running or paused. Contacts still in progress will stop receiving emails from this sequence. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkCancelling}>Keep them</AlertDialogCancel>
            <AlertDialogAction
              disabled={bulkCancelling}
              onClick={(e) => {
                e.preventDefault();
                handleBulkCancel();
              }}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {bulkCancelling ? "Cancelling…" : `Cancel ${activeCount} run${activeCount !== 1 ? "s" : ""}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {sequence && (
        <RunWizard
          open={runWizardOpen}
          onClose={() => {
            setRunWizardOpen(false);
            qc.invalidateQueries({ queryKey: ["sequence-runs", id] });
          }}
          sequence={{ id: parseInt(id), name: sequence.name ?? "" }}
        />
      )}
    </div>
  );
}
