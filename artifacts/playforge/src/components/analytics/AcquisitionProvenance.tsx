import { useQuery } from "@tanstack/react-query";
import { ClipboardList, CalendarDays, Radar, UserRoundPlus, CircleHelp } from "lucide-react";
import { formatReportDateTime } from "@/lib/reportTime";

export type AcquisitionSource = "lead_form" | "event_feedback" | "monitored" | "manual";
export type Acquisition = {
  recordCreatedAt: string | null;
  firstAcquiredAt: string | null;
  sources: AcquisitionSource[];
  leadForms: { id: number; at: string; formName: string | null }[];
  eventFeedback: { id: number; at: string; formName: string | null }[];
};
type AcquisitionResponse = {
  contacts: Record<string, Acquisition>;
  accounts: Record<string, Acquisition>;
};

const sourceConfig = {
  lead_form: { label: "Lead form", Icon: ClipboardList, style: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  event_feedback: { label: "Event feedback", Icon: CalendarDays, style: "text-violet-700 bg-violet-50 border-violet-200" },
  monitored: { label: "Monitored account", Icon: Radar, style: "text-sky-700 bg-sky-50 border-sky-200" },
  manual: { label: "Manually added", Icon: UserRoundPlus, style: "text-slate-600 bg-slate-50 border-slate-200" },
} as const;

const cleanIds = (ids: (number | null | undefined)[]) =>
  [...new Set(ids.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0))].sort((a, b) => a - b);

export function useAcquisition(contactIds: (number | null | undefined)[], accountIds: (number | null | undefined)[], enabled = true) {
  const contacts = cleanIds(contactIds);
  const accounts = cleanIds(accountIds);
  const contactKey = contacts.join(",");
  const accountKey = accounts.join(",");
  return useQuery<AcquisitionResponse>({
    queryKey: ["analytics", "acquisition", contactKey, accountKey],
    queryFn: async () => {
      const requests = Array.from({ length: Math.max(Math.ceil(contacts.length / 200), Math.ceil(accounts.length / 200)) }, (_, index) =>
        fetch("/api/analytics/acquisition", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactIds: contacts.slice(index * 200, (index + 1) * 200), accountIds: accounts.slice(index * 200, (index + 1) * 200) }),
        }).then(async response => {
          if (!response.ok) throw new Error(`Acquisition details unavailable (${response.status})`);
          return response.json() as Promise<AcquisitionResponse>;
        }),
      );
      const pages = await Promise.all(requests);
      return {
        contacts: Object.assign({}, ...pages.map(page => page.contacts)) as AcquisitionResponse["contacts"],
        accounts: Object.assign({}, ...pages.map(page => page.accounts)) as AcquisitionResponse["accounts"],
      };
    },
    enabled: enabled && (contacts.length > 0 || accounts.length > 0),
    staleTime: 60_000,
  });
}

export function SourceIcons({ data }: { data?: Acquisition }) {
  if (!data) return null;
  if (!data.sources.length) return <span title="Source not recorded" aria-label="Source not recorded" className="inline-flex items-center justify-center w-[18px] h-[18px] rounded border border-slate-200 bg-slate-50 text-slate-400 shrink-0"><CircleHelp className="w-2.5 h-2.5" aria-hidden="true" /></span>;
  return <span className="inline-flex items-center gap-0.5 align-middle shrink-0" aria-label={`Acquired via: ${data.sources.map(s => sourceConfig[s]?.label ?? s).join(", ")}`}>
    {data.sources.map(source => {
      const config = sourceConfig[source];
      if (!config) return null;
      return <span key={source} title={config.label} className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded border ${config.style}`}>
        <config.Icon className="w-2.5 h-2.5" aria-hidden="true" />
      </span>;
    })}
  </span>;
}

export function SourceBadges({ data }: { data?: Acquisition }) {
  if (!data?.sources.length) return <span className="inline-flex rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600">Not recorded</span>;
  return <span className="inline-flex flex-wrap gap-1">
    {data.sources.map(source => {
      const config = sourceConfig[source];
      if (!config) return null;
      return <span key={source} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap ${config.style}`}>
        <config.Icon className="w-3 h-3" aria-hidden="true" />{config.label}
      </span>;
    })}
  </span>;
}

export function SourceLegend() {
  return <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500" aria-label="Acquisition source icon legend">
    {(Object.keys(sourceConfig) as AcquisitionSource[]).map(source => {
      const config = sourceConfig[source];
      return <span key={source} className="inline-flex items-center gap-1">
        <span className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded border ${config.style}`}><config.Icon className="w-2.5 h-2.5" aria-hidden="true" /></span>
        {config.label}
      </span>;
    })}
    <span className="inline-flex items-center gap-1"><span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded border border-slate-200 bg-slate-50 text-slate-400"><CircleHelp className="w-2.5 h-2.5" aria-hidden="true" /></span>Not recorded</span>
  </div>;
}

function dateLabel(value: string) {
  const formatted = formatReportDateTime(value);
  return formatted === "—" ? "Date unavailable" : formatted;
}

export function AcquisitionDetails({ data, title }: { data?: Acquisition; title: string }) {
  if (!data) return null;
  const firstForm = [...data.leadForms.map(form => ({ ...form, source: "Lead form" })),
    ...data.eventFeedback.map(form => ({ ...form, source: "Event feedback" }))]
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  return <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs font-semibold text-slate-800">{title}</p>
      <SourceIcons data={data} />
    </div>
    <p className="text-[11px] text-slate-600">Database record created: <span className="font-medium text-slate-800">{data.recordCreatedAt ? dateLabel(data.recordCreatedAt) : "Not recorded"}</span> · Original source not recorded</p>
    <p className="text-[11px] text-slate-600">First linked form response: <span className="font-medium text-slate-800">{data.firstAcquiredAt ? dateLabel(data.firstAcquiredAt) : "None recorded"}</span>{firstForm ? ` · ${firstForm.source}` : ""}</p>
    <p className="text-[11px] text-slate-600">Linked source types: {data.sources.length ? data.sources.map(source => sourceConfig[source]?.label ?? source).join(" · ") : "None recorded"} <span className="text-slate-500">(not the database record’s origin)</span></p>
    {data.sources.includes("monitored") && <p className="text-[11px] text-sky-700">Currently included in account monitoring</p>}
    {data.leadForms.length > 0 && <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 mb-1">Lead forms ({data.leadForms.length})</p>
      <ul className="space-y-1">{data.leadForms.map(form => <li key={form.id} className="text-[11px] text-slate-600">
        {dateLabel(form.at)}{form.formName ? ` · ${form.formName}` : ""}
      </li>)}</ul>
    </div>}
    {data.eventFeedback.length > 0 && <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-700 mb-1">Event feedback interactions ({data.eventFeedback.length})</p>
      <ul className="space-y-1">{data.eventFeedback.map(event => <li key={event.id} className="text-[11px] text-slate-600">
        {dateLabel(event.at)}{event.formName ? ` · ${event.formName}` : ""}
      </li>)}</ul>
    </div>}
  </div>;
}