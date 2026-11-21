import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatReportDateTime } from "@/lib/reportTime";
import { GtmStatusBadge, useGtmStatuses } from "@/components/analytics/GtmStatusBadge";

type JourneyEvent = {
  id: string;
  eventType: string;
  description: string | null;
  createdAt: string;
  contactId: number | null;
  contactName: string | null;
  email: string | null;
  classification?: string;
  productInterest?: string | null;
  formName?: string;
  journeyName?: string | null;
  sequenceName?: string | null;
  sentSubject?: string | null;
  pageName?: string | null;
  url?: string | null;
  scoreDelta: number;
  totalScore: number | null;
  tags: string[] | null;
  stage: string | null;
};

export function InboundJourneyPanel({
  clientId, accountId, playId, journeyId, dateFrom, dateTo, onContact,
}: {
  clientId: string; accountId: string; playId: string; journeyId: string;
  dateFrom: string; dateTo: string; onContact: (id: number, name: string) => void;
}) {
  const { data, isLoading, error } = useQuery<{ accountName: string; events: JourneyEvent[]; hasMore: boolean }>({
    queryKey: ["analytics-inbound-journey", clientId, accountId, playId, journeyId, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({ clientId, accountId });
      if (playId) params.set("playId", playId);
      if (journeyId) params.set("journeyId", journeyId);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const response = await fetch(`/api/analytics/inbound-account-journey?${params}`, { credentials: "include" });
      if (!response.ok) throw new Error(`Could not load the account journey (${response.status})`);
      return response.json();
    },
  });
  const { data: gtmStatuses, isLoading: loadingGtmStatuses, error: gtmStatusesError } = useGtmStatuses(
    data?.events.map(event => event.contactId) ?? [],
  );

  return <Card className="shadow-xs">
    <CardHeader className="pb-2">
      <CardTitle className="text-sm">Inbound account journey{data ? ` — ${data.accountName}` : ""}</CardTitle>
      <p className="text-xs text-muted-foreground">
        Form responses and linked contact activity in time order. Forms remain visible when a play or journey is selected.
      </p>
    </CardHeader>
    <CardContent>
      {isLoading ? <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16" />)}</div>
        : error ? <p role="alert" className="text-sm text-red-600">{error.message}</p>
        : !data?.events.length ? <p className="text-sm text-muted-foreground py-6">
          No form submissions or journey activity in this date range.
        </p>
        : <div className="space-y-0 border-l-2 border-indigo-100 ml-2">
          {data.events.slice().reverse().map(event => {
            const inbound = event.eventType === "lead_form" || event.eventType === "event_feedback";
            const emailClick = event.eventType === "email_click";
            return <div key={event.id} className="relative pl-5 py-3 border-b last:border-0">
              <span className={`absolute -left-[6px] top-5 h-2.5 w-2.5 rounded-full ${inbound ? "bg-emerald-500" : "bg-indigo-500"}`} />
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <p className="text-sm font-medium">{event.description || event.eventType.replaceAll("_", " ")}</p>
                <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>
                  {formatReportDateTime(event.createdAt)}
                </time>
              </div>
              <div className="flex gap-x-3 gap-y-1 flex-wrap items-center text-xs text-muted-foreground mt-1">
                {event.contactId ? <>
                  <button className="text-indigo-600 hover:underline"
                    onClick={() => onContact(event.contactId!, event.contactName?.trim() || event.email || "Contact")}>
                    {event.contactName?.trim() || event.email || `Contact #${event.contactId}`}
                  </button>
                  {(event.contactName?.trim() || event.email?.trim()) && <GtmStatusBadge scope="contact" status={gtmStatuses?.[event.contactId]} loading={loadingGtmStatuses} error={!!gtmStatusesError} />}
                </> : event.contactName?.trim() && <span>{event.contactName}</span>}
                {inbound && <span className="capitalize font-medium text-emerald-700">{event.classification}</span>}
                {event.formName && <span>{event.formName}</span>}
                {event.productInterest && <span>Interest: {event.productInterest}</span>}
                {emailClick && <span>Message: {event.sentSubject || "Unknown email"}</span>}
                {emailClick
                  ? <span className="break-all">Destination: {event.url || "Unknown link"}</span>
                  : event.url && <span className="break-all">Destination: {event.url}</span>}
                {event.sequenceName && <span>Email sequence: {event.sequenceName}</span>}
                {event.journeyName && <span>Journey: {event.journeyName}</span>}
                {event.pageName && <span>Page: {event.pageName}</span>}
                {!inbound && <span>Current score {event.totalScore ?? 0}{event.scoreDelta ? ` · event ${event.scoreDelta > 0 ? "+" : ""}${event.scoreDelta}` : ""}</span>}
                {!inbound && event.stage && <span>Stage: {event.stage.replaceAll("-", " ")}</span>}
                {!inbound && (event.tags ?? []).map(tag => <span key={tag} className="rounded bg-indigo-50 px-1.5 py-0.5 text-indigo-700">{tag}</span>)}
              </div>
            </div>;
          })}
          {data.hasMore && <p className="text-xs text-amber-700 pl-5 py-2">Showing the latest 500 events per source. Narrow the date range for earlier activity.</p>}
        </div>}
    </CardContent>
  </Card>;
}
