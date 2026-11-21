import { useState } from "react";
import { Link } from "wouter";
import { useDecideResearchAttribution, useRefreshResearchAttribution, useResearchAttributionHistory, useResearchAttributionQueue, type ResearchAttributionItem } from "@/hooks/use-intent";
import { Button } from "@/components/ui/button";
import { formatReportDateTime } from "@/lib/reportTime";

function ReviewItem({ item, onDone }: { item: ResearchAttributionItem; onDone: () => void }) {
  const [decision, setDecision] = useState<"reject" | "retain" | "reassign">("reject");
  const [reason, setReason] = useState("");
  const [accountId, setAccountId] = useState("");
  const mutation = useDecideResearchAttribution();
  const url = (() => { try { const value = new URL(item.sourceUrl ?? ""); return ["http:", "https:"].includes(value.protocol) ? value.href : null; } catch { return null; } })();
  return <div className="rounded-lg border border-amber-200 bg-white p-4 space-y-3 text-sm">
    <div className="font-bold text-stone-900">
      {item.eventType?.replace(/_/g, " ") ?? "Public event"} · <Link href={`/intent/accounts/${item.accountId}`} className="underline">{item.accountName}</Link>
    </div>
    <p className="text-amber-800">{item.reason}</p>
    <div className="text-stone-600"><strong>Original excerpt:</strong> {item.originalExcerpt || "Unavailable"}</div>
    {item.excerpt !== item.originalExcerpt && <div className="text-stone-500"><strong>Stored summary:</strong> {item.excerpt}</div>}
    <div>{url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-emerald-700 underline break-all">{url}</a> : <span className="text-stone-500">No source URL</span>}</div>
    <div className="flex flex-wrap gap-2">
      <label className="sr-only" htmlFor={`decision-${item.id}`}>Decision</label>
      <select id={`decision-${item.id}`} value={decision} onChange={event => setDecision(event.target.value as typeof decision)} className="rounded border p-2">
        <option value="reject">Reject incorrect evidence</option>
        <option value="reassign">Reassign to another account</option>
        <option value="retain">Retain for this account</option>
      </select>
      {decision === "reassign" && <input aria-label="New account ID" type="number" min="1" value={accountId} onChange={event => setAccountId(event.target.value)} placeholder="New account ID" className="rounded border p-2 w-40" />}
    </div>
    <textarea aria-label="Review reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} placeholder="Explain the decision (required)" className="w-full rounded border p-2" />
    {mutation.isError && <p role="alert" className="text-rose-700">{mutation.error.message}</p>}
    <Button disabled={mutation.isPending || reason.trim().length < 8 || (decision === "reassign" && (!Number.isInteger(Number(accountId)) || Number(accountId) <= 0))} onClick={() => mutation.mutate({
      id: item.id, decision, reason: reason.trim(), ...(decision === "reassign" ? { accountId: Number(accountId) } : {}),
    }, { onSuccess: onDone })}>{mutation.isPending ? "Saving and recomputing…" : "Save review"}</Button>
  </div>;
}

export function ResearchAttributionQueue({ accountId }: { accountId: number }) {
  const [allAccounts, setAllAccounts] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [reviewed, setReviewed] = useState<number[]>([]);
  const queue = useResearchAttributionQueue(allAccounts ? undefined : accountId, cursor);
  const history = useResearchAttributionHistory(accountId);
  const refresh = useRefreshResearchAttribution();
  return <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 space-y-4">
    <div className="flex items-center justify-between gap-2">
      <div><h3 className="font-bold text-stone-900">Research attribution review</h3><p className="text-xs text-stone-600">Candidates only. Check the original source before making a decision; no records are changed automatically.</p></div>
      <Button variant="outline" onClick={() => { setAllAccounts(!allAccounts); setCursor(null); }}>{allAccounts ? "This account" : "All accounts"}</Button>
    </div>
    {queue.isError && <p role="alert" className="text-rose-700">{queue.error.message}</p>}
    {queue.isLoading && <p>Loading review candidates…</p>}
    {queue.data?.items.filter(item => !reviewed.includes(item.id)).map(item => <ReviewItem key={item.id} item={item} onDone={() => setReviewed(ids => [...ids, item.id])} />)}
    {queue.data?.items.length === 0 && <p className="text-sm text-stone-600">No candidates in this batch.</p>}
    {queue.data?.nextCursor && <Button variant="outline" onClick={() => setCursor(queue.data!.nextCursor)}>Next batch</Button>}
    {Boolean(history.data?.items.length) && <details className="border-t pt-3 text-sm text-stone-700">
      <summary className="cursor-pointer font-semibold">Reviewed decisions for this account ({history.data!.items.length})</summary>
      <div className="space-y-2 mt-3">{history.data!.items.map(item => item.reviews.map((review, index) =>
        <div key={`${item.id}-${index}`} className="rounded bg-white p-3 border">
          <strong>{review.decision}</strong> · {item.accountName} · {formatReportDateTime(review.at)} · Reviewer #{review.reviewerId}
          {review.fromAccountId !== review.toAccountId && <span> · Account #{review.fromAccountId} → #{review.toAccountId}</span>}
          <p>Reason: {review.reason}</p><p className="text-stone-500">Flag: {review.flagReason}</p>
          <p className="text-stone-500">Original: {item.originalExcerpt}</p>
          <Button variant="outline" className="mt-2" disabled={refresh.isPending} onClick={() => refresh.mutate(item.id)}>{refresh.isPending ? "Recomputing…" : "Recompute affected accounts"}</Button>
        </div>
      ))}</div>
      {refresh.isError && <p role="alert" className="text-rose-700">{refresh.error.message}</p>}
    </details>}
  </section>;
}