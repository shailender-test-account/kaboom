import { useAuthContext } from "@/contexts/AuthContext";
import { buildDemoEngagement, matchesDemoEngagement } from "./model";

const dateLabel = (date: Date) => date.toLocaleDateString("en-IN", {
  day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
});

export default function DemoEngagementHistory({ contactId, companyId, contactIds }: {
  contactId?: number; companyId?: number; contactIds?: number[];
}) {
  const { user } = useAuthContext();
  if (!matchesDemoEngagement(user?.tenantId, { contactId, companyId, contactIds })) return null;
  const d = buildDemoEngagement();
  return <section data-testid="demo-engagement" aria-label="Saurabh Pandey demo engagement history"
    className="mb-6 min-w-0 space-y-4 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 sm:p-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-[10px] font-bold uppercase tracking-widest text-indigo-700">Demo activity · not live customer data</p>
        <h2 className="mt-1 text-base font-semibold">Saurabh Pandey · engagement history</h2>
        <p className="mt-1 text-xs text-muted-foreground">HDFC journey · illustrative email clicks, page visits and scrolling, 2–3 visits per completed month.</p>
      </div>
      <span className="rounded-full border border-indigo-200 bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-900">{d.stage}</span>
    </header>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        ["Total demo points", String(d.total), `${d.visits.length} visits · ${d.visits.length * 5} scored actions`],
        ["Recency weight", `${d.lastVisit?.recencyWeight.toFixed(2) ?? "0.00"}×`, d.lastVisit ? `Last visit ${dateLabel(d.lastVisit.date)} · ${Math.floor(d.lastVisit.recencyDays)} days ago` : "No visits yet"],
        ["Frequency weight", `${d.frequencyWeight.toFixed(2)}×`, `${d.activeDays} distinct active days`],
        ["Weighted demo index", String(d.weightedIndex), "Separate from real CRM / intent scores"],
      ].map(([label, value, detail]) => <div key={label} className="min-w-0 rounded-lg border bg-background p-3">
        <p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
        <p className="mt-1 break-words text-[11px] text-muted-foreground">{detail}</p>
      </div>)}
    </div>
    <div className="flex flex-wrap gap-2" aria-label="Monthly demo visit counts">
      {d.months.map(m => <span key={m.month} className="rounded border bg-background px-2 py-1 text-xs">{m.month}: <strong>{m.count} visits</strong></span>)}
    </div>
    <details className="rounded-lg border bg-background p-3">
      <summary className="cursor-pointer text-xs font-medium">How demo scoring and weights work</summary>
      <div className="mt-3 space-y-2 text-xs text-muted-foreground">
        <p>Every visit: email click +5, journey landing +10, strategy page +15, solutions page +20, 90% scroll +5 = <strong>55 points</strong>. Total demo points are the sum of all actions, without decay.</p>
        <p>Recency = exp(−0.033 × days since visit). Frequency = 1 + 0.5 × ln(1 + distinct active days). Recent visits retain more weight; repeat visits on different days increase the frequency multiplier.</p>
        <p>Illustrative stage multipliers: Aware 1× → Pre-Engage 1.5× → Engage 2× → Advanced Engage 2.5×. In this demo, the sixth visit reaches Advanced Engage.</p>
        <p>Weighted demo index = round(sum of each visit’s points × recency × stage multiplier, then × frequency). This is an explanatory demo calculation, not the production intent-scoring formula or buying-horizon qualification.</p>
        <p>No demo activity is saved to analytics, added to real scores, used for Hot/Warm/Cold qualification, or allowed to trigger sequences.</p>
      </div>
    </details>
    <div className="space-y-2">
      {[...d.visits].reverse().map((visit, index) => <details key={visit.date.toISOString()} open={index === 0}
        className="rounded-lg border bg-background p-3">
        <summary className="cursor-pointer text-xs">
          <span className="ml-1 inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <strong>{dateLabel(visit.date)}</strong><span>{visit.stage}</span>
            <strong className="text-emerald-700">+{visit.points} points</strong>
            <span className="text-muted-foreground">Running total {visit.cumulative}</span>
          </span>
        </summary>
        <p className="mt-2 text-[11px] text-muted-foreground">Recency {visit.recencyWeight.toFixed(2)}× · Stage {visit.stageWeight}× · Weighted contribution {visit.weighted.toFixed(1)} before shared frequency weight</p>
        <ol className="mt-3 space-y-2">
          {visit.events.map(event => <li key={event.kind} className="flex items-start justify-between gap-3 border-t pt-2 text-xs">
            <div className="min-w-0"><strong>{event.kind}</strong><p className="mt-0.5 break-words text-muted-foreground">{event.detail}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{event.at.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST · Running total {event.cumulative}</p>
            </div>
            <span className="shrink-0 font-semibold text-emerald-700">+{event.points}</span>
          </li>)}
        </ol>
      </details>)}
    </div>
  </section>;
}
