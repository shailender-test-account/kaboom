import { useEffect } from "react";
import type { HpResearchTakeaway, MonitoringBusinessDirection } from "@workspace/api-client-react";
import { formatReportDate } from "@/lib/reportTime";

export type ResearchSource = {
  id: number; summary: string; sourceUrl: string | null; occurredAt: string; publishedAt?: string | null;
  businessDirections?: MonitoringBusinessDirection[]; takeaways?: HpResearchTakeaway[]; analysisNote?: string | null;
};

function Citations({ ids, sources, prefix, page, label }: { ids: number[]; sources: ResearchSource[]; prefix: string; page: string; label: string }) {
  return <>{[...new Set(ids)].filter(id => sources.some(source => source.id === id)).map(id =>
    <a key={id} href={`${page}#${prefix}-${id}`} aria-label={`Read source excerpt ${id} for ${label}`} className="font-semibold text-blue-700 underline">[{sources.findIndex(source => source.id === id) + 1}] </a>)}</>;
}

export function BusinessDirectionBullets({ directions = [], sources = [], sourcePrefix = "research-source", sourcePage = "" }: {
  directions?: MonitoringBusinessDirection[]; sources?: ResearchSource[]; sourcePrefix?: string; sourcePage?: string;
}) {
  const byTheme=new Map<string,MonitoringBusinessDirection>();
  for(const point of directions)if(!byTheme.has(point.theme))byTheme.set(point.theme,point);
  const distinct = [...byTheme.values()].slice(0, 3);
  return <section aria-label="Business signals and likely direction" className="space-y-2">
    <h5 className="text-xs font-semibold">Business signals &amp; likely direction</h5>
    {!distinct.length ? <p className="text-xs text-slate-600">Available sources do not yet establish a specific near-term business direction.</p>
      : <ul className="list-disc space-y-2 pl-4 text-xs leading-relaxed text-slate-700">{distinct.map(point => <li key={point.theme}>
        <strong>{point.theme}:</strong> {point.signal} <Citations ids={point.evidenceIds} sources={sources} prefix={sourcePrefix} page={sourcePage} label={point.theme} />
        <p><strong>Possible direction:</strong> {point.direction}</p>
      </li>)}</ul>}
  </section>;
}

export function HpTakeawayBullets({ takeaways = [], sources = [], sourcePrefix = "research-source", sourcePage = "", validationSummary }: {
  takeaways?: HpResearchTakeaway[]; sources?: ResearchSource[]; sourcePrefix?: string; sourcePage?: string; validationSummary?: string | null;
}) {
  if (!takeaways.length) return <p className="text-xs text-slate-600">No source-backed HP product recommendation is established by the available research. Validate a local operational requirement before proposing a solution.</p>;
  const distinct = [...new Map(takeaways.map(point => [`${point.category}:${point.product}`, point])).values()].slice(0, 4);
  return <><ul className="list-disc space-y-3 pl-4 text-xs leading-relaxed text-slate-700">
    {distinct.map(point => <li key={`${point.category}:${point.product}`}>
      <strong>{point.category} · {point.product}</strong>
      <p><strong>Why it may fit:</strong> {point.takeaway} <Citations ids={point.evidenceIds} sources={sources} prefix={sourcePrefix} page={sourcePage} label={point.category} /></p>
      {point.pitch && <p><strong>Pitch:</strong> {point.pitch}</p>}
      <p><strong>Validate:</strong> {point.recommendation}</p>
      {!!point.supportingSources?.length && <details className="mt-1">
        <summary className="cursor-pointer text-blue-700">Supporting context &amp; excerpts</summary>
        {point.supportingSources.filter(source => /^https?:\/\//i.test(source.url)).map(source =>
          <blockquote key={source.url} className="mt-2 border-l-2 border-slate-200 pl-2">
            <p>{source.quote}</p>
            <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">Read original source</a>
          </blockquote>)}
      </details>}
    </li>)}
  </ul>{validationSummary && <p className="text-[11px] leading-relaxed text-slate-500">{validationSummary}</p>}</>;
}

export function ResearchSources({ sources = [], sourcePrefix = "research-source" }: {
  sources?: ResearchSource[]; sourcePrefix?: string;
}) {
  useEffect(() => {
    const target = window.location.hash.slice(1);
    if (target && (target.startsWith(`${sourcePrefix}-`) || target === "account-research-details")) {
      document.getElementById(target)?.scrollIntoView?.({ block: "start" });
    }
  }, [sources, sourcePrefix]);
  if (!sources.length) return null;
  return <section className="space-y-3 border-t border-slate-200 pt-3 text-xs text-slate-600" aria-label="Monitoring source excerpts">
    <h5 className="font-semibold">Supporting excerpts &amp; original sources</h5>
    {sources.map((source, index) => <div key={source.id} id={`${sourcePrefix}-${source.id}`} tabIndex={-1} className="scroll-mt-6 rounded border border-slate-200 p-3 focus:outline-blue-600">
      <strong>[{index + 1}] {source.publishedAt ? `Published ${formatReportDate(source.publishedAt)}` : `Publication date unverified · recorded ${formatReportDate(source.occurredAt)}`}</strong>
      <blockquote className="my-2 whitespace-pre-line">{source.summary}</blockquote>
      {source.sourceUrl && /^https?:\/\//i.test(source.sourceUrl) && <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-blue-700 underline">Open original source</a>}
      {(!!source.businessDirections?.length || !!source.takeaways?.length || !!source.analysisNote) && <details className="mt-3 border-t border-slate-100 pt-2">
        <summary className="cursor-pointer font-semibold text-teal-800">This news: interpretation &amp; HP entry pitch</summary>
        <div className="mt-3 space-y-3">
          {!!source.businessDirections?.length && <BusinessDirectionBullets directions={source.businessDirections} sources={sources} sourcePrefix={sourcePrefix} />}
          {!!source.takeaways?.length && <HpTakeawayBullets takeaways={source.takeaways} sources={sources} sourcePrefix={sourcePrefix} />}
          {source.analysisNote && <p><strong>Assessment &amp; limitations:</strong> {source.analysisNote}</p>}
          {!source.takeaways?.length && source.analysisNote && <p>No defensible HP product fit was identified for this story; no buying intent is implied.</p>}
        </div>
      </details>}
    </div>)}
  </section>;
}
