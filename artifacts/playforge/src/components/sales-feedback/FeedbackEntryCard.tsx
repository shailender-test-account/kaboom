import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, ChevronDown, FileSpreadsheet, GitCompare, PenLine, Phone, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FeedbackEntry } from "@/hooks/use-sales-feedback";

export const fmtDate = (d: string | null) => d
  ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) + " IST"
  : null;
export const typeLabel = (t: string) => t === "sales_rep" ? "Sales rep" : "Telesales";

const statusStyle: Record<string, string> = {
  pending: "border-l-amber-500 ",
  approved: "border-l-teal-600",
  rejected: "border-l-slate-400",
};
const statusChip: Record<string, string> = {
  pending: "bg-amber-50 text-amber-900 border-amber-300",
  approved: "bg-teal-50 text-teal-900 border-teal-300",
  rejected: "bg-slate-100 text-slate-600 border-slate-300",
};
const tempChip: Record<string, string> = {
  Hot: "bg-red-50 text-red-800 border-red-200", Warm: "bg-amber-50 text-amber-800 border-amber-200", Cold: "bg-sky-50 text-sky-800 border-sky-200",
};

const auditVal = (v: unknown) => v == null || v === "" ? "none" : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? (fmtDate(v) ?? v) : typeof v === "object" ? JSON.stringify(v) : String(v);

export function FeedbackEntryCard({ entry: e, onReview, compact = false }: {
  entry: FeedbackEntry; onReview?: (e: FeedbackEntry) => void; compact?: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const [audit, setAudit] = useState(false);
  const history = e.reviewHistory ?? [];
  const unmatched = e.accountId == null && e.contactId == null;
  const partial = !unmatched && e.contactId == null;
  const rawEntries = Object.entries(e.rawFields ?? {});
  return (
    <article data-testid={`feedback-entry-${e.id}`}
      className={cn("rounded-md border border-l-[3px] bg-card p-3 text-xs space-y-2 sf-rise", statusStyle[e.reviewStatus])}>
      <header className="flex flex-wrap items-center gap-1.5">
        <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider", statusChip[e.reviewStatus])} data-testid={`status-feedback-${e.id}`}>{e.reviewStatus}</span>
        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
          {e.type === "sales_rep" ? <UserRound className="h-3 w-3" /> : <Phone className="h-3 w-3" />}{typeLabel(e.type)}
        </span>
        {e.proposedTemperature && <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold", tempChip[e.proposedTemperature] ?? "bg-muted")}>Proposed {e.proposedTemperature}</span>}
        {e.approvedQualification && <span className="rounded border border-teal-300 bg-teal-600 px-1.5 py-0.5 text-[10px] font-semibold text-white" data-testid={`qualified-feedback-${e.id}`}>Qualification applied</span>}
        {e.reviewStatus === "approved" && !e.approvedQualification && <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">History only</span>}
        {unmatched && <span className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-800" data-testid={`unmatched-feedback-${e.id}`}><AlertTriangle className="h-3 w-3" />Unmatched identity</span>}
        {partial && <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-900">Account only, no contact</span>}
        {e.superseded && <span className="inline-flex items-center gap-1 rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-900" data-testid={`superseded-feedback-${e.id}`}>
          <GitCompare className="h-3 w-3" />Superseded by a changed-file revision</span>}
        <span className="ml-auto text-muted-foreground tabular-nums">{fmtDate(e.occurredAt) ?? <span className="text-amber-800">Call date not recorded</span>}</span>
      </header>

      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {e.createdByName
          ? <span><span className="text-muted-foreground">Submitted by </span><strong data-testid={`author-feedback-${e.id}`}>{e.createdByName}</strong></span>
          : e.sourceId != null
            ? <span><span className="text-muted-foreground">Rep in sheet </span><strong data-testid={`rep-feedback-${e.id}`}>{e.repName || "Unknown"}</strong></span>
            : <span><span className="text-muted-foreground">Rep </span><strong data-testid={`rep-feedback-${e.id}`}>{e.repName || "Unknown"}</strong> <span className="text-muted-foreground" data-testid={`legacy-author-${e.id}`}>(typed name, submitter not recorded)</span></span>}
        {!compact && <span><span className="text-muted-foreground">Account </span>{e.accountId ? <Link className="underline" href={`/crm/companies/${e.accountId}`}>{e.accountName ?? `#${e.accountId}`}</Link> : "Not matched"}</span>}
        <span><span className="text-muted-foreground">Contact </span>{e.contactId ? <Link className="underline" href={`/crm/contacts/${e.contactId}`}>{e.contactName ?? `#${e.contactId}`}</Link> : "Not matched"}</span>
        {e.product && <span><span className="text-muted-foreground">Product </span>{e.product}</span>}
        {e.timingMonths != null && <span><span className="text-muted-foreground">Timing </span>{e.timingMonths} mo</span>}
      </div>

      <blockquote className="border-l-2 border-muted-foreground/30 pl-2.5 text-[13px] leading-relaxed whitespace-pre-wrap" data-testid={`text-feedback-${e.id}`}>{e.feedback}</blockquote>
      {e.nextAction && <p className="rounded bg-amber-50/70 px-2 py-1 text-amber-950"><span className="font-semibold">Next action: </span>{e.nextAction}</p>}

      {e.reviewStatus !== "pending" && (
        <p className="text-muted-foreground" data-testid={`review-meta-${e.id}`}>
          Reviewed {fmtDate(e.reviewedAt) ?? "date unknown"}{e.reviewedBy != null ? ` by user #${e.reviewedBy}` : ""}{e.reviewNote ? ` · "${e.reviewNote}"` : ""}
        </p>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-dashed pt-2 font-mono text-[10.5px] text-muted-foreground">
        {e.sourceId != null
          ? <span className="inline-flex items-center gap-1"><FileSpreadsheet className="h-3 w-3" />{e.sourceName ?? `Source #${e.sourceId}`} / {e.fileName ?? "file?"} / {e.sheetName ?? "sheet?"} row {e.rowNumber ?? "?"}</span>
          : <span className="inline-flex items-center gap-1"><PenLine className="h-3 w-3" />Manual entry</span>}
        <span data-testid={`submitted-feedback-${e.id}`}>{e.sourceId != null ? "imported" : "submitted"} {fmtDate(e.createdAt)}{e.createdByName ? ` by ${e.createdByName}` : e.sourceId != null ? " · no signed-in author" : ""}</span>
        {rawEntries.length > 0 && <button type="button" className="inline-flex items-center gap-0.5 underline" onClick={() => setRaw(r => !r)} data-testid={`button-raw-${e.id}`} aria-expanded={raw}>
          raw row <ChevronDown className={cn("h-3 w-3 transition-transform", raw && "rotate-180")} /></button>}
        {history.length > 0 && <button type="button" className="inline-flex items-center gap-0.5 underline" onClick={() => setAudit(r => !r)} data-testid={`button-audit-${e.id}`} aria-expanded={audit}>
          review audit ({history.length}) <ChevronDown className={cn("h-3 w-3 transition-transform", audit && "rotate-180")} /></button>}
        {onReview && <button type="button" onClick={() => onReview(e)} data-testid={`button-review-${e.id}`}
          className="ml-auto rounded border border-foreground/20 bg-background px-2 py-1 font-sans text-[11px] font-semibold text-foreground hover:bg-muted">
          {e.reviewStatus === "pending" ? "Review" : "Re-review"}</button>}
      </footer>
      {audit && (
        <ol className="space-y-1 rounded bg-muted/50 p-2 font-mono text-[10.5px]" data-testid={`audit-${e.id}`}>
          {history.map((h, i) => <li key={i} className="flex flex-wrap gap-x-3 border-b border-dashed pb-1 last:border-0">
            {Object.entries(h).map(([k, v]) => <span key={k}><span className="text-muted-foreground">{k} </span>{auditVal(v)}</span>)}
          </li>)}
        </ol>
      )}
      {raw && (
        <dl className="grid grid-cols-[minmax(110px,max-content)_1fr] gap-x-3 gap-y-0.5 rounded bg-muted/50 p-2 font-mono text-[10.5px]" data-testid={`raw-fields-${e.id}`}>
          {rawEntries.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground truncate">{k}</dt><dd className="break-words">{v == null || v === "" ? "(blank)" : typeof v === "object" ? JSON.stringify(v) : String(v)}</dd></div>)}
        </dl>
      )}
    </article>
  );
}
