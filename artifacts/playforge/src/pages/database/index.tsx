import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Search, Plus, Building2, Users, Layers, Download, Upload,
  MoreHorizontal, BookOpen, MapPin, Activity, ChevronRight, ChevronDown, ChevronLeft,
  X, GitBranch, MailOpen, AlertCircle, Clock, Zap, LayoutList, Group,
  CheckSquare, Square, Tag, Trash2, Globe, Mail, BarChart3, FileText, Loader2, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useListContactDatabases } from "@workspace/api-client-react";
import { canAccess, pageSection } from "@workspace/api-zod";
import { useAuthContext } from "@/contexts/AuthContext";
import { DatabaseOverview, VerifyDetailsDialog, type DatasetSelection } from "@/components/database/DatabaseOverview";
import { KABOOM_FIELDS, KABOOM_FIELD_KEY_BY_LABEL, type MappingAction, type ColMapping } from "@/lib/csvImportFields";

const api = (path: string) =>
  fetch(`/api${path}`, { credentials: "include" }).then(r => r.json());

// ─────────── TYPES ───────────
type Contact = {
  id: number; firstName: string | null; lastName: string | null; email: string | null;
  title: string | null; companyName: string | null; companyId: number | null;
  leadScore: number; tags: string[]; status: string; stage: string;
  source: string;
  lastActivity: string | null; createdAt: string;
  journeyCount: number; journeyIds: number[]; sequenceStatus: string | null;
  emailCount: number; sequenceCompletedAt: string | null;
  identifier: string | null;
};

function initials(c: Contact): string {
  const f = c.firstName?.[0] ?? "";
  const l = c.lastName?.[0] ?? "";
  return (f + l) || (c.email?.[0]?.toUpperCase() ?? "?");
}

function displayName(c: Contact): string {
  if (c.firstName || c.lastName) return `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  return c.email ?? `Contact #${c.id}`;
}
type Journey = { id: number; name: string; status: string; contactCount: number; clientName: string | null };
type Segment = { id: number; name: string; segment_type: string; last_computed_count: number };
type Threshold = { id: number; label: string; minScore: number; color: string };

// ─────────── HELPERS ───────────
function dedupeThresholds(ts: Threshold[]): Threshold[] {
  const seen = new Set<string>();
  return ts
    .filter(t => { const k = `${t.label}:${t.minScore}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.minScore - b.minScore);
}

function getTier(score: number, thresholds: Threshold[]): Threshold {
  const sorted = [...thresholds].sort((a, b) => b.minScore - a.minScore);
  return sorted.find(t => score >= t.minScore) ?? { id: 0, label: "Cold", minScore: 0, color: "slate" };
}

const TIER: Record<string, { bar: string; bg: string; text: string; border: string }> = {
  Champion:   { bar: "bg-purple-600", bg: "bg-purple-50",  text: "text-purple-700", border: "border-purple-200" },
  "Very Hot": { bar: "bg-red-500",    bg: "bg-red-50",     text: "text-red-700",    border: "border-red-200"   },
  Hot:        { bar: "bg-orange-500", bg: "bg-orange-50",  text: "text-orange-700", border: "border-orange-200"},
  Warm:       { bar: "bg-blue-400",   bg: "bg-blue-50",    text: "text-blue-700",   border: "border-blue-200"  },
  Engaged:    { bar: "bg-yellow-400", bg: "bg-yellow-50",  text: "text-yellow-700", border: "border-yellow-200"},
  Cold:       { bar: "bg-slate-400",  bg: "bg-slate-50",   text: "text-slate-600",  border: "border-slate-200" },
};
const tStyle = (label: string) => TIER[label] ?? TIER.Cold;

function relDate(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ─────────── SCORE BAR ───────────
function ScoreBar({ score, thresholds }: { score: number; thresholds: Threshold[] }) {
  const tier = getTier(score, thresholds);
  const style = tStyle(tier.label);
  return (
    <div className="flex items-center gap-2 min-w-[140px]">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", style.bar)} style={{ width: `${Math.min(100, (score / 200) * 100)}%` }} />
      </div>
      <span className={cn("text-xs font-semibold tabular-nums w-6 text-right", style.text)}>{score}</span>
      <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full border hidden xl:inline-block", style.bg, style.text, style.border)}>
        {tier.label}
      </span>
    </div>
  );
}

function SeqPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-muted-foreground/40">—</span>;
  const map: Record<string, string> = {
    active:       "bg-emerald-50 text-emerald-700 border-emerald-200",
    completed:    "bg-blue-50 text-blue-700 border-blue-200",
    paused:       "bg-yellow-50 text-yellow-700 border-yellow-200",
    failed:       "bg-red-50 text-red-700 border-red-200",
    unsubscribed: "bg-gray-100 text-gray-600 border-gray-200",
  };
  return (
    <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full border font-medium capitalize",
      map[status] ?? "bg-gray-100 text-gray-600 border-gray-200")}>
      {status}
    </span>
  );
}

// ─────────── JOURNEY PICKER DIALOG ───────────
function JourneyPickerDialog({
  open, onClose, title, journeys, assignedIds, onToggle, busy,
}: {
  open: boolean; onClose: () => void; title: string;
  journeys: Journey[]; assignedIds: number[];
  onToggle: (jid: number, assigned: boolean) => void; busy: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="max-h-60 overflow-y-auto space-y-0.5 py-1">
          {journeys.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No journeys yet</p>
          )}
          {journeys.map(j => {
            const assigned = assignedIds.includes(j.id);
            return (
              <button key={j.id} disabled={busy} onClick={() => onToggle(j.id, assigned)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-left transition-colors",
                  assigned ? "bg-indigo-50 text-indigo-800" : "hover:bg-muted text-foreground"
                )}>
                <BookOpen className={cn("w-3.5 h-3.5 shrink-0", assigned ? "text-indigo-600" : "text-muted-foreground")} />
                <span className="flex-1 truncate">{j.name}</span>
                {assigned && <span className="text-[10px] text-indigo-600 font-medium">Assigned ✓</span>}
              </button>
            );
          })}
        </div>
        <DialogFooter><Button variant="outline" size="sm" onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkAssignDialog({
  open, onClose, count, journeys, onAssign, busy,
}: {
  open: boolean; onClose: () => void; count: number;
  journeys: Journey[]; onAssign: (jid: number) => void; busy: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Assign {count} contact{count !== 1 ? "s" : ""} to a journey</DialogTitle>
        </DialogHeader>
        <div className="max-h-60 overflow-y-auto space-y-0.5 py-1">
          {journeys.map(j => (
            <button key={j.id} disabled={busy} onClick={() => onAssign(j.id)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm text-left hover:bg-muted transition-colors">
              <BookOpen className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{j.name}</span>
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            </button>
          ))}
        </div>
        <DialogFooter><Button variant="outline" size="sm" onClick={onClose}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────── PRE-BUILT VIEWS ───────────
function ScoreTiersView({ contacts, thresholds, journeys }: { contacts: Contact[]; thresholds: Threshold[]; journeys: Journey[] }) {
  const tiers = dedupeThresholds(thresholds);
  const sorted = [...tiers].sort((a, b) => b.minScore - a.minScore);
  return (
    <div className="p-6 space-y-4 overflow-auto flex-1">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold">Score Tiers</h2>
        <span className="text-xs text-muted-foreground">{contacts.length} contacts</span>
      </div>
      {sorted.map((tier, idx) => {
        const max = idx === 0 ? 200 : sorted[idx - 1].minScore - 1;
        const group = contacts.filter(c => c.leadScore >= tier.minScore && c.leadScore <= max);
        const style = tStyle(tier.label);
        return (
          <div key={tier.id} className="border rounded-lg overflow-hidden">
            <div className={cn("px-4 py-2.5 border-b flex items-center justify-between", style.bg)}>
              <div className="flex items-center gap-2">
                <span className={cn("text-sm font-semibold", style.text)}>{tier.label}</span>
                <span className={cn("text-[10px] px-2 py-0.5 rounded-full border", style.bg, style.text, style.border)}>
                  {tier.minScore}–{max >= 200 ? "200+" : max}
                </span>
                <span className="text-xs text-muted-foreground">{group.length} contacts</span>
              </div>
              {journeys.length > 0 && (
                <Button variant="outline" size="sm" className="h-6 text-[11px] gap-1 px-2">
                  <Zap className="w-3 h-3" /> Run Sequence
                </Button>
              )}
            </div>
            <div className="divide-y">
              {group.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">No contacts in this tier</p>
              )}
              {group.slice(0, 8).map(c => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                    <span className="text-[10px] font-semibold text-indigo-700">{initials(c)}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{displayName(c)}</span>
                    {c.companyName && <span className="text-xs text-muted-foreground ml-2">· {c.companyName}</span>}
                  </div>
                  <span className={cn("text-xs font-bold tabular-nums", style.text)}>{c.leadScore}</span>
                </div>
              ))}
              {group.length > 8 && (
                <p className="text-xs text-muted-foreground text-center py-2">+{group.length - 8} more</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ByCompanyView({ contacts, thresholds }: { contacts: Contact[]; thresholds: Threshold[] }) {
  const byCompany = useMemo(() => {
    const map = new Map<string, Contact[]>();
    contacts.forEach(c => {
      const k = c.companyName ?? "No Company";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    });
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [contacts]);
  return (
    <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4 overflow-auto flex-1 content-start">
      {byCompany.map(([company, members]) => {
        const avg = members.length ? Math.round(members.reduce((s, c) => s + c.leadScore, 0) / members.length) : 0;
        const totalJ = members.reduce((s, c) => s + c.journeyCount, 0);
        const style = tStyle(getTier(avg, thresholds).label);
        return (
          <div key={company} className="border rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b bg-muted/30 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-md bg-indigo-100 flex items-center justify-center shrink-0">
                  <Building2 className="w-4 h-4 text-indigo-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{company}</p>
                  <p className="text-xs text-muted-foreground">{members.length} contacts{totalJ > 0 ? ` · ${totalJ} journeys` : ""}</p>
                </div>
              </div>
              <p className={cn("text-sm font-bold tabular-nums", style.text)}>{avg} avg</p>
            </div>
            <div className="divide-y">
              {members.slice(0, 5).map(c => (
                <div key={c.id} className="flex items-center gap-2.5 px-4 py-2">
                  <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                    <span className="text-[9px] font-semibold text-indigo-700">{initials(c)}</span>
                  </div>
                  <span className="flex-1 text-xs truncate">{displayName(c)}</span>
                  <span className={cn("text-xs font-semibold", tStyle(getTier(c.leadScore, thresholds).label).text)}>{c.leadScore}</span>
                </div>
              ))}
              {members.length > 5 && (
                <p className="text-xs text-muted-foreground text-center py-1.5">+{members.length - 5} more</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function JourneyCoverageView({ contacts, thresholds }: { contacts: Contact[]; thresholds: Threshold[] }) {
  const assigned   = contacts.filter(c => c.journeyCount > 0);
  const unassigned = contacts.filter(c => c.journeyCount === 0);
  const groups = [
    { label: "No Journey Assigned", list: unassigned, Icon: AlertCircle, color: "text-orange-500" },
    { label: "Assigned to Journeys", list: assigned,  Icon: BookOpen,    color: "text-emerald-600" },
  ];
  return (
    <div className="p-6 space-y-4 overflow-auto flex-1">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold">Journey Coverage</h2>
        <div className="flex gap-4 text-xs">
          <span className="text-emerald-600 font-medium">{assigned.length} assigned</span>
          <span className="text-orange-600 font-medium">{unassigned.length} unassigned</span>
        </div>
      </div>
      {groups.map(({ label, list, Icon, color }) => (
        <div key={label} className="border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b bg-muted/30 flex items-center gap-2">
            <Icon className={cn("w-3.5 h-3.5", color)} />
            <span className="text-sm font-semibold">{label}</span>
            <span className="text-xs text-muted-foreground">({list.length})</span>
          </div>
          <div className="divide-y">
            {list.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">None</p>}
            {list.slice(0, 8).map(c => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-semibold text-indigo-700">{initials(c)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{displayName(c)}</p>
                  <p className="text-xs text-muted-foreground truncate">{c.companyName ?? c.email}</p>
                </div>
                <span className={cn("text-xs font-semibold", tStyle(getTier(c.leadScore, thresholds).label).text)}>{c.leadScore}</span>
                {c.journeyCount > 0 && (
                  <span className="text-[10px] text-muted-foreground">{c.journeyCount}j</span>
                )}
              </div>
            ))}
            {list.length > 8 && <p className="text-xs text-muted-foreground text-center py-2">+{list.length - 8} more</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function SequenceGapsView({ contacts }: { contacts: Contact[] }) {
  const now = Date.now();
  const never     = contacts.filter(c => !c.sequenceStatus);
  const completed = contacts.filter(c =>
    c.sequenceStatus === "completed" &&
    c.sequenceCompletedAt != null &&
    now - new Date(c.sequenceCompletedAt).getTime() > 30 * 86_400_000
  );
  const unsub     = contacts.filter(c => c.sequenceStatus === "unsubscribed" || c.status === "unsubscribed");
  const groups = [
    { label: "Never Enrolled",   list: never,     Icon: MailOpen, color: "text-slate-500" },
    { label: "Completed >30d",   list: completed, Icon: Clock,    color: "text-blue-600"  },
    { label: "Unsubscribed",     list: unsub,     Icon: X,        color: "text-red-600"   },
  ];
  return (
    <div className="p-6 space-y-4 overflow-auto flex-1">
      <h2 className="text-sm font-semibold mb-1">Sequence Gaps</h2>
      {groups.map(({ label, list, Icon, color }) => (
        <div key={label} className="border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b bg-muted/30 flex items-center gap-2">
            <Icon className={cn("w-3.5 h-3.5", color)} />
            <span className="text-sm font-semibold">{label}</span>
            <span className="text-xs text-muted-foreground">({list.length})</span>
          </div>
          <div className="divide-y">
            {list.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">None</p>}
            {list.slice(0, 6).map(c => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-semibold text-indigo-700">{initials(c)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{displayName(c)}</p>
                  <p className="text-xs text-muted-foreground truncate">{c.companyName ?? c.email}</p>
                </div>
                <span className="text-xs text-muted-foreground">{relDate(c.lastActivity)}</span>
              </div>
            ))}
            {list.length > 6 && <p className="text-xs text-muted-foreground text-center py-2">+{list.length - 6} more</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────── BY SOURCE VIEW ───────────
function BySourceView({ contacts, thresholds }: { contacts: Contact[]; thresholds: Threshold[] }) {
  const SOURCE_LABELS: Record<string, string> = {
    manual: "Manual Entry", web_form: "Web Form", import: "Import",
    crm_sync: "CRM Sync", api: "API",
  };
  const SOURCE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    manual: Users, web_form: Globe, import: Download,
    crm_sync: Activity, api: GitBranch,
  };
  const bySource = useMemo(() => {
    const map = new Map<string, Contact[]>();
    contacts.forEach(c => {
      const k = c.source || "manual";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    });
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [contacts]);

  return (
    <div className="p-6 space-y-4 overflow-auto flex-1">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold">By Source</h2>
        <span className="text-xs text-muted-foreground">{contacts.length} contacts</span>
      </div>
      {bySource.map(([source, members]) => {
        const avg = members.length
          ? Math.round(members.reduce((s, c) => s + c.leadScore, 0) / members.length)
          : 0;
        const style = tStyle(getTier(avg, thresholds).label);
        const Icon = SOURCE_ICONS[source] ?? Globe;
        return (
          <div key={source} className="border rounded-lg overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-muted/30 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-md bg-indigo-100 flex items-center justify-center shrink-0">
                  <Icon className="w-4 h-4 text-indigo-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{SOURCE_LABELS[source] ?? source}</p>
                  <p className="text-xs text-muted-foreground">{members.length} contacts</p>
                </div>
              </div>
              <p className={cn("text-sm font-bold tabular-nums", style.text)}>{avg} avg score</p>
            </div>
            <div className="divide-y">
              {members.slice(0, 5).map(c => (
                <div key={c.id} className="flex items-center gap-2.5 px-4 py-2">
                  <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                    <span className="text-[9px] font-semibold text-indigo-700">
                      {initials(c)}
                    </span>
                  </div>
                  <span className="flex-1 text-xs truncate">{displayName(c)}</span>
                  <span className={cn("text-xs font-semibold", tStyle(getTier(c.leadScore, thresholds).label).text)}>
                    {c.leadScore}
                  </span>
                </div>
              ))}
              {members.length > 5 && (
                <p className="text-xs text-muted-foreground text-center py-1.5">+{members.length - 5} more</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────── CSV IMPORT MODAL ───────────
const CSV_HEADERS = [
  "First Name", "Last Name", "Email", "Phone", "Title", "Company",
  "Designation", "Function", "Employee Size", "Company Revenue",
  "LinkedIn URL", "Company LinkedIn URL", "City", "Pin", "State", "Country",
];

function downloadTemplate() {
  const csv = CSV_HEADERS.join(",") + "\n";
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "contacts_import_template.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

type ImportStep = "select" | "mapping" | "preview" | "result";

interface PreviewRow {
  rowNum: number;
  data: Record<string, string | null>;
  errors: string[];
}

interface PreviewData {
  headers: string[];
  headerErrors: string[];
  unknownHeaders: string[];
  previewRows: PreviewRow[];
  totalDataRows: number;
  validRowCount: number;
  existingCount: number;
  newCount: number;
}

function CsvImportModal({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [step, setStep] = useState<ImportStep>("select");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [result, setResult] = useState<{ imported: number; updated: number; skipped: number } | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [clientId, setClientId] = useState<string>("");
  const [identifier, setIdentifier] = useState<string>("");
  const [colMappings, setColMappings] = useState<Record<string, ColMapping>>({});
  const [dbMode, setDbMode] = useState<"existing" | "new">("new");
  const [databaseId, setDatabaseId] = useState("");
  const [newDbName, setNewDbName] = useState("");
  const [segmentId, setSegmentId] = useState("none");
  const { data: dbOverview } = useListContactDatabases({ query: { enabled: open, queryKey: ["/api/contact-databases"] } });
  const staticSegments = (dbOverview?.segments ?? []).filter(sg => sg.segmentType === "static");
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: clients = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["clients"],
    queryFn: () => fetch("/api/clients", { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });

  const reset = () => {
    setStep("select");
    setFile(null);
    setFileError(null);
    setPreviewing(false);
    setPreview(null);
    setResult(null);
    setImportErrors([]);
    setImporting(false);
    setClientId("");
    setIdentifier("");
    setColMappings({});
    setDbMode("new"); setDatabaseId(""); setNewDbName(""); setSegmentId("none");
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleClose = () => { reset(); onClose(); };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFileError(null);
    setPreview(null);
    setImportErrors([]);
    setColMappings({});
    if (!f) { setFile(null); return; }
    const lower = f.name.toLowerCase();
    if (!lower.endsWith(".csv") && !lower.endsWith(".xls") && !lower.endsWith(".xlsx")) {
      setFileError("Only .csv, .xls, or .xlsx files are accepted.");
      setFile(null);
      return;
    }
    if (f.size > 15 * 1024 * 1024) {
      setFileError("File is too large (max 15 MB).");
      setFile(null);
      return;
    }
    setFile(f);
  };

  const handlePreview = async () => {
    if (!file) return;
    setPreviewing(true);
    setImportErrors([]);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/contacts/import/preview", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const data = await res.json() as PreviewData & { errors?: string[] };
      if (!res.ok) {
        const msgs = [...(data.headerErrors ?? []), ...(data.errors ?? [])];
        setFileError(msgs.length > 0 ? msgs.join(" ") : "Failed to read the file.");
        return;
      }
      setPreview(data);
      // If there are unknown headers, stop at mapping step first
      if ((data.unknownHeaders ?? []).length > 0) {
        const defaults: Record<string, ColMapping> = {};
        for (const h of data.unknownHeaders ?? []) {
          defaults[h] = { action: "ignore" };
        }
        setColMappings(defaults);
        setStep("mapping");
      } else {
        setStep("preview");
      }
    } catch {
      setFileError("Failed to read the file. Please try again.");
    } finally {
      setPreviewing(false);
    }
  };

  const handleContinueToPreview = async () => {
    if (!file) return;
    setPreviewing(true);
    setFileError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (Object.keys(colMappings).length > 0) {
        formData.append("columnMappings", JSON.stringify(colMappings));
      }
      const res = await fetch("/api/contacts/import/preview", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const data = await res.json() as PreviewData & { errors?: string[] };
      if (!res.ok) {
        const msgs = [...(data.headerErrors ?? []), ...(data.errors ?? [])];
        setFileError(msgs.length > 0 ? msgs.join(" ") : "Failed to read the file.");
        return;
      }
      // Re-fetching with the chosen mappings applied means previously-unknown
      // headers mapped to a Kaboom field (e.g. "Identifier") now resolve — so
      // any that are still unrecognized are genuinely unmapped/custom columns.
      setPreview(data);
      setStep("preview");
    } catch {
      setFileError("Failed to re-check the file with your mappings. Please try again.");
    } finally {
      setPreviewing(false);
    }
  };

  const handleImport = async () => {
    if (!file) return;
    setImportErrors([]);
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (clientId) formData.append("clientId", clientId);
      if (dbMode === "existing" && databaseId) formData.append("databaseId", databaseId);
      if (dbMode === "new" && newDbName.trim()) formData.append("newDatabaseName", newDbName.trim());
      if (segmentId !== "none") formData.append("segmentId", segmentId);
      if (identifier.trim()) {
        formData.append("identifier", identifier.trim());
      }
      if (Object.keys(colMappings).length > 0) {
        formData.append("columnMappings", JSON.stringify(colMappings));
      }
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msgs = (data as { errors?: string[] }).errors;
        setImportErrors(msgs && msgs.length > 0 ? msgs : ["Import failed."]);
        return;
      }
      setResult(data as { imported: number; updated: number; skipped: number });
      setStep("result");
      onSuccess();
    } catch {
      setImportErrors(["Import failed. Please try again."]);
    } finally {
      setImporting(false);
    }
  };

  const handleBack = () => {
    if (step === "mapping") {
      setStep("select");
      setPreview(null);
      setColMappings({});
    } else {
      setStep(preview && (preview.unknownHeaders ?? []).length > 0 ? "mapping" : "select");
      setImportErrors([]);
    }
  };

  if (!open) return null;

  const colDisplayNames = preview?.headers ?? [];
  const previewRows = preview?.previewRows ?? [];
  const totalDataRows = preview?.totalDataRows ?? 0;
  const validRowCount = preview?.validRowCount ?? 0;
  const existingCount = preview?.existingCount ?? 0;
  const newCount = preview?.newCount ?? validRowCount;
  const headerErrors = preview?.headerErrors ?? [];
  const unknownHeaders = preview?.unknownHeaders ?? [];

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className={cn("flex flex-col max-h-[85vh]", step === "preview" ? "max-w-3xl" : "max-w-lg")}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-indigo-600" />
            Import Contacts
            {step === "mapping" && (
              <span className="ml-auto text-xs font-normal text-muted-foreground">Step 2 of 3 — Map Columns</span>
            )}
            {step === "preview" && (
              <span className="ml-auto text-xs font-normal text-muted-foreground">{unknownHeaders.length > 0 ? "Step 3 of 3" : "Step 2 of 2"} — Preview</span>
            )}
          </DialogTitle>
        </DialogHeader>

        {step === "select" && (
          <div className="space-y-4 py-1 overflow-y-auto">
            <p className="text-sm text-muted-foreground">
              Upload a CSV, XLS, or XLSX file to bulk-import contacts. Duplicate emails are updated automatically.
              Download the template below to get started with the correct column headers.
            </p>

            <button
              onClick={downloadTemplate}
              className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 hover:underline transition-colors"
            >
              <FileText className="w-3.5 h-3.5" />
              Download template CSV
            </button>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Named database</label>
              <div className="grid grid-cols-2 gap-1 bg-muted rounded-lg p-0.5">
                {(["new", "existing"] as const).map(m => (
                  <button key={m} type="button" data-testid={`button-db-mode-${m}`} onClick={() => setDbMode(m)}
                    className={cn("py-1 text-xs rounded-md transition-colors", dbMode === m ? "bg-background shadow-sm font-medium" : "text-muted-foreground")}>
                    {m === "new" ? "New database" : "Add to existing"}
                  </button>
                ))}
              </div>
              {dbMode === "new" ? (
                <Input value={newDbName} onChange={e => setNewDbName(e.target.value)} disabled={previewing} data-testid="input-new-database"
                  placeholder={file ? `Defaults to "${file.name.replace(/\.[^.]+$/, "")}"` : "Defaults to the uploaded filename"} className="h-9 text-sm" />
              ) : (
                <Select value={databaseId} onValueChange={setDatabaseId} disabled={previewing}>
                  <SelectTrigger className="w-full" data-testid="select-database"><SelectValue placeholder="Choose a database" /></SelectTrigger>
                  <SelectContent>
                    {(dbOverview?.databases ?? []).map(d => (
                      <SelectItem key={d.id} value={String(d.id)}>{d.name} ({d.contactCount.toLocaleString()})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Also add to static segment <span className="text-muted-foreground font-normal">(optional)</span></label>
              <Select value={segmentId} onValueChange={setSegmentId} disabled={previewing}>
                <SelectTrigger className="w-full" data-testid="select-segment"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No segment</SelectItem>
                  {staticSegments.map(sg => <SelectItem key={sg.id} value={String(sg.id)}>{sg.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">Dynamic segments follow their rules, so only static segments are listed.</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Client <span className="text-muted-foreground font-normal">(optional)</span></label>
              <Select value={clientId || "none"} onValueChange={v => setClientId(v === "none" ? "" : v)} disabled={previewing}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={clients.length === 0 ? "Loading clients…" : "Select a client"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No client</SelectItem>
                  {clients.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                Identifier <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                disabled={previewing}
                placeholder="e.g. hp-list-jul-2026"
                className="h-9 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                A tag applied to every contact in this upload, separate from regular tags — use it to segment contacts by which file they came from.
                If your file has its own identifier/code column, map it in the next step and it will take priority per row.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">CSV, XLS, or XLSX file (max 15 MB)</label>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xls,.xlsx"
                onChange={handleFileChange}
                disabled={previewing}
                className="block w-full text-sm text-muted-foreground
                  file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-input
                  file:text-xs file:font-medium file:bg-background file:text-foreground
                  file:cursor-pointer file:hover:bg-muted file:transition-colors
                  cursor-pointer"
              />
              {fileError && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />{fileError}
                </p>
              )}
              {file && !fileError && (
                <p className="text-xs text-muted-foreground">{file.name} ({(file.size / 1024).toFixed(1)} KB)</p>
              )}
            </div>
          </div>
        )}

        {step === "mapping" && preview && unknownHeaders.length > 0 && (
          <div className="space-y-4 py-1 overflow-y-auto flex-1 min-h-0">
            <p className="text-sm text-muted-foreground">
              Your CSV has <span className="font-medium text-foreground">{unknownHeaders.length}</span> column{unknownHeaders.length !== 1 ? "s" : ""} that aren't standard Kaboom fields.
              Choose what to do with each one:
            </p>
            <div className="space-y-3">
              {unknownHeaders.map(header => {
                const cur = colMappings[header] ?? { action: "ignore" as MappingAction };
                return (
                  <div key={header} className="rounded-lg border border-border p-3 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">{header}</span>
                      <span className="text-xs text-muted-foreground">— unknown column</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {(["map", "ignore", "custom"] as MappingAction[]).map(action => (
                        <button
                          key={action}
                          onClick={() => setColMappings(prev => ({ ...prev, [header]: { action } }))}
                          className={cn(
                            "text-xs rounded-md border px-2 py-1.5 text-left transition-colors",
                            cur.action === action
                              ? action === "map"   ? "border-indigo-400 bg-indigo-50 text-indigo-700 font-medium"
                              : action === "custom" ? "border-emerald-400 bg-emerald-50 text-emerald-700 font-medium"
                              : "border-gray-400 bg-gray-50 text-gray-700 font-medium"
                              : "border-border bg-background text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {action === "map"    && "Map to Kaboom field"}
                          {action === "ignore" && "Ignore this column"}
                          {action === "custom" && "Add as custom field"}
                        </button>
                      ))}
                    </div>
                    {cur.action === "map" && (
                      <select
                        className="w-full h-8 px-2 text-xs border rounded bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                        value={cur.mapTo ?? ""}
                        onChange={e => setColMappings(prev => ({
                          ...prev,
                          [header]: { action: "map", mapTo: e.target.value as ColMapping["mapTo"] },
                        }))}
                      >
                        <option value="">— Select a Kaboom field —</option>
                        {KABOOM_FIELDS.map(f => (
                          <option key={f.key} value={f.key}>{f.label}</option>
                        ))}
                      </select>
                    )}
                    {cur.action === "ignore" && (
                      <p className="text-[11px] text-muted-foreground">This column will be skipped during import.</p>
                    )}
                    {cur.action === "custom" && (
                      <p className="text-[11px] text-emerald-700">
                        Values will be saved as a custom field named <span className="font-mono font-medium">"{header}"</span> on each contact. You can filter and export by this field later.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step === "preview" && preview && (
          <div className="space-y-4 py-1 overflow-y-auto flex-1 min-h-0">
            {headerErrors.length > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-1">
                <p className="text-xs font-semibold text-destructive flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> Column errors — fix these before importing
                </p>
                <ul className="space-y-0.5">
                  {headerErrors.map((e, i) => (
                    <li key={i} className="text-xs text-destructive/80">• {e}</li>
                  ))}
                </ul>
              </div>
            )}

            {headerErrors.length === 0 && (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Showing first {previewRows.length} of <span className="font-medium text-foreground">{totalDataRows}</span> rows
                    {totalDataRows !== validRowCount && (
                      <> &mdash; <span className="text-amber-600 font-medium">{totalDataRows - validRowCount} row{totalDataRows - validRowCount !== 1 ? "s" : ""} with errors will be skipped</span></>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{file?.name}</span>
                </div>

                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 flex items-center gap-3 text-sm flex-wrap">
                  <span className="flex items-center gap-1.5 font-medium text-emerald-700">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                    {newCount} new
                  </span>
                  {existingCount > 0 && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/40" />
                        {existingCount} already in your database (will be updated)
                      </span>
                    </>
                  )}
                </div>

                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/50 border-b border-border">
                        <th className="px-2 py-2 text-left font-medium text-muted-foreground w-10">#</th>
                        {colDisplayNames.map(h => (
                          <th key={h} className="px-2 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                        ))}
                        <th className="px-2 py-2 text-left font-medium text-muted-foreground w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map(row => {
                        const hasError = row.errors.length > 0;
                        return (
                          <tr key={row.rowNum} className={cn("border-b border-border last:border-0", hasError && "bg-destructive/5")}>
                            <td className="px-2 py-1.5 text-muted-foreground">{row.rowNum}</td>
                            {colDisplayNames.map(h => {
                              const fieldKey = KABOOM_FIELD_KEY_BY_LABEL[h];
                              const val = fieldKey ? (row.data[fieldKey] ?? null) : null;
                              return (
                                <td key={h} className="px-2 py-1.5 max-w-[140px] truncate text-foreground">
                                  {val ?? <span className="text-muted-foreground/50">—</span>}
                                </td>
                              );
                            })}
                            <td className="px-2 py-1.5">
                              {hasError && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <AlertCircle className="w-3.5 h-3.5 text-destructive cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="left" className="max-w-xs text-xs">
                                    {row.errors.map((e, i) => <div key={i}>{e}</div>)}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {importErrors.length > 0 && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-1">
                    <p className="text-xs font-semibold text-destructive flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Import failed
                    </p>
                    <ul className="max-h-32 overflow-y-auto space-y-0.5">
                      {importErrors.map((e, i) => (
                        <li key={i} className="text-xs text-destructive/80">• {e}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {step === "result" && result && (
          <div className="py-4">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 flex items-center gap-2">
              <CheckSquare className="w-4 h-4 text-emerald-600 shrink-0" />
              <p className="text-sm text-emerald-800 font-medium">
                {result.imported > 0 && <>Added {result.imported} new contact{result.imported !== 1 ? "s" : ""}.</>}
                {result.updated > 0 && <>{result.imported > 0 ? " " : ""}Updated {result.updated} existing contact{result.updated !== 1 ? "s" : ""}.</>}
                {result.skipped > 0 && <> Skipped {result.skipped} row{result.skipped !== 1 ? "s" : ""} (no email or phone).</>}
              </p>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 flex-wrap sm:flex-nowrap sm:justify-end shrink-0 border-t pt-3 mt-2">
          {step === "select" && (
            <>
              <Button variant="outline" size="sm" onClick={handleClose}>Cancel</Button>
              <Button
                size="sm"
                className="bg-indigo-600 hover:bg-indigo-700 gap-1.5"
                onClick={handlePreview}
                disabled={!file || !!fileError || previewing}
              >
                {previewing ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading…</>
                ) : (
                  <>Preview Import</>
                )}
              </Button>
            </>
          )}

          {step === "mapping" && (
            <>
              <Button variant="outline" size="sm" onClick={handleBack}>
                <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Back
              </Button>
              <Button
                size="sm"
                className="bg-indigo-600 hover:bg-indigo-700 gap-1.5"
                onClick={handleContinueToPreview}
                disabled={previewing || Object.values(colMappings).some(m => m.action === "map" && !m.mapTo)}
                title={Object.values(colMappings).some(m => m.action === "map" && !m.mapTo) ? "Select a Kaboom field for each column marked 'Map to Kaboom field'" : undefined}
              >
                {previewing ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Applying mappings…</>
                ) : (
                  <>Continue to Preview</>
                )}
              </Button>
            </>
          )}

          {step === "preview" && (
            <>
              <Button variant="outline" size="sm" onClick={handleBack} disabled={importing}>
                <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Back
              </Button>
              {headerErrors.length === 0 && (
                <Button
                  size="sm"
                  className="bg-indigo-600 hover:bg-indigo-700 gap-1.5"
                  onClick={handleImport}
                  disabled={importing || newCount === 0}
                >
                  {importing ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Importing…</>
                  ) : (
                    <><Upload className="w-3.5 h-3.5" /> Import {newCount} contact{newCount !== 1 ? "s" : ""}</>
                  )}
                </Button>
              )}
            </>
          )}

          {step === "result" && (
            <Button variant="outline" size="sm" onClick={handleClose}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────── CONSTANTS ───────────
const PRESETS = [
  { key: "all",  label: "All",  range: [0, 200]   as [number, number] },
  { key: "cold", label: "Cold", range: [0, 39]    as [number, number] },
  { key: "warm", label: "Warm", range: [40, 79]   as [number, number] },
  { key: "hot",  label: "Hot",  range: [80, 200]  as [number, number] },
];

const SIDEBAR_VIEWS = [
  { key: "view:score-tiers",      label: "Score Tiers",      Icon: Layers   },
  { key: "view:by-company",       label: "By Company",       Icon: Building2},
  { key: "view:by-source",        label: "By Source",        Icon: Globe    },
  { key: "view:recently-active",  label: "Recently Active",  Icon: Activity },
  { key: "view:no-activity",      label: "No Activity 30d",  Icon: Clock    },
  { key: "view:journey-coverage", label: "Journey Coverage", Icon: MapPin   },
  { key: "view:sequence-gaps",    label: "Sequence Gaps",    Icon: MailOpen },
];

const SPECIAL_VIEWS = ["view:score-tiers", "view:by-company", "view:by-source", "view:journey-coverage", "view:sequence-gaps"];

// ─────────── MAIN PAGE ───────────
export default function DatabasePage() {
  const [, navigate] = useLocation();
  const { toast }    = useToast();
  const qc           = useQueryClient();
  const { user }     = useAuthContext();
  const dbSection    = pageSection("/database");
  const canEdit      = !!user && !!dbSection && canAccess(user, dbSection, true);
  const [databaseId, setDatabaseId] = useState<number | null>(null);
  const [dataset, setDataset]       = useState<DatasetSelection>(null);
  const [verifyFor, setVerifyFor]   = useState<{ id: number; name: string } | null>(null);

  const [section, setSection]       = useState(() => {
    const id = Number(new URLSearchParams(window.location.search).get("segmentId"));
    return Number.isSafeInteger(id) && id > 0 ? `segment:${id}` : "all";
  });
  const [search, setSearch]         = useState("");
  const [scoreRange, setScoreRange] = useState<[number, number]>([0, 200]);
  const [preset, setPreset]         = useState("all");
  const [groupCo, setGroupCo]       = useState(false);
  const [expanded, setExpanded]     = useState<Set<string>>(new Set());
  const [selected, setSelected]     = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen]     = useState(false);
  const [pickerCid, setPickerCid]   = useState<number | null>(null);
  const [pickerJids, setPickerJids] = useState<number[]>([]);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [sortF, setSortF]           = useState<"leadScore" | "name" | "lastActivity">("leadScore");
  const [sortD, setSortD]           = useState<"asc" | "desc">("desc");
  const [showSlider, setShowSlider] = useState(false);
  const [stageFilter, setStageFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [identifierFilter, setIdentifierFilter] = useState("");
  const [deleteId, setDeleteId]           = useState<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [dbPage, setDbPage]             = useState(1);
  const [totalDbCount, setTotalDbCount] = useState<number | null>(null);
  const DB_PAGE_SIZE = 100;

  // ── Build API query params from all active filter state ──
  const contactsParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (search)               p.search = search;
    if (scoreRange[0] > 0)    p.scoreMin = String(scoreRange[0]);
    if (scoreRange[1] < 200)  p.scoreMax = String(scoreRange[1]);
    if (stageFilter !== "all")  p.stage  = stageFilter;
    if (sourceFilter !== "all") p.source = sourceFilter;
    if (identifierFilter.trim()) p.identifier = identifierFilter.trim();
    if (section.startsWith("journey:")) p.journeyId = section.split(":")[1];
    if (section.startsWith("segment:")) p.segmentId = section.split(":")[1];
    if (databaseId != null) p.databaseId = String(databaseId);
    if (dataset) p.datasetId = String(dataset.id);
    p.page     = String(dbPage);
    p.pageSize = String(DB_PAGE_SIZE);
    return p;
  }, [search, scoreRange, stageFilter, sourceFilter, identifierFilter, section, dbPage, databaseId, dataset]);

  // Reset to page 1 whenever any filter changes (not page itself)
  const filterSig = `${search}|${scoreRange[0]}-${scoreRange[1]}|${stageFilter}|${sourceFilter}|${identifierFilter}|${section}|${databaseId}|${dataset?.id}`;
  const prevFilterSig = useRef(filterSig);
  useEffect(() => {
    if (prevFilterSig.current !== filterSig) {
      prevFilterSig.current = filterSig;
      setDbPage(1);
    }
  }, [filterSig]);

  // ── Queries ──
  const { data: contacts = [], isLoading } = useQuery<Contact[]>({
    queryKey: ["db-contacts", contactsParams],
    queryFn: async () => {
      const qs = new URLSearchParams(contactsParams).toString();
      const res = await fetch(`/api/contacts${qs ? `?${qs}` : ""}`, { credentials: "include" });
      const total = parseInt(res.headers.get("X-Total-Count") ?? "0", 10);
      if (!isNaN(total)) setTotalDbCount(total);
      return res.json();
    },
  });
  const { data: journeys = [] } = useQuery<Journey[]>({
    queryKey: ["journeys"],
    queryFn: () => api("/journeys"),
  });
  const { data: segments = [] } = useQuery<Segment[]>({
    queryKey: ["segments"],
    queryFn: () => api("/segments"),
  });
  const { data: rawThresh = [] } = useQuery<Threshold[]>({
    queryKey: ["score-thresholds"],
    queryFn: () => api("/score-thresholds"),
  });
  const thresholds = useMemo(() => dedupeThresholds(rawThresh), [rawThresh]);

  // ── Filtered contacts (backend handles score/search/stage/source/journey; client handles smart-view time gates + sort) ──
  const filtered = useMemo(() => {
    let list = contacts;
    if (section === "view:recently-active") {
      const cut = Date.now() - 14 * 86_400_000;
      list = list.filter(c => c.lastActivity && new Date(c.lastActivity).getTime() > cut);
    } else if (section === "view:no-activity") {
      const cut = Date.now() - 30 * 86_400_000;
      list = list.filter(c => !c.lastActivity || new Date(c.lastActivity).getTime() < cut);
    }
    return [...list].sort((a, b) => {
      let va: string | number, vb: string | number;
      if (sortF === "leadScore")   { va = a.leadScore; vb = b.leadScore; }
      else if (sortF === "name")   { va = displayName(a); vb = displayName(b); }
      else                         { va = a.lastActivity ?? ""; vb = b.lastActivity ?? ""; }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortD === "asc" ? cmp : -cmp;
    });
  }, [contacts, section, sortF, sortD]);

  const grouped = useMemo(() => {
    if (!groupCo) return null;
    const map = new Map<string, Contact[]>();
    filtered.forEach(c => {
      const k = c.companyName ?? "No Company";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    });
    return map;
  }, [filtered, groupCo]);

  const journeysWithContacts = useMemo(() => journeys.filter(j => j.contactCount > 0), [journeys]);

  // ── Handlers ──
  const toggleSort = (f: typeof sortF) => {
    if (sortF === f) setSortD(d => d === "asc" ? "desc" : "asc");
    else { setSortF(f); setSortD("desc"); }
  };

  const applyPreset = (key: string) => {
    const p = PRESETS.find(p => p.key === key);
    if (p) { setPreset(key); setScoreRange(p.range); }
  };

  const toggleSelect = (id: number) =>
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const toggleAll = () =>
    setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map(c => c.id)));

  const toggleExpand = (k: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const openPicker = (c: Contact) => { setPickerCid(c.id); setPickerJids(c.journeyIds ?? []); };

  const handleToggleJourney = useCallback(async (jid: number, assigned: boolean) => {
    if (pickerCid === null) return;
    setPickerBusy(true);
    try {
      if (assigned) {
        await fetch(`/api/journeys/${jid}/contacts/${pickerCid}`, { method: "DELETE", credentials: "include" });
        setPickerJids(prev => prev.filter(id => id !== jid));
      } else {
        await fetch(`/api/journeys/${jid}/contacts`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactIds: [pickerCid] }),
        });
        setPickerJids(prev => [...prev, jid]);
      }
      qc.invalidateQueries({ queryKey: ["db-contacts"] });
      qc.invalidateQueries({ queryKey: ["journeys"] });
    } catch {
      toast({ title: "Error", description: "Failed to update journey assignment.", variant: "destructive" });
    } finally { setPickerBusy(false); }
  }, [pickerCid, qc, toast]);

  const handleRowToggleJourney = useCallback(async (contactId: number, jid: number, assigned: boolean) => {
    try {
      if (assigned) {
        await fetch(`/api/journeys/${jid}/contacts/${contactId}`, { method: "DELETE", credentials: "include" });
      } else {
        await fetch(`/api/journeys/${jid}/contacts`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactIds: [contactId] }),
        });
      }
      qc.invalidateQueries({ queryKey: ["db-contacts"] });
      qc.invalidateQueries({ queryKey: ["journeys"] });
    } catch {
      toast({ title: "Error", description: "Failed to update journey assignment.", variant: "destructive" });
    }
  }, [qc, toast]);

  const handleBulkAssign = async (jid: number) => {
    const ids = Array.from(selected);
    try {
      await fetch(`/api/journeys/${jid}/contacts`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds: ids }),
      });
      toast({ title: "Assigned", description: `${ids.length} contacts added to journey.` });
      setSelected(new Set()); setBulkOpen(false);
      qc.invalidateQueries({ queryKey: ["db-contacts"] });
      qc.invalidateQueries({ queryKey: ["journeys"] });
    } catch {
      toast({ title: "Error", description: "Failed to assign contacts.", variant: "destructive" });
    }
  };

  const exportCsv = () => {
    const hdr = "Name,Email,Title,Company,Score,Tier,Tags,Status,Journeys";
    const rows = filtered.map(c =>
      `"${displayName(c)}","${c.email ?? ""}","${c.title ?? ""}","${c.companyName ?? ""}",${c.leadScore},"${getTier(c.leadScore, thresholds).label}","${c.tags.join(";")}","${c.status}",${c.journeyCount}`
    );
    const blob = new Blob([hdr + "\n" + rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "contacts.csv"; a.click();
  };

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/contacts/${id}`, { method: "DELETE", credentials: "include" }).then(r => {
        if (!r.ok) throw new Error("Failed to delete");
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["db-contacts"] });
      toast({ title: "Contact deleted" });
      setDeleteId(null);
    },
    onError: () => toast({ title: "Error", description: "Could not delete contact.", variant: "destructive" }),
  });

  const chips: { label: string; clear: () => void }[] = [];
  if (search) chips.push({ label: `"${search}"`, clear: () => setSearch("") });
  if (preset !== "all" || scoreRange[0] !== 0 || scoreRange[1] !== 200)
    chips.push({ label: `Score ${scoreRange[0]}–${scoreRange[1]}`, clear: () => { setPreset("all"); setScoreRange([0, 200]); } });
  if (identifierFilter.trim()) chips.push({ label: `Identifier: "${identifierFilter.trim()}"`, clear: () => setIdentifierFilter("") });
  if (stageFilter !== "all") chips.push({ label: `Stage: ${stageFilter}`, clear: () => setStageFilter("all") });
  if (sourceFilter !== "all") {
    const SRC_LBL: Record<string, string> = { manual: "Manual", web_form: "Web Form", import: "Import", crm_sync: "CRM Sync", api: "API" };
    chips.push({ label: `Source: ${SRC_LBL[sourceFilter] ?? sourceFilter}`, clear: () => setSourceFilter("all") });
  }

  const isSpecialView = SPECIAL_VIEWS.includes(section);

  // ── Contact Row ──
  const ContactRow = ({ c }: { c: Contact }) => {
    const sel = selected.has(c.id);
    return (
      <tr className={cn("group border-b border-border/50 hover:bg-muted/30 transition-colors", sel && "bg-indigo-50/40")}>
        <td className="py-2.5 pl-3 w-8" onClick={e => { e.stopPropagation(); toggleSelect(c.id); }}>
          <button className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center">
            {sel
              ? <CheckSquare className="w-3.5 h-3.5 text-indigo-600" />
              : <Square className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
        </td>
        <td className="py-2.5 px-3 cursor-pointer" onClick={() => navigate(`/crm/contacts/${c.id}`)}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
              <span className="text-[10px] font-semibold text-indigo-700">{initials(c)}</span>
            </div>
            <p className="text-sm font-medium truncate max-w-[110px]">{displayName(c)}</p>
          </div>
        </td>
        <td className="py-2.5 px-3 text-xs text-muted-foreground max-w-[160px] truncate">
          {c.email}
        </td>
        <td className="py-2.5 px-3">
          {c.companyName
            ? <div className="flex items-center gap-1 text-xs text-muted-foreground max-w-[110px]">
                <Building2 className="w-3 h-3 shrink-0" />
                <span className="truncate">{c.companyName}</span>
              </div>
            : <span className="text-muted-foreground/40 text-xs">—</span>}
        </td>
        <td className="py-2.5 px-3 text-xs text-muted-foreground max-w-[100px] truncate">
          {c.title ?? <span className="text-muted-foreground/40">—</span>}
        </td>
        <td className="py-2.5 px-3">
          <ScoreBar score={c.leadScore} thresholds={thresholds} />
        </td>
        <td className="py-2.5 px-3 text-xs text-muted-foreground max-w-[100px] truncate">
          {c.identifier
            ? <span className="font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded border text-foreground">{c.identifier}</span>
            : <span className="text-muted-foreground/40">—</span>}
        </td>
        <td className="py-2.5 px-3">
          <div className="flex flex-wrap gap-1">
            {c.tags.slice(0, 2).map(t => (
              <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">{t}</span>
            ))}
            {c.tags.length > 2 && <span className="text-[10px] text-muted-foreground">+{c.tags.length - 2}</span>}
          </div>
        </td>
        <td className="py-2.5 px-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1 text-xs cursor-default">
                <BookOpen className="w-3 h-3 text-muted-foreground" />
                <span className={cn("font-medium tabular-nums", c.journeyCount > 0 ? "text-indigo-600" : "text-muted-foreground")}>
                  {c.journeyCount}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {c.journeyCount === 0 ? "Not in any journey" : `In ${c.journeyCount} journey${c.journeyCount !== 1 ? "s" : ""}`}
            </TooltipContent>
          </Tooltip>
        </td>
        <td className="py-2.5 px-3 text-xs text-muted-foreground capitalize whitespace-nowrap">
          {(c.source || "manual").replace(/_/g, " ")}
        </td>
        <td className="py-2.5 px-3"><SeqPill status={c.sequenceStatus} /></td>
        <td className="py-2.5 px-3 text-xs text-muted-foreground whitespace-nowrap">{relDate(c.lastActivity)}</td>
        <td className="py-2.5 px-3" onClick={e => e.stopPropagation()}>
          <button data-testid={`button-verify-${c.id}`} onClick={() => setVerifyFor({ id: c.id, name: displayName(c) })}
            className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border border-indigo-200 text-indigo-700 hover:bg-indigo-600 hover:text-white hover:border-indigo-600 transition-colors whitespace-nowrap">
            <ShieldCheck className="w-3 h-3" />{canEdit ? "Verify" : "View"}
          </button>
        </td>
        <td className="py-2.5 px-2 w-36" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-0.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => navigate(`/crm/contacts/${c.id}`)}>
                  <Users className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">View Profile</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" title="Assign to Journey">
                  <BookOpen className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <p className="px-2 py-1 text-[11px] text-muted-foreground font-semibold uppercase tracking-wide">Assign to Journey</p>
                {journeys.length === 0 && (
                  <p className="px-2 py-2 text-xs text-muted-foreground">No journeys yet</p>
                )}
                {journeys.slice(0, 8).map(j => {
                  const assigned = (c.journeyIds ?? []).includes(j.id);
                  return (
                    <DropdownMenuItem
                      key={j.id}
                      onSelect={e => { e.preventDefault(); handleRowToggleJourney(c.id, j.id, assigned); }}
                      className={cn(assigned && "bg-indigo-50/80 text-indigo-800")}
                    >
                      <BookOpen className={cn("w-3.5 h-3.5 mr-2 shrink-0", assigned ? "text-indigo-600" : "text-muted-foreground")} />
                      <span className="flex-1 truncate text-xs">{j.name}</span>
                      {assigned && <CheckSquare className="w-3 h-3 text-indigo-600 shrink-0" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => navigate("/sequences")}>
                  <GitBranch className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Enroll in Sequence</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => setDeleteId(c.id)}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">Delete</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44 text-sm">
                <DropdownMenuItem onClick={() => navigate(`/crm/contacts/${c.id}`)}>
                  <Users className="w-3.5 h-3.5 mr-2" /> View Profile
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate("/sequences")}>
                  <GitBranch className="w-3.5 h-3.5 mr-2" /> Enroll in Sequence
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate(`/crm/contacts/${c.id}`)}>
                  <Activity className="w-3.5 h-3.5 mr-2" /> Edit Contact
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleteId(c.id)}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete Contact
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Sidebar ── */}
      <aside className={cn("shrink-0 border-r bg-card flex flex-col overflow-hidden transition-all duration-200", sidebarCollapsed ? "w-9" : "w-[220px]")}>
        <div className={cn("border-b flex items-center gap-2", sidebarCollapsed ? "px-1.5 py-2.5 justify-center" : "px-3 py-2.5")}>
          {!sidebarCollapsed && (
            <div className="flex-1 min-w-0">
              <h2 className="text-xs font-semibold">Contact Database</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">{(totalDbCount ?? contacts.length).toLocaleString()} total contacts</p>
            </div>
          )}
          <button onClick={() => setSidebarCollapsed(v => !v)} className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0" title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {sidebarCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
          </button>
        </div>
        {sidebarCollapsed ? (
          <div className="flex-1 flex flex-col items-center gap-1 py-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={() => { setSidebarCollapsed(false); setSection("all"); }} className={cn("p-1.5 rounded hover:bg-muted transition-colors", section === "all" && "bg-indigo-50 text-indigo-700")}>
                  <Users className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">All Contacts</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={() => { setSidebarCollapsed(false); }} className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground">
                  <Tag className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">Segments</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={() => { setSidebarCollapsed(false); }} className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground">
                  <BarChart3 className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">Views</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        <div className={cn("flex-1 overflow-y-auto p-2", sidebarCollapsed && "hidden")}>

          {/* All Contacts */}
          <button onClick={() => setSection("all")}
            className={cn(
              "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left",
              section === "all" ? "bg-indigo-50 text-indigo-700 font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}>
            <Users className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">All Contacts</span>
            <span className="text-[11px] tabular-nums">{totalDbCount ?? contacts.length}</span>
          </button>

          {/* Segments */}
          <div className="mt-3">
            <div className="flex items-center justify-between px-2 mb-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Segments</p>
              <button onClick={() => navigate("/database/segments/new")} title="New segment" className="text-indigo-600 hover:text-indigo-800 transition-colors">
                <Plus className="w-3 h-3" />
              </button>
            </div>
            {segments.length === 0
              ? <p className="text-[11px] text-muted-foreground px-2 py-1">No segments yet</p>
              : segments.slice(0, 8).map(seg => (
                <button key={seg.id} onClick={() => navigate(`/database/segments/${seg.id}`)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors text-left">
                  {seg.segment_type === "static" ? <Tag className="w-3 h-3 shrink-0" /> : <Zap className="w-3 h-3 shrink-0" />}
                  <span className="flex-1 truncate text-xs">{seg.name}</span>
                  <span className="text-[10px] tabular-nums">{seg.last_computed_count}</span>
                </button>
              ))}
            {segments.length > 8 && (
              <button onClick={() => navigate("/database/segments")} className="px-2 py-0.5 text-[11px] text-indigo-600 hover:text-indigo-800">
                View all →
              </button>
            )}
          </div>

          {/* Views */}
          <div className="mt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-2 mb-1">Views</p>
            {SIDEBAR_VIEWS.map(({ key, label, Icon }) => (
              <button key={key} onClick={() => setSection(key)}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors text-left",
                  section === key ? "bg-indigo-50 text-indigo-700 font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}>
                <Icon className="w-3 h-3 shrink-0" />
                <span className="text-xs">{label}</span>
              </button>
            ))}
          </div>

          {/* Journeys with contacts */}
          {journeysWithContacts.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-2 mb-1">Journeys</p>
              {journeysWithContacts.map(j => (
                <button key={j.id} onClick={() => setSection(`journey:${j.id}`)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors text-left",
                    section === `journey:${j.id}` ? "bg-indigo-50 text-indigo-700 font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}>
                  <BookOpen className="w-3 h-3 shrink-0" />
                  <span className="flex-1 truncate text-xs">{j.name}</span>
                  <span className="text-[10px] tabular-nums">{j.contactCount}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ── Main Content ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Toolbar */}
        <div className="border-b bg-card px-4 py-2.5 flex items-center gap-2 shrink-0 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input placeholder="Search contacts…" value={search} onChange={e => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm w-52" />
          </div>

          <div className="relative">
            <Tag className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input placeholder="Filter by identifier…" value={identifierFilter} onChange={e => setIdentifierFilter(e.target.value)}
              className={cn("pl-8 h-8 text-sm w-44", identifierFilter.trim() && "border-indigo-300 bg-indigo-50/50")} />
          </div>

          {/* Score presets */}
          <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
            {PRESETS.map(p => (
              <button key={p.key} onClick={() => applyPreset(p.key)}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                  preset === p.key ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}>
                {p.label}
              </button>
            ))}
          </div>

          <Button variant="outline" size="sm"
            className={cn("h-8 text-xs gap-1", showSlider && "bg-indigo-50 border-indigo-200 text-indigo-700")}
            onClick={() => setShowSlider(v => !v)}>
            <LayoutList className="w-3 h-3" />
            {scoreRange[0]}–{scoreRange[1]}
          </Button>

          <Button
            variant={groupCo ? "default" : "outline"} size="sm"
            className={cn("h-8 text-xs gap-1", groupCo && "bg-indigo-600 hover:bg-indigo-700 text-white")}
            onClick={() => setGroupCo(v => !v)}>
            <Group className="w-3 h-3" /> By Company
          </Button>

          <select
            value={stageFilter}
            onChange={e => setStageFilter(e.target.value)}
            className={cn(
              "h-8 text-xs px-2 rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-indigo-500",
              stageFilter !== "all" && "border-indigo-300 bg-indigo-50 text-indigo-700"
            )}
          >
            <option value="all">All Stages</option>
            <option value="pre-aware">Pre-Aware</option>
            <option value="aware">Aware</option>
            <option value="evaluating">Evaluating</option>
            <option value="ready">Ready</option>
            <option value="champion">Champion</option>
          </select>

          <select
            value={sourceFilter}
            onChange={e => setSourceFilter(e.target.value)}
            className={cn(
              "h-8 text-xs px-2 rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-indigo-500",
              sourceFilter !== "all" && "border-indigo-300 bg-indigo-50 text-indigo-700"
            )}
          >
            <option value="all">All Sources</option>
            <option value="manual">Manual Entry</option>
            <option value="web_form">Web Form</option>
            <option value="import">Import</option>
            <option value="crm_sync">CRM Sync</option>
            <option value="api">API</option>
          </select>

          <div className="flex-1" />
          <span className="text-xs text-muted-foreground">{filtered.length} contacts</span>
          <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={exportCsv}>
            <Download className="w-3.5 h-3.5" /> Export
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={!canEdit} title={canEdit ? undefined : "View-only access"} onClick={() => setCsvImportOpen(true)}>
            <Upload className="w-3.5 h-3.5" /> Import CSV
          </Button>
          <Button size="sm" className="h-8 bg-indigo-600 hover:bg-indigo-700 gap-1 text-xs" onClick={() => navigate("/database/segments/new")}>
            <Plus className="w-3.5 h-3.5" /> Segment
          </Button>
        </div>

        {/* Score slider */}
        {showSlider && (
          <div className="border-b bg-muted/20 px-4 py-2 flex items-center gap-4 shrink-0">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Score range</span>
            <Slider value={scoreRange}
              onValueChange={v => { setScoreRange(v as [number, number]); setPreset("custom"); }}
              min={0} max={200} step={5} className="flex-1 max-w-xs" />
            <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums w-20">{scoreRange[0]} – {scoreRange[1]}</span>
            <button onClick={() => { setPreset("all"); setScoreRange([0, 200]); }}
              className="text-xs text-indigo-600 hover:text-indigo-800 transition-colors">Reset</button>
          </div>
        )}

        {/* Filter chips */}
        {chips.length > 0 && (
          <div className="border-b bg-card px-4 py-1.5 flex items-center gap-2 shrink-0 flex-wrap">
            {chips.map(chip => (
              <span key={chip.label} className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 text-[11px] px-2 py-0.5 rounded-full border border-indigo-200">
                {chip.label}
                <button onClick={chip.clear} className="hover:text-indigo-900"><X className="w-2.5 h-2.5" /></button>
              </span>
            ))}
            <button onClick={() => { setSearch(""); setPreset("all"); setScoreRange([0, 200]); setStageFilter("all"); setSourceFilter("all"); setIdentifierFilter(""); }}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors ml-1">Clear all</button>
          </div>
        )}

        <DatabaseOverview
          selectedDatabaseId={databaseId}
          selectedDataset={dataset}
          onSelectDatabase={db => { setDatabaseId(db?.id ?? null); setDataset(null); }}
          onSelectDataset={setDataset}
          onOpenSegment={id => { setSection(`segment:${id}`); setDataset(null); }}
        />

        {/* Pre-built views */}
        {isSpecialView && (
          <>
            {section === "view:score-tiers"      && <ScoreTiersView contacts={filtered} thresholds={thresholds} journeys={journeys} />}
            {section === "view:by-company"        && <ByCompanyView contacts={filtered} thresholds={thresholds} />}
            {section === "view:by-source"         && <BySourceView contacts={filtered} thresholds={thresholds} />}
            {section === "view:journey-coverage"  && <JourneyCoverageView contacts={filtered} thresholds={thresholds} />}
            {section === "view:sequence-gaps"     && <SequenceGapsView contacts={filtered} />}
          </>
        )}

        {/* Table */}
        {!isSpecialView && (
          <div className="flex-1 overflow-auto">
            {isLoading ? (
              <div className="flex items-center justify-center h-48">
                <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <Users className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm">No contacts match your filters</p>
                {chips.length > 0 && (
                  <button onClick={() => { setSearch(""); setPreset("all"); setScoreRange([0, 200]); }}
                    className="mt-2 text-xs text-indigo-600 hover:underline">Clear filters</button>
                )}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card border-b z-10">
                  <tr>
                    <th className="w-8 py-2.5 pl-3">
                      <button onClick={toggleAll} className="opacity-60 hover:opacity-100 transition-opacity flex items-center">
                        {selected.size > 0 && selected.size === filtered.length
                          ? <CheckSquare className="w-3.5 h-3.5 text-indigo-600" />
                          : <Square className="w-3.5 h-3.5 text-muted-foreground" />}
                      </button>
                    </th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">
                      <button className="flex items-center gap-1 hover:text-foreground transition-colors" onClick={() => toggleSort("name")}>
                        Contact {sortF === "name" && <ChevronDown className={cn("w-3 h-3", sortD === "asc" && "rotate-180")} />}
                      </button>
                    </th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">Email</th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">Company</th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">Title</th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">
                      <button className="flex items-center gap-1 hover:text-foreground transition-colors" onClick={() => toggleSort("leadScore")}>
                        Score {sortF === "leadScore" && <ChevronDown className={cn("w-3 h-3", sortD === "asc" && "rotate-180")} />}
                      </button>
                    </th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">Identifier</th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">Tags</th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">Journeys</th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">Source</th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">Sequence</th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground">
                      <button className="flex items-center gap-1 hover:text-foreground transition-colors" onClick={() => toggleSort("lastActivity")}>
                        Last Active {sortF === "lastActivity" && <ChevronDown className={cn("w-3 h-3", sortD === "asc" && "rotate-180")} />}
                      </button>
                    </th>
                    <th className="text-left py-2.5 px-3 text-[11px] font-semibold text-muted-foreground whitespace-nowrap">Verify details</th>
                    <th className="w-9" />
                  </tr>
                </thead>
                <tbody>
                  {grouped
                    ? Array.from(grouped.entries()).flatMap(([company, members]) => {
                        const open  = expanded.has(company);
                        const avg   = Math.round(members.reduce((s, c) => s + c.leadScore, 0) / members.length);
                        const totalJ = members.reduce((s, c) => s + c.journeyCount, 0);
                        const style = tStyle(getTier(avg, thresholds).label);
                        return [
                          <tr key={`g:${company}`} className="bg-muted/40 border-b">
                            <td colSpan={14} className="pl-3 pr-4 py-2">
                              <button onClick={() => toggleExpand(company)} className="flex items-center gap-2 w-full text-left">
                                {open
                                  ? <ChevronDown  className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                  : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                                <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                <span className="text-xs font-semibold">{company}</span>
                                <span className="text-xs text-muted-foreground ml-1">({members.length})</span>
                                <span className={cn("text-xs font-semibold ml-3", style.text)}>avg {avg}</span>
                                {totalJ > 0 && <span className="text-xs text-muted-foreground ml-2">· {totalJ} journey{totalJ !== 1 ? "s" : ""}</span>}
                                {members.reduce((s, c) => s + (c.emailCount ?? 0), 0) > 0 && (
                                  <span className="text-xs text-muted-foreground ml-2">
                                    · <Mail className="w-3 h-3 inline -mt-0.5" /> {members.reduce((s, c) => s + (c.emailCount ?? 0), 0)} emails
                                  </span>
                                )}
                              </button>
                            </td>
                          </tr>,
                          ...(open ? members.map(c => <ContactRow key={c.id} c={c} />) : []),
                        ];
                      })
                    : filtered.map(c => <ContactRow key={c.id} c={c} />)
                  }
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Pagination footer */}
        {totalDbCount !== null && totalDbCount > DB_PAGE_SIZE && (
          <div className="border-t bg-card px-4 py-2 flex items-center justify-between shrink-0 text-xs text-muted-foreground">
            <span>
              Showing {((dbPage - 1) * DB_PAGE_SIZE) + 1}–{Math.min(dbPage * DB_PAGE_SIZE, totalDbCount)} of {totalDbCount.toLocaleString()} contacts
            </span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1"
                disabled={dbPage <= 1}
                onClick={() => setDbPage(p => Math.max(1, p - 1))}>
                <ChevronLeft className="w-3.5 h-3.5" /> Prev
              </Button>
              <span className="px-2 tabular-nums">Page {dbPage} of {Math.ceil(totalDbCount / DB_PAGE_SIZE)}</span>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1"
                disabled={dbPage >= Math.ceil(totalDbCount / DB_PAGE_SIZE)}
                onClick={() => setDbPage(p => p + 1)}>
                Next <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}

        {/* Bulk bar */}
        {selected.size > 0 && (
          <div className="border-t bg-card px-4 py-2.5 flex items-center gap-3 shrink-0">
            <CheckSquare className="w-4 h-4 text-indigo-600" />
            <span className="text-sm font-medium">{selected.size} selected</span>
            <Button size="sm" className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700 gap-1" onClick={() => setBulkOpen(true)}>
              <BookOpen className="w-3 h-3" /> Assign to Journey
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setSelected(new Set())}>
              <X className="w-3 h-3" /> Clear
            </Button>
          </div>
        )}
      </div>

      {/* Journey picker (single) */}
      <JourneyPickerDialog
        open={pickerCid !== null}
        onClose={() => setPickerCid(null)}
        title="Assign to Journey"
        journeys={journeys}
        assignedIds={pickerJids}
        onToggle={handleToggleJourney}
        busy={pickerBusy}
      />

      {/* Bulk assign */}
      <BulkAssignDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        count={selected.size}
        journeys={journeys}
        onAssign={handleBulkAssign}
        busy={false}
      />

      <VerifyDetailsDialog
        contactId={verifyFor?.id ?? null}
        contactName={verifyFor?.name ?? ""}
        canEdit={canEdit}
        onClose={() => setVerifyFor(null)}
      />

      {/* CSV Import Modal */}
      <CsvImportModal
        open={csvImportOpen}
        onClose={() => setCsvImportOpen(false)}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: ["db-contacts"] });
          qc.invalidateQueries({ queryKey: ["/api/contact-databases"] });
        }}
      />

      {/* Delete confirmation */}
      <AlertDialog open={deleteId !== null} onOpenChange={open => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete contact?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the contact and all associated data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteId !== null && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
