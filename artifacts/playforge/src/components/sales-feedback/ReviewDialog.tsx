import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useFeedbackOptions, useReviewFeedback, type FeedbackEntry, type ReviewBody } from "@/hooks/use-sales-feedback";
import { fmtDate } from "./FeedbackEntryCard";

export const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
/** Qualification needs an explicit, non-future interaction date; the import date is never substituted. */
export function dateProblem(local: string, now = Date.now()): string | null {
  if (!local) return "Enter the verified call or visit date. The import date is not used.";
  const t = new Date(local).getTime();
  if (Number.isNaN(t)) return "Interaction date is not valid.";
  if (t > now) return "Interaction date cannot be in the future.";
  return null;
}

const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";

export function ReviewDialog({ entry, onClose }: { entry: FeedbackEntry | null; onClose: () => void }) {
  return <Dialog open={!!entry} onOpenChange={o => { if (!o) onClose(); }}>
    {entry && <ReviewForm key={entry.id} entry={entry} onClose={onClose} />}
  </Dialog>;
}

function ReviewForm({ entry: e, onClose }: { entry: FeedbackEntry; onClose: () => void }) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const opts = useFeedbackOptions(e.clientId, search || undefined);
  const review = useReviewFeedback();
  const [accountId, setAccountId] = useState(e.accountId ? String(e.accountId) : "");
  const [contactId, setContactId] = useState(e.contactId ? String(e.contactId) : "");
  const [note, setNote] = useState("");
  const [apply, setApply] = useState(false);
  const [product, setProduct] = useState(e.product ?? "");
  const [timing, setTiming] = useState(e.timingMonths != null ? String(e.timingMonths) : "");
  const [occurred, setOccurred] = useState(toLocalInput(e.occurredAt));
  const [confirm, setConfirm] = useState<null | "approve" | "reject">(null);

  const accounts = (opts.data?.accounts ?? []).filter(a => a.clientId === e.clientId);
  const contacts = (opts.data?.contacts ?? []).filter(c => c.clientId === e.clientId && (!accountId || c.companyId === Number(accountId)));
  const products = opts.data?.products ?? [];
  const productValid = products.some(p => p.name === product);
  const timingValid = timing !== "" && Number.isInteger(Number(timing)) && Number(timing) >= 0;
  const dateErr = dateProblem(occurred);
  const qualifyBlock = apply && (dateErr ? dateErr : !contactId ? "Applying qualification needs a matched contact." : !productValid ? "Choose an exact configured product." : !timingValid ? "Timing must be a whole number of months, 0 or more." : null);
  const noteMissing = !note.trim();

  const submit = (decision: "approve" | "reject") => {
    const body: ReviewBody = {
      decision, note: note.trim(), applyQualification: decision === "approve" && apply,
      accountId: accountId ? Number(accountId) : undefined, contactId: contactId ? Number(contactId) : undefined,
      occurredAt: occurred && !dateErr ? new Date(occurred).toISOString() : undefined,
      ...(decision === "approve" && apply ? { product, timingMonths: Number(timing) } : {}),
    };
    review.mutate({ id: e.id, body }, {
      onSuccess: () => { toast({ title: decision === "approve" ? (apply ? "Approved and qualification applied" : "Approved as history only") : "Feedback rejected" }); setConfirm(null); onClose(); },
      onError: err => { setConfirm(null); toast({ title: "Review failed", description: err.message, variant: "destructive" }); },
    });
  };

  return (
    <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" data-testid="dialog-review">
      <DialogHeader>
        <DialogTitle>Review feedback from {e.repName || "unknown rep"}</DialogTitle>
        <DialogDescription>{fmtDate(e.occurredAt) ?? "Date not recorded"} · {e.sourceId != null ? `${e.fileName ?? ""} / ${e.sheetName ?? ""} row ${e.rowNumber ?? "?"}` : "Manual entry"}</DialogDescription>
      </DialogHeader>
      <blockquote className="rounded border-l-2 border-amber-500 bg-amber-50/50 p-2.5 text-sm whitespace-pre-wrap">{e.feedback}</blockquote>
      {e.superseded && <p className="rounded border border-violet-300 bg-violet-50 p-2 text-xs text-violet-900" data-testid="text-superseded-block">A changed-file revision replaced this row. Approval is disabled; review the latest revision instead. You can still reject it.</p>}
      {e.reviewStatus !== "pending" && <p className="text-xs text-muted-foreground">Currently {e.reviewStatus}{e.approvedQualification ? " with qualification applied" : ""}. Re-review keeps the prior audit trail.</p>}

      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Identity match (explicit, same client only)</legend>
        {e.accountId == null && e.contactId == null && <p className="text-xs text-red-800">This record is unmatched. Choose an account and contact, or approve as history-only on the source client.</p>}
        <Input placeholder="Search accounts and contacts" value={search} onChange={ev => setSearch(ev.target.value)} data-testid="input-identity-search" />
        {opts.isError && <p className="text-xs text-red-800">Could not load identities. <button className="underline" onClick={() => opts.refetch()}>Retry</button></p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs space-y-1"><span>Account</span>
            <select className={sel} value={accountId} onChange={ev => { setAccountId(ev.target.value); setContactId(""); }} data-testid="select-review-account">
              <option value="">Not matched</option>
              {e.accountId && !accounts.some(a => a.id === e.accountId) && <option value={e.accountId}>{e.accountName ?? `#${e.accountId}`} (current)</option>}
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></label>
          <label className="text-xs space-y-1"><span>Contact</span>
            <select className={sel} value={contactId} onChange={ev => setContactId(ev.target.value)} data-testid="select-review-contact">
              <option value="">Not matched</option>
              {e.contactId && !contacts.some(c => c.id === e.contactId) && <option value={e.contactId}>{e.contactName ?? `#${e.contactId}`} (current)</option>}
              {contacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ""}</option>)}
            </select></label>
        </div>
      </fieldset>

      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Approval effect</legend>
        <label className="flex items-start gap-2 text-sm"><input type="radio" name="effect" checked={!apply} onChange={() => setApply(false)} data-testid="radio-history-only" className="mt-1" />
          <span><strong>History only.</strong> <span className="text-muted-foreground">Shown on the account and contact timeline. No score or qualification change.</span></span></label>
        <label className="flex items-start gap-2 text-sm"><input type="radio" name="effect" checked={apply} onChange={() => setApply(true)} data-testid="radio-apply-qualification" className="mt-1" />
          <span><strong>Apply product and timeline qualification.</strong> <span className="text-muted-foreground">May change HP weighted account qualification and approved journey-only routing. Never sends email or sequences.</span></span></label>
        {apply && <div className="grid gap-2 sm:grid-cols-2 pl-6">
          <label className="text-xs space-y-1"><span>Product (configured, active)</span>
            <select className={sel} value={product} onChange={ev => setProduct(ev.target.value)} data-testid="select-review-product">
              <option value="">Choose product</option>
              {product && !productValid && <option value={product} disabled>{product} (not configured)</option>}
              {products.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select></label>
          <label className="text-xs space-y-1"><span>Buying timeline (months)</span>
            <Input type="number" min={0} step={1} value={timing} onChange={ev => setTiming(ev.target.value)} data-testid="input-review-timing" /></label>
        </div>}
        {qualifyBlock && <p className="text-xs text-amber-800 pl-6" data-testid="text-qualify-block">{qualifyBlock}</p>}
      </fieldset>

      <label className="block text-xs space-y-1"><span>Verified interaction date</span>
        <Input type="datetime-local" value={occurred} max={toLocalInput(new Date().toISOString())} onChange={ev => setOccurred(ev.target.value)} data-testid="input-review-occurred" />
        <span className={dateErr && occurred ? "text-red-700" : "text-muted-foreground"}>{e.occurredAt ? "Confirm against the call log." : "The source row had no call date. Enter it from the tracker; the import date is never used."}{occurred && dateErr ? ` ${dateErr}` : ""}</span></label>

      <label className="block text-xs space-y-1"><span>Review note (required)</span>
        <Textarea value={note} onChange={ev => setNote(ev.target.value)} rows={3} data-testid="input-review-note" placeholder="Why this decision" /></label>

      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="outline" className="border-slate-400" disabled={noteMissing || review.isPending} onClick={() => setConfirm("reject")} data-testid="button-reject">Reject</Button>
        <Button disabled={noteMissing || !!qualifyBlock || !!e.superseded || review.isPending} onClick={() => setConfirm("approve")} data-testid="button-approve">
          {apply ? "Approve and apply" : "Approve history only"}</Button>
      </DialogFooter>

      <AlertDialog open={!!confirm} onOpenChange={o => { if (!o) setConfirm(null); }}>
        <AlertDialogContent data-testid="dialog-confirm-review">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "reject" ? "Reject this feedback?" : apply ? "Apply qualification from this feedback?" : "Approve as history only?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "reject" ? "The record stays in the audit trail and can be re-reviewed later."
                : apply ? `This will qualify the contact for ${product} within ${timing} month${timing === "1" ? "" : "s"}. HP weighted account qualification and journey-only routing may change. No emails or sequences will be sent automatically.`
                : "The feedback appears on the timeline. Scores and qualification do not change."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={review.isPending}>Back</AlertDialogCancel>
            <AlertDialogAction disabled={review.isPending} onClick={ev => { ev.preventDefault(); if (confirm) submit(confirm); }} data-testid="button-confirm-review">
              {review.isPending ? "Saving" : "Confirm"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogContent>
  );
}
