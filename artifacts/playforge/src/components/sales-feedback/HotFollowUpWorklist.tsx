import { useState } from "react";
import { Link } from "wouter";
import { Flame, PhoneCall, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthContext } from "@/contexts/AuthContext";
import { canAccess } from "@workspace/api-zod";
import { useHotFollowUps, useUpdateHotFollowUp, type FollowUpStatus, type HotFollowUp, type HotFollowUpFilters } from "@/hooks/use-hot-follow-ups";

const sel = "h-8 rounded-md border bg-background px-2 text-xs";
const when = (d: string | null) => d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) + " IST" : "Date not recorded";

export function HotFollowUpWorklist({ scope, canWrite, compact = false, onLogFeedback }: { scope: Omit<HotFollowUpFilters, "status" | "page">; canWrite: boolean; compact?: boolean; onLogFeedback?: (i: HotFollowUp) => void }) {
  const [status, setStatus] = useState<FollowUpStatus>("open");
  const [page, setPage] = useState(1);
  const q = useHotFollowUps({ ...scope, status, page });
  const d = q.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / (d.pageSize || 25))) : 1;

  return (
    <section className="space-y-3" data-testid={compact ? "hot-followups-scoped" : "hot-followups"} aria-label="Hot follow-up worklist">
      <div className={cn("rounded border bg-muted/30 px-3 py-2 text-xs text-muted-foreground", compact && "text-[11px]")} data-testid="text-hot-explainer">
        <strong className="text-foreground">Individually Hot only.</strong> A contact lands here because of their own fresh product signal with a 0 to 3 month buying timeline, shown as evidence on each row. Account-level heat inherited from colleagues does not qualify. Blocked or opted-out contacts are excluded and never actionable. This list does not place calls or start campaigns; it records who owns the call and how it ended.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5">
          {(["open", "completed"] as const).map(s => <button key={s} onClick={() => { setStatus(s); setPage(1); }} data-testid={`filter-hot-status-${s}`}
            className={cn("rounded px-2.5 py-1 text-xs font-medium", status === s ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>{s === "open" ? "Open" : "Completed"}</button>)}
        </div>
        {!canWrite && <span className="text-[11px] text-muted-foreground" data-testid="text-hot-readonly">Edit access is required to assign or complete follow-ups.</span>}
        {d && <span className="ml-auto font-mono text-[11px] text-muted-foreground" data-testid="text-hot-total">{d.total} {status}</span>}
      </div>

      {q.isLoading && <div className="space-y-2" data-testid="hot-loading">{[0, 1, 2].slice(0, compact ? 2 : 3).map(i => <div key={i} className="h-24 rounded-md bg-muted animate-pulse" />)}</div>}
      {q.isError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800" data-testid="hot-error">Could not load Hot follow-ups: {q.error.message} <button className="underline font-semibold" onClick={() => q.refetch()} data-testid="button-hot-retry">Retry</button></div>}
      {d && d.items.length === 0 && <div className="rounded-md border border-dashed px-6 py-8 text-center" data-testid="hot-empty">
        <Flame className="mx-auto h-7 w-7 text-red-600/40" />
        <p className="mt-2 text-sm font-medium">{status === "open" ? "No open Hot follow-ups." : "No completed follow-ups yet."}</p>
        <p className="mt-1 text-xs text-muted-foreground">Rows appear when a contact gets individual product evidence with a 0 to 3 month timeline.</p>
      </div>}
      {d && d.items.length > 0 && <div className={cn("space-y-2", q.isFetching && "opacity-60 transition-opacity")}>
        {d.items.map(i => <Row key={i.id} item={i} assignees={d.assignees} canWrite={canWrite} compact={compact} onLogFeedback={onLogFeedback} />)}
      </div>}
      {d && d.total > d.pageSize && <div className="flex items-center justify-between text-xs text-muted-foreground" data-testid="hot-pager">
        <span>Rows {(d.page - 1) * d.pageSize + 1}-{Math.min(d.total, (d.page - 1) * d.pageSize + d.items.length)} of {d.total}</span>
        <span className="flex items-center gap-2">
          <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1 || q.isFetching} onClick={() => setPage(p => p - 1)} data-testid="button-hot-prev">Previous</button>
          <span>Page {d.page} of {pages}</span>
          <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= pages || q.isFetching} onClick={() => setPage(p => p + 1)} data-testid="button-hot-next">Next</button>
        </span>
      </div>}
    </section>
  );
}

function Row({ item: i, assignees, canWrite, compact, onLogFeedback }: { item: HotFollowUp; assignees: { id: number; name: string }[]; canWrite: boolean; compact: boolean; onLogFeedback?: (i: HotFollowUp) => void }) {
  const upd = useUpdateHotFollowUp();
  const { user } = useAuthContext();
  const canJ = !!user && canAccess(user, "journeys");
  const canS = !!user && canAccess(user, "sequences");
  const [completing, setCompleting] = useState(false);
  const [note, setNote] = useState("");
  const open = i.status === "open";
  return (
    <article className="rounded-md border bg-card p-3 text-xs space-y-2" data-testid={`hot-row-${i.id}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex-1 min-w-48">
          <div className="flex items-center gap-2"><span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-800">Hot, individual</span>
            <strong className="text-sm" data-testid={`text-hot-contact-${i.id}`}>{i.contactName ?? `Contact ${i.contactId}`}</strong></div>
          <p className="text-muted-foreground">{i.accountName ?? "No account"} · <PhoneCall className="inline h-3 w-3" /> {i.phone || "No phone"} · {i.email || "No email"}</p>
        </div>
        <div className="text-right text-muted-foreground">
          {open ? <span>Queued {when(i.createdAt)}</span> : <span className="text-emerald-800"><CheckCircle2 className="inline h-3 w-3" /> Completed {when(i.completedAt)}</span>}
        </div>
      </div>
      <div data-testid={`hot-evidence-${i.id}`}>
        <span className="text-muted-foreground">Evidence: </span>
        {i.evidence.length ? i.evidence.map((e, k) => <span key={k} className="mr-1 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-amber-900">{e.product} · {e.months != null ? `${e.months} mo timeline` : "timeline n/a"} · {e.at ? when(e.at) : "undated"}{e.reference ? ` · ${e.reference}` : ""}</span>) : "No evidence recorded"}
      </div>
      {!compact && <div className="text-muted-foreground">
        Journey memberships on record: {i.journeys.length ? i.journeys.map((j, k) => <span key={j.id}>{k > 0 && ", "}{canJ ? <Link className="underline" href={`/journeys/${j.id}`}>{j.name}</Link> : j.name}</span>) : "None"}
        {" · "}Sequences: {i.sequences.length ? i.sequences.map((s, k) => <span key={s.id}>{k > 0 && ", "}{canS ? <Link className="underline" href={`/sequences/${s.id}`}>{s.name}</Link> : s.name} ({s.status})</span>) : "None"}
      </div>}
      {!open && i.completionNote && <p className="rounded bg-muted/50 px-2 py-1" data-testid={`text-hot-note-${i.id}`}>Outcome: {i.completionNote}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Owner:</span>
        {canWrite && open ? <select className={sel} value={i.assigneeId ?? ""} disabled={upd.isPending} data-testid={`select-hot-assignee-${i.id}`}
          onChange={e => upd.mutate({ id: i.id, body: { assigneeId: e.target.value ? Number(e.target.value) : null } })}>
          <option value="">Unassigned</option>{assignees.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select> : <span data-testid={`text-hot-assignee-${i.id}`}>{i.assigneeName ?? "Unassigned"}</span>}
        {canWrite && onLogFeedback && <button className="ml-auto rounded border px-2 py-1" onClick={() => onLogFeedback(i)} data-testid={`button-hot-feedback-${i.id}`}>Log feedback</button>}
        {canWrite && open && !completing && <button className={cn("rounded border px-2 py-1 font-semibold", !onLogFeedback && "ml-auto")} onClick={() => setCompleting(true)} data-testid={`button-hot-complete-${i.id}`}>Complete follow-up</button>}
      </div>
      {completing && <div className="space-y-1.5">
        <textarea className="w-full rounded-md border bg-background p-2 text-xs" rows={2} maxLength={2000} placeholder="Follow-up outcome (required)" value={note} onChange={e => setNote(e.target.value)} data-testid={`input-hot-note-${i.id}`} />
        <div className="flex justify-end gap-2">
          <button className="rounded border px-2 py-1" onClick={() => { setCompleting(false); setNote(""); }} data-testid={`button-hot-cancel-${i.id}`}>Cancel</button>
          <button className="rounded bg-foreground px-2 py-1 font-semibold text-background disabled:opacity-40" disabled={!note.trim() || upd.isPending} data-testid={`button-hot-save-${i.id}`}
            onClick={() => upd.mutate({ id: i.id, body: { complete: true, note: note.trim() } }, { onSuccess: () => { setCompleting(false); setNote(""); } })}>{upd.isPending ? "Saving" : "Complete"}</button>
        </div>
      </div>}
      {upd.isError && <p role="alert" className="text-red-800" data-testid={`text-hot-update-error-${i.id}`}>Update failed: {upd.error.message}</p>}
    </article>
  );
}
