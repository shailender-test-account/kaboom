import { useState } from "react";
import { MessageSquarePlus, MessageSquareQuote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFeedbackList } from "@/hooks/use-sales-feedback";
import { FeedbackEntryCard } from "./FeedbackEntryCard";

const PAGE = 5;

/** Account-scoped feedback history for the Sales Dashboard detail panel (sales-gated, not GTM-gated). */
export function AccountFeedbackLog({ accountId, clientId, onAdd }: { accountId: number; clientId: number; onAdd?: () => void }) {
  const [page, setPage] = useState(1);
  const q = useFeedbackList({ clientId, accountId, page, pageSize: PAGE });
  const d = q.isError ? undefined : q.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / (d.pageSize || PAGE))) : 1;
  return (
    <section className="space-y-2" data-testid="section-account-feedback">
      <div className="flex items-center gap-2">
        <h4 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Feedback{d ? ` (${d.total})` : ""}</h4>
        {onAdd && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onAdd} data-testid="button-detail-add-feedback">
          <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />Add feedback</Button>}
      </div>
      {q.isLoading && <div className="space-y-2" data-testid="account-feedback-loading">{[0, 1].map(i => <div key={i} className="h-20 rounded-md bg-muted animate-pulse" />)}</div>}
      {q.isError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-2.5 text-xs text-red-800" data-testid="account-feedback-error">
        Could not load feedback. <button type="button" className="font-semibold underline" onClick={() => q.refetch()}>Retry</button></div>}
      {d && d.items.length === 0 && <div className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground" data-testid="account-feedback-empty">
        <MessageSquareQuote className="mx-auto mb-1 h-5 w-5 text-amber-600/50" />No feedback logged for this account yet.</div>}
      {d && d.items.length > 0 && <div className={cn("space-y-2 transition-opacity", q.isFetching && "opacity-60")}>
        {d.items.map(e => <FeedbackEntryCard key={e.id} entry={e} compact />)}</div>}
      {d && d.total > PAGE && <div className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
        <button type="button" className="rounded border px-2 py-0.5 disabled:opacity-40" disabled={page <= 1 || q.isFetching} onClick={() => setPage(p => p - 1)}>Newer</button>
        <span>{d.page} / {pages}</span>
        <button type="button" className="rounded border px-2 py-0.5 disabled:opacity-40" disabled={page >= pages || q.isFetching} onClick={() => setPage(p => p + 1)}>Older</button>
      </div>}
    </section>
  );
}
