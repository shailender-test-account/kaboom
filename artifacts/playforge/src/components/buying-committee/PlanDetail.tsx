import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useApproveBuyingPlan, useBuyingPlan, useSourceBuyingAccount, useCopyBuyingPlan, type CommitteeCopy, type CommitteeTarget } from "./api";
import CommitteeContacts from "./CommitteeContacts";
import PlanDomains from "./PlanDomains";

const tone = (s: string) => s === "completed" ? "bg-emerald-50 text-emerald-700" : s === "failed" || s === "interrupted" ? "bg-red-50 text-red-700" : s === "processing" ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-600";

export default function PlanDetail({ id, canManage, configured, maxRequests, onEdit, onCopy }: { id: number; canManage: boolean; configured: boolean; maxRequests: number; onEdit: () => void; onCopy?: (copy: CommitteeCopy) => void }) {
  const { toast } = useToast();
  const q = useBuyingPlan(id);
  const approve = useApproveBuyingPlan();
  const source = useSourceBuyingAccount();
  const copy = useCopyBuyingPlan();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [running, setRunning] = useState<number | null>(null), [batch, setBatch] = useState(false), [runError, setRunError] = useState<string | null>(null);
  const [domainsDirty, setDomainsDirty] = useState(false);
  const stop = useRef(false);
  useEffect(() => {
    stop.current = true; setRunError(null);
    return () => { stop.current = true; };
  }, [id]);
  useEffect(() => {
    if (!batch && running === null) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h);
  }, [batch, running]);

  if (q.isLoading) return <div className="h-40 animate-pulse rounded-xl bg-stone-200" />;
  if (q.isError || !q.data) return <p role="alert" className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">{(q.error as Error)?.message ?? "Could not load plan."} <button className="underline" onClick={() => q.refetch()}>Retry</button></p>;
  const { plan, targets } = q.data, cfg = plan.config, approved = plan.status === "approved";
  const budget = Math.min(maxRequests,cfg.requestBudget??maxRequests);
  const estimate = cfg.accountIds.length * 2, over = configured && estimate > budget;
  const pending = targets.filter(t => t.status === "pending");
  const missingDomains = targets.filter(t => !t.domain?.trim());
  const incompleteTargets = targets.length !== cfg.accountIds.length;
  const usedRequests = targets.reduce((n, t) => n + t.requests, 0);
  const done = targets.filter(t => t.status === "completed").length;

  const doApprove = () => {
    if (over || !cfg.country || missingDomains.length > 0 || incompleteTargets || domainsDirty) return;
    if (!window.confirm(`Approve "${plan.name}" for contacts located in ${cfg.country}?\n\nThis freezes the saved country, designations and configuration. Sourcing checks the internal database first. Only accounts with no matching internal contacts use paid Apollo sourcing (up to ${estimate} requests across all accounts). Nothing is sourced until you start it.`)) return;
    approve.mutate({ id: plan.id, revision: plan.revision }, {
      onSuccess: () => toast({ title: "Plan approved" }),
      onError: e => toast({ variant: "destructive", title: "Approval failed", description: `${(e as Error).message}. If the draft changed, reload and review the latest revision.` }),
    });
  };
  const run = async (list: CommitteeTarget[], retry: boolean) => {
    stop.current = false; setBatch(true); setRunError(null);
    for (const t of list) {
      if (stop.current) break;
      setRunning(t.company_id);
      try { await source.mutateAsync({ id: plan.id, accountId: t.company_id, retry }); }
      catch (e) { setRunError(`${t.name}: ${(e as Error).message}. Completed accounts were kept.`); break; }
    }
    setRunning(null); setBatch(false);
  };
  const startSelected = () => {
    if (!window.confirm(`Source ${pending.length} pending account${pending.length === 1 ? "" : "s"} one at a time? Internal contacts matching the approved designations and country are used first. Only an account with zero internal matches uses up to 2 paid Apollo requests; we do not top up internal results. Keep this page open; leaving stops after the current account. Navigation never resumes automatically.`)) return;
    void run(pending, false);
  };
  const retryOne = (t: CommitteeTarget) => {
    if (!window.confirm(`Retry ${t.name}? This may use additional Apollo credits. Interrupted or stale processing runs (older than 5 minutes) are reset on retry.`)) return;
    void run([t], true);
  };

  return <div className="space-y-5 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-lg font-bold text-stone-900">{plan.name}</h3>
        <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{approved ? `Approved ${plan.approved_at ? new Date(plan.approved_at).toLocaleString() : ""}` : "Draft"} / revision {plan.revision} / {cfg.accountIds.length} accounts / up to {cfg.limitPerAccount} contacts each</p></div>
      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${approved ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{plan.status}</span>
    </div>
    <div className="grid gap-3 text-xs text-stone-600 sm:grid-cols-2">
      <div className="rounded-lg bg-stone-50 p-3"><div className="font-bold text-stone-700">Contact country</div>{cfg.country || "Not selected — legacy plan"}</div>
      <div className="rounded-lg bg-stone-50 p-3"><div className="font-bold text-stone-700">Categories</div>{cfg.categories.join(", ")}</div>
      <div className="rounded-lg bg-stone-50 p-3"><div className="font-bold text-stone-700">Designations</div>{cfg.designations.join(", ")}</div>
    </div>
    <div className={`rounded-lg border p-3 text-sm ${over ? "border-red-300 bg-red-50 text-red-800" : "border-stone-200 bg-stone-50 text-stone-700"}`}>
      Up to {estimate} of {budget} external request budget if every account needs fallback. Internal matches use no provider requests. Used so far: {usedRequests}. {done} of {targets.length} accounts completed.{over && " Over budget: approval is blocked."}
      {approved && usedRequests>=budget && <p className="mt-1 font-semibold">External request budget reached. Internal matching remains available; external fallback is blocked.</p>}</div>
    {!configured && <p role="alert" className="flex gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"><AlertCircle className="h-4 w-4 shrink-0" />Internal matching is available. Configure Contact discovery in Settings &gt; Integrations for external fallback when an account has no internal matches.</p>}
    <p className="text-xs text-stone-600">For each account, match internal contacts to the approved designations and contact country first. If any match, add them without external top-up. Only zero-match accounts use external sourcing. Existing people stay linked to the same CRM records; no duplicates or outreach are created.</p>
    {!cfg.country && <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
      {approved ? "This older approved plan has no country filter. Copy to new draft, select a country, save and approve before sourcing or retrying. Previously sourced contacts are retained." : "Choose Edit draft, select the contact country, then save before approval."}
    </p>}
    {!approved && missingDomains.length > 0 && <p role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
      Draft saved. {missingDomains.length} selected account{missingDomains.length === 1 ? " needs" : "s need"} a confirmed company domain. Add domains below and choose Save domains, then approve the plan and start sourcing.
    </p>}
    {!approved && incompleteTargets && <p role="alert" className="text-xs text-amber-900">The saved account selection changed. Edit and review the draft before approval.</p>}
    {!canManage && <p className="text-xs text-stone-500">View only. Admins can edit, approve and source plans.</p>}
    {canManage && !approved && <PlanDomains key={`${plan.id}:${plan.revision}`} plan={plan} targets={targets} onDirtyChange={setDomainsDirty} />}

    {approved && <p className="text-xs text-stone-600">Approved targeting is frozen. To change designations, country or accounts after a zero-result search, copy to a new draft. The original results and request history remain unchanged; new sourcing may consume additional credits.</p>}
    {canManage && <div className="flex flex-wrap gap-2">
      {approved && onCopy && <Button variant="outline" disabled={batch || copy.isPending} onClick={() => copy.mutate(plan.id, {
        onSuccess: result => { if (mounted.current) onCopy(result); },
        onError: e => toast({ variant: "destructive", title: "Could not copy plan", description: (e as Error).message }),
      })}>{copy.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Copy to new draft</Button>}
      {!approved && <Button variant="outline" onClick={onEdit} disabled={domainsDirty}>Edit draft</Button>}
      {!approved && <Button onClick={doApprove} disabled={over || !cfg.country || missingDomains.length > 0 || incompleteTargets || domainsDirty || approve.isPending} className="bg-stone-900 font-bold text-white hover:bg-stone-800">{approve.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Approve plan</Button>}
      {approved && <Button onClick={startSelected} disabled={!cfg.country || batch || pending.length === 0} className="bg-emerald-700 font-bold text-white hover:bg-emerald-800">{batch && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Source selected accounts ({pending.length} pending)</Button>}
      {batch && <Button variant="outline" onClick={() => { stop.current = true; }}>Stop after current</Button>}
    </div>}
    {batch && <p role="status" className="text-xs font-semibold text-amber-800">Sourcing in progress. Stay on this page; leaving will stop after the current account.</p>}
    {runError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">{runError}</p>}

    <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left text-[10px] uppercase tracking-wider text-stone-500"><th className="py-2 pr-3">Account</th><th className="pr-3">Domain</th><th className="pr-3">Status</th><th className="pr-3">Requests</th><th className="pr-3">Found</th><th /></tr></thead>
      <tbody>{targets.map(t => <tr key={t.id} className="border-t border-stone-100 align-top">
        <td className="py-2 pr-3 font-semibold text-stone-800">{t.name}</td><td className="pr-3 text-stone-600">{t.domain}</td>
        <td className="pr-3"><span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${tone(running === t.company_id ? "processing" : t.status)}`}>
          {running === t.company_id ? <Loader2 className="h-3 w-3 animate-spin" /> : t.status === "completed" ? <CheckCircle2 className="h-3 w-3" /> : null}{running === t.company_id ? "working" : t.status}</span>
          {t.error && <div className="mt-1 max-w-xs text-red-700">{t.error}</div>}</td>
        <td className="pr-3 tabular-nums">{t.requests} attempts ({t.responses} responses)</td><td className="pr-3 tabular-nums">{t.found}</td>
        <td>{canManage && approved && ["failed", "interrupted", "processing"].includes(t.status) && <Button size="sm" variant="outline" disabled={batch || !cfg.country || t.status==="processing"} title={t.status==="processing"?"Wait for the active attempt to finish. Interrupted attempts become retryable after five minutes.":undefined} onClick={() => retryOne(t)}>Retry</Button>}</td></tr>)}</tbody></table></div>

    <details><summary className="cursor-pointer text-sm font-bold text-stone-800">Preview sourced contacts</summary>
      <div className="mt-3"><CommitteeContacts clientId={cfg.clientId} accountIds={cfg.accountIds} country={cfg.country} /></div></details>
  </div>;
}
