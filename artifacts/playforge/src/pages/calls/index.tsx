import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Phone, Plus, Play, Pause, Trash2, Users, CheckCircle2,
  Clock, AlertCircle, ChevronRight, PhoneCall, Loader2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });
const json = (path: string, method: string, body: unknown) =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  draft:     { label: "Draft",     className: "bg-gray-100 text-gray-600 border-gray-200" },
  active:    { label: "Active",    className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  paused:    { label: "Paused",    className: "bg-amber-50 text-amber-700 border-amber-200" },
  completed: { label: "Completed", className: "bg-blue-50 text-blue-700 border-blue-200" },
};

const PRODUCT_LABEL: Record<string, string> = {
  aiso:     "AI Search Optimization",
  linkedin: "LinkedIn Executive Presence",
};

export default function CallCampaignsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newScheduleAt, setNewScheduleAt] = useState("");
  const [newTemplateId, setNewTemplateId] = useState<number | null>(null);
  const [newBatchSize, setNewBatchSize] = useState(3);
  const [newWaveGapMinutes, setNewWaveGapMinutes] = useState(6);
  const [newProvider, setNewProvider] = useState<"vapi" | "retell">("vapi");

  const { data: campaigns = [], isLoading } = useQuery<any[]>({
    queryKey: ["call-campaigns"],
    queryFn: () => api("/call-campaigns").then(r => r.json()),
  });

  const { data: pitchTemplates = [] } = useQuery<any[]>({
    queryKey: ["pitch-templates"],
    queryFn: () => api("/pitch-templates").then(r => r.json()),
    enabled: creating,
  });

  const create = useMutation({
    mutationFn: () => json("/call-campaigns", "POST", {
      name: newName.trim(),
      provider: newProvider,
      ...(newTemplateId ? { pitchTemplateId: newTemplateId } : {}),
      ...(newScheduleAt ? { scheduleAt: new Date(newScheduleAt).toISOString() } : {}),
      batchSize: newBatchSize,
      waveGapMinutes: newWaveGapMinutes,
    }).then(r => r.json()),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["call-campaigns"] });
      setCreating(false);
      setNewName("");
      setNewScheduleAt("");
      setNewTemplateId(null);
      setNewBatchSize(3);
      setNewWaveGapMinutes(6);
      setNewProvider("vapi");
      navigate(`/calls/${d.id}`);
    },
    onError: () => toast({ title: "Failed to create campaign", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api(`/call-campaigns/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["call-campaigns"] }); setDeleteId(null); },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const startMutation = useMutation({
    mutationFn: (id: number) => json(`/call-campaigns/${id}/start`, "POST", {}).then(r => r.json()),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["call-campaigns"] });
      toast({ title: d.message ?? "Campaign started" });
    },
    onError: () => toast({ title: "Failed to start campaign", variant: "destructive" }),
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Phone className="w-5 h-5 text-indigo-600" />
            Call Campaigns
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            AI-powered outbound calling with Vapi.ai + ElevenLabs voice
          </p>
        </div>
        <Button
          className="bg-indigo-600 hover:bg-indigo-700 gap-1.5"
          onClick={() => setCreating(true)}
        >
          <Plus className="w-4 h-4" />
          New Campaign
        </Button>
      </div>

      {/* Campaign list */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <Card>
          <CardContent className="py-16 flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-indigo-50 flex items-center justify-center">
              <PhoneCall className="w-6 h-6 text-indigo-400" />
            </div>
            <p className="text-sm font-medium">No call campaigns yet</p>
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              Create a campaign to start AI-powered outbound calls using Vapi.ai.
              Configure your Vapi API key in Settings → Integrations first.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 gap-1.5"
              onClick={() => setCreating(true)}
            >
              <Plus className="w-3.5 h-3.5" />
              Create your first campaign
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {campaigns.map((c: any) => {
            const badge = STATUS_BADGE[c.status] ?? STATUS_BADGE.draft;
            const total   = Number(c.total_contacts   ?? 0);
            const done    = Number(c.done_contacts    ?? 0);
            const calling = Number(c.calling_contacts ?? 0);
            const failed  = Number(c.failed_contacts  ?? 0);
            const pct     = total > 0 ? Math.round((done / total) * 100) : 0;

            return (
              <Card key={c.id} className="hover:shadow-md transition-shadow">
                <CardContent className="px-4 py-3.5">
                  <div className="flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold truncate">{c.name}</p>
                        <Badge variant="outline" className={`text-[10px] h-4 px-1.5 ${badge.className}`}>
                          {badge.label}
                        </Badge>
                        {c.pitch_template_product_key && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-indigo-50 text-indigo-700 border-indigo-200">
                            {PRODUCT_LABEL[c.pitch_template_product_key] ?? c.pitch_template_product_key}
                          </Badge>
                        )}
                        {c.provider && c.provider !== "vapi" && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-teal-50 text-teal-700 border-teal-200">
                            {c.provider === "retell" ? "RetellAI" : c.provider}
                          </Badge>
                        )}
                        {calling > 0 && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-violet-50 text-violet-700 border-violet-200 animate-pulse">
                            {calling} calling
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-4 mt-1.5">
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Users className="w-3 h-3" /> {total} contacts
                        </span>
                        {done > 0 && (
                          <span className="flex items-center gap-1 text-xs text-emerald-600">
                            <CheckCircle2 className="w-3 h-3" /> {done} done
                          </span>
                        )}
                        {failed > 0 && (
                          <span className="flex items-center gap-1 text-xs text-destructive">
                            <AlertCircle className="w-3 h-3" /> {failed} failed
                          </span>
                        )}
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="w-3 h-3" />
                          {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                        </span>
                      </div>
                      {total > 0 && (
                        <div className="mt-2 h-1 bg-muted rounded-full overflow-hidden w-48">
                          <div
                            className="h-full bg-indigo-500 rounded-full transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {(c.status === "draft" || c.status === "paused") && total > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                          onClick={(e) => { e.stopPropagation(); startMutation.mutate(c.id); }}
                          disabled={startMutation.isPending}
                        >
                          {startMutation.isPending && startMutation.variables === c.id
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <Play className="w-3 h-3" />}
                          Start
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); setDeleteId(c.id); }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs gap-1"
                        onClick={() => navigate(`/calls/${c.id}`)}
                      >
                        Open <ChevronRight className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={v => { setCreating(v); if (!v) { setNewName(""); setNewScheduleAt(""); setNewTemplateId(null); setNewBatchSize(3); setNewWaveGapMinutes(6); setNewProvider("vapi"); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Call Campaign</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs font-medium text-muted-foreground">Calling Provider</Label>
              <div className="flex gap-2 mt-1.5">
                {(["vapi", "retell"] as const).map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setNewProvider(p)}
                    className={`h-8 px-3 text-xs rounded border font-medium transition-colors ${
                      newProvider === p
                        ? "bg-indigo-600 text-white border-indigo-600"
                        : "bg-card text-muted-foreground border-border hover:border-indigo-400"
                    }`}
                  >
                    {p === "vapi" ? "Vapi" : "RetellAI"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground">Campaign Name</Label>
              <Input
                className="mt-1.5 h-8 text-sm"
                placeholder="e.g. AI Search — Q3 Outreach"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && newName.trim()) create.mutate(); }}
                autoFocus
              />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground">
                Pitch Template <span className="text-[10px] text-muted-foreground/70 font-normal">(which product is this campaign for?)</span>
              </Label>
              <select
                className="w-full h-8 px-2 text-sm border rounded bg-background mt-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                value={newTemplateId ?? ""}
                onChange={e => setNewTemplateId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— No template (configure later) —</option>
                {(pitchTemplates as any[]).map((t: any) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({PRODUCT_LABEL[t.product_key] ?? t.product_key})
                  </option>
                ))}
              </select>
              {(pitchTemplates as any[]).length === 0 && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  No templates yet — create one in <strong>Library → Pitch Templates</strong> first.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-medium text-muted-foreground">
                  Batch size <span className="text-[10px] text-muted-foreground/70 font-normal">(calls / wave)</span>
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  className="mt-1.5 h-8 text-sm"
                  value={newBatchSize}
                  onChange={e => setNewBatchSize(Math.max(1, Math.min(50, parseInt(e.target.value) || 3)))}
                />
              </div>
              <div>
                <Label className="text-xs font-medium text-muted-foreground">
                  Gap <span className="text-[10px] text-muted-foreground/70 font-normal">(min between waves)</span>
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  className="mt-1.5 h-8 text-sm"
                  value={newWaveGapMinutes}
                  onChange={e => setNewWaveGapMinutes(Math.max(1, parseInt(e.target.value) || 6))}
                />
              </div>
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground">
                Schedule Start <span className="text-[10px] text-muted-foreground/70 font-normal">(optional — leave blank to start manually)</span>
              </Label>
              <Input
                type="datetime-local"
                className="mt-1.5 h-8 text-sm"
                value={newScheduleAt}
                onChange={e => setNewScheduleAt(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!newName.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the campaign and all associated contact records. Call logs are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteId !== null && deleteMutation.mutate(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
