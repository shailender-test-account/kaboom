import { useState } from "react";
import { getContact, type Contact, type Deal } from "@workspace/api-client-react";
import GccContactAlternatives from "@/components/contacts/GccContactAlternatives";
import { formatAmount, MEANING_LABEL } from "./deal-utils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import {
  ArrowLeft, Building2, Mail, Phone, Tag, Activity, Briefcase,
  StickyNote, Loader2, Send, Trash2, GitBranch, ClipboardList, ChevronDown, ChevronRight, Route, Layers, Pencil,
  Plus, Zap, ExternalLink, PhoneCall, Copy, Check, PhoneOff, FolderPlus,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScoreBadge } from "@/components/ScoreBadge";
import { useAuthContext } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import EngagementHistory from "@/components/EngagementHistory";
import DemoEngagementHistory from "@/components/demo-engagement/DemoEngagementHistory";
import { cn } from "@/lib/utils";
import { AddToSegmentDialog } from "@/components/AddToSegmentDialog";
import { formatDistanceToNow, format, subDays } from "date-fns";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Tooltip as UITooltip, TooltipContent as UITooltipContent, TooltipTrigger as UITooltipTrigger,
} from "@/components/ui/tooltip";

const api = (path: string, init?: RequestInit) => fetch(`/api${path}`, { credentials: "include", ...init });
const getJson = (path: string) => api(path).then(r => r.json());

type Activity = { id: number; eventType: string; description: string; pointsEarned: number | null; createdAt: string; sequenceId?: number | null; sequenceName?: string | null };
type Note = { id: number; body: string; authorId: number | null; createdAt: string };
type Threshold = { id: number; label: string; minScore: number; color: string };
type ContactPlay = {
  id: number; name: string; status: string;
  clientId: number | null; clientName: string | null; enrolledAt: string;
};
type FormSubmission = {
  id: number;
  form_id: number | null;
  form_name: string | null;
  journey_id: number | null;
  journey_name: string | null;
  page_id: number | null;
  action_type: string | null;
  field_values: Record<string, unknown>;
  submitted_at: string;
};
type ContactJourney = { id: number; name: string; status: string; slug: string | null; assignedAt: string | null };
type ContactSequenceEnrollment = { id: number; sequenceId: number; sequenceName: string; status: string; enrolledAt: string; completedAt: string | null };
type StageHistoryEntry = { id: number; fromStage: string | null; toStage: string; scoreAtTransition: number; source: string | null; createdAt: string };
type ContestEvent = { id: number; eventType: string; props: Record<string, unknown> | null; createdAt: string; journeyId: number | null; journeyName: string | null };
type ScoreHistoryEntry = { id: number; oldScore: number; newScore: number; delta: number; source: string | null; createdAt: string };

const DEAL_STAGE_LABELS: Record<string, string> = {
  prospect: "Prospect", qualified: "Qualified", proposal: "Proposal",
  negotiation: "Negotiation", closed_won: "Won", closed_lost: "Lost",
};
const DEAL_STAGE_COLORS: Record<string, string> = {
  prospect: "bg-gray-100 text-gray-700", qualified: "bg-blue-100 text-blue-700",
  proposal: "bg-yellow-100 text-yellow-700", negotiation: "bg-orange-100 text-orange-700",
  closed_won: "bg-green-100 text-green-700", closed_lost: "bg-red-100 text-red-700",
};
const CONTACT_STAGE_LABELS: Record<string, string> = {
  "pre-aware": "Pre-Aware", "aware": "Aware", "pre-engage": "Pre-Engage",
  "engage": "Engage", "advance-engage": "Adv-Engage", "action": "Action",
};
const CONTACT_STAGE_COLORS: Record<string, string> = {
  "pre-aware": "bg-slate-100 text-slate-700",
  "aware": "bg-blue-100 text-blue-700",
  "pre-engage": "bg-violet-100 text-violet-700",
  "engage": "bg-emerald-100 text-emerald-700",
  "advance-engage": "bg-amber-100 text-amber-700",
  "action": "bg-rose-100 text-rose-700",
};
const CONTACT_STAGE_DOT: Record<string, string> = {
  "pre-aware": "#94a3b8", "aware": "#60a5fa", "pre-engage": "#a78bfa",
  "engage": "#34d399", "advance-engage": "#f59e0b", "action": "#f43f5e",
};

const EVENT_ICONS: Record<string, string> = {
  email_open: "📧", email_click: "🔗", page_view: "👁", asset_download: "📥",
  form_submit: "📝", email_sent: "📤", email_bounced: "↩️", score_change: "📊",
  auto_journey_assigned: "🗺️", sequence_enrolled: "⚡",
  sequence_enrollment_skipped: "⏭️",
  scenario_selected: "🎭", challenges_selected: "🎯",
  entry_submitted: "🏆", registration_completed: "📋",
};

const CONTEST_EVENT_LABELS: Record<string, string> = {
  scenario_selected: "Scenario selected",
  challenges_selected: "Challenges selected",
  entry_submitted: "Contest entry submitted",
  registration_completed: "Registration completed",
};

/** Render a contest event's props as a human-readable list of strings. */
function formatContestProps(props: Record<string, unknown> | null): string[] {
  if (!props) return [];
  const lines: string[] = [];
  if (props.scenario) {
    const raw = String(props.scenario);
    const label = raw.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`Scenario: ${label}`);
  }
  // choices / challenges — may be array or comma-separated string
  const choicesRaw = props.choices ?? props.challenges ?? props.challenge_ids;
  if (choicesRaw) {
    const items: string[] = Array.isArray(choicesRaw)
      ? (choicesRaw as unknown[]).map(c => String(c).replace(/_/g, " ").replace(/\b\w/g, x => x.toUpperCase()))
      : String(choicesRaw).split(",").map(c => c.trim().replace(/_/g, " ").replace(/\b\w/g, x => x.toUpperCase()));
    if (items.length > 0) lines.push(`Challenges: ${items.join(", ")}`);
  }
  if (props.demo_interest !== undefined) {
    const val = String(props.demo_interest).toLowerCase();
    lines.push(`Demo interest: ${val === "yes" || val === "true" ? "Yes" : "No"}`);
  }
  return lines;
}

const TRIGGER_EVENT_LABELS: Record<string, string> = {
  page_view:        "Journey page view",
  email_click:      "Email click",
  email_open:       "Email open",
  form_submit:      "Form submission",
  asset_download:   "Asset download",
  sequence_enrolled:"Sequence enrolled",
  call_completed:   "Call completed",
};

function extractRuleName(description: string): string | null {
  const match = description.match(/routing rule (.+)$/);
  return match ? match[1] : null;
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function timeAgo(d: string) {
  return formatDistanceToNow(new Date(d), { addSuffix: true });
}

// ── Score formula breakdown ───────────────────────────────────────────────────
// Formula: rawScore = (engagementScore × freqScore) + stageBonus + velocityBonus + accountBonus
//          intentScore = min(100, rawScore)
function ScoreBreakdown({ contact, textColor }: {
  contact: Pick<Contact,
    "intentScore" | "rawIntentScore" | "engagementScore" | "freqScore" |
    "maxStageScore" | "velocityBonus" | "accountBonus" | "accountColleagues" | "distinctActiveDays"
  >;
  textColor: string;
}) {
  const [open, setOpen] = useState(false);

  const eng   = contact.engagementScore ?? 0;
  const fbm   = contact.freqScore ?? 1;
  const spb   = contact.maxStageScore ?? 0;
  const vel   = contact.velocityBonus ?? 0;
  const acct  = contact.accountBonus ?? 0;
  const raw   = contact.rawIntentScore ?? 0;
  const capped = contact.intentScore ?? 0;
  const engContrib = eng * fbm;

  const hasData = contact.engagementScore != null || contact.freqScore != null;
  if (!hasData) return null;

  const rows: { label: string; formula: string; value: number; tooltip: string }[] = [
    {
      label: "Engagement × Freq",
      formula: `${eng.toFixed(1)} × ${fbm.toFixed(2)}`,
      value: Math.round(engContrib * 10) / 10,
      tooltip: "Per-session quality score (time, scroll, interactions, stage weight, recency decay) multiplied by the frequency-breadth multiplier (log scale — rewards spreading activity across more days).",
    },
    {
      label: "Stage bonus",
      formula: `5 × (rank − 1)`,
      value: spb,
      tooltip: "Additive bonus for reaching deeper funnel stages: Aware=0, Pre-engage=5, Engage=10, Advance-engage=15, Action=20.",
    },
    {
      label: "Velocity bonus",
      formula: "last 7d vs prior 7d",
      value: vel,
      tooltip: "Acceleration bonus: +10 if active only in last 7d (fresh surge), +8 for moderate acceleration (≥1.3×), +15 for strong acceleration (≥2×). Zero if decelerating — recency decay handles fade.",
    },
    {
      label: "Account (ABM) bonus",
      formula: `5 × min(${contact.accountColleagues ?? 0}, 4)`,
      value: acct,
      tooltip: `Buying-committee signal: each colleague at the same company who viewed a shared journey and is enrolled in the same sequence adds +5 pts (max +20). ${contact.accountColleagues ?? 0} active colleague${(contact.accountColleagues ?? 0) !== 1 ? "s" : ""} found.`,
    },
  ];

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
      >
        {open
          ? <ChevronDown className="w-3 h-3 shrink-0" />
          : <ChevronRight className="w-3 h-3 shrink-0" />}
        Score breakdown
        <span className="ml-auto tabular-nums text-[10px] text-muted-foreground">
          {contact.distinctActiveDays != null
            ? `${contact.distinctActiveDays} active day${contact.distinctActiveDays !== 1 ? "s" : ""}`
            : ""}
        </span>
      </button>

      {open && (
        <div className="mt-2 rounded-md bg-white/70 border border-white/80 overflow-hidden">
          <table className="w-full text-xs">
            <tbody>
              {rows.map(r => (
                <tr key={r.label} className="border-b border-gray-100 last:border-0">
                  <td className="px-3 py-1.5 text-muted-foreground font-medium whitespace-nowrap">
                    <UITooltip>
                      <UITooltipTrigger asChild>
                        <span className="cursor-help underline decoration-dotted underline-offset-2">{r.label}</span>
                      </UITooltipTrigger>
                      <UITooltipContent side="left" className="max-w-[240px] text-[11px] leading-snug">
                        {r.tooltip}
                      </UITooltipContent>
                    </UITooltip>
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground/70 font-mono text-[10px] whitespace-nowrap">{r.formula}</td>
                  <td className={`px-3 py-1.5 text-right font-bold tabular-nums ${r.value !== 0 ? textColor : "text-muted-foreground"}`}>
                    {r.value > 0 ? `+${r.value}` : r.value === 0 ? "—" : r.value}
                  </td>
                </tr>
              ))}
              {/* Divider + totals */}
              <tr className="border-t-2 border-gray-200 bg-gray-50/60">
                <td className="px-3 py-1.5 font-semibold text-foreground" colSpan={2}>Raw score</td>
                <td className={`px-3 py-1.5 text-right font-black tabular-nums ${textColor}`}>{raw}</td>
              </tr>
              {raw > 100 && (
                <tr className="bg-gray-50/40">
                  <td className="px-3 py-1.5 text-muted-foreground" colSpan={2}>Capped at 100</td>
                  <td className={`px-3 py-1.5 text-right font-black tabular-nums ${textColor}`}>{capped}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Score History Panel ───────────────────────────────────────────────────────
const SOURCE_LABELS: Record<string, string> = {
  admin_recompute: "Admin recompute",
  backfill: "Backfill",
  live: "Live event",
};

function ScoreHistoryPanel({ history, currentScore }: { history: ScoreHistoryEntry[]; currentScore: number }) {
  const [expanded, setExpanded] = useState(false);

  // Build chart data: include an initial point at score 0 before first entry, then all entries
  const chartData = [
    { date: format(new Date(history[0].createdAt), "MMM d"), score: history[0].oldScore, label: "Start" },
    ...history.map(h => ({
      date: format(new Date(h.createdAt), "MMM d"),
      score: h.newScore,
      label: format(new Date(h.createdAt), "MMM d, yyyy HH:mm"),
    })),
  ];

  const maxScore = Math.max(...chartData.map(d => d.score), 10);
  const firstDate = history[0].createdAt;
  const lastDate = history[history.length - 1].createdAt;
  const totalDelta = currentScore - history[0].oldScore;

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-100 transition-colors"
      >
        <span className="text-base">📈</span>
        <div className="flex-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Score History</p>
          <p className="text-sm font-medium text-foreground">
            {history.length} change{history.length !== 1 ? "s" : ""} recorded
            <span className={cn("ml-2 text-xs font-semibold", totalDelta > 0 ? "text-emerald-600" : totalDelta < 0 ? "text-red-500" : "text-slate-400")}>
              {totalDelta > 0 ? "+" : ""}{totalDelta} total
            </span>
          </p>
        </div>
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="border-t border-slate-200">
          {/* Mini chart */}
          <div className="px-4 pt-3 pb-1">
            <ResponsiveContainer width="100%" height={80}>
              <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <YAxis domain={[0, Math.ceil(maxScore * 1.1)]} hide />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ fontSize: 11, padding: "4px 8px", borderRadius: 6, border: "1px solid #e2e8f0" }}
                  formatter={(v: number) => [`Score: ${v}`, ""]}
                  labelFormatter={(l: string) => l}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#6366f1", strokeWidth: 0 }}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Log table */}
          <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
            {[...history].reverse().map(h => {
              const pos = h.delta > 0;
              const neg = h.delta < 0;
              return (
                <div key={h.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className={cn(
                    "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                    pos ? "bg-emerald-100 text-emerald-700" : neg ? "bg-red-100 text-red-600" : "bg-slate-100 text-slate-500"
                  )}>
                    {pos ? "▲" : neg ? "▼" : "→"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold tabular-nums text-foreground">
                        {h.oldScore} → {h.newScore}
                      </span>
                      <span className={cn(
                        "text-xs font-bold tabular-nums",
                        pos ? "text-emerald-600" : neg ? "text-red-500" : "text-slate-400"
                      )}>
                        {pos ? "+" : ""}{h.delta}
                      </span>
                      {h.source && (
                        <span className="text-[10px] text-muted-foreground bg-slate-100 px-1.5 py-0.5 rounded">
                          {SOURCE_LABELS[h.source] ?? h.source}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {format(new Date(h.createdAt), "MMM d, yyyy 'at' h:mm a")}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Score Trend Sparkline ─────────────────────────────────────────────────────
// Always-visible mini chart rendered inside the Intent Engine card. Shows the
// 30-day score trajectory so admins can tell at a glance whether this contact
// is heating up, cooling down, or holding steady.
function ScoreTrendSparkline({
  history,
  currentScore,
}: {
  history: ScoreHistoryEntry[];
  currentScore: number;
}) {
  const now = new Date();
  const cutoff30 = subDays(now, 30);
  const cutoff7  = subDays(now, 7);

  // Only use entries from the last 30 days. If there are none in that window,
  // fall back to the most recent entry as a baseline so we can still show the
  // current score as a dot.
  const recent = history.filter(h => new Date(h.createdAt) >= cutoff30);
  const baseline =
    recent.length > 0
      ? recent[0].oldScore
      : history.length > 0
      ? history[history.length - 1].newScore
      : currentScore;

  // Build chronological [score] points: baseline → each newScore → current
  const raw: number[] = [
    baseline,
    ...recent.map(h => h.newScore),
  ];
  // Ensure the final point is always the live score
  if (raw[raw.length - 1] !== currentScore) raw.push(currentScore);

  // Remove consecutive duplicates to avoid a flat line masking real changes
  const scores = raw.filter((s, i) => i === 0 || s !== raw[i - 1]);
  if (scores.length < 2) return null;

  const chartData = scores.map(score => ({ score }));
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);

  // 7-day and 30-day deltas
  const delta7 = history
    .filter(h => new Date(h.createdAt) >= cutoff7)
    .reduce((sum, h) => sum + h.delta, 0);
  const delta30 = currentScore - baseline;

  const isUp   = delta30 > 0;
  const isDown = delta30 < 0;
  const lineColor  = isUp ? "#10b981" : isDown ? "#f43f5e" : "#94a3b8";
  const trendLabel = isUp ? "↑ Heating up" : isDown ? "↓ Cooling down" : "→ Stable";
  const trendCls   = isUp ? "text-emerald-600" : isDown ? "text-red-500" : "text-slate-500";

  return (
    <div className="mt-3 pt-3 border-t border-white/30">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[11px] font-semibold ${trendCls}`}>{trendLabel}</span>
        {delta7 !== 0 && (
          <span className={`text-[10px] tabular-nums font-medium ${delta7 > 0 ? "text-emerald-600" : "text-red-500"}`}>
            {delta7 > 0 ? "+" : ""}{delta7} this week
          </span>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto">30-day trend</span>
      </div>
      <ResponsiveContainer width="100%" height={44}>
        <AreaChart data={chartData} margin={{ top: 3, right: 0, bottom: 3, left: 0 }}>
          <defs>
            <linearGradient id="scoreTrendGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={lineColor} stopOpacity={0.25} />
              <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={[Math.max(0, minScore - 3), maxScore + 3]} hide />
          <Tooltip
            contentStyle={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff" }}
            formatter={(v: number) => [`Score: ${v}`, ""]}
            labelFormatter={() => ""}
          />
          <Area
            type="monotone"
            dataKey="score"
            stroke={lineColor}
            strokeWidth={1.5}
            fill="url(#scoreTrendGradient)"
            dot={false}
            activeDot={{ r: 3, fill: lineColor, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function StageBadge({ stage }: { stage: string }) {
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold", CONTACT_STAGE_COLORS[stage] ?? "bg-gray-100 text-gray-700")}>
      {CONTACT_STAGE_LABELS[stage] ?? stage}
    </span>
  );
}

const OUTCOME_COLORS: Record<string, string> = {
  interested:        "text-emerald-700 bg-emerald-50 border-emerald-200",
  not_interested:    "text-red-600    bg-red-50    border-red-200",
  callback:          "text-amber-700  bg-amber-50  border-amber-200",
  voicemail:         "text-slate-600  bg-slate-50  border-slate-200",
  no_answer:         "text-slate-500  bg-slate-50  border-slate-200",
  do_not_call:       "text-red-700    bg-red-50    border-red-200",
};

function ContactCallRow({ call }: { call: any }) {
  const [expanded, setExpanded] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [copied, setCopied] = useState(false);
  const [analysing, setAnalysing] = useState(false);

  const hasLlm    = !!(call.analysisId && call.analysisStatus === "completed");
  const hasTx     = !!(call.transcriptText);
  const hasDetail = !!(hasTx || call.aiSummary || hasLlm);

  const sentimentBadge = (s: string | null) => {
    if (!s) return null;
    const map: Record<string, string> = {
      positive: "bg-emerald-50 text-emerald-700 border-emerald-200",
      neutral:  "bg-slate-50  text-slate-600  border-slate-200",
      negative: "bg-red-50    text-red-600    border-red-200",
    };
    return (
      <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold", map[s] ?? "bg-gray-50 text-gray-600 border-gray-200")}>
        {s === "positive" ? "😊" : s === "negative" ? "😞" : "😐"} {s}
      </span>
    );
  };

  const interestBar = (score: number | null) => {
    if (score == null) return null;
    const pct = (score / 10) * 100;
    const col = score >= 7 ? "bg-emerald-500" : score >= 4 ? "bg-amber-400" : "bg-red-400";
    return (
      <div className="flex items-center gap-1.5">
        <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", col)} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[10px] font-bold tabular-nums">{score}/10</span>
      </div>
    );
  };

  const copyFollowUp = async () => {
    if (!call.followUpMessage) return;
    await navigator.clipboard.writeText(call.followUpMessage);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const triggerAnalysis = async () => {
    if (analysing) return;
    setAnalysing(true);
    try {
      await fetch(`/api/analytics/calls/${call.id}/analyse`, { method: "POST", credentials: "include" });
      setTimeout(() => setAnalysing(false), 4000);
    } catch { setAnalysing(false); }
  };

  return (
    <div className="border rounded-lg overflow-hidden bg-card">
      <div
        className={cn("flex items-start gap-3 px-4 py-3", hasDetail && "cursor-pointer hover:bg-indigo-50/40 transition-colors")}
        onClick={() => hasDetail && setExpanded(v => !v)}
      >
        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
          <PhoneCall className="w-4 h-4 text-indigo-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {call.outcome ? (
              <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium", OUTCOME_COLORS[call.outcome] ?? "text-gray-600 bg-gray-50 border-gray-200")}>
                {call.outcome.replace(/_/g, " ")}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Call</span>
            )}
            {call.campaignName && (
              <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground truncate max-w-[140px]">{call.campaignName}</span>
            )}
            {hasLlm && (
              <>
                {sentimentBadge(call.sentiment)}
                {interestBar(call.interestScore)}
              </>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground flex-wrap">
            {call.durationSeconds && <span>{call.durationSeconds}s</span>}
            {call.startedAt && <span>{timeAgo(call.startedAt)}</span>}
            {call.endedReason && <span className="font-mono text-[10px]">{call.endedReason}</span>}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          {!hasLlm && hasTx && (
            <button
              className={cn("text-[10px] px-2 py-0.5 rounded border font-medium transition-colors",
                analysing ? "bg-indigo-50 text-indigo-400 border-indigo-100 cursor-wait" : "bg-indigo-50 text-indigo-600 border-indigo-200 hover:bg-indigo-100"
              )}
              onClick={e => { e.stopPropagation(); triggerAnalysis(); }}
              disabled={analysing}
            >
              {analysing ? "⏳ queued…" : "🧠 Analyse"}
            </button>
          )}
          {call.analysisStatus === "processing" && (
            <span className="text-[10px] text-amber-600 animate-pulse">⏳ analysing…</span>
          )}
          {hasDetail && (
            <span className="text-[10px] text-indigo-500">{expanded ? "▲ collapse" : "▼ view"}</span>
          )}
        </div>
      </div>

      {expanded && hasDetail && (
        <div className="border-t bg-indigo-50/20 px-4 py-3 space-y-3">

          {/* LLM Call Intelligence */}
          {hasLlm && (
            <div className="bg-gradient-to-br from-indigo-50 to-violet-50 border border-indigo-200 rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm">🧠</span>
                <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-700">Call Intelligence — LLM Analysis</p>
                <div className="flex items-center gap-1.5 ml-auto flex-wrap">
                  {sentimentBadge(call.sentiment)}
                  {call.interestScore != null && <span className="text-[10px] text-slate-500 font-medium">Interest {call.interestScore}/10</span>}
                </div>
              </div>

              {call.llmCallSummary && (
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-indigo-500 mb-1">Call Summary</p>
                  <p className="text-[11px] text-slate-700 leading-relaxed">{call.llmCallSummary}</p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {Array.isArray(call.keyHighlights) && call.keyHighlights.length > 0 && (
                  <div className="bg-white/70 rounded p-2">
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-violet-600 mb-1.5">✨ Key Highlights</p>
                    <ul className="space-y-1">
                      {(call.keyHighlights as string[]).map((h, i) => (
                        <li key={i} className="text-[10px] text-slate-700 leading-snug flex gap-1">
                          <span className="text-violet-400 shrink-0">•</span><span>{h}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {call.prospectProfile && (
                  <div className="bg-white/70 rounded p-2 space-y-1.5">
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-blue-600 mb-1.5">👤 Prospect Profile</p>
                    {call.prospectProfile.decision_authority && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] text-slate-500 w-16 shrink-0">Authority</span>
                        <span className="text-[10px] font-medium text-slate-700 capitalize">{String(call.prospectProfile.decision_authority).replace(/_/g, " ")}</span>
                      </div>
                    )}
                    {call.prospectProfile.budget_status && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] text-slate-500 w-16 shrink-0">Budget</span>
                        <span className="text-[10px] font-medium text-slate-700 capitalize">{String(call.prospectProfile.budget_status).replace(/_/g, " ")}</span>
                      </div>
                    )}
                    {call.prospectProfile.timeline && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] text-slate-500 w-16 shrink-0">Timeline</span>
                        <span className="text-[10px] font-medium text-slate-700 capitalize">{String(call.prospectProfile.timeline).replace(/_/g, " ")}</span>
                      </div>
                    )}
                    {Array.isArray(call.prospectProfile.pain_points) && call.prospectProfile.pain_points.length > 0 && (
                      <div>
                        <p className="text-[9px] text-slate-500 mb-0.5">Pain Points</p>
                        {(call.prospectProfile.pain_points as string[]).map((p, i) => (
                          <p key={i} className="text-[10px] text-slate-700 flex gap-1"><span className="text-red-400">•</span>{p}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Recommended Action */}
              {call.recommendedAction && (
                <div className="bg-white/80 rounded p-2.5 border border-emerald-100">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <p className="text-[9px] font-semibold uppercase tracking-wider text-emerald-700 mb-1">
                        ✅ Recommended Action
                        {call.owningTeam && (
                          <span className={cn("ml-2 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase", call.owningTeam === "sales" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700")}>
                            {call.owningTeam}
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-slate-800 font-medium leading-snug">{call.recommendedAction}</p>
                      {call.actionTiming && (
                        <p className="text-[9px] text-muted-foreground mt-0.5">⏰ {call.actionTiming.replace(/_/g, " ")}</p>
                      )}
                    </div>
                  </div>
                  {call.actionReason && (
                    <p className="text-[10px] text-slate-500 mt-1.5 italic leading-snug">{call.actionReason}</p>
                  )}
                </div>
              )}

              {/* Follow-up message — copyable */}
              {call.followUpMessage && (
                <div className="bg-amber-50 border border-amber-100 rounded p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-amber-700 mb-1">📧 Ready-to-Send Follow-Up</p>
                    <button
                      onClick={e => { e.stopPropagation(); copyFollowUp(); }}
                      className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border font-medium bg-white border-amber-200 text-amber-700 hover:bg-amber-50 transition-colors"
                      title="Copy to clipboard"
                    >
                      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-700 leading-relaxed italic">{call.followUpMessage}</p>
                </div>
              )}

              {/* Sentiment / Interest justifications */}
              {(call.sentimentJustification || call.interestJustification) && (
                <div className="flex gap-3 flex-wrap">
                  {call.sentimentJustification && (
                    <p className="text-[10px] text-slate-500 leading-snug flex-1 min-w-0">
                      <span className="font-semibold text-indigo-600">Sentiment: </span>{call.sentimentJustification}
                    </p>
                  )}
                  {call.interestJustification && (
                    <p className="text-[10px] text-slate-500 leading-snug flex-1 min-w-0">
                      <span className="font-semibold text-indigo-600">Interest: </span>{call.interestJustification}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Legacy AI summary */}
          {call.aiSummary && !hasLlm && (
            <div className="bg-white border border-indigo-100 rounded-lg p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600 mb-1.5">🤖 AI Call Summary</p>
              <p className="text-[11px] text-slate-700 leading-relaxed">{call.aiSummary}</p>
            </div>
          )}
          {call.aiNextSteps && !hasLlm && (
            <div className="bg-white border border-emerald-100 rounded-lg p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1.5">✅ Recommended Next Steps</p>
              <div className="space-y-1">
                {String(call.aiNextSteps).split("\n").filter(Boolean).map((step: string, i: number) => (
                  <p key={i} className="text-[11px] text-slate-700 leading-snug">{step}</p>
                ))}
              </div>
            </div>
          )}

          {/* Transcript toggle */}
          {hasTx && (
            <div>
              <button
                className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium"
                onClick={e => { e.stopPropagation(); setShowTranscript(v => !v); }}
              >
                {showTranscript ? "▲ hide transcript" : "▼ show full transcript"}
              </button>
              {showTranscript && (
                <div className="mt-1.5 text-[11px] text-slate-700 leading-relaxed max-h-48 overflow-y-auto bg-white border border-indigo-100 rounded p-2.5 font-mono whitespace-pre-wrap">
                  {call.transcriptText}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface Props { id?: string }

export default function ContactDetailPage({ id }: Props) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const { user: currentUser } = useAuthContext();
  const isAdmin = (currentUser as any)?.role === "admin";
  const qc = useQueryClient();
  const contactId = parseInt(id ?? "");
  const [noteBody, setNoteBody] = useState("");
  const [reassignOpen, setReassignOpen] = useState(false);
  const [pendingClientId, setPendingClientId] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [addToSegmentOpen, setAddToSegmentOpen] = useState(false);
  const [editFirst, setEditFirst] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editStage, setEditStage] = useState("pre-aware");
  const [editStatus, setEditStatus] = useState<"active" | "inactive" | "unsubscribed">("active");
  const [editTags, setEditTags] = useState("");
  const [editWebsite, setEditWebsite] = useState("");
  const [editLinkedin, setEditLinkedin] = useState("");
  const [editCity, setEditCity] = useState("");
  const [editCountry, setEditCountry] = useState("");
  const [playPickerOpen, setPlayPickerOpen] = useState(false);
  const [journeyPickerOpen, setJourneyPickerOpen] = useState(false);
  const [sequencePickerOpen, setSequencePickerOpen] = useState(false);
  const [selectedEnrollPlayId, setSelectedEnrollPlayId] = useState("");
  const [selectedEnrollJourneyId, setSelectedEnrollJourneyId] = useState("");
  const [selectedEnrollSequenceId, setSelectedEnrollSequenceId] = useState("");
  const [reEnrollTarget, setReEnrollTarget] = useState<ContactSequenceEnrollment | null>(null);
  const VALID_TABS = ["overview", "qualification", "timeline", "activity", "deals", "notes", "forms", "plays", "journeys", "sequences"] as const;
  const rawTab = new URLSearchParams(search).get("tab") ?? "overview";
  const defaultTab = (VALID_TABS as readonly string[]).includes(rawTab) ? rawTab : "overview";

  const { data: contact, isLoading } = useQuery<Contact>({
    queryKey: ["contact", contactId],
    queryFn: () => getContact(contactId),
    enabled: !isNaN(contactId),
  });
  const { data: activities = [] } = useQuery<Activity[]>({
    queryKey: ["contact-activities", contactId],
    queryFn: () => getJson(`/contacts/${contactId}/activities`),
    enabled: !isNaN(contactId),
  });
  const { data: deals = [] } = useQuery<Deal[]>({
    queryKey: ["deals", { contactId }],
    queryFn: () => getJson(`/deals?contactId=${contactId}`),
    enabled: !isNaN(contactId),
  });
  const { data: notes = [] } = useQuery<Note[]>({
    queryKey: ["contact-notes", contactId],
    queryFn: () => getJson(`/contacts/${contactId}/notes`),
    enabled: !isNaN(contactId),
  });
  const { data: thresholds = [] } = useQuery<Threshold[]>({
    queryKey: ["score-thresholds"],
    queryFn: () => getJson("/score-thresholds"),
  });
  const { data: timeline } = useQuery({
    queryKey: ["contact-timeline", contactId],
    queryFn: () => getJson(`/contacts/${contactId}/timeline`),
    enabled: !isNaN(contactId),
  });
  const { data: stageHistory = [] } = useQuery<StageHistoryEntry[]>({
    queryKey: ["contact-stage-history", contactId],
    queryFn: () => getJson(`/contacts/${contactId}/stage-history`),
    enabled: !isNaN(contactId),
  });
  const { data: scoreHistory = [] } = useQuery<ScoreHistoryEntry[]>({
    queryKey: ["contact-score-history", contactId],
    queryFn: () => getJson(`/contacts/${contactId}/score-history`),
    enabled: !isNaN(contactId),
  });
  const { data: contestEvents = [] } = useQuery<ContestEvent[]>({
    queryKey: ["contact-contest-events", contactId],
    queryFn: () => getJson(`/contacts/${contactId}/contest-events`),
    enabled: !isNaN(contactId),
  });

  const { data: clients = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["clients"],
    queryFn: () => getJson("/clients"),
    enabled: reassignOpen,
  });
  const { data: companies = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["companies-list"],
    queryFn: () => getJson("/companies"),
    enabled: editOpen,
  });
  const [editCompanyId, setEditCompanyId] = useState<string>("");

  const reassignClient = useMutation({
    mutationFn: async (clientId: number | null) => {
      const r = await api(`/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      if (!r.ok) throw new Error("Failed to update contact");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", contactId] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast({ title: "Client updated" });
      setReassignOpen(false);
    },
    onError: () => toast({ title: "Failed to update client", variant: "destructive" }),
  });
  const { data: submissions = [] } = useQuery<FormSubmission[]>({
    queryKey: ["contact-submissions", contactId],
    queryFn: () => getJson(`/contacts/${contactId}/submissions`),
    enabled: !isNaN(contactId),
  });
  const { data: contactPlays = [] } = useQuery<ContactPlay[]>({
    queryKey: ["contact-plays", contactId],
    queryFn: () => getJson(`/contacts/${contactId}/plays`),
    enabled: !isNaN(contactId),
  });
  const { data: contactJourneys = [] } = useQuery<ContactJourney[]>({
    queryKey: ["contact-journeys", contactId],
    queryFn: () => getJson(`/contacts/${contactId}/journeys`),
    enabled: !isNaN(contactId),
  });
  const { data: contactSequences = [] } = useQuery<ContactSequenceEnrollment[]>({
    queryKey: ["contact-sequences", contactId],
    queryFn: () => getJson(`/contacts/${contactId}/sequences`),
    enabled: !isNaN(contactId),
  });
  const { data: allJourneys = [] } = useQuery<{ id: number; name: string; status: string }[]>({
    queryKey: ["journeys"],
    queryFn: () => getJson("/journeys"),
    enabled: journeyPickerOpen,
  });
  const { data: allSequences = [] } = useQuery<{ id: number; name: string; status: string }[]>({
    queryKey: ["email-sequences"],
    queryFn: () => getJson("/email-sequences"),
    enabled: sequencePickerOpen,
  });
  const { data: allPlays = [] } = useQuery<{ id: number; name: string; status: string; clientId: number | null }[]>({
    queryKey: ["plays"],
    queryFn: () => getJson("/plays"),
    enabled: playPickerOpen,
  });
  const [expandedSubmission, setExpandedSubmission] = useState<number | null>(null);

  const addNote = useMutation({
    mutationFn: () => api(`/contacts/${contactId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: noteBody }),
    }).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact-notes", contactId] });
      setNoteBody("");
      toast({ title: "Note added" });
    },
    onError: () => toast({ title: "Failed to add note", variant: "destructive" }),
  });

  const deleteNote = useMutation({
    mutationFn: (noteId: number) => api(`/contacts/${contactId}/notes/${noteId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contact-notes", contactId] }),
  });

  const deleteContactMutation = useMutation({
    mutationFn: async () => {
      const response=await api(`/contacts/${contactId}`, { method: "DELETE" });
      if(!response.ok)throw new Error((await response.json().catch(()=>null))?.error??"Contact deletion failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["intent"] });
      navigate("/crm/contacts");
      toast({ title: "Contact deleted" });
    },
    onError: (error:Error) => toast({ title: "Failed to delete contact", description:error.message, variant: "destructive" }),
  });

  const updateContact = useMutation({
    mutationFn: (data: Record<string, unknown>) => api(`/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).then(r => { if (!r.ok) throw new Error("Failed to update"); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", contactId] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast({ title: "Contact updated" });
      setEditOpen(false);
    },
    onError: () => toast({ title: "Failed to update contact", variant: "destructive" }),
  });

  const toggleDnc = useMutation({
    mutationFn: (dnc: boolean) => api(`/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dnc }),
    }).then(r => { if (!r.ok) throw new Error("Failed"); return r.json(); }),
    onSuccess: (_, dnc) => {
      qc.invalidateQueries({ queryKey: ["contact", contactId] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast({ title: dnc ? "Marked as DNC — contact won't be emailed or called." : "DNC removed — contact can be reached again." });
    },
    onError: () => toast({ title: "Failed to update DNC status", variant: "destructive" }),
  });

  const enrollInPlay = useMutation({
    mutationFn: (playId: number) =>
      api(`/plays/${playId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds: [contactId] }),
      }).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact-plays", contactId] });
      qc.invalidateQueries({ queryKey: ["contact", contactId] });
      toast({ title: "Enrolled in play" });
      setPlayPickerOpen(false);
      setSelectedEnrollPlayId("");
    },
    onError: () => toast({ title: "Failed to enroll in play", variant: "destructive" }),
  });

  const enrollInJourney = useMutation({
    mutationFn: (journeyId: number) =>
      api(`/journeys/${journeyId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds: [contactId] }),
      }).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact-journeys", contactId] });
      toast({ title: "Added to journey" });
      setJourneyPickerOpen(false);
      setSelectedEnrollJourneyId("");
    },
    onError: () => toast({ title: "Failed to add to journey", variant: "destructive" }),
  });

  const reEnrollInSequence = useMutation({
    mutationFn: (enrollmentId: number) =>
      api(`/contacts/${contactId}/sequences/${enrollmentId}/re-enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }).then(async r => { if (!r.ok) { const body = await r.json().catch(() => ({})); throw new Error((body as any).error ?? "Failed to re-enroll"); } return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact-sequences", contactId] });
      toast({ title: "Re-enrolled in sequence", description: "The contact has been sent through the sequence from the start." });
      setReEnrollTarget(null);
    },
    onError: (err: Error) => toast({ title: "Failed to re-enroll", description: err.message, variant: "destructive" }),
  });

  const enrollInSequence = useMutation({
    mutationFn: (sequenceId: number) =>
      api(`/email-sequences/${sequenceId}/bulk-enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds: [contactId] }),
      }).then(r => { if (!r.ok) throw new Error("Failed to enroll in sequence"); return r.json(); }),
    onSuccess: (result: { enrolled: number; alreadyActive?: number; skippedCompleted?: number; alreadyEnrolled?: number; skippedDnc?: number }) => {
      if ((result.skippedDnc ?? 0) > 0 && (result.enrolled ?? 0) === 0) {
        toast({ title: "This contact is on the DNC list", description: "Remove the DNC flag before enrolling them in a sequence.", variant: "destructive" });
        return;
      }
      if ((result.alreadyActive ?? 0) > 0) {
        toast({ title: "Already enrolled", description: "This contact is currently active in this sequence.", variant: "destructive" });
        return;
      }
      if ((result.skippedCompleted ?? 0) > 0) {
        toast({ title: "Already completed", description: "This contact already finished this sequence. Use the bulk-enroll option with 'Re-enroll completed contacts' to restart them.", variant: "destructive" });
        return;
      }
      qc.invalidateQueries({ queryKey: ["contact-sequences", contactId] });
      toast({ title: "Enrolled in sequence" });
      setSequencePickerOpen(false);
      setSelectedEnrollSequenceId("");
    },
    onError: () => toast({ title: "Failed to enroll in sequence", variant: "destructive" }),
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!contact) {
    return <div className="p-6 text-muted-foreground">Contact not found.</div>;
  }

  const initials = `${contact.firstName?.[0] ?? ""}${contact.lastName?.[0] ?? ""}`.toUpperCase() || (contact.email?.[0]?.toUpperCase() ?? "?");
  const contactStage = contact.stage ?? "pre-aware";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4 shrink-0">
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/crm/contacts")} className="mt-0.5 shrink-0">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="w-12 h-12 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-lg font-bold shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-semibold tracking-tight">{contact.firstName} {contact.lastName}</h1>
              <ScoreBadge score={contact.leadScore} thresholds={thresholds} showLabel />
              <StageBadge stage={contactStage} />
              <Badge variant={contact.status === "active" ? "default" : "secondary"} className="text-xs capitalize">
                {contact.status}
              </Badge>
              {contact.dnc && (
                <Badge variant="outline" className="text-[11px] px-2 py-0.5 bg-red-50 text-red-700 border-red-200 font-semibold flex items-center gap-1">
                  <PhoneOff className="w-3 h-3" />DNC
                </Badge>
              )}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-violet-100 text-violet-700">
                <ClipboardList className="w-3 h-3" />
                {submissions.length} form{submissions.length !== 1 ? "s" : ""}
              </span>
              <div className="ml-auto shrink-0 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    setEditFirst(contact.firstName);
                    setEditLast(contact.lastName);
                    setEditEmail(contact.email);
                    setEditPhone(contact.phone ?? "");
                    setEditTitle(contact.title ?? "");
                    setEditStage(contact.stage ?? "pre-aware");
                    setEditStatus((contact.status as "active" | "inactive" | "unsubscribed") ?? "active");
                    setEditTags((contact.tags ?? []).join(", "));
                    setEditWebsite(contact.website ?? "");
                    setEditLinkedin(contact.linkedinUrl ?? "");
                    setEditCity(contact.city ?? "");
                    setEditCountry(contact.country ?? "");
                    setEditCompanyId(contact.companyId ? String(contact.companyId) : "");
                    setEditOpen(true);
                  }}
                >
                  <Pencil className="w-3.5 h-3.5 mr-1.5" />
                  Edit contact
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground hover:text-violet-700 hover:bg-violet-50"
                  onClick={() => setAddToSegmentOpen(true)}
                >
                  <FolderPlus className="w-3.5 h-3.5 mr-1.5" />
                  Add to segment
                </Button>
                <Button
                  variant={contact.dnc ? "outline" : "ghost"}
                  size="sm"
                  className={contact.dnc
                    ? "h-8 text-xs border-red-300 text-red-700 hover:bg-red-50"
                    : "h-8 text-xs text-muted-foreground hover:text-red-600 hover:bg-red-50"}
                  onClick={() => toggleDnc.mutate(!contact.dnc)}
                  disabled={toggleDnc.isPending}
                >
                  <PhoneOff className="w-3.5 h-3.5 mr-1.5" />
                  {contact.dnc ? "Remove DNC" : "Mark DNC"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  Delete
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground flex-wrap">
              {contact.title && <span>{contact.title}</span>}
              {contact.companyName && (
                <span className="flex items-center gap-1"><Building2 className="w-3 h-3" />{contact.companyName}</span>
              )}
              <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{contact.email}</span>
              {contact.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{contact.phone}</span>}
            </div>
            {contact.tags.length > 0 && (
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                <Tag className="w-3 h-3 text-muted-foreground" />
                {contact.tags.map(t => <Badge key={t} variant="outline" className="text-xs py-0 px-1.5">{t}</Badge>)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue={defaultTab} className="h-full flex flex-col">
          <TabsList className="px-6 pt-0 bg-card border-b rounded-none justify-start h-auto gap-0 shrink-0">
            {[
              { value: "overview", label: "Overview", icon: Briefcase },
              { value: "timeline", label: "Stage Timeline", icon: GitBranch },
              { value: "activity", label: "Activity", icon: Activity },
              { value: "qualification", label: "Qualification & History", icon: Activity },
              { value: "deals", label: `Deals (${deals.length})`, icon: Briefcase },
              { value: "notes", label: `Notes (${notes.length})`, icon: StickyNote },
              { value: "forms", label: `Forms (${submissions.length})`, icon: ClipboardList },
              { value: "plays", label: `Plays (${contactPlays.length})`, icon: Layers },
              { value: "journeys", label: `Journeys (${contactJourneys.length})`, icon: Route },
              { value: "sequences", label: `Sequences (${contactSequences.length})`, icon: Zap },
            ].map(t => (
              <TabsTrigger key={t.value} value={t.value}
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-indigo-600 data-[state=active]:text-indigo-600 data-[state=active]:shadow-none px-4 py-3 text-sm">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="qualification" className="flex-1 overflow-auto p-6 mt-0">
            <div className="max-w-4xl"><EngagementHistory key={`ct-${contactId}`} target={{ contactId }} /></div>
          </TabsContent>

          {/* Overview */}
          <TabsContent value="overview" className="flex-1 overflow-auto p-6 mt-0">
            <DemoEngagementHistory contactId={contactId} />
            {contact.gccAlternatives?.length ? <div className="mb-6">
              <GccContactAlternatives records={contact.gccAlternatives} />
            </div> : null}
            {/* Intent Engine Card */}
            {(contact.intentState || contact.intentScore != null) && (() => {
              const STATE_CONFIG: Record<string, { bg: string; border: string; text: string; icon: string }> = {
                "Decision-Action":    { bg: "bg-red-50",    border: "border-red-200",    text: "text-red-700",    icon: "🔥" },
                "Evaluating-Engage":  { bg: "bg-orange-50", border: "border-orange-200", text: "text-orange-700", icon: "🔆" },
                "Stuck-PreEngage":    { bg: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-700",  icon: "⚡" },
                "Re-engaging":        { bg: "bg-cyan-50",   border: "border-cyan-200",   text: "text-cyan-700",   icon: "🔄" },
                "Stuck-Aware":        { bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-700",   icon: "🌊" },
                "Browsing":           { bg: "bg-gray-50",   border: "border-gray-200",   text: "text-gray-600",   icon: "👀" },
                "Dormant":            { bg: "bg-slate-50",  border: "border-slate-200",  text: "text-slate-500",  icon: "❄️" },
              };
              const state = contact.intentState ?? "Browsing";
              const cfg = STATE_CONFIG[state] ?? STATE_CONFIG["Browsing"];
              const score = contact.intentScore ?? 0;
              const barPct = Math.min(100, score);
              const barColor = score >= 80 ? "bg-red-500" : score >= 50 ? "bg-orange-400" : score >= 30 ? "bg-blue-400" : "bg-slate-300";
              return (
                <div className={`mb-6 rounded-lg border ${cfg.border} ${cfg.bg} p-4`}>
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-lg">{cfg.icon}</span>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Intent Engine</p>
                      <p className={`text-sm font-bold ${cfg.text}`}>{state}</p>
                    </div>
                    <div className="ml-auto text-right">
                      <p className="text-xs text-muted-foreground">Intent Score</p>
                      <p className={`text-2xl font-black tabular-nums ${cfg.text}`}>{score}</p>
                      {contact.rawIntentScore != null && contact.rawIntentScore !== score && (
                        <p className="text-[10px] text-muted-foreground">raw: {contact.rawIntentScore}</p>
                      )}
                    </div>
                  </div>
                  <div className="h-1.5 bg-white/60 rounded-full overflow-hidden mb-3">
                    <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${barPct}%` }} />
                  </div>
                  {contact.suggestedNextAction && (
                    <p className="text-xs font-medium text-muted-foreground">
                      <span className="font-semibold text-foreground">Suggested action: </span>
                      {contact.suggestedNextAction}
                    </p>
                  )}
                  {/* ── Score formula breakdown ── */}
                  <ScoreBreakdown contact={contact} textColor={cfg.text} />
                  {/* ── Score trend sparkline ── */}
                  {scoreHistory.length >= 2 && (
                    <ScoreTrendSparkline history={scoreHistory} currentScore={score} />
                  )}
                </div>
              );
            })()}

            {/* ── Contest Entry highlight card ── */}
            {(() => {
              const entry = contestEvents.find(e => e.eventType === "entry_submitted");
              if (!entry) return null;
              const propLines = formatContestProps(entry.props);
              return (
                <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 max-w-2xl">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-lg">🏆</span>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Contest Entry</p>
                      <p className="text-sm font-bold text-amber-800">Entry submitted</p>
                    </div>
                    <p className="ml-auto text-xs text-muted-foreground">{timeAgo(entry.createdAt)}</p>
                  </div>
                  {propLines.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {propLines.map(line => (
                        <li key={line} className="text-sm text-amber-900 flex items-start gap-1.5">
                          <span className="mt-0.5 text-amber-500">•</span>{line}
                        </li>
                      ))}
                    </ul>
                  )}
                  {entry.journeyName && (
                    <p className="mt-2 text-xs text-muted-foreground">Journey: {entry.journeyName}</p>
                  )}
                </div>
              );
            })()}

            {/* ── Score History ── */}
            {scoreHistory.length > 0 && (
              <ScoreHistoryPanel history={scoreHistory} currentScore={contact.intentScore ?? 0} />
            )}

            <div className="grid grid-cols-2 gap-6 max-w-2xl">
              {[
                { label: "First Name", value: contact.firstName },
                { label: "Last Name", value: contact.lastName },
                { label: "Email", value: contact.email },
                { label: "Phone", value: contact.phone ?? "—" },
                { label: "Job Title", value: contact.title ?? "—" },
                { label: "Company", value: contact.companyName ?? "—" },
                { label: "Lead Score", value: String(contact.leadScore) },
                { label: "Status", value: contact.status },
                { label: "Stage", value: CONTACT_STAGE_LABELS[contactStage] ?? contactStage },
                { label: "Source", value: contact.source ?? "—" },
                { label: "Website", value: contact.website ?? "—" },
                { label: "LinkedIn", value: contact.linkedinUrl ?? "—" },
                { label: "City", value: contact.city ?? "—" },
                { label: "Country", value: contact.country ?? "—" },
                { label: "Created", value: formatDate(contact.createdAt) },
                { label: "Last Activity", value: contact.lastActivity ? formatDate(contact.lastActivity) : "—" },
              ].map(({ label, value }) => (
                <div key={label} className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
                  <p className="text-sm text-foreground break-all">{value}</p>
                </div>
              ))}
              {/* Client — editable */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Client</p>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-foreground">{contact.clientName ?? (contact.clientId ? `Client #${contact.clientId}` : "—")}</p>
                  <button
                    onClick={() => { setPendingClientId(contact.clientId ? String(contact.clientId) : ""); setReassignOpen(true); }}
                    className="text-muted-foreground hover:text-indigo-600 transition-colors"
                    title="Reassign client"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>

            {/* Reassign Client dialog */}
            <Dialog open={reassignOpen} onOpenChange={o => !o && setReassignOpen(false)}>
              <DialogContent className="max-w-sm">
                <DialogHeader><DialogTitle>Reassign Client</DialogTitle></DialogHeader>
                <div className="py-2 space-y-2">
                  <Label className="text-sm">Select client</Label>
                  <Select value={pendingClientId} onValueChange={setPendingClientId}>
                    <SelectTrigger><SelectValue placeholder="— None —" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— None —</SelectItem>
                      {clients.map(c => (
                        <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setReassignOpen(false)}>Cancel</Button>
                  <Button
                    className="bg-indigo-600 hover:bg-indigo-700"
                    disabled={reassignClient.isPending}
                    onClick={() => {
                      const cid = pendingClientId && pendingClientId !== "none" ? parseInt(pendingClientId) : null;
                      reassignClient.mutate(cid);
                    }}
                  >
                    {reassignClient.isPending ? "Saving…" : "Save"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* Edit Contact dialog */}
            <Dialog open={editOpen} onOpenChange={o => !o && setEditOpen(false)}>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Edit contact</DialogTitle>
                  <DialogDescription>Update contact details and profile information.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-1">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">First name</Label>
                      <Input value={editFirst} onChange={e => setEditFirst(e.target.value)} className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Last name</Label>
                      <Input value={editLast} onChange={e => setEditLast(e.target.value)} className="h-8 text-sm" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Email</Label>
                    <Input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} className="h-8 text-sm" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Phone</Label>
                      <Input value={editPhone} onChange={e => setEditPhone(e.target.value)} className="h-8 text-sm" placeholder="+1 555 000 0000" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Job title</Label>
                      <Input value={editTitle} onChange={e => setEditTitle(e.target.value)} className="h-8 text-sm" placeholder="VP Marketing" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Company</Label>
                    <Select value={editCompanyId} onValueChange={setEditCompanyId}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="— No company —" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— No company —</SelectItem>
                        {companies.map(c => (
                          <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Stage</Label>
                      <Select value={editStage} onValueChange={setEditStage}>
                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(CONTACT_STAGE_LABELS).map(([v, l]) => (
                            <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Status</Label>
                      <Select value={editStatus} onValueChange={v => setEditStatus(v as "active" | "inactive" | "unsubscribed")}>
                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active" className="text-xs">Active</SelectItem>
                          <SelectItem value="inactive" className="text-xs">Inactive</SelectItem>
                          <SelectItem value="unsubscribed" className="text-xs">Unsubscribed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Tags <span className="text-muted-foreground font-normal">(comma-separated)</span></Label>
                    <Input value={editTags} onChange={e => setEditTags(e.target.value)} className="h-8 text-sm" placeholder="enterprise, vip, nurture" />
                  </div>
                  <div className="border-t pt-3 space-y-3">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Online presence</p>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">LinkedIn URL</Label>
                      <Input value={editLinkedin} onChange={e => setEditLinkedin(e.target.value)} className="h-8 text-sm" placeholder="https://linkedin.com/in/..." />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium">Website</Label>
                      <Input value={editWebsite} onChange={e => setEditWebsite(e.target.value)} className="h-8 text-sm" placeholder="https://example.com" />
                    </div>
                  </div>
                  <div className="border-t pt-3 space-y-3">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Location</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">City</Label>
                        <Input value={editCity} onChange={e => setEditCity(e.target.value)} className="h-8 text-sm" placeholder="San Francisco" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium">Country</Label>
                        <Input value={editCountry} onChange={e => setEditCountry(e.target.value)} className="h-8 text-sm" placeholder="United States" />
                      </div>
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
                  <Button
                    className="bg-indigo-600 hover:bg-indigo-700"
                    disabled={!editFirst.trim() || !editLast.trim() || !editEmail.trim() || updateContact.isPending}
                    onClick={() => {
                      const tags = editTags.split(",").map(t => t.trim()).filter(Boolean);
                      updateContact.mutate({
                        firstName: editFirst.trim(),
                        lastName: editLast.trim(),
                        email: editEmail.trim(),
                        phone: editPhone.trim() || null,
                        title: editTitle.trim() || null,
                        companyId: editCompanyId && editCompanyId !== "none" ? parseInt(editCompanyId) : null,
                        stage: editStage,
                        status: editStatus,
                        tags,
                        website: editWebsite.trim() || null,
                        linkedinUrl: editLinkedin.trim() || null,
                        city: editCity.trim() || null,
                        country: editCountry.trim() || null,
                      });
                    }}
                  >
                    {updateContact.isPending ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Saving…</> : "Save changes"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </TabsContent>

          {/* Stage Timeline */}
          <TabsContent value="timeline" className="flex-1 overflow-auto p-6 mt-0">
            <div className="max-w-2xl space-y-6">

              {/* Stage history — from contact_stage_history table */}
              <div className="rounded-lg border bg-card">
                <div className="px-4 pt-4 pb-2 flex items-center gap-2">
                  <Layers className="w-4 h-4 text-indigo-500 shrink-0" />
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Stage History</p>
                  <span className="ml-auto text-[11px] text-muted-foreground">{stageHistory.length} transition{stageHistory.length !== 1 ? "s" : ""}</span>
                </div>

                {stageHistory.length === 0 ? (
                  <div className="px-4 pb-4 text-sm text-muted-foreground">No stage transitions recorded yet</div>
                ) : (
                  <>
                    {/* Horizontal path strip */}
                    <div className="px-4 pb-3 flex items-center gap-1.5 flex-wrap">
                      {stageHistory[0].fromStage && (
                        <>
                          <StageBadge stage={stageHistory[0].fromStage} />
                          <span className="text-muted-foreground/50 text-xs">→</span>
                        </>
                      )}
                      {stageHistory.map((h, i) => (
                        <div key={h.id} className="flex items-center gap-1.5">
                          <StageBadge stage={h.toStage} />
                          {i < stageHistory.length - 1 && (
                            <span className="text-muted-foreground/50 text-xs">→</span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Detail rows */}
                    <div className="border-t divide-y">
                      {stageHistory.map((h) => (
                        <div key={h.id} className="flex items-center gap-3 px-4 py-3">
                          {/* Timeline dot */}
                          <div
                            className="w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-background"
                            style={{ background: CONTACT_STAGE_DOT[h.toStage] ?? "#6366f1" }}
                          />
                          {/* Transition */}
                          <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            {h.fromStage ? (
                              <>
                                <StageBadge stage={h.fromStage} />
                                <span className="text-muted-foreground text-xs shrink-0">→</span>
                              </>
                            ) : (
                              <span className="text-[11px] text-muted-foreground italic shrink-0">Entry →</span>
                            )}
                            <StageBadge stage={h.toStage} />
                            {h.source && (
                              <span className="ml-2 text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded border border-indigo-100 truncate">
                                {h.source}
                              </span>
                            )}
                          </div>
                          {/* Score + date */}
                          <div className="shrink-0 text-right">
                            <p className="text-[11px] font-medium text-emerald-600">Score {h.scoreAtTransition}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {format(new Date(h.createdAt), "MMM d, yyyy")}
                            </p>
                            <p className="text-[10px] text-muted-foreground/70">
                              {format(new Date(h.createdAt), "h:mm a")}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Chronological timeline */}
              <div className="relative">
                <div className="absolute left-4 top-0 bottom-0 w-px bg-border" />
                <div className="space-y-0">
                  {(timeline?.timeline ?? []).map((event: any, i: number) => (
                    <div key={event.id}>
                      {/* Stage change marker */}
                      {event.isStageChange && (
                        <div className="relative pl-10 py-3">
                          <div className="absolute left-2.5 w-3 h-3 rounded-full border-2 border-background shadow-sm"
                            style={{ background: CONTACT_STAGE_DOT[event.toStage] ?? "#6366f1", top: "50%", transform: "translateY(-50%)" }} />
                          <div className="flex flex-col gap-1 bg-muted/50 rounded-lg px-3 py-2 border">
                            <div className="flex items-center gap-2">
                              <GitBranch className="w-3 h-3 text-muted-foreground shrink-0" />
                              <span className="text-xs text-muted-foreground">Stage advanced:</span>
                              {event.fromStage && <StageBadge stage={event.fromStage} />}
                              <span className="text-xs text-muted-foreground">→</span>
                              <StageBadge stage={event.toStage} />
                              <span className="text-xs text-muted-foreground ml-auto">Score: {event.cumulativeScore ?? 0}</span>
                            </div>
                            {event.triggerEventType && (
                              <p className="text-[10px] text-muted-foreground pl-5">
                                Triggered by:{" "}
                                <span className="font-medium text-foreground/70">
                                  {TRIGGER_EVENT_LABELS[event.triggerEventType] ?? event.triggerEventType}
                                  {event.triggerPageName ? ` — ${event.triggerPageName}` : ""}
                                </span>
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                      {/* Activity event — hidden for pure stage-advance synthetic entries */}
                      {!event.isPureStageChange && <div className="relative flex items-start gap-3 pl-10 py-2">
                        <div className="absolute left-2 w-4 h-4 rounded-full bg-card border-2 border-border flex items-center justify-center text-[10px]"
                          style={{ top: "8px" }}>
                          {event.eventType === "auto_journey_assigned"
                            ? <Route className="w-2.5 h-2.5 text-indigo-500" />
                            : (EVENT_ICONS[event.eventType] ?? "•")}
                        </div>
                        <div className="flex-1 min-w-0">
                          {event.eventType === "auto_journey_assigned" ? (
                            <div>
                              <p className="text-sm text-foreground">
                                Auto-enrolled into journey{" "}
                                {event.journeyId ? (
                                  <a
                                    href={`/journeys/${event.journeyId}`}
                                    className="font-medium text-indigo-600 hover:underline"
                                    onClick={e => { e.preventDefault(); navigate(`/journeys/${event.journeyId}`); }}
                                  >
                                    {event.journeyName ?? `Journey #${event.journeyId}`}
                                  </a>
                                ) : (
                                  <span className="font-medium">{event.journeyName ?? "unknown journey"}</span>
                                )}
                              </p>
                              {(() => {
                                const ruleName = extractRuleName(event.description ?? "");
                                return ruleName ? (
                                  <p className="text-[11px] text-muted-foreground mt-0.5">
                                    Matched rule: <span className="font-medium text-foreground/70">{ruleName}</span>
                                  </p>
                                ) : null;
                              })()}
                            </div>
                          ) : event.eventType === "sequence_enrolled" ? (
                            <div>
                              <p className="text-sm text-foreground">
                                {extractRuleName(event.description ?? "") ? "Auto-enrolled into sequence" : "Enrolled into sequence"}{" "}
                                {event.sequenceId ? (
                                  <a
                                    href={`/sequences/${event.sequenceId}`}
                                    className="font-medium text-indigo-600 hover:underline"
                                    onClick={e => { e.preventDefault(); navigate(`/sequences/${event.sequenceId}`); }}
                                  >
                                    {event.sequenceName ?? `Sequence #${event.sequenceId}`}
                                  </a>
                                ) : (
                                  <span className="font-medium">{event.description}</span>
                                )}
                              </p>
                              {(() => {
                                const ruleName = extractRuleName(event.description ?? "");
                                return ruleName ? (
                                  <p className="text-[11px] text-muted-foreground mt-0.5">
                                    Matched rule: <span className="font-medium text-foreground/70">{ruleName}</span>
                                  </p>
                                ) : null;
                              })()}
                            </div>
                          ) : event.eventType === "sequence_enrollment_skipped" ? (
                            <div>
                              <p className="text-sm text-foreground">
                                Sequence enrollment skipped{" "}
                                {event.sequenceId ? (
                                  <a
                                    href={`/sequences/${event.sequenceId}`}
                                    className="font-medium text-indigo-600 hover:underline"
                                    onClick={e => { e.preventDefault(); navigate(`/sequences/${event.sequenceId}`); }}
                                  >
                                    {event.sequenceName ?? `Sequence #${event.sequenceId}`}
                                  </a>
                                ) : event.sequenceName ? (
                                  <span className="font-medium">{event.sequenceName}</span>
                                ) : null}
                              </p>
                              <p className="mt-0.5">
                                {(event.description ?? "").includes("DNC") ? (
                                  <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-red-100 text-red-700">
                                    DNC — contact opted out
                                  </span>
                                ) : (
                                  <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
                                    Already completed
                                  </span>
                                )}
                              </p>
                            </div>
                          ) : (
                            <div>
                              <p className="text-sm text-foreground">{event.description}</p>
                              {event.eventType === "email_sent" && event.metadata?.smtpAccountName && (
                                <p className="text-[11px] text-indigo-600 mt-0.5">
                                  Sent via {String(event.metadata.smtpAccountName)}
                                </p>
                              )}
                            </div>
                          )}
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="text-[11px] text-muted-foreground">{timeAgo(event.createdAt)}</span>
                            {event.pageName && <span className="text-[11px] bg-muted px-1.5 py-0.5 rounded">{event.pageName}</span>}
                            {event.source && (
                              <span className={cn("text-[11px]", event.source === "email" ? "text-indigo-600" : "text-muted-foreground")}>
                                via {event.source}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          {event.scoreDelta > 0 && (
                            <span className="text-xs font-medium text-emerald-600">+{event.scoreDelta}</span>
                          )}
                          <p className="text-[10px] text-muted-foreground">score {event.cumulativeScore ?? 0}</p>
                        </div>
                      </div>}
                    </div>
                  ))}
                  {(timeline?.timeline ?? []).length === 0 && (
                    <div className="pl-10 py-8 text-center text-sm text-muted-foreground">No timeline events yet</div>
                  )}
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Activity */}
          <TabsContent value="activity" className="flex-1 overflow-auto p-6 mt-0">
            {/* Call Intelligence section */}
            {timeline?.callLogs && timeline.callLogs.length > 0 && (
              <div className="mb-6 max-w-2xl">
                <div className="flex items-center gap-2 mb-3">
                  <PhoneCall className="w-4 h-4 text-indigo-600" />
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Call Intelligence <span className="normal-case font-normal">({timeline.callLogs.length} call{timeline.callLogs.length !== 1 ? "s" : ""})</span>
                  </p>
                </div>
                <div className="space-y-2">
                  {(timeline.callLogs as any[]).map((call: any) => (
                    <ContactCallRow key={call.id} call={call} />
                  ))}
                </div>
              </div>
            )}

            {/* Intent Score over Time chart */}
            {(() => {
              const cutoff = subDays(new Date(), 60);
              const rawTimeline: any[] = timeline?.timeline ?? [];
              const filtered = [...rawTimeline]
                .reverse()
                .filter((e: any) => new Date(e.createdAt) >= cutoff);

              if (filtered.length === 0) return null;

              const step = Math.max(1, Math.ceil(filtered.length / 30));
              const sampled: any[] = [];
              for (let i = 0; i < filtered.length; i += step) {
                sampled.push(filtered[i]);
              }
              // Ensure the most recent event is always the last point, without exceeding 30
              const last = filtered[filtered.length - 1];
              if (sampled[sampled.length - 1] !== last) {
                sampled[sampled.length - 1] = last;
              }
              const cappedSampled = sampled.slice(0, 30);

              const chartData = cappedSampled.map((e: any) => ({
                date: format(new Date(e.createdAt), "MMM d"),
                fullDate: format(new Date(e.createdAt), "MMM d, yyyy"),
                score: e.cumulativeScore,
              }));

              const minScore = Math.min(...chartData.map(d => d.score));
              const maxScore = Math.max(...chartData.map(d => d.score));
              const yMin = Math.max(0, minScore - 5);
              const yMax = maxScore + 5;

              return (
                <div className="mb-6 max-w-2xl rounded-lg border bg-card p-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                    Intent Score over Time <span className="normal-case font-normal">(last 60 days)</span>
                  </p>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        domain={[yMin, yMax]}
                        tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                        tickLine={false}
                        axisLine={false}
                        width={36}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "6px",
                          fontSize: "12px",
                        }}
                        formatter={(val: number) => [val, "Intent Score"]}
                        labelFormatter={(label, payload) => payload?.[0]?.payload?.fullDate ?? label}
                      />
                      <Line
                        type="monotone"
                        dataKey="score"
                        stroke="#6366f1"
                        strokeWidth={2}
                        dot={chartData.length <= 10 ? { r: 3, fill: "#6366f1", strokeWidth: 0 } : false}
                        activeDot={{ r: 4, fill: "#6366f1", strokeWidth: 0 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              );
            })()}

            {/* Contest Events section */}
            {contestEvents.length > 0 && (
              <div className="mb-6 max-w-2xl">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-base">🏆</span>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Contest Activity <span className="normal-case font-normal">({contestEvents.length} event{contestEvents.length !== 1 ? "s" : ""})</span>
                  </p>
                </div>
                <div className="space-y-3">
                  {contestEvents.map(ce => {
                    const propLines = formatContestProps(ce.props);
                    return (
                      <div key={ce.id} className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-base shrink-0">
                          {EVENT_ICONS[ce.eventType] ?? "🎪"}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {CONTEST_EVENT_LABELS[ce.eventType] ?? ce.eventType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                          </p>
                          {propLines.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {propLines.map(line => (
                                <li key={line} className="text-xs text-muted-foreground">{line}</li>
                              ))}
                            </ul>
                          )}
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="text-xs text-muted-foreground">{timeAgo(ce.createdAt)}</span>
                            {ce.journeyName && (
                              <span className="text-[11px] bg-amber-50 border border-amber-200 text-amber-700 px-1.5 py-0.5 rounded">
                                {ce.journeyName}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activities.length === 0 && contestEvents.length === 0 ? (
              <div className="text-center text-muted-foreground text-sm py-12">No activity recorded yet</div>
            ) : activities.length === 0 ? null : (
              <div className="space-y-3 max-w-2xl">
                {activities.map(a => {
                  const isSkipped = a.eventType === "sequence_enrollment_skipped";
                  const isDnc = isSkipped && (a.description ?? "").includes("DNC");
                  return (
                  <div key={a.id} className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-base shrink-0">
                      {EVENT_ICONS[a.eventType] ?? "•"}
                    </div>
                    <div className="flex-1 min-w-0">
                      {isSkipped ? (
                        <div>
                          <p className="text-sm text-foreground">
                            Sequence enrollment skipped{" "}
                            {a.sequenceId ? (
                              <a
                                href={`/sequences/${a.sequenceId}`}
                                className="font-medium text-indigo-600 hover:underline"
                                onClick={e => { e.preventDefault(); navigate(`/sequences/${a.sequenceId}`); }}
                              >
                                {a.sequenceName ?? `Sequence #${a.sequenceId}`}
                              </a>
                            ) : a.sequenceName ? (
                              <span className="font-medium">{a.sequenceName}</span>
                            ) : null}
                          </p>
                          <p className="mt-0.5">
                            <span className={cn(
                              "text-[11px] px-1.5 py-0.5 rounded-full font-medium",
                              isDnc ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
                            )}>
                              {isDnc ? "DNC — contact opted out" : "Already completed"}
                            </span>
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm text-foreground">{a.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-xs text-muted-foreground">{timeAgo(a.createdAt)}</span>
                        {(a as any).pageName && <span className="text-[11px] bg-muted px-1.5 py-0.5 rounded">{(a as any).pageName}</span>}
                        {(a as any).stage && <StageBadge stage={(a as any).stage} />}
                        {a.pointsEarned != null && (
                          <span className={cn("text-xs font-medium", a.pointsEarned >= 0 ? "text-green-600" : "text-red-500")}>
                            {a.pointsEarned >= 0 ? "+" : ""}{a.pointsEarned} pts
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* Deals */}
          <TabsContent value="deals" className="flex-1 overflow-auto p-6 mt-0">
            {deals.length === 0 ? (
              <div className="text-center text-muted-foreground text-sm py-12">No deals linked to this contact</div>
            ) : (
              <div className="border rounded-lg overflow-hidden bg-card max-w-2xl">
                <table className="w-full">
                  <thead>
                    <tr className="bg-muted/50 border-b">
                      <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Deal</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Stage</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Value</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Close Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deals.map(d => (
                      <tr key={d.id} className="border-b last:border-0">
                        <td className="py-2.5 px-4 text-sm font-medium">{d.title}</td>
                        <td className="py-2.5 px-4">
                          <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", DEAL_STAGE_COLORS[d.stage])}>
                            {DEAL_STAGE_LABELS[d.stage] ?? d.stage}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-sm">
                          {d.value != null ? formatAmount(d.value, d.currency) : "—"}
                          {d.value != null && <div className="text-xs font-normal text-muted-foreground">{MEANING_LABEL[d.valueMeaning ?? "unknown"]}</div>}
                          {d.bookedValue != null && <div className="text-xs font-normal text-muted-foreground">Booked: {formatAmount(d.bookedValue, d.currency)}</div>}
                        </td>
                        <td className="py-2.5 px-4 text-sm text-muted-foreground">
                          {d.expectedCloseDate ? formatDate(d.expectedCloseDate) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          {/* Notes */}
          <TabsContent value="notes" className="flex-1 overflow-auto p-6 mt-0">
            <div className="max-w-2xl space-y-4">
              <div className="flex gap-2">
                <Textarea
                  value={noteBody}
                  onChange={e => setNoteBody(e.target.value)}
                  placeholder="Add a note..."
                  className="min-h-[80px] text-sm resize-none"
                />
                <Button
                  onClick={() => addNote.mutate()}
                  disabled={!noteBody.trim() || addNote.isPending}
                  className="bg-indigo-600 hover:bg-indigo-700 shrink-0 self-end"
                  size="sm"
                >
                  <Send className="w-3.5 h-3.5" />
                </Button>
              </div>
              {notes.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-8">No notes yet</div>
              ) : (
                <div className="space-y-3">
                  {notes.map(n => (
                    <div key={n.id} className="bg-card border rounded-lg p-4 group relative">
                      <p className="text-sm text-foreground whitespace-pre-wrap">{n.body}</p>
                      <p className="text-xs text-muted-foreground mt-2">{timeAgo(n.createdAt)}</p>
                      <Button
                        size="icon" variant="ghost"
                        className="absolute top-2 right-2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                        onClick={() => deleteNote.mutate(n.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {/* Forms */}
          <TabsContent value="forms" className="flex-1 overflow-auto p-6 mt-0">
            <div className="max-w-2xl space-y-3">
              {submissions.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-12">No form submissions yet</div>
              ) : (
                submissions.map(sub => {
                  const isOpen = expandedSubmission === sub.id;
                  const fieldEntries = Object.entries(sub.field_values ?? {}).filter(
                    ([k]) => !["_token", "_journeyId", "_pageId"].includes(k)
                  );
                  return (
                    <div key={sub.id} className="bg-card border rounded-lg overflow-hidden">
                      <button
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                        onClick={() => setExpandedSubmission(isOpen ? null : sub.id)}
                      >
                        <div className="w-8 h-8 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center shrink-0">
                          <ClipboardList className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {sub.form_name ?? "Untitled Form"}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="text-xs text-muted-foreground">{timeAgo(sub.submitted_at)}</span>
                            <span className="text-xs text-muted-foreground">·</span>
                            <span className="text-xs text-muted-foreground">{format(new Date(sub.submitted_at), "MMM d, yyyy 'at' h:mm a")}</span>
                            {sub.journey_name && (
                              <>
                                <span className="text-xs text-muted-foreground">·</span>
                                <span className="text-xs bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded font-medium">
                                  {sub.journey_name}
                                </span>
                              </>
                            )}
                            {fieldEntries.length > 0 && (
                              <span className="text-xs text-muted-foreground ml-auto">
                                {fieldEntries.length} field{fieldEntries.length !== 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="shrink-0 text-muted-foreground">
                          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </div>
                      </button>

                      {isOpen && (
                        <div className="border-t bg-muted/30 px-4 py-3 space-y-3">
                          {Object.keys(sub.field_values ?? {}).length === 0 ? (
                            <p className="text-xs text-muted-foreground italic">No field data recorded</p>
                          ) : (
                            <>
                              <div className="space-y-2">
                                {fieldEntries.map(([key, value]) => (
                                  <div key={key} className="flex gap-3">
                                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide w-32 shrink-0 pt-0.5">
                                      {key.replace(/_/g, " ")}
                                    </span>
                                    <span className="text-sm text-foreground break-words flex-1">
                                      {typeof value === "boolean"
                                        ? (value ? "Yes" : "No")
                                        : value === null || value === undefined || value === ""
                                        ? <span className="text-muted-foreground italic">—</span>
                                        : typeof value === "object"
                                        ? <code className="text-xs bg-muted px-1 py-0.5 rounded">{JSON.stringify(value)}</code>
                                        : String(value)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                              <details className="group">
                                <summary className="text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors list-none flex items-center gap-1">
                                  <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />
                                  Raw JSON
                                </summary>
                                <pre className="mt-2 text-xs bg-muted rounded p-3 overflow-x-auto text-foreground leading-relaxed">
                                  {JSON.stringify(sub.field_values, null, 2)}
                                </pre>
                              </details>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </TabsContent>

          {/* Plays */}
          <TabsContent value="plays" className="flex-1 overflow-auto p-6 mt-0">
            <div className="max-w-2xl">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-muted-foreground">{contactPlays.length} play{contactPlays.length !== 1 ? "s" : ""}</p>
                <UITooltip>
                  <UITooltipTrigger asChild>
                    <span tabIndex={contact.dnc ? 0 : -1} className={contact.dnc ? "cursor-not-allowed" : ""}>
                      <Button size="sm" variant="outline" onClick={() => setPlayPickerOpen(true)} disabled={contact.dnc}>
                        <Plus className="w-3.5 h-3.5 mr-1.5" /> Enroll in play
                      </Button>
                    </span>
                  </UITooltipTrigger>
                  {contact.dnc && (
                    <UITooltipContent side="left" className="max-w-52 text-center">
                      Contact is on the DNC list — remove the DNC flag to enroll in a play
                    </UITooltipContent>
                  )}
                </UITooltip>
              </div>
              {contactPlays.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-12">This contact is not enrolled in any plays</div>
              ) : (
                <div className="border rounded-lg overflow-hidden bg-card">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Play</th>
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Status</th>
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Client</th>
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Enrolled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contactPlays.map(p => (
                        <tr key={p.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                          <td className="py-2.5 px-4">
                            <a
                              href={`/plays/${p.id}`}
                              className="text-sm font-medium text-indigo-600 hover:underline"
                              onClick={e => { e.preventDefault(); navigate(`/plays/${p.id}`); }}
                            >
                              {p.name}
                            </a>
                          </td>
                          <td className="py-2.5 px-4">
                            <span className={cn(
                              "text-xs px-2 py-0.5 rounded-full font-medium capitalize",
                              p.status === "active" ? "bg-emerald-100 text-emerald-700"
                              : p.status === "paused" ? "bg-amber-100 text-amber-700"
                              : "bg-gray-100 text-gray-600"
                            )}>
                              {p.status}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-sm text-muted-foreground">
                            {p.clientName ?? "—"}
                          </td>
                          <td className="py-2.5 px-4 text-sm text-muted-foreground">
                            {formatDate(p.enrolledAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </TabsContent>

          {/* Journeys */}
          <TabsContent value="journeys" className="flex-1 overflow-auto p-6 mt-0">
            <div className="max-w-2xl">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-muted-foreground">{contactJourneys.length} journey{contactJourneys.length !== 1 ? "s" : ""}</p>
                <UITooltip>
                  <UITooltipTrigger asChild>
                    <span tabIndex={contact.dnc ? 0 : -1} className={contact.dnc ? "cursor-not-allowed" : ""}>
                      <Button size="sm" variant="outline" onClick={() => setJourneyPickerOpen(true)} disabled={contact.dnc}>
                        <Plus className="w-3.5 h-3.5 mr-1.5" /> Add to journey
                      </Button>
                    </span>
                  </UITooltipTrigger>
                  {contact.dnc && (
                    <UITooltipContent side="left" className="max-w-52 text-center">
                      Contact is on the DNC list — remove the DNC flag to add to a journey
                    </UITooltipContent>
                  )}
                </UITooltip>
              </div>
              {contactJourneys.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-12">This contact has not been added to any journeys</div>
              ) : (
                <div className="border rounded-lg overflow-hidden bg-card">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Journey</th>
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Status</th>
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Added</th>
                        <th className="py-2 px-4 w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {contactJourneys.map(j => (
                        <tr key={j.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                          <td className="py-2.5 px-4 text-sm font-medium">{j.name}</td>
                          <td className="py-2.5 px-4">
                            <span className={cn(
                              "text-xs px-2 py-0.5 rounded-full font-medium capitalize",
                              j.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600"
                            )}>
                              {j.status}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-sm text-muted-foreground">
                            {j.assignedAt ? formatDate(j.assignedAt) : "—"}
                          </td>
                          <td className="py-2.5 px-4">
                            {j.slug && (
                              <a
                                href={`/j/${j.slug}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-muted-foreground hover:text-indigo-600 transition-colors"
                                title="Open journey"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </TabsContent>

          {/* Sequences */}
          <TabsContent value="sequences" className="flex-1 overflow-auto p-6 mt-0">
            <div className="max-w-2xl">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-muted-foreground">{contactSequences.length} sequence enrollment{contactSequences.length !== 1 ? "s" : ""}</p>
                <UITooltip>
                  <UITooltipTrigger asChild>
                    <span tabIndex={contact.dnc ? 0 : -1} className={contact.dnc ? "cursor-not-allowed" : ""}>
                      <Button size="sm" variant="outline" onClick={() => setSequencePickerOpen(true)} disabled={contact.dnc}>
                        <Plus className="w-3.5 h-3.5 mr-1.5" /> Enroll in sequence
                      </Button>
                    </span>
                  </UITooltipTrigger>
                  {contact.dnc && (
                    <UITooltipContent side="left" className="max-w-52 text-center">
                      Contact is on the DNC list — remove the DNC flag to enroll in a sequence
                    </UITooltipContent>
                  )}
                </UITooltip>
              </div>
              {contactSequences.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-12">This contact is not enrolled in any sequences</div>
              ) : (
                <div className="border rounded-lg overflow-hidden bg-card">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Sequence</th>
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Status</th>
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Enrolled</th>
                        <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Completed</th>
                        <th className="py-2 px-4"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {contactSequences.map(se => (
                        <tr key={se.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                          <td className="py-2.5 px-4 text-sm font-medium">{se.sequenceName}</td>
                          <td className="py-2.5 px-4">
                            {se.status === "completed" ? (
                              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium capitalize bg-blue-100 text-blue-700">
                                Completed
                              </span>
                            ) : (
                              <span className={cn(
                                "text-xs px-2 py-0.5 rounded-full font-medium capitalize",
                                se.status === "active" ? "bg-emerald-100 text-emerald-700"
                                : se.status === "paused" ? "bg-amber-100 text-amber-700"
                                : "bg-gray-100 text-gray-600"
                              )}>
                                {se.status}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-4 text-sm text-muted-foreground">
                            {formatDate(se.enrolledAt)}
                          </td>
                          <td className="py-2.5 px-4 text-sm text-muted-foreground">
                            {se.completedAt ? formatDate(se.completedAt) : "—"}
                          </td>
                          <td className="py-2.5 px-4">
                            {se.status === "completed" && isAdmin && !contact.dnc && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 text-xs px-2"
                                onClick={() => setReEnrollTarget(se)}
                              >
                                Re-enroll
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Re-enroll confirmation */}
      <Dialog open={!!reEnrollTarget} onOpenChange={open => { if (!open) setReEnrollTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Re-enroll in sequence?</DialogTitle>
            <DialogDescription>
              <strong>{contact.firstName} {contact.lastName}</strong> will be sent through <strong>{reEnrollTarget?.sequenceName}</strong> again from the start. A new enrollment row will be created and emails will begin sending based on the sequence schedule.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setReEnrollTarget(null)}>Cancel</Button>
            <Button
              disabled={reEnrollInSequence.isPending}
              onClick={() => reEnrollTarget && reEnrollInSequence.mutate(reEnrollTarget.id)}
            >
              {reEnrollInSequence.isPending ? "Re-enrolling…" : "Re-enroll"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete contact confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {contact.firstName} {contact.lastName}?</DialogTitle>
            <DialogDescription>
              This permanently removes this contact, their inbound responses, activities, notes, and enrollments. Other contacts and account responses remain. This cannot be undone; later imports may recreate the contact.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteContactMutation.isPending}
              onClick={() => deleteContactMutation.mutate()}
            >
              {deleteContactMutation.isPending ? "Deleting…" : "Delete contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Enroll in Play picker */}
      <Dialog open={playPickerOpen} onOpenChange={o => { setPlayPickerOpen(o); if (!o) setSelectedEnrollPlayId(""); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Enroll in a play</DialogTitle>
            <DialogDescription>Select a play to enroll this contact in. Only plays from the same client are shown.</DialogDescription>
          </DialogHeader>
          {contact?.dnc && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
              <PhoneOff className="w-4 h-4 mt-0.5 shrink-0" />
              <span><strong>DNC contact</strong> — this contact is on the Do Not Contact list and will be skipped on enrollment. Remove the DNC flag first.</span>
            </div>
          )}
          <div className="py-2 space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {allPlays.filter(p => !contact.clientId || p.clientId === contact.clientId).length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No eligible plays found.</p>
            ) : (
              allPlays.filter(p => !contact.clientId || p.clientId === contact.clientId).map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors",
                    selectedEnrollPlayId === String(p.id)
                      ? "border-indigo-500 bg-indigo-50 text-indigo-900"
                      : "border-border hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedEnrollPlayId(String(p.id))}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{p.name}</span>
                    <span className={cn(
                      "text-xs px-2 py-0.5 rounded-full font-medium capitalize shrink-0",
                      p.status === "active" ? "bg-emerald-100 text-emerald-700"
                      : p.status === "paused" ? "bg-amber-100 text-amber-700"
                      : "bg-gray-100 text-gray-600"
                    )}>{p.status}</span>
                  </div>
                </button>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPlayPickerOpen(false); setSelectedEnrollPlayId(""); }}>Cancel</Button>
            <Button
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!selectedEnrollPlayId || enrollInPlay.isPending}
              onClick={() => enrollInPlay.mutate(parseInt(selectedEnrollPlayId))}
            >
              {enrollInPlay.isPending ? "Enrolling…" : "Enroll in play"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add to Journey picker */}
      <Dialog open={journeyPickerOpen} onOpenChange={o => { setJourneyPickerOpen(o); if (!o) setSelectedEnrollJourneyId(""); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add to a journey</DialogTitle>
            <DialogDescription>Select a journey to add this contact to.</DialogDescription>
          </DialogHeader>
          {contact?.dnc && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
              <PhoneOff className="w-4 h-4 mt-0.5 shrink-0" />
              <span><strong>DNC contact</strong> — this contact is on the Do Not Contact list and will be skipped on enrollment. Remove the DNC flag first.</span>
            </div>
          )}
          <div className="py-2 space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {allJourneys.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No journeys found.</p>
            ) : (
              allJourneys.map(j => (
                <button
                  key={j.id}
                  type="button"
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors",
                    selectedEnrollJourneyId === String(j.id)
                      ? "border-indigo-500 bg-indigo-50 text-indigo-900"
                      : "border-border hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedEnrollJourneyId(String(j.id))}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{j.name}</span>
                    <span className={cn(
                      "text-xs px-2 py-0.5 rounded-full font-medium capitalize shrink-0",
                      j.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600"
                    )}>{j.status}</span>
                  </div>
                </button>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setJourneyPickerOpen(false); setSelectedEnrollJourneyId(""); }}>Cancel</Button>
            <Button
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!selectedEnrollJourneyId || enrollInJourney.isPending}
              onClick={() => enrollInJourney.mutate(parseInt(selectedEnrollJourneyId))}
            >
              {enrollInJourney.isPending ? "Adding…" : "Add to journey"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Enroll in Sequence picker */}
      <Dialog open={sequencePickerOpen} onOpenChange={o => { setSequencePickerOpen(o); if (!o) setSelectedEnrollSequenceId(""); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Enroll in a sequence</DialogTitle>
            <DialogDescription>Select a sequence to enroll this contact in. Contacts already in a sequence will be skipped.</DialogDescription>
          </DialogHeader>
          {contact?.dnc && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
              <PhoneOff className="w-4 h-4 mt-0.5 shrink-0" />
              <span><strong>DNC contact</strong> — this contact is on the Do Not Contact list and will be skipped on enrollment. Remove the DNC flag first.</span>
            </div>
          )}
          <div className="py-2 space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {allSequences.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No sequences found.</p>
            ) : (
              allSequences.map(s => (
                <button
                  key={s.id}
                  type="button"
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-colors",
                    selectedEnrollSequenceId === String(s.id)
                      ? "border-indigo-500 bg-indigo-50 text-indigo-900"
                      : "border-border hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedEnrollSequenceId(String(s.id))}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{s.name}</span>
                    <span className={cn(
                      "text-xs px-2 py-0.5 rounded-full font-medium capitalize shrink-0",
                      s.status === "active" ? "bg-emerald-100 text-emerald-700"
                      : s.status === "draft" ? "bg-gray-100 text-gray-600"
                      : "bg-amber-100 text-amber-700"
                    )}>{s.status}</span>
                  </div>
                </button>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSequencePickerOpen(false); setSelectedEnrollSequenceId(""); }}>Cancel</Button>
            <Button
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!selectedEnrollSequenceId || enrollInSequence.isPending}
              onClick={() => enrollInSequence.mutate(parseInt(selectedEnrollSequenceId))}
            >
              {enrollInSequence.isPending ? "Enrolling…" : "Enroll in sequence"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {contact && (
        <AddToSegmentDialog
          contactIds={[contact.id]}
          open={addToSegmentOpen}
          onOpenChange={setAddToSegmentOpen}
        />
      )}
    </div>
  );
}
