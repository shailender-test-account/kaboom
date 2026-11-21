import { useId, useState } from "react";
import type { InboundProvenance, InboundSourceCopy } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatReportDateTime } from "@/lib/reportTime";

const date = (value: string | null) => value ? formatReportDateTime(value) : "Unavailable";
// Never render arbitrary URLs from imported data, including manual import identifiers.
const fileLink = (url: string | null) => url && /^https:\/\/drive\.google\.com\/file\/d\/[a-zA-Z0-9_-]+\/view$/.test(url) ? url : null;

/** Local, read-only audit navigation. Opening a record never runs a sync or mutation. */
export default function InboundSourceProvenance({ provenance }: { provenance?: InboundProvenance }) {
  const id = useId();
  const [selected, setSelected] = useState<InboundSourceCopy | null>(null);
  if (!provenance || provenance.copies.length < 2) return null;
  const retained = (copy: InboundSourceCopy) => copy.submissionId === provenance.retainedSubmissionId;
  return <div className="mt-2 text-xs">
    <details data-testid={`provenance-${provenance.retainedSubmissionId}`}>
      <summary data-testid={`provenance-toggle-${provenance.retainedSubmissionId}`} className="cursor-pointer font-semibold text-sky-800">
        Original files · {provenance.copies.length} source copies · 1 response
      </summary>
      <div className="mt-2 space-y-2 rounded border bg-slate-50 p-3 text-slate-700">
        <p data-testid="text-provenance-review-owner">
          Retained copy #{provenance.retainedSubmissionId}
          {provenance.savedReviewCount > 0
            ? ` holds all compatible saved reviews (${provenance.savedReviewCount}).`
            : " has no saved reviews."}
          {" "}Source copies are not extra responses. Conflicting reviews and genuine repeat submissions remain separate.
        </p>
        <ul className="space-y-2">{provenance.copies.map(copy => <li key={copy.submissionId} className="break-words rounded border bg-white p-2" data-testid={`source-copy-${copy.submissionId}`}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {fileLink(copy.fileUrl) ? <a href={fileLink(copy.fileUrl)!} target="_blank" rel="noopener noreferrer" className="font-semibold text-sky-800 underline" data-testid={`link-original-file-${copy.submissionId}`}>{copy.fileName || "Original file"}</a>
              : <span className="font-semibold">{copy.fileName || "File name unavailable"} · file link unavailable</span>}
            <a href={`#${id}-source-record-${copy.submissionId}`} onClick={event => { event.preventDefault(); setSelected(copy); }} className="text-sky-800 underline" data-testid={`link-source-record-${copy.submissionId}`}>Source record #{copy.submissionId}</a>
            {retained(copy) && <strong className="text-emerald-800">Retained copy</strong>}
          </div>
          <p className="mt-1">Submitted: {date(copy.submittedAt)} · Imported: {date(copy.importedAt)}</p>
          <p className="mt-1">{copy.hasSavedReviews
            ? retained(copy) ? "Saved reviews retained here." : `Compatible saved reviews are included in retained copy #${provenance.retainedSubmissionId}.`
            : "No saved reviews on this source copy."}</p>
        </li>)}</ul>
        <p className="text-[11px]">Read-only audit history. Original files require their own access permission. No imports, deletion or routing are triggered here.</p>
      </div>
    </details>
    <Dialog open={!!selected} onOpenChange={open => !open && setSelected(null)}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg" data-testid="dialog-inbound-source-record">
        <DialogHeader><DialogTitle>Source record #{selected?.submissionId}</DialogTitle>
          <DialogDescription>Read-only import provenance for this response. Close to return to the original files.</DialogDescription></DialogHeader>
        {selected && <dl id={`${id}-source-record-${selected.submissionId}`} className="space-y-2 break-words text-xs">
          {Object.entries({
            "Import file": selected.fileName || "Unavailable", "Source": selected.sourceName || "Unavailable",
            "Source row key": selected.rowKey || "Unavailable", "Submission date": date(selected.submittedAt),
            "Imported at": date(selected.importedAt), "Source file modified at": date(selected.sourceModifiedAt),
            "Review retention": retained(selected) ? provenance.savedReviewCount > 0
              ? "This is the retained copy with all compatible saved reviews." : "This is the retained copy; no saved reviews are present."
              : `This copy is consolidated into #${provenance.retainedSubmissionId}; any compatible reviews are retained there.`,
          }).map(([label, value]) => <div key={label} className="border-b pb-2"><dt className="font-semibold">{label}</dt><dd>{value}</dd></div>)}
          {fileLink(selected.fileUrl) && <a href={fileLink(selected.fileUrl)!} target="_blank" rel="noopener noreferrer" className="inline-block text-sky-800 underline" data-testid="link-source-record-file">Open original file</a>}
        </dl>}
        <button type="button" className="rounded border px-3 py-2 text-xs font-semibold" data-testid="button-source-record-back" onClick={() => setSelected(null)}>Back to original files</button>
      </DialogContent>
    </Dialog>
  </div>;
}
