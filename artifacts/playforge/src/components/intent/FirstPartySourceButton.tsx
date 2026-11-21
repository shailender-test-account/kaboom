import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getIntentAccountDetail } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IntentDetailPanel } from "./detail-panel";
import type { IntentDrivingSignal } from "@/hooks/use-intent";
import { formatReportDateTime } from "@/lib/reportTime";

type SourceResponse = {
  id: number; kind: string; formType: string; sourceName?: string; fileName?: string;
  submittedAt?: string; importedAt?: string; dateOrigin: string; contactId?: number; contactName?: string;
  classification?: string; reason?: string; product?: string; horizonMonths?: number;
  answers?: Record<string, unknown>; feedback?: Record<string, unknown>;
};
export function firstPartyLabel(type: string) {
  if (type === "lead_form") return "Lead form";
  if (["questionnaire", "event_questionnaire", "event_feedback"].includes(type)) return "Event questionnaire";
  return type === "inbound_response" || type === "unknown" ? "First-party response" : type.replace(/_/g, " ");
}
function display(value: unknown): string {
  if (value == null || value === "") return "Not provided";
  if (Array.isArray(value)) return value.map(display).join(", ");
  if (typeof value === "object") return Object.entries(value).filter(([key]) => !key.startsWith("__"))
    .map(([key, item]) => `${key.replace(/_/g, " ")}: ${display(item)}`).join("; ");
  return String(value);
}
export default function FirstPartySourceButton({ accountId, scope, signal }: {
  accountId: string; scope: Record<string, any>; signal: IntentDrivingSignal;
}) {
  const [open, setOpen] = useState(false);
  const ref: IntentDrivingSignal["firstPartySource"] | null = signal.firstPartySource || (
    signal.evidenceId > 0 && ["lead_form", "event_questionnaire", "event_feedback", "product_buy_intent"].includes(signal.signalType)
      ? { kind: "intent_evidence" as const, id: signal.evidenceId } : null);
  const query = useQuery({
    queryKey: ["intent", "accounts", accountId, scope, "first-party-source", ref?.kind, ref?.id],
    enabled: open && !!ref, retry: 1, staleTime: 30_000,
    queryFn: ({ signal: abortSignal }) => getIntentAccountDetail(Number(accountId), {
      ...scope, section: "first-party-source", sourceKind: ref!.kind, sourceId: ref!.id,
    }, { signal: abortSignal, credentials: "include" }) as unknown as Promise<SourceResponse>,
  });
  const badge = "rounded border border-emerald-200 bg-white px-2 py-1 text-[9px] font-black uppercase tracking-widest text-emerald-800";
  const title = firstPartyLabel(ref?.formType || signal.signalType);
  if (!ref) return <span className={badge}>{title}</span>;
  const contactScope = new URLSearchParams(Object.entries(scope).filter(([, value]) => value != null && value !== "").map(([key, value]) => [key, String(value)])).toString();
  return <>
    <button type="button" className={`${badge} cursor-pointer underline underline-offset-2 hover:bg-emerald-50`}
      onClick={() => setOpen(true)} aria-label={`View ${title.toLowerCase()} source response`}>{title} · View response</button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{query.data ? firstPartyLabel(query.data.formType) : title} · Original response</DialogTitle></DialogHeader>
        <IntentDetailPanel query={query} label="Source response">
          {query.data && <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-1 gap-3 rounded border bg-stone-50 p-3 sm:grid-cols-2">
              <div><dt className="text-xs font-semibold text-stone-500">Respondent</dt><dd>{query.data.contactId && query.data.contactName ?
                <Link className="font-semibold text-emerald-800 underline" href={`/intent/contacts/${query.data.contactId}${contactScope ? `?${contactScope}` : ""}`}>{query.data.contactName}</Link>
                : query.data.contactName || "Not linked to an identified contact"}</dd></div>
              <div><dt className="text-xs font-semibold text-stone-500">Source</dt><dd>{query.data.sourceName || query.data.fileName || "Saved response"}</dd></div>
              {query.data.fileName && <div><dt className="text-xs font-semibold text-stone-500">Source file</dt><dd className="break-words">{query.data.fileName}</dd></div>}
              <div><dt className="text-xs font-semibold text-stone-500">{query.data.kind === "intent_evidence" ? "Recorded evidence date" : "Submission date"}</dt><dd>{query.data.dateOrigin === "imported"
                ? "Original submission date unavailable" : query.data.submittedAt ? `${formatReportDateTime(query.data.submittedAt)}${query.data.dateOrigin === "edited" ? " (corrected)" : ""}` : "Not recorded"}</dd></div>
              {query.data.importedAt && <div><dt className="text-xs font-semibold text-stone-500">Imported / recorded</dt><dd>{formatReportDateTime(query.data.importedAt)}</dd></div>}
              {query.data.classification && <div><dt className="text-xs font-semibold text-stone-500">Recorded qualification</dt><dd className="capitalize">{query.data.classification}</dd></div>}
              {query.data.product && <div><dt className="text-xs font-semibold text-stone-500">Selected product / solution</dt><dd>{query.data.product}</dd></div>}
              {query.data.horizonMonths != null && <div><dt className="text-xs font-semibold text-stone-500">Purchase timeframe</dt><dd>{query.data.horizonMonths} months</dd></div>}
            </dl>
            {query.data.reason && <p className="rounded border border-emerald-100 bg-emerald-50 p-3 text-xs">{query.data.reason}</p>}
            <section aria-label="Original submitted answers"><h3 className="mb-2 font-bold">Submitted answers</h3>
              {Object.keys(query.data.answers || {}).length ? <dl className="divide-y rounded border px-3">
                {Object.entries(query.data.answers || {}).filter(([key]) => !key.startsWith("__")).map(([key, value]) =>
                  <div key={key} className="py-2"><dt className="text-xs font-semibold">{key.replace(/_/g, " ")}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-xs text-stone-700">{display(value)}</dd></div>)}
              </dl> : <p className="text-xs text-stone-500">Original field answers were not retained in this record.</p>}
            </section>
            {!!Object.keys(query.data.feedback || {}).length && <details><summary className="cursor-pointer text-xs font-semibold">Feedback / recorded answer evidence</summary><p className="mt-2 whitespace-pre-wrap break-words text-xs">{display(query.data.feedback)}</p></details>}
            <p className="text-xs text-stone-500">Saved response #{query.data.id}. Reviewing a source does not change qualification, scores or routing.</p>
          </div>}
        </IntentDetailPanel>
      </DialogContent>
    </Dialog>
  </>;
}
