import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/contexts/AuthContext";
import { BadgeCheck } from "lucide-react";
import { useCreateFeedback, useFeedbackOptions, type CreateFeedbackBody, type FeedbackType, type Temperature } from "@/hooks/use-sales-feedback";

const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";

export interface ManualPrefill { clientId?: number; accountId?: number; contactId?: number }

export function ManualEntryDialog({ open, onOpenChange, defaultClientId, prefill }: { open: boolean; onOpenChange: (o: boolean) => void; defaultClientId?: number; prefill?: ManualPrefill }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>{open && <Form prefill={{ clientId: defaultClientId, ...prefill }} onDone={() => onOpenChange(false)} />}</Dialog>;
}

function Form({ prefill, onDone }: { prefill: ManualPrefill; onDone: () => void }) {
  const defaultClientId = prefill.clientId;
  const { toast } = useToast();
  const { user } = useAuthContext();
  const authorName = user ? [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email : "";
  const [clientId, setClientId] = useState(defaultClientId ? String(defaultClientId) : "");
  const [search, setSearch] = useState("");
  const [accountPage, setAccountPage] = useState(1);
  const [contactPage, setContactPage] = useState(1);
  const [selectedAccount, setSelectedAccount] = useState<{ id: number; name: string; clientId: number }>();
  const opts = useFeedbackOptions(clientId ? Number(clientId) : undefined, search || undefined,
    { accountId: search ? undefined : prefill.accountId, contactId: search ? undefined : prefill.contactId, accountPage });
  const create = useCreateFeedback();
  const [f, setF] = useState({ accountId: prefill.accountId ? String(prefill.accountId) : "", contactId: prefill.contactId ? String(prefill.contactId) : "", type: "telesales" as FeedbackType, occurredAt: "", feedback: "", product: "", timingMonths: "", proposedTemperature: "", nextAction: "" });
  // Fetch contacts independently of account search and its first page.
  const contactOpts = useFeedbackOptions(clientId ? Number(clientId) : undefined, undefined,
    { accountId: f.accountId ? Number(f.accountId) : undefined,
      contactId: f.contactId ? Number(f.contactId) : undefined, contactPage },
    !!clientId && !!f.accountId);
  useEffect(() => {
    const account = opts.data?.accounts.find(a => a.id === Number(f.accountId));
    if (account) setSelectedAccount(account);
  }, [opts.data, f.accountId]);
  // Resolve the client from the scoped account or contact when the target did not carry it.
  const resolved = !!clientId;
  useEffect(() => {
    if (resolved || !opts.data) return;
    const c = prefill.contactId ? opts.data.contacts.find(x => x.id === prefill.contactId) : undefined;
    const a = prefill.accountId ? opts.data.accounts.find(x => x.id === prefill.accountId) : undefined;
    const id = c?.clientId ?? a?.clientId;
    if (id) setClientId(String(id));
    if (c && !prefill.accountId) setF(s => ({ ...s, accountId: String(c.companyId) }));
  }, [resolved, opts.data, prefill.accountId, prefill.contactId]);
  const locked = !!(prefill.accountId || prefill.contactId);
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF(s => ({ ...s, [k]: ev.target.value }));
  const cid = Number(clientId);
  const accountRows = opts.isError ? [] : (opts.data?.accounts ?? []).filter(a => a.clientId === cid);
  const accounts = selectedAccount && selectedAccount.clientId === cid && String(selectedAccount.id) === f.accountId
    && !accountRows.some(a => a.id === selectedAccount.id) ? [selectedAccount, ...accountRows] : accountRows;
  const contacts = contactOpts.isError ? [] : (contactOpts.data?.contacts ?? [])
    .filter(c => c.clientId === cid && c.companyId === Number(f.accountId));
  const timingBad = f.timingMonths !== "" && !(Number.isInteger(Number(f.timingMonths)) && Number(f.timingMonths) >= 0);
  const contactValid = !f.contactId || (!contactOpts.isFetching && !contactOpts.isError && contacts.some(c => c.id === Number(f.contactId)));
  const valid = !!clientId && !!(f.accountId || f.contactId) && !!user && f.feedback.trim() && !timingBad && contactValid && !opts.isError;

  const save = () => {
    const body: CreateFeedbackBody = {
      clientId: cid, type: f.type, feedback: f.feedback.trim(),
      accountId: f.accountId ? Number(f.accountId) : undefined, contactId: f.contactId ? Number(f.contactId) : undefined,
      occurredAt: f.occurredAt ? new Date(f.occurredAt).toISOString() : undefined,
      product: f.product || undefined, timingMonths: f.timingMonths !== "" ? Number(f.timingMonths) : undefined,
      proposedTemperature: (f.proposedTemperature || undefined) as Temperature | undefined, nextAction: f.nextAction.trim() || undefined,
    };
    create.mutate(body, {
      onSuccess: () => { toast({ title: "Feedback logged", description: "It is pending admin review and does not change scores yet." }); onDone(); },
      onError: e => toast({ title: "Could not save feedback", description: e.message, variant: "destructive" }),
    });
  };

  return (
    <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" data-testid="dialog-manual-feedback">
      <DialogHeader>
        <DialogTitle>Log call or visit feedback</DialogTitle>
        <DialogDescription>Manual entries go to the review queue. Nothing is qualified or sent until an admin approves.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs space-y-1"><span>Client *</span>
          <select className={sel} disabled={locked && resolved} value={clientId} onChange={ev => { setClientId(ev.target.value); setSearch(""); setAccountPage(1); setContactPage(1); setSelectedAccount(undefined); setF(s => ({ ...s, accountId: "", contactId: "" })); }} data-testid="select-manual-client">
            <option value="">{locked && !resolved ? (opts.isLoading ? "Resolving from record" : "Could not resolve client") : "Choose client"}</option>
            {clientId && !opts.data?.clients.some(c => c.id === Number(clientId)) && <option value={clientId}>Loading client…</option>}
            {(opts.data?.clients ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <label className="text-xs space-y-1"><span>Feedback type *</span>
          <select className={sel} value={f.type} onChange={set("type")} data-testid="select-manual-type">
            <option value="telesales">Telesales (telecaller)</option><option value="sales_rep">Sales rep</option>
          </select></label>
        <label className="text-xs space-y-1 sm:col-span-2"><span>Find account or contact</span>
          <Input disabled={!clientId} placeholder={clientId ? "Type a company, person or email" : "Choose a client first"} value={search} onChange={ev => { setSearch(ev.target.value); setAccountPage(1); }} data-testid="input-manual-search" />
          <span className="text-muted-foreground">Search by name, or use Next to browse all available accounts.</span></label>
        <div className="text-xs space-y-1"><label htmlFor="manual-account">Account</label>
          <select id="manual-account" className={sel} disabled={!clientId || opts.isFetching || opts.isError} value={f.accountId} onChange={ev => { setSelectedAccount(accounts.find(a => a.id === Number(ev.target.value))); setContactPage(1); setF(s => ({ ...s, accountId: ev.target.value, contactId: "" })); }} data-testid="select-manual-account">
            <option value="">Leave unmatched</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {opts.isFetching ? <p role="status">Loading accounts…</p> : accounts.length === 0 && clientId && !opts.isError && <p>No matching accounts.</p>}
          {clientId && <div className="flex items-center justify-between gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={accountPage === 1 || opts.isFetching} onClick={() => setAccountPage(p => p - 1)} aria-label="Previous accounts">Previous</Button>
            <span>Page {accountPage}</span>
            <Button type="button" size="sm" variant="ghost" disabled={!opts.data?.accountsHasMore || opts.isFetching || opts.isError} onClick={() => setAccountPage(p => p + 1)} aria-label="Next accounts">Next</Button>
          </div>}
        </div>
        <div className="text-xs space-y-1"><label htmlFor="manual-contact">Contact</label>
          <select id="manual-contact" className={sel} disabled={!f.accountId || contactOpts.isFetching || contactOpts.isError} value={f.contactId} onChange={set("contactId")} data-testid="select-manual-contact">
            <option value="">{!f.accountId ? "Choose an account first" : contactOpts.isFetching ? "Loading contacts…" : "Leave unmatched"}</option>{contacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ""}</option>)}
          </select>
          {f.accountId && !contactOpts.isFetching && !contactOpts.isError && !contacts.length && <p>No contacts saved for this account.</p>}
          {contactOpts.isError && f.accountId && <p role="alert">Could not load contacts. <button type="button" className="underline" onClick={() => contactOpts.refetch()}>Retry</button></p>}
          {f.accountId && (contactPage > 1 || contactOpts.data?.contactsHasMore) && <div className="flex items-center justify-between gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={contactPage === 1 || contactOpts.isFetching} onClick={() => { setF(s => ({ ...s, contactId: "" })); setContactPage(p => p - 1); }} aria-label="Previous contacts">Previous</Button>
            <span>Page {contactPage}</span>
            <Button type="button" size="sm" variant="ghost" disabled={!contactOpts.data?.contactsHasMore || contactOpts.isFetching || contactOpts.isError} onClick={() => { setF(s => ({ ...s, contactId: "" })); setContactPage(p => p + 1); }} aria-label="Next contacts">Next</Button>
          </div>}
        </div>
        <div className="text-xs space-y-1"><span id="manual-author-label">Submitted by</span>
          <div aria-labelledby="manual-author-label" className="flex h-9 items-center gap-2 rounded-md border border-dashed bg-muted/50 px-2 text-sm" data-testid="text-manual-author">
            <BadgeCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span className="truncate font-medium">{authorName || "Not signed in"}</span>
            <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">signed-in account</span>
          </div>
          <p className="text-muted-foreground">Recorded from your login with the server time. It cannot be edited.</p></div>
        <label className="text-xs space-y-1"><span>Call or visit date</span><Input type="datetime-local" value={f.occurredAt} onChange={set("occurredAt")} data-testid="input-manual-date" /></label>
        <label className="text-xs space-y-1 sm:col-span-2"><span>What the customer said *</span><Textarea rows={4} value={f.feedback} onChange={set("feedback")} data-testid="input-manual-feedback" /></label>
        <label className="text-xs space-y-1"><span>Product discussed</span>
          <select className={sel} value={f.product} onChange={set("product")} data-testid="select-manual-product">
            <option value="">None</option>{(opts.data?.products ?? []).map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select></label>
        <label className="text-xs space-y-1"><span>Buying timeline (months)</span><Input type="number" min={0} step={1} value={f.timingMonths} onChange={set("timingMonths")} data-testid="input-manual-timing" />
          {timingBad && <span className="text-red-700">Whole number, 0 or more</span>}</label>
        <label className="text-xs space-y-1"><span>Rep's proposed temperature</span>
          <select className={sel} value={f.proposedTemperature} onChange={set("proposedTemperature")} data-testid="select-manual-temperature">
            <option value="">Not proposed</option><option>Hot</option><option>Warm</option><option>Cold</option>
          </select></label>
        <label className="text-xs space-y-1"><span>Next action</span><Input value={f.nextAction} onChange={set("nextAction")} data-testid="input-manual-next" /></label>
      </div>
      {opts.isError && <p className="text-xs text-red-800">Could not load clients and identities. <button className="underline" onClick={() => opts.refetch()}>Retry</button></p>}
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button disabled={!valid || create.isPending} onClick={save} data-testid="button-save-manual">{create.isPending ? "Saving" : "Send to review"}</Button>
      </DialogFooter>
    </DialogContent>
  );
}
