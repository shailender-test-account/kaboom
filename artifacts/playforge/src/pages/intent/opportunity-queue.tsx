import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowDownToLine, ArrowRight, ChevronLeft, ChevronRight, ExternalLink, FileSpreadsheet, Search, X } from "lucide-react";
import { useIntentScopeOptions } from "@/hooks/use-intent";
import { downloadHotOpportunities, useOpportunities, useOpportunityHandoff, useOpportunityHandoffs, type Opportunity } from "@/hooks/use-opportunities";
import { Skeleton } from "@/components/ui/skeleton";
import { INTENT_CATEGORY_NAMES } from "@/lib/intent-scope";
import { formatReportDateTime } from "@/lib/reportTime";

const dateLabel = (value: string | null | undefined) => value && !Number.isNaN(new Date(value).getTime())
  ? formatReportDateTime(value)
  : "Not recorded";
export const sourceLabel = (source: string) => {
  const s = source.toLowerCase();
  if (s.includes("form")) return "Form";
  if (s.includes("event")) return "Event";
  if (s.includes("monitor") || s.includes("research")) return "Monitoring";
  return source.replace(/[_-]/g, " ") || "Unclassified";
};
const field = "h-9 w-full rounded-lg border border-stone-200 bg-[#FBFCF8] px-3 text-xs font-semibold text-stone-700 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100";
const label = "text-[10px] font-black uppercase tracking-[.12em] text-stone-500";
const statusTone = (status: string) => status.toLowerCase() === "hot"
  ? "bg-[#E8F2D4] text-[#275329] border-[#C7E5A6]"
  : status.toLowerCase() === "warm" ? "bg-amber-50 text-amber-800 border-amber-200" : "bg-stone-100 text-stone-600 border-stone-200";

function HandoffHistory({ accountId }: { accountId: number }) {
  const { data, isLoading, error, refetch } = useOpportunityHandoffs(accountId);
  const entries: Record<string, unknown>[] = Array.isArray(data) ? data : data && typeof data === "object"
    ? (["items", "handoffs", "history"].map(key => (data as Record<string, unknown>)[key]).find(Array.isArray) as Record<string, unknown>[] || []) : [];
  if (isLoading) return <div className="space-y-2">{[1, 2].map(n => <Skeleton key={n} className="h-10 w-full" />)}</div>;
  if (error) return <div role="alert" className="text-xs text-red-700">History unavailable: {(error as Error).message} <button data-testid="button-retry-handoff-history" className="underline" onClick={() => refetch()}>Retry</button></div>;
  if (!entries.length) return <p className="text-xs text-stone-500">No previous sheet handoffs for this account.</p>;
  return <div className="max-h-40 overflow-y-auto divide-y divide-stone-200">{entries.map((entry, i) => (
    <div key={String(entry.id ?? i)} className="py-2 text-xs flex items-start justify-between gap-3">
      <div className="min-w-0"><p className="font-bold text-stone-800 truncate">{String(entry.spreadsheetId ?? entry.spreadsheet ?? "Google Sheet")}</p><p className="text-stone-500">{dateLabel(String(entry.createdAt ?? entry.handedOffAt ?? entry.sentAt ?? ""))}</p></div>
      <span className="capitalize text-stone-600">{String(entry.status ?? "Recorded")}</span>
    </div>
  ))}</div>;
}

function SheetHandoff({ opportunity, close }: { opportunity: Opportunity; close: () => void }) {
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [range, setRange] = useState("");
  const [feedback, setFeedback] = useState("");
  const handoff = useOpportunityHandoff();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFeedback("");
    const input = spreadsheetId.trim();
    const parsed = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    const id = parsed ? parsed[1] : input;
    if (!id) { setFeedback("Enter a spreadsheet ID or Google Sheets URL."); return; }
    try {
      const result = await handoff.mutateAsync({ accountId: opportunity.accountId, productId: opportunity.productId, spreadsheetId: id, ...(range.trim() ? { range: range.trim() } : {}) });
      const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
      setFeedback(record.status === "pending"
        ? "A handoff to this sheet is already in progress. Check its status in the history below."
        : `Sheet write completed${record.duplicate ? " · already present in this sheet" : ""}${record.range ? ` · ${record.range}` : ""}.`);
    } catch (error) { setFeedback(`Sheet write failed: ${error instanceof Error ? error.message : "Unknown error"}`); }
  };
  return <div className="fixed inset-0 z-50 bg-[#11281C]/50 flex items-end sm:items-center justify-center p-0 sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div role="dialog" aria-modal="true" aria-label="Google Sheets handoff" className="w-full sm:max-w-lg bg-[#FAFBF7] rounded-t-2xl sm:rounded-2xl border border-stone-200 shadow-2xl max-h-[90dvh] overflow-y-auto">
      <div className="flex items-start justify-between p-6 border-b border-stone-200">
        <div><div className={label}>Selected opportunity / Google Sheets</div><h3 className="text-xl font-black tracking-tight text-[#173626] mt-1">{opportunity.accountName}</h3><p className="text-xs text-stone-500 mt-1">{opportunity.productName}</p></div>
        <button type="button" data-testid="button-close-handoff" aria-label="Close" className="p-2 rounded-lg hover:bg-stone-100" onClick={close}><X className="w-4 h-4" /></button>
      </div>
      <form onSubmit={submit} className="p-6 space-y-4">
        <p className="text-xs leading-relaxed text-stone-600">Write this account–product opportunity to a sheet you choose. Only this selected row is sent.</p>
        <label className="block space-y-1.5"><span className={label}>Spreadsheet ID or URL</span><input data-testid="input-handoff-spreadsheet" required className={field} value={spreadsheetId} onChange={e => setSpreadsheetId(e.target.value)} placeholder="Paste a Google Sheets URL or ID" /></label>
        <label className="block space-y-1.5"><span className={label}>Range · optional</span><input data-testid="input-handoff-range" className={field} value={range} onChange={e => setRange(e.target.value)} placeholder="e.g. Opportunities!A:H" /></label>
        <button data-testid="button-write-sheet" type="submit" disabled={handoff.isPending} className="w-full h-10 rounded-lg bg-[#173626] hover:bg-[#28523A] disabled:opacity-50 text-[#E8F3CA] text-xs font-black flex items-center justify-center gap-2"><FileSpreadsheet className="w-4 h-4" />{handoff.isPending ? "Writing to sheet…" : "Write selected opportunity"}</button>
        {feedback && <p role="status" data-testid="status-handoff-result" className={`rounded-lg p-3 text-xs font-semibold ${feedback.includes("failed") ? "bg-red-50 text-red-800" : "bg-[#E8F2D4] text-[#275329]"}`}>{feedback}</p>}
      </form>
      <div className="border-t border-stone-200 px-6 pb-6 pt-4"><h4 className={label + " mb-3"}>Handoff history</h4><HandoffHistory accountId={opportunity.accountId} /></div>
    </div>
  </div>;
}

export function OpportunityQueue({
  categoryNames = [],
  legacyCategoryIds = [],
}: {
  categoryNames?: string[];
  legacyCategoryIds?: number[];
}) {
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<number[]>([0]);
  const [status, setStatus] = useState("");
  const [clientId, setClientId] = useState("");
  const [productId, setProductId] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Opportunity | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const { data: scope } = useIntentScopeOptions();
  useEffect(() => { const timer = setTimeout(() => setSearch(searchInput.trim()), 300); return () => clearTimeout(timer); }, [searchInput]);
  useEffect(() => { setPage(1); setCursors([0]); }, [status, clientId, productId, categoryName, search, categoryNames.join(","), legacyCategoryIds.join(",")]);
  useEffect(() => { setCategoryName(""); }, [categoryNames.join(",")]);
  const effectiveCategoryName = categoryName || (categoryNames.length === 1 ? categoryNames[0] : "");
  const effectiveLegacyCategoryId = !effectiveCategoryName && categoryNames.length === 0 && legacyCategoryIds.length === 1
    ? legacyCategoryIds[0] : undefined;
  const filters = {
    page, pageSize: 10, cursor: cursors[page - 1] ?? 0,
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    ...(clientId ? { clientId: Number(clientId) } : {}),
    ...(productId ? { productId: Number(productId) } : {}),
    ...(effectiveCategoryName ? { categoryName: effectiveCategoryName } : {}),
    ...(effectiveLegacyCategoryId ? { categoryId: effectiveLegacyCategoryId } : {}),
  };
  const { data, isLoading, isFetching, error, refetch } = useOpportunities(filters);
  const accountDetailsHref = (item: Opportunity) => {
    const params = new URLSearchParams({ productId: String(item.productId) });
    if (effectiveCategoryName) params.set("categoryName", effectiveCategoryName);
    else if (effectiveLegacyCategoryId) params.set("categoryId", String(effectiveLegacyCategoryId));
    return `/intent/accounts/${item.accountId}?${params}`;
  };
  const exportHot = async () => {
    setExporting(true); setExportMessage("");
    try {
      await downloadHotOpportunities({
        ...(clientId ? { clientId: Number(clientId) } : {}),
        ...(productId ? { productId: Number(productId) } : {}),
        ...(effectiveCategoryName ? { categoryName: effectiveCategoryName } : {}),
        ...(effectiveLegacyCategoryId ? { categoryId: effectiveLegacyCategoryId } : {}),
      });
      setExportMessage("Hot opportunities CSV downloaded for the current scope.");
    } catch (e) { setExportMessage(`Export failed: ${e instanceof Error ? e.message : "Unknown error"}`); }
    finally { setExporting(false); }
  };
  return <section className="rounded-[16px] border border-stone-200 bg-[#FFFEFA] shadow-sm overflow-hidden" aria-label="Opportunity queue">
    <div className="p-5 md:p-6 border-b border-stone-200 flex flex-wrap items-start justify-between gap-4 bg-[#F2F5ED]">
      <div><div className={label}>Decision workspace / 01</div><h2 className="text-xl md:text-2xl font-black tracking-tight text-[#173626] mt-1">Opportunity queue</h2><p className="text-xs text-stone-600 mt-1.5">Account × product decisions, grounded in people and monitoring signals.</p></div>
      <button type="button" data-testid="button-export-hot-csv" disabled={exporting} onClick={exportHot} className="h-9 px-4 rounded-lg bg-[#173626] text-[#E8F3CA] hover:bg-[#28523A] disabled:opacity-50 text-xs font-black flex items-center gap-2"><ArrowDownToLine className="w-4 h-4" />{exporting ? "Preparing CSV…" : "Export Hot CSV"}</button>
    </div>
    <div className="p-4 md:p-5 grid grid-cols-2 md:grid-cols-6 gap-3 border-b border-stone-200">
      <label className="col-span-2 space-y-1"><span className={label}>Search opportunities</span><div className="relative"><Search className="absolute left-3 top-2.5 w-4 h-4 text-stone-400" /><input data-testid="input-opportunity-search" className={field + " pl-9"} placeholder="Account, product or reason" value={searchInput} onChange={e => setSearchInput(e.target.value)} /></div></label>
       <label className="space-y-1"><span className={label}>Status</span><select data-testid="select-opportunity-status" className={field} value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="review">Needs review</option></select></label>
      <label className="space-y-1"><span className={label}>Client</span><select data-testid="select-opportunity-client" className={field} value={clientId} onChange={e => setClientId(e.target.value)}><option value="">All clients</option>{scope?.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="space-y-1"><span className={label}>Product</span><select data-testid="select-opportunity-product" className={field} value={productId} onChange={e => setProductId(e.target.value)}><option value="">All products</option>{scope?.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="space-y-1"><span className={label}>Category</span><select data-testid="select-opportunity-category" className={field} value={categoryName} onChange={e => setCategoryName(e.target.value)}><option value="">Dashboard scope</option>{INTENT_CATEGORY_NAMES.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
    </div>
    {categoryNames.length > 1 && !categoryName && <p className="px-5 pt-3 text-[11px] text-amber-800">The dashboard scope includes multiple categories. Choose one category above to narrow this queue; the summary cards retain their combined scope.</p>}
    {exportMessage && <p role="status" data-testid="status-hot-export" className={`mx-5 mt-4 rounded-lg px-3 py-2 text-xs font-semibold ${exportMessage.startsWith("Export failed") ? "bg-red-50 text-red-800" : "bg-[#E8F2D4] text-[#275329]"}`}>{exportMessage}</p>}
    {error ? <div role="alert" className="p-12 text-center"><p className="font-bold text-stone-800">The opportunity queue could not be loaded.</p><p className="text-xs text-red-700 mt-2">{(error as Error).message}</p><button data-testid="button-retry-opportunities" onClick={() => refetch()} className="mt-4 text-xs font-black underline text-emerald-800">Try again</button></div>
      : isLoading ? <div className="p-5 space-y-3">{[1, 2, 3, 4].map(n => <Skeleton key={n} className="h-28 w-full rounded-xl" />)}</div>
      : !data?.items.length ? <div className="px-6 py-16 text-center"><div className="mx-auto w-12 h-12 rounded-2xl bg-[#E8F2D4] flex items-center justify-center text-[#275329]"><Search className="w-5 h-5" /></div><h3 className="mt-4 text-base font-black text-[#173626]">{data?.hasMore ? "No matches in this batch" : "No opportunities in this view"}</h3><p className="mt-1 text-xs text-stone-500">{data?.hasMore ? "Continue to search the remaining accounts." : "Try a different status, scope or search term."}</p><button data-testid="button-reset-opportunity-filters" onClick={() => { setStatus(""); setClientId(""); setProductId(""); setCategoryName(""); setSearchInput(""); }} className="mt-4 text-xs font-black underline text-emerald-800">Clear queue filters</button></div>
      : <div className={`divide-y divide-stone-200 ${isFetching ? "opacity-70" : ""}`}>{data.items.map(item => <article key={`${item.accountId}-${item.productId}`} data-testid={`card-opportunity-${item.accountId}-${item.productId}`} className="p-5 md:px-6 md:py-5 hover:bg-[#FAFCF5] transition-colors">
        <div className="flex flex-wrap justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap"><span className={`text-[10px] font-black uppercase tracking-widest rounded-full px-2.5 py-1 border ${statusTone(item.status)}`}>{item.status}</span><span className="text-[10px] font-bold uppercase tracking-widest text-stone-500">{sourceLabel(item.source)}</span><span className="text-[10px] text-stone-400">{item.categoryName}</span></div>
            <h3 className="text-base font-black text-[#173626] mt-2">{item.accountName} <span className="font-medium text-stone-400 mx-1">/</span> {item.productName}</h3>
            <p className="mt-2 text-xs leading-relaxed text-stone-600"><strong className="text-stone-800">Why now:</strong> {item.reason || "No rationale has been recorded yet."}</p>
            <p className="mt-2 text-xs text-stone-600"><strong className="text-stone-800">Known contact:</strong> {item.contact?.name ? <>{item.contact.name}{item.contact.email ? ` · ${item.contact.email}` : ""}</> : "No named contact yet"}</p>
          </div>
          <div className="w-full md:w-52 shrink-0 rounded-xl border border-[#DDE8D2] bg-[#F4F8ED] px-4 py-3"><div className="flex justify-between items-end"><span className={label}>Intent score</span><span className="text-2xl font-black tabular-nums text-[#173626]">{item.score.total}</span></div><div className="mt-2 h-1.5 bg-[#DAE6D4] rounded-full overflow-hidden"><div className="h-full bg-[#427654] rounded-full" style={{ width: `${Math.min(100, Math.max(0, item.score.total))}%` }} /></div><div className="mt-2 flex justify-between text-[10px] font-bold text-stone-600"><span>People {item.score.people}</span><span>Monitoring {item.score.monitoring}</span></div></div>
        </div>
        <div className="mt-4 pt-3 border-t border-stone-100 flex flex-wrap items-center gap-x-5 gap-y-3 text-[11px]"><div className="text-stone-500">Latest action <strong className="text-stone-700">{dateLabel(item.latestActionAt)}</strong></div><div className="text-stone-500">Next step <strong className="text-stone-700">{item.nextStep || "Review evidence and plan outreach"}</strong></div><div className="text-stone-500">Handoff <strong className="text-stone-700">{item.handoffStatus || "Not sent"}</strong></div><div className="md:ml-auto flex items-center gap-3"><Link data-testid={`link-opportunity-account-${item.accountId}-${item.productId}`} href={accountDetailsHref(item)} className="font-black text-[#315B3C] hover:underline">Account <ExternalLink className="inline w-3 h-3" /></Link><Link data-testid={`link-opportunity-analytics-${item.accountId}-${item.productId}`} href={`/analytics?section=intent-timeline&accountId=${item.accountId}&productId=${item.productId}&clientId=${item.clientId}`} className="font-black text-[#315B3C] hover:underline">Timeline <ArrowRight className="inline w-3 h-3" /></Link><button type="button" data-testid={`button-handoff-${item.accountId}-${item.productId}`} onClick={() => setSelected(item)} className="px-3 py-2 bg-[#E8F2D4] hover:bg-[#D9EABF] rounded-lg font-black text-[#275329]">Write to Sheet</button></div></div>
      </article>)}</div>}
    <div className="px-5 py-4 bg-[#FAFBF7] border-t border-stone-200 flex items-center justify-between text-xs text-stone-500"><span data-testid="text-opportunity-count">{data ? `Page ${data.page}${data.hasMore ? " · more accounts to scan" : " · end of results"}` : "Opportunity queue"}</span><div className="flex gap-2"><button data-testid="button-opportunity-prev" disabled={page <= 1 || isFetching} onClick={() => setPage(p => Math.max(1, p - 1))} className="p-2 rounded-lg border border-stone-200 disabled:opacity-30 hover:bg-stone-100" aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button><button data-testid="button-opportunity-next" disabled={!data?.hasMore || data.nextCursor == null || isFetching} onClick={() => { const next = data?.nextCursor; if (next == null) return; setCursors(current => [...current.slice(0, page), next]); setPage(p => p + 1); }} className="p-2 rounded-lg border border-stone-200 disabled:opacity-30 hover:bg-stone-100" aria-label="Next page"><ChevronRight className="w-4 h-4" /></button></div></div>
    {selected && <SheetHandoff key={`${selected.accountId}-${selected.productId}`} opportunity={selected} close={() => setSelected(null)} />}
  </section>;
}