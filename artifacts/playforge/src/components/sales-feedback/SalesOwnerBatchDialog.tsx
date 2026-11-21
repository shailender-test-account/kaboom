import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  usePreviewSalesOwnerBatch, useConfirmSalesOwnerBatch, getListSalesHotAccountsQueryKey, getGetSalesAccountQueryKey,
} from "@workspace/api-client-react";
import type { SalesOwnerBatchAssignment, SalesOwnerBatchPreview } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const message = (error: unknown) => {
  const e = error as { data?: { error?: string } };
  return e?.data?.error ?? "Could not complete this request. Reload and review the accounts again before confirming.";
};

export function SalesOwnerBatchDialog({ accountIds, onClose, onSaved }: {
  accountIds: number[]; onClose: () => void; onSaved: (count: number) => void;
}) {
  const qc = useQueryClient();
  const preview = usePreviewSalesOwnerBatch();
  const confirm = useConfirmSalesOwnerBatch();
  const [assignments, setAssignments] = useState<SalesOwnerBatchAssignment[]>(accountIds.map(accountId => ({ accountId, userIds: [] })));
  const [data, setData] = useState<SalesOwnerBatchPreview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = preview.isPending || confirm.isPending;
  const load = () => {
    setError(null);
    setReviewing(false);
    preview.mutate({ data: { assignments } }, {
      onSuccess: result => { setData(result); setReviewing(!!result.reviewToken); },
      onError: error => { setData(null); setError(message(error)); },
    });
  };
  const save = () => {
    if (!reviewing || !data?.reviewToken) return;
    setError(null);
    confirm.mutate({ data: { reviewToken: data.reviewToken } }, {
      onSuccess: result => {
        qc.invalidateQueries({ queryKey: getListSalesHotAccountsQueryKey() });
        for (const id of result.assignedAccounts) qc.invalidateQueries({ queryKey: getGetSalesAccountQueryKey(id) });
        onSaved(result.assignedAccounts.length);
      },
      onError: error => { setReviewing(false); setData(null); setError(message(error)); },
    });
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-2xl" onInteractOutside={event => { if (busy) event.preventDefault(); }}
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>{reviewing ? "Review account assignments" : "Assign unowned Hot accounts"}</DialogTitle>
        <DialogDescription>{accountIds.length} selected accounts. Existing roster ownership stays unchanged.
          This does not grant access rights, call, email or enroll anyone.</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!data && <Button disabled={busy} onClick={load}>Load accounts and eligible users</Button>}
      {data && <div className="max-h-[55vh] overflow-y-auto space-y-3">
        {data.rows.map(row => <fieldset key={row.accountId} disabled={busy} className="rounded border p-3 space-y-2">
          <legend className="px-1 text-sm font-semibold">{row.accountName} · {row.clientName}</legend>
          {reviewing ? <p className="text-sm">Assign to: {row.proposedUsers.map(u => `${u.name} (${u.email})`).join(", ")}</p> : <>
            {!row.assignableUsers.length && <p className="text-sm text-muted-foreground">No eligible users. An administrator must separately grant Sales and client access before assignment.</p>}
            {row.assignableUsers.map(user => <label key={user.id} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={assignments.find(a => a.accountId === row.accountId)!.userIds.includes(user.id)}
                onChange={event => setAssignments(current => current.map(a => a.accountId !== row.accountId ? a : ({
                  ...a, userIds: event.target.checked ? [...a.userIds, user.id] : a.userIds.filter(id => id !== user.id),
                })))} />
              {user.name} · {user.email}
            </label>)}
          </>}
        </fieldset>)}
      </div>}
      <p className="text-xs text-muted-foreground">Up to 25 accounts and 10 owners per account. All assignments save together or none do.
        Reviews expire after 10 minutes; changed ownership or access requires a new review.</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        {reviewing ? <>
          <Button variant="outline" disabled={busy} onClick={() => setReviewing(false)}>Edit choices</Button>
          <Button disabled={busy} onClick={save}>{confirm.isPending ? "Saving…" : "Confirm assignments"}</Button>
        </> : data && <Button disabled={busy || assignments.some(a => !a.userIds.length || a.userIds.length > 10)} onClick={load}>
          {preview.isPending ? "Loading review…" : "Review assignments"}
        </Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
