import { useState } from "react";
import { Link } from "wouter";
import { canAccess } from "@workspace/api-zod";
import { useAuthContext } from "@/contexts/AuthContext";
import { useFeedbackList, type FeedbackFilters, type FeedbackEntry } from "@/hooks/use-sales-feedback";
import { FeedbackEntryCard } from "./FeedbackEntryCard";
import { ReviewDialog } from "./ReviewDialog";
import { ManualEntryDialog } from "./ManualEntryDialog";

export type FeedbackTarget = { companyId: number } | { contactId: number } | { parentKey: string; clientId: number };
const PAGE_SIZE = 10;

function toFilters(t: FeedbackTarget): FeedbackFilters | null {
  if ("companyId" in t) return Number.isFinite(t.companyId) && t.companyId > 0 ? { accountId: t.companyId } : null;
  if ("contactId" in t) return Number.isFinite(t.contactId) && t.contactId > 0 ? { contactId: t.contactId } : null;
  return t.parentKey && t.clientId ? { parentKey: t.parentKey, clientId: t.clientId } : null;
}

function prefillFor(t: FeedbackTarget) {
  if ("companyId" in t) return { accountId: t.companyId };
  if ("contactId" in t) return { contactId: t.contactId };
  return { clientId: t.clientId };
}

export default function SalesFeedbackHistory({ target }: { target: FeedbackTarget }) {
  const { user } = useAuthContext();
  const allowed = !!user && canAccess(user, "gtm");
  const base = toFilters(target);
  const [page, setPage] = useState(1);
  const [reviewing, setReviewing] = useState<FeedbackEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const canWrite = !!user && canAccess(user, "gtm", true);
  // Never fall back to tenant-wide feedback when the target is missing.
  const q = useFeedbackList({ ...(base ?? {}), page, pageSize: PAGE_SIZE }, allowed && !!base);
  if (!allowed || !base) return null;
  const d = q.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / (d.pageSize || PAGE_SIZE))) : 1;
  const isAdmin = user?.role === "admin";
  const pending = d?.items.filter(i => i.reviewStatus === "pending").length ?? 0;

  return (
    <section data-testid="sales-feedback-history" aria-label="Sales feedback" className="space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sales feedback from calls and visits</h4>
        {d && <span className="text-xs text-muted-foreground">{d.total} record{d.total === 1 ? "" : "s"}{pending ? ` · ${pending} awaiting review on this page` : ""}</span>}
        {canWrite && <button type="button" className="ml-auto rounded border border-foreground/20 bg-background px-2 py-1 text-xs font-semibold hover:bg-muted" onClick={() => setAdding(true)} data-testid="button-add-feedback-here">Add feedback</button>}
        <Link href="/intent/sales-feedback" className={canWrite ? "text-xs underline" : "ml-auto text-xs underline"} data-testid="link-sales-feedback-page">Open feedback desk</Link>
      </div>
      <p className="text-[11px] text-muted-foreground">Pending and rejected feedback does not affect scores. Only admin-approved entries with qualification applied change qualification.</p>
      {q.isLoading && <div className="space-y-2" data-testid="sales-feedback-loading"><div className="h-20 rounded bg-muted animate-pulse" /><div className="h-20 rounded bg-muted animate-pulse" /></div>}
      {q.isError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800" data-testid="sales-feedback-error">
        Could not load sales feedback: {q.error.message} <button type="button" className="underline font-semibold" onClick={() => q.refetch()} data-testid="button-sales-feedback-retry">Retry</button></div>}
      {d && d.items.length === 0 && <p className="rounded border border-dashed p-4 text-xs text-muted-foreground" data-testid="sales-feedback-empty">No telecaller or sales rep feedback is linked here yet.</p>}
      {d && d.items.length > 0 && <div className="space-y-2">{d.items.map(e => <FeedbackEntryCard key={e.id} entry={e} compact={"companyId" in target} onReview={isAdmin ? setReviewing : undefined} />)}</div>}
      {d && d.total > PAGE_SIZE && <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground" data-testid="sales-feedback-pager">
        <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1 || q.isFetching} onClick={() => setPage(p => p - 1)} data-testid="button-sales-feedback-prev">Previous</button>
        <span>Page {d.page} of {pages}</span>
        <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= pages || q.isFetching} onClick={() => setPage(p => p + 1)} data-testid="button-sales-feedback-next">Next</button>
      </div>}
      {canWrite && <ManualEntryDialog open={adding} onOpenChange={setAdding} prefill={prefillFor(target)} />}
      {isAdmin && <ReviewDialog entry={reviewing} onClose={() => setReviewing(null)} />}
    </section>
  );
}
