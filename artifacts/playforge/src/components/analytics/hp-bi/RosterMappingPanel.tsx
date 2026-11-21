import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetHpRosterAnalysisQueryKey, useGetHpRosterAnalysis, useUpdateHpRosterAssociation } from "@workspace/api-client-react";
import type { HpRosterMappedAccount } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/useAuth";
import { Chip, Panel, Skel } from "./ui";
import { num } from "./format";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import RosterAccountSearch from "./RosterAccountSearch";

const STATUSES = ["Hot", "Warm", "Cold", "Unclassified"] as const;
const MAPS = ["roster", "linked", "review", "unmatched"] as const;
const MAP_LABEL: Record<string, string> = { roster: "Direct roster", linked: "Reporting link", review: "Needs review", unmatched: "Unmatched" };
const btn = "rounded border border-[#c5d3df] bg-white px-2 py-1 text-xs hover:bg-[#eaf6fc] disabled:opacity-50";

export default function RosterMappingPanel({ clientId, onOpenAccount, admin }: { clientId: number; onOpenAccount?: (parentKey: string) => void; admin?: boolean }) {
  const { user } = useAuth();
  const isAdmin = admin ?? user?.role === "admin";
  const qc = useQueryClient();
  const params = { clientId };
  const q = useGetHpRosterAnalysis(params, { query: { queryKey: getGetHpRosterAnalysisQueryKey(params) } });
  const mut = useUpdateHpRosterAssociation();
  const [status, setStatus] = useState("");
  const [mapping, setMapping] = useState("");
  const [search, setSearch] = useState("");
  const [pick, setPick] = useState<{ acc: HpRosterMappedAccount; target: number; label: string } | null>(null);
  const [finding, setFinding] = useState<HpRosterMappedAccount | null>(null);
  const [unlink, setUnlink] = useState<HpRosterMappedAccount | null>(null);
  const data = q.data;
  const rows = useMemo(() => (data?.accounts ?? []).filter(a => (!status || a.status === status) && (!mapping || a.mapping === mapping) && (!search || a.name.toLowerCase().includes(search.toLowerCase()))), [data, status, mapping, search]);
  const totals = useMemo(() => { const t = { hot: 0, warm: 0, cold: 0, responses: 0 }; for (const a of data?.accounts ?? []) { t.hot += a.hot; t.warm += a.warm; t.cold += a.cold; t.responses += a.responses; } return t; }, [data]);
  const counts = useMemo(() => Object.fromEntries(MAPS.map(m => [m, (data?.accounts ?? []).filter(a => a.mapping === m).length])), [data]);

  const submit = (acc: HpRosterMappedAccount, target: number | null) => {
    mut.mutate({ data: { clientId, sourceAccountId: acc.accountId, targetAccountId: target, expectedTargetAccountId: acc.targetAccountId, confirm: true } }, {
      onSuccess: () => { setPick(null); setUnlink(null);
        void qc.invalidateQueries({ queryKey: ["hp-bi"] }); void qc.invalidateQueries({ queryKey: ["hp-bi-detail"] }); void qc.invalidateQueries({ queryKey: getGetHpRosterAnalysisQueryKey(params) }); },
    });
  };

  if (q.isLoading) return <div data-testid="roster-loading" role="status" className="space-y-2"><Skel className="h-20" /><Skel className="h-60" /></div>;
  if (q.isError || !data) {
    const st = (q.error as { status?: number } | null)?.status;
    return <div role="alert" data-testid="roster-error" className="rounded border border-[#e5b8b8] bg-[#fdf3f3] p-4 text-sm">{st === 401 || st === 403 ? "You are not authorised to view roster analysis." : `Could not load roster analysis. ${(q.error as Error | null)?.message ?? ""}`} <button type="button" className={btn} onClick={() => void q.refetch()}>Retry</button></div>;
  }
  const mapNote = (a: HpRosterMappedAccount) => a.mapping === "roster" ? "Directly matched to a roster account" : a.mapping === "linked" ? `Reporting link to account ${a.targetAccountId}` : a.targetAccountId ? "Saved roster target unavailable — review or unlink" : a.mapping === "review" ? "Suggestions only; nothing approved" : "No safe candidate";

  return (
    <div className="space-y-3" data-testid="roster-panel">
      <Panel id="roster-columns" title="Workbook snapshot" note="Workbook columns and populated rows; NA placeholders excluded. Not leads or ToV."
        right={<span className="text-xs text-[#41586e]" data-testid="roster-file">{data.fileName ?? "No file name"} / {num(data.sourceRows)} rows / {num(data.rosterAccounts)} roster accounts</span>}>
        <p className="text-xs mb-2" data-testid="roster-column-count">{data.columns.length} columns captured</p>
        {data.columns.length === 0 ? <p className="text-xs text-[#5d7388]">No workbook columns captured.</p> :
          <div className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-3">{data.columns.map(c => <div key={c.key} className="flex justify-between gap-2 border-t border-[#e3ebf2] py-0.5 text-xs" data-testid={`roster-col-${c.key}`}><span className="truncate" title={c.label}>{c.label}</span><span className="tabular-nums text-[#41586e]">{num(c.populatedRows)} / {num(data.sourceRows)}</span></div>)}</div>}
      </Panel>
      <Panel id="roster-totals" title="Source GTM responses" note="Original response counts per status, distinct from CRM qualification.">
        <div className="flex flex-wrap gap-3 text-xs" data-testid="roster-totals">
          <span>Accounted responses {num(totals.responses)} of {num(data.responses)}</span>
          <span data-testid="total-hot">Hot {num(totals.hot)}</span><span data-testid="total-warm">Warm {num(totals.warm)}</span><span data-testid="total-cold">Cold {num(totals.cold)}</span>
        </div>
        <div className="flex flex-wrap gap-3 text-xs mt-2" data-testid="roster-mapping-counts">{MAPS.map(m => <span key={m}>{MAP_LABEL[m]}: <strong>{num(counts[m])}</strong></span>)}</div>
        <p className="text-[11px] text-[#5d7388] mt-1">Reporting links affect BI grouping only. Company, contact, submission and enrollment identities stay unchanged.</p>
      </Panel>
      <Panel id="roster-accounts" title="Mapped accounts" right={<button type="button" className={btn} onClick={() => void q.refetch()} disabled={q.isFetching} data-testid="button-roster-refresh">{q.isFetching ? "Refreshing" : "Refresh"}</button>}>
        <div className="flex flex-wrap gap-1 mb-2 items-center">
          {STATUSES.map(s => <button key={s} type="button" aria-pressed={status === s} data-testid={`roster-filter-${s}`} className={`${btn} ${status === s ? "!bg-[#0B2A4A] !text-white" : ""}`} onClick={() => setStatus(status === s ? "" : s)}>{s}</button>)}
          <select aria-label="Mapping state" data-testid="roster-filter-mapping" className={btn} value={mapping} onChange={e => setMapping(e.target.value)}><option value="">All mapping states</option>{MAPS.map(m => <option key={m} value={m}>{MAP_LABEL[m]}</option>)}</select>
          <input data-testid="roster-search" aria-label="Search accounts" placeholder="Search accounts" className="rounded border border-[#c5d3df] px-2 py-1 text-xs" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {mut.isError && <p role="alert" data-testid="roster-mutation-error" className="text-xs text-[#b3261e] mb-2">{(mut.error as Error).message || "The association could not be saved."}</p>}
        {rows.length === 0 ? <p className="text-xs text-[#5d7388] py-6 text-center" data-testid="roster-empty">{data.accounts.length ? "No accounts match these filters." : "No GTM accounts to map."}</p> :
          <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left text-[10.5px] uppercase text-[#5d7388]">{["Account", "Status", "Responses", "Hot", "Warm", "Cold", "Mapping", "Action"].map(h => <th key={h} className="py-1 pr-2">{h}</th>)}</tr></thead>
            <tbody>{rows.map(a => <tr key={a.accountId} className="border-t border-[#e3ebf2] align-top" data-testid={`roster-row-${a.accountId}`}>
              <td className="py-1 pr-2">{onOpenAccount ? <button type="button" className="text-[#05628f] hover:underline text-left" onClick={() => onOpenAccount(a.parentKey)}>{a.name}</button> : a.name}</td>
              <td><Chip tone={a.status === "Hot" ? "hot" : a.status === "Warm" ? "warm" : a.status === "Cold" ? "blue" : "gray"}>{a.status}</Chip></td>
              <td className="tabular-nums">{a.responses}</td><td className="tabular-nums">{a.hot}</td><td className="tabular-nums">{a.warm}</td><td className="tabular-nums">{a.cold}</td>
              <td><div>{MAP_LABEL[a.mapping]}</div><div className="text-[11px] text-[#5d7388]">{mapNote(a)}</div></td>
              <td>
                {a.targetAccountId !== null && <button type="button" className={btn} disabled={!isAdmin || mut.isPending} title={isAdmin ? undefined : "Admin only"} data-testid={`button-unlink-${a.accountId}`} onClick={() => { mut.reset(); setUnlink(a); }}>Unlink</button>}
                {a.mapping === "review" && (a.candidates.length ? <ul className="space-y-1">{a.candidates.map(c => <li key={c.accountId} className="rounded border border-[#e3ebf2] p-1"><div className="font-medium">{c.name}</div><div className="text-[11px] text-[#5d7388]">{c.hpId} / {c.parentName} / {c.reason}</div>
                  <button type="button" className={btn} disabled={!isAdmin || mut.isPending} title={isAdmin ? undefined : "Admin only"} data-testid={`button-select-${a.accountId}-${c.accountId}`} onClick={() => { mut.reset(); setPick({ acc: a, target: c.accountId, label: c.name }); }}>Select</button></li>)}</ul> : <span className="text-[#5d7388]">No safe candidate</span>)}
                {a.mapping === "unmatched" && <span className="text-[#5d7388]">No safe candidate</span>}
                {a.mapping !== "roster" && <button type="button" className={`${btn} mt-1`} disabled={!isAdmin || mut.isPending} data-testid={`button-find-roster-${a.accountId}`} onClick={() => setFinding(a)}>Find roster account</button>}
              </td></tr>)}</tbody></table></div>}
      </Panel>
      {finding && <RosterAccountSearch clientId={clientId} name={finding.name} onClose={() => setFinding(null)} onSelect={candidate => { mut.reset(); setPick({ acc: finding, target: candidate.accountId, label: candidate.name }); setFinding(null); }} />}
      {(pick || unlink) && <Dialog open onOpenChange={open => { if (!open && !mut.isPending) { setPick(null); setUnlink(null); } }}><DialogContent data-testid="roster-confirm" className="max-w-md">
        <DialogHeader><DialogTitle>{pick ? "Confirm reporting link" : "Confirm unlink"}</DialogTitle></DialogHeader>
        <p>{pick ? `Group "${pick.acc.name}" into "${pick.label}" for BI reporting only.` : `Remove the reporting link for "${unlink!.name}".`}</p>
        <p className="text-xs text-[#41586e]">This is not a legal merge. BI parent grouping changes, but company, contact, submission and enrollment identities remain unchanged.</p>
        {mut.isError && <p role="alert" className="text-xs text-red-700">{mut.error.message}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={btn} disabled={mut.isPending} data-testid="button-roster-cancel" onClick={() => { setPick(null); setUnlink(null); }}>Cancel</button>
          <button type="button" className="rounded bg-[#0B2A4A] px-3 py-1 text-xs text-white disabled:opacity-50" disabled={mut.isPending} data-testid="button-roster-confirm" onClick={() => pick ? submit(pick.acc, pick.target) : submit(unlink!, null)}>{mut.isPending ? "Saving" : "Confirm"}</button></div></DialogContent></Dialog>}
    </div>
  );
}
