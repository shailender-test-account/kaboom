import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import FormsBannersTab from "./FormsBannersTab";
import BannersLibraryPage from "@/pages/library/banners";
import { JourneyRoutingTab } from "./JourneyRoutingTab";
import { TeamAccessTab } from "@/components/settings/TeamAccessTab";
import {
  Settings, Plus, Trash2, Check, X, Pencil, Save,
  Building2, Users, TrendingUp, Sliders, Puzzle,
  Mail, Shield, Copy, CheckCheck, UserPlus, Loader2, Layers, Megaphone, GitBranch, MoreHorizontal,
  KeyRound, Eye, EyeOff, Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Wrench, History, RefreshCw, Info,
  ExternalLink, ChevronRight, ChevronDown, AlertTriangle, DatabaseZap,
} from "lucide-react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { ScoreBadge, resolveThreshold, FALLBACK_THRESHOLDS } from "@/components/ScoreBadge";
import type { Threshold } from "@/components/ScoreBadge";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });
const json = (path: string, method: string, body: unknown) =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ── Scoring helpers ──────────────────────────────────────────────────────────
const PRESET_COLORS = ["slate", "gray", "blue", "indigo", "violet", "green", "emerald", "yellow", "amber", "orange", "red", "rose", "purple"];
const COLOR_DOTS: Record<string, string> = {
  slate: "bg-slate-400", gray: "bg-gray-400", blue: "bg-blue-500",
  indigo: "bg-indigo-500", violet: "bg-violet-500", green: "bg-green-500",
  emerald: "bg-emerald-500", yellow: "bg-yellow-500", amber: "bg-amber-500",
  orange: "bg-orange-500", red: "bg-red-500", rose: "bg-rose-500", purple: "bg-purple-500",
};
const COLOR_BADGE: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700 border-slate-200",
  gray: "bg-gray-100 text-gray-700 border-gray-200",
  blue: "bg-blue-100 text-blue-700 border-blue-200",
  indigo: "bg-indigo-100 text-indigo-700 border-indigo-200",
  violet: "bg-violet-100 text-violet-700 border-violet-200",
  green: "bg-green-100 text-green-700 border-green-200",
  emerald: "bg-emerald-100 text-emerald-700 border-emerald-200",
  yellow: "bg-yellow-100 text-yellow-700 border-yellow-200",
  amber: "bg-amber-100 text-amber-700 border-amber-200",
  orange: "bg-orange-100 text-orange-700 border-orange-200",
  red: "bg-red-100 text-red-700 border-red-200",
  rose: "bg-rose-100 text-rose-700 border-rose-200",
  purple: "bg-purple-100 text-purple-700 border-purple-200",
};

type ScoringRule = { id: number; eventType: string; points: number; description: string | null; isActive: boolean };
type ScoreThreshold = { id: number; tenantId: number; label: string; minScore: number; color: string };
type TeamUser = { id: number; email: string; firstName: string; lastName: string; role: string; createdAt: string };
type StageConfig = { id: number; slug: string; label: string; color: string; minScore: number; description: string | null; displayOrder: number };

// ── RuleRow ──────────────────────────────────────────────────────────────────
function RuleRow({ rule, thresholds }: { rule: ScoringRule; thresholds: ScoreThreshold[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [pts, setPts] = useState(String(rule.points));
  const [desc, setDesc] = useState(rule.description ?? "");

  const patch = useMutation({
    mutationFn: (data: Partial<ScoringRule>) =>
      json(`/scoring-rules/${rule.id}`, "PATCH", data).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scoring-rules"] });
      qc.invalidateQueries({ queryKey: ["scoring-stale-status"] });
      toast({ title: "Rule saved" });
      setEditing(false);
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: () => api(`/scoring-rules/${rule.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scoring-rules"] });
      qc.invalidateQueries({ queryKey: ["scoring-stale-status"] });
    },
  });

  const previewScore = parseInt(pts) || rule.points;

  return (
    <tr className="border-b last:border-0 group">
      <td className="py-3 px-4">
        <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{rule.eventType}</span>
      </td>
      <td className="py-3 px-4">
        {editing
          ? <Input value={desc} onChange={e => setDesc(e.target.value)} className="h-7 text-sm w-56" placeholder="Description..." />
          : <span className="text-sm text-muted-foreground">{rule.description ?? "—"}</span>}
      </td>
      <td className="py-3 px-4 w-36">
        {editing
          ? <div className="flex items-center gap-2">
              <Input type="number" value={pts} onChange={e => setPts(e.target.value)} className="h-7 w-20 text-sm text-center" />
              <ScoreBadge score={Math.max(0, Math.min(200, previewScore))} thresholds={thresholds.length ? thresholds : FALLBACK_THRESHOLDS} />
            </div>
          : <span className={cn("text-sm font-semibold tabular-nums", rule.points >= 0 ? "text-green-600" : "text-red-600")}>
              {rule.points >= 0 ? "+" : ""}{rule.points} pts
            </span>}
      </td>
      <td className="py-3 px-4">
        <Switch checked={rule.isActive} onCheckedChange={() => patch.mutate({ isActive: !rule.isActive })} />
      </td>
      <td className="py-3 px-4">
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {editing ? (
            <>
              <Button size="icon" variant="ghost" className="h-7 w-7"
                onClick={() => patch.mutate({ points: parseInt(pts) || rule.points, description: desc || undefined })}>
                <Check className="w-3.5 h-3.5 text-green-600" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7"
                onClick={() => { setEditing(false); setPts(String(rule.points)); setDesc(rule.description ?? ""); }}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </>
          ) : (
            <>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(true)}><Pencil className="w-3.5 h-3.5" /></Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => del.mutate()}><Trash2 className="w-3.5 h-3.5" /></Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function AddRuleRow({ onAdded }: { onAdded: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [eventType, setEventType] = useState("");
  const [points, setPoints] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => json("/scoring-rules", "POST", { eventType, points: parseInt(points), description: description || undefined, isActive: true })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => {
      onAdded();
      qc.invalidateQueries({ queryKey: ["scoring-stale-status"] });
      setOpen(false);
      setEventType("");
      setPoints("");
      setDescription("");
    },
    onError: () => toast({ title: "Failed to create", variant: "destructive" }),
  });
  if (!open) return (
    <tr><td colSpan={5} className="py-2 px-4">
      <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
        <Plus className="w-3.5 h-3.5" /> Add rule
      </button>
    </td></tr>
  );
  return (
    <tr className="bg-muted/30">
      <td className="py-2 px-4"><Input value={eventType} onChange={e => setEventType(e.target.value)} className="h-7 text-sm font-mono w-40" placeholder="event_type" /></td>
      <td className="py-2 px-4"><Input value={description} onChange={e => setDescription(e.target.value)} className="h-7 text-sm w-48" placeholder="Description..." /></td>
      <td className="py-2 px-4"><Input type="number" value={points} onChange={e => setPoints(e.target.value)} className="h-7 text-sm w-20" placeholder="±pts" /></td>
      <td className="py-2 px-4" />
      <td className="py-2 px-4">
        <div className="flex gap-1">
          <Button size="sm" className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700"
            onClick={() => create.mutate()} disabled={!eventType || !points || create.isPending}>
            <Save className="w-3 h-3 mr-1" /> Save
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </td>
    </tr>
  );
}

// ── ThresholdRow ─────────────────────────────────────────────────────────────
function ThresholdRow({ t, onSaved, onDeleted }: { t: ScoreThreshold; onSaved: () => void; onDeleted: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(t.label);
  const [minScore, setMinScore] = useState(String(t.minScore));
  const [color, setColor] = useState(t.color);
  const patch = useMutation({
    mutationFn: () => json(`/score-thresholds/${t.id}`, "PATCH", { label, minScore: parseInt(minScore), color })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => { onSaved(); setEditing(false); },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: () => api(`/score-thresholds/${t.id}`, { method: "DELETE" }),
    onSuccess: onDeleted,
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });
  if (editing) return (
    <tr className="border-b last:border-0 bg-muted/30">
      <td className="py-2 px-4"><Input value={label} onChange={e => setLabel(e.target.value)} className="h-7 text-sm w-32" /></td>
      <td className="py-2 px-4"><Input type="number" value={minScore} onChange={e => setMinScore(e.target.value)} className="h-7 text-sm w-20" /></td>
      <td className="py-2 px-4">
        <div className="flex items-center gap-1.5 flex-wrap">
          {PRESET_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)}
              className={cn("w-5 h-5 rounded-full", COLOR_DOTS[c], color === c && "ring-2 ring-offset-1 ring-foreground")} />
          ))}
        </div>
      </td>
      <td className="py-2 px-4">
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => patch.mutate()} disabled={patch.isPending}><Check className="w-3.5 h-3.5 text-green-600" /></Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(false)}><X className="w-3.5 h-3.5" /></Button>
        </div>
      </td>
    </tr>
  );
  return (
    <tr className="border-b last:border-0 group">
      <td className="py-3 px-4">
        <div className="flex items-center gap-2">
          <span className={cn("w-2.5 h-2.5 rounded-full", COLOR_DOTS[t.color] ?? "bg-gray-400")} />
          <span className="text-sm font-medium">{t.label}</span>
        </div>
      </td>
      <td className="py-3 px-4"><span className="text-sm text-muted-foreground">≥ {t.minScore} pts</span></td>
      <td className="py-3 px-4"><ScoreBadge score={t.minScore} thresholds={[t]} showLabel /></td>
      <td className="py-3 px-4">
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(true)}><Pencil className="w-3.5 h-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => del.mutate()}><Trash2 className="w-3.5 h-3.5" /></Button>
        </div>
      </td>
    </tr>
  );
}

function AddThresholdRow({ onAdded }: { onAdded: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(""); const [minScore, setMinScore] = useState(""); const [color, setColor] = useState("blue");
  const create = useMutation({
    mutationFn: () => json("/score-thresholds", "POST", { label, minScore: parseInt(minScore), color })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => { onAdded(); setOpen(false); setLabel(""); setMinScore(""); setColor("blue"); },
    onError: () => toast({ title: "Failed to create", variant: "destructive" }),
  });
  if (!open) return (
    <tr><td colSpan={4} className="py-2 px-4">
      <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
        <Plus className="w-3.5 h-3.5" /> Add threshold
      </button>
    </td></tr>
  );
  return (
    <tr className="bg-muted/30">
      <td className="py-2 px-4"><Input value={label} onChange={e => setLabel(e.target.value)} className="h-7 text-sm w-32" placeholder="e.g. Hot" /></td>
      <td className="py-2 px-4"><Input type="number" value={minScore} onChange={e => setMinScore(e.target.value)} className="h-7 text-sm w-20" placeholder="50" /></td>
      <td className="py-2 px-4">
        <div className="flex items-center gap-1.5 flex-wrap">
          {PRESET_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)}
              className={cn("w-5 h-5 rounded-full", COLOR_DOTS[c], color === c && "ring-2 ring-offset-1 ring-foreground")} />
          ))}
        </div>
      </td>
      <td className="py-2 px-4">
        <div className="flex gap-1">
          <Button size="sm" className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700"
            onClick={() => create.mutate()} disabled={!label || !minScore || create.isPending}>
            <Save className="w-3 h-3 mr-1" /> Save
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </td>
    </tr>
  );
}

// ── RecomputeResult types ────────────────────────────────────────────────────
type RecomputeChange = {
  id: number; name: string; email: string;
  oldScore: number; newScore: number; delta: number;
};
type RecomputeLogEntry = {
  id: number; timestamp: string;
  total: number; updated: number; errors: number;
  changes: RecomputeChange[];
};

// ── ScoreIntegrityPanel ───────────────────────────────────────────────────────
type IntegrityContact = { id: number; name: string; email: string; intentScore: number; missingDeltaCount?: number; estimatedMissingDelta?: number };
type IntegrityReport  = {
  dataGapCount: number; formulaOnlyCount: number; totalCount: number;
  dataGap: IntegrityContact[]; formulaOnly: IntegrityContact[];
};

function ScoreIntegrityPanel() {
  const [open, setOpen]             = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const { data: report, isFetching, refetch } = useQuery<IntegrityReport>({
    queryKey: ["score-integrity"],
    queryFn: () => api("/scoring/score-integrity").then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    enabled: open,
    staleTime: 60_000,
  });

  const backfill = useMutation({
    mutationFn: () => api("/scoring/score-integrity/backfill", { method: "POST" }).then(async r => {
      if (!r.ok) throw new Error((await r.json()).error ?? "Backfill failed");
      return r.json() as Promise<{ eventsPatched: number; contactsRecomputed: number; errors: number }>;
    }),
    onSuccess: (data) => {
      toast({
        title: "Backfill complete",
        description: `${data.eventsPatched} event${data.eventsPatched !== 1 ? "s" : ""} patched · ${data.contactsRecomputed} score${data.contactsRecomputed !== 1 ? "s" : ""} recomputed${data.errors ? ` · ${data.errors} error${data.errors !== 1 ? "s" : ""}` : ""}.`,
      });
      refetch();
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <>
      {/* Confirmation dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Backfill missing score deltas?</AlertDialogTitle>
            <AlertDialogDescription>
              This will set <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">score_delta = 5</code> on all
              email_open events and <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">score_delta = 15</code> on
              all email_click events where the value is currently 0 or missing,
              then recompute intent scores for every affected contact. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmOpen(false); backfill.mutate(); }}>
              Backfill missing deltas
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Panel */}
      <div className="rounded-lg border border-border overflow-hidden bg-card">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/30 transition-colors"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Score Integrity
            {report && report.totalCount > 0 && (
              <span className="ml-1 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold px-2 py-0.5">
                {report.totalCount} contact{report.totalCount !== 1 ? "s" : ""}
              </span>
            )}
            {report && report.totalCount === 0 && (
              <span className="ml-1 rounded-full bg-green-100 text-green-700 text-xs font-semibold px-2 py-0.5">
                All clear
              </span>
            )}
          </span>
          <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>

        {open && (
          <div className="border-t">
            {isFetching ? (
              <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Scanning contacts…
              </div>
            ) : !report ? (
              <div className="px-4 py-4 text-sm text-muted-foreground">Failed to load report.</div>
            ) : report.totalCount === 0 ? (
              <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                No contacts with unexplained intent scores — all timeline Σ values are consistent.
              </div>
            ) : (
              <div className="divide-y">
                {/* Summary row */}
                <div className="flex flex-wrap gap-4 px-4 py-3 bg-muted/20 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-500" />
                    <span className="font-medium text-amber-700">{report.dataGapCount}</span>
                    <span className="text-muted-foreground">data gap — email events with missing delta (backfill needed)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sky-400" />
                    <span className="font-medium text-sky-700">{report.formulaOnlyCount}</span>
                    <span className="text-muted-foreground">formula-only — score from bonuses alone (expected)</span>
                  </div>
                </div>

                {/* Data gap table */}
                {report.dataGap.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between px-4 py-2 bg-amber-50/60">
                      <p className="text-xs font-medium text-amber-800">
                        Data gap — email_open / email_click events recorded with score_delta = 0
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
                        onClick={() => setConfirmOpen(true)}
                        disabled={backfill.isPending}
                      >
                        {backfill.isPending
                          ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Backfilling…</>
                          : <><RefreshCw className="w-3 h-3 mr-1.5" />Backfill missing deltas</>}
                      </Button>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b bg-muted/10">
                          <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Contact</th>
                          <th className="text-right text-xs font-medium text-muted-foreground py-2 px-4 w-28">Intent score</th>
                          <th className="text-right text-xs font-medium text-muted-foreground py-2 px-4 w-28">Events missing Σ</th>
                          <th className="text-right text-xs font-medium text-muted-foreground py-2 px-4 w-32">Est. missing pts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.dataGap.map(c => (
                          <tr
                            key={c.id}
                            className="border-b last:border-0 hover:bg-muted/20 cursor-pointer transition-colors"
                            onClick={() => navigate(`/crm/contacts/${c.id}`)}
                          >
                            <td className="py-2.5 px-4">
                              <div className="text-sm font-medium truncate max-w-[200px]">{c.name}</div>
                              <div className="text-xs text-muted-foreground truncate max-w-[200px]">{c.email}</div>
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <span className="text-sm font-semibold tabular-nums">{c.intentScore}</span>
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <span className="text-sm tabular-nums text-amber-600 font-medium">{c.missingDeltaCount}</span>
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <span className="text-sm tabular-nums text-green-600 font-medium">+{c.estimatedMissingDelta}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Formula-only table */}
                {report.formulaOnly.length > 0 && (
                  <div>
                    <div className="px-4 py-2 bg-sky-50/60">
                      <p className="text-xs font-medium text-sky-800">
                        Formula-only — score driven by stage bonus, velocity, or ABM colleagues (no backfill needed)
                      </p>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b bg-muted/10">
                          <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Contact</th>
                          <th className="text-right text-xs font-medium text-muted-foreground py-2 px-4 w-28">Intent score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.formulaOnly.map(c => (
                          <tr
                            key={c.id}
                            className="border-b last:border-0 hover:bg-muted/20 cursor-pointer transition-colors"
                            onClick={() => navigate(`/crm/contacts/${c.id}`)}
                          >
                            <td className="py-2.5 px-4">
                              <div className="text-sm font-medium truncate max-w-[200px]">{c.name}</div>
                              <div className="text-xs text-muted-foreground truncate max-w-[200px]">{c.email}</div>
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <span className="text-sm font-semibold tabular-nums">{c.intentScore}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── ScoringRulesTab ──────────────────────────────────────────────────────────
function ScoringRulesTab() {
  const qc = useQueryClient();
  const { user } = useAuthContext();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const isAdmin = (user as any)?.role === "admin";
  // null   = no user preference — auto-expand the latest run from query cache
  // number = user explicitly expanded that run
  // "none" = user explicitly collapsed all runs
  const [userExpandedRunId, setUserExpandedRunId] = useState<number | "none" | null>(null);
  // which run's change table shows ALL rows (vs first 5)
  const [showAllRunId, setShowAllRunId] = useState<number | null>(null);

  const { data: rules = [] } = useQuery<ScoringRule[]>({
    queryKey: ["scoring-rules"],
    queryFn: () => api("/scoring-rules").then(r => r.json()),
  });
  const { data: thresholds = [] } = useQuery<ScoreThreshold[]>({
    queryKey: ["score-thresholds"],
    queryFn: () => api("/score-thresholds").then(r => r.json()),
  });

  const { data: runHistory = [] } = useQuery<RecomputeLogEntry[]>({
    queryKey: ["scoring-recompute-log"],
    queryFn: async () => {
      const r = await api("/scoring/recompute-log");
      if (!r.ok) throw new Error("Failed to load recompute log");
      return r.json();
    },
    staleTime: 30_000,
  });

  // Server-persisted stale-score signal: isStale = true when rules were changed
  // after the last bulk recompute (or no recompute has ever run).
  const { data: staleData } = useQuery<{ isStale: boolean; rulesChangedAt: string | null; lastRecomputeAt: string | null }>({
    queryKey: ["scoring-stale-status"],
    queryFn: async () => {
      const r = await api("/scoring/stale-status");
      if (!r.ok) throw new Error("Failed to load stale status");
      return r.json();
    },
    staleTime: 30_000,
  });

  // Derive the effective expanded run ID from the query cache directly —
  // no useState seed needed, so there's no flicker on mount.
  const expandedRunId =
    userExpandedRunId === null
      ? (runHistory[0]?.id ?? null)   // auto-expand the latest run
      : userExpandedRunId === "none"
        ? null                         // user explicitly collapsed all
        : userExpandedRunId;           // user explicitly expanded a specific run

  const positiveRules = rules.filter(r => r.points >= 0);
  const negativeRules = rules.filter(r => r.points < 0);

  const recompute = useMutation({
    mutationFn: () =>
      api("/scoring/recompute", { method: "POST" }).then(async r => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Recompute failed");
        return r.json() as Promise<RecomputeLogEntry>;
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["scoring-stale-status"] });
      qc.invalidateQueries({ queryKey: ["scoring-recompute-log"] }).then(() => {
        // pin to the newly added run once the list refreshes
        setUserExpandedRunId(data.id);
        setShowAllRunId(null);
      });
      toast({
        title: "Scores recomputed",
        description: `${data.changes.length} contact${data.changes.length !== 1 ? "s" : ""} changed${data.errors ? ` · ${data.errors} error${data.errors !== 1 ? "s" : ""}` : ""}.`,
      });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const cleanupBotEvents = useMutation({
    mutationFn: () =>
      api("/scoring/cleanup-bot-events", { method: "POST" }).then(async r => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Cleanup failed");
        return r.json() as Promise<{ botClicksDeleted: number; followOnEventsDeleted: number; contactsRecomputed: number }>;
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast({
        title: "Bot events cleaned up",
        description: `${data.botClicksDeleted} bot clicks removed · ${data.followOnEventsDeleted} follow-on events removed · ${data.contactsRecomputed} scores recomputed.`,
      });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Scoring Rules</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Points awarded or deducted when a contact performs an action. Scores are capped at 200.</p>
        </div>
        {isAdmin && (
          <div className="flex gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-red-200 text-red-700 hover:bg-red-50"
              onClick={() => cleanupBotEvents.mutate()}
              disabled={cleanupBotEvents.isPending || recompute.isPending}
              title="Remove email_click / page_view events written by Safe Links / corporate email scanners (< 5 min after send) and recompute affected scores"
            >
              {cleanupBotEvents.isPending
                ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              Clean up bot events
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => recompute.mutate()}
              disabled={recompute.isPending || cleanupBotEvents.isPending}
            >
              {recompute.isPending
                ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              Recompute all scores
            </Button>
          </div>
        )}
      </div>

      {/* ── Stale-score banner — shown when server reports rules changed since last recompute ── */}
      {isAdmin && staleData?.isStale && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-orange-500" />
            <div>
              <p className="text-sm font-medium text-orange-800">Formula changed — contacts may show stale scores</p>
              <p className="text-xs text-orange-700 mt-0.5">
                Existing scores reflect the previous rule values. Run a recompute to apply the updated formula to all contacts.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="shrink-0 bg-orange-600 hover:bg-orange-700 text-white"
            onClick={() => recompute.mutate()}
            disabled={recompute.isPending}
          >
            {recompute.isPending
              ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Recomputing…</>
              : <><RefreshCw className="w-3.5 h-3.5 mr-1.5" />Run recompute</>}
          </Button>
        </div>
      )}

      {isAdmin && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
          <span>
            <strong>Recompute recalculates every contact's score from their full activity history.</strong>{" "}
            Routing rules (sequence enrollments, journey assignments) are suppressed during a bulk recompute so contacts don't lose their current sequence progress or get re-enrolled unexpectedly.
          </span>
        </div>
      )}

      {/* ── Recompute History ─────────────────────────────────────────────── */}
      {runHistory.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          {/* History header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
            <History className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">Recompute History</span>
            <span className="text-xs text-muted-foreground">({runHistory.length} run{runHistory.length !== 1 ? "s" : ""})</span>
          </div>

          {/* One row per run */}
          <div className="divide-y">
            {runHistory.map(run => {
              const isExpanded = expandedRunId === run.id;
              const showAll = showAllRunId === run.id;
              const visible = showAll ? run.changes : run.changes.slice(0, 5);

              return (
                <div key={run.id}>
                  {/* Run summary row — click to expand/collapse */}
                  <button
                    type="button"
                    className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/20 transition-colors"
                    onClick={() => setUserExpandedRunId(isExpanded ? "none" : run.id)}
                  >
                    <div className="flex items-center gap-3">
                      <ChevronRight className={cn(
                        "w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0",
                        isExpanded && "rotate-90",
                      )} />
                      <span className="text-xs text-muted-foreground">
                        {new Date(run.timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{run.total} processed</span>
                      <span className={cn(
                        "font-medium",
                        run.changes.length > 0 ? "text-foreground" : "text-muted-foreground",
                      )}>
                        {run.changes.length} changed
                      </span>
                      {run.errors > 0 && (
                        <span className="text-destructive">{run.errors} error{run.errors !== 1 ? "s" : ""}</span>
                      )}
                    </div>
                  </button>

                  {/* Expanded change table */}
                  {isExpanded && (
                    <div className="border-t bg-muted/10">
                      {run.changes.length === 0 ? (
                        <div className="px-8 py-3 text-xs text-muted-foreground">
                          No score changes — all contacts were already up to date.
                        </div>
                      ) : (
                        <>
                          <table className="w-full">
                            <thead>
                              <tr className="border-b">
                                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4 pl-8">Contact</th>
                                <th className="text-right text-xs font-medium text-muted-foreground py-2 px-4 w-24">Before</th>
                                <th className="text-right text-xs font-medium text-muted-foreground py-2 px-4 w-24">After</th>
                                <th className="text-right text-xs font-medium text-muted-foreground py-2 px-4 w-28">Change</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visible.map(c => (
                                <tr
                                  key={c.id}
                                  role="link"
                                  tabIndex={0}
                                  className="border-b last:border-0 hover:bg-muted/20 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-inset"
                                  onClick={(e) => {
                                    if (e.metaKey || e.ctrlKey) {
                                      window.open(`/crm/contacts/${c.id}`, "_blank");
                                    } else {
                                      navigate(`/crm/contacts/${c.id}`);
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      navigate(`/crm/contacts/${c.id}`);
                                    }
                                  }}
                                >
                                  <td className="py-2.5 px-4 pl-8">
                                    <div className="text-sm font-medium truncate max-w-[200px]">{c.name}</div>
                                    <div className="text-xs text-muted-foreground truncate max-w-[200px]">{c.email}</div>
                                  </td>
                                  <td className="py-2.5 px-4 text-right">
                                    <ScoreBadge score={c.oldScore} thresholds={thresholds.length ? thresholds : FALLBACK_THRESHOLDS} />
                                  </td>
                                  <td className="py-2.5 px-4 text-right">
                                    <ScoreBadge score={c.newScore} thresholds={thresholds.length ? thresholds : FALLBACK_THRESHOLDS} />
                                  </td>
                                  <td className="py-2.5 px-4 text-right">
                                    <span className={cn(
                                      "text-sm font-semibold tabular-nums",
                                      c.delta > 0 ? "text-green-600" : "text-red-600",
                                    )}>
                                      {c.delta > 0 ? "+" : ""}{c.delta}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {run.changes.length > 5 && (
                            <div className="px-8 py-2.5 border-t bg-muted/20">
                              <button
                                onClick={(e) => { e.stopPropagation(); setShowAllRunId(showAll ? null : run.id); }}
                                className="text-xs text-indigo-600 hover:text-indigo-700 font-medium transition-colors"
                              >
                                {showAll ? "Show fewer" : `Show all ${run.changes.length} changes`}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {positiveRules.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">Positive signals</p>
          <div className="border rounded-lg overflow-hidden bg-card">
            <table className="w-full">
              <thead><tr className="bg-muted/50 border-b">
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Event type</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Description</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4 w-36">Points</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4 w-20">Active</th>
                <th className="py-2 px-4 w-20" />
              </tr></thead>
              <tbody>{positiveRules.map(r => <RuleRow key={r.id} rule={r} thresholds={thresholds} />)}</tbody>
            </table>
          </div>
        </div>
      )}
      {negativeRules.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">Negative signals</p>
          <div className="border rounded-lg overflow-hidden bg-card">
            <table className="w-full">
              <thead><tr className="bg-muted/50 border-b">
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Event type</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Description</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4 w-36">Points</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4 w-20">Active</th>
                <th className="py-2 px-4 w-20" />
              </tr></thead>
              <tbody>{negativeRules.map(r => <RuleRow key={r.id} rule={r} thresholds={thresholds} />)}</tbody>
            </table>
          </div>
        </div>
      )}
      <div className="border rounded-lg overflow-hidden bg-card">
        <table className="w-full"><tbody>
          <AddRuleRow onAdded={() => qc.invalidateQueries({ queryKey: ["scoring-rules"] })} />
        </tbody></table>
      </div>

      {isAdmin && <ScoreIntegrityPanel />}
    </div>
  );
}

// ── ThresholdsTab ────────────────────────────────────────────────────────────
function ThresholdsTab() {
  const qc = useQueryClient();
  const { data: thresholds = [] } = useQuery<ScoreThreshold[]>({
    queryKey: ["score-thresholds"],
    queryFn: () => api("/score-thresholds").then(r => r.json()),
  });
  const sorted = [...thresholds].sort((a, b) => a.minScore - b.minScore);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Score Thresholds</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Define score bands that classify contacts. Contacts reaching a higher band appear with that color in the CRM.</p>
      </div>
      {sorted.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {sorted.map(t => (
            <div key={t.id} className="flex items-center gap-1.5">
              <ScoreBadge score={t.minScore} thresholds={thresholds} showLabel />
              <span className="text-xs text-muted-foreground">≥{t.minScore}</span>
            </div>
          ))}
        </div>
      )}
      <div className="border rounded-lg overflow-hidden bg-card">
        <table className="w-full">
          <thead><tr className="bg-muted/50 border-b">
            <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Label</th>
            <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Min Score</th>
            <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Preview</th>
            <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4 w-24">Actions</th>
          </tr></thead>
          <tbody>
            {sorted.map(t => (
              <ThresholdRow key={t.id} t={t}
                onSaved={() => qc.invalidateQueries({ queryKey: ["score-thresholds"] })}
                onDeleted={() => qc.invalidateQueries({ queryKey: ["score-thresholds"] })}
              />
            ))}
            <AddThresholdRow onAdded={() => qc.invalidateQueries({ queryKey: ["score-thresholds"] })} />
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── OrganizationTab ──────────────────────────────────────────────────────────
function OrganizationTab() {
  const { user } = useAuthContext();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const tenantId = (user as any)?.tenantId ?? "—";

  const [orgName, setOrgName] = useState((user as any)?.tenantName ?? "");
  useEffect(() => { setOrgName((user as any)?.tenantName ?? ""); }, [user]);

  const orgMutation = useMutation({
    mutationFn: async (name: string) => {
      const r = await fetch("/api/settings/organization", {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => toast({ title: "Organization name updated" }),
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [newTenant, setNewTenant] = useState({ name: "", adminEmail: "", adminPassword: "" });
  const createMutation = useMutation({
    mutationFn: async (body: typeof newTenant) => {
      const r = await fetch("/api/settings/tenants", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed");
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: `Tenant "${data.tenant.name}" created — ID: ${data.tenant.id}` });
      setCreateOpen(false);
      setNewTenant({ name: "", adminEmail: "", adminPassword: "" });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const isAdmin = (user as any)?.role === "admin";

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-base font-semibold text-foreground">Organization</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Your workspace configuration and billing info.</p>
      </div>

      <Card className="shadow-xs">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workspace Details</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1.5">Organization name</label>
            <div className="flex items-center gap-2">
              <Input
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                className="h-8 text-sm"
                placeholder="Your organization name"
              />
              <Button
                size="sm"
                className="h-8 bg-indigo-600 hover:bg-indigo-700 shrink-0"
                disabled={orgMutation.isPending || !orgName.trim() || orgName.trim() === ((user as any)?.tenantName ?? "")}
                onClick={() => orgMutation.mutate(orgName.trim())}
              >
                {orgMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span className="ml-1.5">Save</span>
              </Button>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1.5">Tenant ID</label>
            <div className="flex items-center gap-2">
              <Input value={String(tenantId)} className="h-8 text-sm font-mono" readOnly />
              <Button size="icon" variant="outline" className="h-8 w-8 shrink-0"
                onClick={() => { navigator.clipboard.writeText(String(tenantId)); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                {copied ? <CheckCheck className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-xs">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Plan & Billing</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Professional Plan</p>
              <p className="text-xs text-muted-foreground mt-0.5">Unlimited plays, journeys, sequences · up to 50k contacts</p>
            </div>
            <Badge variant="default" className="bg-indigo-600 text-white">Active</Badge>
          </div>
        </CardContent>
      </Card>

      {isAdmin && (
        <Card className="shadow-xs">
          <CardHeader className="pb-2 pt-4 px-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Multi-Tenant</CardTitle>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setCreateOpen(true)}>
                <Plus className="w-3.5 h-3.5" /> New Tenant
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <p className="text-xs text-muted-foreground">Create a separate tenant workspace with its own admin user, data, and journeys.</p>
          </CardContent>
        </Card>
      )}

      <Card className="shadow-xs border-dashed">
        <CardContent className="px-4 py-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
              <Shield className="w-4 h-4 text-amber-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Data & Privacy</p>
              <p className="text-xs text-muted-foreground mt-0.5">All data is stored within your region. GDPR compliant. Contact support to request a data export or deletion.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Tenant</DialogTitle>
            <DialogDescription>A new isolated workspace with its own data and admin user.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1.5">Organization name</label>
              <Input
                value={newTenant.name}
                onChange={e => setNewTenant(p => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Acme Corp"
                className="h-8 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1.5">Admin email</label>
              <Input
                type="email"
                value={newTenant.adminEmail}
                onChange={e => setNewTenant(p => ({ ...p, adminEmail: e.target.value }))}
                placeholder="admin@example.com"
                className="h-8 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1.5">Admin password <span className="text-muted-foreground font-normal">(min 8 chars)</span></label>
              <Input
                type="password"
                value={newTenant.adminPassword}
                onChange={e => setNewTenant(p => ({ ...p, adminPassword: e.target.value }))}
                placeholder="••••••••"
                className="h-8 text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={createMutation.isPending || !newTenant.name.trim() || !newTenant.adminEmail.trim() || newTenant.adminPassword.length < 8}
              onClick={() => createMutation.mutate(newTenant)}
            >
              {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1.5" />}
              Create Tenant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── TeamTab ──────────────────────────────────────────────────────────────────
const ROLES = ["admin", "manager", "editor", "viewer"] as const;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function LegacyTeamTab() {
  const { user } = useAuthContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteFirst, setInviteFirst] = useState("");
  const [inviteLast, setInviteLast] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "manager" | "editor" | "viewer">("editor");
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [newCreds, setNewCreds] = useState<{ email: string; tempPassword: string } | null>(null);
  const [editMember, setEditMember] = useState<TeamUser | null>(null);
  const [editFirst, setEditFirst] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [pwUserId, setPwUserId] = useState<number | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [selfPwOpen, setSelfPwOpen] = useState(false);
  const [selfCurrent, setSelfCurrent] = useState("");
  const [selfNew, setSelfNew] = useState("");
  const [selfShowCurrent, setSelfShowCurrent] = useState(false);
  const [selfShowNew, setSelfShowNew] = useState(false);

  const isSuperAdmin = user?.email === "saurabh@dotconverse.com";

  const { data: members = [], isLoading } = useQuery<TeamUser[]>({
    queryKey: ["users"],
    queryFn: () => api("/users").then(r => r.json()),
  });

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: number; role: string }) =>
      json(`/users/${id}/role`, "PATCH", { role }).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); toast({ title: "Role updated" }); },
    onError: () => toast({ title: "Failed to update role", variant: "destructive" }),
  });

  const deleteUser = useMutation({
    mutationFn: (id: number) =>
      api(`/users/${id}`, { method: "DELETE" }).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); toast({ title: "Member deleted" }); setDeleteId(null); },
    onError: () => toast({ title: "Failed to delete member", variant: "destructive" }),
  });

  const editProfile = useMutation({
    mutationFn: ({ id, ...data }: { id: number; firstName: string; lastName: string; email: string }) =>
      json(`/users/${id}/profile`, "PATCH", data).then(r => { if (!r.ok) return r.json().then((e: any) => Promise.reject(e)); return r.json(); }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); toast({ title: "Profile updated" }); setEditMember(null); },
    onError: (e: any) => toast({ title: e?.error ?? "Failed to update profile", variant: "destructive" }),
  });

  const changePassword = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      json(`/users/${id}/password`, "PATCH", { password }).then(r => { if (!r.ok) return r.json().then((e: any) => Promise.reject(e)); return r.json(); }),
    onSuccess: () => { toast({ title: "Password updated" }); setPwUserId(null); setPwValue(""); setShowPw(false); },
    onError: (e: any) => toast({ title: e?.error ?? "Failed to update password", variant: "destructive" }),
  });

  const changeSelfPassword = useMutation({
    mutationFn: () =>
      json("/auth/password", "PATCH", { currentPassword: selfCurrent, newPassword: selfNew })
        .then(r => { if (!r.ok) return r.json().then((e: any) => Promise.reject(e)); return r.json(); }),
    onSuccess: () => {
      toast({ title: "Password updated successfully" });
      setSelfPwOpen(false); setSelfCurrent(""); setSelfNew(""); setSelfShowCurrent(false); setSelfShowNew(false);
    },
    onError: (e: any) => toast({ title: e?.error ?? "Failed to update password", variant: "destructive" }),
  });

  const invite = useMutation({
    mutationFn: () => json("/users/invite", "POST", {
      email: inviteEmail, firstName: inviteFirst, lastName: inviteLast, role: inviteRole,
    }).then(r => { if (!r.ok) return r.json().then(e => Promise.reject(e)); return r.json(); }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setNewCreds({ email: data.user.email, tempPassword: data.tempPassword });
      setInviteOpen(false);
      setInviteEmail(""); setInviteFirst(""); setInviteLast(""); setInviteRole("editor");
    },
    onError: (e: any) => toast({ title: e?.error ?? "Failed to invite user", variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Team Members</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Manage who has access to this workspace and their permissions.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={() => setSelfPwOpen(true)}>
            <KeyRound className="w-3.5 h-3.5" /> Change my password
          </Button>
          <Button size="sm" className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700" onClick={() => setInviteOpen(true)}>
            <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Invite
          </Button>
        </div>
      </div>

      {/* New credentials banner */}
      {newCreds && (
        <Card className="border-emerald-200 bg-emerald-50 shadow-xs">
          <CardContent className="px-4 py-3">
            <p className="text-sm font-medium text-emerald-800 mb-1">User invited!</p>
            <p className="text-xs text-emerald-700">
              Share these credentials with <strong>{newCreds.email}</strong>:<br />
              Temp password: <span className="font-mono font-bold">{newCreds.tempPassword}</span>
            </p>
            <Button size="sm" variant="ghost" className="h-6 text-xs mt-2 text-emerald-700" onClick={() => setNewCreds(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Invite form */}
      {inviteOpen && (
        <Card className="shadow-xs border-indigo-100 bg-indigo-50/30">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold">Invite team member</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="First name" value={inviteFirst} onChange={e => setInviteFirst(e.target.value)} className="h-8 text-sm" />
              <Input placeholder="Last name" value={inviteLast} onChange={e => setInviteLast(e.target.value)} className="h-8 text-sm" />
            </div>
            <Input type="email" placeholder="Email address" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} className="h-8 text-sm" />
            <Select value={inviteRole} onValueChange={v => setInviteRole(v as any)}>
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLES.map(r => <SelectItem key={r} value={r} className="text-xs capitalize">{r}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700"
                onClick={() => invite.mutate()}
                disabled={!inviteEmail || !inviteFirst || !inviteLast || invite.isPending}>
                {invite.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                Send invite
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setInviteOpen(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Members table */}
      <div className="border rounded-lg overflow-hidden bg-card">
        <table className="w-full">
          <thead><tr className="bg-muted/50 border-b">
            <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Name</th>
            <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Email</th>
            <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4 w-36">Role</th>
            <th className="py-2 px-4 w-20" />
          </tr></thead>
          <tbody>
            {isLoading
              ? Array.from({ length: 2 }).map((_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td colSpan={4} className="py-3 px-4">
                      <div className="h-4 bg-muted animate-pulse rounded w-48" />
                    </td>
                  </tr>
                ))
              : members.map(m => (
                  <tr key={m.id} className="border-b last:border-0 group">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold shrink-0">
                          {m.firstName[0]}{m.lastName[0]}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">{m.firstName} {m.lastName}</p>
                          {(user as any)?.id === m.id && <p className="text-[11px] text-muted-foreground">You</p>}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-sm text-muted-foreground">{m.email}</span>
                    </td>
                    <td className="py-3 px-4">
                      <Select
                        value={m.role}
                        onValueChange={v => changeRole.mutate({ id: m.id, role: v })}
                        disabled={(user as any)?.id === m.id}
                      >
                        <SelectTrigger className="h-7 text-xs w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map(r => <SelectItem key={r} value={r} className="text-xs capitalize">{r}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="py-3 px-4">
                      {(user as any)?.id !== m.id && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem onClick={() => { setEditFirst(m.firstName); setEditLast(m.lastName); setEditEmail(m.email); setEditMember(m); }}>
                              <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
                            </DropdownMenuItem>
                            {isSuperAdmin && (
                              <DropdownMenuItem onClick={() => { setPwValue(""); setShowPw(false); setPwUserId(m.id); }}>
                                <KeyRound className="w-3.5 h-3.5 mr-2" /> Change password
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteId(m.id)}>
                              <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={o => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete team member?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove them from the workspace. They will no longer be able to log in. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId !== null && deleteUser.mutate(deleteId)}
            >
              {deleteUser.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit member dialog */}
      <Dialog open={editMember !== null} onOpenChange={o => { if (!o) setEditMember(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit team member</DialogTitle>
            <DialogDescription>Update the member's name, email, or role.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">First name</Label>
                <Input value={editFirst} onChange={e => setEditFirst(e.target.value)} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Last name</Label>
                <Input value={editLast} onChange={e => setEditLast(e.target.value)} className="h-8 text-sm" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Email</Label>
              <Input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} className="h-8 text-sm" />
            </div>
            {editMember && (
              <div className="space-y-1">
                <Label className="text-xs">Role</Label>
                <Select value={editMember.role} onValueChange={v => setEditMember({ ...editMember, role: v })}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map(r => <SelectItem key={r} value={r} className="text-xs capitalize">{r}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditMember(null)}>Cancel</Button>
            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!editFirst.trim() || !editLast.trim() || !editEmail.trim() || editProfile.isPending}
              onClick={() => {
                if (!editMember) return;
                // Update role if changed
                if (editMember.role !== members.find(m => m.id === editMember.id)?.role) {
                  changeRole.mutate({ id: editMember.id, role: editMember.role });
                }
                editProfile.mutate({ id: editMember.id, firstName: editFirst, lastName: editLast, email: editEmail });
              }}
            >
              {editProfile.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change MY password dialog — visible to all users */}
      <Dialog open={selfPwOpen} onOpenChange={o => { if (!o) { setSelfPwOpen(false); setSelfCurrent(""); setSelfNew(""); setSelfShowCurrent(false); setSelfShowNew(false); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><KeyRound className="w-4 h-4 text-indigo-600" /> Change my password</DialogTitle>
            <DialogDescription>Enter your current password and choose a new one.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <Label className="text-xs">Current password</Label>
              <div className="relative">
                <Input
                  type={selfShowCurrent ? "text" : "password"}
                  value={selfCurrent}
                  onChange={e => setSelfCurrent(e.target.value)}
                  className="h-8 text-sm pr-9"
                  placeholder="Your current password"
                />
                <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setSelfShowCurrent(v => !v)}>
                  {selfShowCurrent ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">New password <span className="text-muted-foreground font-normal">(min 8 chars)</span></Label>
              <div className="relative">
                <Input
                  type={selfShowNew ? "text" : "password"}
                  value={selfNew}
                  onChange={e => setSelfNew(e.target.value)}
                  className="h-8 text-sm pr-9"
                  placeholder="New password"
                />
                <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setSelfShowNew(v => !v)}>
                  {selfShowNew ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setSelfPwOpen(false); setSelfCurrent(""); setSelfNew(""); }}>Cancel</Button>
            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!selfCurrent || selfNew.length < 8 || changeSelfPassword.isPending}
              onClick={() => changeSelfPassword.mutate()}
            >
              {changeSelfPassword.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
              Update password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change password dialog — super-admin only */}
      <Dialog open={pwUserId !== null} onOpenChange={o => { if (!o) { setPwUserId(null); setPwValue(""); setShowPw(false); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><KeyRound className="w-4 h-4 text-indigo-600" /> Change password</DialogTitle>
            <DialogDescription>
              Set a new password for <strong>{members.find(m => m.id === pwUserId)?.email ?? ""}</strong>.
              They will need to use this password on their next login.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <Label className="text-xs">New password <span className="text-muted-foreground font-normal">(min 8 chars)</span></Label>
              <div className="relative">
                <Input
                  type={showPw ? "text" : "password"}
                  value={pwValue}
                  onChange={e => setPwValue(e.target.value)}
                  className="h-8 text-sm pr-9"
                  placeholder="Enter new password"
                />
                <button
                  type="button"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPw(v => !v)}
                >
                  {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setPwUserId(null); setPwValue(""); setShowPw(false); }}>Cancel</Button>
            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={pwValue.length < 8 || changePassword.isPending}
              onClick={() => pwUserId !== null && changePassword.mutate({ id: pwUserId, password: pwValue })}
            >
              {changePassword.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
              Update password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── StageRow ─────────────────────────────────────────────────────────────────
function StageRow({ stage, onSaved }: { stage: StageConfig; onSaved: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(stage.label);
  const [color, setColor] = useState(stage.color);
  const [minScore, setMinScore] = useState(String(stage.minScore));
  const [description, setDescription] = useState(stage.description ?? "");

  const patch = useMutation({
    mutationFn: () =>
      json(`/stages/${stage.id}`, "PATCH", {
        label,
        color,
        minScore: parseInt(minScore) || 0,
        description: description || undefined,
      }).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => { onSaved(); setEditing(false); toast({ title: "Stage saved" }); },
    onError: () => toast({ title: "Failed to save stage", variant: "destructive" }),
  });

  const cancel = () => {
    setLabel(stage.label);
    setColor(stage.color);
    setMinScore(String(stage.minScore));
    setDescription(stage.description ?? "");
    setEditing(false);
  };

  if (editing) {
    return (
      <tr className="border-b last:border-0 bg-muted/30 align-top">
        <td className="py-3 px-4 w-40">
          <div className="flex items-center gap-2">
            <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", COLOR_DOTS[color] ?? "bg-gray-400")} />
            <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{stage.slug}</span>
          </div>
        </td>
        <td className="py-3 px-4">
          <Input value={label} onChange={e => setLabel(e.target.value)} className="h-7 text-sm w-36" placeholder="Display name" />
        </td>
        <td className="py-3 px-4">
          <Input type="number" value={minScore} onChange={e => setMinScore(e.target.value)} className="h-7 text-sm w-20" min={0} max={500} />
        </td>
        <td className="py-3 px-4">
          <Input value={description} onChange={e => setDescription(e.target.value)} className="h-7 text-sm w-52" placeholder="Short description…" />
        </td>
        <td className="py-3 px-4">
          <div className="flex items-center gap-1 flex-wrap w-44">
            {PRESET_COLORS.map(c => (
              <button key={c} onClick={() => setColor(c)}
                className={cn("w-4 h-4 rounded-full shrink-0", COLOR_DOTS[c], color === c && "ring-2 ring-offset-1 ring-foreground")} />
            ))}
          </div>
        </td>
        <td className="py-3 px-4">
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => patch.mutate()} disabled={patch.isPending}>
              <Check className="w-3.5 h-3.5 text-green-600" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={cancel}>
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b last:border-0 group align-middle">
      <td className="py-3 px-4 w-40">
        <div className="flex items-center gap-2">
          <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", COLOR_DOTS[stage.color] ?? "bg-gray-400")} />
          <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{stage.slug}</span>
        </div>
      </td>
      <td className="py-3 px-4">
        <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border", COLOR_BADGE[stage.color] ?? "bg-gray-100 text-gray-700 border-gray-200")}>
          {stage.label}
        </span>
      </td>
      <td className="py-3 px-4">
        <span className="text-sm text-muted-foreground">≥ {stage.minScore} pts</span>
      </td>
      <td className="py-3 px-4 max-w-xs">
        <span className="text-xs text-muted-foreground line-clamp-1">{stage.description ?? "—"}</span>
      </td>
      <td className="py-3 px-4" />
      <td className="py-3 px-4">
        <Button size="icon" variant="ghost" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => setEditing(true)}>
          <Pencil className="w-3.5 h-3.5" />
        </Button>
      </td>
    </tr>
  );
}

// ── StagesTab ─────────────────────────────────────────────────────────────────
function StagesTab() {
  const qc = useQueryClient();
  const { data: stages = [], isLoading } = useQuery<StageConfig[]>({
    queryKey: ["stages"],
    queryFn: () => api("/stages").then(r => r.json()),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Stage Configuration</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Customize how each stage appears across the platform — display name, color, and the minimum score required to enter it.
          Stage keys are fixed and cannot be changed.
        </p>
      </div>

      {/* Stage funnel preview */}
      {stages.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {stages.map((s, i) => (
            <div key={s.id} className="flex items-center gap-1">
              <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border", COLOR_BADGE[s.color] ?? "bg-gray-100 text-gray-700 border-gray-200")}>
                <span className={cn("w-1.5 h-1.5 rounded-full", COLOR_DOTS[s.color] ?? "bg-gray-400")} />
                {s.label}
              </span>
              {i < stages.length - 1 && <span className="text-muted-foreground/40 text-xs">→</span>}
            </div>
          ))}
        </div>
      )}

      <div className="border rounded-lg overflow-hidden bg-card">
        <table className="w-full">
          <thead>
            <tr className="bg-muted/50 border-b">
              <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4 w-40">Stage key</th>
              <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Display name</th>
              <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4 w-28">Min score</th>
              <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Description</th>
              <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4 w-48">Color</th>
              <th className="py-2 px-4 w-16" />
            </tr>
          </thead>
          <tbody>
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <td key={j} className="py-3 px-4"><div className="h-4 bg-muted animate-pulse rounded w-24" /></td>
                    ))}
                    <td className="py-3 px-4" />
                  </tr>
                ))
              : stages.map(s => (
                  <StageRow key={s.id} stage={s} onSaved={() => qc.invalidateQueries({ queryKey: ["stages"] })} />
                ))
            }
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-dashed p-4 bg-muted/20">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Note:</span> Stage keys (e.g. <code className="font-mono bg-muted px-1 py-0.5 rounded text-[11px]">pre-aware</code>, <code className="font-mono bg-muted px-1 py-0.5 rounded text-[11px]">engage</code>) are stored on contacts and activity events. Only the label, color, and minimum score are customizable.
        </p>
      </div>
    </div>
  );
}

type CsvRow = { email: string; clickedAt?: string | null };

type CsvPreview = {
  rows: CsvRow[];
  matched: number;
  skipped_already_aware: number;
  unmatched: number;
  unmatched_emails: string[];
  total_rows: number;
};

type CsvResult = {
  updated: number;
  skipped: number;
  unmatched: number;
  event_skipped_duplicate: number;
};

function extractResendRow(r: Record<string, unknown>): CsvRow | null {
  const keys = Object.keys(r);
  const emailKey = keys.find(k => /^(email|to|recipient|address)$/i.test(k));
  const eventKey  = keys.find(k => /^(last_event|event|status)$/i.test(k));
  const timeKey   = keys.find(k => /^(clicked.?at|click.?date|click_time|created_at|sent_at|timestamp|date)$/i.test(k));

  const email = String(emailKey ? r[emailKey] : "").trim();
  if (!email.includes("@")) return null;

  const event = eventKey ? String(r[eventKey]).trim().toLowerCase() : "";
  if (eventKey && event && event !== "clicked") return null;

  const clickedAt = timeKey ? String(r[timeKey]).trim() || undefined : undefined;
  return { email, clickedAt };
}

async function parseResendFile(file: File): Promise<CsvRow[]> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "xlsx" || ext === "xls") {
    const { read, utils } = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = read(buf);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw: Record<string, unknown>[] = utils.sheet_to_json(ws, { defval: "" });
    return raw.map(extractResendRow).filter((r): r is CsvRow => r !== null);
  }
  const { default: Papa } = await import("papaparse");
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        resolve(res.data.map(extractResendRow).filter((r): r is CsvRow => r !== null));
      },
      error: reject,
    });
  });
}

// ── RecentRunWarning ─────────────────────────────────────────────────────────
function RecentRunWarning({ className }: { className?: string }) {
  const { data: runs = [] } = useQuery<BackfillRun[]>({
    queryKey: ["backfill-runs"],
    queryFn: () => api("/admin/backfill-runs").then(r => r.json()),
    staleTime: 30_000,
  });

  if (runs.length === 0) return null;

  const minutesAgo = Math.floor((Date.now() - new Date(runs[0].created_at).getTime()) / 60_000);
  if (minutesAgo >= 60) return null;

  const timeLabel =
    minutesAgo < 1
      ? "less than a minute ago"
      : `${minutesAgo} minute${minutesAgo !== 1 ? "s" : ""} ago`;

  return (
    <div className={cn("flex items-center gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5", className)}>
      <AlertCircle className="w-3 h-3 shrink-0 text-amber-500" />
      <span>Last run <strong>{timeLabel}</strong> — re-running may create duplicate activity events.</span>
    </div>
  );
}

// ── BackfillAuditLog ─────────────────────────────────────────────────────────

type BackfillRun = {
  id: number;
  triggered_by: number | null;
  triggered_by_email: string | null;
  source: string;
  total_rows: number;
  updated: number;
  skipped: number;
  unmatched: number;
  extra: Record<string, unknown>;
  created_at: string;
};

type BackfillRunContact = {
  id: number;
  action: string;
  email: string;
  name: string;
};

function sourceLabel(source: string) {
  if (source === "csv") return "CSV (rows)";
  if (source === "csv_upload") return "CSV upload";
  if (source === "api") return "API sync";
  return source;
}

function readBackfillParams(): { from: string; to: string; source: string } {
  const sp = new URLSearchParams(window.location.search);
  return {
    from: sp.get("bf_from") ?? "",
    to: sp.get("bf_to") ?? "",
    source: sp.get("bf_source") ?? "all",
  };
}

function writeBackfillParams(from: string, to: string, source: string) {
  const sp = new URLSearchParams(window.location.search);
  if (from) sp.set("bf_from", from); else sp.delete("bf_from");
  if (to) sp.set("bf_to", to); else sp.delete("bf_to");
  if (source && source !== "all") sp.set("bf_source", source); else sp.delete("bf_source");
  const newSearch = sp.toString();
  const newUrl = newSearch
    ? `${window.location.pathname}?${newSearch}`
    : window.location.pathname;
  window.history.replaceState(null, "", newUrl);
}

function actionBadge(action: string) {
  if (action === "updated") return (
    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-700">updated</span>
  );
  if (action === "skipped") return (
    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700">skipped</span>
  );
  return (
    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-600">{action}</span>
  );
}

function BackfillRunDrillDown({ run, onClose }: { run: BackfillRun; onClose: () => void }) {
  const { data: contacts = [], isLoading } = useQuery<BackfillRunContact[]>({
    queryKey: ["backfill-run-contacts", run.id],
    queryFn: () => api(`/admin/backfill-runs/${run.id}/contacts`).then(r => r.json()),
    staleTime: 60_000,
  });

  const hasContacts = !isLoading && contacts.length > 0;

  return (
    <Sheet open onOpenChange={open => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col gap-0 p-0">
        <SheetHeader className="px-5 pt-5 pb-3 border-b">
          <SheetTitle className="text-sm font-semibold">
            Run details — {new Date(run.created_at).toLocaleString(undefined, {
              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            })}
          </SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground">
            {sourceLabel(run.source)} · {run.updated} updated · {run.skipped} skipped · {run.unmatched} unmatched
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading contacts…
            </div>
          ) : !hasContacts ? (
            <div className="text-xs text-muted-foreground py-8 text-center">
              No contact-level detail stored for this run.
              <p className="mt-1 text-[11px]">Runs made after this feature was enabled will show a full contact list.</p>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground mb-2">
                Showing {contacts.length} contact{contacts.length !== 1 ? "s" : ""}{contacts.length === 500 ? " (capped at 500)" : ""}.
              </p>
              <div className="rounded-md border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/50 border-b">
                      <th className="text-left text-muted-foreground font-medium py-1.5 px-2.5">Contact</th>
                      <th className="text-left text-muted-foreground font-medium py-1.5 px-2.5">Email</th>
                      <th className="text-left text-muted-foreground font-medium py-1.5 px-2.5 w-20">Action</th>
                      <th className="py-1.5 px-2 w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((c, i) => (
                      <tr key={i} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="py-1.5 px-2.5 font-medium max-w-[130px] truncate">
                          {c.name || "—"}
                        </td>
                        <td className="py-1.5 px-2.5 text-muted-foreground max-w-[150px] truncate">
                          {c.email || "—"}
                        </td>
                        <td className="py-1.5 px-2.5">
                          {actionBadge(c.action)}
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          {c.id > 0 && (
                            <a
                              href={`/crm/contacts/${c.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-indigo-600 transition-colors"
                              title="Open in CRM"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function BackfillAuditLog() {
  const initial = readBackfillParams();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [source, setSource] = useState(initial.source);
  const [selectedRun, setSelectedRun] = useState<BackfillRun | null>(null);

  useEffect(() => {
    writeBackfillParams(from, to, source);
  }, [from, to, source]);

  const queryParams = new URLSearchParams();
  if (from) queryParams.set("from", from);
  if (to) queryParams.set("to", to);
  if (source && source !== "all") queryParams.set("source", source);
  const qs = queryParams.toString();

  const { data: runs = [], isLoading } = useQuery<BackfillRun[]>({
    queryKey: ["backfill-runs", from, to, source],
    queryFn: () => api(`/admin/backfill-runs${qs ? `?${qs}` : ""}`).then(r => r.json()),
    staleTime: 30_000,
  });

  const hasFilters = !!from || !!to || (source !== "all");

  const clearFilters = () => { setFrom(""); setTo(""); setSource("all"); };

  return (
    <>
      {selectedRun && (
        <BackfillRunDrillDown run={selectedRun} onClose={() => setSelectedRun(null)} />
      )}
      <div className="border-t pt-4 mt-3 space-y-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <History className="w-3.5 h-3.5 text-muted-foreground" />
          <p className="text-xs font-medium text-foreground">Past backfill runs</p>
          {!isLoading && runs.length > 0 && (
            <span className="text-[11px] text-muted-foreground">({runs.length})</span>
          )}
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-muted-foreground whitespace-nowrap">From</label>
            <input
              type="date"
              value={from}
              onChange={e => setFrom(e.target.value)}
              className="h-7 rounded-md border border-input bg-background px-2 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-muted-foreground whitespace-nowrap">To</label>
            <input
              type="date"
              value={to}
              onChange={e => setTo(e.target.value)}
              className="h-7 rounded-md border border-input bg-background px-2 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger className="h-7 text-[11px] w-36">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="csv">CSV (rows)</SelectItem>
              <SelectItem value="csv_upload">CSV upload</SelectItem>
              <SelectItem value="api">API sync</SelectItem>
            </SelectContent>
          </Select>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading run history…
          </div>
        ) : runs.length === 0 ? (
          <p className="text-[11px] text-muted-foreground pl-1">
            {hasFilters ? "No runs match the current filters." : "No runs recorded yet."}
          </p>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="text-left text-muted-foreground font-medium py-1.5 px-2.5">When</th>
                  <th className="text-left text-muted-foreground font-medium py-1.5 px-2.5">Source</th>
                  <th className="text-left text-muted-foreground font-medium py-1.5 px-2.5">Triggered by</th>
                  <th className="text-right text-muted-foreground font-medium py-1.5 px-2.5">Rows</th>
                  <th className="text-right text-muted-foreground font-medium py-1.5 px-2.5">Updated</th>
                  <th className="text-right text-muted-foreground font-medium py-1.5 px-2.5">Skipped</th>
                  <th className="text-right text-muted-foreground font-medium py-1.5 px-2.5">Unmatched</th>
                  <th className="py-1.5 px-2 w-16" />
                </tr>
              </thead>
              <tbody>
                {runs.map(run => (
                  <tr
                    key={run.id}
                    className="border-b last:border-0 hover:bg-muted/20 cursor-pointer group"
                    onClick={() => setSelectedRun(run)}
                  >
                    <td className="py-1.5 px-2.5 text-muted-foreground whitespace-nowrap">
                      {new Date(run.created_at).toLocaleString(undefined, {
                        month: "short", day: "numeric",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="py-1.5 px-2.5">
                      <span className="font-mono bg-muted rounded px-1 py-0.5">{sourceLabel(run.source)}</span>
                    </td>
                    <td className="py-1.5 px-2.5 text-muted-foreground max-w-[120px] truncate">
                      {run.triggered_by_email ?? "—"}
                    </td>
                    <td className="py-1.5 px-2.5 text-right tabular-nums">{run.total_rows}</td>
                    <td className="py-1.5 px-2.5 text-right tabular-nums text-emerald-700 font-medium">{run.updated}</td>
                    <td className="py-1.5 px-2.5 text-right tabular-nums text-amber-600">{run.skipped}</td>
                    <td className="py-1.5 px-2.5 text-right tabular-nums text-muted-foreground">{run.unmatched}</td>
                    <td className="py-1.5 px-2 text-right">
                      <ChevronRight className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity inline" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function ResendCsvUploadPanel({ isAdmin, onRunComplete }: { isAdmin: boolean; onRunComplete?: () => void }) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<"idle" | "parsing" | "preview" | "applying" | "done">("idle");
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [result, setResult] = useState<CsvResult | null>(null);
  const [rows, setRows] = useState<CsvRow[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setPhase("parsing");
    setFileName(file.name);
    setPreview(null);
    setResult(null);
    try {
      const parsed = await parseResendFile(file);
      if (parsed.length === 0) {
        toast({ title: "No valid email rows found in file", variant: "destructive" });
        setPhase("idle");
        return;
      }
      setRows(parsed);
      const r = await fetch("/api/admin/resend-backfill?dry_run=true", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsed }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Preview failed"); }
      const data = await r.json();
      setPreview({
        rows: parsed,
        matched: data.matched ?? 0,
        skipped_already_aware: data.skipped_already_aware ?? 0,
        unmatched: data.unmatched ?? 0,
        unmatched_emails: data.unmatched_emails ?? [],
        total_rows: data.total_rows ?? parsed.length,
      });
      setPhase("preview");
    } catch (err: any) {
      toast({ title: err.message ?? "Failed to parse file", variant: "destructive" });
      setPhase("idle");
    }
  }, [toast]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const applyBackfill = async () => {
    if (!rows.length) return;
    setPhase("applying");
    try {
      const r = await fetch("/api/admin/resend-backfill", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Backfill failed"); }
      const data = await r.json();
      setResult({
        updated: data.updated ?? 0,
        skipped: data.skipped ?? 0,
        unmatched: data.unmatched ?? 0,
        event_skipped_duplicate: data.event_skipped_duplicate ?? 0,
      });
      setPhase("done");
      toast({ title: `Backfill complete — ${data.updated} contacts advanced to aware` });
      onRunComplete?.();
    } catch (err: any) {
      toast({ title: err.message ?? "Backfill failed", variant: "destructive" });
      setPhase("preview");
    }
  };

  const reset = () => {
    setPhase("idle");
    setPreview(null);
    setResult(null);
    setRows([]);
    setFileName("");
  };

  return (
    <div className="border-t pt-4 mt-3 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-foreground">Upload Resend Export</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Upload a CSV or XLSX export from Resend to retroactively advance clicked contacts to <span className="font-mono">aware</span> stage
          </p>
        </div>
        {(phase === "preview" || phase === "done") && (
          <Button size="sm" variant="ghost" className="h-6 text-[11px] text-muted-foreground" onClick={reset}>
            Reset
          </Button>
        )}
      </div>

      <RecentRunWarning />

      {phase === "idle" && (
        <div
          className={cn(
            "border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors",
            dragOver ? "border-indigo-400 bg-indigo-50" : "border-muted-foreground/20 hover:border-indigo-300 hover:bg-muted/30"
          )}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <FileSpreadsheet className="w-7 h-7 mx-auto mb-1.5 text-muted-foreground/60" />
          <p className="text-xs font-medium text-muted-foreground">Drop CSV or XLSX here, or click to browse</p>
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">Columns: <span className="font-mono">To / Email</span> (required), <span className="font-mono">Clicked At</span> (optional)</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
        </div>
      )}

      {phase === "parsing" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Parsing {fileName}…
        </div>
      )}

      {phase === "preview" && preview && (
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/30 px-3 py-2.5 space-y-2">
            <p className="text-xs font-medium text-foreground">Preview — {preview.total_rows} unique email{preview.total_rows !== 1 ? "s" : ""} in file</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded bg-emerald-50 border border-emerald-200 px-2 py-1.5">
                <p className="text-base font-bold text-emerald-700">{preview.matched}</p>
                <p className="text-[10px] text-emerald-600 font-medium">Will be updated</p>
                <p className="text-[10px] text-emerald-600/70">pre-aware → aware</p>
              </div>
              <div className="rounded bg-amber-50 border border-amber-200 px-2 py-1.5">
                <p className="text-base font-bold text-amber-700">{preview.skipped_already_aware}</p>
                <p className="text-[10px] text-amber-600 font-medium">Already aware+</p>
                <p className="text-[10px] text-amber-600/70">will be skipped</p>
              </div>
              <div className="rounded bg-slate-50 border border-slate-200 px-2 py-1.5">
                <p className="text-base font-bold text-slate-600">{preview.unmatched}</p>
                <p className="text-[10px] text-slate-500 font-medium">No match</p>
                <p className="text-[10px] text-slate-400/70">not in KABOOM</p>
              </div>
            </div>
            {preview.unmatched_emails.length > 0 && (
              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer hover:text-foreground">Show unmatched emails ({preview.unmatched})</summary>
                <div className="mt-1 font-mono text-[10px] leading-4 max-h-24 overflow-y-auto">
                  {preview.unmatched_emails.join(", ")}
                  {preview.unmatched > preview.unmatched_emails.length && ` … and ${preview.unmatched - preview.unmatched_emails.length} more`}
                </div>
              </details>
            )}
          </div>
          {preview.matched > 0 ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700"
                onClick={applyBackfill}
              >
                <Upload className="w-3 h-3 mr-1.5" />
                Apply Backfill ({preview.matched} contact{preview.matched !== 1 ? "s" : ""})
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={reset}>Cancel</Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlertCircle className="w-3.5 h-3.5" />
              No contacts to update — all are already at aware stage or not found in KABOOM.
              <Button size="sm" variant="ghost" className="h-6 text-xs ml-1" onClick={reset}>Reset</Button>
            </div>
          )}
        </div>
      )}

      {phase === "applying" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Applying backfill…
        </div>
      )}

      {phase === "done" && result && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2.5 space-y-1">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            <p className="text-xs font-medium text-emerald-800">
              Backfill complete — {result.updated} contact{result.updated !== 1 ? "s" : ""} advanced to <span className="font-mono">aware</span>
            </p>
          </div>
          <p className="text-[11px] text-emerald-700">
            {result.skipped} skipped · {result.unmatched} unmatched
            {result.event_skipped_duplicate > 0 && ` · ${result.event_skipped_duplicate} click event${result.event_skipped_duplicate !== 1 ? "s" : ""} deduped (same-day)`}
          </p>
        </div>
      )}
    </div>
  );
}

// ── ResendPanel ───────────────────────────────────────────────────────────────
function ResendPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuthContext();
  const isAdmin = (user as any)?.role === "admin";
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [readOnlyCheck, setReadOnlyCheck] = useState<{ detail: string } | null>(null);
  const checkConnection = useMutation({
    mutationFn: () => api("/integrations/resend/readiness").then(async r => {
      if (!r.ok) throw new Error("Could not check the connection");
      return r.json();
    }),
    onSuccess: setReadOnlyCheck,
    onError: () => setReadOnlyCheck({ detail: "The connection could not be checked. No email was sent." }),
  });
  const [backfillResult, setBackfillResult] = useState<{
    opens: number; clicks: number; bounces: number; contacts: number; journeyVisits: number;
  } | null>(null);

  const { data, isLoading } = useQuery<{
    provider: string; configured: boolean; maskedKey: string | null;
    transport?: string;
    fromEmail: string | null; fromName: string | null;
  }>({
    queryKey: ["integration", "resend"],
    queryFn: () => api("/integrations/resend").then(r => r.json()),
  });

  const save = useMutation({
    mutationFn: () =>
      json("/integrations/resend", "PUT", {
        ...(apiKey ? { apiKey } : {}),
        fromEmail: fromEmail || undefined,
        fromName: fromName || undefined,
      }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Save failed"); }
        return r.json();
      }),
    onSuccess: (d) => {
      qc.setQueryData(["integration", "resend"], d);
      setApiKey("");
      setRotating(false);
      setShowKey(false);
      toast({ title: "Resend settings saved" });
    },
    onError: (e: any) => toast({ title: e.message ?? "Failed to save", variant: "destructive" }),
  });

  const test = useMutation({
    mutationFn: () =>
      json("/integrations/resend/test", "POST", {
        ...(apiKey ? { apiKey } : {}),
        fromEmail: fromEmail || undefined,
        fromName: fromName || undefined,
      }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Test failed"); }
        return r.json();
      }),
    onSuccess: (d) => toast({ title: `Test email sent to ${d.sentTo}` }),
    onError: (e: any) => toast({ title: e.message ?? "Test failed", variant: "destructive" }),
  });

  const syncBackfill = useMutation({
    mutationFn: () =>
      json("/admin/resend-backfill?days=30&limit=1000", "POST", {}).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Sync failed"); }
        return r.json();
      }),
    onSuccess: (d) => {
      setBackfillResult({
        opens: d.processed?.opens ?? 0,
        clicks: d.processed?.clicks ?? 0,
        bounces: d.processed?.bounces ?? 0,
        contacts: d.contacts_updated ?? 0,
        journeyVisits: d.processed?.journey_visits_linked ?? 0,
      });
      qc.invalidateQueries({ queryKey: ["backfill-runs"] });
      toast({ title: `Synced from Resend — ${d.contacts_updated} contacts updated` });
    },
    onError: (e: any) => toast({ title: e.message ?? "Sync failed", variant: "destructive" }),
  });

  const configured = data?.configured ?? false;
  const canSave = !!(apiKey || (data?.configured && (fromEmail || fromName)));

  const handleExpand = () => {
    if (!expanded && data) {
      setFromEmail(data.fromEmail ?? "");
      setFromName(data.fromName ?? "");
    }
    setExpanded(v => !v);
  };

  return (
    <Card className="shadow-xs">
      <CardContent className="px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="text-2xl shrink-0">📧</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-foreground">Resend</p>
                {isLoading
                  ? <div className="h-4 w-14 bg-muted animate-pulse rounded" />
                  : configured
                    ? <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-700 bg-emerald-50 h-4 px-1.5">Active</Badge>
                    : <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">Not configured</Badge>}
              </div>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-indigo-600 hover:text-indigo-700" onClick={handleExpand}>
                {expanded ? "Collapse" : "Configure"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Transactional email for sequences and form confirmations</p>

            {expanded && (
              <div className="mt-4 space-y-3 border-t pt-4">
                {/* Masked key display */}
                {configured && !rotating && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">API Key</label>
                    <div className="flex items-center gap-2">
                      <Input value={data?.maskedKey ?? ""} readOnly className="h-8 text-sm font-mono bg-muted/40" />
                      <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => setRotating(true)}>
                        Rotate
                      </Button>
                    </div>
                  </div>
                )}

                {/* Key input (new or rotating) */}
                {(!configured || rotating) && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">
                      API Key {rotating && <span className="text-indigo-600">(enter new key)</span>}
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        type={showKey ? "text" : "password"}
                        value={apiKey}
                        onChange={e => setApiKey(e.target.value)}
                        placeholder="re_••••••••••••••••"
                        className="h-8 text-sm font-mono"
                      />
                      <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => setShowKey(v => !v)}>
                        {showKey ? "Hide" : "Show"}
                      </Button>
                      {rotating && (
                        <Button size="sm" variant="ghost" className="h-8 text-xs shrink-0" onClick={() => { setRotating(false); setApiKey(""); }}>
                          Cancel
                        </Button>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">Get your API key from <a href="https://resend.com/api-keys" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">resend.com/api-keys</a></p>
                  </div>
                )}

                {/* From fields */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">From Email</label>
                    <Input
                      type="email"
                      value={fromEmail}
                      onChange={e => setFromEmail(e.target.value)}
                      placeholder="noreply@yourdomain.com"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">From Name</label>
                    <Input
                      value={fromName}
                      onChange={e => setFromName(e.target.value)}
                      placeholder="Your Company"
                      className="h-8 text-sm"
                    />
                  </div>
                </div>

                {/* Webhook URL — copy to Resend webhook settings */}
                {true && (
                  <div className="border-t pt-3 mt-1">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">
                      Webhook URL <span className="text-indigo-500">(add this in Resend → Webhooks)</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        readOnly
                        value={`${window.location.origin}/api/email/webhook`}
                        className="h-8 text-xs font-mono bg-muted/40"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs shrink-0"
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/api/email/webhook`);
                          toast({ title: "Copied!" });
                        }}
                      >
                        Copy
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Enable events: <span className="font-mono">email.opened · email.clicked · email.delivered · email.bounced</span>
                    </p>
                  </div>
                )}

                {/* Actions */}
                <RecentRunWarning />
                {data?.transport === "connector" && <p className="text-xs text-muted-foreground">Using the connected Replit Resend integration. No API key needs to be entered here.</p>}
                <div className="flex items-center gap-2 pt-1 flex-wrap">
                  <Button size="sm" variant="outline" className="h-8 text-xs" disabled={checkConnection.isPending}
                    onClick={() => checkConnection.mutate()}>Check connection — no email</Button>
                  <Button
                    size="sm"
                    className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700"
                    onClick={() => save.mutate()}
                    disabled={save.isPending || (!apiKey && !configured)}
                  >
                    {save.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => { if (window.confirm(`Send a real test email to ${user?.email ?? "your account email"}?`)) test.mutate(); }}
                    disabled={test.isPending || (!configured && !apiKey)}
                  >
                    {test.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                    Send test email
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                    onClick={() => { setBackfillResult(null); syncBackfill.mutate(); }}
                    disabled={syncBackfill.isPending || !configured}
                    title={!configured ? "Save your API key first" : "Pull last 30 days of email events from Resend"}
                  >
                    {syncBackfill.isPending
                      ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Syncing…</>
                      : "↓ Sync history from Resend"}
                  </Button>
                </div>
                {readOnlyCheck && <p role="status" className="text-xs text-muted-foreground">{readOnlyCheck.detail}</p>}

                {/* Backfill result */}
                {backfillResult && (
                  <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800 space-y-0.5">
                    <p className="font-medium">Sync complete — {backfillResult.contacts} contact{backfillResult.contacts !== 1 ? "s" : ""} updated</p>
                    <p className="text-emerald-700">
                      {backfillResult.opens} open{backfillResult.opens !== 1 ? "s" : ""} ·{" "}
                      {backfillResult.clicks} click{backfillResult.clicks !== 1 ? "s" : ""} ·{" "}
                      {backfillResult.bounces} bounce{backfillResult.bounces !== 1 ? "s" : ""} recorded
                      {backfillResult.journeyVisits > 0 && (
                        <> · {backfillResult.journeyVisits} journey visit{backfillResult.journeyVisits !== 1 ? "s" : ""} attributed</>
                      )}
                    </p>
                  </div>
                )}

                {isAdmin && <BackfillAuditLog />}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── UpstashPanel ──────────────────────────────────────────────────────────────
function UpstashPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [redisUrl, setRedisUrl] = useState("");
  const [token, setToken] = useState("");
  const [showUrl, setShowUrl] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [rotating, setRotating] = useState(false);

  const { data, isLoading } = useQuery<{
    provider: string; configured: boolean; maskedUrl: string | null; hasToken: boolean; requiresRestart?: boolean; source?: string;
  }>({
    queryKey: ["integration", "upstash"],
    queryFn: () => api("/integrations/upstash").then(r => r.json()),
  });

  const save = useMutation({
    mutationFn: () =>
      json("/integrations/upstash", "PUT", {
        ...(redisUrl ? { redisUrl } : {}),
        ...(token    ? { token }    : {}),
      }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Save failed"); }
        return r.json();
      }),
    onSuccess: (d) => {
      qc.setQueryData(["integration", "upstash"], d);
      setRedisUrl("");
      setToken("");
      setRotating(false);
      setShowUrl(false);
      setShowToken(false);
      toast({ title: "Upstash settings saved", description: "Restart the server to activate the new Redis connection." });
    },
    onError: (e: any) => toast({ title: e.message ?? "Failed to save", variant: "destructive" }),
  });

  const test = useMutation({
    mutationFn: () =>
      json("/integrations/upstash/test", "POST", {
        ...(redisUrl ? { redisUrl } : {}),
      }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Test failed"); }
        return r.json();
      }),
    onSuccess: () => toast({ title: "Redis connection successful" }),
    onError: (e: any) => toast({ title: e.message ?? "Connection failed", variant: "destructive" }),
  });

  const configured = data?.configured ?? false;

  return (
    <Card className="shadow-xs">
      <CardContent className="px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="text-2xl shrink-0">⚡</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-foreground">Upstash Redis</p>
                {isLoading
                  ? <div className="h-4 w-14 bg-muted animate-pulse rounded" />
                  : configured
                    ? <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-700 bg-emerald-50 h-4 px-1.5">Active</Badge>
                    : data?.source === "env"
                      ? <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 bg-amber-50 h-4 px-1.5">Active (env fallback)</Badge>
                      : <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">Not configured</Badge>}
              </div>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-indigo-600 hover:text-indigo-700" onClick={() => setExpanded(v => !v)}>
                {expanded ? "Collapse" : "Configure"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">BullMQ job queue for email automation and sequence scheduling</p>

            {expanded && (
              <div className="mt-4 space-y-3 border-t pt-4">
                {/* Masked URL display */}
                {configured && !rotating && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Redis URL</label>
                    <div className="flex items-center gap-2">
                      <Input value={data?.maskedUrl ?? ""} readOnly className="h-8 text-sm font-mono bg-muted/40" />
                      <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => setRotating(true)}>
                        Rotate
                      </Button>
                    </div>
                    {data?.hasToken && (
                      <p className="text-[11px] text-muted-foreground mt-1">REST API token: saved</p>
                    )}
                  </div>
                )}

                {/* URL + Token input (new or rotating) */}
                {(!configured || rotating) && (
                  <>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Redis URL {rotating && <span className="text-indigo-600">(enter new URL)</span>}
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type={showUrl ? "text" : "password"}
                          value={redisUrl}
                          onChange={e => setRedisUrl(e.target.value)}
                          placeholder="rediss://default:TOKEN@host.upstash.io:6379"
                          className="h-8 text-sm font-mono"
                        />
                        <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => setShowUrl(v => !v)}>
                          {showUrl ? "Hide" : "Show"}
                        </Button>
                        {rotating && (
                          <Button size="sm" variant="ghost" className="h-8 text-xs shrink-0" onClick={() => { setRotating(false); setRedisUrl(""); setToken(""); }}>
                            Cancel
                          </Button>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Find your Redis URL in <a href="https://console.upstash.com" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">console.upstash.com</a> → Database → Connect → Node.js. Use the <span className="font-mono">rediss://</span> (TLS) format.
                      </p>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        REST API Token <span className="text-muted-foreground font-normal">(optional)</span>
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type={showToken ? "text" : "password"}
                          value={token}
                          onChange={e => setToken(e.target.value)}
                          placeholder="AXXXASQg..."
                          className="h-8 text-sm font-mono"
                        />
                        <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => setShowToken(v => !v)}>
                          {showToken ? "Hide" : "Show"}
                        </Button>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1">Used for REST API access (separate from the Redis connection token above).</p>
                    </div>
                  </>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700"
                    onClick={() => save.mutate()}
                    disabled={save.isPending || (!redisUrl && !configured)}
                  >
                    {save.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => test.mutate()}
                    disabled={test.isPending || (!configured && !redisUrl)}
                  >
                    {test.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                    Test connection
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── SmtpAccountsPanel ─────────────────────────────────────────────────────────

interface SmtpAccount {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  maskedUsername: string;
  useTls: boolean;
  fromEmail: string;
  fromName: string;
  dailyLimit: number | null;
  todaySent: number;
  createdAt: string;
  usedIn: number;
}

interface SmtpFormState {
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  useTls: boolean;
  fromEmail: string;
  fromName: string;
  dailyLimit: string;
}

const EMPTY_SMTP_FORM: SmtpFormState = {
  name: "", host: "", port: "587", username: "", password: "",
  useTls: true, fromEmail: "", fromName: "", dailyLimit: "",
};

function SmtpAccountsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<SmtpFormState>(EMPTY_SMTP_FORM);
  const [testEmail, setTestEmail] = useState("");
  const [testingId, setTestingId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: accounts = [], isLoading } = useQuery<SmtpAccount[]>({
    queryKey: ["smtp-accounts"],
    queryFn: () => api("/smtp-accounts").then(r => r.json()),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name, host: form.host, port: parseInt(form.port),
        username: form.username, password: form.password || undefined,
        useTls: form.useTls, fromEmail: form.fromEmail, fromName: form.fromName,
        dailyLimit: form.dailyLimit !== "" ? parseInt(form.dailyLimit) : null,
      };
      const r = editingId
        ? await json(`/smtp-accounts/${editingId}`, "PATCH", body)
        : await json("/smtp-accounts", "POST", body);
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Save failed"); }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["smtp-accounts"] });
      toast({ title: editingId ? "Account updated" : "Account added" });
      setDialogOpen(false);
      setEditingId(null);
      setForm(EMPTY_SMTP_FORM);
    },
    onError: (e: any) => toast({ title: e.message ?? "Failed", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => json(`/smtp-accounts/${id}`, "DELETE", {}).then(async r => { if (!r.ok) throw new Error("Delete failed"); }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["smtp-accounts"] }); toast({ title: "Account deleted" }); setDeleteId(null); },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  async function testSend(id: number) {
    if (!testEmail) { toast({ title: "Enter a recipient email first", variant: "destructive" }); return; }
    setTestingId(id);
    try {
      const r = await json(`/smtp-accounts/${id}/test`, "POST", { toEmail: testEmail });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Test failed");
      toast({ title: "Test email sent successfully!" });
    } catch (e: any) {
      toast({ title: e.message ?? "Test failed", variant: "destructive" });
    } finally {
      setTestingId(null);
    }
  }

  function openEdit(a: SmtpAccount) {
    setEditingId(a.id);
    setForm({
      name: a.name, host: a.host, port: String(a.port),
      username: a.username, password: "",
      useTls: a.useTls, fromEmail: a.fromEmail, fromName: a.fromName,
      dailyLimit: a.dailyLimit != null ? String(a.dailyLimit) : "",
    });
    setDialogOpen(true);
  }

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY_SMTP_FORM);
    setDialogOpen(true);
  }

  const f = (k: keyof SmtpFormState, v: any) => setForm(prev => ({ ...prev, [k]: v }));

  return (
    <Card className="shadow-xs col-span-1 sm:col-span-2">
      <CardContent className="px-4 py-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl shrink-0">📬</span>
            <div>
              <p className="text-sm font-medium text-foreground">SMTP Sending Accounts</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Connect pre-warmed inboxes (Google Workspace, M365) to bypass enterprise email gateways.
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={openAdd}>
            <Plus className="w-3 h-3" /> Add Account
          </Button>
        </div>

        {isLoading ? (
          <div className="h-10 bg-muted animate-pulse rounded" />
        ) : accounts.length === 0 ? (
          <div className="border-2 border-dashed rounded-lg py-6 text-center text-xs text-muted-foreground">
            No SMTP accounts configured. Add one to send sequences from your own inbox.
          </div>
        ) : (
          <div className="space-y-2">
            {/* Test email row */}
            <div className="flex gap-2 mb-3">
              <Input
                value={testEmail}
                onChange={e => setTestEmail(e.target.value)}
                placeholder="you@company.com (for test sends)"
                className="h-7 text-xs flex-1"
              />
            </div>
            {accounts.map(a => (
              <div key={a.id} className="flex items-center gap-3 px-3 py-2.5 rounded-md border bg-card text-sm">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{a.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {a.host}:{a.port} · {a.maskedUsername}
                    {a.usedIn > 0 && (
                      <span className="ml-2 text-indigo-600">
                        {a.usedIn} sequence{a.usedIn !== 1 ? "s" : ""}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Today:{" "}
                    <span className={
                      a.dailyLimit !== null && a.todaySent >= a.dailyLimit
                        ? "text-amber-600 font-medium"
                        : "text-foreground"
                    }>
                      {a.todaySent}
                    </span>
                    {a.dailyLimit !== null
                      ? <span> / {a.dailyLimit} sent</span>
                      : <span> sent (no limit)</span>}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm" variant="ghost" className="h-6 text-[10px] px-2"
                    onClick={() => testSend(a.id)}
                    disabled={testingId === a.id}
                  >
                    {testingId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Test"}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => openEdit(a)}>
                    <Pencil className="w-3 h-3" />
                  </Button>
                  <Button
                    size="sm" variant="ghost" className="h-6 px-1.5 text-destructive hover:text-destructive"
                    onClick={() => setDeleteId(a.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Add/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit" : "Add"} SMTP Account</DialogTitle>
            <DialogDescription>
              Connect an SMTP inbox to send sequence emails from your own domain.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Account name</Label>
              <Input value={form.name} onChange={e => f("name", e.target.value)} placeholder="e.g. Google Workspace — sales@acme.com" className="h-8 text-sm" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-1.5">
                <Label className="text-xs">SMTP host</Label>
                <Input value={form.host} onChange={e => f("host", e.target.value)} placeholder="smtp.gmail.com" className="h-8 text-sm font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Port</Label>
                <Input value={form.port} onChange={e => f("port", e.target.value)} placeholder="587" type="number" className="h-8 text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Username / email</Label>
                <Input value={form.username} onChange={e => f("username", e.target.value)} placeholder="you@company.com" className="h-8 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{editingId ? "New password" : "Password / App password"}</Label>
                <Input type="password" value={form.password} onChange={e => f("password", e.target.value)} placeholder={editingId ? "Leave blank to keep" : "App password"} className="h-8 text-sm" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.useTls} onCheckedChange={v => f("useTls", v)} />
              <Label className="text-xs">Use TLS / STARTTLS</Label>
            </div>
            <div className="border-t pt-3 space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">From details</Label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">From email</Label>
                <Input value={form.fromEmail} onChange={e => f("fromEmail", e.target.value)} placeholder="you@company.com" type="email" className="h-8 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">From name</Label>
                <Input value={form.fromName} onChange={e => f("fromName", e.target.value)} placeholder="Your Name" className="h-8 text-sm" />
              </div>
            </div>
            <div className="border-t pt-3 space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Sending limits</Label>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Daily sending limit</Label>
              <Input
                value={form.dailyLimit}
                onChange={e => f("dailyLimit", e.target.value)}
                placeholder="e.g. 200 — leave blank for unlimited"
                type="number"
                min={1}
                className="h-8 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                Sequence worker skips sends once this account hits its daily cap. Resets at midnight UTC. Leave blank for unlimited.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button
              size="sm" className="bg-indigo-600 hover:bg-indigo-700"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !form.name || !form.host || !form.fromEmail || (!editingId && !form.password)}
            >
              {saveMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
              {editingId ? "Update" : "Add Account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete SMTP account?</AlertDialogTitle>
            <AlertDialogDescription>
              Any sequences using this account will fall back to Resend.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ── VapiPanel ─────────────────────────────────────────────────────────────────
function VapiPanel() {
  const { user } = useAuthContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [assistants, setAssistants] = useState<{ name: string; id: string }[]>([]);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [voiceProvider, setVoiceProvider] = useState<"vapi" | "11labs">("vapi");
  const [voiceId, setVoiceId] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [rotating, setRotating] = useState(false);

  const { data, isLoading } = useQuery<{
    provider: string; configured: boolean; maskedKey: string | null;
    assistants: { name: string; id: string }[];
    assistantId: string | null; phoneNumberId: string | null; voiceProvider: string | null; voiceId: string | null; hasWebhookSecret: boolean;
  }>({
    queryKey: ["integration", "vapi"],
    queryFn: () => api("/integrations/vapi").then(r => r.json()),
  });

  const save = useMutation({
    mutationFn: () =>
      json("/integrations/vapi", "PUT", {
        ...(apiKey ? { apiKey } : {}),
        assistants: assistants.filter(a => a.id.trim()),
        phoneNumberId: phoneNumberId || undefined,
        voiceProvider,
        voiceId: voiceId || undefined,
        ...(webhookSecret ? { webhookSecret } : {}),
      }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Save failed"); }
        return r.json();
      }),
    onSuccess: (d) => {
      qc.setQueryData(["integration", "vapi"], d);
      setApiKey("");
      setWebhookSecret("");
      setRotating(false);
      setShowKey(false);
      toast({ title: "Vapi settings saved" });
    },
    onError: (e: any) => toast({ title: e.message ?? "Failed to save", variant: "destructive" }),
  });

  const clearSecret = useMutation({
    mutationFn: () =>
      json("/integrations/vapi", "PUT", { clearWebhookSecret: true }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Clear failed"); }
        return r.json();
      }),
    onSuccess: (d) => {
      qc.setQueryData(["integration", "vapi"], d);
      toast({ title: "Webhook secret cleared" });
    },
    onError: (e: any) => toast({ title: e.message ?? "Failed to clear", variant: "destructive" }),
  });

  const configured = data?.configured ?? false;

  const handleExpand = () => {
    if (!expanded && data) {
      setAssistants(data.assistants ?? []);
      setPhoneNumberId(data.phoneNumberId ?? "");
      setVoiceProvider((data.voiceProvider as "vapi" | "11labs") ?? "vapi");
      setVoiceId(data.voiceId ?? "");
    }
    setExpanded(v => !v);
  };

  const addAssistant    = () => setAssistants(a => [...a, { name: "", id: "" }]);
  const removeAssistant = (i: number) => setAssistants(a => a.filter((_, idx) => idx !== i));
  const updateAssistant = (i: number, field: "name" | "id", val: string) =>
    setAssistants(a => a.map((x, idx) => idx === i ? { ...x, [field]: val } : x));

  const webhookUrl = `${window.location.origin}/api/public/vapi-webhook/${user?.tenantId ?? ""}`;

  return (
    <Card className="shadow-xs">
      <CardContent className="px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="text-2xl shrink-0">📞</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-foreground">Vapi.ai</p>
                {isLoading
                  ? <div className="h-4 w-14 bg-muted animate-pulse rounded" />
                  : configured
                    ? <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-700 bg-emerald-50 h-4 px-1.5">Active</Badge>
                    : <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">Not configured</Badge>}
              </div>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-indigo-600 hover:text-indigo-700" onClick={handleExpand}>
                {expanded ? "Collapse" : "Configure"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">AI-powered outbound calling for Call Campaigns</p>
            {expanded && (
              <div className="mt-4 space-y-3 border-t pt-4">
                {configured && !rotating && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">API Key</label>
                    <div className="flex items-center gap-2">
                      <Input value={data?.maskedKey ?? ""} readOnly className="h-8 text-sm font-mono bg-muted/40" />
                      <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => setRotating(true)}>Rotate</Button>
                    </div>
                  </div>
                )}
                {(!configured || rotating) && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">
                      API Key {rotating && <span className="text-indigo-600">(enter new key)</span>}
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        type={showKey ? "text" : "password"}
                        value={apiKey}
                        onChange={e => setApiKey(e.target.value)}
                        placeholder="vapi_••••••••••••"
                        className="h-8 text-sm font-mono"
                      />
                      <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => setShowKey(v => !v)}>
                        {showKey ? "Hide" : "Show"}
                      </Button>
                      {rotating && (
                        <Button size="sm" variant="ghost" className="h-8 text-xs shrink-0" onClick={() => { setRotating(false); setApiKey(""); }}>
                          Cancel
                        </Button>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Get your API key from <a href="https://dashboard.vapi.ai" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">dashboard.vapi.ai</a> → API Keys
                    </p>
                  </div>
                )}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-muted-foreground">
                      Assistants <span className="font-normal text-emerald-600">(recommended)</span>
                    </label>
                    <button
                      type="button"
                      onClick={addAssistant}
                      className="h-6 px-2 text-[11px] rounded border border-indigo-300 text-indigo-600 hover:bg-indigo-50 font-medium transition-colors"
                    >
                      + Add assistant
                    </button>
                  </div>
                  {assistants.length === 0 ? (
                    <div className="border border-dashed rounded-lg p-3 text-center">
                      <p className="text-[11px] text-muted-foreground">No assistants added yet.</p>
                      <button
                        type="button"
                        onClick={addAssistant}
                        className="mt-1 text-[11px] text-indigo-600 hover:underline font-medium"
                      >
                        + Add your first assistant
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {assistants.map((a, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input
                            value={a.name}
                            onChange={e => updateAssistant(i, "name", e.target.value)}
                            placeholder="Display name, e.g. SDR Bot"
                            className="h-8 text-sm flex-1"
                          />
                          <Input
                            value={a.id}
                            onChange={e => updateAssistant(i, "id", e.target.value)}
                            placeholder="asst_abc123…"
                            className="h-8 text-sm font-mono flex-[2]"
                          />
                          <button
                            type="button"
                            onClick={() => removeAssistant(i)}
                            className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-red-500 rounded hover:bg-red-50 transition-colors shrink-0"
                            title="Remove"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Each assistant's ID comes from your Vapi dashboard → Assistants. When a campaign has an assistant selected, the inline "Agent Script" fields are ignored.
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Phone Number ID</label>
                  <Input
                    value={phoneNumberId}
                    onChange={e => setPhoneNumberId(e.target.value)}
                    placeholder="e.g. phone_abc123"
                    className="h-8 text-sm font-mono"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Found in your Vapi dashboard under Phone Numbers
                  </p>
                </div>
                <div className="space-y-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Voice Provider</label>
                    <div className="flex gap-2">
                      {(["vapi", "11labs"] as const).map(p => (
                        <button
                          key={p}
                          onClick={() => setVoiceProvider(p)}
                          className={`h-8 px-3 text-xs rounded border font-medium transition-colors ${
                            voiceProvider === p
                              ? "bg-indigo-600 text-white border-indigo-600"
                              : "bg-card text-muted-foreground border-border hover:border-indigo-400"
                          }`}
                        >
                          {p === "vapi" ? "Vapi (built-in)" : "ElevenLabs"}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {voiceProvider === "vapi"
                        ? "Uses Vapi's built-in voices — no ElevenLabs account needed."
                        : "Uses ElevenLabs voices — requires an ElevenLabs voice ID."}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">
                      {voiceProvider === "vapi" ? "Vapi Voice ID" : "ElevenLabs Voice ID"}
                      <span className="font-normal text-muted-foreground/70"> (optional)</span>
                    </label>
                    <Input
                      value={voiceId}
                      onChange={e => setVoiceId(e.target.value)}
                      placeholder={voiceProvider === "vapi" ? "e.g. Abby, Andrew, Aria — leave blank for default" : "e.g. rachel or a full ElevenLabs voice ID"}
                      className="h-8 text-sm font-mono"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {voiceProvider === "vapi"
                        ? <>Browse voices at <a href="https://dashboard.vapi.ai" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">dashboard.vapi.ai</a> → Voice Library. Leave blank to use default (Abby).</>
                        : <>Browse voices at <a href="https://elevenlabs.io/voice-library" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">elevenlabs.io/voice-library</a>.</>}
                    </p>
                  </div>
                </div>
                <div className="border-t pt-3 space-y-2">
                  <p className="text-xs font-semibold text-foreground">Webhook Security</p>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Server URL (paste into Vapi → Server URL)</label>
                    <div className="flex items-center gap-2">
                      <input
                        value={webhookUrl}
                        readOnly
                        onFocus={e => e.currentTarget.select()}
                        onClick={e => e.currentTarget.select()}
                        className="flex-1 h-8 text-[11px] font-mono bg-muted/40 text-foreground border border-input rounded-md px-2 cursor-text select-all outline-none focus:ring-1 focus:ring-ring"
                      />
                      <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => { navigator.clipboard.writeText(webhookUrl); toast({ title: "Copied!" }); }}>
                        Copy
                      </Button>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">
                      Webhook Secret {data?.hasWebhookSecret && <span className="text-emerald-600">(configured ✓)</span>}
                    </label>
                    <Input
                      type="password"
                      value={webhookSecret}
                      onChange={e => setWebhookSecret(e.target.value)}
                      placeholder={data?.hasWebhookSecret ? "Enter new secret to rotate…" : "Set a shared secret…"}
                      className="h-8 text-sm font-mono"
                    />
                    <div className="flex items-center justify-between mt-1">
                      <p className="text-[11px] text-muted-foreground">
                        Set this same value in Vapi dashboard → Server URL → Secret. Leave blank to skip secret verification.
                      </p>
                      {data?.hasWebhookSecret && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[11px] text-red-500 hover:text-red-600 hover:bg-red-50 px-2 shrink-0 ml-2"
                          onClick={() => clearSecret.mutate()}
                          disabled={clearSecret.isPending}
                        >
                          {clearSecret.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Clear"}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700"
                    onClick={() => save.mutate()}
                    disabled={save.isPending || (!apiKey && !configured)}
                  >
                    {save.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                    Save
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── DataToolsTab ─────────────────────────────────────────────────────────────
function DataToolsTab() {
  const qc = useQueryClient();
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Data Tools</h2>
        <p className="text-xs text-muted-foreground mt-0.5">One-off admin operations for backfilling and importing data.</p>
      </div>

      <Card className="shadow-xs">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Resend CSV Backfill
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <p className="text-xs text-muted-foreground mb-3">
            Upload a CSV or XLSX export from Resend to retroactively advance clicked contacts to the{" "}
            <span className="font-mono text-foreground">aware</span> stage. Useful when contacts clicked emails before KABOOM was fully wired up.
          </p>
          <ResendCsvUploadPanel
            isAdmin={true}
            onRunComplete={() => qc.invalidateQueries({ queryKey: ["backfill-runs"] })}
          />
          <BackfillAuditLog />
        </CardContent>
      </Card>
    </div>
  );
}

// ── AdvancedTab ──────────────────────────────────────────────────────────────
type BackfillPreview = { total: number; sample: { id: number; name: string | null; email: string }[] };

function AdvancedTab() {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<BackfillPreview | null>(null);

  const previewQuery = useMutation({
    mutationFn: async (): Promise<BackfillPreview> => {
      const r = await fetch("/api/admin/backfill-aware-stage/preview", {
        credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Request failed");
      return r.json();
    },
    onSuccess: (data) => {
      setPreview(data);
    },
    onError: (e: Error) => toast({ title: "Preview failed", description: e.message, variant: "destructive" }),
  });

  const backfill = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/backfill-aware-stage", {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Request failed");
      return r.json() as Promise<{ advanced: number; skipped: number }>;
    },
    onSuccess: (data) => {
      setPreview(null);
      const msg = data.advanced === 0
        ? "No contacts needed updating — all are already at aware or beyond."
        : `${data.advanced} contact${data.advanced === 1 ? "" : "s"} advanced to aware.${data.skipped > 0 ? ` (${data.skipped} already up to date)` : ""}`;
      toast({ title: "Backfill complete", description: msg });
    },
    onError: (e: Error) => toast({ title: "Backfill failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-base font-semibold text-foreground">Advanced</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Admin-only maintenance actions for your workspace.</p>
      </div>

      <Card className="shadow-xs">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contact Stage Maintenance</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">Backfill contact stages</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Advances contacts that are still at <span className="font-mono">pre-aware</span> but have at least one recorded email click to <span className="font-mono">aware</span>. Safe to re-run — already-advanced contacts are skipped.
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => { setPreview(null); previewQuery.mutate(); }}
              disabled={previewQuery.isPending || backfill.isPending}
            >
              {previewQuery.isPending
                ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Previewing…</>
                : <><Eye className="w-3 h-3 mr-1.5" />Preview</>}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => setConfirming(true)}
              disabled={backfill.isPending || previewQuery.isPending}
            >
              {backfill.isPending
                ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Running…</>
                : <><Shield className="w-3 h-3 mr-1.5" />Backfill contact stages</>}
            </Button>
          </div>

          {preview && (
            <div className="rounded-md border bg-muted/40 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                <p className="text-xs font-medium text-foreground">
                  {preview.total === 0
                    ? "No contacts would be advanced — all are already at aware or beyond."
                    : <><span className="text-indigo-600 font-semibold">{preview.total}</span> contact{preview.total === 1 ? "" : "s"} would be advanced to <span className="font-mono">aware</span>.</>}
                </p>
              </div>
              {preview.sample.length > 0 && (
                <ul className="space-y-1 pl-5">
                  {preview.sample.map(c => (
                    <li key={c.id} className="text-xs text-muted-foreground">
                      {c.name ? <><span className="text-foreground">{c.name}</span> — {c.email}</> : c.email}
                    </li>
                  ))}
                  {preview.total > preview.sample.length && (
                    <li className="text-xs text-muted-foreground italic">…and {preview.total - preview.sample.length} more</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Backfill contact stages?</AlertDialogTitle>
            <AlertDialogDescription>
              {preview
                ? <>This will advance <strong>{preview.total} contact{preview.total === 1 ? "" : "s"}</strong> from <strong>pre-aware</strong> to <strong>aware</strong>. The operation is idempotent and tenant-scoped.</>
                : <>This will advance all contacts stuck at <strong>pre-aware</strong> (who have at least one email click) to <strong>aware</strong>. The operation is idempotent and tenant-scoped — it will not affect contacts in other tenants or contacts already past pre-aware.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-indigo-600 hover:bg-indigo-700"
              onClick={() => { setConfirming(false); backfill.mutate(); }}
            >
              Run backfill
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── RetellPanel ───────────────────────────────────────────────────────────────
function RetellPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [agentId, setAgentId] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [rotating, setRotating] = useState(false);

  const { data, isLoading } = useQuery<{
    provider: string; configured: boolean; maskedKey: string | null;
    agentId: string | null; fromNumber: string | null; hasWebhookSecret: boolean;
  }>({
    queryKey: ["integration", "retellai"],
    queryFn: () => api("/integrations/retellai").then(r => r.json()),
  });

  const save = useMutation({
    mutationFn: () =>
      json("/integrations/retellai", "PUT", {
        ...(apiKey ? { apiKey } : {}),
        agentId: agentId || undefined,
        fromNumber: fromNumber || undefined,
        ...(webhookSecret ? { webhookSecret } : {}),
      }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Save failed"); }
        return r.json();
      }),
    onSuccess: (d) => {
      qc.setQueryData(["integration", "retellai"], d);
      setApiKey("");
      setWebhookSecret("");
      setRotating(false);
      setShowKey(false);
      toast({ title: "RetellAI settings saved" });
    },
    onError: (e: any) => toast({ title: e.message ?? "Failed to save", variant: "destructive" }),
  });

  const clearSecret = useMutation({
    mutationFn: () =>
      json("/integrations/retellai", "PUT", { clearWebhookSecret: true }).then(async r => {
        if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Clear failed"); }
        return r.json();
      }),
    onSuccess: (d) => {
      qc.setQueryData(["integration", "retellai"], d);
      toast({ title: "Webhook secret cleared" });
    },
    onError: (e: any) => toast({ title: e.message ?? "Failed to clear", variant: "destructive" }),
  });

  return (
    <Card className="shadow-xs">
      <CardContent className="px-4 py-3">
        <div
          className="flex items-center gap-3 cursor-pointer select-none"
          onClick={() => setExpanded(v => !v)}
        >
          <span className="text-2xl shrink-0">📞</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-foreground">RetellAI</p>
              {isLoading
                ? <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">…</Badge>
                : data?.configured
                  ? <Badge className="text-[10px] h-4 px-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200">Connected</Badge>
                  : <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">Not configured</Badge>
              }
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">AI voice calling via RetellAI agents</p>
          </div>
          <span className="text-muted-foreground text-xs">{expanded ? "▲" : "▼"}</span>
        </div>

        {expanded && (
          <div className="mt-3 space-y-3 border-t pt-3">
            {data?.configured && (
              <p className="text-[11px] text-muted-foreground">
                Connected · key ending <code className="font-mono">{data.maskedKey?.slice(-4)}</code>
                {data.agentId && <> · agent <code className="font-mono text-[10px]">{data.agentId}</code></>}
                {data.fromNumber && <> · from <code className="font-mono text-[10px]">{data.fromNumber}</code></>}
              </p>
            )}

            <div className="space-y-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">
                  API Key {data?.configured && <span className="font-normal">(leave blank to keep existing)</span>}
                </label>
                <div className="flex gap-1.5">
                  <Input
                    type={showKey ? "text" : "password"}
                    className="h-7 text-xs font-mono flex-1"
                    placeholder={data?.configured ? "••••••••" : "key_..."}
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                  />
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setShowKey(v => !v)}>
                    {showKey ? "Hide" : "Show"}
                  </Button>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Agent ID</label>
                <Input
                  className="h-7 text-xs font-mono"
                  placeholder="agent_..."
                  value={agentId}
                  onChange={e => setAgentId(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">From Number <span className="font-normal text-muted-foreground/70">(E.164, e.g. +12025551234)</span></label>
                <Input
                  className="h-7 text-xs font-mono"
                  placeholder="+1..."
                  value={fromNumber}
                  onChange={e => setFromNumber(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground flex items-center justify-between mb-1">
                  <span>
                    Webhook Secret <span className="font-normal text-muted-foreground/70">(optional HMAC verification)</span>
                    {!rotating && data?.hasWebhookSecret && <span className="ml-1 text-emerald-600">✓ set</span>}
                  </span>
                  {data?.hasWebhookSecret && !rotating && (
                    <button
                      className="text-[11px] text-destructive hover:underline"
                      onClick={() => clearSecret.mutate()}
                      disabled={clearSecret.isPending}
                    >
                      Clear
                    </button>
                  )}
                </label>
                {rotating ? (
                  <Input
                    className="h-7 text-xs font-mono"
                    placeholder="New secret…"
                    value={webhookSecret}
                    onChange={e => setWebhookSecret(e.target.value)}
                  />
                ) : (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRotating(true)}>
                    {data?.hasWebhookSecret ? "Rotate secret" : "Set secret"}
                  </Button>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground bg-muted/50 rounded p-2">
                Webhook URL: <code className="font-mono text-[10px]">/api/public/retell-webhook/YOUR_TENANT_ID</code>
              </div>
            </div>

            <Button
              size="sm"
              className="bg-indigo-600 hover:bg-indigo-700 text-white h-7 text-xs"
              disabled={save.isPending || (!data?.configured && !apiKey)}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── IntegrationsTab ──────────────────────────────────────────────────────────
function IntentProviderPanel({ provider, title, description, defaultLimit }: { provider: "newsapi" | "apollo"; title: string; description: string; defaultLimit: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuthContext();
  const isAdmin = (user as any)?.role === "admin";
  const [apiKey, setApiKey] = useState("");
  const [limit, setLimit] = useState(defaultLimit);
  const [expanded, setExpanded] = useState(false);
  const { data } = useQuery<{ configured: boolean; maskedKey?: string; maxRequestsPerRun: number; enabled: boolean }>({
    queryKey: ["integration", provider],
    queryFn: () => api(`/integrations/${provider}`).then(async response => {
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }),
  });
  useEffect(() => { if (data?.maxRequestsPerRun) setLimit(data.maxRequestsPerRun); }, [data?.maxRequestsPerRun]);
  const save = useMutation({
    mutationFn: () => json(`/integrations/${provider}`, "PUT", { ...(apiKey ? { apiKey } : {}), maxRequestsPerRun: limit, enabled: true }).then(async response => {
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }),
    onSuccess: () => {
      setApiKey(""); setExpanded(false);
      qc.invalidateQueries({ queryKey: ["integration", provider] });
      qc.invalidateQueries({ queryKey: ["intent"] });
      toast({ title: `${title} connected` });
    },
    onError: (error: Error) => toast({ title: "Could not save provider", description: error.message, variant: "destructive" }),
  });
  const test = useMutation({
    mutationFn: () => json(`/integrations/${provider}/test`, "POST", apiKey ? { apiKey } : {}).then(async response => {
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }),
    onSuccess: () => toast({ title: `${title} connection verified` }),
    onError: (error: Error) => toast({ title: "Connection test failed", description: error.message, variant: "destructive" }),
  });
  return <Card className="shadow-xs" data-testid={`integration-${provider}`}>
    <CardContent className="px-4 py-3 space-y-3">
      <div className="flex items-start gap-3">
        <DatabaseZap className="w-5 h-5 text-indigo-600 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2"><p className="text-sm font-medium">{title}</p><Badge variant="outline" className={data?.configured ? "text-emerald-700 border-emerald-200" : "text-amber-700 border-amber-200"}>{data?.configured ? "Connected" : "Not connected"}</Badge></div>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          {data?.maskedKey && <p className="text-[11px] font-mono text-muted-foreground mt-1">{data.maskedKey}</p>}
        </div>
        {isAdmin && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setExpanded(value => !value)}>{expanded ? "Close" : data?.configured ? "Manage" : "Connect"}</Button>}
      </div>
      {expanded && isAdmin && <div className="space-y-2 border-t pt-3">
        <div><Label className="text-xs">API key</Label><Input data-testid={`input-${provider}-key`} className="h-8 mt-1 font-mono text-xs" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={data?.configured ? "Leave blank to keep saved key" : "Paste provider API key"} /></div>
        <div><Label className="text-xs">Maximum requests per run</Label><Input className="h-8 mt-1 text-xs" type="number" min={1} max={500} value={limit} onChange={event => setLimit(Math.max(1, Number(event.target.value) || 1))} /></div>
        <p className="text-[11px] text-muted-foreground">The key is stored server-side and is never returned to the browser. Run history records request, page, retry, rate-limit, and failure counts.</p>
        <div className="flex gap-2"><Button data-testid={`button-save-${provider}`} size="sm" className="h-7 text-xs" disabled={save.isPending || (!apiKey && !data?.configured)} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</Button><Button size="sm" variant="outline" className="h-7 text-xs" disabled={test.isPending || (!apiKey && !data?.configured)} onClick={() => test.mutate()}>{test.isPending ? "Testing…" : "Test"}</Button></div>
      </div>}
    </CardContent>
  </Card>;
}

const OTHER_INTEGRATIONS = [
  { name: "Salesforce", desc: "Sync contacts and deals to CRM", icon: "☁️", status: "coming_soon" },
  { name: "HubSpot", desc: "Two-way contact and company sync", icon: "🧲", status: "coming_soon" },
  { name: "Slack", desc: "Get notifications in your Slack workspace", icon: "💬", status: "coming_soon" },
  { name: "Zapier", desc: "Connect to 5,000+ apps via webhooks", icon: "⚙️", status: "coming_soon" },
];

function IntegrationsTab() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Integrations</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Connect KABOOM to your existing stack.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <IntentProviderPanel provider="newsapi" title="NewsAPI.org" description="Live public company news for intent research." defaultLimit={100} />
        <IntentProviderPanel provider="apollo" title="Contact discovery" description="Live B2B contact discovery and enrichment." defaultLimit={20} />
        <ResendPanel />
        <UpstashPanel />
        <VapiPanel />
        <RetellPanel />
        <SmtpAccountsPanel />
        {OTHER_INTEGRATIONS.map(intg => (
          <Card key={intg.name} className="shadow-xs">
            <CardContent className="px-4 py-3">
              <div className="flex items-start gap-3">
                <span className="text-2xl shrink-0">{intg.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{intg.name}</p>
                    {intg.status === "coming_soon" && <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">Soon</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{intg.desc}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const { user } = useAuthContext();
  const isAdmin = (user as any)?.role === "admin";

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Settings className="w-5 h-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold text-foreground tracking-tight">Settings</h1>
        </div>
        <p className="text-sm text-muted-foreground">Manage your workspace, team, and scoring configuration</p>
      </div>

      <Tabs defaultValue="organization">
        <TabsList className="h-9 mb-6 flex-wrap">
          <TabsTrigger value="organization" className="text-xs gap-1.5"><Building2 className="w-3.5 h-3.5" />Organization</TabsTrigger>
          <TabsTrigger value="team" className="text-xs gap-1.5"><Users className="w-3.5 h-3.5" />Team</TabsTrigger>
          <TabsTrigger value="scoring" className="text-xs gap-1.5"><TrendingUp className="w-3.5 h-3.5" />Scoring Rules</TabsTrigger>
          <TabsTrigger value="thresholds" className="text-xs gap-1.5"><Sliders className="w-3.5 h-3.5" />Thresholds</TabsTrigger>
          <TabsTrigger value="stages" className="text-xs gap-1.5"><Layers className="w-3.5 h-3.5" />Stages</TabsTrigger>
          <TabsTrigger value="routing" className="text-xs gap-1.5"><GitBranch className="w-3.5 h-3.5" />Journey Routing</TabsTrigger>
          <TabsTrigger value="forms-banners" className="text-xs gap-1.5"><Megaphone className="w-3.5 h-3.5" />Forms</TabsTrigger>
          <TabsTrigger value="banners" className="text-xs gap-1.5"><Megaphone className="w-3.5 h-3.5" />Banners</TabsTrigger>
          <TabsTrigger value="integrations" className="text-xs gap-1.5"><Puzzle className="w-3.5 h-3.5" />Integrations</TabsTrigger>
          {isAdmin && (
            <>
              <TabsTrigger value="data-tools" className="text-xs gap-1.5"><Wrench className="w-3.5 h-3.5" />Data Tools</TabsTrigger>
              <TabsTrigger value="advanced" className="text-xs gap-1.5"><Shield className="w-3.5 h-3.5" />Advanced</TabsTrigger>
            </>
          )}
        </TabsList>
        <TabsContent value="organization"><OrganizationTab /></TabsContent>
        <TabsContent value="team"><TeamAccessTab /></TabsContent>
        <TabsContent value="scoring"><ScoringRulesTab /></TabsContent>
        <TabsContent value="thresholds"><ThresholdsTab /></TabsContent>
        <TabsContent value="stages"><StagesTab /></TabsContent>
        <TabsContent value="routing"><JourneyRoutingTab /></TabsContent>
        <TabsContent value="forms-banners"><FormsBannersTab /></TabsContent>
        <TabsContent value="banners"><BannersLibraryPage /></TabsContent>
        <TabsContent value="integrations"><IntegrationsTab /></TabsContent>
        {isAdmin && (
          <>
            <TabsContent value="data-tools"><DataToolsTab /></TabsContent>
            <TabsContent value="advanced"><AdvancedTab /></TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}
