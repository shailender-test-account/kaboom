import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useHpAccountRegister, useHpBiDetail } from "./api";
import { ProfileEditor } from "./AccountDetail";
import { ImportFlow } from "./ImportPanel";
import { Chip, Empty, ErrorBox, Skel } from "./ui";

export default function AccountDataManager({ clientId }: { clientId: number }) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<{ companyId: number; parentKey: string; name: string } | null>(null);
  useEffect(() => { const t = setTimeout(() => { setSearch(text.trim()); setPage(1); }, 350); return () => clearTimeout(t); }, [text]);
  const q = useHpAccountRegister(clientId, search, page);
  const detail = useHpBiDetail({ clientId, parentKey: sel?.parentKey }, !!sel);
  const scoped = useMemo(() => {
    const d = detail.data;
    if (!d || !sel) return null;
    return { ...d, members: d.members.filter(m => m.id === sel.companyId) };
  }, [detail.data, sel]);
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (q.data?.pageSize ?? 25)));
  return (
    <div className="space-y-4" data-testid="account-data-manager">
      <div className="rounded-lg border border-[#c5d3df] bg-white p-4 text-xs text-[#41586e]">
        <h3 className="text-sm font-semibold text-[#0B2A4A]">Account Data Manager</h3>
        <p className="mt-1">One row per legal company ID; several legal accounts may share a parent. This register is independent of the selected fiscal year and dashboard filters.</p>
      </div>
      {sel ? (
        <div className="rounded-lg border border-[#c5d3df] bg-white p-4 space-y-3" data-testid="manager-edit">
          <button type="button" data-testid="button-manager-back" className="text-xs font-semibold text-[#05628f] hover:underline" onClick={() => setSel(null)}>&larr; Back to list</button>
          <h4 className="text-sm font-semibold text-[#0B2A4A]">{sel.name}</h4>
          {detail.isLoading && <Skel className="h-40" />}
          {detail.isError && <ErrorBox message={(detail.error as Error).message} onRetry={() => detail.refetch()} />}
          {scoped && (scoped.members.length
            ? <ProfileEditor key={sel.companyId} d={scoped} clientId={clientId} />
            : <Empty title="Account not found" body="This legal account is no longer in its parent group." />)}
        </div>
      ) : (
        <div className="rounded-lg border border-[#c5d3df] bg-white p-4 space-y-3">
          <div className="relative max-w-sm"><Search className="w-3.5 h-3.5 absolute left-2 top-2 text-[#5d7388]" />
            <input data-testid="input-manager-search" value={text} onChange={e => setText(e.target.value)} placeholder="Search legal accounts" className="pl-7 pr-2 py-1.5 text-xs rounded border border-[#c5d3df] w-full" /></div>
          {q.isLoading && <div className="space-y-2" data-testid="manager-loading">{Array.from({ length: 6 }).map((_, i) => <Skel key={i} className="h-8" />)}</div>}
          {q.isError && <ErrorBox message={(q.error as Error).message} onRetry={() => q.refetch()} />}
          {q.data && (q.data.items.length === 0
            ? <Empty title="No legal accounts found" body={search ? "No account matches this search." : "Import an accounts dataset below to build the register."} />
            : <div className="overflow-x-auto"><table className="w-full text-xs min-w-[720px]" data-testid="table-manager">
              <thead><tr className="text-left text-[10.5px] uppercase text-[#5d7388]"><th className="py-1">Legal account</th><th>HP ID</th><th>Parent</th><th>Top 200</th><th>ABM</th><th /></tr></thead>
              <tbody>{q.data.items.map(r => (
                <tr key={r.companyId} className="border-t border-[#e3ebf2]" data-testid={`row-manager-${r.companyId}`}>
                  <td className="py-1.5 font-medium">{r.name}</td><td>{r.hpId ?? "Unknown"}</td><td>{r.parentName ?? "Unknown"}</td>
                  <td>{r.top200 ? <Chip tone="blue">Top 200</Chip> : "No"}</td><td>{r.abmClassification || "Not designated"}</td>
                  <td><button type="button" data-testid={`button-edit-${r.companyId}`} className="text-[#05628f] hover:underline" disabled={!r.parentKey}
                    onClick={() => r.parentKey && setSel({ companyId: r.companyId, parentKey: r.parentKey, name: r.name })}>Edit</button></td></tr>))}</tbody></table></div>)}
          <p className="text-[11px] text-[#5d7388] sm:hidden">Swipe the table horizontally for account fields and Edit.</p>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <button type="button" data-testid="button-manager-prev" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="rounded border border-[#c5d3df] px-2 py-1 disabled:opacity-50">Previous</button>
            <span data-testid="text-manager-page">Page {page} of {pages} / {total.toLocaleString("en-IN")} legal accounts</span>
            <button type="button" data-testid="button-manager-next" disabled={page >= pages} onClick={() => setPage(p => p + 1)} className="rounded border border-[#c5d3df] px-2 py-1 disabled:opacity-50">Next</button>
          </div>
        </div>
      )}
      <div className="rounded-lg border border-[#c5d3df] bg-white p-4">
        <h4 className="text-sm font-semibold text-[#0B2A4A] mb-2">Import datasets</h4>
        <ImportFlow clientId={clientId} />
      </div>
    </div>
  );
}
