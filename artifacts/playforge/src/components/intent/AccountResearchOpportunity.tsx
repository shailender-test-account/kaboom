import { useState } from "react";
import type { ListMonitoredAccounts200ItemsItemResearchContext } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BusinessDirectionBullets } from "./HpResearchTakeaways";
import { formatReportDate } from "@/lib/reportTime";
import ResearchQuality from "./ResearchQuality";

export default function AccountResearchOpportunity({ name, context, loading = false, unavailable = false, lastCheckedAt }: {
  name: string; context?: ListMonitoredAccounts200ItemsItemResearchContext; loading?: boolean; unavailable?: boolean; lastCheckedAt?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const evidence = context?.evidence ?? [];
  const seen = new Set<string>();
  const seenUrls = new Set<string>();
  const news = evidence.filter(source => {
    const key = source.summary.trim().toLowerCase();
    if (!key || seen.has(key) || (source.sourceUrl && seenUrls.has(source.sourceUrl))) return false;
    seen.add(key);
    if (source.sourceUrl) seenUrls.add(source.sourceUrl);
    return true;
  }).slice(0, 3);
  const pendingMessage = loading ? "Loading account research…" : unavailable ? "Account research is unavailable. Use Retry above." : null;
  const assessed=evidence.filter(source=>source.analysisNote).length;
  const directions = context?.businessDirections?.length ? context.businessDirections : evidence.flatMap(source => source.businessDirections ?? []);
  const assessments = evidence.filter(source => source.analysisNote?.trim());
  const fallbackPoints = context?.analysisPoints?.filter(point => point.trim()) ?? [];
  const diagnostics = context?.diagnostics;

  return <section id="account-research-context" data-testid="account-research-summary" className="mb-6 scroll-mt-6">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-black text-stone-900">Latest account research</h2>
      {context && context.kind !== "no_recent_findings" && <Button size="sm" onClick={() => setOpen(true)}>Validate needs</Button>}
    </div>
    {!pendingMessage && evidence.length>0 && <p className="mb-3 text-[11px] text-stone-500">
      Deep analysis: {assessed}/{evidence.length} source articles assessed. Open each source excerpt below for its interpretation, HP entry pitch and limitations.
      {assessed<evidence.length ? " Remaining source analyses are pending; a missing interpretation is not a no-fit finding." : ""}
    </p>}
    {!pendingMessage && lastCheckedAt && <p className="mb-3 text-xs text-stone-600" data-testid="research-completion-status">
      Last completed monitoring: {formatReportDate(lastCheckedAt)}. {news.length ? `${evidence.length} usable saved source${evidence.length === 1 ? "" : "s"} available below.` : "The check completed, but no usable account-specific news is available in these stored results. Completion does not guarantee relevant news."}
    </p>}
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <article aria-label="Key News" className="min-w-0 rounded-lg border border-sky-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-xs font-black uppercase tracking-wide text-sky-900">1. Key News</h3>
        {pendingMessage ? <p className="text-xs text-stone-500">{pendingMessage}</p> : news.length ? <ul className="list-disc space-y-3 pl-4 text-xs leading-relaxed text-stone-700">{news.map(source =>
          <li key={source.id}>
            <span>{source.summary.trim().slice(0, 175)}{source.summary.trim().length > 175 ? "…" : ""}</span>
            <span className="mt-1 block text-[11px] text-stone-500">{source.publishedAt ? `Published ${formatReportDate(source.publishedAt)}` : "Publication date unverified"} · <a href={`#research-source-${source.id}`} className="font-semibold text-blue-700 underline">Read excerpt [{evidence.findIndex(item => item.id === source.id) + 1}]</a></span>
          </li>)}</ul> : <p className="text-xs text-stone-600">No recent, validated account-specific news is available.</p>}
        {!pendingMessage && !news.length && diagnostics && diagnostics.assessedCount > 0 && <div className="mt-2 space-y-1 text-xs text-stone-600">
          <p>{diagnostics.assessedCount} saved findings assessed; {diagnostics.excludedCount} excluded.</p>
          <ul className="list-disc pl-4">{diagnostics.exclusions.filter(reason => reason.count > 0).slice(0, 3).map(reason =>
            <li key={reason.reason}>{reason.label}: {reason.count}</li>)}</ul>
          <p>Review account identity, geography and the research-quality details below before running another check.</p>
        </div>}
      </article>
      <article aria-label="Key Interpretation of News" className="min-w-0 rounded-lg border border-teal-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-xs font-black uppercase tracking-wide text-teal-900">2. Key Interpretation of News</h3>
        {pendingMessage ? <p className="text-xs text-stone-500">{pendingMessage}</p> : directions.length
          ? <BusinessDirectionBullets directions={directions} sources={evidence} />
          : news.length ? <div className="space-y-3 text-xs leading-relaxed text-stone-700">
            {assessments.length ? assessments.map(source => <p key={source.id}>{source.analysisNote} <a href={`#research-source-${source.id}`} className="font-semibold text-blue-700 underline">Read assessment source [{evidence.findIndex(item => item.id === source.id) + 1}]</a></p>)
              : fallbackPoints.length ? <ul className="list-disc space-y-2 pl-4">{fallbackPoints.map(point => <li key={point}>{point}</li>)}</ul>
              : <p>{context?.summary}</p>}
            {!assessments.length && <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">Source news is available, but its deeper interpretation has not been saved yet. This is pending analysis, not a finding of no business direction.</p>}
          </div> : <div className="space-y-2 text-xs text-stone-600">
            <p>No usable account-specific news is available to interpret from these stored results.</p>
            <p>{context ? context.summary : "No saved research assessment is available yet."}</p>
            <p>Unrelated or excluded findings are not used to invent an interpretation. Buying qualification is unchanged.</p>
          </div>}
      </article>
    </div>
    {!pendingMessage && <div className="mt-3"><ResearchQuality diagnostics={context?.diagnostics} /></div>}
    {context && context.kind !== "no_recent_findings" && <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Validate needs · {name}</DialogTitle>
          <DialogDescription>Use this discovery guide with the account owner. Opening this guide does not qualify the account or change scores.</DialogDescription>
        </DialogHeader>
        <p className="text-sm font-semibold">{context.summary}</p>
        <p className="text-sm">{context.nextAction}</p>
        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>Identify the operational and procurement owners; a quoted executive is not automatically the buyer.</li>
          <li>{context.kind === "expansion" ? "Confirm the site opening and fit-out timeline." : "Confirm whether the event creates a requirement for this account in the selected country."}</li>
          <li>Ask which devices, meeting rooms or support services are actually required; do not assume all possible needs apply.</li>
          <li>Validate user counts, room counts, existing suppliers, budget and procurement stage.</li>
          <li>Record confirmed requirements through the existing lead-response or research-review process before changing qualification.</li>
        </ol>
        <p className="text-xs text-stone-500">Discovery guide only—nothing is saved, no outreach is sent, and no buying intent is declared.</p>
        <Button variant="outline" onClick={() => setOpen(false)}>Close guide</Button>
      </DialogContent>
    </Dialog>}
  </section>;
}
