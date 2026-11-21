import { useState } from "react";
import { useIntentContactEngagement } from "@/hooks/use-intent";
import { IntentDetailPanel } from "./detail-panel";
import { formatReportDateTime } from "@/lib/reportTime";
import InboundSourceProvenance from "./InboundSourceProvenance";

const label = (value: string) => value.replace(/_/g, " ");
const valueText = (value: unknown): string => {
  if (value == null || value === "") return "Not provided";
  if (Array.isArray(value)) return value.map(valueText).join(", ");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${label(key)}: ${valueText(item)}`).join("; ");
  return String(value);
};
function Pager({ page, total, hasMore, onChange, name }: {
  page: number; total: number; hasMore: boolean; onChange: (page: number) => void; name: string;
}) {
  return <nav aria-label={`${name} pagination`} className="flex items-center justify-between gap-3 border-t border-stone-100 p-3 text-xs">
    <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous {name}</button>
    <span>Page {page} · {total} records</span>
    <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={!hasMore} onClick={() => onChange(page + 1)}>Next {name}</button>
  </nav>;
}
export default function ContactEngagementEvidence({ id, scope, enabled }: {
  id: string; scope: Record<string, any>; enabled: boolean;
}) {
  const [gtmPage, setGtmPage] = useState(1);
  const [timelinePage, setTimelinePage] = useState(1);
  const query = useIntentContactEngagement(id, scope, gtmPage, timelinePage, enabled);
  return <section aria-label="Contact GTM evidence and KABOOM timeline" className="space-y-5">
    <IntentDetailPanel query={query} label="Contact engagement">
      {query.data && <>
        <section aria-label="GTM score evidence" className="overflow-hidden rounded-lg border border-emerald-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-emerald-50/50 px-4 py-3">
            <h2 className="text-sm font-bold text-emerald-950">GTM evidence · Lead forms &amp; event questionnaires</h2>
            <span className="rounded border bg-white px-2 py-1 text-xs font-semibold">Contact qualification: {query.data.gtmStatus}</span>
          </div>
          <p className="px-4 pt-3 text-xs text-stone-500">This contact’s own responses, across all dates. Qualification and declared product interest are separate from journey points and the selected-product intent score.</p>
          {!query.data.gtmEvidence.items.length ? <p className="p-4 text-sm text-stone-500">No attributable lead-form or questionnaire responses are recorded for this contact.</p>
            : <div className="divide-y">{query.data.gtmEvidence.items.map(row => <article key={row.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="text-sm font-bold">{row.sourceType === "lead_form" ? "Lead form" : "Event questionnaire / feedback"} · {row.sourceName}</h3>
                <span className="text-xs font-semibold">{row.qualification}</span>
              </div>
              <p className="mt-1 text-xs text-stone-500">{row.occurredAt ? formatReportDateTime(row.occurredAt) : "Submission date unavailable"}{row.journey ? ` · ${row.journey}` : ""}</p>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <div><dt className="font-semibold">Product / solution</dt><dd>{row.product || "Not provided"}</dd></div>
                <div><dt className="font-semibold">Purchase timeframe</dt><dd>{row.horizonMonths != null ? `${row.horizonMonths} months` : "Not provided"}</dd></div>
              </dl>
              {row.reason && <p className="mt-2 text-xs text-stone-600">{row.reason}</p>}
              <InboundSourceProvenance provenance={row.provenance} />
              <details className="mt-3 text-xs" open>
                <summary className="cursor-pointer font-semibold text-emerald-800">Submitted answers &amp; feedback</summary>
                <dl className="mt-2 grid gap-2 rounded bg-stone-50 p-3 sm:grid-cols-2">
                  {Object.entries({ ...row.answers, ...row.feedback }).filter(([key]) => !key.startsWith("__")).map(([key, value]) =>
                    <div key={key} className="min-w-0 break-words"><dt className="font-semibold">{label(key)}</dt><dd className="mt-0.5 text-stone-600">{valueText(value)}</dd></div>)}
                </dl>
              </details>
            </article>)}</div>}
          {query.data.gtmEvidence.total > 25 && <Pager name="responses" page={gtmPage} total={query.data.gtmEvidence.total} hasMore={query.data.gtmEvidence.hasMore} onChange={setGtmPage} />}
        </section>
        <section aria-label="KABOOM journey timeline" className="overflow-hidden rounded-lg border border-sky-200 bg-white shadow-sm">
          <h2 className="border-b bg-sky-50/50 px-4 py-3 text-sm font-bold text-sky-950">KABOOM journey &amp; engagement timeline</h2>
          {!query.data.timeline.items.length ? <p className="p-4 text-sm text-stone-500">No recorded KABOOM journey or engagement activity for this contact.</p>
            : <ol className="divide-y">{query.data.timeline.items.map(event => <li key={event.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-xs font-bold">{label(event.kind)}{event.isBot && <span className="ml-2 rounded bg-amber-50 px-2 py-0.5 text-amber-800">Bot / automated · not verified engagement</span>}</p>
                <time className="text-xs text-stone-500">{event.occurredAt ? formatReportDateTime(event.occurredAt) : "Date unavailable"}</time>
              </div>
              {event.description && <p className="mt-1 break-words text-xs text-stone-700">{event.description}</p>}
              <p className="mt-1 text-xs text-stone-500">{[event.source, event.journey, event.page, event.stage ? `Stage: ${event.stage}` : null].filter(Boolean).join(" · ")}</p>
              <p className="mt-1 text-xs font-semibold text-emerald-800">{[
                event.scoreDelta != null ? `${Number(event.scoreDelta) >= 0 ? "+" : ""}${event.scoreDelta} points` : null,
                event.oldScore != null && event.newScore != null ? `Score ${event.oldScore} → ${event.newScore}` : null,
                event.product, event.qualification,
              ].filter(Boolean).join(" · ")}</p>
            </li>)}</ol>}
          {query.data.timeline.total > 25 && <Pager name="activity" page={timelinePage} total={query.data.timeline.total} hasMore={query.data.timeline.hasMore} onChange={setTimelinePage} />}
        </section>
      </>}
    </IntentDetailPanel>
  </section>;
}
