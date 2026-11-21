import { useEffect, useRef, type ReactNode } from "react";
import { CategoryPropensityFact, IntentAccount, IntentEvidence, useProgressiveIntentAccount, useIntentAccountScoreBreakdown, useIntentResearchSummary } from "@/hooks/use-intent";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, TrendingUp, Activity, ExternalLink, ArrowUpRight, ArrowDownRight, Minus, AlertCircle, Zap, Radio, Target, Lightbulb, Users, ShieldCheck, ChevronLeft, Laptop, Printer, Headphones, BriefcaseBusiness, CheckCircle2, Calculator, HelpCircle, Link2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { IntentPageHeader, TierBadge } from "@/components/intent/ui";
import DemoEngagementHistory from "@/components/demo-engagement/DemoEngagementHistory";
import { getScopeParams } from "@/lib/intent-scope";
import { formatReportDate, formatReportDateTime } from "@/lib/reportTime";
import { useAuthContext } from "@/contexts/AuthContext";
import { ResearchAttributionQueue } from "./research-attribution-queue";
import { ResearchCorrections } from "./research-corrections";
import { useMonitoredAccounts } from "./account-intelligence-overview";
import AccountResearchOpportunity from "@/components/intent/AccountResearchOpportunity";
import MonitoredResearchContext from "@/components/intent/MonitoredResearchContext";
import HpMonitoringContext from "@/components/analytics/hp-bi/MonitoringContext";
import FirstPartySourceButton from "@/components/intent/FirstPartySourceButton";

function TrendBadge({ delta }: { delta: number }) {
  if (delta === 0) return <span className="text-[10px] font-black text-stone-400 uppercase tracking-widest flex items-center gap-0.5"><Minus className="w-3 h-3" /> Flat</span>;
  if (delta > 0) return <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest flex items-center gap-0.5"><ArrowUpRight className="w-3 h-3" /> +{delta}</span>;
  return <span className="text-[10px] font-black text-rose-500 uppercase tracking-widest flex items-center gap-0.5"><ArrowDownRight className="w-3 h-3" /> {delta}</span>;
}

function AccountDetailSections({ researchStatus, topCards, qualification, newsSources, signalFeed, additionalAnalysis }: {
  researchStatus: ReactNode; topCards: ReactNode; qualification: ReactNode;
  newsSources: ReactNode; signalFeed: ReactNode; additionalAnalysis: ReactNode;
}) {
  return <div className="flex-1 max-w-[1200px] mx-auto w-full p-6">
    {researchStatus}
    {topCards}
    {qualification}
    {newsSources}
    {signalFeed}
    {additionalAnalysis}
  </div>;
}

function safeHttpUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function HighlightedSourceContext({ fullContext, signalText }: { fullContext: string; signalText?: string }) {
  const needle = signalText?.trim();
  if (!needle) return <>{fullContext}</>;
  const exactIndex = fullContext.toLowerCase().indexOf(needle.toLowerCase());
  if (exactIndex >= 0) {
    return <>
      {fullContext.slice(0, exactIndex)}
      <mark className="rounded-sm bg-amber-200 px-0.5 font-semibold text-stone-900">{fullContext.slice(exactIndex, exactIndex + needle.length)}</mark>
      {fullContext.slice(exactIndex + needle.length)}
    </>;
  }
  const keywords = [...new Set(needle.toLowerCase().match(/[a-z]{5,}/g) ?? [])].slice(0, 16);
  const sentences = fullContext.split(/(?<=[.!?])\s+/);
  const matchIndex = sentences.findIndex(sentence => keywords.filter(word => sentence.toLowerCase().includes(word)).length >= 3);
  if (matchIndex < 0) return <>{fullContext}</>;
  return <>
    {sentences.map((sentence, index) => (
      <span key={`${index}-${sentence.slice(0, 20)}`}>
        {index > 0 ? " " : ""}
        {index === matchIndex
          ? <mark className="rounded-sm bg-amber-200 px-0.5 font-semibold text-stone-900">{sentence}</mark>
          : sentence}
      </span>
    ))}
  </>;
}

export function selectScopedCategoryInsights<T extends { category:string; score:number; inSelectedScope?:boolean; explicitSource?:string|null }>(items:T[],hasScope:boolean){
  return (hasScope?items.filter(item=>item.inSelectedScope):items).sort((a,b)=>
    Number(Boolean(b.explicitSource))-Number(Boolean(a.explicitSource))
    ||Number(Boolean(b.inSelectedScope))-Number(Boolean(a.inSelectedScope))
    ||b.score-a.score
    ||a.category.localeCompare(b.category),
  );
}

export function explicitPublicEvidenceRank(item:Pick<IntentEvidence,"eventType"|"context">){
  const eventType=String(item.eventType??"").toLowerCase();
  const context=item.context as Record<string,unknown>|undefined;
  const aiReview=context?.aiReview as Record<string,unknown>|undefined;
  const fitment=String(context?.fitmentLevel??aiReview?.fitmentLevel??"").toLowerCase();
  if(/\b(rfp|rfq|tender|procurement|purchase_order|pricing_request|demo_request|vendor_evaluation|contract|renewal)\b/.test(eventType))return 0;
  if(fitment==="direct_intent")return 0;
  if(fitment==="confirmed_need")return 1;
  return 2;
}

function SignalCard({ item }: { item: IntentEvidence }) {
  const sourceUrl = safeHttpUrl(item.sourceUrl);
  const sourceTitle = typeof item.context?.sourceTitle === "string" ? item.context.sourceTitle.trim() : "";
  const excerptTitle = (item.excerpt?.split(/\s+[—–-]\s+|[.!?]\s+/)[0]?.trim() || "").slice(0, 180);
  const cardTitle = item.title || item.summary || sourceTitle || excerptTitle || (sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : "Evidence source");
  const aiReview = item.context?.aiReview;
  const answer = item.context?.answer;
  const fullContext = typeof item.context?.originalExcerpt === "string" ? item.context.originalExcerpt : "";
  const contextLabels = [
    item.context?.formName && `Form: ${item.context.formName}`,
    item.context?.campaign && `Campaign: ${item.context.campaign}`,
    item.context?.leadSource && `Source: ${item.context.leadSource}`,
  ].filter((value): value is string => Boolean(value));
  return (
    <article className="p-4 bg-white border border-stone-200 rounded-lg shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
      {item.contribution !== undefined && item.contribution > 0 && (
        <div className="absolute top-0 right-0 bg-emerald-50 text-emerald-700 border-l border-b border-emerald-100 px-2 py-1 rounded-bl-lg text-[10px] font-black tabular-nums tracking-widest">
          +{item.contribution} pts
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-2 pr-12">
        <span className="text-[9px] font-black uppercase tracking-widest text-stone-600 bg-stone-100 px-1.5 py-0.5 rounded">
          {item.eventType?.replace(/_/g, " ") || "Signal"}
        </span>
        {item.reviewStatus && (
          <span className={cn(
            "text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded",
            item.reviewStatus === "approved" ? "bg-lime-50 text-lime-800" :
            item.reviewStatus === "rejected" ? "bg-rose-50 text-rose-700" :
            "bg-amber-50 text-amber-800"
          )}>
            {item.reviewStatus.replace(/_/g, " ")}
          </span>
        )}
        <span className="text-[10px] font-bold text-stone-400">
          {item.eventDate || item.capturedAt ? formatReportDate(item.eventDate || item.capturedAt) : ""}
        </span>
      </div>

      <h4 className="text-sm font-bold text-stone-900 leading-snug mb-1.5 group-hover:text-emerald-700 transition-colors">
        {cardTitle}
      </h4>

      {item.excerpt && (
        <p className="text-[12px] text-stone-600 font-medium leading-relaxed mb-3 line-clamp-3">
          {item.excerpt}
        </p>
      )}

      {aiReview?.rationale && (
        <div className="mt-3 rounded-md border border-emerald-100 bg-emerald-50/50 p-3">
          <p className="text-[9px] font-black uppercase tracking-widest text-emerald-700 mb-1">AI interpretation</p>
          <p className="text-[11px] font-medium leading-relaxed text-stone-700">{aiReview.rationale}</p>
          {!!aiReview.inferredCategories?.length && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {aiReview.inferredCategories.map(category => <span key={category} className="rounded bg-white border border-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-800">{category}</span>)}
            </div>
          )}
        </div>
      )}

      {answer?.reason && (
        <div className="mt-3 rounded-md border border-sky-100 bg-sky-50/50 p-3">
          <p className="text-[9px] font-black uppercase tracking-widest text-sky-700 mb-1">Questionnaire signal context</p>
          {answer.field && <p className="text-[10px] font-black uppercase tracking-widest text-sky-800">{answer.field.replace(/_/g, " ")}</p>}
          {answer.value !== undefined && answer.value !== null && <p className="text-[12px] font-semibold leading-relaxed text-stone-900 mt-1 whitespace-pre-wrap">{String(answer.value)}</p>}
          <p className="text-[11px] font-medium leading-relaxed text-stone-700">{answer.reason}</p>
          {typeof answer.strength === "number" && <p className="text-[10px] font-bold text-sky-800 mt-1.5">Signal strength: {answer.strength}/100</p>}
        </div>
      )}

      {!!contextLabels.length && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {contextLabels.map(label => <span key={label} className="rounded bg-stone-50 border border-stone-200 px-1.5 py-0.5 text-[9px] font-bold text-stone-600">{label}</span>)}
        </div>
      )}

      {fullContext && fullContext !== item.excerpt && (
        <details className="mt-3 text-[11px] text-stone-600">
          <summary className="cursor-pointer font-bold text-stone-700">View full source context</summary>
          <div className="mt-2 rounded-md border border-amber-100 bg-amber-50/30 p-3">
            <p className="mb-2 text-[9px] font-black uppercase tracking-widest text-amber-800">Highlighted text is the contextual signal used</p>
            <p className="whitespace-pre-wrap leading-relaxed"><HighlightedSourceContext fullContext={fullContext} signalText={item.excerpt} /></p>
          </div>
        </details>
      )}

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-stone-50">
        <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-stone-400">
          <span className="text-emerald-700">{item.provenance || item.provider || item.source || "Internal"}</span>
          {item.productName ? ` · ${item.productName}` : ""}
        </div>
        {sourceUrl && (
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex text-[9px] font-black uppercase tracking-widest text-stone-500 hover:text-emerald-600 transition-colors items-center gap-0.5">
            Source <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </article>
  )
}

function SignalGroup({ title, evidence }: { title: string, evidence: IntentEvidence[] }) {
  if (!evidence?.length) return null;
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3 border-b border-stone-200 pb-1.5">
        <h3 className="text-xs font-black text-stone-800 uppercase tracking-widest">{title}</h3>
        <span className="text-[10px] font-bold text-stone-400 tracking-widest uppercase">{evidence.length} records</span>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {evidence.map((item, i) => <SignalCard key={item.id ?? i} item={item} />)}
      </div>
    </div>
  )
}

function InfoCard({ title, icon: Icon, children, action }: any) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg shadow-sm flex flex-col overflow-hidden transition-all hover:border-stone-300 h-full">
      <div className="px-4 py-3 border-b border-stone-100 bg-stone-50/50 flex items-center justify-between shrink-0">
        <h3 className="text-[10px] font-black uppercase tracking-widest text-stone-600 flex items-center gap-1.5">
          {Icon && <Icon className="w-3.5 h-3.5 text-emerald-600" />} {title}
        </h3>
        {action && <div>{action}</div>}
      </div>
      <div className="p-4 flex-1 flex flex-col min-h-0">
        {children}
      </div>
    </div>
  )
}

function briefingPoints(text: string) {
  const cleaned = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned
    .split(/(?<=[.!?])\s+|\s+…+\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 20)
    .slice(0, 6);
}

function tierHeat(tier:string|null|undefined){
  return tier==="hot"?3:tier==="warm"?2:tier==="emerging"?1:0;
}

function SidebarWidget({ title, icon: Icon, children }: any) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden">
      <div className="px-4 py-3 bg-stone-50/80 border-b border-stone-100 flex items-center justify-between">
        <h3 className="text-[10px] font-black text-stone-600 uppercase tracking-widest flex items-center gap-1.5">
          {Icon && <Icon className="w-3.5 h-3.5 text-emerald-600" />} {title}
        </h3>
      </div>
      <div className="p-0">
        {children}
      </div>
    </div>
  )
}

const propensityComponentLabels = {
  accountFit: "Account fit",
  need: "Operational need",
  refresh: "Refresh pressure",
  purchaseReadiness: "Purchase readiness",
  externalPressure: "External pressure",
} as const;

function factClassification(fact: CategoryPropensityFact) {
  if (fact.kind === "account_fit") {
    return { label: "Assumption", className: "border-violet-200 bg-violet-50 text-violet-800", icon: HelpCircle };
  }
  if (fact.sourceReliability >= 80 || fact.sourceUrl === "internal:first-party") {
    return { label: "Confirmed fact", className: "border-emerald-200 bg-emerald-50 text-emerald-800", icon: CheckCircle2 };
  }
  return { label: "Estimate", className: "border-amber-200 bg-amber-50 text-amber-800", icon: Calculator };
}

function pitchFromSignal(category: string, product: string | null, productRationale: string | null, opportunity: string | null, fact: CategoryPropensityFact) {
  const solution = product || category;
  const need = opportunity || `a concrete ${category} requirement`;
  const positioning = productRationale ? ` If confirmed, position ${solution}: ${productRationale}` : ` If confirmed, position ${solution} against the verified requirement.`;
  if (fact.kind === "negative") {
    return `Do not lead with ${solution}. Confirm whether the stated constraint or lack of plans has changed before proposing a solution.`;
  }
  if (fact.kind === "purchase") {
    return `Reference the buying activity directly and ask whether ${solution} is included in the active evaluation, required specification, or procurement timeline.${positioning}`;
  }
  if (fact.kind === "need" || fact.kind === "refresh") {
    return `Ask whether this change creates ${need}, then validate the workload, user group, scale, and timing.${positioning}`;
  }
  if (fact.kind === "external_pressure") {
    return `Use this event as a discovery opener, not proof of demand: ask whether it creates ${need}.${positioning}`;
  }
  return `Treat this as account context only. Ask a qualifying question before connecting it to ${solution}; it does not independently establish purchase intent.`;
}

function SignalJustificationCard({ category, product, productRationale, opportunity, fact, index }: {
  category: string;
  product: string | null;
  productRationale?: string | null;
  opportunity?: string | null;
  fact: CategoryPropensityFact;
  index: number;
} & { productRationale?: string | null; opportunity?: string | null }) {
  const classification = factClassification(fact);
  const ClassificationIcon = classification.icon;
  const sourceUrl = safeHttpUrl(fact.sourceUrl || undefined);
  const sourceLabel = fact.sourceUrl === "internal:first-party" ? "Open first-party evidence below" : sourceUrl ? "Open exact source" : "No external source";
  const cardId = `hotness-signal-${fact.id}`;
  return (
    <article id={cardId} className="scroll-mt-6 rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 text-xs font-black text-emerald-800">{index + 1}</div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-stone-400">{category} · {fact.kind.replace(/_/g, " ")}</p>
            <h3 className="mt-1 text-[13px] font-bold leading-snug text-stone-900">{fact.explanation}</h3>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn("inline-flex items-center gap-1 rounded border px-2 py-1 text-[9px] font-black uppercase tracking-wider", classification.className)}>
            <ClassificationIcon className="h-3 w-3" /> {classification.label}
          </span>
          <span className="rounded border border-stone-200 bg-stone-50 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-stone-700">
            Strength {fact.strength}/100
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-md border border-emerald-100 bg-emerald-50/50 p-3">
          <p className="text-[9px] font-black uppercase tracking-widest text-emerald-800">Why this affects the heat</p>
          <p className="mt-1 text-[11px] font-medium leading-relaxed text-stone-700">
            This signal contributes to <strong>{category}</strong> because it was classified as {fact.kind.replace(/_/g, " ")} evidence.
            {fact.kind === "purchase"
              ? " It is purchase-stage evidence and can support Hot when the remaining fit and corroboration thresholds are met."
              : fact.kind === "negative"
                ? " It reduces confidence or heat and must override weaker inferred optimism."
                : " It supports the need or fit, but does not by itself prove an active purchase."}
          </p>
        </div>
        <div className="rounded-md border border-blue-100 bg-blue-50/50 p-3">
          <p className="text-[9px] font-black uppercase tracking-widest text-blue-800">Suggested pitch line</p>
          <p className="mt-1 text-[11px] font-medium leading-relaxed text-stone-700">{pitchFromSignal(category, product, productRationale || null, opportunity || null, fact)}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-3">
        <p className="text-[9px] font-bold uppercase tracking-wider text-stone-400">
          Reliability {fact.sourceReliability}% · {formatReportDate(fact.occurredAt)}
        </p>
        {sourceUrl ? (
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-emerald-700 hover:text-emerald-900">
            {sourceLabel} <ExternalLink className="h-3 w-3" />
          </a>
        ) : fact.sourceUrl === "internal:first-party" ? (
          <button onClick={() => document.getElementById("evidence")?.scrollIntoView({ behavior: "smooth" })} className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-emerald-700 hover:text-emerald-900">
            {sourceLabel} <ArrowDownRight className="h-3 w-3" />
          </button>
        ) : (
          <span className="text-[9px] font-bold uppercase tracking-wider text-stone-400">{sourceLabel}</span>
        )}
      </div>
    </article>
  );
}

function CategoryPropensityAudit({ conclusions }: {
  conclusions: NonNullable<NonNullable<IntentAccount["researchIntent"]>["opportunityBrief"]>["categoryConclusions"];
}) {
  const auditable = conclusions.filter(conclusion => conclusion.propensity);
  if (!auditable.length) return null;

  return (
    <section className="mb-8 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 bg-stone-50/70 px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-stone-900">
            <Calculator className="h-3.5 w-3.5 text-emerald-700" /> Category propensity audit
          </h2>
          <p className="mt-1 text-[11px] font-medium text-stone-600">Open a category to inspect its score inputs, deductions, buying status, and cited facts.</p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[9px] font-black uppercase tracking-wider">
          <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-800">Confirmed fact</span>
          <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">Estimate</span>
          <span className="rounded border border-violet-200 bg-violet-50 px-2 py-1 text-violet-800">Assumption</span>
        </div>
      </div>
      <div className="divide-y divide-stone-200">
        {auditable.map(conclusion => {
          const propensity = conclusion.propensity!;
          return (
            <details key={conclusion.categoryId} className="group">
              <summary className="cursor-pointer list-none px-4 py-4 hover:bg-stone-50">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[13px] font-bold text-stone-900">{conclusion.categoryName}</h3>
                    <p className="mt-1 text-[10px] font-medium text-stone-500">{propensity.evidence.length} contributing fact{propensity.evidence.length === 1 ? "" : "s"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-stone-900 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-white">
                      Propensity: {propensity.band} · {propensity.score}
                    </span>
                    <span className="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-sky-800">
                      Evidence confidence: {Math.round(propensity.dataConfidence * 100)}%
                    </span>
                  </div>
                </div>
              </summary>
              <div className="border-t border-stone-100 bg-stone-50/40 p-4">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7">
                  {Object.entries(propensity.components).map(([key, points]) => (
                    <div key={key} className="rounded-md border border-stone-200 bg-white p-2.5">
                      <p className="text-[8px] font-black uppercase tracking-widest text-stone-400">{propensityComponentLabels[key as keyof typeof propensityComponentLabels]}</p>
                      <p className="mt-1 text-lg font-black tabular-nums text-stone-900">+{points}</p>
                    </div>
                  ))}
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2.5">
                    <p className="text-[8px] font-black uppercase tracking-widest text-emerald-700">Momentum</p>
                    <p className="mt-1 text-lg font-black tabular-nums text-emerald-800">+{propensity.momentum}</p>
                  </div>
                  <div className="rounded-md border border-rose-200 bg-rose-50 p-2.5">
                    <p className="text-[8px] font-black uppercase tracking-widest text-rose-700">Deductions</p>
                    <p className="mt-1 text-lg font-black tabular-nums text-rose-700">−{propensity.negativeDeduction}</p>
                  </div>
                </div>

                <div className={cn("mt-3 flex items-start gap-2 rounded-md border p-3", propensity.hasRecentPurchaseSignal ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50")}>
                  {propensity.hasRecentPurchaseSignal ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />}
                  <div>
                    <p className={cn("text-[10px] font-black uppercase tracking-widest", propensity.hasRecentPurchaseSignal ? "text-emerald-800" : "text-amber-800")}>
                      Purchase stage: {propensity.hasRecentPurchaseSignal ? "Recent purchase signal confirmed" : "No confirmed recent purchase signal"}
                    </p>
                    <p className="mt-0.5 text-[10px] font-medium text-stone-600">
                      {propensity.hasRecentPurchaseSignal ? "A reliable purchase event occurred within the last 90 days." : "This category cannot reach Hot until reliable near-term buying evidence is captured."}
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  <p className="text-[9px] font-black uppercase tracking-widest text-stone-500">Contributing facts</p>
                  {propensity.evidence.length ? propensity.evidence.map(fact => {
                    const classification = factClassification(fact);
                    const FactIcon = classification.icon;
                    const sourceUrl = safeHttpUrl(fact.sourceUrl || undefined);
                    return (
                      <article key={`${fact.kind}-${fact.id}`} className="rounded-md border border-stone-200 bg-white p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                              <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest", classification.className)}>
                                <FactIcon className="h-2.5 w-2.5" /> {classification.label}
                              </span>
                              <span className={cn("rounded px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest", fact.kind === "negative" ? "bg-rose-50 text-rose-700" : "bg-stone-100 text-stone-600")}>{fact.kind.replace(/_/g, " ")}</span>
                              <span className="text-[9px] font-bold text-stone-400">{formatReportDate(fact.occurredAt)} · source reliability {fact.sourceReliability}%</span>
                            </div>
                            <p className="text-[11px] font-medium leading-relaxed text-stone-700">{fact.explanation}</p>
                          </div>
                          {sourceUrl ? (
                            <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-[9px] font-black uppercase tracking-widest text-emerald-700 hover:text-emerald-900">
                              Cited source <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="shrink-0 text-[9px] font-black uppercase tracking-widest text-stone-400">First-party record</span>
                          )}
                        </div>
                      </article>
                    );
                  }) : <p className="rounded-md border border-dashed border-stone-300 p-4 text-center text-[10px] font-bold text-stone-400">No accepted facts contributed to this score.</p>}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

type PanelQuery = { data: unknown; isError: boolean; error: Error | null; refetch: () => unknown };
export function AccountDetailPanel({ query, label, children }: { query: PanelQuery; label: string; children: ReactNode }) {
  if (query.isError) return <div role="alert" className="my-3 rounded-lg border border-rose-200 bg-white p-4 text-sm text-rose-700">
    {label} could not be loaded{query.error?.message ? `: ${query.error.message}` : "."}{" "}
    <button className="font-bold underline" onClick={() => void query.refetch()}>Retry {label.toLowerCase()}</button>
  </div>;
  if (!query.data) return <div role="status" className="my-3 rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-500">
    Loading {label.toLowerCase()}…<Skeleton className="mt-3 h-16 w-full" />
  </div>;
  return <>{children}</>;
}

export default function IntentAccountPage({ id }: { id: string }) {
  const { user } = useAuthContext();
  const [location] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const qs = searchParams.toString();
  const intentListUrl = `/intent/accounts${qs ? `?${qs}` : ''}`;
  const reviewQuery = new URLSearchParams(searchParams);
  reviewQuery.set("reviewAccount", id);
  const reviewUrl = `/intent/dashboard?${reviewQuery.toString()}`;

  const scopeParams = getScopeParams(searchParams);

  const { data: account, identity, evidence, research, analysis, refetch: refetchAccount } = useProgressiveIntentAccount(id, scopeParams);
  const { isPending: isLoading, isError, error } = identity;
  const scoreBreakdown = useIntentAccountScoreBreakdown(id);
  const monitoringContext = useMonitoredAccounts(1, "", Number(id));
  const parentResearchAccount = account?.parentMonitoringContext?.find(context => context.analysisAccountId != null);
  const parentResearchId = parentResearchAccount?.analysisAccountId ?? undefined;
  const parentMonitoring = useMonitoredAccounts(1, "", parentResearchId, parentResearchId != null && parentResearchId !== Number(id));
  const retainedMember = account?.memberMonitoringContext?.find(context =>
    context.accountId !== Number(id) && !!context.sourceEvidence?.length);
  const retainedMemberMonitoring = useMonitoredAccounts(1, "", retainedMember?.accountId, !!retainedMember);
  const { data: researchState } = useIntentResearchSummary({ accountIds: id });

  const observedRun = useRef<{ id: string; completedAt?: string | null } | null>(null);
  useEffect(() => {
    const completedAt = researchState?.latestRun?.completedAt;
    // Initial historical completion is not a new event; avoid duplicate reads.
    if (observedRun.current?.id === id && completedAt && completedAt !== observedRun.current.completedAt) void refetchAccount();
    if (researchState) observedRun.current = { id, completedAt };
  }, [id, refetchAccount, researchState]);

  if (isLoading) {
    return <div className="p-6 max-w-5xl mx-auto"><Link href={intentListUrl}>← Command Center</Link><p role="status" className="my-4 text-sm text-stone-500">Loading account identity…</p><Skeleton className="h-32 w-full mb-6 rounded-lg" /></div>;
  }

  if (isError || !account) {
    return (
      <div className="p-6 max-w-5xl mx-auto text-center py-20 font-sans">
        <AlertCircle className="w-10 h-10 text-rose-300 mx-auto mb-4" />
        <h2 className="text-lg font-bold text-stone-900">{isError ? "Failed to load account" : "Account not found"}</h2>
        {isError && <p className="text-sm font-semibold text-stone-500 mt-1">{error?.message}</p>}
        {isError && <Button variant="outline" className="mt-4" onClick={() => void identity.refetch()}>Retry account identity</Button>}
        <Button asChild variant="outline" className="mt-6 border-stone-200 text-stone-700 font-bold">
          <Link href={intentListUrl}>Return to Intent Engine</Link>
        </Button>
      </div>
    );
  }

  const chartData = (account.scoreHistory || []).map((h: any) => ({
    date: formatReportDate(h.date),
    score: h.score,
  }));

  const contributions = account.contributions || [];
  const fullBrief = account.researchIntent?.opportunityBrief;
  const selectedConclusion = fullBrief?.bestSelectedConclusion;
  const brief = fullBrief && selectedConclusion ? {
    ...fullBrief,
    strongestOpportunity: `${selectedConclusion.categoryName} — ${selectedConclusion.tier}`,
    whyNow: selectedConclusion.rationale,
    solutions: selectedConclusion.recommendedProducts.map((product, index) => ({ priority: index + 1, name: product.name, rationale: product.rationale })),
    entryOffer: selectedConclusion.opportunities.join(" ") || `Validate the operational need, scale, buying owner, and timing for ${selectedConclusion.categoryName}.`,
    buyers: selectedConclusion.buyers,
    outreachAngle: [...selectedConclusion.gaps, ...selectedConclusion.opportunities].join(" "),
    sourceUrls: selectedConclusion.sourceUrls,
  } : fullBrief;
  const whyNowPoints = brief ? briefingPoints(brief.whyNow) : [];
  const questionnaire = account.productAnalysis?.questionnaireAnalysis;
  const hpSolutionFit = account.hpSolutionFit;
  const bestProduct = account.productAnalysis?.bestProduct;
  const productCategories = account.productAnalysis?.topCategories || [];
  const strongestCategory = productCategories[0];
  const validatedIntent = account.canonicalCategoryIntent || (bestProduct && (!strongestCategory || bestProduct.score >= strongestCategory.score) ? bestProduct : strongestCategory);
  const validatedIntentScore = validatedIntent?.score ?? account.score ?? 0;
  const validatedIntentTier = validatedIntent?.tier ?? account.tierKey ?? "cold";
  const accountStatus = account.intentStatus?.accountStatus ?? validatedIntentTier;
  const accountStatusScore = accountStatus === "hot" ? 100 : accountStatus === "warm" ? 50 : 0;
  const selectedProductIds = new Set(account.analysisScope?.selectedProductIds || []);
  const selectedCategoryIds = new Set(account.analysisScope?.selectedCategoryIds || []);
  const hasProductScope = selectedProductIds.size > 0;
  const categoryConclusions = fullBrief?.categoryConclusions || [];
  const hpCategoryInsights = account.intentStatus?.categories || [];
  const canonicalCategoryStatus=(name:string)=>hpCategoryInsights.find(item=>item.name.toLowerCase()===name.toLowerCase());
  const mergedProductCategories = productCategories.map(category => {
    const canonical=canonicalCategoryStatus(category.category);
    if(canonical)return {
      ...category,
      score:canonical.status==="hot"?100:canonical.status==="warm"?50:0,
      tier:canonical.status,
      explanation:canonical.statusReason,
      signalCount:canonical.drivingSignals.length,
    };
    const conclusion = categoryConclusions.find(item => item.categoryName.toLowerCase() === category.category.toLowerCase());
    const conclusionWins=conclusion&&(tierHeat(conclusion.tier)>tierHeat(category.tier)||(tierHeat(conclusion.tier)===tierHeat(category.tier)&&conclusion.score>=category.score));
    return conclusionWins ? {
      ...category,
      score: conclusion.score,
      tier: conclusion.tier,
      explanation: conclusion.rationale,
    } : category;
  });
  const productCategoryNames = new Set(mergedProductCategories.map(category => category.category.toLowerCase()));
  const allCategoryInsights = [
    ...mergedProductCategories,
    ...categoryConclusions
      .filter(conclusion => !productCategoryNames.has(conclusion.categoryName.toLowerCase()))
      .map(conclusion => {
        const canonical=canonicalCategoryStatus(conclusion.categoryName);
        return {
        category: conclusion.categoryName,
        score: canonical?canonical.status==="hot"?100:canonical.status==="warm"?50:0:conclusion.score,
        tier: canonical?.status??conclusion.tier,
        inSelectedScope: hasProductScope || selectedConclusion?.categoryId === conclusion.categoryId,
        signalCount: canonical?.drivingSignals.length??conclusion.propensity?.evidence.length??0,
        strongestProduct: conclusion.recommendedProducts[0]?.name ?? null,
        explanation: canonical?.statusReason??conclusion.rationale,
      }}),
    ...(account.researchIntent?.topics || [])
      .filter(topic => !productCategoryNames.has(topic.label.toLowerCase()))
      .map(topic => ({
        category: topic.label,
        score: tierHeat(topic.tier)>tierHeat(accountStatus) ? accountStatusScore : topic.score,
        tier: tierHeat(topic.tier)>tierHeat(accountStatus) ? accountStatus : topic.tier,
        inSelectedScope: false,
        signalCount: topic.evidenceCount,
        strongestProduct: null,
        explanation: `${topic.explanation}${tierHeat(topic.tier)>tierHeat(accountStatus) ? " This research hypothesis is not validated as Hot by the account status." : ""}${topic.solutions?.length ? ` Possible solutions: ${topic.solutions.join(", ")}.` : ""}`,
        isLegacyResearch: true,
      })),
  ];
  const categoryInsights = selectScopedCategoryInsights(allCategoryInsights,hasProductScope);

  const pub = account.evidence?.public || [];
  const uploaded = account.evidence?.uploaded || [];
  const company = account.evidence?.companyKaboom || [];
  const contact = account.evidence?.contactKaboom || [];
  const isPriorityEvidence = (item: IntentEvidence) => !hasProductScope || item.productId == null || selectedProductIds.has(item.productId);
  const priorityPub = pub.filter(isPriorityEvidence).sort((a,b)=>explicitPublicEvidenceRank(a)-explicitPublicEvidenceRank(b)||new Date(b.eventDate||b.capturedAt||0).getTime()-new Date(a.eventDate||a.capturedAt||0).getTime());
  const explicitEvidenceRank = (item: IntentEvidence) => item.evidenceKind === "lead_form" || item.evidenceKind === "product_buy_intent" ? 0 : item.evidenceKind === "event_questionnaire" || item.evidenceKind === "event_feedback" ? 1 : 2;
  const priorityUploaded = uploaded.filter(isPriorityEvidence).sort((a,b)=>explicitEvidenceRank(a)-explicitEvidenceRank(b)||new Date(b.eventDate||b.capturedAt||0).getTime()-new Date(a.eventDate||a.capturedAt||0).getTime());
  const otherEvidence = [...pub, ...uploaded].filter(item => !isPriorityEvidence(item));
  const hasSignals = pub.length > 0 || uploaded.length > 0 || company.length > 0 || contact.length > 0;

  const ownResearchContext = monitoringContext.data?.items.find(item => item.id === Number(id))?.researchContext;
  const parentResearchContext = parentResearchId === Number(id) ? ownResearchContext
    : parentMonitoring.data?.items.find(item => item.id === parentResearchId)?.researchContext;
  const showParentResearch = !!parentResearchContext?.evidence?.length;
  const retainedMemberContext = retainedMemberMonitoring.data?.items.find(item=>item.id===retainedMember?.accountId)?.researchContext;
  const showRetainedMember = !showParentResearch && !ownResearchContext?.evidence?.length && !!retainedMemberContext?.evidence?.length;
  const researchContext = showParentResearch ? parentResearchContext : showRetainedMember ? retainedMemberContext : ownResearchContext;
  const researchName = showParentResearch ? parentResearchAccount!.accountName : showRetainedMember ? retainedMember!.accountName : account.name;
  const researchCheckedAt = showParentResearch
    ? (parentResearchId === Number(id) ? monitoringContext.data : parentMonitoring.data)?.items.find(item => item.id === parentResearchId)?.lastResearchedAt
    : showRetainedMember ? retainedMemberMonitoring.data?.items.find(item => item.id === retainedMember?.accountId)?.lastResearchedAt
      : monitoringContext.data?.items.find(item => item.id === Number(id))?.lastResearchedAt;
  const hasResearchOpportunity = researchContext && researchContext.kind !== "no_recent_findings";
  const scopedJustifications = categoryConclusions
    .filter(conclusion => !hasProductScope || !selectedCategoryIds.size || selectedCategoryIds.has(conclusion.categoryId))
    .flatMap(conclusion => (conclusion.propensity?.evidence || []).map(fact => ({
      categoryId: conclusion.categoryId,
      category: conclusion.categoryName,
      product: conclusion.recommendedProducts?.[0]?.name || null,
      productRationale: conclusion.recommendedProducts?.[0]?.rationale || null,
      opportunity: conclusion.opportunities?.[0] || null,
      tier: conclusion.tier,
      score: conclusion.score,
      fact,
    })))
    .sort((a, b) =>
      Number(b.fact.kind === "purchase") - Number(a.fact.kind === "purchase")
      || b.fact.strength - a.fact.strength
      || new Date(b.fact.occurredAt).getTime() - new Date(a.fact.occurredAt).getTime()
    );

  return (
    <div className="min-h-[100dvh] bg-stone-50 flex flex-col font-sans">
      <DemoEngagementHistory companyId={Number(id)} />
      <IntentPageHeader
        title={account.name}
        subtitle={
          <div className="flex items-center gap-4 text-xs font-semibold text-stone-500">
            {account.domain && <a href={`https://${account.domain}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-stone-900 transition-colors"><ExternalLink className="w-3.5 h-3.5" /> {account.domain}</a>}
            <span className="flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5" /> {account.industry || "Unknown Industry"}</span>
          </div>
        }
        breadcrumbs={<Link href={intentListUrl} className="hover:text-stone-900 flex items-center gap-1 transition-colors"><ChevronLeft className="w-3.5 h-3.5" /> Command Center</Link>}
        stats={
          <div className="flex flex-wrap items-center gap-x-10 gap-y-4 py-1">
            <div className="flex items-center gap-3">
               <span className="text-[10px] font-black uppercase tracking-widest text-stone-400">Confirmed buying intent</span>
               <div className="flex items-center gap-2">
                  {analysis.data && !analysis.isError ? <><span className="text-2xl font-black tabular-nums leading-none text-stone-900 tracking-tighter">{accountStatusScore}</span><TierBadge tier={accountStatus} /></> : <span className="text-sm text-stone-500">{analysis.isError ? "Unavailable" : "Loading qualification…"}</span>}
                  {hasResearchOpportunity && <a href="#account-research-context" className="rounded border border-teal-200 bg-teal-50 px-2 py-1 text-[10px] font-bold text-teal-800">Needs validation →</a>}
                  {account.intentStatus?.accountFlag === "category_open" && <span className="rounded border border-violet-200 bg-violet-50 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-violet-700">Category open</span>}
               </div>
            </div>
            <div
              className="flex flex-col gap-1 border-l border-stone-200 pl-10"
              title={scoreBreakdown.isError ? `Additive score unavailable${scoreBreakdown.error?.message ? `: ${scoreBreakdown.error.message}` : ""}` : "Separate additive score; it may exceed 100"}
              data-testid="account-additive-score-header"
            >
              <span className="text-[9px] font-black uppercase tracking-widest text-emerald-700">Additive total</span>
              <span className="text-xl font-black tabular-nums leading-none text-emerald-800" data-testid="text-account-additive-total">
                {scoreBreakdown.isLoading ? "Loading…" : scoreBreakdown.isError ? "Unavailable" : scoreBreakdown.data?.total ?? "—"}
              </span>
            </div>
            <div className="flex flex-col gap-1 border-l border-stone-200 pl-10">
               <span className="text-[9px] font-black uppercase tracking-widest text-stone-400">Strongest Match</span>
               <span className="text-[12px] font-bold text-stone-800 max-w-[200px] truncate">{!analysis.data || analysis.isError ? (analysis.isError ? "Unavailable" : "Loading fit…") : validatedIntent && (["warm","hot"].includes(validatedIntentTier.toLowerCase()) || account.canonicalCategoryIntent?.source === "questionnaire" || account.canonicalCategoryIntent?.source === "lead_form") ? ("categoryName" in validatedIntent ? validatedIntent.categoryName : "productName" in validatedIntent ? validatedIntent.productName : validatedIntent.category) : "No validated fit"}</span>
            </div>
            {account.lastSignalAt && (
              <div className="flex flex-col gap-1 border-l border-stone-200 pl-10">
                 <span className="text-[9px] font-black uppercase tracking-widest text-stone-400">Last Active</span>
                 <span className="text-[12px] font-bold text-stone-800">{formatReportDate(account.lastSignalAt)}</span>
              </div>
            )}
            <div
              className="flex flex-col gap-1 border-l border-stone-200 pl-10 cursor-help"
              title={account.lastResearchedAt ? `Last monitored ${formatReportDateTime(account.lastResearchedAt)}` : "This account has not been monitored yet"}
            >
               <span className="text-[9px] font-black uppercase tracking-widest text-stone-400">Last Monitored</span>
                <span className="text-[12px] font-bold text-stone-800">{account.lastResearchedAt ? formatReportDate(account.lastResearchedAt) : "Not yet"}</span>
            </div>
            <div className="flex flex-col gap-1 border-l border-stone-200 pl-10">
               <span className="text-[9px] font-black uppercase tracking-widest text-stone-400">Signals</span>
               <span className="text-[12px] font-bold text-stone-800">{evidence.isError ? "Unavailable" : !evidence.data ? "Loading evidence…" : `${account.evidence?.public?.length || 0} external · ${account.evidence?.uploaded?.length || 0} internal`}</span>
            </div>
          </div>
        }
      />

      <AccountDetailSections researchStatus={<>
        {!monitoringContext.data && !monitoringContext.isError && <p role="status" className="mb-4 text-sm text-stone-500">Loading research opportunity context…</p>}
        {monitoringContext.isError && <p role="alert" className="mb-4 text-sm text-rose-700">Research opportunity context could not be loaded. <button className="underline" onClick={() => monitoringContext.refetch()}>Retry</button></p>}
      </>} topCards={<>
        {!!account.parentMonitoringContext?.length && <div className="mb-5">
          {!showParentResearch && <HpMonitoringContext contexts={account.parentMonitoringContext} clientId={scopeParams.clientId ? Number(scopeParams.clientId) : undefined} />}
          {showParentResearch ? <h3 className="mt-4 text-xs font-semibold text-stone-500">Parent organization research: {researchName} · separate from member-company qualification</h3>
            : !account.parentMonitoringContext.some(context => context.accountId === Number(id)) && <h3 className="mt-4 text-xs font-semibold text-stone-500">Separate member-company research: {account.name}</h3>}
        </div>}
        {showRetainedMember && <p className="mb-3 text-xs font-semibold text-stone-500">Retained member-company research: {researchName}. These sources have not been reassigned to the parent.</p>}
        <AccountResearchOpportunity key={`${id}-${researchName}`} name={researchName} context={researchContext} lastCheckedAt={researchCheckedAt}
          loading={(!monitoringContext.data && !monitoringContext.isError) || (parentResearchId != null && parentResearchId !== Number(id) && parentMonitoring.isLoading) || (!!retainedMember && retainedMemberMonitoring.isLoading)}
          unavailable={monitoringContext.isError && !showParentResearch} />
      </>}
      qualification={
        <AccountDetailPanel query={analysis} label="Canonical qualification">
        <section id="hotness-justification" className="mb-8 scroll-mt-6 overflow-hidden rounded-lg border border-emerald-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-emerald-100 bg-emerald-50/70 px-4 py-3">
            <div>
              <h2 className="flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-emerald-950">
                <Link2 className="h-3.5 w-3.5" /> Why confirmed buying intent is {accountStatus}
              </h2>
              <p className="mt-1 max-w-3xl text-[11px] font-medium leading-relaxed text-emerald-900/80">
                {hasResearchOpportunity && accountStatus === "cold" ? "No confirmed buying requirement has qualified yet. Relevant approved business activity is shown in the three research cards above; validate the need, owner and timing before qualifying it." : account.intentStatus?.accountExplanation || "No current approved evidence explains the account status."}
              </p>
            </div>
            <span className="rounded border border-emerald-200 bg-white px-2 py-1 text-[9px] font-black uppercase tracking-widest text-emerald-800">
              {account.intentStatus?.accountDrivingSignals?.length || 0} account driver{account.intentStatus?.accountDrivingSignals?.length === 1 ? "" : "s"}
            </span>
          </div>
          {account.intentStatus?.accountDrivingSignals?.length ? (
            <div className="grid grid-cols-1 gap-3 border-b border-stone-100 p-4 lg:grid-cols-2">
              {account.intentStatus.accountDrivingSignals.map((signal, index) => (
                <div key={`${signal.evidenceId}-${signal.signalType}-${index}`} className="rounded-lg border border-emerald-100 bg-emerald-50/30 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <FirstPartySourceButton accountId={id} scope={scopeParams} signal={signal} />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-stone-400">{formatReportDate(signal.occurredAt)} · {signal.strength}</span>
                  </div>
                  <p className="text-[11px] font-semibold leading-relaxed text-stone-700">“{signal.quote}”</p>
                  {signal.sourceUrl && <a href={signal.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold text-emerald-800 hover:underline">Open source <ExternalLink className="h-3 w-3" /></a>}
                </div>
              ))}
            </div>
          ) : (
            <div className="border-b border-stone-100 p-5 text-center">
              <p className="text-sm font-bold text-stone-800">No confirmed buying-intent driver is available yet</p>
              <p className="mx-auto mt-1 max-w-xl text-[11px] font-medium leading-relaxed text-stone-500">{hasResearchOpportunity ? "Relevant business context is available above. Validate the potential requirement before treating it as buying intent." : "The account should not be Hot unless a current explicit or high-probability signal is present."}</p>
            </div>
          )}
          <div className="p-4">
            <h3 className="mb-3 text-[10px] font-black uppercase tracking-widest text-stone-500">Why category status can differ</h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {(account.intentStatus?.categories || []).map(category => (
                <div key={category.key} className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[12px] font-black text-stone-900">{category.name}</p>
                      <p className="text-[9px] font-bold uppercase tracking-widest text-stone-400">{category.attribution.replace(/_/g, " ")} attribution</p>
                    </div>
                    <TierBadge tier={category.status} />
                  </div>
                  <p className="text-[11px] font-medium leading-relaxed text-stone-600">{category.statusReason}</p>
                  {category.drivingSignals[0] && <p className="mt-2 border-l-2 border-stone-300 pl-2 text-[10px] font-medium leading-relaxed text-stone-500">“{category.drivingSignals[0].quote}”</p>}
                  {category.drivingSignals[0]?.firstPartySource && <div className="mt-2">
                    <FirstPartySourceButton accountId={id} scope={scopeParams} signal={category.drivingSignals[0]} />
                  </div>}
                </div>
              ))}
            </div>
          </div>
        </section>
        </AccountDetailPanel>
      } newsSources={
        researchContext?.evidence?.length ? <section id="account-research-details" className="mb-6 scroll-mt-6 rounded-lg border border-stone-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-bold">Actual news excerpts &amp; source links · {researchName}</h2>
          <MonitoredResearchContext context={researchContext} detailed />
        </section> : null
      } additionalAnalysis={<>

        {questionnaire?.answerCount ? (
          <section className="mb-8 overflow-hidden rounded-lg border border-violet-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-violet-100 bg-violet-50 px-4 py-3">
              <div>
                <h2 className="flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-violet-900">
                  <ShieldCheck className="h-3.5 w-3.5" /> Questionnaire Analysis
                </h2>
                <p className="mt-1 text-[11px] font-medium text-violet-800">{questionnaire.interpretation}</p>
                <p className="mt-1 text-[10px] font-semibold text-violet-700">Product interest retains 85% of its remaining scoring value every 30 days (a 15% monthly reduction). Other answers keep their configured half-life.</p>
              </div>
              <div className="flex items-center gap-2">
                {questionnaire.declaredTier ? <TierBadge tier={questionnaire.declaredTier} /> : null}
                <span className="rounded border border-violet-200 bg-white px-2 py-1 text-[9px] font-black uppercase tracking-widest text-violet-700">
                  {questionnaire.answerCount} answer{questionnaire.answerCount === 1 ? "" : "s"}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
              {questionnaire.answers.map((answer, index) => (
                <div key={`${answer.field}-${index}`} className="rounded-md border border-stone-200 bg-stone-50/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[9px] font-black uppercase tracking-widest text-stone-500">{answer.field.replace(/_/g, " ")}</p>
                    <span className="shrink-0 text-[9px] font-black text-violet-700">{answer.strength}/100</span>
                  </div>
                  <p className="mt-1 text-[12px] font-bold leading-relaxed text-stone-900">{String(answer.value ?? "No answer")}</p>
                  {answer.reason ? <p className="mt-1 text-[10px] font-medium leading-relaxed text-stone-600">{answer.reason}</p> : null}
                   {answer.field === "product_interest" && answer.audit ? (
                     <div className="mt-3 grid grid-cols-2 gap-2 rounded border border-violet-100 bg-white p-2.5">
                       <div>
                         <p className="text-[8px] font-black uppercase tracking-widest text-stone-400">Original value</p>
                         <p className="text-[12px] font-black tabular-nums text-stone-900">{answer.audit.originalPoints} pts</p>
                       </div>
                       <div>
                         <p className="text-[8px] font-black uppercase tracking-widest text-violet-500">Retained now</p>
                         <p className="text-[12px] font-black tabular-nums text-violet-800">{answer.audit.currentPoints} pts · {Math.round(answer.audit.decayFactor * 100)}%</p>
                       </div>
                       <p className="col-span-2 text-[9px] font-semibold text-stone-500">
                         {answer.audit.ageDays} days old
                         {answer.audit.nextDecayAt ? ` · Next 30-day boundary ${formatReportDate(answer.audit.nextDecayAt)}` : ""}
                       </p>
                     </div>
                   ) : answer.audit ? (
                     <p className="mt-2 text-[9px] font-semibold text-stone-500">{answer.audit.decayRule} · {answer.audit.currentPoints} of {answer.audit.originalPoints} pts retained</p>
                   ) : null}
                  <p className="mt-2 text-[9px] font-bold uppercase tracking-wider text-stone-400">
                    {answer.productId ? "Applied to matched product" : "Account/category context"}
                  </p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <AccountDetailPanel query={evidence} label="Solution hypotheses">
        {!researchContext && hpSolutionFit ? (
          <section className="mb-8 overflow-hidden rounded-lg border border-blue-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 bg-blue-50 px-4 py-3">
              <div>
                <h2 className="flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-blue-950">
                    <Target className="h-3.5 w-3.5" /> HP Solution Hypotheses — Not Scored Intent
                </h2>
                <p className="mt-1 text-[11px] font-medium text-blue-800">
                  Exploratory matches for discovery only. They do not raise the intent score until a category-specific need or buying action is validated.
                </p>
              </div>
              <span className="rounded border border-blue-200 bg-white px-2 py-1 text-[9px] font-black uppercase tracking-widest text-blue-700">
                Client: {hpSolutionFit.clientName}
              </span>
            </div>
            {hpSolutionFit.recommendations.length ? (
              <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-2">
                {hpSolutionFit.recommendations.map((recommendation, index) => {
                  const FamilyIcon = recommendation.family === "Business PCs" ? Laptop : recommendation.family === "Commercial Printing" ? Printer : recommendation.family === "HP Poly" ? Headphones : BriefcaseBusiness;
                  return (
                    <article key={recommendation.name} className="rounded-lg border border-stone-200 bg-stone-50/60 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-2.5">
                          <div className="mt-0.5 rounded-md border border-blue-100 bg-blue-50 p-1.5 text-blue-700"><FamilyIcon className="h-4 w-4" /></div>
                          <div>
                            <p className="text-[9px] font-black uppercase tracking-widest text-stone-400">#{index + 1} · {recommendation.family}</p>
                            <h3 className="mt-0.5 text-[13px] font-bold leading-snug text-stone-900">{recommendation.name}</h3>
                          </div>
                        </div>
                        <div className="text-right">
                          <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest", recommendation.fit === "strong" ? "bg-emerald-100 text-emerald-800" : recommendation.fit === "moderate" ? "bg-amber-100 text-amber-800" : "bg-stone-200 text-stone-700")}>{recommendation.fit}</span>
                          <p className="mt-1 text-[10px] font-black tabular-nums text-blue-700">{recommendation.score} fit</p>
                        </div>
                      </div>
                      <p className="mt-3 text-[11px] font-medium leading-relaxed text-stone-600">{recommendation.rationale}</p>
                      <div className="mt-3 space-y-1.5 border-t border-stone-200 pt-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-stone-400">Signals behind this fit</p>
                        {recommendation.evidence.map(item => (
                          <p key={item.id} className="line-clamp-2 text-[10px] font-medium leading-relaxed text-stone-600">
                            <span className="font-black text-stone-400">•</span> {item.summary}
                          </p>
                        ))}
                      </div>
                      <a href={recommendation.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-blue-700 hover:text-blue-900">
                        View on HP <ExternalLink className="h-3 w-3" />
                      </a>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="p-6 text-center">
                <p className="text-sm font-bold text-stone-800">No defensible HP solution fit yet</p>
                <p className="mx-auto mt-1 max-w-xl text-[11px] font-medium leading-relaxed text-stone-500">The available signals do not identify a specific workforce, PC, print or collaboration need. Generic growth or funding alone will not generate an HP recommendation.</p>
              </div>
            )}
          </section>
        ) : null}

        </AccountDetailPanel>
        <AccountDetailPanel query={research} label="Research brief">
        {fullBrief?.categoryConclusions ? <CategoryPropensityAudit conclusions={fullBrief.categoryConclusions} /> : null}
        </AccountDetailPanel>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mb-8">
          <div className="md:col-span-7">
            <AccountDetailPanel query={research} label="Recommended play">
            <InfoCard title="Recommended Play" icon={Radio}>
              {brief ? (
                <div className="grid grid-cols-2 gap-4 h-full">
                  <div className="flex flex-col border-r border-stone-100 pr-4">
                    <span className="text-[9px] font-black uppercase tracking-widest text-stone-400 block mb-1.5">Entry Offer</span>
                    <p className="text-[13px] font-bold text-stone-900 leading-snug">{brief.entryOffer}</p>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[9px] font-black uppercase tracking-widest text-stone-400 block mb-1.5">Outreach Angle</span>
                    <p className="text-[12px] font-medium text-stone-600 line-clamp-3 leading-relaxed">{brief.outreachAngle}</p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-[11px] font-medium text-stone-400 italic">No actionable brief available.</p>
                </div>
              )}
            </InfoCard>
            </AccountDetailPanel>
          </div>

          <div className="md:col-span-5">
            <InfoCard title="Target Personas" icon={Users}>
              <AccountDetailPanel query={research} label="Target personas">
              {brief && brief.buyers.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {brief.buyers.map(b => (
                    <span key={b} className="bg-stone-50 border border-stone-200 text-stone-700 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider">{b}</span>
                  ))}
                </div>
              ) : (
                <span className="text-[10px] font-bold uppercase tracking-widest text-stone-400 mb-4 block">No specific personas</span>
              )}

              </AccountDetailPanel>
              <AccountDetailPanel query={evidence} label="Contact navigation">
              <div className="mt-auto border-t border-stone-100 pt-3 flex items-center justify-between">
                <span className="text-[9px] font-black uppercase tracking-widest text-stone-400 block">Active Contacts</span>
                {account.contacts?.length ? (
                  <div className="flex -space-x-1.5">
                    {account.contacts.slice(0, 4).map((c: any) => (
                      <Link href={`/intent/contacts/${c.id}${qs ? `?${qs}` : ""}`} key={c.id} className="w-6 h-6 rounded-full bg-emerald-100 border-2 border-white flex items-center justify-center text-[9px] font-black text-emerald-800 relative z-10 hover:z-20 hover:scale-110 transition-transform shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" title={`Open ${c.name}`}>
                        {c.name.charAt(0)}
                      </Link>
                    ))}
                    {account.contacts.length > 4 && (
                      <div className="w-6 h-6 rounded-full bg-stone-100 border-2 border-white flex items-center justify-center text-[9px] font-black text-stone-600 relative z-0 shadow-sm">
                        +{account.contacts.length - 4}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-[10px] font-medium text-stone-400 italic">{evidence.isError ? "Contacts unavailable" : !evidence.data ? "Loading contacts…" : "None tracked"}</span>
                )}
              </div>
              </AccountDetailPanel>
            </InfoCard>
          </div>
        </div>

        {/* EVIDENCE AREA */}
        {user?.role === "admin" && <ResearchAttributionQueue accountId={Number(id)} />}
        {user?.role === "admin" && <ResearchCorrections key={id} accountId={Number(id)} />}
      </>} signalFeed={
        <div id="evidence" className="scroll-mt-6 border-t border-stone-200 pt-8 mt-4">
          <div className="flex items-center justify-between gap-4 mb-6">
            <div className="flex items-center gap-2">
              <Radio className="w-5 h-5 text-emerald-600" />
              <h2 className="text-lg font-black text-stone-900 tracking-tight">Signal & Evidence Feed</h2>
            </div>

            {(account.researchIntent?.pendingCount || 0) > 0 && (
              <div className="bg-stone-50 border border-stone-200 rounded-lg px-4 py-2 flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="text-[11px] font-medium text-stone-700"><strong>{account.researchIntent!.pendingCount} signal{account.researchIntent!.pendingCount === 1 ? "" : "s"} queued</strong> · automatic synthesis will approve or reject these; no manual approval is required</span>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">

              {/* Research Synthesis injected as a top "Signal" */}
              <AccountDetailPanel query={research} label="Research synthesis">
              {brief && !researchContext && (
                <div className="mb-8 rounded-xl border border-stone-200 bg-white shadow-sm overflow-hidden flex flex-col">
                  <div className="px-5 py-4 border-b border-stone-100 flex items-center justify-between bg-stone-50/50">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-emerald-100 flex items-center justify-center text-emerald-700 border border-emerald-200/50 shadow-sm">
                        <Lightbulb className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="text-[13px] font-black text-stone-900 uppercase tracking-widest leading-none">AI Research Synthesis</h3>
                        <p className="text-[10px] font-bold text-stone-500 mt-0.5">Opportunity Brief</p>
                      </div>
                    </div>
                  </div>

                  <div className="p-0">
                    <div className="p-5 pb-6 border-b border-stone-100 bg-white">
                      <h4 className="text-[9px] font-black uppercase tracking-widest text-emerald-700 mb-2 flex items-center gap-1.5"><Radio className="w-3.5 h-3.5" /> Full Context (Why Now)</h4>
                      {whyNowPoints.length ? (
                        <ul className="space-y-2.5">
                          {whyNowPoints.map((point, index) => (
                            <li key={`${index}-${point.slice(0, 24)}`} className="flex items-start gap-2.5 text-[13px] font-semibold leading-relaxed text-stone-800">
                              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                              <span>{point}</span>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="text-[13px] font-semibold leading-relaxed text-stone-800">{brief.whyNow}</p>}
                      {whyNowPoints.length > 1 ? (
                        <details className="mt-4 border-t border-stone-100 pt-3">
                          <summary className="cursor-pointer text-[9px] font-black uppercase tracking-widest text-stone-500 hover:text-emerald-700">View original synthesis</summary>
                          <p className="mt-2 text-[11px] font-medium leading-relaxed text-stone-600">{brief.whyNow}</p>
                        </details>
                      ) : null}
                    </div>

                    {brief.solutions?.length > 0 && (
                      <div className="p-5 bg-stone-50/30">
                        <h4 className="text-[9px] font-black uppercase tracking-widest text-emerald-700 mb-3 flex items-center gap-1.5"><Laptop className="w-3.5 h-3.5" /> Evidence-Backed Solutions</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {brief.solutions.map((sol, i) => (
                            <div key={i} className="bg-white border border-stone-200 rounded-lg p-3.5 shadow-sm hover:border-emerald-200 hover:shadow transition-all group relative overflow-hidden">
                              <div className="absolute top-0 right-0 bg-stone-50 text-stone-500 border-l border-b border-stone-100 px-2 py-1 rounded-bl text-[8px] font-black uppercase tracking-widest group-hover:bg-emerald-50 group-hover:text-emerald-700 group-hover:border-emerald-100 transition-colors">
                                Pri {sol.priority}
                              </div>
                              <h5 className="font-bold text-[12px] text-stone-900 mb-2 pr-12 group-hover:text-emerald-800 transition-colors">{sol.name}</h5>
                              <p className="text-[11px] font-medium text-stone-600 leading-relaxed">{sol.rationale}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {brief.caution && (
                      <div className="p-4 bg-amber-50/50 border-t border-amber-100">
                        <div className="flex items-start gap-3">
                          <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center shrink-0 border border-amber-200/50">
                            <AlertCircle className="w-3.5 h-3.5 text-amber-700" />
                          </div>
                          <div>
                            <span className="text-[9px] font-black uppercase tracking-widest text-amber-800 block mb-0.5">Use with care</span>
                            <p className="text-[11px] font-semibold text-amber-900/80 leading-relaxed">{brief.caution}</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              </AccountDetailPanel>
              <AccountDetailPanel query={analysis} label="HP category intent">
              <div className="mb-8 rounded-xl border border-stone-200 bg-white shadow-sm overflow-hidden flex flex-col">
                  <div className="px-5 py-4 border-b border-stone-100 flex items-center justify-between bg-stone-50/50">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-sky-100 flex items-center justify-center text-sky-700 border border-sky-200/50 shadow-sm">
                        <Target className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="text-[13px] font-black text-stone-900 uppercase tracking-widest leading-none">HP Category Intent</h3>
                        <p className="text-[10px] font-bold text-stone-500 mt-0.5">Account opportunity across four HP solution categories</p>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-5 bg-white">
                     {hpCategoryInsights.map(category => (
                       <div key={category.key} className="bg-stone-50/50 border border-stone-100 rounded-lg p-4 hover:border-sky-200 hover:bg-sky-50/30 transition-colors">
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div>
                             <p className="text-[13px] font-bold text-stone-900">{category.name}</p>
                             <p className="text-[10px] font-medium text-stone-500 mt-0.5">{category.drivingSignals.length} driving signal{category.drivingSignals.length === 1 ? "" : "s"} · {category.attribution.replace(/_/g, " ")}</p>
                          </div>
                          <span className={cn(
                            "text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded border",
                             category.status === "hot" ? "bg-rose-50 text-rose-700 border-rose-100" :
                             category.status === "warm" ? "bg-amber-50 text-amber-800 border-amber-100" : "bg-stone-100 text-stone-600 border-stone-200"
                          )}>
                             {category.status}
                          </span>
                        </div>
                          <p className="text-[11px] font-medium text-stone-700 leading-relaxed mt-2">{category.statusReason}</p>
                         <p className="text-[11px] font-semibold text-stone-700 leading-relaxed mt-2">{category.nextPlay}</p>
                         {category.drivingSignals[0] && <p className="mt-3 line-clamp-3 rounded border border-sky-100 bg-white p-2.5 text-[10px] font-medium leading-relaxed text-stone-600">“{category.drivingSignals[0].quote}”</p>}
                          {category.expiresAt && <p className="mt-2 text-[9px] font-bold uppercase tracking-widest text-stone-400">Expires {formatReportDate(category.expiresAt)}</p>}
                      </div>
                    ))}
                  </div>
                </div>

              </AccountDetailPanel>
              <AccountDetailPanel query={evidence} label="Supporting evidence">
              {hasSignals ? (
                <div className="space-y-8">
                  <SignalGroup title={hasProductScope ? "Selected Product Questionnaires & Uploads" : "Questionnaires, Feedback & Admin Uploads"} evidence={priorityUploaded} />
                  <SignalGroup title={hasProductScope ? "Selected Product Signals" : "Public Signals"} evidence={priorityPub} />
                  <SignalGroup title="Company Activity" evidence={company} />
                  <SignalGroup title="Contact Activity" evidence={contact} />
                  <SignalGroup title="Other Category Signals" evidence={otherEvidence} />
                </div>
              ) : (
                !brief && (
                  <p className="text-[13px] font-medium text-stone-500 italic p-8 text-center bg-white rounded-lg border border-stone-200 shadow-sm">
                    No raw evidence records found for this account.
                  </p>
                )
              )}

              {!!account.excludedHistoricalSignals?.count && (
                <div className="rounded-lg border border-stone-200 bg-white p-4 flex items-start gap-3 mt-8">
                  <AlertCircle className="w-4 h-4 text-stone-400 shrink-0 mt-0.5" />
                  <div className="text-[11px] font-medium text-stone-600 leading-relaxed">
                    <span className="font-bold text-stone-900">{account.excludedHistoricalSignals.count} older signal{account.excludedHistoricalSignals.count === 1 ? "" : "s"} retained for history.</span>
                    {" "}Latest is from {account.excludedHistoricalSignals.latestAt ? formatReportDate(account.excludedHistoricalSignals.latestAt) : "before current window"}. Records do not affect the rolling 3-month analysis.
                  </div>
                </div>
              )}
              </AccountDetailPanel>
            </div>

            <div className="space-y-6">
              <AccountDetailPanel query={evidence} label="Score movement">
              <SidebarWidget title="Score Movement" icon={TrendingUp}>
                <div className="p-4 h-[180px]">
                  {chartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                        <XAxis dataKey="date" tick={{ fontSize: 9, fontWeight: 700, fill: '#a8a29e' }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 9, fontWeight: 700, fill: '#a8a29e' }} axisLine={false} tickLine={false} />
                        <Tooltip contentStyle={{ borderRadius: '6px', border: '1px solid #e7e5e4', fontSize: '11px', fontWeight: 600, padding: '4px 8px' }} />
                        <Line type="monotone" dataKey="score" stroke="#059669" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] font-bold uppercase tracking-widest text-stone-400">Not enough data</div>
                  )}
                </div>
              </SidebarWidget>

              </AccountDetailPanel>
              <AccountDetailPanel query={analysis} label="Category propensity">
              <AccountDetailPanel query={research} label="Category research">
              <SidebarWidget title="Category Propensity" icon={Target}>
                {categoryInsights.length ? (
                  <div className="divide-y divide-stone-100">
                    {categoryInsights.map(category => {
                      const conclusion = fullBrief?.categoryConclusions?.find(c => c.categoryName.toLowerCase() === category.category.toLowerCase());
                      const propensity = conclusion?.propensity;
                      const confidence = propensity ? Math.round(propensity.dataConfidence * 100) : null;
                      const hasPurchase = propensity?.hasRecentPurchaseSignal;

                      return (
                      <div key={category.category} className="p-4 hover:bg-stone-50/50 transition-colors">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[12px] font-bold text-stone-900 flex items-center gap-1.5">
                            {category.category}
                            {hasProductScope && category.inSelectedScope ? (
                              <span className="text-[8px] font-black uppercase tracking-widest text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100/50">Selected</span>
                            ) : null}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {category.tier ? (
                               <span className={cn(
                                 "text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded",
                                  category.tier === "hot" ? "bg-rose-50 text-rose-700 border border-rose-100" :
                                  category.tier === "warm" ? "bg-amber-50 text-amber-700 border border-amber-100" :
                                 "bg-stone-100 text-stone-600 border border-stone-200"
                               )}>{category.tier}</span>
                            ) : null}
                            <span className="text-[11px] font-black text-emerald-700">{category.score > 0 ? `${category.score} pts` : "Context"}</span>
                          </div>
                        </div>

                        <p className="text-[11px] font-medium text-stone-600 leading-relaxed mb-3">{category.explanation}</p>

                        {propensity && (
                          <div className="grid grid-cols-2 gap-2 mt-2">
                            <div className="bg-stone-50 border border-stone-200 rounded p-2 flex flex-col justify-between">
                              <span className="text-[8px] font-black uppercase tracking-widest text-stone-500 mb-1 block">Data Confidence</span>
                              <span className="text-[11px] font-bold text-stone-800">{confidence}%</span>
                            </div>
                            <div className={cn("border rounded p-2 flex flex-col justify-between", hasPurchase ? "bg-emerald-50 border-emerald-200" : "bg-stone-50 border-stone-200")}>
                              <span className={cn("text-[8px] font-black uppercase tracking-widest mb-1 block", hasPurchase ? "text-emerald-700" : "text-stone-500")}>Purchase Evidence</span>
                              <div className="flex items-center gap-1">
                                {hasPurchase ? <CheckCircle2 className="w-3 h-3 text-emerald-600" /> : <AlertCircle className="w-3 h-3 text-stone-400" />}
                                <span className={cn("text-[11px] font-bold", hasPurchase ? "text-emerald-800" : "text-stone-600")}>{hasPurchase ? "Confirmed" : "None"}</span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )})}
                  </div>
                ) : (
                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone-400 text-center py-6">No categories</p>
                )}
              </SidebarWidget>

              </AccountDetailPanel>
              </AccountDetailPanel>
              <AccountDetailPanel query={analysis} label="Score factors">
              <SidebarWidget title="Score Factors" icon={Activity}>
                <div className="divide-y divide-stone-100 max-h-[300px] overflow-y-auto">
                  {contributions.length === 0 ? (
                    <div className="p-6 text-[10px] font-bold uppercase tracking-widest text-center text-stone-400">No active factors</div>
                  ) : (
                    contributions.map((c: any, i: number) => (
                      <div key={i} className="p-4 hover:bg-stone-50/50 transition-colors flex items-start justify-between gap-3">
                        <div>
                          <p className="font-bold text-[11px] text-stone-900 leading-tight">{c.label}</p>
                          <p className="text-[9px] font-medium text-stone-500 mt-1">{c.reason}</p>
                        </div>
                        <span className="font-black tabular-nums text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100 text-[10px] shrink-0">+{c.points}</span>
                      </div>
                    ))
                  )}
                </div>
              </SidebarWidget>

              </AccountDetailPanel>
              <SidebarWidget title="Additive Score Breakdown" icon={Calculator}>
                <div className="p-3">
                  <p className="mb-3 text-[10px] font-medium leading-relaxed text-stone-500">
                    This additive total is separate from the validated 0–100 intent score and may exceed 100.
                  </p>
                  {scoreBreakdown.isLoading ? (
                    <div className="space-y-2" aria-label="Loading additive score breakdown">
                      <Skeleton className="h-9 w-full" />
                      <Skeleton className="h-16 w-full" />
                    </div>
                  ) : scoreBreakdown.isError ? (
                    <p role="alert" className="rounded border border-rose-100 bg-rose-50 p-3 text-[10px] font-semibold leading-relaxed text-rose-700">
                      Failed to load additive score breakdown{scoreBreakdown.error?.message ? `: ${scoreBreakdown.error.message}` : "."}
                      {" "}<button className="underline" onClick={() => void scoreBreakdown.refetch()}>Retry additive score</button>
                    </p>
                  ) : scoreBreakdown.data ? (
                    <>
                      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                        <div className="flex items-end justify-between gap-2">
                          <div>
                            <p className="text-[9px] font-black uppercase tracking-widest text-emerald-800">Additive total</p>
                            <p className="mt-0.5 text-2xl font-black tabular-nums leading-none text-emerald-900" data-testid="text-additive-account-total">{scoreBreakdown.data.total}</p>
                          </div>
                          <p className="text-right text-[9px] font-bold leading-relaxed text-emerald-800">
                            {scoreBreakdown.data.contactPoints} contact pts<br />
                            + {scoreBreakdown.data.accountSignalPoints} account-signal pts
                          </p>
                        </div>
                        <p className="mt-2 border-t border-emerald-200 pt-2 text-[9px] font-bold text-emerald-800">
                          Contact points + account-signal points = additive total
                        </p>
                      </div>

                      {scoreBreakdown.data.contacts.length ? (
                        <div className="mt-3">
                          <p className="mb-1.5 text-[9px] font-black uppercase tracking-widest text-stone-500">Contact contributions</p>
                          <div className="divide-y divide-stone-100 overflow-hidden rounded-md border border-stone-200">
                            {scoreBreakdown.data.contacts.map(contact => (
                              <Link
                                key={contact.id}
                                href={`/intent/contacts/${contact.id}${qs ? `?${qs}` : ""}`}
                                className="block p-2.5 transition-colors hover:bg-stone-50"
                                data-testid={`link-additive-contact-${contact.id}`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate text-[11px] font-bold text-stone-800">{contact.name}</span>
                                  <span className="shrink-0 text-[11px] font-black tabular-nums text-emerald-700">+{contact.total}</span>
                                </div>
                                <p className="mt-1 text-[9px] font-medium text-stone-500">
                                  Journey {contact.journeyPoints} + affinity {contact.affinityPoints}
                                </p>
                                {!!contact.affinities.length && (
                                  <div className="mt-1.5 flex flex-wrap gap-1">
                                    {contact.affinities.map(affinity => (
                                      <span key={affinity} className="rounded bg-stone-100 px-1.5 py-0.5 text-[8px] font-bold text-stone-600">{affinity}</span>
                                    ))}
                                  </div>
                                )}
                              </Link>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="mt-3 rounded border border-dashed border-stone-200 p-2.5 text-center text-[9px] font-medium text-stone-400">No contact contributions.</p>
                      )}

                      {scoreBreakdown.data.signals.length ? (
                        <div className="mt-3">
                          <p className="mb-1.5 text-[9px] font-black uppercase tracking-widest text-stone-500">Account signal reasons</p>
                          <div className="max-h-[250px] space-y-2 overflow-y-auto">
                            {scoreBreakdown.data.signals.map(signal => {
                              const sourceUrl = safeHttpUrl(signal.sourceUrl || undefined);
                              return (
                                <article key={signal.evidenceId} className="rounded-md border border-stone-200 bg-white p-2.5" data-testid={`card-additive-signal-${signal.evidenceId}`}>
                                  <div className="flex items-start justify-between gap-2">
                                    <p className="text-[9px] font-black uppercase tracking-wider text-stone-500">{signal.eventType.replace(/_/g, " ")}</p>
                                    <span className="shrink-0 rounded border border-emerald-100 bg-emerald-50 px-1.5 py-0.5 text-[9px] font-black tabular-nums text-emerald-700">+{signal.points}</span>
                                  </div>
                                  {(signal.category || signal.productName) && (
                                    <p className="mt-1 text-[9px] font-bold text-stone-500">{[signal.category, signal.productName].filter(Boolean).join(" · ")}</p>
                                  )}
                                  <p className="mt-1 text-[10px] font-medium leading-relaxed text-stone-700">{signal.reason}</p>
                                  <div className="mt-1.5 flex items-center justify-between gap-2">
                                    <time className="text-[8px] font-bold text-stone-400">{formatReportDate(signal.occurredAt)}</time>
                                    {sourceUrl && (
                                      <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[8px] font-black uppercase tracking-wider text-emerald-700 hover:text-emerald-900">
                                        Source <ExternalLink className="h-2.5 w-2.5" />
                                      </a>
                                    )}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <p className="mt-3 rounded border border-dashed border-stone-200 p-2.5 text-center text-[9px] font-medium text-stone-400">No account signal points.</p>
                      )}
                    </>
                  ) : (
                    <p className="rounded border border-dashed border-stone-200 p-3 text-center text-[10px] font-medium text-stone-400">No additive score breakdown is available.</p>
                  )}
                </div>
              </SidebarWidget>

              <AccountDetailPanel query={evidence} label="Active contacts">
              <SidebarWidget title="Active Contacts" icon={Users}>
                <div className="divide-y divide-stone-100 max-h-[300px] overflow-y-auto">
                  {(account.contacts || []).map((c: any) => (
                    <Link key={c.id} href={`/intent/contacts/${c.id}${qs ? `?${qs}` : ''}`} className="flex items-center gap-3 p-3 hover:bg-stone-50 transition-colors group block">
                      <div className="w-8 h-8 rounded-full bg-stone-100 text-stone-600 flex items-center justify-center text-[10px] font-black shrink-0 border border-stone-200">
                        {c.name[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-bold text-stone-900 group-hover:text-emerald-700 truncate transition-colors">{c.name}</p>
                        <p className="text-[10px] font-medium text-stone-500 truncate">{c.title}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[12px] font-black tabular-nums text-stone-900">{c.score}</p>
                      </div>
                    </Link>
                  ))}
                  {(account.contacts || []).length === 0 && (
                    <p className="p-5 text-[10px] font-bold uppercase tracking-widest text-center text-stone-400">No active contacts</p>
                  )}
                </div>
              </SidebarWidget>
              </AccountDetailPanel>
            </div>
          </div>
        </div>
      } />
    </div>
  );
}
