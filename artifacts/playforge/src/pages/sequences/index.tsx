import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch, Plus, Search, Pencil, Trash2, Loader2,
  Users, MoreHorizontal, Zap, Play, Pause, Rocket,
  ShieldCheck, AlertTriangle, XCircle, HelpCircle,
} from "lucide-react";
import { RunWizard } from "./RunWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface EmailSequence {
  id: number;
  name: string;
  status: "draft" | "active" | "paused";
  triggerType: string;
  playId: number | null;
  playName: string | null;
  stepCount: number;
  enrolledCount: number;
  contactCount: number;
  createdAt: string;
}

interface DeliverabilityStats {
  sent: number;
  delivered: number;
  bounced: number;
  unsubscribed: number;
  deliveryRate: number;
  bounceRate: number;
  unsubscribeRate: number;
  health: "green" | "amber" | "red" | "none";
}

const STATUS_CONFIG = {
  draft:  { label: "Draft",  dot: "bg-gray-400",    classes: "bg-gray-100 text-gray-700 border-gray-200" },
  active: { label: "Active", dot: "bg-emerald-500", classes: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  paused: { label: "Paused", dot: "bg-amber-400",   classes: "bg-amber-50 text-amber-700 border-amber-200" },
};

const TRIGGER_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  FORM_SUBMITTED: "Form Submitted",
  PAGE_VIEWED: "Page Viewed",
  LINK_CLICKED: "Link Clicked",
};

const HEALTH_CONFIG = {
  green: {
    label: "Healthy",
    icon: ShieldCheck,
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
    icon_class: "text-emerald-500",
  },
  amber: {
    label: "Warning",
    icon: AlertTriangle,
    badge: "bg-amber-50 text-amber-700 border-amber-200",
    icon_class: "text-amber-500",
  },
  red: {
    label: "Critical",
    icon: XCircle,
    badge: "bg-red-50 text-red-700 border-red-200",
    icon_class: "text-red-500",
  },
  none: {
    label: "No data",
    icon: HelpCircle,
    badge: "bg-gray-100 text-gray-500 border-gray-200",
    icon_class: "text-gray-400",
  },
};

function DeliverabilityBadge({ stats }: { stats: DeliverabilityStats | undefined }) {
  const health = stats?.health ?? "none";
  const cfg = HEALTH_CONFIG[health];
  const Icon = cfg.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border cursor-default select-none ${cfg.badge}`}
          onClick={e => e.stopPropagation()}
        >
          <Icon className={`w-3 h-3 ${cfg.icon_class}`} />
          {cfg.label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="p-0 overflow-hidden rounded-lg shadow-lg border border-border bg-popover">
        {stats && stats.sent > 0 ? (
          <div className="min-w-[180px]">
            <div className="px-3 py-2 border-b border-border bg-muted/40">
              <p className="text-xs font-semibold text-foreground">Deliverability Breakdown</p>
            </div>
            <div className="px-3 py-2 space-y-1.5">
              <Row label="Sent" value={String(stats.sent)} />
              <Row label="Delivered" value={`${stats.deliveryRate}%`} accent={stats.deliveryRate >= 95 ? "emerald" : stats.deliveryRate >= 85 ? "amber" : "red"} />
              <Row label="Bounced" value={`${stats.bounceRate}%`} accent={stats.bounceRate < 2 ? "emerald" : stats.bounceRate < 5 ? "amber" : "red"} />
              <Row label="Unsubscribed" value={`${stats.unsubscribeRate}%`} />
            </div>
          </div>
        ) : (
          <div className="px-3 py-2.5 text-xs text-muted-foreground">
            No emails sent yet
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: "emerald" | "amber" | "red" }) {
  const color = accent === "emerald" ? "text-emerald-600" : accent === "amber" ? "text-amber-600" : accent === "red" ? "text-red-600" : "text-foreground";
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

export default function SequencesPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<EmailSequence | null>(null);
  const [runTarget, setRunTarget] = useState<EmailSequence | null>(null);

  const { data: sequences = [], isLoading } = useQuery<EmailSequence[]>({
    queryKey: ["email-sequences"],
    queryFn: () => fetch("/api/email-sequences", { credentials: "include" }).then(r => r.json()),
  });

  const { data: deliverabilityMap = {} } = useQuery<Record<number, DeliverabilityStats>>({
    queryKey: ["sequences-deliverability"],
    queryFn: () => fetch("/api/analytics/sequences/deliverability", { credentials: "include" }).then(r => r.json()),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/email-sequences/${id}`, { method: "DELETE", credentials: "include" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-sequences"] });
      toast({ title: "Sequence deleted" });
      setDeleteTarget(null);
    },
    onError: () => toast({ title: "Failed to delete sequence", variant: "destructive" }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      fetch(`/api/email-sequences/${id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-sequences"] });
      toast({ title: "Status updated" });
    },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  const filtered = sequences.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    (s.playName ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Sequences</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Automated email workflows for your plays</p>
          </div>
          <Button onClick={() => navigate("/sequences/new")} className="bg-indigo-600 hover:bg-indigo-700">
            <Plus className="w-4 h-4 mr-2" /> New Sequence
          </Button>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search sequences..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="border rounded-lg bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead>Sequence</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Play</TableHead>
                <TableHead className="text-center">Steps</TableHead>
                <TableHead className="text-center">Enrolled</TableHead>
                <TableHead>Deliverability</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-16 text-center">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-16 text-center">
                    <GitBranch className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
                    <p className="text-muted-foreground text-sm">
                      {search ? "No sequences match your search" : "No sequences yet — create your first one"}
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(seq => {
                  const cfg = STATUS_CONFIG[seq.status] ?? STATUS_CONFIG.draft;
                  const delivStats = deliverabilityMap[seq.id];
                  return (
                    <TableRow key={seq.id} className="group cursor-pointer hover:bg-muted/30"
                      onClick={() => navigate(`/sequences/${seq.id}`)}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
                            <GitBranch className="w-4 h-4 text-purple-600" />
                          </div>
                          <span className="font-medium text-sm text-foreground">{seq.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border flex items-center gap-1.5 w-fit ${cfg.classes}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                          {cfg.label}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {TRIGGER_LABELS[seq.triggerType] ?? seq.triggerType}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {seq.playName ?? <span className="text-muted-foreground/50">—</span>}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
                          <Zap className="w-3.5 h-3.5" />{seq.stepCount}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        {seq.enrolledCount > seq.contactCount ? (
                          <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
                            <Users className="w-3.5 h-3.5" />
                            <span>{seq.contactCount} contacts</span>
                            <span className="text-muted-foreground/50">·</span>
                            <span>{seq.enrolledCount} runs</span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
                            <Users className="w-3.5 h-3.5" />{seq.enrolledCount} enrolled
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <DeliverabilityBadge stats={delivStats} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(seq.createdAt), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100">
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => navigate(`/sequences/${seq.id}`)}>
                              <Pencil className="w-4 h-4 mr-2" /> Open Editor
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setRunTarget(seq)}>
                              <Rocket className="w-4 h-4 mr-2" /> Run Sequence…
                            </DropdownMenuItem>
                            {seq.status !== "active" && (
                              <DropdownMenuItem onClick={() => statusMutation.mutate({ id: seq.id, status: "active" })}>
                                <Play className="w-4 h-4 mr-2" /> Activate
                              </DropdownMenuItem>
                            )}
                            {seq.status === "active" && (
                              <DropdownMenuItem onClick={() => statusMutation.mutate({ id: seq.id, status: "paused" })}>
                                <Pause className="w-4 h-4 mr-2" /> Pause
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setDeleteTarget(seq)}
                            >
                              <Trash2 className="w-4 h-4 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        {runTarget && (
          <RunWizard
            open={!!runTarget}
            onClose={() => setRunTarget(null)}
            sequence={runTarget}
          />
        )}

        <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete sequence?</AlertDialogTitle>
              <AlertDialogDescription>
                "{deleteTarget?.name}" and all its enrollments will be permanently deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive hover:bg-destructive/90"
                onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}
