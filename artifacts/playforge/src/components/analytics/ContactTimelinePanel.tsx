import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, ChevronRight } from "lucide-react";
import { differenceInDays, differenceInHours, formatDistanceToNow, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { formatReportDateTime } from "@/lib/reportTime";
import { AcquisitionDetails, useAcquisition } from "./AcquisitionProvenance";

const STAGE_ORDER = ["pre-aware", "aware", "pre-engage", "engage", "advance-engage", "action"];
const STAGE_LABELS: Record<string, string> = {
  "pre-aware": "Pre-Aware", aware: "Aware", "pre-engage": "Pre-Engage",
  engage: "Engage", "advance-engage": "Adv-Engage", action: "Action",
};
const STAGE_COLORS: Record<string, string> = {
  "pre-aware": "#94a3b8", aware: "#60a5fa", "pre-engage": "#a78bfa",
  engage: "#34d399", "advance-engage": "#f59e0b", action: "#f43f5e",
};
const STAGE_BG: Record<string, string> = {
  "pre-aware": "bg-slate-100 text-slate-700", aware: "bg-blue-100 text-blue-700",
  "pre-engage": "bg-violet-100 text-violet-700", engage: "bg-emerald-100 text-emerald-700",
  "advance-engage": "bg-amber-100 text-amber-700", action: "bg-rose-100 text-rose-700",
};
const EVENT_ICONS: Record<string, string> = {
  email_open: "📧", email_click: "🔗", page_view: "👁", asset_download: "📥", form_submit: "📝",
};
const INTENT_STATE_MINI_CFG: Record<string, { bg: string; text: string; icon: string }> = {
  "Decision-Action": { bg: "bg-red-100", text: "text-red-700", icon: "🔥" },
  "Evaluating-Engage": { bg: "bg-orange-100", text: "text-orange-700", icon: "🔆" },
  "Stuck-PreEngage": { bg: "bg-amber-100", text: "text-amber-700", icon: "⚡" },
  "Re-engaging": { bg: "bg-cyan-100", text: "text-cyan-700", icon: "🔄" },
  "Stuck-Aware": { bg: "bg-blue-100", text: "text-blue-700", icon: "🌊" },
  Browsing: { bg: "bg-gray-100", text: "text-gray-600", icon: "👀" },
  Dormant: { bg: "bg-slate-100", text: "text-slate-500", icon: "❄️" },
};
const CALL_OUTCOME_STYLES: Record<string, string> = {
  interested: "text-emerald-700 bg-emerald-50 border-emerald-200", callback: "text-blue-700 bg-blue-50 border-blue-200",
  answered: "text-slate-700 bg-slate-50 border-slate-200", not_interested: "text-red-600 bg-red-50 border-red-200",
  no_answer: "text-gray-500 bg-gray-50 border-gray-200", dnc: "text-orange-700 bg-orange-50 border-orange-200",
};

function StageBadge({ stage }: { stage: string }) {
  return <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold", STAGE_BG[stage] ?? "bg-gray-100 text-gray-700")}>{STAGE_LABELS[stage] ?? stage}</span>;
}
const GTM_STATUS_BG: Record<string, string> = {
  hot: "bg-rose-100 text-rose-800",
  warm: "bg-amber-100 text-amber-800",
  cold: "bg-slate-100 text-slate-700",
};
function updatedLabel(value: string | null | undefined) {
  const formatted = formatReportDateTime(value);
  return formatted === "—" ? "Date not recorded" : formatted;
}
function Initials({ name }: { name: string }) {
  const parts = name.trim().split(" ");
  return <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[11px] font-bold shrink-0">{`${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase()}</div>;
}
function stageDuration(from: string, to: string | null) {
  const start = parseISO(from), end = to ? parseISO(to) : new Date(), days = differenceInDays(end, start);
  return days >= 1 ? `${days}d` : `${differenceInHours(end, start)}h`;
}
function CallLogEntry({ cl }: { cl: any }) {
  const hasDetail = !!(cl.aiSummary || cl.transcriptText);
  const [expanded, setExpanded] = useState(hasDetail);
  const [showTx, setShowTx] = useState(false);
  return <div className="border border-border rounded-lg overflow-hidden text-xs">
    <button className={cn("w-full text-left px-3 py-2 flex items-center gap-2 transition-colors", hasDetail ? "hover:bg-indigo-50/50 cursor-pointer" : "")} onClick={() => hasDetail && setExpanded(v => !v)} disabled={!hasDetail}>
      <span className="text-base">📞</span><div className="flex-1 min-w-0"><div className="flex items-center gap-2 flex-wrap">
        {cl.outcome && <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold", CALL_OUTCOME_STYLES[cl.outcome] ?? "text-gray-600 bg-gray-50 border-gray-200")}>{cl.outcome.replace(/_/g, " ")}</span>}
        {cl.durationSeconds != null && <span className="text-[10px] text-muted-foreground tabular-nums">{cl.durationSeconds}s</span>}
        {cl.endedReason && <span className="text-[9px] font-mono text-muted-foreground">{cl.endedReason}</span>}
        {cl.campaignName && <span className="text-[10px] text-muted-foreground truncate max-w-[100px]">{cl.campaignName}</span>}
      </div>{cl.startedAt && <p className="text-[10px] text-muted-foreground mt-0.5">{formatReportDateTime(cl.startedAt)}</p>}</div>
      {hasDetail && <span className="text-[10px] text-indigo-500 shrink-0">{expanded ? "▲" : "▼"}</span>}
    </button>
    {expanded && <div className="border-t px-3 pb-3 pt-2 space-y-2 bg-slate-50/50">
      {cl.aiSummary && <div className="bg-white border border-indigo-100 rounded p-2.5"><p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600 mb-1">🤖 AI Summary</p><p className="text-[11px] text-slate-700 leading-relaxed">{cl.aiSummary}</p></div>}
      {cl.aiNextSteps && <div className="bg-white border border-emerald-100 rounded p-2.5"><p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1">✅ Next Steps</p><div className="space-y-1">{cl.aiNextSteps.split("\n").filter(Boolean).map((s: string, i: number) => <p key={i} className="text-[11px] text-slate-700">{s}</p>)}</div></div>}
      {cl.transcriptText && <div><button className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium" onClick={e => { e.stopPropagation(); setShowTx(v => !v); }}>{showTx ? "▲ hide transcript" : "▼ show transcript"}</button>{showTx && <div className="mt-1.5 max-h-40 overflow-y-auto bg-white border border-indigo-100 rounded p-2 text-[10px] font-mono text-slate-700 whitespace-pre-wrap leading-relaxed">{cl.transcriptText}</div>}</div>}
    </div>}
  </div>;
}

export function ContactTimelinePanel({ contactId }: { contactId: number }) {
  const { data, isLoading } = useQuery({ queryKey: ["contacts", contactId, "timeline"], queryFn: () => fetch(`/api/contacts/${contactId}/timeline`, { credentials: "include" }).then(r => r.json()) });
  const acquisition = useAcquisition([contactId], [data?.contact?.companyId], !!data?.contact);
  if (isLoading) return <div className="p-4 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (!data) return <div className="p-4 text-sm text-muted-foreground">No data</div>;
  const { contact, timeline, stageHistory, callLogs } = data as { contact: any; timeline: any[]; stageHistory: any[]; callLogs?: any[] };
  const stageDurations = STAGE_ORDER.map((stage, i) => {
    const entry = stageHistory.find((s: any) => s.toStage === stage);
    if (!entry) return null;
    const next = stageHistory.find((s: any) => s.toStage === STAGE_ORDER[i + 1]);
    return { stage, duration: stageDuration(entry.achievedAt, next?.achievedAt ?? null), score: entry.scoreAtTransition };
  }).filter(Boolean);
  const currentStage = contact.stage ?? "pre-aware";
  const stageUpdatedAt = [...stageHistory].reverse().find((s: any) => s.toStage === currentStage)?.achievedAt ?? null;
  const gtmStatus = contact.gtmStatus as { status: string; updatedAt: string | null } | null;
  const intentCfg = INTENT_STATE_MINI_CFG[contact.intentState ?? "Browsing"] ?? INTENT_STATE_MINI_CFG.Browsing;
  const scoreBreakdown = contact.intentScore > 0 && (() => {
    const engagement = Number(contact.engagementScore ?? 0) * Number(contact.freqScore ?? 1), stage = Number(contact.maxStageScore ?? 0), velocity = Number(contact.velocityBonus ?? 0), account = Number(contact.accountBonus ?? 0), total = Math.max(engagement + stage + velocity + account, .01);
    const velocityLabel = velocity >= 15 ? "Strong acceleration this week (2×+ more events than prior week)" : velocity >= 10 ? "Fresh surge — new activity after a quiet period" : velocity >= 8 ? "Moderate acceleration this week (1.3×+ more events)" : "No velocity signal this period";
    const signals = [{ label: "Engagement × Frequency", value: engagement, bar: "bg-indigo-500", text: "text-indigo-600", sub: `${Number(contact.engagementScore ?? 0).toFixed(1)} session quality × ${Number(contact.freqScore ?? 1).toFixed(2)} freq multiplier · ${contact.distinctActiveDays ?? 0} active day${contact.distinctActiveDays !== 1 ? "s" : ""}` }, { label: "Stage Progression Bonus", value: stage, bar: "bg-violet-500", text: "text-violet-600", sub: `Deepest stage reached: ${(contact.stage ?? "pre-aware").replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}` }, { label: "Velocity / Momentum", value: velocity, bar: "bg-emerald-500", text: "text-emerald-600", sub: velocityLabel }, { label: "Account ABM Bonus", value: account, bar: "bg-amber-500", text: "text-amber-600", sub: (contact.accountColleagues ?? 0) > 0 ? `${contact.accountColleagues} active colleague${contact.accountColleagues !== 1 ? "s" : ""} at the same company in last 30d` : "No other contacts at this company active recently" }];
    return <div className="px-4 py-3 border-b"><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">How Intent Score Was Calculated</p><div className="flex items-start gap-4 mb-4"><div className="flex-1"><div className="flex items-baseline gap-1"><span className="text-3xl font-black tabular-nums text-indigo-600">{contact.intentScore}</span><span className="text-sm text-muted-foreground">&thinsp;/ 100</span></div><p className="text-[11px] text-muted-foreground mt-0.5">Intent Score</p></div><div className="text-right"><p className="text-xl font-bold tabular-nums text-slate-700">{contact.leadScore}</p><p className="text-[11px] text-muted-foreground">Activity Score (pts)</p></div></div><div className="space-y-3">{signals.map(sig => <div key={sig.label}><div className="flex items-center justify-between mb-1"><span className="text-[11px] font-medium">{sig.label}</span><span className={cn("text-[11px] font-bold tabular-nums", sig.value > 0 ? sig.text : "text-muted-foreground")}>{sig.value > 0 ? `+${sig.value.toFixed(1)}` : "—"}</span></div><div className="h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className={cn("h-full rounded-full", sig.bar)} style={{ width: `${Math.min((sig.value / total) * 100, 100)}%` }} /></div><p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{sig.sub}</p></div>)}<div className="pt-2 border-t space-y-0.5"><div className="flex items-center justify-between"><span className="text-[11px] text-muted-foreground">Raw total (sum of signals)</span><span className="text-[11px] font-mono font-semibold">{contact.rawIntentScore}</span></div>{Number(contact.rawIntentScore) > 100 && <div className="flex items-center justify-between"><span className="text-[11px] text-muted-foreground">Capped at 100 →</span><span className="text-[11px] font-mono font-semibold text-indigo-600">{contact.intentScore}</span></div>}</div></div></div>;
  })();
  return <div className="overflow-y-auto">
    <div className="px-4 py-3 border-b bg-muted/30"><div className="flex items-start gap-3"><Initials name={`${contact.firstName} ${contact.lastName}`} /><div className="flex-1 min-w-0">
      <p className="text-sm font-semibold">{contact.firstName} {contact.lastName}</p>
      <div className="mt-1.5 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[10px] font-medium text-muted-foreground">Journey</span>
          <StageBadge stage={currentStage} />
          <span className="text-[10px] text-muted-foreground">Updated {updatedLabel(stageUpdatedAt)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[10px] font-medium text-muted-foreground">GTM OS · Account</span>
          {gtmStatus ? <>
            <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold", GTM_STATUS_BG[gtmStatus.status] ?? GTM_STATUS_BG.cold)}>{gtmStatus.status.charAt(0).toUpperCase() + gtmStatus.status.slice(1)}</span>
            <span className="text-[10px] text-muted-foreground">Updated {updatedLabel(gtmStatus.updatedAt)}</span>
          </> : <span className="text-[10px] text-muted-foreground">Not classified</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1.5 flex-wrap"><span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold", intentCfg.bg, intentCfg.text)}>{intentCfg.icon} {contact.intentState ?? "Browsing"}</span><span className="text-xs text-muted-foreground">Score: <span className="font-semibold text-foreground">{contact.leadScore}</span></span>{(contact.intentScore ?? 0) > 0 && <span className="text-xs text-muted-foreground">Intent: <span className="font-semibold text-foreground">{contact.intentScore}</span></span>}</div>
      {contact.suggestedNextAction && <p className="text-[11px] text-indigo-600 mt-1 truncate">→ {contact.suggestedNextAction}</p>}
    </div></div></div>
    <div className="px-4 py-3 border-b bg-slate-50/60 space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Acquisition and form history</p>
      {acquisition.isPending ? <Skeleton className="h-20" /> : acquisition.isError ? (
        <p role="alert" className="text-xs text-red-700">Acquisition history could not be loaded.</p>
      ) : <>
        <AcquisitionDetails title="Contact" data={acquisition.data?.contacts[String(contactId)]} />
        {contact.companyId && <AcquisitionDetails title={contact.companyName || "Account"} data={acquisition.data?.accounts[String(contact.companyId)]} />}
      </>}
    </div>
    {scoreBreakdown}
    {stageDurations.length > 0 && <div className="px-4 py-3 border-b"><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">Stage Journey</p><div className="space-y-1.5">{stageDurations.map((sd: any, i: number) => <div key={sd.stage} className="flex items-center gap-2"><StageBadge stage={sd.stage} /><div className="flex items-center gap-1 text-[11px] text-muted-foreground"><Clock className="w-3 h-3" /><span>{sd.duration}</span></div><span className="text-[11px] text-muted-foreground ml-auto">at score {sd.score}</span>{i < stageDurations.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground" />}</div>)}</div></div>}
    {callLogs && callLogs.length > 0 && <div className="px-4 py-3 border-b"><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">📞 Call History ({callLogs.length})</p><div className="space-y-2">{callLogs.map((cl: any) => <CallLogEntry key={cl.id} cl={cl} />)}</div></div>}
    <div className="px-4 py-3"><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Activity Timeline</p><div className="space-y-0">{timeline.map((evt: any, i: number) => <div key={evt.id} className="relative">{i < timeline.length - 1 && <div className="absolute left-3.5 top-8 bottom-0 w-px bg-border" />}{evt.isStageChange && <div className="flex items-center gap-2 my-1.5 ml-8"><div className="h-px flex-1 bg-border" /><span className="text-[10px] text-muted-foreground">{STAGE_LABELS[evt.fromStage ?? ""] ?? evt.fromStage} → <span className="font-semibold" style={{ color: STAGE_COLORS[evt.toStage] }}>{STAGE_LABELS[evt.toStage] ?? evt.toStage}</span></span><div className="h-px flex-1 bg-border" /></div>}<div className="flex items-start gap-3 py-2"><div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-sm shrink-0 z-10">{EVENT_ICONS[evt.eventType] ?? "•"}</div><div className="flex-1 min-w-0"><p className="text-xs text-foreground leading-snug">{evt.description}</p><div className="flex items-center gap-2 mt-0.5"><span className="text-[10px] text-muted-foreground">{formatDistanceToNow(new Date(evt.createdAt), { addSuffix: true })}</span>{evt.scoreDelta > 0 && <span className="text-[10px] font-semibold text-emerald-600">+{evt.scoreDelta}</span>}<span className="text-[10px] text-muted-foreground ml-auto">score {evt.cumulativeScore}</span></div></div></div></div>)}</div></div>
  </div>;
}