import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSalesHotAccounts, useGetSalesAccountOptions, useGetSalesAccount, useReplaceSalesAccountOwners,
  getListSalesHotAccountsQueryKey, getGetSalesAccountOptionsQueryKey, getGetSalesAccountQueryKey,
  getGetSalesOwnerHistoryQueryKey,
} from "@workspace/api-client-react";
import type { SalesHotAccount, SalesHotEvidence } from "@workspace/api-client-react";
import { ChevronRight, Flame, History, Loader2, Lock, Mail, MessageSquarePlus, Phone, Search, ShieldOff, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { SalesOwnerBatchDialog } from "./SalesOwnerBatchDialog";

import SalesAccessHistory from "./SalesAccessHistory";
import { AccountFeedbackLog } from "./AccountFeedbackLog";

export type AddFeedbackTarget = { clientId: number; accountId: number };

const sel = "h-8 rounded-md border bg-background px-2 text-xs";
const POLL = 60_000;
const fmt = (d: string) => { const t = new Date(d); return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString(); };
const msg = (e: unknown, f: string) => (e instanceof Error && e.message) ? e.message : f;

const dayMs = 86_400_000;
export function latestDeclaration(a: Pick<SalesHotAccount, "evidence">) {
  let best: SalesHotEvidence | undefined;
  for (const e of a.evidence) { const t = new Date(e.at).getTime(); if (!Number.isNaN(t) && (!best || t > new Date(best.at).getTime())) best = e; }
  return best;
}
export function soonestMonths(a: Pick<SalesHotAccount, "evidence">) {
  return a.evidence.length ? Math.min(...a.evidence.map(e => e.months)) : null;
}
const ago = (d: string) => {
  const t = new Date(d).getTime(); if (Number.isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / dayMs);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : days < 60 ? `${days} days ago` : `${Math.floor(days / 30)} months ago`;
};

export function hasFreshEvidence(a: Pick<SalesHotAccount, "evidence">) { return a.evidence.some(e => e.fresh); }

function FreshnessBadge({ fresh }: { fresh: boolean }) {
  return fresh
    ? <span className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-red-800"><Flame className="h-3 w-3" />Recent Hot declaration</span>
    : <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-900"><History className="h-3 w-3" />Historical Hot · needs reconfirmation</span>;
}

function EvidenceLine({ e }: { e: SalesHotEvidence }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <FreshnessBadge fresh={e.fresh} />
      <span className="font-medium">{e.product}</span>
      <span className="text-muted-foreground">buying in {e.months} mo</span>
      <span className="font-mono text-[11px] text-muted-foreground">declared {fmt(e.at)} · {e.source}</span>
    </li>
  );
}

function OwnerChips({ owners }: { owners: SalesHotAccount["owners"] }) {
  if (!owners.length) return <span className="text-xs text-muted-foreground">No owner</span>;
  return <span className="flex flex-wrap gap-1">{owners.map((o, i) => (
    <span key={`${o.userId ?? o.email}-${i}`} title={o.email} className={cn("rounded px-1.5 py-0.5 text-[11px]", o.source === "roster" ? "bg-muted text-foreground" : "bg-accent text-accent-foreground")}>
      {o.name}<span className="ml-1 text-[10px] opacity-70">{o.source === "roster" ? "roster" : "assigned"}</span>
    </span>))}</span>;
}

export function SalesAccountDetailPanel({ id, onClose, onAddFeedback }: { id: number; onClose: () => void; onAddFeedback?: (t: AddFeedbackTarget) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useGetSalesAccount(id, { query: { enabled: !!id, queryKey: getGetSalesAccountQueryKey(id), refetchInterval: POLL } });
  const save = useReplaceSalesAccountOwners();
  const [picked, setPicked] = useState<number[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setPicked(null); setErr(null); }, [id]);
  const d = q.isError ? undefined : q.data;
  const current = picked ?? d?.assignedUserIds ?? [];
  const dirty = !!d && picked !== null && JSON.stringify([...picked].sort()) !== JSON.stringify([...d.assignedUserIds].sort());
  const roster = d?.account.owners.filter(o => o.source === "roster") ?? [];
  const rosterIds = new Set(roster.map(o => o.userId).filter((v): v is number => v != null));

  const submit = () => {
    setErr(null);
    save.mutate({ id, data: { userIds: current } }, {
      onSuccess: res => {
        qc.setQueryData(getGetSalesAccountQueryKey(id), res);
        qc.invalidateQueries({ queryKey: getListSalesHotAccountsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetSalesAccountQueryKey(id) });
        qc.invalidateQueries({ queryKey: getGetSalesOwnerHistoryQueryKey(id) });
        setPicked(null);
        toast({ title: "Account owners saved" });
      },
      onError: e => setErr(msg(e, "Could not save owners. Nothing was changed.")),
    });
  };

  return (
    <aside className="rounded-lg border bg-card p-4 space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto" aria-label="Account detail" data-testid="panel-account-detail">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">{d?.account.clientName ?? "Account"}</p>
          <h3 className="text-base font-semibold truncate" data-testid="text-detail-name">{d?.account.name ?? "Loading account"}</h3>
        </div>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onClose} aria-label="Close account detail" data-testid="button-close-detail"><X className="h-4 w-4" /></Button>
      </div>
      {q.isLoading && <div className="space-y-2" data-testid="detail-loading">{[0, 1, 2].map(i => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}</div>}
      {q.isError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800" data-testid="detail-error">Could not load this account. Your access may have changed. <button className="underline font-semibold" onClick={() => q.refetch()}>Retry</button></div>}
      {d && <>
        <section className="space-y-1.5">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Declared interest</h4>
          <ul className="space-y-1.5" data-testid="list-detail-evidence">{d.account.evidence.map((e, i) => <EvidenceLine key={i} e={e} />)}</ul>
          <p className="text-[11px] text-muted-foreground">Recent means the declaration is recent. It is not consent to call or email.</p>
        </section>
        <section className="space-y-1.5">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Contacts ({d.contacts.length})</h4>
          {d.contacts.length === 0 ? <p className="text-xs text-muted-foreground">No saved contacts.</p> :
            <ul className="divide-y rounded border">{d.contacts.map(c => (
              <li key={c.id} className="px-2.5 py-2 text-xs space-y-0.5" data-testid={`row-detail-contact-${c.id}`}>
                <div className="flex items-center gap-2"><span className="font-medium">{c.name}</span>
                  {c.suppressed && <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 text-[10.5px] font-semibold text-red-800"><ShieldOff className="h-3 w-3" />Suppressed, do not contact</span>}</div>
                <div className={cn("flex flex-wrap gap-x-3 text-muted-foreground", c.suppressed && "line-through")}>
                  {c.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{c.email}</span>}
                  {c.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{c.phone}</span>}
                </div>
              </li>))}</ul>}
        </section>
        <section className="space-y-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Owners</h4>
          {roster.length > 0 && <div className="flex flex-wrap items-center gap-1 text-xs"><Lock className="h-3 w-3 text-muted-foreground" />
            {roster.map((o, i) => <span key={i} className="rounded bg-muted px-1.5 py-0.5">{o.name}</span>)}
            <span className="text-[11px] text-muted-foreground">Roster owners keep ownership even if their explicit assignment is removed below.</span></div>}
          {!d.canAssign ? <OwnerChips owners={d.account.owners.filter(o => o.source === "assigned")} /> : <>
            <fieldset className="max-h-48 overflow-y-auto rounded border p-2 grid gap-1" disabled={save.isPending} data-testid="fieldset-owners">
              <legend className="px-1 text-xs font-medium">Explicit owners</legend>
              {d.account.owners.filter(o => o.source === "assigned" && o.userId !== null
                && !d.assignableUsers.some(u => u.id === o.userId)).map(o => (
                <label key={`ineligible-${o.userId}`} className="flex items-center gap-2 text-xs text-amber-800">
                  <input type="checkbox" checked={current.includes(o.userId!)} disabled={!current.includes(o.userId!)}
                    onChange={() => setPicked(current.filter(userId => userId !== o.userId))}
                    data-testid={`checkbox-owner-${o.userId}`} />
                  <span>{o.name} · no longer eligible; remove this assignment</span>
                </label>
              ))}
              {d.assignableUsers.map(u => {
                const onRoster = rosterIds.has(u.id);
                return <label key={u.id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={current.includes(u.id)}
                    onChange={e => setPicked(e.target.checked ? [...current, u.id] : current.filter(x => x !== u.id))} data-testid={`checkbox-owner-${u.id}`} />
                  <span className="truncate">{u.name} <span className="text-muted-foreground">{u.email}</span></span>{onRoster && <span className="text-[10px] text-muted-foreground" title="Removing the explicit assignment keeps roster ownership">on roster, keeps access</span>}
                </label>;
              })}
            </fieldset>
            {err && <p role="alert" className="text-xs text-destructive" data-testid="text-owners-error">{err}</p>}
            <div className="flex justify-end gap-2">
              {dirty && <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Discard</Button>}
              <Button size="sm" disabled={!dirty || save.isPending} onClick={submit} data-testid="button-save-owners">
                {save.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Users className="mr-1.5 h-3.5 w-3.5" />}Save owners</Button>
            </div>
            <SalesAccessHistory key={id} id={id} kind="owners" />
          </>}
        </section>
        <AccountFeedbackLog accountId={d.account.id} clientId={d.account.clientId}
          onAdd={onAddFeedback ? () => onAddFeedback({ clientId: d.account.clientId, accountId: d.account.id }) : undefined} />
      </>}
    </aside>
  );
}

export function SalesHotAccounts({ onAddFeedback }: { onAddFeedback?: (t: AddFeedbackTarget) => void } = {}) {
  const { toast } = useToast();
  const [unassigned, setUnassigned] = useState(false);
  const [batchIds, setBatchIds] = useState<number[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [search]);
  const [selected, setSelected] = useState<number | null>(null);
  const opts = useGetSalesAccountOptions({ query: { queryKey: getGetSalesAccountOptionsQueryKey(), refetchInterval: POLL } });
  const canAssign = !opts.isError && !!opts.data?.canAssign;
  const params = { clientId: clientId ? Number(clientId) : undefined, search: debouncedSearch || undefined, page,
    unassigned: canAssign && unassigned ? true : undefined };
  const list = useListSalesHotAccounts(params, { query: { queryKey: getListSalesHotAccountsQueryKey(params), refetchInterval: POLL } });
  const d = list.isError ? undefined : list.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / (d.pageSize || 25))) : 1;
  const visibility = d?.visibility ?? opts.data?.visibility;
  const batchMode = canAssign && unassigned;
  useEffect(() => { setBatchIds([]); }, [clientId, search, unassigned, canAssign]);
  useEffect(() => { if (!canAssign) { setBatchOpen(false); setUnassigned(false); } }, [canAssign]);

  return (
    <div className="space-y-3" data-testid="view-hot-accounts">
      <p className="text-xs text-muted-foreground" data-testid="text-accounts-scope">
        <span className="rounded border px-1.5 py-0.5 font-semibold text-foreground" data-testid="text-visibility">{visibility === "all" ? "All authorized accounts" : visibility === "owned" ? "Your accounts" : "Loading scope"}</span>{" "}
        Accounts with a declared Hot interest across every client you can access. Older declarations stay listed and are marked for reconfirmation.
      </p>
      {opts.isError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">Could not load clients. <button className="underline font-semibold" onClick={() => opts.refetch()}>Retry</button></div>}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/70 p-2">
        <select aria-label="Client" className={sel} value={clientId} onChange={e => { setClientId(e.target.value); setPage(1); }} data-testid="filter-accounts-client">
          <option value="">All clients</option>{(opts.data?.clients ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <label className="relative"><span className="sr-only">Search accounts</span>
          <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <input className={cn(sel, "w-full sm:w-56 pl-7")} placeholder="Search accounts" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} data-testid="input-accounts-search" /></label>
        {canAssign && <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={unassigned} onChange={e => { setUnassigned(e.target.checked); setPage(1); }} />
          Unassigned owners only
        </label>}
        {canAssign && unassigned && <Button size="sm" disabled={!batchIds.length || list.isFetching || list.isError}
          onClick={() => setBatchOpen(true)}>Assign selected ({batchIds.length}/25)</Button>}
        {d && <span className="ml-auto font-mono text-[11px] text-muted-foreground" data-testid="text-accounts-total">{d.total} accounts</span>}
      </div>
      <div className={cn("grid gap-4", selected && "lg:grid-cols-[minmax(0,1fr)_400px]")}>
        <div className="space-y-2 min-w-0">
          {list.isLoading && <div className="space-y-2" data-testid="accounts-loading">{[0, 1, 2, 3].map(i => <div key={i} className="h-16 rounded-md bg-muted animate-pulse" />)}</div>}
          {list.isError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800" data-testid="accounts-error">Could not load Hot accounts. <button className="underline font-semibold" onClick={() => list.refetch()} data-testid="button-accounts-retry">Retry</button></div>}
          {d && d.items.length === 0 && <div className="rounded-md border border-dashed px-6 py-12 text-center" data-testid="accounts-empty">
            <Flame className="mx-auto h-8 w-8 text-red-600/40" />
            <p className="mt-2 text-sm font-medium">{search || clientId ? "No Hot accounts match these filters." : visibility === "owned" ? "None of your accounts has a declared Hot interest." : "No accounts have a declared Hot interest."}</p>
            <p className="mt-1 text-xs text-muted-foreground">Accounts appear here once a contact declares Hot interest.</p>
          </div>}
          {d && d.items.length > 0 && <div className={cn("overflow-hidden rounded-lg border bg-card shadow-xs transition-opacity", list.isFetching && "opacity-70")}>
            <table className="w-full text-left text-xs" data-testid="table-hot-accounts">
              <thead className="border-b bg-muted/50 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                <tr>
                  {batchMode && <th className="w-8 px-3 py-2"><span className="sr-only">Select</span></th>}
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">Product interest</th>
                  <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Hot contacts</th>
                  <th className="hidden px-3 py-2 font-medium lg:table-cell">Last declared</th>
                  <th className="hidden px-3 py-2 font-medium xl:table-cell">Owners</th>
                  <th className="px-3 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {d.items.map(a => {
                  const fresh = hasFreshEvidence(a);
                  const latest = latestDeclaration(a);
                  const products = [...new Set(a.evidence.map(e => e.product))];
                  const soon = soonestMonths(a);
                  const active = selected === a.id;
                  return <tr key={a.id} data-testid={`tr-account-${a.id}`} className={cn("group align-top transition-colors hover:bg-muted/40", active && "bg-accent/60 hover:bg-accent/60")}>
                    {batchMode && <td className="px-3 py-3"><input type="checkbox" aria-label={`Select ${a.name}`}
                      checked={batchIds.includes(a.id)} disabled={list.isFetching || (!batchIds.includes(a.id) && batchIds.length >= 25)}
                      onChange={event => setBatchIds(current => event.target.checked ? [...current, a.id] : current.filter(id => id !== a.id))} /></td>}
                    <td className={cn("min-w-0 px-3 py-2.5 border-l-2", fresh ? "border-l-red-500" : "border-l-amber-400")}>
                      <button type="button" onClick={() => setSelected(a.id)} aria-pressed={active} data-testid={`row-account-${a.id}`}
                        className="block max-w-full text-left focus-visible:outline-2 focus-visible:outline-ring rounded-sm">
                        <span className="block truncate text-sm font-semibold group-hover:text-primary">{a.name}</span>
                        <span className="block font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">{a.clientName}</span>
                      </button>
                      <div className="mt-1.5"><FreshnessBadge fresh={fresh} /></div>
                      <p className="mt-1 text-[11px] text-muted-foreground md:hidden">{products.join(", ")} · {a.hotContacts} Hot contact{a.hotContacts === 1 ? "" : "s"}{latest ? ` · ${fmt(latest.at)}` : ""}</p>
                    </td>
                    <td className="hidden px-3 py-2.5 md:table-cell">
                      <div className="flex flex-wrap gap-1">{products.map(p => <span key={p} className="rounded border bg-background px-1.5 py-0.5 text-[11px] font-medium">{p}</span>)}</div>
                      {soon != null && <p className="mt-1 text-[11px] text-muted-foreground">Buying in {soon} mo{a.evidence.length > 1 ? " (soonest)" : ""}</p>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-right sm:table-cell"><span className="font-mono text-sm font-semibold tabular-nums" data-testid={`text-hot-contacts-${a.id}`}>{a.hotContacts}</span></td>
                    <td className="hidden px-3 py-2.5 lg:table-cell" data-testid={`text-last-declared-${a.id}`}>
                      {latest ? <><span className="block font-mono tabular-nums">{fmt(latest.at)}</span>
                        <span className="block text-[11px] text-muted-foreground">{ago(latest.at)} · {latest.source}</span></> : <span className="text-muted-foreground">Not recorded</span>}
                    </td>
                    <td className="hidden max-w-56 px-3 py-2.5 xl:table-cell"><OwnerChips owners={a.owners} /></td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {onAddFeedback && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onAddFeedback({ clientId: a.clientId, accountId: a.id })}
                          data-testid={`button-row-feedback-${a.id}`} aria-label={`Add feedback for ${a.name}`}>
                          <MessageSquarePlus className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">Feedback</span></Button>}
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setSelected(a.id)} aria-label={`Open ${a.name}`} data-testid={`button-row-open-${a.id}`}>
                          <ChevronRight className="h-4 w-4" /></Button>
                      </div>
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>}
          {d && d.total > 0 && <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1 || list.isFetching} onClick={() => setPage(p => p - 1)} data-testid="button-accounts-prev">Previous</button>
            <span>Page {d.page} of {pages}</span>
            <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= pages || list.isFetching} onClick={() => setPage(p => p + 1)} data-testid="button-accounts-next">Next</button>
          </div>}
        </div>
        {selected && <SalesAccountDetailPanel key={selected} id={selected} onClose={() => setSelected(null)} onAddFeedback={onAddFeedback} />}
      </div>
      {canAssign && batchOpen && <SalesOwnerBatchDialog accountIds={batchIds} onClose={() => setBatchOpen(false)}
        onSaved={count => { setBatchOpen(false); setBatchIds([]); setSelected(null); toast({ title: `Owners assigned to ${count} accounts` }); }} />}
    </div>
  );
}
