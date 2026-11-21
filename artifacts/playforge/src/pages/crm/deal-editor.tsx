import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateDeal, useUpdateDeal, useDeleteDeal, useListClients, useGetDealHistory, useGetDealLinkOptions,
  getGetDealHistoryQueryKey, getGetDealQueryKey, getListDealsQueryKey,
  type Deal, type DealLinkChoice,
} from "@workspace/api-client-react";
import { History, Trash2, X, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import OpportunityContacts from "./opportunity-contacts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { invalidateHpBi } from "@/components/analytics/hp-bi/api";
import {
  STAGES, MEANING_LABEL, CLOSED_STAGES, OPPORTUNITY_STAGES, applyStage, buildCreate, buildUpdate, dealErrorMessage,
  emptyForm, formFromDeal, formatAmount, reportingGaps, stageLabel, validateForm, type DealForm,
} from "./deal-utils";

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function useRefreshDeals() {
  const qc = useQueryClient();
  return (id?: number) => Promise.all([
    qc.invalidateQueries({ queryKey: getListDealsQueryKey() }),
    qc.invalidateQueries({ queryKey: ["/api/deals"] }),
    qc.invalidateQueries({ queryKey: ["deals"] }),
    id ? qc.invalidateQueries({ queryKey: getGetDealQueryKey(id) }) : Promise.resolve(),
    id ? qc.invalidateQueries({ queryKey: getGetDealHistoryQueryKey(id) }) : Promise.resolve(),
    invalidateHpBi(qc),
  ]);
}

function LinkPicker({ label, testId, clientId, kind, companyId, selected, onSelect, disabled }: {
  label: string; testId: string; clientId: number; kind: "accounts" | "contacts"; companyId?: number | null;
  selected: DealLinkChoice | null; onSelect: (c: DealLinkChoice | null) => void; disabled?: boolean;
}) {
  const [term, setTerm] = useState("");
  const search = useDebounced(term.trim());
  const params = { clientId, ...(search ? { search } : {}),
    ...(kind === "contacts" && companyId ? { companyId } : kind === "accounts" && selected ? { companyId: selected.id } : {}),
    ...(kind === "contacts" && selected ? { contactId: selected.id } : {}) };
  const q = useGetDealLinkOptions(params, { query: { enabled: clientId > 0 && !disabled, queryKey: ["/api/deals/link-options", kind, params] } });
  const raw = (kind === "accounts" ? q.data?.accounts : q.data?.contacts) ?? [];
  const items = useMemo(() => {
    const list = raw.slice(0, 25);
    return selected && !list.some(i => i.id === selected.id) ? [selected, ...list] : list;
  }, [raw, selected]);
  return (
    <div className="space-y-1.5 min-w-0" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        {selected && (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
            onClick={() => onSelect(null)} data-testid={`${testId}-clear`}><X className="w-3 h-3" />Clear</button>
        )}
      </div>
      <div className="text-xs rounded border bg-muted/40 px-2 py-1 truncate" data-testid={`${testId}-current`}>
        {selected ? selected.name : <span className="text-muted-foreground">Not linked</span>}
      </div>
      <Input value={term} onChange={e => setTerm(e.target.value)} placeholder={`Search ${kind}`} disabled={disabled} data-testid={`${testId}-search`} />
      <div className="max-h-32 overflow-y-auto rounded border divide-y">
        {q.isLoading && <p className="text-xs text-muted-foreground p-2">Searching</p>}
        {q.isError && <p className="text-xs text-red-600 p-2">Could not load {kind}. <button type="button" className="underline" onClick={() => q.refetch()}>Retry</button></p>}
        {!q.isLoading && !q.isError && items.length === 0 && <p className="text-xs text-muted-foreground p-2">{search ? "No matches. Try a shorter search." : "Nothing available."}</p>}
        {items.map(i => (
          <button type="button" key={i.id} onClick={() => onSelect(i)} data-testid={`${testId}-option-${i.id}`}
            className={`w-full text-left text-xs px-2 py-1.5 truncate hover:bg-muted ${selected?.id === i.id ? "bg-indigo-50 font-medium" : ""}`}>{i.name}</button>
        ))}
      </div>
    </div>
  );
}

function HistoryPanel({ dealId }: { dealId: number }) {
  const q = useGetDealHistory(dealId, { query: { queryKey: getGetDealHistoryQueryKey(dealId) } });
  const rows = q.data ?? [];
  const diff = (a: Record<string, unknown> | null, b: Record<string, unknown> | null) => {
    const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(k => !["updatedAt", "createdAt"].includes(k));
    return keys.filter(k => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])).map(k => ({ k, from: a?.[k], to: b?.[k] }));
  };
  const show = (v: unknown) => v == null || v === "" ? "empty" : String(v);
  return (
    <div className="space-y-2" data-testid="deal-history">
      <h3 className="text-sm font-semibold flex items-center gap-1.5"><History className="w-4 h-4" />Audit history</h3>
      {q.isLoading && <p className="text-xs text-muted-foreground">Loading history</p>}
      {q.isError && <p className="text-xs text-red-600">History failed to load. <button type="button" className="underline" onClick={() => q.refetch()}>Retry</button></p>}
      {!q.isLoading && !q.isError && rows.length === 0 && <p className="text-xs text-muted-foreground">No audit entries recorded for this deal yet.</p>}
      <ul className="space-y-2 max-h-56 overflow-y-auto pr-1">
        {rows.map(h => {
          const changes = diff(h.before as Record<string, unknown> | null, h.after as Record<string, unknown> | null);
          return (
            <li key={h.id} className="text-xs border rounded p-2" data-testid={`history-${h.id}`}>
              <div className="flex justify-between gap-2"><span className="font-medium">{h.action}</span>
                <span className="text-muted-foreground">{new Date(h.changedAt).toLocaleString()}{h.actorId != null ? ` / user ${h.actorId}` : ""}</span></div>
              {changes.length > 0 && <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {changes.map(c => <li key={c.k} className="break-words"><span className="font-mono">{c.k}</span>: {show(c.from)} to {show(c.to)}</li>)}</ul>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DealEditor({ deal, open, onClose }: { deal: Deal | null; open: boolean; onClose: () => void }) {
  const isNew = !deal;
  const { toast } = useToast();
  const refresh = useRefreshDeals();
  const [form, setForm] = useState<DealForm>(emptyForm());
  const [original, setOriginal] = useState<DealForm | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [company, setCompany] = useState<DealLinkChoice | null>(null);
  const [contact, setContact] = useState<DealLinkChoice | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const clients = useListClients();
  const create = useCreateDeal();
  const update = useUpdateDeal();
  const del = useDeleteDeal();

  // Initialise once per opened deal, never on background refetches.
  const dealId = deal?.id ?? null;
  useEffect(() => {
    if (!open) return;
    const f = deal ? formFromDeal(deal) : emptyForm();
    setForm(f); setOriginal(deal ? f : null); setErrors([]); setConfirmDelete(false);
    setCompany(deal?.companyId ? { id: deal.companyId, name: `Account #${deal.companyId}` } : null);
    setContact(deal?.contactId ? { id: deal.contactId, name: `Contact #${deal.contactId}` } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dealId]);

  // Resolve display names for existing links from the endpoint (current choice stays retained).
  const clientId = Number(form.clientId) || 0;
  const namesParams = { clientId, ...(form.companyId ? { companyId: form.companyId } : {}), ...(form.contactId ? { contactId: form.contactId } : {}) };
  const names = useGetDealLinkOptions(namesParams, { query: { enabled: open && !isNew && clientId > 0, queryKey: ["/api/deals/link-options", "names", namesParams, dealId] } });
  useEffect(() => {
    const a = names.data?.accounts.find(x => x.id === form.companyId);
    if (a && company && company.id === a.id && company.name !== a.name) setCompany(a);
    const c = names.data?.contacts.find(x => x.id === form.contactId);
    if (c && contact && contact.id === c.id && contact.name !== c.name) setContact(c);
  }, [names.data, form.companyId, form.contactId, company, contact]);

  const set = <K extends keyof DealForm>(k: K, v: DealForm[K]) => setForm(p => ({ ...p, [k]: v }));
  const gaps = reportingGaps(form);
  const stageChanged = !!original && original.stage !== form.stage;
  const outcomeCleared = stageChanged && CLOSED_STAGES.includes(original!.stage) && !form.actualOutcomeDate;
  const busy = create.isPending || update.isPending || del.isPending;
  const canOpp = OPPORTUNITY_STAGES.includes(form.stage);
  const closed = CLOSED_STAGES.includes(form.stage);

  const save = () => {
    const errs = validateForm(form, isNew);
    if (!isNew && original) {
      const body = buildUpdate(form, original);
      if (!errs.length && Object.keys(body).length === 0) { toast({ title: "No changes to save" }); return; }
    }
    setErrors(errs);
    if (errs.length) return;
    const fail = (e: unknown) => { const m = dealErrorMessage(e, "Save failed."); setErrors([m]); toast({ title: "Deal not saved", description: m, variant: "destructive" }); };
    if (isNew) {
      create.mutate({ data: buildCreate(form) }, {
        onSuccess: d => { toast({ title: "Deal created" }); refresh(d.id); onClose(); }, onError: fail });
    } else if (deal && original) {
      update.mutate({ id: deal.id, data: buildUpdate(form, original) }, {
        onSuccess: () => { toast({ title: "Deal saved" }); refresh(deal.id); onClose(); }, onError: fail });
    }
  };

  const remove = () => {
    if (!deal) return;
    del.mutate({ id: deal.id }, {
      onSuccess: () => { toast({ title: "Deal deleted" }); setConfirmDelete(false); refresh(deal.id); onClose(); },
      onError: e => { setConfirmDelete(false); const m = dealErrorMessage(e, "Delete failed."); setErrors([m]); toast({ title: "Deal not deleted", description: m, variant: "destructive" }); },
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={o => !o && !busy && onClose()}>
        <DialogContent className="max-w-2xl w-[calc(100vw-1.5rem)] max-h-[90dvh] overflow-y-auto overflow-x-hidden" data-testid="dialog-deal-editor">
          <DialogHeader>
            <DialogTitle>{isNew ? "New Deal" : `Edit deal #${deal!.id}`}</DialogTitle>
            <DialogDescription>Amounts are never converted or combined across currencies. Leave reporting facts blank when they are not known.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 min-w-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="deal-title">Deal name *</Label>
                <Input id="deal-title" value={form.title} onChange={e => set("title", e.target.value)} data-testid="input-deal-title" /></div>
              <div className="space-y-1.5"><Label>Client {isNew ? "*" : "(fixed)"}</Label>
                {isNew ? (
                  <Select value={form.clientId} onValueChange={v => { setForm(p => ({ ...p, clientId: v, companyId: null, contactId: null })); setCompany(null); setContact(null); }}>
                    <SelectTrigger data-testid="select-deal-client"><SelectValue placeholder="Select client" /></SelectTrigger>
                    <SelectContent>{(clients.data ?? []).map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
                  </Select>
                ) : <div className="text-sm rounded border bg-muted/40 px-3 py-2 truncate" data-testid="text-deal-client">{clients.data?.find(c => c.id === deal!.clientId)?.name ?? `Client #${deal!.clientId}`}</div>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label>Stage</Label>
                  <Select value={form.stage} onValueChange={v => setForm(p => applyStage(p, original, v))}>
                    <SelectTrigger data-testid="select-deal-stage"><SelectValue /></SelectTrigger>
                    <SelectContent>{STAGES.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
                  </Select></div>
                <div className="space-y-1.5"><Label>Priority</Label>
                  <Select value={form.priority} onValueChange={v => set("priority", v)}>
                    <SelectTrigger data-testid="select-deal-priority"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent>
                  </Select></div>
              </div>
            </div>

            {stageChanged && (
              <div className="text-xs rounded border border-amber-300 bg-amber-50 text-amber-900 p-2.5 flex gap-2" data-testid="note-stage-change">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Moving from {stageLabel(original!.stage)} to {stageLabel(form.stage)} is allowed without further facts. Reported results become incomplete until you review the dates below.
                  {outcomeCleared && " The previous outcome date and booked amount are cleared and will not be resent."}
                  {!OPPORTUNITY_STAGES.includes(form.stage) && " Opportunity confirmation and date are cleared for this stage."}</span>
              </div>
            )}

            <fieldset className="rounded-md border p-3 space-y-3">
              <legend className="text-xs font-semibold px-1">Amount</legend>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5"><Label>Value</Label>
                  <Input type="number" min="0" step="any" value={form.value} onChange={e => set("value", e.target.value)} placeholder="Blank = none, 0 is valid" data-testid="input-deal-value" /></div>
                <div className="space-y-1.5"><Label>Currency (3 letters)</Label>
                  <Input maxLength={3} value={form.currency} onChange={e => set("currency", e.target.value.toUpperCase())} placeholder="Not set" data-testid="input-deal-currency" /></div>
                <div className="space-y-1.5"><Label>Value means</Label>
                  <Select value={form.valueMeaning} onValueChange={v => set("valueMeaning", v)}>
                    <SelectTrigger data-testid="select-deal-meaning"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(MEANING_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
                  </Select></div>
              </div>
              {form.stage === "closed_won" && (
                <div className="space-y-1.5 sm:w-1/2"><Label>Booked value (same currency)</Label>
                  <Input type="number" min="0" step="any" value={form.bookedValue} onChange={e => set("bookedValue", e.target.value)} data-testid="input-deal-booked" /></div>
              )}
            </fieldset>

            <fieldset className="rounded-md border p-3 space-y-3">
              <legend className="text-xs font-semibold px-1">Reporting facts</legend>
              <label className={`flex items-start gap-2 text-sm ${canOpp ? "" : "opacity-60"}`}>
                <input type="checkbox" className="mt-1" disabled={!canOpp} checked={form.opportunityConfirmed}
                  onChange={e => set("opportunityConfirmed", e.target.checked)} data-testid="check-opportunity" />
                <span>Confirmed opportunity<span className="block text-xs text-muted-foreground">Needs Proposal, Negotiation, Won or Lost, this confirmation and an actual date. Stage alone does not count.</span></span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5"><Label>Actual opportunity date</Label>
                  <Input type="date" disabled={!canOpp} value={form.actualOpportunityDate} onChange={e => set("actualOpportunityDate", e.target.value)} data-testid="input-opportunity-date" /></div>
                <div className="space-y-1.5"><Label>Actual outcome date</Label>
                  <Input type="date" disabled={!closed} value={form.actualOutcomeDate} onChange={e => set("actualOutcomeDate", e.target.value)} data-testid="input-outcome-date" /></div>
                <div className="space-y-1.5"><Label>Expected close (forecast only)</Label>
                  <Input type="date" value={form.expectedCloseDate} onChange={e => set("expectedCloseDate", e.target.value)} data-testid="input-expected-close" /></div>
              </div>
            </fieldset>

            {clientId > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <LinkPicker label="Account" testId="picker-account" clientId={clientId} kind="accounts" selected={company}
                  onSelect={c => { setCompany(c); setContact(null); setForm(p => ({ ...p, companyId: c?.id ?? null, contactId: null })); }} />
                <LinkPicker label="Contact" testId="picker-contact" clientId={clientId} kind="contacts" companyId={form.companyId} selected={contact}
                  onSelect={c => { setContact(c); set("contactId", c?.id ?? null); }} />
              </div>
            ) : <p className="text-xs text-muted-foreground">Choose a client to link an account and contact.</p>}
            {form.companyId && <p className="text-[11px] text-muted-foreground">Changing the account clears the contact because it may belong to another account.</p>}

            <div className="space-y-1.5"><Label>Notes</Label>
              <Textarea rows={3} value={form.notes} onChange={e => set("notes", e.target.value)} data-testid="input-deal-notes" /></div>

            {gaps.length > 0 && (
              <ul className="text-xs rounded border border-slate-200 bg-slate-50 p-2.5 space-y-1 list-disc pl-5 text-slate-700" data-testid="list-reporting-gaps">
                <li className="list-none -ml-3 font-semibold">Not yet counted in HP reporting</li>
                {gaps.map(g => <li key={g}>{g}</li>)}
              </ul>
            )}
            {deal && <p className="text-xs text-muted-foreground">Saved amount: {formatAmount(deal.value, deal.currency)}</p>}
            {errors.length > 0 && (
              <ul className="text-xs rounded border border-red-300 bg-red-50 text-red-800 p-2.5 space-y-1" role="alert" data-testid="list-deal-errors">
                {errors.map(e => <li key={e}>{e}</li>)}</ul>
            )}
            {deal && <HistoryPanel dealId={deal.id} />}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            {deal ? (
              <Button variant="outline" className="text-red-600 border-red-200 hover:bg-red-50" onClick={() => setConfirmDelete(true)} disabled={busy} data-testid="button-delete-deal">
                <Trash2 className="w-4 h-4 mr-1.5" />Delete</Button>
            ) : <span />}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={onClose} disabled={busy} data-testid="button-cancel-deal">Cancel</Button>
              <Button className="bg-indigo-600 hover:bg-indigo-700" onClick={save} disabled={busy} data-testid="button-save-deal">
                {busy ? "Saving" : isNew ? "Create Deal" : "Save changes"}</Button>
            </div>
          </DialogFooter>
          {deal && <OpportunityContacts dealId={deal.id} />}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent data-testid="dialog-delete-deal">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this deal?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p><strong>{deal?.title}</strong> ({deal ? stageLabel(deal.stage) : ""}, {deal ? formatAmount(deal.value, deal.currency) : ""}) will be removed from the pipeline.</p>
                <p>Any HP opportunity or outcome records, evidence and monthly, quarterly and account totals built from this deal are recalculated without it. This cannot be undone.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>Keep deal</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={e => { e.preventDefault(); remove(); }} disabled={del.isPending} data-testid="button-confirm-delete-deal">
              {del.isPending ? "Deleting" : "Delete deal"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
