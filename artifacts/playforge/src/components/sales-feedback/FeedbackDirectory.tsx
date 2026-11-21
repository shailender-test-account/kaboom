import { useState } from "react";
import { Building2, UserRound } from "lucide-react";
import { useFeedbackOptions } from "@/hooks/use-sales-feedback";
import type { ManualPrefill } from "@/components/sales-feedback/ManualEntryDialog";

const sel = "h-8 rounded-md border bg-background px-2 text-xs";
const btn = "ml-auto shrink-0 rounded border px-2 py-1 text-xs font-medium hover:bg-muted";

export function FeedbackDirectory({ onLog }: { onLog?: (p: ManualPrefill) => void }) {
  const [clientId, setClientId] = useState("");
  const [search, setSearch] = useState("");
  const q = useFeedbackOptions(clientId ? Number(clientId) : undefined, search.trim() || undefined);
  const d = q.data;
  const accounts = d?.accounts ?? [];
  const contacts = d?.contacts ?? [];
  const accName = new Map(accounts.map(a => [a.id, a.name]));
  const cliName = new Map((d?.clients ?? []).map(c => [c.id, c.name]));

  return (
    <section className="space-y-3" data-testid="feedback-directory">
      <div className="flex flex-wrap items-center gap-2">
        <select className={sel} value={clientId} onChange={e => setClientId(e.target.value)} data-testid="filter-directory-client">
          <option value="">All clients</option>{(d?.clients ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input className={`${sel} w-56`} placeholder="Search company, person or email" value={search} onChange={e => setSearch(e.target.value)} data-testid="input-directory-search" />
        <span className="ml-auto text-[11px] text-muted-foreground" data-testid="text-directory-limit">Shows up to 50 accounts and 50 contacts. Search to narrow.</span>
      </div>
      {q.isError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800" data-testid="directory-error">Could not load accounts and contacts: {q.error.message} <button className="underline font-semibold" onClick={() => q.refetch()} data-testid="button-directory-retry">Retry</button></div>}
      {q.isLoading && <div className="grid gap-3 md:grid-cols-2" data-testid="directory-loading">{[0, 1].map(i => <div key={i} className="h-48 rounded-md bg-muted animate-pulse" />)}</div>}
      {d && <div className={`grid gap-3 md:grid-cols-2 ${q.isFetching ? "opacity-60" : ""}`}>
        <div className="rounded-md border bg-card">
          <h3 className="flex items-center gap-2 border-b px-3 py-2 text-sm font-semibold"><Building2 className="h-4 w-4" />Accounts <span className="font-mono text-[11px] font-normal text-muted-foreground" data-testid="text-directory-accounts">{accounts.length >= 50 ? "50 shown (more may exist)" : `${accounts.length} shown`}</span></h3>
          {accounts.length === 0 ? <p className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="directory-accounts-empty">No accounts match.</p> :
            <ul className="divide-y max-h-[60dvh] overflow-y-auto">{accounts.map(a => <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-xs" data-testid={`row-directory-account-${a.id}`}>
              <div className="min-w-0"><p className="truncate font-medium">{a.name}</p><p className="text-muted-foreground">{cliName.get(a.clientId) ?? `Client ${a.clientId}`}</p></div>
              {onLog && <button className={btn} onClick={() => onLog({ clientId: a.clientId, accountId: a.id })} data-testid={`button-directory-account-feedback-${a.id}`}>Log feedback</button>}
            </li>)}</ul>}
        </div>
        <div className="rounded-md border bg-card">
          <h3 className="flex items-center gap-2 border-b px-3 py-2 text-sm font-semibold"><UserRound className="h-4 w-4" />Contacts <span className="font-mono text-[11px] font-normal text-muted-foreground" data-testid="text-directory-contacts">{contacts.length >= 50 ? "50 shown (more may exist)" : `${contacts.length} shown`}</span></h3>
          {contacts.length === 0 ? <p className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="directory-contacts-empty">No contacts match.</p> :
            <ul className="divide-y max-h-[60dvh] overflow-y-auto">{contacts.map(c => <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-xs" data-testid={`row-directory-contact-${c.id}`}>
              <div className="min-w-0"><p className="truncate font-medium">{c.name}</p><p className="truncate text-muted-foreground">{c.email || "No email"}{accName.has(c.companyId) ? ` · ${accName.get(c.companyId)}` : ""}</p></div>
              {onLog && <button className={btn} onClick={() => onLog({ clientId: c.clientId, accountId: c.companyId, contactId: c.id })} data-testid={`button-directory-contact-feedback-${c.id}`}>Log feedback</button>}
            </li>)}</ul>}
        </div>
      </div>}
    </section>
  );
}
