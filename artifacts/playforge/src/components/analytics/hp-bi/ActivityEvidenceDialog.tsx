import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { HpBiDetail, HpBiRecord } from "./types";
import MonitoringContext from "./MonitoringContext";
import InboundSourceProvenance from "@/components/intent/InboundSourceProvenance";

type Person = HpBiDetail["contacts"][number];
export type ActivityInspection = { record: HpBiRecord } | { person: Person } | { accountId: number };
const show = (v: unknown): string => v === null || v === undefined || v === "" ? "Not provided" : typeof v === "object" ? JSON.stringify(v) : String(v);

export default function ActivityEvidenceDialog({ value, detail, onClose, dateText }: {
  value: ActivityInspection | null; detail: HpBiDetail; onClose: () => void; dateText: (date: string) => string;
}) {
  const record = value && "record" in value ? value.record : null;
  const person = value && "person" in value ? value.person : record ? detail.contacts.find(c => c.id === record.contactId) : null;
  const accountId = record?.accountId ?? person?.companyId ?? (value && "accountId" in value ? value.accountId : undefined);
  const account = detail.members.find(m => m.id === accountId);
  const fields: [string, unknown][] = record ? [
    ["Person", person?.name ?? (record.contactId == null ? "Account-level — no person attributed" : "Contact unavailable")],
    ["Email", person?.email], ["Title", person?.title], ["Legal account", account?.name ?? "Unknown legal account"],
    ["Action kind", record.kind], ["Recorded status", record.status], ["Occurred at (IST)", dateText(record.occurredAt)],
    ["Product", record.product], ["Category", record.category], ["Purchase timeframe (months)", record.horizonMonths],
    ["Recorded value", record.orderValue], ["Currency", record.currency], ["Page / program", record.sourceName],
    ["Source", record.source], ["Source reference", record.externalEventId ?? record.id], ["Record ID", record.id],
    ...(record.relatedRecords?.length ? [["Related records from this same submission", record.relatedRecords] as [string, unknown]] : []),
    ...Object.entries(record.lineage ?? {}).map(([k, v]) => [k, v] as [string, unknown]),
    ...(record.exclusionReasons?.length ? [["Exclusion reasons", record.exclusionReasons.join("; ")] as [string, unknown]] : []),
  ] : person ? [
    ["Name", person.name], ["Email", person.email], ["Title", person.title], ["Legal account", account?.name],
    ["Contact ID", person.id], ["Current engagement score (not lead qualification)", person.score], ["New contact", person.isNew ? "Yes" : "No"],
  ] : [["Legal account", account?.name], ["Account ID", accountId], ...Object.entries(account?.dimensions ?? {})];
  return <Dialog open={!!value} onOpenChange={open => !open && onClose()}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl" data-testid="activity-evidence-inspection">
      <DialogHeader><DialogTitle>{record ? "Source record details" : person ? "Contact details" : "Legal account details"}</DialogTitle>
        <DialogDescription>Details from the selected account scope. Close to return to the same contacts and filters.</DialogDescription></DialogHeader>
      <dl className="space-y-2 text-xs">{fields.map(([name, v]) => <div key={name} className="grid grid-cols-[minmax(100px,1fr)_2fr] gap-3 border-b pb-2">
        <dt className="font-semibold text-[#41586e]">{name}</dt><dd className="break-words min-w-0 whitespace-pre-wrap">{show(v)}</dd>
      </div>)}</dl>
      {value && <MonitoringContext contexts={detail.monitoringContext} accountId={accountId ?? -1} clientId={detail.clientId} />}
      {record && <InboundSourceProvenance provenance={record.provenance} />}
      {record && <p className="text-xs text-[#5d7388]">A recorded value is not necessarily booked business. Form submissions alone do not establish Hot status. Original source fields not supplied to this report are not inferred.</p>}
      <button type="button" className="rounded border px-3 py-2 text-xs font-semibold" onClick={onClose} data-testid="activity-inspection-back">Back to contact evidence</button>
    </DialogContent>
  </Dialog>;
}
