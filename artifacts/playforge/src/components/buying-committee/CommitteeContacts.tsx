import { useState, type ReactNode } from "react";
import { committeeExportUrl, useBuyingOptions, useCommitteeContacts, type CommitteePerson } from "./api";
import SaveContact from "./SaveContact";

const PAGE = 25;

function Person({ p, clientId, canSave }: { p: CommitteePerson; clientId: number; canSave: boolean }) {
  const apollo = p.source.toLowerCase().includes("apollo");
  return (
    <li className="rounded border border-[#d5e0ea] bg-white p-2 text-xs" data-testid={`committee-person-${p.id}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={p.engaged ? "font-bold text-green-700" : "font-medium text-[#0B2A4A]"}>{p.name}</span>
        {p.engaged && <span className="rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold text-green-800 border border-green-200">Engaged: {p.engagementSources.join(", ") || "verified CRM contact"}</span>}
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold border ${apollo ? "bg-sky-50 text-sky-800 border-sky-200" : "bg-stone-50 text-stone-700 border-stone-200"}`}>{apollo ? "Sourced prospect" : p.source}</span>
        {p.categories.map(c => <span key={c} className="rounded bg-[#eef3f7] px-1.5 py-0.5 text-[10px] text-[#41586e]">{c}</span>)}
      </div>
      <div className="mt-0.5 text-[#5d7388]">{p.title || "Title not provided"} / {p.companyName}{p.location ? ` / ${p.location}` : ""}</div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[#41586e]">
        <span>{p.email || "Email not available"}</span>
        <span>{p.phone || "Phone not provided"}</span>
        {p.linkedin && /^https?:\/\/([a-z]+\.)?linkedin\.com\//i.test(p.linkedin) ? <a className="text-[#05628f] hover:underline" href={p.linkedin} target="_blank" rel="noreferrer">LinkedIn</a> : <span>LinkedIn not available</span>}
      </div>
      {p.sourcedAt && <div className="mt-0.5 text-[10px] text-[#8CA0B3]">Sourced {new Date(p.sourcedAt).toLocaleDateString()}</div>}
      {(canSave || p.crmContactId) && <SaveContact person={p} clientId={clientId} canSave={canSave} />}
    </li>
  );
}

function Help({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panel = `committee-help-${id}`;
  return (
    <span className="relative inline-block align-middle">
      <button type="button" aria-label={label} aria-expanded={open} aria-controls={panel} data-testid={`button-help-${id}`}
        onClick={() => setOpen(o => !o)} onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[#9fb3c6] bg-white text-[10px] font-bold leading-none text-[#41586e] hover:bg-[#eaf6fc] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0096D6]">?</button>
      {open && <span id={panel} role="note" data-testid={`help-${id}`} className="absolute left-0 top-5 z-20 block w-72 max-w-[80vw] rounded border border-[#c5d3df] bg-white p-2 text-[11px] font-normal normal-case tracking-normal text-[#41586e] shadow-md">{children}</span>}
    </span>
  );
}

function CommitteeContactsPage({ clientId, accountIds, country, pageSize = PAGE }: { clientId: number; accountIds: number[]; country?: string; pageSize?: number }) {
  const [page, setPage] = useState(1);
  const [planPage, setPlanPage] = useState(1);
  const [viewCountry, setViewCountry] = useState(country ?? "");
  const options = useBuyingOptions();
  const q = useCommitteeContacts({ clientId, accountIds, page, pageSize, planPage, ...(viewCountry ? { country: viewCountry } : {}) });
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const sourcing = q.data?.sourcing;
  const plans = q.data?.savedPlans;
  return (
    <div className="space-y-2" data-testid="committee-contacts">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[#5d7388]">
        <span className="inline-flex items-center gap-1 font-semibold text-[#0B2A4A]" data-testid="text-committee-count">{q.data ? `${total} ${total === 1 ? "person" : "people"}` : "Contacts"}
          <Help id="contacts" label="About committee contacts">Matching internal contacts are used first; external sourcing is used only when no internal matches are found for an account. Verified engaged CRM contacts remain visible across all dates. Bold green names indicate verified engagement, not database membership. Contact details depend on source availability; personal-email and direct-dial unlocks are not requested.</Help></span>
        {!country && <label className="flex items-center gap-1.5"><span className="sr-only">Filter sourced contact country</span>
          <select aria-label="Filter sourced contact country" data-testid="select-committee-country" className="h-7 rounded border border-[#c5d3df] bg-white px-1.5 text-xs text-[#0B2A4A]" value={viewCountry}
            onChange={e => { setViewCountry(e.target.value); setPage(1); setPlanPage(1); }}>
            <option value="">All countries</option>
            {(options.data?.countries ?? ["India"]).map(c => <option key={c} value={c}>{c}</option>)}
          </select></label>}
        {viewCountry && <span className="inline-flex items-center gap-1" data-testid="text-committee-country">Sourced contact country: {viewCountry}
          <Help id="country" label="About the country filter">Verified first-party engagement history remains visible regardless of country. Previously sourced contacts in other countries are retained but excluded from this view and CSV.</Help></span>}
        {q.data && <span className="ml-auto inline-flex items-center gap-1">
          {q.data.canExport ? <a href={committeeExportUrl(clientId, accountIds, viewCountry || undefined)} download data-testid="link-committee-export" className="rounded border border-[#c5d3df] bg-white px-2 py-0.5 text-[#0B2A4A] hover:bg-slate-50">Export CSV</a>
            : <span data-testid="text-export-restricted">Export restricted to admins</span>}
          <Help id="export" label="About the CSV export">CSV includes all matching people on every page for these {accountIds.length} selected HP accounts: company, designation, available business contact details, sourced/existing provenance, requested categories, sourced date and verified engagement sources. Requested categories are targeting, not buying intent. No new sourcing or outreach. Handle downloaded contact details securely.</Help></span>}
      </div>
      {sourcing && <div role="status" data-testid="committee-sourcing-summary" className={`rounded border px-2 py-1 text-[11px] ${sourcing.failedAccounts > 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-[#d5e0ea] bg-[#f5f9fc] text-[#41586e]"}`}>
        {sourcing.accounts === 0 ? <span>No sourcing plan or attempt{viewCountry ? ` in ${viewCountry}` : ""}.</span> : <span className="inline-flex flex-wrap items-center gap-x-1">
          <span>Sourcing {sourcing.accounts}/{accountIds.length} member accounts: {sourcing.completedAccounts} completed · {sourcing.pendingAccounts} pending · {sourcing.processingAccounts} processing</span>
          {sourcing.failedAccounts > 0 && <strong data-testid="text-sourcing-attention">· {sourcing.failedAccounts} need attention</strong>}
          {sourcing.completedAccounts > 0 && <span>· Sourcing returned {sourcing.returnedContacts} matching {sourcing.returnedContacts === 1 ? "person" : "people"}</span>}
          {sourcing.completedAccounts > 0 && sourcing.returnedContacts === 0 && <span className="font-semibold">· review domains, country and designations</span>}
          {sourcing.lastCompletedAt && <span>· last {new Date(sourcing.lastCompletedAt).toLocaleDateString()}</span>}
          <Help id="sourcing" label="About sourcing status">Latest sourcing status per member account. Zero returned people from a completed run means sourcing finished without matches, not that data disappeared. Review the approved company domains, country and designations before sourcing again.{sourcing.lastCompletedAt ? ` Last completed: ${new Date(sourcing.lastCompletedAt).toLocaleString()}.` : ""}</Help>
        </span>}
      </div>}
      {plans && <details data-testid="details-saved-plans" className="rounded border border-[#d5e0ea] px-2 py-1 text-[11px] text-[#41586e]">
        <summary className="cursor-pointer font-semibold text-[#05628f]">Saved plans ({plans.items.length}{plans.hasMore ? "+" : ""})</summary>
        <div className="mt-1 flex items-center gap-1 text-[#5d7388]">By legal account, including drafts
          <Help id="plans" label="About saved plans">Opening a plan only reviews saved information; it never approves, sources or retries.</Help></div>
        {plans.items.length === 0 && <p>No saved plans in this account and country scope.</p>}
        <ul className="mt-1 space-y-0.5">{plans.items.map(p => <li key={`${p.planId}:${p.companyId}`}>
          <a data-committee-plan-link data-testid={`link-plan-${p.planId}-${p.companyId}`} className="font-semibold text-[#05628f] underline" href={`${import.meta.env.BASE_URL}intent/buying-committee?planId=${p.planId}`}>
            {p.companyName} — {p.planName} — {p.country || "Country not selected"}
          </a>
          <span> · {p.planStatus} · {p.status}</span>
        </li>)}</ul>
        {(planPage > 1 || plans.hasMore) && <div className="mt-1 flex items-center gap-3">
          <button type="button" disabled={planPage === 1} className="underline disabled:opacity-50" onClick={() => setPlanPage(planPage - 1)}>Previous plans</button>
          <span>Plans page {planPage}</span>
          <button type="button" disabled={!plans.hasMore} className="underline disabled:opacity-50" onClick={() => setPlanPage(planPage + 1)}>Next plans</button>
        </div>}
      </details>}
      {q.isLoading && <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="h-14 animate-pulse rounded bg-[#e3ebf2]" />)}</div>}
      {q.isError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{(q.error as Error).message.replace(/\bApollo\b/gi,"contact discovery")} <button type="button" className="underline" onClick={() => q.refetch()}>Retry</button></p>}
      {q.data && total === 0 && <p className="text-xs text-[#5d7388]">No committee contacts or engaged contacts for these accounts yet.</p>}
      {q.data && total > 0 && <ul className="space-y-1.5">{q.data.items.map(p => <Person key={p.id} p={p} clientId={clientId} canSave={!!q.data.canSave} />)}</ul>}
      {total > pageSize && <div className="flex items-center justify-between text-xs">
        <button type="button" className="rounded border border-[#c5d3df] bg-white px-2 py-1 disabled:opacity-50" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="text-[#5d7388]">Page {page} of {pages} / {total} people</span>
        <button type="button" className="rounded border border-[#c5d3df] bg-white px-2 py-1 disabled:opacity-50" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </div>}
    </div>
  );
}

export default function CommitteeContacts(props: { clientId: number; accountIds: number[]; country?: string; pageSize?: number }) {
  return <CommitteeContactsPage key={`${props.clientId}:${[...props.accountIds].sort((a,b)=>a-b).join(",")}:${props.country ?? ""}:${props.pageSize ?? PAGE}`} {...props} />;
}
