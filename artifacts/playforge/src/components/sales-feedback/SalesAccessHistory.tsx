import { useState } from "react";
import { useGetSalesOwnerHistory, useGetSalesVisibilityHistory } from "@workspace/api-client-react";
import type { SalesAccessHistoryEntry } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export function SalesAccessHistoryEntryDetails({ entry }: { entry: SalesAccessHistoryEntry }) {
  return <>
    <p><strong>{entry.actor}</strong> · {entry.outcome === "changed" ? "Saved" : entry.outcome === "unchanged" ? "No change" : "Rejected: owners not eligible"}</p>
    <p>Before: {entry.before.join(", ") || "No explicit owners"}</p>
    <p>After: {entry.after.join(", ") || "No explicit owners"}</p>
    <p className="text-muted-foreground">Requested {new Date(entry.requestedAt).toLocaleString()} · Recorded {new Date(entry.recordedAt).toLocaleString()}</p>
  </>;
}

/** Only mount inside administrator controls; the endpoints independently enforce admin access. */
export default function SalesAccessHistory({ id, kind }: { id: number; kind: "owners" | "visibility" }) {
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const params = { beforeId: cursors[cursors.length - 1] };
  const owners = useGetSalesOwnerHistory(id, params, { query: { enabled: open && kind === "owners", refetchInterval: 30_000 } });
  const visibility = useGetSalesVisibilityHistory(id, params, { query: { enabled: open && kind === "visibility", refetchInterval: 30_000 } });
  const q = kind === "owners" ? owners : visibility;
  return <div className="space-y-2 border-t pt-2 text-xs" data-testid={`sales-${kind}-history`}>
    <button type="button" className="font-medium underline" aria-expanded={open}
      onClick={() => { setOpen(!open); setCursors([undefined]); }}>
      {open ? "Hide" : "Show"} {kind === "owners" ? "ownership" : "visibility"} history
    </button>
    {open && <>
      <p className="text-muted-foreground">Admin-only history. Names reflect current profiles; deleted records use IDs.
        {kind === "owners" && " Explicit assignments only; roster ownership is unchanged."}</p>
      {q.isLoading ? <p role="status">Loading history…</p> : q.isError ?
        <p role="alert">Could not load history. <button type="button" className="underline" onClick={() => q.refetch()}>Retry</button></p>
        : q.data && <>
          <p className="font-medium">{q.data.target}</p>
          {!q.data.items.length ? <p className="text-muted-foreground">No recorded changes.</p> :
            <ol className="max-h-72 space-y-3 overflow-y-auto rounded border p-2">
              {q.data.items.map(entry => <li key={entry.id} className="space-y-1">
                <SalesAccessHistoryEntryDetails entry={entry} />
              </li>)}
            </ol>}
          <div className="flex gap-2">
            {cursors.length > 1 && <Button type="button" size="sm" variant="ghost" onClick={() => setCursors(c => c.slice(0, -1))}>Newer</Button>}
            {q.data.nextBeforeId != null && <Button type="button" size="sm" variant="ghost"
              onClick={() => setCursors(c => [...c, q.data!.nextBeforeId!])}>Older</Button>}
          </div>
        </>}
    </>}
  </div>;
}
