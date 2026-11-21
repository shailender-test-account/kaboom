import { useEffect, useState } from "react";
import { Loader2, Plus, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import DomainLookup from "./DomainLookup";
import {
  committeeCategories, useBuyingAccounts, useBuyingSuggestions, useSaveBuyingPlan,
  type CommitteeAccount, type CommitteeCategory, type CommitteeConfig, type CommitteePlan, type CommitteeCopy,
} from "./api";

export interface Draft {
  country?: string;
  name: string; includeRoster: boolean; audienceIds: number[]; accounts: Record<number, CommitteeAccount>;
  categories: CommitteeCategory[]; designations: string[]; limitPerAccount: number; domains: Record<string, string>;
}
export const emptyDraft = (): Draft => ({ name: "Buying committee plan", country: "India", includeRoster: true, audienceIds: [], accounts: {}, categories: [], designations: [], limitPerAccount: 3, domains: {} });
export function draftFromPlan(plan: CommitteePlan, names: Record<number, string>): Draft {
  const c = plan.config, accounts: Record<number, CommitteeAccount> = {};
  c.accountIds.forEach(id => { accounts[id] = { id, name: names[id] ?? `Account #${id}`, domain: null }; });
  return { name: plan.name, country: c.country ?? "", includeRoster: c.includeRoster, audienceIds: c.audienceIds, accounts, categories: c.categories, designations: c.designations, limitPerAccount: c.limitPerAccount, domains: c.domains ?? {} };
}
export function draftFromCopy(copy: CommitteeCopy): Draft {
  return draftFromPlan({ name: copy.config.name, config: copy.config } as CommitteePlan,
    Object.fromEntries(copy.accounts.map(a => [a.id, a.name])));
}
export const domainOf = (d: Draft, a: CommitteeAccount) => (d.domains[String(a.id)] ?? a.domain ?? "").trim();
const inp = "h-10 w-full rounded-md border border-stone-200 bg-white px-3 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500";
const lab = "text-xs font-bold uppercase tracking-widest text-stone-500";

export default function PlanBuilder({ clientId, databases, maxRequests, countries = ["India"], editing, copied = false, initial, onSaved, onCancel }: {
  clientId: number; databases: { id: number; name: string; clientId: number | null }[]; maxRequests: number;
  editing?: CommitteePlan; initial: Draft; onSaved: (id: number) => void; onCancel: () => void;
  countries?: string[];
  copied?: boolean;
}) {
  const { toast } = useToast();
  const [d, setD] = useState<Draft>(initial);
  const [segment, setSegment] = useState("");
  const [search, setSearch] = useState(""), [debounced, setDebounced] = useState(""), [page, setPage] = useState(1), [desig, setDesig] = useState("");
  useEffect(() => { const t = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 350); return () => clearTimeout(t); }, [search]);
  const hasSource = d.includeRoster || d.audienceIds.length > 0;
  const accountsQ = useBuyingAccounts({ clientId, includeRoster: d.includeRoster, audienceIds: d.audienceIds, search: debounced, page, segment });
  const sugg = useBuyingSuggestions(d.categories);
  const save = useSaveBuyingPlan(editing?.id);
  const selected = Object.values(d.accounts);
  const [selectedPage, setSelectedPage] = useState(1);
  const selectedPages = Math.max(1, Math.ceil(selected.length / 10));
  const visibleSelectedPage = Math.min(selectedPage, selectedPages);
  const selectedScopeKey = `${clientId}:${d.includeRoster}:${d.audienceIds.join(",")}`;
  const estimate = selected.length * 2, over = estimate > maxRequests;
  const missing = selected.filter(a => !domainOf(d, a));
  const domainGroups = new Map<string, number>();
  selected.forEach(a => {
    try {
      const value = domainOf(d, a);
      if (!value) return;
      const host = new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
      domainGroups.set(host, (domainGroups.get(host) ?? 0) + 1);
    } catch { /* The server validates malformed manual domains on save. */ }
  });
  const sharedDomains = [...domainGroups].filter(([, count]) => count > 1).map(([domain]) => domain);
  const canSave = !!d.name.trim() && hasSource && selected.length > 0 && selected.length<=50 && d.categories.length > 0 && d.designations.length > 0 && !save.isPending;
  const toggle = <T,>(arr: T[], v: T) => arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
  const pageCount = Math.max(1, Math.ceil((accountsQ.data?.total ?? 0) / (accountsQ.data?.pageSize || 20)));
  const addDesig = (v: string) => { const t = v.trim(); if (t && !d.designations.includes(t)) setD(x => ({ ...x, designations: [...x.designations, t] })); };

  const submit = () => {
    const domains: Record<string, string> = {};
    selected.forEach(a => { domains[String(a.id)] = domainOf(d, a); });
    const cfg: CommitteeConfig = { clientId, name: d.name.trim(), includeRoster: d.includeRoster, audienceIds: d.audienceIds, accountIds: selected.map(a => a.id), categories: d.categories, designations: d.designations, limitPerAccount: d.limitPerAccount, domains, ...(d.country ? { country: d.country } : {}) };
    save.mutate(cfg, {
      onSuccess: r => { toast({ title: "Draft saved", description: missing.length
        ? "Your selections are saved. Edit the draft to confirm missing company domains before approval and sourcing."
        : "Review the saved designations and budget, then approve." }); onSaved(r.plan.id); },
      onError: e => toast({ variant: "destructive", title: "Could not save plan", description: (e as Error).message }),
    });
  };

  return <div className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm space-y-6">
    <div className="flex items-start justify-between"><div><h3 className="text-lg font-bold text-stone-900">{editing ? `Edit draft: ${editing.name}` : "New buying committee plan"}</h3>
      <p className="mt-1 text-sm text-stone-500">{copied ? "Unsaved copy. Review the targeting, Save draft, then approve the new plan. The original plan, contacts and request history stay unchanged. Copying and saving never start sourcing." : "Prospect data stays separate from engagement and intent scores. Nothing is sourced until you approve."}</p></div>
      <button aria-label="Close" onClick={onCancel} className="rounded p-1 text-stone-400 hover:bg-stone-100"><X className="h-5 w-5" /></button></div>

    <div className="grid gap-5 sm:grid-cols-3">
      <label className="space-y-2 sm:col-span-2"><span className={lab}>Plan name</span><input className={inp} value={d.name} onChange={e => setD({ ...d, name: e.target.value })} /></label>
      <label className="space-y-2"><span className={lab}>Contacts per account (1-10)</span>
        <input type="number" min={1} max={10} className={inp} value={d.limitPerAccount} onChange={e => setD({ ...d, limitPerAccount: Math.min(10, Math.max(1, Math.round(Number(e.target.value)) || 1)) })} /></label>
    </div>

    <label className="block space-y-2"><span className={lab}>Contact country</span>
      <select aria-label="Contact country" className={inp} value={d.country ?? ""} onChange={e => setD({ ...d, country: e.target.value })}>
        <option value="">Select a country before approval</option>
        {[...new Set([...countries, ...(d.country ? [d.country] : [])])].map(country => <option key={country} value={country}>{country}</option>)}
      </select>
      <span className="block text-xs text-stone-500">Source people located in this country, not the employer’s headquarters. New plans start with India; review your selection before approval.</span>
    </label>
    <section className="space-y-2"><h4 className={lab}>Categories</h4>
      <div className="flex flex-wrap gap-2">{committeeCategories.map(c => <label key={c} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold ${d.categories.includes(c) ? "border-emerald-500 bg-emerald-50 text-emerald-900" : "border-stone-200 bg-white text-stone-700"}`}>
        <input type="checkbox" className="h-4 w-4" checked={d.categories.includes(c)} onChange={() => setD({ ...d, categories: toggle(d.categories, c) })} />{c}</label>)}</div></section>

    <section className="space-y-2"><div className="flex items-center justify-between"><h4 className={lab}>Designations</h4><span className="text-[10px] font-bold uppercase text-stone-400">{d.designations.length} selected</span></div>
      <div className="flex flex-wrap gap-1.5">{d.designations.map(t => <button key={t} onClick={() => setD({ ...d, designations: d.designations.filter(x => x !== t) })} className="flex items-center gap-1 rounded-full bg-stone-900 px-2.5 py-1 text-xs font-semibold text-white">{t}<X className="h-3 w-3" /></button>)}
        {d.designations.length === 0 && <span className="text-xs text-stone-500">Choose categories, then add suggested or custom designations.</span>}</div>
      {d.categories.length > 0 && <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-stone-50 p-2">
        {sugg.isLoading && <Loader2 className="h-4 w-4 animate-spin text-stone-400" />}
        {sugg.isError && <span className="text-xs text-red-700">Suggestions unavailable. <button className="underline" onClick={() => sugg.refetch()}>Retry</button></span>}
        {(sugg.data?.designations ?? []).filter(t => !d.designations.includes(t)).map(t => <button key={t} onClick={() => addDesig(t)} className="rounded-full border border-stone-300 bg-white px-2.5 py-1 text-xs font-semibold text-stone-700 hover:bg-emerald-50"><Plus className="mr-1 inline h-3 w-3" />{t}</button>)}</div>}
      <div className="flex gap-2"><input className={inp} placeholder="Custom designation" value={desig} onChange={e => setDesig(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { addDesig(desig); setDesig(""); } }} />
        <Button type="button" variant="outline" className="h-10" onClick={() => { addDesig(desig); setDesig(""); }}>Add</Button></div></section>

    <section className="space-y-3"><h4 className={lab}>Account sources</h4>
      <div className="flex flex-wrap gap-2">
        <label className="flex items-center gap-2 rounded-md border border-stone-200 px-3 py-2 text-sm font-semibold"><input type="checkbox" checked={d.includeRoster} onChange={() => { setD({ ...d, includeRoster: !d.includeRoster }); setPage(1); }} />Roster</label>
        {databases.filter(x => x.clientId === null || x.clientId === clientId).map(db => <label key={db.id} className="flex items-center gap-2 rounded-md border border-stone-200 px-3 py-2 text-sm font-semibold"><input type="checkbox" checked={d.audienceIds.includes(db.id)} onChange={() => { setD({ ...d, audienceIds: toggle(d.audienceIds, db.id) }); setPage(1); }} />{db.name}</label>)}</div>
      <details open className="space-y-2">
      <summary className="cursor-pointer rounded-md border border-stone-200 bg-white px-3 py-2.5 text-sm font-semibold">Choose accounts ({selected.length} selected, maximum 50)</summary>
      <div className="grid gap-2 sm:grid-cols-[1fr_220px]">
        <input aria-label="Search committee accounts" className={inp} placeholder="Search accounts by name" value={search} onChange={e => setSearch(e.target.value)} disabled={!hasSource} />
        <select aria-label="HP segment" className={inp} value={segment} disabled={!hasSource} onChange={e => { setSegment(e.target.value); setPage(1); }}>
          <option value="">All HP segments</option>
          {[...new Set([...(accountsQ.data?.segments ?? []), ...(segment ? [segment] : [])])].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {!hasSource ? <p className="text-xs text-amber-700">Select the roster or at least one database to list accounts.</p> :
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-2">
          {accountsQ.isLoading && <Loader2 className="mx-auto my-6 h-5 w-5 animate-spin text-stone-300" />}
          {accountsQ.isError && <p role="alert" className="p-2 text-xs text-red-700">{(accountsQ.error as Error).message} <button className="underline" onClick={() => accountsQ.refetch()}>Retry</button></p>}
          {accountsQ.data?.items.length === 0 && <p className="p-3 text-center text-xs text-stone-500">No accounts match.</p>}
          <div className="max-h-72 overflow-y-auto">{accountsQ.data?.items.map(a => <label key={a.id} className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-white">
            <input type="checkbox" className="h-4 w-4" checked={!!d.accounts[a.id]} onChange={() => setD(x => { const n = { ...x.accounts }; if (n[a.id]) delete n[a.id]; else n[a.id] = a; return { ...x, accounts: n }; })} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{a.name}</span><span className="block truncate text-[10px] text-stone-500">{a.domain || "No domain on file"}</span></span>
            <span className="shrink-0 rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-900">{a.segment || "Unclassified"}</span></label>)}</div>
          <div className="flex items-center justify-between border-t border-stone-200 px-1 pt-2 text-xs text-stone-600">
            <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span>Page {page} of {pageCount} / {accountsQ.data?.total ?? 0} accounts</span>
            <Button type="button" size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</Button></div>
        </div>}
      </details>
    </section>

    <section className="space-y-2"><div className="flex items-center justify-between"><h4 className={lab}>Selected accounts and confirmed domains</h4><span className="text-[10px] font-bold uppercase text-stone-400">{selected.length} selected</span></div>
      {selected.length === 0 && <p className="text-xs text-stone-500">No accounts selected. Selections are kept across pages and searches.</p>}
      <div className="space-y-2">{selected.slice((visibleSelectedPage - 1) * 10, visibleSelectedPage * 10).map(a => { const v = domainOf(d, a); return <div key={a.id} className="grid items-center gap-2 rounded-lg border border-stone-200 p-2 sm:grid-cols-[1fr_minmax(0,1fr)_auto]">
        <span className="truncate text-sm font-semibold">{a.name}</span>
        <input aria-label={`Confirmed domain for ${a.name}`} className={`${inp} ${v ? "" : "border-amber-400"}`} placeholder="Confirmed domain, e.g. company.com" value={d.domains[String(a.id)] ?? a.domain ?? ""} onChange={e => setD({ ...d, domains: { ...d.domains, [String(a.id)]: e.target.value } })} />
        <Button type="button" variant="outline" size="sm" onClick={() => setD(x => { const n = { ...x.accounts }; delete n[a.id]; return { ...x, accounts: n }; })}>Remove</Button>
        <DomainLookup key={`${selectedScopeKey}:${a.id}`} scope={{ clientId, accountId: a.id, includeRoster: d.includeRoster, audienceIds: d.audienceIds }}
          onConfirm={domain => setD(current => current.accounts[a.id] ? { ...current, domains: { ...current.domains, [String(a.id)]: domain } } : current)} />
        </div>; })}</div>
      {selected.length > 10 && <div className="flex items-center justify-between">
        <Button type="button" size="sm" variant="outline" disabled={visibleSelectedPage <= 1} onClick={() => setSelectedPage(visibleSelectedPage - 1)}>Previous selected</Button>
        <span className="text-xs">Selected page {visibleSelectedPage} of {selectedPages}</span>
        <Button type="button" size="sm" variant="outline" disabled={visibleSelectedPage >= selectedPages} onClick={() => setSelectedPage(visibleSelectedPage + 1)}>Next selected</Button>
      </div>}
      {missing.length > 0 && <p className="text-xs font-semibold text-amber-700">{missing.length} selected account{missing.length === 1 ? " needs" : "s need"} a confirmed domain before approval and sourcing. You can save the draft now and add domains later. Domains are saved to the plan only, not the CRM.</p>}
      {sharedDomains.length > 0 && <p role="alert" className="text-xs font-semibold text-amber-800">Selected legal accounts share {sharedDomains.join(", ")}. A shared parent domain does not establish employer identity. Approval remains blocked; review and source these accounts separately.</p>}
    </section>

    <div className={`rounded-lg border p-3 text-sm ${over ? "border-red-300 bg-red-50 text-red-800" : "border-stone-200 bg-stone-50 text-stone-700"}`}>
      Maximum external fallback requests: <strong>{estimate}</strong> (up to 2 per account) of a <strong>{maxRequests}</strong> request budget. Matching internal contacts use no provider requests.{over && " Over budget: reduce accounts before approval."}</div>
    <div className="flex justify-end gap-3 border-t border-stone-100 pt-5"><Button variant="outline" onClick={onCancel}>Cancel</Button>
      <Button onClick={submit} disabled={!canSave} className="bg-stone-900 font-bold text-white hover:bg-stone-800">{save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save draft</Button></div>
  </div>;
}
