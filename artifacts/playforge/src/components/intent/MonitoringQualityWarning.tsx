import { Link } from "wouter";
import type { MonitoringCheckQuality } from "@workspace/api-client-react";

/** Source quality is separate from operational completion and intent. */
export default function MonitoringQualityWarning({ quality }: { quality?: MonitoringCheckQuality }) {
  if (!quality || quality.usableCount > 0) return null;
  return <aside aria-label="Research quality warning" className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
    <p className="font-semibold">Completed check · no usable business news</p>
    <p className="mt-1">{quality.assessedCount === 0
      ? "No business articles were saved under this check. Duplicate sources may be retained under an earlier check."
      : `${quality.assessedCount} stored sources assessed; none passed existing source-quality validation.`}</p>
    {quality.exclusions.length > 0 && <ul className="mt-1 list-inside list-disc">
      {quality.exclusions.map(exclusion => <li key={exclusion.reason}>{exclusion.label}: {exclusion.count}</li>)}
    </ul>}
    <p className="mt-1">Quality is assessed now, not a historical snapshot. Provider completion and intent are unchanged; this does not establish an absence of business needs.</p>
    <Link href={`/intent/accounts/${quality.accountId}`} className="mt-1 inline-block font-semibold underline">Review saved sources and exclusions in account analysis</Link>
    <p className="mt-1">Review account attribution, India coverage and source exclusions before relying on this check. Opening analysis does not start paid research.</p>
  </aside>;
}
