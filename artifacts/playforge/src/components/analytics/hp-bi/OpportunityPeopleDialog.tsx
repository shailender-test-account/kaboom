import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { HpBiDetail, HpBiRecord } from "./types";
import { dateTimeText } from "./format";
import { opportunityRecords, type OpportunityMetric } from "./structured";

export type OpportunitySelection = { metric: OpportunityMetric; category?: string };
export const opportunityMetricLabels: Record<OpportunityMetric, string> = {
  touchpoints: "Marketing touchpoints", engagedContacts: "Engaged contacts",
  leads: "Leads", opportunities: "Opportunities", value: "Opportunity value",
};
const PAGE_SIZE = 10;

export default function OpportunityPeopleDialog({ selection, detail, onClose, onInspect }: {
  selection: OpportunitySelection; detail: HpBiDetail; onClose: () => void; onInspect: (record: HpBiRecord) => void;
}) {
  const [page, setPage] = useState(1);
  // Use the same FY records and category membership as the clicked metric.
  // All-date preferences and other categories must never leak into these counts.
  const records = opportunityRecords(detail, selection.metric, selection.category)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const people = new Set(records.map(r => r.contactId).filter(id => id != null)).size;
  const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const visible = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return <Dialog open onOpenChange={open => !open && onClose()}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-4xl" data-testid="opportunity-people-dialog">
      <DialogHeader>
        <DialogTitle>{selection.category ?? "All categories"} · {opportunityMetricLabels[selection.metric]}</DialogTitle>
        <DialogDescription>Selected fiscal year · {people} identified {people === 1 ? "person" : "people"} · {records.length} supporting records. A person may have several product or activity records; an account-level record does not identify a person.</DialogDescription>
      </DialogHeader>
      {!records.length ? <p className="py-6 text-sm text-[#5d7388]">No supporting records for this metric in the selected account, category and fiscal year.</p> :
        <div className="overflow-x-auto"><table className="w-full border-collapse text-xs [&_th]:border [&_td]:border [&_th]:p-2 [&_td]:p-2" aria-label="People and product interest">
          <thead className="bg-[#edf4f9] text-left"><tr>{["Person / account", "Product / category", "Source / date", "Interest / status", "Evidence"].map(label => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>{visible.map(record => {
            const person = detail.contacts.find(c => c.id === record.contactId);
            const account = detail.members.find(m => m.id === record.accountId);
            return <tr key={record.id} className="align-top">
              <td><strong>{person?.name ?? (record.contactId == null ? "Account-level · no person attributed" : "Contact unavailable")}</strong>
                {person && <><div>{person.title || "Title not recorded"}</div><div>{person.email || "Email not recorded"}</div></>}
                <div className="text-[#5d7388]">{account?.name ?? "Legal account unavailable"}</div></td>
              <td><strong>{record.product || "Product not recorded"}</strong><div>{record.category || "Unassigned category"}</div></td>
              <td>{record.sourceName || record.source}<div className="mt-1 text-[#5d7388]">{dateTimeText(record.occurredAt)}</div></td>
              <td>{record.kind} · {record.status || "Status not recorded"}
                <div>{record.horizonMonths == null ? "Purchase timing not recorded" : `${record.horizonMonths} months`}</div>
                {record.orderValue != null && <div>{record.currency || "Currency not supplied"} {record.orderValue.toLocaleString("en-IN")}</div>}</td>
              <td><button type="button" onClick={() => onInspect(record)} className="font-semibold text-[#05628f] underline" aria-label={`View source record for ${person?.name ?? "account-level activity"}: ${record.product || record.kind}`}>View record</button></td>
            </tr>;
          })}</tbody>
        </table></div>}
      {records.length > PAGE_SIZE && <div className="flex items-center justify-between gap-3 text-xs">
        <button type="button" className="rounded border px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous records</button>
        <span>Page {page} of {pages}</span>
        <button type="button" className="rounded border px-3 py-1 disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next records</button>
      </div>}
      <button type="button" className="justify-self-start rounded border px-3 py-2 text-xs font-semibold" onClick={onClose}>Back to account</button>
    </DialogContent>
  </Dialog>;
}
