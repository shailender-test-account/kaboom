import type { ListMonitoredAccounts200ItemsItemResearchContext } from "@workspace/api-client-react";

/** Stored evidence only: expanding diagnostics never fetches or starts research. */
export default function ResearchQuality({ diagnostics }: {
  diagnostics?: ListMonitoredAccounts200ItemsItemResearchContext["diagnostics"];
}) {
  if (!diagnostics) return null;
  const d = diagnostics;
  return <section aria-label="Research quality" className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-700">
    <h4 className="font-bold">Research quality · stored findings</h4>
    <p className="mt-1">
      {d.assessedCount === 0 ? "No stored findings to assess. A successful provider check can return no results."
        : `${d.usableCount} usable for business context · ${d.excludedCount} excluded · ${d.assessedCount} assessed`}
    </p>
    {d.assessedCount > 0 && d.usableCount === 0 && <p className="mt-1 font-semibold">No useful account-specific business news in these findings.</p>}
    {d.truncated && <p className="mt-1">Showing quality for the latest {d.assessedCount} of {d.storedFindingCount} stored findings, not the full history.</p>}
    {(d.exclusions.length > 0 || d.unverifiedPublicationDateCount > 0 || d.insufficientOperationalEvidenceCount > 0) &&
      <details className="mt-2">
        <summary className="cursor-pointer font-semibold">Why findings were excluded or limited</summary>
        {d.exclusions.length > 0 && <>
          <p className="mt-2">Exclusions (one primary reason per finding):</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">{d.exclusions.map(reason =>
            <li key={reason.reason}>{reason.label}: {reason.count}</li>)}</ul>
        </>}
        {(d.unverifiedPublicationDateCount > 0 || d.insufficientOperationalEvidenceCount > 0) && <>
          <p className="mt-2">Limitations on retained context (may overlap; not additional exclusions):</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {d.unverifiedPublicationDateCount > 0 && <li>Publication date unverified: {d.unverifiedPublicationDateCount}. Event/retrieval recency is not proof of newly published news.</li>}
            {d.insufficientOperationalEvidenceCount > 0 && <li>Insufficient operational evidence: {d.insufficientOperationalEvidenceCount}. Business news alone does not establish a product requirement.</li>}
          </ul>
        </>}
      </details>}
    <p className="mt-2 text-[11px] text-stone-500">Provider completion/history counts are separate from usable news. This read-only assessment starts no paid research and changes no buying qualification.</p>
  </section>;
}
