import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBuyingOptions, useBuyingPlan, useBuyingPlans, type CommitteeCopy } from "@/components/buying-committee/api";
import PlanBuilder, { draftFromCopy, draftFromPlan, emptyDraft } from "@/components/buying-committee/PlanBuilder";
import PlanDetail from "@/components/buying-committee/PlanDetail";

export default function BuyingCommitteePage() {
  const search = useSearch();
  // Query IDs are strict: malformed links must not silently choose another plan.
  const params = new URLSearchParams(search);
  const rawPlanId = params.get("planId");
  const selected = rawPlanId && /^[1-9]\d*$/.test(rawPlanId) && Number(rawPlanId) <= 2147483647 ? Number(rawPlanId) : undefined;
  const invalidPlan = rawPlanId !== null && selected === undefined;
  const [, navigate] = useLocation();
  const opts = useBuyingOptions();
  const [listClientId, setClientId] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<"none" | "new" | "edit" | "copy">("none");
  const [copied, setCopied] = useState<CommitteeCopy>();
  const selPlan = useBuyingPlan(selected);
  const clientId = selected ? selPlan.data?.plan.client_id : invalidPlan ? undefined : listClientId;
  useEffect(() => { if (!listClientId && opts.data?.clients[0]) setClientId(opts.data.clients[0].id); }, [opts.data, listClientId]);
  useEffect(() => { setPage(1); setMode("none"); }, [search]);
  const plans = useBuyingPlans(clientId, page);
  const selectPlan = (id?: number) => { setMode("none"); setCopied(undefined); navigate(`/intent/buying-committee${id ? `?planId=${id}` : ""}`); };
  const o = opts.data;

  return <div className="flex min-h-full min-w-0 flex-col bg-background text-foreground">
    <header className="border-b bg-card px-6 py-5">
      <h1 className="text-2xl font-semibold tracking-tight">Buying Committee</h1>
      <p className="mt-1 text-sm text-muted-foreground">Build and manage account buying committees independently of intent scoring.</p>
    </header>
    <div className="mx-auto w-full min-w-0 max-w-[1100px] space-y-6 p-4 sm:p-6">
      {rawPlanId !== null && <Button variant="outline" onClick={() => window.history.length > 1 ? window.history.back() : navigate("/analytics")}>Back</Button>}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-xl font-bold text-stone-900">Buying committee plans</h2>
          <p className="mt-1 text-sm font-medium text-stone-500">Evidence-backed contacts per account. Kept separate from engagement and intent scores.</p></div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <select aria-label="Client" value={clientId ?? ""} onChange={e => { setClientId(Number(e.target.value)); selectPlan(); setPage(1); }} className="h-10 rounded-md border border-stone-200 bg-white px-3 text-sm font-semibold">
            {!clientId && <option value="">Select client</option>}
            {o?.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
           {o?.canManage && <Button disabled={!clientId} onClick={() => setMode("new")} className="h-10"><Plus className="mr-2 h-4 w-4" />New plan</Button>}
        </div>
      </div>

      {opts.isError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">{(opts.error as Error).message} <button className="underline" onClick={() => opts.refetch()}>Retry</button></p>}
      {opts.isLoading && <div className="h-24 animate-pulse rounded-xl bg-stone-200" />}
      {o && !o.configured && <p className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">Internal database matching is available. Configure Contact discovery in Settings &gt; Integrations for external fallback when no matching internal contacts are found.</p>}

      {mode !== "none" && o?.canManage && clientId && (mode === "new" || mode === "copy" && copied || mode === "edit" && selPlan.data?.plan.status === "draft") && <PlanBuilder key={mode + (selected ?? "")} clientId={clientId} databases={o.databases} maxRequests={o.maxRequests} countries={o.countries} copied={mode === "copy"}
        editing={mode === "edit" ? selPlan.data?.plan : undefined}
        initial={mode === "copy" && copied ? draftFromCopy(copied) : mode === "edit" && selPlan.data ? draftFromPlan(selPlan.data.plan, Object.fromEntries(selPlan.data.targets.map(t => [t.company_id, t.name]))) : emptyDraft()}
        onSaved={id => { selectPlan(id); setPage(1); }} onCancel={() => { setMode("none"); setCopied(undefined); }} />}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-widest text-stone-500">Saved plans</h3>
          {plans.isLoading && <div className="h-20 animate-pulse rounded-lg bg-stone-200" />}
          {plans.isError && <p role="alert" className="text-xs text-red-700">{(plans.error as Error).message} <button className="underline" onClick={() => plans.refetch()}>Retry</button></p>}
          {plans.data?.items.length === 0 && <div className="rounded-xl border border-dashed border-stone-300 bg-white p-6 text-center text-sm text-stone-500">No plans for this client yet.</div>}
          {plans.data?.items.map(p => <button key={p.id} onClick={() => selectPlan(p.id)} className={`w-full rounded-lg border bg-card p-3 text-left ${selected === p.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
            <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-bold text-stone-900">{p.name}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${p.status === "approved" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{p.status}</span></div>
            <div className="mt-1 text-[11px] text-stone-500">{p.config.accountIds.length} accounts / {new Date(p.created_at).toLocaleDateString()}</div></button>)}
          {(plans.data?.total ?? 0) > 10 && <div className="flex items-center justify-between text-xs">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span>Page {page} of {Math.ceil((plans.data?.total ?? 0) / 10)}</span>
            <Button size="sm" variant="outline" disabled={page * 10 >= (plans.data?.total ?? 0)} onClick={() => setPage(page + 1)}>Next</Button></div>}
        </aside>
        <section>
          {invalidPlan && <p role="alert" className="text-sm text-red-800">Invalid buying committee plan link. Select a client and a saved plan.</p>}
          {selected && o ? <PlanDetail key={selected} id={selected} canManage={o.canManage} configured={o.configured} maxRequests={o.maxRequests} onEdit={() => setMode("edit")}
            onCopy={copy => { setCopied(copy); setMode("copy"); }} /> :
            <div className="rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center"><p className="font-bold text-stone-800">Select a plan</p>
              <p className="mt-1 text-sm text-stone-500">Choose a saved plan to review targets, approve it, or preview contacts.</p></div>}
        </section>
      </div>
    </div>
  </div>;
}
