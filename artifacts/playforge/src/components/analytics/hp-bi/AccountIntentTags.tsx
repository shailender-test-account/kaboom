import type { HpBiDetail } from "./types";
import { sourceIntent, type IntentHeat } from "./sourceIntent";
import { Chip } from "./ui";
import MonitoringCoverage, { monitoringCoverage } from "./MonitoringCoverage";
import { useState } from "react";
import EngagementHistory from "@/components/EngagementHistory";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const labels = { gtm: "Autonomous GTM", monitoring: "Monitoring", journey: "Journey" } as const;
const badge = (status: IntentHeat) => <Chip tone={status === "Hot" ? "hot" : status === "Warm" ? "warm" : "gray"}>{status}</Chip>;

export default function AccountIntentTags({ d, opportunities = false }: { d: HpBiDetail; opportunities?: boolean }) {
  const [showGtm, setShowGtm] = useState(false);
  const intent = sourceIntent(d);
  const coverage = monitoringCoverage(d);
  const hasMonitoringIntent = intent.statuses.monitoring === "Hot" || intent.statuses.monitoring === "Warm";
  if (opportunities) return <div data-testid="opportunity-source-intent" className="space-y-2">
    <h5 className="text-[11px] uppercase font-semibold text-[#5d7388]">Category intent by source</h5>
    <MonitoringCoverage d={d} hasIntent={hasMonitoringIntent} showLabel />
    {intent.categories.length ? <div className="overflow-x-auto"><table className="w-full text-xs">
      <thead><tr className="text-left text-[#5d7388]"><th className="py-2 pr-2">Category</th>
        {Object.values(labels).map(label => <th key={label} className="pr-2">{label}</th>)}</tr></thead>
      <tbody>{intent.categories.map(row => <tr key={row.category} className="border-t border-[#e3ebf2]">
        <td className="py-2 pr-2 font-medium">{row.category}</td>
        {(["gtm", "monitoring", "journey"] as const).map(source => <td key={source} className="pr-2">
          {row[source] === "Hot" || row[source] === "Warm" ? badge(row[source]) : <span className="text-[#5d7388]">—</span>}
        </td>)}</tr>)}</tbody>
    </table></div> : <p className="text-xs text-[#5d7388]">No category-specific Hot/Warm evidence available.</p>}
    <p className="text-[11px] text-[#5d7388]">All-date GTM and journey declarations; fresh approved monitoring research. Missing categories are not inferred. These tags do not add leads or change fiscal totals.</p>
  </div>;
  return <div data-testid="account-intent-tags" className="mt-3 space-y-2 text-left">
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {(["gtm", "monitoring", "journey"] as const).map(source => <div key={source} className="rounded border border-[#d5e0ea] bg-white p-2 text-xs space-y-1">
        <div className="font-semibold text-[#41586e]">{labels[source]} {source === "monitoring" && intent.statuses[source] === "Not available"
          ? <Chip tone="gray">{coverage.label}</Chip> : badge(intent.statuses[source])}</div>
        {source === "monitoring" && <MonitoringCoverage d={d} hasIntent={hasMonitoringIntent} />}
        {source === "gtm" && <>
          <p className="text-[11px] text-[#41586e]">Sources: {d.account?.gtm?.formTypes?.map(type =>
            type === "event_feedback" ? "Event Feedback Form / questionnaire" : "Lead Form").join(" · ") || "See source records"}</p>
          {intent.statuses.gtm === "Warm" && <p className="text-[11px] text-[#41586e]">Warm: current product/service declaration with freshness-adjusted form points ≥35; no fresh Hot declaration.</p>}
          <button type="button" onClick={() => setShowGtm(true)} className="text-[#05628f] underline text-[11px]"
            data-testid="open-gtm-source-details">View respondents &amp; qualification evidence</button>
        </>}
        <div className="flex flex-wrap gap-1">{intent.categories.filter(row => row[source] === "Hot" || row[source] === "Warm")
          .map(row => <span key={row.category} className="text-[11px] text-[#41586e]">{row.category} · {row[source]}</span>)}</div>
      </div>)}
    </div>
    <div className="text-xs font-semibold text-[#41586e]">Overall Intent {badge(intent.overall)}
      <span className="ml-2 font-normal text-[11px] text-[#5d7388]">{d.account?.priority ? "Freshness-adjusted weighted account priority; not an additional lead." : "Strongest available source; not an additional lead."}</span></div>
    <Dialog open={showGtm} onOpenChange={setShowGtm}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Autonomous GTM · qualification evidence</DialogTitle>
          <DialogDescription>All-date source history: respondents, form/questionnaire details, selected products and purchase timelines. Historical responses can differ from today's freshness-adjusted qualification.</DialogDescription></DialogHeader>
        {showGtm && d.clientId != null ? <EngagementHistory
          target={{ parentKey: d.account.parentKey, clientId: d.clientId }} title="Respondents and source evidence" />
          : <p>Source history is unavailable without a client scope.</p>}
      </DialogContent>
    </Dialog>
  </div>;
}
