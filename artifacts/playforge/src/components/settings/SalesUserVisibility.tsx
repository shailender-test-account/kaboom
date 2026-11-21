import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMemberSalesAccess, useSetMemberSalesAccess, getGetMemberSalesAccessQueryKey, getGetSalesAccountOptionsQueryKey, getListSalesHotAccountsQueryKey, getGetSalesVisibilityHistoryQueryKey } from "@workspace/api-client-react";
import { Eye, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import SalesAccessHistory from "@/components/sales-feedback/SalesAccessHistory";

type V = "owned" | "all";
const OPTS: { v: V; l: string; d: string }[] = [
  { v: "owned", l: "Own accounts", d: "Only accounts this user owns, by roster or assignment." },
  { v: "all", l: "All accounts", d: "Every Hot account within this user's client access. For marketing." },
];

export default function SalesUserVisibility({ memberId, isAdmin }: { memberId: number; isAdmin: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = getGetMemberSalesAccessQueryKey(memberId);
  const q = useGetMemberSalesAccess(memberId, { query: { enabled: !!memberId && !isAdmin, queryKey: key } });
  const save = useSetMemberSalesAccess();
  const [value, setValue] = useState<V>("owned");
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (q.data) setValue(q.data.visibility); }, [q.data]);
  const current: V = isAdmin ? "all" : value;
  const dirty = !isAdmin && !!q.data && value !== q.data.visibility;

  const submit = () => {
    setErr(null); setSaved(false);
    save.mutate({ id: memberId, data: { visibility: value } }, {
      onSuccess: res => { qc.setQueryData(key, res);
        qc.invalidateQueries({ queryKey: getGetSalesVisibilityHistoryQueryKey(memberId) });
        qc.invalidateQueries({ queryKey: getGetSalesAccountOptionsQueryKey() });
        qc.invalidateQueries({ queryKey: getListSalesHotAccountsQueryKey() });
        qc.invalidateQueries({ predicate: q => typeof q.queryKey[0] === "string" && /^\/api\/sales\/accounts\/\d+$/.test(q.queryKey[0]) });
        setSaved(true); toast({ title: "Sales account visibility saved" }); },
      onError: e => setErr(e instanceof Error && e.message ? e.message : "Could not save sales account visibility."),
    });
  };

  return (
    <section className="space-y-2 rounded-lg border p-3" aria-labelledby={`sales-vis-${memberId}`} data-testid="section-sales-visibility">
      <h4 id={`sales-vis-${memberId}`} className="flex items-center gap-1.5 text-xs font-medium"><Eye className="h-3.5 w-3.5" />Sales account visibility</h4>
      <p className="text-[11px] text-muted-foreground">Saved separately from section and client access. Client grants still apply.</p>
      {isAdmin ? <p className="text-xs text-muted-foreground" data-testid="text-sales-visibility-admin">Admins always see all accounts.</p>
        : q.isLoading ? <div className="h-14 rounded bg-muted animate-pulse" />
        : q.isError ? <p role="alert" className="text-xs text-destructive">Could not load visibility. <button className="underline" onClick={() => q.refetch()}>Retry</button></p>
        : null}
      <div role="radiogroup" aria-label="Sales account visibility" className="grid gap-2 sm:grid-cols-2">
        {OPTS.map(o => (
          <button key={o.v} type="button" role="radio" aria-checked={current === o.v} disabled={isAdmin || !q.data || save.isPending}
            onClick={() => { setValue(o.v); setSaved(false); }} data-testid={`radio-sales-visibility-${o.v}`}
            className={cn("rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed", current === o.v ? "border-primary bg-accent" : "hover:bg-muted/40", (isAdmin || !q.data) && "opacity-60")}>
            <span className="block text-sm font-medium">{o.l}</span><span className="block text-[11px] text-muted-foreground">{o.d}</span>
          </button>))}
      </div>
      {err && <p role="alert" className="text-xs text-destructive" data-testid="text-sales-visibility-error">{err}</p>}
      {!isAdmin && <div className="flex items-center justify-end gap-2">
        {saved && !dirty && <span role="status" className="text-xs text-emerald-700">Saved</span>}
        <Button size="sm" variant="outline" disabled={!dirty || save.isPending} onClick={submit} data-testid="button-save-sales-visibility">
          {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save sales visibility</Button>
      </div>}
      <SalesAccessHistory key={memberId} id={memberId} kind="visibility" />
    </section>
  );
}
