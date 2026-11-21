import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch, Plus, Trash2, Loader2, ArrowRight,
  Tag, TrendingUp, Zap, Map, Pencil, Brain,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

// ── Types ─────────────────────────────────────────────────────────────────────
type RoutingRule = {
  id: number;
  name: string;
  condition_type: string;
  condition_value: Record<string, unknown>;
  journey_id: number;
  journey_name: string;
  enroll_sequence_id: number | null;
  apply_to: string;
  apply_client_id: number | null;
  apply_segment_id: number | null;
  if_already_in_journey: string;
  reenroll_after_completion: boolean;
  is_active: boolean;
};
type Journey  = { id: number; name: string };
type Sequence = { id: number; name: string };
type Client   = { id: number; name: string };
type Segment  = { id: number; name: string; last_computed_count: number };

type RuleBody = {
  name: string;
  journeyId: number;
  conditionType: string;
  conditionValue: Record<string, unknown>;
  applyTo: string;
  applyClientId?: number;
  applySegmentId?: number;
  ifAlreadyInJourney: string;
  enrollSequenceId?: number;
  reenrollAfterCompletion: boolean;
  isActive: boolean;
};

// ── Intent states ─────────────────────────────────────────────────────────────
const INTENT_STATES = [
  "Browsing",
  "Stuck-Aware",
  "Stuck-PreEngage",
  "Evaluating-Engage",
  "Decision-Action",
  "Re-engaging",
  "Dormant",
] as const;

// ── Label maps ────────────────────────────────────────────────────────────────
const CONDITION_LABELS: Record<string, string> = {
  score_above:      "Score crosses above",
  score_below:      "Score drops below",
  score_range:      "Score enters range",
  tag_added:        "Tag is added",
  tag_removed:      "Tag is removed",
  intent_state_is:  "Intent state transitions to",
};

const CONDITION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  score_above:     TrendingUp,
  score_below:     TrendingUp,
  score_range:     TrendingUp,
  tag_added:       Tag,
  tag_removed:     Tag,
  intent_state_is: Brain,
};

const APPLY_TO_LABELS: Record<string, string> = {
  all:     "All contacts",
  client:  "Specific client",
  segment: "Specific segment",
};

function describeCondition(rule: RoutingRule): string {
  const cv = rule.condition_value;
  switch (rule.condition_type) {
    case "score_above":     return `Score ≥ ${cv.threshold}`;
    case "score_below":     return `Score < ${cv.threshold}`;
    case "score_range":     return `Score ${cv.min}–${cv.max}`;
    case "tag_added":       return `Tag "${cv.tag}" added`;
    case "tag_removed":     return `Tag "${cv.tag}" removed`;
    case "intent_state_is": return `Intent → ${cv.state}`;
    default: return rule.condition_type;
  }
}

// ── Form state ────────────────────────────────────────────────────────────────
type FormState = {
  name: string;
  journeyId: string;
  conditionType: string;
  threshold: string;
  rangeMin: string;
  rangeMax: string;
  tag: string;
  intentState: string;
  applyTo: string;
  applyClientId: string;
  applySegmentId: string;
  ifAlreadyInJourney: string;
  enrollSequenceId: string;
  reenrollAfterCompletion: boolean;
  isActive: boolean;
};

const BLANK_FORM: FormState = {
  name: "",
  journeyId: "",
  conditionType: "score_above",
  threshold: "50",
  rangeMin: "0",
  rangeMax: "100",
  tag: "",
  intentState: "Decision-Action",
  applyTo: "all",
  applyClientId: "none",
  applySegmentId: "none",
  ifAlreadyInJourney: "skip",
  enrollSequenceId: "none",
  reenrollAfterCompletion: false,
  isActive: true,
};

function ruleToForm(rule: RoutingRule): FormState {
  const cv = rule.condition_value;
  return {
    name: rule.name,
    journeyId: String(rule.journey_id),
    conditionType: rule.condition_type,
    threshold: String((cv.threshold as number) ?? 50),
    rangeMin:  String((cv.min       as number) ?? 0),
    rangeMax:  String((cv.max       as number) ?? 100),
    tag: String(cv.tag ?? ""),
    intentState: String(cv.state ?? "Decision-Action"),
    applyTo: rule.apply_to,
    applyClientId:  rule.apply_client_id  ? String(rule.apply_client_id)  : "none",
    applySegmentId: rule.apply_segment_id ? String(rule.apply_segment_id) : "none",
    ifAlreadyInJourney: rule.if_already_in_journey,
    enrollSequenceId: rule.enroll_sequence_id ? String(rule.enroll_sequence_id) : "none",
    reenrollAfterCompletion: rule.reenroll_after_completion ?? false,
    isActive: rule.is_active,
  };
}

// ── RuleDialog ─────────────────────────────────────────────────────────────────
interface RuleDialogProps {
  open: boolean;
  onClose: () => void;
  editRuleId: number | null;
  journeys: Journey[];
  sequences: Sequence[];
  clients: Client[];
  segments: Segment[];
  initialForm: FormState;
  onSaved: () => void;
}

function RuleDialog({
  open, onClose, editRuleId, journeys, sequences, clients, segments, initialForm, onSaved,
}: RuleDialogProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(initialForm);

  // Sync form when dialog re-opens with new initialForm
  const [lastInitial, setLastInitial] = useState(initialForm);
  if (lastInitial !== initialForm) {
    setLastInitial(initialForm);
    setForm(initialForm);
  }

  const set = (patch: Partial<FormState>) => setForm(f => ({ ...f, ...patch }));

  function buildConditionValue(): Record<string, unknown> {
    switch (form.conditionType) {
      case "score_above": return { threshold: Number(form.threshold) };
      case "score_below": return { threshold: Number(form.threshold) };
      case "score_range": return { min: Number(form.rangeMin), max: Number(form.rangeMax) };
      case "tag_added":
      case "tag_removed": return { tag: form.tag };
      case "intent_state_is": return { state: form.intentState };
      default: return {};
    }
  }

  function buildBody(): RuleBody {
    return {
      name: form.name.trim(),
      journeyId: Number(form.journeyId),
      conditionType: form.conditionType,
      conditionValue: buildConditionValue(),
      applyTo: form.applyTo,
      applyClientId:  form.applyTo === "client"  && form.applyClientId  !== "none" ? Number(form.applyClientId)  : undefined,
      applySegmentId: form.applyTo === "segment" && form.applySegmentId !== "none" ? Number(form.applySegmentId) : undefined,
      ifAlreadyInJourney: form.ifAlreadyInJourney,
      enrollSequenceId: form.enrollSequenceId !== "none" ? Number(form.enrollSequenceId) : undefined,
      reenrollAfterCompletion: form.reenrollAfterCompletion,
      isActive: form.isActive,
    };
  }

  const saveMutation = useMutation({
    mutationFn: (body: RuleBody) => {
      if (editRuleId !== null) {
        return api(`/journey-routing-rules/${editRuleId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      return api("/journey-routing-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      onSaved();
      onClose();
      toast({ title: editRuleId ? "Rule updated" : "Routing rule created" });
    },
    onError: () => toast({ title: "Failed to save rule", variant: "destructive" }),
  });

  const isValid = form.name.trim() && form.journeyId &&
    (form.applyTo !== "client"  || form.applyClientId  !== "none") &&
    (form.applyTo !== "segment" || form.applySegmentId !== "none");

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-indigo-600" />
            {editRuleId ? "Edit Routing Rule" : "New Routing Rule"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Name */}
          <div className="space-y-1.5">
            <Label className="text-xs">Rule name</Label>
            <Input
              value={form.name}
              onChange={e => set({ name: e.target.value })}
              placeholder="e.g. Hot leads — auto-enroll journey"
              className="h-8 text-sm"
            />
          </div>

          {/* Target journey */}
          <div className="space-y-1.5">
            <Label className="text-xs">Target journey <span className="text-destructive">*</span></Label>
            <Select value={form.journeyId} onValueChange={v => set({ journeyId: v })}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Select a journey…" />
              </SelectTrigger>
              <SelectContent>
                {journeys.map(j => (
                  <SelectItem key={j.id} value={String(j.id)}>{j.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Condition */}
          <div className="space-y-1.5">
            <Label className="text-xs">Trigger condition</Label>
            <Select value={form.conditionType} onValueChange={v => set({ conditionType: v })}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Score threshold */}
          {(form.conditionType === "score_above" || form.conditionType === "score_below") && (
            <div className="space-y-1.5">
              <Label className="text-xs">Score threshold</Label>
              <Input
                type="number" min={0} max={500}
                value={form.threshold}
                onChange={e => set({ threshold: e.target.value })}
                className="h-8 text-sm w-32"
              />
            </div>
          )}

          {/* Score range */}
          {form.conditionType === "score_range" && (
            <div className="flex items-center gap-2">
              <div className="space-y-1.5 flex-1">
                <Label className="text-xs">Min score</Label>
                <Input type="number" min={0} value={form.rangeMin}
                  onChange={e => set({ rangeMin: e.target.value })} className="h-8 text-sm" />
              </div>
              <div className="space-y-1.5 flex-1">
                <Label className="text-xs">Max score</Label>
                <Input type="number" min={0} value={form.rangeMax}
                  onChange={e => set({ rangeMax: e.target.value })} className="h-8 text-sm" />
              </div>
            </div>
          )}

          {/* Tag */}
          {(form.conditionType === "tag_added" || form.conditionType === "tag_removed") && (
            <div className="space-y-1.5">
              <Label className="text-xs">Tag name</Label>
              <Input
                value={form.tag}
                onChange={e => set({ tag: e.target.value })}
                placeholder="e.g. vip"
                className="h-8 text-sm"
              />
            </div>
          )}

          {/* Intent state picker */}
          {form.conditionType === "intent_state_is" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Target intent state</Label>
              <Select value={form.intentState} onValueChange={v => set({ intentState: v })}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTENT_STATES.map(s => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Rule fires only when the contact transitions <em>into</em> this state (not on every recompute).
              </p>
            </div>
          )}

          {/* Apply to */}
          <div className="space-y-1.5">
            <Label className="text-xs">Apply to</Label>
            <Select value={form.applyTo} onValueChange={v => set({ applyTo: v, applyClientId: "none", applySegmentId: "none" })}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(APPLY_TO_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Client picker */}
          {form.applyTo === "client" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Client <span className="text-destructive">*</span></Label>
              <Select value={form.applyClientId} onValueChange={v => set({ applyClientId: v })}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Choose a client…" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Segment picker */}
          {form.applyTo === "segment" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Segment <span className="text-destructive">*</span></Label>
              <Select value={form.applySegmentId} onValueChange={v => set({ applySegmentId: v })}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Choose a segment…" />
                </SelectTrigger>
                <SelectContent>
                  {segments.map(s => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name} ({s.last_computed_count} contacts)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* If already enrolled + sequence */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">If already enrolled</Label>
              <Select value={form.ifAlreadyInJourney} onValueChange={v => set({ ifAlreadyInJourney: v })}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">Skip</SelectItem>
                  <SelectItem value="re_add">Re-enroll</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Also start sequence</Label>
              <Select value={form.enrollSequenceId} onValueChange={v => set({ enrollSequenceId: v })}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {sequences.map(s => (
                    <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Re-enroll after completion (sequence only) */}
          {form.enrollSequenceId !== "none" && (
            <div className="flex items-center justify-between pt-1">
              <div>
                <Label className="text-xs font-medium">Re-enroll after completion</Label>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Allow contacts to restart the sequence if they already completed it
                </p>
              </div>
              <Switch
                checked={form.reenrollAfterCompletion}
                onCheckedChange={v => set({ reenrollAfterCompletion: v })}
              />
            </div>
          )}

          {/* Active toggle */}
          <div className="flex items-center justify-between pt-1">
            <Label className="text-xs font-medium">Active immediately</Label>
            <Switch
              checked={form.isActive}
              onCheckedChange={v => set({ isActive: v })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            className="bg-indigo-600 hover:bg-indigo-700"
            disabled={!isValid || saveMutation.isPending}
            onClick={() => saveMutation.mutate(buildBody())}
          >
            {saveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
            {editRuleId ? "Save Changes" : "Create Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── JourneyRoutingTab ─────────────────────────────────────────────────────────
export function JourneyRoutingTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen]     = useState(false);
  const [editRuleId, setEditRuleId]     = useState<number | null>(null);
  const [dialogForm, setDialogForm]     = useState<FormState>(BLANK_FORM);

  const { data: rules = [], isLoading } = useQuery<RoutingRule[]>({
    queryKey: ["journey-routing-rules-global"],
    queryFn: () => api("/journey-routing-rules").then(r => r.json()),
  });

  const { data: journeys  = [] } = useQuery<Journey[]>({
    queryKey: ["journeys-slim"],
    queryFn: () => api("/journeys").then(r => r.json()),
  });
  const { data: sequences = [] } = useQuery<Sequence[]>({
    queryKey: ["email-sequences-mini"],
    queryFn: () => api("/email-sequences").then(r => r.json()),
  });
  const { data: clients   = [] } = useQuery<Client[]>({
    queryKey: ["clients"],
    queryFn: () => api("/clients").then(r => r.json()),
  });
  const { data: segments  = [] } = useQuery<Segment[]>({
    queryKey: ["segments"],
    queryFn: () => api("/segments").then(r => r.json()),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      api(`/journey-routing-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["journey-routing-rules-global"] }),
    onError: () => toast({ title: "Failed to update rule", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      api(`/journey-routing-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journey-routing-rules-global"] });
      toast({ title: "Rule deleted" });
    },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  function openCreate() {
    setEditRuleId(null);
    setDialogForm(BLANK_FORM);
    setDialogOpen(true);
  }

  function openEdit(rule: RoutingRule) {
    setEditRuleId(rule.id);
    setDialogForm(ruleToForm(rule));
    setDialogOpen(true);
  }

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ["journey-routing-rules-global"] });
  }

  const activeCount = rules.filter(r => r.is_active).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Journey Routing Rules</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Automatically enroll contacts into journeys when their score or tags change.
            Rules are evaluated whenever a contact's score or tags update.
          </p>
        </div>
        <Button
          size="sm"
          className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700 shrink-0 ml-4"
          onClick={openCreate}
        >
          <Plus className="w-3.5 h-3.5 mr-1.5" /> New Rule
        </Button>
      </div>

      {/* Summary strip */}
      {!isLoading && rules.length > 0 && (
        <div className="flex items-center gap-4 p-3 rounded-lg bg-muted/40 border">
          {[
            { label: "Total rules",      value: rules.length,                       color: "text-foreground" },
            { label: "Active",           value: activeCount,                        color: "text-emerald-600" },
            { label: "Inactive",         value: rules.length - activeCount,         color: "text-muted-foreground" },
            { label: "Journeys covered", value: new Set(rules.map(r => r.journey_id)).size, color: "text-indigo-600" },
          ].map((stat, i) => (
            <>
              {i > 0 && <div key={`div-${i}`} className="w-px h-8 bg-border" />}
              <div key={stat.label} className="text-center">
                <p className={cn("text-xl font-bold", stat.color)}>{stat.value}</p>
                <p className="text-[11px] text-muted-foreground">{stat.label}</p>
              </div>
            </>
          ))}
        </div>
      )}

      {/* Rules list */}
      {isLoading ? (
        <div className="space-y-2">
          {[1,2,3].map(i => <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />)}
        </div>
      ) : rules.length === 0 ? (
        <div className="border-2 border-dashed rounded-xl p-12 text-center space-y-2">
          <GitBranch className="w-10 h-10 text-muted-foreground/30 mx-auto" />
          <p className="text-sm font-medium text-muted-foreground">No routing rules yet</p>
          <p className="text-xs text-muted-foreground max-w-sm mx-auto">
            Create rules to automatically enroll contacts into journeys when their lead score
            crosses a threshold or a tag is applied.
          </p>
          <Button size="sm" variant="outline" className="mt-3" onClick={openCreate}>
            <Plus className="w-3.5 h-3.5 mr-1.5" /> Create first rule
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map(rule => {
            const Icon = CONDITION_ICONS[rule.condition_type] ?? Zap;
            return (
              <div
                key={rule.id}
                className={cn(
                  "flex items-center gap-3 p-3.5 rounded-lg border bg-card transition-all",
                  !rule.is_active && "opacity-50"
                )}
              >
                <div className={cn(
                  "w-9 h-9 rounded-lg flex items-center justify-center shrink-0",
                  rule.condition_type.startsWith("score") ? "bg-indigo-50" :
                  rule.condition_type === "intent_state_is" ? "bg-violet-50" : "bg-emerald-50"
                )}>
                  <Icon className={cn(
                    "w-4 h-4",
                    rule.condition_type.startsWith("score") ? "text-indigo-600" :
                    rule.condition_type === "intent_state_is" ? "text-violet-600" : "text-emerald-600"
                  )} />
                </div>

                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{rule.name}</span>
                    {!rule.is_active && (
                      <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">
                        Inactive
                      </Badge>
                    )}
                    {rule.apply_to !== "all" && (
                      <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-indigo-700 border-indigo-200 bg-indigo-50">
                        {APPLY_TO_LABELS[rule.apply_to] ?? rule.apply_to}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
                    <span className="font-medium text-foreground">{CONDITION_LABELS[rule.condition_type]}</span>
                    <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-[11px]">
                      {describeCondition(rule)}
                    </span>
                    <ArrowRight className="w-3 h-3 shrink-0 text-muted-foreground/60" />
                    <div className="flex items-center gap-1">
                      <Map className="w-3 h-3" />
                      <span className="font-medium text-foreground">{rule.journey_name}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Switch
                    checked={rule.is_active}
                    onCheckedChange={v => toggleMutation.mutate({ id: rule.id, isActive: v })}
                    className="scale-75"
                  />
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => openEdit(rule)}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteMutation.mutate(rule.id)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* How it works callout */}
      <div className="rounded-lg border border-dashed p-4 bg-muted/20">
        <p className="text-xs text-muted-foreground leading-relaxed">
          <span className="font-medium text-foreground">How routing rules work:</span>{" "}
          Whenever a contact's score, tags, or intent state changes, all active rules are evaluated.
          Matching contacts are automatically enrolled in the specified journey and optionally started on
          a sequence. <span className="font-medium text-foreground">Intent state</span> rules fire only on
          transitions — e.g. a contact moving into <em>Decision-Action</em> triggers the rule once, not on
          every recompute. Use <em>Apply to</em> to scope a rule to contacts of a specific client or segment.
        </p>
      </div>

      {/* Create / Edit dialog */}
      <RuleDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        editRuleId={editRuleId}
        journeys={journeys}
        sequences={sequences}
        clients={clients}
        segments={segments}
        initialForm={dialogForm}
        onSaved={handleSaved}
      />
    </div>
  );
}
