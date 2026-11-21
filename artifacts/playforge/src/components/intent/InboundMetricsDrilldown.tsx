import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  IntentInboundDashboardFilters,
  useIntentInboundAccounts,
  useIntentInboundContacts,
} from "@/hooks/use-intent";

export type InboundMetric = "accounts" | "hot" | "warm" | "cold" | "contacts";

const titles: Record<InboundMetric, string> = {
  accounts: "All accounts",
  hot: "Hot accounts",
  warm: "Warm accounts",
  cold: "Cold accounts",
  contacts: "All contacts",
};

export function InboundMetricsDrilldown({
  metric, filters, onClose, onOpenAccount,
}: {
  metric: InboundMetric | null;
  filters: IntentInboundDashboardFilters;
  onClose: () => void;
  onOpenAccount: (accountId: number) => void;
}) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [metric, filters.sourceId, filters.dateRange, filters.formType, filters.category, filters.product]);
  const pageSize = 20;
  const showingContacts = metric === "contacts";
  const accounts = useIntentInboundAccounts({
    ...filters, page, pageSize,
    classification: metric === "hot" || metric === "warm" || metric === "cold" ? metric : undefined,
  }, metric !== null && !showingContacts);
  const contacts = useIntentInboundContacts({ ...filters, page, pageSize }, showingContacts);
  const query = showingContacts ? contacts : accounts;
  const total = showingContacts ? contacts.data?.total : accounts.data?.total;
  const totalPages = showingContacts ? contacts.data?.totalPages : accounts.data?.totalPages;

  return <Dialog open={metric !== null} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
      <DialogHeader className="border-b border-slate-100 p-6 pb-4">
        <DialogTitle>{metric ? titles[metric] : "Dashboard details"}</DialogTitle>
        <DialogDescription>
          {showingContacts
            ? "Individual contacts behind this total, counted once each."
            : "Accounts behind this total. Manually added accounts have no form responses or intent rating yet."}
          {" "}The dashboard filters still apply.
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {query.isLoading ? <p className="py-8 text-center text-sm text-slate-500">Loading records…</p>
          : query.isError ? <p role="alert" className="py-8 text-center text-sm text-rose-700">Could not load these records. Please try again.</p>
          : showingContacts ? contacts.data?.contacts.length ? (
            <div className="divide-y divide-slate-100">
              {contacts.data.contacts.map(contact => <div key={contact.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">{contact.name}</p>
                  <p className="text-xs text-slate-500">
                    {contact.title ? `${contact.title} · ` : ""}{contact.email || contact.phone || "No contact details"}
                  </p>
                  <p className="text-xs text-slate-500">{contact.accountName}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => onOpenAccount(contact.accountId)}>
                  View account
                </Button>
              </div>)}
            </div>
          ) : <p className="py-8 text-center text-sm text-slate-500">No contacts match these filters.</p>
          : accounts.data?.accounts.length ? (
            <div className="divide-y divide-slate-100">
              {accounts.data.accounts.map(account => <div key={account.account_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">{account.name}</p>
                    <Badge variant="outline" className={account.classification === "hot"
                      ? "border-rose-200 bg-rose-50 text-rose-700"
                      : account.classification==="warm"?"border-amber-200 bg-amber-50 text-amber-700"
                      : account.classification==="cold"?"border-slate-300 bg-slate-100 text-slate-700":"border-slate-200 bg-slate-50 text-slate-600"}>{account.classification??"No inbound intent"}</Badge>
                  </div>
                  <p className="text-xs text-slate-500">
                    {account.response_count} response{account.response_count === 1 ? "" : "s"} · {account.respondents.length} contact{account.respondents.length === 1 ? "" : "s"}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => onOpenAccount(account.account_id)} disabled={account.form_type==="manual"} title={account.form_type==="manual"?"No form responses yet":undefined}>
                  View account
                </Button>
              </div>)}
            </div>
          ) : <p className="py-8 text-center text-sm text-slate-500">No accounts match these filters.</p>}
      </div>
      {!query.isLoading && !query.isError && (total ?? 0) > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-6 py-4">
        <span className="text-xs text-slate-600">
          Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total ?? 0)} of {total}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(current => current - 1)}>Previous</Button>
          <Button variant="outline" size="sm" disabled={page >= (totalPages ?? 1)} onClick={() => setPage(current => current + 1)}>Next</Button>
        </div>
      </div>}
    </DialogContent>
  </Dialog>;
}