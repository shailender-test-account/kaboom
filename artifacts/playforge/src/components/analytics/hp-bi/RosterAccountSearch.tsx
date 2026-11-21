import { useEffect, useState } from "react";
import { useListHpAccountRegister, type HpRosterCandidate } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** A manual selection is never an automatic name-match approval. */
export default function RosterAccountSearch({ clientId, name, onClose, onSelect }: {
  clientId: number; name: string; onClose: () => void; onSelect: (candidate: HpRosterCandidate) => void;
}) {
  const [text, setText] = useState(name);
  const [search, setSearch] = useState(name);
  const [page, setPage] = useState(1);
  useEffect(() => { const timer = setTimeout(() => { setSearch(text.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [text]);
  const q = useListHpAccountRegister({ clientId, search, page, pageSize: 25 }, { query: { enabled: search.length >= 2, staleTime: 0 } });
  const items = q.data?.items.filter(r => r.hpId) ?? [];
  return <Dialog open onOpenChange={open => !open && onClose()}><DialogContent data-testid="roster-search" className="max-w-lg">
    <DialogHeader><DialogTitle>Find a roster account</DialogTitle></DialogHeader>
    <p className="text-xs text-muted-foreground">Search by workbook account name, parent or HP ID. Selection still requires confirmation and does not merge legal identities.</p>
    <input aria-label="Search roster accounts" data-testid="input-roster-search" value={text} onChange={e => setText(e.target.value)} className="w-full rounded border p-2 text-sm" />
    {search.length < 2 && <p className="text-xs">Enter at least two characters.</p>}
    {q.isLoading && <p role="status">Searching…</p>}
    {q.isError && <p role="alert">{(q.error as Error).message} <button type="button" onClick={() => void q.refetch()}>Retry</button></p>}
    {!q.isLoading && search.length >= 2 && !items.length && <p className="text-xs">No roster accounts on this page. Refine the name or try another results page.</p>}
    <ul className="max-h-72 overflow-y-auto space-y-2">{items.map(r => <li key={r.companyId} className="rounded border p-2 text-xs">
      <strong>{r.name}</strong><p>{r.hpId} / {r.parentName}</p>
      <button type="button" data-testid={`manual-roster-select-${r.companyId}`} className="mt-1 rounded bg-[#0B2A4A] px-2 py-1 text-white"
        onClick={() => onSelect({ accountId: r.companyId, name: r.name, hpId: r.hpId!, parentName: r.parentName ?? r.name, reason: "Manual administrator selection" })}>Select for review</button>
    </li>)}</ul>
    <div className="flex justify-between text-xs"><button type="button" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</button>
      <span>Page {page}</span><button type="button" disabled={!q.data || page * 25 >= q.data.total} onClick={() => setPage(p => p + 1)}>Next</button></div>
  </DialogContent></Dialog>;
}
