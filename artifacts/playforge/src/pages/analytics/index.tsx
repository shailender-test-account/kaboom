import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import HpBiDashboard from "@/components/analytics/hp-bi/HpBiDashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  exportTrafficExcel, exportTrafficPdf,
  exportStageExcel, exportStagePdf,
  exportContentExcel, exportContentPdf,
  exportSourceExcel, exportSourcePdf,
  exportUsersExcel, exportUsersPdf,
  exportScrollDepthExcel, exportScrollDepthPdf,
  exportAbmExcel, exportAbmPdf,
  exportAccountIntelExcel, exportAccountIntelPdf,
  exportVelocityExcel, exportVelocityPdf,
  exportScoreIntelExcel, exportScoreIntelPdf,
  exportCallsExcel, exportCallsPdf,
} from "@/lib/analyticsExportDeferred";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, Legend,
  PieChart, Pie, Cell,
} from "recharts";
import {
  Eye, Users, FileText, Download, TrendingUp, Activity,
  Globe, Mail, ArrowLeft, X, Filter, Clock, Zap,
  ChevronRight, Star, FileSpreadsheet, FileDown, ChevronDown, Map, Copy, Check,
  Sparkles, SendHorizonal, RotateCcw, ChevronDown as ChevronDownIcon, PhoneOff,
  Link, MousePointerClick, Loader2, UserX,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDistanceToNow, differenceInDays, differenceInHours, parseISO } from "date-fns";
import { formatReportDate, formatReportDateTime, formatReportDayLabel, formatReportTime, REPORT_TIME_ZONE } from "@/lib/reportTime";
import { cn } from "@/lib/utils";
import { ContactTimelinePanel } from "@/components/analytics/ContactTimelinePanel";
import { AccountSheet, AccountsAnalyticsPanel } from "@/components/analytics/AccountsAnalyticsPanel";
import { SourceBadges, SourceIcons, SourceLegend, useAcquisition } from "@/components/analytics/AcquisitionProvenance";
import { GtmStatusBadge, useGtmStatuses, type GtmStatuses } from "@/components/analytics/GtmStatusBadge";
import { InboundJourneyPanel } from "./InboundJourneyPanel";
import { IntentOpportunityTimeline } from "./IntentOpportunityTimeline";

const api = (path: string) =>
  fetch(`/api${path}`, { credentials: "include" }).then(r => {
    if (!r.ok) throw new Error(`Analytics request failed (${r.status})`);
    return r.json();
  });

const trafficApi = (path: string) =>
  fetch(`/api${path}`, { credentials: "include" }).then(r => {
    if (!r.ok) throw new Error(`Traffic analytics request failed (${r.status})`);
    return r.json();
  });

const qs = (params: Record<string, string>) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) p.set(k, v); });
  const s = p.toString();
  return s ? `?${s}` : "";
};

const STAGE_ORDER = ["pre-aware","aware","pre-engage","engage","advance-engage","action"];
const STAGE_LABELS: Record<string,string> = {
  "pre-aware":"Pre-Aware","aware":"Aware","pre-engage":"Pre-Engage",
  "engage":"Engage","advance-engage":"Adv-Engage","action":"Action",
};
const STAGE_COLORS: Record<string,string> = {
  "pre-aware":"#94a3b8","aware":"#60a5fa","pre-engage":"#a78bfa",
  "engage":"#34d399","advance-engage":"#f59e0b","action":"#f43f5e",
};
const STAGE_BG: Record<string,string> = {
  "pre-aware":"bg-slate-100 text-slate-700",
  "aware":"bg-blue-100 text-blue-700",
  "pre-engage":"bg-violet-100 text-violet-700",
  "engage":"bg-emerald-100 text-emerald-700",
  "advance-engage":"bg-amber-100 text-amber-700",
  "action":"bg-rose-100 text-rose-700",
};
const EVENT_ICONS: Record<string,string> = {
  email_open:"📧",email_click:"🔗",page_view:"👁",asset_download:"📥",form_submit:"📝",
};
const DONUT_COLORS = ["#6366f1","#06b6d4","#a78bfa","#34d399","#f59e0b","#f43f5e"];

interface Filters {
  clientId: string; inboundAccountIds: string[]; inboundOnly: boolean; playId: string; journeyId: string;
  stages: string[]; companyIds: string[];
  scoreMin: string; scoreMax: string; dateFrom: string; dateTo: string;
}
const EMPTY_FILTERS: Filters = {
  clientId:"",inboundAccountIds:[],inboundOnly:false,playId:"",journeyId:"",stages:[],companyIds:[],
  scoreMin:"",scoreMax:"",dateFrom:"",dateTo:"",
};

// Read journey/client pre-filter from URL on first mount.
// Used by deep-links e.g. from Contest Entries: /analytics?journeyId=42
function getFiltersFromUrl(): Filters {
  try {
    const p = new URLSearchParams(window.location.search);
    return {
      ...EMPTY_FILTERS,
      journeyId: p.get("journeyId") ?? "",
      clientId:  p.get("clientId")  ?? "",
    };
  } catch { return EMPTY_FILTERS; }
}

// ── Multi-select dropdown with optional search ─────────────────────────────────
function MultiSelectDropdown({
  options, selected, onChange, placeholder, searchable = false, width = "130px", onInteract, disabled = false, allLabel,
  allSelected, onAll, noneLabel, onNone,
}: {
  options: { value: string; label: string; badge?: string }[];
  selected: string[];
  onChange: (vals: string[]) => void;
  placeholder: string;
  searchable?: boolean;
  width?: string;
  onInteract?: () => void;
  disabled?: boolean;
  allLabel?: string;
  allSelected?: boolean;
  onAll?: () => void;
  noneLabel?: string;
  onNone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const filtered = search
    ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;
  const toggle = (val: string) =>
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  const triggerLabel =
    selected.length === 0 ? placeholder
    : selected.length === 1 ? (options.find(o => o.value === selected[0])?.label ?? selected[0])
    : `${selected.length} selected`;
  return (
    <div ref={ref} className="relative" style={{ width }}>
      <button
        type="button"
        disabled={disabled}
        aria-label={placeholder}
        aria-expanded={open}
        className="h-7 text-xs w-full px-2 flex items-center justify-between gap-1 rounded-md border border-input bg-background hover:border-indigo-400 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={() => { onInteract?.(); setSearch(""); setOpen(v => !v); }}
      >
        <span className="truncate text-foreground">{triggerLabel}</span>
        <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className={cn("absolute z-50 top-8 left-0 bg-white border border-border rounded-md shadow-lg", searchable ? "w-[min(360px,calc(100vw-2rem))]" : "min-w-[200px]")}>
          {searchable && (
            <div className="p-2 border-b">
              <input
                autoFocus
                className="w-full text-xs px-2 py-1 border border-input rounded outline-none focus:border-indigo-400"
                placeholder={allLabel ? "Search inbound accounts…" : "Search…"}
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}
              />
            </div>
          )}
          <div className="overflow-auto max-h-60 py-1">
            {noneLabel && (
              <button type="button" aria-pressed={!allSelected && selected.length === 0}
                className="w-full text-left px-3 py-1.5 text-xs text-indigo-600 hover:bg-indigo-50 font-medium flex items-center justify-between"
                onClick={() => { onNone?.(); setOpen(false); }}>
                {noneLabel}
                {!allSelected && selected.length === 0 && <Check className="w-3 h-3" />}
              </button>
            )}
            {(allLabel || selected.length > 0) && (
              <button
                type="button"
                aria-pressed={allLabel ? (allSelected ?? selected.length === 0) : undefined}
                className="w-full text-left px-3 py-1.5 text-xs text-indigo-600 hover:bg-indigo-50 font-medium flex items-center justify-between"
                onClick={() => { if (onAll) onAll(); else onChange([]); setOpen(false); }}
              >
                {allLabel ?? "Clear selection"}
                {allLabel && (allSelected ?? selected.length === 0) && <Check className="w-3 h-3" />}
              </button>
            )}
            {filtered.map(opt => (
              <label key={opt.value} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/50 select-none">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggle(opt.value)}
                  className="w-3 h-3 rounded accent-indigo-600"
                />
                <span className="min-w-0 flex-1 break-words">{opt.label}</span>
                {opt.badge && <span className="text-[9px] text-muted-foreground shrink-0">{opt.badge}</span>}
              </label>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground italic">No results</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface DrillState { open: boolean; title: string; extraParams: Record<string,string>; }

function StageBadge({ stage }: { stage: string }) {
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold", STAGE_BG[stage] ?? "bg-gray-100 text-gray-700")}>
      {STAGE_LABELS[stage] ?? stage}
    </span>
  );
}

function ScoreBar({ score, max = 100 }: { score: number; max?: number }) {
  const pct = Math.min(100, (score / max) * 100);
  const color = score >= 75 ? "#f43f5e" : score >= 50 ? "#f59e0b" : score >= 25 ? "#34d399" : "#94a3b8";
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden min-w-[40px]">
        <div className="h-full rounded-full transition-all" style={{ background: color, width: `${pct}%` }} />
      </div>
      <span className="text-xs font-semibold tabular-nums w-7 text-right shrink-0">{score}</span>
    </div>
  );
}

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(" ");
  const init = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return (
    <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[11px] font-bold shrink-0">
      {init.toUpperCase()}
    </div>
  );
}

// ── Export Menu ────────────────────────────────────────────────────────────────
function ExportMenu({ onExcel, onPdf, disabled = false }: {
  onExcel: () => void; onPdf: () => void; disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" disabled={disabled}>
          <Download className="w-3.5 h-3.5" />
          Export
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onExcel} className="gap-2 cursor-pointer">
          <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
          <div>
            <p className="text-xs font-medium">Excel (.xlsx)</p>
            <p className="text-[10px] text-muted-foreground">Multi-sheet workbook</p>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onPdf} className="gap-2 cursor-pointer">
          <FileDown className="w-4 h-4 text-indigo-600" />
          <div>
            <p className="text-xs font-medium">PDF Report</p>
            <p className="text-[10px] text-muted-foreground">Branded dashboard PDF</p>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function stageDuration(from: string, to: string | null) {
  const start = parseISO(from);
  const end = to ? parseISO(to) : new Date();
  const days = differenceInDays(end, start);
  if (days >= 1) return `${days}d`;
  const hrs = differenceInHours(end, start);
  return `${hrs}h`;
}

// ── Contact Timeline Panel ─────────────────────────────────────────────────────
const CALL_OUTCOME_STYLES: Record<string, string> = {
  interested:     "text-emerald-700 bg-emerald-50 border-emerald-200",
  callback:       "text-blue-700 bg-blue-50 border-blue-200",
  answered:       "text-slate-700 bg-slate-50 border-slate-200",
  not_interested: "text-red-600 bg-red-50 border-red-200",
  no_answer:      "text-gray-500 bg-gray-50 border-gray-200",
  dnc:            "text-orange-700 bg-orange-50 border-orange-200",
};

function CallLogEntry({ cl }: { cl: any }) {
  const hasDetail = !!(cl.aiSummary || cl.transcriptText);
  const [expanded, setExpanded] = useState(hasDetail);
  const [showTx, setShowTx] = useState(false);
  return (
    <div className="border border-border rounded-lg overflow-hidden text-xs">
      <button
        className={cn("w-full text-left px-3 py-2 flex items-center gap-2 transition-colors", hasDetail ? "hover:bg-indigo-50/50 cursor-pointer" : "")}
        onClick={() => hasDetail && setExpanded(v => !v)}
        disabled={!hasDetail}
      >
        <span className="text-base">📞</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {cl.outcome && (
              <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold", CALL_OUTCOME_STYLES[cl.outcome] ?? "text-gray-600 bg-gray-50 border-gray-200")}>
                {cl.outcome.replace(/_/g, " ")}
              </span>
            )}
            {cl.durationSeconds != null && (
              <span className="text-[10px] text-muted-foreground tabular-nums">{cl.durationSeconds}s</span>
            )}
            {cl.endedReason && (
              <span className="text-[9px] font-mono text-muted-foreground">{cl.endedReason}</span>
            )}
            {cl.campaignName && (
              <span className="text-[10px] text-muted-foreground truncate max-w-[100px]">{cl.campaignName}</span>
            )}
          </div>
          {cl.startedAt && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {formatReportDateTime(cl.startedAt)}
            </p>
          )}
        </div>
        {hasDetail && (
          <span className="text-[10px] text-indigo-500 shrink-0">{expanded ? "▲" : "▼"}</span>
        )}
      </button>
      {expanded && (
        <div className="border-t px-3 pb-3 pt-2 space-y-2 bg-slate-50/50">
          {cl.aiSummary && (
            <div className="bg-white border border-indigo-100 rounded p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600 mb-1">🤖 AI Summary</p>
              <p className="text-[11px] text-slate-700 leading-relaxed">{cl.aiSummary}</p>
            </div>
          )}
          {cl.aiNextSteps && (
            <div className="bg-white border border-emerald-100 rounded p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1">✅ Next Steps</p>
              <div className="space-y-1">
                {cl.aiNextSteps.split("\n").filter(Boolean).map((s: string, i: number) => (
                  <p key={i} className="text-[11px] text-slate-700">{s}</p>
                ))}
              </div>
            </div>
          )}
          {cl.transcriptText && (
            <div>
              <button
                className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium"
                onClick={e => { e.stopPropagation(); setShowTx(v => !v); }}
              >
                {showTx ? "▲ hide transcript" : "▼ show transcript"}
              </button>
              {showTx && (
                <div className="mt-1.5 max-h-40 overflow-y-auto bg-white border border-indigo-100 rounded p-2 text-[10px] font-mono text-slate-700 whitespace-pre-wrap leading-relaxed">
                  {cl.transcriptText}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LegacyContactTimelinePanel({ contactId }: { contactId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["contacts", contactId, "timeline"],
    queryFn: () => api(`/contacts/${contactId}/timeline`),
  });

  if (isLoading) return <div className="p-4 space-y-3">{Array.from({length:5}).map((_,i)=><Skeleton key={i} className="h-12"/>)}</div>;
  if (!data) return <div className="p-4 text-sm text-muted-foreground">No data</div>;

  const { contact, timeline, stageHistory, callLogs } = data as {
    contact: any; timeline: any[]; stageHistory: any[]; callLogs?: any[];
  };

  const stageDurations = STAGE_ORDER.map((stage, i) => {
    const entry = stageHistory.find((s: any) => s.toStage === stage);
    if (!entry) return null;
    const nextEntry = stageHistory.find((s: any) => s.toStage === STAGE_ORDER[i + 1]);
    const duration = stageDuration(entry.achievedAt, nextEntry?.achievedAt ?? null);
    return { stage, achievedAt: entry.achievedAt, duration, score: entry.scoreAtTransition };
  }).filter(Boolean);

  const intentCfg2 = INTENT_STATE_MINI_CFG[contact.intentState ?? "Browsing"] ?? INTENT_STATE_MINI_CFG["Browsing"];

  return (
    <div className="overflow-y-auto">
      {/* Contact header */}
      <div className="px-4 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-3">
          <Initials name={`${contact.firstName} ${contact.lastName}`} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">{contact.firstName} {contact.lastName}</p>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <StageBadge stage={contact.stage ?? "pre-aware"} />
              <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold", intentCfg2.bg, intentCfg2.text)}>
                {intentCfg2.icon} {contact.intentState ?? "Browsing"}
              </span>
              <span className="text-xs text-muted-foreground">Score: <span className="font-semibold text-foreground">{contact.leadScore}</span></span>
              {(contact.intentScore ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">Intent: <span className="font-semibold text-foreground">{contact.intentScore}</span></span>
              )}
            </div>
            {contact.suggestedNextAction && (
              <p className="text-[11px] text-indigo-600 mt-1 truncate">→ {contact.suggestedNextAction}</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Score Breakdown ──────────────────────────────────────────────── */}
      {contact.intentScore > 0 && (() => {
        const engContrib  = Number(contact.engagementScore ?? 0) * Number(contact.freqScore ?? 1);
        const stageContrib    = Number(contact.maxStageScore ?? 0);
        const velocityContrib = Number(contact.velocityBonus ?? 0);
        const accountContrib  = Number(contact.accountBonus ?? 0);
        const rawTotal = Math.max(engContrib + stageContrib + velocityContrib + accountContrib, 0.01);

        const velocityLabel =
          velocityContrib >= 15 ? "Strong acceleration this week (2×+ more events than prior week)" :
          velocityContrib >= 10 ? "Fresh surge — new activity after a quiet period" :
          velocityContrib >= 8  ? "Moderate acceleration this week (1.3×+ more events)" :
          "No velocity signal this period";

        const signals: { label: string; value: number; bar: string; text: string; sub: string }[] = [
          {
            label: "Engagement × Frequency",
            value: engContrib,
            bar:  "bg-indigo-500",
            text: "text-indigo-600",
            sub:  `${Number(contact.engagementScore ?? 0).toFixed(1)} session quality × ${Number(contact.freqScore ?? 1).toFixed(2)} freq multiplier · ${contact.distinctActiveDays ?? 0} active day${contact.distinctActiveDays !== 1 ? "s" : ""}`,
          },
          {
            label: "Stage Progression Bonus",
            value: stageContrib,
            bar:  "bg-violet-500",
            text: "text-violet-600",
            sub:  `Deepest stage reached: ${(contact.stage ?? "pre-aware").replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}`,
          },
          {
            label: "Velocity / Momentum",
            value: velocityContrib,
            bar:  "bg-emerald-500",
            text: "text-emerald-600",
            sub:  velocityLabel,
          },
          {
            label: "Account ABM Bonus",
            value: accountContrib,
            bar:  "bg-amber-500",
            text: "text-amber-600",
            sub:  (contact.accountColleagues ?? 0) > 0
              ? `${contact.accountColleagues} active colleague${contact.accountColleagues !== 1 ? "s" : ""} at the same company in last 30d`
              : "No other contacts at this company active recently",
          },
        ];

        return (
          <div className="px-4 py-3 border-b">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">How Intent Score Was Calculated</p>

            {/* Score totals row */}
            <div className="flex items-start gap-4 mb-4">
              <div className="flex-1">
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-black tabular-nums text-indigo-600">{contact.intentScore}</span>
                  <span className="text-sm text-muted-foreground">&thinsp;/ 100</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">Intent Score</p>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold tabular-nums text-slate-700">{contact.leadScore}</p>
                <p className="text-[11px] text-muted-foreground">Activity Score (pts)</p>
              </div>
            </div>

            {/* Signal bars */}
            <div className="space-y-3">
              {signals.map(sig => (
                <div key={sig.label}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-medium">{sig.label}</span>
                    <span className={cn("text-[11px] font-bold tabular-nums", sig.value > 0 ? sig.text : "text-muted-foreground")}>
                      {sig.value > 0 ? `+${sig.value.toFixed(1)}` : "—"}
                    </span>
                  </div>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={cn("h-full rounded-full", sig.bar)}
                      style={{ width: `${Math.min((sig.value / rawTotal) * 100, 100)}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{sig.sub}</p>
                </div>
              ))}

              {/* Formula footer */}
              <div className="pt-2 border-t space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">Raw total (sum of signals)</span>
                  <span className="text-[11px] font-mono font-semibold">{contact.rawIntentScore}</span>
                </div>
                {Number(contact.rawIntentScore) > 100 && (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">Capped at 100 →</span>
                    <span className="text-[11px] font-mono font-semibold text-indigo-600">{contact.intentScore}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Stage journey */}
      {stageDurations.length > 0 && (
        <div className="px-4 py-3 border-b">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">Stage Journey</p>
          <div className="space-y-1.5">
            {stageDurations.map((sd: any, i: number) => (
              <div key={sd.stage} className="flex items-center gap-2">
                <StageBadge stage={sd.stage} />
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Clock className="w-3 h-3" />
                  <span>{sd.duration}</span>
                </div>
                <span className="text-[11px] text-muted-foreground ml-auto">at score {sd.score}</span>
                {i < stageDurations.length - 1 && (
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Call History ──────────────────────────────────────────────────── */}
      {callLogs && callLogs.length > 0 && (
        <div className="px-4 py-3 border-b">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            📞 Call History ({callLogs.length})
          </p>
          <div className="space-y-2">
            {callLogs.map((cl: any) => (
              <CallLogEntry key={cl.id} cl={cl} />
            ))}
          </div>
        </div>
      )}

      {/* Activity timeline */}
      <div className="px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Activity Timeline</p>
        <div className="space-y-0">
          {timeline.map((evt: any, i: number) => (
            <div key={evt.id} className="relative">
              {i < timeline.length - 1 && (
                <div className="absolute left-3.5 top-8 bottom-0 w-px bg-border" />
              )}
              {evt.isStageChange && (
                <div className="flex items-center gap-2 my-1.5 ml-8">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[10px] text-muted-foreground">
                    {STAGE_LABELS[evt.fromStage ?? ""] ?? evt.fromStage} → <span className="font-semibold" style={{ color: STAGE_COLORS[evt.toStage] }}>{STAGE_LABELS[evt.toStage] ?? evt.toStage}</span>
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="flex items-start gap-3 py-2">
                <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-sm shrink-0 z-10">
                  {EVENT_ICONS[evt.eventType] ?? "•"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-foreground leading-snug">{evt.description}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(evt.createdAt), { addSuffix: true })}
                    </span>
                    {evt.scoreDelta > 0 && (
                      <span className="text-[10px] font-semibold text-emerald-600">+{evt.scoreDelta}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto">score {evt.cumulativeScore}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Contact List Panel ─────────────────────────────────────────────────────────
const INTENT_STATE_MINI_CFG: Record<string, { bg: string; text: string; icon: string }> = {
  "Decision-Action":   { bg: "bg-red-100",    text: "text-red-700",    icon: "🔥" },
  "Evaluating-Engage": { bg: "bg-orange-100", text: "text-orange-700", icon: "🔆" },
  "Stuck-PreEngage":   { bg: "bg-amber-100",  text: "text-amber-700",  icon: "⚡" },
  "Re-engaging":       { bg: "bg-cyan-100",   text: "text-cyan-700",   icon: "🔄" },
  "Stuck-Aware":       { bg: "bg-blue-100",   text: "text-blue-700",   icon: "🌊" },
  "Browsing":          { bg: "bg-gray-100",   text: "text-gray-600",   icon: "👀" },
  "Dormant":           { bg: "bg-slate-100",  text: "text-slate-500",  icon: "❄️" },
};

export function ContactListPanel({
  contacts, loading, onSelect, gtmStatuses, gtmLoading, gtmError,
}: {
  contacts: any[];
  loading: boolean;
  onSelect: (id: number, name: string) => void;
  gtmStatuses: GtmStatuses;
  gtmLoading: boolean;
  gtmError: boolean;
}) {
  if (loading) return <div className="p-4 space-y-3">{Array.from({length:6}).map((_,i)=><Skeleton key={i} className="h-14"/>)}</div>;
  if (!contacts.length) return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
      <Users className="w-8 h-8 opacity-30" />
      <p className="text-sm">No contacts match these filters</p>
    </div>
  );
  return (
    <div className="divide-y divide-border overflow-y-auto">
      {contacts.map((c: any) => {
        const intentState = c.intentState ?? c.intent_state ?? null;
        const intentScore = c.intentScore ?? c.intent_score ?? null;
        const suggestedNextAction = c.suggestedNextAction ?? c.suggested_next_action ?? null;
        const intentCfg = intentState ? (INTENT_STATE_MINI_CFG[intentState] ?? INTENT_STATE_MINI_CFG["Browsing"]) : null;
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id, `${c.first_name} ${c.last_name}`)}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
          >
            <Initials name={`${c.first_name} ${c.last_name}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium truncate">{c.first_name} {c.last_name}</p>
                <GtmStatusBadge scope="contact" status={gtmStatuses[String(c.id)]} loading={gtmLoading} error={gtmError} />
                <StageBadge stage={c.stage ?? "pre-aware"} />
                {intentCfg && intentState && (
                  <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold", intentCfg.bg, intentCfg.text)}>
                    {intentCfg.icon} {intentState}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground truncate">{c.email} {c.company_name ? `· ${c.company_name}` : ""}</p>
              <div className="mt-1 flex items-center gap-3">
                <div className="w-28">
                  <ScoreBar score={intentScore != null ? Number(intentScore) : (c.lead_score ?? 0)} />
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  intent: <span className="font-semibold text-foreground">{intentScore ?? c.lead_score ?? 0}</span>
                </span>
              </div>
              {suggestedNextAction && (
                <p className="text-[10px] text-indigo-600 mt-0.5 truncate">→ {suggestedNextAction}</p>
              )}
              {(c.freq_score != null || c.max_stage_score != null || c.engagement_score != null) && (
                <div className="flex gap-3 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">freq: <span className="font-mono">{Number(c.freq_score ?? 0).toFixed(2)}</span></span>
                  <span className="text-[10px] text-muted-foreground">stage: <span className="font-mono">{Number(c.max_stage_score ?? 0).toFixed(2)}</span></span>
                  <span className="text-[10px] text-muted-foreground">eng: <span className="font-mono">{Number(c.engagement_score ?? 0).toFixed(2)}</span></span>
                </div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[11px] text-muted-foreground">{c.activity_count ?? 0} events</p>
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground ml-auto mt-1" />
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Intent State Panel ─────────────────────────────────────────────────────────
const INTENT_STATE_CFG: Record<string, { bar: string; text: string; icon: string; desc: string }> = {
  "Decision-Action":   { bar: "bg-red-500",    text: "text-red-600",    icon: "🔥", desc: "Ready to buy — act now" },
  "Evaluating-Engage": { bar: "bg-orange-400", text: "text-orange-600", icon: "🔆", desc: "Comparing options actively" },
  "Stuck-PreEngage":   { bar: "bg-amber-400",  text: "text-amber-600",  icon: "⚡", desc: "Engaged but stalled" },
  "Re-engaging":       { bar: "bg-cyan-500",   text: "text-cyan-700",   icon: "🔄", desc: "Returning after absence" },
  "Stuck-Aware":       { bar: "bg-blue-400",   text: "text-blue-600",   icon: "🌊", desc: "Aware but not yet acting" },
  "Browsing":          { bar: "bg-slate-300",  text: "text-slate-500",  icon: "👀", desc: "Early exploration" },
  "Dormant":           { bar: "bg-zinc-200",   text: "text-zinc-400",   icon: "❄️", desc: "No recent activity" },
};
const INTENT_STATE_ORDER = ["Decision-Action","Evaluating-Engage","Stuck-PreEngage","Re-engaging","Stuck-Aware","Browsing","Dormant"];

function IntentStatePanel({ onDrillContact }: { tenantId?: number; onDrillContact: (id: number, name: string) => void }) {
  const { data: contacts = [], isLoading } = useQuery<any[]>({
    queryKey: ["contacts-intent-dist"],
    queryFn: () => api("/contacts?limit=1000"),
  });

  const recompute = useMutation({
    mutationFn: () => fetch("/api/scoring/recompute", { method: "POST", credentials: "include" }).then(r => r.json()),
  });

  const distribution = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of contacts) {
      const s = c.intentState ?? c.intent_state ?? "Browsing";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    const total = contacts.length;
    return INTENT_STATE_ORDER.map(state => ({
      state, count: counts[state] ?? 0, pct: total > 0 ? Math.round(((counts[state] ?? 0) / total) * 100) : 0,
    }));
  }, [contacts]);

  const avgIntent = useMemo(() => {
    if (!contacts.length) return 0;
    const sum = contacts.reduce((a: number, c: any) => a + (c.intentScore ?? c.intent_score ?? 0), 0);
    return Math.round(sum / contacts.length);
  }, [contacts]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* State distribution */}
      <Card className="shadow-xs lg:col-span-2">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-semibold">Intent State Distribution</CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">Contacts segmented by composite intent engine state</p>
            </div>
            <button
              onClick={() => recompute.mutate()}
              disabled={recompute.isPending}
              className="text-[11px] px-3 py-1.5 rounded border border-indigo-200 text-indigo-600 hover:bg-indigo-50 transition-colors disabled:opacity-50 font-medium"
            >
              {recompute.isPending ? "Recomputing…" : recompute.isSuccess ? `✓ Done (${(recompute.data as any)?.updated ?? 0} updated)` : "↻ Recompute All"}
            </button>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {isLoading ? <Skeleton className="h-40" /> : (
            <div className="space-y-2.5">
              {distribution.map(({ state, count, pct }) => {
                const cfg = INTENT_STATE_CFG[state] ?? { bar:"bg-indigo-400", text:"text-indigo-600", icon:"•", desc:"" };
                return (
                  <div key={state} className="group cursor-default">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{cfg.icon}</span>
                        <span className={`text-xs font-semibold ${cfg.text}`}>{state}</span>
                        <span className="text-[10px] text-muted-foreground hidden group-hover:inline">{cfg.desc}</span>
                      </div>
                      <span className="text-xs text-muted-foreground tabular-nums">{count} ({pct}%)</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${cfg.bar}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
              {!isLoading && contacts.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">No contact data — run "Recompute All" to populate intent scores.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Avg intent score KPI + top states */}
      <Card className="shadow-xs">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold">Avg Intent Score</CardTitle>
          <p className="text-[11px] text-muted-foreground">Across all contacts</p>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {isLoading ? <Skeleton className="h-24" /> : (
            <>
              <div className="text-center py-4">
                <p className={`text-5xl font-black tabular-nums ${avgIntent >= 80 ? "text-red-600" : avgIntent >= 50 ? "text-orange-500" : avgIntent >= 30 ? "text-blue-500" : "text-slate-400"}`}>
                  {avgIntent}
                </p>
                <p className="text-xs text-muted-foreground mt-1">/ 100</p>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${avgIntent >= 80 ? "bg-red-500" : avgIntent >= 50 ? "bg-orange-400" : avgIntent >= 30 ? "bg-blue-400" : "bg-slate-300"}`}
                  style={{ width: `${avgIntent}%` }} />
              </div>
              <div className="space-y-1 pt-2">
                {[
                  { label: "High Intent (≥80)", count: contacts.filter((c: any) => (c.intentScore ?? c.intent_score ?? 0) >= 80).length, cls: "text-red-600" },
                  { label: "Mid Intent (30–79)", count: contacts.filter((c: any) => { const s = c.intentScore ?? c.intent_score ?? 0; return s >= 30 && s < 80; }).length, cls: "text-orange-500" },
                  { label: "Low Intent (<30)", count: contacts.filter((c: any) => (c.intentScore ?? c.intent_score ?? 0) < 30).length, cls: "text-slate-400" },
                ].map(({ label, count, cls }) => (
                  <div key={label} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{label}</span>
                    <span className={`font-semibold tabular-nums ${cls}`}>{count}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Playbook Recommendations ───────────────────────────────────────────────────
const PLAYBOOK_CFG: Record<string, {
  border: string; bg: string; headerBg: string; text: string; icon: string; action: string;
}> = {
  "Decision-Action":   { border:"border-red-200",    bg:"bg-red-50/60",    headerBg:"bg-red-600",    text:"text-red-700",    icon:"🔥", action:"Route to AE immediately — high-priority follow-up" },
  "Evaluating-Engage": { border:"border-orange-200", bg:"bg-orange-50/60", headerBg:"bg-orange-500", text:"text-orange-700", icon:"🔆", action:"Trigger sales outreach with a hook based on visited content" },
  "Stuck-PreEngage":   { border:"border-amber-200",  bg:"bg-amber-50/60",  headerBg:"bg-amber-500",  text:"text-amber-700",  icon:"⚡", action:"Share comparison content, case study, or 'why us' material" },
  "Re-engaging":       { border:"border-cyan-200",   bg:"bg-cyan-50/60",   headerBg:"bg-cyan-600",   text:"text-cyan-700",   icon:"🔄", action:"Re-engagement campaign referencing previously viewed content" },
  "Stuck-Aware":       { border:"border-blue-200",   bg:"bg-blue-50/60",   headerBg:"bg-blue-500",   text:"text-blue-700",   icon:"🌊", action:"Send educational nurture sequence; introduce a problem-framing piece" },
  "Dormant":           { border:"border-slate-200",  bg:"bg-slate-50/60",  headerBg:"bg-slate-400",  text:"text-slate-500",  icon:"❄️", action:"Quarterly re-activation or remove from active list" },
};
const PLAYBOOK_ORDER = ["Decision-Action","Evaluating-Engage","Stuck-PreEngage","Re-engaging","Stuck-Aware","Dormant"];

function downloadPlaybookCSV(
  view: "contacts" | "accounts",
  data: { contacts: any[]; accounts: any[]; isJourneyScoped?: boolean; journeyName?: string | null },
) {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const row = (cells: unknown[]) => cells.map(esc).join(",");
  const jn = data.journeyName ? ` — ${data.journeyName}` : "";
  const ts = new Date().toISOString().slice(0, 10);

  if (view === "contacts") {
    const scoreLabel = data.isJourneyScoped ? "Journey Score" : "Intent Score";
    const daysLabel  = data.isJourneyScoped ? "Journey Active Days" : "Active Days";
    const headers = ["Name","Email","Company","Global Stage","Intent State",scoreLabel,daysLabel,"Last Activity","Suggested Action"];
    const lines = [
      headers.join(","),
      ...data.contacts.map(c => row([
        [c.first_name, c.last_name].filter(Boolean).join(" "),
        c.email ?? "",
        c.company_name ?? "",
        c.global_stage ?? c.stage ?? "",
        c.intent_state ?? "",
        data.isJourneyScoped ? (c.journey_score ?? 0) : (c.intent_score ?? 0),
        data.isJourneyScoped ? (c.journey_active_days ?? 0) : (c.distinct_active_days ?? 0),
        c.last_activity ? formatReportDate(c.last_activity) : "",
        c.suggested_next_action ?? "",
      ])),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `playbook-contacts${jn}-${ts}.csv`; a.click();
    URL.revokeObjectURL(url);
  } else {
    const scoreLabel = data.isJourneyScoped ? "Top Journey Score" : "Top Intent Score";
    const headers = ["Company","Industry","Dominant Intent State","Actionable Contacts","Total Contacts",scoreLabel];
    const lines = [
      headers.join(","),
      ...data.accounts.map(a => row([
        a.name ?? "", a.industry ?? "", a.dominant_intent_state ?? "",
        a.actionable_contacts ?? 0, a.total_contacts ?? 0, a.max_intent_score ?? 0,
      ])),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `playbook-accounts${jn}-${ts}.csv`; anchor.click();
    URL.revokeObjectURL(url);
  }
}

function PlaybookSection({
  data, loading, onViewContact, onDrillAccount, gtmStatuses, gtmLoading, gtmError,
}: {
  data?: { contacts: any[]; accounts: any[]; plays: any[]; isJourneyScoped?: boolean; journeyName?: string | null };
  loading: boolean;
  onViewContact: (id: number, name: string) => void;
  onDrillAccount: (title: string, extra: Record<string,string>) => void;
  gtmStatuses: GtmStatuses;
  gtmLoading: boolean;
  gtmError: boolean;
}) {
  const [view, setView] = useState<"contacts"|"accounts">("contacts");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["Dormant"]));

  const contacts       = data?.contacts       ?? [];
  const accounts       = data?.accounts       ?? [];
  const plays          = data?.plays          ?? [];
  const isJourneyScoped = data?.isJourneyScoped ?? false;
  const journeyName    = data?.journeyName    ?? null;

  const grouped = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const c of contacts) {
      const s = c.intent_state ?? "Browsing";
      if (!map[s]) map[s] = [];
      map[s].push(c);
    }
    return map;
  }, [contacts]);

  const actionable = contacts.filter(c => !["Dormant","Browsing"].includes(c.intent_state ?? "")).length;

  const toggle = (s: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(s)) next.delete(s); else next.add(s);
    return next;
  });

  if (loading) return (
    <div className="p-6 space-y-4">{Array.from({length:4}).map((_,i)=><Skeleton key={i} className="h-28 rounded-lg"/>)}</div>
  );

  return (
    <div className="p-6 space-y-5">
      {/* Summary bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-1">
          {isJourneyScoped && journeyName && (
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 text-[10px] font-semibold">
              <Map className="w-3 h-3" /> Journey: {journeyName}
            </div>
          )}
          <h2 className="text-sm font-semibold">
            {actionable > 0
              ? `${actionable} contact${actionable!==1?"s":""} across ${accounts.length} account${accounts.length!==1?"s":""} need${actionable===1?"s":""} attention`
              : isJourneyScoped ? "No contacts in this journey have actionable intent states yet" : "No contacts currently require action"}
          </h2>
          <p className="text-[11px] text-muted-foreground">
            {isJourneyScoped
              ? "Scores and stages derived from this journey's activity only · global scores unchanged"
              : "Based on global intent signals · updates on every journey page visit"}
            {plays.length > 0 && ` · ${plays.length} active play${plays.length!==1?"s":""} available`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 self-start sm:self-auto flex-wrap justify-end">
          <button
            onClick={() => downloadPlaybookCSV(view, data ?? { contacts: [], accounts: [], isJourneyScoped, journeyName })}
            disabled={view === "contacts" ? contacts.length === 0 : accounts.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium text-muted-foreground hover:bg-muted/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
          <div className="flex items-center rounded-lg border overflow-hidden">
            {(["contacts","accounts"] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={cn("px-3 py-1.5 text-xs font-medium transition-colors",
                  view===v ? "bg-indigo-600 text-white" : "text-muted-foreground hover:bg-muted/60")}>
                {v==="contacts" ? "👤 Contacts" : "🏢 Accounts"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Contact view ──────────────────────────────────────────────────────── */}
      {view === "contacts" && (
        <>
          {contacts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3 border rounded-lg bg-muted/10">
              <span className="text-5xl">🎯</span>
              <p className="text-sm font-medium">
                {isJourneyScoped ? "No contacts have visited this journey yet" : "All clear — no contacts with actionable intent states"}
              </p>
              <p className="text-[11px]">
                {isJourneyScoped ? "Contacts appear here once they visit a page in this journey" : "Contacts appear here once they build an intent signal from journey visits"}
              </p>
            </div>
          )}
          <div className="space-y-3">
            {PLAYBOOK_ORDER.filter(s => (grouped[s]??[]).length > 0).map(state => {
              const cfg = PLAYBOOK_CFG[state]!;
              const rows = grouped[state] ?? [];
              const open = !collapsed.has(state);
              return (
                <div key={state} className={cn("rounded-lg border overflow-hidden shadow-xs", cfg.border)}>
                  <button onClick={() => toggle(state)}
                    className={cn("w-full flex items-center justify-between px-4 py-3 transition-colors text-left",
                      open ? cfg.headerBg : "bg-white hover:bg-slate-50")}>
                    <div className="flex items-center gap-2.5">
                      <span className="text-base leading-none">{cfg.icon}</span>
                      <span className={cn("text-sm font-semibold", open ? "text-white" : cfg.text)}>{state}</span>
                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-bold",
                        open ? "bg-white/20 text-white" : `${cfg.border.replace("border-","bg-").replace("-200","-100")} ${cfg.text}`)}>
                        {rows.length}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={cn("text-[11px] hidden md:block max-w-sm truncate", open ? "text-white/80" : "text-muted-foreground")}>
                        → {cfg.action}
                      </span>
                      <ChevronDown className={cn("w-4 h-4 shrink-0 transition-transform", open ? "rotate-180 text-white/80" : cfg.text)} />
                    </div>
                  </button>
                  {open && (
                    <div className={cn("divide-y", cfg.border)}>
                      {rows.map((c: any) => {
                        const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
                        const score = isJourneyScoped ? Number(c.journey_score ?? 0) : Number(c.intent_score ?? 0);
                        const scoreCap = isJourneyScoped ? Math.min(100, score * 2) : score; // journey scores are smaller
                        const activeDays = isJourneyScoped ? (c.journey_active_days ?? 0) : (c.distinct_active_days ?? 0);
                        const stageSrc = isJourneyScoped ? (c.global_stage ?? c.stage) : (c.stage ?? c.global_stage);
                        const journeyStages: string[] = isJourneyScoped ? (c.journey_stages ?? []) : [];
                        const lastAct = c.last_activity
                          ? formatDistanceToNow(parseISO(c.last_activity), { addSuffix: true })
                          : "—";
                        return (
                          <div key={c.id} className={cn("flex items-center gap-3 px-4 py-3 hover:bg-white/70 transition-colors", cfg.bg)}>
                            <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[11px] font-bold shrink-0 uppercase">
                              {(c.first_name?.[0]??"")+((c.last_name?.[0])??"")}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium">{name}</span>
                                <GtmStatusBadge scope="contact" status={gtmStatuses[String(c.id)]} loading={gtmLoading} error={gtmError} />
                                {c.company_name && <span className="text-[11px] text-muted-foreground">· {c.company_name}</span>}
                                <StageBadge stage={stageSrc ?? "pre-aware"} />
                                {isJourneyScoped && journeyStages.length > 0 && journeyStages.map((s: string) => (
                                  <span key={s} className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-indigo-100 text-indigo-700 border border-indigo-200">
                                    {s}
                                  </span>
                                ))}
                              </div>
                              <div className="flex items-center gap-3 mt-1 flex-wrap">
                                <div className="flex items-center gap-1.5">
                                  <div className="w-20 bg-gray-200 rounded-full h-1.5">
                                    <div className={cn("h-1.5 rounded-full", scoreCap>=80?"bg-red-500":scoreCap>=50?"bg-orange-400":scoreCap>=30?"bg-blue-400":"bg-slate-300")}
                                      style={{width:`${Math.min(100,scoreCap)}%`}}/>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground tabular-nums">
                                    {isJourneyScoped ? "journey pts:" : "intent:"}{" "}
                                    <span className="font-semibold text-foreground">{score}</span>
                                  </span>
                                </div>
                                <span className="text-[10px] text-muted-foreground">{activeDays} active day{activeDays!==1?"s":""}</span>
                                <span className="text-[10px] text-muted-foreground">{c.recent_events ?? 0} events</span>
                                <span className="text-[10px] text-muted-foreground">{lastAct}</span>
                              </div>
                              {c.suggested_next_action && (
                                <p className="text-[10px] text-indigo-600 mt-0.5 truncate">→ {c.suggested_next_action}</p>
                              )}
                            </div>
                            <button onClick={() => onViewContact(c.id, name)}
                              className={cn("shrink-0 text-[11px] px-2.5 py-1 rounded border font-medium transition-colors hover:bg-white whitespace-nowrap", cfg.text, cfg.border)}>
                              View →
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Account view ──────────────────────────────────────────────────────── */}
      {view === "accounts" && (
        <>
          {accounts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3 border rounded-lg bg-muted/10">
              <span className="text-5xl">🏢</span>
              <p className="text-sm font-medium">
                {isJourneyScoped ? "No accounts have contacts in this journey yet" : "No accounts with actionable contacts yet"}
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {accounts.map((acc: any) => {
              const cfg = PLAYBOOK_CFG[acc.dominant_intent_state] ?? PLAYBOOK_CFG["Dormant"]!;
              const pct = Math.min(100, isJourneyScoped
                ? Math.min(100, (acc.max_intent_score ?? 0) * 2)
                : (acc.max_intent_score ?? 0));
              return (
                <div key={acc.id} className={cn("rounded-lg border p-4 shadow-xs flex flex-col gap-3", cfg.border, cfg.bg)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold truncate">{acc.name}</h3>
                      {acc.industry && <p className="text-[11px] text-muted-foreground">{acc.industry}</p>}
                    </div>
                    <span className={cn("shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap border", cfg.border, cfg.text,
                      cfg.bg.replace("/60",""))}>
                      {cfg.icon} {acc.dominant_intent_state}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">Actionable contacts</span>
                      <span className={cn("font-bold", cfg.text)}>{acc.actionable_contacts} / {acc.total_contacts}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">{isJourneyScoped ? "Top journey score" : "Top intent score"}</span>
                      <span className="font-semibold tabular-nums">{acc.max_intent_score ?? 0}</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-1.5">
                      <div className={cn("h-1.5 rounded-full", cfg.headerBg)} style={{width:`${pct}%`}}/>
                    </div>
                  </div>
                  <p className={cn("text-[10px] truncate font-medium", cfg.text)}>→ {cfg.action}</p>
                  <button
                    onClick={() => onDrillAccount(`${acc.name} — Contacts`, { companyId: String(acc.id), _strip: "stage,stages" })}
                    className={cn("mt-auto text-[11px] py-1.5 rounded border font-medium transition-colors hover:bg-white text-center", cfg.text, cfg.border)}>
                    View Contacts →
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Active plays strip */}
      {plays.length > 0 && (
        <div className="border rounded-lg bg-indigo-50/40 px-4 py-3">
          <p className="text-[11px] font-semibold text-indigo-700 mb-2">Active plays available to assign</p>
          <div className="flex flex-wrap gap-2">
            {plays.map((p: any) => (
              <a key={p.id} href={`/plays/${p.id}`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-indigo-200 text-indigo-700 text-[11px] font-medium hover:bg-indigo-50 transition-colors">
                <Zap className="w-3 h-3" /> {p.name}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Filter Bar ─────────────────────────────────────────────────────────────────
function FilterBar({ filters, onChange }: {
  filters: Filters;
  onChange: (f: Filters) => void;
}) {
  const [clientsEnabled, setClientsEnabled] = useState(false);
  const [playsEnabled, setPlaysEnabled] = useState(false);
  const [journeysEnabled, setJourneysEnabled] = useState(false);
  const [companiesEnabled, setCompaniesEnabled] = useState(false);
  const clientsQuery = useQuery<any[]>({ queryKey: ["clients"], queryFn: () => api("/clients"), enabled: clientsEnabled });
  const playsQuery = useQuery<any[]>({ queryKey: ["plays"], queryFn: () => api("/plays"), enabled: playsEnabled });
  const journeysQuery = useQuery<any[]>({ queryKey: ["journeys"], queryFn: () => api("/journeys"), enabled: journeysEnabled });
  const companiesQuery = useQuery<any[]>({ queryKey: ["companies"], queryFn: () => api("/companies"), enabled: companiesEnabled });
  const { data: clients = [] } = clientsQuery;
  const { data: plays = [] } = playsQuery;
  const { data: journeys = [] } = journeysQuery;
  const { data: companies = [] } = companiesQuery;
  const inboundQuery = useQuery<{ accounts: Array<{id:number;name:string;domain:string|null;classification:string}> }>({
    queryKey: ["analytics-inbound-accounts", filters.clientId],
    queryFn: () => trafficApi(`/analytics/inbound-account-options${qs({clientId:filters.clientId})}`),
    enabled: !!filters.clientId,
  });
  const singleInboundId = filters.inboundAccountIds.length === 1 ? filters.inboundAccountIds[0] : "";
  const linksQuery = useQuery<{ plays: any[]; journeys: any[] }>({
    queryKey: ["analytics-inbound-links", filters.clientId, singleInboundId],
    queryFn: () => trafficApi(`/analytics/inbound-account-options${qs({clientId:filters.clientId,accountId:singleInboundId})}`),
    enabled: !!filters.clientId && !!singleInboundId,
  });
  const inboundAccounts = inboundQuery.data?.accounts ?? [];

  const filteredPlays = singleInboundId
    ? (linksQuery.data?.plays ?? [])
    : filters.clientId ? plays.filter((p: any) => String(p.clientId) === filters.clientId) : plays;
  const selectedInboundPlay = linksQuery.data?.plays.find((p: any) => String(p.id) === filters.playId);
  const filteredJourneys = singleInboundId
    ? (linksQuery.data?.journeys ?? []).filter((j: any) =>
        !selectedInboundPlay?.journeyId || String(j.id) === String(selectedInboundPlay.journeyId))
    : filters.clientId ? journeys.filter((j: any) => String(j.clientId) === filters.clientId) : journeys;

  const set = (key: keyof Filters, val: string) => onChange({ ...filters, [key]: val });
  const setArr = (key: keyof Filters, val: string[]) => onChange({
    ...filters, [key]: val, ...(key === "companyIds" ? { inboundAccountIds: [], inboundOnly:false, playId: "", journeyId: "" } : {}),
  });

  const setClient = (val: string) => {
    const newClientId = val === "__all" ? "" : val;
    if (newClientId !== filters.clientId) {
      onChange({ ...filters, clientId: newClientId, inboundAccountIds: [], inboundOnly:false,
        playId: "", journeyId: "", companyIds: [] });
      return;
    }
    const newFilters = { ...filters, clientId: newClientId };
    // Clear play/journey if they no longer belong to the new client
    if (newClientId) {
      if (filters.playId) {
        if (!playsQuery.isSuccess) setPlaysEnabled(true);
        else if (!plays.some((p: any) => String(p.id) === filters.playId && String(p.clientId) === newClientId)) newFilters.playId = "";
      }
      if (filters.journeyId) {
        if (!journeysQuery.isSuccess) setJourneysEnabled(true);
        else if (!journeys.some((j: any) => String(j.id) === filters.journeyId && String(j.clientId) === newClientId)) newFilters.journeyId = "";
      }
    }
    onChange(newFilters);
  };

  const setInboundAccounts = (vals: string[]) => onChange({
    ...filters, inboundAccountIds: vals, inboundOnly: vals.length > 0,
    playId: "", journeyId: "", companyIds: [],
  });
  const setAllInbound = () => onChange({
    ...filters, inboundAccountIds: [], inboundOnly:true,
    playId: "", journeyId: "", companyIds: [],
  });
  const clearInbound = () => onChange({ ...filters, inboundAccountIds: [], inboundOnly:false });

  useEffect(() => {
    if (!singleInboundId || !linksQuery.isSuccess) return;
    if ((filters.playId && !filteredPlays.some((p: any) => String(p.id) === filters.playId)) ||
        (filters.journeyId && !filteredJourneys.some((j: any) => String(j.id) === filters.journeyId))) {
      onChange({ ...filters, playId: filteredPlays.some((p: any) => String(p.id) === filters.playId) ? filters.playId : "",
        journeyId: filteredJourneys.some((j: any) => String(j.id) === filters.journeyId) ? filters.journeyId : "" });
    }
  }, [filters, linksQuery.isSuccess, filteredPlays, filteredJourneys, onChange]);

  useEffect(() => {
    if (!filters.clientId) return;
    const nextFilters = { ...filters };
    let changed = false;
    if (filters.playId && playsEnabled && playsQuery.isSuccess &&
        !plays.some((p: any) => String(p.id) === filters.playId && String(p.clientId) === filters.clientId)) {
      nextFilters.playId = "";
      changed = true;
    }
    if (filters.journeyId && journeysEnabled && journeysQuery.isSuccess &&
        !journeys.some((j: any) => String(j.id) === filters.journeyId && String(j.clientId) === filters.clientId)) {
      nextFilters.journeyId = "";
      changed = true;
    }
    if (changed) onChange(nextFilters);
  }, [filters, onChange, plays, playsEnabled, playsQuery.isSuccess, journeys, journeysEnabled, journeysQuery.isSuccess]);

  const clear = () => onChange(EMPTY_FILTERS);
  const hasAny = Object.entries(filters).some(([, v]) => Array.isArray(v) ? v.length > 0 : typeof v === "boolean" ? v : v !== "");

  const clientName  = clients.find((c: any)  => String(c.id) === filters.clientId)?.name;
  const playName    = filteredPlays.find((p: any) => String(p.id) === filters.playId)?.name;
  const journeyName = filteredJourneys.find((j: any) => String(j.id) === filters.journeyId)?.name;
  const inboundName = inboundAccounts.find(a => String(a.id) === singleInboundId)?.name;

  return (
    <div className="@container border-b bg-muted/20 px-4 py-2 grid grid-cols-[14px_minmax(0,1fr)] gap-x-2 gap-y-2 shrink-0">
      <Filter aria-label="Analytics filters" className="w-3.5 h-3.5 mt-[7px] text-muted-foreground" />
      <div className="grid min-w-0 grid-cols-2 @min-[420px]:grid-cols-3 @min-[840px]:grid-cols-6 gap-2">

      <Select value={filters.clientId || "__all"} onValueChange={setClient}>
        <SelectTrigger aria-label="Client" className="h-7 min-w-0 w-full gap-1 px-2 py-0 text-xs [&>span]:truncate [&>svg]:shrink-0" onPointerDown={() => setClientsEnabled(true)} onFocus={() => setClientsEnabled(true)}><SelectValue placeholder="Client" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All Clients</SelectItem>
          {clients.map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <MultiSelectDropdown
        options={inboundAccounts.map(a => ({
          value: String(a.id), label: a.domain ? `${a.name} · ${a.domain}` : a.name,
          badge: a.classification === "hot" ? "Hot" : a.classification === "warm" ? "Warm" : "Cold",
        }))}
        selected={filters.inboundAccountIds}
        onChange={setInboundAccounts}
        allLabel="All inbound accounts"
        allSelected={filters.inboundOnly && !filters.inboundAccountIds.length}
        onAll={setAllInbound}
        noneLabel="No inbound filter"
        onNone={clearInbound}
        placeholder={filters.inboundOnly && !filters.inboundAccountIds.length ? "All inbound accounts" : "Inbound accounts"}
        searchable
        disabled={!filters.clientId || inboundQuery.isLoading}
        width="100%"
      />

      <Select value={filters.playId || "__all"} onValueChange={v => onChange({ ...filters, playId: v === "__all" ? "" : v, journeyId: "" })}>
        <SelectTrigger aria-label="Play" className="h-7 min-w-0 w-full gap-1 px-2 py-0 text-xs [&>span]:truncate [&>svg]:shrink-0" onPointerDown={() => setPlaysEnabled(true)} onFocus={() => setPlaysEnabled(true)}><SelectValue placeholder={singleInboundId ? `Linked plays (${filteredPlays.length})` : filters.clientId ? `Plays (${filteredPlays.length})` : "Play"} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">{singleInboundId ? "All linked plays" : filters.clientId ? "All plays for client" : "All Plays"}</SelectItem>
          {filteredPlays.map((p: any) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <Select value={filters.journeyId || "__all"} onValueChange={v => set("journeyId", v === "__all" ? "" : v)}>
        <SelectTrigger aria-label="Journey" className="h-7 min-w-0 w-full gap-1 px-2 py-0 text-xs [&>span]:truncate [&>svg]:shrink-0" onPointerDown={() => setJourneysEnabled(true)} onFocus={() => setJourneysEnabled(true)}><SelectValue placeholder={singleInboundId ? `Linked journeys (${filteredJourneys.length})` : filters.clientId ? `Journeys (${filteredJourneys.length})` : "Journey"} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">{singleInboundId ? "All linked journeys" : filters.clientId ? "All journeys for client" : "All Journeys"}</SelectItem>
          {filteredJourneys.map((j: any) => <SelectItem key={j.id} value={String(j.id)}>{j.name}</SelectItem>)}
        </SelectContent>
      </Select>

      <MultiSelectDropdown
        options={STAGE_ORDER.map(s => ({ value: s, label: STAGE_LABELS[s] }))}
        selected={filters.stages}
        onChange={vals => setArr("stages", vals)}
        placeholder="All Stages"
        width="100%"
      />

      <MultiSelectDropdown
        options={companies.map((c: any) => ({ value: String(c.id), label: c.name }))}
        selected={filters.companyIds}
        onChange={vals => setArr("companyIds", vals)}
        onInteract={() => setCompaniesEnabled(true)}
        placeholder="All Companies"
        searchable
        width="100%"
      />
      </div>

      <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      <div role="group" aria-label="Score range" className="flex items-center gap-1.5">
        <span className="mr-0.5 text-[11px] font-medium text-muted-foreground">Score</span>
        <Input aria-label="Minimum score" type="number" placeholder="Min" value={filters.scoreMin} onChange={e => set("scoreMin", e.target.value)}
          className="h-7 w-16 px-2 text-xs md:text-xs" min={0} max={100} />
        <span className="text-xs text-muted-foreground">–</span>
        <Input aria-label="Maximum score" type="number" placeholder="Max" value={filters.scoreMax} onChange={e => set("scoreMax", e.target.value)}
          className="h-7 w-16 px-2 text-xs md:text-xs" min={0} max={100} />
      </div>

      <div role="group" aria-label="Date range" className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[11px] font-medium text-muted-foreground">Dates</span>
        <Input aria-label="Start date" type="date" value={filters.dateFrom} onChange={e => set("dateFrom", e.target.value)}
          className="h-7 w-[132px] min-w-0 px-2 text-xs md:text-xs" />
        <span className="text-xs text-muted-foreground">–</span>
        <Input aria-label="End date" type="date" value={filters.dateTo} onChange={e => set("dateTo", e.target.value)}
          className="h-7 w-[132px] min-w-0 px-2 text-xs md:text-xs" />
      </div>

      {hasAny && (
        <Button variant="ghost" size="sm" onClick={clear} className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground">
          <X className="w-3 h-3" /> Clear
        </Button>
      )}
      </div>

      {filters.clientId && inboundQuery.isError && <span role="alert" className="col-start-2 text-xs text-red-600">Unable to load inbound accounts</span>}
      {singleInboundId && linksQuery.isError && <span role="alert" className="col-start-2 text-xs text-red-600">Unable to load linked plays and journeys</span>}

      {hasAny && (
        <div className="col-start-2 flex min-w-0 flex-wrap gap-1">
          {filters.clientId  && <span className="text-[10px] bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{clientName ?? "Client"}</span>}
          {filters.clientId && filters.inboundOnly && !filters.companyIds.length && <span className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">Inbound: {singleInboundId ? inboundName ?? "Account" : filters.inboundAccountIds.length ? `${filters.inboundAccountIds.length} accounts` : "All inbound accounts"}</span>}
          {filters.playId    && <span className="text-[10px] bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">{playName ?? "Play"}</span>}
          {filters.journeyId && <span className="text-[10px] bg-sky-100 text-sky-700 px-2 py-0.5 rounded-full">{journeyName ?? "Journey"}</span>}
          {filters.stages.map(s => (
            <span key={s} className={cn("text-[10px] px-2 py-0.5 rounded-full", STAGE_BG[s] ?? "bg-gray-100 text-gray-700")}>{STAGE_LABELS[s]}</span>
          ))}
          {filters.companyIds.length > 0 && (
            <span className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
              {filters.companyIds.length === 1
                ? (companies.find((c: any) => String(c.id) === filters.companyIds[0])?.name ?? "Company")
                : `${filters.companyIds.length} companies`}
            </span>
          )}
          {(filters.scoreMin || filters.scoreMax) && <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Score {filters.scoreMin||"0"}–{filters.scoreMax||"100"}</span>}
          {(filters.dateFrom || filters.dateTo) && <span className="text-[10px] bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full">Date range</span>}
        </div>
      )}
    </div>
  );
}

// ── ABM helpers ───────────────────────────────────────────────────────────────
const fmtDuration = (secs: number | null | undefined) => {
  if (secs == null || secs === 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};

const fmtVisitDate = (dt: string) => {
  return formatReportDate(dt);
};

const fmtVisitTime = (dt: string) => {
  return formatReportTime(dt);
};

const EVENT_TYPE_LABEL: Record<string,string> = {
  page_view:"Page View", form_submit:"Form Submit",
  asset_download:"Download", banner_click:"Banner Click", scroll_depth:"Scroll Depth",
  email_open:"Email Open", email_click:"Email Click", call_completed:"Call",
};


// ── TopOpportunitiesPanel ─────────────────────────────────────────────────────
interface TopOpportunity {
  call_log_id: number;
  contact_id: number | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  outcome: string | null;
  started_at: string | null;
  campaign_name: string | null;
  analysis_id: number;
  sentiment: string | null;
  interest_score: number;
  interest_justification: string | null;
  recommended_action: string | null;
  action_timing: string | null;
  owning_team: string | null;
  follow_up_message: string | null;
}

function OppInterestBar({ score }: { score: number }) {
  const pct = (score / 10) * 100;
  const col = score >= 8 ? "bg-emerald-500" : score >= 7 ? "bg-green-400" : "bg-amber-400";
  return (
    <div className="flex items-center gap-1.5 min-w-[80px]">
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${col}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-bold tabular-nums text-slate-700">{score}/10</span>
    </div>
  );
}

function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return null;
  const map: Record<string, { label: string; cls: string }> = {
    positive: { label: "😊 Positive", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    neutral:  { label: "😐 Neutral",  cls: "bg-slate-100  text-slate-600  border-slate-200"  },
    negative: { label: "😞 Negative", cls: "bg-red-50     text-red-700    border-red-200"    },
  };
  const m = map[sentiment] ?? { label: sentiment, cls: "bg-gray-50 text-gray-600 border-gray-200" };
  return (
    <span className={`inline-flex text-[10px] px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap ${m.cls}`}>
      {m.label}
    </span>
  );
}

function TimingChip({ timing }: { timing: string | null }) {
  if (!timing) return null;
  const map: Record<string, { label: string; cls: string; icon: string }> = {
    this_week: { label: "This Week",  cls: "bg-rose-50   text-rose-700   border-rose-200",   icon: "🔥" },
    next_week: { label: "Next Week",  cls: "bg-amber-50  text-amber-700  border-amber-200",  icon: "⏰" },
    no_action: { label: "No Action",  cls: "bg-gray-50   text-gray-500   border-gray-200",   icon: "—"  },
  };
  const m = map[timing] ?? { label: timing.replace(/_/g, " "), cls: "bg-slate-50 text-slate-600 border-slate-200", icon: "📅" };
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap ${m.cls}`}>
      {m.icon} {m.label}
    </span>
  );
}

function CopyFollowUpButton({ message }: { message: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!message) return null;
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };
  return (
    <button
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy follow-up message"}
      className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded border font-semibold transition-colors whitespace-nowrap
        ${copied
          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
          : "bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100"
        }`}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? "Copied!" : "Copy follow-up"}
    </button>
  );
}

function TopOpportunitiesPanel({
  opportunities,
  loading,
  onOpenContact,
  gtmStatuses,
  gtmLoading,
  gtmError,
}: {
  opportunities: TopOpportunity[];
  loading: boolean;
  onOpenContact?: (contactId: number, name: string) => void;
  gtmStatuses: GtmStatuses;
  gtmLoading: boolean;
  gtmError: boolean;
}) {
  return (
    <Card className="shadow-xs border-2 border-emerald-200 bg-gradient-to-br from-emerald-50/60 to-white">
      <CardHeader className="px-0 py-0">
        <div className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white px-4 py-2.5 rounded-t-lg flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Star size={14} className="text-yellow-300 fill-yellow-300" />
            <CardTitle className="text-sm font-semibold">Top Opportunities</CardTitle>
            <span className="text-[10px] text-emerald-100 font-medium ml-1">Interest score ≥ 7 — act now</span>
          </div>
          {!loading && (
            <Badge variant="secondary" className="text-[10px] bg-white/20 text-white border-0">
              {opportunities.length} call{opportunities.length !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-2 w-64" />
                </div>
                <Skeleton className="h-6 w-24" />
              </div>
            ))}
          </div>
        ) : opportunities.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
            <Star size={24} className="text-emerald-300" />
            <p className="text-sm font-medium">No high-interest calls yet</p>
            <p className="text-xs text-center max-w-xs">
              Calls with an LLM interest score of 7 or higher will appear here as hot prospects ready for immediate follow-up.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {opportunities.map((opp, idx) => {
              const name = [opp.first_name, opp.last_name].filter(Boolean).join(" ") || opp.email || "Unknown";
              const rank = idx + 1;
              const rankColor = rank === 1 ? "text-yellow-500" : rank === 2 ? "text-slate-400" : rank === 3 ? "text-amber-600" : "text-slate-300";
              return (
                <div key={opp.call_log_id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 hover:bg-emerald-50/40 transition-colors">
                  {/* Rank */}
                  <div className="flex items-center gap-2 shrink-0 sm:w-6">
                    <span className={`text-base font-black tabular-nums ${rankColor}`}>#{rank}</span>
                  </div>

                  {/* Contact + company */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        onClick={() => opp.contact_id && onOpenContact?.(opp.contact_id, name)}
                        className="text-sm font-semibold text-indigo-700 hover:underline truncate max-w-[180px]"
                      >
                        {name}
                      </button>
                      {opp.contact_id && <GtmStatusBadge scope="contact" status={gtmStatuses[String(opp.contact_id)]} loading={gtmLoading} error={gtmError} />}
                      {opp.company_name && (
                        <span className="text-xs text-slate-500 truncate">· {opp.company_name}</span>
                      )}
                    </div>
                    {opp.recommended_action && (
                      <p className="text-xs text-slate-600 mt-0.5 line-clamp-1" title={opp.recommended_action}>
                        <span className="font-semibold text-slate-500">Action:</span> {opp.recommended_action}
                      </p>
                    )}
                  </div>

                  {/* Interest bar */}
                  <div className="shrink-0 w-28">
                    <OppInterestBar score={opp.interest_score} />
                  </div>

                  {/* Sentiment */}
                  <div className="shrink-0">
                    <SentimentBadge sentiment={opp.sentiment} />
                  </div>

                  {/* Timing chip */}
                  <div className="shrink-0">
                    <TimingChip timing={opp.action_timing} />
                  </div>

                  {/* Owning team */}
                  {opp.owning_team && (
                    <div className="shrink-0">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap
                        ${opp.owning_team === "sales" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-purple-50 text-purple-700 border-purple-200"}`}>
                        {opp.owning_team === "sales" ? "Sales" : "Marketing"}
                      </span>
                    </div>
                  )}

                  {/* Copy follow-up */}
                  <div className="shrink-0">
                    <CopyFollowUpButton message={opp.follow_up_message} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── CallLogRow — expandable transcript row for Recent Calls table ─────────────
function CallLogRow({ row, outcomeColors, transcriptText, onOpenContact, onRefetch, gtmStatuses, gtmLoading, gtmError }: {
  row: any;
  outcomeColors: Record<string, string>;
  transcriptText: string;
  onOpenContact?: (contactId: number, name: string) => void;
  onRefetch?: () => void;
  gtmStatuses: GtmStatuses;
  gtmLoading: boolean;
  gtmError: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  const dncMut = useMutation({
    mutationFn: (contactId: number) =>
      fetch(`/api/contacts/${contactId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dnc: true }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["dnc-list"] });
      onRefetch?.();
      toast({ title: "Contact marked as DNC — they won't be emailed or called." });
    },
    onError: () => toast({ title: "Failed to mark as DNC", variant: "destructive" }),
  });

  const hasLlm   = !!(row.analysis_id && row.analysis_status === "completed");
  const hasDetail = !!(transcriptText || row.ai_summary || hasLlm);
  const hasTx     = !!(transcriptText);

  const sentimentBadge = (s: string | null) => {
    if (!s) return null;
    const map: Record<string, string> = {
      positive: "bg-emerald-50 text-emerald-700 border-emerald-200",
      neutral:  "bg-slate-50  text-slate-600  border-slate-200",
      negative: "bg-red-50    text-red-600    border-red-200",
    };
    return (
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${map[s] ?? "bg-gray-50 text-gray-600 border-gray-200"}`}>
        {s === "positive" ? "😊" : s === "negative" ? "😞" : "😐"} {s}
      </span>
    );
  };

  const interestBar = (score: number | null) => {
    if (!score) return null;
    const pct = (score / 10) * 100;
    const col = score >= 7 ? "bg-emerald-500" : score >= 4 ? "bg-amber-400" : "bg-red-400";
    return (
      <div className="flex items-center gap-1.5">
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${col}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[10px] font-bold tabular-nums">{score}/10</span>
      </div>
    );
  };

  const triggerAnalysis = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (analysing) return;
    setAnalysing(true);
    try {
      await fetch(`/api/analytics/calls/${row.id}/analyse`, {
        method: "POST", credentials: "include",
      });
      setTimeout(() => {
        setAnalysing(false);
        onRefetch?.();
      }, 4000);
    } catch {
      setAnalysing(false);
    }
  };

  return (
    <>
      <tr
        className={`transition-colors ${hasDetail ? "cursor-pointer hover:bg-indigo-50/60" : "hover:bg-slate-50/60"}`}
        onClick={() => hasDetail && setExpanded(v => !v)}
      >
        <td className="px-3 py-2.5 text-xs font-medium">
          {row.contact_id && onOpenContact ? (
            <span className="inline-flex items-center gap-1.5 flex-wrap">
              <button
                className="font-semibold text-indigo-600 hover:underline text-left"
                onClick={e => { e.stopPropagation(); onOpenContact(row.contact_id, `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim()); }}
              >
                {row.first_name} {row.last_name}
              </button>
              <GtmStatusBadge scope="contact" status={gtmStatuses[String(row.contact_id)]} loading={gtmLoading} error={gtmError} />
            </span>
          ) : (
            <p>{row.first_name} {row.last_name}</p>
          )}
          {row.email && <span className="block text-[10px] text-muted-foreground">{row.email}</span>}
          {row.contact_id && (
            <button
              className="mt-0.5 flex items-center gap-0.5 text-[9px] text-red-500 hover:text-red-700 hover:underline disabled:opacity-40"
              onClick={e => { e.stopPropagation(); dncMut.mutate(row.contact_id); }}
              disabled={dncMut.isPending}
              title="Mark as DNC — block from emails & calls"
            >
              <PhoneOff className="w-2.5 h-2.5" />
              Mark DNC
            </button>
          )}
          {hasDetail && (
            <span className="text-[10px] text-indigo-500 mt-0.5 block">{expanded ? "▲ collapse" : "▼ view summary"}</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
          {row.phone ? (
            <a href={`tel:${row.phone}`} className="hover:text-indigo-600 hover:underline" onClick={e => e.stopPropagation()}>
              {row.phone}
            </a>
          ) : "—"}
        </td>
        <td className="px-3 py-2.5 text-xs text-muted-foreground">{row.company_name ?? "—"}</td>
        <td className="px-3 py-2.5 text-xs">
          {row.outcome ? (
            <div className="space-y-0.5">
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${outcomeColors[row.outcome] ?? "text-gray-600 bg-gray-50 border-gray-200"}`}>
                {row.outcome.replace(/_/g, " ")}
              </span>
              {row.ended_reason && (
                <p className="text-[9px] text-muted-foreground font-mono">{row.ended_reason}</p>
              )}
            </div>
          ) : "—"}
        </td>
        <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">
          {row.duration_seconds ? `${row.duration_seconds}s` : "—"}
        </td>
        <td className="px-3 py-2.5 text-xs text-muted-foreground truncate max-w-[120px]">{row.campaign_name ?? "—"}</td>
        <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
          {row.started_at ? formatReportDate(row.started_at) : "—"}
        </td>
        <td className="px-3 py-2.5 text-xs">
          {hasLlm ? (
            <div className="space-y-1 min-w-[90px]">
              {sentimentBadge(row.sentiment)}
              {interestBar(row.interest_score)}
            </div>
          ) : row.analysis_status === "processing" ? (
            <span className="text-[10px] text-amber-600 animate-pulse">⏳ analysing…</span>
          ) : hasTx ? (
            <button
              className={`text-[10px] px-2 py-0.5 rounded border font-medium transition-colors ${analysing ? "bg-indigo-50 text-indigo-400 border-indigo-100 cursor-wait" : "bg-indigo-50 text-indigo-600 border-indigo-200 hover:bg-indigo-100"}`}
              onClick={triggerAnalysis}
              disabled={analysing}
            >
              {analysing ? "⏳ queued…" : "🧠 Analyse"}
            </button>
          ) : (
            <span className="text-[10px] text-muted-foreground">no transcript</span>
          )}
        </td>
      </tr>
      {expanded && hasDetail && (
        <tr>
          <td colSpan={8} className="px-3 pb-4 pt-0 bg-indigo-50/30">
            <div className="space-y-3 pt-2">

              {/* ── LLM Call Intelligence ─────────────────────────────── */}
              {hasLlm && (
                <div className="bg-gradient-to-br from-indigo-50 to-violet-50 border border-indigo-200 rounded-lg p-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">🧠</span>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-700">Call Intelligence — LLM Analysis</p>
                    <div className="flex items-center gap-1.5 ml-auto">
                      {sentimentBadge(row.sentiment)}
                      <span className="text-[10px] text-slate-500 font-medium">Interest {row.interest_score}/10</span>
                    </div>
                  </div>

                  {/* Call Summary */}
                  {row.llm_call_summary && (
                    <div>
                      <p className="text-[9px] font-semibold uppercase tracking-wider text-indigo-500 mb-1">Call Summary</p>
                      <p className="text-[11px] text-slate-700 leading-relaxed">{row.llm_call_summary}</p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Key Highlights */}
                    {Array.isArray(row.key_highlights) && row.key_highlights.length > 0 && (
                      <div className="bg-white/70 rounded p-2">
                        <p className="text-[9px] font-semibold uppercase tracking-wider text-violet-600 mb-1.5">✨ Key Highlights</p>
                        <ul className="space-y-1">
                          {(row.key_highlights as string[]).map((h, i) => (
                            <li key={i} className="text-[10px] text-slate-700 leading-snug flex gap-1">
                              <span className="text-violet-400 shrink-0">•</span>
                              <span>{h}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Prospect Profile */}
                    {row.prospect_profile && (
                      <div className="bg-white/70 rounded p-2 space-y-1.5">
                        <p className="text-[9px] font-semibold uppercase tracking-wider text-blue-600 mb-1.5">👤 Prospect Profile</p>
                        {row.prospect_profile.decision_authority && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] text-slate-500 w-16 shrink-0">Authority</span>
                            <span className="text-[10px] font-medium text-slate-700 capitalize">{String(row.prospect_profile.decision_authority).replace(/_/g, " ")}</span>
                          </div>
                        )}
                        {row.prospect_profile.budget_status && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] text-slate-500 w-16 shrink-0">Budget</span>
                            <span className="text-[10px] font-medium text-slate-700 capitalize">{String(row.prospect_profile.budget_status).replace(/_/g, " ")}</span>
                          </div>
                        )}
                        {row.prospect_profile.timeline && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] text-slate-500 w-16 shrink-0">Timeline</span>
                            <span className="text-[10px] font-medium text-slate-700 capitalize">{String(row.prospect_profile.timeline).replace(/_/g, " ")}</span>
                          </div>
                        )}
                        {Array.isArray(row.prospect_profile.pain_points) && row.prospect_profile.pain_points.length > 0 && (
                          <div>
                            <p className="text-[9px] text-slate-500 mb-0.5">Pain Points</p>
                            {(row.prospect_profile.pain_points as string[]).map((p, i) => (
                              <p key={i} className="text-[10px] text-slate-700 flex gap-1"><span className="text-red-400">•</span>{p}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Recommended Action + Next Steps */}
                  <div className="bg-white/80 rounded p-2.5 border border-emerald-100">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <p className="text-[9px] font-semibold uppercase tracking-wider text-emerald-700 mb-1">
                          ✅ Recommended Action
                          {row.owning_team && (
                            <span className={`ml-2 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase ${row.owning_team === "sales" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>
                              {row.owning_team}
                            </span>
                          )}
                        </p>
                        <p className="text-[11px] text-slate-800 font-medium leading-snug">{row.recommended_action}</p>
                        {row.action_timing && (
                          <p className="text-[9px] text-muted-foreground mt-0.5">⏰ {row.action_timing.replace(/_/g, " ")}</p>
                        )}
                      </div>
                    </div>
                    {row.action_reason && (
                      <p className="text-[10px] text-slate-500 mt-1.5 italic leading-snug">{row.action_reason}</p>
                    )}
                  </div>

                  {/* Follow-up message */}
                  {row.follow_up_message && (
                    <div className="bg-amber-50 border border-amber-100 rounded p-2.5">
                      <p className="text-[9px] font-semibold uppercase tracking-wider text-amber-700 mb-1">📧 Ready-to-Send Follow-Up</p>
                      <p className="text-[11px] text-slate-700 leading-relaxed italic">{row.follow_up_message}</p>
                    </div>
                  )}

                  {/* Sentiment justification */}
                  {(row.sentiment_justification || row.interest_justification) && (
                    <div className="flex gap-3 flex-wrap">
                      {row.sentiment_justification && (
                        <p className="text-[10px] text-slate-500 leading-snug flex-1 min-w-0">
                          <span className="font-semibold text-indigo-600">Sentiment: </span>{row.sentiment_justification}
                        </p>
                      )}
                      {row.interest_justification && (
                        <p className="text-[10px] text-slate-500 leading-snug flex-1 min-w-0">
                          <span className="font-semibold text-indigo-600">Interest: </span>{row.interest_justification}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Rule-based AI Summary (legacy) ───────────────────── */}
              {row.ai_summary && !hasLlm && (
                <div className="bg-white border border-indigo-100 rounded-lg p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600 mb-1.5">🤖 AI Call Summary</p>
                  <p className="text-[11px] text-slate-700 leading-relaxed">{row.ai_summary}</p>
                </div>
              )}
              {row.ai_next_steps && !hasLlm && (
                <div className="bg-white border border-emerald-100 rounded-lg p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1.5">✅ Recommended Next Steps</p>
                  <div className="space-y-1">
                    {row.ai_next_steps.split("\n").filter(Boolean).map((step: string, i: number) => (
                      <p key={i} className="text-[11px] text-slate-700 leading-snug">{step}</p>
                    ))}
                  </div>
                </div>
              )}

              {/* Transcript toggle */}
              {transcriptText && (
                <div>
                  <button
                    className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium"
                    onClick={e => { e.stopPropagation(); setShowTranscript(v => !v); }}
                  >
                    {showTranscript ? "▲ hide transcript" : "▼ show full transcript"}
                  </button>
                  {showTranscript && (
                    <div className="mt-1.5 text-[11px] text-slate-700 leading-relaxed max-h-48 overflow-y-auto bg-white border border-indigo-100 rounded p-2.5 font-mono whitespace-pre-wrap">
                      {transcriptText}
                    </div>
                  )}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const VALID_SECTIONS = ["traffic","stage","content","source","users","depth","abm","accounts","account-intel","velocity","score-intel","playbook","score-corrections","calls","call-intel","calls-intel","intent-timeline"] as const;
type SectionId = typeof VALID_SECTIONS[number];

function getSectionFromUrl(): SectionId {
  try {
    const p = new URLSearchParams(window.location.search);
    const s = p.get("section") ?? "";
    return (VALID_SECTIONS as readonly string[]).includes(s) ? (s as SectionId) : "traffic";
  } catch { return "traffic"; }
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const { toast } = useToast();
  const [section, setSection] = useState<SectionId>(getSectionFromUrl);

  const changeSection = (s: SectionId) => {
    setSection(s);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("section", s);
      window.history.replaceState(null, "", url.toString());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    const handlePop = () => setSection(getSectionFromUrl());
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);
  const [abmPage, setAbmPage] = useState(1);
  const [intelPage, setIntelPage] = useState(1);
  const [abmUnique, setAbmUnique] = useState(false);
  const [filters, setFilters] = useState<Filters>(getFiltersFromUrl);
  const [hpLegacy, setHpLegacy] = useState(false);
  const { data: hpClients = [], isLoading: hpClientsLoading } = useQuery<any[]>({ queryKey: ["clients"], queryFn: () => api("/clients") });
  const hpSelected = hpClients.some(c => String(c.id) === filters.clientId
    && /^(hp|hp india|hewlett[ -]packard(?: india)?|hp inc\.?)$/i.test(c.name));
  useEffect(() => { setHpLegacy(false); }, [filters.clientId]);
  const [drill, setDrill] = useState<DrillState>({ open: false, title: "", extraParams: {} });
  const [intelAccountId, setIntelAccountId] = useState<number | null>(null);
  useEffect(() => { setIntelAccountId(null); }, [section]);
  const [drillContactId, setDrillContactId] = useState<number | null>(null);
  const [drillContactName, setDrillContactName] = useState("");
  const [visitorSheet, setVisitorSheet] = useState<{
    open: boolean; visitorToken: string | null;
    name: string; stage: string; company: string;
  }>({ open: false, visitorToken: null, name: "", stage: "pre-aware", company: "" });

  const fp = useMemo(() => {
    const r: Record<string,string> = {};
    const { stages, companyIds, inboundAccountIds, inboundOnly, ...rest } = filters;
    Object.entries(rest).forEach(([k, v]) => { if (v) r[k] = v as string; });
    // Stages: single → backward-compat "stage", multiple → new "stages" (comma-sep)
    if (stages.length === 1) r["stage"] = stages[0];
    else if (stages.length > 1) r["stages"] = stages.join(",");
    // Inbound scoping is opt-in; an empty dropdown is not an account filter.
    const selectedAccounts = inboundAccountIds.length ? inboundAccountIds : companyIds;
    if (selectedAccounts.length === 1) r["companyId"] = selectedAccounts[0];
    else if (selectedAccounts.length > 1) r["companyIds"] = selectedAccounts.join(",");
    else if (inboundOnly && filters.clientId) r["inboundOnly"] = "1";
    return r;
  }, [filters]);

  // Reset to page 1 whenever any filter changes so stale page offsets
  // don't produce empty "page N of 1" results after narrowing the set.
  useEffect(() => { setAbmPage(1); }, [fp]);
  useEffect(() => { setIntelPage(1); }, [fp]);

  const openDrill = (title: string, extra: Record<string,string> = {}) => {
    setDrill({ open: true, title, extraParams: extra });
    setDrillContactId(null);
    setDrillContactName("");
  };

  const drillParams = useMemo(() => {
    // _strip: comma-sep list of fp keys to omit for this specific drill
    // (e.g. company drills should ignore the active stage filter)
    const stripKeys = drill.extraParams._strip ? String(drill.extraParams._strip).split(",") : [];
    const base = stripKeys.length
      ? Object.fromEntries(Object.entries(fp).filter(([k]) => !stripKeys.includes(k)))
      : fp;
    const { _strip, ...extra } = drill.extraParams;
    return { ...base, ...extra };
  }, [fp, drill.extraParams]);

  // Main data queries
  const trafficSummaryQuery = useQuery({
    queryKey: ["analytics","traffic", fp],
    queryFn: () => trafficApi(`/analytics/traffic${qs({ part: "summary", ...fp })}`),
    enabled: section === "traffic" && !hpClientsLoading && (!hpSelected || hpLegacy),
  });
  const { data: trafficSummary, isLoading: trafficSummaryLoading } = trafficSummaryQuery;
  const trafficSummarySettled = trafficSummaryQuery.isFetched && !trafficSummaryQuery.isFetching;
  const trafficDetailsQuery = useQuery({
    queryKey: ["analytics","traffic-details", fp],
    queryFn: () => trafficApi(`/analytics/traffic${qs({ part: "details", ...fp })}`),
    enabled: section === "traffic" && !hpClientsLoading && (!hpSelected || hpLegacy) && trafficSummarySettled,
  });
  const { data: trafficDetails, isLoading: trafficDetailsLoading } = trafficDetailsQuery;
  const trafficDetailsPending = !trafficSummarySettled || trafficDetailsLoading;
  const traffic = trafficSummary && trafficDetails ? { ...trafficSummary, ...trafficDetails } : undefined;
  const trafficLoading = trafficSummaryLoading || trafficDetailsPending;
  const { data: stageDist, isLoading: sdL } = useQuery({
    queryKey: ["analytics","stage-dist", fp],
    queryFn: () => api(`/analytics/stage-distribution${qs(fp)}`),
    enabled: section === "stage",
  });
  const { data: content, isLoading: cL } = useQuery({
    queryKey: ["analytics","content", fp],
    queryFn: () => api(`/analytics/content-popularity${qs(fp)}`),
    enabled: section === "stage" || section === "content",
  });
  const { data: trafficSrc, isLoading: tsL } = useQuery({
    queryKey: ["analytics","traffic-src", fp],
    queryFn: () => api(`/analytics/traffic-source${qs(fp)}`),
    enabled: section === "source",
  });
  const { data: usersByStage = [], isLoading: ubL } = useQuery<any[]>({
    queryKey: ["analytics","users-by-stage", fp],
    queryFn: () => api(`/analytics/users-by-stage${qs(fp)}`),
    enabled: section === "users",
  });

  // Drill contacts query
  const { data: drillContacts = [], isLoading: drillLoading } = useQuery<any[]>({
    queryKey: ["analytics","drill", drillParams],
    queryFn:  () => api(`/analytics/contacts-drill${qs(drillParams)}`),
    enabled: drill.open,
  });

  // Scroll depth query
  const { data: scrollDepth, isLoading: sdepL } = useQuery({
    queryKey: ["analytics","scroll-depth", fp],
    queryFn:  () => api(`/analytics/scroll-depth${qs(fp)}`),
    enabled: section === "depth",
  });

  // ABM data query
  // Visitor timeline — fetches all events for a single anonymous visitor_token
  const { data: visitorEventsData, isLoading: visitorEventsLoading } = useQuery({
    queryKey: ["visitor-timeline", visitorSheet.visitorToken],
    queryFn: () => {
      if (!visitorSheet.visitorToken) return Promise.resolve({ rows: [] });
      return fetch(
        `/api/analytics/abm-data?visitorToken=${encodeURIComponent(visitorSheet.visitorToken)}&limit=200`,
        { credentials: "include" },
      ).then(r => r.json());
    },
    enabled: visitorSheet.open && !!visitorSheet.visitorToken,
    staleTime: 60_000,
  });

  const abmQuery = useQuery({
    queryKey: ["analytics","abm-data", fp, abmPage],
    queryFn:  () => api(`/analytics/abm-data${qs({ ...fp, page: String(abmPage) })}`),
    enabled: section === "abm",
  });
  const { data: abmData, isLoading: abmL } = abmQuery;
  const sourceRows: any[] = section === "traffic"
    ? [...(trafficDetails?.table ?? []), ...(trafficDetails?.contacts ?? []).map((row: any) => ({ ...row, contact_id: row.id }))]
    : section === "abm" ? (abmData?.rows ?? []) : [];
  const acquisition = useAcquisition(
    sourceRows.map(row => row.contact_id),
    sourceRows.map(row => row.company_id),
    section === "traffic" || section === "abm",
  );

  const landingUrlsQuery = useQuery<{ landingUrls: any[]; ctaUrls: any[] }>({
    queryKey: ["analytics","landing-urls", fp],
    queryFn:  () => trafficApi(`/analytics/landing-urls${qs(fp)}`),
    enabled: section === "traffic" && !hpClientsLoading && (!hpSelected || hpLegacy) && trafficSummarySettled,
  });
  const { data: landingUrlData, isLoading: luL } = landingUrlsQuery;
  const landingUrlsLoading = luL || (section === "traffic" && !trafficSummarySettled && !landingUrlData);

  const accountIntelQuery = useQuery<{ rows: any[]; page: number; limit: number; hasMore: boolean }>({
    queryKey: ["analytics-account-intel", fp, intelPage],
    queryFn:  () => api(`/analytics/account-intelligence${qs({ ...fp, page: String(intelPage) })}`),
    enabled: section === "account-intel",
  });
  const { isLoading: aiL } = accountIntelQuery;
  const accountIntel = accountIntelQuery.data?.rows ?? [];
  const accountIntelIds = accountIntel.map(row => row.id as number | null);
  const accountIntelSources = useAcquisition(
    [], accountIntelIds, section === "account-intel",
  );

  const { data: velocityData, isLoading: velL } = useQuery<{ stageTransitions: any[]; conversionRates: any[] }>({
    queryKey: ["analytics-velocity", fp],
    queryFn:  () => api(`/analytics/journey-velocity${qs(fp)}`),
    enabled: section === "velocity",
  });

  const { data: scoreIntel, isLoading: siL } = useQuery<{ distribution: any[]; risers: any[]; trend: any[]; byAccount: any[] }>({
    queryKey: ["analytics-score-intel", fp],
    queryFn:  () => api(`/analytics/score-intelligence${qs(fp)}`),
    enabled: section === "score-intel",
  });

  const { data: playbookData, isLoading: pbL } = useQuery<{ contacts: any[]; accounts: any[]; plays: any[] }>({
    queryKey: ["analytics-playbook", fp],
    queryFn:  () => api(`/analytics/playbook-recommendations${qs(fp)}`),
    enabled: section === "playbook",
  });

  const { data: scoreCorrections, isLoading: scL, refetch: refetchCorrections } = useQuery<{
    summary: { totalRuns: number; distinctContacts: number; lastRun: string | null };
    corrections: Array<{
      event_id: number; contact_id: number;
      first_name: string; last_name: string; email: string;
      old_score: number; new_score: number; delta: number;
      corrected_at: string; run_id: string | null;
    }>;
  }>({
    queryKey: ["analytics-score-corrections", fp],
    queryFn: () => api(`/analytics/score-corrections${qs(fp)}`),
    enabled: section === "score-corrections",
  });

  const runScoreCorrection = useMutation({
    mutationFn: () =>
      fetch("/api/analytics/recalculate-scores", { method: "POST", credentials: "include" }).then(r => r.json()),
    onSuccess: () => { refetchCorrections(); },
  });

  // ── Call Intelligence queries ─────────────────────────────────────────────
  const [ciFilters, setCiFilters] = useState({ sentiment: "", owning_team: "", score_min: "", score_max: "", status: "", search: "", dateFrom: "", dateTo: "", page: 1 });
  const [ciDetail, setCiDetail]   = useState<any | null>(null);

  const { data: ciAggregate, isLoading: ciaL, refetch: refetchCiAgg } = useQuery<{
    summary: {
      total: number; completed: number; failed: number; processing: number; avgScore: number;
      sentimentBreakdown: { positive: number; neutral: number; negative: number };
      teamBreakdown: { sales: number; marketing: number };
      scoreBands: { hot: number; warm: number; cold: number };
    };
    scoreDistribution: Array<{ score: number; count: number }>;
    actionTimingBreakdown: Array<{ timing: string; count: number }>;
    recentFailures: any[];
    callsOverTime: Array<{ day: string; completed: number; failed: number }>;
    salesVsMarketing: Array<{ timing: string; sales: number; marketing: number }>;
  }>({
    queryKey: ["analytics-ci-agg", fp],
    queryFn: () => api(`/analytics/call-intelligence/aggregate${qs(fp)}`),
    enabled: section === "call-intel" || section === "calls-intel",
  });

  const ciListQs = useMemo(() => {
    const p: Record<string, string> = { page: String(ciFilters.page), limit: "20" };
    if (ciFilters.sentiment)   p.sentiment    = ciFilters.sentiment;
    if (ciFilters.owning_team) p.owning_team  = ciFilters.owning_team;
    if (ciFilters.score_min)   p.score_min    = ciFilters.score_min;
    if (ciFilters.score_max)   p.score_max    = ciFilters.score_max;
    if (ciFilters.status)      p.status       = ciFilters.status;
    if (ciFilters.search)      p.search       = ciFilters.search;
    if (ciFilters.dateFrom)    p.dateFrom     = ciFilters.dateFrom;
    if (ciFilters.dateTo)      p.dateTo       = ciFilters.dateTo;
    return p;
  }, [ciFilters]);

  const { data: ciList, isLoading: ciL, refetch: refetchCiList } = useQuery<{
    items: any[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>({
    queryKey: ["analytics-ci-list", ciListQs, fp],
    queryFn: () => api(`/analytics/call-intelligence${qs({ ...fp, ...ciListQs })}`),
    enabled: section === "call-intel" || section === "calls-intel",
  });

  const [callsPage, setCallsPage] = useState(1);
  const [callsExporting, setCallsExporting] = useState(false);

  const [abmExporting, setAbmExporting] = useState(false);
  const [intelExporting, setIntelExporting] = useState(false);

  async function handleIntelExport(fmt: "excel" | "pdf") {
    setIntelExporting(true);
    try {
      const result = await api(`/analytics/account-intelligence${qs({ ...fp, export: "true" })}`);
      const rows: any[] = result.rows ?? [];
      const ids = [...new Set(rows.map(row => Number(row.id)).filter(id => Number.isSafeInteger(id) && id > 0))];
      const sources: Record<string, { sources: string[] }> = {};
      for (let i = 0; i < ids.length; i += 200) {
        const response = await fetch("/api/analytics/acquisition", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountIds: ids.slice(i, i + 200), contactIds: [] }),
        });
        if (!response.ok) throw new Error("Acquisition sources could not be loaded");
        Object.assign(sources, (await response.json()).accounts);
      }
      const exportRows = rows.map(row => ({ ...row, acquisition_sources: sources[String(row.id)]?.sources ?? [] }));
      if (fmt === "excel") exportAccountIntelExcel(exportRows);
      else exportAccountIntelPdf(exportRows);
    } catch {
      toast({ title: "Could not export the full account portfolio", variant: "destructive" });
    } finally {
      setIntelExporting(false);
    }
  }

  async function handleAbmExport(fmt: "excel" | "pdf") {
    setAbmExporting(true);
    try {
      const data = await api(`/analytics/abm-data${qs({ ...fp, export: "true" })}`);
      const rows = data.rows ?? [];
      if (fmt === "excel") exportAbmExcel(rows);
      else exportAbmPdf(rows);
    } finally {
      setAbmExporting(false);
    }
  }

  async function handleCallsExport(fmt: "excel" | "pdf") {
    setCallsExporting(true);
    try {
      const data = await api(`/analytics/calls/export${qs(fp)}`);
      const calls = data.calls ?? [];
      if (fmt === "excel") exportCallsExcel(calls);
      else exportCallsPdf(calls);
    } finally {
      setCallsExporting(false);
    }
  }

  const { data: callsData, isLoading: callsL, refetch: refetchCallsKpi } = useQuery<{
    kpi: {
      totalCalls: number; connected: number; interested: number;
      avgDuration: number; totalCampaigns: number; connectionRate: number; completionRate: number;
    };
    outcomeBreakdown: Array<{ outcome: string; count: number }>;
    campaigns: any[];
    recentCalls: any[];
    intelligence: {
      analysed: number;
      avgInterestScore: number;
      sentimentBreakdown: { positive: number; neutral: number; negative: number };
      teamBreakdown: { sales: number; marketing: number };
    };
  }>({
    queryKey: ["analytics-calls", fp],
    queryFn: () => api(`/analytics/calls${qs(fp)}`),
    enabled: section === "calls",
  });

  const { data: recentCallsData, isLoading: recentCallsL, refetch: refetchCalls } = useQuery<{
    calls: any[];
    total: number;
    page: number;
    pageSize: number;
  }>({
    queryKey: ["analytics-calls-recent", callsPage, fp],
    queryFn: () => api(`/analytics/calls/recent${qs({ ...fp, page: String(callsPage) })}`),
    enabled: section === "calls",
  });

  const { data: topOppData, isLoading: topOppL } = useQuery<{ opportunities: TopOpportunity[] }>({
    queryKey: ["analytics-calls-top-opportunities", fp],
    queryFn: () => api(`/analytics/calls/top-opportunities${qs(fp)}`),
    enabled: section === "calls",
    staleTime: 60_000,
  });

  const gtmContactIds = useMemo(() => {
    const ids: Array<number | null | undefined> = [];
    if (section === "traffic" || section === "abm") {
      ids.push(...sourceRows.map((row: any) => row.contact_id));
    }
    if (section === "score-intel") ids.push(...(scoreIntel?.risers ?? []).map((row: any) => row.id));
    if (section === "score-corrections") ids.push(...(scoreCorrections?.corrections ?? []).map(row => row.contact_id));
    if (section === "playbook") ids.push(...(playbookData?.contacts ?? []).map((row: any) => row.id));
    if (section === "calls") {
      ids.push(...(recentCallsData?.calls ?? []).map((row: any) => row.contact_id));
      ids.push(...(callsData?.recentCalls ?? []).map((row: any) => row.contact_id));
      ids.push(...(topOppData?.opportunities ?? []).map((row: any) => row.contact_id));
    }
    if (section === "call-intel" || section === "calls-intel") {
      ids.push(...(ciList?.items ?? []).map((row: any) => row.contact_id));
    }
    if (drill.open) ids.push(...drillContacts.map((row: any) => row.id));
    return ids;
  }, [section, sourceRows, scoreIntel, scoreCorrections, playbookData, recentCallsData, callsData, topOppData, ciList, drill.open, drillContacts]);
  const gtmStatusQuery = useGtmStatuses(gtmContactIds);
  const gtmStatuses = gtmStatusQuery.data ?? {};
  const gtmLoading = gtmStatusQuery.isLoading;
  const gtmError = gtmStatusQuery.isError;

  const sections = [
    { id:"traffic",           label:"Traffic" },
    { id:"stage",             label:"Content Affinity by Stage" },
    { id:"content",           label:"Popularity" },
    { id:"source",            label:"Source of Traffic" },
    { id:"users",             label:"Users & Journeys" },
    { id:"depth",             label:"Scroll Depth" },
    { id:"abm",               label:"ABM Data" },
    { id:"accounts",          label:"Accounts" },
    { id:"account-intel",     label:"Autonomous GTM OS" },
    { id:"intent-timeline",   label:"Intent Timeline" },
    { id:"velocity",          label:"Journey Velocity" },
    { id:"score-intel",       label:"Score Intelligence" },
    { id:"playbook",          label:"Playbook" },
    { id:"score-corrections", label:"Score Corrections" },
    { id:"calls",             label:"Call Campaigns" },
    { id:"call-intel",        label:"🧠 Call Intelligence" },
  ] as const;
  const moreSectionIds: readonly SectionId[] = [
    "intent-timeline", "accounts", "depth", "velocity", "account-intel",
    "score-intel", "playbook", "score-corrections", "calls", "call-intel",
  ];
  const moreSections = sections.filter(s => moreSectionIds.includes(s.id));
  const moreIsActive = moreSectionIds.includes(section);

  const clickProps = (title: string, extra: Record<string,string> = {}) => ({
    onClick: () => openDrill(title, extra),
    className: "cursor-pointer",
    style: { outline: "none" } as React.CSSProperties,
  });

  if (hpSelected && !hpLegacy) return (
    <div className="flex flex-col h-full min-w-0 max-w-full overflow-y-auto overflow-x-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-card px-4 sm:px-6 py-3 shrink-0">
        <label className="flex items-center gap-2 text-sm font-medium">Client
          <select aria-label="Analytics client" className="rounded-md border bg-background px-3 py-1.5" value={filters.clientId}
            onChange={e => setFilters(f => ({ ...f, clientId: e.target.value }))}>
            <option value="">All Clients</option>
            {hpClients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button className="text-sm text-primary hover:underline" onClick={() => setHpLegacy(true)}>Detailed engagement analytics</button>
      </div>
      <HpBiDashboard clientId={Number(filters.clientId)} />
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4 shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
        {hpSelected && <button className="text-sm text-primary hover:underline" onClick={() => setHpLegacy(false)}>Back to HP Commercial Marketing BI</button>}
        <p className="text-sm text-muted-foreground mt-0.5">Traffic, engagement and stage progression — click any chart element to drill down · Report times: GMT+05:30 ({REPORT_TIME_ZONE})</p>
      </div>

      {/* Filter bar */}
      {section !== "intent-timeline" && <FilterBar filters={filters} onChange={setFilters} />}

      {/* Section tabs */}
      <div className="border-b bg-card px-6 flex gap-0 shrink-0 overflow-x-auto scrollbar-none">
        {sections.filter(s => !moreSectionIds.includes(s.id)).map(s => (
          <button key={s.id} onClick={() => changeSection(s.id as SectionId)}
            className={cn("px-3 py-3 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0",
              section === s.id ? "border-indigo-600 text-indigo-600 font-semibold" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {s.label}
          </button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="More analytics sections"
              className={cn("px-3 py-3 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1",
                moreIsActive ? "border-indigo-600 text-indigo-600 font-semibold" : "border-transparent text-muted-foreground hover:text-foreground")}>
              More <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {moreSections.map(s => (
              <DropdownMenuItem key={s.id} onSelect={() => changeSection(s.id)}
                className={cn("cursor-pointer", section === s.id && "bg-indigo-50 text-indigo-700 font-semibold")}
                aria-current={section === s.id ? "page" : undefined}>
                {s.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Per-section export bar */}
      <div className="border-b bg-muted/10 px-6 py-2 flex items-center justify-between shrink-0">
        <p className="text-[11px] text-muted-foreground">
          {sections.find(s => s.id === section)?.label}{section !== "accounts" ? " — Download this report" : " — Account activity for the selected filters"}
        </p>
        {section === "traffic" && (
          <ExportMenu disabled={trafficLoading || !traffic} onExcel={() => exportTrafficExcel(traffic)} onPdf={() => exportTrafficPdf(traffic)} />
        )}
        {section === "stage" && (
          <ExportMenu disabled={sdL || cL || !stageDist} onExcel={() => exportStageExcel(stageDist, content)} onPdf={() => exportStagePdf(stageDist, content)} />
        )}
        {section === "content" && (
          <ExportMenu disabled={cL || !content} onExcel={() => exportContentExcel(content)} onPdf={() => exportContentPdf(content)} />
        )}
        {section === "source" && (
          <ExportMenu disabled={tsL || !trafficSrc} onExcel={() => exportSourceExcel(trafficSrc)} onPdf={() => exportSourcePdf(trafficSrc)} />
        )}
        {section === "users" && (
          <ExportMenu disabled={ubL || !usersByStage.length} onExcel={() => exportUsersExcel(usersByStage)} onPdf={() => exportUsersPdf(usersByStage)} />
        )}
        {section === "depth" && (
          <ExportMenu disabled={sdepL || !scrollDepth} onExcel={() => exportScrollDepthExcel(scrollDepth)} onPdf={() => exportScrollDepthPdf(scrollDepth)} />
        )}
        {section === "abm" && (
          <ExportMenu disabled={abmL || abmExporting} onExcel={() => handleAbmExport("excel")} onPdf={() => handleAbmExport("pdf")} />
        )}
        {section === "accounts" && <span className="text-[11px] text-muted-foreground">Open an account for its activity history</span>}
        {section === "account-intel" && (
          <ExportMenu disabled={aiL || intelExporting || accountIntelQuery.isError || !accountIntel.length} onExcel={() => void handleIntelExport("excel")} onPdf={() => void handleIntelExport("pdf")} />
        )}
        {section === "velocity" && (
          <ExportMenu disabled={velL || !velocityData} onExcel={() => exportVelocityExcel(velocityData ?? { stageTransitions: [], conversionRates: [] })} onPdf={() => exportVelocityPdf(velocityData ?? { stageTransitions: [], conversionRates: [] })} />
        )}
        {section === "score-intel" && (
          <ExportMenu disabled={siL || !scoreIntel} onExcel={() => exportScoreIntelExcel(scoreIntel ?? { distribution: [], risers: [], trend: [], byAccount: [] })} onPdf={() => exportScoreIntelPdf(scoreIntel ?? { distribution: [], risers: [], trend: [], byAccount: [] })} />
        )}
        {section === "playbook" && (
          <span className="text-[11px] text-muted-foreground italic">Live recommendations — no export</span>
        )}
        {section === "score-corrections" && (
          <span className="text-[11px] text-muted-foreground italic">Bot score corrections — no export</span>
        )}
        {section === "calls" && (
          <span className="text-[11px] text-muted-foreground italic">Call campaign analytics — no export</span>
        )}
        {section === "intent-timeline" && (
          <span className="text-[11px] text-muted-foreground">Account and person-level evidence · event time and import time</span>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {section === "intent-timeline" && <IntentOpportunityTimeline />}
        {section === "accounts" && <AccountsAnalyticsPanel filters={fp} />}
        {(section === "users" || section === "abm") && filters.clientId && filters.inboundAccountIds.length === 1 && (
          <InboundJourneyPanel
            clientId={filters.clientId} accountId={filters.inboundAccountIds[0]}
            playId={filters.playId} journeyId={filters.journeyId}
            dateFrom={filters.dateFrom} dateTo={filters.dateTo}
            onContact={(id, name) => {
              setDrill({ open: true, title: `${name} — Timeline`, extraParams: {} });
              setDrillContactId(id);
              setDrillContactName(name);
            }}
          />
        )}

        {/* ── Traffic ─────────────────────────────────────────────────── */}
        {section === "traffic" && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {trafficSummaryLoading ? Array.from({length:4}).map((_,i)=><Skeleton key={i} className="h-24"/>) : trafficSummaryQuery.isError && !trafficSummary ? (
                <p role="alert" className="col-span-full rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  Unable to load traffic summary: {trafficSummaryQuery.error instanceof Error ? trafficSummaryQuery.error.message : "Request failed"}
                </p>
              ) : (
                <>
                  {[
                    { label:"Total Visits",     val:(trafficSummary?.kpi?.visits ?? 0).toLocaleString(),      icon:Eye,       color:"text-indigo-600", bg:"bg-indigo-50",  extra:{ eventType:"page_view" } },
                    { label:"Unique Visitors",  val:(trafficSummary?.kpi?.uniqueVisits ?? 0).toLocaleString(),icon:Users,     color:"text-sky-600",    bg:"bg-sky-50",     extra:{ eventType:"page_view" } },
                    { label:"Form Fills",       val:(trafficSummary?.kpi?.formFills ?? 0).toLocaleString(),   icon:FileText,  color:"text-emerald-600",bg:"bg-emerald-50", extra:{ eventType:"form_submit" } },
                    { label:"Downloads",        val:(trafficSummary?.kpi?.downloads ?? 0).toLocaleString(),   icon:Download,  color:"text-amber-600",  bg:"bg-amber-50",   extra:{ eventType:"asset_download" } },
                  ].map(({ label, val, icon: Icon, color, bg, extra }) => (
                    <Card key={label} className="shadow-xs hover:shadow-sm transition-shadow cursor-pointer group" onClick={() => openDrill(`${label} — Contacts`, extra)}>
                      <CardContent className="px-4 pt-3 pb-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className={cn("w-6 h-6 rounded flex items-center justify-center", bg)}>
                            <Icon className={cn("w-3.5 h-3.5", color)} />
                          </div>
                          <ChevronRight className="w-3 h-3 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                        <p className="text-xs text-muted-foreground">{label}</p>
                        <p className="text-2xl font-bold text-foreground mt-0.5">{val}</p>
                      </CardContent>
                    </Card>
                  ))}
                </>
              )}
            </div>
            {!trafficSummaryLoading && !trafficSummaryQuery.isError && (trafficSummary?.kpi?.botFiltered ?? 0) > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                  <span><strong className="text-amber-700">{(trafficSummary.kpi.botFiltered).toLocaleString()} bot events filtered</strong> — traffic KPIs show real human visits only (email security scanners excluded)</span>
              </div>
            )}

            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold">Visits Over Time (Last 30 Days)</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {trafficSummaryLoading ? <Skeleton className="h-56"/> : trafficSummaryQuery.isError && !trafficSummary ? (
                  <p role="alert" className="py-10 text-center text-sm text-red-700">
                    Unable to load traffic trend: {trafficSummaryQuery.error instanceof Error ? trafficSummaryQuery.error.message : "Request failed"}
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={trafficSummary?.trend ?? []} margin={{ left:0, right:8, top:4, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9"/>
                      <XAxis dataKey="date" tick={{ fontSize:10 }} tickFormatter={d => formatReportDayLabel(String(d))}/>
                      <YAxis tick={{ fontSize:11 }} allowDecimals={false} width={28}/>
                      <Tooltip contentStyle={{ fontSize:12 }} labelFormatter={d => formatReportDayLabel(String(d), true)}/>
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize:12 }}/>
                      <Line type="monotone" dataKey="visits" name="Visits" stroke="#6366f1" strokeWidth={2} dot={false}/>
                      <Line type="monotone" dataKey="unique_visits" name="Unique" stroke="#06b6d4" strokeWidth={2} dot={false} strokeDasharray="4 2"/>
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-3 px-4 flex-row items-center justify-between space-y-0">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-muted-foreground" />
                  <CardTitle className="text-sm font-semibold">Traffic Data</CardTitle>
                </div>
                <Select defaultValue="visits">
                  <SelectTrigger className="h-7 text-xs w-[130px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="visits">Visits</SelectItem>
                    <SelectItem value="unique">Unique Visitors</SelectItem>
                    <SelectItem value="forms">Form Fills</SelectItem>
                    <SelectItem value="downloads">Downloads</SelectItem>
                  </SelectContent>
                </Select>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <div className="px-4 pb-2"><SourceLegend />{acquisition.isError && <p role="alert" className="text-xs text-red-700">Acquisition sources could not be loaded.</p>}</div>
                {trafficDetailsPending ? <Skeleton className="h-48 mx-4 mb-4"/> : trafficDetailsQuery.isError && !trafficDetails ? (
                  <p role="alert" className="mx-4 my-6 text-sm text-red-700">
                    Unable to load traffic data: {trafficDetailsQuery.error instanceof Error ? trafficDetailsQuery.error.message : "Request failed"}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[900px]">
                      <thead>
                        <tr className="border-b bg-slate-50">
                          {[
                            { label:"No",                w:"w-10"   },
                            { label:"First Name",        w:"w-28"   },
                            { label:"Last Name",         w:"w-28"   },
                            { label:"Email",             w:"w-44"   },
                            { label:"Company",           w:""       },
                            { label:"Source",            w:"w-24"   },
                            { label:"IP Address",        w:"w-32"   },
                            { label:"Visit Date",        w:"w-44"   },
                            { label:"Duration in second",w:"w-36"   },
                            { label:"Link",              w:"w-16"   },
                          ].map(h => (
                            <th key={h.label} className={cn("text-left text-xs font-semibold text-indigo-600 px-3 py-2.5 whitespace-nowrap", h.w)}>
                              {h.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {(trafficDetails?.table ?? []).map((row: any, i: number) => {
                          const hasContact = !!row.contact_id;
                          const dateStr    = formatReportDateTime(row.created_at, true);
                          const src        = row.source ? (row.source.charAt(0).toUpperCase() + row.source.slice(1)) : "Direct";
                          return (
                            <tr key={row.id}
                              className={cn("transition-colors", hasContact ? "cursor-pointer hover:bg-indigo-50/60" : "hover:bg-slate-50/60")}
                              onClick={() => {
                                if (hasContact) {
                                  const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || "Contact";
                                  setDrill({ open: true, title: `${name} — Timeline`, extraParams: {} });
                                  setDrillContactId(row.contact_id);
                                  setDrillContactName(name);
                                }
                              }}>
                              <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">{i + 1}</td>
                              <td className="px-3 py-2.5 text-xs font-medium">
                                <div className="flex flex-col items-start gap-1">
                                  <span className="inline-flex items-center gap-1">{row.contact_id && row.first_name !== "Anonymous" && (row.first_name || row.last_name) && <SourceIcons data={acquisition.data?.contacts[String(row.contact_id)]} />}{row.first_name ?? <span className="text-muted-foreground">–</span>}</span>
                                  {row.contact_id && row.first_name !== "Anonymous" && <GtmStatusBadge scope="contact" status={gtmStatuses[String(row.contact_id)]} loading={gtmLoading} error={gtmError} />}
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-xs font-medium">{row.last_name  ?? <span className="text-muted-foreground">–</span>}</td>
                              <td className="px-3 py-2.5 text-xs text-muted-foreground">{row.email ?? <span>–</span>}</td>
                              <td className="px-3 py-2.5 text-xs">
                                {row.company_name
                                  ? <span className="inline-flex items-center gap-1"><SourceIcons data={acquisition.data?.accounts[String(row.company_id)]} />{row.company_name}</span>
                                  : row.company_hint
                                    ? <span className="text-muted-foreground italic">~{row.company_hint}</span>
                                    : <span className="text-muted-foreground">–</span>}
                              </td>
                              <td className="px-3 py-2.5 text-xs">
                                <span className={cn("inline-flex items-center gap-1", src === "Email" ? "text-indigo-600" : "text-slate-600")}>
                                  {src === "Email" ? <Mail className="w-3 h-3"/> : <Globe className="w-3 h-3"/>}
                                  {src}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-xs font-mono text-slate-500">{row.ip_address ?? "—"}</td>
                              <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">{dateStr}</td>
                              <td className="px-3 py-2.5 text-xs tabular-nums text-slate-700">{row.duration_seconds != null ? `${row.duration_seconds}s` : "—"}</td>
                              <td className="px-3 py-2.5">
                                <button
                                  onClick={e => { e.stopPropagation(); if (row.page_name) openDrill(`"${row.page_name}" viewers`, { pageName: row.page_name }); }}
                                  className="text-xs text-indigo-600 hover:text-indigo-800 font-medium hover:underline">
                                  Link
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {!trafficDetailsPending && !trafficDetailsQuery.isError && (trafficDetails?.table ?? []).length === 0 && (
                          <tr><td colSpan={10} className="px-4 py-10 text-center text-sm text-muted-foreground">No traffic data yet</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
            {/* ── Identified Contacts leaderboard ─────────────────────── */}
            {(() => {
              const ctxs: any[] = trafficDetails?.contacts ?? [];
              const scoreColor = (s: number | null) => {
                if (s == null) return "bg-slate-100 text-slate-600";
                if (s >= 75)   return "bg-red-100 text-red-700";
                if (s >= 50)   return "bg-orange-100 text-orange-700";
                if (s >= 25)   return "bg-yellow-100 text-yellow-700";
                return "bg-slate-100 text-slate-600";
              };
              const scoreLabel = (s: number | null) => {
                if (s == null) return "—";
                if (s >= 75)   return "Very Hot";
                if (s >= 50)   return "Hot";
                if (s >= 25)   return "Warm";
                return "Cold";
              };
              const initials = (row: any) =>
                [row.first_name, row.last_name].filter(Boolean).map((n: string) => n[0]).join("").toUpperCase() || "?";
              return (
                <Card className="shadow-xs">
                  <CardHeader className="pb-2 pt-3 px-4 flex-row items-center justify-between space-y-0">
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-muted-foreground" />
                      <CardTitle className="text-sm font-semibold">Identified Contacts</CardTitle>
                      {!trafficDetailsPending && !trafficDetailsQuery.isError && ctxs.length > 0 && (
                        <span className="text-[11px] bg-indigo-100 text-indigo-700 font-semibold rounded-full px-2 py-0.5">
                          {ctxs.length}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground">Sorted by lead score</span>
                  </CardHeader>
                  <CardContent className="px-0 pb-0">
                    <div className="px-4 pb-2"><SourceLegend />{acquisition.isError && <p role="alert" className="text-xs text-red-700">Acquisition sources could not be loaded.</p>}</div>
                    {trafficDetailsPending ? <Skeleton className="h-48 mx-4 mb-4"/> : trafficDetailsQuery.isError && !trafficDetails ? (
                      <p role="alert" className="mx-4 my-6 text-sm text-red-700">
                        Unable to load identified contacts: {trafficDetailsQuery.error instanceof Error ? trafficDetailsQuery.error.message : "Request failed"}
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[700px]">
                          <thead>
                            <tr className="border-b bg-slate-50">
                              {["#","Contact","Company","Score","Stage","Visits","Last Seen",""].map(h => (
                                <th key={h} className="text-left text-xs font-semibold text-indigo-600 px-3 py-2.5 whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {ctxs.map((row: any, i: number) => {
                              const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unknown";
                              const score = row.lead_score as number | null;
                              const stageLbl = STAGE_LABELS[row.stage] ?? row.stage ?? "—";
                              return (
                                <tr key={row.id}
                                  className="hover:bg-indigo-50/50 transition-colors cursor-pointer group"
                                  onClick={() => {
                                    setDrill({ open: true, title: `${name} — Timeline`, extraParams: {} });
                                    setDrillContactId(row.id);
                                    setDrillContactName(name);
                                  }}>
                                  <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums w-8">{i + 1}</td>
                                  <td className="px-3 py-2.5 text-xs w-48">
                                    <div className="flex items-center gap-2">
                                      <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold flex items-center justify-center shrink-0">
                                        {initials(row)}
                                      </div>
                                      <div className="min-w-0">
                                        <p className="font-medium truncate text-indigo-700 group-hover:underline inline-flex items-center gap-1"><SourceIcons data={acquisition.data?.contacts[String(row.id)]} />{name}</p>
                                        <GtmStatusBadge scope="contact" status={gtmStatuses[String(row.id)]} loading={gtmLoading} error={gtmError} />
                                        <p className="text-[11px] text-muted-foreground truncate">{row.email ?? ""}</p>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2.5 text-xs text-slate-600 w-36 truncate max-w-[140px]">{row.company_name ? <span className="inline-flex items-center gap-1"><SourceIcons data={acquisition.data?.accounts[String(row.company_id)]} />{row.company_name}</span> : <span className="text-muted-foreground">—</span>}</td>
                                  <td className="px-3 py-2.5 w-28">
                                    <div className="flex items-center gap-1.5">
                                      <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded", scoreColor(score))}>
                                        {scoreLabel(score)}
                                      </span>
                                      <span className="text-xs tabular-nums font-mono text-slate-600">{score ?? 0}</span>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2.5 text-xs w-28">
                                    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", STAGE_BG[row.stage] ?? "bg-slate-100 text-slate-600")}>
                                      {stageLbl}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2.5 text-xs tabular-nums text-slate-700 w-16">{row.visit_count ?? 0}</td>
                                  <td className="px-3 py-2.5 text-xs text-slate-500 w-32 whitespace-nowrap">
                                    {row.last_seen ? formatDistanceToNow(new Date(row.last_seen), { addSuffix: true }) : "—"}
                                  </td>
                                  <td className="px-3 py-2.5 w-8">
                                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground"/>
                                  </td>
                                </tr>
                              );
                            })}
                            {!trafficDetailsQuery.isError && ctxs.length === 0 && (
                              <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                                No identified contacts yet — visitors resolve to contacts once they click an email link or fill a form.
                              </td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

            {/* ── Landing URLs & CTA Destinations ──────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="shadow-xs">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold">Top Landing URLs</CardTitle>
                  <p className="text-[11px] text-muted-foreground">Full URLs visitors arrived at — shows campaign parameters like UTM and contact ID</p>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  {landingUrlsLoading ? (
                    <div className="space-y-2">{Array.from({length:5}).map((_,i)=><Skeleton key={i} className="h-7"/>)}</div>
                  ) : landingUrlsQuery.isError && !landingUrlData ? (
                    <p role="alert" className="py-8 text-center text-sm text-red-700">
                      Unable to load landing URLs: {landingUrlsQuery.error instanceof Error ? landingUrlsQuery.error.message : "Request failed"}
                    </p>
                  ) : (landingUrlData?.landingUrls ?? []).length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
                      <Link className="w-7 h-7 opacity-20"/>
                      <p className="text-xs text-center">No URL data yet — captured automatically on new page views</p>
                    </div>
                  ) : (
                    <div className="space-y-0 max-h-64 overflow-y-auto divide-y divide-border/40">
                      {(landingUrlData?.landingUrls ?? []).map((r: any, i: number) => {
                        let display = r.page_url;
                        try {
                          const u = new URL(r.page_url);
                          display = (u.pathname + u.search)
                            .replace(/[?&](kaboom_tid|kaboom_vt|pf_vt)=[^&]*/g, "")
                            .replace(/[?&]$/, "") || u.pathname;
                        } catch { /* keep raw */ }
                        return (
                          <div key={i} className="flex items-center gap-2 py-2">
                            <span className="text-[10px] text-muted-foreground tabular-nums w-4 shrink-0">{i + 1}</span>
                            <div className="flex-1 min-w-0">
                              <a href={r.page_url} target="_blank" rel="noreferrer" title={r.page_url}
                                 className="text-[11px] text-indigo-600 hover:underline truncate block">
                                {display}
                              </a>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="text-[11px] font-semibold tabular-nums">{r.visits}</p>
                              <p className="text-[10px] text-muted-foreground">{r.unique_visitors} uniq</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="shadow-xs">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold">Top CTA Destinations</CardTitle>
                  <p className="text-[11px] text-muted-foreground">Outbound URLs contacts clicked from within journey pages</p>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  {landingUrlsLoading ? (
                    <div className="space-y-2">{Array.from({length:5}).map((_,i)=><Skeleton key={i} className="h-7"/>)}</div>
                  ) : landingUrlsQuery.isError && !landingUrlData ? (
                    <p role="alert" className="py-8 text-center text-sm text-red-700">
                      Unable to load CTA destinations: {landingUrlsQuery.error instanceof Error ? landingUrlsQuery.error.message : "Request failed"}
                    </p>
                  ) : (landingUrlData?.ctaUrls ?? []).length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
                      <MousePointerClick className="w-7 h-7 opacity-20"/>
                      <p className="text-xs text-center">No CTA clicks recorded yet — data appears as contacts click buttons in journey pages</p>
                    </div>
                  ) : (
                    <div className="space-y-0 max-h-64 overflow-y-auto divide-y divide-border/40">
                      {(landingUrlData?.ctaUrls ?? []).map((r: any, i: number) => {
                        let display = r.cta_url;
                        try {
                          const u = new URL(r.cta_url);
                          display = u.hostname + u.pathname;
                        } catch { /* keep raw */ }
                        return (
                          <div key={i} className="flex items-center gap-2 py-2">
                            <span className="text-[10px] text-muted-foreground tabular-nums w-4 shrink-0">{i + 1}</span>
                            <div className="flex-1 min-w-0">
                              <a href={r.cta_url} target="_blank" rel="noreferrer" title={r.cta_url}
                                 className="text-[11px] text-emerald-600 hover:underline truncate block">
                                {display}
                              </a>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="text-[11px] font-semibold tabular-nums">{r.clicks}</p>
                              <p className="text-[10px] text-muted-foreground">{r.unique_clickers} uniq</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}

        {/* ── Stage Affinity ───────────────────────────────────────────── */}
        {section === "stage" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold">Contact Stage Distribution</CardTitle>
                <p className="text-[11px] text-muted-foreground">Click a slice or legend row to see those contacts</p>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {sdL ? <Skeleton className="h-64"/> : (
                  <div className="flex items-center gap-4">
                    <ResponsiveContainer width="55%" height={220}>
                      <PieChart>
                        <Pie data={stageDist?.data ?? []} dataKey="count" nameKey="stage"
                          innerRadius="55%" outerRadius="80%"
                          onClick={(d) => openDrill(`${STAGE_LABELS[d.stage] ?? d.stage} — Contacts`, { stage: d.stage })}>
                          {(stageDist?.data ?? []).map((entry: any) => (
                            <Cell key={entry.stage} fill={STAGE_COLORS[entry.stage] ?? "#94a3b8"} className="cursor-pointer hover:opacity-80"/>
                          ))}
                        </Pie>
                        <Tooltip formatter={(v: any, n: any) => [`${v} contacts`, STAGE_LABELS[n] ?? n]}/>
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="space-y-1.5 flex-1">
                      {(stageDist?.data ?? []).map((d: any) => (
                        <button key={d.stage}
                          onClick={() => openDrill(`${STAGE_LABELS[d.stage] ?? d.stage} — Contacts`, { stage: d.stage })}
                          className="w-full flex items-center gap-2 hover:bg-muted/50 rounded px-1 py-0.5 transition-colors">
                          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background:STAGE_COLORS[d.stage] }}/>
                          <span className="text-xs text-muted-foreground flex-1 text-left">{STAGE_LABELS[d.stage] ?? d.stage}</span>
                          <span className="text-xs font-semibold">{d.pct}%</span>
                          <span className="text-[11px] text-muted-foreground">({d.count})</span>
                        </button>
                      ))}
                      <div className="border-t pt-2 mt-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Total Contacts</span>
                          <span className="font-bold">{stageDist?.total ?? 0}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold">Content Affinity by Stage</CardTitle>
                <p className="text-[11px] text-muted-foreground">Click a page bar to see who viewed it</p>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-4">
                {sdL || cL ? <Skeleton className="h-48"/> : (
                  STAGE_ORDER.filter(s => (content?.byStage ?? []).some((b: any) => b.stage === s)).map(stage => {
                    const pages = (content?.byStage ?? []).filter((b: any) => b.stage === stage);
                    return (
                      <div key={stage}>
                        <button onClick={() => openDrill(`${STAGE_LABELS[stage]} — Contacts`, { stage })}
                          className="flex items-center gap-2 mb-1.5 hover:opacity-80 transition-opacity">
                          <StageBadge stage={stage}/>
                          <span className="text-[11px] text-muted-foreground">{pages.length} page{pages.length!==1?"s":""} engaged</span>
                        </button>
                        <div className="space-y-1">
                          {pages.slice(0,3).map((p: any) => (
                            <button key={p.page_name}
                              onClick={() => openDrill(`"${p.page_name}" viewers`, { pageName: p.page_name, stage })}
                              className="flex items-center gap-2 w-full hover:bg-muted/40 rounded px-1 py-0.5 transition-colors">
                              <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                                <div className="h-full rounded-full" style={{ background:STAGE_COLORS[stage], width:`${Math.min(100,(p.views/(pages[0]?.views||1))*100)}%` }}/>
                              </div>
                              <span className="text-[11px] text-foreground min-w-0 truncate max-w-[140px]">{p.page_name}</span>
                              <span className="text-[10px] text-muted-foreground shrink-0">{p.views}v</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Content Popularity ──────────────────────────────────────── */}
        {section === "content" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold">Engagement by Content</CardTitle>
                <p className="text-[11px] text-muted-foreground">Click a bar to see who viewed that page</p>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {cL ? <Skeleton className="h-56"/> : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={content?.byPage ?? []} layout="vertical" margin={{ left:4, right:24, top:4, bottom:4 }}>
                      <XAxis type="number" tick={{ fontSize:10 }} allowDecimals={false}/>
                      <YAxis type="category" dataKey="page_name" width={130} tick={{ fontSize:10 }}/>
                      <Tooltip contentStyle={{ fontSize:12 }}/>
                      <Bar dataKey="views" name="Views" fill="#6366f1" radius={[0,4,4,0]}
                        onClick={(d) => openDrill(`"${d.page_name}" viewers`, { pageName: d.page_name })}
                        className="cursor-pointer"/>
                      <Bar dataKey="unique_visitors" name="Unique" fill="#a5b4fc" radius={[0,4,4,0]}
                        onClick={(d) => openDrill(`"${d.page_name}" unique visitors`, { pageName: d.page_name })}
                        className="cursor-pointer"/>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold">Intent — Page Visit Ranking</CardTitle>
                <p className="text-[11px] text-muted-foreground">Click a page to see who visited it</p>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {cL ? <Skeleton className="h-48 mx-4 mb-4"/> : (
                  <div className="divide-y divide-border">
                    {(content?.byPage ?? []).map((p: any, i: number) => (
                      <button key={p.page_name}
                        onClick={() => openDrill(`"${p.page_name}" viewers`, { pageName: p.page_name })}
                        className="flex items-center gap-3 px-4 py-2.5 w-full hover:bg-muted/40 transition-colors">
                        <span className="text-xs text-muted-foreground w-5 text-right shrink-0">{i+1}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground truncate text-left">{p.page_name}</p>
                          <p className="text-[11px] text-muted-foreground">{p.unique_visitors} unique visitors</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Eye className="w-3 h-3 text-muted-foreground"/>
                          <span className="text-xs font-semibold">{p.views}</span>
                        </div>
                      </button>
                    ))}
                    {!cL && (content?.byPage??[]).length===0 && (
                      <div className="px-4 py-8 text-center text-sm text-muted-foreground">No page view data yet</div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Source of Traffic ───────────────────────────────────────── */}
        {section === "source" && (() => {
          const SOURCE_META: Record<string, { icon: string; bg: string; fg: string; desc: string }> = {
            "Email":        { icon:"✉️",  bg:"#eef2ff", fg:"#4f46e5", desc:"Traffic from email opens and click-through links in sequences." },
            "LinkedIn":     { icon:"in",  bg:"#dbeafe", fg:"#1d4ed8", desc:"Visitors who arrived from LinkedIn posts, ads, or InMail." },
            "Google Search":{ icon:"G",   bg:"#fef9c3", fg:"#854d0e", desc:"Organic or paid search traffic from Google." },
            "Meta":         { icon:"f",   bg:"#fce7f3", fg:"#9d174d", desc:"Traffic from Facebook, Instagram, or Meta ad campaigns." },
            "X / Twitter":  { icon:"X",   bg:"#f0f9ff", fg:"#0369a1", desc:"Visitors from X (formerly Twitter) posts or ads." },
            "Journey Link": { icon:"🔗",  bg:"#ecfdf5", fg:"#065f46", desc:"Direct journey link shares — visited via a copied or shared URL." },
            "Direct":       { icon:"🌐",  bg:"#f8fafc", fg:"#475569", desc:"Direct visits, bookmarks, or referrer not detected." },
          };
          const getSourceMeta = (s: string) => SOURCE_META[s] ?? { icon:"🌐", bg:"#f8fafc", fg:"#475569", desc:`Traffic from ${s}.` };
          return (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="shadow-xs">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold">Traffic Source Breakdown</CardTitle>
                  <p className="text-[11px] text-muted-foreground">Click a source to drill into those contacts</p>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  {tsL ? <Skeleton className="h-56"/> : (
                    <div className="flex items-center gap-6">
                      <ResponsiveContainer width="50%" height={220}>
                        <PieChart>
                          <Pie data={trafficSrc?.data ?? []} dataKey="count" nameKey="source"
                            innerRadius="55%" outerRadius="80%"
                            onClick={(d) => openDrill(`${d.source} — Contacts`, { source: d.source })}>
                            {(trafficSrc?.data ?? []).map((_: any, i: number) => (
                              <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} className="cursor-pointer hover:opacity-80"/>
                            ))}
                          </Pie>
                          <Tooltip formatter={(v: any, n: any) => [`${v} visits`, n]}/>
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="space-y-2.5 flex-1 min-w-0">
                        {(trafficSrc?.data ?? []).map((d: any, i: number) => {
                          const m = getSourceMeta(d.source);
                          return (
                            <button key={d.source}
                              onClick={() => openDrill(`${d.source} — Contacts`, { source: d.source })}
                              className="flex items-center gap-2 w-full hover:bg-muted/50 rounded p-1 transition-colors">
                              <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}/>
                              <div className="w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold shrink-0" style={{ background: m.bg, color: m.fg }}>
                                {m.icon}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-medium truncate">{d.source}</span>
                                  <span className="text-xs font-semibold shrink-0 ml-1">{d.pct}%</span>
                                </div>
                                <div className="flex-1 bg-muted rounded-full h-1 overflow-hidden mt-0.5">
                                  <div className="h-full rounded-full" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length], width:`${d.pct}%` }}/>
                                </div>
                              </div>
                              <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">{d.count}</span>
                            </button>
                          );
                        })}
                        <div className="border-t pt-2 mt-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">Total Page Views</span>
                            <span className="font-bold">{(trafficSrc?.total ?? 0).toLocaleString()}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="shadow-xs">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold">Channel Insights</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-3">
                  {tsL ? <Skeleton className="h-48"/> : (
                    (trafficSrc?.data ?? []).length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
                        <Globe className="w-8 h-8 opacity-20"/>
                        <p className="text-sm">No traffic data yet</p>
                        <p className="text-xs text-center max-w-xs">Share journey links with UTM parameters (utm_source=linkedin) to see channel attribution.</p>
                      </div>
                    ) : (
                      (trafficSrc?.data ?? []).map((d: any, i: number) => {
                        const m = getSourceMeta(d.source);
                        return (
                          <button key={d.source}
                            onClick={() => openDrill(`${d.source} — Contacts`, { source: d.source })}
                            className="rounded-lg border p-3.5 w-full text-left hover:bg-muted/40 transition-colors">
                            <div className="flex items-center gap-2.5 mb-1.5">
                              <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0" style={{ background: m.bg, color: m.fg }}>
                                {m.icon}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold">{d.source}</p>
                                <p className="text-[11px] text-muted-foreground">{d.count.toLocaleString()} visits · {d.pct}% of traffic</p>
                              </div>
                              <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}/>
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-relaxed">{m.desc}</p>
                          </button>
                        );
                      })
                    )
                  )}
                </CardContent>
              </Card>
            </div>
          );
        })()}

        {/* ── Users & Journeys ────────────────────────────────────────── */}
        {section === "users" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold">Contacts by Stage</CardTitle>
                <p className="text-[11px] text-muted-foreground">Click a bar to drill into those contacts</p>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {ubL ? <Skeleton className="h-56"/> : (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart
                      data={usersByStage.map(d => ({ ...d, label: STAGE_LABELS[d.stage] ?? d.stage }))}
                      margin={{ left:4, right:8, top:4, bottom:8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9"/>
                      <XAxis dataKey="label" tick={{ fontSize:10 }}/>
                      <YAxis tick={{ fontSize:11 }} allowDecimals={false} width={28}/>
                      <Tooltip contentStyle={{ fontSize:12 }}/>
                      <Bar dataKey="count" name="Contacts" radius={[4,4,0,0]}
                        onClick={(d) => openDrill(`${STAGE_LABELS[d.stage] ?? d.stage} — Contacts`, { stage: d.stage })}
                        className="cursor-pointer">
                        {usersByStage.map((d: any) => (
                          <Cell key={d.stage} fill={STAGE_COLORS[d.stage] ?? "#6366f1"}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold">Stage Progression Summary</CardTitle>
                <p className="text-[11px] text-muted-foreground">Click a row to see contacts at that stage</p>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {ubL ? <Skeleton className="h-48 mx-4 mb-4"/> : (
                  <div className="divide-y divide-border">
                    {STAGE_ORDER.map(stage => {
                      const d = usersByStage.find((r: any) => r.stage === stage);
                      const count = d?.count ?? 0;
                      const total = usersByStage.reduce((s: number, r: any) => s + r.count, 0);
                      const pct   = total > 0 ? Math.round((count/total)*100) : 0;
                      return (
                        <button key={stage}
                          onClick={() => openDrill(`${STAGE_LABELS[stage]} — Contacts`, { stage })}
                          className="flex items-center gap-3 px-4 py-3 w-full hover:bg-muted/40 transition-colors">
                          <StageBadge stage={stage}/>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                                <div className="h-full rounded-full transition-all" style={{ background:STAGE_COLORS[stage], width:`${pct}%` }}/>
                              </div>
                              <span className="text-[11px] text-muted-foreground shrink-0">{pct}%</span>
                            </div>
                          </div>
                          <span className="text-sm font-semibold w-6 text-right shrink-0">{count}</span>
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0"/>
                        </button>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Scroll Depth ──────────────────────────────────────────── */}
        {section === "depth" && (
          <div className="space-y-6">

            {/* Overall funnel */}
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold">Overall Engagement Depth</CardTitle>
                <p className="text-[11px] text-muted-foreground">Unique visitors who reached each time-on-page milestone across all journeys</p>
              </CardHeader>
              <CardContent className="px-4 pb-5">
                {sdepL ? <Skeleton className="h-28"/> : (() => {
                  const t = scrollDepth?.totals ?? { d25:0, d50:0, d75:0, d100:0 };
                  const base = Math.max(t.d25, 1);
                  const milestones = [
                    { label:"25%", key:"d25", color:"#6366f1", hint:"1.5 s on page" },
                    { label:"50%", key:"d50", color:"#06b6d4", hint:"10 s on page" },
                    { label:"75%", key:"d75", color:"#34d399", hint:"30 s on page" },
                    { label:"100%",key:"d100",color:"#f59e0b", hint:"60 s on page" },
                  ] as const;
                  return (
                    <div className="space-y-3 mt-2">
                      {milestones.map(m => {
                        const count = t[m.key] as number;
                        const pct = Math.round((count / base) * 100);
                        return (
                          <div key={m.label} className="flex items-center gap-3 cursor-pointer rounded hover:bg-slate-50 px-1 -mx-1 transition-colors"
                            onClick={() => openDrill(`Scroll Depth ${m.label} — Contacts`, { eventType: "scroll_depth" })}>
                            <span className="text-[11px] font-semibold w-9 shrink-0 tabular-nums" style={{ color: m.color }}>{m.label}</span>
                            <div className="flex-1 bg-muted rounded-full h-3 overflow-hidden">
                              <div className="h-full rounded-full transition-all duration-700" style={{ background: m.color, width: `${pct}%` }} />
                            </div>
                            <span className="text-xs font-bold tabular-nums w-6 text-right shrink-0">{count}</span>
                            <span className="text-[10px] text-muted-foreground w-20 shrink-0">{m.hint}</span>
                          </div>
                        );
                      })}
                      {t.d25 === 0 && (
                        <p className="text-[12px] text-muted-foreground text-center py-4">No scroll depth data yet — open a journey in the public viewer to start recording.</p>
                      )}
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            {/* Per-journey breakdown */}
            {!sdepL && (scrollDepth?.byJourney ?? []).length > 0 && (
              <Card className="shadow-xs">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold">Per-Journey Breakdown</CardTitle>
                  <p className="text-[11px] text-muted-foreground">Unique visitors reaching each depth milestone per journey</p>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b">
                          <th className="px-4 py-2 text-left font-semibold text-muted-foreground">Journey</th>
                          <th className="px-3 py-2 text-right font-semibold" style={{ color:"#6366f1" }}>25%</th>
                          <th className="px-3 py-2 text-right font-semibold" style={{ color:"#06b6d4" }}>50%</th>
                          <th className="px-3 py-2 text-right font-semibold" style={{ color:"#34d399" }}>75%</th>
                          <th className="px-3 py-2 text-right font-semibold" style={{ color:"#f59e0b" }}>100%</th>
                          <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Drop-off</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {(scrollDepth?.byJourney ?? []).map((row: any) => {
                          const dropoff = row.d25 > 0 ? Math.round(((row.d25 - row.d100) / row.d25) * 100) : 0;
                          return (
                            <tr key={row.id} className="hover:bg-indigo-50/60 transition-colors cursor-pointer"
                              onClick={() => openDrill(`"${row.name}" — Scroll Depth Contacts`, { journeyId: String(row.id), eventType: "scroll_depth" })}>
                              <td className="px-4 py-2.5 font-medium max-w-[200px] truncate">{row.name}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{row.d25}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{row.d50}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{row.d75}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{row.d100}</td>
                              <td className="px-3 py-2.5 text-right">
                                <span className={cn("font-semibold", dropoff >= 75 ? "text-rose-500" : dropoff >= 50 ? "text-amber-500" : "text-emerald-600")}>
                                  {dropoff}%
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Bar chart — visitors per depth milestone, grouped by journey */}
            {!sdepL && (scrollDepth?.byJourney ?? []).length > 0 && (
              <Card className="shadow-xs">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold">Depth Funnel by Journey</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart
                      data={(scrollDepth?.byJourney ?? []).map((r: any) => ({
                        name: r.name.length > 18 ? r.name.slice(0, 17) + "…" : r.name,
                        _id: r.id, _name: r.name,
                        "25%": r.d25, "50%": r.d50, "75%": r.d75, "100%": r.d100,
                      }))}
                      margin={{ left: 0, right: 8, top: 4, bottom: 0 }}
                      onClick={(d) => { if (d?.activePayload?.[0]?.payload?._id) openDrill(`"${d.activePayload[0].payload._name}" — Scroll Depth Contacts`, { journeyId: String(d.activePayload[0].payload._id), eventType: "scroll_depth" }); }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={28} />
                      <Tooltip contentStyle={{ fontSize: 12 }} />
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="25%"  fill="#6366f1" radius={[2,2,0,0]} />
                      <Bar dataKey="50%"  fill="#06b6d4" radius={[2,2,0,0]} />
                      <Bar dataKey="75%"  fill="#34d399" radius={[2,2,0,0]} />
                      <Bar dataKey="100%" fill="#f59e0b" radius={[2,2,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {!sdepL && (scrollDepth?.byJourney ?? []).length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 gap-3 text-muted-foreground">
                <TrendingUp className="w-10 h-10 opacity-20" />
                <p className="text-sm font-medium">No scroll depth data yet</p>
                <p className="text-xs text-center max-w-xs">Open a journey in the public viewer and wait a few seconds — depth events are tracked automatically.</p>
              </div>
            )}
          </div>
        )}

        {/* ── ABM Data ──────────────────────────────────────────────── */}
        {section === "abm" && (() => {
          const rows: any[]  = abmData?.rows  ?? [];
          const hasMore = abmData?.hasMore === true;
          const journeyPageCount: number | null = abmData?.journeyPageCount ?? null;

          const TH = ({ children, cls = "" }: { children: React.ReactNode; cls?: string }) => (
            <th className={cn("px-3 py-2 text-left font-semibold text-[10px] uppercase tracking-wide text-muted-foreground whitespace-nowrap border-b bg-muted/40 sticky top-0 z-10", cls)}>
              {children}
            </th>
          );
          const TD = ({ children, cls = "" }: { children: React.ReactNode; cls?: string }) => (
            <td className={cn("px-3 py-2 whitespace-nowrap border-b border-border/50", cls)}>
              {children}
            </td>
          );

          // Unique-visitors mode: keep only the most recent event per contact
          const displayRows = abmUnique
            ? (() => {
                const seen = new Set<number>();
                return rows.filter((r: any) => {
                  if (!r.contact_id) return true; // keep anonymous rows always
                  if (seen.has(r.contact_id)) return false;
                  seen.add(r.contact_id);
                  return true;
                });
              })()
            : rows;

          return (
            <div className="space-y-4">
              {/* Toolbar */}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-sm font-semibold">Visitor Activity Log</p>
                  <p className="text-[11px] text-muted-foreground">
                    {abmL ? "Loading…" : abmUnique
                      ? `${displayRows.length.toLocaleString()} unique visitors on page ${abmPage}`
                      : `Page ${abmPage} · up to 30 events per page`}
                  </p>
                  {journeyPageCount !== null && (
                    <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 inline-block mt-1">
                      This journey has <strong>{journeyPageCount}</strong> page{journeyPageCount !== 1 ? "s" : ""} total — each contact can have at most {journeyPageCount} page-view event{journeyPageCount !== 1 ? "s" : ""}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setAbmUnique(v => !v)}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium border transition-colors",
                      abmUnique
                        ? "bg-indigo-600 text-white border-indigo-600"
                        : "bg-white text-muted-foreground border-border hover:border-indigo-400 hover:text-indigo-600"
                    )}
                  >
                    <Users className="w-3 h-3" />
                    Unique visitors
                  </button>
                  <span className="text-[11px] text-muted-foreground">Use the Export button above for PDF or Excel</span>
                </div>
              </div>
              <SourceLegend />
              {acquisition.isError && <p role="alert" className="text-xs text-red-700">Acquisition sources could not be loaded.</p>}

              {/* Table */}
              <Card className="shadow-xs overflow-hidden">
                <div className="overflow-auto max-h-[560px]">
                  {abmQuery.isError ? (
                    <div role="alert" className="p-6 text-sm text-rose-700">Unable to load visitor activity. <Button variant="outline" size="sm" onClick={() => void abmQuery.refetch()}>Retry</Button></div>
                  ) : abmL ? (
                    <div className="p-6 space-y-2">
                      {Array.from({length:8}).map((_,i) => <Skeleton key={i} className="h-8"/>)}
                    </div>
                  ) : rows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
                      <Activity className="w-10 h-10 opacity-20" />
                      <p className="text-sm">No visitor activity found</p>
                      <p className="text-xs text-center max-w-xs">Try adjusting the filters or visit a journey to generate activity data.</p>
                    </div>
                  ) : (
                    <table className="w-full text-[11px]" style={{ minWidth: 1340 }}>
                      <thead>
                        <tr>
                          <TH>Page Name</TH>
                          <TH>Event</TH>
                          <TH>URL / Destination</TH>
                          <TH>First Name</TH>
                          <TH>Last Name</TH>
                          <TH>User Email</TH>
                          <TH>Company</TH>
                          <TH>Designation</TH>
                          <TH cls="text-right">Score (+/-)</TH>
                          <TH cls="text-right">Score After</TH>
                          <TH>Stage Reached</TH>
                          <TH>Journey</TH>
                          <TH cls="text-right">Page Time</TH>
                          <TH cls="text-right">All-Time</TH>
                          <TH>User Type</TH>
                          <TH>Tags</TH>
                          <TH>Visit Date</TH>
                          <TH>Time</TH>
                        </tr>
                      </thead>
                      <tbody>
                        {displayRows.map((row: any, i: number) => (
                          <tr key={row.id ?? i}
                            className={cn("transition-colors",
                              row.contact_id   ? "cursor-pointer hover:bg-indigo-50/60" :
                              row.visitor_token ? "cursor-pointer hover:bg-slate-50"     : "hover:bg-muted/30",
                              i % 2 === 0 ? "" : "bg-muted/10"
                            )}
                            onClick={() => {
                              if (row.contact_id) {
                                const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || "Contact";
                                setDrill({ open: true, title: `${name} — Timeline`, extraParams: {} });
                                setDrillContactId(row.contact_id);
                                setDrillContactName(name);
                              } else if (row.visitor_token) {
                                setVisitorSheet({
                                  open: true,
                                  visitorToken: row.visitor_token,
                                  name: "Anonymous Visitor",
                                  stage: row.user_stage ?? "pre-aware",
                                  company: row.company_name ?? row.company_hint ?? "",
                                });
                              }
                            }}>
                            <TD>
                              <span className="max-w-[160px] truncate block font-medium" title={row.page_name ?? ""}>
                                {row.page_name ?? <span className="text-muted-foreground italic">—</span>}
                              </span>
                            </TD>
                            <TD>
                              <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide",
                                row.event_type === "page_view"       ? "bg-indigo-100 text-indigo-700" :
                                row.event_type === "form_submit"      ? "bg-emerald-100 text-emerald-700" :
                                row.event_type === "asset_download"   ? "bg-amber-100 text-amber-700" :
                                row.event_type === "banner_click"     ? "bg-sky-100 text-sky-700" :
                                row.event_type === "scroll_depth"     ? "bg-violet-100 text-violet-700" :
                                row.event_type === "email_open"       ? "bg-blue-100 text-blue-700" :
                                row.event_type === "email_click"      ? "bg-cyan-100 text-cyan-700" :
                                row.event_type === "call_completed"   ? "bg-orange-100 text-orange-700" :
                                "bg-gray-100 text-gray-700"
                              )}>
                                {EVENT_TYPE_LABEL[row.event_type] ?? row.event_type ?? "—"}
                              </span>
                            </TD>
                            <TD>
                              {(() => {
                                const rawUrl = row.cta_url || row.page_url;
                                if (!rawUrl) return <span className="text-muted-foreground italic text-[10px]">—</span>;
                                let display = rawUrl;
                                try {
                                  const u = new URL(rawUrl);
                                  display = (u.pathname + u.search)
                                    .replace(/[?&](cid|kaboom_tid|kaboom_vt|pf_vt)=[^&]*/g, "")
                                    .replace(/[?&]$/, "") || u.pathname;
                                } catch { /* keep raw */ }
                                return (
                                  <a href={rawUrl} target="_blank" rel="noreferrer" title={rawUrl}
                                     className={cn("max-w-[220px] truncate block text-[10px] hover:underline",
                                       row.cta_url ? "text-emerald-600" : "text-indigo-600")}>
                                    {display}
                                  </a>
                                );
                              })()}
                            </TD>
                            <TD>
                              <div className="flex flex-col items-start gap-1 group min-w-[80px]">
                                <span className={cn(
                                  "text-[11px]",
                                  row.contact_id
                                    ? "font-medium text-indigo-700 group-hover:underline"
                                    : row.visitor_token
                                      ? "text-slate-500 italic"
                                      : "text-muted-foreground"
                                )}>
                                  {row.user_type === "known" && row.contact_id && <SourceIcons data={acquisition.data?.contacts[String(row.contact_id)]} />}
                                  {row.first_name || (row.user_type === "anonymous" ? "Visitor" : "—")}
                                </span>
                                {row.contact_id && <GtmStatusBadge scope="contact" status={gtmStatuses[String(row.contact_id)]} loading={gtmLoading} error={gtmError} />}
                                {(row.contact_id || row.visitor_token) && (
                                  <ChevronRight className="w-3 h-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                                )}
                              </div>
                            </TD>
                            <TD>{row.last_name ?? <span className="text-muted-foreground">—</span>}</TD>
                            <TD>
                              {row.email
                                ? <span className="max-w-[180px] truncate block text-muted-foreground" title={row.email}>{row.email}</span>
                                : <span className="text-muted-foreground">—</span>}
                            </TD>
                            <TD>
                              <span className="max-w-[130px] truncate block"
                                    title={row.company_name ?? (row.company_hint ? `Possible: ${row.company_hint}` : "")}>
                                {row.company_name
                                  ? <span className="inline-flex items-center gap-1"><SourceIcons data={acquisition.data?.accounts[String(row.company_id)]} />{row.company_name}</span>
                                  : row.company_hint
                                    ? <span className="text-muted-foreground italic text-[10px]">~{row.company_hint}</span>
                                    : <span className="text-muted-foreground">—</span>}
                              </span>
                            </TD>
                            <TD>
                              <span className="max-w-[130px] truncate block text-muted-foreground" title={row.designation ?? ""}>
                                {row.designation ?? "—"}
                              </span>
                            </TD>
                            <TD cls="text-right">
                              {(row.score ?? 0) > 0
                                ? <span className="font-semibold text-emerald-600">+{row.score}</span>
                                : <span className="text-muted-foreground">0</span>}
                            </TD>
                            <TD cls="text-right">
                              <span className="font-semibold">{row.total_score ?? 0}</span>
                            </TD>
                            <TD>
                              <StageBadge stage={row.user_stage ?? "pre-aware"} />
                            </TD>
                            <TD>
                              <span className="max-w-[140px] truncate block" title={row.journey_name ?? ""}>
                                {row.journey_name ?? <span className="text-muted-foreground">—</span>}
                              </span>
                            </TD>
                            <TD cls="text-right font-mono text-muted-foreground">
                              {row.duration_seconds != null ? fmtDuration(row.duration_seconds) : <span className="text-muted-foreground/50">—</span>}
                            </TD>
                            <TD cls="text-right font-mono text-muted-foreground">
                              {fmtDuration(row.total_time_seconds)}
                            </TD>
                            <TD>
                              <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold",
                                row.user_type === "known" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600"
                              )}>
                                {row.user_type === "known" ? "known" : "anon"}
                              </span>
                            </TD>
                            <TD>
                              <div className="flex flex-wrap gap-0.5 max-w-[120px]">
                                {(row.contact_tags ?? []).slice(0,3).map((tag: string) => (
                                  <span key={tag} className="bg-indigo-50 text-indigo-600 text-[9px] px-1.5 py-0.5 rounded-full font-medium">{tag}</span>
                                ))}
                                {(row.contact_tags ?? []).length > 3 && (
                                  <span className="text-[9px] text-muted-foreground">+{(row.contact_tags ?? []).length - 3}</span>
                                )}
                              </div>
                            </TD>
                            <TD cls="font-mono text-muted-foreground">{fmtVisitDate(row.visit_date)}</TD>
                            <TD cls="font-mono text-muted-foreground">{fmtVisitTime(row.visit_date)}</TD>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </Card>

              {/* Pagination */}
              {(abmPage > 1 || hasMore) && (
                <div className="flex items-center justify-between gap-3">
                  <Button variant="outline" size="sm" className="h-7 text-xs"
                    onClick={() => setAbmPage(p => p - 1)} disabled={abmPage <= 1}>
                    ← Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">Page {abmPage}</span>
                  <Button variant="outline" size="sm" className="h-7 text-xs"
                    onClick={() => setAbmPage(p => p + 1)} disabled={!hasMore}>
                    Next →
                  </Button>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Autonomous GTM OS ─────────────────────────────────────────── */}
        {section === "account-intel" && (
          <div className="space-y-4">
            <div className="rounded-lg bg-zinc-900 text-white px-6 py-4 text-center">
              <h2 className="text-base font-bold tracking-wide">🏢 AUTONOMOUS GTM OS — Full Portfolio View</h2>
              <p className="text-xs text-zinc-400 mt-0.5">Recorded GTM OS qualification, acquisition source, journey and engagement for every tracked account</p>
            </div>

            <Card className="shadow-xs">
              <CardContent className="px-0 pb-0">
                {accountIntelQuery.isError ? <div role="alert" className="px-4 py-5 text-sm text-rose-700">Unable to load account portfolio. <Button variant="outline" size="sm" onClick={() => void accountIntelQuery.refetch()}>Retry</Button></div> : aiL ? <Skeleton className="h-48 mx-4 my-4"/> : (
                  <div className="overflow-x-auto">
                    {accountIntelIds.some(id => id != null) && accountIntelSources.isError && <div role="alert" className="px-4 py-2 text-xs text-rose-700">Acquisition sources could not be loaded. <Button variant="outline" size="sm" onClick={() => void accountIntelSources.refetch()}>Retry</Button></div>}
                    <div className="px-3 py-2 border-b"><SourceLegend /></div>
                    <table className="w-full text-sm min-w-[1200px]">
                      <thead>
                        <tr className="bg-cyan-600 text-white">
                          {["#","Account Name","Acquisition","Journey","Contact Score","Score Prev Month","GTM OS Account Qualification","Journey Stage","Days in Stage","# Contacts Tracked","Total Events","Sessions","Avg Session (sec)"].map(h => (
                            <th key={h} className="text-left text-xs font-semibold px-3 py-2.5 whitespace-nowrap first:w-10">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {accountIntel.map((row: any, i: number) => {
                          const score = parseFloat(row.avg_score) || 0;
                          const prevScore = parseFloat(row.prev_month_score) || 0;
                          const scoreColor = score >= 75 ? "text-red-600 font-bold" : score >= 50 ? "text-orange-500 font-semibold" : score >= 25 ? "text-amber-600" : "text-slate-500";
                          const prevColor  = prevScore >= 75 ? "text-red-600 font-bold" : prevScore >= 50 ? "text-orange-500 font-semibold" : prevScore >= 25 ? "text-amber-600" : "text-slate-500";
                          const stageFmt = (s: string) => s ? s.replace(/-/g," ").replace(/\b\w/g, c => c.toUpperCase()) : "—";
                           const canonicalId = Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0 ? Number(row.id) : null;
                          return (
                             <tr key={canonicalId ?? `domain-${i}`} className={cn("transition-colors", canonicalId && "hover:bg-indigo-50/60 cursor-pointer")}
                               onClick={() => { if (canonicalId) setIntelAccountId(canonicalId); }}>
                              <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">{(intelPage - 1) * 30 + i + 1}</td>
                               <td className="px-3 py-2.5 text-xs font-semibold text-indigo-700">{canonicalId ? <button type="button" onClick={() => setIntelAccountId(canonicalId)} className="text-left hover:underline focus-visible:underline" data-testid={`button-intel-account-${canonicalId}`}>{row.name}</button> : <span title="Contact domain group without a linked account">{row.name} · Unlinked</span>}</td>
                               <td className="px-3 py-2.5 text-xs">{!canonicalId ? "—" : accountIntelSources.isPending ? <Skeleton className="h-4 w-12" /> : accountIntelSources.isError ? "Unavailable" : <SourceBadges data={accountIntelSources.data?.accounts[String(canonicalId)]} />}</td>
                               <td className="px-3 py-2.5 text-xs max-w-48 truncate" title={row.journeyName ?? undefined}>{row.journeyName ?? "Not recorded"}</td>
                              <td className={cn("px-3 py-2.5 text-xs text-center tabular-nums", scoreColor)}>{score.toFixed(1)}</td>
                              <td className={cn("px-3 py-2.5 text-xs text-center tabular-nums", prevColor)}>{prevScore.toFixed(1)}</td>
                               <td className="px-3 py-2.5 text-xs whitespace-nowrap">{canonicalId ? <GtmStatusBadge status={row.gtmStatus ?? undefined} /> : "Not categorized"}</td>
                              <td className="px-3 py-2.5 text-xs whitespace-nowrap">{stageFmt(row.dominant_stage)}</td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums">{row.days_in_stage ?? 0}</td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums font-medium">{row.contact_count ?? 0}</td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums">{row.total_events ?? 0}</td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums">{row.sessions ?? 0}</td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums">{parseFloat(row.avg_session_secs) ? parseFloat(row.avg_session_secs).toFixed(1) : "—"}</td>
                            </tr>
                          );
                        })}
                        {!aiL && accountIntel.length === 0 && (
                          <tr><td colSpan={13} className="px-4 py-10 text-center text-sm text-muted-foreground">No account data found</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
            {(intelPage > 1 || accountIntelQuery.data?.hasMore) && (
              <div className="flex items-center justify-between gap-3">
                <Button variant="outline" size="sm" onClick={() => setIntelPage(page => page - 1)} disabled={intelPage === 1}>← Previous</Button>
                <span className="text-xs text-muted-foreground">Page {intelPage} · up to 30 accounts per page</span>
                <Button variant="outline" size="sm" onClick={() => setIntelPage(page => page + 1)} disabled={!accountIntelQuery.data?.hasMore}>Next →</Button>
              </div>
            )}
            <AccountSheet key={intelAccountId ?? "none"} accountId={intelAccountId} filters={{}} onClose={() => setIntelAccountId(null)} />
          </div>
        )}

        {/* ── Journey Velocity ─────────────────────────────────────────── */}
        {section === "velocity" && (
          <div className="space-y-6">
            <div className="rounded-lg bg-zinc-900 text-white px-6 py-4 text-center">
              <h2 className="text-base font-bold tracking-wide">🚀 JOURNEY VELOCITY — Stage Movement &amp; Conversion Analytics</h2>
              <p className="text-xs text-zinc-400 mt-0.5">Track how fast accounts progress through ABM stages vs. portfolio average</p>
            </div>

            {/* Stage transitions table */}
            <Card className="shadow-xs">
              <CardHeader className="px-0 py-0">
                <div className="bg-cyan-600 text-white px-4 py-2.5 rounded-t-lg">
                  <CardTitle className="text-sm font-semibold">Account Journey Tracking — Stage Transitions &amp; Velocity</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {velL ? <Skeleton className="h-48 mx-4 my-4"/> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[900px]">
                      <thead>
                        <tr className="border-b bg-slate-50">
                          {["Account","From Stage","To Stage","Entry Date","Exit Date","Days in Stage","Industry","Velocity vs Avg"].map(h => (
                            <th key={h} className="text-left text-xs font-semibold text-indigo-600 px-3 py-2.5 whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {(velocityData?.stageTransitions ?? []).map((row: any, i: number) => {
                          const stageFmt = (s: string) => s ? s.replace(/-/g," ").replace(/\b\w/g, c => c.toUpperCase()) : "—";
                          const velCls = row.velocityVsAvg.includes("faster") ? "text-green-600 font-semibold" : row.velocityVsAvg.includes("slower") ? "text-amber-600 font-semibold" : "text-slate-500";
                          return (
                            <tr key={i} className="hover:bg-indigo-50/60 transition-colors cursor-pointer"
                              onClick={() => { const extra: Record<string,string> = { stage: row.toStage }; if (row.companyId) extra.companyId = String(row.companyId); openDrill(`${row.account} — ${stageFmt(row.toStage)} Contacts`, extra); }}>
                              <td className="px-3 py-2.5 text-xs font-semibold text-indigo-700">{row.account}</td>
                              <td className="px-3 py-2.5 text-xs text-muted-foreground">{stageFmt(row.fromStage)}</td>
                              <td className="px-3 py-2.5 text-xs">
                                <span className="inline-flex items-center px-2 py-0.5 rounded bg-green-100 text-green-700 text-[11px] font-medium">{stageFmt(row.toStage)}</span>
                              </td>
                              <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                                {row.entryDate ? formatReportDate(row.entryDate) : "—"}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                                {row.exitDate ? formatReportDate(row.exitDate) : <span className="text-muted-foreground italic">In progress</span>}
                              </td>
                              <td className="px-3 py-2.5 text-xs tabular-nums text-center">{row.daysInStage}</td>
                              <td className="px-3 py-2.5 text-xs">{row.industry ?? "—"}</td>
                              <td className={cn("px-3 py-2.5 text-xs whitespace-nowrap", velCls)}>{row.velocityVsAvg}</td>
                            </tr>
                          );
                        })}
                        {!velL && (velocityData?.stageTransitions ?? []).length === 0 && (
                          <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">No stage transition data yet</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Conversion rates table */}
            <Card className="shadow-xs">
              <CardHeader className="px-0 py-0">
                <div className="bg-cyan-600 text-white px-4 py-2.5 rounded-t-lg">
                  <CardTitle className="text-sm font-semibold">Stage Conversion Rates &amp; Avg Days</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {velL ? <Skeleton className="h-48 mx-4 my-4"/> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[800px]">
                      <thead>
                        <tr className="border-b bg-slate-50">
                          {["Stage Transition","Accounts Entered","Accounts Exited","Conversion Rate","Avg Days in Stage","Industry Leader","Fastest Account"].map(h => (
                            <th key={h} className="text-left text-xs font-semibold text-indigo-600 px-3 py-2.5 whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {(velocityData?.conversionRates ?? []).map((row: any, i: number) => {
                          const stageFmt = (s: string) => s ? s.replace(/-/g," ").replace(/\b\w/g, c => c.toUpperCase()) : "—";
                          const rate = row.conversionRate;
                          const rateCls = rate >= 80 ? "bg-green-100 text-green-700" : rate >= 60 ? "bg-amber-100 text-amber-700" : "bg-orange-100 text-orange-700";
                          return (
                            <tr key={i} className="hover:bg-indigo-50/60 transition-colors cursor-pointer"
                              onClick={() => openDrill(`${stageFmt(row.fromStage)} → ${stageFmt(row.toStage)} — Contacts`, { stage: row.toStage })}>
                              <td className="px-3 py-2.5 text-xs">
                                <span className="font-medium">{stageFmt(row.fromStage)}</span>
                                <span className="text-muted-foreground mx-1">→</span>
                                <span className="font-medium text-indigo-600">{stageFmt(row.toStage)}</span>
                              </td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums font-medium">{row.entered}</td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums font-medium">{row.exited}</td>
                              <td className="px-3 py-2.5 text-xs text-center">
                                <span className={cn("inline-flex items-center justify-center px-2 py-0.5 rounded text-[11px] font-semibold min-w-[48px]", rateCls)}>
                                  {rate}%
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums">{row.avgDays}d</td>
                              <td className="px-3 py-2.5 text-xs">{row.industryLeader ?? <span className="text-muted-foreground">—</span>}</td>
                              <td className="px-3 py-2.5 text-xs font-medium text-indigo-600">{row.fastestAccount ?? <span className="text-muted-foreground">—</span>}</td>
                            </tr>
                          );
                        })}
                        {!velL && (velocityData?.conversionRates ?? []).length === 0 && (
                          <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">No conversion data yet</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Playbook Recommendations ──────────────────────────────────── */}
        {section === "playbook" && (
          <PlaybookSection
            data={playbookData}
            loading={pbL}
            gtmStatuses={gtmStatuses}
            gtmLoading={gtmLoading}
            gtmError={gtmError}
            onViewContact={(id, name) => {
              setDrill({ open: true, title: `${name} — Timeline`, extraParams: {} });
              setDrillContactId(id);
              setDrillContactName(name);
            }}
            onDrillAccount={(title, extra) => openDrill(title, extra)}
          />
        )}

        {/* ── Score Intelligence ────────────────────────────────────────── */}
        {section === "score-intel" && (
          <div className="space-y-6">
            <div className="rounded-lg bg-zinc-900 text-white px-6 py-4 text-center">
              <h2 className="text-base font-bold tracking-wide">📊 CONTACT SCORE INTELLIGENCE — Score Distribution &amp; Velocity</h2>
              <p className="text-xs text-zinc-400 mt-0.5">Intent state distribution, score heat, rising contacts, and per-account breakdown</p>
            </div>

            {/* Intent State Distribution */}
            <IntentStatePanel tenantId={undefined} onDrillContact={(id, name) => { setDrill({ open: true, title: `${name} — Timeline`, extraParams: {} }); setDrillContactId(id); setDrillContactName(name); }} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Score distribution */}
              <Card className="shadow-xs">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold">Score Heat Distribution</CardTitle>
                  <p className="text-[11px] text-muted-foreground">Based on Intent Score (0–100) — Very Hot ≥65 · Hot ≥40 · Warm ≥18 · Cold &lt;18</p>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  {siL ? <Skeleton className="h-40"/> : (
                    <div className="space-y-3">
                      {(scoreIntel?.distribution ?? []).map((row: any) => {
                        const total = (scoreIntel?.distribution ?? []).reduce((s: number, r: any) => s + r.count, 0);
                        const pct   = total > 0 ? Math.round((row.count / total) * 100) : 0;
                        const cfg: Record<string, { bar: string; text: string; emoji: string; scoreMin: string; scoreMax?: string }> = {
                          "Very Hot (65+)": { bar:"bg-red-500",    text:"text-red-600",    emoji:"🔥", scoreMin:"65" },
                          "Hot (40–64)":    { bar:"bg-orange-400", text:"text-orange-500", emoji:"🔥", scoreMin:"40", scoreMax:"64" },
                          "Warm (18–39)":   { bar:"bg-blue-400",   text:"text-blue-500",   emoji:"🌊", scoreMin:"18", scoreMax:"39" },
                          "Cold (<18)":     { bar:"bg-slate-300",  text:"text-slate-500",  emoji:"❄️", scoreMin:"0",  scoreMax:"17" },
                        };
                        const c = cfg[row.bucket] ?? { bar:"bg-indigo-400", text:"text-indigo-600", emoji:"•", scoreMin:"0" };
                        return (
                          <div key={row.bucket} className="cursor-pointer rounded p-1 -mx-1 hover:bg-slate-50 transition-colors"
                            onClick={() => { const extra: Record<string,string> = { scoreMin: c.scoreMin }; if (c.scoreMax) extra.scoreMax = c.scoreMax; openDrill(`${c.emoji} ${row.bucket} — Contacts`, extra); }}>
                            <div className="flex items-center justify-between mb-1">
                              <span className={cn("text-xs font-medium", c.text)}>{c.emoji} {row.bucket}</span>
                              <span className="text-xs text-muted-foreground tabular-nums">{row.count} ({pct}%)</span>
                            </div>
                            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                              <div className={cn("h-full rounded-full transition-all", c.bar)} style={{ width: `${pct}%` }}/>
                            </div>
                          </div>
                        );
                      })}
                      {!siL && (scoreIntel?.distribution ?? []).length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-6">No score data</p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Score by account */}
              <Card className="shadow-xs">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold">Score by Account</CardTitle>
                  <p className="text-[11px] text-muted-foreground">Avg/Max/Min = Activity Score (cumulative pts) · Heat counts = Intent Score (0–100)</p>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  {siL ? <Skeleton className="h-40 mx-4"/> : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b bg-slate-50">
                            {["Account","Industry","Contacts","Avg","Max","Min","🔥 Very Hot","🔥 Hot","🌊 Warm","❄️ Cold"].map(h => (
                              <th key={h} className="text-left text-[11px] font-semibold text-indigo-600 px-3 py-2 whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {(scoreIntel?.byAccount ?? []).map((row: any) => (
                            <tr key={row.id} className="hover:bg-indigo-50/60 cursor-pointer"
                              onClick={() => openDrill(`${row.company_name} — Contacts`, { companyId: String(row.id), _strip: "stage,stages" })}>
                              <td className="px-3 py-2 text-xs font-semibold text-indigo-700">{row.company_name}</td>
                              <td className="px-3 py-2 text-xs text-muted-foreground">{row.industry ?? "—"}</td>
                              <td className="px-3 py-2 text-xs text-center tabular-nums">{row.contact_count}</td>
                              <td className="px-3 py-2 text-xs text-center tabular-nums font-semibold text-orange-500">{parseFloat(row.avg_score).toFixed(1)}</td>
                              <td className="px-3 py-2 text-xs text-center tabular-nums text-red-600 font-medium">{row.max_score}</td>
                              <td className="px-3 py-2 text-xs text-center tabular-nums text-slate-500">{row.min_score}</td>
                              <td className="px-3 py-2 text-xs text-center tabular-nums text-red-600">{row.very_hot_count}</td>
                              <td className="px-3 py-2 text-xs text-center tabular-nums text-orange-500">{row.hot_count}</td>
                              <td className="px-3 py-2 text-xs text-center tabular-nums text-blue-500">{row.warm_count}</td>
                              <td className="px-3 py-2 text-xs text-center tabular-nums text-slate-400">{row.cold_count}</td>
                            </tr>
                          ))}
                          {!siL && (scoreIntel?.byAccount ?? []).length === 0 && (
                            <tr><td colSpan={10} className="px-4 py-8 text-center text-sm text-muted-foreground">No account data</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Score trend chart */}
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold">Score Activity Trend — Last 30 Days</CardTitle>
                <p className="text-[11px] text-muted-foreground">Daily sum of positive score events across all contacts</p>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {siL ? <Skeleton className="h-52"/> : (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={scoreIntel?.trend ?? []} margin={{ left:0, right:8, top:4, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9"/>
                      <XAxis dataKey="date" tick={{ fontSize:10 }} tickFormatter={d => formatReportDayLabel(String(d))}/>
                      <YAxis tick={{ fontSize:11 }} allowDecimals={false} width={32}/>
                      <Tooltip contentStyle={{ fontSize:12 }} labelFormatter={d => formatReportDayLabel(String(d), true)}/>
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize:12 }}/>
                      <Line type="monotone" dataKey="total_delta" name="Score Points" stroke="#6366f1" strokeWidth={2} dot={false}/>
                      <Line type="monotone" dataKey="active_contacts" name="Active Contacts" stroke="#06b6d4" strokeWidth={2} dot={false} strokeDasharray="4 2"/>
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Rising contacts table */}
            <Card className="shadow-xs">
              <CardHeader className="px-0 py-0">
                <div className="bg-cyan-600 text-white px-4 py-2.5 rounded-t-lg">
                  <CardTitle className="text-sm font-semibold">🚀 Top Rising Contacts — Score Gainers (Last 30 Days)</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {siL ? <Skeleton className="h-48 mx-4 my-4"/> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[700px]">
                      <thead>
                        <tr className="border-b bg-slate-50">
                          {["#","Contact Name","Company","Stage","Prev Score","Current Score","Score Gain (+30d)"].map(h => (
                            <th key={h} className="text-left text-xs font-semibold text-indigo-600 px-3 py-2.5 whitespace-nowrap first:w-10">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {(scoreIntel?.risers ?? []).map((row: any, i: number) => {
                          const stageFmt = (s: string) => s ? s.replace(/-/g," ").replace(/\b\w/g, c => c.toUpperCase()) : "—";
                          return (
                            <tr key={row.id} className="hover:bg-slate-50/60 transition-colors cursor-pointer"
                              onClick={() => { const name = [row.first_name, row.last_name].filter(Boolean).join(" "); setDrill({ open:true, title:`${name} — Timeline`, extraParams:{} }); setDrillContactId(row.id); setDrillContactName(name); }}>
                              <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">{i+1}</td>
                              <td className="px-3 py-2.5 text-xs font-semibold text-indigo-700">
                                {[row.first_name, row.last_name].filter(Boolean).join(" ")}
                                <div><GtmStatusBadge scope="contact" status={gtmStatuses[String(row.id)]} loading={gtmLoading} error={gtmError} /></div>
                                <div className="text-[11px] text-muted-foreground font-normal">{row.email}</div>
                              </td>
                              <td className="px-3 py-2.5 text-xs">{row.company_name ?? "—"}</td>
                              <td className="px-3 py-2.5 text-xs">{stageFmt(row.stage)}</td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums text-slate-500">{row.prev_score}</td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums font-semibold text-orange-500">{row.lead_score}</td>
                              <td className="px-3 py-2.5 text-xs text-center">
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-green-100 text-green-700 text-[11px] font-bold">
                                  +{row.score_gain_30d}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                        {!siL && (scoreIntel?.risers ?? []).length === 0 && (
                          <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">No score gain activity in the last 30 days</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Score Corrections ────────────────────────────────────────── */}
        {section === "score-corrections" && (
          <div className="space-y-6">
            <div className="rounded-lg bg-zinc-900 text-white px-6 py-4 text-center">
              <h2 className="text-base font-bold tracking-wide">🤖 SCORE CORRECTIONS — Bot Inflation Audit</h2>
              <p className="text-xs text-zinc-400 mt-0.5">Contacts whose lead scores were adjusted by the bot-open correction engine</p>
            </div>

            {/* KPI strip + Run button */}
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
              <div className="flex gap-3 flex-wrap">
                <Card className="shadow-xs flex-1 min-w-[140px]">
                  <CardContent className="px-4 py-3">
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold">Contacts Corrected</p>
                    {scL ? <Skeleton className="h-7 w-12 mt-1" /> : (
                      <p className="text-2xl font-black tabular-nums mt-1 text-indigo-600">
                        {scoreCorrections?.summary.distinctContacts ?? 0}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card className="shadow-xs flex-1 min-w-[140px]">
                  <CardContent className="px-4 py-3">
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold">Total Runs</p>
                    {scL ? <Skeleton className="h-7 w-12 mt-1" /> : (
                      <p className="text-2xl font-black tabular-nums mt-1 text-slate-700">
                        {scoreCorrections?.summary.totalRuns ?? 0}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card className="shadow-xs flex-1 min-w-[200px]">
                  <CardContent className="px-4 py-3">
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold">Last Run</p>
                    {scL ? <Skeleton className="h-7 w-32 mt-1" /> : (
                      <p className="text-sm font-semibold mt-1 text-slate-700 tabular-nums">
                        {scoreCorrections?.summary.lastRun
                          ? formatReportDateTime(scoreCorrections.summary.lastRun)
                          : <span className="text-muted-foreground font-normal italic">Never run</span>
                        }
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              <div className="shrink-0">
                <Button
                  onClick={() => runScoreCorrection.mutate()}
                  disabled={runScoreCorrection.isPending}
                  className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
                  size="sm"
                >
                  {runScoreCorrection.isPending ? (
                    <>
                      <Activity className="w-3.5 h-3.5 animate-pulse" />
                      Running…
                    </>
                  ) : (
                    <>
                      <Zap className="w-3.5 h-3.5" />
                      Run Score Correction
                    </>
                  )}
                </Button>
                {runScoreCorrection.isSuccess && (
                  <p className="text-[11px] text-emerald-600 mt-1.5 text-right font-medium">
                    ✓ {(runScoreCorrection.data as any)?.message}
                  </p>
                )}
                {runScoreCorrection.isError && (
                  <p className="text-[11px] text-red-500 mt-1.5 text-right">Failed — check server logs</p>
                )}
              </div>
            </div>

            {/* Corrections table */}
            <Card className="shadow-xs">
              <CardHeader className="px-0 py-0">
                <div className="bg-indigo-600 text-white px-4 py-2.5 rounded-t-lg flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">🤖 Contacts with Bot-Corrected Scores</CardTitle>
                  <Badge variant="secondary" className="text-[10px] bg-white/20 text-white border-0">
                    {scoreCorrections?.corrections.length ?? 0} contact{(scoreCorrections?.corrections.length ?? 0) !== 1 ? "s" : ""}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {scL ? (
                  <div className="space-y-2 p-4">
                    {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
                  </div>
                ) : (scoreCorrections?.corrections.length ?? 0) === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                    <Zap className="w-8 h-8 opacity-30" />
                    <p className="text-sm font-medium">No corrections on record</p>
                    <p className="text-xs text-center max-w-xs">
                      Click "Run Score Correction" above to detect and remove bot-generated email opens from lead scores.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[700px]">
                      <thead>
                        <tr className="border-b bg-slate-50">
                          {["#", "Contact", "Email", "Old Score", "New Score", "Score Change", "Run ID", "Corrected At"].map(h => (
                            <th key={h} className="text-left text-xs font-semibold text-indigo-600 px-3 py-2.5 whitespace-nowrap first:w-10">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {(scoreCorrections?.corrections ?? []).map((row, i) => {
                          const delta = Number(row.delta);
                          const oldScore = Number(row.old_score);
                          const newScore = Number(row.new_score);
                          const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unknown";
                          const runShort = row.run_id ? row.run_id.slice(0, 8) : null;
                          return (
                            <tr key={row.event_id}
                              className="hover:bg-slate-50/60 transition-colors cursor-pointer"
                              onClick={() => {
                                setDrill({ open: true, title: `${name} — Timeline`, extraParams: {} });
                                setDrillContactId(row.contact_id);
                                setDrillContactName(name);
                              }}
                            >
                              <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">{i + 1}</td>
                              <td className="px-3 py-2.5 text-xs font-semibold text-indigo-700">
                                <div className="flex items-center gap-2">
                                  <Initials name={name} />
                                  {name}
                                  <GtmStatusBadge scope="contact" status={gtmStatuses[String(row.contact_id)]} loading={gtmLoading} error={gtmError} />
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-xs text-muted-foreground max-w-[180px] truncate">{row.email}</td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums text-slate-500 line-through">{oldScore}</td>
                              <td className="px-3 py-2.5 text-xs text-center tabular-nums font-semibold text-emerald-600">{newScore}</td>
                              <td className="px-3 py-2.5 text-xs text-center">
                                {delta !== 0 ? (
                                  <span className={cn(
                                    "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold",
                                    delta < 0 ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"
                                  )}>
                                    {delta > 0 ? "+" : ""}{delta}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground text-[11px]">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-xs">
                                {runShort ? (
                                  <span className="font-mono text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded" title={row.run_id ?? ""}>
                                    {runShort}…
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground text-[11px]">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                                {formatReportDateTime(row.corrected_at)}
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

            {/* Explanation callout */}
            <Card className="shadow-xs border-amber-200 bg-amber-50">
              <CardContent className="px-4 py-3 flex gap-3 items-start">
                <span className="text-xl shrink-0">ℹ️</span>
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-amber-900">How score corrections work</p>
                  <p className="text-xs text-amber-800 leading-relaxed">
                    Email security scanners (anti-spam bots) often auto-open emails within seconds of delivery, creating false <code className="bg-amber-100 px-1 rounded">email_open</code> events that inflate lead scores.
                    The correction engine identifies opens that occurred within 120 seconds of enrollment and marks them as bot activity.
                    Affected lead scores are then recalculated excluding bot events. The table above shows contacts whose scores changed and by how much.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Call Campaigns ───────────────────────────────────────────── */}
        {section === "calls" && (
          <div className="space-y-5">
            <div className="rounded-lg bg-indigo-900 text-white px-6 py-4 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold tracking-wide">📞 CALL CAMPAIGNS — Outbound Analytics</h2>
                <p className="text-xs text-indigo-300 mt-0.5">AI-powered outbound call performance across all campaigns</p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={callsExporting}
                    className="shrink-0 border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white h-8 px-3 text-xs font-semibold"
                  >
                    {callsExporting
                      ? <><span className="mr-1.5 animate-spin inline-block">⏳</span>Exporting…</>
                      : <><Download className="w-3.5 h-3.5 mr-1.5" />Export<ChevronDown className="w-3 h-3 ml-1" /></>
                    }
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={() => handleCallsExport("excel")} className="gap-2 text-sm">
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" /> Excel (.xlsx)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleCallsExport("pdf")} className="gap-2 text-sm">
                    <FileDown className="w-3.5 h-3.5 text-rose-500" /> PDF Report
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* ── Call Intelligence KPI strip ─────────────────────────── */}
            {!callsL && (callsData?.intelligence?.analysed ?? 0) > 0 && (
              <Card className="shadow-xs border-violet-200 bg-gradient-to-r from-indigo-50 to-violet-50">
                <CardContent className="px-4 py-3">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-base">🧠</span>
                    <p className="text-xs font-bold uppercase tracking-wider text-indigo-700">Call Intelligence</p>
                    <span className="ml-auto text-[10px] text-slate-500">{callsData!.intelligence.analysed} call{callsData!.intelligence.analysed !== 1 ? "s" : ""} analysed by LLM</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {/* Avg Interest Score */}
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Avg Interest Score</p>
                      <div className="flex items-center gap-2">
                        <span className="text-2xl font-black text-indigo-700 tabular-nums">{callsData!.intelligence.avgInterestScore}</span>
                        <span className="text-xs text-slate-400">/10</span>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${callsData!.intelligence.avgInterestScore >= 7 ? "bg-emerald-500" : callsData!.intelligence.avgInterestScore >= 4 ? "bg-amber-400" : "bg-red-400"}`}
                          style={{ width: `${(callsData!.intelligence.avgInterestScore / 10) * 100}%` }}
                        />
                      </div>
                    </div>
                    {/* Sentiment Breakdown */}
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Sentiment</p>
                      <div className="space-y-0.5">
                        {[
                          { label: "😊 Positive", val: callsData!.intelligence.sentimentBreakdown.positive, col: "bg-emerald-400" },
                          { label: "😐 Neutral",  val: callsData!.intelligence.sentimentBreakdown.neutral,  col: "bg-slate-300"  },
                          { label: "😞 Negative", val: callsData!.intelligence.sentimentBreakdown.negative, col: "bg-red-400"    },
                        ].map(({ label, val, col }) => {
                          const pct = callsData!.intelligence.analysed > 0 ? Math.round((val / callsData!.intelligence.analysed) * 100) : 0;
                          return (
                            <div key={label} className="flex items-center gap-1.5">
                              <span className="text-[10px] text-slate-600 w-20 shrink-0">{label}</span>
                              <div className="flex-1 h-1 bg-slate-100 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${col}`} style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-[10px] font-bold tabular-nums w-6 text-right">{val}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {/* Team Routing */}
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Team Routing</p>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold">Sales</span>
                          <span className="text-sm font-black tabular-nums text-blue-700">{callsData!.intelligence.teamBreakdown.sales}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-semibold">Marketing</span>
                          <span className="text-sm font-black tabular-nums text-purple-700">{callsData!.intelligence.teamBreakdown.marketing}</span>
                        </div>
                      </div>
                    </div>
                    {/* How to use */}
                    <div className="space-y-1">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">How it works</p>
                      <p className="text-[10px] text-slate-600 leading-relaxed">
                        Click any call row to see the full LLM analysis — prospect profile, key highlights, sentiment, interest score, and a ready-to-send follow-up message.
                      </p>
                      <p className="text-[10px] text-slate-400">New calls are analysed automatically after a call completes. Click <span className="font-semibold text-indigo-600">🧠 Analyse</span> to trigger manually.</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* KPI strip */}
            {callsL ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                {Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                {[
                  { label: "Total Calls",      val: (callsData?.kpi.totalCalls ?? 0).toLocaleString(),      color: "text-indigo-600" },
                  { label: "Connected",         val: (callsData?.kpi.connected  ?? 0).toLocaleString(),      color: "text-emerald-600" },
                  { label: "Interested",        val: (callsData?.kpi.interested ?? 0).toLocaleString(),      color: "text-green-700" },
                  { label: "Connect Rate",      val: `${callsData?.kpi.connectionRate ?? 0}%`,               color: "text-violet-600" },
                  { label: "Completion Rate",   val: `${callsData?.kpi.completionRate ?? 0}%`,               color: "text-blue-600" },
                  { label: "Avg Duration",      val: `${callsData?.kpi.avgDuration ?? 0}s`,                 color: "text-amber-700" },
                  { label: "Campaigns",         val: (callsData?.kpi.totalCampaigns ?? 0).toLocaleString(),  color: "text-slate-700" },
                ].map(({ label, val, color }) => (
                  <Card key={label} className="shadow-xs">
                    <CardContent className="px-4 py-3">
                      <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold">{label}</p>
                      <p className={`text-2xl font-black tabular-nums mt-1 ${color}`}>{val}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Outcome Breakdown — recharts BarChart */}
              <Card className="shadow-xs">
                <CardHeader className="px-0 py-0">
                  <div className="bg-indigo-600 text-white px-4 py-2.5 rounded-t-lg">
                    <CardTitle className="text-sm font-semibold">📊 Outcome Breakdown</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="px-4 pb-4 pt-3">
                  {callsL ? <Skeleton className="h-40" /> : (callsData?.outcomeBreakdown.length ?? 0) === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-8">No calls completed yet</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart
                        data={(callsData?.outcomeBreakdown ?? []).map(r => ({
                          name: r.outcome.replace(/_/g, " "),
                          count: r.count,
                          fill: ({ interested: "#10b981", callback: "#3b82f6", no_answer: "#9ca3af", not_interested: "#f87171", dnc: "#f97316" } as Record<string, string>)[r.outcome] ?? "#94a3b8",
                        }))}
                        margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                        <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                        <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} />
                        <Bar dataKey="count" radius={[4,4,0,0]}>
                          {(callsData?.outcomeBreakdown ?? []).map((row, i) => (
                            <Cell key={i} fill={({ interested: "#10b981", callback: "#3b82f6", no_answer: "#9ca3af", not_interested: "#f87171", dnc: "#f97316" } as Record<string, string>)[row.outcome] ?? "#94a3b8"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              {/* Per-Campaign Stats */}
              <Card className="shadow-xs">
                <CardHeader className="px-0 py-0">
                  <div className="bg-indigo-600 text-white px-4 py-2.5 rounded-t-lg">
                    <CardTitle className="text-sm font-semibold">🎯 Campaign Performance</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  {callsL ? <div className="p-4"><Skeleton className="h-40" /></div> : (callsData?.campaigns.length ?? 0) === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-8 px-4">No campaigns yet</p>
                  ) : (
                    <div className="divide-y">
                      {(callsData?.campaigns ?? []).map((c: any) => (
                        <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold truncate">{c.name}</p>
                            <p className="text-xs text-muted-foreground">{c.total ?? 0} calls · {c.interested ?? 0} interested</p>
                          </div>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                            c.status === "active" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                            c.status === "completed" ? "bg-blue-50 text-blue-700 border-blue-200" :
                            "bg-gray-50 text-gray-600 border-gray-200"
                          }`}>{c.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* ── Top Opportunities ───────────────────────────────────────── */}
            {(topOppL || (topOppData?.opportunities?.length ?? 0) > 0) && (
              <TopOpportunitiesPanel
                opportunities={topOppData?.opportunities ?? []}
                loading={topOppL}
                gtmStatuses={gtmStatuses}
                gtmLoading={gtmLoading}
                gtmError={gtmError}
                onOpenContact={(cid, name) => {
                  setDrill({ open: true, title: `${name} — Timeline`, extraParams: {} });
                  setDrillContactId(cid);
                  setDrillContactName(name);
                }}
              />
            )}

            {/* Recent Calls */}
            <Card className="shadow-xs">
              <CardHeader className="px-0 py-0">
                <div className="bg-indigo-600 text-white px-4 py-2.5 rounded-t-lg flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">📋 Recent Calls</CardTitle>
                  <div className="flex items-center gap-2">
                    {recentCallsData && (
                      <span className="text-[10px] text-indigo-200">
                        {((recentCallsData.page - 1) * recentCallsData.pageSize) + 1}–{Math.min(recentCallsData.page * recentCallsData.pageSize, recentCallsData.total)} of {recentCallsData.total}
                      </span>
                    )}
                    <Badge variant="secondary" className="text-[10px] bg-white/20 text-white border-0">
                      {recentCallsData?.total ?? 0} calls
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {recentCallsL ? (
                  <div className="space-y-2 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
                ) : (recentCallsData?.calls.length ?? 0) === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                    <p className="text-sm font-medium">No calls logged yet</p>
                    <p className="text-xs text-center max-w-xs">
                      Create a Call Campaign and start it to see call logs here.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[700px]">
                      <thead>
                        <tr className="border-b bg-slate-50">
                          {["Contact", "Phone", "Company", "Outcome", "Duration", "Campaign", "Called", "Intelligence"].map(h => (
                            <th key={h} className="text-left text-xs font-semibold text-indigo-600 px-3 py-2.5 whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {(recentCallsData?.calls ?? []).map((row: any) => {
                          const outcomeColors: Record<string, string> = {
                            interested:     "text-emerald-700 bg-emerald-50 border-emerald-200",
                            callback:       "text-blue-700 bg-blue-50 border-blue-200",
                            answered:       "text-slate-700 bg-slate-100 border-slate-300",
                            no_answer:      "text-gray-500 bg-gray-50 border-gray-200",
                            not_interested: "text-red-600 bg-red-50 border-red-200",
                            dnc:            "text-orange-700 bg-orange-50 border-orange-200",
                          };
                          const transcriptText: string = (() => {
                            const tx = row.transcript;
                            if (!tx) return "";
                            if (typeof tx === "string") {
                              try {
                                const p = JSON.parse(tx);
                                if (Array.isArray(p)) return p.map((m: any) => `${m.role === "assistant" ? "AI" : "User"}: ${m.content ?? ""}`).join("\n");
                                return p?.text ?? tx;
                              } catch { return tx; }
                            }
                            if (Array.isArray(tx)) return (tx as any[]).map((m: any) => `${m.role === "assistant" ? "AI" : "User"}: ${m.content ?? ""}`).join("\n");
                            return (tx as any)?.text ?? "";
                          })();
                          return (
                            <CallLogRow
                              key={row.id}
                              row={row}
                              outcomeColors={outcomeColors}
                              transcriptText={transcriptText}
                              gtmStatuses={gtmStatuses}
                              gtmLoading={gtmLoading}
                              gtmError={gtmError}
                              onRefetch={() => refetchCalls()}
                              onOpenContact={(cid, name) => {
                                setDrill({ open: true, title: `${name} — Timeline`, extraParams: {} });
                                setDrillContactId(cid);
                                setDrillContactName(name);
                              }}
                            />
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {/* Pagination controls */}
                {recentCallsData && recentCallsData.total > recentCallsData.pageSize && (
                  <div className="flex items-center justify-between px-4 py-3 border-t bg-slate-50/60">
                    <p className="text-xs text-muted-foreground">
                      Page {recentCallsData.page} of {Math.ceil(recentCallsData.total / recentCallsData.pageSize)}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        className="text-xs px-3 py-1.5 rounded border font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 transition-colors"
                        disabled={callsPage <= 1}
                        onClick={() => setCallsPage(p => Math.max(1, p - 1))}
                      >
                        ← Prev
                      </button>
                      <span className="text-xs font-semibold text-indigo-600 tabular-nums px-1">
                        {callsPage} / {Math.ceil(recentCallsData.total / recentCallsData.pageSize)}
                      </span>
                      <button
                        className="text-xs px-3 py-1.5 rounded border font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 transition-colors"
                        disabled={callsPage >= Math.ceil(recentCallsData.total / recentCallsData.pageSize)}
                        onClick={() => setCallsPage(p => p + 1)}
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Call Intelligence ─────────────────────────────────────────── */}
        {(section === "call-intel" || section === "calls-intel") && (
          <div className="space-y-5">
            <div className="rounded-lg bg-gradient-to-r from-indigo-900 to-violet-900 text-white px-6 py-4 text-center">
              <h2 className="text-base font-bold tracking-wide">🧠 CALL INTELLIGENCE — LLM-Powered Call Analysis</h2>
              <p className="text-xs text-indigo-300 mt-0.5">Structured prospect profiling, sentiment scoring, and action routing for every call</p>
            </div>

            {/* Aggregate KPI strip */}
            {ciaL ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
              </div>
            ) : ciAggregate && (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 gap-4">
                {[
                  { label: "Total Analysed",  val: ciAggregate.summary.completed.toLocaleString(),  color: "text-indigo-700" },
                  { label: "Avg Interest",    val: `${ciAggregate.summary.avgScore}/10`,             color: ciAggregate.summary.avgScore >= 7 ? "text-emerald-700" : ciAggregate.summary.avgScore >= 4 ? "text-amber-700" : "text-red-600" },
                  { label: "Failed / Pending", val: `${ciAggregate.summary.failed} / ${ciAggregate.summary.processing}`, color: ciAggregate.summary.failed > 0 ? "text-red-600" : "text-slate-600" },
                  { label: "Hot Leads (7-10)", val: ciAggregate.summary.scoreBands.hot.toLocaleString(), color: "text-emerald-700" },
                ].map(({ label, val, color }) => (
                  <Card key={label} className="shadow-xs">
                    <CardContent className="px-4 py-3">
                      <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold">{label}</p>
                      <p className={`text-2xl font-black tabular-nums mt-1 ${color}`}>{val}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Charts row */}
            {ciAggregate && !ciaL && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {/* Sentiment breakdown */}
                <Card className="shadow-xs">
                  <CardHeader className="px-0 py-0">
                    <div className="bg-violet-600 text-white px-4 py-2.5 rounded-t-lg">
                      <CardTitle className="text-sm font-semibold">😊 Sentiment Breakdown</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-4 pt-3 space-y-3">
                    {[
                      { label: "Positive", val: ciAggregate.summary.sentimentBreakdown.positive, col: "bg-emerald-400" },
                      { label: "Neutral",  val: ciAggregate.summary.sentimentBreakdown.neutral,  col: "bg-slate-300"  },
                      { label: "Negative", val: ciAggregate.summary.sentimentBreakdown.negative, col: "bg-red-400"    },
                    ].map(({ label, val, col }) => {
                      const total = ciAggregate.summary.completed;
                      const pct = total > 0 ? Math.round((val / total) * 100) : 0;
                      return (
                        <div key={label} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-600 font-medium">{label}</span>
                            <span className="font-bold tabular-nums text-slate-700">{val} <span className="text-slate-400 font-normal">({pct}%)</span></span>
                          </div>
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${col}`} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                {/* Interest score distribution */}
                <Card className="shadow-xs">
                  <CardHeader className="px-0 py-0">
                    <div className="bg-indigo-600 text-white px-4 py-2.5 rounded-t-lg">
                      <CardTitle className="text-sm font-semibold">📊 Interest Score Distribution</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-2 pt-3">
                    {(ciAggregate.scoreDistribution.length === 0) ? (
                      <p className="text-xs text-muted-foreground text-center py-8">No completed analyses yet</p>
                    ) : (
                      <ResponsiveContainer width="100%" height={140}>
                        <BarChart data={ciAggregate.scoreDistribution} barSize={16}>
                          <XAxis dataKey="score" tick={{ fontSize: 10 }} />
                          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={24} />
                          <Tooltip formatter={(v: any) => [v, "Calls"]} />
                          <Bar dataKey="count" radius={[3,3,0,0]}>
                            {ciAggregate.scoreDistribution.map((entry) => (
                              <Cell
                                key={entry.score}
                                fill={entry.score >= 7 ? "#10b981" : entry.score >= 4 ? "#f59e0b" : "#ef4444"}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </CardContent>
                </Card>

                {/* Team routing + score bands */}
                <Card className="shadow-xs">
                  <CardHeader className="px-0 py-0">
                    <div className="bg-blue-600 text-white px-4 py-2.5 rounded-t-lg">
                      <CardTitle className="text-sm font-semibold">🏷️ Team Routing & Bands</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-4 pt-3 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-blue-50 rounded-lg p-3 text-center">
                        <p className="text-[10px] text-blue-600 font-semibold uppercase tracking-wider">Sales</p>
                        <p className="text-2xl font-black text-blue-700 tabular-nums mt-1">{ciAggregate.summary.teamBreakdown.sales}</p>
                      </div>
                      <div className="bg-purple-50 rounded-lg p-3 text-center">
                        <p className="text-[10px] text-purple-600 font-semibold uppercase tracking-wider">Marketing</p>
                        <p className="text-2xl font-black text-purple-700 tabular-nums mt-1">{ciAggregate.summary.teamBreakdown.marketing}</p>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      {[
                        { label: "🔥 Hot (7-10)", val: ciAggregate.summary.scoreBands.hot,  bg: "bg-emerald-50",  text: "text-emerald-800" },
                        { label: "🌡️ Warm (4-6)", val: ciAggregate.summary.scoreBands.warm, bg: "bg-amber-50",   text: "text-amber-800"  },
                        { label: "❄️ Cold (1-3)", val: ciAggregate.summary.scoreBands.cold, bg: "bg-slate-50",   text: "text-slate-700"  },
                      ].map(({ label, val, bg, text }) => (
                        <div key={label} className={`flex items-center justify-between px-3 py-1.5 rounded ${bg}`}>
                          <span className={`text-xs font-medium ${text}`}>{label}</span>
                          <span className={`text-sm font-black tabular-nums ${text}`}>{val}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Calls over time — line chart */}
            {ciAggregate && (ciAggregate.callsOverTime?.length ?? 0) > 0 && (
              <Card className="shadow-xs">
                <CardHeader className="px-0 py-0">
                  <div className="bg-slate-700 text-white px-4 py-2.5 rounded-t-lg">
                    <CardTitle className="text-sm font-semibold">📈 Calls Analysed Over Time (Last 30 Days)</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="px-4 pb-2 pt-3">
                  <ResponsiveContainer width="100%" height={160}>
                    <LineChart data={ciAggregate.callsOverTime} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="day" tick={{ fontSize: 9 }} tickFormatter={(v: string) => v.slice(5)} />
                      <YAxis tick={{ fontSize: 9 }} allowDecimals={false} width={24} />
                      <Tooltip labelFormatter={(v: string) => `Date: ${v}`} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Line type="monotone" dataKey="completed" stroke="#10b981" strokeWidth={2} dot={false} name="Completed" />
                      <Line type="monotone" dataKey="failed"    stroke="#ef4444" strokeWidth={1.5} dot={false} name="Failed" strokeDasharray="4 2" />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {/* Sales vs Marketing stacked bar */}
            {ciAggregate && (ciAggregate.salesVsMarketing?.length ?? 0) > 0 && (
              <Card className="shadow-xs">
                <CardHeader className="px-0 py-0">
                  <div className="bg-violet-600 text-white px-4 py-2.5 rounded-t-lg">
                    <CardTitle className="text-sm font-semibold">🏆 Sales vs Marketing — Action Timing Breakdown</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="px-4 pb-2 pt-3">
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={ciAggregate.salesVsMarketing} barSize={20} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                      <XAxis dataKey="timing" tick={{ fontSize: 9 }} tickFormatter={(v: string) => v.replace(/_/g, " ")} />
                      <YAxis tick={{ fontSize: 9 }} allowDecimals={false} width={24} />
                      <Tooltip formatter={(v: any, name: string) => [v, name.charAt(0).toUpperCase() + name.slice(1)]} labelFormatter={(v: string) => v.replace(/_/g, " ")} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Bar dataKey="sales"     stackId="a" fill="#3b82f6" radius={[0,0,0,0]} name="Sales" />
                      <Bar dataKey="marketing" stackId="a" fill="#8b5cf6" radius={[3,3,0,0]} name="Marketing" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {/* Recent failures */}
            {ciAggregate && (ciAggregate.recentFailures?.length ?? 0) > 0 && (
              <Card className="shadow-xs border-red-200 bg-red-50">
                <CardContent className="px-4 py-3">
                  <p className="text-xs font-semibold text-red-700 mb-2">⚠️ Recent Analysis Failures — click Retry to rerun</p>
                  <div className="space-y-1.5">
                    {ciAggregate.recentFailures.map((f: any) => (
                      <div key={f.id} className="flex items-center gap-3 bg-white rounded p-2 border border-red-100">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-slate-700">
                            {[f.first_name, f.last_name].filter(Boolean).join(" ") || "Unknown Contact"} — Call #{f.call_log_id}
                          </p>
                          <p className="text-[10px] text-red-600 truncate">{f.error_message ?? "Unknown error"}</p>
                        </div>
                        <button
                          className="text-[10px] px-2 py-1 bg-red-100 text-red-700 hover:bg-red-200 rounded font-semibold shrink-0 transition-colors"
                          onClick={async () => {
                            await fetch(`/api/analytics/call-intelligence/${f.call_log_id}/rerun`, { method: "POST", credentials: "include" });
                            setTimeout(() => { refetchCiAgg(); refetchCiList(); }, 5000);
                          }}
                        >
                          Retry
                        </button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Filterable call analysis list */}
            <Card className="shadow-xs">
              <CardHeader className="px-0 py-0">
                <div className="bg-gradient-to-r from-indigo-600 to-violet-600 text-white px-4 py-2.5 rounded-t-lg flex items-center gap-3">
                  <CardTitle className="text-sm font-semibold flex-1">🔍 All Call Analyses</CardTitle>
                  <span className="text-[10px] text-indigo-200">
                    {ciList ? `${ciList.pagination.total} total` : ""}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="px-4 pt-3 pb-4">
                {/* Filters */}
                <div className="flex flex-wrap gap-2 mb-3">
                  <input
                    type="text"
                    placeholder="Search contact, company, action…"
                    className="h-7 px-2.5 text-xs border rounded flex-1 min-w-[180px] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    value={ciFilters.search}
                    onChange={e => setCiFilters(f => ({ ...f, search: e.target.value, page: 1 }))}
                  />
                  <select
                    className="h-7 px-2 text-xs border rounded bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    value={ciFilters.sentiment}
                    onChange={e => setCiFilters(f => ({ ...f, sentiment: e.target.value, page: 1 }))}
                  >
                    <option value="">All sentiments</option>
                    <option value="positive">😊 Positive</option>
                    <option value="neutral">😐 Neutral</option>
                    <option value="negative">😞 Negative</option>
                  </select>
                  <select
                    className="h-7 px-2 text-xs border rounded bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    value={ciFilters.owning_team}
                    onChange={e => setCiFilters(f => ({ ...f, owning_team: e.target.value, page: 1 }))}
                  >
                    <option value="">All teams</option>
                    <option value="sales">Sales</option>
                    <option value="marketing">Marketing</option>
                  </select>
                  <select
                    className="h-7 px-2 text-xs border rounded bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    value={ciFilters.status}
                    onChange={e => setCiFilters(f => ({ ...f, status: e.target.value, page: 1 }))}
                  >
                    <option value="">All call outcomes</option>
                    <option value="answered">✅ Answered (≥ 30s)</option>
                    <option value="short_call">⚡ Picked up briefly (&lt; 30s)</option>
                    <option value="not_answered">❌ Not answered</option>
                    <option value="voicemail">📭 Voicemail</option>
                    <option value="busy">🚫 Busy / No answer</option>
                  </select>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number" min="1" max="10" placeholder="Min score"
                      className="h-7 w-20 px-2 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      value={ciFilters.score_min}
                      onChange={e => setCiFilters(f => ({ ...f, score_min: e.target.value, page: 1 }))}
                    />
                    <span className="text-xs text-slate-400">–</span>
                    <input
                      type="number" min="1" max="10" placeholder="Max score"
                      className="h-7 w-20 px-2 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      value={ciFilters.score_max}
                      onChange={e => setCiFilters(f => ({ ...f, score_max: e.target.value, page: 1 }))}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-400 font-medium">From</span>
                    <input
                      type="date"
                      className="h-7 px-2 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      value={ciFilters.dateFrom}
                      onChange={e => setCiFilters(f => ({ ...f, dateFrom: e.target.value, page: 1 }))}
                    />
                    <span className="text-[10px] text-slate-400 font-medium">To</span>
                    <input
                      type="date"
                      className="h-7 px-2 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      value={ciFilters.dateTo}
                      onChange={e => setCiFilters(f => ({ ...f, dateTo: e.target.value, page: 1 }))}
                    />
                  </div>
                  {(ciFilters.sentiment || ciFilters.owning_team || ciFilters.status || ciFilters.score_min || ciFilters.score_max || ciFilters.search || ciFilters.dateFrom || ciFilters.dateTo) && (
                    <button
                      className="h-7 px-2.5 text-xs bg-slate-100 hover:bg-slate-200 rounded font-medium transition-colors"
                      onClick={() => setCiFilters({ sentiment: "", owning_team: "", score_min: "", score_max: "", status: "", search: "", dateFrom: "", dateTo: "", page: 1 })}
                    >
                      ✕ Clear
                    </button>
                  )}
                </div>

                {/* Table */}
                {ciL ? (
                  <div className="space-y-2">
                    {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
                  </div>
                ) : (ciList?.items.length ?? 0) === 0 ? (
                  <div className="py-12 text-center">
                    <p className="text-sm text-muted-foreground">No call analyses found</p>
                    <p className="text-xs text-muted-foreground mt-1">Analyses are created automatically when a call completes, or manually from Call Campaigns → 🧠 Analyse.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[800px]">
                      <thead>
                        <tr className="border-b bg-slate-50">
                          {["Contact", "Company", "Status", "Sentiment", "Interest", "Team", "Action", "Analysed", ""].map(h => (
                            <th key={h} className="text-left text-xs font-semibold text-indigo-600 px-3 py-2.5 whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {ciList!.items.map((row: any) => {
                          const score = row.interest_score;
                          const scoreBg = score >= 7 ? "bg-emerald-100 text-emerald-800" : score >= 4 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800";
                          const sentimentMap: Record<string,string> = {
                            positive: "bg-emerald-50 text-emerald-700 border-emerald-200",
                            neutral:  "bg-slate-50  text-slate-600  border-slate-200",
                            negative: "bg-red-50    text-red-600    border-red-200",
                          };
                          const sentimentEmoji: Record<string,string> = { positive: "😊", neutral: "😐", negative: "😞" };
                          return (
                            <tr
                              key={row.id}
                              className="hover:bg-indigo-50/40 cursor-pointer transition-colors"
                              onClick={async () => {
                                // Primary (spec): GET /analytics/call-intelligence/:id (analysis row id)
                                // Fallback: /:callLogId compat alias
                                try {
                                  const url = row.id
                                    ? `/api/analytics/call-intelligence/${row.id}`
                                    : `/api/analytics/call-intelligence/${row.call_log_id}`;
                                  const detail = await fetch(url, { credentials: "include" }).then(r => r.json());
                                  setCiDetail(detail);
                                } catch {
                                  setCiDetail(row); // fallback to list data
                                }
                              }}
                            >
                              <td className="px-3 py-2.5 text-xs">
                                <p className="font-semibold text-slate-800">{[row.first_name, row.last_name].filter(Boolean).join(" ") || "—"}</p>
                                {row.contact_id && <GtmStatusBadge scope="contact" status={gtmStatuses[String(row.contact_id)]} loading={gtmLoading} error={gtmError} />}
                                {row.email && <p className="text-[10px] text-muted-foreground">{row.email}</p>}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-muted-foreground">{row.company_name ?? "—"}</td>
                              <td className="px-3 py-2.5 text-xs">
                                {row.status === "completed" ? (
                                  <span className="text-emerald-600 font-semibold text-[10px]">✓ Done</span>
                                ) : row.status === "failed" ? (
                                  <span className="text-red-600 font-semibold text-[10px]">✗ Failed</span>
                                ) : (
                                  <span className="text-amber-600 font-semibold text-[10px] animate-pulse">⏳ {row.status}</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-xs">
                                {row.sentiment ? (
                                  <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${sentimentMap[row.sentiment] ?? ""}`}>
                                    {sentimentEmoji[row.sentiment]} {row.sentiment}
                                  </span>
                                ) : "—"}
                              </td>
                              <td className="px-3 py-2.5 text-xs">
                                {score != null ? (
                                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold ${scoreBg}`}>
                                    {score}/10
                                  </span>
                                ) : "—"}
                              </td>
                              <td className="px-3 py-2.5 text-xs">
                                {row.owning_team ? (
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${row.owning_team === "sales" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>
                                    {row.owning_team}
                                  </span>
                                ) : "—"}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-slate-700 max-w-[200px] truncate">{row.recommended_action ?? "—"}</td>
                              <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                                {row.processed_at ? formatReportDate(row.processed_at) : row.created_at ? formatReportDate(row.created_at) : "—"}
                              </td>
                              <td className="px-3 py-2.5 text-xs">
                                <button
                                  className={`text-[10px] px-2 py-0.5 rounded font-semibold transition-colors ${
                                    row.status === "failed"
                                      ? "bg-red-50 text-red-600 border border-red-200 hover:bg-red-100"
                                      : "bg-indigo-50 text-indigo-600 border border-indigo-200 hover:bg-indigo-100"
                                  }`}
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    // Primary (spec): POST /analytics/call-intelligence/:id/rerun
                                    const url = row.id
                                      ? `/api/analytics/call-intelligence/${row.id}/rerun`
                                      : `/api/analytics/call-intelligence/${row.call_log_id}/rerun`;
                                    await fetch(url, { method: "POST", credentials: "include" });
                                    setTimeout(() => { refetchCiList(); refetchCiAgg(); }, 5000);
                                  }}
                                >
                                  {row.status === "failed" ? "Retry" : "Re-analyse"}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Pagination */}
                {ciList && ciList.pagination.totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4 pt-3 border-t">
                    <p className="text-xs text-muted-foreground">
                      Showing {((ciFilters.page - 1) * 20) + 1}–{Math.min(ciFilters.page * 20, ciList.pagination.total)} of {ciList.pagination.total}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button
                        className="h-7 w-7 flex items-center justify-center border rounded text-xs hover:bg-slate-50 disabled:opacity-40 transition-colors"
                        disabled={ciFilters.page <= 1}
                        onClick={() => setCiFilters(f => ({ ...f, page: f.page - 1 }))}
                      >‹</button>
                      <span className="text-xs font-medium text-slate-600 px-1">{ciFilters.page} / {ciList.pagination.totalPages}</span>
                      <button
                        className="h-7 w-7 flex items-center justify-center border rounded text-xs hover:bg-slate-50 disabled:opacity-40 transition-colors"
                        disabled={ciFilters.page >= ciList.pagination.totalPages}
                        onClick={() => setCiFilters(f => ({ ...f, page: f.page + 1 }))}
                      >›</button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Detail drawer */}
            <Sheet open={!!ciDetail} onOpenChange={(open) => { if (!open) setCiDetail(null); }}>
              <SheetContent className="w-[520px] sm:w-[580px] p-0 flex flex-col overflow-hidden" side="right">
                <SheetHeader className="px-4 py-3 border-b flex-row items-center gap-2 shrink-0 space-y-0">
                  <div className="flex-1 min-w-0">
                    <SheetTitle className="text-sm font-semibold truncate">
                      🧠 {[ciDetail?.first_name, ciDetail?.last_name].filter(Boolean).join(" ") || "Call Analysis"}
                    </SheetTitle>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {ciDetail?.company_name ?? ""}{ciDetail?.company_name && ciDetail?.campaign_name ? " · " : ""}{ciDetail?.campaign_name ?? ""}
                    </p>
                  </div>
                  {ciDetail?.sentiment && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold shrink-0 ${
                      ciDetail.sentiment === "positive" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                      ciDetail.sentiment === "negative" ? "bg-red-50 text-red-600 border-red-200" :
                      "bg-slate-50 text-slate-600 border-slate-200"
                    }`}>
                      {ciDetail.sentiment === "positive" ? "😊" : ciDetail.sentiment === "negative" ? "😞" : "😐"} {ciDetail.sentiment}
                    </span>
                  )}
                </SheetHeader>

                {ciDetail && (
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Interest score */}
                    <div className="flex items-center gap-3 bg-indigo-50 rounded-lg px-4 py-3">
                      <div className="flex-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600 mb-1">Interest Score</p>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-indigo-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${ciDetail.interest_score >= 7 ? "bg-emerald-500" : ciDetail.interest_score >= 4 ? "bg-amber-400" : "bg-red-400"}`}
                              style={{ width: `${(ciDetail.interest_score / 10) * 100}%` }}
                            />
                          </div>
                          <span className="text-lg font-black tabular-nums text-indigo-800">{ciDetail.interest_score}/10</span>
                        </div>
                        {ciDetail.interest_justification && (
                          <p className="text-[10px] text-indigo-600 mt-1 italic">{ciDetail.interest_justification}</p>
                        )}
                      </div>
                    </div>

                    {/* Call summary */}
                    {ciDetail.call_summary && (
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Call Summary</p>
                        <p className="text-xs text-slate-700 leading-relaxed">{ciDetail.call_summary}</p>
                      </div>
                    )}

                    {/* Key highlights */}
                    {Array.isArray(ciDetail.key_highlights) && ciDetail.key_highlights.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-600 mb-2">✨ Key Highlights</p>
                        <ul className="space-y-1.5">
                          {(ciDetail.key_highlights as string[]).map((h, i) => (
                            <li key={i} className="text-xs text-slate-700 flex gap-1.5 bg-violet-50 rounded px-2 py-1.5">
                              <span className="text-violet-400 shrink-0">•</span>
                              <span>{h}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Prospect profile */}
                    {ciDetail.prospect_profile && (
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 mb-2">👤 Prospect Profile</p>
                        <div className="bg-blue-50 rounded-lg p-3 space-y-1.5">
                          {["decision_authority", "budget_status", "timeline"].map(k => {
                            const v = (ciDetail.prospect_profile as any)[k];
                            if (!v) return null;
                            return (
                              <div key={k} className="flex items-center gap-2">
                                <span className="text-[9px] text-slate-500 uppercase tracking-wider w-20 shrink-0">{k.replace(/_/g," ")}</span>
                                <span className="text-xs font-medium text-slate-700 capitalize">{String(v).replace(/_/g," ")}</span>
                              </div>
                            );
                          })}
                          {Array.isArray((ciDetail.prospect_profile as any).pain_points) && (ciDetail.prospect_profile as any).pain_points.length > 0 && (
                            <div>
                              <p className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">Pain Points</p>
                              {((ciDetail.prospect_profile as any).pain_points as string[]).map((p,i) => (
                                <p key={i} className="text-xs text-slate-700 flex gap-1"><span className="text-red-400">•</span>{p}</p>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Recommended action */}
                    {ciDetail.recommended_action && (
                      <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">✅ Recommended Action</p>
                          {ciDetail.owning_team && (
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${ciDetail.owning_team === "sales" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>
                              {ciDetail.owning_team}
                            </span>
                          )}
                          {ciDetail.action_timing && (
                            <span className="text-[9px] text-slate-500 ml-auto">⏰ {String(ciDetail.action_timing).replace(/_/g," ")}</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-800 font-medium leading-snug">{ciDetail.recommended_action}</p>
                        {ciDetail.action_reason && (
                          <p className="text-[10px] text-slate-500 mt-1.5 italic">{ciDetail.action_reason}</p>
                        )}
                      </div>
                    )}

                    {/* Follow-up message */}
                    {ciDetail.follow_up_message && (
                      <div className="bg-amber-50 border border-amber-100 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">📧 Ready-to-Send Follow-Up</p>
                          <button
                            className="text-[10px] px-2 py-0.5 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded font-semibold transition-colors"
                            onClick={() => { navigator.clipboard?.writeText(ciDetail.follow_up_message); }}
                          >
                            Copy
                          </button>
                        </div>
                        <p className="text-xs text-slate-700 leading-relaxed italic">{ciDetail.follow_up_message}</p>
                      </div>
                    )}

                    {/* Sentiment justification */}
                    {ciDetail.sentiment_justification && (
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Sentiment Analysis</p>
                        <p className="text-xs text-slate-600 leading-relaxed">{ciDetail.sentiment_justification}</p>
                      </div>
                    )}

                    {/* Error message (for failed analyses) */}
                    {ciDetail.status === "failed" && ciDetail.error_message && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                        <p className="text-[10px] font-semibold text-red-700 mb-1">Error</p>
                        <p className="text-[10px] font-mono text-red-600 break-all">{ciDetail.error_message}</p>
                      </div>
                    )}

                    {/* Source transcript */}
                    {ciDetail.transcript && (
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                        <p className="text-[10px] font-semibold text-slate-600 mb-1.5">📝 Source Transcript</p>
                        <pre className="text-[10px] text-slate-700 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto font-sans">
                          {(() => {
                            const tx = ciDetail.transcript;
                            if (typeof tx === "string") {
                              try {
                                const p = JSON.parse(tx);
                                if (Array.isArray(p)) return p.map((m: any) => `${m.role ?? "unknown"}: ${m.content ?? ""}`).join("\n");
                                return (p as any)?.text ?? tx;
                              } catch { return tx; }
                            }
                            if (Array.isArray(tx)) return (tx as any[]).map((m: any) => `${m.role ?? "unknown"}: ${m.content ?? ""}`).join("\n");
                            return (tx as any)?.text ?? JSON.stringify(tx, null, 2);
                          })()}
                        </pre>
                      </div>
                    )}

                    {/* Re-analyse — always visible */}
                    <div className="border-t pt-3">
                      <button
                        className="w-full text-xs px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg font-semibold transition-colors"
                        onClick={async () => {
                          const url = ciDetail.id
                            ? `/api/analytics/call-intelligence/${ciDetail.id}/rerun`
                            : `/api/analytics/call-intelligence/${ciDetail.call_log_id}/rerun`;
                          await fetch(url, { method: "POST", credentials: "include" });
                          setCiDetail(null);
                          setTimeout(() => { refetchCiList(); refetchCiAgg(); }, 5000);
                        }}
                      >
                        🔄 Re-analyse with LLM
                      </button>
                    </div>

                    {/* Meta */}
                    <div className="text-[10px] text-slate-400 pt-1 space-y-0.5">
                      <p>Call log ID: {ciDetail.call_log_id}</p>
                      {ciDetail.outcome && <p>Call outcome: {ciDetail.outcome.replace(/_/g, " ")}</p>}
                      {ciDetail.duration_seconds && <p>Duration: {ciDetail.duration_seconds}s</p>}
                      {ciDetail.processed_at && <p>Analysed: {formatReportDateTime(ciDetail.processed_at)}</p>}
                    </div>
                  </div>
                )}
              </SheetContent>
            </Sheet>
          </div>
        )}

      </div>

      {/* ── Drill-Down Sheet ─────────────────────────────────────────── */}
      <Sheet open={drill.open} onOpenChange={(open) => { if (!open) { setDrill(s => ({ ...s, open: false })); setDrillContactId(null); } }}>
        <SheetContent className="w-[480px] sm:w-[520px] p-0 flex flex-col overflow-hidden" side="right">
          <SheetHeader className="px-4 py-3 border-b flex-row items-center gap-2 shrink-0 space-y-0">
            {drillContactId ? (
              <button onClick={() => setDrillContactId(null)} className="p-1 hover:bg-muted rounded transition-colors shrink-0">
                <ArrowLeft className="w-4 h-4"/>
              </button>
            ) : null}
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-sm font-semibold truncate">
                {drillContactId ? drillContactName : drill.title}
              </SheetTitle>
              {!drillContactId && (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {drillLoading ? "Loading…" : `${drillContacts.length} contact${drillContacts.length!==1?"s":""} found`}
                </p>
              )}
            </div>
            {!drillContactId && (
              <Badge variant="secondary" className="text-[10px] shrink-0">
                {drillContacts.length}
              </Badge>
            )}
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            {drillContactId ? (
              <ContactTimelinePanel contactId={drillContactId}/>
            ) : (
              <ContactListPanel
                contacts={drillContacts}
                loading={drillLoading}
                gtmStatuses={gtmStatuses}
                gtmLoading={gtmLoading}
                gtmError={gtmError}
                onSelect={(id, name) => { setDrillContactId(id); setDrillContactName(name); }}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Visitor Timeline Sheet (anonymous visitors) ───────────────────── */}
      <Sheet open={visitorSheet.open} onOpenChange={open => setVisitorSheet(s => ({ ...s, open }))}>
        <SheetContent className="w-[440px] sm:w-[500px] p-0 flex flex-col overflow-hidden" side="right">
          <SheetHeader className="px-4 py-3 border-b shrink-0 space-y-0">
            <SheetTitle className="flex items-center gap-2 text-sm font-semibold">
              <span className="w-7 h-7 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0">
                <UserX className="w-3.5 h-3.5 text-slate-400" />
              </span>
              Anonymous Visitor
            </SheetTitle>
            <div className="flex items-center gap-2 mt-1.5">
              <StageBadge stage={visitorSheet.stage} />
              {visitorSheet.company && (
                <span className="text-[11px] text-muted-foreground truncate">· {visitorSheet.company}</span>
              )}
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {visitorEventsLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-12 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading activity…
              </div>
            ) : (() => {
              const evRows: any[] = [...(visitorEventsData?.rows ?? [])].reverse();
              if (evRows.length === 0) return (
                <p className="text-xs text-muted-foreground text-center py-16">
                  No events found for this visitor.
                </p>
              );

              const EVENT_COLOR: Record<string, string> = {
                page_view:      "border-indigo-400 bg-indigo-50",
                cta_click:      "border-emerald-400 bg-emerald-50",
                banner_click:   "border-sky-400 bg-sky-50",
                banner_dismiss: "border-gray-300 bg-gray-50",
                form_submit:    "border-violet-400 bg-violet-50",
              };
              const EVENT_DOT: Record<string, string> = {
                page_view:      "bg-indigo-400",
                cta_click:      "bg-emerald-400",
                banner_click:   "bg-sky-400",
                banner_dismiss: "bg-gray-300",
                form_submit:    "bg-violet-400",
              };

              return (
                <div className="relative pl-5">
                  {/* timeline spine */}
                  <div className="absolute left-[9px] top-2 bottom-2 w-px bg-border" />
                  <div className="space-y-3">
                    {evRows.map((ev: any, i: number) => (
                      <div key={ev.id ?? i} className="flex gap-3 relative">
                        {/* dot */}
                        <div className={cn(
                          "w-[9px] h-[9px] rounded-full border-2 bg-white shrink-0 mt-1 -ml-5 z-10",
                          ev.event_type === "page_view"       ? "border-indigo-400" :
                          ev.event_type === "cta_click"       ? "border-emerald-400" :
                          ev.event_type === "form_submit"     ? "border-violet-400" :
                          ev.event_type === "banner_click"    ? "border-sky-400" :
                          "border-gray-300"
                        )} />
                        {/* card */}
                        <div className={cn(
                          "flex-1 rounded-lg border px-3 py-2 text-[11px]",
                          EVENT_COLOR[ev.event_type] ?? "border-gray-200 bg-gray-50"
                        )}>
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-semibold text-foreground leading-tight">
                              {ev.page_name || (EVENT_TYPE_LABEL[ev.event_type] ?? ev.event_type) || "Event"}
                            </span>
                            <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                              {ev.visit_date ? formatReportDateTime(ev.visit_date) : "—"}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-muted-foreground">
                              {EVENT_TYPE_LABEL[ev.event_type] ?? ev.event_type}
                            </span>
                            {(ev.score ?? 0) > 0 && (
                              <span className="text-emerald-600 font-semibold">+{ev.score} pts</span>
                            )}
                            {ev.duration_seconds != null && ev.duration_seconds > 0 && (
                              <span className="text-muted-foreground">{fmtDuration(ev.duration_seconds)}</span>
                            )}
                          </div>
                          {ev.user_stage && ev.user_stage !== "pre-aware" && i === evRows.length - 1 && (
                            <div className="mt-1.5">
                              <StageBadge stage={ev.user_stage} />
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AI Assistant ──────────────────────────────────────────────────── */}
      <AnalyticsAiPanel />
    </div>
  );
}

// ── AI Assistant Panel ──────────────────────────────────────────────────────

type ActionCard = {
  type: "executed" | "scheduled";
  action: "resume" | "pause";
  playName: string;
  newStatus?: string;
  executeAt?: string;
  delayHuman?: string;
};
type FollowUpContact = {
  name: string; company: string; email: string;
  score: number; stage: string; pts7d: number;
  momentum: string; est_days_to_75: number | null; reason: string;
};
type AiMessage = {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  actionCards?: ActionCard[];
  followUps?: FollowUpContact[];
  dataRows?: Record<string, unknown>[];
};

const SUGGESTED = [
  "Names of people who opened an email in the last 7 days",
  "Contacts who re-engaged after a 10-day gap",
  "Which accounts should I focus on this week?",
  "Who should I follow up in the TechNova play?",
  "Show me hot contacts (score ≥ 75) and their company",
];

function DataTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows || rows.length === 0) return null;
  const cols = Object.keys(rows[0]);
  const fmt = (v: unknown) => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      return formatReportDate(v);
    }
    if (Array.isArray(v)) return v.join(", ") || "—";
    return String(v);
  };
  const label = (k: string) => k.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
      <table className="text-[11px] w-full border-collapse">
        <thead>
          <tr className="bg-indigo-50">
            {cols.map(c => (
              <th key={c} className="text-left px-2.5 py-1.5 font-semibold text-indigo-700 whitespace-nowrap border-b border-indigo-100">{label(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-gray-50/60"}>
              {cols.map(c => (
                <td key={c} className="px-2.5 py-1.5 text-gray-700 whitespace-nowrap border-b border-gray-100 max-w-[180px] truncate">{fmt(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-muted-foreground px-2.5 py-1">{rows.length} row{rows.length !== 1 ? "s" : ""}</p>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 75 ? "bg-red-100 text-red-700" : score >= 50 ? "bg-orange-100 text-orange-700" : score >= 25 ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-500";
  return <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded-full", color)}>{score}</span>;
}

function ActionCardBadge({ card }: { card: ActionCard }) {
  const isScheduled = card.type === "scheduled";
  const isPause = card.action === "pause";
  return (
    <div className={cn(
      "mt-2 rounded-xl border px-3 py-2.5 text-xs flex items-start gap-2.5",
      isScheduled
        ? "bg-amber-50 border-amber-200"
        : isPause
        ? "bg-rose-50 border-rose-200"
        : "bg-emerald-50 border-emerald-200"
    )}>
      <span className="text-base leading-none mt-0.5">
        {isScheduled ? "⏰" : isPause ? "⏸" : "▶️"}
      </span>
      <div className="flex-1 min-w-0">
        <p className={cn(
          "font-semibold leading-tight",
          isScheduled ? "text-amber-800" : isPause ? "text-rose-800" : "text-emerald-800"
        )}>
          {isScheduled
            ? `Scheduled: ${card.action === "pause" ? "Pause" : "Resume"} in ${card.delayHuman}`
            : card.action === "pause" ? "Play Paused" : "Play Resumed"}
        </p>
        <p className={cn(
          "mt-0.5 leading-tight",
          isScheduled ? "text-amber-700" : isPause ? "text-rose-700" : "text-emerald-700"
        )}>
          {card.playName}
          {isScheduled && card.executeAt && (
            <span className="ml-1 opacity-70">
              · at {formatReportTime(card.executeAt)}
            </span>
          )}
          {!isScheduled && card.newStatus && (
            <span className="ml-1 opacity-70">· status: {card.newStatus}</span>
          )}
        </p>
      </div>
    </div>
  );
}

function FollowUpList({ contacts }: { contacts: FollowUpContact[] }) {
  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Follow-up list</p>
      {contacts.map((c, i) => (
        <div key={i} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 flex items-start gap-2">
          <span className="text-base leading-none mt-0.5">{c.reason.split(" ")[0]}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-medium text-xs text-gray-800 truncate">{c.name}</span>
              <ScoreBadge score={c.score} />
              <span className="text-[10px] text-gray-400">{c.stage}</span>
            </div>
            <p className="text-[11px] text-gray-500 truncate">{c.company} · {c.email}</p>
            <div className="flex items-center gap-2 mt-0.5">
              {c.pts7d > 0 && (
                <span className="text-[10px] text-indigo-600">+{c.pts7d} pts this week</span>
              )}
              {c.est_days_to_75 !== null && c.est_days_to_75 > 0 && (
                <span className="text-[10px] text-orange-600">~{c.est_days_to_75}d to action</span>
              )}
              <span className="text-[10px] text-gray-400">{c.reason.replace(/^\S+\s/, "")}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AnalyticsAiPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (open && messages.length === 0) {
      inputRef.current?.focus();
    }
  }, [open, messages.length]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    setInput("");
    const history = messages.slice(-6);
    setMessages(prev => [...prev, { role: "user", content: q }]);
    setLoading(true);
    setMessages(prev => [...prev, { role: "assistant", content: "", streaming: true }]);

    try {
      const res = await fetch("/api/analytics/ai-chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });

      if (!res.ok || !res.body) throw new Error("Request failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let full = "";
      const actionCards: ActionCard[] = [];
      let followUps: FollowUpContact[] = [];
      let dataRows: Record<string, unknown>[] | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const ev = JSON.parse(line);

            if (ev.content) {
              full += ev.content;
              setMessages(prev => {
                const next = [...prev];
                next[next.length - 1] = { role: "assistant", content: full, streaming: true, actionCards, followUps };
                return next;
              });
            }

            if (ev.action_card) {
              actionCards.push(ev.action_card as ActionCard);
              setMessages(prev => {
                const next = [...prev];
                next[next.length - 1] = { ...next[next.length - 1], actionCards: [...actionCards] };
                return next;
              });
            }

            if (ev.follow_up_contacts) {
              followUps = ev.follow_up_contacts as FollowUpContact[];
              setMessages(prev => {
                const next = [...prev];
                next[next.length - 1] = { ...next[next.length - 1], followUps };
                return next;
              });
            }

            if (ev.data_rows !== undefined) {
              dataRows = ev.data_rows as Record<string, unknown>[];
              setMessages(prev => {
                const next = [...prev];
                next[next.length - 1] = { ...next[next.length - 1], dataRows };
                return next;
              });
            }

            if (ev.done) {
              setMessages(prev => {
                const next = [...prev];
                next[next.length - 1] = { role: "assistant", content: full, streaming: false, actionCards, followUps, dataRows };
                return next;
              });
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch {
      setMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: "assistant", content: "Sorry, something went wrong. Please try again.", streaming: false };
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, [messages, loading]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
  };

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg px-4 py-2.5 text-sm font-medium transition-all"
      >
        <Sparkles className="w-4 h-4" />
        <span>AI Assistant</span>
      </button>

      {/* Panel */}
      {open && (
        <div className="fixed bottom-20 right-6 z-50 w-[440px] max-w-[calc(100vw-3rem)] bg-white rounded-2xl shadow-2xl border border-indigo-100 flex flex-col overflow-hidden"
             style={{ height: "600px" }}>
          {/* Header */}
          <div className="flex items-center gap-2.5 px-4 py-3 bg-gradient-to-r from-indigo-600 to-violet-600 text-white shrink-0">
            <div className="flex items-center justify-center w-7 h-7 rounded-full bg-white/20">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm leading-tight">KABOOM AI Assistant</p>
              <p className="text-[11px] text-indigo-100 leading-tight">Insights · Actions · Scheduling</p>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button onClick={() => setMessages([])} className="p-1.5 hover:bg-white/20 rounded-lg transition-colors" title="Clear chat">
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
              <button onClick={() => setOpen(false)} className="p-1.5 hover:bg-white/20 rounded-lg transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 flex items-center justify-center">
                  <Sparkles className="w-7 h-7 text-indigo-500" />
                </div>
                <div>
                  <p className="font-semibold text-gray-800 text-sm">Ask anything or give a command</p>
                  <p className="text-xs text-muted-foreground mt-1">Get insights, or ask me to resume/pause plays,<br/>schedule actions, and surface follow-up contacts.</p>
                </div>
                <div className="w-full space-y-1.5">
                  {SUGGESTED.map(s => (
                    <button key={s} onClick={() => send(s)}
                      className="w-full text-left text-xs px-3 py-2 rounded-lg border border-indigo-100 hover:bg-indigo-50 hover:border-indigo-300 text-gray-700 transition-colors">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={cn("flex gap-2.5", m.role === "user" ? "justify-end" : "justify-start")}>
                  {m.role === "assistant" && (
                    <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
                      <Sparkles className="w-3 h-3 text-indigo-600" />
                    </div>
                  )}
                  <div className={cn(
                    "rounded-2xl px-3.5 py-2.5 text-sm max-w-[88%] leading-relaxed",
                    m.role === "user"
                      ? "bg-indigo-600 text-white rounded-tr-sm whitespace-pre-wrap"
                      : "bg-gray-50 text-gray-800 border border-gray-100 rounded-tl-sm"
                  )}>
                    {m.role === "assistant" ? (
                      <>
                        {/* Action cards appear before text */}
                        {m.actionCards?.map((card, ci) => (
                          <ActionCardBadge key={ci} card={card} />
                        ))}
                        {/* Text content */}
                        {m.content ? (
                          <p className={cn("whitespace-pre-wrap", m.actionCards?.length ? "mt-2" : "")}>
                            {m.content}
                            {m.streaming && <span className="inline-block w-0.5 h-3.5 bg-indigo-500 animate-pulse ml-0.5 align-middle" />}
                          </p>
                        ) : m.streaming && !m.actionCards?.length ? (
                          <span className="inline-flex gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                          </span>
                        ) : null}
                        {/* Data table from query_data tool */}
                        {m.dataRows !== undefined && (
                          <DataTable rows={m.dataRows} />
                        )}
                        {/* Follow-up contact list */}
                        {m.followUps && m.followUps.length > 0 && (
                          <FollowUpList contacts={m.followUps} />
                        )}
                      </>
                    ) : (
                      <span className="whitespace-pre-wrap">{m.content}</span>
                    )}
                  </div>
                  {m.role === "user" && (
                    <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold text-white">
                      U
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>

          {/* Quick-action chips */}
          {messages.length > 0 && !loading && (
            <div className="px-4 pb-1 flex gap-1.5 overflow-x-auto shrink-0 scrollbar-none">
              {["Who re-engaged this week?", "Follow-up list?", "Email openers last 7d?", "Next steps?"].map(s => (
                <button key={s} onClick={() => send(s)}
                  className="text-[11px] whitespace-nowrap px-2.5 py-1 rounded-full bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-100 transition-colors shrink-0">
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="px-3 pb-3 pt-2 border-t bg-gray-50/50 shrink-0">
            <div className="flex items-end gap-2 bg-white rounded-xl border border-gray-200 px-3 py-2 focus-within:border-indigo-400 focus-within:ring-1 focus-within:ring-indigo-200 transition-all">
              <Textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Ask a question or give a command…"
                disabled={loading}
                className="flex-1 resize-none border-0 p-0 text-sm focus-visible:ring-0 bg-transparent min-h-[20px] max-h-[100px] leading-relaxed"
                rows={1}
              />
              <button
                onClick={() => send(input)}
                disabled={!input.trim() || loading}
                className="shrink-0 w-8 h-8 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors"
              >
                <SendHorizonal className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5 text-center">Enter to send · Shift+Enter for new line</p>
          </div>
        </div>
      )}
    </>
  );
}
