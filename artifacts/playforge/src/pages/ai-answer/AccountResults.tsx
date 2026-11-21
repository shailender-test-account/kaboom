import { Link } from "wouter";
import type { AIAnswerAccount } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

const date = (s: string | null) => s ? new Date(s).toLocaleDateString() : "date unknown";
export default function AccountResults({ accounts, page, pages, busy, goPage }: {
  accounts: AIAnswerAccount[]; page: number; pages: number; busy: boolean; goPage: (page: number) => void;
}) {
  if (!accounts.length) return <div className="rounded-lg border border-dashed p-8 text-center" data-testid="state-empty">
    <p className="font-medium">No accounts matched these filters</p>
    <p className="text-sm text-muted-foreground">The question was understood; no accounts match the recorded evidence for this client.</p>
  </div>;
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground" data-testid="text-page-info">Page {page} of {pages}. Each legal account is counted once. Paging reuses the interpreted filters without another AI call.</p>
    <ul className={`space-y-3 ${busy ? "opacity-50" : ""}`}>
      {accounts.map(a => <li key={a.id} className="rounded-lg border bg-card p-4 space-y-2" data-testid={`card-account-${a.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><Link href={`/crm/companies/${a.id}`} className="font-semibold text-primary hover:underline">{a.name}</Link>
            <p className="text-xs text-muted-foreground">{a.industry || "Industry not recorded"}</p></div>
          <Badge variant="secondary">{a.matchingRecords} matching record{a.matchingRecords === 1 ? "" : "s"}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">Latest matching record: {date(a.lastEngagedAt)}</p>
        <ul className="space-y-2">
          {a.evidence.map((e, i) => <li key={`${e.reference}-${i}`} className="text-sm flex flex-wrap gap-2 items-center" data-testid={`account-evidence-${a.id}-${i}`}>
            <Badge variant={e.basis === "declared" ? "secondary" : "default"} className="font-normal">{e.basis === "declared" ? "Recorded response" : "Observed engagement"}</Badge>
            <span>{e.product || "General engagement"}</span>
            <span className="text-xs text-muted-foreground">{date(e.occurredAt)}{e.source ? ` via ${e.source}` : ""} (ref {e.reference})</span>
          </li>)}
        </ul>
      </li>)}
    </ul>
    <div className="flex items-center justify-between">
      <Button variant="outline" size="sm" disabled={busy || page <= 1} onClick={() => goPage(page - 1)} data-testid="button-prev-page"><ChevronLeft className="w-4 h-4" />Previous</Button>
      <span className="text-xs text-muted-foreground">{page} / {pages}</span>
      <Button variant="outline" size="sm" disabled={busy || page >= pages} onClick={() => goPage(page + 1)} data-testid="button-next-page">Next<ChevronRight className="w-4 h-4" /></Button>
    </div>
  </div>;
}
