import { useState } from "react";
import { useListSalesAccessHistory } from "@workspace/api-client-react";
import type { ListSalesAccessHistoryParams } from "@workspace/api-client-react";
import { SalesAccessHistoryEntryDetails } from "@/components/sales-feedback/SalesAccessHistory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const defaults = () => {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { dateFrom: from.toISOString().slice(0, 10), dateTo: to.toISOString().slice(0, 10), actor: "", kind: "" };
};
type Member = { id: number; firstName: string; lastName: string };

function HistoryPanel({ members }: { members: Member[] }) {
  const [draft, setDraft] = useState(defaults);
  const [params, setParams] = useState<ListSalesAccessHistoryParams>(() => {
    const { dateFrom, dateTo } = defaults();
    return { dateFrom, dateTo };
  });
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const [error, setError] = useState("");
  const q = useListSalesAccessHistory({ ...params, beforeId: cursors[cursors.length - 1] },
    { query: { refetchInterval: 30_000, staleTime: 0 } });
  const apply = () => {
    const from = Date.parse(`${draft.dateFrom}T00:00:00Z`), to = Date.parse(`${draft.dateTo}T00:00:00Z`);
    const days = (to - from) / 86400000 + 1;
    if (!Number.isFinite(days) || days < 1 || days > 366) {
      setError("Choose dates in order, spanning no more than 366 days."); return;
    }
    const actorId = draft.actor ? Number(draft.actor) : undefined;
    if (actorId !== undefined && (!Number.isInteger(actorId) || actorId < 1 || actorId > 2147483647)) {
      setError("Enter a valid positive actor ID."); return;
    }
    setError("");
    setCursors([undefined]);
    setParams({ dateFrom: draft.dateFrom, dateTo: draft.dateTo, actorId,
      kind: draft.kind === "owners" || draft.kind === "visibility" ? draft.kind : undefined });
  };
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">
      Ownership assignments and sales visibility across this workspace, including deleted accounts and members.
      Names reflect current profiles; deleted records use IDs. Explicit owners only; roster ownership is unchanged.
      Password and credential history is not included.
    </p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); apply(); }}>
      <div className="space-y-1"><Label htmlFor="sales-history-from">From (UTC)</Label>
        <Input id="sales-history-from" data-testid="input-sales-history-from" type="date" required value={draft.dateFrom}
          onChange={e => setDraft(d => ({ ...d, dateFrom: e.target.value }))} /></div>
      <div className="space-y-1"><Label htmlFor="sales-history-to">Through (UTC)</Label>
        <Input id="sales-history-to" data-testid="input-sales-history-to" type="date" required value={draft.dateTo}
          onChange={e => setDraft(d => ({ ...d, dateTo: e.target.value }))} /></div>
      <div className="space-y-1"><Label htmlFor="sales-history-actor">Actor ID (optional)</Label>
        <Input id="sales-history-actor" data-testid="input-sales-history-actor" type="number" min="1" max="2147483647" step="1"
          list="sales-history-members" placeholder="All actors" value={draft.actor}
          onChange={e => setDraft(d => ({ ...d, actor: e.target.value }))} />
        <datalist id="sales-history-members">{members.map(m =>
          <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>)}</datalist>
      </div>
      <div className="space-y-1"><Label htmlFor="sales-history-kind">Change type</Label>
        <select id="sales-history-kind" data-testid="select-sales-history-kind"
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={draft.kind} onChange={e => setDraft(d => ({ ...d, kind: e.target.value }))}>
          <option value="">All types</option><option value="owners">Ownership</option><option value="visibility">Visibility</option>
        </select></div>
      <Button type="submit" data-testid="button-apply-sales-history">Apply filters</Button>
      <Button type="button" variant="outline" data-testid="button-reset-sales-history" onClick={() => {
        const d = defaults(); setDraft(d); setParams({ dateFrom: d.dateFrom, dateTo: d.dateTo }); setCursors([undefined]); setError("");
      }}>Reset</Button>
      <Button type="button" variant="ghost" disabled={q.isFetching} onClick={() => q.refetch()} data-testid="button-refresh-sales-history">Refresh</Button>
    </form>
    <p className="text-xs text-muted-foreground">At most 366 days per search. Enter any actor ID, including a deleted member’s ID.
      Showing recorded UTC dates {params.dateFrom} through {params.dateTo}{params.actorId ? ` · Actor #${params.actorId}` : ""}
      {params.kind ? ` · ${params.kind === "owners" ? "Ownership" : "Visibility"}` : " · All types"}.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {q.isLoading ? <p role="status">Loading access history…</p> : q.isError ?
      <p role="alert" className="text-sm text-destructive">Could not load access history. <button type="button" className="underline"
        data-testid="button-retry-sales-history" onClick={() => q.refetch()}>Retry</button></p>
      : q.data && <>
        {!q.data.items.length ? <p className="text-sm text-muted-foreground" data-testid="text-sales-history-empty">No recorded changes match these filters.</p> :
          <ol className="max-h-[32rem] overflow-y-auto divide-y rounded-md border" data-testid="list-sales-access-history">
            {q.data.items.map(entry => <li key={entry.id} className="space-y-1 p-3 text-xs" data-testid={`row-sales-history-${entry.id}`}>
              <p className="font-medium">{entry.kind === "owners" ? "Ownership" : "Visibility"} · {entry.target} · {entry.kind === "owners" ? "Account" : "User"} #{entry.targetId}</p>
              <p className="text-muted-foreground">Actor #{entry.actorId} · Entry #{entry.id}</p>
              <SalesAccessHistoryEntryDetails entry={entry} />
            </li>)}
          </ol>}
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={cursors.length === 1 || q.isFetching}
            data-testid="button-newer-sales-history" onClick={() => setCursors(c => c.slice(0, -1))}>Newer</Button>
          <span className="text-xs text-muted-foreground" data-testid="text-sales-history-page">Page {cursors.length}</span>
          <Button type="button" size="sm" variant="outline" disabled={q.data.nextBeforeId == null || q.isFetching}
            data-testid="button-older-sales-history" onClick={() => { if (q.data?.nextBeforeId != null) setCursors(c => [...c, q.data!.nextBeforeId!]); }}>Older</Button>
        </div>
      </>}
  </div>;
}

/** Mounted only by TeamAccessAdmin; the API independently enforces administrator access. */
export default function TenantSalesAccessHistory({ members }: { members: Member[] }) {
  const [open, setOpen] = useState(false);
  return <Card><CardContent className="p-4 space-y-3">
    <Button type="button" variant="outline" aria-expanded={open} aria-controls="tenant-sales-history"
      data-testid="button-toggle-sales-history" onClick={() => setOpen(o => !o)}>
      {open ? "Hide" : "Show"} team-wide sales access history
    </Button>
    {open && <div id="tenant-sales-history"><HistoryPanel members={members} /></div>}
  </CardContent></Card>;
}
