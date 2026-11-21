import { useState } from "react";
import { MessageSquareQuote, Plus, Flame, PhoneOff } from "lucide-react";
import { canAccess } from "@workspace/api-zod";
import { useAuthContext } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFeedbackList, useFeedbackOptions, type FeedbackEntry, type FeedbackType, type ReviewStatus } from "@/hooks/use-sales-feedback";
import { FeedbackEntryCard } from "@/components/sales-feedback/FeedbackEntryCard";
import { ReviewDialog } from "@/components/sales-feedback/ReviewDialog";
import { ManualEntryDialog, type ManualPrefill } from "@/components/sales-feedback/ManualEntryDialog";
import { HotFollowUpWorklist } from "@/components/sales-feedback/HotFollowUpWorklist";
import { FeedbackDirectory } from "@/components/sales-feedback/FeedbackDirectory";
import { SourcesPanel } from "@/components/sales-feedback/SourcesPanel";
import { SalesHotAccounts } from "@/components/sales-feedback/SalesHotAccounts";
import { useGetSalesAccountOptions, getGetSalesAccountOptionsQueryKey } from "@workspace/api-client-react";

const PAGE_SIZE = 25;
const sel = "h-8 rounded-md border bg-background px-2 text-xs";
const STATUSES: { v: ReviewStatus | ""; l: string }[] = [{ v: "pending", l: "Awaiting review" }, { v: "approved", l: "Approved" }, { v: "rejected", l: "Rejected" }, { v: "", l: "All" }];

export default function SalesFeedbackPage() { return <SalesWorkspace />; }

function OptionsError({ q }: { q: { isError: boolean; error: Error | null; refetch: () => unknown } }) {
  if (!q.isError) return null;
  return <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800" data-testid="options-error">Could not load clients, accounts and products: {q.error?.message} <button className="underline font-semibold" onClick={() => q.refetch()} data-testid="button-options-retry">Retry</button></div>;
}

function SourcesTab({ canWrite }: { canWrite: boolean }) {
  const opts = useFeedbackOptions();
  return <div className="space-y-3"><OptionsError q={opts} /><SourcesPanel options={opts.data} canWrite={canWrite} /></div>;
}

type Tab = "accounts" | "hot" | "contacts" | "feed" | "sources";
const TAB_LABEL: Record<Tab, string> = { accounts: "Hot accounts", hot: "Call follow-ups", contacts: "Accounts & contacts", feed: "Feedback", sources: "Drive sources" };

export function SalesWorkspace() {
  const { user } = useAuthContext();
  const canWrite = !!user && canAccess(user, "sales", true);
  const isAdmin = user?.role === "admin";
  const [tab, setTabState] = useState<Tab>(() => { const t = new URLSearchParams(window.location.search).get("tab"); return t === "feed" || t === "sources" || t === "contacts" || t === "hot" ? t : "accounts"; });
  const salesOpts = useGetSalesAccountOptions({ query: { queryKey: getGetSalesAccountOptionsQueryKey(), refetchInterval: 60_000 } });
  const showSources = salesOpts.data?.visibility === "all";
  const tabs: Tab[] = showSources ? ["accounts", "hot", "contacts", "feed", "sources"] : ["accounts", "hot", "contacts", "feed"];
  const setTab = (t: Tab) => {
    setTabState(t);
    const u = new URL(window.location.href);
    if (t === "accounts") u.searchParams.delete("tab"); else u.searchParams.set("tab", t);
    window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
  };
  const [prefill, setPrefill] = useState<ManualPrefill | undefined>();
  const [manual, setManual] = useState(false);
  const openManual = (p?: ManualPrefill) => { setPrefill(p); setManual(true); };
  return (
    <div className="sf-desk min-h-[100dvh] p-4 md:p-6 space-y-5" data-testid="page-sales-dashboard">
      <header className="flex flex-wrap items-end gap-4 sf-rise">
        <div className="flex-1 min-w-64">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-muted-foreground">Sales workspace</p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight"><Flame className="h-6 w-6 text-red-600" />Sales Dashboard</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Declared Hot accounts, call follow-ups and feedback in one place. <span className="inline-flex items-center gap-1"><PhoneOff className="h-3.5 w-3.5" />Viewing never sends email, places calls, syncs or enrolls anyone.</span></p>
        </div>
        <span className="rounded border px-2 py-1 text-[11px] font-medium text-muted-foreground" data-testid="text-sales-access">{canWrite ? "Edit access" : "View only"}</span>
        {canWrite && <Button onClick={() => openManual()} data-testid="button-new-feedback"><Plus className="mr-1 h-4 w-4" />Log feedback</Button>}
      </header>
      <nav className="flex flex-wrap gap-1 border-b" role="tablist" aria-label="Sales workspace sections">
        {tabs.map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`tab-${t}`}
          className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors", tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {TAB_LABEL[t]}</button>)}
      </nav>
      {tab === "accounts" && <SalesHotAccounts onAddFeedback={canWrite ? t => openManual({ clientId: t.clientId, accountId: t.accountId }) : undefined} />}
      {tab === "hot" && <div className="space-y-3">
        <p className="text-xs text-muted-foreground" data-testid="text-hot-scope"><span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 font-semibold text-red-800">Scope: HP only</span> This queue currently covers HP contacts individually declared Hot. Other clients are not included.</p>
        <HotFollowUpWorklist scope={{}} canWrite={canWrite} onLogFeedback={canWrite ? i => openManual({ clientId: i.clientId, accountId: i.accountId ?? undefined, contactId: i.contactId }) : undefined} />
        <p className="text-xs text-muted-foreground">Looking for another account or contact? <button type="button" className="font-medium text-primary underline underline-offset-2" onClick={() => setTab("contacts")}>Browse accounts &amp; contacts</button> to view saved records{canWrite ? " and log feedback" : ""}.</p>
      </div>}
      {tab === "contacts" && <FeedbackDirectory onLog={canWrite ? openManual : undefined} />}
      {tab === "feed" && <FeedbackTab isAdmin={isAdmin} onAdd={canWrite ? () => openManual() : undefined} />}
      {tab === "sources" && showSources && <SourcesTab canWrite={canWrite} />}
      {canWrite && <ManualEntryDialog open={manual} onOpenChange={o => { setManual(o); if (!o) setPrefill(undefined); }} prefill={prefill} />}
    </div>
  );
}

function FeedbackTab({ isAdmin, onAdd }: { isAdmin: boolean; onAdd?: () => void }) {

  const [status, setStatus] = useState<ReviewStatus | "">("");
  const [type, setType] = useState<FeedbackType | "">("");
  const [clientId, setClientId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [contactId, setContactId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [reviewing, setReviewing] = useState<FeedbackEntry | null>(null);
  const opts = useFeedbackOptions(clientId ? Number(clientId) : undefined, search || undefined);
  const list = useFeedbackList({
    clientId: clientId ? Number(clientId) : undefined, accountId: accountId ? Number(accountId) : undefined,
    contactId: contactId ? Number(contactId) : undefined, type: type || undefined, status: status || undefined, page, pageSize: PAGE_SIZE,
  });
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };
  const d = list.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / (d.pageSize || PAGE_SIZE))) : 1;
  const unmatched = d?.items.filter(i => i.accountId == null && i.contactId == null).length ?? 0;
  const cid = Number(clientId);

  return (
    <div className="space-y-3">
      {!isAdmin && <p className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="text-admin-only">Reviews are admin-only. Your entries stay pending until an administrator approves or rejects them.</p>}
      <OptionsError q={opts} />
        <div className="flex flex-wrap items-center gap-2" data-testid="feedback-filters">
          <div className="flex rounded-md border p-0.5">
            {STATUSES.map(s => <button key={s.l} onClick={() => reset(setStatus)(s.v)} data-testid={`filter-status-${s.v || "all"}`}
              className={cn("rounded px-2.5 py-1 text-xs font-medium", status === s.v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>{s.l}</button>)}
          </div>
          <select className={sel} value={type} onChange={e => reset(setType)(e.target.value as FeedbackType | "")} data-testid="filter-type">
            <option value="">All types</option><option value="telesales">Telesales</option><option value="sales_rep">Sales rep</option></select>
          <select className={sel} value={clientId} onChange={e => { reset(setClientId)(e.target.value); setAccountId(""); setContactId(""); }} data-testid="filter-client">
            <option value="">All clients</option>{(opts.data?.clients ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          {clientId && <>
            <input className={cn(sel, "w-40")} placeholder="Find account or contact" value={search} onChange={e => setSearch(e.target.value)} data-testid="filter-search" />
            <select className={cn(sel, "max-w-48")} value={accountId} onChange={e => { reset(setAccountId)(e.target.value); setContactId(""); }} data-testid="filter-account">
              <option value="">Any account</option>{(opts.data?.accounts ?? []).filter(a => a.clientId === cid).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            <select className={cn(sel, "max-w-48")} value={contactId} onChange={e => reset(setContactId)(e.target.value)} data-testid="filter-contact">
              <option value="">Any contact</option>{(opts.data?.contacts ?? []).filter(c => c.clientId === cid && (!accountId || c.companyId === Number(accountId))).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </>}
          {d && <span className="ml-auto font-mono text-[11px] text-muted-foreground" data-testid="text-feedback-total">{d.total} records{unmatched ? ` · ${unmatched} unmatched on page` : ""}</span>}
        </div>

        {list.isLoading && <div className="space-y-2" data-testid="feedback-loading">{[0, 1, 2].map(i => <div key={i} className="h-28 rounded-md bg-muted animate-pulse" />)}</div>}
        {list.isError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800" data-testid="feedback-error">Could not load feedback: {list.error.message} <button className="underline font-semibold" onClick={() => list.refetch()} data-testid="button-feedback-retry">Retry</button></div>}
        {d && d.items.length === 0 && <div className="rounded-md border border-dashed px-6 py-12 text-center" data-testid="feedback-empty">
          <MessageSquareQuote className="mx-auto h-8 w-8 text-amber-600/50" />
          <p className="mt-2 text-sm font-medium">{status === "pending" ? "The review queue is clear." : !status && !type && !clientId && !accountId && !contactId ? "No feedback has been recorded yet." : "No feedback matches these filters."}</p>
          <p className="mt-1 text-xs text-muted-foreground">{status === "" && !type && !clientId ? "No feedback has been recorded yet. " : ""}Log a call manually, or connect a Drive source and press Sync.</p>
          {onAdd && <Button size="sm" className="mt-3" onClick={onAdd} data-testid="button-empty-new-feedback"><Plus className="mr-1 h-4 w-4" />Log feedback</Button>}
        </div>}
        {d && d.items.length > 0 && <div className={cn("space-y-2.5 transition-opacity", list.isFetching && "opacity-60")}>
          {d.items.map(e => <FeedbackEntryCard key={e.id} entry={e} onReview={isAdmin ? setReviewing : undefined} />)}
        </div>}
        {d && d.total > 0 && <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground" data-testid="feedback-pager">
          <span>Records {(d.page - 1) * d.pageSize + 1}-{Math.min(d.total, (d.page - 1) * d.pageSize + d.items.length)} of {d.total}</span>
          <span className="flex items-center gap-2">
            <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1 || list.isFetching} onClick={() => setPage(p => p - 1)} data-testid="button-feedback-prev">Previous</button>
            <span>Page {d.page} of {pages}</span>
            <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= pages || list.isFetching} onClick={() => setPage(p => p + 1)} data-testid="button-feedback-next">Next</button>
          </span>
        </div>}
      {isAdmin && <ReviewDialog entry={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}
