import type { Contact } from "@workspace/api-client-react";

export default function GccContactAlternatives({ records }: { records: Contact["gccAlternatives"] }) {
  if (!records?.length) return null;
  return <section data-testid="gcc-contact-alternatives" className="rounded-lg border bg-card p-4 space-y-3">
    <h3 className="text-sm font-semibold">GCC source-supplied alternatives</h3>
    <p className="text-xs text-muted-foreground">
      Imported directory details, not verified addresses or consent to outreach. Primary contact details are unchanged.
      Each source version is shown separately.
    </p>
    {records.map((r, index) => <article key={`${r.fileHash}-${r.sourceRow}-${index}`}
      className="border-t pt-3 text-sm space-y-2" data-testid="gcc-contact-source">
      <dl className="grid gap-2 sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Alternate email (source-supplied)</dt>
          <dd className="break-words [overflow-wrap:anywhere]">{r.alternateEmail || "Not supplied"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Alternate phone (source-supplied)</dt>
          <dd className="break-words [overflow-wrap:anywhere]">{r.alternatePhone || "Not supplied"}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground break-words">
        {r.fileName} / {r.sheet} / row {r.sourceRow}
        {r.importedAt && <> · Imported {r.importedAt}</>}
      </p>
    </article>)}
  </section>;
}
