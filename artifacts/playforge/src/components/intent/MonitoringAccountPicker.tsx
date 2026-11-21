import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useGetMonitoringAccountOptions } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export default function MonitoringAccountPicker({ clientId, audiences, selected, onChange, selectedAudienceIds = [], onSelectAudience }: {
  clientId: number | null; audiences: { id: number; name: string }[];
  selected: number[]; onChange: (ids: number[]) => void;
  selectedAudienceIds?: number[]; onSelectAudience?: (id: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [audienceId, setAudienceId] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useGetMonitoringAccountOptions({ clientId: clientId ?? undefined, audienceId,
    search: debounced || undefined, page, pageSize: 25 });
  const picked = useGetMonitoringAccountOptions({ clientId: clientId ?? undefined, ids: selected.join(",") || undefined },
    { query: { enabled: selected.length > 0 } });
  const names = new Map([...(picked.data?.items ?? []), ...(query.data?.items ?? [])].map(a => [a.id, a.name]));
  return <section className="space-y-3" aria-label="Choose individual accounts">
    <div><h4 className="text-xs font-bold uppercase tracking-widest text-stone-500">Choose a few accounts</h4>
      <p className="mt-1 text-xs text-stone-500">Browse your GCC or another uploaded list, then check only the accounts to monitor. Browsing a list does not select the whole database.</p></div>
    <label className="block text-xs font-semibold text-stone-700">Browse uploaded list
      <select aria-label="Browse uploaded list" value={audienceId ?? ""}
        onChange={event => { setAudienceId(event.target.value ? Number(event.target.value) : undefined); setPage(1); }}
        className="mt-1 h-9 w-full rounded border bg-white px-2 text-sm">
        <option value="">All available accounts</option>
        {audiences.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </label>
    {audienceId && onSelectAudience && <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
      <Button type="button" size="sm" variant="outline" disabled={selectedAudienceIds.includes(audienceId)}
        onClick={() => onSelectAudience(audienceId)}>
        {selectedAudienceIds.includes(audienceId) ? "Entire list selected" : "Monitor entire list"}
      </Button>
      <p className="mt-2 text-xs text-emerald-900">Includes all client-assigned accounts in this uploaded list, including future additions—not just this page. Save the schedule to apply. Daily limits and recheck intervals still apply.</p>
    </div>}
    {!audiences.length && <p className="text-xs text-amber-800">No uploaded account lists are available for this client. <Link href="/intent/ingest" className="font-semibold underline">Import your GCC account list</Link>, then return here.</p>}
    <input aria-label="Search accounts by name or domain" placeholder="Search company name or domain…"
      value={search} onChange={event => setSearch(event.target.value)} className="h-9 w-full rounded border bg-white px-3 text-sm" />
    <div className="flex items-center justify-between text-xs"><strong>{selected.length} individual accounts selected</strong>
      {!!selected.length && <button type="button" className="underline" onClick={() => onChange([])}>Clear selected accounts</button>}
    </div>
    {!!selected.length && <div className="flex max-h-32 flex-wrap gap-1 overflow-auto" aria-label="Selected accounts">
      {selected.map(id => <button key={id} type="button" aria-label={`Remove ${names.get(id) ?? `account ${id}`}`}
        onClick={() => onChange(selected.filter(value => value !== id))}
        className="max-w-full truncate rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-900">
        {names.get(id) ?? `Account #${id}`} ×
      </button>)}
    </div>}
    {picked.isError && selected.length > 0 && <p role="alert" className="text-xs text-amber-800">Selected account names could not load. Your selected IDs are retained. <button type="button" className="underline" onClick={() => picked.refetch()}>Retry</button></p>}
    <div className="max-h-64 overflow-auto rounded border bg-stone-50 p-2">
      {query.isLoading ? <p role="status" className="p-3 text-xs">Loading accounts…</p> :
        query.isError ? <p role="alert" className="p-3 text-xs text-red-700">Could not load accounts. <button type="button" className="underline" onClick={() => query.refetch()}>Retry</button></p> :
        !query.data?.items.length ? <p className="p-3 text-xs text-stone-500">No matching accounts. Change the search or import your GCC list.</p> :
        query.data.items.map(a => <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded p-2 hover:bg-white">
          <input type="checkbox" aria-label={`Monitor ${a.name}`} checked={selected.includes(a.id)}
            disabled={!selected.includes(a.id) && selected.length >= 200}
            onChange={() => onChange(selected.includes(a.id) ? selected.filter(id => id !== a.id) : [...selected, a.id])} />
          <span className="min-w-0"><strong className="block truncate text-xs">{a.name}</strong><span className="block truncate text-[10px] text-stone-500">{a.domain || "Individual account"}</span></span>
        </label>)}
    </div>
    <div className="flex items-center justify-between">
      <Button type="button" size="sm" variant="outline" disabled={page === 1 || query.isFetching} onClick={() => setPage(p => p - 1)}>Previous</Button>
      <span className="text-xs text-stone-500">Page {page} · up to 25 accounts</span>
      <Button type="button" size="sm" variant="outline" disabled={!query.data?.hasMore || query.isFetching} onClick={() => setPage(p => p + 1)}>Next</Button>
    </div>
    <p className="text-[11px] text-stone-500">Selections are retained across searches and pages. Accounts must be assigned to a client to be monitored. Up to 200 individually selected accounts per schedule.</p>
  </section>;
}
