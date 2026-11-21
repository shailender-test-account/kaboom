import type { HpAccountPriority } from "@workspace/api-client-react";
import { formatReportDateTime } from "@/lib/reportTime";

export default function AccountPriority({ priority: p }: { priority?: HpAccountPriority }) {
  if (!p) return null;
  return <section className="rounded border border-[#b9d9df] bg-[#f3fbfa] p-3 space-y-3" data-testid="account-priority">
    <div className="flex flex-wrap justify-between gap-2">
      <h4 className="text-xs font-semibold uppercase text-[#0B2A4A]">Account Score</h4>
      <strong className="text-[#0B2A4A]">{p.score}/100 · {p.status}</strong>
    </div>
    <p className="text-xs text-[#41586e]" data-testid="priority-score-equation">
      {p.forms} forms + {p.journey} journey + {p.monitoring} monitoring = {p.score}/100.
      {" "}These are weighted, freshness-adjusted contributions, not counts of contacts.
    </p>
    <div className="grid grid-cols-3 gap-2 text-xs">
      {([["Forms", p.forms, 65], ["Journey", p.journey, 25], ["Monitoring", p.monitoring, 10]] as const).map(([label, value, max]) =>
        <div key={label} className="rounded border border-[#d5e0ea] bg-white p-2">
          <span className="block text-[#5d7388]">{label}</span><strong>{value}/{max}</strong>
        </div>)}
    </div>
    <p className="text-xs">Declared qualification: <strong>{p.declaredQualification}</strong>
      {p.needsReconfirmation && <span className="ml-2 font-semibold text-amber-800">Needs reconfirmation · purchase window passed</span>}</p>
    <div className="text-xs" data-testid="priority-routing">
      Journey routing: <strong>{p.routing.status}</strong>
      {!!p.routing.journeys.length && <span> · {p.routing.journeys.join(", ")}</span>}
      <p className="mt-1 text-[#5d7388]">{p.routing.reason}</p>
    </div>
    {p.nextReviewAt && <p className="text-[11px] text-[#5d7388]">Next freshness review: {formatReportDateTime(p.nextReviewAt)}</p>}
    <details className="text-xs text-[#41586e]">
      <summary className="cursor-pointer">How is this calculated?</summary>
      <ul className="mt-2 list-disc pl-4 space-y-1">
        <li>Forms 65%, journey behaviour 25%, monitoring 10%. Duplicate evidence does not add points.</li>
        <li>The strongest form is used, not the average or sum of contacts. A selected product with a 0–3 month horizon starts at 100 × 65% = 65 points; over 3–6 months starts at 70 × 65% = 45.5 points.</li>
        <li>Form contribution = base points × 0.65 × 2^(−max(0, age in days − 30)/60). Source dates, not repeat imports, determine age. Displayed contributions are truncated to one decimal; the total uses unrounded contributions.</li>
        <li>Forms: full weight for 30 days, then half every 60 days. Journey: full weight for 14 days, then half every 30 days. Monitoring: half every 30 days from the event date.</li>
        <li>Hot: at least 65 with fresh explicit purchase evidence. Warm: at least 35, or a higher score without fresh purchase evidence. Cold: below 35.</li>
        <li>Passed purchase windows need reconfirmation. Missing or future evidence dates cannot establish fresh intent. Immediate (0-month) declarations have a 30-day reconfirmation window.</li>
        <li>Current Warm forms or overall Warm accounts use approved published product/category destinations and eligible contacts. Missing mappings or contacts need attention. A sequence requires an enabled saved rule and an active, approved destination.</li>
        <li>Scores refresh when the account is read; the routing worker checks bounded batches each minute. Historical fiscal leads and stored journey points are unchanged.</li>
      </ul>
    </details>
  </section>;
}
