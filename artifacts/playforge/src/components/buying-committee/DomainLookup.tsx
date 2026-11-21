import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CommitteeDomainLookupInput, CommitteeDomainLookupResult } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { committeeRequest } from "./api";

/** Review-only state is local and never touches the draft until confirmation. */
export default function DomainLookup({ scope, onConfirm }: {
  scope: CommitteeDomainLookupInput; onConfirm: (domain: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cost, setCost] = useState(false);
  const [verified, setVerified] = useState(false);
  const [choice, setChoice] = useState("");
  const [result, setResult] = useState<CommitteeDomainLookupResult>();
  const lookup = useMutation({
    retry: false,
    mutationFn: (research: boolean) => committeeRequest<CommitteeDomainLookupResult>("/domain-lookup",
      { ...scope, research, acknowledgeCost: research && cost }),
    onSuccess: data => { setResult(data); setChoice(""); setVerified(false); },
    onSettled: () => setCost(false),
  });
  const selected = result?.candidates.find((c, i) => String(i) === choice);
  return <div className="space-y-2 sm:col-span-3">
    <Button type="button" size="sm" variant="outline" disabled={lookup.isPending}
      onClick={() => { setOpen(true); setResult(undefined); setChoice(""); setVerified(false); lookup.mutate(false); }}>Lookup website</Button>
    {open && <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs" aria-label="Website evidence review">
      <div className="flex justify-between gap-3"><strong>Review company website evidence</strong>
        <button type="button" disabled={lookup.isPending} className="underline" onClick={() => setOpen(false)}>Close</button></div>
      {lookup.isPending && <p role="status">Checking evidence… No domain has been attached.</p>}
      {lookup.isError && <p role="alert" className="text-red-700">{(lookup.error as Error).message}</p>}
      {result && <>
        <p>Legal company: <strong>{result.legalName}</strong>{result.parentName && <> · Roster parent: <strong>{result.parentName}</strong></>}</p>
        <ul className="list-disc space-y-1 pl-4 text-amber-800">{result.warnings.map(w => <li key={w}>{w}</li>)}</ul>
        {result.candidates.length === 0 && <p>No website suggestion found in this evidence.</p>}
        {result.candidates.map((candidate, i) => <div key={`${candidate.domain}-${candidate.relationship}`} className="space-y-1 rounded border bg-white p-2">
          <label className="flex items-center gap-2"><input type="radio" name={`domain-candidate-${scope.accountId}`} checked={choice === String(i)}
            onChange={() => { setChoice(String(i)); setVerified(false); }} /><strong>{candidate.domain}</strong> · {candidate.relationship === "legal-company" ? "Legal-company evidence (review required)" : candidate.relationship === "parent-company" ? "Parent-company only" : "Uncertain identity"}</label>
          <p>{candidate.origin}</p><p className="whitespace-pre-wrap break-words">{candidate.evidence}</p>
          <a href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer" className="break-all font-semibold text-emerald-800 underline">Open website/source: {candidate.sourceUrl}</a>
        </div>)}
        {selected && <><label className="flex items-start gap-2"><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />
          I checked the official source and confirm this domain represents this selected legal employer, not merely its parent or another company.</label>
          <Button type="button" size="sm" disabled={!verified || lookup.isPending} onClick={() => {
            onConfirm(selected.domain); setOpen(false); setResult(undefined); setVerified(false); setChoice("");
          }}>Confirm domain for draft</Button></>}
        <div className="space-y-2 border-t pt-3">
          <p>Need more evidence? Public research sends the company and parent names to configured Tavily, or Perplexity if Tavily is unavailable. One search request, at most five results, no automatic retries or Apollo credits. Errors/timeouts may still incur provider cost.</p>
          <label className="flex items-start gap-2"><input type="checkbox" checked={cost} disabled={lookup.isPending} onChange={e => setCost(e.target.checked)} />I acknowledge the provider cost of one public search.</label>
          <Button type="button" size="sm" variant="outline" disabled={!cost || lookup.isPending} onClick={() => lookup.mutate(true)}>Research public website</Button>
          {result.requests > 0 && <p>{result.provider}: {result.requests} request made. Results remain unconfirmed until you review them.</p>}
        </div>
      </>}
      <p className="text-stone-600">Confirmation updates only this unsaved draft. Use Save draft to persist it. CRM records, approval and Apollo sourcing are unchanged.</p>
    </div>}
  </div>;
}
