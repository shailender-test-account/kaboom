import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { hpBiQuery } from "./api";
import type { HpBiEvidence, HpBiFilters } from "./types";
import { dateText, num } from "./format";
import { Chip, Empty, ErrorBox, Skel } from "./ui";
import InboundSourceProvenance from "@/components/intent/InboundSourceProvenance";

export interface EvidenceQuery { title: string; month?: number; quarter?: number; kind?: string; category?: string }
const EXPLICIT = ["lead", "opportunity", "closed_won", "closed_lost", "attendance", "invitation"];

export default function EvidenceDialog({ filters, query, onClose, onBack, backLabel = "Back to dashboard" }: { filters: HpBiFilters; query: EvidenceQuery | null; onClose: () => void; onBack: () => void; backLabel?: string }) {
  const [page, setPage] = useState(1);
  const [separate, setSeparate] = useState(false);
  useEffect(() => { setPage(1); setSeparate(false); }, [query]);
  const f = { ...filters, groupResponses: !separate, page, pageSize: undefined, month: query?.month, quarter: query?.quarter, kind: query?.kind, category: query?.category };
  const q = useQuery({ queryKey: ["hp-bi-evidence", f], enabled: !!query, staleTime: 15_000, queryFn: async () => {
    const r = await fetch(`/api/analytics/hp-bi/evidence?${hpBiQuery(f)}`, { credentials: "include" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Evidence request failed (${r.status})`);
    return r.json() as Promise<HpBiEvidence>;
  } });
  const d = q.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  return (
    <Dialog open={!!query} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[88vh] overflow-y-auto" data-testid="dialog-evidence">
        <button type="button" data-testid="button-evidence-back" onClick={onBack} className="self-start inline-flex items-center gap-1 text-xs font-semibold text-[#05628f] hover:underline"><ArrowLeft className="w-3.5 h-3.5" />{backLabel}</button>
        <DialogHeader><DialogTitle>{query?.title ?? "Evidence"}</DialogTitle>
          <DialogDescription>Source records behind this number, under the current filters. One questionnaire can produce an activity record and a qualified lead; these are shown together, not as duplicate accounts. Metric totals remain unchanged.</DialogDescription></DialogHeader>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={separate} data-testid="evidence-separate-records" onChange={e => { setSeparate(e.target.checked); setPage(1); }} />Show each source record separately</label>
        {d && <p className="text-xs text-[#5d7388]">{d.total} displayed entries from {d.sourceRecordTotal ?? d.total} source records. Separate submissions and legal accounts are never merged by name.</p>}
        {q.isLoading && <div className="space-y-2"><Skel className="h-8" /><Skel className="h-8" /><Skel className="h-8" /></div>}
        {q.isError && <ErrorBox message={(q.error as Error).message} onRetry={() => q.refetch()} />}
        {d && d.records.length === 0 && <Empty title="No source records" body="Nothing recorded for this selection. A zero here means no records, not missing data." />}
        {d && d.records.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="table-evidence">
              <thead><tr className="text-left text-[10.5px] uppercase tracking-wider text-[#5d7388]"><th className="py-1 pr-2">Date</th><th className="pr-2">Account</th><th className="pr-2">Kind</th><th className="pr-2">Type</th><th className="pr-2">Category / product</th><th className="pr-2">Horizon</th><th className="pr-2">Value</th><th>Source</th></tr></thead>
              <tbody>{d.records.map(r => (
                <tr key={r.id} className="border-t border-[#e3ebf2]" data-testid={`row-evidence-${r.id}`}>
                  <td className="py-1.5 pr-2 whitespace-nowrap">{dateText(r.occurredAt)}</td>
                  <td className="pr-2 max-w-[200px] truncate">{r.accountName}</td>
                  <td className="pr-2"><Chip tone={r.kind === "opportunity" || r.kind === "closed_won" || r.kind === "closed_lost" ? "blue" : r.kind === "lead" ? "teal" : "gray"}>{r.kind}</Chip></td>
                  <td className="pr-2">{EXPLICIT.includes(r.kind) || r.kind === "interest" ? <Chip tone="blue">Declared / recorded</Chip> : ["digital", "content"].includes(r.kind) ? <Chip tone="amber">Observed</Chip> : <Chip tone="gray">Recorded activity</Chip>}</td>
                  <td className="pr-2">{[r.category, r.product].filter(Boolean).join(" / ") || "Unknown"}</td>
                  <td className="pr-2">{r.horizonMonths == null ? "Unknown" : `${r.horizonMonths} mo`}</td>
                  <td className="pr-2 whitespace-nowrap">{r.orderValue == null ? "None" : r.currency ? `${r.currency} ${num(r.orderValue)}` : `${num(r.orderValue)} (no currency)`}
                    {r.orderValue != null && <div className="text-[10px] text-[#5d7388]">{r.kind === "closed_won" ? "Booked business" : r.kind === "opportunity" ? "Opportunity ToV" : "Prospective value"}</div>}
                  </td>
                  <td className="text-[#5d7388]">{r.sourceName || r.source}{r.status ? ` / ${r.status}` : ""}
                    <InboundSourceProvenance provenance={r.provenance} />
                    {!!r.relatedRecords?.length && <details data-testid={`combined-evidence-${r.id}`} className="mt-1">
                      <summary className="cursor-pointer font-semibold text-[#05628f]">Same submission: lead + questionnaire activity · view both records</summary>
                      {[r, ...r.relatedRecords].map(source => <div key={source.id} className="mt-2 rounded border p-2">
                        <strong>{source.kind === "lead" ? `${source.status ?? "Qualified"} lead` : "Questionnaire activity"}</strong>
                        <pre className="whitespace-pre-wrap break-all text-[10px] mt-1">{JSON.stringify({ ...source, relatedRecords: undefined }, null, 2)}</pre>
                      </div>)}
                    </details>}
                    {r.externalEventId && <div className="text-[10px] font-mono break-all" data-testid={`text-ref-${r.id}`}>Ref {r.externalEventId}</div>}
                    {r.lineage?.dealId != null && <div className="text-[10px]" data-testid={`text-lineage-deal-${r.id}`}>CRM deal {r.lineage.dealId} / {r.lineage.valueMeaning ?? "meaning unknown"} / {r.lineage.currency ?? "currency unknown"} / opportunity {r.lineage.opportunityConfirmed ? "confirmed" : "not confirmed"} / opp. date {r.lineage.actualOpportunityDate ?? "none"} / outcome date {r.lineage.actualOutcomeDate ?? "none"}</div>}
                    {r.exclusionReasons && r.exclusionReasons.length > 0 && <div className="text-[10px] text-[#8f4f0f]" data-testid={`text-exclusion-${r.id}`}>Money excluded: {r.exclusionReasons.join("; ")}</div>}
                    {r.lineage && <div className="text-[10px]">{[r.lineage.fileName, r.lineage.sheet, r.lineage.row ? `row ${r.lineage.row}` : null, r.lineage.rowKey].filter(Boolean).join(" / ")}</div>}
                  </td></tr>))}</tbody>
            </table>
          </div>
        )}
        {d && (
          <div className="flex items-center justify-between text-xs text-[#41586e]">
            <span data-testid="text-evidence-total">{num(d.total)} records</span>
            <div className="flex items-center gap-1">
              <button data-testid="button-evidence-prev" disabled={page <= 1} onClick={() => setPage(page - 1)} className="p-1 rounded border border-[#d5e0ea] disabled:opacity-40" aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
              <span className="px-2 tabular-nums">Page {page} / {pages}</span>
              <button data-testid="button-evidence-next" disabled={page >= pages} onClick={() => setPage(page + 1)} className="p-1 rounded border border-[#d5e0ea] disabled:opacity-40" aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
