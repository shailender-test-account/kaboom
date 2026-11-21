import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetResearchCorrections, usePreviewResearchCorrection, useApplyResearchCorrection, useRefreshResearchCorrections,
  type ResearchCorrectionProposal, type ResearchCorrectionFinding,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { formatReportDateTime } from "@/lib/reportTime";

function Fitments({ value }: { value: unknown }) {
  const fits = Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
  if (!fits.length) return <p className="text-stone-500">No product fitments</p>;
  return <ul className="space-y-2">{fits.map((fit, index) => <li key={index} className="rounded border bg-white p-2">
    <strong>{String(fit.productName ?? `Product #${fit.productId}`)}</strong>
    <div>{String(fit.level ?? "Unverified")} · {String(fit.points ?? "Unknown")} points</div>
    <p className="text-stone-600">{String(fit.reason ?? "No recorded reason")}</p>
  </li>)}</ul>;
}
function FindingReview({ accountId, finding }: { accountId: number; finding: ResearchCorrectionFinding }) {
  const client = useQueryClient();
  const preview = usePreviewResearchCorrection();
  const apply = useApplyResearchCorrection();
  const [proposal, setProposal] = useState<ResearchCorrectionProposal | null>(null);
  const [approved, setApproved] = useState(false);
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState(false);
  const removals = proposal?.exactRemovals;
  const removedSignals = Array.isArray(removals?.signals) ? removals.signals as Array<{ id: number; productId: number | null }> : [];
  const removedProductIds = Array.isArray(removals?.productIds) ? removals.productIds : [];
  const sourceUrl = (() => {
    try { const url = new URL(finding.sourceUrl ?? ""); return ["http:", "https:"].includes(url.protocol) ? url.href : null; }
    catch { return null; }
  })();
  return <div className="rounded-lg border bg-white p-4 space-y-3 text-sm">
    <h4 className="font-semibold">Finding #{finding.id} · {finding.eventType?.replace(/_/g, " ") ?? "Public event"}</h4>
    <p><strong>Original provider facts:</strong> {finding.originalExcerpt || "Unavailable — cannot apply a correction"}</p>
    {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="block break-all text-emerald-700 underline">Open original source</a>}
    {finding.excerpt !== finding.originalExcerpt && <p className="text-stone-500"><strong>Stored summary:</strong> {finding.excerpt}</p>}
    {!saved && <Button variant="outline" disabled={preview.isPending || apply.isPending || !finding.originalExcerpt} onClick={() => {
      setProposal(null); setApproved(false); setReason(""); apply.reset();
      preview.mutate({ accountId, data: { evidenceId: finding.id } }, { onSuccess: setProposal });
    }}>{preview.isPending ? "Preparing proposal…" : proposal ? "Preview again" : "Preview correction"}</Button>}
    {preview.isError && <p role="alert" className="text-rose-700">{preview.error.message}</p>}
    {proposal && !saved && <div className="space-y-3 border-t pt-3">
      <p><strong>Facts used for reassessment:</strong> {proposal.sourceFact}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <div><h5 className="font-semibold mb-2">Old fitments</h5><Fitments value={proposal.before.fitments} /><p className="mt-2">Old primary product: {String(proposal.before.productId ?? "None")}</p></div>
        <div><h5 className="font-semibold mb-2">Proposed source-backed fitments</h5><Fitments value={proposal.proposed.fitments} /><p className="mt-2">Proposed event type: {String(proposal.proposed.eventType ?? "None")}</p></div>
      </div>
      <p>{proposal.reason}</p>
      <div className="rounded bg-amber-50 p-3 space-y-1">
        <h5 className="font-semibold">Exact removals and replacements</h5>
        <p>Unsupported product IDs removed: {removedProductIds.length ? removedProductIds.join(", ") : "None"}</p>
        <p>Evidence-owned signals removed and replaced: {removedSignals.length ? removedSignals.map(signal => `#${signal.id} (product ${signal.productId ?? "none"})`).join(", ") : "None"}</p>
        <p>Primary product link {String(removals?.primaryProductId ?? "none")} and signal link {String(removals?.primarySignalId ?? "none")} will be replaced with the first proposed fitment, or cleared when none remain.</p>
        <p>Protected shared or non-public signals: {proposal.protectedSignals.length ? proposal.protectedSignals.map(signal => `#${String(signal.id)} (${String(signal.source)})`).join(", ") : "None"}. These are never removed; a protected primary link blocks application.</p>
      </div>
      <p className="text-xs text-stone-500">This proposal expires {formatReportDateTime(proposal.expiresAt)}. Any source, signal or catalog change requires a new preview.</p>
      <textarea aria-label={`Correction reason for finding ${finding.id}`} value={reason} onChange={event => setReason(event.target.value)}
        maxLength={1000} placeholder="Explain why you approve this correction (at least 8 characters)" className="w-full rounded border p-2" disabled={apply.isPending} />
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={approved} disabled={apply.isPending} onChange={event => setApproved(event.target.checked)} className="mt-1" />
        <span>I reviewed the original facts, old/proposed fitments and exact removals, and approve this correction for finding #{finding.id} only.</span>
      </label>
      {apply.isError && <p role="alert" className="text-rose-700">{apply.error.message} Preview again before retrying.</p>}
      <Button disabled={!approved || reason.trim().length < 8 || apply.isPending} onClick={() => {
        apply.mutate({ accountId, data: { proposalId: proposal.proposalId, evidenceId: finding.id,
          sourceVersion: proposal.sourceVersion, approved: true, reason: reason.trim() } }, { onSuccess: () => {
          setSaved(true); setApproved(false); setProposal(null);
          void client.invalidateQueries({ queryKey: ["intent"] });
          void client.invalidateQueries({ queryKey: [`/api/intent/accounts/${accountId}/research-corrections`] });
        } });
      }}>{apply.isPending ? "Applying approved correction…" : "Apply this finding’s approved correction"}</Button>
    </div>}
    {saved && <p role="status" className="text-emerald-800">Correction saved with an audit record. {apply.data?.refreshPending ? "Research-view refresh needs retry below. Do not reapply." : "Research views refreshed."}</p>}
  </div>;
}

export function ResearchCorrections({ accountId }: { accountId: number }) {
  const [cursor, setCursor] = useState<number | undefined>();
  const query = useGetResearchCorrections(accountId, cursor ? { cursor } : undefined, { query: { staleTime: 0 } });
  const refresh = useRefreshResearchCorrections();
  const client = useQueryClient();
  return <section className="rounded-xl border border-stone-200 bg-stone-50 p-5 space-y-4">
    <h3 className="font-bold text-stone-900">Reviewed research corrections</h3>
    <p className="text-sm text-stone-600">Admin-only, one finding at a time. JSON exports are proposals, not approval. Corrections affect public-research links and signals only — not forms, inbound qualification, fiscal results or Total Order Value.</p>
    {query.isLoading && <p>Loading public research…</p>}
    {query.isError && <p role="alert" className="text-rose-700">{query.error.message}</p>}
    {query.data?.items.length === 0 && <p className="text-sm">No approved public research in this batch.</p>}
    {query.data?.items.map(finding => <FindingReview key={`${accountId}-${finding.id}`} accountId={accountId} finding={finding} />)}
    <div className="flex gap-2">
      {cursor && <Button variant="outline" onClick={() => setCursor(undefined)}>First batch</Button>}
      {query.data?.nextCursor && <Button variant="outline" onClick={() => setCursor(query.data!.nextCursor!)}>Next findings</Button>}
    </div>
    {Boolean(query.data?.history.length) && <details className="border-t pt-3 text-sm">
      <summary className="cursor-pointer font-semibold">Correction audit history ({query.data!.history.length} most recent)</summary>
      <div className="mt-3 space-y-3">{query.data!.history.map(item => <div key={item.proposalId} className="border rounded bg-white p-3">
        <strong>Finding #{item.evidenceId}</strong> · Reviewer #{item.approvedBy} · {formatReportDateTime(item.appliedAt)}
        <p>Approval reason: {item.reason}</p>
        <p>Original facts: {String(item.proposal.sourceFact ?? "")}</p>
        <details><summary className="cursor-pointer">Reviewed before/after and exact applied delta</summary>
          <pre className="whitespace-pre-wrap break-all text-xs mt-2">{JSON.stringify({ before: item.proposal.before, proposed: item.proposal.proposed, removals: item.proposal.exactRemovals, delta: item.delta }, null, 2)}</pre>
        </details>
      </div>)}</div>
    </details>}
    {Boolean(query.data?.history.length) && <Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate({ accountId }, { onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["intent"] }); void query.refetch();
    } })}>{refresh.isPending ? "Refreshing research…" : "Retry research-view refresh"}</Button>}
    {refresh.isError && <p role="alert" className="text-rose-700">{refresh.error.message}</p>}
    {refresh.isSuccess && <p role="status" className="text-sm text-emerald-800">Research views refreshed. BI and inbound data were not changed.</p>}
  </section>;
}
