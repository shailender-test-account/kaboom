import { useState, useCallback, useEffect, useRef, createContext, useContext, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  Panel,
  type Connection,
  type Node,
  type Edge,
  type NodeProps,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft, Loader2, Save, Zap, Mail, Clock,
  GitBranch, Tag, Webhook, CheckCircle2, Plus,
  Settings2, Trash2, ChevronDown, BarChart2, Workflow,
  Play, History, Users, ChevronRight, SendHorizonal,
  AlertTriangle, SkipForward, CircleDot, Check, Eye, MousePointerClick,
  RefreshCw, MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RunWizard } from "./RunWizard";
import { format, formatDistanceToNow } from "date-fns";
import { groupEnrollments } from "@/lib/enrollmentGrouping";

// ── Node colours ─────────────────────────────────────────────────────────────
const NODE_COLORS: Record<string, { bg: string; border: string; header: string; text: string }> = {
  trigger:   { bg: "#fff7ed", border: "#f97316", header: "#ea580c", text: "white" },
  email:     { bg: "#eff6ff", border: "#3b82f6", header: "#2563eb", text: "white" },
  wait:      { bg: "#f9fafb", border: "#6b7280", header: "#4b5563", text: "white" },
  condition: { bg: "#faf5ff", border: "#a855f7", header: "#9333ea", text: "white" },
  tag:       { bg: "#f0fdfa", border: "#14b8a6", header: "#0d9488", text: "white" },
  webhook:   { bg: "#f8fafc", border: "#64748b", header: "#475569", text: "white" },
  goal:      { bg: "#f0fdf4", border: "#22c55e", header: "#16a34a", text: "white" },
};

const NODE_ICONS: Record<string, React.ComponentType<any>> = {
  trigger: Zap, email: Mail, wait: Clock,
  condition: GitBranch, tag: Tag, webhook: Webhook, goal: CheckCircle2,
};

const NODE_LABELS: Record<string, string> = {
  trigger: "TRIGGER", email: "EMAIL", wait: "WAIT",
  condition: "CONDITION", tag: "TAG", webhook: "WEBHOOK", goal: "GOAL",
};

// ── Canvas stats context (per-email-node aggregates) ─────────────────────────
type CanvasStat = { sent: number; opens: number; clicks: number; openRate: number; clickRate: number };
const CanvasStatsContext = createContext<Record<string, CanvasStat>>({});

// ── Custom node base ──────────────────────────────────────────────────────────
function FlowNode({ id, type, data, selected }: NodeProps & { type: string }) {
  const stats = useContext(CanvasStatsContext);
  const stat = type === "email" ? stats[id] : undefined;
  const c = NODE_COLORS[type] ?? NODE_COLORS.email;
  const Icon = NODE_ICONS[type] ?? Zap;
  const showTargetHandle = type !== "trigger";
  const isCond = type === "condition";

  return (
    <div
      style={{
        background: c.bg,
        border: `2px solid ${selected ? c.header : c.border}`,
        borderRadius: 10,
        minWidth: 180,
        boxShadow: selected ? `0 0 0 3px ${c.border}33` : "0 2px 8px rgba(0,0,0,.08)",
        transition: "box-shadow .15s, border-color .15s",
      }}
    >
      {showTargetHandle && (
        <Handle type="target" position={Position.Top}
          style={{ background: "#94a3b8", width: 10, height: 10, border: "2px solid white" }} />
      )}

      {/* Header */}
      <div style={{ background: c.header, color: c.text, borderRadius: "8px 8px 0 0", padding: "6px 12px" }}
        className="flex items-center gap-1.5 text-xs font-bold">
        <Icon className="w-3 h-3" />
        {NODE_LABELS[type] ?? type.toUpperCase()}
      </div>

      {/* Body */}
      <div className="px-3 py-2 text-xs text-gray-600 min-h-[36px]">
        <NodeBody type={type} data={data as any} />
        {type === "email" && stat && stat.sent > 0 && (
          <div className="flex items-center gap-1 mt-2" data-testid={`email-node-stats-${id}`}>
            <span
              className="inline-flex items-center gap-0.5 rounded bg-blue-100 text-blue-700 px-1.5 py-0.5 text-[10px] font-semibold"
              title={`${stat.opens} opens out of ${stat.sent} sent`}
            >
              <Eye className="w-2.5 h-2.5" /> {stat.openRate}%
            </span>
            <span
              className="inline-flex items-center gap-0.5 rounded bg-purple-100 text-purple-700 px-1.5 py-0.5 text-[10px] font-semibold"
              title={`${stat.clicks} clicks out of ${stat.sent} sent`}
            >
              <MousePointerClick className="w-2.5 h-2.5" /> {stat.clickRate}%
            </span>
            <span className="text-[10px] text-gray-400 ml-auto" title="Emails sent">
              {stat.sent}
            </span>
          </div>
        )}
      </div>

      {isCond ? (
        <>
          <Handle type="source" position={Position.Bottom} id="true"
            style={{ left: "30%", background: "#22c55e", width: 10, height: 10, border: "2px solid white" }} />
          <Handle type="source" position={Position.Bottom} id="false"
            style={{ left: "70%", background: "#ef4444", width: 10, height: 10, border: "2px solid white" }} />
          <div className="flex justify-between px-3 pb-1.5 text-[10px] font-semibold">
            <span className="text-emerald-600" style={{ marginLeft: "10%" }}>Yes</span>
            <span className="text-red-500" style={{ marginRight: "10%" }}>No</span>
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom}
          style={{ background: "#94a3b8", width: 10, height: 10, border: "2px solid white" }} />
      )}
    </div>
  );
}

function NodeBody({ type, data }: { type: string; data: Record<string, any> }) {
  if (type === "trigger")   return <span className="font-medium">{TRIGGER_LABELS[data.triggerType] ?? "Select trigger…"}</span>;
  if (type === "email")     return <span>{data.templateName ?? <span className="text-gray-400 italic">No template selected</span>}</span>;
  if (type === "wait")      return <span>{data.duration ? `${data.duration} ${data.unit ?? "hours"}` : <span className="text-gray-400 italic">Set duration…</span>}</span>;
  if (type === "condition") return <span>{data.conditionType ? `${CONDITION_LABELS[data.conditionType] ?? data.conditionType} ${data.value ? `> ${data.value}` : ""}` : <span className="text-gray-400 italic">Set condition…</span>}</span>;
  if (type === "tag")       return <span>{data.operation && data.tagName ? `${data.operation} "${data.tagName}"` : <span className="text-gray-400 italic">Configure tag…</span>}</span>;
  if (type === "webhook")   return <span className="truncate max-w-[150px] block">{data.url || <span className="text-gray-400 italic">Set URL…</span>}</span>;
  if (type === "goal")      return <span>{data.goalName || <span className="text-gray-400 italic">Set goal name…</span>}</span>;
  return null;
}

const TRIGGER_LABELS: Record<string, string> = {
  MANUAL: "Manual enrollment",
  FORM_SUBMITTED: "Form submitted",
  PAGE_VIEWED: "Page viewed",
  LINK_CLICKED: "Link clicked",
};
const CONDITION_LABELS: Record<string, string> = {
  EMAIL_OPENED: "Email opened",
  EMAIL_CLICKED: "Email clicked",
  LEAD_SCORE_GT: "Lead score >",
  TAG_EXISTS: "Has tag",
};

// Register node types
const makeDelegateNode = (type: string) => (props: NodeProps) => <FlowNode {...props} type={type} />;
const nodeTypes = {
  trigger:   makeDelegateNode("trigger"),
  email:     makeDelegateNode("email"),
  wait:      makeDelegateNode("wait"),
  condition: makeDelegateNode("condition"),
  tag:       makeDelegateNode("tag"),
  webhook:   makeDelegateNode("webhook"),
  goal:      makeDelegateNode("goal"),
};

// ── Palette button ─────────────────────────────────────────────────────────────
const PALETTE_ITEMS: { type: string; label: string }[] = [
  { type: "trigger",   label: "Trigger" },
  { type: "email",     label: "Email" },
  { type: "wait",      label: "Wait" },
  { type: "condition", label: "Condition" },
  { type: "tag",       label: "Tag" },
  { type: "webhook",   label: "Webhook" },
  { type: "goal",      label: "Goal" },
];

// ── Right panel (node config) ──────────────────────────────────────────────────
function NodeConfigPanel({
  node, templates, onUpdate, onDelete, onClose,
}: {
  node: Node; templates: any[]; onUpdate: (id: string, data: Record<string, any>) => void;
  onDelete: (id: string) => void; onClose: () => void;
}) {
  const { type, data } = node;
  const d = data as Record<string, any>;

  // Fetch existing contact tags for autocomplete in tag / condition nodes
  const { data: existingTags = [] } = useQuery<string[]>({
    queryKey: ["contacts", "tags"],
    queryFn: () => fetch("/api/contacts/tags", { credentials: "include" }).then(r => r.json()),
    staleTime: 60_000,
  });

  function set(key: string, value: any) {
    onUpdate(node.id, { ...d, [key]: value });
  }

  return (
    <div className="absolute right-0 top-0 bottom-0 w-80 bg-card border-l shadow-xl z-10 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          {(() => { const Icon = NODE_ICONS[type ?? "email"] ?? Zap; return <Icon className="w-4 h-4 text-muted-foreground" />; })()}
          <span className="text-sm font-semibold capitalize">{type} Node</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={() => { onDelete(node.id); onClose(); }}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>✕</Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {type === "trigger" && (
          <div className="space-y-2">
            <Label>Trigger Type</Label>
            <Select value={d.triggerType ?? "MANUAL"} onValueChange={v => set("triggerType", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(TRIGGER_LABELS).map(([v, l]) => (
                  <SelectItem key={v} value={v}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {type === "email" && (
          <>
            <div className="space-y-2">
              <Label>Email Template</Label>
              <Select
                value={d.templateId ? String(d.templateId) : ""}
                onValueChange={v => {
                  const tpl = templates.find(t => t.id === parseInt(v));
                  // One atomic update so templateId and templateName are always in sync
                  onUpdate(node.id, { ...d, templateId: parseInt(v), templateName: tpl?.name ?? "" });
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select template…" /></SelectTrigger>
                <SelectContent>
                  {templates.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {d.templateId && (
              <div className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
                Subject: {templates.find(t => t.id === d.templateId)?.subject ?? "—"}
              </div>
            )}
          </>
        )}

        {type === "wait" && (
          <div className="flex gap-2">
            <div className="flex-1 space-y-2">
              <Label>Duration</Label>
              <Input type="number" min={1} value={d.duration ?? ""} placeholder="2"
                onChange={e => set("duration", parseInt(e.target.value) || null)} />
            </div>
            <div className="w-28 space-y-2">
              <Label>Unit</Label>
              <Select value={d.unit ?? "hours"} onValueChange={v => set("unit", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hours">Hours</SelectItem>
                  <SelectItem value="days">Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {type === "condition" && (
          <>
            <div className="space-y-2">
              <Label>Condition</Label>
              <Select value={d.conditionType ?? ""} onValueChange={v => set("conditionType", v)}>
                <SelectTrigger><SelectValue placeholder="Select condition…" /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CONDITION_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(d.conditionType === "LEAD_SCORE_GT") && (
              <div className="space-y-2">
                <Label>Threshold value</Label>
                <Input type="number" value={d.value ?? ""} placeholder="50"
                  onChange={e => set("value", e.target.value)} />
              </div>
            )}
            {d.conditionType === "TAG_EXISTS" && (
              <div className="space-y-2">
                <Label>Tag name</Label>
                <datalist id="seq-contact-tags-cond">
                  {existingTags.map(t => <option key={t} value={t} />)}
                </datalist>
                <Input list="seq-contact-tags-cond" value={d.value ?? ""} placeholder="hot-lead"
                  onChange={e => set("value", e.target.value)} />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Connect the <span className="font-semibold text-emerald-600">Yes (left)</span> and <span className="font-semibold text-red-500">No (right)</span> handles to different steps.
            </p>
          </>
        )}

        {type === "tag" && (
          <>
            <div className="space-y-2">
              <Label>Operation</Label>
              <Select value={d.operation ?? "add"} onValueChange={v => set("operation", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="add">Add tag</SelectItem>
                  <SelectItem value="remove">Remove tag</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Tag Name</Label>
              <datalist id="seq-contact-tags-tag">
                {existingTags.map(t => <option key={t} value={t} />)}
              </datalist>
              <Input list="seq-contact-tags-tag" value={d.tagName ?? ""} placeholder="hot-lead"
                onChange={e => set("tagName", e.target.value)} />
            </div>
          </>
        )}

        {type === "webhook" && (
          <>
            <div className="space-y-2">
              <Label>Webhook URL</Label>
              <Input value={d.url ?? ""} placeholder="https://hooks.example.com/..."
                onChange={e => set("url", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Method</Label>
              <Select value={d.method ?? "POST"} onValueChange={v => set("method", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="GET">GET</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-md bg-muted p-2 text-xs font-mono text-muted-foreground">
              {"{"} "contactId": 123, "email": "...", "event": "step_reached" {"}"}
            </div>
          </>
        )}

        {type === "goal" && (
          <div className="space-y-2">
            <Label>Goal Name</Label>
            <Input value={d.goalName ?? ""} placeholder="Meeting Booked"
              onChange={e => set("goalName", e.target.value)} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step status helpers ───────────────────────────────────────────────────────
const STEP_STATUS_CONFIG: Record<string, {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  className: string;
}> = {
  sent:    { icon: SendHorizonal, label: "Sent",    className: "text-emerald-600" },
  bounced: { icon: AlertTriangle, label: "Bounced", className: "text-red-500"     },
  skipped: { icon: SkipForward,   label: "Skipped", className: "text-amber-500"   },
  pending: { icon: CircleDot,     label: "Pending", className: "text-gray-400"    },
  done:    { icon: Check,         label: "Done",    className: "text-blue-500"    },
};

const ENROLLMENT_STATUS_BADGE: Record<string, string> = {
  active:    "bg-emerald-100 text-emerald-700",
  completed: "bg-blue-100 text-blue-700",
  paused:    "bg-amber-100 text-amber-700",
};

// ── EnrollmentsView ───────────────────────────────────────────────────────────
interface EnrollmentsViewProps {
  enrollments: any[];
  isLoading: boolean;
  expandedId: number | null;
  onToggle: (id: number) => void;
  enrollmentSteps: any;
  stepsLoading: boolean;
  onReEnroll: (contactId: number) => void;
  reEnrolling: boolean;
}

/** Renders per-step delivery chips for a single enrollment. */
function EnrollmentStepDetails({
  enrollmentId,
  expandedId,
  enrollmentSteps,
  stepsLoading,
}: {
  enrollmentId: number;
  expandedId: number | null;
  enrollmentSteps: any;
  stepsLoading: boolean;
}) {
  const isThisOne = expandedId === enrollmentId;
  if (stepsLoading && isThisOne) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading step statuses…
      </div>
    );
  }
  if (!isThisOne || !enrollmentSteps?.steps?.length) {
    return (
      <p className="text-xs text-muted-foreground py-1">
        No step data available — sequence may not have been published before this enrollment.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Step delivery status
      </p>
      <div className="flex flex-wrap gap-2">
        {(enrollmentSteps.steps as any[]).map((step: any, idx: number) => {
          const cfg = STEP_STATUS_CONFIG[step.status] ?? STEP_STATUS_CONFIG.pending;
          const Icon = cfg.icon;
          const nonEmail = step.stepType !== "email";
          return (
            <Tooltip key={step.stepId}>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium cursor-default",
                    nonEmail
                      ? "bg-gray-50 border-gray-200 text-gray-500"
                      : cn("border", {
                        "bg-emerald-50 border-emerald-200": step.status === "sent",
                        "bg-red-50 border-red-200":         step.status === "bounced",
                        "bg-amber-50 border-amber-200":     step.status === "skipped",
                        "bg-gray-50 border-gray-200":       step.status === "pending",
                        "bg-blue-50 border-blue-200":       step.status === "done",
                      }),
                  )}
                >
                  <span className="text-[10px] text-muted-foreground w-3.5 shrink-0">{idx + 1}.</span>
                  <Icon className={cn("w-3.5 h-3.5 shrink-0", nonEmail ? "text-gray-400" : cfg.className)} />
                  <span className={cn("max-w-[100px] truncate", nonEmail ? "text-gray-500" : cfg.className)}>
                    {step.label}
                  </span>
                  {!nonEmail && step.status === "sent" && (step.openCount > 0 || step.clickCount > 0) && (
                    <span className="flex items-center gap-1 ml-1 pl-1.5 border-l border-emerald-200">
                      {step.openCount > 0 && (
                        <span className="flex items-center gap-0.5 text-emerald-700" title="Opens">
                          <Eye className="w-3 h-3" />
                          <span className="text-[10px] font-semibold tabular-nums">{step.openCount}</span>
                        </span>
                      )}
                      {step.clickCount > 0 && (
                        <span className="flex items-center gap-0.5 text-indigo-700" title="Clicks">
                          <MousePointerClick className="w-3 h-3" />
                          <span className="text-[10px] font-semibold tabular-nums">{step.clickCount}</span>
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs max-w-[220px]">
                <p className="font-semibold mb-0.5 capitalize">{step.stepType} · {step.status}</p>
                {step.recipientEmail && step.stepType === "email" && (
                  <p className="text-muted-foreground">To: {step.recipientEmail}</p>
                )}
                {step.occurredAt && (
                  <p className="text-muted-foreground">
                    {format(new Date(step.occurredAt), "MMM d, yyyy h:mm a")}
                  </p>
                )}
                {!step.occurredAt && step.stepType === "email" && step.status === "pending" && (
                  <p className="text-muted-foreground">Not yet sent</p>
                )}
                {step.stepType === "email" && step.status === "sent" && (
                  <div className="mt-1 pt-1 border-t border-border/50 space-y-0.5">
                    <p className="text-muted-foreground flex items-center gap-1">
                      <Eye className="w-3 h-3" /> {step.openCount ?? 0} open{step.openCount === 1 ? "" : "s"}
                      {step.firstOpenedAt && (
                        <span className="ml-1 text-[10px]">· first {format(new Date(step.firstOpenedAt), "MMM d, h:mm a")}</span>
                      )}
                    </p>
                    <p className="text-muted-foreground flex items-center gap-1">
                      <MousePointerClick className="w-3 h-3" /> {step.clickCount ?? 0} click{step.clickCount === 1 ? "" : "s"}
                      {step.firstClickedAt && (
                        <span className="ml-1 text-[10px]">· first {format(new Date(step.firstClickedAt), "MMM d, h:mm a")}</span>
                      )}
                    </p>
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function EnrollmentsView({
  enrollments, isLoading, expandedId, onToggle, enrollmentSteps, stepsLoading,
  onReEnroll, reEnrolling,
}: EnrollmentsViewProps) {
  // Track which contact group is open (contact_id)
  const [expandedContactId, setExpandedContactId] = useState<number | null>(null);

  // Group enrollments by contact, sorted by most recent first within each group
  const grouped = useMemo(() => groupEnrollments(enrollments), [enrollments]);

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-6 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-xl" />
        ))}
      </div>
    );
  }

  if (enrollments.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <Users className="w-10 h-10 opacity-30" />
        <p className="text-sm font-medium">No enrollments yet</p>
        <p className="text-xs text-center max-w-xs">
          Run this sequence to enroll contacts. Each enrollment will show per-step delivery status here.
        </p>
      </div>
    );
  }

  const totalEnrollments = enrollments.length;
  const totalContacts = grouped.length;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex-1 overflow-y-auto p-6 bg-muted/30">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Enrollments
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {totalContacts} contact{totalContacts !== 1 ? "s" : ""}
              {totalEnrollments > totalContacts && (
                <> · {totalEnrollments} total runs</>
              )}
            </span>
          </h2>
        </div>

        <div className="space-y-2">
          {grouped.map(({ contactId, latest, enrollments: contactEnrollments }) => {
            const isContactExpanded = expandedContactId === contactId;
            const hasMultiple = contactEnrollments.length > 1;
            const fullName = [latest.first_name, latest.last_name].filter(Boolean).join(" ") || "Unknown";
            // Derive summary status: active beats anything, else show latest
            const summaryStatus = contactEnrollments.find(e => e.status === "active")?.status ?? latest.status;
            const statusCfg = ENROLLMENT_STATUS_BADGE[summaryStatus] ?? "bg-gray-100 text-gray-600";

            return (
              <div key={contactId} className="bg-card border rounded-xl overflow-hidden">
                {/* ── Contact-level row ─────────────────────────────────────── */}
                <div className="flex items-center">
                  <button
                    className="flex-1 flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors text-left min-w-0"
                    onClick={() => {
                      if (hasMultiple) {
                        // Toggle the group; close any open step-detail panel
                        setExpandedContactId(prev => (prev === contactId ? null : contactId));
                        if (expandedId !== null) onToggle(expandedId); // close steps
                      } else {
                        // Single enrollment: toggle step details directly
                        setExpandedContactId(prev => (prev === contactId ? null : contactId));
                        onToggle(contactEnrollments[0].id);
                      }
                    }}
                  >
                    <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                      <span className="text-xs font-semibold text-indigo-600">
                        {(latest.first_name?.[0] ?? latest.email?.[0] ?? "?").toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{fullName}</span>
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", statusCfg)}>
                          {summaryStatus}
                        </span>
                        {hasMultiple && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-violet-100 text-violet-700 border border-violet-200">
                            {contactEnrollments.length}× enrolled
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{latest.email ?? "—"}</p>
                    </div>
                    <div className="text-xs text-muted-foreground shrink-0 hidden sm:block">
                      {latest.enrolled_at
                        ? formatDistanceToNow(new Date(latest.enrolled_at), { addSuffix: true })
                        : "—"}
                    </div>
                    <ChevronRight className={cn(
                      "w-4 h-4 text-muted-foreground transition-transform shrink-0",
                      isContactExpanded && "rotate-90",
                    )} />
                  </button>

                  {/* ── Re-enroll row menu ──────────────────────────────────── */}
                  <div className="pr-2 shrink-0">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => onReEnroll(contactId)}
                          disabled={reEnrolling}
                        >
                          <RefreshCw className="w-3.5 h-3.5 mr-2" />
                          Re-enroll
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {/* ── Expanded content ──────────────────────────────────────── */}
                {isContactExpanded && (
                  hasMultiple ? (
                    /* Multiple enrollments: show sub-rows */
                    <div className="border-t bg-muted/20">
                      {contactEnrollments.map((enrollment: any) => {
                        const reEnrollNum: number = enrollment.re_enrollment_number ?? 1;
                        const isStepExpanded = expandedId === enrollment.id;
                        const enrStatusCfg = ENROLLMENT_STATUS_BADGE[enrollment.status] ?? "bg-gray-100 text-gray-600";

                        return (
                          <div key={enrollment.id} className="border-b last:border-b-0">
                            {/* Sub-row */}
                            <button
                              className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-muted/40 transition-colors text-left"
                              onClick={() => onToggle(enrollment.id)}
                            >
                              <div className="w-4 shrink-0" /> {/* indent spacer */}
                              <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                                <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", enrStatusCfg)}>
                                  {enrollment.status}
                                </span>
                                {reEnrollNum === 1 ? (
                                  <span className="text-xs text-muted-foreground">Original enrollment</span>
                                ) : (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-violet-100 text-violet-700 border border-violet-200">
                                    Re-enrollment #{reEnrollNum - 1}
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground shrink-0 hidden sm:block">
                                {enrollment.enrolled_at
                                  ? formatDistanceToNow(new Date(enrollment.enrolled_at), { addSuffix: true })
                                  : "—"}
                              </div>
                              <ChevronDown className={cn(
                                "w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0",
                                !isStepExpanded && "-rotate-90",
                              )} />
                            </button>

                            {/* Step details for this sub-enrollment */}
                            {isStepExpanded && (
                              <div className="px-5 pb-3 pt-1 bg-muted/10">
                                <EnrollmentStepDetails
                                  enrollmentId={enrollment.id}
                                  expandedId={expandedId}
                                  enrollmentSteps={enrollmentSteps}
                                  stepsLoading={stepsLoading}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    /* Single enrollment: show steps directly */
                    <div className="border-t px-4 py-3 bg-muted/20">
                      <EnrollmentStepDetails
                        enrollmentId={contactEnrollments[0].id}
                        expandedId={expandedId}
                        enrollmentSteps={enrollmentSteps}
                        stepsLoading={stepsLoading}
                      />
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}

// ── Main editor ─────────────────────────────────────────────────────────────────
interface SequenceEditorProps { id: string; }

export default function SequenceEditor({ id }: SequenceEditorProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const numId = parseInt(id);

  const [view, setView] = useState<"canvas" | "analytics" | "enrollments">("canvas");
  const [runWizardOpen, setRunWizardOpen] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [expandedEnrollment, setExpandedEnrollment] = useState<number | null>(null);
  const [senderEmail, setSenderEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [smtpAccountId, setSmtpAccountId] = useState<string | null>(null);
  const [smtpRotationMode, setSmtpRotationMode] = useState<"round_robin" | null>(null);

  const { data: sequence, isLoading } = useQuery<any>({
    queryKey: ["email-sequences", id],
    queryFn: () => fetch(`/api/email-sequences/${numId}`, { credentials: "include" }).then(r => r.json()),
  });

  const { data: templates = [] } = useQuery<any[]>({
    queryKey: ["templates"],
    queryFn: () => fetch("/api/templates", { credentials: "include" }).then(r => r.json()),
  });

  const { data: smtpAccounts = [] } = useQuery<{ id: number; name: string; fromEmail: string }[]>({
    queryKey: ["smtp-accounts"],
    queryFn: () => fetch("/api/smtp-accounts", { credentials: "include" }).then(r => r.json()),
  });

  const { data: analytics, isLoading: analyticsLoading } = useQuery<any>({
    queryKey: ["sequence-analytics", id],
    queryFn: () => fetch(`/api/analytics/sequences/${numId}`, { credentials: "include" }).then(r => r.json()),
    enabled: view === "analytics",
  });

  const { data: canvasStatsData } = useQuery<{ steps: Array<{ stepId: string } & CanvasStat> }>({
    queryKey: ["sequence-canvas-stats", id, view],
    queryFn: () => fetch(`/api/email-sequences/${numId}/canvas-stats`, { credentials: "include" }).then(r => r.json()),
    enabled: view === "canvas" || view === "analytics",
    refetchOnMount: "always",
    staleTime: 0,
  });

  const canvasStats: Record<string, CanvasStat> = {};
  for (const s of canvasStatsData?.steps ?? []) {
    const { stepId, ...rest } = s;
    canvasStats[stepId] = rest;
  }

  const { data: enrollments = [], isLoading: enrollmentsLoading } = useQuery<any[]>({
    queryKey: ["sequence-enrollments", id],
    queryFn: () => fetch(`/api/email-sequences/${numId}/enrollments`, { credentials: "include" }).then(r => r.json()),
    enabled: view === "enrollments",
  });

  const { data: enrollmentSteps, isLoading: stepsLoading } = useQuery<any>({
    queryKey: ["enrollment-steps", id, expandedEnrollment],
    queryFn: () => fetch(`/api/email-sequences/${numId}/enrollments/${expandedEnrollment}/steps`, { credentials: "include" }).then(r => r.json()),
    enabled: expandedEnrollment !== null,
  });

  useEffect(() => {
    if (sequence?.nodesJson) {
      const nj = sequence.nodesJson as { nodes: Node[]; edges: Edge[] };
      setNodes(nj.nodes ?? []);
      setEdges(nj.edges ?? []);
    }
    if (sequence) {
      setSenderEmail(sequence.senderEmail ?? "");
      setSenderName(sequence.senderName ?? "");
      setSmtpAccountId(sequence.smtpAccountId ? String(sequence.smtpAccountId) : null);
      setSmtpRotationMode(sequence.smtpRotationMode ?? null);
    }
  }, [sequence]);

  const onConnect = useCallback((params: Connection) => {
    // Guard against self-loops and duplicate edges from the same source-handle
    // (each non-condition node has a single source handle so it can only have
    // one outgoing edge; condition nodes have separate "true" / "false" handles
    // which we treat independently).
    if (params.source === params.target) return;
    setEdges(eds => {
      const filtered = eds.filter(e =>
        !(e.source === params.source && (e.sourceHandle ?? null) === (params.sourceHandle ?? null))
      );
      return addEdge({
        ...params,
        id: `e-${params.source}-${params.sourceHandle ?? "out"}-${params.target}-${Date.now()}`,
        animated: true,
        style: { stroke: "#6366f1", strokeWidth: 2 },
        label: params.sourceHandle === "true" ? "Yes" : params.sourceHandle === "false" ? "No" : undefined,
      }, filtered);
    });
    setIsDirty(true);
  }, [setEdges]);

  const isValidConnection = useCallback((c: any) => {
    return c.source !== c.target;
  }, []);

  const onNodeClick = useCallback((_: any, node: Node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  function addNode(type: string) {
    const id = `${type}-${Date.now()}`;
    const newNode: Node = {
      id,
      type,
      position: { x: 200 + Math.random() * 100, y: 100 + nodes.length * 120 },
      data: type === "trigger" ? { triggerType: sequence?.triggerType ?? "MANUAL" } : {},
    };
    setNodes(ns => [...ns, newNode]);
    setIsDirty(true);
  }

  function updateNodeData(nodeId: string, data: Record<string, any>) {
    setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data } : n));
    setSelectedNode(prev => prev?.id === nodeId ? { ...prev, data } : prev);
    setIsDirty(true);
  }

  function deleteNode(nodeId: string) {
    setNodes(ns => ns.filter(n => n.id !== nodeId));
    setEdges(es => es.filter(e => e.source !== nodeId && e.target !== nodeId));
    setIsDirty(true);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      fetch(`/api/email-sequences/${numId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodesJson: { nodes, edges } }),
      }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-sequences"] });
      toast({ title: "Sequence saved" });
      setIsDirty(false);
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });

  const saveSenderMutation = useMutation({
    mutationFn: () =>
      fetch(`/api/email-sequences/${numId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderEmail: senderEmail.trim() || null,
          senderName: senderName.trim() || null,
          smtpAccountId: smtpRotationMode === "round_robin" ? null : (smtpAccountId ? parseInt(smtpAccountId) : null),
          smtpRotationMode: smtpRotationMode,
        }),
      }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-sequences", id] });
      toast({ title: "Sender settings saved" });
    },
    onError: () => toast({ title: "Failed to save sender settings", variant: "destructive" }),
  });

  const reEnrollMutation = useMutation({
    mutationFn: (contactId: number) =>
      fetch(`/api/email-sequences/${numId}/enroll`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId }),
      }).then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? "Re-enrollment failed");
        }
        return r.json();
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sequence-enrollments", id] });
      toast({ title: "Contact re-enrolled successfully" });
    },
    onError: (err: Error) =>
      toast({ title: "Re-enrollment failed", description: err.message, variant: "destructive" }),
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      await fetch(`/api/email-sequences/${numId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodesJson: { nodes, edges } }),
      });
      return fetch(`/api/email-sequences/${numId}/publish`, {
        method: "POST", credentials: "include",
      }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-sequences", id] });
      qc.invalidateQueries({ queryKey: ["email-sequences"] });
      toast({ title: "Sequence published and active" });
      setIsDirty(false);
    },
    onError: () => toast({ title: "Failed to publish", variant: "destructive" }),
  });

  const STATUS_COLORS: Record<string, string> = {
    draft:  "bg-gray-100 text-gray-700",
    active: "bg-emerald-100 text-emerald-700",
    paused: "bg-amber-100 text-amber-700",
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="border-b bg-card px-4 py-2.5 flex items-center gap-3 shrink-0">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/sequences")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex items-center gap-2 flex-1">
          <span className="font-semibold text-sm">{sequence?.name}</span>
          {sequence?.status && (
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", STATUS_COLORS[sequence.status])}>
              {sequence.status.charAt(0).toUpperCase() + sequence.status.slice(1)}
            </span>
          )}
        </div>
        {/* View toggle */}
        <div className="flex items-center border rounded-md overflow-hidden">
          <button
            onClick={() => setView("canvas")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
              view === "canvas" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"
            )}
          >
            <Workflow className="w-3.5 h-3.5" /> Canvas
          </button>
          <button
            onClick={() => setView("analytics")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-l",
              view === "analytics" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"
            )}
          >
            <BarChart2 className="w-3.5 h-3.5" /> Analytics
          </button>
          <button
            onClick={() => setView("enrollments")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-l",
              view === "enrollments" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"
            )}
          >
            <Users className="w-3.5 h-3.5" /> Enrollments
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/sequences/${id}/runs`)}>
            <History className="w-3.5 h-3.5 mr-1.5" />
            Runs
          </Button>
          <Button variant="outline" size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !isDirty || view !== "canvas"}>
            {saveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
            Save
          </Button>
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700"
            onClick={() => setRunWizardOpen(true)}>
            <Play className="w-3.5 h-3.5 mr-1.5" />
            Run
          </Button>
          <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700"
            onClick={() => publishMutation.mutate()} disabled={publishMutation.isPending || view !== "canvas"}>
            {publishMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 mr-1.5" />}
            Publish
          </Button>
        </div>
      </div>

      <RunWizard
        open={runWizardOpen}
        onClose={() => setRunWizardOpen(false)}
        sequence={{ id: numId, name: sequence?.name ?? "" }}
      />

      {/* Analytics view */}
      {view === "analytics" && (
        <div className="flex-1 overflow-y-auto p-6 bg-muted/30">
          {analyticsLoading ? (
            <div className="space-y-4">
              <div className="grid grid-cols-5 gap-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 rounded-xl" />
                ))}
              </div>
              <Skeleton className="h-64 rounded-xl" />
            </div>
          ) : (
            <>
              {/* Deliverability summary row */}
              {analytics?.deliverability && (
                <div className="mb-4 rounded-xl border border-border bg-card shadow-xs overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-border bg-muted/40 flex items-center gap-2">
                    <span className="text-xs font-semibold text-foreground">Deliverability</span>
                    {(analytics.deliverability.openedBots ?? 0) > 0 && (
                      <span className="flex items-center gap-1 ml-auto text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                        {analytics.deliverability.openedBots} bot opens filtered
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-7 divide-x divide-border">
                    {[
                      { label: "Sent",         val: analytics.deliverability.sent,         color: "text-indigo-600" },
                      { label: "Delivered",    val: analytics.deliverability.delivered,    color: "text-emerald-600" },
                      { label: "Opened",       val: analytics.deliverability.opened,       color: "text-sky-600",    note: "bot-filtered" },
                      { label: "Clicked",      val: analytics.deliverability.clicked,      color: "text-blue-600",   note: "bot-filtered" },
                      { label: "Bounced",      val: analytics.deliverability.bounced,      color: "text-red-500" },
                      { label: "Unsubscribed", val: analytics.deliverability.unsubscribed, color: "text-orange-500" },
                      { label: "Spam",         val: analytics.deliverability.spam ?? 0,    color: "text-rose-600" },
                    ].map(({ label, val, color, note }) => (
                      <div key={label} className="px-4 py-3 text-center">
                        <p className={`text-xl font-bold tabular-nums ${color}`}>{val.toLocaleString()}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
                        {note && <p className="text-[9px] text-muted-foreground/60 italic">{note}</p>}
                      </div>
                    ))}
                  </div>
                  {/* Sending path split — only shown when at least one sent event is recorded */}
                  {((analytics.deliverability as any).sentViaResend > 0 || (analytics.deliverability as any).sentViaSMTP > 0) && (
                    <div className="px-4 py-2 border-t border-border bg-muted/20 flex items-center gap-3">
                      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Sending path</span>
                      {(analytics.deliverability as any).sentViaResend > 0 && (
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                          Resend: {(analytics.deliverability as any).sentViaResend.toLocaleString()}
                        </span>
                      )}
                      {(analytics.deliverability as any).sentViaSMTP > 0 && (
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                          SMTP: {(analytics.deliverability as any).sentViaSMTP.toLocaleString()}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* KPI row */}
              <div className="grid grid-cols-5 gap-3 mb-6">
                {[
                  { label: "Enrolled", value: analytics?.totalEnrolled ?? 0, color: "text-indigo-600" },
                  { label: "Completed", value: analytics?.totalCompleted ?? 0, color: "text-emerald-600" },
                  {
                    label: "Completion Rate",
                    value: analytics?.totalEnrolled
                      ? `${Math.round((analytics.totalCompleted / analytics.totalEnrolled) * 100)}%`
                      : "0%",
                    color: "text-blue-600",
                  },
                  {
                    label: "Avg Open Rate",
                    value: `${analytics?.avgOpenRate ?? 0}%`,
                    color: "text-amber-600",
                  },
                  {
                    label: "Avg Click Rate",
                    value: `${analytics?.avgClickRate ?? 0}%`,
                    color: "text-purple-600",
                  },
                ].map((stat) => (
                  <Card key={stat.label}>
                    <CardContent className="pt-4 pb-4">
                      <p className="text-xs text-muted-foreground mb-1">{stat.label}</p>
                      <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Step breakdown — email nodes with real open/click/bounce counts */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold">Step Breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  {nodes.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-6">
                      No nodes in this sequence yet. Build your flow in the Canvas view.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left py-2 px-3 text-xs font-medium text-muted-foreground">Step</th>
                            <th className="text-left py-2 px-3 text-xs font-medium text-muted-foreground">Type</th>
                            <th className="text-right py-2 px-3 text-xs font-medium text-muted-foreground">Sent</th>
                            <th className="text-left py-2 px-3 text-xs font-medium text-muted-foreground">Via</th>
                            <th className="text-right py-2 px-3 text-xs font-medium text-muted-foreground">Open Rate</th>
                            <th className="text-right py-2 px-3 text-xs font-medium text-muted-foreground">Click Rate</th>
                            <th className="text-right py-2 px-3 text-xs font-medium text-muted-foreground">Bounce Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nodes.map((node, idx) => {
                            const stepStat = analytics?.stepBreakdown?.find((s: any) => s.stepId === node.id);
                            const c = NODE_COLORS[node.type ?? "email"] ?? NODE_COLORS.email;
                            const Icon = NODE_ICONS[node.type ?? "email"] ?? Zap;
                            const label = (node.data?.subject as string) || (node.data?.label as string) || NODE_LABELS[node.type ?? "email"] || node.type || "Step";
                            const isEmail = node.type === "email";
                            const paths = stepStat?.sendingPaths as { resend: number; smtp: number } | undefined;
                            const hasPathData = isEmail && paths && (paths.resend > 0 || paths.smtp > 0);
                            return (
                              <tr key={node.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                                <td className="py-2.5 px-3">
                                  <div className="flex items-center gap-2">
                                    <div className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                                      style={{ background: c.header + "20", border: `1px solid ${c.border}40` }}>
                                      <Icon className="w-3 h-3" style={{ color: c.header }} />
                                    </div>
                                    <span className="text-xs font-medium truncate max-w-[140px]">{label}</span>
                                  </div>
                                </td>
                                <td className="py-2.5 px-3">
                                  <span className="text-xs text-muted-foreground capitalize">{node.type}</span>
                                </td>
                                <td className="py-2.5 px-3 text-right text-xs font-medium tabular-nums">
                                  {isEmail ? (stepStat?.sent ?? 0).toLocaleString() : <span className="text-muted-foreground">—</span>}
                                </td>
                                <td className="py-2.5 px-3">
                                  {hasPathData ? (
                                    <div className="flex flex-wrap gap-1">
                                      {paths!.resend > 0 && (
                                        <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 font-medium whitespace-nowrap">
                                          <span className="w-1 h-1 rounded-full bg-indigo-400 shrink-0" />
                                          Resend {paths!.resend > 0 && paths!.smtp > 0 ? `(${paths!.resend})` : ""}
                                        </span>
                                      )}
                                      {paths!.smtp > 0 && (
                                        <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 font-medium whitespace-nowrap">
                                          <span className="w-1 h-1 rounded-full bg-amber-400 shrink-0" />
                                          SMTP {paths!.resend > 0 && paths!.smtp > 0 ? `(${paths!.smtp})` : ""}
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-muted-foreground text-xs">—</span>
                                  )}
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  {isEmail ? (
                                    <span className={`text-xs font-medium tabular-nums ${(stepStat?.openRate ?? 0) > 25 ? "text-emerald-600" : "text-muted-foreground"}`}>
                                      {stepStat?.openRate ?? 0}%
                                    </span>
                                  ) : <span className="text-muted-foreground text-xs">—</span>}
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  {isEmail ? (
                                    <span className={`text-xs font-medium tabular-nums ${(stepStat?.clickRate ?? 0) > 5 ? "text-blue-600" : "text-muted-foreground"}`}>
                                      {stepStat?.clickRate ?? 0}%
                                    </span>
                                  ) : <span className="text-muted-foreground text-xs">—</span>}
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  {isEmail ? (
                                    <span className={`text-xs font-medium tabular-nums ${(stepStat?.bounceRate ?? 0) > 3 ? "text-red-500" : "text-muted-foreground"}`}>
                                      {stepStat?.bounceRate ?? 0}%
                                    </span>
                                  ) : <span className="text-muted-foreground text-xs">—</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Email Clients & Device Type breakdown */}
              {((analytics?.emailClients?.length ?? 0) > 0 || (analytics?.deviceTypes?.length ?? 0) > 0) && (
                <div className="mt-4 grid grid-cols-2 gap-4">
                  {/* Email clients */}
                  {(analytics?.emailClients?.length ?? 0) > 0 && (
                    <Card>
                      <CardHeader className="pb-2 pt-4">
                        <CardTitle className="text-sm font-semibold">Email Clients</CardTitle>
                      </CardHeader>
                      <CardContent className="pb-4">
                        <div className="space-y-2">
                          {(analytics!.emailClients as { client: string; count: number; share: number }[]).map((ec) => (
                            <div key={ec.client}>
                              <div className="flex items-center justify-between text-xs mb-0.5">
                                <span className="font-medium truncate max-w-[120px]">{ec.client}</span>
                                <span className="text-muted-foreground tabular-nums ml-2">
                                  {ec.share}% <span className="text-muted-foreground/60">({ec.count})</span>
                                </span>
                              </div>
                              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-indigo-500 transition-all"
                                  style={{ width: `${ec.share}%` }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-3">Based on non-bot opens</p>
                      </CardContent>
                    </Card>
                  )}

                  {/* Device types */}
                  {(analytics?.deviceTypes?.length ?? 0) > 0 && (
                    <Card>
                      <CardHeader className="pb-2 pt-4">
                        <CardTitle className="text-sm font-semibold">Device Types</CardTitle>
                      </CardHeader>
                      <CardContent className="pb-4">
                        <div className="space-y-2">
                          {(analytics!.deviceTypes as { device: string; count: number; share: number }[]).map((dt) => {
                            const DEVICE_COLORS: Record<string, string> = {
                              desktop: "bg-blue-500",
                              mobile: "bg-emerald-500",
                              tablet: "bg-amber-500",
                              unknown: "bg-gray-400",
                            };
                            return (
                              <div key={dt.device}>
                                <div className="flex items-center justify-between text-xs mb-0.5">
                                  <span className="font-medium capitalize">{dt.device}</span>
                                  <span className="text-muted-foreground tabular-nums ml-2">
                                    {dt.share}% <span className="text-muted-foreground/60">({dt.count})</span>
                                  </span>
                                </div>
                                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all ${DEVICE_COLORS[dt.device] ?? "bg-gray-400"}`}
                                    style={{ width: `${dt.share}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-3">Based on non-bot opens</p>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}

              {/* Sequence info */}
              <Card className="mt-4">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Sequence</span>
                    <span className="font-medium">{analytics?.sequenceName}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm mt-2">
                    <span className="text-muted-foreground">Status</span>
                    <span className={cn(
                      "text-xs px-2 py-0.5 rounded-full font-medium",
                      STATUS_COLORS[analytics?.status ?? "draft"]
                    )}>{analytics?.status ?? "draft"}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm mt-2">
                    <span className="text-muted-foreground">Total Nodes</span>
                    <span className="font-medium">{nodes.length}</span>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}

      {/* Enrollments view */}
      {view === "enrollments" && (
        <EnrollmentsView
          enrollments={enrollments}
          isLoading={enrollmentsLoading}
          expandedId={expandedEnrollment}
          onToggle={(eid) => setExpandedEnrollment(prev => prev === eid ? null : eid)}
          enrollmentSteps={enrollmentSteps}
          stepsLoading={stepsLoading}
          onReEnroll={(contactId) => reEnrollMutation.mutate(contactId)}
          reEnrolling={reEnrollMutation.isPending}
        />
      )}

      {/* Canvas area */}
      <div className={cn("flex flex-1 overflow-hidden relative", view !== "canvas" ? "hidden" : "")} ref={reactFlowWrapper}>
        {/* Left palette */}
        <div className="w-52 border-r bg-card flex flex-col gap-1 p-2 shrink-0 overflow-y-auto">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 mb-1">Add Node</p>
          {PALETTE_ITEMS.map(item => {
            const c = NODE_COLORS[item.type];
            const Icon = NODE_ICONS[item.type] ?? Zap;
            return (
              <button
                key={item.type}
                onClick={() => addNode(item.type)}
                className="flex items-center gap-2 px-2 py-2 rounded-md text-xs font-medium hover:bg-muted transition-colors text-left"
              >
                <div className="w-6 h-6 rounded flex items-center justify-center shrink-0"
                  style={{ background: c.header + "22", border: `1px solid ${c.border}44` }}>
                  <Icon className="w-3 h-3" style={{ color: c.header }} />
                </div>
                <span>{item.label}</span>
                <Plus className="w-3 h-3 text-muted-foreground ml-auto" />
              </button>
            );
          })}
          <div className="mt-4 px-1 border-t pt-3">
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Click to add nodes, then drag handles to connect them. Condition nodes have Yes/No exits.
            </p>
          </div>
          {/* Sender override */}
          <div className="mt-3 px-1 border-t pt-3 flex flex-col gap-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Sending</p>

            {/* Rotation toggle */}
            {smtpAccounts.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] text-muted-foreground">Account selection</label>
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => setSmtpRotationMode(null)}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded text-[10px] border transition-colors text-left",
                      smtpRotationMode === null
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 font-medium"
                        : "border-border text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <span className={cn(
                      "w-3 h-3 rounded-full border-2 shrink-0",
                      smtpRotationMode === null ? "border-indigo-500 bg-indigo-500" : "border-muted-foreground"
                    )} />
                    Use specific account
                  </button>
                  <button
                    onClick={() => setSmtpRotationMode("round_robin")}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded text-[10px] border transition-colors text-left",
                      smtpRotationMode === "round_robin"
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700 font-medium"
                        : "border-border text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <span className={cn(
                      "w-3 h-3 rounded-full border-2 shrink-0",
                      smtpRotationMode === "round_robin" ? "border-indigo-500 bg-indigo-500" : "border-muted-foreground"
                    )} />
                    Rotate across all accounts
                  </button>
                </div>
                {smtpRotationMode === "round_robin" && (
                  <p className="text-[10px] text-indigo-600 leading-relaxed">
                    Sends are spread across all {smtpAccounts.length} SMTP accounts — helps avoid per-inbox limits.
                  </p>
                )}
              </div>
            )}

            {/* Specific account picker — hidden when rotating */}
            {smtpRotationMode !== "round_robin" && (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-muted-foreground">Sending account</label>
                <Select
                  value={smtpAccountId ?? "__resend__"}
                  onValueChange={v => setSmtpAccountId(v === "__resend__" ? null : v)}
                >
                  <SelectTrigger className="h-7 text-[11px]">
                    <SelectValue placeholder="Resend (default)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__resend__">Resend (default)</SelectItem>
                    {smtpAccounts.map(a => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {smtpAccountId
                    ? "Emails send from your SMTP inbox — bypasses bulk-ESP filters."
                    : smtpAccounts.length === 0
                      ? "Add an SMTP inbox in Settings → Integrations to bypass Resend."
                      : "Using Resend (default)."}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-muted-foreground">From name</label>
              <Input
                value={senderName}
                onChange={e => setSenderName(e.target.value)}
                placeholder="e.g. Sam at Acme"
                className="h-7 text-xs px-2"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-muted-foreground">From email</label>
              <Input
                value={senderEmail}
                onChange={e => setSenderEmail(e.target.value)}
                placeholder="sam@yourco.com"
                className="h-7 text-xs px-2"
                type="email"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[10px] px-2 mt-0.5"
              onClick={() => saveSenderMutation.mutate()}
              disabled={saveSenderMutation.isPending}
            >
              {saveSenderMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
              Save sender
            </Button>
            {smtpAccounts.length === 0 && (
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Leave blank to use global sender. Add SMTP accounts in Settings → Integrations to bypass Resend.
              </p>
            )}
          </div>
        </div>

        {/* React Flow canvas */}
        <div className="flex-1 h-full">
         <CanvasStatsContext.Provider value={canvasStats}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(changes) => { onNodesChange(changes); setIsDirty(true); }}
            onEdgesChange={(changes) => { onEdgesChange(changes); setIsDirty(true); }}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            deleteKeyCode="Delete"
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
            <Controls />
            <MiniMap
              nodeColor={(n) => NODE_COLORS[n.type ?? "email"]?.border ?? "#94a3b8"}
              maskColor="rgba(255,255,255,.7)"
              style={{ right: selectedNode ? 320 : 12 }}
            />
            {nodes.length === 0 && (
              <Panel position="top-center">
                <div className="mt-20 text-center text-sm text-muted-foreground bg-white border rounded-xl px-8 py-6 shadow-sm">
                  <GitBranch className="w-8 h-8 mx-auto mb-3 text-muted-foreground/40" />
                  <p className="font-medium mb-1">Start building your sequence</p>
                  <p className="text-xs">Add a Trigger node first, then connect Email, Wait, and Condition steps.</p>
                </div>
              </Panel>
            )}
          </ReactFlow>
         </CanvasStatsContext.Provider>
        </div>

        {/* Right config panel */}
        {selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            templates={templates}
            onUpdate={updateNodeData}
            onDelete={deleteNode}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </div>
    </div>
  );
}
