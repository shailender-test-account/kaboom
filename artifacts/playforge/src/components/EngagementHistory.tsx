import { useState } from "react";
import { useGetEngagementHistory, getGetEngagementHistoryQueryKey } from "@workspace/api-client-react";
import type { GetEngagementHistoryParams } from "@workspace/api-client-react";
import { useAuthContext } from "@/contexts/AuthContext";
import DemoEngagementHistory from "@/components/demo-engagement/DemoEngagementHistory";
import ManageAccountPanel from "@/components/analytics/hp-bi/ManageAccountPanel";
import { Link } from "wouter";
import SalesFeedbackHistory from "@/components/sales-feedback/SalesFeedbackHistory";
import { canAccess } from "@workspace/api-zod";
import { HotFollowUpWorklist } from "@/components/sales-feedback/HotFollowUpWorklist";

export type EngagementTarget =
  | { companyId: number }
  | { contactId: number }
  | { parentKey: string; clientId: number };

interface HistContact { id: number; companyId: number; name: string; email: string | null; title: string | null; isNew: boolean; score: number; intentScore: number | null; stage: string | null; tags: string[]; status: string;
  journeys?: { id: number; name: string; status: string; addedVia: string }[];
  enrollments?: { id: number; sequenceId: number; sequenceName: string; status: string }[];
  opportunities?: { id: number; title: string; stage: string }[];
}
interface HistItem {
  id: string | number; contactId: number | null; contactName: string | null; occurredAt: string | null; kind: string; source: string | null;
  description: string | null; scoreDelta: number | null; oldScore: number | null; newScore: number | null; stage: string | null;
  journey: string | null; page: string | null; product: string | null; qualification: string | null; dateOrigin: string | null;
  isBot: boolean; tagsAdded: string[] | null; tagsRemoved: string[] | null;
}
interface HistResponse {
  clientId?: number;
  summary: { score: number; status: "Hot" | "Warm" | "Unqualified"; contactsCount: number; hotContacts: number; warmContacts: number; tags: string[] };
  contacts: HistContact[]; items: HistItem[]; total: number; page: number; pageSize: number; hasMore: boolean;
}

const PAGE_SIZE = 50;
const tone = (s: string) => s === "Hot" ? "bg-red-50 text-red-800 border-red-200" : s === "Warm" ? "bg-amber-50 text-amber-800 border-amber-200" : "bg-slate-100 text-slate-600 border-slate-200";
const Flag = ({ s, testid }: { s: string; testid?: string }) => <span data-testid={testid} className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold ${tone(s)}`}>{s}</span>;
const when = (d: string | null) => d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) + " IST" : null;
const label = (s: string | null) => (s ?? "").replace(/_/g, " ");
const isUpload = (o: string | null) => !!o && /upload|import/i.test(o);

export default function EngagementHistory({ target, title = "Qualification and engagement history", allowRouting = false }: { target: EngagementTarget; title?: string; allowRouting?: boolean }) {
  return <EngagementHistoryContent key={JSON.stringify(target)} target={target} title={title} allowRouting={allowRouting} />;
}

function EngagementHistoryContent({ target, title, allowRouting }: { target: EngagementTarget; title: string; allowRouting: boolean }) {
  const [page, setPage] = useState(1);
  const [routingContact, setRoutingContact] = useState<number | null>(null);
  const { user } = useAuthContext();
  const params = { ...target, page, pageSize: PAGE_SIZE } as GetEngagementHistoryParams;
  const q = useGetEngagementHistory(params, {
    query: {
      queryKey: [...getGetEngagementHistoryQueryKey(params), "tenant", user?.tenantId, "user", user?.id, "target", JSON.stringify(target), "page", page],
      staleTime: 0, gcTime: 0, refetchOnMount: "always",
      refetchInterval: 60_000,
    },
  });
  const d = q.data as unknown as HistResponse | undefined;
  const pages = d ? Math.max(1, Math.ceil(d.total / (d.pageSize || PAGE_SIZE))) : 1;
  const multi = !("contactId" in target);
  const selected = d?.contacts.find(c => c.id === routingContact);
  const canRoute = allowRouting && !!user && canAccess(user, "analytics", true)
    && (canAccess(user, "journeys", true) || canAccess(user, "sequences", true) || canAccess(user, "deals", true));

  return (
    <section data-testid="engagement-history" className="space-y-4 text-sm" aria-label={title}>
      <DemoEngagementHistory
        contactId={"contactId" in target ? target.contactId : undefined}
        companyId={"companyId" in target ? target.companyId : undefined}
        contactIds={"parentKey" in target ? d?.contacts.map(c => c.id) : undefined} />
      <h3 className="text-sm font-semibold">{title}</h3>
      <SalesFeedbackHistory target={target} />
      {!!user && canAccess(user, "gtm") && <div className="rounded-lg border p-3"><h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Hot telecaller follow-ups</h4>
        <HotFollowUpWorklist compact canWrite={canAccess(user, "gtm", true)} scope={"companyId" in target ? { accountId: target.companyId } : "contactId" in target ? { contactId: target.contactId } : { parentKey: target.parentKey, clientId: target.clientId }} /></div>}
      {q.isLoading && <div className="space-y-2" data-testid="engagement-history-loading"><div className="h-16 rounded bg-muted animate-pulse" /><div className="h-32 rounded bg-muted animate-pulse" /></div>}
      {q.isError && (
        <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800" data-testid="engagement-history-error">
          Could not load engagement history: {(q.error as Error)?.message ?? "Unknown error"}{" "}
          <button type="button" className="underline font-semibold" onClick={() => q.refetch()} data-testid="button-history-retry">Retry</button>
        </div>
      )}
      {d && (
        <>
          <div className="rounded-lg border bg-card p-3 space-y-2" data-testid="engagement-summary">
            <div className="flex items-center gap-3 flex-wrap">
              <Flag s={d.summary.status} testid="engagement-status" />
              <span className="text-2xl font-bold tabular-nums" data-testid="engagement-score">{d.summary.score}</span>
              <span className="text-xs text-muted-foreground">
                {multi ? "journey engagement points, summed across contacts (not an average, not capped at 100)" : "current stored engagement points (not capped at 100)"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {d.summary.contactsCount} contact{d.summary.contactsCount === 1 ? "" : "s"} · {d.summary.hotContacts} Hot · {d.summary.warmContacts} Warm. History covers all dates, not a fiscal year.
              Intent score is a separate current formula value and is not part of these points.
            </p>
            {d.summary.tags.length > 0 && <div className="flex flex-wrap gap-1">{d.summary.tags.map(t => <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{t}</span>)}</div>}
          </div>

          <div data-testid="engagement-contacts">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Contacts</h4>
            {d.contacts.length === 0 ? <p className="text-xs text-muted-foreground">No contacts in scope.</p> : (
              <div className="overflow-x-auto rounded border">
                <table className="w-full text-xs">
                  <thead><tr className="bg-muted/50 text-left text-muted-foreground"><th className="p-2">Contact and routing</th><th className="p-2">Status</th><th className="p-2 text-right">Points</th><th className="p-2 text-right">Intent</th><th className="p-2">Stage</th><th className="p-2">Tags</th></tr></thead>
                  <tbody>{d.contacts.map(c => (
                    <tr key={c.id} className="border-t align-top" data-testid={`history-contact-${c.id}`}>
                      <td className="p-2 min-w-56"><div className="font-medium">{c.name} {c.isNew && <span className="text-[10px] text-teal-700">New</span>}</div><div className="text-muted-foreground">{c.title || "Title unknown"} · {c.email || "No email"}</div>
                        <div className="mt-2 space-y-1">
                          <div><span className="text-muted-foreground">Journeys: </span>{c.journeys?.length ? c.journeys.map(j => <div key={j.id}><Link className="underline" href={`/journeys/${j.id}`}>{j.name}</Link><span className="text-muted-foreground"> · {j.status} · {j.addedVia}</span></div>) : "Not assigned"}</div>
                          <div><span className="text-muted-foreground">Sequences: </span>{c.enrollments?.length ? c.enrollments.map(e => <div key={e.id}><Link className="underline" href={`/sequences/${e.sequenceId}`}>{e.sequenceName}</Link><span className="text-muted-foreground"> · {e.status}</span></div>) : "Not enrolled"}</div>
                          <div><span className="text-muted-foreground">Opportunities: </span>{c.opportunities?.length ? c.opportunities.map(o => <div key={o.id}><Link className="underline" href={`/crm/deals?dealId=${o.id}`}>{o.title}</Link><span className="text-muted-foreground"> · {o.stage}</span></div>) : "Not linked"}</div>
                          {canRoute && <button type="button" className="rounded border bg-white px-2 py-1 font-semibold" disabled={!d.clientId || !c.companyId} data-testid={`route-history-contact-${c.id}`} onClick={() => setRoutingContact(c.id)}>Route / manage</button>}
                        </div>
                      </td>
                      <td className="p-2"><Flag s={c.status} /></td>
                      <td className="p-2 text-right tabular-nums font-semibold">{c.score}</td>
                      <td className="p-2 text-right tabular-nums">{c.intentScore ?? "n/a"}</td>
                      <td className="p-2">{c.stage ? label(c.stage) : "Unknown"}</td>
                      <td className="p-2">{c.tags?.length ? c.tags.join(", ") : "None"}</td>
                    </tr>))}</tbody>
                </table>
              </div>)}
            {canRoute && selected && d.clientId && <div className="mt-3 rounded border bg-muted/20 p-3" data-testid="inline-contact-routing">
              <div className="mb-3 flex items-center justify-between gap-2"><strong>Route {selected.name}</strong><button className="text-xs underline" onClick={() => setRoutingContact(null)}>Close routing</button></div>
              <ManageAccountPanel key={selected.id} clientId={d.clientId} routingOnly d={{ contacts: [selected], members: [] }} />
            </div>}
          </div>

          <div data-testid="engagement-timeline">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">History, newest first ({d.total} recorded source events)</h4>
            {d.items.length === 0 ? (
              <p className="rounded border border-dashed p-4 text-xs text-muted-foreground" data-testid="engagement-empty">No engagement history has been recorded for this {multi ? "scope" : "contact"} yet.</p>
            ) : (
              <ul className="divide-y rounded border bg-card">
                {d.items.map(i => {
                  const intentChange = /intent/i.test(i.kind) || /intent/i.test(i.qualification ?? "");
                  return (
                    <li key={`${i.id}`} className="p-2.5 text-xs space-y-0.5" data-testid={`history-item-${i.id}`}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <strong>{label(i.kind)}</strong>
                        {i.isBot && <span className="rounded border border-slate-400 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700" data-testid={`history-bot-${i.id}`}>Bot, not human engagement</span>}
                        {i.contactName && <span className="text-muted-foreground">{i.contactName}</span>}
                        {i.scoreDelta != null && (intentChange
                          ? <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-800">Intent score change {i.scoreDelta > 0 ? "+" : ""}{i.scoreDelta}</span>
                          : <span className={`rounded px-1.5 py-0.5 ${i.isBot ? "bg-slate-100 text-slate-600" : "bg-emerald-50 text-emerald-800"}`}>{i.isBot ? "Points (bot)" : "Points awarded"} {i.scoreDelta > 0 ? "+" : ""}{i.scoreDelta}</span>)}
                        {i.oldScore != null && i.newScore != null && <span className="tabular-nums text-muted-foreground">{i.oldScore} to {i.newScore}</span>}
                      </div>
                      {i.description && <p>{i.description}</p>}
                      <p className="text-muted-foreground">
                        {i.occurredAt ? when(i.occurredAt) : "Date not recorded"}
                        {isUpload(i.dateOrigin) && <span className="ml-1 rounded bg-amber-50 px-1 text-amber-800">upload date, not the original event time</span>}
                        {i.source ? ` · ${label(i.source)}` : ""}{i.stage ? ` · stage ${label(i.stage)}` : ""}
                      </p>
                      {(i.journey || i.page || i.product || i.qualification) && <p className="text-muted-foreground">{[i.journey && `Journey: ${i.journey}`, i.page && `Page: ${i.page}`, i.product && `Product: ${i.product}`, i.qualification && `Qualification: ${i.qualification}`].filter(Boolean).join(" · ")}</p>}
                      {!!i.tagsAdded?.length && <p className="text-emerald-800">Tags added: {i.tagsAdded.join(", ")}</p>}
                      {!!i.tagsRemoved?.length && <p className="text-red-800">Tags removed: {i.tagsRemoved.join(", ")}</p>}
                    </li>);
                })}
              </ul>)}
            <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted-foreground" data-testid="engagement-pager">
              <span>{d.total === 0 ? "0 events" : `Events ${(d.page - 1) * d.pageSize + 1}-${Math.min(d.total, (d.page - 1) * d.pageSize + d.items.length)} of ${d.total}`}</span>
              <span className="flex items-center gap-2">
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1 || q.isFetching} onClick={() => setPage(1)} data-testid="button-history-first">First</button>
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1 || q.isFetching} onClick={() => setPage(p => p - 1)} data-testid="button-history-prev">Previous</button>
                <span>Page {d.page} of {pages}</span>
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={!d.hasMore || q.isFetching} onClick={() => setPage(p => p + 1)} data-testid="button-history-next">Next</button>
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= pages || q.isFetching} onClick={() => setPage(pages)} data-testid="button-history-last">Last</button>
              </span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
