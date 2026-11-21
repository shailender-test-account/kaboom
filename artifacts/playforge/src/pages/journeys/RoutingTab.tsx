import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch, Plus, Trash2, Loader2, ToggleLeft, ToggleRight,
  ChevronDown, ArrowRight, Tag, TrendingUp, Zap, Pencil,
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

type RoutingRule = {
  id: number;
  name: string;
  condition_type: string;
  condition_value: Record<string, any>;
  journey_id: number;
  enroll_sequence_id: number | null;
  apply_to: string;
  apply_client_id: number | null;
  apply_segment_id: number | null;
  if_already_in_journey: string;
  reenroll_after_completion: boolean;
  is_active: boolean;
  sequence_name: string | null;
  client_name: string | null;
  segment_filter_name: string | null;
};

const CONDITION_LABELS: Record<string, string> = {
  score_above: "Score crosses above",
  score_below: "Score drops below",
  score_range: "Score enters range",
  tag_added:   "Tag is added",
  tag_removed: "Tag is removed",
};

const CONDITION_ICONS: Record<string, React.ComponentType<any>> = {
  score_above: TrendingUp,
  score_below: TrendingUp,
  score_range: TrendingUp,
  tag_added:   Tag,
  tag_removed: Tag,
};

function describeCondition(rule: RoutingRule): string {
  const cv = rule.condition_value;
  switch (rule.condition_type) {
    case "score_above": return `Score ≥ ${cv.threshold}`;
    case "score_below": return `Score < ${cv.threshold}`;
    case "score_range": return `Score ${cv.min}–${cv.max}`;
    case "tag_added":   return `Tag "${cv.tag}" added`;
    case "tag_removed": return `Tag "${cv.tag}" removed`;
    default: return rule.condition_type;
  }
}

function describeScope(rule: RoutingRule): string {
  if (rule.apply_to === "client" && rule.client_name) return `Client: ${rule.client_name}`;
  if (rule.apply_to === "segment" && rule.segment_filter_name) return `Segment: ${rule.segment_filter_name}`;
  if (rule.apply_to === "client") return "Client scope";
  if (rule.apply_to === "segment") return "Segment scope";
  return "All contacts";
}

const blankForm = {
  name: "",
  conditionType: "score_above" as string,
  threshold: "50",
  rangeMin: "0",
  rangeMax: "100",
  tag: "",
  applyTo: "all" as string,
  applyClientId: "" as string,
  applySegmentId: "" as string,
  ifAlreadyInJourney: "skip" as string,
  enrollSequenceId: "" as string,
  reenrollAfterCompletion: false,
  isActive: true,
};

function ruleToForm(rule: RoutingRule) {
  const cv = rule.condition_value ?? {};
  return {
    name: rule.name,
    conditionType: rule.condition_type,
    threshold: cv.threshold != null ? String(cv.threshold) : "50",
    rangeMin: cv.min != null ? String(cv.min) : "0",
    rangeMax: cv.max != null ? String(cv.max) : "100",
    tag: cv.tag ?? "",
    applyTo: rule.apply_to,
    applyClientId: rule.apply_client_id != null ? String(rule.apply_client_id) : "",
    applySegmentId: rule.apply_segment_id != null ? String(rule.apply_segment_id) : "",
    ifAlreadyInJourney: rule.if_already_in_journey,
    enrollSequenceId: rule.enroll_sequence_id != null ? String(rule.enroll_sequence_id) : "",
    reenrollAfterCompletion: rule.reenroll_after_completion ?? false,
    isActive: rule.is_active,
  };
}

export function RoutingTab({ journeyId }: { journeyId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [form, setForm] = useState(blankForm);

  const { data: rules = [], isLoading } = useQuery<RoutingRule[]>({
    queryKey: ["journey-routing-rules", journeyId],
    queryFn: () => api(`/journeys/${journeyId}/routing-rules`).then(r => r.json()),
  });

  const { data: sequences = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["email-sequences-mini"],
    queryFn: () => api("/email-sequences").then(r => r.json()),
  });

  const { data: clients = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["clients-mini"],
    queryFn: () => api("/clients").then(r => r.json()).then((d: any) => d.rows ?? d),
  });

  const { data: segments = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["segments-mini"],
    queryFn: () => api("/segments").then(r => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: async (body: any) => {
      const res = await api(`/journeys/${journeyId}/routing-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journey-routing-rules", journeyId] });
      closeDialog();
      toast({ title: "Routing rule created" });
    },
    onError: () => toast({ title: "Failed to create rule", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: any }) => {
      const res = await api(`/journey-routing-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journey-routing-rules", journeyId] });
      closeDialog();
      toast({ title: "Routing rule updated" });
    },
    onError: () => toast({ title: "Failed to update rule", variant: "destructive" }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      api(`/journey-routing-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["journey-routing-rules", journeyId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      api(`/journey-routing-rules/${id}`, { method: "DELETE" }),
    onMutate: async (id: number) => {
      await qc.cancelQueries({ queryKey: ["journey-routing-rules", journeyId] });
      const prev = qc.getQueryData<RoutingRule[]>(["journey-routing-rules", journeyId]);
      qc.setQueryData<RoutingRule[]>(["journey-routing-rules", journeyId], (old = []) =>
        old.filter(r => r.id !== id)
      );
      return { prev };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journey-routing-rules", journeyId] });
      toast({ title: "Rule deleted" });
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["journey-routing-rules", journeyId], ctx.prev);
      toast({ title: "Failed to delete", variant: "destructive" });
    },
  });

  function openCreate() {
    setEditingRuleId(null);
    setForm(blankForm);
    setDialogOpen(true);
  }

  function openEdit(rule: RoutingRule) {
    setEditingRuleId(rule.id);
    setForm(ruleToForm(rule));
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingRuleId(null);
    setForm(blankForm);
  }

  function buildConditionValue() {
    switch (form.conditionType) {
      case "score_above": return { threshold: Number(form.threshold) };
      case "score_below": return { threshold: Number(form.threshold) };
      case "score_range": return { min: Number(form.rangeMin), max: Number(form.rangeMax) };
      case "tag_added":
      case "tag_removed": return { tag: form.tag };
      default: return {};
    }
  }

  function isFormValid() {
    if (!form.name.trim()) return false;
    if (form.applyTo === "client" && !form.applyClientId) return false;
    if (form.applyTo === "segment" && !form.applySegmentId) return false;
    if ((form.conditionType === "tag_added" || form.conditionType === "tag_removed") && !form.tag.trim()) return false;
    return true;
  }

  function buildBody() {
    return {
      name: form.name.trim(),
      conditionType: form.conditionType,
      conditionValue: buildConditionValue(),
      applyTo: form.applyTo,
      applyClientId: form.applyClientId ? Number(form.applyClientId) : undefined,
      applySegmentId: form.applySegmentId ? Number(form.applySegmentId) : undefined,
      ifAlreadyInJourney: form.ifAlreadyInJourney,
      enrollSequenceId: form.enrollSequenceId ? Number(form.enrollSequenceId) : undefined,
      reenrollAfterCompletion: form.reenrollAfterCompletion,
      isActive: form.isActive,
    };
  }

  function handleSave() {
    if (!isFormValid()) return;
    if (editingRuleId != null) {
      updateMutation.mutate({ id: editingRuleId, body: buildBody() });
    } else {
      createMutation.mutate(buildBody());
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Routing Rules</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Auto-enroll contacts into this journey when conditions are met
          </p>
        </div>
        <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700" onClick={openCreate}>
          <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <div className="border-2 border-dashed rounded-xl p-10 text-center space-y-2">
          <GitBranch className="w-8 h-8 text-muted-foreground/40 mx-auto" />
          <p className="text-sm font-medium text-muted-foreground">No routing rules yet</p>
          <p className="text-xs text-muted-foreground">
            Add a rule to automatically enroll contacts when their score or tags change
          </p>
          <Button size="sm" variant="outline" className="mt-2" onClick={openCreate}>
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
                  "flex items-center gap-3 p-3 rounded-lg border bg-card transition-all",
                  !rule.is_active && "opacity-50"
                )}
              >
                <div className={cn(
                  "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                  rule.condition_type.startsWith("score") ? "bg-indigo-50" : "bg-emerald-50"
                )}>
                  <Icon className={cn(
                    "w-4 h-4",
                    rule.condition_type.startsWith("score") ? "text-indigo-600" : "text-emerald-600"
                  )} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground truncate">{rule.name}</span>
                    {!rule.is_active && (
                      <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">
                        Inactive
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5 flex-wrap">
                    <span className="font-medium text-foreground">{CONDITION_LABELS[rule.condition_type]}</span>
                    <span>{describeCondition(rule)}</span>
                    <ArrowRight className="w-3 h-3 shrink-0" />
                    <span>Enroll in journey</span>
                    {rule.sequence_name && (
                      <>
                        <span>·</span>
                        <span>Start <em>{rule.sequence_name}</em></span>
                      </>
                    )}
                    <span>·</span>
                    <span className="text-muted-foreground/70">{describeScope(rule)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Switch
                    checked={rule.is_active}
                    onCheckedChange={v => toggleMutation.mutate({ id: rule.id, isActive: v })}
                    className="scale-75"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => openEdit(rule)}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
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

      <Dialog open={dialogOpen} onOpenChange={o => { if (!o) closeDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-indigo-600" />
              {editingRuleId != null ? "Edit Routing Rule" : "New Routing Rule"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Rule name</Label>
              <Input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Hot leads — auto-enroll"
                className="h-8 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Condition</Label>
              <Select value={form.conditionType} onValueChange={v => setForm(f => ({ ...f, conditionType: v }))}>
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

            {(form.conditionType === "score_above" || form.conditionType === "score_below") && (
              <div className="space-y-1.5">
                <Label className="text-xs">Score threshold</Label>
                <Input
                  type="number" min={0} max={500}
                  value={form.threshold}
                  onChange={e => setForm(f => ({ ...f, threshold: e.target.value }))}
                  className="h-8 text-sm w-32"
                />
              </div>
            )}

            {form.conditionType === "score_range" && (
              <div className="flex items-center gap-2">
                <div className="space-y-1.5 flex-1">
                  <Label className="text-xs">Min score</Label>
                  <Input type="number" min={0} value={form.rangeMin}
                    onChange={e => setForm(f => ({ ...f, rangeMin: e.target.value }))}
                    className="h-8 text-sm" />
                </div>
                <div className="space-y-1.5 flex-1">
                  <Label className="text-xs">Max score</Label>
                  <Input type="number" min={0} value={form.rangeMax}
                    onChange={e => setForm(f => ({ ...f, rangeMax: e.target.value }))}
                    className="h-8 text-sm" />
                </div>
              </div>
            )}

            {(form.conditionType === "tag_added" || form.conditionType === "tag_removed") && (
              <div className="space-y-1.5">
                <Label className="text-xs">Tag name</Label>
                <Input
                  value={form.tag}
                  onChange={e => setForm(f => ({ ...f, tag: e.target.value }))}
                  placeholder="e.g. vip"
                  className="h-8 text-sm"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">Scope — who this rule applies to</Label>
              <Select value={form.applyTo} onValueChange={v => setForm(f => ({ ...f, applyTo: v, applyClientId: "", applySegmentId: "" }))}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All contacts</SelectItem>
                  <SelectItem value="client">Contacts in a client</SelectItem>
                  <SelectItem value="segment">Contacts in a segment</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.applyTo === "client" && (
              <div className="space-y-1.5">
                <Label className="text-xs">Which client <span className="text-destructive">*</span></Label>
                <Select value={form.applyClientId || "none"} onValueChange={v => setForm(f => ({ ...f, applyClientId: v === "none" ? "" : v }))}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="Select a client…" />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="none" disabled>Select a client…</SelectItem>
                    {clients.map((c: any) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {form.applyTo === "segment" && (
              <div className="space-y-1.5">
                <Label className="text-xs">Which segment <span className="text-destructive">*</span></Label>
                <Select value={form.applySegmentId || "none"} onValueChange={v => setForm(f => ({ ...f, applySegmentId: v === "none" ? "" : v }))}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="Select a segment…" />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="none" disabled>Select a segment…</SelectItem>
                    {segments.map((s: any) => (
                      <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">If already enrolled</Label>
                <Select value={form.ifAlreadyInJourney} onValueChange={v => setForm(f => ({ ...f, ifAlreadyInJourney: v }))}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">Skip</SelectItem>
                    <SelectItem value="move">Move</SelectItem>
                    <SelectItem value="re_enroll">Re-enroll</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Also start sequence (optional)</Label>
                <Select value={form.enrollSequenceId || "none"} onValueChange={v => setForm(f => ({ ...f, enrollSequenceId: v === "none" ? "" : v }))}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {sequences.map((s: any) => (
                      <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {form.enrollSequenceId && (
              <div className="flex items-center justify-between pt-1">
                <div>
                  <Label className="text-xs font-medium">Re-enroll after completion</Label>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Allow contacts to restart the sequence if they completed it before
                  </p>
                </div>
                <Switch
                  checked={form.reenrollAfterCompletion}
                  onCheckedChange={v => setForm(f => ({ ...f, reenrollAfterCompletion: v }))}
                />
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <Label className="text-xs font-medium">Active immediately</Label>
              <Switch
                checked={form.isActive}
                onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={closeDialog}>Cancel</Button>
            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!isFormValid() || isSaving}
              onClick={handleSave}
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
              {editingRuleId != null ? "Save Changes" : "Create Rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
