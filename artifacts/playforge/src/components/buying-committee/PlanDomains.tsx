import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useSaveBuyingPlan, type CommitteePlan, type CommitteeTarget } from "./api";

/** Draft-only domain editing, preserving the reviewed account/category/role scope. */
export default function PlanDomains({ plan, targets, onDirtyChange }: {
  plan: CommitteePlan; targets: CommitteeTarget[]; onDirtyChange: (dirty: boolean) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useSaveBuyingPlan(plan.id);
  const { toast } = useToast();
  const dirty = targets.some(t => (values[String(t.company_id)] ?? t.domain) !== t.domain);
  useEffect(() => { onDirtyChange(dirty || save.isPending); }, [dirty, save.isPending, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const submit = () => {
    setError(null);
    const domains = { ...plan.config.domains };
    targets.forEach(t => { domains[String(t.company_id)] = (values[String(t.company_id)] ?? t.domain).trim(); });
    save.mutate({ ...plan.config, name: plan.name, domains }, {
      onSuccess: () => toast({ title: "Domains saved", description: "Review the saved plan, then approve and start sourcing when all company domains are confirmed." }),
      onError: e => setError((e as Error).message),
    });
  };
  return <section className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-4">
    <div><h4 className="text-sm font-bold text-stone-900">Company domains</h4>
      <p className="mt-1 text-xs text-stone-600">Add or correct domains right here. Saved to this draft only, not the CRM. Confirm every company before approval; saving never starts Apollo sourcing.</p></div>
    {targets.map(t => <label key={t.company_id} className="grid items-center gap-2 sm:grid-cols-2">
      <span className="text-xs font-semibold text-stone-800">{t.name}</span>
      <input aria-label={`Domain for ${t.name}`} value={values[String(t.company_id)] ?? t.domain} disabled={save.isPending}
        placeholder="Confirmed domain, e.g. company.com"
        onChange={e => { setValues(v => ({ ...v, [String(t.company_id)]: e.target.value })); setError(null); }}
        className="h-10 w-full rounded-md border border-stone-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
    </label>)}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={!dirty || save.isPending} onClick={submit}>{save.isPending ? "Saving domains…" : "Save domains"}</Button>
      {dirty && <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => { setValues({}); setError(null); }}>Reset changes</Button>}
      {dirty && <span className="text-xs text-amber-800">Save domain changes before approving the plan.</span>}
    </div>
  </section>;
}
