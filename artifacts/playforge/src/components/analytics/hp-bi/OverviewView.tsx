import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import type { HpBiDashboard, HpBiPeriod } from "./types";
import type { EvidenceQuery } from "./EvidenceDialog";
import { HP_AMBER, HP_BLUE, HP_NAVY, HP_PLUM, HP_TEAL, moneyLines, moneyText, num, hasPeriodRecords } from "./format";
import { Chip, HBar, Kpi, Panel } from "./ui";
import CrmDealQuality from "./CrmDealQuality";
import Collapsible from "./Collapsible";
import type { MetricKey } from "./MetricSummaryDialog";

function Values({ v }: { v: Record<string, number> }) {
  const l = moneyLines(v);
  if (!l.length) return <span className="text-[#5d7388] text-xs">None recorded</span>;
  return <span className="flex flex-col leading-tight">{l.map(x => <span key={x}>{x}</span>)}</span>;
}

function DealMetricNote({ text, explanation }: { text: string; explanation: string }) {
  return <div>{text}<details className="mt-1">
    <summary className="w-fit cursor-pointer text-[#05628f]" aria-label={`About ${text}`}>?</summary>
    <p className="mt-1">{explanation}</p>
  </details></div>;
}

function QuarterCard({ q, i, onEvidence }: { q: HpBiPeriod; i: number; onEvidence: (e: EvidenceQuery) => void }) {
  const rows: [string, number, string | undefined][] = [["Touchpoints", q.touchpoints, "touchpoint"], ["Distinct contacts", q.contacts, "-"], ["Invitations", q.invitations, "invitation"], ["Attendance", q.attendance, "attendance"], ["Digital", q.digital, "digital"], ["Content", q.content, "content"], ["Other", q.other, "other"], ["Leads", q.leads, "lead"], ["Opportunities", q.opportunities, "opportunity"], ["Closed won", q.closedWon ?? 0, "closed_won"], ["Closed lost", q.closedLost ?? 0, "closed_lost"]];
  return (
    <div style={{ animationDelay: `${i * 60}ms` }} className={`hpbi-rise rounded-md border border-[#d5e0ea] p-3 ${q.isFuture ? "bg-[#f3f6f9]" : "bg-white"}`} data-testid={`card-quarter-${i}`}>
      <div className="flex items-center justify-between"><span className="text-sm font-semibold text-[#0B2A4A]">{q.label}</span>{q.isFuture && <Chip>Not yet started</Chip>}</div>
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-0.5 text-xs">
        {rows.map(([k, v, kind]) => (<div key={k} className="contents"><dt className="text-[#5d7388]">{k}</dt><dd className="text-right tabular-nums font-medium text-[#10243B]">{q.isFuture && v === 0 ? "n/a" : kind === "-" ? num(v) :
          <button data-testid={`link-evidence-q${i + 1}-${k.toLowerCase()}`} className="underline decoration-dotted hover:text-[#0096D6]" onClick={() => onEvidence({ title: `${q.label}: ${k}`, quarter: i + 1, kind })}>{num(v)}</button>}</dd></div>))}
        <dt className="text-[#5d7388]">Hot / Warm</dt><dd className="text-right tabular-nums">{q.hot} / {q.warm}</dd>
        <dt className="text-[#5d7388]">Categories</dt><dd className="text-right tabular-nums">{q.categories.length}</dd>
        <dt className="text-[#5d7388]">Opportunity ToV</dt><dd className="text-right text-[11px]"><Values v={q.values} /></dd>
        <dt className="text-[#5d7388]">Prospective</dt><dd className="text-right text-[11px]"><Values v={q.prospectiveValues ?? {}} /></dd>
        <dt className="text-[#5d7388]">Booked business</dt><dd className="text-right text-[11px]" data-testid={`text-booked-q${i + 1}`}><Values v={q.bookedValues ?? {}} /></dd>
      </dl>
    </div>
  );
}

export default function OverviewView({ data, pageHint, onEvidence, onMetric }: { data: HpBiDashboard; pageHint: string; onEvidence: (e: EvidenceQuery) => void; onMetric: (k: MetricKey) => void }) {
  const s = data.summary, q = data.quality;
  const lifecycle = s.dealLifecycle;
  const decimal = (value: number | null | undefined, suffix = "") => value == null
    ? "Not available" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
  const maxSeg = Math.max(1, ...data.segments.map(x => x.accounts));
  const maxRad = Math.max(1, ...data.rads.map(x => x.accounts));
  const coverage = s.engagedAccounts;
  const stages: [string, number, string, string][] = [["Touchpoints", s.touchpoints, HP_BLUE, "touchpoint"], ["Engaged contacts", s.engagedContacts, "#4cb4e0", "engaged_contacts"], ["Actual leads", s.leads, HP_TEAL, "lead"], ["Hot leads", s.hot, HP_AMBER, "hot"], ["Opportunities", s.opportunities, HP_PLUM, "opportunity"]];
  const maxStage = Math.max(1, ...stages.map(x => x[1]));
  const monthData = data.months.map(m => ({ name: m.label, Touchpoints: m.isFuture && !hasPeriodRecords(m) ? null : m.touchpoints, Leads: m.isFuture && !hasPeriodRecords(m) ? null : m.leads, Opportunities: m.isFuture && !hasPeriodRecords(m) ? null : m.opportunities }));
  const catMax = Math.max(1, ...data.categories.map(c => c.touchpoints));
  const gaps: [string, number][] = [["Missing segment", q.missingSegment], ["Missing RAD", q.missingRad], ["Unlinked contacts", q.unlinkedContacts], ["Leads without horizon", q.missingHorizon], ["Unpriced opportunities", q.unpricedOpportunities], ["Value without currency", q.missingCurrency], ["Unresolved matches", q.unresolvedMatches]];
  return (
    <div className="space-y-3 hpbi-fade" data-testid="tab-content-overview">
      {s.gtm && <Collapsible testId="hp-gtm-qualification" title="Autonomous GTM · mapped HP accounts and responses" summary={s.gtm.inboundAccounts !== undefined && s.gtm.inboundResponses !== undefined
        ? `${num(s.gtm.inboundAccounts)} accounts / ${num(s.gtm.inboundResponses)} responses`
        : `${num(s.gtm.hotAccounts)} Hot / ${num(s.gtm.warmAccounts)} Warm qualified accounts`}>
        <div>
        {s.gtm.inboundAccounts !== undefined && <div className="mt-2">
          <p className="font-semibold text-[#0B2A4A]">Autonomous GTM source coverage · all responses</p>
          <div className="flex flex-wrap gap-4 mt-2">
            <span data-testid="gtm-inbound-accounts"><strong>{num(s.gtm.inboundAccounts)}</strong> responding HP accounts</span>
            <span data-testid="gtm-inbound-responses"><strong>{num(s.gtm.inboundResponses ?? 0)}</strong> responses</span>
            <span data-testid="gtm-source-hot-accounts"><strong>{num(s.gtm.inboundHotAccounts ?? 0)}</strong> Hot in GTM</span>
            <span data-testid="gtm-source-warm-accounts"><strong>{num(s.gtm.inboundWarmAccounts ?? 0)}</strong> Warm in GTM</span>
            <span>{num(s.gtm.inboundColdAccounts ?? 0)} Cold in GTM</span>
          </div>
        </div>}
        <p className="font-semibold text-[#0B2A4A] mt-3">HP product-qualified accounts</p>
        <div className="flex flex-wrap gap-4 mt-2">
          <span data-testid="gtm-hot-accounts"><strong>{num(s.gtm.hotAccounts)}</strong> Hot accounts</span>
          <span data-testid="gtm-warm-accounts"><strong>{num(s.gtm.warmAccounts)}</strong> Warm accounts</span>
          <span>{num(s.gtm.qualifiedAccounts)} qualified legal accounts</span>
          <span data-testid="gtm-upload-date-responses">{num(s.gtm.uploadDateResponses ?? 0)} product responses using upload/import dates</span>
        </div>
        <p className="mt-2 text-[#5d7388]">Linked directly to the same HP account IDs and responses as Autonomous GTM, with no duplicate import. Coverage follows the selected account filters regardless of fiscal year. A selected product/service is required: 0–3 months is Hot; over 3 through 6 months is Warm. Over 6 months, no clear horizon, or no product/service is Cold; generic feedback alone is not a lead. Missing submission dates use the upload/import date for fiscal and monthly reporting; open an account to correct a date.</p>
        </div>
      </Collapsible>}
      <p className="text-xs font-semibold text-[#5d7388]">Fiscal-year results · {data.year} · dated records only</p>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-3">
        <Kpi onClick={() => onMetric("accounts")} index={0} testId="kpi-accounts" label="Legal accounts" value={num(s.accounts)} sub={`${num(s.parentAccounts)} parent groups; ${num(s.newAccounts)} new`} />
        <Kpi onClick={() => onMetric("contacts")} index={1} testId="kpi-contacts" label="Contacts" value={num(s.contacts)} sub={`${num(s.newContacts)} new; ${num(s.engagedContacts)} engaged`} />
        <Kpi onClick={() => onMetric("touchpoints")} index={2} testId="kpi-touchpoints" label={`Touchpoints · FY${data.year}`} value={num(s.touchpoints)} sub={`${num(coverage)} accounts touched in FY; ${num(s.touchpointsAllDates??s.touchpoints)} touchpoints across all dates`} />
        <Kpi onClick={() => onMetric("leads")} index={3} testId="kpi-leads" label="Actual leads" value={num(s.leads)} accent={HP_TEAL} sub={`${num(s.hot)} Hot / ${num(s.warm)} Warm`} />
        <Kpi onClick={() => onMetric("hot")} index={4} testId="kpi-hot" label="Hot leads" value={num(s.hot)} accent={HP_AMBER} sub="Product + horizon 3 months or less" />
        <Kpi onClick={() => onMetric("opps")} index={5} testId="kpi-opps" label="Opportunities" value={num(s.opportunities)} accent={HP_PLUM} sub="Actual opportunity records" />
        <Kpi onClick={() => onMetric("prospective")} index={7} testId="kpi-prospective" label="Prospective ToV" value={<Values v={s.prospectiveValues} />} accent={HP_AMBER} sub="Submitted Total Order Value; not booked" />
        <Kpi onClick={() => onMetric("booked")} index={8} testId="kpi-booked" label="Booked value" value={<Values v={s.bookedValues} />} accent={HP_TEAL} sub="Explicit closed_won records only" />
        <Kpi onClick={() => onMetric("won")} index={9} testId="kpi-closed-won" label="Closed won" value={num(s.closedWon ?? 0)} accent={HP_TEAL} sub={<>Actual outcome dates only. Booked: <Values v={s.bookedValues} /></>} />
        <Kpi onClick={() => onMetric("lost")} index={10} testId="kpi-closed-lost" label="Closed lost" value={num(s.closedLost ?? 0)} accent="#a8400f" sub="Actual outcome dates only" />
        <Kpi index={12} testId="kpi-avg-days-to-close" label="Avg. Days to Close" value={decimal(lifecycle?.avgDaysToClose, " days")} accent={HP_TEAL}
          sub={<DealMetricNote text={`${num(lifecycle?.closedDurationSamples ?? 0)} wins with valid dates`}
            explanation="Average calendar days from actual confirmed opportunity date to actual won date, for CRM wins in the selected fiscal year and account scope. Missing or reversed dates are excluded; same-day wins count as zero days. Upload dates and expected close dates are not used." />} />
        <Kpi index={13} testId="kpi-win-rate" label="Win Rate" value={decimal(lifecycle?.winRate, "%")} accent={HP_TEAL}
          sub={<DealMetricNote text={`${num(lifecycle?.closedOutcomes ?? 0)} recorded outcomes`}
            explanation="Closed won ÷ (closed won + closed lost) × 100, using actual outcome dates in the selected fiscal year and account scope. Open opportunities are not in the denominator. No outcomes means not available, not a zero-percent win rate." />} />
        <Kpi index={14} testId="kpi-open-deals" label="Open Deals" value={decimal(lifecycle?.openDeals)} accent={HP_PLUM}
          sub={<DealMetricNote text={lifecycle?.asOfDate ? `Open as of ${lifecycle.asOfDate}` : "No reporting snapshot available"}
            explanation="Confirmed CRM opportunities still open at this snapshot, across all opportunity start dates for the selected accounts. Uses today in India, or the selected fiscal year's last day for a past year. Includes deals that closed after that historical snapshot; excludes prospects, unconfirmed and invalidly linked deals. Future fiscal years have no snapshot yet." />} />
        <Kpi index={15} testId="kpi-avg-open-deal-age" label="Avg. Open Deal Age" value={decimal(lifecycle?.avgOpenDealAge, " days")} accent={HP_AMBER}
          sub={<DealMetricNote text={lifecycle?.asOfDate ? `Age as of ${lifecycle.asOfDate}` : "No reporting snapshot available"}
            explanation="Average calendar days since the actual confirmed opportunity date for the Open Deals snapshot. No estimated or upload dates are substituted. No valid open opportunities means not available." />} />
      </div>

      <div className="grid grid-cols-12 gap-3">
        <Panel id="panel-months" className="col-span-12 xl:col-span-8" title="Monthly rhythm" note="Chronological, Nov to Oct. Click a bar for its records. Months not yet started are blank, not zero.">
          <div className="h-[230px]" data-testid="chart-months">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={monthData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="#e3ebf2" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#5d7388" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#5d7388" }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #d5e0ea" }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Touchpoints" fill={HP_BLUE} radius={[2, 2, 0, 0]} animationDuration={700} cursor="pointer" onClick={(_: unknown, idx: number) => onEvidence({ title: `${data.months[idx]?.label ?? "Month"}: records`, month: idx + 1 })} />
                <Line dataKey="Leads" stroke={HP_TEAL} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} animationDuration={900} />
                <Line dataKey="Opportunities" stroke={HP_PLUM} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} animationDuration={900} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel id="panel-funnel" className="col-span-12 xl:col-span-4" title="Marketing to outcome" note="Stages carry different units; compared on one scale for drop-off only.">
          <ul className="space-y-2.5">
            {stages.map(([n, v, c, kind]) => (
              <li key={n} data-testid={`row-stage-${n.toLowerCase().replace(/ /g, "-")}`}>
                <button type="button" className="block w-full rounded text-left hover:bg-[#edf4f9] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0096D6]"
                  aria-label={`View ${n.toLowerCase()} records (${num(v)})`}
                  onClick={() => onEvidence({ title: n, kind })}>
                <div className="flex justify-between text-xs mb-1"><span className="text-[#41586e]">{n}</span><span className="tabular-nums font-semibold text-[#0B2A4A]">{num(v)}</span></div>
                <HBar value={v} max={maxStage} color={c} h={12} />
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-[#5d7388] mt-3">Click a stage to view its source records. Engaged contacts shows supporting touchpoints; a person may have several. Invitation is not attendance; a response is not a lead; a handoff is not an opportunity.</p>
        </Panel>
      </div>

      <Panel id="panel-quarters" title="Quarter comparison" note="Q1 Nov-Jan, Q2 Feb-Apr, Q3 May-Jul, Q4 Aug-Oct. Volume and quality shown separately.">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">{data.quarters.map((x, i) => <QuarterCard key={x.label} q={x} i={i} onEvidence={onEvidence} />)}</div>
      </Panel>

      <div className="grid grid-cols-12 gap-3">
        <Panel id="panel-segments" className="col-span-12 md:col-span-6 xl:col-span-4" title="GTM segments" note={`Accounts by segment. ${pageHint}`}>
          <ul className="space-y-2">
            {data.segments.map(x => (
              <li key={x.name} data-testid={`row-segment-${x.name}`}>
                <div className="flex justify-between text-xs"><span className="font-medium text-[#10243B]">{x.name}</span><span className="tabular-nums text-[#5d7388]">{num(x.accounts)} accts / {num(x.contacts)} contacts / {num(x.leads)} leads ({num(x.hot)} Hot) / {num(x.touchpoints)} tp</span></div>
                <HBar value={x.accounts} max={maxSeg} />
              </li>
            ))}
          </ul>
        </Panel>
        <Panel id="panel-rads" className="col-span-12 md:col-span-6 xl:col-span-3" title="RAD classification" note="Retention, Acquisition, Development, Unknown.">
          <ul className="space-y-2">
            {data.rads.map(x => (
              <li key={x.name} data-testid={`row-rad-${x.name}`}>
                <div className="flex justify-between text-xs"><span className="font-medium text-[#10243B]">{x.name}</span><span className="tabular-nums text-[#5d7388]">{num(x.accounts)} / {num(x.leads)} leads / {num(x.touchpoints)} tp</span></div>
                <HBar value={x.accounts} max={maxRad} color={HP_NAVY} />
              </li>
            ))}
          </ul>
        </Panel>
        <Panel id="panel-quality" className="col-span-12 xl:col-span-5" title="Data quality" note={`Baseline ${num(q.baselineAccounts)} accounts / ${num(q.baselineRows)} rows. Last import: ${q.lastImport ? new Date(q.lastImport).toLocaleString("en-IN") : "none yet"}`}>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-4 gap-2">
            {gaps.map(([k, v]) => (
              <div key={k} data-testid={`quality-${k.toLowerCase().replace(/ /g, "-")}`} className={`rounded border px-2 py-1.5 ${v > 0 ? "border-[#f0cfae] bg-[#fdf5ec]" : "border-[#d5e0ea] bg-[#f6f9fb]"}`}>
                <div className="text-lg font-semibold tabular-nums text-[#0B2A4A]" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif" }}>{num(v)}</div>
                <div className="text-[10.5px] text-[#5d7388] leading-tight">{k}</div>
              </div>
            ))}
          </div>
          <div className="mt-4"><CrmDealQuality crm={q.crmDeals} scopeNote={pageHint.replace(/\.$/, "")} /></div>
        </Panel>
      </div>

      <Panel id="panel-months-table" title="Monthly outcomes" note="Opportunity ToV, prospective value and booked business stay separate, per currency. Click a count for its records.">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="table-month-outcomes">
            <thead><tr className="text-left text-[10.5px] uppercase tracking-wider text-[#5d7388]"><th className="py-1.5 pr-3">Month</th><th className="px-2 text-right">Opps</th><th className="px-2 text-right">Won</th><th className="px-2 text-right">Lost</th><th className="px-2">Opportunity ToV</th><th className="px-2">Prospective</th><th className="pl-2">Booked</th></tr></thead>
            <tbody>{data.months.map((m, idx) => (
              <tr key={m.label} className="border-t border-[#e3ebf2]" data-testid={`row-month-${idx + 1}`}>
                <td className="py-1.5 pr-3 font-medium">{m.label}</td>
                {m.isFuture && !hasPeriodRecords(m) ? <td colSpan={6} className="text-[#8CA0B3]">Not yet started</td> : <>
                  <td className="px-2 text-right tabular-nums">{num(m.opportunities)}</td>
                  <td className="px-2 text-right tabular-nums"><button className="underline decoration-dotted hover:text-[#0096D6]" data-testid={`link-evidence-month-${idx + 1}-won`} onClick={() => onEvidence({ title: `${m.label}: closed won`, month: idx + 1, kind: "closed_won" })}>{num(m.closedWon ?? 0)}</button></td>
                  <td className="px-2 text-right tabular-nums"><button className="underline decoration-dotted hover:text-[#0096D6]" data-testid={`link-evidence-month-${idx + 1}-lost`} onClick={() => onEvidence({ title: `${m.label}: closed lost`, month: idx + 1, kind: "closed_lost" })}>{num(m.closedLost ?? 0)}</button></td>
                  <td className="px-2 text-[11px]">{moneyText(m.values)}</td><td className="px-2 text-[11px]">{moneyText(m.prospectiveValues)}</td><td className="pl-2 text-[11px]">{moneyText(m.bookedValues)}</td></>}
              </tr>))}</tbody>
          </table>
        </div>
      </Panel>

      <Panel id="panel-categories" title="Category interest" note="Observed interest from engagement. On this view a category is not a buyer; buyer and whitespace counts are supplied context.">
        {data.categories.length === 0 ? <p className="text-xs text-[#5d7388]">No categories observed in this selection.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-[10.5px] uppercase tracking-wider text-[#5d7388]"><th className="py-1.5 pr-3">Category</th><th className="pr-3 w-[22%]">Touchpoints</th><th className="px-2 text-right">Contacts</th><th className="px-2 text-right">Leads</th><th className="px-2 text-right">Hot</th><th className="px-2 text-right">Opps</th><th className="px-2 text-right">Buyers</th><th className="px-2 text-right">Whitespace</th><th className="px-2 text-right">Won</th><th className="px-2 text-right">Lost</th><th className="px-2">Opp. ToV</th><th className="pl-2">Booked</th></tr></thead>
              <tbody>
                {data.categories.map(c => (
                  <tr key={c.name} className="border-t border-[#e3ebf2]" data-testid={`row-category-${c.name}`}>
                    <td className="py-1.5 pr-3 font-medium text-[#10243B]"><button data-testid={`link-evidence-category-${c.name}`} className="underline decoration-dotted hover:text-[#0096D6] text-left" onClick={() => onEvidence({ title: `Category: ${c.name}`, category: c.name })}>{c.name}</button></td>
                    <td className="pr-3"><div className="flex items-center gap-2"><div className="flex-1"><HBar value={c.touchpoints} max={catMax} h={6} /></div><span className="tabular-nums w-8 text-right">{num(c.touchpoints)}</span></div></td>
                    <td className="px-2 text-right tabular-nums">{num(c.contacts)}</td><td className="px-2 text-right tabular-nums">{num(c.leads)}</td>
                    <td className="px-2 text-right tabular-nums">{num(c.hot)}</td><td className="px-2 text-right tabular-nums">{num(c.opportunities)}</td>
                    <td className="px-2 text-right tabular-nums">{num(c.buyers)}</td><td className="px-2 text-right tabular-nums">{num(c.whitespace)}</td>
                    <td className="px-2 text-right tabular-nums">{num(c.closedWon ?? 0)}</td><td className="px-2 text-right tabular-nums">{num(c.closedLost ?? 0)}</td>
                    <td className="px-2 text-[11px]">{moneyText(c.values)}</td><td className="pl-2 text-[11px]">{moneyText(c.bookedValues)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
