import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ArrowUpRight, CalendarDays, Search } from "lucide-react";
import { useIntentScopeOptions } from "@/hooks/use-intent";
import { useOpportunities, useOpportunityTimeline, type OpportunityEvent } from "@/hooks/use-opportunities";
import { Skeleton } from "@/components/ui/skeleton";
import { sourceLabel } from "@/pages/intent/opportunity-queue";
import { formatReportDateTime } from "@/lib/reportTime";
import { GtmStatusBadge, useGtmStatuses, type GtmStatuses } from "@/components/analytics/GtmStatusBadge";

const field = "h-9 w-full rounded-lg border border-[#D7E1D6] bg-[#FEFFF9] px-3 text-xs font-semibold text-[#264334] outline-none focus:ring-2 focus:ring-[#C9E4BC]";
const eyebrow = "text-[10px] font-black uppercase tracking-[.15em] text-[#63806B]";
const formatTime = (value: string | null) => value && !Number.isNaN(Date.parse(value))
  ? formatReportDateTime(value) : "Not recorded";
const safeUrl = (url: string | null) => {
  if (!url) return null;
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null; } catch { return null; }
};
function TimelineEvent({ event, gtmStatuses, loadingGtmStatuses, gtmStatusesError }: {
  event: OpportunityEvent;
  gtmStatuses?: GtmStatuses;
  loadingGtmStatuses: boolean;
  gtmStatusesError: boolean;
}) {
  const evidenceUrl = safeUrl(event.url);
  return <article data-testid={`card-intent-event-${event.id}`} className="relative pl-8 pb-6 last:pb-0 border-l border-[#D9E6D6] ml-2.5">
    <div className="absolute -left-[6px] top-0.5 h-3 w-3 rounded-full bg-[#4A805A] border-2 border-[#F8FAF4]" />
    <div className="rounded-xl border border-[#E1E8DC] bg-[#FFFEFA] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><div><div className="flex gap-2 items-center flex-wrap"><span className="text-[10px] uppercase tracking-widest font-black text-[#315B3C] bg-[#E8F2D4] rounded px-2 py-1">{sourceLabel(event.source)}</span><span className="text-[10px] text-[#718074] font-bold uppercase tracking-wide">{event.type.replace(/[_-]/g, " ")}</span></div><div className="mt-2 flex flex-wrap items-center gap-2"><p className="text-xs text-[#526357]">{event.contactName || "Account-level signal"}</p>{event.contactId && event.contactName?.trim() && <GtmStatusBadge scope="contact" status={gtmStatuses?.[event.contactId]} loading={loadingGtmStatuses} error={gtmStatusesError} />}</div></div><span className="text-lg font-black tabular-nums text-[#204A32]">{event.points > 0 ? "+" : ""}{event.points}<span className="text-[10px] font-semibold text-[#7B8C7E] ml-1">pts</span></span></div>
      {event.evidence && <p className="mt-3 text-sm leading-relaxed text-[#263D30]">{event.evidence}</p>}
      {event.tags?.length > 0 && <div className="flex flex-wrap gap-1.5 mt-3">{event.tags.map(tag => <span key={tag} className="rounded-full border border-[#D5E4CF] px-2 py-0.5 text-[10px] font-bold text-[#3E6647]">{tag}</span>)}</div>}
      <div className="mt-3 pt-3 border-t border-[#EDF0E9] flex flex-wrap items-center gap-x-5 gap-y-1 text-[10px] text-[#6A786B]"><span>Event time <strong className="text-[#415746]">{formatTime(event.occurredAt)}</strong></span><span>Imported <strong className="text-[#415746]">{formatTime(event.importedAt)}</strong></span>{evidenceUrl && <a data-testid={`link-intent-evidence-${event.id}`} target="_blank" rel="noopener noreferrer" href={evidenceUrl} className="ml-auto text-[#315B3C] font-black hover:underline">Open evidence <ArrowUpRight className="inline w-3 h-3" /></a>}</div>
    </div>
  </article>;
}

export function IntentOpportunityTimeline() {
  const initial = useMemo(() => new URLSearchParams(window.location.search), []);
  const [accountId, setAccountId] = useState<number | undefined>(() => Number(initial.get("accountId")) || undefined);
  const [productId, setProductId] = useState(initial.get("productId") || "");
  const [clientId, setClientId] = useState(initial.get("clientId") || "");
  const [status, setStatus] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [person, setPerson] = useState("");
  const [tag, setTag] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<number[]>([0]);
  useEffect(() => { const timer = setTimeout(() => setSearch(searchInput.trim()), 300); return () => clearTimeout(timer); }, [searchInput]);
  useEffect(() => { setPage(1); setCursors([0]); }, [clientId, productId, status, search]);
  const { data: scope } = useIntentScopeOptions();
  const { data: queue, isLoading: loadingQueue, error: queueError, refetch: retryQueue } = useOpportunities({
    page, pageSize: 15, cursor: cursors[page - 1] ?? 0, ...(clientId ? { clientId: Number(clientId) } : {}), ...(productId ? { productId: Number(productId) } : {}), ...(status ? { status } : {}), ...(search ? { search } : {}),
  });
  const { data: timeline, isLoading, error, refetch } = useOpportunityTimeline(accountId, {
    ...(productId ? { productId: Number(productId) } : {}),
    ...(person ? { contactId: Number(person) } : {}), ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}),
  });
  const events = useMemo(() => (timeline?.events || []).filter(e => !tag || e.tags?.some(t => t.toLowerCase().includes(tag.toLowerCase()))), [timeline?.events, tag]);
  const renderedContactIds = [
    ...(timeline?.people.map(personRecord => personRecord.id) ?? []),
    ...events.filter(event => event.contactId && event.contactName?.trim()).map(event => event.contactId),
  ];
  const { data: gtmStatuses, isLoading: loadingGtmStatuses, error: gtmStatusesError } = useGtmStatuses(renderedContactIds);
  return <section className="max-w-[1360px] mx-auto space-y-5">
    <div className="rounded-2xl bg-[#183626] text-[#EFF5E7] p-6 md:p-8 flex flex-wrap justify-between items-end gap-5">
      <div><p className="text-[10px] font-black tracking-[.2em] uppercase text-[#C9E59A]">Intent intelligence / evidence trail</p><h2 className="text-2xl md:text-3xl font-black tracking-tight mt-2">Account & person timeline</h2><p className="text-xs text-[#B9CABB] mt-2 max-w-xl">Trace the signals behind an opportunity: who acted, what changed, and when it was observed versus imported.</p></div>
      <Link href="/intent/sales-dashboard" className="inline-flex items-center gap-2 rounded-lg border border-[#55715A] px-4 py-2.5 text-xs font-black hover:bg-[#2D5138]"><ArrowLeft className="w-4 h-4" /> Sales cockpit</Link>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-5 items-start">
      <aside className="rounded-2xl border border-[#DBE5D8] bg-[#FEFFF9] overflow-hidden lg:sticky lg:top-4">
        <div className="p-5 border-b border-[#E4EBE0]"><h3 className="font-black text-[#183626]">Find an account</h3><p className="text-xs text-[#748276] mt-1">Select an account–product record.</p></div>
        <div className="p-4 space-y-3 border-b border-[#E4EBE0]">
          <div className="relative"><Search className="w-4 h-4 absolute top-2.5 left-3 text-[#869989]" /><input data-testid="input-timeline-search" className={field + " pl-9"} value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="Search account or product" /></div>
          <div className="grid grid-cols-2 gap-2"><select data-testid="select-timeline-client" aria-label="Client" className={field} value={clientId} onChange={e => setClientId(e.target.value)}><option value="">All clients</option>{scope?.clients.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select><select data-testid="select-timeline-status" aria-label="Status" className={field} value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option></select></div>
          <select data-testid="select-timeline-product" aria-label="Product" className={field} value={productId} onChange={e => setProductId(e.target.value)}><option value="">All products</option>{scope?.products.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select>
        </div>
        <div className="max-h-[420px] overflow-y-auto divide-y divide-[#E7EDE4]">{loadingQueue ? <div className="p-4 space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div> : queueError ? <div className="p-4 text-xs text-red-700" role="alert">Account list unavailable: {(queueError as Error).message}<button className="block underline mt-2" onClick={() => retryQueue()}>Retry</button></div> : !queue?.items.length ? <p className="p-6 text-xs text-[#718074]">No accounts match this search.</p> : queue.items.map(o => <button key={`${o.accountId}-${o.productId}`} data-testid={`button-timeline-account-${o.accountId}-${o.productId}`} onClick={() => { setAccountId(o.accountId); setProductId(String(o.productId)); setPerson(""); setTag(""); }} className={`w-full text-left p-4 hover:bg-[#F4F8EF] ${accountId === o.accountId && (!productId || Number(productId) === o.productId) ? "bg-[#EDF4E4] border-l-[3px] border-[#4A805A]" : ""}`}><div className="flex gap-2 justify-between items-start"><span className="text-xs font-black text-[#23432E]">{o.accountName}</span><span className="text-[10px] uppercase font-black text-[#4A805A]">{o.status}</span></div><span className="block text-[11px] text-[#69796D] mt-1">{o.productName}</span></button>)}</div>
        {(page > 1 || queue?.hasMore) && <div className="p-3 flex justify-between text-xs border-t border-[#E4EBE0]"><button data-testid="button-timeline-previous" className="font-bold disabled:opacity-30" disabled={page <= 1 || loadingQueue} onClick={() => setPage(p => p - 1)}>Previous</button><span>Page {page}</span><button data-testid="button-timeline-next" className="font-bold disabled:opacity-30" disabled={!queue?.hasMore || queue.nextCursor == null || loadingQueue} onClick={() => { const next = queue?.nextCursor; if (next == null) return; setCursors(current => [...current.slice(0, page), next]); setPage(p => p + 1); }}>Next</button></div>}
      </aside>
      <main className="min-w-0 space-y-4">
        {!accountId ? <div className="rounded-2xl border border-dashed border-[#C8D9C5] bg-[#F8FAF4] py-24 text-center"><CalendarDays className="w-8 h-8 text-[#6C976F] mx-auto" /><h3 className="mt-4 font-black text-[#23432E]">Choose an account to inspect</h3><p className="mt-1 text-xs text-[#69796D]">The full evidence trail will appear here.</p></div>
        : error ? <div role="alert" className="rounded-xl p-8 border border-red-200 bg-red-50 text-sm text-red-800">Timeline could not be loaded: {(error as Error).message}<button data-testid="button-retry-timeline" className="block mt-3 font-bold underline" onClick={() => refetch()}>Try again</button></div>
        : isLoading ? <div className="space-y-3"><Skeleton className="h-36 rounded-xl" /><Skeleton className="h-20 rounded-xl" />{[1,2,3].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}</div>
        : timeline && <><div className="rounded-2xl border border-[#DBE5D8] bg-[#FEFFF9] p-5 md:p-6"><p className={eyebrow}>Selected account</p><div className="flex flex-wrap gap-4 justify-between items-start mt-1"><div><h3 data-testid="text-timeline-account" className="text-xl font-black text-[#183626]">{timeline.accountName}</h3><p className="text-xs text-[#738477] mt-1">{timeline.people.length} known people · {timeline.events.length} recorded events</p></div><Link href={`/intent/accounts/${accountId}${productId ? `?productId=${productId}` : ""}`} className="text-xs font-black text-[#346341] hover:underline">Open account <ArrowUpRight className="inline w-3 h-3" /></Link></div><div className="grid grid-cols-3 gap-2 mt-5">{[["People", timeline.score.people], ["Monitoring", timeline.score.monitoring], ["Total intent", timeline.score.total]].map(([name, score]) => <div key={name} className="bg-[#F1F6EA] rounded-xl px-4 py-3"><p className={eyebrow}>{name}</p><p className="text-2xl font-black tabular-nums text-[#204A32] mt-1">{score}</p></div>)}</div></div>
           <div className="rounded-2xl border border-[#DBE5D8] bg-[#FEFFF9] p-5"><p className={eyebrow}>People · named when known</p>{timeline.people.length ? <div className="mt-3 flex flex-wrap gap-2">{timeline.people.map(personRecord => <button key={personRecord.id} data-testid={`button-timeline-person-${personRecord.id}`} onClick={() => setPerson(person === String(personRecord.id) ? "" : String(personRecord.id))} className={`text-left px-3 py-2 rounded-lg border text-xs ${person === String(personRecord.id) ? "bg-[#E8F2D4] border-[#96BF83]" : "bg-[#FAFCF7] border-[#E1E9DB]"}`}><strong className="text-[#23432E]">{personRecord.name}</strong><span className="ml-2 font-black text-[#4A805A]">{personRecord.score}</span><span className="block text-[#718074] mt-0.5">{personRecord.email || personRecord.tags?.join(" · ") || "Known contact"}</span>{personRecord.name?.trim() && <span className="mt-1 block"><GtmStatusBadge scope="contact" status={gtmStatuses?.[personRecord.id]} loading={loadingGtmStatuses} error={!!gtmStatusesError} /></span>}</button>)}</div> : <p className="mt-3 text-xs text-[#718074]">No named people are associated with this account yet. Account-level signals remain visible.</p>}</div>
          <div className="rounded-2xl border border-[#DBE5D8] bg-[#F8FAF4] p-5"><div className="flex flex-wrap justify-between gap-2 items-center"><div><p className={eyebrow}>Evidence ledger</p><h3 className="font-black text-[#183626] mt-1">Signals over time</h3></div><span className="text-xs text-[#718074]">{events.length} shown</span></div><div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-4"><input data-testid="input-timeline-tag" className={field} placeholder="Filter by tag" value={tag} onChange={e => setTag(e.target.value)} /><label className="text-[10px] text-[#718074]">From<input data-testid="input-timeline-from" type="date" className={field + " mt-1"} value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} /></label><label className="text-[10px] text-[#718074]">To<input data-testid="input-timeline-to" type="date" className={field + " mt-1"} value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} /></label></div>{person && <button data-testid="button-clear-timeline-person" onClick={() => setPerson("")} className="mt-3 text-xs font-bold text-[#346341] underline">Clear person filter</button>}</div>
           {events.length ? <div className="pt-2 pl-2">{events.map(e => <TimelineEvent key={e.id} event={e} gtmStatuses={gtmStatuses} loadingGtmStatuses={loadingGtmStatuses} gtmStatusesError={!!gtmStatusesError} />)}</div> : <div className="rounded-xl border border-dashed border-[#C8D9C5] p-10 text-center text-xs text-[#718074]">No events match these filters. Try another person, tag, or date range.</div>}
        </>}
      </main>
    </div>
  </section>;
}
