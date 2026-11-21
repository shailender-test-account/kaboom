import type { ListMonitoredAccounts200ItemsItemResearchContext } from "@workspace/api-client-react";
import { BusinessDirectionBullets, HpTakeawayBullets, ResearchSources } from "./HpResearchTakeaways";
import ResearchQuality from "./ResearchQuality";

export default function MonitoredResearchContext({ context, detailed = false, sourcePage = "" }: {
  context: ListMonitoredAccounts200ItemsItemResearchContext; detailed?: boolean; sourcePage?: string;
}) {
  const active = context.kind !== "no_recent_findings";
  // The footer owns source excerpts, not a second copy of the summary.
  if (detailed) return <ResearchSources sources={context.evidence} />;
  return <div className="mt-3 space-y-3">
    <ResearchQuality diagnostics={context.diagnostics} />
    {!active && <p className="text-xs text-slate-500">{context.label}</p>}
    <BusinessDirectionBullets directions={context.businessDirections} sources={context.evidence} sourcePage={sourcePage} />
    {context.takeaways !== undefined
      ? <section aria-label="Potential HP fit and pitch" className="space-y-2"><h5 className="text-xs font-semibold">Potential HP fit &amp; pitch · hypotheses</h5>
        <HpTakeawayBullets takeaways={context.takeaways} sources={context.evidence} sourcePage={sourcePage} validationSummary={context.validationSummary} /></section>
      : <ul className="list-disc space-y-2 pl-4 text-xs leading-relaxed text-slate-700">
        {(context.analysisPoints?.length ? context.analysisPoints : [context.summary]).slice(0, 3).map(point => <li key={point}>{point}</li>)}
      </ul>}
    <details className="text-[11px] leading-relaxed text-slate-500"><summary className="cursor-pointer">Research limitations</summary>{context.caution}</details>
  </div>;
}
