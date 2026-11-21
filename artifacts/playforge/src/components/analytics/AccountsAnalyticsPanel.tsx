import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Building2, ChevronDown, ChevronRight, Download, Search, Users, X } from "lucide-react";
import { AcquisitionDetails, SourceIcons, SourceLegend, useAcquisition } from "@/components/analytics/AcquisitionProvenance";
import { ContactTimelinePanel } from "@/components/analytics/ContactTimelinePanel";
import { GtmStatusBadge, type GtmStatus } from "@/components/analytics/GtmStatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { exportAccountsExcel, exportAccountsPdf } from "@/lib/analyticsExportDeferred";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { formatReportDateTime } from "@/lib/reportTime";

type AccountSummary = {
  id: number; name: string; clientName: string | null; contactCount: number;
  activityScore: number; intentScore: number | null; gtmStatus: GtmStatus | null;
  lastActivity: string | null; journeyCount: number; eventCount: number;
  journeyName: string | null; keyContactName: string | null;
};
type AccountActivity = {
  id: string; sourceType: "activity_event" | "journey_event"; sourceId: number;
  eventType: string; description: string | null; createdAt: string;
  contactId: number | null; contactName: string | null; scoreDelta: number;
  journeyName: string | null; pageName: string | null; stage: string | null;
};
type Page<T> = { items: T[]; page: number; hasMore: boolean };
type AccountPage = Page<AccountSummary> & { total: number };
type AccountDetail = {
  account: AccountSummary;
  contacts: { id: number; name: string; leadScore: number; stage: string | null; lastActivity: string | null;
    leadForm: boolean; eventFeedback: boolean; journey: boolean; gtmStatus: GtmStatus | null }[];
  journeys: { id: number; name: string; views: number; lastActivity: string | null }[];
  contactCount: number;
};

async function accountGet<T>(path: string): Promise<T> {
  const response = await fetch(`/api/analytics/accounts${path}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}
const date = (value: string | null) => value ? formatReportDateTime(value) : "Not recorded";
const score = (value: number | null | undefined) => value == null ? "Not recorded" : Number(value).toLocaleString("en-GB", { maximumFractionDigits: 1 });

function RequestError({ label, retry }: { label: string; retry: () => void }) {
  return <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-800">
    <p>{label} could not be loaded. Try again.</p>
    <Button variant="outline" size="sm" className="mt-3" onClick={retry} data-testid={`button-retry-${label.toLowerCase().replace(/\s+/g, "-")}`}>Retry</Button>
  </div>;
}

function Pagination({ page, hasMore, onChange, label, total, pageSize }: { page: number; hasMore: boolean; onChange: (page: number) => void; label: string; total?: number; pageSize?: number }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
    <span data-testid={`text-${label}-page`}>{label} · Page {page}{total !== undefined && pageSize !== undefined
      ? ` of ${Math.max(1, Math.ceil(total / pageSize))} · Showing ${total ? (page - 1) * pageSize + 1 : 0}–${Math.min(page * pageSize, total)} of ${total.toLocaleString()} accounts`
      : ""}</span>
    <div className="flex shrink-0 gap-2">
      <Button size="sm" variant="outline" disabled={page === 1} onClick={() => onChange(page - 1)} data-testid={`button-${label}-previous`}>Previous</Button>
      <Button size="sm" variant="outline" disabled={!hasMore} onClick={() => onChange(page + 1)} data-testid={`button-${label}-next`}>Next <ArrowRight className="ml-1 h-3 w-3" /></Button>
    </div>
  </div>;
}

export function AccountSheet({ accountId, filters, onClose }: {
  accountId: number | null;
  filters: Record<string, string>;
  onClose: () => void;
}) {
  const [activityPage, setActivityPage] = useState(1);
  const [contact, setContact] = useState<{ id: number; name: string } | null>(null);
  const detail = useQuery({
    queryKey: ["analytics", "accounts", "detail", accountId, filters],
    queryFn: () => {
      const params = new URLSearchParams(filters);
      const query = params.toString();
      return accountGet<AccountDetail>(`/${accountId}${query ? `?${query}` : ""}`);
    },
    enabled: accountId !== null,
  });
  const activity = useQuery({
    queryKey: ["analytics", "accounts", "activity", accountId, filters, activityPage],
    queryFn: () => {
      const params = new URLSearchParams({ ...filters, page: String(activityPage), limit: "20" });
      return accountGet<Page<AccountActivity>>(`/${accountId}/activity?${params}`);
    },
    enabled: accountId !== null,
  });
  const acquisition = useAcquisition([], [accountId], accountId !== null);
  const account = detail.data?.account;
  return <Sheet open={accountId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent side="right" className="w-full sm:max-w-[640px] p-0 flex flex-col overflow-hidden">
      <SheetHeader className="border-b px-5 py-4 flex-row items-center gap-3 space-y-0 shrink-0">
        {contact && <button type="button" onClick={() => setContact(null)} className="rounded p-1 hover:bg-muted" aria-label="Back to account" data-testid="button-back-to-account"><ArrowLeft className="h-4 w-4" /></button>}
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate text-base">{contact ? contact.name : account?.name ?? "Account details"}</SheetTitle>
          <p className="text-[11px] text-muted-foreground mt-0.5">{contact ? "Contact journey and activity" : "Account journey and activity · Report times GMT+05:30"}</p>
        </div>
      </SheetHeader>
      <div className="flex-1 overflow-y-auto min-h-0">
        {contact ? <ContactTimelinePanel contactId={contact.id} /> : <div className="p-4 sm:p-5 space-y-5">
          {detail.isPending ? <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full" />)}</div>
            : detail.isError ? <RequestError label="Account details" retry={() => void detail.refetch()} /> : account && <>
              <div className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">{account.clientName ?? "No client assigned"}</p>
                  <GtmStatusBadge status={account.gtmStatus ?? undefined} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
                  <div><p className="text-[11px] text-muted-foreground">Account activity score</p><p className="text-xl font-semibold tabular-nums" data-testid="text-account-activity-score">{score(account.activityScore)} <span className="text-xs font-normal text-muted-foreground">pts</span></p></div>
                  <div><p className="text-[11px] text-muted-foreground">Account intent score</p><p className="text-xl font-semibold tabular-nums" data-testid="text-account-intent-score">{score(account.intentScore)}</p></div>
                  <div><p className="text-[11px] text-muted-foreground">Contacts</p><p className="text-xl font-semibold tabular-nums">{detail.data.contactCount}</p></div>
                  <div><p className="text-[11px] text-muted-foreground">Recorded events</p><p className="text-xl font-semibold tabular-nums">{account.eventCount.toLocaleString()}</p></div>
                </div>
                <p className="mt-4 border-t pt-3 text-[11px] text-muted-foreground">Last activity: {date(account.lastActivity)} · {account.journeyCount} {account.journeyCount === 1 ? "journey" : "journeys"}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">Intent score and GTM OS qualification are recorded account values; event activity below follows the selected Traffic filters.</p>
              </div>

              {acquisition.isPending ? <Skeleton className="h-24" /> : acquisition.isError
                ? <RequestError label="Acquisition history" retry={() => void acquisition.refetch()} />
                : <AcquisitionDetails data={acquisition.data?.accounts[String(accountId)]} title="Account record and form history" />}
              {!acquisition.isPending && !acquisition.isError && !acquisition.data?.accounts[String(accountId)] &&
                <p className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">No acquisition source recorded for this account.</p>}

              <section>
                <h3 className="text-sm font-semibold mb-2">Journeys <span className="font-normal text-muted-foreground">({detail.data.journeys.length})</span></h3>
                {detail.data.journeys.length ? <div className="rounded-lg border bg-card divide-y">
                  {detail.data.journeys.map(journey => <div key={journey.id} className="flex items-start justify-between gap-4 px-4 py-3">
                    <div className="min-w-0"><p className="text-sm font-medium truncate">{journey.name}</p><p className="text-[11px] text-muted-foreground mt-1">Last viewed {date(journey.lastActivity)}</p></div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{journey.views.toLocaleString()} views</span>
                  </div>)}
                </div> : <p className="rounded-lg border bg-card p-4 text-xs text-muted-foreground">No journey views recorded.</p>}
              </section>

              <section>
                <h3 className="text-sm font-semibold mb-2">Contacts <span className="font-normal text-muted-foreground">({detail.data.contactCount})</span></h3>
                <p className="text-[11px] text-muted-foreground mb-2">People found in both GTM OS forms and journeys appear first. Source labels show recorded activity, even when the journey score is 0.</p>
                {detail.data.contactCount > detail.data.contacts.length && <p className="text-[11px] text-muted-foreground mb-2">Showing {detail.data.contacts.length} contacts, with cross-source contacts first, then by activity score.</p>}
                {detail.data.contacts.length ? <div className="rounded-lg border bg-card divide-y">
                  {detail.data.contacts.map(person => {
                    const sourceCount = Number(person.leadForm) + Number(person.eventFeedback) + Number(person.journey);
                    const overlapsJourney = person.journey && (person.leadForm || person.eventFeedback);
                    return <button key={person.id} type="button" onClick={() => setContact({ id: person.id, name: person.name })} className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors ${overlapsJourney ? "bg-sky-50 border-l-4 border-l-sky-500 hover:bg-sky-100/80" : "hover:bg-indigo-50/60"}`} data-testid={`button-account-contact-${person.id}`}>
                      <span className="flex-1 min-w-0">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-indigo-700">
                          {person.name}
                          {overlapsJourney && <span className="rounded-full bg-sky-700 px-2 py-0.5 text-[10px] font-semibold text-white" title="Linked GTM OS form response and journey page view">{sourceCount} sources · GTM OS + Journey</span>}
                          {person.gtmStatus && <GtmStatusBadge status={person.gtmStatus} scope="contact" />}
                        </span>
                        <span className="flex flex-wrap gap-1.5 mt-1.5">
                          {person.leadForm && <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">Lead form</span>}
                          {person.eventFeedback && <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">Event feedback</span>}
                          {person.journey && <span className="rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-800">Journey</span>}
                        </span>
                        <span className="block text-[11px] text-muted-foreground mt-1">{person.stage ? `Journey stage: ${person.stage.replace(/-/g, " ")}` : "Stage not recorded"} · Last active {date(person.lastActivity)}</span>
                      </span>
                    <span className="text-right shrink-0"><span className="block text-xs font-semibold tabular-nums">{score(person.leadScore)} pts</span><span className="block text-[10px] text-muted-foreground">Contact activity</span></span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </button>;
                  })}
                </div> : <p className="rounded-lg border bg-card p-4 text-xs text-muted-foreground">No linked contacts recorded.</p>}
              </section>
            </>}

          <section>
            <h3 className="text-sm font-semibold mb-2">All activity <span className="font-normal text-muted-foreground">· newest first</span></h3>
            <div className="rounded-lg border bg-card overflow-hidden">
              {activity.isPending ? <div className="p-4 space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-14" />)}</div>
                : activity.isError ? <div className="p-4"><RequestError label="Account activity" retry={() => void activity.refetch()} /></div>
                : activity.data?.items.length ? <div className="divide-y">
                  {activity.data.items.map(event => <div key={event.id} className="px-4 py-3 flex gap-3">
                    <div className="mt-1 h-2 w-2 rounded-full bg-indigo-500 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5"><p className="text-xs font-semibold">{event.eventType.replace(/[_-]/g, " ")}</p><time className="text-[11px] text-muted-foreground">{date(event.createdAt)}</time></div>
                      {event.description && <p className="text-xs mt-1">{event.description}</p>}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[11px] text-muted-foreground">
                        {event.contactId && <button type="button" className="text-indigo-700 hover:underline font-medium" onClick={() => setContact({ id: event.contactId!, name: event.contactName ?? "Contact" })} data-testid={`button-activity-contact-${event.id}`}>{event.contactName ?? `Contact #${event.contactId}`}</button>}
                        {event.journeyName && <span>Journey: {event.journeyName}</span>}
                        {event.pageName && <span>Page: {event.pageName}</span>}
                        {event.stage && <span>Stage: {event.stage.replace(/-/g, " ")}</span>}
                        <span className="font-medium">Score change {event.scoreDelta > 0 ? "+" : ""}{score(event.scoreDelta)} pts</span>
                      </div>
                    </div>
                  </div>)}
                </div> : <p className="p-5 text-xs text-muted-foreground">No activity recorded for this account.</p>}
              {activity.data && (activityPage > 1 || activity.data.hasMore) && <Pagination label="Activity" page={activityPage} hasMore={activity.data.hasMore} onChange={setActivityPage} />}
            </div>
          </section>
        </div>}
      </div>
    </SheetContent>
  </Sheet>;
}

export function AccountsAnalyticsPanel({ filters }: { filters: Record<string, string> }) {
  const pageSize = 20;
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const scopedFilters = status === "all" ? filters : { ...filters, status };
  const filterKey = JSON.stringify(scopedFilters);
  const [pageState, setPageState] = useState({ filterKey, page: 1 });
  const [selection, setSelection] = useState<{ filterKey: string; id: number } | null>(null);
  const page = pageState.filterKey === filterKey ? pageState.page : 1;
  const selectedId = selection?.filterKey === filterKey ? selection.id : null;
  const setPage = (nextPage: number) => setPageState({ filterKey, page: nextPage });
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(input.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [input]);
  const accounts = useQuery({
    queryKey: ["analytics", "accounts", "list", scopedFilters, search, page],
    queryFn: () => {
      const params = new URLSearchParams({ ...scopedFilters, page: String(page), limit: String(pageSize) });
      if (search) params.set("q", search);
      return accountGet<AccountPage>(`?${params}`);
    },
    placeholderData: undefined,
  });
  const accountIds = accounts.data?.items.map(item => item.id) ?? [];
  const acquisition = useAcquisition([], accountIds);
  const download = async (format: "excel" | "pdf") => {
    if (exporting) return;
    setExporting(true);
    setExportError(false);
    try {
      const rows: AccountSummary[] = [];
      for (let exportPage = 1; ; exportPage++) {
        const params = new URLSearchParams({ ...scopedFilters, page: String(exportPage), limit: "50" });
        if (search) params.set("q", search);
        const result = await accountGet<AccountPage>(`?${params}`);
        rows.push(...result.items);
        if (!result.hasMore) break;
      }
      const applied = { ...scopedFilters, ...(search ? { search } : {}) };
      if (format === "excel") exportAccountsExcel(rows, applied);
      else exportAccountsPdf(rows, applied);
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  };
  return <div className="space-y-4">
    <div className="rounded-lg bg-zinc-900 text-white px-5 py-4 sm:px-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div><h2 className="text-base font-bold tracking-wide">ACCOUNTS — Journey intelligence</h2><p className="text-xs text-zinc-400 mt-1">Event activity and account selection follow the Traffic filters. Intent scores and GTM OS qualification remain recorded account values.</p></div>
      <span className="text-[11px] text-zinc-400 shrink-0">Report times · GMT+05:30</span>
    </div>
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="p-4 border-b flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div><h3 className="text-sm font-semibold">Account directory</h3><p className="text-[11px] text-muted-foreground mt-0.5">Event counts follow the selected filters; intent score and GTM OS qualification are recorded account values.</p></div>
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={status} onValueChange={value => { setStatus(value); setExportError(false); }}>
            <SelectTrigger className="h-9 w-[165px] text-xs" aria-label="Choose Status" data-testid="select-account-status"><SelectValue placeholder="Choose Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Choose Status · All</SelectItem>
              <SelectItem value="hot">Hot</SelectItem>
              <SelectItem value="warm">Warm</SelectItem>
              <SelectItem value="cold">Cold</SelectItem>
              <SelectItem value="uncategorized">Not categorized</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative w-full sm:w-56 shrink-0"><Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input value={input} onChange={e => { setInput(e.target.value); setPage(1); }} placeholder="Search accounts" aria-label="Search accounts" className="pl-9 pr-8 h-9" data-testid="input-search-accounts" />{input && <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground" onClick={() => { setInput(""); setSearch(""); setPage(1); }} aria-label="Clear search" data-testid="button-clear-account-search"><X className="h-3.5 w-3.5" /></button>}</div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="outline" disabled={exporting || accounts.isPending || accounts.isError} className="h-9 text-xs gap-1"><Download className="h-3.5 w-3.5" />{exporting ? "Exporting…" : "Export"}<ChevronDown className="h-3 w-3" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void download("excel")}>Excel (.xlsx)</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void download("pdf")}>PDF Report</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {exportError && <p role="alert" className="px-4 py-2 text-xs text-rose-700 border-b">Export failed. Please try again.</p>}
      <div className="px-4 py-2 border-b"><SourceLegend /></div>
      {accounts.data && <Pagination label="Accounts" page={page} hasMore={accounts.data.hasMore} onChange={setPage} total={accounts.data.total} pageSize={pageSize} />}
      {accounts.isPending ? <div className="p-4 space-y-3">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-20" />)}</div>
        : accounts.isError ? <div className="p-4"><RequestError label="Accounts" retry={() => void accounts.refetch()} /></div>
        : !accounts.data?.items.length ? <div className="px-5 py-14 text-center"><Building2 className="mx-auto h-9 w-9 text-muted-foreground/50" /><h3 className="mt-3 text-sm font-semibold">No accounts found</h3><p className="text-xs text-muted-foreground mt-1">{search ? "Try a different name or clear the search." : "There are no accounts for this client yet."}</p>{search && <Button variant="outline" size="sm" className="mt-4" onClick={() => { setInput(""); setSearch(""); setPage(1); }} data-testid="button-reset-account-search">Clear search</Button>}</div>
         : <div className="divide-y">{accounts.data.items.map(account => <button key={account.id} type="button" onClick={() => setSelection({ filterKey, id: account.id })} className="w-full text-left px-4 py-4 hover:bg-indigo-50/60 transition-colors flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-5" data-testid={`button-open-account-${account.id}`}>
          <div className="min-w-0 lg:flex-1 flex gap-3">
            <div className="h-9 w-9 bg-indigo-50 text-indigo-700 rounded-lg flex items-center justify-center shrink-0"><Building2 className="h-4 w-4" /></div>
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-sm text-indigo-700" data-testid={`text-account-name-${account.id}`}>{account.name}</span>{acquisition.isPending ? <Skeleton className="h-4 w-10" /> : acquisition.isError ? <span className="text-[10px] text-muted-foreground">Source unavailable</span> : acquisition.data?.accounts[String(account.id)] ? <SourceIcons data={acquisition.data.accounts[String(account.id)]} /> : <span className="text-[10px] text-muted-foreground">Source not recorded</span>}</div>
              <p className="text-[11px] text-muted-foreground mt-1">{account.clientName ?? "No client assigned"} · Last active {date(account.lastActivity)}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:flex lg:items-center gap-3 sm:gap-5 lg:shrink-0">
            <div className="min-w-0 lg:max-w-36"><span className="block text-[10px] text-muted-foreground" title="Most recently active journey, or latest inbound route when no activity is recorded">Journey</span><span className="block text-xs font-medium truncate" title={account.journeyName ?? undefined}>{account.journeyName ?? "Not recorded"}</span></div>
            <div className="min-w-0 lg:max-w-32"><span className="block text-[10px] text-muted-foreground" title="Latest inbound respondent, otherwise the highest-scoring linked contact">Key contact</span><span className="block text-xs font-medium truncate" title={account.keyContactName ?? undefined}>{account.keyContactName ?? "Not recorded"}</span></div>
            <div><span className="block text-[10px] text-muted-foreground">Activity score</span><span className="text-xs font-semibold tabular-nums">{score(account.activityScore)} pts</span></div>
            <div><span className="block text-[10px] text-muted-foreground">Intent score</span><span className="text-xs font-semibold tabular-nums">{score(account.intentScore)}</span></div>
            <div><span className="block text-[10px] text-muted-foreground">Journeys</span><span className="text-xs font-semibold tabular-nums">{account.journeyCount}</span></div>
            <div><span className="block text-[10px] text-muted-foreground">People / events</span><span className="text-xs font-semibold tabular-nums inline-flex items-center gap-1"><Users className="h-3 w-3" />{account.contactCount} / {account.eventCount}</span></div>
            <div><span className="block text-[10px] text-muted-foreground mb-1">Qualification</span><GtmStatusBadge status={account.gtmStatus ?? undefined} /></div>
          </div>
          <ChevronRight className="hidden lg:block h-4 w-4 text-muted-foreground shrink-0" />
        </button>)}</div>}
      {accounts.data && (page > 1 || accounts.data.hasMore) && <Pagination label="Accounts" page={page} hasMore={accounts.data.hasMore} onChange={setPage} total={accounts.data.total} pageSize={pageSize} />}
    </div>
    <AccountSheet key={`${filterKey}:${selectedId ?? "none"}`} accountId={selectedId} filters={scopedFilters} onClose={() => setSelection(null)} />
  </div>;
}